/**
 * worker 领任务的放行口径（aven 11-02「排空 / 自修期间照样分类和答疑」）。纯函数，不碰 IO。
 *
 * 原来排空重启、自修工单期间一律不领任务，连分类都停：11-02 真机一条 @bot 赶上排空，45 秒才回固定句、232 秒才领到。
 * 现在分三档：
 *   all     正常：什么都领。
 *   light   只领「轻活」——前置分类 + 只读任务（答疑 / 无页面工具的实测 / 日报），改代码、运维、起 dev 的实测都不领。
 *           自修工单在跑时一直是这一档（自修在 lark-bot 自己的 worktree 里改代码跑测试，和业务仓的只读任务互不相干）；
 *           排空开始后的头 DRAIN_LIGHT_WINDOW_MS 也是这一档。
 *   intake  只领前置分类（几秒一条）：排空超过窗口后。只读答疑动辄几分钟，排空里一直接会让重启迟迟等不到「0 在飞」。
 *   none    已发起 restart、等 SIGTERM：什么都不领（领了也会马上被优雅退出交还）。
 */

export const DRAIN_LIGHT_WINDOW_MS = 3 * 60_000

export const CLAIM_MODES = Object.freeze(['all', 'light', 'intake', 'none'])

export const resolveClaimMode = ({ draining = false, drainingSince = null, restartRequested = false, selfFixBusy = false, now = Date.now(), lightWindowMs = DRAIN_LIGHT_WINDOW_MS } = {}) => {
  if (restartRequested) return 'none'
  if (draining) {
    const since = Number(drainingSince)
    return Number.isFinite(since) && since > 0 && now - since < lightWindowMs ? 'light' : 'intake'
  }
  return selfFixBusy ? 'light' : 'all'
}

// 前置分类：received + intake.required，领了只跑只读分类、不建 worktree、不执行。
export const isIntakeTask = (task) => Boolean(task?.intake?.required)

// 轻活：分类，或路由出来是只读的任务（resolveWorkContext 的 readOnly；运维动作 readOnly=false，自然排除）。
export const isLightTask = ({ task, workContext }) => isIntakeTask(task) || workContext?.readOnly === true

export const claimAllowed = (mode, { task, workContext }) => {
  if (mode === 'all') return true
  if (mode === 'light') return isLightTask({ task, workContext })
  if (mode === 'intake') return isIntakeTask(task)
  return false
}

// 日志用：档位变化时打一行人话。
export const describeClaimMode = (mode) => ({
  all: '正常领任务',
  light: '只接分类和只读答疑（排空初期 / 自修工单在跑），改代码的任务等一等',
  intake: '只接分类（排空中，等在飞任务跑完就重启）',
  none: '已发起重启，不再领任务',
})[mode] || mode
