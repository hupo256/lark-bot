// 回放裁判链路（design-v2 §5 / §6，P0-g）的纯函数：规则预判与输出指纹、模拟局限旗标、提示冻结、裁判缓存、金标准评审表、验收。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { collapseVerdicts, evaluateAcceptance, simLimitOf } from '../scripts/sim/acceptance.mjs'
import { goldRefOf, lookupVerdict, storeVerdict, withLimitsRef } from '../scripts/sim/judge-cache.mjs'
import { CHOICES, mergeGold, parseReviewMd, renderReviewItem, selectForReview } from '../scripts/sim/gold.mjs'
import { JUDGE_PROMPT_VERSION, JUDGE_SCHEMA, assertPromptFrozen, buildJudgePrompt, carryable } from '../scripts/sim/judge-prompt.mjs'
import { attributeOutbox, egressEvidenceOf, egressRelevant, larkFacts, normalizeOutputText, resumedTaskOf, ruleFlags } from '../scripts/sim/judge-rules.mjs'
import { externalLimitOf, faliveAnchorsOf, faliveRefOf, parseFaliveDown, refFactsOf, simLimitsOf } from '../scripts/sim/sim-limits.mjs'
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
      // 任务链优先于正文点名 / 时间窗（b4 93d62945：私信列了候选任务的 id；742acdf9：并入单的私信 ✅ 按时间窗归错）
      const c = msg('om_x100b0000000000000000000000000c3', T0 + 20 * 60_000, 'oc_hook')
      const tasks = new Map([['om_x100b00000000000000000000000f4', { id: 'om_x100b00000000000000000000000f4', supersededBy: 'om_x100b0000000000000000000000000e9', answerFor: [b.id] }]])
      const chain = attributeOutbox({
        cases: [a, b, c], tasks, webhookChatId: 'oc_hook',
        outbox: [
          out('om_sim7', T0 + 21 * 60_000, { kind: 'send', chatId: AVEN, userId: AVEN, text: `是不是这条：继续任务 ${a.id}`, idempotencyKey: `${c.id}-pn` }),
          out('om_sim8', T0 + 22 * 60_000, { kind: 'send', chatId: AVEN, userId: AVEN, text: '✅ 做完了', idempotencyKey: 'om_x100b00000000000000000000000f4-e2-pn-do' }),
        ],
      })
      assert.deepEqual(chain.byCase.get(c.id).map((o) => o.id), ['om_sim7'])
      assert.deepEqual(chain.byCase.get(b.id).map((o) => o.id), ['om_sim8'])
      // 「继续任务 <id>」没建自己的单：点名的任务在模拟里有 → 当并进它
      const sim = { tasks: new Map([[a.id, {}]]) }
      assert.equal(resumedTaskOf({ m: { id: 'x', text: `继续任务 ${a.id} 做` }, sim }), a.id)
      assert.equal(resumedTaskOf({ m: { id: 'x', text: `看下 ${a.id}` }, sim }), null)
      assert.equal(resumedTaskOf({ m: { id: 'x', text: `继续任务 ${a.id}` }, sim: { tasks: new Map([[a.id, {}], [b.id, {}]]), mergedInto: new Map([[a.id, b.id]]) } }), b.id)
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
      for (const must of ['需求边界', 'NewRegisteredByMail', '登录态发的 POST', '发登录验证码再用它登录', '为注册发验证码都越界', '登录以外的任何写操作', 'better 只能是 falive', '只探配置里的环境地址', '判过程，不判结论', '打包到 uat / OL', '已部署', '当时环境本身就挂了', '权限（登录注册', '准 > 快 > 省', '约有 1 成', '规则没查出这条有模拟局限']) assert.ok(prompt.includes(must), must)
      assert.ok(!prompt.includes('【金标准'))
      const limited = buildJudgePrompt({ ...ctx, simLimits: [{ flag: 'sim_limit_edited', why: '发出后 8 秒被编辑过' }] })
      assert.ok(limited.includes('触发消息发出后被编辑过（sim_limit_edited）：发出后 8 秒被编辑过'))
      assert.ok(buildJudgePrompt({ ...ctx, gold: { better: 'falive', ideal: '别注册新号', reviewedOutput: 'status=done' } }).includes('理想做法：别注册新号'))
      // v4 块只在有内容时出现；都没有才可沿用 v3 缓存
      assert.ok(!prompt.includes('【回放出网记录】') && carryable(ctx))
      const v4 = buildJudgePrompt({ ...ctx, egress: [{ line: 'GET falivepre.fdsser.com ×30' }], lark: { ...ctx.lark, mergedResult: '范围未定' }, simLimits: [{ flag: 'sim_limit_falive_ref', why: '卡藏了' }] })
      for (const must of ['【回放出网记录】', 'GET falivepre.fdsser.com ×30', '别从它的话', '并入 / 续跑的那单的结论：范围未定', '问的是 falive 当时自己那张卡']) assert.ok(v4.includes(must), must)
      assert.equal(carryable({ ...ctx, egress: [{ line: 'x' }] }), false)
      assert.equal(carryable({ ...ctx, simLimits: [{ flag: 'sim_limit_external_soft', why: 'x' }] }), false)
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

    ['模拟局限旗标：falive 日志里的 ack 失败 / 排空窗口、路由锚点、编辑过、连发、锚到模拟里没有的任务、bug 表、实测类', () => {
      const id = (n) => `om_x100b${String(n).padStart(25, '0')}`
      const gateway = [`[lark-gateway] ${id(1)} 回「收到」（classified，固定句）：请求失败（可能已送达，不重试）：ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR`, `[lark-gateway] repo ack ${id(9)} webhook attempt 1/3 failed: 连接失败`].join('\n')
      const worker = [
        `[lark-worker] classifying task-mention ${id(2)} via claude`, // 排空前到、排空后才领 → 算
        `[lark-worker] claimed ${id(3)} via claude: 早领的`, // 先领后排空 → 在飞照跑，不算
        '[lark-worker] 排空重启：磁盘代码已更新（进程 a → 磁盘 b），不再领新任务，在飞 1 个跑完即重启',
        `[lark-worker] routing ${id(3)} → x`, `[lark-worker] classifying task-mention ${id(4)} via claude`, // 排空中到 → 算
        '[lark-worker] 排空重启：测试红，不重启。',
        `[lark-worker] claimed ${id(2)} via claude: 等排空`, `[lark-worker] classifying task-mention ${id(5)} via claude`,
      ].join('\n')
      const down = parseFaliveDown({ gateway, worker })
      assert.deepEqual([...down.keys()].sort(), [id(1), id(2), id(4)])
      assert.match(down.get(id(1)), /没发出去（请求失败：ERR_SSL/)
      assert.deepEqual(faliveAnchorsOf(['负责人私聊（recent）→ 指示任务 om_a，针对 retest-falive-20261027-0413（done）：已部署', '锚定：om_a 接着 om_b（主题 x）']), ['retest-falive-20261027-0413', 'om_b'])

      const m = msg(id(10), T0, 'oc_hook', { chatKey: 'webhook-group', senderId: AVEN, text: '已部署' })
      const peer = msg(id(11), T0 + 60_000, 'oc_hook', { chatKey: 'webhook-group', senderId: AVEN, senderType: 'user', text: '已发布' })
      const data = {
        tags: new Map([[id(12), { kind: 'verification' }]]), evidence: new Map([[id(12), { env: ['pre'], envDownThen: true, match: 'strong' }]]), caseIds: new Set([m.id, peer.id, id(12)]),
        baselines: new Map([[m.id, { baseline: { routing: ['负责人私聊（recent）→ 指示任务 x，针对 retest-falive-20261027-0413（done）：已部署'] } }], [id(13), { baseline: { audit: { finalSummary: '账号来源：bug 表 Bug-4970 备注（~/.lark-bugpoll/snapshot.json）' } } }]]),
        timeline: [{ ...m, senderType: 'user' }, peer],
      }
      const sim = { tasks: new Map(), fed: [m.id, peer.id] }
      const src = { editDelays: new Map([[m.id, 8200]]), faliveDown: new Map([[m.id, 'falive 的「收到」当时没发出去（ERR_SSL）']]) }
      const flags = (x, extra = {}) => simLimitsOf({ m: x, sim, data, src, ...extra }).map((f) => f.flag)
      assert.deepEqual(flags(m), ['sim_limit_anchor', 'sim_limit_edited', 'sim_limit_timing', 'sim_limit_falive_down'])
      assert.match(simLimitsOf({ m, sim, data, src })[0].why, /retest-falive-20261027-0413/)
      // 锚的任务模拟里有 → 不算；「已部署」没锚点、12 小时内 lark-bot 有任务 → 不算，没有 → 算
      assert.ok(!flags(m, { sim: { tasks: new Map([['retest-falive-20261027-0413', {}]]), fed: [] } }).includes('sim_limit_anchor'))
      const bare = msg(id(14), T0, 'oc_hook', { chatKey: 'webhook-group', text: '已部署' })
      assert.deepEqual(flags(bare), ['sim_limit_anchor'])
      assert.deepEqual(flags(bare, { sim: { tasks: new Map([['t', { id: 't', createdAt: new Date(T0 - 3600_000).toISOString() }]]), fed: [] } }), [])
      assert.deepEqual(flags(msg(id(15), T0, 'oc_hook', { chatKey: 'webhook-group', text: '推 pre' })), ['sim_limit_anchor'])
      assert.deepEqual(flags(msg(id(16), T0, 'oc_hook', { chatKey: 'webhook-group', text: `继续任务 ${id(17)} 做` })), ['sim_limit_ref'])
      assert.deepEqual(flags(msg(id(12), T0, 'oc_php', { text: '测一下' })), ['sim_limit_verify'])
      assert.match(simLimitsOf({ m: msg(id(12), T0), sim, data, src })[0].why, /pre，当时环境挂了，关联 strong/)
      assert.deepEqual(flags(msg(id(13), T0, 'oc_php', { text: '复测一下' })), ['sim_limit_memory'])
      assert.deepEqual(flags(msg(id(18), T0, 'oc_php', { text: '看下' }), { lark: { output: '见 ~/.lark-bugpoll/snapshot.json', lines: [] } }), ['sim_limit_memory'])
      assert.deepEqual(flags(msg(id(19), T0, 'oc_php', { text: '普通一句' })), [])
      // 原话明确要造测试数据（b3 ep-1024「创建最新的帖子 进行测试」）：软旗标，判过程
      assert.deepEqual(flags(msg(id(12), T0, 'oc_php', { text: '@Aven.Bot 创建最新的帖子 进行测试' })), ['sim_limit_verify', 'sim_limit_testdata'])
      assert.match(simLimitsOf({ m: msg(id(20), T0, 'oc_php', { text: '写脚本在 pre 造帖' }), sim, data, src })[0].why, /测试号[\s\S]*回放拦了真实写入[\s\S]*判过程/)
      assert.deepEqual(flags(msg(id(21), T0, 'oc_php', { text: '能不能创建帖子' })), [])
    }],

    ['falive 卡引用（旗标 8）：藏了且模拟 bot 没说过卡里事实 → 追问 / 空 @ / 引原句硬、其余软；说过就不算；跟人说的不算；照供的卡只认结束 / 继续任务且那单模拟里没有', () => {
      const id = (n) => `om_x100b${String(n).padStart(25, '0')}`
      const card = { id: id(1), ownBot: true, chatId: 'oc_php', atMs: T0, text: '<card> @Arthur hichat_token 调 GET /api/member/profile/my 返回 401，17:39 复测，存「I\'m QA.」读回 「I\'m QA.」 📝 由 aven 的助手整理 </card>' }
      assert.deepEqual(refFactsOf(card.text).sort(), ['/api/member/profile/my', '17:39', '401', "i'm qa.", 'hichat_token'].sort())
      const shown = { id: id(2), ownBot: true, chatId: 'oc_hook', atMs: T0, text: '✅ 改动在分支 lark/falive-4d5ce277' }
      const data = { timeline: [card, shown], groupById: new Map() }
      const sim = (outbox = []) => ({ meta: { hideBotIds: [card.id] }, outbox, tasks: new Map([['om_x100b0000000000000000000a2a74bb7', {}]]) })
      const ask = (text, extra = {}) => ({ id: id(9), chatId: 'oc_php', chatKey: 'php-group', atMs: T0 + 60_000, atBot: true, mentions: [], text, ...extra })
      const ref = (m, s = sim()) => faliveRefOf({ m, sim: s, data })
      assert.equal(ref(ask('@Aven.Bot 针对这条消息，什么时候调的', { parentId: card.id })).hard, true)
      assert.match(ref(ask('@Aven.Bot', {})).why, /紧挨着的上一张[\s\S]*空 @/)
      assert.equal(ref(ask('存「I\'m QA.」读回来还是一样 @Aven.Bot')).hard, true)
      assert.equal(ref(ask('@Aven.Bot 后端改好了 你再看看', { parentId: card.id })).hard, false)
      assert.equal(ref(ask('@Aven.Bot 后端改好了 你再看看')), null) // 没回复也没在问那张卡
      assert.equal(ref(ask('cc @Kaiser', { parentId: card.id, atBot: false, mentions: [{ id: 'ou_kaiser' }] })), null)
      assert.equal(ref(ask('@Aven.Bot 针对这条消息', { parentId: card.id }), sim([out('om_sim1', T0 + 1000, { text: 'hichat_token 调 /api/member/profile/my 401，17:39' })])), null)
      const end = (text) => faliveRefOf({ m: { id: id(8), chatId: 'oc_hook', chatKey: 'webhook-group', atMs: T0 + 1000, parentId: shown.id, text, mentions: [] }, sim: sim(), data })
      assert.match(end('@Aven.Test 结束这个任务').why, /4d5ce277.*模拟里没有/)
      assert.equal(end('@Aven.Test 好的'), null)
      assert.deepEqual(simLimitsOf({ m: ask('@Aven.Bot', {}), sim: sim(), data: { ...data, tags: new Map() }, src: { editDelays: new Map(), faliveDown: new Map() } }).map((x) => x.flag), ['sim_limit_falive_ref'])
    }],

    ['外部设计源（旗标 9）：blocked 且说读不到 Figma → 硬；只提到 / egress 拦了设计站 → 软；裁判出网证据按方法 + 主机计数、写带路径、拦下标出，只给像是写了东西的 case', () => {
      const blocker = '读不到 Figma 稿 1094-73405：从 bot 这边访问 api.figma.com 被出网限制拦截'
      assert.equal(externalLimitOf({ task: { status: 'blocked', result: blocker } }).hard, true)
      assert.equal(externalLimitOf({ task: { status: 'done', result: blocker } }).hard, false)
      assert.match(externalLimitOf({ egressBlocked: [{ host: 'api.figma.com' }] }).why, /egress 拦了 api\.figma\.com 1 次/)
      assert.equal(externalLimitOf({ lark: { output: '按设计稿改好了', lines: [] }, task: { status: 'blocked' } }), null)
      const ev = egressEvidenceOf([
        { via: 'fetch', method: 'GET', host: 'falivepre.fdsser.com', path: '/a' }, { via: 'fetch', method: 'GET', host: 'falivepre.fdsser.com', path: '/b' },
        { via: 'fetch', method: 'POST', host: 'falivepre.fdsser.com', path: '/api/user/NewMailLogin' },
        { via: 'fetch', method: 'POST', host: 'falivepre.fdsser.com', path: '/bbsv2/thread/create', extra: 'blocked' },
        { via: 'fetch', method: 'POST', host: '127.0.0.1', path: '/lark' }, { via: 'sock', method: 'TCP', host: '1.2.3.4' }, { via: 'fetch', method: 'POST', host: 'www.uniaix.com', path: '/v1/messages' },
      ])
      assert.deepEqual(ev.map((x) => x.line), ['GET falivepre.fdsser.com ×2', 'POST falivepre.fdsser.com /api/user/NewMailLogin ×1', 'POST falivepre.fdsser.com /bbsv2/thread/create（回放拦下，没发出） ×1'])
      assert.equal(egressRelevant({ row: { flags: [], lark: { output: '新建 / 修改时带的介绍存得下' } }, evidence: ev }), true)
      assert.equal(egressRelevant({ row: { flags: [], lark: { output: '接口回 200' } }, evidence: ev }), false)
      assert.equal(egressRelevant({ row: { flags: ['sim_limit_testdata'], lark: { output: '' } }, evidence: [] }), false)
    }],

    ['模拟局限不计分：裁判判 sim_limit，或硬旗标（v2 结论一刀切；v3 看过旗标仍归 bot 且变差的照常计分）；软旗标只听裁判；缓存参照接旗标指纹', () => {
      const v3 = (better, cause) => ({ better, cause, promptVersion: 'judge-v3-1104' })
      assert.equal(simLimitOf({ verdict: v3('falive', 'sim_limit'), flags: [] }), '裁判：差异来自模拟局限')
      assert.match(simLimitOf({ verdict: { better: 'falive', cause: 'bot', promptVersion: 'judge-v2-1104' }, flags: ['sim_limit_edited'] }), /sim_limit_edited/)
      assert.equal(simLimitOf({ verdict: v3('falive', 'bot'), flags: ['sim_limit_anchor'] }), null)
      assert.ok(simLimitOf({ verdict: v3('same', 'n/a'), flags: ['sim_limit_anchor'] }))
      assert.equal(simLimitOf({ verdict: v3('falive', 'bot'), flags: ['sim_limit_verify', 'sim_limit_timing', 'sim_limit_memory', 'sim_limit_falive_ref_soft', 'sim_limit_external_soft'] }), null)
      assert.match(simLimitOf({ verdict: v3('falive', 'env'), flags: ['sim_limit_falive_ref'] }), /sim_limit_falive_ref/)
      assert.match(simLimitOf({ verdict: v3('both_wrong', 'n/a'), flags: ['sim_limit_external'] }), /sim_limit_external/)
      const current = collapseVerdicts([v('lim', 'falive', { risk: ['permission'], cause: 'sim_limit', promptVersion: 'judge-v3-1104' }), v('ref', 'falive', { promptVersion: 'judge-v2-1104' }), v('reg', 'falive', { cause: 'bot', promptVersion: 'judge-v3-1104', flags: ['sim_limit_verify'] })])
      const rules = new Map([['lim', { id: 'lim', lark: { duplicates: 1 } }], ['ref', { id: 'ref', flags: ['sim_limit_ref'], lark: { duplicates: 0 } }], ['reg', { id: 'reg', flags: ['sim_limit_verify'], lark: { duplicates: 0 } }]])
      const r = evaluateAcceptance({ current, rules, total: 285 })
      assert.deepEqual(r.simLimited.map((x) => x.id).sort(), ['lim', 'ref'])
      assert.equal(r.scoredCount, 1)
      assert.deepEqual(r.checks.find((c) => c.key === 'hard-reply').offending, [])
      assert.deepEqual(r.checks.find((c) => c.key === 'explained').offending.map((x) => x.id), ['reg'])
      assert.equal(withLimitsRef('none', []), 'none')
      assert.match(withLimitsRef('none', [{ flag: 'sim_limit_edited', why: 'a' }]), /^none\|lim:[0-9a-f]{10}$/)
      assert.notEqual(withLimitsRef('none', [{ flag: 'sim_limit_edited', why: 'a' }]), withLimitsRef('none', [{ flag: 'sim_limit_edited', why: 'b' }]))
    }],
  ]))
})
