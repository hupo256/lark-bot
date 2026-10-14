import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  annotateLedgerHeadings,
  applyProgress,
  applyStatusColumn,
  checkStreamUrl,
  computeProgress,
  diffLedger,
  expandNos,
  fetchSiteBuildTime,
  findPreviousFullReport,
  isReportDay,
  parseReportDays,
  renderCounts,
  splitStatusBlock,
  tableMismatches,
  validateStatusData,
} from '../lib/lark-daily-ledger.mjs'

const ROWS = [
  { no: 1, feature: '用户资料', owner: 'henry', status: '🟡' },
  { no: 4, feature: '预约', owner: 'aven', status: '🟠' },
  { no: 5, feature: 'banner', owner: 'aven', status: '✅' },
  { no: 17, feature: '签到', owner: 'adrian', status: '🟡' },
  { no: 18, feature: '补签', owner: 'adrian', status: '🟡' },
  { no: 54, feature: '无 web', owner: '（无web工作）', status: '❌' },
]

const statusData = {
  features: [
    { no: 1, status: '✅', pre: '能用', evidence: 'pre 已接 member/info' },
    { no: 4, status: '🟠', pre: '看不到', reason: 'reserveMatch 报错' },
    { no: 5, status: '✅', pre: '看不到', reason: 'banner 没数据' },
    { no: 17, status: '🟡' },
    { no: 18, status: '✅', pre: '能用' },
    { no: 54, status: '—' },
  ],
  resolved: [{ section: '三', key: 'help 模块改名', evidence: 'pre a58b92b 已改' }],
}

describe('工作日', () => {
  it('缺省周一到周五；支持区间与列表', () => {
    assert.deepEqual(parseReportDays(undefined), [1, 2, 3, 4, 5])
    assert.deepEqual(parseReportDays('1-5'), [1, 2, 3, 4, 5])
    assert.deepEqual(parseReportDays('1,3, 5'), [1, 3, 5])
    assert.deepEqual(parseReportDays([5, 1, 1]), [1, 5])
    assert.throws(() => parseReportDays('周一'))
    assert.equal(isReportDay(new Date(2026, 9, 17), [1, 2, 3, 4, 5]), false) // 周六
    assert.equal(isReportDay(new Date(2026, 9, 19), [1, 2, 3, 4, 5]), true) // 周一
  })
})

describe('逐功能状态', () => {
  const text = `# 日报\n\n正文\n\n<!-- STATUS_JSON\n${JSON.stringify(statusData)}\nSTATUS_JSON -->\n`
  it('剥离 JSON 块；缺失 / 坏 JSON 给错误', () => {
    const { doc, data, error } = splitStatusBlock(text)
    assert.equal(error, null)
    assert.equal(doc, '# 日报\n\n正文')
    assert.equal(data.features.length, 6)
    assert.match(splitStatusBlock('# x').error, /没有逐功能状态/)
    assert.match(splitStatusBlock('# x\n<!-- STATUS_JSON\n{bad\nSTATUS_JSON -->').error, /解析失败/)
  })
  it('校验齐全与取值', () => {
    const { statuses, errors, resolved } = validateStatusData(statusData, ROWS)
    assert.deepEqual(errors, [])
    assert.equal(statuses.get(17).pre, '未验证')
    assert.equal(resolved.length, 1)
    const bad = validateStatusData({ features: [{ no: 1, status: '好' }] }, ROWS)
    assert.match(bad.errors.join('；'), /#1 状态「好」不合法/)
    assert.match(bad.errors.join('；'), /缺 6 个功能的状态/)
  })
  it('进度按代码状态算，排除 #54，✅ 但 pre 看不到的单列', () => {
    const { statuses } = validateStatusData(statusData, ROWS)
    const progress = computeProgress({ rows: ROWS, statuses })
    assert.equal(progress.total, 5)
    assert.equal(progress.done, 3)
    assert.equal(progress.percent, 78) // (100+60+100+30+100)/5
    assert.deepEqual(progress.preHidden.map((item) => item.no), [5])
    assert.equal(renderCounts(progress), '**计数**（不含 #54）：✅ 3 项（aven 1、adrian 1、henry 1）。未完成 2 项：\n- aven 1 项：#4\n- adrian 1 项：#17')
    assert.deepEqual(tableMismatches(ROWS, statuses).map((item) => `${item.no}:${item.table}→${item.code}`), ['1:🟡→✅', '18:🟡→✅'])
  })
})

const DOC = `# Falive Web 一期 · 日报（2026-10-15）

## 总体进度：90%

## 一、功能进度总览

| # | 功能 | 负责人 | 状态 | 还剩什么 | 需要谁支持 |
|---|---|---|---|---|---|
| 1 | 用户资料 | henry | ⬜ | x | y |
| 4 | 预约 | aven | ✅ | x | y |
| 17–18 | 签到 / 补签 | adrian | ✅ | x | y |
| 54 | 无 | — | ⬜ | | |

**计数**（不含 #54）：✅ 99 项。未完成 0 项：
- 谁 0 项：#0

## 二、API：还缺什么、哪些有问题（剩 9 行）

| 功能 | 缺什么 | 现状 | 找谁 | 文档 |
|---|---|---|---|---|
| #4 预约 | reserveMatch | 报错 | live | live-3·1 |

## 三、需要再跟进的工作

| 事项 | 说明 | 负责人 |
|---|---|---|
| 发邮件部署 pre | x | **aven** |
`

describe('回写与台账', () => {
  const { statuses } = validateStatusData(statusData, ROWS)
  it('状态列按代码回写，合并行全 ✅ 才 ✅', () => {
    const out = applyStatusColumn(DOC, statuses)
    assert.match(out, /\| 1 \| 用户资料 \| henry \| ✅ \|/)
    assert.match(out, /\| 4 \| 预约 \| aven \| ⬜ \|/)
    assert.match(out, /\| 17–18 \| 签到 \/ 补签 \| adrian \| ⬜ \|/)
    assert.match(out, /\| 54 \| 无 \| — \| — \|/)
    assert.deepEqual(expandNos('17–20'), [17, 18, 19, 20])
    assert.deepEqual(expandNos('**#9**'), [9])
  })
  it('总体进度与计数块按脚本数字替换', () => {
    const out = applyProgress(DOC, computeProgress({ rows: ROWS, statuses }))
    assert.match(out, /^## 总体进度：78\.0%（✅ 3 \/ 5）$/m)
    assert.match(out, /\*\*计数\*\*（不含 #54）：✅ 3 项/)
    assert.doesNotMatch(out, /谁 0 项/)
    assert.match(out, /- adrian 1 项：#17\n\n## 二、/)
  })
  it('昨天有今天没：有依据算删，没依据算无故消失；标题带剩余行数', () => {
    const previous = DOC.replace('| 发邮件部署 pre | x | **aven** |', '| 发邮件部署 pre | x | **aven** |\n| help 模块改名「聊天」 | x | **henry** |\n| 分支流程 | x | 待确认 |')
    const diff = diffLedger({ previous, current: DOC, resolved: validateStatusData(statusData, ROWS).resolved })
    const three = diff.find((item) => item.name === '三')
    assert.deepEqual(three.removed, ['help 模块改名「聊天」', '分支流程'])
    assert.deepEqual(three.unexplained, ['分支流程'])
    const out = annotateLedgerHeadings(DOC, diff)
    assert.match(out, /^## 二、API：还缺什么、哪些有问题（剩 1 行）$/m)
    assert.match(out, /^## 三、需要再跟进的工作（剩 1 行，今日删 1 行）$/m)
    const cleared = annotateLedgerHeadings(DOC.replace('| #4 预约 | reserveMatch | 报错 | live | live-3·1 |\n', ''), diffLedger({ previous: DOC, current: DOC.replace('| #4 预约 | reserveMatch | 报错 | live | live-3·1 |\n', ''), resolved: [{ section: '二', key: '#4 预约' }] }))
    assert.match(cleared, /^## 二、.*（剩 0 行，今日删 1 行，已清零）$/m)
  })
  it('模板取前一天（或更早）的完整版', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-'))
    try {
      for (const day of ['2026-10-13', '2026-10-14', '2026-10-15']) writeFileSync(join(dir, `FaliveWeb日报-${day}-完整版.md`), day)
      writeFileSync(join(dir, 'FaliveWeb日报-2026-10-14.md'), 'short')
      assert.equal(findPreviousFullReport({ dir, date: '2026-10-15' }).date, '2026-10-14')
      assert.equal(findPreviousFullReport({ dir, date: '2026-10-13' }), null)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('网络实测（注入 fetch）', () => {
  const response = (status, body) => ({ status, text: async () => body })
  it('pre 构建时间取自入口 JS 的 VITE_BUILD_TIME', async () => {
    const fetchImpl = async (url) => (url.endsWith('/') ? response(200, '<script src="/assets/index-DTxx_yMcN.js">') : response(200, 'a={VITE_BUILD_TIME:1791903942562,b:1}'))
    const out = await fetchSiteBuildTime({ siteUrl: 'https://pre.example.com/', fetchImpl })
    assert.equal(out.ok, true)
    assert.equal(out.ms, 1791903942562)
    assert.equal((await fetchSiteBuildTime({ siteUrl: 'https://pre.example.com/', fetchImpl: async () => response(200, '<html>') })).ok, false)
  })
  it('拉流：404 / 非播放列表 / 超时都算播不了', async () => {
    assert.equal((await checkStreamUrl({ url: 'https://cdn/x.flv', fetchImpl: async () => response(404, '') })).ok, false)
    assert.equal((await checkStreamUrl({ url: 'https://cdn/x.flv', fetchImpl: async () => response(206, '') })).ok, true)
    assert.equal((await checkStreamUrl({ url: 'https://cdn/x.m3u8?t=1', fetchImpl: async () => response(200, '<html>') })).ok, false)
    assert.equal((await checkStreamUrl({ url: 'https://cdn/x.m3u8', fetchImpl: async () => response(200, '#EXTM3U\n#EXTINF') })).ok, true)
    const hang = (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
    assert.match((await checkStreamUrl({ url: 'https://cdn/x.m3u8', fetchImpl: hang, timeoutMs: 20 })).detail, /无响应/)
  })
})
