import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { startKeepAwake } from '../lib/lark-keep-awake.mjs'
import { isLidClosed, lastSystemSleepAt, parseClamshellState, parseKernSleepTime } from '../lib/lark-power.mjs'

describe('电源态单采样点', () => {
  it('解析 ioreg / sysctl 输出', () => {
    assert.equal(parseClamshellState('   "AppleClamshellState" = Yes\n'), true)
    assert.equal(parseClamshellState('   "AppleClamshellState" = No\n'), false)
    assert.equal(parseClamshellState(''), false)
    assert.equal(parseKernSleepTime('{ sec = 1792204239, usec = 128033 } Sat Oct 17 06:30:39 2026'), 1792204239000)
    assert.equal(parseKernSleepTime('{ sec = 0, usec = 0 }'), null)
  })
  it('非 macOS：合盖按开盖、入睡时间 null，不起子进程', async () => {
    assert.equal(await isLidClosed({ platform: 'linux' }), false)
    assert.equal(await lastSystemSleepAt({ platform: 'linux' }), null)
  })
})

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
})
