/**
 * 执行器选择（纯函数）：task > 本机 bot 配置 > wrapper 默认 > 内置默认值。
 * 单独成文件是为了让 gateway（ingest / routes）不必 import 带 spawn 的 lark-ai-executor.mjs（见 lark-gateway-purity 测试）。
 */

import { AI_EXECUTORS, DEFAULT_EXECUTOR } from './lark-constants.mjs'

export const validateAiExecutor = (value, source = 'AI executor') => {
  const normalized = String(value || '').trim().toLowerCase()
  if (!AI_EXECUTORS.has(normalized)) throw new Error(`${source} must be one of: ${[...AI_EXECUTORS].join(', ')}`)
  return normalized
}

// 执行器切换只允许走任务或显式配置，不读取进程环境变量，避免 launchd/终端残留环境让实际执行器与配置文件不一致。
export const resolveAiExecutor = (workerConfig, task) => {
  const candidates = [
    [task.aiExecutor, 'task.aiExecutor'],
    [workerConfig.localConfig?.aiExecutor, 'config.aiExecutor'],
    [workerConfig.aiExecutor, 'worker aiExecutor'],
    [DEFAULT_EXECUTOR, 'default AI executor'],
  ]
  const [value, source] = candidates.find(([candidate]) => candidate != null && String(candidate).trim())
  return validateAiExecutor(value, source)
}
