import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { normalizeRepoProfile, registerRepoProfiles, resetRepoProfiles } from '../lib/lark-repo-profile.mjs'
import { buildAnalysisPrompt, buildIntentClassificationPrompt, buildTaskPrompt } from '../lib/lark-worker-prompts.mjs'

// 规则预算（aven 2026-10-14：规则越补越多，干活越来越慢的坑不能再踩）。
// 这里量的是「去掉数据块后的规则文字」：超了就得合并旧规则，不能只往上叠。
const CLASSIFIER_RULE_BUDGET = 4800
const TASK_PROMPT_BUDGET = 12000
// 第 1 批：分析提示骨架、实施续会话的增量提示各有预算；事故编号（PR-0xxxx）不得写进任何提示正文。
const ANALYSIS_PROMPT_BUDGET = 4000
const IMPLEMENTATION_FOLLOWUP_BUDGET = 11000

describe('提示词规则预算', () => {
  afterEach(() => resetRepoProfiles())
  it('分类器规则（不含台账 / 总表数据）不超预算；实施提示骨架不超预算', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lark-budget-'))
    try {
      registerRepoProfiles({ repos: { falive: { root: dir, baseRef: 'main', chatIds: ['oc'], ownership: { me: 'aven', meAliases: ['Aven'] }, docIntakeDir: 'docs/pending', verify: { probeCommand: 'node scripts/pre-probe.mjs', schemaCheck: 'x' }, groupPostAsUser: true } } })
      const task = { id: 'x', repo: 'falive', chatId: 'oc', text: 'm', addressedToBot: true, attachments: [], intake: { classification: { decision: 'api_reply' } }, commandType: 'api' }
      // 传空台账：量的是规则字数，不是运行期 runtime/lark-ledger 的数据量（10-15 台账涨到 50 行把本测试带红）。
      const classifier = buildIntentClassificationPrompt(task, { ledger: { items: {}, events: [] } })
      assert.ok(classifier.length <= CLASSIFIER_RULE_BUDGET, `分类器规则 ${classifier.length} 字符，超过预算 ${CLASSIFIER_RULE_BUDGET}：先合并旧规则再加`)
      const profile = normalizeRepoProfile('falive', { root: dir, baseRef: 'main' })
      void profile
      const ctx = { repo: 'falive', projectId: 'FALIVE', projectName: 'Falive Web', cwd: dir, hotfixBranch: 'lark/x', baseRef: 'main', projectDocs: [], readOnly: false }
      const taskPrompt = buildTaskPrompt(ctx, task, 'claude', { ruleContext: { text: '', sources: [] }, analysis: null, triage: null, scopeContract: null })
      assert.ok(taskPrompt.length <= TASK_PROMPT_BUDGET, `实施提示 ${taskPrompt.length} 字符，超过预算 ${TASK_PROMPT_BUDGET}：先合并旧规则再加`)
      const analysisPrompt = buildAnalysisPrompt(ctx, task, { text: '', sources: [] }, { lineLimit: 300 })
      assert.ok(analysisPrompt.length <= ANALYSIS_PROMPT_BUDGET, `分析提示 ${analysisPrompt.length} 字符，超过预算 ${ANALYSIS_PROMPT_BUDGET}`)
      const analysis = { summary: 's', applicableRules: [], requirements: ['r1'] }
      const followUp = buildTaskPrompt(ctx, task, 'claude', { ruleContext: { text: 'RULES', sources: [] }, analysis, triage: null, scopeContract: { scope: null, lineLimit: 300 }, followUp: true })
      assert.ok(followUp.length <= IMPLEMENTATION_FOLLOWUP_BUDGET, `续会话实施提示 ${followUp.length} 字符，超过预算 ${IMPLEMENTATION_FOLLOWUP_BUDGET}`)
      assert.doesNotMatch(followUp, /<<<UNTRUSTED_TASK_INPUT|<<<TRUSTED_RULE_CONTEXT|\bRULES\b/, '增量提示不重复任务正文与规则原文块')
      assert.match(followUp, /实施阶段/)
      // 需求口径（教训 #49）：分类与作答都只认产品拍板并写进 PRD 的需求变更。
      for (const [name, text] of [['分类', classifier], ['实施', taskPrompt]]) assert.match(text, /产品拍板/, `${name}提示缺需求口径`)
      for (const [name, text] of [['分类', classifier], ['实施', taskPrompt], ['分析', analysisPrompt], ['续会话', followUp]]) {
        assert.doesNotMatch(text, /PR-0\d{4}/, `${name}提示里不得出现事故编号`)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
