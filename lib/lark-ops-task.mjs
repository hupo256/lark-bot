/**
 * 运维指令（aven 2026-11-01）：负责人本人私信 bot 下达的固定动作——发部署邮件、推开发分支发 MR。
 * 原来只有 falive-bot 能做（它让模型在 falive 仓里自由执行）；lark-bot 收窄成「固定动作」：
 *   · 不跑模型、不执行任意命令：消息只被解析成下面几种动作之一，由 lark-ops-run.mjs 的固定代码执行；认不出来就回「支持哪些」。
 *   · 只认负责人（notifyOpenId / allowedOpenIds）私信：首行「运维：」显式，或负责人私信里出现部署 / 发推 pre·uat·online 这类说法时推断。
 *   · 发邮件只在消息明确说「不用确认 / 直接发」时才发；否则只回将要发的内容，等负责人回「部署 X 直接发」。
 * 本文件只放纯逻辑（gateway 也引）；执行在 lark-ops-run.mjs（只给 worker）。
 */

import { parseShipAction } from './lark-ship.mjs'

export const OPS_COMMAND_TYPE = 'ops'
const ENV = '(pre|uat|online)'
// 环境 → 远端分支（fameex-web / falive-react 都是同名分支）：部署信查合没合、日报查各环境今天的提交都按它取（lark-daily-report）。
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
 *   { action: 'deploy', env, autoSend, mergedFrom? }  部署 / 发信部署 X（「不用确认 / 直接发」才真发；「X 通过了…合到 Y」先查 X 的改动是否都已进 Y）
 *   { action: 'mr', env }                              发 / 推 X（推开发分支，建发往 X 的 MR）
 *   { action: 'ship', env, branch?, projectId? }       部署 dev / test（lib/lark-ship.mjs）
 * 认不出返回 null。
 */
export const parseOpsAction = (text) => {
  // 部署 dev / test（11-06，lib/lark-ship.mjs）：推分支、打 Labels 合 MR、等 Jenkins、复测。和下面发部署信的「部署 pre / online」分开。
  const ship = parseShipAction(text)
  if (ship) return ship
  const input = String(text || '').replace(/^\s*(?:运维|ops)\s*[:：]\s*/i, '')
  const deploy = new RegExp(`(?:发信)?部署\\s*[「"“']?\\s*${ENV}`, 'i').exec(input) || new RegExp(`发(?:部署)?(?:信|邮件)\\S{0,4}\\s*${ENV}`, 'i').exec(input)
  if (deploy) {
    const env = deploy[1].toLowerCase()
    const autoSend = /不用(?:我)?(?:再)?确认|无需确认|直接发|直接发送/.test(input)
    const from = new RegExp(`${ENV}\\s*(?:环境)?\\s*(?:已经?)?(?:通过|测好|测完|没问题|验过)`, 'i').exec(input)?.[1]?.toLowerCase()
    const asksMerged = new RegExp(`合(?:到|进)\\s*${env}`, 'i').test(input)
    return { action: 'deploy', env, autoSend, ...(asksMerged && from && from !== env ? { mergedFrom: from } : {}) }
  }
  const mr = new RegExp(`(?:^|[^部])[发推]\\s*${ENV}\\b`, 'i').exec(input)
  if (mr) return { action: 'mr', env: mr[1].toLowerCase() }
  return null
}

// 部署 dev / test 的说明（11-06）。
export const SHIP_HELP = '- 部署 dev / test [分支名或项目号]：推分支、按改动打 Labels 合 MR（有冲突先解），Jenkins 部署成功后去该环境复测、私信结果；回复某个任务的结果卡说「部署 test」就用那单的分支'

export const OPS_HELP = [
  '我能办的运维动作（只认你私信）：',
  '- 部署 pre / uat / online：起草部署邮件；带「不用确认 / 直接发」就直接发',
  '- 「uat 通过了，合到 online 的话部署 online，直接发」：先查 uat 的改动是不是都进了 online，进了才发',
  '- 发 pre / uat / online：推开发分支，建发往它的 MR',
].join('\n')

// ── 部署邮件的主题摘要 / 更新说明（按提交标题生成，不跑模型）────────────────

const NOISE_RE = /^(?:docs|test|chore|ci|style|build)(?:\([^)]*\))?!?:|^feat\(bot\)|^Merge /i
const stripPrefix = (subject) => String(subject).replace(/^\w+(?:\([^)]*\))?!?:\s*/, '').split(/——|\s—\s/)[0].trim()

/** info 的 commits（「短 sha 标题」）→ { subjectSummary, update, items }。只有文档 / 测试 / CI 时给固定说法。 */
export const composeDeploySummary = (commits = []) => {
  const subjects = commits.map((line) => String(line).replace(/^[0-9a-f]{7,40}\s+/, ''))
  const real = subjects.filter((s) => !NOISE_RE.test(s))
  const items = [...new Set(real.map(stripPrefix).filter(Boolean))]
  if (!items.length) return { subjectSummary: '文档与测试调整', update: '本次只有文档、测试与 CI 调整，无功能改动。', items }
  const head = items.slice(0, 3).map((s) => (s.length > 30 ? `${s.slice(0, 30)}…` : s))
  return {
    subjectSummary: `${head.join('、')}${items.length > 3 ? ' 等' : ''}`,
    update: `${items.join('；')}${subjects.length > real.length ? '；其余为文档、测试与 CI 调整' : ''}。`,
    items,
  }
}

// 机器人能力清单（代码生成、随功能增长）：分类提示把它当数据块放（lib/lark-classify-prompt），单独一份预算，不占分类规则的预算（11-06）。
export const OPS_CAPABILITIES = `${OPS_HELP}\n${SHIP_HELP}`
