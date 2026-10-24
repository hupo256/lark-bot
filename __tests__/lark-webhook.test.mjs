import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { isConnectError, sendWebhookMessage } from '../lib/lark-webhook.mjs'

// webhook 重试只对「确定没送达」的失败（aven 2026-10-20 review）：自定义机器人没有幂等键，超时重试可能群里发两条。
const run = async (fetchImpl) => {
  let attempts = 0
  const out = await sendWebhookMessage({ url: 'https://x', card: '{}', retries: 3, sleepImpl: async () => {}, fetchImpl: async (...args) => { attempts += 1; return fetchImpl(attempts, ...args) } })
  return { out, attempts }
}
const fetchFailed = (code) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) })

describe('webhook 重试只对确定没送达的失败', () => {
  it('连接没建立和 502 / 503 才重试，超时 / 中途断开 / 读 body 失败 / 其它状态码不重试', async () => {
    {
      const t1 = '连接没建立（ECONNREFUSED / ENOTFOUND / 连接超时）→ 重试，后一次成功就算成功'
      assert.equal(isConnectError(fetchFailed('ECONNREFUSED')), true, t1)
      assert.equal(isConnectError(fetchFailed('ECONNRESET')), false, '连接中途断开：可能已送达，不算')
      // TLS 握手失败（ERR_SSL_*）：请求没发出去，同样重试（10-24 真机「收到」丢失）
      assert.equal(isConnectError(fetchFailed('ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR')), true, t1)
      const tls = await run(async (n) => {
        if (n === 1) throw fetchFailed('ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR')
        return { ok: true, status: 200, text: async () => '{"code":0}' }
      })
      assert.deepEqual([tls.out.ok, tls.attempts], [true, 2], t1)
      const { out, attempts } = await run(async (n) => {
        if (n === 1) throw fetchFailed('ENOTFOUND')
        if (n === 2) throw fetchFailed('UND_ERR_CONNECT_TIMEOUT')
        return { ok: true, status: 200, text: async () => '{"code":0}' }
      })
      assert.equal(out.ok, true, t1)
      assert.equal(attempts, 3, t1)
    }

    {
      const t2 = '请求超时 / 连接中途断开 → 不重试（可能已送达）'
      const timeout = await run(async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }) })
      assert.equal(timeout.out.ok, false, t2)
      assert.equal(timeout.attempts, 1, t2)
      assert.match(timeout.out.reason, /可能已送达/, t2)
      const reset = await run(async () => { throw fetchFailed('ECONNRESET') })
      assert.equal(reset.attempts, 1, t2)
    }

    {
      const t3 = '已拿到响应但读 body 失败 → 不重试'
      const { out, attempts } = await run(async () => ({ ok: true, status: 200, text: async () => { throw new Error('terminated') } }))
      assert.equal(out.ok, false, t3)
      assert.equal(attempts, 1, t3)
      assert.match(out.reason, /读响应失败/, t3)
    }

    {
      const t4 = '502 / 503 重试；500 / 504 / 200 但解析不了 / 4xx 带错误码都不重试'
      for (const status of [502, 503]) {
        const { attempts } = await run(async () => ({ ok: false, status, text: async () => 'bad gateway' }))
        assert.equal(attempts, 3, `${status} 重试`)
      }
      for (const status of [500, 504]) {
        const { attempts } = await run(async () => ({ ok: false, status, text: async () => 'oops' }))
        assert.equal(attempts, 1, `${status} 不重试`)
      }
      assert.equal((await run(async () => ({ ok: true, status: 200, text: async () => '<html>' }))).attempts, 1, t4)
      assert.equal((await run(async () => ({ ok: false, status: 400, text: async () => '{"code":19001}' }))).attempts, 1, t4)
      assert.equal((await run(async () => ({ ok: true, status: 200, text: async () => '{"code":11232,"msg":"frequency limited"}' }))).attempts, 1, t4)
    }
  })
})
