/**
 * claude 命令行的「宿主层」参数（从 lark-ai-executor 拆出，体量预算）：模型 / 强度、宿主隔离（--strict-mcp-config /
 * --setting-sources）、系统层（--append-system-prompt）、无头摘工具与 git 硬拦。纯函数，不起进程。
 * 设计见 docs/upgrade-plan-context-layers-2026-11-01.md（S1 / S2）。
 */

// 各执行器在本地配置里的模型/推理强度/Provider 键名不同；缺省时返回空，由 CLI 自己决定默认值。
// claude：`claudeModel` / `claudeEffort`（兼容旧键 model / reasoningEffort）；`claudeAnalysisModel` / `claudeAnalysisEffort`
// 给只读分析 / 分诊阶段单独指定（分析要全面精确，实施要快），缺省同任务模型与强度。
// `claudeIntentModel` / `claudeIntentEffort` 给前置意图分类单独指定（11-02 实测：分类耗时几乎全是生成输出，
// Opus low 比 high 中位快 40%、53 条回归集无新增误判；换 Sonnet / Haiku 不更快、反而漏判），缺省同任务模型与强度。
export const resolveAiModelConfig = (localConfig, executor) => {
  if (!localConfig || typeof localConfig !== 'object') return { model: null, reasoningEffort: null, provider: null, analysisModel: null, analysisEffort: null, intentModel: null, intentEffort: null }
  switch (executor) {
    case 'codex':
      return { model: localConfig.codexModel, reasoningEffort: localConfig.codexReasoningEffort, provider: null }
    case 'pi':
      return { model: localConfig.piModel, reasoningEffort: localConfig.piReasoningEffort, provider: localConfig.piProvider }
    case 'cursor':
      return { model: localConfig.cursorModel, reasoningEffort: null, provider: null }
    case 'claude':
    default: {
      const model = localConfig.claudeModel || localConfig.model || null
      const reasoningEffort = localConfig.claudeEffort || localConfig.reasoningEffort || null
      return {
        model,
        reasoningEffort,
        provider: null,
        analysisModel: localConfig.claudeAnalysisModel || model,
        analysisEffort: localConfig.claudeAnalysisEffort || reasoningEffort,
        intentModel: localConfig.claudeIntentModel || model,
        intentEffort: localConfig.claudeIntentEffort || reasoningEffort,
      }
    }
  }
}

// 模型命名空间：同一个模型在不同 API 线路上名字不同（uniaix / 本机订阅用裸名 `claude-opus-5-5`，reachvpn 要
// `@hqex-react-aventong-3/claude-opus-5-5`）。运行配置只钉裸名，前缀由 claude.env 的 LARK_CLAUDE_MODEL_NAMESPACE
// 给出——它和 key / base_url 由 `apikey <线路>` 一起写，切线路不用改运行配置（11-04 切线路后 bot 停摆的教训）。
// 已带 `@…/` 前缀的模型名原样传，不重复加。
export const namespacedClaudeModel = (model, namespace = process.env.LARK_CLAUDE_MODEL_NAMESPACE) => {
  if (!model) return model
  const ns = String(namespace || '').trim()
  if (!ns || model.startsWith('@')) return model
  return `${ns.endsWith('/') ? ns : `${ns}/`}${model}`
}

// claude 的模型 / 推理强度参数：缺省不传，由 claude.env 的 ANTHROPIC_MODEL（proxy）或账号默认（local）决定。
// 所有 claude 调用（任务 / 分析 / 分类 / 启动探针）都从这里出 --model，命名空间只在这一处加。
export const claudeModelArgs = ({ model, effort, namespace }) => {
  const m = namespacedClaudeModel(model, namespace)
  return [
    ...(m ? ['--model', m] : []),
    ...(effort ? ['--effort', effort] : []),
  ]
}


// 无头任务模式摘掉的 Claude 内建工具：会结束本轮 / 排程到未来（ScheduleWakeup、Cron*）、把活甩到别的会话或云端
// （Workflow、RemoteTrigger）、切换工作目录（EnterWorktree / ExitWorktree）。这些在交互式会话里合理，在 `-p` 一次性
// 工单里只会让会话提前结束、结果文件没写（falive 教训 #31：模型把长命令放后台再 ScheduleWakeup「等它」，活干成了却报失败）。
export const CLAUDE_HEADLESS_DISALLOWED_TOOLS = Object.freeze([
  'ScheduleWakeup',
  'CronCreate',
  'CronDelete',
  'CronList',
  'RemoteTrigger',
  'Workflow',
  'EnterWorktree',
  'ExitWorktree',
])
// 「不 commit / 不 push」的硬拦（提交由 Worker 在终检后统一做）：只写在提示词里是软约束，跳过权限模式下照样能执行。
// deny 规则在 --dangerously-skip-permissions 下仍生效（11-01 探针：`cd x && git push`、`git -C x push`、`git -c a=b commit`
// 全拦，`git -c … status` 不误伤）。`git * push*` 兜住 git 与子命令之间夹 -C / -c 选项的写法。
export const CLAUDE_GIT_DENY_RULES = Object.freeze([
  'Bash(git push:*)',
  'Bash(git * push*)',
  'Bash(git commit:*)',
  'Bash(git * commit*)',
])
// 宿主隔离（docs/upgrade-plan-context-layers-2026-11-01.md S1）：bot 的 claude 会话默认会吃进本机个人设置
// （~/.claude/settings.json 的 hooks / outputStyle / model / modelSettings 强度表、个人 skills）和账号级 claude.ai 连接器
// （Google Drive / Sheets / Docs / Figma，falive 96 个实施会话里 40 个挂着）。换台机器这些全变，行为变了无处可查。
// - --strict-mcp-config：不给 --mcp-config = 一个 MCP 都不连（bot 的 Figma / Lark 文档都是 Worker 确定性预取，不靠模型选工具）。
// - --setting-sources project：只读业务仓 .claude/settings.json。前提是模型 / 强度已在本仓配置钉住——否则隔离后会静默
//   变成账号默认，所以没钉就不隔离（返回 null）并由 validateConfig / doctor 告警。claudeSettingSources 显式配置优先（回滚用，
//   如 "user,project,local" = 旧行为）。纯函数。
export const resolveClaudeSettingSources = (localConfig = {}) => {
  const explicit = localConfig?.claudeSettingSources
  if (typeof explicit === 'string' && explicit.trim()) return { value: explicit.trim(), isolated: !/\buser\b/.test(explicit), reason: '配置 claudeSettingSources' }
  const { model, reasoningEffort } = resolveAiModelConfig(localConfig, 'claude')
  if (model && reasoningEffort) return { value: 'project', isolated: true, reason: '已钉 claudeModel / claudeEffort，只读业务仓项目设置' }
  return { value: null, isolated: false, reason: '未钉 claudeModel / claudeEffort：不隔离个人设置（否则模型 / 强度会静默变成账号默认）' }
}
export const claudeIsolationArgs = (settingSources) => [
  '--strict-mcp-config',
  ...(settingSources ? ['--setting-sources', settingSources] : []),
]
// 系统层（驾驶规则）：追加到默认系统提示后面，不用 --system-prompt（那会把默认的工具指导与安全指令整个换掉）。
// --exclude-dynamic-system-prompt-sections 把 cwd / git status / 记忆路径挪进首条 user 消息，系统层跨任务、跨 worktree 逐字相同，
// 才可能命中提示缓存。分析与实施共用同一份：续会话沿用首轮快照（--system-prompt-snapshot 默认 on），两阶段口径一致。
export const claudeSystemPromptArgs = (systemPromptText) => systemPromptText
  ? ['--append-system-prompt', systemPromptText, '--exclude-dynamic-system-prompt-sections']
  : []

