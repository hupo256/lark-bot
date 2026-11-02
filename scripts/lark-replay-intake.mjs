#!/usr/bin/env node
/**
 * 分类回放（11-01 对话层）：拿真实消息核「分类 → 契约 → 可执行性」。
 *   node scripts/lark-replay-intake.mjs [--fixture __tests__/fixtures/intake-replay-1101.json] [--live] [--json]
 * 默认（不跑模型）：按 fixture 的 expected 分类构造任务，核 deriveContract / intakeActionable / 运维指令不过分类，并打印分类提示字数。
 * --live：真跑 claude 分类器（与 worker 同一条命令），比 decision / deliverable / selfAnswer / continues，不一致退出码 1。
 * 改分类提示词（lib/lark-classify-prompt.mjs）或 intake 规则（lib/lark-intake-resolve.mjs）后跑一遍。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { buildIntentClassificationPrompt } from '../lib/lark-classify-prompt.mjs'
import { intakeActionable } from '../lib/lark-intake-resolve.mjs'
import { parseCommandType, textForParse } from '../lib/lark-message.mjs'
import { OPS_COMMAND_TYPE, resolveOpsCommandType } from '../lib/lark-ops-task.mjs'
import { larkBotRoot } from '../lib/lark-paths.mjs'
import { deriveContract } from '../lib/lark-task-contract.mjs'

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const fixturePath = value('--fixture', join(larkBotRoot, '__tests__', 'fixtures', 'intake-replay-1101.json'))
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))
const live = flag('--live')
const asJson = flag('--json')

// 运维指令判定与 ingest 同口径：负责人私信 + 显式「运维：」或原话里的部署 / 发推说法。
const config = { notifyOpenId: 'ou_aven', allowedOpenIds: ['ou_aven'], project: 'PR-TEST' }
const opsOf = (text) => resolveOpsCommandType({ config, msg: { chatType: 'p2p', senderOpenId: 'ou_aven', text }, classified: { type: parseCommandType(textForParse({ text })), source: 'explicit' } })

const taskOf = (item, classification = null) => ({
  id: item.id,
  text: item.text,
  operator: item.fromPrincipal ? 'ou_aven' : 'ou_someone',
  chatId: item.trigger === 'dm' ? 'oc_dm' : 'oc_group',
  chatType: item.trigger === 'dm' ? 'p2p' : 'group',
  addressedToBot: item.addressedToBot !== false,
  fromPrincipal: Boolean(item.fromPrincipal),
  attachments: [],
  conversation: item.conversation || null,
  intake: { required: true, trigger: item.trigger, classification },
})

const rows = []
let failed = 0
for (const item of fixture.cases) {
  const expected = item.expected || {}
  const ops = opsOf(item.text)
  if (item.ops || expected.classified === false) {
    const task = { ...taskOf(item), commandType: ops.type, commandTypeSource: ops.source }
    const contract = deriveContract(task)
    const ok = ops.type === OPS_COMMAND_TYPE && contract?.deliverable === expected.contract
    if (!ok) failed += 1
    rows.push({ id: item.id, ok, mode: 'ops', got: { commandType: ops.type, contract: contract?.deliverable || null }, expected })
    continue
  }
  const classification = { decision: expected.decision, confidence: 'high', deliverable: expected.deliverable ?? null, forMe: true, selfAnswer: Boolean(expected.selfAnswer), reply: 'x', continues: expected.continues ?? null, relatedTaskId: null, topic: null, waitsFor: null, summary: item.text, reason: 'fixture' }
  const task = taskOf(item, classification)
  const contract = deriveContract(task)
  const actionable = intakeActionable(task, classification, null)
  const prompt = buildIntentClassificationPrompt(taskOf(item), { localConfig: config })
  const got = { contract: contract?.deliverable || null, selfAnswer: contract?.selfAnswer === true, actionable, promptChars: prompt.length }
  let ok = got.contract === expected.contract && got.selfAnswer === Boolean(expected.selfAnswer) && got.actionable === Boolean(expected.actionable)
  if (live) {
    const { execAiExecutor } = await import('../lib/lark-ai-executor.mjs')
    const run = await execAiExecutor({ executor: 'claude', promptText: prompt, cwd: larkBotRoot, attachments: [], localConfig: {}, resultKind: 'intent', readOnly: true })
    const cls = run.result
    got.live = { decision: cls.decision, confidence: cls.confidence, deliverable: cls.deliverable, selfAnswer: cls.selfAnswer, continues: cls.continues, reply: cls.reply }
    const liveOk = cls.decision === expected.decision && (cls.deliverable ?? null) === (expected.deliverable ?? null) && Boolean(cls.selfAnswer) === Boolean(expected.selfAnswer) && (cls.continues ?? null) === (expected.continues ?? null)
    ok = ok && liveOk
  }
  if (!ok) failed += 1
  rows.push({ id: item.id, ok, mode: live ? 'live' : 'deterministic', got, expected })
}

if (asJson) console.log(JSON.stringify({ failed, rows }, null, 2))
else {
  for (const row of rows) console.log(`${row.ok ? '✓' : '✗'} ${row.id} [${row.mode}] got=${JSON.stringify(row.got)} expected=${JSON.stringify(row.expected)}`)
  console.log(`${rows.length - failed}/${rows.length} 通过${live ? '（含真跑分类器）' : ''}`)
}
process.exit(failed ? 1 : 0)
