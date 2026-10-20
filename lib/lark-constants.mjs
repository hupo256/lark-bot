/**
 * Lark 模块跨文件共享的默认值与枚举集中地：只收容「无自然归属、且此前分散在多个文件各写一份」
 * 的字面量，避免同一事实换个文件名字就再抄一遍、改的时候漏掉某一处。
 */

export const GATEWAY_HOST = '127.0.0.1'
export const defaultGatewayPort = Number(process.env.LARK_GATEWAY_PORT || 3005)
export const defaultGatewayUrl = process.env.LARK_GATEWAY_URL || `http://${GATEWAY_HOST}:${defaultGatewayPort}`
// 独立实例（aven 2026-10-20：falive 与 fameex 分开部署、互不影响）：plist 注入 LARK_INSTANCE_MODE=repo-only 的那套
// 只服务仓库 profile 的外部群——不建应用机器人长连接、不补拉内部群、不回写 bug 表，发消息只走 webhook。
export const isRepoOnlyInstance = () => process.env.LARK_INSTANCE_MODE === 'repo-only'
// bot 自己跑单测 / 终检时的子进程环境：去掉实例级变量，测试结果不随跑在哪套实例里变（10-20 排空重启在 repo-only 环境下自检红 1 条）。
export const hermeticTestEnv = (env = process.env) => {
  const { LARK_INSTANCE_MODE, LARK_GATEWAY_PORT, LARK_GATEWAY_URL, ...rest } = env
  return rest
}
export const defaultTaskLeaseMs = Number(process.env.LARK_TASK_LEASE_MS || 40 * 60 * 1000)

// AI 执行器枚举：只允许已知 CLI 执行器，任何 Lark/config 输入都不能变成任意命令。
// 第 3 批：只保留 claude（codex / pi / cursor 从未在配置里启用过，四套分支徒增代码）。
export const AI_EXECUTORS = new Set(['claude'])
export const DEFAULT_EXECUTOR = 'claude'
