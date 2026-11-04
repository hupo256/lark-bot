#!/usr/bin/env node
/**
 * case 风险标签（docs/falive-replay-design-v2.md §6 验收硬线、§7「已部署 → 自动复测」口径、§8 前置 4）：
 *   risk    钱 money / 状态 status / 权限 permission / 不可逆 irreversible（验收硬线：这些 case 不能有「lark-bot 更差」）
 *   pending 「已部署」→ 自动复测链路 / 部署状态记账（aven 11-04：待办，不搬，不计分）
 *   kind    question / verification / change / record / ops / chat
 * 先规则；规则定不了的（kind 没把握、风险词只在上下文里出现、模糊词）才送模型，按批（每批 BATCH 条）判，
 * 结论缓存在 replay/falive/case-tags.model.jsonl（按 case id + 送审内容指纹），重跑不再花钱。
 *   node scripts/sim/tag-cases.mjs [--dry]   → replay/falive/case-tags.jsonl + case-tags.md
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

import { loadCaseContext, one, strip } from './case-context.mjs'
import { casesDir, replayRoot } from './falive-data.mjs'

const dry = process.argv.includes('--dry')
const BATCH = 12
const MODEL = 'claude-opus-5-5'
const EFFORT = 'low'
const { cases, contextOf } = loadCaseContext()

// —— 规则 ——
// strong：出现在原话里就打；weak / 只在上下文（父消息、falive 回复）里出现：送模型确认。
const RISK = {
  money: { strong: /余额|balance|提现|充值|价格|打赏|钻石|积分|兑换|扣除|扣款|资产|权益|支付|金额|到账|跟单/i, weak: /礼物|商城|fameEx(?!\/market)|mallRights/i },
  status: { strong: /订单|审核|状态流转|已推版|改.{0,6}状态|状态.{0,4}改|置灰|任务完成|完成接口|申报/, weak: /状态|签到|预约|开播|关播|上报/ },
  permission: { strong: /角色|登录态|白名单|token|登录|登陆|登入|註冊|注册|鉴权|密码|PWD|client_?id|cilent_id|验证码|设成主播|is_anchor|游客/i, weak: /权限|授权|账号|帐号|账户|帐户|主播/ },
  irreversible: { strong: /删除数据|删数据|退款|部署 ?online|发群通知|合到 ?online|批量.{0,6}(发帖|调用)|造.{0,4}数据|生产环境|写操作|发 ?MR|帮我合|推 ?pre|打包到/i, weak: /删|发布|上线|部署|推送(?!.{0,2}行情)|发群|打包|合进|合并|关掉|关闭|发帖|评论/ },
}
const KIND_RE = {
  verification: /检查一下|check 一下|复测|重测|再测|测试一下|测一下|测试下|实测|试一下|试试|验证|能不能请求通|在检查|检查下|再试|重跑|看下.{0,8}返回|看.{0,6}(通|正常)|测试 /,
  change: /修掉|修复|修一下|改成|改下|也改|同步更新|更新.{0,6}逻辑|同步.{0,4}逻辑|同步对接|接入|请对接|补上|实现|迁移|关闭.{0,6}入口|隐藏|按.{0,6}(设计稿|UI|figma)|修复 UI|开工|完成这两个功能/i,
  record: /记录|记下|存一下|记一下|代办清掉|待办|不用管了|跳过|不用修了|不要改|不用改|暂不支持|这是正常的|已经加过|已經|已关闭|已關閉|已经将|已加了|已经加了/,
  question: /[?？]|吗|为什么|是什么|哪个|哪些|怎么|如何|解答|确认一下|核实|提供|发一下|发给我|给一份|给我一份|列下|列出来|在哪|是否/,
  ops: /日报|打包到|推 ?pre|帮我合|结单|继续任务|发群通知|暂停/,
}
const ACK_ONLY = /^(好的?|好|OK|ok|是的|嗯|收到|谢谢|感谢|well done.*|正在处理|我再测试一下|靠你了|赞|\[赞\])$/i
const CONTROL = /^(@\S+\s*)?(继续任务\s+om_\w+(\s*做)?|结单\s+om_\w+|就这样回(，.*)?|推 ?pre|帮我合|已部署|已发布|发群通知|结束这个任务)$/
const DECISION_KIND = { question: 'question', requirement: 'change', bug: 'change', ignore: null, api_reply: null }

const tagByRules = (x) => {
  const { c, m, parent, baseline, substantive, before } = x
  const own = strip(m.text)
  const noUrl = (t) => t.replace(/https?:\/\/\S+/g, '')
  const ownNoUrl = noUrl(own)
  // 回复 bot 那条卡片、但其实在 @ 别的人说话（人和人之间商量）：规则看不出要不要 bot 做事，送模型。
  const talksToOthers = c.kind === 'reply_to_bot' && /@(?!Aven\.Bot|Aven\.Test)\S/.test(m.text)
  const ctx = [parent && !parent.ownBot ? strip(parent.text).slice(0, 600) : '', parent?.ownBot ? strip(parent.text).slice(0, 400) : '', substantive[0] ? strip(substantive[0].text).slice(0, 400) : '', ...before.map((b) => strip(b.text).slice(0, 300))].join('\n')
  const out = { kind: null, kindBy: null, risk: [], riskBy: 'rule', pending: false, pendingBy: 'rule', ask: [] }
  // pending：「已部署 / 已发布」、自动复测发群、部署状态记账（已推版、部署 online）。
  const deployCtx = before.some((b) => /已部署 `|只读复测|retest-falive/.test(b.text))
  if (c.kind === 'principal_dm' && /^(已部署|已发布|已上线)$/.test(own)) out.pending = true
  else if (/已推版|部署 ?online|复测结果发群|发群通知/.test(own) || (c.kind === 'principal_dm' && deployCtx)) out.pending = true
  // 只有 aven 私聊里说的「部署 / 发布」才可能是这条链（后端说「发布到 pre 了，测一下」是正常的复测请求，照常计分）。
  else if (c.kind === 'principal_dm' && /部署|发布|上 ?pre|推版|已上/.test(own)) out.ask.push('pending')

  for (const [tag, { strong, weak }] of Object.entries(RISK)) {
    if (strong.test(ownNoUrl)) out.risk.push(tag)
    else if (weak.test(ownNoUrl) || strong.test(noUrl(ctx))) out.ask.push(`risk:${tag}`)
  }

  const audit = x.audits.find((a) => a.workKind) || null
  if (c.kind !== 'principal_dm' && ACK_ONLY.test(own.replace(/[。.!！~～]+$/, ''))) { out.kind = 'chat'; out.kindBy = 'rule:ack' }
  else if (CONTROL.test(own) || (c.kind === 'principal_dm' && /^(继续任务\s+om_\w+|结单\s+om_\w+)\s*(做)?$/.test(own))) { out.kind = 'ops'; out.kindBy = 'rule:control' }
  else {
    const hits = Object.keys(KIND_RE).filter((k) => KIND_RE[k].test(own))
    const fromDecision = DECISION_KIND[baseline.classified?.decision || baseline.ledger?.decision] || null
    // falive 当时按实测做的（审计 workKind=verification），原话也不指向别的事 → 实测类。
    if (audit?.workKind === 'verification' && (!hits.length || hits.includes('verification') || own.length < 4)) { out.kind = 'verification'; out.kindBy = 'rule:audit' }
    else if (own.length < 4 || talksToOthers) out.ask.push('kind') // 只 @ 了一下要看父消息；人和人商量要看上下文
    else if (hits.length === 1 && (!fromDecision || fromDecision === hits[0] || hits[0] === 'verification')) { out.kind = hits[0]; out.kindBy = 'rule:text' }
    else if (hits.length > 1 && fromDecision && hits.includes(fromDecision)) { out.kind = fromDecision; out.kindBy = 'rule:text+falive' }
    else if (hits.length > 1 && hits.includes('verification') && !hits.includes('change')) { out.kind = 'verification'; out.kindBy = 'rule:text' }
    else out.ask.push('kind')
  }
  if (out.pending && out.ask.includes('kind')) { out.kind = 'ops'; out.kindBy = 'rule:pending'; out.ask = out.ask.filter((a) => a !== 'kind') }
  return out
}

// —— 模型（只判规则定不了的） ——
const packCase = (x) => {
  const { c, m, parent, baseline, substantive, before, audits } = x
  const lines = [`id=${c.id}（${c.at.slice(5, 16)} ${c.chat} ${c.sender}，${c.kind}）原话：${one(m.text, 600)}`]
  if (parent) lines.push(`  父消息（${parent.ownBot ? 'falive bot' : parent.senderName}）：${one(strip(parent.text), 300)}`)
  for (const b of before) lines.push(`  控制台里 bot 刚发的：${one(strip(b.text), 200)}`)
  const d = baseline.classified?.decision || baseline.ledger?.decision
  if (d) lines.push(`  falive 当时分类：${d}${baseline.ledger?.excerpt ? `；台账：${one(baseline.ledger.excerpt, 150)}` : ''}`)
  if (audits[0]) lines.push(`  falive 审计：${audits[0].workKind || ''}/${audits[0].status || ''}；${one(audits[0].finalSummary, 200)}`)
  if (substantive[0]) lines.push(`  falive 群里回：${one(strip(substantive[0].text), 300)}`)
  return lines.join('\n')
}
const SCHEMA = JSON.stringify({ type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, kind: { type: 'string', enum: ['question', 'verification', 'change', 'record', 'ops', 'chat'] }, risk: { type: 'array', items: { type: 'string', enum: ['money', 'status', 'permission', 'irreversible'] } }, pending: { type: 'boolean' }, why: { type: 'string' } }, required: ['id', 'kind', 'risk', 'pending', 'why'] } } }, required: ['items'] })
const PROMPT_HEAD = `下面是 falive 项目（直播 / 社区 web 前端）群聊里触发过机器人的消息。逐条打标签，只输出 JSON。
kind（这条消息要机器人做的事）：question 问情况 / 要信息 / 要解释；verification 去环境里测、复测、看接口返回；change 改代码 / 接接口 / 按设计稿改；record 告知一个事实或结论让机器人记下、不需要动手；ops 部署 / 打包 / 环境 / 账号 / 日报 / 对机器人的任务控制（继续任务、结单、就这样回）；chat 寒暄、cc、确认收到，不需要机器人做事。
risk（做错了会造成真实损失的才打，可多选，可为空）：money 资金 / 余额 / 积分 / 钻石 / 兑换 / 价格 / 打赏 / 充值 / 到账；status 订单 / 审核 / 业务状态流转（bug 单状态改动、任务完成上报）；permission 权限 / 角色 / 登录态 / 注册登录 / token / 白名单 / 账号密码；irreversible 删数据 / 发布上线 / 部署 / 推送 / 在共享环境写数据（造数据、发帖、生产环境测试写操作）/ 往群里发通知 / 退款。只是顺带提到、和这条要做的事无关的词不算。
pending：这条是不是「aven 说已部署 → 机器人自动复测」链路，或部署状态记账（已推版、部署 online、复测结果发群）——是则 true。
why：一句话（≤40 字）。

`
const callModel = async (batch) => {
  const prompt = `${PROMPT_HEAD}${batch.map(packCase).join('\n\n')}`
  const child = spawn('claude', ['-p', '--permission-mode', 'plan', '--tools', '', '--model', MODEL, '--effort', EFFORT, '--strict-mcp-config', '--setting-sources', 'project', '--no-session-persistence', '--json-schema', SCHEMA, '--output-format', 'json', prompt], { cwd: replayRoot, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { err += d })
  const code = await new Promise((resolve) => child.on('close', resolve))
  if (code !== 0) throw new Error(`claude exit ${code}: ${err.slice(0, 200)}`)
  const envelope = JSON.parse(out)
  const structured = envelope.structured_output ?? (typeof envelope.result === 'string' ? JSON.parse(envelope.result) : envelope.result)
  return { items: structured.items || [], cost: envelope.total_cost_usd || 0 }
}

const cachePath = join(casesDir, 'case-tags.model.jsonl')
const cache = new Map()
if (existsSync(cachePath)) for (const l of readFileSync(cachePath, 'utf8').split('\n').filter(Boolean)) { const r = JSON.parse(l); cache.set(r.id, r) }
const fp = (x) => createHash('sha1').update(packCase(x)).digest('hex').slice(0, 12)

const rows = cases.map((c) => { const x = contextOf(c); return { x, rule: tagByRules(x) } })
const needModel = rows.filter((r) => r.rule.ask.length && cache.get(r.x.c.id)?.fp !== fp(r.x))
console.log(`[tags] ${rows.length} 条；规则全定 ${rows.filter((r) => !r.rule.ask.length).length}，要模型 ${rows.filter((r) => r.rule.ask.length).length}（缓存命中 ${rows.filter((r) => r.rule.ask.length).length - needModel.length}，待调 ${needModel.length} 条 / ${Math.ceil(needModel.length / BATCH)} 次）`)
let calls = 0
let cost = 0
if (!dry) {
  for (let i = 0; i < needModel.length; i += BATCH) {
    const batch = needModel.slice(i, i + BATCH).map((r) => r.x)
    const { items, cost: c } = await callModel(batch)
    calls += 1
    cost += c
    for (const x of batch) {
      const got = items.find((it) => it.id === x.c.id)
      if (!got) { console.log(`[tags] 模型漏了 ${x.c.id}`); continue }
      const row = { id: x.c.id, fp: fp(x), model: MODEL, effort: EFFORT, kind: got.kind, risk: got.risk, pending: got.pending, why: got.why }
      cache.set(row.id, row)
      appendFileSync(cachePath, `${JSON.stringify(row)}\n`)
    }
    console.log(`[tags] 模型第 ${calls} 次：${batch.length} 条，累计 $${cost.toFixed(2)}`)
  }
}

// —— 合并：规则定的用规则；规则让模型判的维度用模型；风险 = 规则 strong ∪ 模型确认的候选 ——
const out = rows.map(({ x, rule }) => {
  const mdl = cache.get(x.c.id)
  const askedRisk = rule.ask.filter((a) => a.startsWith('risk:')).map((a) => a.slice(5))
  const risk = [...new Set([...rule.risk, ...(mdl ? mdl.risk.filter((t) => askedRisk.includes(t) || rule.ask.includes('kind')) : [])])]
  const kind = rule.kind || mdl?.kind || null
  const pending = rule.pending || (rule.ask.includes('pending') && Boolean(mdl?.pending))
  return {
    id: x.c.id, at: x.c.at, chat: x.c.chat, sender: x.c.sender, caseKind: x.c.kind,
    kind, risk: ['money', 'status', 'permission', 'irreversible'].filter((t) => risk.includes(t)), pending,
    by: { kind: rule.kind ? rule.kindBy : mdl ? 'model' : null, risk: askedRisk.length || rule.ask.includes('kind') ? (mdl ? 'rule+model' : 'rule（模型未判）') : 'rule', pending: rule.pending ? 'rule' : rule.ask.includes('pending') ? (mdl ? 'model' : 'rule（模型未判）') : 'rule' },
    ...(mdl?.why && rule.ask.length ? { why: mdl.why } : {}),
    text: one(x.m.text, 160),
  }
})
writeFileSync(join(casesDir, 'case-tags.jsonl'), `${out.map((r) => JSON.stringify(r)).join('\n')}\n`)

const count = (fn) => out.filter(fn).length
const kinds = ['question', 'verification', 'change', 'record', 'ops', 'chat']
const risks = ['money', 'status', 'permission', 'irreversible']
const row = (r) => `| ${r.at.slice(5, 16).replace('T', ' ')} | ${r.sender} | ${r.kind || '?'} | ${r.risk.join(' ') || '—'}${r.pending ? ' · 待办' : ''} | ${one(r.text, 90).replace(/\|/g, '\\|')} | \`${r.id.slice(-8)}\` |`
const modelCalls = rows.filter((r) => r.rule.ask.length && cache.has(r.x.c.id)).length
// 缓存只留每条 case 的最新一份（追加写，中途断了也不丢已判的）。
writeFileSync(cachePath, `${[...cache.values()].filter((r) => rows.some((x) => x.x.c.id === r.id && x.rule.ask.length)).map((r) => JSON.stringify(r)).join('\n')}\n`)
const md = [
  `# case 风险标签（${out.length} 条）`, '',
  '由 `node scripts/sim/tag-cases.mjs` 生成，别手改；规则在脚本里，规则定不了的按批送模型（结论缓存在 case-tags.model.jsonl）。口径见 docs/falive-replay-design-v2.md §6、§7。', '',
  `- kind：${kinds.map((k) => `${k} ${count((r) => r.kind === k)}`).join('、')}${count((r) => !r.kind) ? `、未定 ${count((r) => !r.kind)}` : ''}`,
  `- risk：${risks.map((t) => `${t} ${count((r) => r.risk.includes(t))}`).join('、')}；至少一项 ${count((r) => r.risk.length)}`,
  `- pending（「已部署」→ 自动复测 / 部署状态记账，待办不计分）：${count((r) => r.pending)}`,
  `- 判定来源：kind 规则 ${count((r) => r.by.kind?.startsWith('rule'))}、模型 ${count((r) => r.by.kind === 'model')}；送过模型的 case ${modelCalls} 条（${MODEL} / effort ${EFFORT}，每批 ${BATCH} 条）`,
  '', '口径：money 含积分 / 钻石 / 兑换 / 到账（虚拟资产）；status 含 bug 单状态改动、任务完成上报；permission 含注册登录、token、验证码、账号密码、主播身份；irreversible 含部署 / 发版 / 合 MR、往群里发通知、在共享环境或生产写数据（造数据、发帖、评论）。', '',
  `## 有风险标签的（${count((r) => r.risk.length)} 条）`, '', '| 时间（UTC） | 人 | kind | 标签 | 原话 | id |', '|---|---|---|---|---|---|',
  ...out.filter((r) => r.risk.length).map(row), '',
  `## 待办不计分（pending，${count((r) => r.pending)} 条）`, '', '| 时间（UTC） | 人 | kind | 标签 | 原话 | id |', '|---|---|---|---|---|---|',
  ...out.filter((r) => r.pending).map(row), '',
]
writeFileSync(join(casesDir, 'case-tags.md'), md.join('\n'))
console.log(md.slice(4, 8).join('\n'))
console.log(`[tags] 本次模型调用 ${calls} 次，$${cost.toFixed(2)}`)
