import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, it } from 'node:test'

import { bashCommandHead, formatAuditMetrics, parseAuditLog, summarizeAuditMetrics } from '../lib/lark-audit-metrics.mjs'
import { buildAiExecutorCommand, execAiExecutor, resolveAiModelConfig } from '../lib/lark-ai-executor.mjs'
import { parseClaudeEnvelope } from '../lib/lark-ai-result.mjs'
import { REQUIRED_CLAUDE_FLAGS, buildExecutorChecks, collectExecutorFacts } from '../lib/lark-executor-doctor.mjs'
import { describePrdCacheDoc, detectShadowedAgentsDoc } from '../lib/lark-work-context.mjs'
import { buildAnalysisPrompt, buildTaskPromptParts, buildTriagePrompt } from '../lib/lark-worker-prompts.mjs'
import { runAI } from '../lib/lark-worker-run.mjs'
import { runSteps } from './support/steps.mjs'
import { branchForEnv, describeBuild, parseLegacyVersion, parseWebNextCommit } from '../lib/lark-env-version.mjs'
import { KNOWLEDGE_MAX_CHARS, buildEnvKnowledgeBlock, readKnowledge } from '../lib/lark-knowledge.mjs'
import { ENV_VERSION_TOOL } from '../lib/lark-paths.mjs'

// 11-01 上下文分层升级（docs/plan/upgrade-plan-context-layers-2026-11-01.md）S3 / S4 / S6 的纯函数：
// AGENTS.md 遮蔽检测、PRD 缓存标龄、截图先看、审计度量、体检执行层。
const ctx = { projectId: 'TR-99999', projectName: 'test', projectDocs: [], cwd: '/tmp/repo', hotfixBranch: 'hotfix/x', baseRef: 'origin/online' }
const line = (event) => JSON.stringify(event)
// 假 claude：分析阶段在事件流末尾吐 result 事件（structured_output），实施阶段写 result.json；记下每次的参数。
const fakeClaude = (calls) => (cmd, args) => {
  const child = new EventEmitter()
  Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: () => {}, pid: 4000 + calls.length })
  calls.push({ cmd, args })
  const resultPath = args.join(' ').match(/(\/\S+result\.json)/)?.[1]
  setImmediate(() => {
    child.stdout.write(`${line({ type: 'system', subtype: 'init', session_id: `s${calls.length}` })}\n`)
    if (args.includes('--json-schema')) child.stdout.write(`${line({ type: 'result', session_id: `s${calls.length}`, structured_output: { status: 'ready', summary: 's', applicableRules: [], requirements: [], blockers: [], scope: null } })}\n`)
    else if (resultPath) writeFileSync(resultPath, JSON.stringify({ status: 'done', summary: 'ok', checks: [], changedFiles: [], warnings: [] }))
    child.stdout.end()
    child.stderr.end()
    setImmediate(() => child.emit('exit', 0))
  })
  return child
}
const argOf = (args, flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null)

describe('上下文分层升级：遮蔽检测 / 缓存标龄 / 视觉分流 / 度量 / 体检', () => {
  it('S3 S4 S6 纯函数', () => runSteps([
    ['AGENTS.md 只在有不导入它的 CLAUDE.md 时算被遮蔽', () => {
      const fs = (files) => ({ exists: (path) => path in files, read: (path) => files[path] })
      assert.equal(detectShadowedAgentsDoc('/r', fs({ '/r/AGENTS.md': 'x', '/r/CLAUDE.md': '# CLAUDE.md' })), true)
      assert.equal(detectShadowedAgentsDoc('/r', fs({ '/r/AGENTS.md': 'x', '/r/CLAUDE.md': '@AGENTS.md\n# CLAUDE.md' })), false)
      assert.equal(detectShadowedAgentsDoc('/r', fs({ '/r/AGENTS.md': 'x' })), false, '只有 AGENTS.md：Claude Code 直接读它')
      assert.equal(detectShadowedAgentsDoc('/r', fs({ '/r/CLAUDE.md': 'x' })), false)
      assert.equal(detectShadowedAgentsDoc('/r', fs({ '/r/AGENTS.md': 'x', '/r/CLAUDE.local.md': 'mine' })), true)
      assert.equal(detectShadowedAgentsDoc('/r', { exists: () => true, read: () => { throw new Error('EACCES') } }), true, '读不到 CLAUDE.md 按没导入算')
    }],
    ['PRD 缓存标抓取时间，超 7 天提示以现抓 / 现状为准；读不到 mtime 原样返回', () => {
      const now = Date.parse('2026-11-01T00:00:00Z')
      const stat = (days) => () => ({ mtimeMs: now - days * 86_400_000 })
      assert.match(describePrdCacheDoc('/c/prd.md', { now, stat: stat(0) }), /抓取于 今天）$/)
      assert.match(describePrdCacheDoc('/c/prd.md', { now, stat: stat(3) }), /抓取于 3 天前）$/)
      assert.match(describePrdCacheDoc('/c/prd.md', { now, stat: stat(9) }), /抓取于 9 天前，可能已过期/)
      assert.equal(describePrdCacheDoc('/c/prd.md', { now, stat: () => { throw new Error('ENOENT') } }), '/c/prd.md')
      assert.doesNotMatch(describePrdCacheDoc('/c/prd.md', { now, stat: stat(7) }), /可能已过期/, '正好 7 天不算过期')
    }],
    ['带已下载截图的任务提示先 Read 截图；下载失败 / 无截图不提；有非本条附件时注明归属', () => {
      const user = (attachments) => buildTaskPromptParts(ctx, { id: 't', text: '按截图改', attachments }, 'claude', { ruleContext: { text: '', sources: [] } }).user
      assert.match(user([{ type: 'image', localPath: '/a/1.png' }, { type: 'image', localPath: '/a/2.png' }]), /附件里有 2 张截图：先用 Read 逐张打开/)
      assert.doesNotMatch(user([{ type: 'image', localPath: '/a/1.png', downloadError: 'x' }]), /张截图：先用 Read/)
      assert.doesNotMatch(user([]), /张截图：先用 Read/)
      // claude 实施续分析会话：增量提示不带任务正文，所以分析提示本身也要带（11-01 真实回放发现漏了）
      assert.match(buildAnalysisPrompt(ctx, { id: 't', text: 'x', attachments: [{ type: 'image', localPath: '/a/1.png' }] }, { text: '', sources: [] }), /附件里有 1 张截图：先用 Read/)
      // 11-03 falive 回放 r3-c：上下文包把群里之前别人发的图挂进附件，结论说成提问人这条带的截图。有非本条附件时清单外注明归属。
      const borrowed = [{ type: 'image', origin: '本条' }, { type: 'image', origin: '群里之前的消息 · Kaiser 10-30 17:27' }]
      const note = /UNTRUSTED_TASK_INPUT\n+来源标「本条」的才是这条消息自己带的；其余是上下文里别人发的，只作前文证据，答复里别说成对方这条发的。/
      assert.match(user(borrowed), note, '数据块之后（可信区）注明归属')
      assert.match(user([{ type: 'file', origin: '话题回复 · A' }]), note)
      assert.match(buildTaskPromptParts(ctx, { id: 't', text: 'x', attachments: borrowed, contract: { v: 1, deliverable: 'verification' } }, 'claude', { ruleContext: { text: '', sources: [] } }).user, note, '实测 / 代答单趟同样')
      assert.match(buildAnalysisPrompt(ctx, { id: 't', text: 'x', attachments: borrowed }, { text: '', sources: [] }), note)
      assert.match(buildTriagePrompt(ctx, { id: 't', text: 'x', attachments: borrowed }, 'facts'), note)
      for (const own of [[], [{ type: 'image', origin: '本条' }], [{ type: 'image', localPath: '/a/1.png' }]]) assert.doesNotMatch(user(own), /来源标「本条」/, '只有本条 / 没标来源不加')
    }],
    ['Bash 命令头：剥 cd / 环境变量前缀；sed -n 算读、sed -i 不算', () => {
      assert.deepEqual(bashCommandHead('cd /x && grep -rn foo src'), { word: 'grep', isReader: true })
      assert.deepEqual(bashCommandHead('A=1 B="x y" /usr/bin/grep foo'), { word: 'grep', isReader: true })
      assert.equal(bashCommandHead("sed -n '1,20p' a.ts").isReader, true)
      assert.equal(bashCommandHead("sed -i '' 's/a/b/' a.ts").isReader, false)
      assert.equal(bashCommandHead('pnpm install').isReader, false)
    }],
    ['审计度量：隔离事实、MCP 暴露、Bash 代读比例、截图 / bug 记录路由、缓存', () => {
      const log = [
        '=== 2026-10-30T00:00:00Z claude task ===',
        line({ type: 'system', subtype: 'init', model: 'm', output_style: 'yolo-chinese', permissionMode: 'bypassPermissions', mcp_servers: [{ name: 'claude.ai Google Drive' }], skills: ['a', 'b', 'c'] }),
        line({ type: 'assistant', message: { content: [
          { type: 'tool_use', name: 'Bash', input: { command: 'cd /r && cat a.ts' } },
          { type: 'tool_use', name: 'Bash', input: { command: 'pnpm test' } },
          { type: 'tool_use', name: 'Read', input: { file_path: '/att/1.png' } },
        ] } }),
        'not json',
        line({ type: 'result', usage: { cache_read_input_tokens: 90, cache_creation_input_tokens: 8, input_tokens: 2 }, total_cost_usd: 0.5, num_turns: 3, permission_denials: [{}] }),
      ].join('\n')
      const sessions = parseAuditLog(log)
      assert.equal(sessions.length, 1)
      const m = summarizeAuditMetrics([
        { audit: { attachments: [{ type: 'image' }], task: { text: 'x' } }, sessions },
        { audit: { attachments: [{ type: 'image' }], task: { text: 'y' } }, sessions: parseAuditLog(line({ type: 'system', subtype: 'init', output_style: 'default', mcp_servers: [] })) },
      ])
      assert.deepEqual(m.isolation.outputStyles, { 'yolo-chinese': 1, default: 1 })
      assert.equal(m.isolation.mcpExposedSessions, 1)
      assert.deepEqual([m.bash.total, m.bash.readers, m.bash.readerRatio], [2, 1, 0.5])
      assert.deepEqual([m.routing.imageTasks, m.routing.imageRead, m.routing.imageReadRatio], [2, 1, 0.5])
      assert.deepEqual([m.cache.readRatio, m.costUsd, m.permissionDenials], [0.9, 0.5, 1])
      // 边角：init 之前的事件 / 非 init 的 system 事件不开会话；缺字段记 unknown / (空)；附件在 task 里也认；读非图片不算看图；用了读记录工具才算
      const edge = parseAuditLog([
        line({ type: 'result', usage: {} }),
        line({ type: 'system', subtype: 'hook_started' }),
        line({ type: 'system', subtype: 'init' }),
        line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }, { type: 'tool_use', name: 'Read', input: { file_path: '/a.ts' } }, { type: 'tool_use', name: 'Bash', input: { command: 'node /x/tools/read-bug-record.mjs u' } }] } }),
        line({ type: 'result', usage: {} }),
      ].join('\n'))
      assert.equal(edge.length, 1)
      assert.deepEqual([edge[0].model, edge[0].permissionMode, edge[0].result.turns], [null, null, 0])
      const link = 'https://x.sg.larksuite.com/record/VpFkrE4D2eXDYHcPkHtlslbRgsf'
      const bashOnly = parseAuditLog([line({ type: 'system', subtype: 'init' }), line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git log' } }, { type: 'tool_use', name: 'Read', input: { file_path: '/x/read-bug-record.mjs' } }] } })].join('\n'))
      const e = summarizeAuditMetrics([{ audit: { task: { text: link, attachments: [{ type: 'image' }] } }, sessions: edge }, { audit: { task: { text: link } }, sessions: bashOnly }])
      assert.deepEqual([e.isolation.models, Object.fromEntries(e.bash.topHeads)], [{ unknown: 2 }, { '(空)': 1, node: 1, git: 1 }])
      assert.deepEqual([e.routing.imageTasks, e.routing.imageRead], [1, 0])
      assert.deepEqual([e.routing.bugLinkTasks, e.routing.bugToolUsed], [2, 1])
      assert.match(formatAuditMetrics(summarizeAuditMetrics([])), /MCP：挂着连接器的会话 0\/0（—）/)
    }],
    ['分析阶段走事件流：命令带 stream-json + eventStream；信封取最后一个 result 事件，整段 JSON 照旧，半行跳过，都没有就抛', () => {
      const analysis = buildAiExecutorCommand({ executor: 'claude', promptText: 'a', cwd: '/tmp/repo', resultKind: 'analysis' })
      assert.equal(analysis.args[analysis.args.indexOf('--output-format') + 1], 'stream-json')
      assert.deepEqual([analysis.eventStream, analysis.resultMode], [true, 'stdout-structured'])
      const stream = [line({ type: 'system', subtype: 'init', session_id: 's1' }), line({ type: 'result', structured_output: { status: 'ready' }, session_id: 's1' }), '{"type":"res'].join('\n')
      assert.deepEqual(parseClaudeEnvelope(stream).structured_output, { status: 'ready' })
      assert.equal(parseClaudeEnvelope(line({ structured_output: { a: 1 }, session_id: 'x' })).session_id, 'x')
      assert.throws(() => parseClaudeEnvelope(line({ type: 'assistant' }) + '\nnot json'))
      assert.equal(parseClaudeEnvelope(`${line({ type: 'result', session_id: 'first' })}\n{"type":"assis`).session_id, 'first', 'result 在第一行、后面是截断半行')
    }],
    ['execAiExecutor：claude 才带隔离 / 系统层；系统层只给分析 / 实施；分析事件流的 result 事件被解析成结构化结果', async () => {
      const calls = []
      const pinned = { claudeModel: 'm', claudeEffort: 'high' }
      const analysis = await execAiExecutor({ executor: 'claude', promptText: 'a', cwd: tmpdir(), localConfig: pinned, resultKind: 'analysis', systemPromptText: 'SYS', spawnImpl: fakeClaude(calls) })
      assert.deepEqual([analysis.result.status, analysis.sessionId], ['ready', 's1'])
      assert.deepEqual([argOf(calls[0].args, '--setting-sources'), argOf(calls[0].args, '--append-system-prompt')], ['project', 'SYS'])
      await execAiExecutor({ executor: 'claude', promptText: 't', cwd: tmpdir(), localConfig: pinned, systemPromptText: 'SYS', spawnImpl: fakeClaude(calls) })
      assert.equal(argOf(calls[1].args, '--append-system-prompt'), 'SYS')
      await execAiExecutor({ executor: 'claude', promptText: 'x', cwd: tmpdir(), localConfig: {}, resultKind: 'intent', systemPromptText: 'SYS', spawnImpl: (cmd, args) => { calls.push({ cmd, args }); throw new Error('stop') } }).catch(() => {})
      assert.equal(calls[2].args.includes('--append-system-prompt'), false, '分类不带系统层')
      assert.equal(calls[2].args.includes('--setting-sources'), false, '没钉模型 / 强度不隔离')
      await execAiExecutor({ executor: 'cursor', promptText: 'x', cwd: mkdtempSync(join(tmpdir(), 'cur-')), localConfig: { ...pinned, claudeSettingSources: 'project' }, systemPromptText: 'SYS', spawnImpl: (cmd, args) => { calls.push({ cmd, args }); throw new Error('stop') } }).catch(() => {})
      assert.equal(calls[3].args.some((a) => a === '--setting-sources' || a === '--append-system-prompt'), false, '非 claude 执行器不吃 claude 参数')
      // 分类单独配模型 / 强度（11-02）：只作用于 intent，分析 / 实施仍走各自的键；没配沿用任务模型与强度。
      const stop = (cmd, args, opts) => { calls.push({ cmd, args, opts }); throw new Error('stop') }
      const intentCfg = { ...pinned, claudeIntentModel: 'fast', claudeIntentEffort: 'low', claudeAnalysisEffort: 'max' }
      await execAiExecutor({ executor: 'claude', promptText: 'x', cwd: tmpdir(), localConfig: intentCfg, resultKind: 'intent', spawnImpl: stop }).catch(() => {})
      await execAiExecutor({ executor: 'claude', promptText: 'x', cwd: tmpdir(), localConfig: intentCfg, resultKind: 'analysis', spawnImpl: stop }).catch(() => {})
      await execAiExecutor({ executor: 'claude', promptText: 'x', cwd: tmpdir(), localConfig: intentCfg, spawnImpl: stop }).catch(() => {})
      await execAiExecutor({ executor: 'claude', promptText: 'x', cwd: tmpdir(), localConfig: pinned, resultKind: 'intent', spawnImpl: stop }).catch(() => {})
      // 配置里都没有：退回调用方传的 model / reasoningEffort，再退回旧参数名 codexModel / codexReasoningEffort。
      await execAiExecutor({ executor: 'claude', promptText: 'x', cwd: tmpdir(), localConfig: {}, model: 'p', reasoningEffort: 'pe', resultKind: 'intent', spawnImpl: stop }).catch(() => {})
      await execAiExecutor({ executor: 'claude', promptText: 'x', cwd: tmpdir(), localConfig: {}, codexModel: 'c', codexReasoningEffort: 'ce', resultKind: 'intent', spawnImpl: stop }).catch(() => {})
      assert.deepEqual(calls.slice(4).map((c) => [argOf(c.args, '--model'), argOf(c.args, '--effort')]), [['fast', 'low'], ['m', 'max'], ['m', 'high'], ['m', 'high'], ['p', 'pe'], ['c', 'ce']])
      // 分类瘦身（11-04 省钱）：只有 intent 带 --safe-mode（不注入本机 CLAUDE.md / 记忆）+ 关提示缓存（单发调用写了读不到）；分析 / 实施照旧走缓存
      assert.deepEqual(calls.slice(4, 7).map((c) => [c.args.includes('--safe-mode'), c.opts?.env?.DISABLE_PROMPT_CACHING ?? null]), [[true, '1'], [false, null], [false, null]])
      assert.equal(calls[4].opts.env.PATH, process.env.PATH, '其它环境变量照传')
    }],
    ['环境版本解析（11-02）：老站 /version 认 React 注释、新站 /wn/<sha>/、只认十六进制；分支映射可覆盖；人话三种落点', () => {
      assert.equal(parseLegacyVersion('<div>Version: <!-- -->13E83A1</div>'), '13e83a1')
      assert.equal(parseLegacyVersion('<div>Version: b0ad0a3</div>'), 'b0ad0a3')
      assert.deepEqual([parseLegacyVersion('Version: unknown'), parseLegacyVersion(''), parseLegacyVersion(null)], [null, null, null])
      assert.equal(parseWebNextCommit('<script src="https://cdn.x.vip/wn/d456f82/assets/a.js">'), 'd456f82')
      assert.deepEqual([parseWebNextCommit('/wn/1005796x/a.js'), parseWebNextCommit('/wn/zz12345/')], [null, null])
      assert.deepEqual([branchForEnv('pre'), branchForEnv('prod', { prod: 'online' })], ['pre', 'online'])
      const info = { found: true, date: '11-02 19:34', author: 'hurley', subject: 's' }
      assert.equal(describeBuild({ label: '老站', sha: null, branch: 'pre' }), '老站：没查到')
      assert.match(describeBuild({ label: '老站', sha: 'abc1234', branch: 'pre', info: { found: false } }), /本地仓库里找不到这个提交/)
      assert.match(describeBuild({ label: '老站', sha: 'abc1234', branch: 'pre', info: { ...info, onBranch: true, behind: 0 } }), /= origin\/pre 最新；这个提交：11-02 19:34 hurley「s」/)
      assert.match(describeBuild({ label: '老站', sha: 'abc1234', branch: 'online', info: { ...info, onBranch: true, behind: 60 } }), /比 origin\/online 最新落后 60 个提交/)
      assert.match(describeBuild({ label: '老站', sha: 'abc1234', branch: 'test', info: { ...info, onBranch: false, behind: null } }), /不在 origin\/test 上/)
      assert.match(describeBuild({ label: '老站', sha: 'abc1234', branch: 'test', info: { ...info, onBranch: null } }), /没核 origin\/test/)
    }],
    ['固定知识（11-02）：读 *.md 按名排序拼接、超长截断注明、没有目录为空；块只在有知识或配了站点时出现；只给只读 / 代答 / 实测提示，改码不带', () => {
      const dir = mkdtempSync(join(tmpdir(), 'kn-'))
      assert.equal(readKnowledge({ dir: join(dir, 'none') }), '')
      writeFileSync(join(dir, 'b.md'), ' 第二份 \n')
      writeFileSync(join(dir, 'a.md'), '第一份')
      writeFileSync(join(dir, 'skip.txt'), '不是 md')
      mkdirSync(join(dir, 'sub.md'))
      assert.equal(readKnowledge({ dir: join(dir) }), '', '读失败（目录名像 md）整块不给')
      const ok = mkdtempSync(join(tmpdir(), 'kn-'))
      writeFileSync(join(ok, 'b.md'), ' 第二份 \n')
      writeFileSync(join(ok, 'a.md'), '第一份')
      writeFileSync(join(ok, 'empty.md'), '  ')
      assert.equal(readKnowledge({ dir: ok }), '第一份\n\n第二份')
      assert.equal(readKnowledge({ dir: ok, maxChars: 3 }), `第一份\n…（固定知识超过 3 字，后面截掉了）`)
      assert.equal(readKnowledge({ dir: ok, maxChars: 8 }), '第一份\n\n第二份', '正好上限不截')
      assert.equal(KNOWLEDGE_MAX_CHARS, 6000)
      assert.equal(buildEnvKnowledgeBlock({}), '')
      assert.equal(buildEnvKnowledgeBlock({ envSites: { test: '  ' } }), '')
      const onlyKnowledge = buildEnvKnowledgeBlock({ knowledge: 'K' })
      assert.match(onlyKnowledge, /【环境与部署/)
      assert.match(onlyKnowledge, /统一叫「老站」「新站」，不写 old site/, '对外叫法统一（11-03 群里冒过 old site）')
      assert.doesNotMatch(onlyKnowledge, /env-version/, '没配站点不提工具')
      const both = buildEnvKnowledgeBlock({ knowledge: 'K', envSites: { pre: 'https://p' } })
      assert.ok(both.includes(`node ${ENV_VERSION_TOOL}`) && both.includes('\nK\n'))
      const ctx = { projectId: '(adhoc)', projectName: 'x', projectDocs: [], cwd: '/tmp/repo' }
      const answer = { id: 'a', text: '现在 pre 跑的哪个版本', attachments: [], contract: { deliverable: 'answer', readOnly: true } }
      const change = { id: 'c', text: '修一下登录', attachments: [], contract: { deliverable: 'change', readOnly: false } }
      const opts = { ruleContext: { text: '', sources: [] }, knowledge: '部署知识原文', envSites: { pre: 'https://p' } }
      const answerPrompt = buildTaskPromptParts(ctx, answer, 'claude', opts).user
      assert.ok(answerPrompt.includes('部署知识原文') && answerPrompt.includes(ENV_VERSION_TOOL))
      const changePrompt = buildTaskPromptParts(ctx, change, 'claude', opts).user
      assert.ok(!changePrompt.includes('部署知识原文') && !changePrompt.includes(ENV_VERSION_TOOL))
      const cmd = buildAiExecutorCommand({ executor: 'claude', promptText: 'x', cwd: '/tmp/repo', readOnly: true, extraReadOnlyCommands: [`node ${ENV_VERSION_TOOL}`] })
      assert.ok(argOf(cmd.args, '--allowedTools').includes(`Bash(node ${ENV_VERSION_TOOL}:*)`))
    }],
    ['runAI：AGENTS.md 遮蔽只对 claude 生效（codex / cursor 原生读 AGENTS.md）', async () => {
      const calls = []
      const exec = async (options) => {
        calls.push(options)
        return { executor: options.executor, result: options.resultKind === 'analysis' ? { status: 'ready', summary: 's', applicableRules: [], requirements: [], blockers: [], scope: null } : { status: 'done', summary: 'ok', checks: [], changedFiles: [], warnings: [] } }
      }
      const task = (aiExecutor) => ({ id: `t-${aiExecutor}`, source: 'lark', text: '修复：按钮颜色', aiExecutor, attachments: [] })
      const deps = { exec, snapshot: () => ({ status: '', diff: '' }), detectAgentsDoc: () => true, hasGlobalRules: () => true }
      const hardRules = /### Source: ~\/\.ai-rules\/AGENT\.md/
      await runAI({ localConfig: {} }, task('claude'), { ...ctx, cwd: tmpdir() }, null, undefined, deps)
      assert.match(calls[1].systemPromptText, /工作目录根的 AGENTS\.md/)
      assert.doesNotMatch(calls[0].promptText, hardRules, 'claude 且本机 CLAUDE.md 带硬规则：不重复注入')
      calls.length = 0
      await runAI({ localConfig: {} }, task('claude'), { ...ctx, cwd: tmpdir() }, null, undefined, { ...deps, hasGlobalRules: () => false })
      assert.match(calls[0].promptText, hardRules, '本机没带（换机器没软链）：照常注入')
      calls.length = 0
      await runAI({ localConfig: {} }, task('cursor'), { ...ctx, cwd: tmpdir() }, null, undefined, deps)
      assert.doesNotMatch(calls[1].promptText, /工作目录根的 AGENTS\.md/)
      assert.match(calls[0].promptText, hardRules, '非 claude 不自动加载，照常注入')
      calls.length = 0
      await runAI({ localConfig: {} }, task('claude'), { ...ctx, cwd: tmpdir() }, null, undefined, { ...deps, detectAgentsDoc: () => false })
      assert.doesNotMatch(calls[1].systemPromptText, /AGENTS\.md/)
    }],
    ['模型配置：空配置 / 旧键兼容（resolveAiModelConfig 从 executor 拆出后仍同口径）', () => {
      assert.deepEqual(resolveAiModelConfig(null, 'claude'), { model: null, reasoningEffort: null, provider: null, analysisModel: null, analysisEffort: null, intentModel: null, intentEffort: null })
      assert.deepEqual([resolveAiModelConfig({ model: 'm', reasoningEffort: 'low' }, 'claude').model, resolveAiModelConfig({ model: 'm', reasoningEffort: 'low' }, 'claude').reasoningEffort], ['m', 'low'])
    }],
    ['体检取数：默认 claude、CLI 失败记 null、版本去空白、非 claude 不起子进程、规则缺失记原因、没钉不隔离', () => {
      const spawned = []
      const spawn = (bin, args) => { spawned.push(args[0]); return args[0] === '--version' ? { status: 0, stdout: ' 2.1.289 \n' } : { status: 1, stdout: 'x' } }
      const facts = collectExecutorFacts({ localConfig: {}, home: '/h', spawn, read: () => '{"outputStyle":"s"}' })
      assert.deepEqual([facts.executor, facts.claudeVersion, facts.claudeHelp, facts.userSettings.outputStyle, facts.settingSources.isolated, facts.globalRulesAutoLoaded], ['claude', '2.1.289', null, 's', false, false])
      assert.equal(facts.rulesError, null)
      assert.deepEqual(spawned, ['--version', '--help'])
      spawned.length = 0
      const codex = collectExecutorFacts({ localConfig: { aiExecutor: 'codex' }, home: '/h', spawn, read: () => { throw new Error('ENOENT') } })
      assert.deepEqual([codex.claudeVersion, codex.claudeHelp, codex.userSettings, spawned.length], [null, null, null, 0])
      assert.equal(collectExecutorFacts({ home: '/h', spawn: () => { throw new Error('ENOENT') }, read: () => '{}' }).claudeVersion, null)
      const noHooks = buildExecutorChecks({ executor: 'claude', claudeVersion: '1', claudeHelp: REQUIRED_CLAUDE_FLAGS.join(' '), userSettings: { hooks: {} }, settingSources: null, rulesError: null })
      const iso = noHooks.find((c) => c.id === 'exec-isolation')
      assert.doesNotMatch(iso.text, /hooks|会漏进去/)
      assert.match(iso.text, /未知/)
    }],
    ['体检执行层：CLI 缺失 / 缺参数是 bad；没隔离是 warn 并列出会漏的个人设置；AGENTS.md 遮蔽是 info；非 claude 跳过', () => {
      const help = REQUIRED_CLAUDE_FLAGS.join(' ')
      const base = { executor: 'claude', claudeVersion: '2.1.289', claudeHelp: help, userSettings: { outputStyle: 'yolo-chinese', hooks: { Stop: [] } }, settingSources: { isolated: true, value: 'project' }, agentsDocShadowed: false, rulesError: null }
      const levels = (facts) => Object.fromEntries(buildExecutorChecks(facts).map((c) => [c.id, c.level]))
      assert.deepEqual(levels(base), { 'exec-cli': 'ok', 'exec-isolation': 'ok' })
      assert.equal(levels({ ...base, claudeVersion: null })['exec-cli'], 'bad')
      assert.equal(levels({ ...base, claudeHelp: '--json-schema' })['exec-flags'], 'bad')
      const leak = buildExecutorChecks({ ...base, settingSources: { isolated: false, reason: '未钉' } }).find((c) => c.id === 'exec-isolation')
      assert.equal(leak.level, 'warn')
      assert.match(leak.text, /outputStyle=yolo-chinese/)
      assert.match(leak.text, /hooks（Stop）/)
      assert.equal(levels({ ...base, agentsDocShadowed: true })['exec-agents-md'], 'info')
      assert.equal(levels({ ...base, rulesError: 'VERIFY-RULE-004' })['exec-rules'], 'bad')
      assert.deepEqual(levels({ ...base, executor: 'codex' }), { 'exec-cli': 'info' })
      assert.equal(levels({ ...base, globalRulesAutoLoaded: false })['exec-global-rules'], 'info')
    }],
  ]))
})
