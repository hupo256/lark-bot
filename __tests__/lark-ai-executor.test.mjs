#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, it } from 'node:test'

import { parseAiExecutorDirective, resolveGatewayAiExecutor } from '../lib/lark-ingest.mjs'
import {
  CLAUDE_HEADLESS_DISALLOWED_TOOLS,
  buildAiExecutorCommand,
  buildClaudeReadinessCommand,
  execAiExecutor,
  executorReadableDirs,
  formatStructuredAiResult,
  isTransientAiError,
  preflightAiExecutor,
  resolveAiExecutor,
  validateAiExecutor,
} from '../lib/lark-ai-executor.mjs'
import {
  buildClaudeResultFileInstruction,
  buildClaudeResultRecoveryInstruction,
  parseStructuredAiResult,
  parseStructuredAnalysisValue,
  parseStructuredIntentResult,
} from '../lib/lark-ai-result.mjs'
import { buildQueuedCard, buildResultCard, buildWaitingCard, resolveOwnerMention } from '../lib/lark-cards.mjs'
import { scanDiffForViolations } from '../lib/lark-lint-diff.mjs'
import { buildFocusedRuleContext } from '../lib/lark-rule-context.mjs'
import { larkBotRoot } from '../lib/lark-paths.mjs'
import { requestJson } from '../lib/lark-gateway-client.mjs'
import { gatewayStatusForAiStatus, isCompletedAiStatus } from '../lib/lark-status-meta.mjs'
import { normalizeAnalysisForTask } from '../lib/lark-worker-run.mjs'
import {
  buildAnalysisPrompt,
  buildIntentClassificationPrompt,
  buildTaskPrompt,
  buildTriagePrompt,
  buildValidationRequirements,
  resolveTaskMode,
} from '../lib/lark-worker-prompts.mjs'
import { eachCase, runSteps } from './support/steps.mjs'

describe('AI executor selection', () => {
  it('执行器选择：固定枚举校验、task > local config > wrapper > default 优先级、群消息首位指令解析、Gateway 入队解析默认值', () => runSteps([
    ['只接受已知 CLI 执行器固定枚举', () => {
      assert.equal(validateAiExecutor(' Claude '), 'claude')
      assert.equal(validateAiExecutor('CLAUDE'), 'claude')
      // 第 3 批：codex / pi / cursor 已删，只剩 claude
      assert.throws(() => validateAiExecutor('codex'), /must be one of/)
      assert.throws(() => validateAiExecutor('bash -c whoami'), /must be one of/)
    }],
    ['优先级为 task > local config > wrapper > default', () => {
      const worker = { aiExecutor: 'claude', localConfig: { aiExecutor: 'claude' } }
      assert.equal(resolveAiExecutor(worker, { aiExecutor: 'claude' }), 'claude')
      assert.equal(resolveAiExecutor(worker, {}), 'claude')
      assert.equal(resolveAiExecutor({ aiExecutor: 'claude', localConfig: {} }, {}), 'claude')
      assert.equal(resolveAiExecutor({ localConfig: {} }, {}), 'claude')
    }],
    ['群消息识别首个文本位置的安全选择指令，标签后无需空格', () => {
      assert.equal(parseAiExecutorDirective('[codex] 修复登录页'), 'codex')
      assert.equal(parseAiExecutorDirective('[codex]这里有明显颜色重叠'), 'codex')
      assert.equal(parseAiExecutorDirective(' [CLAUDE] 看这里'), 'claude')
      assert.equal(parseAiExecutorDirective('[claude]直接处理'), 'claude')
      assert.equal(parseAiExecutorDirective('[pi] 处理这个'), 'pi')
      assert.equal(parseAiExecutorDirective('[cursor]看一下'), 'cursor')
      assert.equal(parseAiExecutorDirective('![Image](img_v3_demo) [codex] 这个选项是接口还是写死的'), 'codex')
      assert.equal(parseAiExecutorDirective('![Image](img_1)\n![Image](img_2)\n[CLAUDE] 看两个截图'), 'claude')
      assert.equal(parseAiExecutorDirective('[Image: img_v3_fallback]\n[codex]排查这里'), 'codex')
      assert.equal(parseAiExecutorDirective('修复 [codex] 登录页'), undefined)
      assert.equal(parseAiExecutorDirective('![Image](img_v3_demo) 先看截图 [codex] 再处理'), undefined)
      assert.equal(parseAiExecutorDirective('[shell] whoami'), undefined)
    }],
    ['Gateway 入队时解析有效执行器，确保领取卡展示默认值', () => {
      const config = { aiExecutor: 'claude' }
      assert.equal(resolveGatewayAiExecutor({ config }), 'claude')
      assert.equal(resolveGatewayAiExecutor({ requestedExecutor: 'claude', config }), 'claude')
      assert.equal(resolveGatewayAiExecutor({ config: {} }), 'claude') // fallback to DEFAULT_EXECUTOR
    }],
  ]))
})

describe('claude headless command', () => {
  it('Claude 无头任务命令：stream-json 事件流、摘掉结束本轮 / 排程 / 甩活工具（lessons #31）、--resume 续会话、结果文件与补写指令', () => runSteps([
    ['Claude 启用 stream-json 事件流（供审计与空闲超时），最终结果仍走结构化 resultPath', () => {
      const command = buildAiExecutorCommand({ executor: 'claude', promptText: 'fix it', cwd: '/tmp/repo' })
      assert.deepEqual(command.args, [
        '-p', '--dangerously-skip-permissions',
        '--disallowedTools', ...CLAUDE_HEADLESS_DISALLOWED_TOOLS,
        '--output-format', 'stream-json', '--verbose', '--include-partial-messages', 'fix it',
      ])
      assert.equal(command.eventStream, true)
      assert.equal(command.resultMode, 'structured')
    }],
    ['Claude 无头任务模式摘掉会结束本轮 / 排程 / 甩活的内建工具（lessons #31），变长参数后紧跟下一个 -- 选项', () => {
      const command = buildAiExecutorCommand({ executor: 'claude', promptText: 'fix it', cwd: '/tmp/repo', readableDirs: ['/tmp/ref'] })
      for (const tool of ['ScheduleWakeup', 'CronCreate', 'Workflow', 'RemoteTrigger', 'EnterWorktree']) {
        assert.ok(CLAUDE_HEADLESS_DISALLOWED_TOOLS.includes(tool), tool)
      }
      const at = command.args.indexOf('--disallowedTools')
      assert.ok(at > 0)
      assert.equal(command.args[at + 1 + CLAUDE_HEADLESS_DISALLOWED_TOOLS.length], '--output-format')
      // 只读分类 / 分诊走 --tools 白名单，本来就没有这些工具，不重复加
      assert.equal(buildAiExecutorCommand({ executor: 'claude', promptText: 'x', cwd: '/tmp/repo', resultKind: 'intent' }).args.includes('--disallowedTools'), false)
    }],
    ['Claude 任务模式可 --resume 续会话（结果文件补写用），紧跟在 --output-format 前', () => {
      const command = buildAiExecutorCommand({ executor: 'claude', promptText: 'write result', cwd: '/tmp/repo', resumeSessionId: 'sess-1' })
      const at = command.args.indexOf('--resume')
      assert.deepEqual(command.args.slice(at, at + 3), ['--resume', 'sess-1', '--output-format'])
      assert.equal(buildAiExecutorCommand({ executor: 'claude', promptText: 'x', cwd: '/tmp/repo' }).args.includes('--resume'), false)
    }],
    ['结果文件指令要求全程同步、禁止后台 / 排程等待；补写指令只写文件不重跑', () => {
      const instruction = buildClaudeResultFileInstruction('/tmp/r/result.json')
      assert.match(instruction, /同步执行/)
      assert.match(instruction, /run_in_background/)
      assert.match(instruction, /绝不能不写结果就结束/)
      const recovery = buildClaudeResultRecoveryInstruction('/tmp/r/result.json', 'ENOENT: no such file')
      assert.match(recovery, /ENOENT: no such file/)
      assert.match(recovery, /不要重跑任务/)
      assert.match(recovery, /\/tmp\/r\/result\.json/)
    }],
    ['AI 硬超时：两个环境变量都没设默认 30 分钟；LARK_WORKER_AI_TIMEOUT_MS 优先，旧名 LARK_WORKER_CODEX_TIMEOUT_MS 仍兼容（变异补测 10-24）', () => {
      // 常量在模块加载时读环境变量：每种环境起一个干净子进程 import，读导出的 aiTimeoutMs。
      const moduleUrl = pathToFileURL(join(larkBotRoot, 'lib/lark-ai-executor.mjs')).href
      const timeoutWith = (vars) => {
        const env = { ...process.env }
        delete env.LARK_WORKER_AI_TIMEOUT_MS
        delete env.LARK_WORKER_CODEX_TIMEOUT_MS
        Object.assign(env, vars)
        const res = spawnSync(process.execPath, ['--input-type=module', '-e', `const { aiTimeoutMs } = await import(${JSON.stringify(moduleUrl)}); process.stdout.write('AI_TIMEOUT=' + aiTimeoutMs)`], { env, encoding: 'utf8' })
        assert.equal(res.status, 0, res.stderr)
        return Number(res.stdout.match(/AI_TIMEOUT=(\d+)/)?.[1])
      }
      assert.equal(timeoutWith({}), 1800000, '都没设默认 30 分钟')
      assert.equal(timeoutWith({ LARK_WORKER_AI_TIMEOUT_MS: '600000' }), 600000, '设了新名按新名')
      assert.equal(timeoutWith({ LARK_WORKER_CODEX_TIMEOUT_MS: '900000' }), 900000, '只设旧名按旧名')
      assert.equal(timeoutWith({ LARK_WORKER_AI_TIMEOUT_MS: '600000', LARK_WORKER_CODEX_TIMEOUT_MS: '900000' }), 600000, '两个都设新名优先')
    }],
  ]))

  it('Claude 只读面：readiness probe、意图分类只开 Read + plan、只读分析含 scope Schema、分析结果解析、只读放行目录', () => runSteps([
    ['Claude readiness probe 只读、不指定模型（与任务命令同一模型来源）', () => {
      const command = buildClaudeReadinessCommand()
      assert.equal(command.cmd, 'claude')
      assert.deepEqual(command.args.slice(command.args.indexOf('--permission-mode'), command.args.indexOf('--permission-mode') + 2), ['--permission-mode', 'plan'])
      assert.equal(command.args.includes('--model'), false)
      assert.equal(command.args.includes('--dangerously-skip-permissions'), false)
      assert.match(command.args.at(-1), /CLAUDE_MODEL_READY$/)
    }],
    ['Claude 意图分类只开放 Read + plan，不使用无人值守写权限', () => {
      const command = buildAiExecutorCommand({
        executor: 'claude',
        promptText: 'classify it',
        cwd: '/tmp/repo',
        resultPath: '/tmp/intent.json',
        resultKind: 'intent',
        readOnly: true,
      })
      assert.equal(command.resultMode, 'stdout-structured')
      assert.deepEqual(command.args.slice(command.args.indexOf('--permission-mode'), command.args.indexOf('--permission-mode') + 2), ['--permission-mode', 'plan'])
      assert.deepEqual(command.args.slice(command.args.indexOf('--tools'), command.args.indexOf('--tools') + 2), ['--tools', 'Read'])
      assert.equal(command.args.includes('--dangerously-skip-permissions'), false)
      assert.ok(command.args.includes('--json-schema'))
      // cwd 外的附件 / PRD 缓存 / 存量项目经 --add-dir 放行；变长参数之后必须紧跟选项，prompt 仍在末尾
      const addDirAt = command.args.indexOf('--add-dir')
      assert.ok(addDirAt > 0)
      assert.ok(command.args.slice(addDirAt + 1).find((a) => a.startsWith('--')))
      assert.equal(command.args.at(-1), 'classify it')
    }],
    ['Claude 只读分析：无写工具、不跳过权限，--json-schema 用含 scope 的分析 Schema，结果走 stdout', () => {
      const command = buildAiExecutorCommand({
        executor: 'claude',
        promptText: 'analyze it',
        cwd: '/tmp/repo',
        resultPath: '/tmp/analysis.json',
        resultKind: 'analysis',
      })
      assert.equal(command.resultMode, 'stdout-structured')
      assert.deepEqual(command.args.slice(command.args.indexOf('--tools'), command.args.indexOf('--tools') + 2), ['--tools', 'Read,Grep,Glob,Bash'])
      assert.equal(command.args.includes('--dangerously-skip-permissions'), false)
      assert.match(command.args[command.args.indexOf('--allowedTools') + 1], /^Bash\(git log:\*\)/)
      const schema = JSON.parse(command.args[command.args.indexOf('--json-schema') + 1])
      assert.equal(schema.$schema, undefined)
      assert.ok(schema.required.includes('scope'))
      assert.equal(command.args.at(-1), 'analyze it')
    }],
    ['分析结果解析：claude envelope（含代码围栏）可解析，scope 只认对象 / null', () => {
      const analysis = { status: 'ready', summary: 'ok', applicableRules: [], requirements: [], blockers: [], scope: null }
      assert.deepEqual(parseStructuredAnalysisValue(`\`\`\`json\n${JSON.stringify(analysis)}\n\`\`\``), analysis)
      assert.throws(() => parseStructuredAnalysisValue({ ...analysis, scope: [] }), /scope 必须是对象或 null/)
      assert.throws(() => parseStructuredAnalysisValue({ ...analysis, status: 'done' }), /合法 status/)
    }],
    ['只读放行目录覆盖 lark-bot 仓库，且只含实际存在的目录', () => {
      const dirs = executorReadableDirs()
      assert.ok(dirs.length >= 1)
      assert.ok(dirs.every((dir) => existsSync(dir)))
      assert.ok(dirs.includes(realpathSync(larkBotRoot)))
    }],
    ['预检结果按执行器 + 模型缓存：已预检过不重复跑 CLI；要求模型探针时只有探针通过过的缓存才算数，通过后不再重复探（变异补测 10-24）', () => {
      const bin = mkdtempSync(join(tmpdir(), 'lark-preflight-bin-'))
      const log = join(bin, 'calls.log')
      const savedPath = process.env.PATH
      try {
        writeFileSync(join(bin, 'claude'), `#!/bin/sh\necho "$1" >> '${log}'\nif [ "$1" = "--version" ]; then echo '9.9.9 (fake)'; exit 0; fi\necho CLAUDE_MODEL_READY\n`)
        chmodSync(join(bin, 'claude'), 0o755)
        process.env.PATH = `${bin}:${savedPath}`
        const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [])
        // 模型名唯一：缓存是模块级的，不和别的用例串。
        const localConfig = { claudeModel: 'mutfix-preflight-model' }
        const first = preflightAiExecutor('claude', { localConfig })
        assert.equal(first.modelProbe, 'not_run')
        assert.deepEqual(calls(), ['--version'])
        assert.equal(preflightAiExecutor('claude', { localConfig }), first, '已预检过直接用缓存')
        assert.deepEqual(calls(), ['--version'], '不重复跑 --version')
        const probed = preflightAiExecutor('claude', { localConfig, probeModel: true })
        assert.equal(probed.modelProbe, 'passed')
        assert.deepEqual(calls(), ['--version', '--version', '-p'], '缓存没探过模型 → 要求探针时重新预检并真探一次')
        assert.equal(preflightAiExecutor('claude', { localConfig, probeModel: true }), probed, '探针通过过的缓存直接用')
        assert.equal(preflightAiExecutor('claude', { localConfig }), probed)
        assert.equal(calls().length, 3, '探过之后不再重复烧模型请求')
      } finally {
        process.env.PATH = savedPath
        rmSync(bin, { recursive: true, force: true })
      }
    }],
  ]))

})

describe('task-mention intent classification', () => {
  it('意图分类：解析合法分类拒绝缺字段、兼容完整代码围栏拒绝围栏外文字、Prompt 标群消息不可信且歧义时 ignore', () => runSteps([
    ['解析合法分类并拒绝缺字段结果', () => {
      const result = parseStructuredIntentResult({
        decision: 'bug',
        confidence: 'high',
        summary: '修复登录页报错',
        reason: '明确描述了报错',
      }, 'claude')
      assert.equal(result.decision, 'bug')
      assert.throws(() => parseStructuredIntentResult({ decision: 'bug' }), /confidence/)
      assert.throws(() => parseStructuredIntentResult('{bad json'), /未返回合法意图分类结果/)
    }],
    ['Claude 兼容完整 JSON 代码围栏，但拒绝围栏外的解释文字', () => {
      const fenced = '```json\n{"decision":"requirement","confidence":"medium","summary":"调整页面规则","reason":"明确交办产品行为变更"}\n```'
      assert.equal(parseStructuredIntentResult(fenced, 'claude').decision, 'requirement')
      assert.throws(
        () => parseStructuredIntentResult(`分类结果如下：\n${fenced}`, 'claude'),
        /未返回合法意图分类结果/,
      )
    }],
    ['分类 Prompt 把群消息标为不可信并明确歧义时 ignore', () => {
      const prompt = buildIntentClassificationPrompt({
        text: '这个按钮不对，帮忙修一下',
        attachments: [{ type: 'image', localPath: '/tmp/screenshot.png' }],
      })
      assert.match(prompt, /UNTRUSTED_LARK_MESSAGE/)
      assert.match(prompt, /有歧义时必须 decision=ignore/)
      assert.match(prompt, /\/tmp\/screenshot\.png/)
    }],
  ]))
})

describe('focused rule loading and two-phase prompts', () => {
  it('精准规则加载与两阶段 Prompt：tips 任务命中文案契约、分析 Prompt 注入规则原文、实现 Prompt 注入 ready 结论', () => runSteps([
    ['tips/Tooltip 任务精准命中文案契约，并保留来源与指纹', () => {
      const context = buildFocusedRuleContext({ taskText: '这些标题 hover 时加上 tips' })
      assert.equal(context.scenario, 'write_ui')
      assert.ok(context.sources.some((item) => item.section.includes('文案契约')))
      assert.match(context.text, /文案契约/)
      assert.match(context.fingerprint, /^[a-f0-9]{16}$/)
    }],
    ['分析 Prompt 注入规则原文；实现 Prompt 注入 ready 结论', () => {
      const workContext = { projectId: 'PR-00001', projectName: 'test', projectDocs: [], cwd: '/tmp/repo' }
      const task = { id: 'task-1', text: '标题加 tips', attachments: [] }
      const ruleContext = {
        scenario: 'write_ui',
        fingerprint: 'abc123',
        aiRulesRevision: 'aaa1111',
        larkBotRevision: 'bbb2222',
        sources: [{ path: 'common/rule.md', section: '## Copy', sha256: 'deadbeef' }],
        text: '权威规则：文案必须来自 PRD。',
      }
      const analysis = {
        status: 'ready',
        summary: '文案已存在',
        applicableRules: [{ source: 'common/rule.md', application: '复用 PRD 文案' }],
        requirements: ['不得自造文案'],
        blockers: [],
      }
      const analysisPrompt = buildAnalysisPrompt(workContext, task, ruleContext)
      assert.match(analysisPrompt, /第一阶段只读分析/)
      assert.match(analysisPrompt, /权威规则：文案必须来自 PRD/)
      assert.match(analysisPrompt, /规则指纹：abc123/)
      assert.match(analysisPrompt, /规则来源版本：~\/\.ai-rules@aaa1111 · lark-bot@bbb2222/)

      const implementationPrompt = buildTaskPrompt(workContext, task, 'codex', { ruleContext, analysis })
      assert.match(implementationPrompt, /第一阶段只读分析已判定 ready/)
      assert.match(implementationPrompt, /不得自造文案/)
      assert.match(implementationPrompt, /权威规则：文案必须来自 PRD/)
    }],
  ]))
})

describe('risk-based validation policy', () => {
  it('验证策略：resolveTaskMode 三态优先级、L1 样式跳过 type-check、任务 Prompt 只留风险分级、视觉验证只复用现有页面', () => runSteps([
    ['resolveTaskMode 三态优先级：只读 > 测试反馈 > 常规', () => {
      assert.equal(resolveTaskMode({ commandType: 'status', text: '状态：x' }), 'readOnly')
      assert.equal(resolveTaskMode({ source: 'lark-bugtable', commandType: 'qa' }), 'testFeedback')
      assert.equal(resolveTaskMode({ source: 'lark', commandType: 'fix', text: '修复：x' }), 'testFeedback')
      assert.equal(resolveTaskMode({ source: 'manual-api', commandType: 'fix' }), 'regular')
      assert.equal(resolveTaskMode({ source: 'lark', commandType: 'docs' }), 'regular')
    }],
    ['L1 样式改动跳过 type-check，验证使用本地二进制并预防缓存/网络问题', () => {
      const policy = buildValidationRequirements()
      assert.match(policy, /L1 样式/)
      assert.match(policy, /无需 type-check/)
      assert.match(policy, /node_modules\/\.bin\/vitest run --no-cache/)
      assert.match(policy, /pnpm --filter fameex install --frozen-lockfile --prefer-offline/)
      assert.match(policy, /同一检查最多执行一次/)
      assert.match(policy, /自动视觉验收默认关闭/)
      assert.match(policy, /不要启动 dev server/)
      assert.match(policy, /默认跳过不是 warning/)
    }],
    ['任务 Prompt 只保留风险分级策略，不再强制每个 apps/web 改动跑 tsc', () => {
      const prompt = buildTaskPrompt(
        { projectId: 'PR-00001', projectName: 'test', projectDocs: [], cwd: '/tmp/repo', hotfixBranch: 'hotfix/test' },
        { id: 'task-1', text: '调整圆角', attachments: [] },
        'codex',
      )
      assert.match(prompt, /按最终 diff 风险分级/)
      assert.doesNotMatch(prompt, /cd apps\/web && pnpm exec tsc --noEmit/)
      assert.match(prompt, /必需检查完成后立即结束/)
      assert.match(prompt, /done_with_warnings/)
      assert.match(prompt, /不得误判 failed/)
      assert.match(prompt, /任务没有明确要求视觉验证/)
      assert.match(prompt, /跳过 Browser \/ Playwright，禁止启动 dev server/)
      assert.match(prompt, /必需检查通过就尽快返回 done/)
    }],
    ['明确要求视觉验证时只复用现有页面，不在沙箱启动开发服务', () => {
      const prompt = buildTaskPrompt(
        { projectId: 'PR-01947', projectName: 'test', projectDocs: [], cwd: '/tmp/repo' },
        { id: 'task-visual', source: 'lark', text: '修复后用 Playwright 做视觉验收', commandType: null, attachments: [] },
        'codex',
      )
      assert.match(prompt, /任务明确要求视觉验证/)
      assert.match(prompt, /只复用已经运行且可访问的页面/)
      assert.match(prompt, /不要在 Codex 沙箱内启动 dev server/)
    }],
  ]))

  it('测试反馈与 G2：群内反馈直接实施、群任务 / Bug 表流程阻塞降级而范围歧义保留、非测试反馈来源不扩权、状态查询零改动成功', () => runSteps([
    ['群内测试反馈不分 L1/L2/L3，范围明确就不重复跑同步或 G2 门禁', () => {
      const task = {
        id: 'task-feedback',
        source: 'lark',
        text: 'QA：提交后补充局部校验，并调整错误提示',
        commandType: 'qa',
        attachments: [],
      }
      const analysisPrompt = buildAnalysisPrompt(
        { projectId: 'PR-01947', projectName: 'test', projectDocs: [], cwd: '/tmp/repo' },
        task,
        { scenario: 'write_ui', signals: ['ui'], sources: [], text: '已加载 UI 规则。' },
      )
      const prompt = buildTaskPrompt(
        { projectId: 'PR-01947', projectName: 'test', projectDocs: [], cwd: '/tmp/repo' },
        task,
        'codex',
        {
          ruleContext: {
            scenario: 'write_ui',
            signals: ['ui'],
            sources: [],
            text: '已加载 UI 规则。',
          },
          analysis: {
            status: 'ready',
            summary: '目标已定位到现有提交表单。',
            applicableRules: [],
            requirements: ['只改当前表单校验与提示'],
            blockers: [],
          },
        },
      )
      const docsList = prompt.slice(prompt.indexOf('请在 /tmp/repo 中完成任务'), prompt.indexOf('Worker 已按任务语义精准加载'))
      assert.doesNotMatch(docsList, /lark-doc-sync\.md/)
      // bot 边界文档给 lark-bot 仓库内的绝对路径（cwd 是业务 worktree，相对路径读不到）
      assert.ok(docsList.includes(join(larkBotRoot, 'docs/task-boundaries-and-reply.md')))
      assert.match(analysisPrompt, /修改范围/)
      assert.match(analysisPrompt, /缺 G2、README、技术方案、rule session、历史 gate 证据/)
      assert.match(analysisPrompt, /范围能从现有事实唯一确定时必须返回 ready/)
      assert.match(prompt, /测试反馈直接实施路径/)
      assert.match(prompt, /此路径不限于 L1/)
      assert.match(prompt, /不要自行运行 Lark 同步/)
      assert.match(prompt, /不要运行 docs-tdd context \/ changed \/ gate/)
      assert.match(prompt, /唯一需要人工确认的需求问题是修改范围/)
      assert.match(prompt, /不得仅因缺 G2、PRD、Figma、QA 文档、README、技术方案或历史 gate 证据返回 waiting_confirmation/)
    }],
    ['群任务和 Bug 表的 G2 流程阻塞都会降级，真实范围歧义仍保留', () => {
      // 正文不再是可省的：降级资格现在由 workKind 决定（缺陷反馈可免流程材料，新需求不可），
      // 详见 lark-work-policy.test.mjs。这里给出典型缺陷反馈正文。
      const groupTask = { source: 'lark', commandType: null, text: '错误提示不显示' }
      const bugTableTask = { source: 'lark-bugtable', commandType: null, text: '输入框错误态不对' }
      const g2Analysis = {
        status: 'blocked',
        summary: '缺少 G2 定稿证据',
        applicableRules: [],
        requirements: [],
        blockers: ['当前项目缺少 G2、README 和技术方案，当前不能依规进入实施'],
      }
      const groupResult = normalizeAnalysisForTask(groupTask, g2Analysis)
      const bugTableResult = normalizeAnalysisForTask(bugTableTask, g2Analysis)
      assert.equal(groupResult.status, 'ready')
      assert.deepEqual(groupResult.blockers, [])
      assert.equal(bugTableResult.status, 'ready')
      assert.deepEqual(bugTableResult.blockers, [])

      const bugTablePrompt = buildAnalysisPrompt(
        { projectId: 'PR-01947', projectName: 'test', projectDocs: [], cwd: '/tmp/repo' },
        { ...bugTableTask, id: 'record-1', text: '输入框错误态不对', attachments: [] },
        { scenario: 'write_ui', signals: ['ui'], sources: [], text: '已加载 UI 规则。' },
      )
      assert.match(bugTablePrompt, /来自白名单项目群或 Bug 表/)
      assert.match(bugTablePrompt, /范围能从现有事实唯一确定时必须返回 ready/)

      const ambiguous = normalizeAnalysisForTask(bugTableTask, {
        status: 'blocked',
        summary: '存在两个候选页面',
        applicableRules: [],
        requirements: [],
        blockers: ['消息无法定位目标页面：现货和合约页均有同名控件，需要确认修改范围'],
      })
      assert.equal(ambiguous.status, 'blocked')
      assert.deepEqual(ambiguous.blockers, ['消息无法定位目标页面：现货和合约页均有同名控件，需要确认修改范围'])
    }],
    ['非测试反馈来源保持原 G2 判定，不被扩权', () => {
      const externalTask = { source: 'manual-api', commandType: 'qa' }
      const analysis = {
        status: 'blocked',
        summary: '缺少 G2',
        applicableRules: [],
        requirements: [],
        blockers: ['缺少 G2 定稿证据'],
      }
      assert.equal(normalizeAnalysisForTask(externalTask, analysis), analysis)
    }],
    ['状态查询 Prompt 明确零改动成功', () => {
      const task = {
        id: 'status-1',
        source: 'lark-bugtable',
        commandType: 'status',
        text: '状态：这个项目现在的状态是？',
        attachments: [],
      }
      const prompt = buildTaskPrompt(
        { projectId: 'PR-01947', projectName: '跟单设置', projectDocs: [], cwd: '/tmp/repo' },
        task,
        'codex',
        { ruleContext: { scenario: 'g4_coding_worktree', sources: [], text: '只读规则。' } },
      )
      assert.match(prompt, /本任务是只读信息查询/)
      assert.match(prompt, /changedFiles 必须为 \[\]/)
      assert.match(prompt, /无代码改动是正确结果/)
      assert.doesNotMatch(prompt, /编码规范（改任何代码前必做/)
    }],
  ]))
})

describe('Gateway transient retry', () => {
  it('Gateway 瞬时重试：幂等请求遇 ECONNRESET 重试成功，claim 类默认不重试', () => runSteps([
    ['幂等请求遇到 ECONNRESET 会重试并成功', async () => {
      let calls = 0
      const fetchImpl = async () => {
        calls += 1
        if (calls < 3) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } })
        return { ok: true, json: async () => ({ ok: true }) }
      }
      const result = await requestJson('http://127.0.0.1:3005', '/status', { retryTransient: true }, { fetchImpl, sleepImpl: async () => {} })
      assert.deepEqual(result, { ok: true })
      assert.equal(calls, 3)
    }],
    ['claim 类调用默认不重试，避免重复领取', async () => {
      let calls = 0
      const fetchImpl = async () => {
        calls += 1
        throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } })
      }
      await assert.rejects(() => requestJson('http://127.0.0.1:3005', '/claim', { method: 'POST' }, { fetchImpl, sleepImpl: async () => {} }), /fetch failed/)
      assert.equal(calls, 1)
    }],
  ]))
})

describe('AI 子进程瞬时错误识别（决定是否自动重试）', () => {
  // 每行：name 保留原用例标题（瞬时 / 非瞬时两组原为模板标题）；transient 为期望判定。
  const transientCases = [
    // PR-02273 实况：claude exec 退出码 1，audit 里是这条。此前无此分类 → 直接判 failed 逼人工重试。
    { name: 'claude 连接中途断开被判为瞬时', sample: 'API Error: Connection closed mid-response. The response above may be incomplete.', transient: true },
    ...[
      'overloaded_error: server is overloaded',
      'HTTP 529 too many requests',
      'Error: socket hang up',
      'connect ECONNRESET 1.2.3.4:443',
      'rate limit exceeded, please retry',
      'upstream 503 Service Unavailable',
      'fetch failed',
    ].map((sample) => ({ name: `瞬时：${sample.slice(0, 32)}`, sample, transient: true })),
    ...[
      'API Error: 401 invalid api key',
      'API Error: 400 invalid model name',
      'permission denied: not logged in',
      'SyntaxError: Unexpected token in prompt',
      '',
      null,
      undefined,
    ].map((sample) => ({ name: `非瞬时（永久错误/空，不应重试）：${String(sample).slice(0, 32)}`, sample, transient: false })),
  ]

  it('claude 连接中途断开与过载 / 限流 / 网络抖动判瞬时；永久错误与空值判非瞬时、不应重试', () => eachCase(transientCases, ({ name, sample, transient }) => {
    assert.equal(isTransientAiError(sample), transient, name)
  }))
})
describe('structured result and cards', () => {
  const result = {
    status: 'done',
    summary: '修复登录按钮颜色。',
    checks: ['button.test.tsx 通过'],
    changedFiles: ['apps/web/button.tsx'],
  }

  it('结构化结果转回执：done 群卡精简、只读查询显示查询完成、done_with_warnings 映射 done 并保留验证提醒', () => runSteps([
    ['Worker 把结构化结果转成稳定回执（群卡精简：不列验证/文件明细）', () => {
      const text = formatStructuredAiResult(result)
      assert.match(text, /^已完成。/)
      assert.doesNotMatch(text, /执行器：codex/)
      assert.match(text, /修复登录按钮颜色。/)
      // 验证/文件等实现细节不上群卡
      assert.doesNotMatch(text, /button.test.tsx 通过/)
      assert.doesNotMatch(text, /文件：/)
    }],
    ['只读状态查询使用“查询完成”结论，不显示待发布', () => {
      const text = formatStructuredAiResult({ ...result, changedFiles: [] }, { readOnly: true })
      assert.match(text, /^查询完成。/)
      assert.doesNotMatch(text, /待发布/)
    }],
    ['实现完成但 Playwright 环境不可用时映射为 done，并在群卡保留验证提醒', () => {
      const resultWithWarnings = {
        status: 'done_with_warnings',
        summary: '样式改动已完成且 L1 代码检查通过。',
        checks: ['git diff --check 通过', 'Biome 通过'],
        changedFiles: ['apps/web/src/apps/CopyTrading/components/CopySetting/KolProfile.tsx'],
        warnings: ['Playwright 页面验证因本地端口权限不可用未执行'],
        blockers: null,
        owner: null,
        failureKind: null,
        nextStep: null,
      }
      const text = formatStructuredAiResult(resultWithWarnings)
      assert.equal(isCompletedAiStatus(resultWithWarnings.status), true)
      assert.equal(gatewayStatusForAiStatus(resultWithWarnings.status), 'done')
      assert.match(text, /^已完成（有验证提醒）。/)
      assert.match(text, /验证提醒：Playwright 页面验证因本地端口权限不可用未执行/)
      assert.doesNotMatch(text, /处理失败/)
    }],
  ]))

  it('结构化结果解析与分诊：done_with_warnings 须列 warnings、缺陷分诊门禁（VERIFY-TASK-001）、正文分诊行', () => runSteps([
    ['结构化结果解析接受 done_with_warnings，并拒绝缺少 warnings 的伪完成', () => {
      const dir = mkdtempSync(join(tmpdir(), 'lark-result-test-'))
      const resultPath = join(dir, 'result.json')
      const base = {
        status: 'done_with_warnings',
        summary: '页面已修复。',
        checks: ['Biome 通过'],
        changedFiles: ['apps/web/Page.tsx'],
        warnings: ['Playwright 环境不可用'],
        blockers: null,
        owner: null,
        failureKind: null,
        nextStep: null,
      }
      try {
        writeFileSync(resultPath, JSON.stringify(base))
        assert.deepEqual(parseStructuredAiResult(resultPath), base)
        writeFileSync(resultPath, JSON.stringify({ ...base, warnings: [] }))
        assert.throws(() => parseStructuredAiResult(resultPath), /必须列出 warnings/)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }],
    ['缺陷分诊门禁（VERIFY-TASK-001）：后端根因缺证据 / 后端根因关单无转交均拒收，合规与旧形态放行', () => {
      const dir = mkdtempSync(join(tmpdir(), 'lark-diag-test-'))
      const resultPath = join(dir, 'result.json')
      const base = {
        status: 'done', summary: '已定位并转交后端。', checks: ['已读 Network'], changedFiles: [],
        warnings: [], blockers: null, owner: '后端', failureKind: null, nextStep: null,
      }
      const evidence = { userSeenValue: '79.40', apiActualValue: '79.40', contractExpectedValue: '146.03', dataFlowFirstErrorLocation: 'API availableTrialFee' }
      const write = (o) => { writeFileSync(resultPath, JSON.stringify(o)); return resultPath }
      try {
        // 旧形态（无新字段）仍放行
        assert.deepEqual(parseStructuredAiResult(write(base)), base)
        // 后端根因缺证据 → 拒收
        assert.throws(() => parseStructuredAiResult(write({ ...base, rootCauseLayer: 'backend-data', taskState: 'awaiting_owner_fix', evidence: null })), /必须给出 evidence/)
        // 后端根因标 completed 但 blockers 无转交项 → 拒收
        assert.throws(() => parseStructuredAiResult(write({ ...base, rootCauseLayer: 'backend-data', taskState: 'completed', evidence, blockers: null })), /不能标 taskState=completed 关单/)
        // 后端根因 + 证据 + awaiting_owner_fix + 转交项 → 放行
        const ok = { ...base, rootCauseLayer: 'backend-data', taskState: 'awaiting_owner_fix', evidence, blockers: ['availableTrialFee 漏未激活，转后端'] }
        assert.deepEqual(parseStructuredAiResult(write(ok)), ok)
        // 前端根因 completed 无需证据 → 放行
        const feOk = { ...base, rootCauseLayer: 'frontend-logic', taskState: 'completed' }
        assert.deepEqual(parseStructuredAiResult(write(feOk)), feOk)
        // 非法 taskState → 拒收
        assert.throws(() => parseStructuredAiResult(write({ ...base, taskState: 'nonsense' })), /taskState 必须是/)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }],
    ['结果正文带「分诊」行：显示根因层与诊断状态，后端根因标注需对应端修复', () => {
      const text = formatStructuredAiResult({
        status: 'done', summary: '已转交后端。', checks: [], changedFiles: [], warnings: [],
        blockers: null, owner: '后端', failureKind: null, nextStep: null,
        rootCauseLayer: 'backend-data', taskState: 'awaiting_owner_fix',
        evidence: { userSeenValue: 'a', apiActualValue: 'b', contractExpectedValue: 'c', dataFlowFirstErrorLocation: 'd' },
      })
      assert.match(text, /分诊：根因层 后端数据（非前端，需对应端修复）/)
      assert.match(text, /诊断状态 待对应端修复/)
      // 无分诊字段的旧形态结果不出现「分诊」行
      const plain = formatStructuredAiResult({ status: 'done', summary: 'ok', checks: [], changedFiles: [], warnings: [], blockers: null, owner: null, failureKind: null, nextStep: null })
      assert.doesNotMatch(plain, /分诊：/)
    }],
  ]))

  it('回执与卡片：卡片展示执行器、待确认回执列 blockers、待确认卡橙色并 @ 触发人、failed 列失败类型', () => runSteps([
    ['排队卡与结果卡展示实际执行器', () => {
      const config = { project: 'PR-01947', title: 'Test' }
      const task = { project: 'PR-01947', summary: 'fix', aiExecutor: 'codex' }
      assert.match(JSON.parse(buildQueuedCard({ config, task })).elements[0].text.content, /执行器.*Codex/)
      assert.match(JSON.parse(buildResultCard({ config, task, status: 'done', result: 'ok' })).elements[0].text.content, /执行器.*Codex/)
    }],
    ['waiting_confirmation 结果转成「待确认」回执并列出 blockers（群卡不列建议责任人）', () => {
      const text = formatStructuredAiResult(
        { status: 'waiting_confirmation', summary: '需要 hover tips 文案', checks: [], changedFiles: [], blockers: ['缺 tips 文案原文'], owner: '产品' },
      )
      assert.match(text, /^需人工确认/)
      assert.match(text, /待补充：缺 tips 文案原文/)
      // owner 单独用于卡片 @ 责任人，不再在正文列一行
      assert.doesNotMatch(text, /建议责任人/)
    }],
    ['待确认卡为橙色、能识别触发人时 @ 其补料', () => {
      const config = { project: 'PR-01947', title: 'Test' }
      const task = { project: 'PR-01947', summary: 'tips', aiExecutor: 'codex' }
      const card = JSON.parse(buildWaitingCard({ config, task, status: 'waiting_confirmation', result: '缺文案', mentionOpenId: 'ou_pm' }))
      assert.equal(card.header.template, 'orange')
      assert.match(card.elements[0].text.content, /待确认，需补充材料/)
      assert.match(card.elements[0].text.content, /<at id=ou_pm><\/at>/)
      // 无触发人（bug 表任务）→ 不带 @
      const noMention = JSON.parse(buildWaitingCard({ config, task, status: 'waiting_confirmation', result: '缺文案' }))
      assert.doesNotMatch(noMention.elements[0].text.content, /<at id=/)
    }],
    ['failed 结果带 failureKind 时回执列出失败类型（群卡不列下一步）', () => {
      const text = formatStructuredAiResult(
        { status: 'failed', summary: '构建产物缺失', checks: [], changedFiles: [], failureKind: 'env', nextStep: '在 dev 克隆重装依赖后重试' },
      )
      assert.match(text, /^处理失败。/)
      assert.match(text, /失败类型：环境失败/)
      // 下一步属实现细节，不上群卡
      assert.doesNotMatch(text, /下一步/)
    }],
  ]))

  it('阻塞语义与责任人：blocked 结果和卡片、owner 命中 ownerMap / 关键词 / 回落提单人、waiting 卡附 ownerNote', () => runSteps([
    ['blocked 结果和卡片使用阻塞语义', () => {
      const text = formatStructuredAiResult(
        { status: 'blocked', summary: '缺少权威文案', checks: ['只读分析通过'], changedFiles: [], blockers: ['PM 未提供 tips 文案'] },
      )
      assert.match(text, /^已阻塞/)
      assert.match(text, /待补充：PM 未提供 tips 文案/)
      const card = JSON.parse(buildWaitingCard({
        config: { project: 'PR-01947', title: 'Test' },
        task: { project: 'PR-01947', summary: 'tips', aiExecutor: 'codex' },
        status: 'blocked',
        result: text,
      }))
      assert.equal(card.header.template, 'orange')
      assert.match(card.elements[0].text.content, /已阻塞/)
    }],
    ['owner 命中 ownerMap → @ 责任人；命中关键词也算；未命中回落提单人并注明', () => {
      // 精确命中角色
      assert.deepEqual(
        resolveOwnerMention({ owner: '产品', ownerMap: { 产品: 'ou_pm', QA: 'ou_qa' }, operator: 'ou_op' }),
        { mentionOpenId: 'ou_pm', ownerNote: null, matched: true },
      )
      // 关键词包含命中（owner 文案里含配置 key）
      assert.equal(resolveOwnerMention({ owner: '产品经理张三', ownerMap: { 产品: 'ou_pm' }, operator: 'ou_op' }).mentionOpenId, 'ou_pm')
      // 未识别 → 回落提单人 + note
      const fallback = resolveOwnerMention({ owner: '外部供应商', ownerMap: { 产品: 'ou_pm' }, operator: 'ou_op' })
      assert.equal(fallback.mentionOpenId, 'ou_op')
      assert.equal(fallback.matched, false)
      assert.match(fallback.ownerNote, /未在责任人表识别「外部供应商」/)
      // 无配置表 + 无 owner → 回落提单人、无 note
      assert.deepEqual(resolveOwnerMention({ operator: 'ou_op' }), { mentionOpenId: 'ou_op', ownerNote: null, matched: false })
      // bug 表任务无提单人 → 不 @
      assert.equal(resolveOwnerMention({ owner: '产品', ownerMap: {} }).mentionOpenId, null)
    }],
    ['waiting 卡携带 ownerNote 时在 @ 行后附注', () => {
      const card = JSON.parse(buildWaitingCard({
        config: { project: 'PR-01947', title: 'Test' },
        task: { project: 'PR-01947', summary: 'tips', aiExecutor: 'codex' },
        status: 'waiting_confirmation',
        result: '缺文案',
        mentionOpenId: 'ou_op',
        ownerNote: '（未在责任人表识别「产品」，暂 @ 提单人）',
      }))
      assert.match(card.elements[0].text.content, /<at id=ou_op><\/at>/)
      assert.match(card.elements[0].text.content, /未在责任人表识别「产品」/)
    }],
  ]))
})

describe('no_change_needed 终态（本仓无对应改动，转后端/别的仓）', () => {
  const base = {
    status: 'no_change_needed',
    summary: '该拉先项属后台 API，前端无对应改动。',
    checks: ['已核对现有前端代码与接口层，无需改动'],
    changedFiles: [],
    warnings: [],
    blockers: null,
    owner: '后端',
    failureKind: null,
    nextStep: '转后端处理该接口',
  }

  it('no_change_needed：非完成态透传、解析接受空 changedFiles、群卡首行无需改动、结果卡中性灰', () => runSteps([
    ['非完成态：不触发规范闸/可信度评估，Gateway 落态原样透传', () => {
      assert.equal(isCompletedAiStatus('no_change_needed'), false)
      assert.equal(gatewayStatusForAiStatus('no_change_needed'), 'no_change_needed')
    }],
    ['parseStructuredAiResult 接受 no_change_needed + changedFiles 空数组', () => {
      const dir = mkdtempSync(join(tmpdir(), 'lark-nochange-'))
      const resultPath = join(dir, 'result.json')
      try {
        writeFileSync(resultPath, JSON.stringify(base))
        assert.deepEqual(parseStructuredAiResult(resultPath), base)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }],
    ['群卡结论首行为「无需改动」，不误报处理失败/已完成', () => {
      const text = formatStructuredAiResult(base)
      assert.match(text, /^无需改动。/)
      assert.match(text, /该拉先项属后台 API/)
      assert.doesNotMatch(text, /处理失败/)
      assert.doesNotMatch(text, /已完成/)
    }],
    ['结果卡用中性灰、不是绿 done 也不是红 failed', () => {
      const card = JSON.parse(buildResultCard({
        config: { project: 'PR-02135', title: 'Test' },
        task: { project: 'PR-02135', summary: '后台 api', aiExecutor: 'codex' },
        status: 'no_change_needed',
        result: '无需改动。',
      }))
      assert.equal(card.header.template, 'grey')
      assert.match(card.elements[0].text.content, /无需改动/)
    }],
  ]))
})

describe('unattended diff quality gate', () => {
  it('样式违规：只拦新增行 arbitrary value 与失效裸色类、合法 token 不误报、一行多违规全列、补齐的 arbitrary 前缀也拦', () => runSteps([
    ['只拦新增代码行里的 arbitrary value 与失效裸色类', () => {
      const violations = scanDiffForViolations([
        '+++ b/apps/web/src/Button.tsx',
        '-<div className="rounded-[4px] text-green" />',
        '+<div className="rounded-[8px] text-green" />',
        '+++ b/README.md',
        '+rounded-[99px] text-red',
      ].join('\n'))
      assert.deepEqual(violations.map((item) => item.kind), ['arbitrary-value', 'invalid-color-class'])
    }],
    ['合法项目 token 不误报', () => {
      const violations = scanDiffForViolations('+++ b/apps/web/src/Button.tsx\n+<div className="rounded-m text-sem-g" />')
      assert.deepEqual(violations, [])
    }],
    ['一行多违规全列（matchAll，不再只报首个）', () => {
      const violations = scanDiffForViolations(
        '+++ b/apps/web/src/Box.tsx\n+<div className="rounded-[8px] w-[10px] text-green" />',
      )
      assert.deepEqual(violations.map((v) => v.kind), ['arbitrary-value', 'arbitrary-value', 'invalid-color-class'])
    }],
    ['补齐的 arbitrary 前缀（ring/aspect/content）也拦', () => {
      const violations = scanDiffForViolations(
        '+++ b/apps/web/src/A.tsx\n+<div className="ring-[3px] aspect-[16/9] content-[\'x\']" />',
      )
      assert.deepEqual(violations.map((v) => v.token), ['ring-[3px]', 'aspect-[16/9]', "content-['x']"])
    }],
  ]))

  it('语境与类型 / i18n 违规：className 语境限定、TS 裸 any、i18n 动态 key、JSX 硬编码中文', () => runSteps([
    ['className 语境限定：注释 / 散文里的类名不误报，引号内与 @apply 才算', () => {
      // 注释行整行跳过
      assert.deepEqual(scanDiffForViolations('+++ b/apps/web/src/A.tsx\n+// 用 rounded-[8px] 演示'), [])
      // 非引号、非 @apply 的散文（如日志字符串外）：token 不在引号内 → 不算
      assert.deepEqual(scanDiffForViolations('+++ b/apps/web/src/A.tsx\n+const doc = 见 rounded-[8px] 文档'), [])
      // CSS @apply 语境仍拦
      assert.equal(scanDiffForViolations('+++ b/apps/web/src/a.css\n+  @apply rounded-[8px];').length, 1)
    }],
    ['裸 any（as any / : any / <any>）在 TS 文件被拦，非 TS 不查', () => {
      const ts = scanDiffForViolations(
        '+++ b/apps/web/src/x.ts\n+const a = data as any\n+let b: any\n+const c = x as unknown as any',
      )
      assert.deepEqual(ts.map((v) => v.kind), ['bare-any', 'bare-any', 'bare-any'])
      // .js 也算 TS？否——TS_FILE_RE 只匹配 ts/tsx；js 里的 any 不查（无类型系统）
      assert.deepEqual(scanDiffForViolations('+++ b/apps/web/src/x.js\n+const a = data as any'), [])
    }],
    ['i18n 动态 key：t(变量) / t(模板插值) 被拦，t("literal") 放行', () => {
      // 用拼接构造 t(`ns:${status}`)，避免在测试源码里出现真的模板占位（触发 lint 噪声）
      const tmplKey = 't(`ns:' + '$' + '{status}`)'
      const bad = scanDiffForViolations(`+++ b/apps/web/src/x.tsx\n+const s = t(reasonKey)\n+const d = ${tmplKey}`)
      assert.deepEqual(bad.map((v) => v.kind), ['i18n-dynamic-key', 'i18n-dynamic-key'])
      // 字面量 key 与带 options 的字面量不误报
      assert.deepEqual(
        scanDiffForViolations("+++ b/apps/web/src/x.tsx\n+const s = t('ns:a.b')\n+const c = t('ns:c', { count })"),
        [],
      )
    }],
    ['JSX 文本硬编码中文被拦（限 tsx/jsx），表达式节点 {t()} 与属性不误报', () => {
      assert.deepEqual(
        scanDiffForViolations('+++ b/apps/web/src/x.tsx\n+<button>确定</button>').map((v) => v.kind),
        ['i18n-hardcoded-cjk'],
      )
      // {t('x')} 表达式节点、以及 .ts 非 JSX 文件不误报
      assert.deepEqual(scanDiffForViolations("+++ b/apps/web/src/x.tsx\n+<button>{t('ns:ok')}</button>"), [])
      assert.deepEqual(scanDiffForViolations('+++ b/apps/web/src/x.ts\n+const label = "确定"'), [])
    }],
  ]))
})

describe('分诊 Prompt 的 PRD 来源', () => {
  it('PRD 缓存与存量项目都没有时如实说明并引导 needs_info，不给不存在的路径', () => {
    const prompt = buildTriagePrompt({ projectId: 'PR-00009', projectName: 'test', cwd: '/tmp/repo' }, { id: 't1', text: '埋点未上报' }, '（无）')
    assert.match(prompt, /本地没有该项目的 PRD 落盘/)
    assert.doesNotMatch(prompt, /apps\/web\/docs_tdd/)
  })
})

describe('结果文件自纠偏（lessons #31）', () => {
  // 假 claude 子进程：首轮吐 init 事件带 session_id、正常退出但不写结果；--resume 那轮才写 result.json。
  const fakeSpawn = (calls, { recoveryWrites = true, recoveryStatus = 'done' } = {}) => (cmd, args) => {
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdin = new PassThrough()
    child.kill = () => {}
    calls.push({ cmd, args })
    const resumeAt = args.indexOf('--resume')
    const resultPath = args.join(' ').match(/(\/\S+result\.json)/)?.[1]
    setImmediate(() => {
      child.stdout.write(`{"type":"system","subtype":"init","session_id":"sess-${calls.length}","tools":[]}\n`)
      if (resumeAt >= 0 && recoveryWrites && resultPath) {
        writeFileSync(resultPath, JSON.stringify({ status: recoveryStatus, summary: '补写', checks: [], changedFiles: [], warnings: [] }))
      }
      child.stdout.end()
      child.stderr.end()
      setImmediate(() => child.emit('exit', 0))
    })
    return child
  }

  it('结果文件自纠偏：没写 result.json 续同会话补写一次、补写仍失败按原错误上抛、续会话回退后补写续新会话、只读分类不补写', () => runSteps([
    ['claude 任务正常退出却没写 result.json：续同一会话只补写一次，补写成功即按正常结果返回', async () => {
      const calls = []
      const auditLogPath = join(mkdtempSync(join(tmpdir(), 'lark-heal-')), 'audit.log')
      const out = await execAiExecutor({
        executor: 'claude', promptText: '发日报', cwd: tmpdir(), auditLogPath, localConfig: {}, spawnImpl: fakeSpawn(calls),
      })
      assert.equal(calls.length, 2)
      assert.equal(calls[0].args.includes('--resume'), false)
      assert.deepEqual(calls[1].args.slice(calls[1].args.indexOf('--resume'), calls[1].args.indexOf('--resume') + 2), ['--resume', 'sess-1'])
      assert.match(calls[1].args.at(-1), /不要重跑任务/)
      assert.equal(out.result.status, 'done')
      assert.match(readFileSync(auditLogPath, 'utf8'), /\[self-heal\].*--resume sess-1[\s\S]*\[self-heal\] 补写成功：status=done/)
    }],
    ['补写仍没写出来：只试一次，按原错误上抛并注明补写也失败', async () => {
      const calls = []
      await assert.rejects(
        execAiExecutor({ executor: 'claude', promptText: '发日报', cwd: tmpdir(), localConfig: {}, spawnImpl: fakeSpawn(calls, { recoveryWrites: false }) }),
        /Claude 未返回合法结构化结果：ENOENT[\s\S]*续会话补写也失败/,
      )
      assert.equal(calls.length, 2)
    }],
    ['续会话失败回退新会话后，补写结果文件续的是新会话而不是失败的旧会话（aven 2026-10-20 review #12）', async () => {
      const calls = []
      const spawnImpl = (cmd, args) => {
        const child = new EventEmitter()
        child.stdout = new PassThrough()
        child.stderr = new PassThrough()
        child.stdin = new PassThrough()
        child.kill = () => {}
        calls.push({ cmd, args })
        const resumeAt = args.indexOf('--resume')
        const resumed = resumeAt >= 0 ? args[resumeAt + 1] : null
        const resultPath = args.join(' ').match(/(\/\S+result\.json)/)?.[1]
        setImmediate(() => {
          const session = calls.length === 1 ? 'sess-dead' : calls.length === 2 ? 'sess-new' : resumed
          child.stdout.write(`{"type":"system","subtype":"init","session_id":"${session}","tools":[]}\n`)
          if (calls.length === 3 && resultPath) writeFileSync(resultPath, JSON.stringify({ status: 'done', summary: '补写', checks: [], changedFiles: [], warnings: [] }))
          child.stdout.end()
          child.stderr.end()
          setImmediate(() => child.emit('exit', calls.length === 1 ? 1 : 0))
        })
        return child
      }
      const out = await execAiExecutor({ executor: 'claude', promptText: '增量', fallbackPromptText: '完整', resumeSessionId: 'sess-old', cwd: tmpdir(), localConfig: {}, spawnImpl })
      assert.equal(calls.length, 3)
      assert.equal(calls[0].args[calls[0].args.indexOf('--resume') + 1], 'sess-old')
      assert.equal(calls[1].args.includes('--resume'), false)
      assert.equal(calls[2].args[calls[2].args.indexOf('--resume') + 1], 'sess-new')
      assert.equal(out.resumeFallback, true)
      assert.equal(out.sessionId, 'sess-new')
    }],
    ['只读分类（stdout 结构化）不走补写：没有 resultPath 可补', async () => {
      const calls = []
      const spawnImpl = (cmd, args) => {
        const child = fakeSpawn(calls)(cmd, args)
        return child
      }
      await assert.rejects(
        execAiExecutor({ executor: 'claude', promptText: 'x', cwd: tmpdir(), resultKind: 'intent', localConfig: {}, spawnImpl }),
        /意图分类结果缺少合法 decision/,
      )
      assert.equal(calls.length, 1)
    }],
  ]))
})

describe('只读任务拿不到可写面；子进程按进程组终止（第 0 批）', () => {
  it('只读任务无写权限面；spawn 带 detached、abort 时按进程组 kill', () => runSteps([
    ['claude 任务模式 readOnly：无 --dangerously-skip-permissions，工具面与分析同档', () => {
      const ro = buildAiExecutorCommand({ executor: 'claude', promptText: '复测', cwd: '/tmp/repo', readOnly: true })
      assert.equal(ro.args.includes('--dangerously-skip-permissions'), false)
      assert.equal(ro.args[ro.args.indexOf('--tools') + 1], 'Read,Grep,Glob,Bash')
      assert.ok(ro.args.includes('--allowedTools'))
      assert.ok(ro.args.includes('--output-format'))
      const rw = buildAiExecutorCommand({ executor: 'claude', promptText: '改', cwd: '/tmp/repo', readOnly: false })
      assert.equal(rw.args.includes('--dangerously-skip-permissions'), true)
      assert.equal(rw.args.includes('--allowedTools'), false)
    }],
    ['spawn 带 detached；abort 时 kill 的是 -pid（整组），孙进程不会存活', async () => {
      const spawnOptions = []
      const killed = []
      const originalKill = process.kill
      process.kill = (pid, sig) => { killed.push([pid, sig]); if (pid === -4242) setImmediate(() => child.emit('exit', null)) }
      let child
      const spawnImpl = (cmd, args, options) => {
        spawnOptions.push(options)
        child = new EventEmitter()
        child.pid = 4242
        child.stdout = new PassThrough()
        child.stderr = new PassThrough()
        child.stdin = new PassThrough()
        child.kill = () => { killed.push(['child.kill']) }
        return child
      }
      const controller = new AbortController()
      try {
        const run = execAiExecutor({ executor: 'claude', promptText: 'x', cwd: tmpdir(), localConfig: {}, spawnImpl, signal: controller.signal })
        await new Promise((resolve) => setImmediate(resolve))
        controller.abort()
        await assert.rejects(run, /aborted/)
        assert.equal(spawnOptions[0].detached, true)
        assert.deepEqual(killed[0], [-4242, 'SIGTERM'])
      } finally {
        process.kill = originalKill
      }
    }],
  ]))
})
