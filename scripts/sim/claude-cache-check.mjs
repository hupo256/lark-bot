#!/usr/bin/env node
/**
 * claude 调用缓存（scripts/sim/claude-cache.mjs）的自检：
 *   1. 判定表：用 lib 的 buildAiExecutorCommand 拼各类真实命令行（intent / triage / analysis / 只读任务 / 可写任务 / 续会话 / 就绪探针），
 *      喂判定函数（不真跑），核每类 cache / bypass。
 *   2. 真调两次：同一条 falive 消息（带截图）走 classifyTaskIntent → execAiExecutor，LARK_CLAUDE_BIN 指包装；第一次 miss 真调、第二次 hit，
 *      核两次 stdout 逐字节相同、分类结果相同、第二次 < 1 秒。缓存与日志放临时目录，不碰回放的 ai-cache。
 *   node scripts/sim/claude-cache-check.mjs [--only-table] [--id <om_...>]
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
if (!process.env.LARK_RUNTIME_DIR) process.env.LARK_RUNTIME_DIR = join(homedir(), 'github', 'lark-bot', 'runtime')
const scratch = mkdtempSync(join(tmpdir(), 'claude-cache-check-'))
process.env.SIM_AI_CACHE_DIR = join(scratch, 'cache')
process.env.SIM_DIR = join(scratch, 'sim')
process.env.LARK_CLAUDE_BIN = join(here, 'claude')

const { classifyClaudeArgv } = await import('./claude-cache.mjs')
const { buildAiExecutorCommand, execAiExecutor } = await import('../../lib/lark-ai-executor.mjs')
let failed = 0
const check = (label, ok, detail = '') => {
  if (!ok) failed += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `：${detail}` : ''}`)
}

// —— 1. 判定表 ——
const base = { executor: 'claude', promptText: '任务正文\n\n结果文件路径：/tmp/lark-claude-result-AbC123/result.json\n', cwd: tmpdir(), resultPath: '/tmp/lark-claude-result-AbC123/result.json', model: 'claude-opus-5-5', reasoningEffort: 'high', settingSources: 'project', extraReadOnlyCommands: [`node ${join(here, '..', '..', 'tools', 'read-bug-record.mjs')}`, `node ${join(here, '..', '..', 'tools', 'env-version.mjs')}`] }
const cases = [
  ['intent', { ...base, promptText: '分类', resultKind: 'intent', readOnly: true }, true, 'intent'],
  ['triage', { ...base, promptText: '分诊', resultKind: 'triage' }, true, 'triage'],
  ['analysis', { ...base, promptText: '分析', resultKind: 'analysis', systemPromptText: '驾驶规则' }, true, 'analysis'],
  ['只读任务（代答 / 实测）', { ...base, resultKind: 'task', readOnly: true }, true, 'task-ro'],
  ['可写任务（改码实施）', { ...base, resultKind: 'task', readOnly: false, systemPromptText: '驾驶规则' }, false, 'task-rw'],
  ['续会话实施', { ...base, resultKind: 'task', readOnly: false, resumeSessionId: 'abc-123' }, false, null],
  ['只读任务续会话（补写结果 / 群回复）', { ...base, resultKind: 'task', readOnly: true, resumeSessionId: 'abc-123' }, false, 'resume'],
  ['带页面工具的只读任务', { ...base, resultKind: 'task', readOnly: true, extraReadOnlyCommands: [...base.extraReadOnlyCommands, 'node /x/tools/verify-page.mjs'] }, false, 'task-rw'],
]
for (const [label, options, expectCache, expectKind] of cases) {
  const { args: argv } = buildAiExecutorCommand(options)
  const verdict = classifyClaudeArgv(argv)
  check(`判定 ${label} → ${verdict.cacheable ? 'cache' : 'bypass'}（${verdict.kind}；${verdict.reason}）`, verdict.cacheable === expectCache && (!expectKind || verdict.kind === expectKind))
}
check('判定 --version → bypass', !classifyClaudeArgv(['--version']).cacheable)
const { buildClaudeReadinessCommand } = await import('../../lib/lark-ai-executor.mjs')
check('判定 就绪探针（text 输出）→ bypass', !classifyClaudeArgv(buildClaudeReadinessCommand({ model: 'm', effort: 'low' }).args).cacheable)

if (args.includes('--only-table')) {
  rmSync(scratch, { recursive: true, force: true })
  process.exit(failed ? 1 : 0)
}

// —— 2. 真调两次 ——
const { classifyTaskIntent } = await import('../../lib/lark-worker-run.mjs')
const { datasetDir, replayRoot } = await import('./falive-data.mjs')
const timeline = JSON.parse(readFileSync(join(datasetDir, 'timeline.json'), 'utf8'))
const wanted = value('--id', null)
const m = wanted ? timeline.find((x) => x.id === wanted) : timeline.find((x) => x.atBot && !x.ownBot && x.text && (x.resources || []).some((r) => r.localPath && r.type === 'image'))
if (!m) throw new Error('时间线里没找到带截图的 @bot 消息')
const attachments = (m.resources || []).filter((r) => r.localPath).map((r) => ({ type: r.type === 'image' ? 'image' : 'file', imageKey: r.key, localPath: join(replayRoot, 'raw', r.localPath.replace(/^\.?\/?/, '')) }))
const task = {
  id: m.id, source: 'lark', chatId: m.chatId, chatType: 'group', messageId: m.id, operator: m.senderId, project: 'FALIVE', chatName: m.chatName,
  text: m.text, summary: String(m.text).slice(0, 60), attachments, addressedToBot: true, status: 'received',
  intake: { required: true, trigger: 'bot_mention', receivedAt: new Date(m.atMs).toISOString() }, createdAt: new Date(m.atMs).toISOString(),
}
const localConfig = { project: 'FALIVE', aiExecutor: 'claude', claudeModel: 'claude-opus-5-5', claudeEffort: 'medium', claudeIntentModel: 'claude-opus-5-5', claudeIntentEffort: 'low', repoLabel: 'falive-react（Falive Web 前端仓）' }
const workerConfig = { projectId: 'FALIVE', projectName: 'Falive Web', aiExecutor: 'claude', localConfig }
const runOnce = async () => {
  const chunks = []
  const spawnImpl = (cmd, argv, options) => {
    const child = spawn(cmd, argv, options)
    child.stdout?.on('data', (chunk) => chunks.push(chunk))
    return child
  }
  const started = Date.now()
  const result = await classifyTaskIntent(workerConfig, task, null, undefined, { exec: (options) => execAiExecutor({ ...options, spawnImpl }) })
  return { result, stdout: Buffer.concat(chunks), ms: Date.now() - started }
}
console.log(`真调：${m.id}（${attachments.length} 个附件）${String(m.text).replace(/\s+/g, ' ').slice(0, 60)}`)
const first = await runOnce()
const second = await runOnce()
const log = readFileSync(join(process.env.SIM_DIR, 'ai-cache.log'), 'utf8').trim().split('\n')
console.log(log.map((line) => `  ai-cache.log | ${line}`).join('\n'))
check('第一次 miss（真调并落盘）', /^\S+ miss intent \S+ \d+ms 已落盘/.test(log[0] || ''), `${first.ms}ms`)
check('第二次 hit', /^\S+ hit intent /.test(log[1] || ''), `${second.ms}ms`)
check('两次 stdout 逐字节相同', first.stdout.length > 0 && first.stdout.equals(second.stdout), `${first.stdout.length} / ${second.stdout.length} 字节`)
check('两次分类结果相同', JSON.stringify(first.result) === JSON.stringify(second.result), `${first.result.decision}/${first.result.confidence}`)
check('第二次 < 1 秒', second.ms < 1000, `${second.ms}ms`)
rmSync(scratch, { recursive: true, force: true })
process.exit(failed ? 1 : 0)
