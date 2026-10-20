import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { normalizeRepoProfile, registerRepoProfiles, resetRepoProfiles } from '../lib/lark-repo-profile.mjs'
import { buildAnalysisPrompt, buildIntentClassificationPrompt, buildTaskPrompt } from '../lib/lark-worker-prompts.mjs'

// 规则预算（aven 2026-10-14：规则越补越多，干活越来越慢的坑不能再踩）。
// 这里量的是「去掉数据块后的规则文字」：超了就得合并旧规则，不能只往上叠。
// 10-20：膨胀的主因是同一段规则被几个分支各带一份（代答提示「完成口径」×3、「环境实测」×2，12.5k 早已超标却没量到），
// 所以每种任务都量，并直接断言共用规则块只出现一次；首轮 / 续会话共用一个上限，留约 1.4k 余量给迭代期加规则。
const CLASSIFIER_RULE_BUDGET = 4800
const TASK_PROMPT_BUDGET = 12000
// 第 1 批：分析提示骨架有预算；事故编号（PR-0xxxx）不得写进任何提示正文。
const ANALYSIS_PROMPT_BUDGET = 4000

// 共用规则块的标题：任何一种任务的提示里最多出现一次。
const SINGLE_USE_BLOCKS = ['完成口径（硬规则', '环境实测（硬规则）', '群回复格式（', '代答回复格式（', '缺陷根因分诊（']

const TASK_KINDS = {
  api_reply: { commandType: 'api', intake: { classification: { decision: 'api_reply' } } },
  bug: { commandType: null, intake: { classification: { decision: 'bug' } } },
  requirement: { commandType: null, intake: { classification: { decision: 'requirement' } } },
  question: { commandType: 'status', intake: { classification: { decision: 'question' } } },
}

const countOf = (text, needle) => text.split(needle).length - 1

describe('提示词规则预算', () => {
  afterEach(() => resetRepoProfiles())
  it('分类器规则（不含台账 / 总表数据）不超预算；各类任务的实施提示不超预算、共用规则块不重复', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lark-budget-'))
    try {
      registerRepoProfiles({ repos: { falive: { root: dir, baseRef: 'main', chatIds: ['oc'], ownership: { me: 'aven', meAliases: ['Aven'] }, docIntakeDir: 'docs/pending', verify: { probeCommand: 'node scripts/pre-probe.mjs', schemaCheck: 'x' }, groupPostAsUser: true } } })
      const baseTask = { id: 'x', repo: 'falive', chatId: 'oc', text: 'm', addressedToBot: true, attachments: [] }
      // 传空台账：量的是规则字数，不是运行期 runtime/lark-ledger 的数据量（10-15 台账涨到 50 行把本测试带红）。
      const classifier = buildIntentClassificationPrompt({ ...baseTask, ...TASK_KINDS.api_reply }, { ledger: { items: {}, events: [] } })
      assert.ok(classifier.length <= CLASSIFIER_RULE_BUDGET, `分类器规则 ${classifier.length} 字符，超过预算 ${CLASSIFIER_RULE_BUDGET}：先合并旧规则再加`)
      // 需求口径（教训 #49）：分类只认产品拍板并写进 PRD 的需求变更。
      assert.match(classifier, /产品拍板/, '分类提示缺需求口径')
      assert.doesNotMatch(classifier, /PR-0\d{4}/, '分类提示里不得出现事故编号')
      void normalizeRepoProfile('falive', { root: dir, baseRef: 'main' })
      const ctx = { repo: 'falive', projectId: 'FALIVE', projectName: 'Falive Web', cwd: dir, hotfixBranch: 'lark/x', baseRef: 'main', projectDocs: [], readOnly: false }
      const analysis = { summary: 's', applicableRules: [], requirements: ['r1'] }
      for (const [kind, extra] of Object.entries(TASK_KINDS)) {
        const task = { ...baseTask, ...extra }
        const first = buildTaskPrompt(ctx, task, 'claude', { ruleContext: { text: '', sources: [] }, analysis: null, triage: null, scopeContract: null })
        const followUp = buildTaskPrompt(ctx, task, 'claude', { ruleContext: { text: 'RULES', sources: [] }, analysis, triage: null, scopeContract: { scope: null, lineLimit: 300 }, followUp: true })
        for (const [stage, text] of [['首轮', first], ['续会话', followUp]]) {
          const label = `${kind}·${stage}`
          assert.ok(text.length <= TASK_PROMPT_BUDGET, `${label}实施提示 ${text.length} 字符，超过预算 ${TASK_PROMPT_BUDGET}：先查有没有重复块、能不能按任务类型裁剪，再合并旧规则`)
          for (const block of SINGLE_USE_BLOCKS) assert.ok(countOf(text, block) <= 1, `${label}提示里「${block}」出现 ${countOf(text, block)} 次：共用规则块只渲染一次`)
          assert.equal(countOf(text, '完成口径（硬规则'), 1, `${label}提示缺完成口径`)
          assert.match(text, /产品拍板/, `${label}提示缺需求口径`)
          assert.doesNotMatch(text, /PR-0\d{4}/, `${label}提示里不得出现事故编号`)
        }
        assert.doesNotMatch(followUp, /<<<UNTRUSTED_TASK_INPUT|<<<TRUSTED_RULE_CONTEXT|\bRULES\b/, `${kind} 增量提示不重复任务正文与规则原文块`)
        assert.match(followUp, /实施阶段/)
      }
      // 按任务类型裁剪：代答只用代答格式；缺陷分诊只给可能是缺陷的任务。
      const prompt = (kind) => buildTaskPrompt(ctx, { ...baseTask, ...TASK_KINDS[kind] }, 'claude', { ruleContext: { text: '', sources: [] }, analysis: null, triage: null, scopeContract: null })
      assert.doesNotMatch(prompt('question'), /群回复格式（/, '代答不套对接进度的群回复格式')
      assert.match(prompt('bug'), /缺陷根因分诊（/)
      assert.match(prompt('bug'), /taskState：缺陷类任务的诊断状态机/)
      for (const kind of ['api_reply', 'requirement', 'question']) {
        assert.doesNotMatch(prompt(kind), /缺陷根因分诊（/, `${kind} 不带缺陷分诊`)
        assert.match(prompt(kind), /taskState \/ rootCauseLayer \/ evidence：本任务不是缺陷，都填 null/)
      }
      const analysisPrompt = buildAnalysisPrompt(ctx, { ...baseTask, ...TASK_KINDS.api_reply }, { text: '', sources: [] }, { lineLimit: 300 })
      assert.ok(analysisPrompt.length <= ANALYSIS_PROMPT_BUDGET, `分析提示 ${analysisPrompt.length} 字符，超过预算 ${ANALYSIS_PROMPT_BUDGET}`)
      assert.doesNotMatch(analysisPrompt, /PR-0\d{4}/, '分析提示里不得出现事故编号')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
