import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildAnalysisPrompt, buildIntentClassificationPrompt, buildTaskPrompt } from '../lib/lark-worker-prompts.mjs'
import { eachCase } from './support/steps.mjs'

// 规则预算（从 falive 移植，aven 2026-10-14：规则越补越多，干活越来越慢的坑不能再踩）。超了就得合并旧规则，不能只往上叠。
// 10-31 按 fameex 线当时的实测钉住：实施提示约 8.2k（上限 9500，留约 1.3k 给迭代期加规则）、分析提示约 2.1k、分类器约 0.7k。
const CLASSIFIER_RULE_BUDGET = 1500
const TASK_PROMPT_BUDGET = 9500
const ANALYSIS_PROMPT_BUDGET = 2600
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
