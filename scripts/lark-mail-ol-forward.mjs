#!/usr/bin/env node
/**
 * 手动把一封 OL 上线申请邮件转到群并附规范度评分（aven 11-02；事件自动转发落地前用它）：
 *   node scripts/lark-mail-ol-forward.mjs --message-id <邮件 message_id> --chat-id <oc_…> [--dry-run] [--force]
 * --dry-run 只打印评分不发；--force 跳过「OL 申请首封」判定。邮件读 / 分享用 aven 的 user 身份，评分由 bot 回在卡片下。
 */
import { forwardOlMail } from '../lib/lark-mail-ol-forward.mjs'

const argv = process.argv.slice(2)
const option = (name) => {
  const at = argv.indexOf(name)
  return at >= 0 ? argv[at + 1] : undefined
}
const messageId = option('--message-id')
const chatId = option('--chat-id')
const dryRun = argv.includes('--dry-run')
if (!messageId || (!chatId && !dryRun)) {
  console.error('用法：node scripts/lark-mail-ol-forward.mjs --message-id <id> --chat-id <oc_…> [--dry-run] [--force]')
  process.exit(2)
}
const outcome = await forwardOlMail({ messageId, chatId, dryRun, force: argv.includes('--force') })
if (outcome.markdown) console.log(outcome.markdown)
console.log(JSON.stringify({ ...outcome, markdown: undefined, result: outcome.result ? { score: outcome.result.score, tier: outcome.result.tier } : undefined }))
process.exit(outcome.ok ? 0 : 1)
