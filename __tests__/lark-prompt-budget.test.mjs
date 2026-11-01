import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildAnalysisPrompt, buildIntentClassificationPrompt, buildTaskPrompt, buildTaskPromptParts, buildWorkerSystemPrompt } from '../lib/lark-worker-prompts.mjs'
import { eachCase, runSteps } from './support/steps.mjs'

// 规则预算（从 falive 移植，aven 2026-10-14：规则越补越多，干活越来越慢的坑不能再踩）。超了就得合并旧规则，不能只往上叠。
// 10-31 按 fameex 线当时的实测钉住：实施提示约 8.2k（上限 9500，留约 1.3k 给迭代期加规则）、分析提示约 2.1k、分类器约 0.7k。
const CLASSIFIER_RULE_BUDGET = 1500
const TASK_PROMPT_BUDGET = 9500
const ANALYSIS_PROMPT_BUDGET = 2600
// 11-01 上下文分层（docs/upgrade-plan-context-layers-2026-11-01.md S5）后按层各有上限：驾驶规则进系统层（实测 6.1k，配页面工具 +
// AGENTS.md 遮蔽 6.7k），claude 的实施 user 只放本轮（实测 2.8k，续会话 2.6k），只读查询不走系统层（4.2k）。
// 加规则先想清楚放哪一层：换一条任务还成立 → 系统层；只对本轮成立 → user。
const SYSTEM_LAYER_BUDGET = 7500
const TASK_USER_BUDGET = 3600
const FOLLOW_UP_USER_BUDGET = 3200
const READ_ONLY_PROMPT_BUDGET = 4800
// 互斥句对：同一份（系统层 + user）里不许同时出现，出现就是两条规则互相打架、模型只能随机取舍（《8 个卡点》§4）。
const CONFLICT_PAIRS = [
  ['自己验证（硬规则）', '禁止启动 dev server'],
  ['自己验证（硬规则）', '跳过 Browser / Playwright'],
  ['changedFiles 必须为 []', '编码规范（改任何代码前必做'],
  ['不得仅因缺 G2', '因缺 PRD / Figma / 文案原文 / API 样例'],
]
// 只许出现一次的块：拆层后最容易犯的错是系统层和 user 各留一份。
const SINGLE_USE_MARKERS = ['提交边界：', 'Lark 资料规则：', '- taskState：', '缺陷根因分诊（', '编码规范（改任何代码前必做', '验证策略（代码类修复必做', '- **达标即停**']
// 事故编号（PR-0xxxx）只能留在代码注释里，不得写进任何提示正文（ctx 用 TR 项目号，正文里出现的 PR-0 就是事故编号）。
const ctx = { projectId: 'TR-99999', projectName: 'test', projectDocs: [], cwd: '/tmp/repo', hotfixBranch: 'hotfix/x', baseRef: 'origin/online' }
const TASK_KINDS = [
  { name: 'bug', text: '修复 登录页报错', intake: { classification: { decision: 'bug' } } },
  { name: 'requirement', text: '新增 xx 功能', intake: { classification: { decision: 'requirement' } } },
  { name: 'readonly', text: '状态：项目进度', commandType: 'status' },
  { name: 'api', text: 'api: 对接 xx', commandType: 'api' },
  { name: 'fix', text: '修复：按钮颜色', commandType: 'fix' },
  { name: 'with_attachments', text: '按截图改', attachments: [{ type: 'image', localPath: '/tmp/x/1.png' }] },
]

describe('上下文分层预算与冲突 lint（S5）', () => {
  const verify = { localDev: ['pnpm', 'dev'], compareBase: 'https://test.example.com' }
  it('分层预算与冲突 lint', () => runSteps([
    ['系统层不超预算、不随任务变（跨任务逐字相同才可能命中提示缓存）；正文里没有事故编号', () => {
      const plain = buildWorkerSystemPrompt()
      const full = buildWorkerSystemPrompt({ verify, agentsDocShadowed: true })
      assert.ok(full.length <= SYSTEM_LAYER_BUDGET, `系统层 ${full.length} 字符，超过预算 ${SYSTEM_LAYER_BUDGET}`)
      assert.doesNotMatch(full, /PR-0\d{4}|TR-99999|\/tmp\/repo|hotfix\/x/, '系统层不能带任务 / 工作目录信息')
      const parts = TASK_KINDS.filter((k) => k.name !== 'readonly').map(({ name, ...extra }) =>
        buildTaskPromptParts(ctx, { id: name, attachments: [], chatId: 'oc', ...extra }, 'claude', { ruleContext: { text: '', sources: [] }, verify }).system)
      assert.equal(new Set(parts).size, 1, '各类可写任务的系统层必须逐字相同')
      assert.equal(parts[0], buildWorkerSystemPrompt({ verify }))
      assert.notEqual(plain, full)
    }],
    ['各模式 user 层各有上限；只读查询不走系统层；拼成一份时不重复、不冲突', () => eachCase(TASK_KINDS, ({ name, ...extra }) => {
      for (const v of [null, verify]) {
        const task = { id: 't', attachments: [], chatId: 'oc', ...extra }
        const first = buildTaskPromptParts(ctx, task, 'claude', { ruleContext: { text: '', sources: [] }, verify: v })
        const followUp = buildTaskPromptParts(ctx, task, 'claude', { ruleContext: { text: 'RULES', sources: [] }, analysis: { summary: 's', applicableRules: [], requirements: ['r1'] }, scopeContract: { scope: null, lineLimit: 300 }, followUp: true, verify: v })
        if (name === 'readonly') {
          assert.equal(first.system, null, '只读查询单趟，不走系统层')
          assert.ok(first.user.length <= READ_ONLY_PROMPT_BUDGET, `只读提示 ${first.user.length} 字符，超过预算 ${READ_ONLY_PROMPT_BUDGET}`)
        } else {
          assert.ok(first.user.length <= TASK_USER_BUDGET, `${name} 实施 user ${first.user.length} 字符，超过预算 ${TASK_USER_BUDGET}`)
          assert.ok(followUp.user.length <= FOLLOW_UP_USER_BUDGET, `${name} 续会话 user ${followUp.user.length} 字符，超过预算 ${FOLLOW_UP_USER_BUDGET}`)
          assert.doesNotMatch(first.user, /编码规范（改任何代码前必做|验证策略（代码类修复必做|- taskState：/, `${name}：驾驶规则不得在 user 层重发`)
        }
        for (const text of [buildTaskPrompt(ctx, task, 'codex', { ruleContext: { text: '', sources: [] }, verify: v }), [first.system, first.user].filter(Boolean).join('\n\n')]) {
          for (const [a, b] of CONFLICT_PAIRS) assert.ok(!(text.includes(a) && text.includes(b)), `${name}${v ? '·verify' : ''}：「${a}」与「${b}」同时出现`)
          for (const marker of SINGLE_USE_MARKERS) assert.ok(text.split(marker).length - 1 <= 1, `${name}${v ? '·verify' : ''}：「${marker}」出现不止一次`)
        }
      }
    })],
  ]))
})

describe('提示词规则预算', () => {
  it('分类器 / 各类任务实施提示（首轮与续会话）/ 分析提示不超预算；续会话不重复任务正文与规则原文；正文里没有事故编号', () => eachCase(TASK_KINDS, ({ name, ...extra }) => {
    const task = { id: 't', attachments: [], chatId: 'oc', ...extra }
    const first = buildTaskPrompt(ctx, task, 'claude', { ruleContext: { text: '', sources: [] }, analysis: null, triage: null, scopeContract: null })
    const followUp = buildTaskPrompt(ctx, task, 'claude', { ruleContext: { text: 'RULES', sources: [] }, analysis: { summary: 's', applicableRules: [], requirements: ['r1'] }, triage: null, scopeContract: { scope: null, lineLimit: 300 }, followUp: true })
    for (const [stage, text] of [['首轮', first], ['续会话', followUp]]) {
      assert.ok(text.length <= TASK_PROMPT_BUDGET, `${name}·${stage}实施提示 ${text.length} 字符，超过预算 ${TASK_PROMPT_BUDGET}：先查有没有重复块、能不能按任务类型裁剪，再合并旧规则`)
      assert.doesNotMatch(text, /PR-0\d{4}/, `${name}·${stage}提示里不得出现事故编号`)
    }
    assert.doesNotMatch(followUp, /<<<UNTRUSTED_TASK_INPUT|<<<TRUSTED_RULE_CONTEXT|\bRULES\b/, `${name} 增量提示不重复任务正文与规则原文块`)
    const classifier = buildIntentClassificationPrompt(task)
    assert.ok(classifier.length <= CLASSIFIER_RULE_BUDGET, `分类器规则 ${classifier.length} 字符，超过预算 ${CLASSIFIER_RULE_BUDGET}`)
    assert.doesNotMatch(classifier, /PR-0\d{4}/)
    const analysis = buildAnalysisPrompt(ctx, task, { text: '', sources: [] }, { lineLimit: 300 })
    assert.ok(analysis.length <= ANALYSIS_PROMPT_BUDGET, `${name} 分析提示 ${analysis.length} 字符，超过预算 ${ANALYSIS_PROMPT_BUDGET}`)
    assert.doesNotMatch(analysis, /PR-0\d{4}/)
  }))
})
