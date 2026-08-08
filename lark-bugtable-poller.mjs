#!/usr/bin/env node

/**
 * Lark bug 多维表格轮询器（能力3）。
 *
 * 周期性读取 bug 表里「负责人=我 且 状态=待处理」的记录，去重后投递到本地
 * Bot Gateway 队列（POST /lark/tasks），复用 worker → AI → 回群 → 回写状态 的统一链路。
 * 鉴权走 lark-cli 已登录的 bot 身份，不在配置里放 app 级密钥。
 *
 * 规则来源：apps/web/docs_tdd/common/lark-bot-gateway.md、lark-doc-sync.md。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'

import { isProjectId } from './lib/lark-message.mjs'

const larkCliBin = process.env.LARK_CLI_BIN || 'lark-cli'
const defaultGatewayUrl = process.env.LARK_GATEWAY_URL || 'http://127.0.0.1:3005'
const ACTIVE_TASK_STATUSES = new Set(['received', 'queued', 'running', 'verifying', 'done_pending_writeback'])
const WAITING_TASK_STATUSES = new Set(['blocked', 'waiting_confirmation'])

export const classifyBugTaskStatus = (status) => {
  if (status === 'done') return 'done'
  if (ACTIVE_TASK_STATUSES.has(status)) return 'in-flight'
  if (WAITING_TASK_STATUSES.has(status)) return 'waiting'
  if (status === 'failed') return 'failed'
  return 'new'
}
const defaultPollMs = Number(process.env.LARK_BUGTABLE_POLL_MS || 90000)
// 空闲自动收工：连续这么久没有新 bug 就自动退出，忘了 poll-off 也无害（默认 4h）
const defaultIdleOffMs = Number(process.env.LARK_BUGTABLE_IDLE_OFF_MS || 4 * 60 * 60 * 1000)
// lark-cli 子进程超时兜底（默认 60s）
const larkCliTimeoutMs = Number(process.env.LARK_CLI_TIMEOUT_MS || 60000)
// 与 gateway 约定的本地 API 共享密钥（可选）
const gatewaySecret = process.env.LARK_GATEWAY_SECRET || ''

const runLarkCli = (args, { timeoutMs = larkCliTimeoutMs } = {}) =>
  new Promise((resolveFn) => {
    // 强制 bot 身份（同 lib/lark-cli.mjs）：defaultAs:auto 会选 user，bitable 读写需 bot scope。
    const child = spawn(larkCliBin, ['--as', 'bot', ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveFn(result)
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // 进程可能已退出
        }
      }, 3000)
      finish({ code: -1, stdout, stderr: `${stderr}\n[lark-cli timeout after ${timeoutMs}ms]`.slice(-200) })
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => finish({ code: -1, stdout, stderr: String(error) }))
    child.on('exit', (code) => finish({ code, stdout, stderr }))
  })

const loadConfig = (configPath) => {
  const absolute = resolve(configPath)
  if (!existsSync(absolute)) {
    throw new Error(`Missing config: ${absolute}`)
  }
  return JSON.parse(readFileSync(absolute, 'utf8'))
}

// 已处理 record_id 持久化，避免重复建 task
const createSeenStore = (statePath) => {
  mkdirSync(dirname(statePath), { recursive: true })
  const seen = existsSync(statePath) ? new Set(JSON.parse(readFileSync(statePath, 'utf8')).seen || []) : new Set()
  return {
    has: (id) => seen.has(id),
    add(id) {
      seen.add(id)
      writeFileSync(statePath, JSON.stringify({ seen: [...seen] }, null, 2))
    },
  }
}

// 人员字段值形如 [{id/open_id, name}]；判断是否含目标 open_id
const assigneeHasOpenId = (value, openId) => {
  if (!openId || !Array.isArray(value)) return false
  return value.some((person) => person?.id === openId || person?.open_id === openId)
}

// 单选/文本状态字段取文本值
const readStatusText = (value) => {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map((v) => v?.text || v?.name || '').join('')
  return value?.text || value?.name || ''
}

// 项目ID 列值形如 "PR-01947" / "PM-1469\n"（探针见过尾部换行），取文本并去空白
const readProjectId = ({ fields, bug }) => readStatusText(fields[bug.projectField || '项目ID']).trim()

// 把记录正文拼成给 AI 的 task 文本
const buildBugText = ({ record, bug }) => {
  const fields = record.fields || {}
  const title = readStatusText(fields[bug.titleField || '问题标题']) || '(无标题)'
  const desc = readStatusText(fields[bug.descField || '问题描述（复现步骤）']) || ''
  const projectId = readProjectId({ fields, bug })
  return [
    `修复：Lark bug 表待处理项 [${title}]`,
    projectId ? `项目：${projectId}` : '项目：(表格未填项目ID，无法确定目标仓库，请在结果里说明)',
    `记录 ID：${record.record_id}`,
    `描述：${desc || '(表格未填描述，请结合标题与项目文档定位)'}`,
  ].join('\n')
}

// base +record-list 返回列式结构：data.fields 是列名字符串数组，data.data 是行（单元格数组），
// data.record_id_list 是并行的 record_id。这里 zip 回 { record_id, fields } 记录对象。
const parseColumnarRecords = (data) => {
  const cols = data.fields || []
  const rows = data.data || []
  const ids = data.record_id_list || []
  return rows.map((row, rowIndex) => {
    const fields = {}
    cols.forEach((name, colIndex) => {
      fields[name] = row[colIndex]
    })
    return { record_id: ids[rowIndex], fields }
  })
}

// 服务端按状态过滤 + 翻页拉全（待处理可能 >200），仅投影需要的列以减小 payload
const fetchPendingRecords = async ({ bug }) => {
  const filterJson = JSON.stringify({
    logic: 'and',
    conditions: [[bug.statusField, '==', bug.pendingValue]],
  })
  const projected = [
    bug.statusField,
    bug.assigneeField,
    bug.projectField || '项目ID',
    bug.titleField || '问题标题',
    bug.descField || '问题描述（复现步骤）',
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

const enqueueTask = async ({ gatewayUrl, record, bug, chatId }) => {
  // 校验项目号：只把合法 PR-#### / PM-#### 传给 gateway；异常单元格（如 ../../x）不作为 project，
  // 交由 worker 走 adhoc 临时 worktree，避免污染路径/分支名。
  const rawProject = readProjectId({ fields: record.fields || {}, bug })
  const project = isProjectId(rawProject) ? rawProject.toUpperCase() : undefined
  const response = await fetch(`${gatewayUrl}/lark/tasks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(gatewaySecret ? { 'x-lark-gateway-secret': gatewaySecret } : {}),
    },
    body: JSON.stringify({
      id: record.record_id,
      source: 'lark-bugtable',
      recordId: record.record_id,
      project,
      chatId,
      text: buildBugText({ record, bug }),
    }),
  })
  if (!response.ok) {
    throw new Error(`enqueue failed: ${response.status} ${await response.text()}`)
  }
}

// 读 gateway 当前所有任务的状态（record_id → status），作为去重与「是否在处理中」的权威依据
const fetchGatewayTaskStatuses = async (gatewayUrl) => {
  const response = await fetch(`${gatewayUrl}/lark/tasks`, {
    headers: gatewaySecret ? { 'x-lark-gateway-secret': gatewaySecret } : {},
  })
  if (!response.ok) throw new Error(`list tasks failed: ${response.status}`)
  const { tasks = [] } = await response.json()
  const byId = new Map()
  for (const task of tasks) byId.set(task.id, task.status)
  return byId
}

const runOnce = async ({ config, seen, gatewayUrl }) => {
  const bug = config.bugTable
  if (!bug?.appToken || !bug?.tableId) {
    throw new Error('config.bugTable.appToken / tableId are required')
  }
  const records = await fetchPendingRecords({ bug })
  const mine = records.filter((record) => assigneeHasOpenId(record.fields?.[bug.assigneeField], bug.myOpenId))
  // 用 gateway 任务状态（而非「入队即永久 seen」）判断去重：避免 failed 的 bug 既留在表里待处理、
  // 又被本地 seen 挡住永不再捞而静默消失。seen 只缓存已确认 done 的记录（跨重启防重入队）。
  const statusById = await fetchGatewayTaskStatuses(gatewayUrl)
  let enqueued = 0
  let inFlight = 0
  let waiting = 0
  let stuck = 0
  for (const record of mine) {
    const id = record.record_id
    if (seen.has(id)) continue // 已知终态成功
    const disposition = classifyBugTaskStatus(statusById.get(id))
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
    if (disposition === 'failed') {
      // 上次失败：群里已收到失败卡片，表格保持待处理待人工介入。此处不自动重跑（避免对
      // 真正修不动的 bug 无限重试 AI、刷群烧钱）；仅计数暴露，需人工在群里重触发或手动处理。
      stuck += 1
      continue
    }
    // 全新记录 → 入队
    await enqueueTask({ gatewayUrl, record, bug, chatId: bug.chatId || config.allowedChatIds?.[0] })
    enqueued += 1
    console.log(`[bugtable-poller] enqueued ${id}`)
  }
  console.log(`[bugtable-poller] pending=${records.length} mine=${mine.length} new=${enqueued} in-flight=${inFlight} waiting=${waiting} stuck-failed=${stuck}`)
  return enqueued
}

export async function runLarkBugtablePoller({
  configPath,
  gatewayUrl = defaultGatewayUrl,
  pollMs = defaultPollMs,
  idleOffMs = defaultIdleOffMs,
  argv = process.argv.slice(2),
}) {
  const config = loadConfig(configPath)
  // 状态文件放在项目 agent/ 下（configPath 在 agent/scripts/ 内）
  const statePath = join(dirname(resolve(configPath)), '..', 'lark-bugtable-state.json')
  const seen = createSeenStore(statePath)
  const once = argv.includes('--once')

  let idleMs = 0
  do {
    try {
      const enqueued = await runOnce({ config, seen, gatewayUrl })
      idleMs = enqueued > 0 ? 0 : idleMs
    } catch (error) {
      console.error('[bugtable-poller]', error.message)
    }
    if (!once) {
      await new Promise((r) => setTimeout(r, pollMs))
      idleMs += pollMs
      if (idleOffMs > 0 && idleMs >= idleOffMs) {
        console.log(`[bugtable-poller] 空闲 ${Math.round(idleOffMs / 3600000)}h 无新 bug，poller 自动收工`)
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
