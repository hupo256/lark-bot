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
// 提示人重启时写哪个命令：falive 独立实例是 falive-bot，fameex 那套是 lark-bot（10-24：falive 的告警写成 lark-bot restart，误导）。
export const botCliName = () => (isRepoOnlyInstance() ? 'falive-bot' : 'lark-bot')
// bot 自己跑单测 / 终检时的子进程环境：去掉实例级变量，测试结果不随跑在哪套实例里变（10-20 排空重启在 repo-only 环境下自检红 1 条）。
// 10-25 也去掉 LARK_CLAUDE_BIN（自检的测试不能拿到真 claude 路径，见 resolveClaudeBinary）和 NODE_TEST_CONTEXT（带着它的
// node --test 会把自己当子测试进程、输出改成序列化格式，摘不出 ℹ tests / ✖ 行）。
export const hermeticTestEnv = (env = process.env) => {
  const { LARK_INSTANCE_MODE, LARK_GATEWAY_PORT, LARK_GATEWAY_URL, LARK_CLAUDE_BIN, NODE_TEST_CONTEXT, ...rest } = env
  return rest
}
export const defaultTaskLeaseMs = Number(process.env.LARK_TASK_LEASE_MS || 40 * 60 * 1000)

// AI 执行器枚举：只允许已知 CLI 执行器，任何 Lark/config 输入都不能变成任意命令。
// 第 3 批：只保留 claude（codex / pi / cursor 从未在配置里启用过，四套分支徒增代码）。
export const AI_EXECUTORS = new Set(['claude'])
export const DEFAULT_EXECUTOR = 'claude'
// claude 二进制：LARK_CLAUDE_BIN 覆盖（与 LARK_CLI_BIN 同风格，沙箱 / 假 claude 用）。node --test 进程里（NODE_TEST_CONTEXT）
// 没显式指定就用一个不存在的路径：测试绝不调真 claude（10-24 fameex 沙箱试跑事故：只靠 PATH 遮挡，假 claude 一失效就落到
// 真 claude；10-25 搬来 falive）。调用时读 env（不在加载时定死），线上不受影响。所有起 claude 的地方都经它。
export const TEST_CLAUDE_BIN = '/nonexistent/lark-bot-test-no-claude'
export const resolveClaudeBinary = (env = process.env) => env.LARK_CLAUDE_BIN || (env.NODE_TEST_CONTEXT ? TEST_CLAUDE_BIN : 'claude')
