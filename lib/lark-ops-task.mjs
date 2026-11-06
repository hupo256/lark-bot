/**
 * 运维指令（aven 2026-11-01 起；11-06 改成 fameex 口径）：负责人本人私信 bot 下达的固定动作。
 *   · 只认负责人（notifyOpenId / allowedOpenIds）私信：首行「运维：」显式，或负责人私信里出现「部署 / 发推 X」这类说法时推断。
 *   · 现在能办的只有「部署 dev / test」（lib/lark-ship.mjs）：推分支、打 Labels 合 MR、等 Jenkins、复测。
 *   · 「部署 pre / online」「发 pre」这类：fameex 的 pre / online 要人在 Jenkins 手动构建、拿版本号发邮件给 OPS，bot 不代办，
 *     固定回一句说明（manual）。11-06 前这里是 falive 的部署信 / 发 MR（deploy_mail.py、falive-react 开发分支），falive 已下线，删了。
 * 本文件只放纯逻辑（gateway 也引）；执行在 lark-ops-run.mjs（只给 worker）。
 */

import { parseShipAction } from './lark-ship.mjs'

export const OPS_COMMAND_TYPE = 'ops'
const ENV = '(pre|uat|online)'
// 环境 → 远端分支（fameex-web 都是同名分支）：日报查各环境今天的提交按它取（lark-daily-report）。
export const envRef = (env) => `origin/${env}`

// 负责人私信里的运维动作信号（只看负责人本条原话，不看被引用的卡片）。
export const OPS_INTENT_RE = new RegExp(`(部署|发信|发邮件|[发推]\\s*${ENV}\\b|合(?:到|进)\\s*${ENV}\\b)`, 'i')

export const isOpsOwner = (config, openId) =>
  Boolean(openId) && [config?.notifyOpenId, ...(Array.isArray(config?.allowedOpenIds) ? config.allowedOpenIds : [])].filter(Boolean).includes(openId)

/**
 * gateway 入队时定命令类型：显式「运维：」或推断，都只在负责人私信里成立；否则不当运维。
 * 推断还要能解析出动作（parseOpsAction）：11-02 真机，aven 私信问「你能发邮件吗」被 OPS_INTENT_RE 的「发邮件」
 * 拦成运维、回了「没认出要办哪件事」——问能不能、问清楚之类的话该进分类器自答，只有真的说了部署 / 发哪个环境才是运维。
 */
export const resolveOpsCommandType = ({ config, msg, classified }) => {
  const ownerDm = msg?.chatType === 'p2p' && isOpsOwner(config, msg?.senderOpenId)
  if (classified?.type === OPS_COMMAND_TYPE) return ownerDm ? classified : { type: null, source: null }
  const text = String(msg?.text || '')
  if (!classified?.type && ownerDm && OPS_INTENT_RE.test(text) && parseOpsAction(text)) return { type: OPS_COMMAND_TYPE, source: 'inferred' }
  return classified
}

/**
 * 负责人原话 → 动作：
 *   { action: 'ship', env, branch?, projectId? }  部署 dev / test（lib/lark-ship.mjs）
 *   { action: 'manual', env }                     部署 / 发信 / 发推 pre·uat·online：bot 不代办，回一句怎么做
 * 认不出返回 null。
 */
export const parseOpsAction = (text) => {
  const ship = parseShipAction(text)
  if (ship) return ship
  const input = String(text || '').replace(/^\s*(?:运维|ops)\s*[:：]\s*/i, '')
  const manual = new RegExp(`(?:发信)?部署\\s*[「"“']?\\s*${ENV}`, 'i').exec(input) ||
    new RegExp(`发(?:部署)?(?:信|邮件)\\S{0,4}\\s*${ENV}`, 'i').exec(input) ||
    new RegExp(`(?:^|[^部])[发推]\\s*${ENV}\\b`, 'i').exec(input)
  return manual ? { action: 'manual', env: manual[1].toLowerCase() } : null
}

export const OPS_HELP = [
  '我能办的运维动作（只认你私信）：',
  '- 部署 dev / test [分支名或项目号]：推分支、按改动打 Labels 合 MR（有冲突先解），Jenkins 部署成功后去该环境复测、私信结果；回复某个任务的结果卡说「部署 test」就用那单的分支',
  '- pre / online 不代办：要你在 Jenkins 手动构建、拿版本号发邮件给 OPS',
].join('\n')

// 「部署 pre / online」的固定回复。fameex 没有 uat。
export const manualDeployText = (env) => env === 'uat'
  ? 'fameex 没有 uat 环境。我能代办的是「部署 dev / test」。'
  : `${env} 我不代办：合完 MR 要你在 Jenkins 手动点构建，再拿版本号发邮件给 OPS。我能代办的是「部署 dev / test」。`

// 机器人能力清单（代码生成、随功能增长）：分类提示把它当数据块放（lib/lark-classify-prompt），单独一份预算，不占分类规则的预算（11-06）。
export const OPS_CAPABILITIES = OPS_HELP
