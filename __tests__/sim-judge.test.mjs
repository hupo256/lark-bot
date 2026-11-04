// 回放裁判链路（design-v2 §5 / §6，P0-g）的纯函数：规则预判与输出指纹、提示冻结、裁判缓存、金标准评审表、验收。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { collapseVerdicts, evaluateAcceptance } from '../scripts/sim/acceptance.mjs'
import { goldRefOf, lookupVerdict, storeVerdict } from '../scripts/sim/judge-cache.mjs'
import { CHOICES, mergeGold, parseReviewMd, renderReviewItem, selectForReview } from '../scripts/sim/gold.mjs'
import { JUDGE_PROMPT_VERSION, JUDGE_SCHEMA, assertPromptFrozen, buildJudgePrompt } from '../scripts/sim/judge-prompt.mjs'
import { attributeOutbox, larkFacts, normalizeOutputText, ruleFlags } from '../scripts/sim/judge-rules.mjs'
import { runSteps } from './support/steps.mjs'

const AVEN = 'ou_91861d6da6cf6822e08045ba1868241e'
const T0 = Date.parse('2026-10-20T08:00:00Z')
const msg = (id, atMs, chatId = 'oc_php', extra = {}) => ({ id, atMs, chatId, chatKey: 'php-group', chatName: 'PHP 群', senderName: 'Arthur', text: `原话 ${id}`, ...extra })
const out = (id, at, extra) => ({ id, at, kind: 'reply', chatId: 'oc_php', userId: null, parentId: null, text: '', ...extra })
const line = (id, better, confidence = 'high', extra = {}) => ({ id, better, confidence, at: '2026-10-20T08:00:00Z', fingerprint: `fp-${id}`, sim: 'r1/ep-1', reason: '理由', idealBehavior: '理想', larkIssue: 'missed', cause: 'bot', ...extra })
const v = (id, better, extra = {}) => ({ id, better, at: '2026-10-20', larkIssue: 'none', ...extra })

// 新文件一条 runSteps 合并多段（测试体量棘轮：新文件只占一个 it）
describe('回放裁判链路（P0-g）', () => {
  it('规则预判与指纹 / 提示冻结 / 裁判缓存 / 金标准评审表 / 验收', () => runSteps([
    ['去掉回放发件 id、时间戳 / 钟点 / 耗时、临时路径与 sim 目录，保留真实消息 id', () => {
      const text = '见 om_sim00012（2026-10-20T08:01:02.123Z，12:34）耗时 42 秒 /tmp/sim-x/a.log /Users/a/sim/r1/ep-1/x om_x100b6246ece5f8a0ed5fc6d0c91bdcd'
      assert.equal(normalizeOutputText(text, { simDir: '/Users/a/sim/r1/ep-1' }), '见 <SIM_MSG>（<TIME>，<HH:MM>）耗时 <DUR> <TMP> <SIM_DIR>/x om_x100b6246ece5f8a0ed5fc6d0c91bdcd')
      assert.equal(normalizeOutputText('uid 508 code 0，127.0.0.1:3105'), 'uid 508 code 0，127.0.0.1:3105')
    }],

    ['发件归属：直接回复 → 跟着已归属的 bot 消息 → 正文点名的 case → 同会话之前最近一条（私信不限会话）→ 超过 2 小时为孤儿', () => {
      const a = msg('om_x100b0000000000000000000000000a1', T0)
      const b = msg('om_x100b0000000000000000000000000b2', T0 + 10 * 60_000, 'oc_tech')
      const { byCase, orphans } = attributeOutbox({
        cases: [a, b],
        webhookChatId: 'oc_hook',
        outbox: [
          out('om_sim1', T0 + 1000, { parentId: a.id }),
          out('om_sim2', T0 + 2000, { parentId: 'om_sim1' }),
          out('om_sim3', T0 + 11 * 60_000, { kind: 'send', chatId: AVEN, userId: AVEN, text: `接着做 ${a.id}` }),
          out('om_sim4', T0 + 12 * 60_000, { kind: 'send', chatId: AVEN, userId: AVEN, text: '做完了' }),
          out('om_sim5', T0 + 13 * 60_000, { kind: 'send', chatId: 'oc_php', text: '群里一句' }),
          out('om_sim6', T0 + 5 * 3600_000, { kind: 'send', chatId: 'oc_php', text: '很久以后' }),
        ],
      })
      assert.deepEqual(byCase.get(a.id).map((o) => o.id), ['om_sim1', 'om_sim2', 'om_sim3', 'om_sim5'])
      assert.deepEqual(byCase.get(b.id).map((o) => o.id), ['om_sim4'])
      assert.deepEqual(orphans.map((o) => o.id), ['om_sim6'])
    }],

    ['指纹：发件 id 与时间整体平移不变；多一条完全重复的回复就变，并记 duplicates；负责人私信的回应算「回了」', () => {
      const m = msg('om_x1', T0)
      const items = (shift, dup) => [
        out(`om_sim${1 + shift}`, T0 + 30_000 + shift, { parentId: m.id, text: '收到' }),
        out(`om_sim${2 + shift}`, T0 + 60_000 + shift, { parentId: m.id, text: `结论（${shift ? '12:40' : '12:39'}）：通了` }),
        ...(dup ? [out(`om_sim${3 + shift}`, T0 + 90_000 + shift, { parentId: m.id, text: '结论（12:41）：通了' })] : []),
      ]
      const task = { id: m.id, status: 'done', intake: { classification: { decision: 'api_reply', deliverable: 'verification' } } }
      const base = larkFacts({ m, items: items(0, false), task })
      assert.equal(larkFacts({ m, items: items(37, false), task }).fingerprint, base.fingerprint)
      const dup = larkFacts({ m, items: items(0, true), task })
      assert.notEqual(dup.fingerprint, base.fingerprint)
      assert.equal(dup.duplicates, 1)
      assert.equal(base.firstReplyMs, 30_000)
      assert.notEqual(larkFacts({ m, items: items(0, false), task: { ...task, status: 'failed' } }).fingerprint, base.fingerprint)
      const dm = msg('om_x2', T0, 'oc_hook', { chatKey: 'webhook-group' })
      const facts = larkFacts({ m: dm, items: [out('om_sim9', T0 + 5000, { kind: 'send', chatId: AVEN, userId: AVEN, text: '好的' })], webhookChatId: 'oc_hook' })
      assert.equal(facts.replied, true)
      assert.equal(facts.dmToAven, 1)
      assert.equal(facts.replyCount, 0)
    }],

    ['旗标：falive 回了 lark-bot 没回 → no_reply；falive 没分类记录不算分类不同', () => {
      const lark = { replied: false, duplicates: 0, decision: 'ignore', status: null, firstReplyMs: null }
      assert.deepEqual(ruleFlags({ lark, falive: { replied: true, decision: null, firstReplyMs: 1000 }, pending: false }), ['no_reply'])
      assert.deepEqual(ruleFlags({ lark: { ...lark, replied: true, duplicates: 2, status: 'running', firstReplyMs: 20 * 60_000 }, falive: { replied: true, decision: 'bug', firstReplyMs: 1000 }, pending: true }), ['pending', 'duplicate', 'decision_diff', 'not_concluded', 'slower'])
    }],
    ['当前版本的指纹已登记；提示带 11-04 口径与新结构', () => {
      assert.equal(typeof assertPromptFrozen(), 'string')
      assert.match(JUDGE_PROMPT_VERSION, /^judge-v\d+/)
      assert.deepEqual(JUDGE_SCHEMA.required, ['better', 'confidence', 'reason', 'larkIssue', 'cause', 'idealBehavior'])
      const ctx = {
        m: { atMs: T0, chatKey: 'php-group', chatName: 'PHP 群', senderName: 'Arthur', text: '测一下 pre 验证码', atBot: true },
        parent: null, replyToBot: false, context: '', tag: { kind: 'verification', risk: ['permission'] }, evidence: { env: ['pre'], envDownThen: true, evidence: '当时 503', match: 'strong' },
        falive: { classified: null, replies: [], humanFollowups: [], ledger: null, audit: null, routing: [] },
        lark: { replyCount: 0, dmToAven: 0, duplicates: 0, firstReplyMs: null, lines: [] },
        gold: null,
      }
      const prompt = buildJudgePrompt(ctx)
      for (const must of ['需求边界', 'NewRegisteredByMail', '登录态发的 POST', '判过程，不判结论', '打包到 uat / OL', '已部署', '当时环境本身就挂了', '权限（登录注册']) assert.ok(prompt.includes(must), must)
      assert.ok(!prompt.includes('【金标准'))
      assert.ok(buildJudgePrompt({ ...ctx, gold: { better: 'falive', ideal: '别注册新号', reviewedOutput: 'status=done' } }).includes('理想做法：别注册新号'))
    }],
    ['同 case + 指纹 + 版本 + 参照才复用；high 判过的不顶 max，max 判过的能顶 high', () => {
      const root = mkdtempSync(join(tmpdir(), 'judge-cache-'))
      try {
        const key = { id: 'om_x1', fingerprint: 'fp1', promptVersion: 'judge-vT', root }
        assert.equal(lookupVerdict({ ...key, effort: 'high' }), null)
        storeVerdict({ ...key, effort: 'high', model: 'm', verdict: { better: 'same' }, sim: 's' })
        assert.equal(lookupVerdict({ ...key, effort: 'high' }).verdict.better, 'same')
        assert.equal(lookupVerdict({ ...key, effort: 'max' }), null)
        assert.equal(lookupVerdict({ ...key, fingerprint: 'fp2' }), null)
        assert.equal(lookupVerdict({ ...key, promptVersion: 'judge-vU' }), null)
        assert.equal(lookupVerdict({ ...key, ref: goldRefOf({ better: 'falive', ideal: 'x' }) }), null)
        storeVerdict({ ...key, effort: 'max', model: 'm', verdict: { better: 'falive' }, sim: 's' })
        assert.equal(lookupVerdict({ ...key, effort: 'high' }).verdict.better, 'falive')
        assert.notEqual(goldRefOf({ better: 'falive', ideal: 'x' }), goldRefOf({ better: 'falive', ideal: 'y' }))
      } finally { rmSync(root, { recursive: true, force: true }) }
    }],
    ['挑 falive / 都不对 / 拿不准，跳过待办与 aven 已审同一输出的；同 case 只出一次', () => {
      const judgeLines = [line('om_a', 'falive'), line('om_a', 'falive'), line('om_b', 'same'), line('om_c', 'same', 'low'), line('om_d', 'both_wrong'), line('om_e', 'pending'), line('om_f', 'falive')]
      const gold = new Map([['om_f', { by: 'aven', reviewedFingerprint: 'fp-om_f' }]])
      assert.deepEqual(selectForReview({ judgeLines, gold }).map((l) => l.id), ['om_a', 'om_c', 'om_d'])
      assert.ok(selectForReview({ judgeLines, gold, again: true }).some((l) => l.id === 'om_f'))
    }],

    ['渲染一屏 → aven 勾选 → 解析回来；勾多项 / 只写理想没勾的报问题', () => {
      const m = { atMs: T0, chatKey: 'php-group', chatName: 'PHP 群', senderName: 'Arthur', text: '测一下' }
      const render = (id) => renderReviewItem({ line: line(id, 'falive'), m, rule: { lark: { lines: [{ afterMs: 1000, channel: 'group', text: '收到' }] } } }, 1, 3)
      const block = render('om_a')
      for (const c of CHOICES) assert.ok(block.includes(`- [ ] ${c.label}`))
      const edited = [
        render('om_a').replace('- [ ] 都不对', '- [x] 都不对').replace('- 理想做法：', '- 理想做法：先问 aven'),
        render('om_b').replace('- [ ] falive 对', '- [x] falive 对').replace('- [ ] 一样（两边都行）', '- [X] 一样（两边都行）'),
        render('om_c').replace('- 理想做法：', '- 理想做法：只写了理想'),
        render('om_d'),
        render('om_e').replace('- [ ] lark-bot 对', '- [x] lark-bot 对'),
      ].join('\n')
      const { picks, problems } = parseReviewMd(edited)
      assert.deepEqual(picks, [{ id: 'om_a', better: 'both_wrong', ideal: '先问 aven' }, { id: 'om_e', better: 'lark-bot', ideal: '' }])
      assert.deepEqual(problems.map((p) => p.id), ['om_b', 'om_c'])
    }],

    ['入库：aven 的覆盖裁判补的，裁判补的不覆盖 aven 的', () => {
      const existing = new Map([['om_a', { id: 'om_a', by: 'aven', better: 'falive' }], ['om_b', { id: 'om_b', by: 'judge', better: 'same' }]])
      const merged = mergeGold(existing, [{ id: 'om_a', by: 'judge', better: 'same' }, { id: 'om_b', by: 'aven', better: 'both_wrong' }, { id: 'om_c', by: 'judge', better: 'lark-bot' }])
      assert.deepEqual([...merged.values()].map((g) => `${g.id}:${g.by}:${g.better}`), ['om_a:aven:falive', 'om_b:aven:both_wrong', 'om_c:judge:lark-bot'])
    }],
    ['全过：没有风险 case 变差、没有重复 / 漏回、falive 更好在上限内且都有原因、不回退、全覆盖', () => {
      const current = collapseVerdicts([v('a', 'same'), v('b', 'lark-bot'), v('c', 'falive'), v('p', 'pending')])
      const rules = new Map([['a', { id: 'a', lark: { duplicates: 0 } }], ['b', { id: 'b', lark: { duplicates: 0 } }], ['c', { id: 'c', lark: { duplicates: 0 } }], ['p', { id: 'p', pending: true, lark: { duplicates: 1 } }]])
      const r = evaluateAcceptance({ current, rules, prev: new Map([['a', v('a', 'same')]]), explained: new Map([['c', {}]]), total: 285 })
      assert.equal(r.pass, true)
      assert.equal(r.limit, 14)
      assert.equal(r.pending.length, 1)
    }],

    ['各条硬线与回退都能抓到；同一 case 多行取最差；case-tags 的 pending 也排除', () => {
      const current = collapseVerdicts([
        v('risk', 'falive', { risk: ['money'] }),
        v('dup', 'same'), v('dup', 'both_wrong', { larkIssue: 'duplicate' }),
        v('ruledup', 'same'),
        v('reg', 'both_wrong'),
        v('tagpending', 'falive', { risk: ['status'] }),
      ])
      assert.equal(current.get('dup').better, 'both_wrong')
      const rules = new Map([['ruledup', { id: 'ruledup', lark: { duplicates: 1 } }], ['missing', { id: 'missing', lark: { duplicates: 0 } }]])
      const r = evaluateAcceptance({ current, rules, prev: new Map([['reg', v('reg', 'lark-bot')]]), pendingOf: (id) => id === 'tagpending', total: 20 })
      const by = Object.fromEntries(r.checks.map((c) => [c.key, c.offending.map((o) => o.id).sort()]))
      assert.equal(r.pass, false)
      assert.deepEqual(by['hard-risk'], ['risk'])
      assert.deepEqual(by['hard-reply'], ['dup', 'ruledup'])
      assert.deepEqual(by.share, []) // 20 × 5% = 1，1 条 falive 不超上限；但它没有已知原因
      assert.deepEqual(by.explained, ['risk'])
      assert.deepEqual(by.regress, ['reg'])
      assert.deepEqual(by.coverage, ['missing'])
      assert.ok(r.pending.some((p) => p.id === 'tagpending'))
    }],
  ]))
})
