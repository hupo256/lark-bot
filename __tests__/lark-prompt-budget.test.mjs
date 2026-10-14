import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { normalizeRepoProfile, registerRepoProfiles, resetRepoProfiles } from '../lib/lark-repo-profile.mjs'
import { buildIntentClassificationPrompt, buildTaskPrompt } from '../lib/lark-worker-prompts.mjs'

// 规则预算（aven 2026-10-14：规则越补越多，干活越来越慢的坑不能再踩）。
// 这里量的是「去掉数据块后的规则文字」：超了就得合并旧规则，不能只往上叠。
const CLASSIFIER_RULE_BUDGET = 4800
const TASK_PROMPT_BUDGET = 12000

describe('提示词规则预算', () => {
  afterEach(() => resetRepoProfiles())
  it('分类器规则（不含台账 / 总表数据）不超预算；实施提示骨架不超预算', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lark-budget-'))
    try {
      registerRepoProfiles({ repos: { falive: { root: dir, baseRef: 'main', chatIds: ['oc'], ownership: { me: 'aven', meAliases: ['Aven'] }, docIntakeDir: 'docs/pending', verify: { probeCommand: 'node scripts/pre-probe.mjs', schemaCheck: 'x' }, groupPostAsUser: true } } })
      const task = { id: 'x', repo: 'falive', chatId: 'oc', text: 'm', addressedToBot: true, attachments: [], intake: { classification: { decision: 'api_reply' } }, commandType: 'api' }
      const classifier = buildIntentClassificationPrompt(task)
      assert.ok(classifier.length <= CLASSIFIER_RULE_BUDGET, `分类器规则 ${classifier.length} 字符，超过预算 ${CLASSIFIER_RULE_BUDGET}：先合并旧规则再加`)
      const profile = normalizeRepoProfile('falive', { root: dir, baseRef: 'main' })
      void profile
      const ctx = { repo: 'falive', projectId: 'FALIVE', projectName: 'Falive Web', cwd: dir, hotfixBranch: 'lark/x', baseRef: 'main', projectDocs: [], readOnly: false }
      const taskPrompt = buildTaskPrompt(ctx, task, 'claude', { ruleContext: { text: '', sources: [] }, analysis: null, triage: null, scopeContract: null })
      assert.ok(taskPrompt.length <= TASK_PROMPT_BUDGET, `实施提示 ${taskPrompt.length} 字符，超过预算 ${TASK_PROMPT_BUDGET}：先合并旧规则再加`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
