import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { isLidClosed, lastSystemSleepAt, parseClamshellState, parseKernSleepTime } from '../lib/lark-power.mjs'

describe('电源态单采样点', () => {
  it('解析 ioreg / sysctl 输出', () => {
    assert.equal(parseClamshellState('   "AppleClamshellState" = Yes\n'), true)
    assert.equal(parseClamshellState('   "AppleClamshellState" = No\n'), false)
    assert.equal(parseKernSleepTime('{ sec = 1792204239, usec = 128033 } Sat Oct 17 06:30:39 2026'), 1792204239000)
    assert.equal(parseKernSleepTime('{ sec = 0, usec = 0 }'), null)
  })
  it('非 macOS：合盖按开盖、入睡时间 null，不起子进程', async () => {
    assert.equal(await isLidClosed({ platform: 'linux' }), false)
    assert.equal(await lastSystemSleepAt({ platform: 'linux' }), null)
  })
})
