import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { applyChatToRepoConfig, classifyWebhookProbe, findCustomBot, onboardChat, pickChatByName, probeWebhook, webhookFileFor } from '../lib/lark-chat-onboard.mjs'
import { signWebhook } from '../lib/lark-webhook.mjs'
import { runSteps } from './support/steps.mjs'

// 新群接入（aven 11-03：「每加一个群都要改好几处 + 重启」）：人只给 webhook 地址 / 密钥，其余一条命令做完。
const CHAT = 'oc_5eda2a60f85fb2f7807b64a8526bf7e5'
const baseConfig = () => ({
  project: 'PR-1',
  repos: {
    falive: { botName: 'Aven.Bot', chatIds: ['oc_old'], webhooksByChat: { oc_old: { file: '/x/old.json' } }, chatLabels: { oc_old: '旧群' }, botMentionOpenIds: { oc_old: 'ou_old' } },
    other: { chatIds: ['oc_other'] },
  },
})
let dir = ''
const setup = () => {
  dir = mkdtempSync(join(tmpdir(), 'lark-onboard-'))
  writeFileSync(join(dir, 'lark-bot.local.json'), JSON.stringify(baseConfig()), { mode: 0o600 })
}
const deps = (over = {}) => ({
  searchChats: async () => [{ chat_id: CHAT, name: 'Falive 前端交接群' }, { chat_id: 'oc_y', name: 'Falive 前端交接群（旧）' }],
  listBots: async () => [{ name: 'Lark CLI', openId: 'ou_cli' }, { name: 'Aven.bot', openId: 'ou_80f6' }],
  probe: async () => ({ ok: true }),
  validate: () => [],
  now: () => new Date('2026-11-03T09:55:00Z'),
  ...over,
})
const run = (over = {}, args = {}) => onboardChat({ configPath: join(dir, 'lark-bot.local.json'), name: 'Falive 前端交接群', webhookUrl: 'https://hook/x', secret: 's3', credDir: dir, deps: deps(over), ...args })
const readConfig = () => JSON.parse(readFileSync(join(dir, 'lark-bot.local.json'), 'utf8'))

describe('新群接入 add-chat', () => {
  it('认机器人不分大小写、群名只认精确、webhook 校验不发消息、写四处 + 0600 凭据 + 备份；任一步不过就不写文件', () => runSteps([
    ['纯函数：认机器人 / 选群 / 判校验结果 / 改配置', () => {
      assert.equal(findCustomBot([{ name: 'Aven.bot', openId: 'ou_1' }], 'Aven.Bot')?.openId, 'ou_1', '小写的 Aven.bot 也认')
      assert.equal(findCustomBot([{ name: 'Aven Bot', openId: 'ou_2' }], 'Aven.Bot'), null)
      assert.equal(findCustomBot([{ name: '', openId: 'ou_3' }], ''), null, '空名字不算命中')
      assert.equal(pickChatByName([{ chat_id: 'oc_a', name: ' 群A ' }, { chat_id: 'oc_b', name: '群A2' }], '群A').chat.chat_id, 'oc_a')
      assert.match(pickChatByName([{ chat_id: 'oc_b', name: '群A2' }], '群A').error, /没找到.*群A2/, '只有近似的不猜，报候选')
      assert.match(pickChatByName([{ chat_id: 'oc_a', name: '群A' }, { chat_id: 'oc_c', name: '群A' }], '群A').error, /2 个群/)
      assert.deepEqual([19002, 0].map((code) => classifyWebhookProbe({ code }).ok), [true, true])
      assert.match(classifyWebhookProbe({ code: 19021 }).reason, /密钥/)
      assert.match(classifyWebhookProbe({ StatusCode: 19001, StatusMessage: 'token invalid' }).reason, /19001：token invalid）.*地址/)
      assert.match(classifyWebhookProbe({ code: 19001, msg: 'bad hook' }).reason, /19001：bad hook）/)
      assert.match(classifyWebhookProbe(null).reason, /code 无：响应解析不了）/)
      assert.equal(webhookFileFor('/c', 'falive', CHAT), '/c/falive-webhook-526bf7e5.json')
      const config = baseConfig()
      const next = applyChatToRepoConfig(config, { repoKey: 'falive', chatId: CHAT, label: '交接群', botOpenId: 'ou_80f6', webhookFile: '/c/h.json' })
      assert.deepEqual(next.repos.falive.chatIds, ['oc_old', CHAT])
      assert.deepEqual([next.repos.falive.webhooksByChat[CHAT], next.repos.falive.chatLabels[CHAT], next.repos.falive.botMentionOpenIds[CHAT]], [{ file: '/c/h.json' }, '交接群', 'ou_80f6'])
      assert.equal(next.repos.falive.webhooksByChat.oc_old.file, '/x/old.json', '旧群不动')
      assert.deepEqual(config.repos.falive.chatIds, ['oc_old'], '不改入参')
      assert.deepEqual(applyChatToRepoConfig(next, { repoKey: 'falive', chatId: CHAT, webhookFile: '/c/h.json' }).repos.falive.chatIds, ['oc_old', CHAT], '重复接入不重复加')
      assert.equal(applyChatToRepoConfig(config, { repoKey: 'falive', chatId: CHAT, webhookFile: '/f' }).repos.falive.botMentionOpenIds[CHAT], undefined, '没认出机器人不写 id')
      // 控制台群（--console）：写 notifyChatId + webhook，不进仓库群；仓库群和控制台互斥
      const asConsole = applyChatToRepoConfig(config, { repoKey: 'falive', chatId: 'oc_console', label: '控制台', webhookFile: '/c/con.json', console: true })
      assert.equal(asConsole.repos.falive.notifyChatId, 'oc_console')
      assert.ok(!(asConsole.repos.falive.chatIds || []).includes('oc_console'), '控制台不进 chatIds')
      assert.deepEqual(asConsole.repos.falive.webhooksByChat.oc_console, { file: '/c/con.json' })
      assert.throws(() => applyChatToRepoConfig(asConsole, { repoKey: 'falive', chatId: 'oc_console', webhookFile: '/f' }), /是控制台群/)
      assert.throws(() => applyChatToRepoConfig(next, { repoKey: 'falive', chatId: CHAT, webhookFile: '/f', console: true }), /已经是仓库群/)
      assert.throws(() => applyChatToRepoConfig(config, { repoKey: 'falive', chatId: 'oc_other', webhookFile: '/f' }), /已经属于仓 other/)
      assert.throws(() => applyChatToRepoConfig(config, { repoKey: 'nope', chatId: CHAT, webhookFile: '/f' }), /没有仓 nope/)
    }],
    ['probeWebhook：带签名、故意错的消息类型；网络错不算通过', async () => {
      let sent = null
      const ok = await probeWebhook({ url: 'https://hook/x', secret: 's3', now: 1_793_699_700_000, fetchImpl: async (url, init) => { sent = JSON.parse(init.body); return { text: async () => '{"code":19002,"msg":"params error"}' } } })
      assert.equal(ok.ok, true)
      assert.equal(sent.msg_type, 'falive_onboard_probe', '不是能发进群的类型')
      assert.equal(sent.sign, signWebhook({ secret: 's3', timestamp: '1793699700' }))
      const bare = await probeWebhook({ url: 'u', fetchImpl: async (url, init) => { sent = JSON.parse(init.body); return { text: async () => 'not json' } } })
      assert.equal(sent.sign, undefined, '没密钥不签名')
      assert.equal(bare.ok, false)
      const down = await probeWebhook({ url: 'u', fetchImpl: async () => { throw new Error('ENOTFOUND') } })
      assert.equal(down.reason, 'webhook 请求失败：ENOTFOUND')
    }],
    ['一次接入：四处写进配置、凭据 0600、原配置备份', async () => {
      const out = await run()
      assert.equal(out.ok, true)
      assert.deepEqual([out.chatId, out.label, out.botOpenId, out.notes], [CHAT, 'Falive 前端交接群', 'ou_80f6', []])
      const repo = readConfig().repos.falive
      assert.deepEqual(repo.chatIds, ['oc_old', CHAT])
      assert.equal(repo.webhooksByChat[CHAT].file, out.webhookFile)
      assert.equal(repo.botMentionOpenIds[CHAT], 'ou_80f6')
      assert.deepEqual(JSON.parse(readFileSync(out.webhookFile, 'utf8')), { webhookUrl: 'https://hook/x', secret: 's3' })
      assert.equal(statSync(out.webhookFile).mode & 0o777, 0o600)
      assert.equal(statSync(join(dir, 'lark-bot.local.json')).mode & 0o777, 0o600, '配置仍是 0600')
      assert.deepEqual(JSON.parse(readFileSync(out.backup, 'utf8')), baseConfig(), '备份是改之前的')
      assert.equal(readdirSync(dir).filter((name) => name.includes('.tmp-')).length, 0, '不留临时文件')
    }],
    ['给 --chat-id 不查群名；没认出机器人照样接入并提示；label 优先', async () => {
      let searched = false
      const out = await run({ searchChats: async () => { searched = true; return [] }, listBots: async () => [{ name: '别的机器人', openId: 'ou_z' }] }, { name: '', chatId: CHAT, label: '交接' })
      assert.equal(searched, false)
      assert.deepEqual([out.ok, out.label, out.botOpenId], [true, '交接', ''])
      assert.match(out.notes[0], /没认出「Aven.Bot」.*别的机器人/)
      assert.equal(readConfig().repos.falive.botMentionOpenIds[CHAT], undefined)
      const padded = await run({}, { name: '  Falive 前端交接群 ' })
      assert.equal(padded.label, 'Falive 前端交接群', '显示名取查到的群名（去空格），不取手敲的参数')
      const again = await run({}, { name: '', chatId: 'oc_old' })
      assert.equal(again.label, '旧群', '只给 chat-id 时沿用已有显示名')
      assert.equal((await run({}, { name: '', chatId: 'oc_new' })).label, '')
      const noSecret = await run({}, { chatId: 'oc_n', name: '', secret: '' })
      assert.deepEqual(JSON.parse(readFileSync(noSecret.webhookFile, 'utf8')), { webhookUrl: 'https://hook/x' }, '没密钥不写 secret 字段')
    }],
    ['任一步不过：报原因、不写任何文件', async () => {
      const before = readdirSync(dir).sort()
      const cases = [
        [{}, { webhookUrl: '' }, /缺 --webhook/],
        [{}, { name: '', chatId: '' }, /缺 --name/],
        [{}, { repoKey: 'nope' }, /没有仓 nope/],
        [{}, { name: '不存在的群' }, /没找到/],
        [{ probe: async () => ({ ok: false, reason: '签名不对' }) }, {}, /签名不对/],
        [{}, { chatId: 'oc_other', name: '' }, /已经属于仓 other/],
        [{ validate: () => ['root 不存在'] }, {}, /校验不过：root 不存在/],
      ]
      for (const [over, args, reason] of cases) {
        const out = await run(over, args)
        assert.equal(out.ok, false, String(reason))
        assert.match(out.reason, reason)
      }
      assert.deepEqual(readdirSync(dir).sort(), before)
      assert.deepEqual(readConfig(), baseConfig())
    }],
  ], { before: setup, after: () => rmSync(dir, { recursive: true, force: true }) }))
})
