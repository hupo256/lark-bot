import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseClamshellState, startKeepAwake } from '../lib/lark-keep-awake.mjs'

describe('开盖不空闲睡眠（caffeinate -i 跟着 gateway pid 走）', () => {
  const fakeSpawn = (calls) => (cmd, args) => {
    calls.push([cmd, ...args])
    return { on() {}, unref() {}, kill() { calls.push(['kill']) } }
  }

  it('macOS 挂 caffeinate -i -w <pid>，stop 时 kill', () => {
    const calls = []
    const handle = startKeepAwake({ env: {}, platform: 'darwin', pid: 4242, spawnFn: fakeSpawn(calls) })
    assert.deepEqual(calls, [['/usr/bin/caffeinate', '-i', '-w', '4242']])
    handle.stop()
    assert.deepEqual(calls.at(-1), ['kill'])
  })

  it('LARK_KEEP_AWAKE=0 或非 macOS 不启动', () => {
    const calls = []
    startKeepAwake({ env: { LARK_KEEP_AWAKE: '0' }, platform: 'darwin', spawnFn: fakeSpawn(calls) }).stop()
    startKeepAwake({ env: {}, platform: 'linux', spawnFn: fakeSpawn(calls) }).stop()
    assert.deepEqual(calls, [])
  })

  it('ioreg 合盖状态解析', () => {
    assert.equal(parseClamshellState('      "AppleClamshellState" = Yes\n'), true)
    assert.equal(parseClamshellState('      "AppleClamshellState" = No\n'), false)
    assert.equal(parseClamshellState(''), false)
  })
})
