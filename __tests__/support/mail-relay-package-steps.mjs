/**
 * 测试段落（并进 __tests__/lark-mail-relay.test.mjs 的同一个 it，测试体量棘轮不加 it）。
 * packages/mail-relay 独立包（11-05 P1 拆分，docs/plan/plan-mail-relay-standalone-2026-11-05.md）：
 * 包边界（不 import lark-bot）、自带 lark-cli 层与 lark-bot 的参数逐字一致、独立运行的路径缺省、长连接、独立入口。
 * 引擎 / 路由 / 评分 / 转发的行为照旧由 __tests__/lark-mail-relay.test.mjs 覆盖（经 lib/ 薄转发）。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as botCli from '../../lib/lark-cli.mjs'
import { startConsumer } from '../../packages/mail-relay/consumer.mjs'
import { createRelayCli, fileRelayIo, MAIL_RELAY_STANDALONE_STATE_FILE, startMailRelay } from '../../packages/mail-relay/engine.mjs'
import * as pkgCli from '../../packages/mail-relay/lark.mjs'
import { eachCase } from './steps.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const pkgDir = join(root, 'packages', 'mail-relay')
const listMjs = (dir) => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? listMjs(join(dir, name)) : name.endsWith('.mjs') ? [join(dir, name)] : []))
const quiet = async (fn) => {
  const original = [console.log, console.warn, console.error]
  console.log = console.warn = console.error = () => {}
  try {
    return await fn()
  } finally {
    ;[console.log, console.warn, console.error] = original
  }
}
const ROUTE = { id: 'ol', preset: 'ol-release', chatId: 'oc_group' }

export const mailRelayPackageSteps = [
  ['包边界：packages/mail-relay 下的文件只 import node: 内置和包内文件，不碰 lark-bot（拆成独立应用的前提）', () => {
    const offenders = []
    for (const file of listMjs(pkgDir)) {
      const source = readFileSync(file, 'utf8')
      for (const [, spec] of source.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"`]([^'"`]+)['"`]/g)) {
        if (spec.startsWith('node:')) continue
        const target = resolve(dirname(file), spec)
        if (!spec.startsWith('.') || relative(pkgDir, target).startsWith('..')) offenders.push(`${relative(root, file)} → ${spec}`)
      }
    }
    assert.deepEqual(offenders, [])
  }],
  ['lark-cli 层对照：发 / 回 Markdown 拼出的参数、返回值、幂等键、标题段、结果解析与 lark-bot lib/lark-cli.mjs 逐字相同（内置时零行为变化）', async () => {
    const capture = (stdouts) => {
      const calls = []
      return { calls, run: async (args) => (calls.push(args), stdouts.length ? stdouts.shift() : { code: 0, stdout: '{"ok":true,"data":{"message_id":"om_1","chat_id":"oc_p2p"}}', stderr: '' }) }
    }
    const fail = { code: 1, stdout: '{"ok":false,"error":{"type":"api","message":"withdrawn"}}', stderr: '' }
    const cases = [
      ['sendMarkdown', { chatId: 'oc_group', markdown: '**标题**\n正文', headline: true }],
      ['sendMarkdown', { chatId: 'ou_me', markdown: '私信' }],
      ['sendMarkdown', { chatId: null, markdown: 'x' }],
      ['replyMarkdown', { messageId: 'om_card', markdown: '**评分**\n说明', headline: true, fallbackChatId: 'oc_group' }],
      ['replyMarkdown', { messageId: 'om_card', markdown: 'x', inThread: true }],
      ['replyMarkdown', { messageId: null, markdown: 'x', fallbackChatId: 'oc_group' }],
      ['replyMarkdown', { messageId: 'om_card', markdown: 'x', fallbackChatId: 'oc_group' }, [fail]],
    ]
    await eachCase(cases, async ([fn, input, failures = []]) => {
      const left = capture([...failures])
      const right = capture([...failures])
      const wait = async () => {}
      const a = await quiet(() => botCli[fn]({ ...input, retries: failures.length || 3, run: left.run, wait }))
      const b = await quiet(() => pkgCli[fn]({ ...input, retries: failures.length || 3, run: right.run, wait }))
      assert.deepEqual(right.calls, left.calls)
      assert.deepEqual(b, a)
    })
    assert.equal(pkgCli.headlinePostContent('**a**\nb'), botCli.headlinePostContent('**a**\nb'))
    assert.equal(pkgCli.markdownIdempotencyKey('oc_x', 'md'), botCli.markdownIdempotencyKey('oc_x', 'md'))
    for (const stdout of ['{"data":{"message_id":"a"}}', '{"data":{"message":{"message_id":"b"}}}', '{"message_id":"c"}', 'x']) assert.equal(pkgCli.parseSentMessageId(stdout), botCli.parseSentMessageId(stdout))
    for (const result of [{ code: 0, stdout: '{"ok":true}' }, { code: 0, stdout: '{"ok": false}' }, { code: 2, stdout: '' }]) assert.equal(pkgCli.larkCallFailed(result), botCli.larkCallFailed(result))
    for (const result of [{ code: -1 }, { stdout: '{"error":{"type":"network"}}' }, { stdout: '{"error":{"message":"HTTP 429"}}' }, { stdout: '{"error":{"type":"auth"}}' }, { stdout: 'x' }]) assert.equal(pkgCli.isTransientLarkError(result), botCli.isTransientLarkError(result))
    assert.deepEqual(pkgCli.messageSendRecipientArgs('ou_x'), botCli.messageSendRecipientArgs('ou_x'))
    assert.equal(pkgCli.larkCliBin, '/usr/bin/false', '单测进程里不碰真飞书')
    assert.deepEqual(await pkgCli.runLarkCli(['im'], { timeoutMs: 5000 }), { code: 1, stdout: '', stderr: '' })
  }],
  ['独立运行缺省：台账默认 <baseDir>/mail-relay-state.json，stateFile / cliConfigDir 相对路径按 baseDir 解析；没给 baseDir 按当前目录', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mail-relay-pkg-'))
    try {
      const run = async () => ({ code: 0, stdout: '', stderr: '' })
      const writeClock = async ({ io }) => (io.write({ checkedAt: 'T', forwarded: {} }), { checked: 0 })
      const relay = { enabled: true, routes: [ROUTE] }
      const first = await quiet(() => startMailRelay({ relay, baseDir: dir, cli: { run, env: null }, catchUp: writeClock, schedule: () => null }))
      await new Promise((resolve) => setImmediate(resolve))
      first.stop()
      assert.equal(JSON.parse(readFileSync(join(dir, MAIL_RELAY_STANDALONE_STATE_FILE), 'utf8')).checkedAt, 'T')
      const second = await quiet(() => startMailRelay({ relay: { ...relay, stateFile: 'state/relay.json' }, baseDir: dir, cli: { run, env: null }, catchUp: writeClock, schedule: () => null }))
      await new Promise((resolve) => setImmediate(resolve))
      second.stop()
      assert.equal(existsSync(join(dir, 'state', 'relay.json')), true)
      assert.deepEqual(createRelayCli({ cliConfigDir: 'cli', baseDir: dir, run }).env, { LARKSUITE_CLI_CONFIG_DIR: join(dir, 'cli') })
      assert.deepEqual(createRelayCli({ cliConfigDir: '/abs/cli', baseDir: dir, run }).env, { LARKSUITE_CLI_CONFIG_DIR: '/abs/cli' })
      assert.equal(createRelayCli({ cliConfigDir: 'cli', run }).env.LARKSUITE_CLI_CONFIG_DIR, resolve('cli'))
      assert.deepEqual(createRelayCli({ run }), { run, env: null })
      assert.deepEqual(fileRelayIo(undefined).read(), { checkedAt: null, forwarded: {} }, '没给路径：空台账、不落盘')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }],
  ['包自带长连接：逐行 JSON 交给 onLine（坏行跳过）、命令与环境变量照传、stop 后不重连', async () => {
    const spawned = []
    const children = []
    const spawnChild = (bin, args, options) => {
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.exitCode = null
      child.kill = () => {}
      spawned.push([bin, args, options.env?.LARKSUITE_CLI_CONFIG_DIR])
      children.push(child)
      return child
    }
    const lines = []
    const consumer = startConsumer({ eventKey: 'mail', command: ['--as', 'user', 'mail', '+watch'], env: { LARKSUITE_CLI_CONFIG_DIR: '/c' }, onLine: (raw) => lines.push(raw), spawnChild })
    children[0].stdout.emit('data', Buffer.from('{"a":1}\nnot json\n{"b"'))
    children[0].stdout.emit('data', Buffer.from(':2}\n'))
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(lines, [{ a: 1 }, { b: 2 }])
    assert.deepEqual(spawned, [['/usr/bin/false', ['--as', 'user', 'mail', '+watch'], '/c']])
    assert.equal(consumer.observe().alive, true)
    consumer.stop()
    children[0].emit('exit', 0)
    assert.equal(children.length, 1, 'stop 之后退出不重连')
  }],
  ['独立入口：check 列出路由；缺 --config 退 2；配置错退 1 并说明；enabled=false 不启动', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mail-relay-bin-'))
    const bin = join(pkgDir, 'bin', 'mail-relay.mjs')
    const node = (args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: 'child' } })
    try {
      const good = join(dir, 'config.json')
      writeFileSync(good, JSON.stringify({ notifyOpenId: 'ou_me', mailRelay: { enabled: true, routes: [ROUTE, { id: 'b2b', label: 'B2B', chatId: 'oc_group', match: { subject: ['Prod-b2b'] } }] } }))
      const check = node(['check', '--config', good])
      assert.equal(check.status, 0, check.stderr)
      assert.deepEqual(check.stdout.trim().split('\n').slice(1), ['- ol（OL 上线申请）→ oc_group，评分器 ol-release', '- b2b（B2B）→ oc_group，评分器 无'])
      assert.equal(node(['check']).status, 2)
      const bad = join(dir, 'bad.json')
      writeFileSync(bad, JSON.stringify({ enabled: true, routes: [{ id: 'x', chatId: 'nope' }] }))
      const invalid = node(['check', '--config', bad])
      assert.equal(invalid.status, 1)
      assert.match(invalid.stderr, /chatId 必须是群 chat_id/)
      const off = join(dir, 'off.json')
      writeFileSync(off, JSON.stringify({ enabled: false, routes: [ROUTE] }))
      const stopped = node(['run', '--config', off])
      assert.deepEqual([stopped.status, stopped.stderr.trim()], [1, 'mailRelay.enabled 不是 true，不启动'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }],
]
