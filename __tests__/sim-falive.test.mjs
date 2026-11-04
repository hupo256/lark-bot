/**
 * 回放台子里 falive 校准用的纯函数（scripts/sim/falive-code-pin.mjs、falive-calibration.mjs；design-v2 §8 P0-h）。
 * 一个 it 合并全部段（测试棘轮）。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { normalizeRouting, routingLines } from '../scripts/sim/falive-calibration.mjs'
import { parseCodeStarts, pickConfigBackup, runningCodeAt } from '../scripts/sim/falive-code-pin.mjs'
import { runSteps } from './support/steps.mjs'

const LOG = [
  '[lark-gateway] listening on http://127.0.0.1:3006 for PR-01947',
  '[lark-gateway] code=a301f6c04d91 startedAt=2026-10-28T07:57:50.168Z（health.version 会在磁盘代码变更后报 codeStale）',
  '[lark-gateway] code=0089d20f061b startedAt=2026-10-28T10:24:25.027Z（health.version 会在磁盘代码变更后报 codeStale）',
  '[lark-gateway] code=zzz startedAt=坏的（不认）',
  '[lark-gateway] code=9ffb7ff103f2 startedAt=2026-10-28T11:24:34.663Z（health.version 会在磁盘代码变更后报 codeStale）',
].join('\n')

describe('falive 校准：代码 / 配置钉版与路由比对', () => {
  it('按启动指纹取当时的代码、按备份 mtime 取当时的配置、路由行归一后可逐行比', () => runSteps([
    ['启动指纹：只认 12 位十六进制 + 合法时刻，按时间排序', () => {
      const starts = parseCodeStarts(LOG)
      assert.deepEqual(starts.map((s) => s.codeHash), ['a301f6c04d91', '0089d20f061b', '9ffb7ff103f2'])
      assert.deepEqual(parseCodeStarts(''), [])
    }],
    ['某时刻在跑的 = 之前最后一次启动；启动前没有记录回 null；恰好在启动时刻算新的', () => {
      const starts = parseCodeStarts(LOG)
      assert.equal(runningCodeAt(starts, Date.parse('2026-10-28T10:59:20Z')).codeHash, '0089d20f061b')
      assert.equal(runningCodeAt(starts, Date.parse('2026-10-28T10:24:25.027Z')).codeHash, '0089d20f061b')
      assert.equal(runningCodeAt(starts, Date.parse('2026-10-28T07:00:00Z')), null)
    }],
    ['生效配置 = mtime 晚于该时刻的最早备份；都早于它 → null（用现行配置）', () => {
      const backups = [
        { path: 'bak-1031', mtimeMs: Date.parse('2026-10-31T12:19:00Z') },
        { path: 'bak-1027', mtimeMs: Date.parse('2026-10-27T04:02:00Z') },
        { path: 'bak-1028', mtimeMs: Date.parse('2026-10-28T13:09:00Z') },
      ]
      assert.equal(pickConfigBackup(backups, Date.parse('2026-10-28T10:59:20Z')).path, 'bak-1028')
      assert.equal(pickConfigBackup(backups, Date.parse('2026-10-20T00:00:00Z')).path, 'bak-1027')
      assert.equal(pickConfigBackup(backups, Date.parse('2026-11-03T00:00:00Z')), null)
    }],
    ['路由行：case id → C1/C2、群 id → 群名、原话尾巴与工单键不比；只挑提到组内 case 的路由行', () => {
      const ids = ['om_aaa', 'om_bbb']
      assert.equal(normalizeRouting('[lark-gateway] repo start om_aaa -> oc_21a29d687ecfcd6d6776cac669a4c5d3 ok via webhook', ids), 'repo start C1 -> webhook-group ok via webhook')
      assert.equal(normalizeRouting('received task-mention om_bbb，等待意图分类: @Aven.Bot 请帮我核实一下', ids), 'received task-mention C2，等待意图分类…')
      assert.equal(normalizeRouting('台账：om_aaa question 触及 new#ee9885 → 工单键 q:om_aaa', ids), '台账：C1 question 触及 new#ee9885 → 工单键 …')
      const log = ['[lark-gateway] repo ack om_aaa ok via webhook', '[lark-gateway] repo ack om_zzz ok via webhook', '[lark-worker] om_aaa 开始跑', '[lark-gateway] task-mention om_bbb classified=question/high，正式入队'].join('\n')
      assert.deepEqual(routingLines(log, ids), ['repo ack C1 ok via webhook', 'task-mention C2 classified=question/high，正式入队'])
    }],
  ]))
})
