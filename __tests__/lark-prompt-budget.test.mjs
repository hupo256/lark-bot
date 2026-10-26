import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { ledgerSummary, loadLedger } from '../lib/lark-ledger.mjs'
import { larkBotRoot } from '../lib/lark-paths.mjs'
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
  // aven 2026-10-20 review B4：以下几类此前没量到——对接答复块要正文里有【被引用消息】才渲染；文档入库要带文件附件；
  // 等材料的交办、日报清扫、非代答的只读查询、带分诊结论的 bug、被分成 requirement 但其实是「改成 X」的缺陷。
  api_reply_quoted: { commandType: 'api', text: '你再看看\n【被引用消息】Encone：getRoomInfo 的 anchor 字段已补，pre 已更新', intake: { classification: { decision: 'api_reply' } } },
  doc_intake: { commandType: 'api', attachments: [{ type: 'file', localPath: '/tmp/x/1-对接-直播.md', fileName: '1-对接-直播.md' }], archivedDocs: ['docs/pending/对接-直播.md', 'docs/reply/对接-答复.md#kept'] },
  standing: { commandType: null, intake: { classification: { decision: 'requirement' } }, waitsFor: '新域名', standingFrom: ['t0'] },
  sweep: { source: 'daily-sweep', commandType: null },
  readonly: { commandType: 'status', text: '项目进度怎么样' },
  bug_triaged: { commandType: null, intake: { classification: { decision: 'bug' } }, triage: { summary: '前端 mapper 取错字段', evidence: ['src/x.ts:1'] } },
  modify_as_requirement: { commandType: null, text: '把预约按钮颜色改成红色', intake: { classification: { decision: 'requirement' } } },
  // 教训 #58：本条要 bot 自己上 pre 看（引用卡里那句「请测试同学在 pre 看一眼」不算）。
  pre_check: { commandType: null, text: '【被引用消息】\n请测试同学在 pre 看一眼\n\n【本条 @】@Aven.Bot 你自己在 pre 环境看，看完报告结果', intake: { classification: { decision: 'requirement' } } },
}

const countOf = (text, needle) => text.split(needle).length - 1
// 量字数时把 lark-bot 检出路径换成定长占位：预算量的是规则，不随检出在哪个目录变（10-23：worktree 路径长 9 个字就超 1 字）。
// 代答提示里的对接台账读的是本机 runtime/lark-ledger/falive.json（路径在模块加载时定死，测试换不了目录），同样换成占位：
// 量的是规则不是运行期数据（10-26：台账涨到 50 行，question 提示 12239 字把本测试带红，排空重启自检因此一直不过；同 10-15 分类器）。
const liveLedger = ledgerSummary(loadLedger('falive'))
const sizeOf = (text) => {
  const masked = text.split(larkBotRoot).join('<lark-bot>')
  return (liveLedger ? masked.split(liveLedger).join('<ledger>') : masked).length
}

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
      for (const [kind, { triage = null, ...extra }] of Object.entries(TASK_KINDS)) {
        const task = { ...baseTask, ...extra }
        const first = buildTaskPrompt(ctx, task, 'claude', { ruleContext: { text: '', sources: [] }, analysis: null, triage, scopeContract: null })
        const followUp = buildTaskPrompt(ctx, task, 'claude', { ruleContext: { text: 'RULES', sources: [] }, analysis, triage, scopeContract: { scope: null, lineLimit: 300 }, followUp: true })
        for (const [stage, text] of [['首轮', first], ['续会话', followUp]]) {
          const label = `${kind}·${stage}`
          assert.ok(sizeOf(text) <= TASK_PROMPT_BUDGET, `${label}实施提示 ${sizeOf(text)} 字符，超过预算 ${TASK_PROMPT_BUDGET}：先查有没有重复块、能不能按任务类型裁剪，再合并旧规则`)
          for (const block of SINGLE_USE_BLOCKS) assert.ok(countOf(text, block) <= 1, `${label}提示里「${block}」出现 ${countOf(text, block)} 次：共用规则块只渲染一次`)
          assert.equal(countOf(text, '完成口径（硬规则'), 1, `${label}提示缺完成口径`)
          assert.match(text, /产品拍板/, `${label}提示缺需求口径`)
          assert.doesNotMatch(text, /PR-0\d{4}/, `${label}提示里不得出现事故编号`)
        }
        assert.doesNotMatch(followUp, /<<<UNTRUSTED_TASK_INPUT|<<<TRUSTED_RULE_CONTEXT|\bRULES\b/, `${kind} 增量提示不重复任务正文与规则原文块`)
        assert.match(followUp, /实施阶段/)
      }
      // 按任务类型裁剪：代答只用代答格式；缺陷分诊只给可能是缺陷的任务。
      const prompt = (kind) => {
        const { triage = null, ...extra } = TASK_KINDS[kind]
        return buildTaskPrompt(ctx, { ...baseTask, ...extra }, 'claude', { ruleContext: { text: '', sources: [] }, analysis: null, triage, scopeContract: null })
      }
      // 教训 #58：本条要上 pre 看 → 给 Playwright 验 pre 的口径，不带「跳过 Browser」，也不带清扫专属口径；只在引用卡里出现不算。
      assert.match(prompt('pre_check'), /本任务明确要求浏览器验证，必须做/)
      // 验证是 bot 的活（aven 2026-10-22）：配了 verify 的仓，普通实施也给本地起 dev 连 pre 后端验的口径，不再「禁止起 dev server」。
      assert.match(prompt('modify_as_requirement'), /自己验证（硬规则）/)
      assert.doesNotMatch(prompt('modify_as_requirement'), /禁止启动 dev server|写「代码已接，pre 未验证」|已接通，待发布 pre/)
      assert.doesNotMatch(prompt('pre_check'), /跳过 Browser|不要运行 Browser|日报发布后自动建立/)
      assert.doesNotMatch(prompt('api_reply_quoted'), /用 Playwright 验已部署的 pre 站点/)
      assert.doesNotMatch(prompt('question'), /群回复格式（/, '代答不套对接进度的群回复格式')
      // 缺陷分诊按任务性质（resolveWorkKind）给：分类成 requirement 的「改成 X」也算缺陷（review B1）。
      for (const kind of ['bug', 'bug_triaged', 'modify_as_requirement']) {
        assert.match(prompt(kind), /缺陷根因分诊（/, `${kind} 带缺陷分诊`)
        assert.match(prompt(kind), /taskState：缺陷类任务的诊断状态机/)
      }
      for (const kind of ['api_reply', 'api_reply_quoted', 'doc_intake', 'requirement', 'question', 'readonly', 'sweep', 'standing']) {
        assert.doesNotMatch(prompt(kind), /缺陷根因分诊（/, `${kind} 不带缺陷分诊`)
        assert.match(prompt(kind), /taskState \/ rootCauseLayer \/ evidence：本任务不是缺陷，都填 null/)
        // 非缺陷任务 taskState 填 null，提示里不能再让它用 awaiting_owner_fix（review B3）。
        assert.doesNotMatch(prompt(kind), /awaiting_owner_fix/, `${kind} 不该出现 awaiting_owner_fix`)
      }
      // 对接答复不带整段分诊，但保留「后端根因严禁前端凑数」（review B1）。
      for (const kind of ['api_reply', 'api_reply_quoted', 'doc_intake']) assert.match(prompt(kind), /后端根因严禁前端凑数/, `${kind} 缺后端根因条`)
      assert.match(prompt('api_reply_quoted'), /对接答复处理（/, '带【被引用消息】的对接答复要量到答复处理块')
      // 代答：summary 只在代答块说一次；完成口径指向结果契约（review B2）。
      const question = prompt('question')
      assert.doesNotMatch(question, /上面的三档口径|2～3 句|summary 直接回答/)
      assert.match(question, /代答填 report/, '代答按结构化 report（10-21 P6）')
      for (const kind of Object.keys(TASK_KINDS)) assert.doesNotMatch(prompt(kind), /群回复格式（|代答回复格式（/, `${kind} 还带着旧的散文格式`)
      // 文档入库：worker 已存档，提示里不再有覆盖规则（review C5）。
      assert.doesNotMatch(prompt('doc_intake'), /同名已存在则覆盖|先把每份文件\*\*原样\*\*拷贝/)
      assert.match(prompt('doc_intake'), /#kept/)
      // 非代答的只读查询不带群回复块 / 待确认清单（review #16）。
      assert.doesNotMatch(prompt('readonly'), /群回复（|待确认-/)
      // 日报清扫：不渲染「不要启动 dev server」；本次改动在本地起 dev 连 pre 后端验，看 console 有没有「回落 mock」（aven 2026-10-22，取代 review #15 的 build:pre + 反代）。
      assert.doesNotMatch(prompt('sweep'), /不要启动 dev server|禁止启动 dev server/)
      assert.match(prompt('sweep'), /pnpm dev:pre/)
      // 默认仓（fameex 内部群）不按任务类型裁剪：显式 api: 任务照旧带缺陷分诊与根因字段说明。
      resetRepoProfiles()
      const internalApi = buildTaskPrompt({ ...ctx, repo: undefined }, { id: 'y', chatId: 'oc_internal', text: 'api: x', commandType: 'api', attachments: [] }, 'claude', { ruleContext: { text: '', sources: [] }, analysis: null, triage: null, scopeContract: null })
      assert.match(internalApi, /缺陷根因分诊（/, '内部群 api 任务不得裁掉缺陷分诊')
      assert.doesNotMatch(internalApi, /本任务不是缺陷，都填 null/)
      registerRepoProfiles({ repos: { falive: { root: dir, baseRef: 'main', chatIds: ['oc'], ownership: { me: 'aven', meAliases: ['Aven'] }, docIntakeDir: 'docs/pending', verify: { probeCommand: 'node scripts/pre-probe.mjs', schemaCheck: 'x' }, groupPostAsUser: true } } })
      const analysisPrompt = buildAnalysisPrompt(ctx, { ...baseTask, ...TASK_KINDS.api_reply }, { text: '', sources: [] }, { lineLimit: 300 })
      assert.ok(analysisPrompt.length <= ANALYSIS_PROMPT_BUDGET, `分析提示 ${analysisPrompt.length} 字符，超过预算 ${ANALYSIS_PROMPT_BUDGET}`)
      assert.doesNotMatch(analysisPrompt, /PR-0\d{4}/, '分析提示里不得出现事故编号')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
