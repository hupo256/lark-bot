import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  annotateLedgerHeadings,
  applyCalloutCounts,
  applyFeatureClosures,
  applyLedgerClosures,
  loadOwnerClosures,
  applyProgress,
  applyStatusColumn,
  checkStreamUrl,
  checkVerbose,
  computeProgress,
  diffLedger,
  expandNos,
  fetchSiteBuildTime,
  findPreviousFullReport,
  isReportDay,
  parseReportDays,
  renderCounts,
  splitStatusBlock,
  stripCalloutExtras,
  stripNonIssues,
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
  it('进度按代码状态算，排除 #54', () => {
    const { statuses } = validateStatusData(statusData, ROWS)
    const progress = computeProgress({ rows: ROWS, statuses })
    assert.equal(progress.total, 5)
    assert.equal(progress.done, 3)
    assert.equal(progress.percent, 78) // (100+60+100+30+100)/5
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
    assert.match(out, /\| 54 \| 无 \| — \| — \| -- \| -- \|/)
    // aven 10-21：状态后面只写卡点——✅ 行一律 --，没打勾的行保留卡点
    assert.match(out, /\| 1 \| 用户资料 \| henry \| ✅ \| -- \| -- \|/)
    assert.match(out, /\| 4 \| 预约 \| aven \| ⬜ \| x \| y \|/)
    assert.match(applyStatusColumn(DOC.replace('| 4 | 预约 | aven | ✅ | x | y |', '| 4 | 预约 | aven | ✅ |  | y |'), statuses), /\| 4 \| 预约 \| aven \| ⬜ \| -- \| y \|/)
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
  it('外部方汇总行「并入二节」：有依据、不算无故消失，也不算进今日删', () => {
    const previous = DOC.replace('| 发邮件部署 pre | x | **aven** |', '| 发邮件部署 pre | x | **aven** |\n| 运维配置 | O1 O2 | 运维 |')
    const diff = diffLedger({ previous, current: DOC, resolved: [{ section: '三', key: '运维配置', evidence: '并入二节 O1 / O2' }] })
    const three = diff.find((item) => item.name === '三')
    assert.deepEqual(three.unexplained, [])
    assert.deepEqual(three.merged, ['运维配置'])
    assert.match(annotateLedgerHeadings(DOC, diff), /^## 三、需要再跟进的工作（剩 1 行）$/m)
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

describe('负责人拍板关闭', () => {
  const doc = [
    '## 一、功能',
    '<p><b>aven：</b>负责 28 项，26 项 ✅；其中 1 项看不到</p>',
    '## 三、需要再跟进的工作',
    '| 事项 | 说明 | 负责人 |',
    '| --- | --- | --- |',
    '| 发 pre 部署邮件 | 还没发 | aven |',
    '| **#2 收尾** | 等 Arthur | aven；Arthur |',
    '| 测试房间推流 | 等后端 | live 后端 |',
  ].join('\n')
  const closures = { features: [{ no: 2, status: '✅', pre: '能用', by: 'aven', at: '2026-10-16', note: '' }], rows: [{ section: '三', key: '发 pre 部署邮件', by: 'aven', at: '2026-10-16' }, { section: '三', key: '#2 收尾', by: 'aven', at: '2026-10-16' }] }

  it('按首列删掉台账行，只给昨天还在的行登记依据', () => {
    const previous = doc.split('\n').filter((line) => !line.includes('#2 收尾')).join('\n')
    const out = applyLedgerClosures({ markdown: doc, previous, closures })
    assert.ok(!out.doc.includes('发 pre 部署邮件'))
    assert.ok(!out.doc.includes('#2 收尾'))
    assert.ok(out.doc.includes('测试房间推流'))
    assert.deepEqual(out.resolved.map((item) => item.key), ['发 pre 部署邮件'])
    assert.match(out.resolved[0].evidence, /aven 2026-10-16 拍板关闭/)
  })

  it('功能拍板覆盖模型状态', () => {
    const statuses = new Map([[2, { no: 2, status: '🟠', pre: '看不到', reason: '手机号注册报错', evidence: 'x' }]])
    applyFeatureClosures(statuses, closures)
    assert.equal(statuses.get(2).status, '✅')
    assert.equal(statuses.get(2).pre, '能用')
    assert.equal(statuses.get(2).reason, '')
  })

  it('高亮框数字按脚本回写，句子其它部分不动', () => {
    const out = applyCalloutCounts(doc, { byOwner: { aven: { total: 28, done: 27 } } })
    assert.ok(out.includes('<b>aven：</b>负责 28 项，27 项 ✅；其中 1 项看不到'))
  })

  it('没有拍板文件 / 文件坏了都按空处理', () => {
    const dir = mkdtempSync(join(tmpdir(), 'closures-'))
    try {
      assert.deepEqual(loadOwnerClosures(dir), { features: [], rows: [] })
      writeFileSync(join(dir, 'owner-closures.json'), '{bad')
      assert.deepEqual(loadOwnerClosures(dir), { features: [], rows: [] })
      writeFileSync(join(dir, 'owner-closures.json'), JSON.stringify({ features: [{ no: '2' }], rows: [{ key: ' 下载页回归 ' }, { key: '' }] }))
      const loaded = loadOwnerClosures(dir)
      assert.equal(loaded.features[0].no, 2)
      assert.equal(loaded.features[0].status, '✅')
      assert.deepEqual(loaded.rows.map((item) => item.key), ['下载页回归'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('走查不进日报（aven 2026-10-20）', () => {
  it('走查事项整行删；其余行只删提到走查的分句，高亮框标签保持完整', () => {
    const doc = [
      '<p><b>henry：</b>负责 10 项，10 项 ✅。其中 2 项 pre 上还看不到效果：#32 测试房间 260 没在推流。#23 #25 pre 还没走查。</p>',
      '<p><b>aven：</b>负责 5 项；设计走查：搜索页还没做。</p>',
      '| 设计走查：搜索页、录播播放页、H5 底部导航 |  | 设计 / **aven** 改 |',
      '| 30 | 录播 tab | aven | ✅ | 已改接；播放页待设计走查 | live |',
      '- **henry**：补齐了 X；还没走查',
      '- **产品**：安排设计走查',
      '**不缺接口的未完成功能**：#23（只差回归 / 走查）',
      '普通行',
    ].join('\n')
    assert.equal(stripNonIssues(doc), [
      '<p><b>henry：</b>负责 10 项，10 项 ✅。</p>',
      '<p><b>aven：</b>负责 5 项。</p>',
      '| 30 | 录播 tab | aven | ✅ | 已改接 | live |',
      '- **henry**：补齐了 X。',
      '**不缺接口的未完成功能**：#23（只差回归）',
      '普通行',
    ].join('\n'))
    assert.equal(stripNonIssues('没有相关内容\n| a | b |'), '没有相关内容\n| a | b |')
  })
  it('部署 / 复测 / pre 看不到效果也不进日报（aven 2026-10-21）；后端「回调有没有部署」这类真问题不删', () => {
    const doc = [
      '<p><b>adrian：</b>负责 10 项，4 项 ✅（#12 #13），这 4 项在部署版上都还没复测。#14 补签回 400（G3）。</p>',
      '<p><b>broker：</b>负责 3 项，2 项 ✅。#49 测试号自己没有存档，pre 没验。</p>',
      '- **eric**：跑马灯改走 Go；已合入 pre，待发邮件部署',
      '| 发邮件部署 pre | x | **aven** |',
      '| 12 | 积分总额 | adrian | ✅ | 部署版还没复测 | -- |',
      '| #18 回调 | G5 服务端回调有没有部署 | Go 后端 |',
      '| 47 | 入口 | eric | ⬜ | 代码已接，pre 未验证；Go 回 500（G2） | Go 后端 |',
    ].join('\n')
    assert.equal(stripNonIssues(doc), [
      '<p><b>adrian：</b>负责 10 项，4 项 ✅（#12 #13），#14 补签回 400（G3）。</p>',
      '<p><b>broker：</b>负责 3 项，2 项 ✅。#49 测试号自己没有存档。</p>',
      '- **eric**：跑马灯改走 Go；已合入 pre。',
      '| 12 | 积分总额 | adrian | ✅ |  | -- |',
      '| #18 回调 | G5 服务端回调有没有部署 | Go 后端 |',
      '| 47 | 入口 | eric | ⬜ | 代码已接，Go 回 500（G2） | Go 后端 |',
    ].join('\n'))
  })
})

describe('精简（aven 2026-10-21）', () => {
  it('高亮框只删「运维」「外部阻塞」两行，负责人行不动', () => {
    const doc = ['<callout>', '  <p><b>aven：</b>负责 30 项，30 项 ✅</p>', '  <p><b>运维：</b>等 O1</p>', '  <p><b>外部阻塞：</b>Go 后端 G2</p>', '</callout>', '运维：正文里的不动'].join('\n')
    assert.equal(stripCalloutExtras(doc), ['<callout>', '  <p><b>aven：</b>负责 30 项，30 项 ✅</p>', '</callout>', '运维：正文里的不动'].join('\n'))
    assert.equal(stripCalloutExtras('<callout><p><b>aven：</b>x</p><p><b>运维：</b>y</p></callout>'), '<callout><p><b>aven：</b>x</p></callout>')
  })
  it('超长单元格和高亮框行列进核对单，不改正文；标记和反引号不计字数', () => {
    const long = '字'.repeat(81)
    const doc = [
      `<callout><p><b>henry：</b>${'话'.repeat(101)}</p></callout>`,
      '## 一、功能进度总览', '', '| # | 功能 | 还剩什么 |', '|---|---|---|', `| 1 | 资料 | ${long} |`, `| 2 | 登录 | \`${'a'.repeat(78)}\` |`, '',
      '## 二、API', '', '| 功能 | 现状 |', '|---|---|', `| #47 入口 | ${long} |`, '',
      '## 三、跟进', '', '| 事项 | 说明 |', '|---|---|', '| 短的 | 没事 |',
    ].join('\n')
    const [problem] = checkVerbose(doc)
    assert.match(problem, /^超过字数上限 3 处（单元格 80 字、高亮框 100 字）：高亮框 henry（101 字）、一节 #1（81 字）、二节 #47 入口（81 字）$/)
    assert.deepEqual(checkVerbose('## 一、x\n\n| # | a |\n|---|---|\n| 1 | 短 |'), [])
  })
})
