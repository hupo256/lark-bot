/**
 * bug 发现两档调度的一轮（aven 2026-11-01，B2）：推进时钟 → 到期的入口跑一遍（读通知 / 对账）→ 自动开关档。
 * 每轮由 lark-bugtable-poller 的 watch 循环调用（tick 默认 1 分钟）；所有外部依赖注入，测试不碰 lark-cli / gateway。
 */
import { assigneeHasOpenId, BUGTABLE_FIELD_DEFAULTS, buildBugStatusFilter, readStatusText } from './lark-bugtable-parse.mjs'
import { isProjectId } from './lark-project-id.mjs'
import {
  dueActions,
  formatModeSwitch,
  maybeAutoOff,
  notificationsAfter,
  onNewBugs,
  pickNotifiedRecord,
  reconcileAgainstBaseline,
  tickClock,
  titleProbe,
} from './lark-bug-watch.mjs'
import { WATCH_SELF_FIX_AFTER } from './lark-bug-watch-io.mjs'

const ENTRY_LABEL = { notify: '读新 bug 通知', reconcile: '对账' }

/**
 * deps:
 *   readMessages({ chatId, cursor, now }) → { messages, cursorInit?, readFrom }
 *   listRecords({ filter }) → records
 *   listTasks() → Map(recordId → task)
 *   handleRecords({ records, taskById }) → counts
 *   save(state)、dm(text)、recordFailure({ entry, error, consecutive, context }) → { external, selfFix }
 */
export const runWatchRound = async ({ config, cfg, state: initial, now = Date.now(), deps }) => {
  const bug = config.bugTable
  const myOpenId = bug.myOpenId || config.taskMentionOpenIds?.[0]
  const titleField = bug.titleField || BUGTABLE_FIELD_DEFAULTS.titleField
  const projectField = bug.projectField || BUGTABLE_FIELD_DEFAULTS.projectField
  let state = tickClock(initial, now, cfg)
  const report = { notify: null, reconcile: null, switched: [] }
  const persist = () => deps.save(state)
  const due = dueActions(state, now, cfg)

  const guard = async (entry, run) => {
    try {
      const out = await run()
      if ((state.failures?.[entry] || 0) >= WATCH_SELF_FIX_AFTER) await deps.dm(`${ENTRY_LABEL[entry]}恢复正常。`)
      state = { ...state, failures: { ...state.failures, [entry]: 0 } }
      return out
    } catch (error) {
      const consecutive = (state.failures?.[entry] || 0) + 1
      state = { ...state, failures: { ...state.failures, [entry]: consecutive } }
      const outcome = deps.recordFailure({ entry, error, consecutive, context: `模式 ${state.mode}，断点 ${JSON.stringify(state.cursor)}` })
      if (consecutive === WATCH_SELF_FIX_AFTER) {
        await deps.dm([
          `⚠ ${ENTRY_LABEL[entry]}已连续 ${consecutive} 次失败，期间${entry === 'notify' ? '新 bug 通知读不到' : '验退 / 漏掉的 bug 捞不到'}。`,
          `原因：${String(error?.message || error).slice(0, 160)}`,
          ...(outcome?.external ? ['外部原因（网络 / 登录 / 权限），只告警。'] : outcome?.selfFix?.opened ? [`已开自修工单 ${outcome.selfFix.id}。`] : []),
        ].join('\n'))
      }
      return { error }
    } finally {
      persist()
    }
  }

  const handleNotification = async (notification, taskById) => {
    const label = `${notification.project || '?'}「${notification.title.slice(0, 40)}」`
    if (!isProjectId(notification.project) || !notification.title) {
      await deps.dm(`读到一条新 bug 通知，但项目号或标题不完整：${label}\n没开工。回我记录链接或项目号我再接。`)
      return 'unlocated'
    }
    const records = await deps.listRecords({
      filter: { logic: 'and', conditions: [[projectField, '==', notification.project], [titleField, 'intersects', titleProbe(notification.title)]] },
    })
    const picked = pickNotifiedRecord({
      records,
      title: notification.title,
      myOpenId,
      readTitle: (record) => readStatusText(record.fields?.[titleField]),
      isMine: (record, id) => assigneeHasOpenId(record.fields?.[bug.assigneeField], id),
    })
    if (!picked.record) {
      await deps.dm(`新 bug 通知：${label}\n在表里${picked.reason === 'multiple' ? `找到 ${picked.count} 条同名、都分给你` : '没找到分给你的同名记录'}，没开工（不猜）。\n回我记录链接我再接。`)
      return 'unlocated'
    }
    await deps.handleRecords({ records: [picked.record], taskById })
    return 'handled'
  }

  if (due.notify) {
    report.notify = await guard('notify', async () => {
      const read = await deps.readMessages({ chatId: cfg.notifyChatId, cursor: state.cursor, now })
      if (read.cursorInit) {
        state = { ...state, cursor: read.cursorInit, lastNotifyReadAt: now }
        return { init: true }
      }
      const fresh = notificationsAfter(read.messages, state.cursor)
      const taskById = fresh.length ? await deps.listTasks() : new Map()
      const outcomes = []
      for (const notification of fresh) {
        outcomes.push(await handleNotification(notification, taskById))
        // 每处理完一条就落断点：中途失败下轮从这条之后接着读，不重复、不漏
        state = { ...state, cursor: { ...state.cursor, position: notification.position } }
        persist()
      }
      state = { ...state, cursor: { ...state.cursor, readFrom: read.readFrom }, lastNotifyReadAt: now }
      if (fresh.length) {
        const turned = onNewBugs(state, fresh.length, now)
        state = turned.state
        if (turned.switched) {
          report.switched.push('on')
          await deps.dm(formatModeSwitch({ switched: 'on', notification: fresh[0], cfg }))
        }
        if (fresh.length >= 3) await deps.dm(`补读了 ${fresh.length} 条新 bug 通知（可能是合盖 / 离线期间来的）。\n都已按项目分流处理。`)
      }
      return { fresh: fresh.length, outcomes }
    })
  }

  if (due.reconcile) {
    report.reconcile = await guard('reconcile', async () => {
      const all = await deps.listRecords({ filter: buildBugStatusFilter(bug) })
      const pickUp = [myOpenId, ...(cfg.team?.enabled ? cfg.team.assignees : [])]
      const mine = all.filter((record) => pickUp.some((id) => assigneeHasOpenId(record.fields?.[bug.assigneeField], id)))
      const result = reconcileAgainstBaseline({ baseline: state.baseline, records: mine, readStatus: (record) => readStatusText(record.fields?.[bug.statusField]), now })
      state = { ...state, baseline: result.baseline, lastReconcileAt: now }
      if (result.created) {
        const rejected = mine.filter((record) => readStatusText(record.fields?.[bug.statusField]) === bug.rejectedValue).length
        await deps.dm([
          `bug 对账基线已建：你头上现有 ${mine.length} 条未结。`,
          `- 待处理 ${mine.length - rejected} 条`,
          `- 验退 ${rejected} 条`,
          '这些不自动开工；之后新来的、状态变了的（如被验退）才处理。',
          '要修其中某条，回我记录链接。',
        ].join('\n'))
        return { baseline: mine.length }
      }
      const counts = result.actionable.length ? await deps.handleRecords({ records: result.actionable, taskById: await deps.listTasks() }) : null
      return { actionable: result.actionable.length, counts }
    })
  }

  const off = maybeAutoOff(state, cfg, now)
  if (off.switched) {
    state = off.state
    report.switched.push('off')
    await deps.dm(formatModeSwitch({ switched: 'off', cfg }))
  }
  persist()
  return { state, report }
}
