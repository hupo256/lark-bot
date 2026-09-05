/**
 * Lark 模块跨文件共享的默认值与枚举集中地：只收容「无自然归属、且此前分散在多个文件各写一份」
 * 的字面量，避免同一事实换个文件名字就再抄一遍、改的时候漏掉某一处。
 */

export const GATEWAY_HOST = '127.0.0.1'
export const defaultGatewayPort = Number(process.env.LARK_GATEWAY_PORT || 3005)
export const defaultGatewayUrl = process.env.LARK_GATEWAY_URL || `http://${GATEWAY_HOST}:${defaultGatewayPort}`
export const defaultTaskLeaseMs = Number(process.env.LARK_TASK_LEASE_MS || 40 * 60 * 1000)

// AI 执行器枚举：只允许已知 CLI 执行器，任何 Lark/config 输入都不能变成任意命令。
export const AI_EXECUTORS = new Set(['claude', 'codex', 'pi', 'cursor'])
export const DEFAULT_EXECUTOR = 'pi'
