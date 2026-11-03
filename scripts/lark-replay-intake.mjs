#!/usr/bin/env node
/**
 * 分类回放（11-01 对话层）：拿真实消息核「分类 → 契约 → 可执行性」。
 *   node scripts/lark-replay-intake.mjs [--fixture __tests__/fixtures/intake-replay-1101.json] [--live] [--json]
 * 默认（不跑模型）：按 fixture 的 expected 分类构造任务，核 deriveContract / intakeActionable / 运维指令不过分类，并打印分类提示字数。
 * --live：真跑 claude 分类器（与 worker 同一条命令），比 decision / deliverable / selfAnswer / continues，不一致退出码 1。
 * 改分类提示词（lib/lark-classify-prompt.mjs）或 intake 规则（lib/lark-intake-resolve.mjs）后跑一遍。
 *
 * 分类回归集（11-02 起，56 条，fixture 带 regression: true）：
 *   node scripts/lark-replay-intake.mjs --fixture __tests__/fixtures/intake-regression-1102.json --live [--model m] [--effort e] [--conc 8] [--json]
 * 按运行配置（runtime/lark-bot.local.json 的 claudeIntentModel / claudeIntentEffort，没配沿用任务模型）真跑分类器，带 persona，
 * 逐条比 judgeIntakeCase（expected 是可接受值的集合），打印耗时中位 / P90。换分类模型 / 强度、改分类提示前先跑这个。
 * 不带 --live 只核每条都能拼出提示。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { buildIntentClassificationPrompt, readPersona } from '../lib/lark-classify-prompt.mjs'
import { judgeIntakeCase, regressionTaskOf } from '../lib/lark-intake-replay.mjs'
import { intakeActionable } from '../lib/lark-intake-resolve.mjs'
import { parseCommandType, textForParse } from '../lib/lark-message.mjs'
import { OPS_COMMAND_TYPE, resolveOpsCommandType } from '../lib/lark-ops-task.mjs'
import { larkBotRoot, larkLocalConfigPath } from '../lib/lark-paths.mjs'
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
if (fixture.regression) await runRegression()
for (const item of fixture.regression ? [] : fixture.cases) {
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

async function runRegression() {
  const { loadWorkerLocalConfig } = await import('../lib/lark-worker-run.mjs')
  const runtimeConfig = loadWorkerLocalConfig(value('--config', larkLocalConfigPath)) // 默认就是 worker 用的运行配置（模型 / 强度 / 宿主隔离都跟线上一致）
  const localConfig = {
    ...runtimeConfig,
    ...(value('--model', null) ? { claudeIntentModel: value('--model', null) } : {}),
    ...(value('--effort', null) ? { claudeIntentEffort: value('--effort', null) } : {}),
  }
  const persona = readPersona()
  const conc = Math.max(1, Number(value('--conc', 8)))
  const { execAiExecutor } = live ? await import('../lib/lark-ai-executor.mjs') : {}
  const queue = [...fixture.cases]
  const one = async (item) => {
    const task = regressionTaskOf(item, { principalOpenId: localConfig.notifyOpenId })
    task.attachments = task.attachments.filter((a) => !a.localPath || existsSync(a.localPath)) // 附件指本机存档，缺了就不带
    const prompt = buildIntentClassificationPrompt(task, { localConfig, persona })
    if (!live) return { id: item.id, ok: prompt.length > 0, mode: 'prompt', got: { promptChars: prompt.length } }
    const t0 = Date.now()
    try {
      const run = await execAiExecutor({ executor: 'claude', promptText: prompt, cwd: larkBotRoot, attachments: task.attachments, localConfig, resultKind: 'intent', readOnly: true })
      const verdict = judgeIntakeCase(item.expected, run.result)
      return { id: item.id, set: item.set, ok: verdict.ok, mode: 'live', ms: Date.now() - t0, mismatches: verdict.mismatches, text: item.text.slice(0, 60) }
    } catch (error) {
      return { id: item.id, set: item.set, ok: false, mode: 'live', ms: Date.now() - t0, mismatches: [`执行失败：${String(error?.message || error).slice(0, 160)}`] }
    }
  }
  await Promise.all(Array.from({ length: conc }, async () => {
    while (queue.length) rows.push(await one(queue.shift()))
  }))
  failed = rows.filter((row) => !row.ok).length
  if (live && !asJson) {
    const ms = rows.map((row) => row.ms).sort((a, b) => a - b)
    const at = (p) => (ms[Math.min(ms.length - 1, Math.floor(p * (ms.length - 1) + 0.5))] / 1000).toFixed(1)
    console.log(`分类模型：${localConfig.claudeIntentModel || localConfig.claudeModel || '(默认)'} / ${localConfig.claudeIntentEffort || localConfig.claudeEffort || '(默认)'}，并发 ${conc}；耗时中位 ${at(0.5)}s、P90 ${at(0.9)}s`)
  }
}

if (asJson) console.log(JSON.stringify({ failed, rows }, null, 2))
else if (fixture.regression) {
  for (const row of rows.filter((r) => !r.ok)) console.log(`✗ ${row.id} [${row.set}] ${row.mismatches.join('；')}  ${row.text || ''}`)
  console.log(`${rows.length - failed}/${rows.length} 通过${live ? '（真跑分类器）' : '（只核提示能拼出来；加 --live 真跑）'}`)
}
else {
  for (const row of rows) console.log(`${row.ok ? '✓' : '✗'} ${row.id} [${row.mode}] got=${JSON.stringify(row.got)} expected=${JSON.stringify(row.expected)}`)
  console.log(`${rows.length - failed}/${rows.length} 通过${live ? '（含真跑分类器）' : ''}`)
}
process.exit(failed ? 1 : 0)
