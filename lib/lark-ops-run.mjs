/**
 * 运维指令的执行（只给 worker，不进 gateway 闭包）：固定动作（aven 2026-11-01，选「收窄成固定动作」）。
 *   · ship：部署 dev / test（lib/lark-ship-run.mjs → lib/lark-ship.mjs）。
 *   · manual：部署 pre / online 这类 bot 不代办的，回一句怎么做（11-06 起；之前是 falive 的部署信 / 发 MR，falive 下线后删了）。
 * runPreExecutionGates 是 worker 开工前的两个出口：运维指令走这里；裸一句话的新需求停下等确认（原逻辑，从 task-runner 挪来）。
 */
import { formatStructuredAiResult } from './lark-ai-result-text.mjs'
import { runDailyReportTask } from './lark-daily-report.mjs'
import { isOpsOwner, manualDeployText, OPS_HELP, parseOpsAction } from './lark-ops-task.mjs'
import { openSelfRequest as defaultOpenSelfRequest, selfFixEnabled } from './lark-self-fix.mjs'
import { requirementGate } from './lark-work-policy.mjs'
import { updateTaskAudit } from './lark-worker-audit.mjs'
import { auditDirFor } from './lark-paths.mjs'
import { runShip as defaultShip } from './lark-ship-run.mjs'

/** 跑一条运维指令：认身份 → 认动作 → 跑固定动作。返回 { status }。 */
export const runOpsAction = async ({ task, workerConfig, reportStatus, updateAudit = () => {}, ship = defaultShip }) => {
  const config = workerConfig?.localConfig || {}
  const say = (status, text) => reportStatus(status, text, undefined, undefined, undefined, { outcome: opsOutcome({ text }) })
  if (!isOpsOwner(config, task.operator)) {
    await say('failed', '运维指令只接受负责人本人私信下达，这条没执行。')
    return { status: 'failed' }
  }
  const action = parseOpsAction(task.text)
  if (!action) {
    await say('done', `没认出要办哪件事，没动手。\n${OPS_HELP}`)
    return { status: 'done' }
  }
  // 部署 dev / test（lib/lark-ship.mjs）：fameex-web 主仓 + GitLab 令牌。
  if (action.action === 'ship') {
    updateAudit({ status: 'running_ops', ops: action })
    await reportStatus('running')
    const out = await ship({ task, action, localConfig: config, auditDir: auditDirFor(task.project) })
    updateAudit({ status: out.status, opsResult: out.text, completedAt: new Date().toISOString() })
    await reportStatus(out.status, out.text, undefined, undefined, undefined, { outcome: opsOutcome(out) })
    return { status: out.status }
  }
  await say('done', manualDeployText(action.env))
  return { status: 'done' }
}

// 运维结果的结构化 outcome：原文就是人话，出口原样私信负责人（失败前加 ⛔）。
const opsOutcome = (out) => ({ kind: 'ops', summary: String(out.text || '').split('\n')[0] || null, text: out.text, blockers: [], warnings: [] })

/**
 * Worker 开工前的出口（从 lark-task-runner 挪来，体量预算）。返回 true = 已处理完，runner 直接 return。
 *   0. 日报（11-02，lib/lark-daily-report.mjs）：脚本生成、私发负责人，不跑模型；dailyDeps 给单测换掉 git / bug 表 / 发送。
 *   1. 运维指令：固定动作（runOpsAction），不走需求闸 / worktree / 提交链 / 模型。
 *   2. 新需求放行闸（原逻辑不变）：只有「连自评材料都没有」的裸一句话新需求才在动 worktree、烧 AI 之前停下回待确认卡；
 *      有附件 / 正文有细节的放行到 runAI，由能读上下文的 AI 在只读分析阶段自评。人补一句预期行为（回复卡片即可）就续跑。
 */
// 改 bot 自己（workContext.selfRequest，11-04）：开一张需求型自修工单，本任务就此结束（done），群里回一句去向。
// 工单由 worker 空闲时的自修执行器跑；验收过了私信负责人，回「上线 <id>」才合进运行分支（lib/lark-self-fix-directive.mjs）。
export const runSelfRequest = async ({ task, workerConfig, auditContext, reportStatus, openSelfRequest = defaultOpenSelfRequest }) => {
  const opened = openSelfRequest({ task, enabled: selfFixEnabled({ localConfig: workerConfig?.localConfig }) })
  const ticketId = opened.id
  updateTaskAudit(auditContext, { status: ticketId ? 'done' : 'blocked', selfRequest: ticketId || null, completedAt: new Date().toISOString() })
  if (!ticketId) {
    const text = `这条要改的是 bot 自己，但这次没法自动接：${opened.reason}。aven 会手动处理。`
    return reportStatus('blocked', text, undefined, undefined, undefined, { outcome: { kind: 'worker', summary: text, blockers: [opened.reason], nextStep: null, warnings: [] } })
  }
  const text = `这条要改的是 bot 自己的逻辑，已转成 bot 自修工单 ${ticketId}：在 lark-bot 里改好、跑完测试后交 aven 确认，确认上线后在这里回复。`
  return reportStatus('done', text, undefined, undefined, undefined, { outcome: { kind: 'worker', summary: text, blockers: [], nextStep: null, warnings: [] } })
}

export const runPreExecutionGates = async ({ task, workContext, workerConfig, auditContext, executor, reportStatus, dailyDeps, openSelfRequest }) => {
  if (workContext.daily) {
    await runDailyReportTask({ task, workerConfig, reportStatus, deps: dailyDeps })
    return true
  }
  if (workContext.ops) {
    await runOpsAction({ task, workerConfig, reportStatus, updateAudit: (patch) => updateTaskAudit(auditContext, patch) })
    return true
  }
  if (workContext.selfRequest) {
    await runSelfRequest({ task, workerConfig, auditContext, reportStatus, openSelfRequest })
    return true
  }
  const gate = requirementGate(task)
  if (!gate) return false
  console.log(`[lark-worker] ${task.id} workKind=${gate.workKind}，等待人工确认预期行为（未执行 AI）`)
  updateTaskAudit(auditContext, { status: 'waiting_confirmation', workKind: gate.workKind, blockers: gate.blockers, completedAt: new Date().toISOString() })
  const summary = `这条任务被判定为新需求而非缺陷反馈，已停在实施之前等待确认。${gate.nextStep}`
  await reportStatus(
    'waiting_confirmation',
    formatStructuredAiResult({ status: 'waiting_confirmation', summary, blockers: gate.blockers }),
    executor,
    undefined,
    undefined,
    { outcome: { kind: 'worker', summary: '这条像是新需求，一句话还不够推出要做成什么样', blockers: gate.blockers, nextStep: gate.nextStep, warnings: [] } },
  )
  return true
}
