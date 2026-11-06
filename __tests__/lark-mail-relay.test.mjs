import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { exemptReason } from '../lib/lark-chat-retention.mjs'
import { validateConfig } from '../lib/lark-config.mjs'
import { startConsumer } from '../lib/lark-consumer.mjs'
import { headlinePostContent } from '../lib/lark-cli.mjs'
import { classifyOlKind, hasOlSubject, renderOlScore, scoreOlMail } from '../lib/lark-mail-ol-score.mjs'
import { RELAY_ALERT_AFTER_FAILURES, RELAY_POLL_MS, RELAY_POLL_OVERLAP_MS, catchUpRelay, createFailureAlarm, relayAlertSettings, relayFailureText, createRelayCli, createRelayHandler, fileRelayIo, mailFromWatchLine, pickRoute, relayPollMs, startMailRelay } from '../lib/lark-mail-relay.mjs'
import { forwardMail, renderRelayNote } from '../lib/lark-mail-relay-forward.mjs'
import { getScorer } from '../lib/lark-mail-relay-presets.mjs'
import { addressOf, matchRoute, normalizeRoutes, relayChatIds, routeMatches, validateMailRelay } from '../lib/lark-mail-relay-routes.mjs'
import { mailRelayPackageSteps } from './support/mail-relay-package-steps.mjs'
import { eachCase, runSteps } from './support/steps.mjs'

// 审批邮件转群（aven 11-02）：OL 上线评分口径（docs/notes/mail-ol-scoring-2026-11-02.md）+ 通用路由 / 转发 / 引擎 / 拆分接口。
// 正文样本按 11-02 拉的 100 封 OL 邮件里的真实写法缩写。
const FULL_BODY = [
  'Hi，尊敬的客户您好： 本次已通过测试验收，请安排以下更新，谢谢。 一、环境 ONLINE',
  '二、更新内容 类型 功能或者需求描述 开发者 需求 【TR-02647】Banner图删除修改为软删除 @Alec',
  '三、上线参与人及职责 验收角色 负责人 验收范围 在线状态 验收结论时限 QA 验收 @Alec 核心功能 已确认在线 OPS 通知更新完成后 60 分钟内',
  '四、服务版本信息 服务名称 发布版本 TAG 可回滚版本 TAG operate-web PROD-007e6c0bdfc7532700c9 PROD-263a7bc67a89228494b2',
  '五、后端服务更新 / 操作步骤执行 SQL 六、回滚方式服务回滚 七、线上验收 Checklist 八、注意事项 无 九、附件清单 TR-02647-OL.sql',
].join(' ')
const STD_TO = [{ mail_address: 'sysops@hqstech.com' }]
const STD_CC = [{ mail_address: 'devcto@mail.fameex.info' }, { mail_address: 'qa@globaldev.info' }]
const STD_SUBJECT = '【HQEX】【CHAINUP】【ONLINE】【TR-02647】【现货后台】Banner图删除修改为软删除【20261023】'
const OL_RELAY = { enabled: true, routes: [{ id: 'ol', preset: 'ol-release', chatId: 'oc_ol' }] }
const WL_ROUTE = { id: 'wl', label: '加白名单审批', chatId: 'oc_wl', match: { subject: ['白名单'], subjectNot: ['撤销'], from: ['@hqstech.com', 'boss@x.com'], to: ['sysops@hqstech.com'] } }
const [OL] = normalizeRoutes(OL_RELAY)
const [WL] = normalizeRoutes({ routes: [WL_ROUTE] })
const mailOut = (data) => ({ code: 0, stdout: JSON.stringify({ ok: true, data }), stderr: '' })
const fakeRun = (results) => {
  const calls = []
  return { calls, run: async (args, options) => { calls.push({ args, identity: options?.identity || 'bot', env: options?.env }); return results[Math.min(calls.length, results.length) - 1] } }
}
const memIo = (initial = { checkedAt: null, forwarded: {} }) => {
  let state = JSON.parse(JSON.stringify(initial))
  return { read: () => JSON.parse(JSON.stringify(state)), write: (next) => { state = JSON.parse(JSON.stringify(next)) } }
}
const OL_EVENT = { message_id: 'm1', folder_id: 'INBOX', subject: STD_SUBJECT }
const quiet = async (fn) => {
  const original = [console.log, console.warn, console.error]
  console.log = console.warn = console.error = () => {}
  try {
    return await fn()
  } finally {
    ;[console.log, console.warn, console.error] = original
  }
}

describe('审批邮件转群：OL 评分、路由、转发、引擎、拆分接口、独立包', () => {
  it('预设与评分、路由匹配与校验、转发、台账与补转、网关 / 独立进程接线', () => runSteps([
    ['ol-release 预设：只认 OL 申请首封——回复 / 转发 / 非 OL 环境 / 有 in_reply_to 都不认', () => {
      for (const subject of [STD_SUBJECT, '【HQEX】【CHAINUP】【OL环境】生产环境 撮合 重启【20261027】', '【嗨聊】OL環境-申請上線 v6.10.3', '【HQEX】【CHAINUP】【ol】【需求】x【20261018】', '【20261031】【B2B_直播中心】【Falive 直播站】【OL环境 HQUC-AWS-JP-OL-falive-core01】 x']) {
        assert.equal(routeMatches(OL, { subject }), true, subject)
      }
      for (const subject of [`Re: ${STD_SUBJECT}`, `回覆：${STD_SUBJECT}`, '【20261029】【Falive 直播站】【PRE环境】 同步更新 uat/online 的 baseUrl', 'TOOL 升级【20261102】', '【HQEX】【PRE】x']) {
        assert.equal(routeMatches(OL, { subject }), false, subject)
      }
      assert.equal(routeMatches(OL, { subject: STD_SUBJECT, in_reply_to: '<abc@x>' }), false)
      assert.deepEqual([hasOlSubject(undefined), hasOlSubject('【OL】x')], [false, true])
      assert.deepEqual([OL.label, OL.scorer, OL.reply], ['OL 上线申请', 'ol-release', true])
    }],
    ['OL 评分：9 段模板 + 规范主题 + 正确收件 = 16/16 A 档；说明逐组打勾', () => {
      const result = scoreOlMail({ subject: STD_SUBJECT, body: FULL_BODY, to: STD_TO, cc: STD_CC })
      assert.deepEqual([result.score, result.max, result.tier, result.kind, result.riskNoRollback], [16, 16, 'A', 'hqex', false])
      const text = renderOlScore(result, { sender: 'Alec', subject: STD_SUBJECT })
      assert.match(text, /^\*\*OL 上线申请规范度：16\/16（A 档 · 标准）\*\* · 发件人 Alec/)
      assert.match(text, /- 主题 3\/3 ✓\n- 正文 10\/10 ✓\n- 收件 3\/3 ✓/)
      assert.equal(getScorer('ol-release').render(getScorer('ol-release').score({ subject: STD_SUBJECT, body: FULL_BODY, to: STD_TO, cc: STD_CC }), { sender: 'Alec', subject: STD_SUBJECT }), text)
      assert.deepEqual([getScorer(null), getScorer('nope')], [null, null])
    }],
    ['OL 档位边界：14 → A、13 → B、12 → B、11 → C、8 → D', () => {
      const cut = (body) => scoreOlMail({ subject: STD_SUBJECT, body, to: STD_TO, cc: STD_CC })
      const noTail = FULL_BODY.replace(/七、线上验收 Checklist 八、注意事项 无 九、附件清单 TR-02647-OL.sql/, '')
      assert.deepEqual([cut(noTail).score, cut(noTail).tier], [13, 'B'])
      const s14 = scoreOlMail({ subject: STD_SUBJECT.replace('【20261023】', '【202601023】').replace('【TR-02647】', ''), body: FULL_BODY, to: STD_TO, cc: STD_CC })
      assert.deepEqual([s14.score, s14.tier], [14, 'A'])
      const s12 = scoreOlMail({ subject: STD_SUBJECT, body: noTail, to: [{ mail_address: 'hurley@krquant.com' }], cc: STD_CC })
      assert.deepEqual([s12.score, s12.tier], [12, 'B'])
      const s11 = scoreOlMail({ subject: STD_SUBJECT, body: noTail.replace(/PROD-\w+/g, 'v1'), to: [], cc: STD_CC })
      assert.deepEqual([s11.score, s11.tier], [11, 'C'])
      const s8 = scoreOlMail({ subject: STD_SUBJECT, body: '一、环境 ONLINE 请执行附件 sql', to: STD_TO, cc: STD_CC })
      assert.deepEqual([s8.score, s8.tier], [8, 'D'])
    }],
    ['OL 缺项说明：9 位日期点出原文、高风险无回滚单列、运维类注明模板不适用；回复首句不吃正文；两段条件缺一不给分', () => {
      const subject = '【HQEX】【CHAINUP】【OL环境】生产环境 撮合 重启【202601027】'
      const result = scoreOlMail({ subject, body: 'Hi, OPS 本邮件需要审批 重启前，请帮先删除 raft 目录', to: STD_TO, cc: [] })
      assert.equal(result.kind, 'ops')
      assert.equal(result.riskNoRollback, true)
      const text = renderOlScore(result, { subject })
      assert.match(text, /类别：运维操作单/)
      assert.deepEqual([result.max, result.tier], [16, 'D'], '撮合重启没有样本：仍按 9 段模板')
      // 11-04 Rou：补 K 线按往常格式写就算 A、bryn / Brad 发的是 A 档范本。规则从收件箱 23 封 OL 补 K 线首封归纳（旧口径 bryn 原件 7/16 D）
      const kline = '【HQEX】【CHAINUP】【OL】 合约部分币对补K线 (数据源 20261030)【20261103】'
      const direct = '在ONLINE环境： PS： 单个命令执行耗时大概10-20分钟。需要确定执行成功。 服务器名称： chainup-gcp-ol-futures-chmatch-new09 git仓库位置： fcex-go/kline-migrate.git 分支/tag： v3.0 执行操作如下： cd kline-migrate && chmod a+x ./kline-migrate 1. 修 2个 nohup ./kline-migrate -runenv=prod > kline_migrate_prod.log 2>&1 &'
      const batch = '在ONLINE环境： PS： 命令执行耗时大概 30-60 分钟。需要观察 确定命令已执行完。 服务器名称： chainup-gcp-ol-futures-chmatch-new09 git仓库位置： fcex-go/kline-migrate.git 分支/tag： v3.0 1. 执行前检查程序并赋予脚本执行权限： chmod +x ./repair_kline_batch_0905.sh 2. 后台启动真实修复： nohup env DRY_RUN=0 ./repair_kline_batch_0905.sh --all & 3. 查看本次新生成的日志 断开终端前，确认本次日志已出现: SUMMARY ... failed=0 exit_code=0'
      const spot = '操作步骤 在ONLINE环境 Spot-kline-online 的 terminal 执行请求 1. 执行修复提交 nohup env DRY_RUN=0 ./repair_spot_kline_batch_1013.sh & 2. 看进度和结果 执行阶段成功判断 日志出现 SUMMARY，其中 exit_code=0'
      const spotCurl = '在ONLINE环境 Spot-kline-online 的 terminal 执行 http 请求 1. 修 1 个 curl --location \'127.0.0.1:8080/v1/repairKline\''
      const k = (body, subject = kline) => scoreOlMail({ subject, body, to: STD_TO, cc: STD_CC })
      const spotSubject = '【HQEX】【CHAINUP】【ONLINE】现货部分币对补K线 (数据源20261101-1102) 【20261102】'
      const brad = '【HQEX】【chainup】【OL】 合约修补所有币对K线（数据源从04-13 1点起 ）【2026-04-13】'
      const pick = (r) => [r.score, r.max, r.tier, r.kind]
      assert.deepEqual([k(direct), k(batch), k(spot, spotSubject), k(spotCurl, spotSubject), k(direct, brad)].map(pick), [[9, 9, 'A', 'kline'], [9, 9, 'A', 'kline'], [9, 9, 'A', 'kline'], [8, 9, 'A', 'kline'], [8, 9, 'A', 'kline']], '合约直接命令 / 批处理 / 现货 terminal 满分；只贴 curl、Brad「修补」+ 横线日期各缺 1 仍 A')
      assert.match(renderOlScore(k(direct), { subject: kline }), /类别：补 K 线申请[\s\S]*- 主题 3\/3 ✓\n- 正文 3\/3 ✓\n- 收件 3\/3 ✓\n评分口径：补 K 线格式 主题 3 \+ 正文 3 \+ 收件 3，共 9 项；≥8 标准/)
      assert.deepEqual([k(direct.replace(/PS：.*?成功。/, ''), kline.replace(' (数据源 20261030)', '')).tier, k('在ONLINE环境 请执行补 K 线').tier, scoreOlMail({ subject: kline, body: '请执行' }).tier], ['B', 'C', 'D'], '缺 2 → B；正文全无、主题收件齐 6 → C；收件也没有 → D')
      assert.match(text, /⚠️ 含 SQL \/ redis \/ 重启 \/ 删数据类操作，但没写回滚方式/)
      assert.match(text, /结尾 8 位日期【YYYYMMDD】（现在写的是【202601027】）/)
      assert.match(renderOlScore(scoreOlMail({ subject: '【HQEX】【ONLINE】x', body: '' }), { subject: '【HQEX】【ONLINE】x' }), /（没写日期）/)
      const quoted = scoreOlMail({ subject: `Re: ${STD_SUBJECT}`, body: `进行 Alec <a@x> 于2026年10月23日周五 16:14写道： ${FULL_BODY}`, to: STD_TO, cc: STD_CC })
      assert.equal(quoted.score, 16, '回复里引用的原申请照样按原文打分')
      assert.deepEqual(['falive', 'hichat', 'kline', 'ops', 'hqex'], ['【Falive 直播站】', '【嗨聊】', '补K线', '撮合 重启', '【HQEX】'].map(classifyOlKind))
      const ok = (body, key) => scoreOlMail({ subject: STD_SUBJECT, body }).items.find((item) => item.key === key).ok
      assert.deepEqual([ok('更新内容 类型 描述', 'bodyContent'), ok('开发者 @a', 'bodyContent'), ok('更新内容 开发者 @a', 'bodyContent')], [false, false, true])
      assert.deepEqual([ok('上线参与人及职责 负责人', 'bodyPeople'), ok('QA 验收 @a', 'bodyPeople'), ok('上线参与人及职责 QA 验收 @a', 'bodyPeople')], [false, false, true])
      assert.deepEqual([ok('已确认在线', 'bodyOnline'), ok('验收结论时限', 'bodyOnline'), ok('已确认在线 验收结论时限', 'bodyOnline')], [false, false, true])
    }],
    ['自定义路由（加白名单）：主题正则 + 排除词 + 发件域名 / 精确地址 + 收件含抄送；部分字段先放行；按顺序取第一条；关掉的不收', () => {
      const base = { subject: '【HQEX】申请加白名单 IP', head_from: { mail_address: 'Ops@HQSTECH.com' }, to: [{ mail_address: 'a@x.com' }], cc: [{ mail_address: 'sysops@hqstech.com' }] }
      assert.equal(routeMatches(WL, base), true)
      assert.equal(routeMatches(WL, { ...base, subject: '撤销白名单' }), false, '排除词')
      assert.equal(routeMatches(WL, { ...base, subject: '上线申请' }), false, '主题不中')
      assert.equal(routeMatches(WL, { ...base, head_from: { mail_address: 'boss@x.com' } }), true, '精确地址')
      assert.equal(routeMatches(WL, { ...base, head_from: { mail_address: 'other@evil.com' } }), false, '发件不在名单')
      assert.equal(routeMatches(WL, { ...base, cc: [] }), false, '收件 / 抄送都没有 sysops')
      assert.equal(routeMatches(WL, { ...base, subject: `Re: ${base.subject}` }), false, '默认只转首封')
      assert.equal(routeMatches(normalizeRoutes({ routes: [{ ...WL_ROUTE, match: { ...WL_ROUTE.match, firstOnly: false } }] })[0], { ...base, subject: `Re: ${base.subject}` }), true)
      assert.equal(routeMatches(WL, { subject: base.subject, from: 'Ops <ops@hqstech.com>', to: [] }, { partial: true }), true, '+triage 没有抄送：先放行')
      assert.equal(routeMatches(WL, { subject: base.subject, to: [] }, { partial: true }), true, '没有发件人：先放行')
      assert.equal(routeMatches(WL, { subject: base.subject, from: 'x <x@evil.com>', to: [] }, { partial: true }), false, '有发件人就照判')
      assert.equal(routeMatches(WL, { subject: base.subject, to: [] }), false, '全字段时缺发件人不放行')
      assert.equal(routeMatches(WL, { ...base, cc: undefined }), false, '全字段时没有抄送也照判收件')
      assert.equal(routeMatches(WL, { ...base, to: [{ mail_address: 'x@y.com' }], cc: [{ mail_address: 'z@y.com' }] }, { partial: true }), false, '部分字段但有抄送就照判')
      assert.deepEqual([addressOf('A <A@B.com>'), addressOf('a@b.com'), addressOf({ mail_address: 'X@Y' }), addressOf(null)], ['a@b.com', 'a@b.com', 'x@y', ''])
      const routes = normalizeRoutes({ routes: [{ ...WL_ROUTE, id: 'off', enabled: false }, WL_ROUTE, { ...WL_ROUTE, id: 'second', chatId: 'oc_2' }] })
      assert.deepEqual(routes.map((route) => route.id), ['wl', 'second'])
      assert.equal(matchRoute(routes, base).id, 'wl')
      assert.equal(matchRoute(routes, { subject: 'x' }), null)
      const overridden = normalizeRoutes({ routes: [{ id: 'ol2', preset: 'ol-release', chatId: 'oc', label: '上线', scorer: null, reply: false, match: { subject: ['CHAINUP'] } }] })[0]
      assert.deepEqual([overridden.label, overridden.scorer, overridden.reply], ['上线', null, false])
      assert.equal(routeMatches(overridden, { subject: STD_SUBJECT }), true)
      assert.equal(routeMatches(overridden, { subject: '【HQEX】【SPOT】【ONLINE】x' }), false, '配置的 subject 和预设的 OL 判定是「且」')
      assert.deepEqual([WL.label, WL.scorer, normalizeRoutes({ routes: [{ id: 'bare', chatId: 'oc', match: { subject: ['x'] } }] })[0].label], ['加白名单审批', null, 'bare'])
      assert.deepEqual(normalizeRoutes({}), [])
      assert.deepEqual(relayChatIds({ enabled: true, routes: [WL_ROUTE, { ...WL_ROUTE, id: 'off', chatId: 'oc_off', enabled: false }] }), ['oc_wl'])
      assert.deepEqual(relayChatIds({ enabled: false, routes: [WL_ROUTE] }), [])
    }],
    ['配置校验：形状、路由 id 唯一、chatId、预设 / 评分器名、match 各字段与正则、没有任何匹配条件拒收；接进 validateConfig；转发群不自动退群', () => {
      const errorsOf = (relay) => validateMailRelay(relay)
      assert.deepEqual(errorsOf(undefined), [])
      assert.deepEqual(errorsOf([]), ['mailRelay 必须是对象 { enabled, routes: [...], mode?, pollMs?, alert?, cliConfigDir?, stateFile? }'])
      assert.deepEqual(errorsOf(OL_RELAY), [])
      assert.deepEqual(errorsOf({ enabled: 'y', cliConfigDir: '', stateFile: 3, routes: {} }), ['mailRelay.enabled 必须是 true / false', 'mailRelay.cliConfigDir 必须是非空路径字符串', 'mailRelay.stateFile 必须是非空路径字符串', 'mailRelay.routes 必须是数组'])
      const errors = errorsOf({ routes: [
        null,
        { preset: 'ol-release', chatId: 'oc_a' },
        [],
        { id: 'a', preset: 'ol-release', chatId: 'oc_a' },
        { id: 'a', preset: 'ol-release', chatId: 'oc_a' },
        { id: 'b', preset: 'nope', scorer: 'nope', chatId: 'ou_x', enabled: 'y', match: [] },
        { id: 'c', chatId: 'oc_c', match: { subject: ['('], subjectNot: [''], from: 'x', firstOnly: 'y' } },
        { id: 'd', chatId: 'oc_d', match: {} },
        { id: 'e', enabled: false },
        { id: 'f', chatId: 'oc_f', match: { from: ['@a.com'] } },
        { id: 'g', chatId: 'oc_g', match: { to: ['a@b.com'] } },
      ] })
      assert.deepEqual(errors, [
        'mailRelay.routes[0] 必须是对象',
        'mailRelay.routes[1].id 必须是非空字符串',
        'mailRelay.routes[2] 必须是对象',
        'mailRelay.routes[4].id 重复：a',
        'mailRelay.routes[5].enabled 必须是 true / false',
        'mailRelay.routes[5].chatId 必须是群 chat_id（oc_ 开头）',
        'mailRelay.routes[5].preset 不认识：nope（可选：ol-release）',
        'mailRelay.routes[5].scorer 不认识：nope（可选：ol-release，不评分写 null）',
        'mailRelay.routes[5].match 必须是对象',
        'mailRelay.routes[6].match.subject 正则写错了：(',
        'mailRelay.routes[6].match.subjectNot 必须是字符串数组',
        'mailRelay.routes[6].match.from 必须是字符串数组',
        'mailRelay.routes[6].match.firstOnly 必须是 true / false',
        'mailRelay.routes[7] 没有预设也没写 match（subject / from / to 至少一项），会把所有邮件都转出去',
      ])
      assert.ok(validateConfig({ project: 'PR-01947', mailRelay: [] }).errors.includes('mailRelay 必须是对象 { enabled, routes: [...], mode?, pollMs?, alert?, cliConfigDir?, stateFile? }'))
      assert.ok(!validateConfig({ project: 'PR-01947', mailRelay: OL_RELAY }).errors.some((e) => /mailRelay/.test(e)))
      const state = { chats: {} }
      assert.equal(exemptReason({ config: { mailRelay: OL_RELAY }, state, chatId: 'oc_ol' }), '审批邮件转发群')
      assert.equal(exemptReason({ config: { mailRelay: { ...OL_RELAY, enabled: false } }, state, chatId: 'oc_ol' }), null)
    }],
    ['转发：user 读信 → 按路由复核 → user 分享卡片 → bot 回卡片（卡片 id 取 data.im_message_id）', async () => {
      const { calls, run } = fakeRun([
        mailOut({ subject: STD_SUBJECT, body_plain_text: FULL_BODY, to: STD_TO, cc: STD_CC, head_from: { name: 'Alec' } }),
        mailOut({ card_id: 'c1', im_message_id: 'om_card' }),
        mailOut({ message_id: 'om_score' }),
      ])
      const outcome = await quiet(() => forwardMail({ messageId: 'm1', route: OL, run }))
      assert.deepEqual([outcome.ok, outcome.route, outcome.cardMessageId, outcome.scoreMessageId, outcome.scoreVia, outcome.result.score], [true, 'ol', 'om_card', 'om_score', 'bot-reply', 16])
      assert.deepEqual(calls.map((call) => [call.identity, call.args[0], call.args[1]]), [['user', 'mail', '+message'], ['user', 'mail', '+share-to-chat'], ['bot', 'im', '+messages-reply']])
      assert.deepEqual(calls[1].args.slice(2, 6), ['--message-id', 'm1', '--receive-id', 'oc_ol'])
      assert.equal(calls[2].args[calls[2].args.indexOf('--message-id') + 1], 'om_card')
      assert.equal(calls[2].args.includes('--markdown'), false)
      assert.equal(calls[2].args[calls[2].args.indexOf('--msg-type') + 1], 'post')
      const rows = JSON.parse(calls[2].args[calls[2].args.indexOf('--content') + 1]).zh_cn.content
      assert.deepEqual(rows[0], [{ tag: 'text', text: 'OL 上线申请规范度：16/16（A 档 · 标准） · 发件人 Alec', style: ['bold'] }], '首行进 text 段、去掉 **：话题收起时摘要只取 text 段')
      assert.equal(rows[1][0].tag, 'md')
      assert.match(rows[1][0].text, /^- 主题 3\/3 ✓/)
      assert.deepEqual(JSON.parse(headlinePostContent('**只有一行**')).zh_cn.content, [[{ tag: 'text', text: '只有一行', style: ['bold'] }]])
    }],
    ['转发：没评分器只标类别；reply:false 只分享不回；不符合路由不发；读信 / 分享失败如实返回；dryRun 只出说明；force 跳过复核', async () => {
      const wlMail = { subject: '申请加白名单', body_plain_text: 'x', head_from: { name: 'Ops', mail_address: 'ops@hqstech.com' }, to: STD_TO }
      assert.deepEqual(renderRelayNote({ route: WL, mail: wlMail }), { result: null, markdown: '**加白名单审批** · 发件人 Ops' })
      assert.equal(renderRelayNote({ route: WL, mail: { subject: 'x' } }).markdown, '**加白名单审批**')
      assert.match(renderRelayNote({ route: OL, mail: { subject: STD_SUBJECT, body_preview: FULL_BODY, to: STD_TO, cc: STD_CC, head_from: { mail_address: 'a@x.com' } } }).markdown, /16\/16.*· 发件人 a@x\.com/)
      const silent = fakeRun([mailOut(wlMail), mailOut({ im_message_id: 'om_c' })])
      const quietRoute = { ...WL, reply: false }
      assert.deepEqual(await forwardMail({ messageId: 'w', route: quietRoute, run: silent.run }), { ok: true, subject: '申请加白名单', route: 'wl', result: null, cardMessageId: 'om_c', scoreVia: 'none' })
      assert.equal(silent.calls.length, 2)
      const reply = fakeRun([mailOut({ subject: `Re: ${STD_SUBJECT}`, body_plain_text: '进行' })])
      assert.deepEqual(await forwardMail({ messageId: 'm', route: OL, run: reply.run }), { ok: false, step: 'filter', reason: `不符合路由 ol：Re: ${STD_SUBJECT}` })
      assert.equal(reply.calls.length, 1)
      const forced = fakeRun([mailOut({ subject: `Re: ${STD_SUBJECT}`, body_plain_text: '进行' })])
      assert.equal((await forwardMail({ messageId: 'm', route: OL, force: true, dryRun: true, run: forced.run })).dryRun, true)
      const readFail = fakeRun([{ code: 1, stdout: '{"ok":false,"error":{"message":"missing scope"}}', stderr: '' }])
      assert.equal((await forwardMail({ messageId: 'm', route: OL, run: readFail.run })).step, 'read')
      const noData = fakeRun([{ code: 0, stdout: '{"ok":true}', stderr: '' }])
      assert.deepEqual(await forwardMail({ messageId: 'm', route: OL, run: noData.run }), { ok: false, step: 'read', reason: '{"ok":true}' })
      const shareFail = fakeRun([mailOut({ subject: STD_SUBJECT, body_plain_text: FULL_BODY }), { code: 1, stdout: '', stderr: 'no permission' }])
      assert.deepEqual(await forwardMail({ messageId: 'm', route: OL, run: shareFail.run }), { ok: false, step: 'share', reason: 'no permission' })
      const dry = fakeRun([mailOut({ subject: STD_SUBJECT, body_plain_text: FULL_BODY })])
      const preview = await forwardMail({ messageId: 'm', route: OL, dryRun: true, run: dry.run })
      assert.deepEqual([preview.ok, preview.route, preview.result.score, dry.calls.length], [true, 'ol', 13, 1], '没给收件人：收件 3 项全扣')
    }],
    ['引擎：+watch 行解析、只处理 INBOX 命中路由的、转过的不再转、并发同一封只转一次、台账记路由', async () => {
      assert.deepEqual([mailFromWatchLine({ message: OL_EVENT }), mailFromWatchLine({ ok: true, data: { message: OL_EVENT } }), mailFromWatchLine({ header: {} })], [OL_EVENT, OL_EVENT, null])
      const routes = [OL, WL]
      assert.deepEqual([
        pickRoute({ routes, mail: OL_EVENT, forwarded: {} })?.id,
        pickRoute({ routes, mail: { ...OL_EVENT, folder_id: undefined }, forwarded: {} })?.id,
        pickRoute({ routes, mail: { message_id: 'w', subject: '加白名单', to: [] }, forwarded: {} })?.id,
        pickRoute({ routes, mail: { ...OL_EVENT, folder_id: 'SENT' }, forwarded: {} }),
        pickRoute({ routes, mail: { ...OL_EVENT, subject: '【HQEX】【PRE】x' }, forwarded: {} }),
        pickRoute({ routes, mail: OL_EVENT, forwarded: { m1: { at: 'x' } } }),
        pickRoute({ routes, mail: { ...OL_EVENT, message_id: '' }, forwarded: {} }),
      ], ['ol', 'ol', 'wl', null, null, null, null])
      const io = memIo()
      const calls = []
      const forward = async ({ messageId, route, run }) => { calls.push([messageId, route.id, typeof run]); return { ok: true, result: { score: 16, max: 16, tier: 'A' }, scoreVia: 'bot-reply' } }
      const handler = createRelayHandler({ routes, io, forward, now: () => 'T1' })
      await quiet(() => Promise.all([handler.handle(OL_EVENT), handler.handle(OL_EVENT)]))
      await quiet(() => handler.handle(OL_EVENT))
      await quiet(() => createRelayHandler({ routes, io, forward: async () => ({ ok: true, scoreVia: 'none' }), now: () => 'T2' }).handle({ message_id: 'w', subject: '加白名单', to: [] }))
      assert.deepEqual(calls, [['m1', 'ol', 'function']])
      assert.deepEqual(io.read().forwarded, { m1: { at: 'T1', route: 'ol', ok: true, score: 16, tier: 'A' }, w: { at: 'T2', route: 'wl', ok: true } })
    }],
    ['引擎：读信 / 分享失败不记台账（重投或重启还能补）、不符合路由与评分发送失败记下不重读、抛错不打断后续、台账只留 500 条', async () => {
      const io = memIo()
      const outcomes = { a: { ok: false, step: 'read', reason: '429' }, b: { ok: false, step: 'filter', reason: 'Re' }, c: { ok: false, step: 'score', reason: 'x' } }
      const forward = async ({ messageId }) => { if (messageId === 'd') throw new Error('boom'); return outcomes[messageId] }
      const handler = createRelayHandler({ routes: [OL], io, forward, now: () => 'T' })
      for (const id of ['a', 'b', 'c', 'd']) await quiet(() => handler.handle({ ...OL_EVENT, message_id: id }))
      assert.deepEqual(io.read().forwarded, { b: { at: 'T', route: 'ol', ok: false, step: 'filter' }, c: { at: 'T', route: 'ol', ok: false, step: 'score' } })
      const many = memIo({ checkedAt: null, forwarded: Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`old${i}`, { at: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}` }])) })
      await quiet(() => createRelayHandler({ routes: [OL], io: many, forward: async () => ({ ok: true, result: { score: 1, tier: 'D' } }), now: () => '2026-11-02T00:00:00' }).handle(OL_EVENT))
      assert.equal(Object.keys(many.read().forwarded).length, 500, '台账只留最近 500 条')
      assert.ok(many.read().forwarded.m1)
    }],
    ['拉收件箱（启动补转 / 定时拉）：首次启用只落时钟不回填；之后只转上次拉成功之后到达的（同一时刻不算）、overlapMs 往前多看；读失败如实返回且不推时钟', async () => {
      const first = memIo()
      const handled = []
      const handler = { handle: async (mail) => handled.push(mail.message_id) }
      assert.deepEqual(await catchUpRelay({ handler, io: first, run: async () => { throw new Error('不该读') }, now: () => '2026-11-02T10:00:00Z' }), { skipped: 'first-run' })
      assert.equal(first.read().checkedAt, '2026-11-02T10:00:00Z')
      const later = memIo({ checkedAt: '2026-11-02T10:00:00Z', forwarded: {} })
      const calls = []
      const run = async (args, options) => { calls.push([args, options]); return { code: 0, stdout: JSON.stringify({ messages: [{ message_id: 'new2', date: '2026-11-02T12:00:00Z' }, { message_id: 'new1', date: '2026-11-02T11:00:00Z' }, { message_id: 'same', date: '2026-11-02T10:00:00Z' }, { message_id: 'old', date: '2026-11-02T09:00:00Z' }, { message_id: 'nodate' }] }), stderr: '' } }
      assert.deepEqual(await catchUpRelay({ handler, io: later, run, now: () => '2026-11-02T13:00:00Z' }), { checked: 2 })
      assert.deepEqual(handled, ['new1', 'new2'], '按到达先后补转，旧的不转')
      assert.equal(calls[0][1].identity, 'user')
      assert.deepEqual(calls[0][0], ['mail', '+triage', '--filter', '{"folder":"INBOX"}', '--max', '100', '--format', 'json'], '补转不限主题：所有路由一起判')
      assert.equal(later.read().checkedAt, '2026-11-02T13:00:00Z')
      const stuck = memIo({ checkedAt: '2026-11-02T10:00:00Z', forwarded: {} })
      assert.deepEqual(await quiet(() => catchUpRelay({ handler, io: stuck, run: async () => ({ code: 1, stdout: '', stderr: 'HTTP 429' }), now: () => '2026-11-02T13:00:00Z' })), { failed: true, error: '退出码 1；HTTP 429' })
      assert.deepEqual(await quiet(() => catchUpRelay({ handler, io: stuck, run: async () => ({ code: 0, stdout: 'not json', stderr: '' }), now: () => '2026-11-02T13:00:00Z' })), { failed: true, error: '返回不是 JSON：not json' })
      assert.equal(stuck.read().checkedAt, '2026-11-02T10:00:00Z', '读失败不推时钟，下一轮接着补')
      handled.length = 0
      const overlap = memIo({ checkedAt: '2026-11-02T12:00:00Z', forwarded: {} })
      assert.deepEqual(await catchUpRelay({ handler, io: overlap, run, now: () => '2026-11-02T13:00:00Z', overlapMs: 90 * 60_000 }), { checked: 2 })
      assert.deepEqual(handled, ['new1', 'new2'], '往前多看 90 分钟：发信时间早于上次拉取的也补（重复的靠台账去重）')
    }],
    ['读收件箱失败的真实原因：结构化 error 优先、stderr 去掉 lark-cli 的 tip 行、带退出码（11-05：15 次失败日志里只剩 tip）', async () => {
      const TIP = 'tip: run "lark-cli mail user_mailboxes profile --params \'{"user_mailbox_id":"me"}\'" to confirm your email identity'
      await eachCase([
        [{ code: 1, stdout: JSON.stringify({ ok: false, error: { type: 'network', subtype: 'transport', message: 'API call failed:\n  dial tcp: lookup open.larksuite.com' } }), stderr: TIP }, '退出码 1；network/transport API call failed: dial tcp: lookup open.larksuite.com'],
        [{ code: 0, stdout: JSON.stringify({ ok: false, error: { type: 'authorization', code: 99991679, message: 'token expired' } }), stderr: `${TIP}\n` }, 'authorization code 99991679 token expired'],
        [{ code: 1, stdout: '', stderr: `[lark-cli] [WARN] uat-client: refresh attempt 1/2 failed\n${TIP}` }, '退出码 1；[lark-cli] [WARN] uat-client: refresh attempt 1/2 failed'],
        [{ code: -1, stdout: '', stderr: '[lark-cli timeout after 60000ms]' }, '退出码 -1；[lark-cli timeout after 60000ms]'],
        [{ code: 1, stdout: '', stderr: TIP }, '退出码 1'],
        [{ code: 1, stdout: '', stderr: `${TIP}\n${JSON.stringify({ ok: false, identity: 'user', error: { type: 'api', subtype: 'unknown', code: 1230008, message: 'API call failed: too many requests, please retry later' } }, null, 2)}` }, '退出码 1；api/unknown code 1230008 API call failed: too many requests, please retry later'],
        [{ code: 0, stdout: '', stderr: '' }, '没有输出'],
        [{}, '没有输出'],
      ], ([result, want]) => assert.equal(relayFailureText(result), want))
      assert.equal(relayFailureText({ code: 1, stderr: 'x'.repeat(900) }).length, 400)
    }],
    ['拉取失败告警：连续满阈值发一次（带最近错误）、之后不重复、告过警才报恢复、没告过的恢复不说话；收件人 alert.openId 优先、阈值缺省 5', () => {
      const alarm = createFailureAlarm({ afterFailures: 3 })
      const at = (m) => new Date(2026, 10, 5, 9, m).toISOString()
      const said = [1, 2, 3, 4].map((m) => alarm.observe({ at: at(m), failed: true, error: `e${m}` }))
      assert.deepEqual(said.slice(0, 2), [null, null])
      assert.equal(said[2], '审批邮件转发：连续 3 次读收件箱失败（09:01 起），新邮件暂时转不进群；恢复后会自动补转这段时间的。\n最近一次错误：e3')
      assert.equal(said[3], null, '告过警不再重复')
      assert.deepEqual(alarm.state(), { count: 4, since: at(1), alerted: true })
      assert.equal(alarm.observe({ at: at(9), checked: 2 }), '审批邮件转发恢复了：09:01 起连续失败 4 次，这段时间的邮件会自动补转。')
      assert.deepEqual(alarm.state(), { count: 0, since: null, alerted: false })
      assert.equal(alarm.observe({ at: at(10), failed: true }), null)
      assert.equal(alarm.observe({ at: at(11), skipped: 'first-run' }), null, '没告过警的恢复不说话')
      assert.equal(createFailureAlarm().observe({ at: at(1), failed: true }), null)
      assert.deepEqual(relayAlertSettings({}, 'ou_me'), { openId: 'ou_me', afterFailures: RELAY_ALERT_AFTER_FAILURES })
      assert.deepEqual(relayAlertSettings({ alert: { openId: 'ou_ops', afterFailures: 3 } }, 'ou_me'), { openId: 'ou_ops', afterFailures: 3 })
      assert.deepEqual(relayAlertSettings({ alert: { afterFailures: 0 } }), { openId: null, afterFailures: 5 })
      assert.deepEqual(validateMailRelay({ ...OL_RELAY, alert: { openId: 'ou_ops', afterFailures: 3 } }), [])
      assert.deepEqual(validateMailRelay({ ...OL_RELAY, alert: [] }), ['mailRelay.alert 必须是对象 { openId?, afterFailures? }'])
      assert.deepEqual(validateMailRelay({ ...OL_RELAY, alert: { openId: 'oc_x', afterFailures: 1.5 } }), ['mailRelay.alert.openId 必须是 open_id（ou_ 开头）', 'mailRelay.alert.afterFailures 必须是正整数'])
    }],
    ['台账文件：读坏 / 字段不对当空表、写后可读、无路径不落盘、写失败不抛；startConsumer 自定义命令与启动器照传', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'mail-relay-'))
      try {
        const path = join(dir, 'state.json')
        assert.deepEqual(fileRelayIo(path).read(), { checkedAt: null, forwarded: {} }, '没有文件')
        writeFileSync(path, 'not json')
        assert.deepEqual(fileRelayIo(path).read(), { checkedAt: null, forwarded: {} }, '读坏了')
        writeFileSync(path, JSON.stringify({ checkedAt: '', forwarded: 'x' }))
        assert.deepEqual(fileRelayIo(path).read(), { checkedAt: null, forwarded: {} }, 'forwarded 不是对象')
        writeFileSync(path, JSON.stringify({ forwarded: null }))
        assert.deepEqual(fileRelayIo(path).read().forwarded, {})
        fileRelayIo(path).write({ checkedAt: 'T', forwarded: { m: { at: 'T' } } })
        assert.deepEqual(fileRelayIo(path).read(), { checkedAt: 'T', forwarded: { m: { at: 'T' } } })
        assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).forwarded, { m: { at: 'T' } })
        fileRelayIo(null).write({ checkedAt: 'x', forwarded: {} })
        await quiet(async () => fileRelayIo(join(path, 'under-a-file', 's.json')).write({ checkedAt: 'x', forwarded: {} }))
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
      const spawned = []
      const spawnChild = (bin, args) => { const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {}; child.exitCode = null; spawned.push(args); return child }
      const custom = startConsumer({ eventKey: 'mail', command: ['--as', 'user', 'mail', '+watch'], onLine: () => {}, spawnChild })
      const plain = startConsumer({ eventKey: 'im.message.receive_v1', onLine: () => {}, spawnChild })
      custom.stop()
      plain.stop()
      assert.deepEqual(spawned, [['--as', 'user', 'mail', '+watch'], ['--as', 'bot', 'event', 'consume', 'im.message.receive_v1']])
    }],
    ['拆分接口：cliConfigDir 给所有 lark-cli 调用和 +watch 子进程带 LARKSUITE_CLI_CONFIG_DIR；不配就原样', async () => {
      const seen = []
      const run = async (args, options) => { seen.push(options); return { code: 0, stdout: '', stderr: '' } }
      const plain = createRelayCli({ run })
      assert.deepEqual([plain.run === run, plain.env], [true, null])
      const split = createRelayCli({ cliConfigDir: '/opt/relay-app', run })
      await split.run(['mail'], { identity: 'user', env: { A: '1' } })
      await split.run(['im'])
      assert.deepEqual(seen, [{ identity: 'user', env: { A: '1', LARKSUITE_CLI_CONFIG_DIR: '/opt/relay-app' } }, { env: { LARKSUITE_CLI_CONFIG_DIR: '/opt/relay-app' } }])
      assert.deepEqual(split.env, { LARKSUITE_CLI_CONFIG_DIR: '/opt/relay-app' })
      assert.match(createRelayCli({ cliConfigDir: 'runtime/relay-cli' }).env.LARKSUITE_CLI_CONFIG_DIR, /\/runtime\/relay-cli$/, '相对路径按仓库根解析')
      const spawned = []
      const spawnChild = (bin, args, options) => { const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {}; child.exitCode = null; spawned.push(options); return child }
      startConsumer({ eventKey: 'mail', command: ['x'], env: split.env, onLine: () => {}, spawnChild }).stop()
      startConsumer({ eventKey: 'im', onLine: () => {}, spawnChild }).stop()
      assert.equal(spawned[0].env.LARKSUITE_CLI_CONFIG_DIR, '/opt/relay-app')
      assert.equal(spawned[0].env.PATH, process.env.PATH, '子进程继承本进程环境')
      assert.deepEqual(spawned[1], { stdio: ['pipe', 'pipe', 'pipe'] }, '不配就不传 env')
    }],
    ['入口（默认 poll）：不开 WebSocket；立刻拉一轮、之后按 pollMs（缺省 2 分钟、最少 30 秒）拉；带 15 分钟重叠；上一轮没完不叠加；停止清定时', async () => {
      let consumed = null
      const consume = (options) => { consumed = options; return { stop: () => {}, observe: () => null } }
      const io = memIo()
      const calls = []
      let release = null
      const catchUp = (args) => { calls.push(args); return new Promise((resolve) => { release = () => resolve({ checked: 1 }) }) }
      const timers = []
      const cli = { run: async () => ({ code: 0, stdout: '', stderr: '' }), env: {} }
      const relay = await quiet(() => startMailRelay({ relay: OL_RELAY, io, cli, consume, catchUp, schedule: (fn, ms) => { timers.push([fn, ms]); return 7 } }))
      assert.equal(consumed, null, 'poll 模式不开 +watch')
      assert.deepEqual([relay.mode, timers[0][1], calls.length, calls[0].overlapMs, calls[0].io === io, calls[0].run === cli.run], ['poll', RELAY_POLL_MS, 1, RELAY_POLL_OVERLAP_MS, true, true])
      await timers[0][0]()
      assert.equal(calls.length, 1, '上一轮还在跑：本轮跳过')
      release()
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(relay.observe().last.checked, 1)
      await Promise.all([timers[0][0](), (async () => { await Promise.resolve(); release() })()])
      assert.equal(calls.length, 2)
      const failing = await quiet(() => startMailRelay({ relay: OL_RELAY, io, cli, consume, catchUp: async () => { throw new Error('boom') }, schedule: () => null }))
      await new Promise((resolve) => setImmediate(resolve))
      assert.deepEqual([failing.observe().last.failed, failing.observe().last.error, failing.observe().failures.count], [true, 'boom', 1], '拉取抛错记一笔、不炸、计入连续失败')
      // 告警接线：连续 2 次失败（alert.afterFailures=2）私信一次，恢复再报一次；默认发信走本引擎的 lark-cli（bot 身份）私信 alert.openId，发信失败不炸。
      const outcomes = [{ failed: true, error: 'e1' }, { failed: true, error: 'e2' }, { failed: true, error: 'e3' }, { checked: 0 }]
      const sends = []
      const alertCli = { run: async (args, options = {}) => (sends.push([args, options]), { code: 0, stdout: '{"ok":true,"data":{"message_id":"om_alert"}}', stderr: '' }), env: {} }
      const alertTimers = []
      const alerting = await quiet(() => startMailRelay({ relay: { ...OL_RELAY, alert: { afterFailures: 2 } }, notifyOpenId: 'ou_me', io, cli: alertCli, consume, catchUp: async () => outcomes.shift(), schedule: (fn) => { alertTimers.push(fn); return null } }))
      await new Promise((resolve) => setImmediate(resolve))
      for (let round = 0; round < 3; round += 1) await quiet(() => alertTimers[0]())
      assert.equal(sends.length, 2, '满 2 次发一次、第 3 次不重复、恢复发一次')
      assert.deepEqual([sends[0][0].slice(0, 4), sends[0][1].identity], [['im', '+messages-send', '--user-id', 'ou_me'], undefined])
      assert.match(sends[0][0].join(' '), /连续 2 次读收件箱失败.*最近一次错误：e2/s)
      assert.match(sends[1][0].join(' '), /审批邮件转发恢复了：.*连续失败 3 次/)
      const noted = []
      const injected = await quiet(() => startMailRelay({ relay: { ...OL_RELAY, alert: { afterFailures: 1 } }, io, cli, consume, notify: async (text) => { noted.push(text); throw new Error('send down') }, catchUp: async () => ({ failed: true, error: 'x' }), schedule: () => null }))
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(noted.length, 1, '注入的 notify 被调用；抛错不炸')
      assert.equal(injected.observe().failures.alerted, true)
      assert.deepEqual([relayPollMs({}), relayPollMs({ pollMs: 1000 }), relayPollMs({ pollMs: 300_000 }), relayPollMs({ pollMs: 'x' }), relayPollMs(null), relayPollMs({ pollMs: 0 }), relayPollMs({ pollMs: -5 }), relayPollMs({ pollMs: Infinity })], [RELAY_POLL_MS, 30_000, 300_000, RELAY_POLL_MS, RELAY_POLL_MS, RELAY_POLL_MS, RELAY_POLL_MS, RELAY_POLL_MS])
      assert.deepEqual(validateMailRelay({ ...OL_RELAY, mode: 'push', pollMs: -1 }), ['mailRelay.mode 只能是 poll（默认，定时拉）/ watch（实时监听，只在独立应用里用）', 'mailRelay.pollMs 必须是正数（毫秒）'])
      assert.deepEqual(validateMailRelay({ ...OL_RELAY, mode: 'watch', pollMs: 60_000 }), [])
      assert.deepEqual(validateMailRelay({ ...OL_RELAY, pollMs: 0 }), ['mailRelay.pollMs 必须是正数（毫秒）'])
      relay.stop()
    }],
    ['入口（mode=watch，只在独立应用里用）：没开 / 没启用路由不起；开了用 user 身份常驻 +watch、行进 handler；照样定时拉取兜底（同一个台账 / 调用器 / 15 分钟重叠）；停止两路都停', async () => {
      let consumed = null
      const consume = (options) => { consumed = options; return { stop: () => { consumed.stopped = true }, observe: () => ({ alive: true }) } }
      assert.equal(startMailRelay({ relay: { ...OL_RELAY, enabled: false }, consume }).observe(), null)
      assert.equal(startMailRelay({ relay: { enabled: true, routes: [{ ...OL_RELAY.routes[0], enabled: false }] }, consume }).observe(), null)
      assert.equal(startMailRelay({ relay: undefined, consume }).observe(), null)
      assert.equal(consumed, null)
      const io = memIo()
      const caught = []
      const timers = []
      const cleared = []
      const originalClear = globalThis.clearInterval
      const cli = { run: async () => ({ code: 0, stdout: '', stderr: '' }), env: { LARKSUITE_CLI_CONFIG_DIR: '/d' } }
      const relay = await quiet(() => startMailRelay({ relay: { ...OL_RELAY, mode: 'watch' }, io, cli, consume, catchUp: async (args) => { caught.push(args); return { checked: 0 } }, schedule: (fn, ms) => { timers.push([fn, ms]); return 'poll-timer' } }))
      assert.deepEqual(consumed.command, ['--as', 'user', 'mail', '+watch', '--msg-format', 'metadata', '--format', 'data'])
      assert.equal(consumed.eventKey, 'mail.user_mailbox.event.message_received_v1')
      assert.equal(consumed.env, cli.env, '拆分时 +watch 也走同一套凭证')
      assert.equal(consumed.onLine({ header: {} }), null, '不是邮件的行不处理')
      assert.ok(consumed.onLine({ message: { message_id: 'x', subject: 'nothing' } }) instanceof Promise)
      assert.ok(caught[0]?.handler && caught[0].io === io && caught[0].run === cli.run && caught[0].overlapMs === RELAY_POLL_OVERLAP_MS && caught[0].label === '兜底拉取', '启动就拉一轮，同一个台账和调用器、带重叠')
      assert.deepEqual(relay.routes.map((route) => route.id), ['ol'])
      assert.equal(timers[0][1], RELAY_POLL_MS, '兜底按 pollMs 定时拉')
      await timers[0][0]()
      assert.equal(caught.length, 2)
      const seen = relay.observe()
      assert.deepEqual([seen.mode, seen.watch, seen.last.checked, seen.failures.count], ['watch', { alive: true }, 0, 0])
      globalThis.clearInterval = (handle) => cleared.push(handle)
      try {
        relay.stop()
      } finally {
        globalThis.clearInterval = originalClear
      }
      assert.deepEqual([consumed.stopped, cleared], [true, ['poll-timer']])
    }],
    // 独立包 packages/mail-relay（11-05 P1 拆分）：包边界、lark-cli 层对照、独立运行缺省、长连接、独立入口。
    ...mailRelayPackageSteps,
  ]))
})
