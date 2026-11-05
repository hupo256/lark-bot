/**
 * 审批邮件转群引擎在 lark-bot 里的接线（11-05 P1：引擎本体拆到 packages/mail-relay/，见 docs/plan/plan-mail-relay-standalone-2026-11-05.md）。
 * 这里只做薄转发，并注入 lark-bot 的默认件：
 *   · lark-cli 调用器 = lib/lark-cli.mjs 的 runLarkCli（应用令牌缓存、单测不碰真飞书）；
 *   · 长连接 = lib/lark-consumer.mjs（带掉线告警与健康观测）；
 *   · 台账 = runtime/lark-mail-relay-state.json，stateFile / cliConfigDir 的相对路径按仓库根解析。
 * 网关（lark-gateway.mjs）与 scripts/lark-mail-relay.mjs 用这一份；独立运行（Mac mini）用 packages/mail-relay/bin/mail-relay.mjs。
 */
import { join } from 'node:path'

import * as engine from '../packages/mail-relay/engine.mjs'
import { runLarkCli } from './lark-cli.mjs'
import { startConsumer } from './lark-consumer.mjs'
import { larkBotRoot, larkRuntimeDir, resolveFromLarkBotRoot } from './lark-paths.mjs'

export {
  RELAY_ALERT_AFTER_FAILURES,
  RELAY_POLL_MIN_MS,
  RELAY_POLL_MS,
  RELAY_POLL_OVERLAP_MS,
  catchUpRelay,
  createFailureAlarm,
  createRelayHandler,
  mailFromWatchLine,
  pickRoute,
  relayAlertSettings,
  relayFailureText,
  relayPollMs,
} from '../packages/mail-relay/engine.mjs'

export const MAIL_RELAY_STATE_FILE = 'lark-mail-relay-state.json'
const defaultPath = () => (process.env.NODE_TEST_CONTEXT && !process.env.LARK_RUNTIME_DIR ? null : join(larkRuntimeDir, MAIL_RELAY_STATE_FILE))

export const fileRelayIo = (path = defaultPath()) => engine.fileRelayIo(path)

export const createRelayCli = ({ cliConfigDir, run = runLarkCli } = {}) =>
  engine.createRelayCli({ cliConfigDir: cliConfigDir ? resolveFromLarkBotRoot(cliConfigDir) : cliConfigDir, run, baseDir: larkBotRoot })

export const startMailRelay = ({ relay, io, cli, consume = startConsumer, ...rest } = {}) =>
  engine.startMailRelay({
    relay,
    io: io || fileRelayIo(relay?.stateFile ? resolveFromLarkBotRoot(relay.stateFile) : undefined),
    cli: cli || createRelayCli({ cliConfigDir: relay?.cliConfigDir }),
    consume,
    baseDir: larkBotRoot,
    ...rest,
  })
