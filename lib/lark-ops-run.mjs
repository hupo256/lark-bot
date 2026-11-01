/**
 * 运维指令的执行（只给 worker，不进 gateway 闭包）：固定动作，固定命令，不跑模型（aven 2026-11-01，选「收窄成固定动作」）。
 *   · deploy：〔可选〕先查 mergedFrom 环境的提交是否都已进目标环境（git cherry，按补丁比）→ deploy_mail.py info（build 绿、有新内容）
 *     → 按提交标题生成主题摘要 / 更新说明 → 没说「直接发」只回将要发的内容；说了就 draft + send（send 后脚本自动盯部署、复测）。
 *   · mr：推开发分支，push option 建发往目标环境的 MR。
 * runPreExecutionGates 是 worker 开工前的两个出口：运维指令走这里；裸一句话的新需求停下等确认（原逻辑，从 task-runner 挪来）。
 * 配置 config.opsActions = { repo（业务仓，git 命令在这里跑）, deployMail（deploy_mail.py 路径）, devBranch（发 MR 推的分支）}。
 */
import { spawnSync } from 'node:child_process'

import { formatStructuredAiResult } from './lark-ai-executor.mjs'
import { composeDeploySummary, isOpsOwner, OPS_HELP, parseOpsAction } from './lark-ops-task.mjs'
import { requirementGate } from './lark-work-policy.mjs'
import { updateTaskAudit } from './lark-worker-audit.mjs'

const tail = (text, n = 300) => String(text || '').trim().slice(-n)
const short = (sha) => String(sha || '').slice(0, 8)

const defaultRun = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 5 * 60_000 })

/** 部署邮件。返回 { status, text }。 */
export const runDeployAction = ({ action, opts, run = defaultRun }) => {
  const { repo, deployMail } = opts
  if (action.mergedFrom) {
    run('git', ['-C', repo, 'fetch', '-q', 'origin'])
    const cherry = run('git', ['-C', repo, 'cherry', `origin/${action.env}`, `origin/${action.mergedFrom}`])
    if (cherry.status !== 0) return { status: 'failed', text: `查 ${action.mergedFrom} → ${action.env} 合没合失败：${tail(cherry.stderr)}` }
    const missing = String(cherry.stdout || '').split('\n').filter((line) => line.startsWith('+ ')).map((line) => line.slice(2).trim())
    if (missing.length) {
      const lines = missing.slice(0, 10).map((sha) => `- ${String(run('git', ['-C', repo, 'log', '-1', '--format=%h %s', sha]).stdout || sha).trim().slice(0, 100)}`)
      return { status: 'blocked', text: [`${action.mergedFrom} 上还有 ${missing.length} 个提交没进 ${action.env}，没发部署信：`, ...lines].join('\n') }
    }
  }
  const infoRun = run('python3', ['-I', deployMail, 'info', '--env', action.env])
  if (infoRun.status !== 0) return { status: 'failed', text: `取 ${action.env} 部署信息失败：${tail(infoRun.stderr || infoRun.stdout)}` }
  let info
  try { info = JSON.parse(infoRun.stdout) } catch { return { status: 'failed', text: `部署信息不是 JSON：${tail(infoRun.stdout)}` } }
  if (info.job?.status !== 'success') return { status: 'blocked', text: `build:${action.env}${info.job?.id ? ` #${info.job.id}` : ''} 状态是 ${info.job?.status || '取不到'}，没绿不发。` }
  if (info.sha === info.baseline) return { status: 'blocked', text: `${action.env} 已经是 ${short(info.sha)}（${info.baselineFrom || '上次部署'}），没有新内容，不发。` }
  const { subjectSummary, update } = composeDeploySummary(info.commits)
  const plan = [`- 主题摘要：${subjectSummary}`, `- Jobid：${info.job.id}（${action.env} 分支 ${short(info.sha)}）`, `- 更新说明：${update}`]
  if (!action.autoSend) {
    return { status: 'done', text: [`${action.env} 部署信准备好了，还没发：`, ...plan, `确认就回我「部署 ${action.env} 直接发」。`].join('\n') }
  }
  const draftRun = run('python3', ['-I', deployMail, 'draft', '--env', action.env, '--subject-summary', subjectSummary, '--update', update])
  const draftJson = String(draftRun.stdout || '').split('--- body ---')[0]
  let draft
  try { draft = JSON.parse(draftJson) } catch { draft = null }
  if (draftRun.status !== 0 || !draft?.draft_id) return { status: 'failed', text: `起草 ${action.env} 部署信失败：${tail(draftRun.stderr || draftRun.stdout)}` }
  const sendRun = run('python3', ['-I', deployMail, 'send', draft.draft_id])
  if (sendRun.status !== 0) return { status: 'failed', text: `草稿已建但发送失败（草稿 ${draft.draft_id}）：${tail(sendRun.stderr || sendRun.stdout)}` }
  return {
    status: 'done',
    text: [
      `已发 ${action.env} 部署信：`,
      `- 主题：${draft.subject}`,
      `- Jobid：${draft.jobid}（${short(draft.sha)}）`,
      `- 收件人：${(draft.to || []).join('、')}`,
      action.env === 'pre' ? 'pre 部署后 bot 会自动探测并复测。' : `运维部署好后会自动探测、在 ${action.env} 复测并私信你。`,
    ].join('\n'),
  }
}

/** 推开发分支并建发往 env 的 MR。返回 { status, text }。 */
export const runMrAction = ({ action, opts, run = defaultRun }) => {
  const push = run('git', ['-C', opts.repo, 'push', '-o', 'merge_request.create', '-o', `merge_request.target=${action.env}`, 'origin', opts.devBranch])
  const out = `${push.stdout || ''}\n${push.stderr || ''}`
  if (push.status !== 0) return { status: 'failed', text: `推 ${opts.devBranch} 失败：${tail(out)}` }
  if (/Everything up-to-date/i.test(out)) return { status: 'done', text: `${opts.devBranch} 没有新提交，不用推。` }
  const url = /https?:\/\/\S+\/merge_requests\/\d+/.exec(out)?.[0]
  return { status: 'done', text: url ? `已推 ${opts.devBranch}，发往 ${action.env} 的 MR：\n${url}` : `已推 ${opts.devBranch}，但没从输出里认出 MR 链接，去 GitLab 看一下发往 ${action.env} 的 MR。` }
}

/** 跑一条运维指令：认身份 → 认动作 → 跑固定动作。返回 { status }。 */
export const runOpsAction = async ({ task, workerConfig, reportStatus, updateAudit = () => {}, run }) => {
  const config = workerConfig?.localConfig || {}
  if (!isOpsOwner(config, task.operator)) {
    await reportStatus('failed', '处理失败。\n运维指令只接受负责人本人私信下达，这条没执行。')
    return { status: 'failed' }
  }
  const opts = config.opsActions || {}
  const action = parseOpsAction(task.text)
  if (!action) {
    await reportStatus('done', `没认出要办哪件事，没动手。\n${OPS_HELP}`)
    return { status: 'done' }
  }
  const missing = ['repo', ...(action.action === 'deploy' ? ['deployMail'] : ['devBranch'])].filter((key) => !opts[key])
  if (missing.length) {
    await reportStatus('failed', `处理失败。\n运维配置缺 opsActions.${missing.join(' / ')}，没执行。`)
    return { status: 'failed' }
  }
  updateAudit({ status: 'running_ops', ops: action })
  await reportStatus('running')
  const out = action.action === 'deploy' ? runDeployAction({ action, opts, run }) : runMrAction({ action, opts, run })
  updateAudit({ status: out.status, opsResult: out.text, completedAt: new Date().toISOString() })
  await reportStatus(out.status, out.text)
  return { status: out.status }
}

/**
 * Worker 开工前的两个出口（从 lark-task-runner 挪来，体量预算）。返回 true = 已处理完，runner 直接 return。
 *   1. 运维指令：固定动作（runOpsAction），不走需求闸 / worktree / 提交链 / 模型。
 *   2. 新需求放行闸（原逻辑不变）：只有「连自评材料都没有」的裸一句话新需求才在动 worktree、烧 AI 之前停下回待确认卡；
 *      有附件 / 正文有细节的放行到 runAI，由能读上下文的 AI 在只读分析阶段自评。人补一句预期行为（回复卡片即可）就续跑。
 */
export const runPreExecutionGates = async ({ task, workContext, workerConfig, auditContext, executor, reportStatus, run }) => {
  if (workContext.ops) {
    await runOpsAction({ task, workerConfig, reportStatus, updateAudit: (patch) => updateTaskAudit(auditContext, patch), run })
    return true
  }
  const gate = requirementGate(task)
  if (!gate) return false
  console.log(`[lark-worker] ${task.id} workKind=${gate.workKind}，等待人工确认预期行为（未执行 AI）`)
  updateTaskAudit(auditContext, { status: 'waiting_confirmation', workKind: gate.workKind, blockers: gate.blockers, completedAt: new Date().toISOString() })
  await reportStatus(
    'waiting_confirmation',
    formatStructuredAiResult({
      status: 'waiting_confirmation',
      summary: `这条任务被判定为新需求而非缺陷反馈，已停在实施之前等待确认。${gate.nextStep}`,
      blockers: gate.blockers,
    }),
    executor,
  )
  return true
}
