/**
 * 用户身份 lark-cli 调用的护栏（aven 11-06）。
 *
 * 背景：用户访问凭证 2 小时过期，过期前后的那次用户身份调用里 lark-cli 会顺手拿刷新凭证换新。飞书刷新凭证一次性、换完旧的作废，
 * 所以 lark-cli（internal/auth/uat_client.go）在「刷新请求已发出、没拿到有效响应」时（断网、连接断、进程被杀）判定旧凭证可能已作废，
 * 直接删掉本机存的凭证 → 之后每次都报 need_user_authorization，要人重新 `lark-cli auth login`。
 * 11-05 19:29 就是这样：刷新时 DNS 解析 accounts.larksuite.com 失败，凭证被清，bug 通知读不到 13 小时。
 *
 * 这里做两件事：
 *   1. 调用前探测 accounts 域名能不能连上（DNS + TCP 443），连不上就本轮不调、返回一个可重试的失败结果，不让 lark-cli 在断网时去刷新；
 *   2. 从 stderr 里挑出 lark-cli 的 uat-client 行（刷新重试 / 清凭证的原因），调用方原样写进日志——失败账本只留 300 字、会截掉这些。
 * 探测通过也不保证刷新途中不断网，只是把「明知断网还去刷」这一段挡掉。
 */
import { connect } from 'node:net'

// 品牌 lark（国际版）的账号域名；飞书国内版是 accounts.feishu.cn。换应用 / 品牌时用环境变量覆盖。
export const USER_AUTH_HOST = process.env.LARK_USER_AUTH_HOST || 'accounts.larksuite.com'
export const USER_AUTH_PROBE_TIMEOUT_MS = 5000

/** DNS + TCP 连一下 host:443，连上即断。返回 { ok, reason }，不抛。 */
export const probeReachable = ({ host = USER_AUTH_HOST, port = 443, timeoutMs = USER_AUTH_PROBE_TIMEOUT_MS } = {}) =>
  new Promise((resolve) => {
    let settled = false
    const socket = connect({ host, port })
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(result)
    }
    // 措辞别带「超时」「timed out after」：失败指纹会把它归成执行超时；这里要归「接口瞬时错误」（见 skippedUserCallResult）。
    const timer = setTimeout(() => finish({ ok: false, reason: `${timeoutMs}ms 内没连上` }), timeoutMs)
    socket.once('connect', () => finish({ ok: true }))
    socket.once('error', (error) => finish({ ok: false, reason: error?.code || error?.message || 'unknown' }))
  })

// 单测进程里不碰网络（同 larkCliBin 的 /usr/bin/false 约定）。
export const defaultUserAuthProbe = process.env.NODE_TEST_CONTEXT ? async () => ({ ok: true }) : () => probeReachable()

/**
 * 探测不通时代替真实调用的结果：形状同 spawnLarkCli（code -1 → isTransientLarkError 判瞬时、读类调用会退避重试）。
 * 文案带 network error、不带「登录 / login / token」字眼：失败指纹归 transient_api（外部原因只告警），不误归「权限 / 登录」。
 */
export const skippedUserCallResult = ({ host = USER_AUTH_HOST, reason }) => ({
  code: -1,
  stdout: '',
  stderr: `[lark-bot] 用户身份调用前探测 ${host} 不通（${reason}，network error），本轮跳过：断网时让 lark-cli 刷新用户凭证，它会把本机凭证清掉、要重新授权`,
})

/** stderr 里 lark-cli 刷新用户凭证相关的行（uat-client: …），没有返回 []。 */
export const uatClientNotes = (stderr) =>
  String(stderr || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes('uat-client:'))
