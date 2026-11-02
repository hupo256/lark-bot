/**
 * 常驻进程日志带时间（aven 11-02：worker.log / gateway.log 没时间，排空花了多久、哪一段慢都量不出来）。
 * 在 gateway / worker / poller 的 run 入口装一次：console.log / info / warn / error 每行前加本地时间「MM-DD HH:mm:ss.SSS」。
 * LARK_LOG_TIMESTAMPS=0 关；重复装不叠加。只改前缀，不改各处 [lark-xxx] 标签与正文。
 */

const pad = (n, width = 2) => String(n).padStart(width, '0')

export const formatLogTime = (date = new Date()) =>
  `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`

const INSTALLED = Symbol.for('lark-bot.logTimestamps')

export const installLogTimestamps = ({ target = console, env = process.env, now = () => new Date() } = {}) => {
  if (env.LARK_LOG_TIMESTAMPS === '0' || target[INSTALLED]) return false
  for (const name of ['log', 'info', 'warn', 'error']) {
    const original = target[name].bind(target)
    target[name] = (...args) => original(formatLogTime(now()), ...args)
  }
  target[INSTALLED] = true
  return true
}
