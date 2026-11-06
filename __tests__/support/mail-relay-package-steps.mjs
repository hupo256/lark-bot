/**
 * 测试段落（并进 __tests__/lark-mail-relay.test.mjs 的同一个 it，测试体量棘轮不加 it）。
 * packages/mail-relay 独立包（11-05 P1 拆分，docs/plan/plan-mail-relay-standalone-2026-11-05.md）：
 * 包边界（不 import lark-bot）、自带 lark-cli 层与 lark-bot 的参数逐字一致、独立运行的路径缺省、长连接、独立入口。
 * 引擎 / 路由 / 评分 / 转发的行为照旧由 __tests__/lark-mail-relay.test.mjs 覆盖（经 lib/ 薄转发）。
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as botCli from '../../lib/lark-cli.mjs'
import { startConsumer } from '../../packages/mail-relay/consumer.mjs'
import { comparisonClean, compareLedgers, renderComparison } from '../../packages/mail-relay/compare.mjs'
import { createFailureAlarm, createRelayCli, fileRelayIo, isRelayAuthError, MAIL_RELAY_STANDALONE_STATE_FILE, RELAY_USER_SCOPES, startMailRelay } from '../../packages/mail-relay/engine.mjs'
import { validateMailRelay } from '../../packages/mail-relay/routes.mjs'
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
const memIo = (initial) => {
  let state = JSON.parse(JSON.stringify(initial))
  return { read: () => JSON.parse(JSON.stringify(state)), write: (next) => { state = JSON.parse(JSON.stringify(next)) } }
}
const B2B_ROUTE = { id: 'b2b', label: 'B2B', chatId: 'oc_group', match: { subject: ['Prod-b2b'] }, scorer: null }

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
      // compare：本配置台账（stateFile 相对配置目录）对另一份；全一致退 0、有差异退 3 并逐条列出；缺 --against 退 2
      writeFileSync(join(dir, 'mine.json'), JSON.stringify({ forwarded: { m1: { at: '2026-11-06T02:00:00Z', route: 'b2b', ok: true, dryRun: true } } }))
      writeFileSync(join(dir, 'live.json'), JSON.stringify({ forwarded: { m1: { at: '2026-11-06T02:00:05Z', route: 'b2b', ok: true } } }))
      writeFileSync(join(dir, 'live2.json'), JSON.stringify({ forwarded: {} }))
      const shadowConfig = join(dir, 'shadow.json')
      writeFileSync(shadowConfig, JSON.stringify({ enabled: true, shadow: true, stateFile: 'mine.json', routes: [B2B_ROUTE] }))
      const same = node(['compare', '--config', shadowConfig, '--against', join(dir, 'live.json')])
      assert.deepEqual([same.status, same.stdout.trim()], [0, '一致 1 封；只在本机影子 0 封；只在对照台账 0 封；两边结果不同 0 封'])
      const gap = node(['compare', '--config', shadowConfig, '--against', join(dir, 'live2.json'), '--since', '2026-11-06T00:00:00Z'])
      assert.equal(gap.status, 3)
      assert.match(gap.stdout, /只在本机影子：m1（b2b，2026-11-06T02:00:00Z）/)
      assert.equal(node(['compare', '--config', shadowConfig]).status, 2)
      // 部署模板：示例配置通过校验、是影子模式；launchd 模板占位符全被 render-plist.sh 换掉
      const example = JSON.parse(readFileSync(join(pkgDir, 'deploy', 'config.example.json'), 'utf8'))
      assert.deepEqual([validateMailRelay(example.mailRelay), example.mailRelay.shadow, example.mailRelay.mode, example.mailRelay.pollMs, example.mailRelay.routes.map((route) => route.id)], [[], false, 'watch', 300000, ['access', 'ol-release', 'b2b-prod']])
      const rendered = spawnSync('sh', [join(pkgDir, 'deploy', 'render-plist.sh'), '/abs/config.json', '/abs/relay.log'], { encoding: 'utf8' })
      if (rendered.status === 0) {
        assert.doesNotMatch(rendered.stdout, /__[A-Z_]+__/)
        assert.match(rendered.stdout, /<string>\/abs\/config\.json<\/string>[\s\S]*<string>\/abs\/relay\.log<\/string>/)
      } else assert.match(rendered.stderr, /找不到 (node|lark-cli)/, '机器上没装 lark-cli 时如实报错')
      assert.equal(spawnSync('sh', [join(pkgDir, 'deploy', 'render-plist.sh'), 'relative.json'], { encoding: 'utf8' }).status, 1, '配置路径必须是绝对路径')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }],
  ['独立入口 run：常驻不自己退出（引擎计时器都 unref，靠入口撑住事件循环）；SIGTERM 正常退 0', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mail-relay-run-'))
    try {
      const config = join(dir, 'config.json')
      writeFileSync(config, JSON.stringify({ enabled: true, shadow: true, pollMs: 60_000, routes: [B2B_ROUTE] }))
      const child = spawn(process.execPath, [join(pkgDir, 'bin', 'mail-relay.mjs'), 'run', '--config', config], { env: { ...process.env, NODE_TEST_CONTEXT: 'child' }, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      child.stdout.on('data', (chunk) => { out += chunk })
      const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
      const early = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve(null), 1500))])
      assert.equal(early, null, `run 不该自己退出：${JSON.stringify(early)}`)
      assert.match(out, /已启用 1 条路由.*影子模式/)
      child.kill('SIGTERM')
      assert.deepEqual(await exited, { code: 0, signal: null })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }],
  ['影子模式：照常读信判路由记台账（dryRun: true）、不分享不回评分；shadow 只收 true / false', async () => {
    const calls = []
    const mail = { message_id: 'm1', subject: '【B2B_直播中心】【Prod-b2b正式环境】nginx', date: '2026-11-06T02:00:00Z' }
    const run = async (args) => {
      calls.push(args.slice(0, 2).join(' '))
      if (args[1] === '+triage') return { code: 0, stdout: JSON.stringify({ messages: [mail] }), stderr: '' }
      if (args[1] === '+message') return { code: 0, stdout: JSON.stringify({ data: { ...mail, head_from: { name: 'Encone' } } }), stderr: '' }
      return { code: 0, stdout: '{"ok":true,"data":{"im_message_id":"om_card","message_id":"om_x"}}', stderr: '' }
    }
    const io = memIo({ checkedAt: '2026-11-06T01:00:00Z', forwarded: {} })
    const relay = await quiet(() => startMailRelay({ relay: { enabled: true, shadow: true, routes: [B2B_ROUTE] }, io, cli: { run, env: null }, schedule: () => null }))
    for (let i = 0; i < 20 && !io.read().forwarded.m1; i += 1) await new Promise((resolve) => setImmediate(resolve))
    relay.stop()
    assert.deepEqual(calls, ['mail +triage', 'mail +message'], '不分享卡片、不回评分')
    assert.deepEqual(Object.keys(io.read().forwarded.m1).sort(), ['at', 'dryRun', 'ok', 'route'])
    assert.deepEqual([io.read().forwarded.m1.dryRun, io.read().forwarded.m1.route], [true, 'b2b'])
    assert.deepEqual(validateMailRelay({ enabled: true, shadow: 'yes', routes: [B2B_ROUTE] }), ['mailRelay.shadow 必须是 true / false'])
  }],
  ['授权过期告警：授权类错误附重新授权命令（带凭证目录与全部用户权限）、别的错误不附；影子模式前缀', () => {
    const hint = 'LARKSUITE_CLI_CONFIG_DIR=/c lark-cli auth login --scope "x"'
    const alarm = createFailureAlarm({ afterFailures: 1, reloginHint: hint, prefix: '[影子] ' })
    const said = alarm.observe({ at: '2026-11-06T01:00:00Z', failed: true, error: '退出码 1；authentication code 99991679 token expired' })
    assert.match(said, /^\[影子\] 审批邮件转发：连续 1 次读收件箱失败/)
    assert.ok(said.endsWith(`像是邮箱授权过期了，在跑转发的那台机器上重新授权：\n${hint}`))
    alarm.observe({ at: '2026-11-06T01:02:00Z', checked: 0 })
    assert.doesNotMatch(alarm.observe({ at: '2026-11-06T01:04:00Z', failed: true, error: '退出码 -1；[lark-cli timeout after 60000ms]' }), /重新授权/)
    assert.deepEqual(['authorization failed', 'need re-login', 'user access_token invalid', '99991668', 'network/transport dial tcp', 'HTTP 429', null].map(isRelayAuthError), [true, true, true, true, false, false, false])
    assert.deepEqual(RELAY_USER_SCOPES, ['mail:user_mailbox:readonly', 'mail:user_mailbox.message:readonly', 'mail:user_mailbox.message.subject:read', 'mail:user_mailbox.message.body:read', 'mail:user_mailbox.message.address:read', 'mail:event', 'mail:user_mailbox.event.mail_address:read', 'im:message', 'im:message.send_as_user', 'offline_access'])
  }],
  ['对账：按 message_id 对齐，分出一致 / 只在一边 / 结果不同（路由、成没成、分数、档位）；since / until 窗口；报告逐条', () => {
    const left = { forwarded: {
      a: { at: '2026-11-06T02:00:00Z', route: 'ol', ok: true, score: 12, tier: 'B', dryRun: true },
      b: { at: '2026-11-06T03:00:00Z', route: 'b2b', ok: true, dryRun: true },
      c: { at: '2026-11-06T04:00:00Z', route: 'ol', ok: true, score: 9, tier: 'C', dryRun: true },
      old: { at: '2026-11-05T02:00:00Z', route: 'ol', ok: true },
    } }
    const right = { forwarded: {
      a: { at: '2026-11-06T02:00:03Z', route: 'ol', ok: true, score: 12, tier: 'B' },
      c: { at: '2026-11-06T04:00:02Z', route: 'ol', ok: true, score: 10, tier: 'C' },
      d: { at: '2026-11-06T05:00:00Z', route: 'access', ok: false, step: 'filter' },
      bad: { at: 'x', route: 'ol', ok: true },
    } }
    const result = compareLedgers({ left, right, since: '2026-11-06T00:00:00Z' })
    assert.deepEqual([result.same.map((item) => item.id), result.onlyLeft.map((item) => item.id), result.onlyRight.map((item) => item.id), result.differ.map((item) => item.id)], [['a'], ['b'], ['d'], ['c']])
    assert.equal(comparisonClean(result), false)
    assert.equal(renderComparison({ comparison: result, leftName: '影子', rightName: '线上' }), [
      '一致 1 封；只在影子 1 封；只在线上 1 封；两边结果不同 1 封',
      '- 只在影子：b（b2b，2026-11-06T03:00:00Z）',
      '- 只在线上：d（access 没转成(filter)，2026-11-06T05:00:00Z）',
      '- 不同：c（影子 ol 9分 C；线上 ol 10分 C）',
    ].join('\n'))
    assert.deepEqual(compareLedgers({ left, right, since: '2026-11-06T00:00:00Z', until: '2026-11-06T02:30:00Z' }).same.map((item) => item.id), ['a'])
    assert.equal(compareLedgers({ left: {}, right: { forwarded: null } }).same.length, 0)
    assert.equal(comparisonClean(compareLedgers({ left, right: left })), true)
  }],
]
