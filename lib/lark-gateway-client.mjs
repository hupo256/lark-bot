/**
 * Lark Worker 与本地 Gateway 的 HTTP 客户端层：统一注入共享密钥头、对幂等请求做瞬时错误重试，
 * 并用 createGatewayClient 把 worker 用到的各条任务 API 封成一组绑定 gatewayUrl 的方法。
 */

import { secretHeaders } from './lark-config.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const TRANSIENT_GATEWAY_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_SOCKET'])

const isTransientGatewayError = (error) =>
  TRANSIENT_GATEWAY_CODES.has(error?.code) ||
  TRANSIENT_GATEWAY_CODES.has(error?.cause?.code) ||
  (error instanceof TypeError && /fetch failed/i.test(error.message))

// 本地 Gateway 偶发 ECONNRESET 时，仅幂等请求可自动重试；claim/next 绝不重试，避免响应丢失后重复领取。
export const requestJson = async (
  gatewayUrl,
  path,
  options = {},
  { fetchImpl = fetch, sleepImpl = sleep } = {},
) => {
  const { retryTransient = false, ...fetchOptions } = options
  const attempts = retryTransient ? 3 : 1
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(`${gatewayUrl}${path}`, {
        ...fetchOptions,
        headers: {
          'Content-Type': 'application/json',
          ...secretHeaders(),
          ...(fetchOptions.headers || {}),
        },
      })

      if (!response.ok) {
        throw new Error(`${fetchOptions.method || 'GET'} ${path} failed: ${response.status} ${await response.text()}`)
      }
      return response.json()
    } catch (error) {
      if (attempt === attempts || !isTransientGatewayError(error)) throw error
      console.warn(`[lark-worker] Gateway 瞬时连接失败，重试 ${attempt}/${attempts - 1}：${path} (${error.cause?.code || error.code || error.message})`)
      await sleepImpl(attempt * 150)
    }
  }
}

// 绑定单个 gatewayUrl，暴露 worker 调度/回写用到的一组任务 API。
// 写请求（status）走 reliable（幂等重试）；claim/next 用非重试 request（避免重复领取）。
export const createGatewayClient = (gatewayUrl) => {
  const request = (path, options) => requestJson(gatewayUrl, path, options)
  const reliableRequest = (path, options = {}) => requestJson(gatewayUrl, path, { ...options, retryTransient: true })

  const listTasks = async () => {
    const { tasks = [] } = await reliableRequest('/lark/tasks')
    return tasks
  }

  return {
    request,
    reliableRequest,
    listTasks,
    updateTask: (taskId, status, result, executor, epoch, owner, branch) =>
      reliableRequest(`/lark/tasks/${encodeURIComponent(taskId)}/status`, {
        method: 'POST',
        body: JSON.stringify({ status, result, aiExecutor: executor, epoch, owner, branch }),
      }),
    resolveIntake: (taskId, { epoch, classification, error } = {}) =>
      reliableRequest(`/lark/tasks/${encodeURIComponent(taskId)}/intake`, {
        method: 'POST',
        body: JSON.stringify({ epoch, classification, error }),
      }),
    getTask: async (taskId) => (await listTasks()).find((item) => item.id === taskId),
    getNextPendingTask: async () => (await request('/lark/tasks/next', { method: 'POST' })).task,
    claimTask: async (taskId) => (await request(`/lark/tasks/${encodeURIComponent(taskId)}/claim`, { method: 'POST' })).task,
    // 优雅退出时交还在跑任务：让 gateway 把该 running 任务重置回 queued（epoch++），重启后的 worker 立刻重领。
    // 用 reliableRequest 带瞬时重试——退出瞬间 gateway 可能也在重启，值得多试几次。
    releaseTask: (taskId) => reliableRequest(`/lark/tasks/${encodeURIComponent(taskId)}/release`, { method: 'POST' }),
    // 可领取任务（queued/received）按创建时间升序，供调度器挑选
    listClaimable: async () =>
      (await listTasks())
        .filter((item) => item.status === 'queued' || item.status === 'received')
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)),
    // bug 表 poller 用：新记录入队 / QA 验退开新一轮。两者共用同一 body 形状，仅 endpoint 不同。
    // 与原 poller 实现保持一致：不重试（幂等性靠 store.upsert/reopenFromQaReturn 兜底，但避免引入行为变化）。
    enqueueTask: (body) => request('/lark/tasks', { method: 'POST', body: JSON.stringify(body) }),
    reopenTask: (recordId, body) =>
      request(`/lark/tasks/${encodeURIComponent(recordId)}/reopen`, { method: 'POST', body: JSON.stringify(body) }),
  }
}

export { sleep }
