#!/usr/bin/env node

/**
 * Lark bug 多维表格轮询器（能力3）。
 *
 * 周期性读取 bug 表里「负责人=我 且 状态=待处理」的记录，去重后投递到本地
 * Bot Gateway 队列（POST /lark/tasks），复用 worker → AI → 回群 → 回写状态 的统一链路。
 * 鉴权走 lark-cli 已登录的 bot 身份，不在配置里放 app 级密钥。
 *
 * 规则来源：apps/web/docs_tdd/common/lark-bot/docs/README.md、common/rules/lark-doc-sync.md。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

import { larkRuntimeDir } from './lib/lark-repo.mjs'
import { isProjectId } from './lib/lark-project-id.mjs'
import { loadConfig, resolveNotifyChatId } from './lib/lark-config.mjs'
import { buildCardContent } from './lib/lark-cards.mjs'
import { runLarkCli, sendChatMessage } from './lib/lark-cli.mjs'
import { createGatewayClient, sleep } from './lib/lark-gateway-client.mjs'
import { defaultGatewayUrl } from './lib/lark-constants.mjs'
import {
  assigneeHasOpenId,
  buildBugText,
  BUGTABLE_FIELD_DEFAULTS,
  buildBugStatusFilter,
  classifyBugPollAction,
  parseColumnarRecords,
  readBugCommandType,
  readProjectId,
  readStatusText,
} from './lib/lark-bugtable-parse.mjs'

// 测试与既有调用方沿用从本文件导入 classifyBugTaskStatus（实现已下沉到 lib/）。
export { classifyBugTaskStatus } from './lib/lark-bugtable-parse.mjs'

const defaultPollMs = Number(process.env.LARK_BUGTABLE_POLL_MS || 90000)
// 空闲自动收工：连续这么久没有新 bug 就自动退出，忘了 poll-off 也无害（默认 4h）
const defaultIdleOffMs = Number(process.env.LARK_BUGTABLE_IDLE_OFF_MS || 4 * 60 * 60 * 1000)
// 连续失败到这个轮次就发群告警（默认 3 轮 ≈ 4.5min）：失败期间新 bug 完全捞不到，必须让人知道。
const errorAlertRounds = Number(process.env.LARK_BUGTABLE_ERROR_ALERT_ROUNDS || 3)

// 已处理 record_id 持久化，避免重复建 task
const createSeenStore = (statePath) => {
  mkdirSync(dirname(statePath), { recursive: true })
  const seen = existsSync(statePath) ? new Set(JSON.parse(readFileSync(statePath, 'utf8')).seen || []) : new Set()
  const persist = () => writeFileSync(statePath, JSON.stringify({ seen: [...seen] }, null, 2))
  return {
    has: (id) => seen.has(id),
    add(id) {
      seen.add(id)
      persist()
    },
    // 加界：只保留仍在本轮抓取窗口（待处理/验退）里的 id。done 记录回写后离开筛选、随即被剔除，
    // 而它本就不会再入队（不在抓取集）；网关已 done 但表格回写滞后的记录此刻仍被抓到，留在窗口内不误删。
    // 无此清理时 seen 只增不减（已 done 的 record_id 永久累积），是 lark-tasks 之外同型的「只增集合」。
    prune(liveIds) {
      let changed = false
      for (const id of seen) {
        if (!liveIds.has(id)) {
          seen.delete(id)
          changed = true
        }
      }
      if (changed) persist()
    },
  }
}

// 服务端按状态过滤 + 翻页拉全（待处理/验退可能 >200），仅投影需要的列以减小 payload
const fetchPendingRecords = async ({ bug }) => {
  const filterJson = JSON.stringify(buildBugStatusFilter(bug))
  const projected = [
    bug.statusField,
    bug.assigneeField,
    bug.projectField || BUGTABLE_FIELD_DEFAULTS.projectField,
    bug.titleField || BUGTABLE_FIELD_DEFAULTS.titleField,
    bug.descField || BUGTABLE_FIELD_DEFAULTS.descField,
  ].filter(Boolean)

  const all = []
  const pageSize = 200
  for (let offset = 0; offset <= 20000; offset += pageSize) {
    const args = [
      'base',
      '+record-list',
      '--base-token',
      bug.appToken,
      '--table-id',
      bug.tableId,
      '--filter-json',
      filterJson,
      '--format',
      'json',
      '--limit',
      String(pageSize),
      '--offset',
      String(offset),
    ]
    for (const field of projected) {
      args.push('--field-id', field)
    }

    const result = await runLarkCli(args)
    if (result.code !== 0) {
      throw new Error(`record-list failed: ${(result.stderr || result.stdout).slice(0, 200)}`)
    }
    const data = JSON.parse(result.stdout).data || {}
    all.push(...parseColumnarRecords(data))
    if (!data.has_more) break
  }
  return all
}

const enqueueTask = async ({ client, record, bug, chatId, operator, reopen = false }) => {
  // 校验项目号：只把合法 PR-#### / PM-#### 传给 gateway；异常单元格（如 ../../x）不作为 project，
  // 交由 worker 走 adhoc 临时 worktree，避免污染路径/分支名。
  const rawProject = readProjectId({ fields: record.fields || {}, bug })
  const project = isProjectId(rawProject) ? rawProject.toUpperCase() : undefined
  const body = {
    id: record.record_id,
    source: 'lark-bugtable',
    recordId: record.record_id,
    project,
    chatId,
    operator,
    commandType: readBugCommandType({ fields: record.fields || {}, bug }),
    text: buildBugText({ record, bug }),
  }
  if (reopen) await client.reopenTask(record.record_id, body)
  else await client.enqueueTask(body)
}

// 读 gateway 当前任务（record_id → task），作为去重、验退重开与「是否在处理中」的权威依据。
const fetchGatewayTasks = async (client) => {
  const tasks = await client.listTasks()
  const byId = new Map()
  for (const task of tasks) byId.set(task.id, task)
  return byId
}

const runOnce = async ({ config, seen, client }) => {
  const bug = config.bugTable
  if (!bug?.appToken || !bug?.tableId) {
    throw new Error('config.bugTable.appToken / tableId are required')
  }
  const records = await fetchPendingRecords({ bug })
  // myOpenId 与「@负责人才触发任务分类」的 taskMentionOpenIds[0] 是同一人，不在 bugTable 下单独维护。
  const myOpenId = bug.myOpenId || config.taskMentionOpenIds?.[0]
  const mine = records.filter((record) => assigneeHasOpenId(record.fields?.[bug.assigneeField], myOpenId))
  // 用 gateway 任务状态（而非「入队即永久 seen」）判断去重：避免 failed 的 bug 既留在表里待处理、
  // 又被本地 seen 挡住永不再捞而静默消失。seen 只缓存已确认 done 的记录（跨重启防重入队）。
  const taskById = await fetchGatewayTasks(client)
  let enqueued = 0
  let reopened = 0
  let inFlight = 0
  let waiting = 0
  let noChange = 0
  let stuck = 0
  for (const record of mine) {
    const id = record.record_id
    const recordStatus = readStatusText(record.fields?.[bug.statusField])
    const task = taskById.get(id)
    const disposition = classifyBugPollAction({
      recordStatus,
      taskStatus: task?.status,
      seen: seen.has(id),
      rejectedValue: bug.rejectedValue,
    })
    if (disposition === 'seen') continue
    if (disposition === 'done') {
      seen.add(id) // 落地终态成功，之后不再处理（表格状态也应已回写为 doneValue）
      continue
    }
    if (disposition === 'in-flight') {
      inFlight += 1 // 正在处理中，不重复入队
      continue
    }
    if (disposition === 'waiting') {
      waiting += 1 // 阻塞/待确认必须等人工补料，禁止 poller 自动重跑覆盖状态
      continue
    }
    if (disposition === 'no-change') {
      noChange += 1 // 本仓无对应改动（转后端/别的仓）：终局，不自动重跑，留待人工重新分派
      continue
    }
    if (disposition === 'failed') {
      // 上次失败：群里已收到失败卡片，表格保持待处理待人工介入。此处不自动重跑（避免对
      // 真正修不动的 bug 无限重试 AI、刷群烧钱）；仅计数暴露，需人工在群里重触发或手动处理。
      stuck += 1
      continue
    }
    if (disposition === 'reopen') {
      await enqueueTask({ client, record, bug, chatId: resolveNotifyChatId(config), operator: myOpenId, reopen: true })
      reopened += 1
      console.log(`[bugtable-poller] reopened QA-returned ${id}`)
      continue
    }
    // 全新记录 → 入队
    await enqueueTask({ client, record, bug, chatId: resolveNotifyChatId(config), operator: myOpenId })
    enqueued += 1
    console.log(`[bugtable-poller] enqueued ${id}`)
  }
  console.log(`[bugtable-poller] actionable=${records.length} mine=${mine.length} new=${enqueued} qa-returned=${reopened} in-flight=${inFlight} waiting=${waiting} no-change=${noChange} stuck-failed=${stuck}`)
  // 用本轮抓取窗口（全部待处理/验退记录）裁剪 seen：离开筛选的 done 记录随之退出，seen 不再只增。
  seen.prune(new Set(records.map((record) => record.record_id)))
  return enqueued + reopened
}

export async function runLarkBugtablePoller({
  configPath,
  gatewayUrl = defaultGatewayUrl,
  pollMs = defaultPollMs,
  idleOffMs = defaultIdleOffMs,
  argv = process.argv.slice(2),
}) {
  const config = loadConfig(configPath)
  // 跨项目单例状态：与 lark-tasks 队列同源，落在中性的 runtime 目录，不再寄生在某个宿主项目的 agent/ 下。
  const statePath = join(larkRuntimeDir, 'lark-bugtable-state.json')
  const seen = createSeenStore(statePath)
  const client = createGatewayClient(gatewayUrl)
  const once = argv.includes('--once')
  const chatId = resolveNotifyChatId(config)
  const notify = ({ kind, lines, idempotencyKey }) =>
    sendChatMessage({ chatId, card: buildCardContent({ config, kind, lines }), logPrefix: 'poller notice', idempotencyKey })

  let idleMs = 0
  let consecutiveErrors = 0
  let alerted = false
  do {
    try {
      const enqueued = await runOnce({ config, seen, client })
      idleMs = enqueued > 0 ? 0 : idleMs
      consecutiveErrors = 0
      alerted = false
    } catch (error) {
      // 出错的这一轮**不计入空闲**：它根本没读到表，无从判断有没有新 bug。
      // 曾经错误轮次照样 idleMs += pollMs，于是「表一直读不通」会伪装成「一直没新 bug」，
      // 4h 后 poller 静默收工，bug 表入口整条链路无声消失。
      consecutiveErrors += 1
      console.error(`[bugtable-poller] 第 ${consecutiveErrors} 次连续失败：${error.message}`)
      if (consecutiveErrors >= errorAlertRounds && !alerted) {
        alerted = true // 只在跨过阈值时告警一次，恢复后重置，避免持续失败刷群
        await notify({
          kind: 'alert',
          lines: [
            `**详情**：bug 表轮询已连续 ${consecutiveErrors} 次失败，期间**新 bug 不会被自动捞取**。`,
            '请检查 lark-cli 登录态 / 表格权限 / gateway 是否在跑。',
            `原因：${error.message.slice(0, 200)}`,
          ],
          idempotencyKey: `poller-error-${new Date().toISOString().slice(0, 13)}`,
        })
      }
      if (!once) await sleep(pollMs)
      continue
    }
    if (!once) {
      await sleep(pollMs)
      idleMs += pollMs
      if (idleOffMs > 0 && idleMs >= idleOffMs) {
        const hours = Math.round(idleOffMs / 3600000)
        console.log(`[bugtable-poller] 空闲 ${hours}h 无新 bug，poller 自动收工`)
        // 收工必须说一声：poller 是手动常驻的（无 launchd 守护），不通知的话下一个新 bug
        // 到了没人捞、群里也没有任何动静，只能靠人想起来查进程。
        await notify({
          kind: 'notice',
          lines: [
            `**详情**：bug 表轮询已连续 ${hours}h 无新 bug，已自动收工退出（群内 @ 机器人不受影响，仍正常工作）。`,
            '需要重新自动捞 bug 表时执行 `lark-bot poll-on`。',
          ],
          idempotencyKey: `poller-idle-off-${new Date().toISOString().slice(0, 13)}`,
        })
        break
      }
    }
  } while (!once)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const configArgIndex = process.argv.indexOf('--config')
  const configPath = configArgIndex >= 0 ? process.argv[configArgIndex + 1] : undefined
  if (!configPath) {
    console.error('usage: lark-bugtable-poller.mjs --config <path> [--once]')
    process.exit(1)
  }
  runLarkBugtablePoller({ configPath }).catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
