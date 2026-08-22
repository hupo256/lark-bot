#!/usr/bin/env node

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { parseAiExecutorDirective, resolveGatewayAiExecutor } from '../lib/lark-ingest.mjs'
import {
  buildAiExecutorCommand,
  formatStructuredAiResult,
  resolveAiExecutor,
  validateAiExecutor,
} from '../lib/lark-ai-executor.mjs'
import { parseStructuredAiResult, parseStructuredIntentResult } from '../lib/lark-ai-result.mjs'
import { buildQueuedCard, buildResultCard, buildWaitingCard, resolveOwnerMention } from '../lib/lark-cards.mjs'
import { scanDiffForViolations } from '../lib/lark-lint-diff.mjs'
import { buildFocusedRuleContext } from '../lib/lark-rule-context.mjs'
import { requestJson } from '../lib/lark-gateway-client.mjs'
import { gatewayStatusForAiStatus, isCompletedAiStatus } from '../lib/lark-status-meta.mjs'
import { shouldSyncProjectDocs } from '../lib/lark-task-runner.mjs'
import { normalizeAnalysisForTask } from '../lib/lark-worker-run.mjs'
import {
  buildAnalysisPrompt,
  buildIntentClassificationPrompt,
  buildTaskPrompt,
  buildValidationRequirements,
  resolveTaskMode,
} from '../lib/lark-worker-prompts.mjs'

describe('AI executor selection', () => {
  it('只接受 claude/codex 固定枚举', () => {
    assert.equal(validateAiExecutor(' Codex '), 'codex')
    assert.equal(validateAiExecutor('CLAUDE'), 'claude')
    assert.throws(() => validateAiExecutor('bash -c whoami'), /must be one of/)
  })

  it('优先级为 task > env > local config > wrapper > claude', () => {
    const worker = { aiExecutor: 'claude', localConfig: { aiExecutor: 'codex' } }
    assert.equal(resolveAiExecutor(worker, { aiExecutor: 'claude' }, { LARK_AI_EXECUTOR: 'codex' }), 'claude')
    assert.equal(resolveAiExecutor(worker, {}, { LARK_AI_EXECUTOR: 'claude' }), 'claude')
    assert.equal(resolveAiExecutor(worker, {}, {}), 'codex')
    assert.equal(resolveAiExecutor({ aiExecutor: 'claude', localConfig: {} }, {}, {}), 'claude')
  })

  it('群消息识别首个文本位置的安全选择指令，标签后无需空格', () => {
    assert.equal(parseAiExecutorDirective('[codex] 修复登录页'), 'codex')
    assert.equal(parseAiExecutorDirective('[codex]这里有明显颜色重叠'), 'codex')
    assert.equal(parseAiExecutorDirective(' [CLAUDE] 看这里'), 'claude')
    assert.equal(parseAiExecutorDirective('[claude]直接处理'), 'claude')
    assert.equal(parseAiExecutorDirective('![Image](img_v3_demo) [codex] 这个选项是接口还是写死的'), 'codex')
    assert.equal(parseAiExecutorDirective('![Image](img_1)\n![Image](img_2)\n[CLAUDE] 看两个截图'), 'claude')
    assert.equal(parseAiExecutorDirective('[Image: img_v3_fallback]\n[codex]排查这里'), 'codex')
    assert.equal(parseAiExecutorDirective('修复 [codex] 登录页'), undefined)
    assert.equal(parseAiExecutorDirective('![Image](img_v3_demo) 先看截图 [codex] 再处理'), undefined)
    assert.equal(parseAiExecutorDirective('[shell] whoami'), undefined)
  })

  it('Gateway 入队时解析有效执行器，确保领取卡展示默认值', () => {
    const config = { aiExecutor: 'codex' }
    assert.equal(resolveGatewayAiExecutor({ config, env: {} }), 'codex')
    assert.equal(resolveGatewayAiExecutor({ requestedExecutor: 'claude', config, env: {} }), 'claude')
    assert.equal(resolveGatewayAiExecutor({ config, env: { LARK_AI_EXECUTOR: 'claude' } }), 'claude')
  })
})

describe('Codex non-interactive command', () => {
  it('使用指定模型与推理强度，并保持 workspace-write、never、关闭工具网络', () => {
    const command = buildAiExecutorCommand({
      executor: 'codex',
      promptText: 'fix it',
      cwd: '/tmp/repo',
      resultPath: '/tmp/result.json',
      codexModel: 'gpt-5.6-sol',
      codexReasoningEffort: 'high',
    })
    assert.equal(command.cmd, 'codex')
    assert.equal(command.stdin, 'fix it')
    assert.equal(command.resultMode, 'structured')
    assert.ok(command.args.includes('--ephemeral'))
    assert.deepEqual(command.args.slice(command.args.indexOf('--sandbox'), command.args.indexOf('--sandbox') + 2), ['--sandbox', 'workspace-write'])
    assert.deepEqual(command.args.slice(0, 3), ['--ask-for-approval', 'never', 'exec'])
    assert.deepEqual(command.args.slice(command.args.indexOf('--model'), command.args.indexOf('--model') + 2), ['--model', 'gpt-5.6-sol'])
    assert.ok(command.args.includes('model_reasoning_effort="high"'))
    assert.ok(command.args.includes('sandbox_workspace_write.network_access=false'))
    // workspace-write 阶段放行 docs_tdd 软链目标，否则登记文档写入被 seatbelt 拒
    assert.ok(command.args.some((a) => /^sandbox_workspace_write\.writable_roots=/.test(a)))
    assert.equal(command.args.at(-1), '-')
    assert.equal(command.args.includes('--dangerously-bypass-approvals-and-sandbox'), false)
  })

  it('Claude 保持现有无人值守参数，挂载 figma MCP + stream-json 捕获工具痕迹，并与 codex 同构走结构化结果', () => {
    const command = buildAiExecutorCommand({ executor: 'claude', promptText: 'fix it', cwd: '/tmp/repo' })
    assert.ok(command.args.includes('-p'))
    assert.ok(command.args.includes('--dangerously-skip-permissions'))
    // stream-json 捕获 tool_use / MCP 调用（print 模式下强制配 --verbose）
    assert.deepEqual(command.args.slice(command.args.indexOf('--output-format'), command.args.indexOf('--output-format') + 2), ['--output-format', 'stream-json'])
    assert.ok(command.args.includes('--verbose'))
    // figma MCP 挂载，供 mcp__figma__ 痕迹核验；--strict-mcp-config 只挂本配置
    assert.match(command.args[command.args.indexOf('--mcp-config') + 1], /figma-mcp\.json$/)
    assert.ok(command.args.includes('--strict-mcp-config'))
    // prompt 仍是最后一个位置参数
    assert.equal(command.args.at(-1), 'fix it')
    assert.equal(command.resultMode, 'structured')
  })

  it('Codex 分析阶段使用只读沙箱和独立分析 Schema', () => {
    const command = buildAiExecutorCommand({
      executor: 'codex',
      promptText: 'analyze it',
      cwd: '/tmp/repo',
      resultPath: '/tmp/analysis.json',
      resultKind: 'analysis',
    })
    assert.deepEqual(command.args.slice(command.args.indexOf('--sandbox'), command.args.indexOf('--sandbox') + 2), ['--sandbox', 'read-only'])
    // 只读阶段无写、不加 writable_roots
    assert.equal(command.args.some((a) => /^sandbox_workspace_write\.writable_roots=/.test(a)), false)
    const schemaPath = command.args[command.args.indexOf('--output-schema') + 1]
    assert.match(schemaPath, /lark-ai-analysis\.schema\.json$/)
  })

  it('Codex 意图分类使用只读沙箱、关闭网络和独立 Schema', () => {
    const command = buildAiExecutorCommand({
      executor: 'codex',
      promptText: 'classify it',
      cwd: '/tmp/repo',
      resultPath: '/tmp/intent.json',
      resultKind: 'intent',
      readOnly: true,
    })
    assert.deepEqual(command.args.slice(command.args.indexOf('--sandbox'), command.args.indexOf('--sandbox') + 2), ['--sandbox', 'read-only'])
    assert.ok(command.args.includes('sandbox_workspace_write.network_access=false'))
    assert.match(command.args[command.args.indexOf('--output-schema') + 1], /lark-intent-classification\.schema\.json$/)
  })

  it('Claude 意图分类只开放 Read + plan，不使用无人值守写权限', () => {
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
  })
})

describe('task-mention intent classification', () => {
  it('解析合法分类并拒绝缺字段结果', () => {
    const result = parseStructuredIntentResult({
      decision: 'bug',
      confidence: 'high',
      summary: '修复登录页报错',
      reason: '明确描述了报错',
    }, 'claude')
    assert.equal(result.decision, 'bug')
    assert.throws(() => parseStructuredIntentResult({ decision: 'bug' }), /confidence/)
    assert.throws(() => parseStructuredIntentResult('{bad json'), /未返回合法意图分类结果/)
  })

  it('Claude 兼容完整 JSON 代码围栏，但拒绝围栏外的解释文字', () => {
    const fenced = '```json\n{"decision":"requirement","confidence":"medium","summary":"调整页面规则","reason":"明确交办产品行为变更"}\n```'
    assert.equal(parseStructuredIntentResult(fenced, 'claude').decision, 'requirement')
    assert.throws(
      () => parseStructuredIntentResult(`分类结果如下：\n${fenced}`, 'claude'),
      /未返回合法意图分类结果/,
    )
  })

  it('分类 Prompt 把群消息标为不可信并明确歧义时 ignore', () => {
    const prompt = buildIntentClassificationPrompt({
      text: '这个按钮不对，帮忙修一下',
      attachments: [{ type: 'image', localPath: '/tmp/screenshot.png' }],
    })
    assert.match(prompt, /UNTRUSTED_LARK_MESSAGE/)
    assert.match(prompt, /有歧义时必须 decision=ignore/)
    assert.match(prompt, /\/tmp\/screenshot\.png/)
  })
})

describe('focused rule loading and two-phase prompts', () => {
  it('tips/Tooltip 任务精准命中文案契约，并保留来源与指纹', () => {
    const context = buildFocusedRuleContext({ taskText: '这些标题 hover 时加上 tips' })
    assert.equal(context.scenario, 'write_ui')
    assert.ok(context.sources.some((item) => item.section.includes('文案契约')))
    assert.match(context.text, /文案契约/)
    assert.match(context.fingerprint, /^[a-f0-9]{16}$/)
  })

  it('分析 Prompt 注入规则原文；实现 Prompt 注入 ready 结论', () => {
    const workContext = { projectId: 'PR-00001', projectName: 'test', projectDocs: [], cwd: '/tmp/repo' }
    const task = { id: 'task-1', text: '标题加 tips', attachments: [] }
    const ruleContext = {
      scenario: 'write_ui',
      fingerprint: 'abc123',
      ruleReleaseFingerprint: 'l3-fingerprint',
      effectiveRulesFingerprint: 'effective-fingerprint',
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
    assert.match(analysisPrompt, /L3 发布指纹：l3-fingerprint/)
    assert.match(analysisPrompt, /Effective Rules 指纹：effective-fingerprint/)

    const implementationPrompt = buildTaskPrompt(workContext, task, 'codex', { ruleContext, analysis })
    assert.match(implementationPrompt, /第一阶段只读分析已判定 ready/)
    assert.match(implementationPrompt, /不得自造文案/)
    assert.match(implementationPrompt, /权威规则：文案必须来自 PRD/)
  })
})

describe('risk-based validation policy', () => {
  it('resolveTaskMode 三态优先级：只读 > 测试反馈 > 常规', () => {
    assert.equal(resolveTaskMode({ commandType: 'status', text: '状态：x' }), 'readOnly')
    assert.equal(resolveTaskMode({ source: 'lark-bugtable', commandType: 'qa' }), 'testFeedback')
    assert.equal(resolveTaskMode({ source: 'lark', commandType: 'fix', text: '修复：x' }), 'testFeedback')
    assert.equal(resolveTaskMode({ source: 'manual-api', commandType: 'fix' }), 'regular')
    assert.equal(resolveTaskMode({ source: 'lark', commandType: 'docs' }), 'regular')
  })

  it('L1 样式改动跳过 type-check，验证使用本地二进制并预防缓存/网络问题', () => {
    const policy = buildValidationRequirements()
    assert.match(policy, /L1 样式/)
    assert.match(policy, /无需 type-check/)
    assert.match(policy, /node_modules\/\.bin\/vitest run --no-cache/)
    assert.match(policy, /不要用会触发 Corepack\/registry 的 `pnpm exec`/)
    assert.match(policy, /同一检查最多执行一次/)
    assert.match(policy, /自动视觉验收默认关闭/)
    assert.match(policy, /不要启动 dev server/)
    assert.match(policy, /默认跳过不是 warning/)
  })

  it('任务 Prompt 只保留风险分级策略，不再强制每个 apps/web 改动跑 tsc', () => {
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
  })

  it('明确要求视觉验证时只复用现有页面，不在沙箱启动开发服务', () => {
    const prompt = buildTaskPrompt(
      { projectId: 'PR-01947', projectName: 'test', projectDocs: [], cwd: '/tmp/repo' },
      { id: 'task-visual', source: 'lark', text: '修复后用 Playwright 做视觉验收', commandType: null, attachments: [] },
      'codex',
    )
    assert.match(prompt, /任务明确要求视觉验证/)
    assert.match(prompt, /只复用已经运行且可访问的页面/)
    assert.match(prompt, /不要在 Codex 沙箱内启动 dev server/)
  })

  it('群内测试反馈不分 L1/L2/L3，范围明确就不重复跑同步或 G2 门禁', () => {
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
    assert.match(analysisPrompt, /修改范围/)
    assert.match(analysisPrompt, /缺 G2、README、技术方案、rule session、历史 gate 证据/)
    assert.match(analysisPrompt, /范围能从现有事实唯一确定时必须返回 ready/)
    assert.match(prompt, /测试反馈直接实施路径/)
    assert.match(prompt, /此路径不限于 L1/)
    assert.match(prompt, /不要自行运行 Lark 同步/)
    assert.match(prompt, /不要运行 docs-tdd context \/ changed \/ gate/)
    assert.match(prompt, /唯一需要人工确认的需求问题是修改范围/)
    assert.match(prompt, /不得仅因缺 G2、PRD、Figma、QA 文档、README、技术方案或历史 gate 证据返回 waiting_confirmation/)
    assert.equal(shouldSyncProjectDocs(task), false)
  })

  it('群任务和 Bug 表的 G2 流程阻塞都会降级，真实范围歧义仍保留', () => {
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
    assert.equal(shouldSyncProjectDocs({ ...bugTableTask, commandType: 'qa' }), false)

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
  })

  it('非测试反馈来源保持原同步与 G2 判定，不被扩权', () => {
    const externalTask = { source: 'manual-api', commandType: 'qa' }
    const analysis = {
      status: 'blocked',
      summary: '缺少 G2',
      applicableRules: [],
      requirements: [],
      blockers: ['缺少 G2 定稿证据'],
    }
    assert.equal(normalizeAnalysisForTask(externalTask, analysis), analysis)
    assert.equal(shouldSyncProjectDocs(externalTask), true)
    assert.equal(shouldSyncProjectDocs({ source: 'lark', commandType: 'docs' }), true)
  })

  it('状态查询不运行写式文档同步，Prompt 明确零改动成功', () => {
    const task = {
      id: 'status-1',
      source: 'lark-bugtable',
      commandType: 'status',
      text: '状态：这个项目现在的状态是？',
      attachments: [],
    }
    assert.equal(shouldSyncProjectDocs(task), false)
    const prompt = buildTaskPrompt(
      { projectId: 'PR-01947', projectName: '跟单设置', projectDocs: [], cwd: '/tmp/repo' },
      task,
      'codex',
      { ruleContext: { scenario: 'g4_coding_worktree', sources: [], text: '只读规则。' } },
    )
    assert.match(prompt, /本任务是只读状态查询/)
    assert.match(prompt, /changedFiles 必须为 \[\]/)
    assert.match(prompt, /无代码改动是正确结果/)
    assert.doesNotMatch(prompt, /编码规范（改任何代码前必做/)
  })
})

describe('Gateway transient retry', () => {
  it('幂等请求遇到 ECONNRESET 会重试并成功', async () => {
    let calls = 0
    const fetchImpl = async () => {
      calls += 1
      if (calls < 3) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } })
      return { ok: true, json: async () => ({ ok: true }) }
    }
    const result = await requestJson('http://127.0.0.1:3005', '/status', { retryTransient: true }, { fetchImpl, sleepImpl: async () => {} })
    assert.deepEqual(result, { ok: true })
    assert.equal(calls, 3)
  })

  it('claim 类调用默认不重试，避免重复领取', async () => {
    let calls = 0
    const fetchImpl = async () => {
      calls += 1
      throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } })
    }
    await assert.rejects(() => requestJson('http://127.0.0.1:3005', '/claim', { method: 'POST' }, { fetchImpl, sleepImpl: async () => {} }), /fetch failed/)
    assert.equal(calls, 1)
  })
})

describe('structured result and cards', () => {
  const result = {
    status: 'done',
    summary: '修复登录按钮颜色。',
    checks: ['button.test.tsx 通过'],
    changedFiles: ['apps/web/button.tsx'],
  }

  it('Worker 把结构化结果转成稳定回执（群卡精简：不列验证/文件明细）', () => {
    const text = formatStructuredAiResult(result)
    assert.match(text, /^已完成，待发布。/)
    assert.doesNotMatch(text, /执行器：codex/)
    assert.match(text, /修复登录按钮颜色。/)
    // 验证/文件等实现细节不上群卡
    assert.doesNotMatch(text, /button.test.tsx 通过/)
    assert.doesNotMatch(text, /文件：/)
  })

  it('只读状态查询使用“查询完成”结论，不显示待发布', () => {
    const text = formatStructuredAiResult({ ...result, changedFiles: [] }, { readOnly: true })
    assert.match(text, /^查询完成。/)
    assert.doesNotMatch(text, /待发布/)
  })

  it('实现完成但 Playwright 环境不可用时映射为 done，并在群卡保留验证提醒', () => {
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
    assert.match(text, /^已完成（有验证提醒），待发布。/)
    assert.match(text, /验证提醒：Playwright 页面验证因本地端口权限不可用未执行/)
    assert.doesNotMatch(text, /处理失败/)
  })

  it('结构化结果解析接受 done_with_warnings，并拒绝缺少 warnings 的伪完成', () => {
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
  })

  it('排队卡与结果卡展示实际执行器', () => {
    const config = { project: 'PR-01947', title: 'Test' }
    const task = { project: 'PR-01947', summary: 'fix', aiExecutor: 'codex' }
    assert.match(JSON.parse(buildQueuedCard({ config, task })).elements[0].text.content, /执行器.*Codex/)
    assert.match(JSON.parse(buildResultCard({ config, task, status: 'done', result: 'ok' })).elements[0].text.content, /执行器.*Codex/)
  })

  it('waiting_confirmation 结果转成「待确认」回执并列出 blockers（群卡不列建议责任人）', () => {
    const text = formatStructuredAiResult(
      { status: 'waiting_confirmation', summary: '需要 hover tips 文案', checks: [], changedFiles: [], blockers: ['缺 tips 文案原文'], owner: '产品' },
    )
    assert.match(text, /^需人工确认/)
    assert.match(text, /待补充：缺 tips 文案原文/)
    // owner 单独用于卡片 @ 责任人，不再在正文列一行
    assert.doesNotMatch(text, /建议责任人/)
  })

  it('待确认卡为橙色、能识别触发人时 @ 其补料', () => {
    const config = { project: 'PR-01947', title: 'Test' }
    const task = { project: 'PR-01947', summary: 'tips', aiExecutor: 'codex' }
    const card = JSON.parse(buildWaitingCard({ config, task, status: 'waiting_confirmation', result: '缺文案', mentionOpenId: 'ou_pm' }))
    assert.equal(card.header.template, 'orange')
    assert.match(card.elements[0].text.content, /待确认，需补充材料/)
    assert.match(card.elements[0].text.content, /<at id=ou_pm><\/at>/)
    // 无触发人（bug 表任务）→ 不带 @
    const noMention = JSON.parse(buildWaitingCard({ config, task, status: 'waiting_confirmation', result: '缺文案' }))
    assert.doesNotMatch(noMention.elements[0].text.content, /<at id=/)
  })

  it('failed 结果带 failureKind 时回执列出失败类型（群卡不列下一步）', () => {
    const text = formatStructuredAiResult(
      { status: 'failed', summary: '构建产物缺失', checks: [], changedFiles: [], failureKind: 'env', nextStep: '在 dev 克隆重装依赖后重试' },
    )
    assert.match(text, /^处理失败。/)
    assert.match(text, /失败类型：环境失败/)
    // 下一步属实现细节，不上群卡
    assert.doesNotMatch(text, /下一步/)
  })

  it('blocked 结果和卡片使用阻塞语义', () => {
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
  })

  it('owner 命中 ownerMap → @ 责任人；命中关键词也算；未命中回落提单人并注明', () => {
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
  })

  it('waiting 卡携带 ownerNote 时在 @ 行后附注', () => {
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
  })
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

  it('非完成态：不触发规范闸/可信度评估，Gateway 落态原样透传', () => {
    assert.equal(isCompletedAiStatus('no_change_needed'), false)
    assert.equal(gatewayStatusForAiStatus('no_change_needed'), 'no_change_needed')
  })

  it('parseStructuredAiResult 接受 no_change_needed + changedFiles 空数组', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lark-nochange-'))
    const resultPath = join(dir, 'result.json')
    try {
      writeFileSync(resultPath, JSON.stringify(base))
      assert.deepEqual(parseStructuredAiResult(resultPath), base)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('群卡结论首行为「无需改动」，不误报处理失败/已完成', () => {
    const text = formatStructuredAiResult(base)
    assert.match(text, /^无需改动（不属本仓）。/)
    assert.match(text, /该拉先项属后台 API/)
    assert.doesNotMatch(text, /处理失败/)
    assert.doesNotMatch(text, /已完成/)
  })

  it('结果卡用中性灰、不是绿 done 也不是红 failed', () => {
    const card = JSON.parse(buildResultCard({
      config: { project: 'PR-02135', title: 'Test' },
      task: { project: 'PR-02135', summary: '后台 api', aiExecutor: 'codex' },
      status: 'no_change_needed',
      result: '无需改动（不属本仓）。',
    }))
    assert.equal(card.header.template, 'grey')
    assert.match(card.elements[0].text.content, /无需改动（不属本仓）/)
  })
})

describe('unattended diff quality gate', () => {
  it('只拦新增代码行里的 arbitrary value 与失效裸色类', () => {
    const violations = scanDiffForViolations([
      '+++ b/apps/web/src/Button.tsx',
      '-<div className="rounded-[4px] text-green" />',
      '+<div className="rounded-[8px] text-green" />',
      '+++ b/README.md',
      '+rounded-[99px] text-red',
    ].join('\n'))
    assert.deepEqual(violations.map((item) => item.kind), ['arbitrary-value', 'invalid-color-class'])
  })

  it('合法项目 token 不误报', () => {
    const violations = scanDiffForViolations('+++ b/apps/web/src/Button.tsx\n+<div className="rounded-m text-sem-g" />')
    assert.deepEqual(violations, [])
  })

  it('一行多违规全列（matchAll，不再只报首个）', () => {
    const violations = scanDiffForViolations(
      '+++ b/apps/web/src/Box.tsx\n+<div className="rounded-[8px] w-[10px] text-green" />',
    )
    assert.deepEqual(violations.map((v) => v.kind), ['arbitrary-value', 'arbitrary-value', 'invalid-color-class'])
  })

  it('补齐的 arbitrary 前缀（ring/aspect/content）也拦', () => {
    const violations = scanDiffForViolations(
      '+++ b/apps/web/src/A.tsx\n+<div className="ring-[3px] aspect-[16/9] content-[\'x\']" />',
    )
    assert.deepEqual(violations.map((v) => v.token), ['ring-[3px]', 'aspect-[16/9]', "content-['x']"])
  })

  it('className 语境限定：注释 / 散文里的类名不误报，引号内与 @apply 才算', () => {
    // 注释行整行跳过
    assert.deepEqual(scanDiffForViolations('+++ b/apps/web/src/A.tsx\n+// 用 rounded-[8px] 演示'), [])
    // 非引号、非 @apply 的散文（如日志字符串外）：token 不在引号内 → 不算
    assert.deepEqual(scanDiffForViolations('+++ b/apps/web/src/A.tsx\n+const doc = 见 rounded-[8px] 文档'), [])
    // CSS @apply 语境仍拦
    assert.equal(scanDiffForViolations('+++ b/apps/web/src/a.css\n+  @apply rounded-[8px];').length, 1)
  })

  it('裸 any（as any / : any / <any>）在 TS 文件被拦，非 TS 不查', () => {
    const ts = scanDiffForViolations(
      '+++ b/apps/web/src/x.ts\n+const a = data as any\n+let b: any\n+const c = x as unknown as any',
    )
    assert.deepEqual(ts.map((v) => v.kind), ['bare-any', 'bare-any', 'bare-any'])
    // .js 也算 TS？否——TS_FILE_RE 只匹配 ts/tsx；js 里的 any 不查（无类型系统）
    assert.deepEqual(scanDiffForViolations('+++ b/apps/web/src/x.js\n+const a = data as any'), [])
  })

  it('i18n 动态 key：t(变量) / t(模板插值) 被拦，t("literal") 放行', () => {
    // 用拼接构造 t(`ns:${status}`)，避免在测试源码里出现真的模板占位（触发 lint 噪声）
    const tmplKey = 't(`ns:' + '$' + '{status}`)'
    const bad = scanDiffForViolations(`+++ b/apps/web/src/x.tsx\n+const s = t(reasonKey)\n+const d = ${tmplKey}`)
    assert.deepEqual(bad.map((v) => v.kind), ['i18n-dynamic-key', 'i18n-dynamic-key'])
    // 字面量 key 与带 options 的字面量不误报
    assert.deepEqual(
      scanDiffForViolations("+++ b/apps/web/src/x.tsx\n+const s = t('ns:a.b')\n+const c = t('ns:c', { count })"),
      [],
    )
  })

  it('JSX 文本硬编码中文被拦（限 tsx/jsx），表达式节点 {t()} 与属性不误报', () => {
    assert.deepEqual(
      scanDiffForViolations('+++ b/apps/web/src/x.tsx\n+<button>确定</button>').map((v) => v.kind),
      ['i18n-hardcoded-cjk'],
    )
    // {t('x')} 表达式节点、以及 .ts 非 JSX 文件不误报
    assert.deepEqual(scanDiffForViolations("+++ b/apps/web/src/x.tsx\n+<button>{t('ns:ok')}</button>"), [])
    assert.deepEqual(scanDiffForViolations('+++ b/apps/web/src/x.ts\n+const label = "确定"'), [])
  })
})
