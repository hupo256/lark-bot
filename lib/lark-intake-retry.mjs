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
