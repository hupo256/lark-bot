/**
 * 体检的「AI 执行层」一节（docs/plan/upgrade-plan-context-layers-2026-11-01.md S6）：现有 doctor 查 bot 自己的进程 / 心跳 / 轮询，
 * 这里查 bot 交给 claude 的那一层——CLI 在不在、bot 要用的 flag 在不在、个人设置有没有漏进 bot 会话、业务仓 AGENTS.md
 * 有没有被 CLAUDE.md 遮蔽、常驻硬规则文件在不在。对应《Claude Code 第二阶段 8 个卡点》文末的只读体检脚本：
 * 先查链路，再怀疑模型。只在手动 `lark-bot doctor` 里跑（要起 claude --help 子进程），不进每小时定时体检。
 * buildExecutorChecks 是纯函数；collectExecutorFacts 取数（可注入）。
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { resolveClaudeSettingSources } from './lark-claude-args.mjs'
import { buildFocusedRuleContext, userClaudeMdHasHardRules } from './lark-rule-context.mjs'
import { detectShadowedAgentsDoc } from './lark-work-context.mjs'

// bot 拼 claude 命令行时用到、而老版本 CLI 没有的 flag：缺任何一个，任务一起跑就报 unknown option。
export const REQUIRED_CLAUDE_FLAGS = ['--strict-mcp-config', '--setting-sources', '--append-system-prompt', '--exclude-dynamic-system-prompt-sections', '--disallowedTools', '--json-schema', '--effort', '--safe-mode']

const readJson = (path, read) => {
  try {
    return JSON.parse(read(path))
  } catch {
    return null
  }
}

// 个人设置里会改变 bot 行为的项：没隔离时它们全进 bot 会话。
const leakingUserSettings = (settings) => [
  settings?.hooks && Object.keys(settings.hooks).length ? `hooks（${Object.keys(settings.hooks).join(' / ')}）` : null,
  settings?.outputStyle ? `outputStyle=${settings.outputStyle}` : null,
  settings?.model ? `model=${settings.model}` : null,
  settings?.modelSettings ? 'modelSettings（按模型的强度表）' : null,
].filter(Boolean)

export const collectExecutorFacts = ({
  localConfig = {},
  repoDir,
  home = homedir(),
  spawn = spawnSync,
  read = (path) => readFileSync(path, 'utf8'),
  claudeBin = 'claude',
} = {}) => {
  const executor = localConfig?.aiExecutor || 'claude'
  const run = (args) => {
    try {
      const result = spawn(claudeBin, args, { encoding: 'utf8', stdio: 'pipe', timeout: 15_000 })
      return result.status === 0 ? String(result.stdout || '') : null
    } catch {
      return null
    }
  }
  let rulesError = null
  try {
    buildFocusedRuleContext({ taskText: '' })
  } catch (error) {
    rulesError = String(error?.message || error)
  }
  return {
    executor,
    claudeVersion: executor === 'claude' ? (run(['--version']) || '').trim() || null : null,
    claudeHelp: executor === 'claude' ? run(['--help']) : null,
    userSettings: readJson(join(home, '.claude', 'settings.json'), read),
    settingSources: resolveClaudeSettingSources(localConfig),
    agentsDocShadowed: repoDir ? detectShadowedAgentsDoc(repoDir) : false,
    globalRulesAutoLoaded: userClaudeMdHasHardRules({ home, read }),
    rulesError,
  }
}

export const buildExecutorChecks = (facts) => {
  const checks = []
  const push = (id, level, text, action = '') => checks.push({ id, level, text, action })
  if (facts.rulesError) push('exec-rules', 'bad', `常驻硬规则缺失，所有任务都会 fail-closed：${facts.rulesError.slice(0, 160)}`, '核对 ~/.ai-rules 与本仓 rules/ 是否在、标题是否被改')
  if (facts.executor !== 'claude') {
    push('exec-cli', 'info', `执行器是 ${facts.executor}，跳过 claude 执行层检查`)
    return checks
  }
  if (!facts.claudeVersion) {
    push('exec-cli', 'bad', 'claude CLI 不可执行（claude --version 失败）', '确认 PATH 里有 claude；launchd 环境看 runtime/launchd-node.sh')
    return checks
  }
  const missing = facts.claudeHelp == null ? REQUIRED_CLAUDE_FLAGS : REQUIRED_CLAUDE_FLAGS.filter((flag) => !facts.claudeHelp.includes(flag))
  if (missing.length) push('exec-flags', 'bad', `claude ${facts.claudeVersion} 缺 bot 要用的参数：${missing.join(' ')}`, '升级 claude（npm i -g @anthropic-ai/claude-code 或官方安装器），升级前任务会报 unknown option')
  else push('exec-cli', 'ok', `claude ${facts.claudeVersion}，bot 用到的参数都在`)
  const leaks = leakingUserSettings(facts.userSettings)
  if (facts.settingSources?.isolated) push('exec-isolation', 'ok', `bot 会话只读业务仓项目设置（--setting-sources ${facts.settingSources.value}），不连任何 MCP`)
  else push('exec-isolation', 'warn', `bot 会话没隔离个人设置（${facts.settingSources?.reason || '未知'}）${leaks.length ? `，会漏进去：${leaks.join('、')}` : ''}；MCP 已用 --strict-mcp-config 切断`, '在 runtime/lark-bot.local.json 钉 claudeModel / claudeEffort（等于现在想要的模型与强度），隔离自动生效')
  if (facts.globalRulesAutoLoaded === false) push('exec-global-rules', 'info', '本机 ~/.claude/CLAUDE.md 不带 ~/.ai-rules/AGENT.md 的常驻硬规则：bot 改为把这段注入提示（不靠宿主自动加载）', '想省这段提示：ln -s ~/.ai-rules/AGENT.md ~/.claude/CLAUDE.md')
  if (facts.agentsDocShadowed) push('exec-agents-md', 'info', '业务仓 AGENTS.md 被 CLAUDE.md 遮蔽（Claude Code 不自动加载）：bot 已在系统层点名让它读', '根治：业务仓 CLAUDE.md 顶部加一行 @AGENTS.md')
  return checks
}
