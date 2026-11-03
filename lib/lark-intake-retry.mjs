// 前置意图分类的瞬时失败重试：超时 / 断网 / 限流 / 5xx 不落终态 intake_failed，
// 放回 received 并按 notBefore 延后重分类（复用去抖的延迟领取），用完次数才算失败（教训 #37）。
export const INTAKE_RETRY_DELAYS_MS = [60_000, 180_000]
const TRANSIENT_INTAKE_ERROR_RE = /timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|overloaded|rate.?limit|\b(429|5\d\d)\b/i

export const isTransientIntakeError = (error) => TRANSIENT_INTAKE_ERROR_RE.test(String(error || ''))

// 该重试 → 返回要合并进任务的字段；不该重试（非瞬时 / 次数用完）→ null。
export const planIntakeRetry = (task, error, now = Date.now()) => {
  const retries = task.intake?.retries || 0
  if (!error || !isTransientIntakeError(error) || retries >= INTAKE_RETRY_DELAYS_MS.length) return null
  const notBefore = new Date(now + INTAKE_RETRY_DELAYS_MS[retries]).toISOString()
  return {
    status: 'received',
    claimedAt: null,
    updatedAt: new Date(now).toISOString(),
    intake: { ...task.intake, retries: retries + 1, lastError: String(error).slice(0, 300), notBefore },
  }
}

// 分类中被并入了话题补充（lark-intake-ack mergeThreadSupplement 标的 intake.reclassify，11-03 静态 review R7）：worker 拿旧正文算的
// 结果作废（成功 / 报错都一样），放回 received 立刻可领、带着补充重分类一次。不换代（没在执行代码）、不计瞬时重试次数。
// 标了才改任务、持久化并返回 resolveIntake 的结果；没标返回 null。
export const planReclassify = (task, { persist = () => {}, now = Date.now() } = {}) => {
  if (task?.intake?.reclassify !== true) return null
  delete task.intake.reclassify
  task.intake.notBefore = null
  task.status = 'received'
  task.claimedAt = null
  task.updatedAt = new Date(now).toISOString()
  persist(task)
  return { ok: true, actionable: false, retried: true, reclassify: true, task }
}
// 领取时清残留标记：标记只指「领走之后又并入了补充」，这次领取读的就是最新正文。
export const clearReclassify = (task) => {
  if (task?.intake?.reclassify) delete task.intake.reclassify
}
