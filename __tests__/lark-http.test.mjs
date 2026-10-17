import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'

import { readBody, readJsonBody } from '../lib/lark-http.mjs'

const fakeReq = (chunks) => {
  const req = new EventEmitter()
  req.destroy = () => { req.destroyed = true }
  setImmediate(() => {
    for (const chunk of chunks) req.emit('data', chunk)
    req.emit('end')
  })
  return req
}

describe('readBody（第 0 批：坏 body 不再静默当 {}）', () => {
  it('合法 JSON → 对象；空 body → {}；非法 JSON / 非对象 → null', async () => {
    assert.deepEqual(await readBody(fakeReq(['{"a":1}'])), { a: 1 })
    assert.deepEqual(await readBody(fakeReq([])), {})
    assert.equal(await readBody(fakeReq(['{oops'])), null)
    assert.equal(await readBody(fakeReq(['"str"'])), null)
  })
  it('readJsonBody 对坏 body 回 400 并返回 null', async () => {
    const res = { writeHead(status) { this.status = status }, end(body) { this.body = body } }
    assert.equal(await readJsonBody(fakeReq(['{bad']), res), null)
    assert.equal(res.status, 400)
    assert.match(res.body, /invalid/)
  })
})
