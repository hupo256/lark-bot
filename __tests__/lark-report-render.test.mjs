import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { applyRunEvidence, collectRunEvidence, normalizeReport, renderReport } from '../lib/lark-report-render.mjs'

// 结构化群回复（10-21 架构加固 P6）：第一行数字由条目算，不会再出现「都通了」又列问题；实测声明按会话记录核实。
const item = (mark, name, extra = {}) => ({ mark, name, note: '', evidence: 'none', ...extra })

describe('结构化群回复', () => {
  it('第一行由条目算：全 ok 才「都通了」；有没通的按「通了 a 项，没通 b 项」并排在前面', () => {
    assert.equal(renderReport(normalizeReport({ subject: 'front/lives 复测', answer: null, items: [item('ok', '第 2 页', { note: '不再报错，第 3 页为空说明到底了' })] })),
      'front/lives 复测：都通了\n- ✅ 通了 第 2 页：不再报错，第 3 页为空说明到底了')
    const mixed = renderReport(normalizeReport({ subject: '直播详情页', answer: null, items: [item('ok', '礼物'), item('not_usable', 'getRoomInfo', { note: '非主播回 500' }), item('na', '分享')] }))
    assert.equal(mixed, '直播详情页：通了 1 项，没通 1 项\n- ⚠️ 接了但还不能用 getRoomInfo：非主播回 500\n- ✅ 通了 礼物\n- ➖ 不涉及接口 分享')
  })
  it('代答：第一行是答案，只列给出的保留项', () => {
    assert.equal(renderReport(normalizeReport({ subject: null, answer: '头像用 getRoomInfo 的 userData.avatar', items: [] })), '头像用 getRoomInfo 的 userData.avatar')
  })
  it('结构不对返回 null（走旧路径）；未知 mark 按「还不能用」保留，不能丢', () => {
    assert.equal(normalizeReport(null), null)
    assert.equal(normalizeReport({ subject: 'x', answer: null, items: [] }), null)
    const odd = normalizeReport({ subject: '预约 Tab', answer: null, items: [item('ok', '参数'), item('pending', 'Tab 显示', { note: '还没部署 pre' })] })
    assert.equal(renderReport(odd), '预约 Tab：通了 1 项，没通 1 项\n- ⚠️ 接了但还不能用 Tab 显示：还没部署 pre\n- ✅ 通了 参数', '10-21 真机：pending 被丢就成了「都通了」')
  })
  it('声称 pre / 浏览器实测但本轮会话里没跑 → 那一项降成「待验证」；读不到会话记录不降', () => {
    const report = normalizeReport({ subject: '签到复测', answer: null, items: [item('ok', '签到', { evidence: 'pre' }), item('ok', '滚到底', { evidence: 'browser' }), item('ok', '文案', { evidence: 'code' })] })
    const down = applyRunEvidence(report, { probeCalls: 1, browserCalls: 0 })
    assert.equal(renderReport(down), '签到复测：通了 2 项，没通 1 项\n- ⚠️ 待验证 滚到底：这次没实测\n- ✅ 通了 签到\n- ✅ 通了 文案')
    assert.equal(applyRunEvidence(report, null), report)
    assert.equal(normalizeReport(down).items[1].mark, 'unverified', '网关再校验时认 unverified')
  })
  it('从会话记录数探针 / 浏览器调用（按 tool_use id 去重，两个阶段两份会话都算）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lark-evidence-'))
    try {
      const use = (id, command) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } })
      writeFileSync(join(dir, 'a.jsonl'), [use('t1', "node scripts/pre-probe.mjs '[]'"), use('t1', "node scripts/pre-probe.mjs '[]'"), use('t2', 'cd /tmp && node -e "require(\'playwright\')"')].join('\n'))
      writeFileSync(join(dir, 'b.jsonl'), use('t3', 'git diff'))
      assert.deepEqual(collectRunEvidence({ sessionFiles: [join(dir, 'a.jsonl'), join(dir, 'b.jsonl')], probeCommand: 'node scripts/pre-probe.mjs' }), { probeCalls: 1, browserCalls: 1, unopenedFiles: [] })
      assert.equal(collectRunEvidence({ sessionFiles: [join(dir, 'missing.jsonl')] }), null)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('截图有没有打开（10-21 #62）', () => {
  it('按会话记录里的 Read / 命令路径数出没打开的截图；提示只在有没打开的时候出', async () => {
    const { unopenedImagesNote } = await import('../lib/lark-run-report.mjs')
    const dir = mkdtempSync(join(tmpdir(), 'lark-evidence-img-'))
    try {
      const use = (id, name, input) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } })
      writeFileSync(join(dir, 's.jsonl'), [use('t1', 'Read', { file_path: '/att/1.jpg' }), use('t2', 'Bash', { command: 'file /att/3.jpg' })].join('\n'))
      const evidence = collectRunEvidence({ sessionFiles: [join(dir, 's.jsonl')], watchFiles: ['/att/1.jpg', '/att/2.jpg', '/att/3.jpg'] })
      assert.deepEqual(evidence.unopenedFiles, ['/att/2.jpg'])
      assert.match(unopenedImagesNote({ evidence, total: 3 }), /3 张截图有 1 张执行器没打开看/)
      assert.match(unopenedImagesNote({ evidence: { unopenedFiles: ['/a', '/b'] }, total: 2 }), /一张都没打开看/)
      assert.equal(unopenedImagesNote({ evidence: { unopenedFiles: [] }, total: 3 }), null)
      assert.equal(unopenedImagesNote({ evidence: null, total: 3 }), null, '读不到会话记录不提示')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
