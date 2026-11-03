#!/usr/bin/env node
/**
 * falive-bot add-chat：把一个新群接进 falive-bot（拉自定义机器人进群后跑一次）。
 *   falive-bot add-chat --name "Falive 前端交接群" --webhook <地址> --secret <密钥> [--repo falive] [--label 显示名] [--chat-id oc_xxx]
 * 做的事和原因见 lib/lark-chat-onboard.mjs；写完配置不用手动重启（worker 排空重启自动接上）。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

import { onboardChat, probeWebhook } from '../lib/lark-chat-onboard.mjs'
import { formatLarkCliError, larkCallFailed, listChatCustomBots, runLarkCli } from '../lib/lark-cli.mjs'
import { validateConfig } from '../lib/lark-config.mjs'
import { larkRuntimeDir } from '../lib/lark-repo.mjs'

const USAGE = 'usage: falive-bot add-chat --name <群名> | --chat-id <oc_…>  --webhook <地址> [--secret <密钥>] [--repo falive] [--label <显示名>]'
const args = process.argv.slice(2)
const flag = (key) => {
  const index = args.indexOf(`--${key}`)
  return index >= 0 ? String(args[index + 1] || '').trim() : ''
}
if (args.includes('-h') || args.includes('--help')) {
  console.log(USAGE)
  process.exit(0)
}

const searchChats = async (name) => {
  const result = await runLarkCli(['im', '+chat-search', '--query', name, '--format', 'json'], { identity: 'user' })
  if (larkCallFailed(result)) throw new Error(`查群失败：${formatLarkCliError(result)}`)
  const data = JSON.parse(result.stdout).data || {}
  return data.chats || data.items || []
}

try {
  const out = await onboardChat({
    configPath: join(larkRuntimeDir, 'lark-bot.local.json'),
    repoKey: flag('repo') || 'falive',
    name: flag('name'),
    chatId: flag('chat-id'),
    webhookUrl: flag('webhook'),
    secret: flag('secret'),
    label: flag('label'),
    credDir: join(homedir(), '.config', 'fameex-lark'),
    deps: {
      searchChats,
      listBots: (chatId) => listChatCustomBots(chatId),
      probe: probeWebhook,
      validate: (config) => validateConfig(config).errors,
      now: () => new Date(),
    },
  })
  if (!out.ok) {
    console.error(`✖ 没接入：${out.reason}\n${USAGE}`)
    process.exit(1)
  }
  console.log([
    `✅ 已接入「${out.label || out.chatId}」（${out.chatId}）`,
    '- webhook 校验通过（没往群里发消息）',
    `- 群里的机器人：${out.botOpenId || '没认出，见下'}`,
    `- 凭据：${out.webhookFile}（0600）`,
    `- 配置已写入，原配置备份在 ${out.backup}`,
    ...out.notes.map((note) => `- ⚠ ${note}`),
    '- 不用手动重启：worker 看到配置变了，手上任务跑完、自检通过后自动重启（通常几分钟；falive-bot status 可看）',
  ].join('\n'))
} catch (error) {
  console.error(`✖ 没接入：${String(error?.message || error).slice(0, 300)}`)
  process.exit(1)
}
