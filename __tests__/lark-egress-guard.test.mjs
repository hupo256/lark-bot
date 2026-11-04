import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, it } from 'node:test'

import { buildAiExecutorCommand, execAiExecutor } from '../lib/lark-ai-executor.mjs'
import {
  EGRESS_DENY_RULES, EGRESS_GUARD_ENV, checkCurlInvocation, checkEgressRequest, createBlockedPath, egressGuardEnv, egressPolicyFor, egressScopeOf, egressTestDataEnvsOf, parseCurlArgs, parseEgressPolicy, withoutEgressGuard,
} from '../lib/lark-egress-policy.mjs'
import { buildLoginRequest, freshLogin, maskToken, readTestPassword, redactSecrets, resolveTestAccount, validateTestAccess } from '../lib/lark-env-login.mjs'
import { EGRESS_GUARD_BIN_DIR, EGRESS_GUARD_PRELOAD, ENV_LOGIN_TOOL } from '../lib/lark-paths.mjs'
import { deriveContract, requestsTestData } from '../lib/lark-task-contract.mjs'
import { classifyLine } from '../scripts/sim/egress-audit.mjs'
import { BLOCK_NOTE, TESTDATA_BLOCK_NOTE, blockedWrite, noteEgress, simBlockNote } from '../scripts/sim/egress-log.mjs'
import { eachCase, runSteps } from './support/steps.mjs'

// 代答 / 实测的出网范围命令层核对（aven 11-04 design-v2 §7；b2 ep-1031-f8065f 代答 curl 了 accounts.google.com/gsi/…）。
const envSites = { pre: 'https://falivepre.fdsser.com', uat: 'https://faliveuat.fdsser.com', online: 'https://www.falive.com' }
const answer = egressPolicyFor({ scope: 'answer', envSites })
const verification = egressPolicyFor({ scope: 'verification', envSites, loginCodeTypes: ['3'] })
const change = egressPolicyFor({ scope: 'change', envSites })
const guardEnv = (policy, extra = {}) => egressGuardEnv({ policy, env: { PATH: process.env.PATH, ...extra }, binDir: EGRESS_GUARD_BIN_DIR, preloadPath: EGRESS_GUARD_PRELOAD })
// 本机起一个 302 到 accounts.google.com 的服务：-L / fetch 跟跳转时在建连处拦，测试不出本机。
const withRedirectServer = async (fn) => {
  const server = createServer((req, res) => res.writeHead(302, { Location: 'https://accounts.google.com/gsi/client' }).end())
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    return await fn(`http://127.0.0.1:${server.address().port}/`)
  } finally {
    server.close()
  }
}
const runAsync = (cmd, args, env) => new Promise((resolve) => {
  const child = spawn(cmd, args, { env })
  let out = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { out += d })
  child.on('close', (status) => resolve({ status, out }))
})

describe('代答 / 实测出网范围（命令层）', () => {
  it('范围口径 / curl 参数解析 / 子进程环境 / 命令行 deny / curl 壳与 node 预载真拦', () => runSteps([
    ['范围档：只有代答 / 实测；主机按 envSites 同主域', () => {
      assert.equal(egressPolicyFor({ scope: 'regular', envSites }), null)
      assert.deepEqual(answer, { scope: 'answer', domains: ['falivepre.fdsser.com', 'faliveuat.fdsser.com', 'falive.com'], loginCodeTypes: [] })
      assert.deepEqual(verification.loginCodeTypes, ['3'])
      assert.deepEqual(egressPolicyFor({ scope: 'answer' }).domains, [], '没配环境地址：除本机外一律不打')
      assert.deepEqual(parseEgressPolicy(JSON.stringify(answer)), answer)
      for (const text of ['{"scope":"answer"}', '{"scope":"regular","domains":[]}', 'not json']) assert.equal(parseEgressPolicy(text), null, text)
      assert.equal(egressScopeOf({ contract: { deliverable: 'answer' } }), 'answer')
      assert.equal(egressScopeOf({ contract: { deliverable: 'verification' } }), 'verification')
      assert.equal(egressScopeOf({ contract: { deliverable: 'change' } }), 'change', '改代码 / 自测也拦（b2 ep-1023-9f0fd7 在 pre 传了 10 次头像）')
      assert.equal(egressScopeOf({}), 'change')
    }],
    ['一次请求放不放', () => eachCase([
      { name: '第三方（b2 原样）', policy: answer, url: 'https://accounts.google.com/gsi/client', ok: false, re: /accounts\.google\.com 不在范围/ },
      { name: '上游 hichat', policy: verification, url: 'https://pre-hailiao.hai-liao-pre.com/api', ok: false },
      { name: 'www 站的同主域子站', policy: answer, url: 'https://cmsadmin.falive.com/x', ok: true },
      { name: '同在 fdsser.com 下、没配进 envSites 的站', policy: verification, url: 'http://falivego.fdsser.com/api/auth/avatar/upload', ok: false, re: /falivego\.fdsser\.com 不在范围/ },
      { name: '配置站点的子域', policy: answer, url: 'https://api.falivepre.fdsser.com/x', ok: true },
      { name: '不带协议', policy: answer, url: 'falivepre.fdsser.com/api/a', ok: true },
      { name: '后缀相同不算同主域', policy: answer, url: 'https://evilfalive.com/', ok: false },
      { name: '本机任意方法', policy: answer, url: 'http://127.0.0.1:3017/api', method: 'POST', ok: true },
      { name: '代答不发登录 POST', policy: answer, url: 'https://falivepre.fdsser.com/api/user/NewMailLogin', method: 'POST', ok: false, re: /代答只许 GET/ },
      { name: '实测可发登录 POST', policy: verification, url: 'https://falivepre.fdsser.com/api/user/NewMailLogin', method: 'POST', ok: true },
      { name: '实测不发注册', policy: verification, url: 'https://falivepre.fdsser.com/api/user/NewRegisteredByMail', method: 'POST', ok: false, re: /注册/ },
      { name: '实测不发路径含 login 的验证码', policy: verification, url: 'https://www.falive.com/login/sendVerificationCode', method: 'POST', ok: false },
      { name: '实测不发 PUT', policy: verification, url: 'https://www.falive.com/api/login', method: 'PUT', ok: false, re: /这一步要写数据/ },
      { name: '改代码自测可读环境外（npm 源）', policy: change, url: 'https://registry.npmjs.org/react', ok: true },
      { name: '改代码自测不往环境外写', policy: change, url: 'https://api.example.com/x', method: 'POST', ok: false, re: /环境外的 api\.example\.com 写数据/ },
      { name: '改代码自测不发帖（ep-1020）', policy: change, url: 'https://falivepre.fdsser.com/bbsv2/thread/create', method: 'POST', bodies: ['{"title":"t"}'], ok: false, re: /这一步要写数据/ },
      { name: '改代码自测不传头像（ep-1023）', policy: change, url: 'https://falivepre.fdsser.com/go-api/api/auth/avatar/upload', method: 'POST', bodies: undefined, ok: false, re: /这一步要写数据.*请对接人手动做/ },
      { name: '发登录码：php type 3', policy: verification, url: 'https://falivepre.fdsser.com/api/user/sendVerificationCode', method: 'POST', bodies: ['type=3&mail=x'], ok: true },
      { name: '发登录码：portal scene=login（JSON）', policy: change, url: 'https://falivepre.fdsser.com/go-api/api/auth/verification/email/send', method: 'POST', bodies: ['{"email":"a@b.c","scene":"login"}'], ok: true },
      { name: '发注册码', policy: verification, url: 'https://falivepre.fdsser.com/api/user/sendVerificationCode', method: 'POST', bodies: ['{"type":"1"}'], ok: false, re: /用途是 1，不是登录.*发注册码也算注册/ },
      { name: '没配登录 type 的仓：type 3 认不出', policy: change, url: 'https://falivepre.fdsser.com/api/user/sendVerificationCode', method: 'POST', bodies: ['type=3'], ok: false },
      { name: '发码用途看不出（ep-1023 原样，没带 scene）', policy: change, url: 'https://falivepre.fdsser.com/go-api/api/auth/verification/email/send', method: 'POST', bodies: ['{"email":"a@b.c"}'], ok: false, re: /看不出.*scene=login/ },
      { name: '发码请求体读不到', policy: verification, url: 'https://www.falive.com/api/user/sendVerificationCode', method: 'POST', bodies: undefined, ok: false },
      { name: '用途写在 query', policy: verification, url: 'https://www.falive.com/api/user/sendVerificationCode?scene=login', method: 'POST', ok: true },
      { name: 'WebSocket 握手', policy: answer, url: 'wss://www.falive.com/hc-ws', ok: true },
      { name: '别的协议', policy: answer, url: 'ftp://www.falive.com/a', ok: false },
      { name: '本地文件', policy: answer, url: 'file:///tmp/a.html', ok: true },
      { name: 'URL 通配', policy: answer, url: 'https://{accounts.google,www.falive}.com/', ok: false },
    ], ({ policy, url, method, bodies = [], ok, re }) => {
      const check = checkEgressRequest(policy, { method, url, bodies })
      assert.equal(check.ok, ok, check.reason)
      if (re) assert.match(check.reason, re)
    })],
    ['curl 参数：方法 / 地址 / 绕开核对的选项', () => eachCase([
      { name: '选项在前', argv: ['-sS', '-m', '20', '-o', '/dev/null', '-w', '%{http_code}', 'https://www.falive.com/hc'], method: 'GET', urls: ['https://www.falive.com/hc'] },
      { name: '合写短选项带值', argv: ['-sXPOST', '-oout.html', 'https://a.falive.com/login'], method: 'POST', urls: ['https://a.falive.com/login'] },
      { name: '-d 是 POST', argv: ['-d', 'a=1', 'u.falive.com'], method: 'POST', urls: ['u.falive.com'] },
      { name: '-G -d 是 GET', argv: ['-G', '-d', 'a=1', 'u.falive.com'], method: 'GET' },
      { name: '-I 是 HEAD', argv: ['-sI', 'u'], method: 'HEAD' },
      { name: '-T 是 PUT', argv: ['-T', 'f', 'u'], method: 'PUT' },
      { name: '--json 是 POST、--url 取地址', argv: ['--json', '{}', '--url', 'https://x/y'], method: 'POST', urls: ['https://x/y'] },
      { name: '头和 cookie 的值不当地址', argv: ['-H', 'Upgrade: websocket', '-b', 'a=b', '-L', 'https://www.falive.com/'], method: 'GET', urls: ['https://www.falive.com/'] },
      { name: '请求体：-d / --json / -F 的值', argv: ['-d', 'type=3', '--json', '{"scene":"login"}', '-F', 'a=b', 'u'], method: 'POST', bodies: ['type=3', '{"scene":"login"}', 'a=b'] },
      { name: '请求体读不到：@文件 / -F file=@', argv: ['-d', '@body.json', 'u'], bodies: undefined },
      { name: '请求体读不到：-F file=@', argv: ['-F', 'file=@a.png', 'u'], bodies: undefined },
      { name: '--data-raw 的 @ 是字面量', argv: ['--data-raw', '@x', 'u'], bodies: ['@x'] },
      { name: '--get 长写法', argv: ['--get', '--data', 'a', 'u'], method: 'GET', urls: ['u'] },
      { name: '单个 - 不是选项、--url 缺值不算地址', argv: ['-', '--url'], urls: ['-'] },
      { name: '代理 / 配置文件 / 分段 / 换路径', argv: ['-x', 'http://e:1', '-K', 'cfg', '--next', '--request-target', '/r', '--noproxy', '*', 'u'], banned: ['-x', '-K', '--next', '--request-target', '--noproxy'] },
    ], (row) => {
      const { argv, method, urls, banned = [] } = row
      const parsed = parseCurlArgs(argv)
      if ('bodies' in row) assert.deepEqual(parsed.bodies, row.bodies)
      if (method) assert.equal(parsed.method, method)
      if (urls) assert.deepEqual(parsed.urls, urls)
      assert.deepEqual(parsed.banned, banned)
    })],
    ['curl 整条判定', () => {
      assert.equal(checkCurlInvocation(answer, ['--version']).ok, true)
      assert.equal(checkCurlInvocation(answer, ['-sS', 'https://www.falive.com/', 'https://accounts.google.com/gsi/button']).ok, false, '多个地址有一个出范围就拦')
      assert.match(checkCurlInvocation(answer, ['-x', 'http://e:1', 'https://www.falive.com/']).reason, /-x 会绕开出网核对/)
      assert.equal(checkCurlInvocation(verification, ['-s', '-X', 'POST', '-d', 'a', 'https://falivepre.fdsser.com/api/user/NewMailLogin']).ok, true)
      assert.equal(checkCurlInvocation(verification, ['-s', '-d', 'type=3&mail=x', 'https://falivepre.fdsser.com/api/user/sendVerificationCode']).ok, true, '发登录码（ep-1014-d74f19 口径）')
      assert.equal(checkCurlInvocation(verification, ['-s', '-d', 'type=1&mail=x', 'https://falivepre.fdsser.com/api/user/sendVerificationCode']).ok, false, '发注册码')
    }],
    ['子进程环境：壳在 PATH 最前、预载追加在原 NODE_OPTIONS 后；页面工具起 dev 时整个摘掉', () => {
      const env = guardEnv(answer, { NODE_OPTIONS: '--import /sim/egress-hook.mjs', PATH: '/sim/egress:/usr/bin' })
      assert.equal(env.PATH, `${EGRESS_GUARD_BIN_DIR}:/sim/egress:/usr/bin`)
      assert.equal(env.NODE_OPTIONS, `--import /sim/egress-hook.mjs --import ${EGRESS_GUARD_PRELOAD}`)
      assert.deepEqual(JSON.parse(env[EGRESS_GUARD_ENV]), answer)
      const back = withoutEgressGuard(env)
      assert.deepEqual([back.PATH, back.NODE_OPTIONS, back[EGRESS_GUARD_ENV]], ['/sim/egress:/usr/bin', '--import /sim/egress-hook.mjs', undefined])
      assert.equal('NODE_OPTIONS' in withoutEgressGuard(guardEnv(answer)), false)
      assert.equal(egressGuardEnv({ policy: null, env: { A: '1' } }).A, '1')
    }],
    ['claude 命令行：开核对才摘 WebFetch / WebSearch、拦绝对路径 curl', () => {
      const disallowed = (cmd) => cmd.args.slice(cmd.args.indexOf('--disallowedTools') + 1, cmd.args.indexOf('--output-format'))
      const base = { executor: 'claude', promptText: 'p', cwd: '/tmp', resultPath: '/tmp/r.json', readOnly: true }
      const on = disallowed(buildAiExecutorCommand({ ...base, egressGuard: true }))
      for (const rule of EGRESS_DENY_RULES) assert.ok(on.includes(rule), rule)
      assert.ok(EGRESS_DENY_RULES.includes('Bash(*/curl *)') && EGRESS_DENY_RULES.includes('WebFetch'))
      assert.equal(disallowed(buildAiExecutorCommand(base)).includes('WebFetch'), false)
      const allowed = (cmd) => cmd.args[cmd.args.indexOf('--allowedTools') + 1]
      assert.match(allowed(buildAiExecutorCommand({ ...base, egressGuard: true })), /,Bash\(curl:\*\)$/, '核对开着：只读白名单放 curl（走壳）')
      assert.doesNotMatch(allowed(buildAiExecutorCommand(base)), /curl/)
    }],
    ['execAiExecutor：代答 / 实测把环境交给子进程，其它任务不动环境', async () => {
      const calls = []
      const spawnImpl = (cmd, args, options) => {
        calls.push({ args, options })
        const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: () => {}, pid: 4242 })
        const resultPath = args.join(' ').match(/(\/\S+result\.json)/)?.[1]
        setImmediate(() => {
          if (resultPath) writeFileSync(resultPath, JSON.stringify({ status: 'done', summary: 's', checks: [], changedFiles: [], warnings: [] }))
          child.stdout.end()
          child.stderr.end()
          setImmediate(() => child.emit('exit', 0))
        })
        return child
      }
      await execAiExecutor({ executor: 'claude', promptText: 'p', cwd: tmpdir(), readOnly: true, localConfig: { envSites }, egressScope: 'answer', spawnImpl })
      await execAiExecutor({ executor: 'claude', promptText: 'p', cwd: tmpdir(), readOnly: true, localConfig: { envSites }, spawnImpl })
      assert.deepEqual(JSON.parse(calls[0].options.env[EGRESS_GUARD_ENV]), answer)
      assert.ok(calls[0].options.env.PATH.startsWith(`${EGRESS_GUARD_BIN_DIR}:`))
      assert.ok(calls[0].args.includes('WebFetch'))
      assert.equal(calls[1].options.env, undefined)
    }],
    ['curl 壳：范围外不起真 curl；范围内带 -q --proxy 交给 PATH 后面的真 curl；没开核对原样透传', () => {
      const fakeDir = mkdtempSync(join(tmpdir(), 'lark-egress-fake-'))
      const log = join(fakeDir, 'args.log')
      writeFileSync(join(fakeDir, 'curl'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${log}\n`)
      chmodSync(join(fakeDir, 'curl'), 0o755)
      const env = { ...guardEnv(answer), PATH: `${EGRESS_GUARD_BIN_DIR}:${fakeDir}:${process.env.PATH}` }
      const blocked = spawnSync('curl', ['-sS', 'https://accounts.google.com/gsi/client'], { env, encoding: 'utf8' })
      assert.equal(blocked.status, 2)
      assert.match(blocked.stderr, /\[lark-egress\] 已拦截 curl：代答只许打配置的环境/)
      const allowed = spawnSync('curl', ['-sS', 'https://www.falive.com/hc'], { env, encoding: 'utf8' })
      assert.equal(allowed.status, 0, allowed.stderr)
      const plain = spawnSync(join(EGRESS_GUARD_BIN_DIR, 'curl'), ['-s', 'https://accounts.google.com/'], { env: { PATH: `${fakeDir}:${process.env.PATH}` }, encoding: 'utf8' })
      assert.equal(plain.status, 0)
      const lines = readFileSync(log, 'utf8').trim().split('\n')
      assert.match(lines[0], /^-q --proxy http:\/\/127\.0\.0\.1:\d+ -sS https:\/\/www\.falive\.com\/hc$/)
      assert.equal(lines[1], '-s https://accounts.google.com/')
      assert.equal(lines.length, 2, '范围外那次没起真 curl')
      const wget = spawnSync(join(EGRESS_GUARD_BIN_DIR, 'wget'), ['https://www.falive.com/'], { env, encoding: 'utf8' })
      assert.equal(wget.status, 2)
    }],
    ['真 curl 经壳 -L 跳出范围 / node fetch 跟跳转 / https.get 第三方：建连处拦，不出本机', () => withRedirectServer(async (url) => {
      const env = guardEnv(verification)
      const curl = await runAsync(join(EGRESS_GUARD_BIN_DIR, 'curl'), ['-sSL', '-m', '5', '-o', '/dev/null', url], env)
      assert.notEqual(curl.status, 0)
      assert.match(curl.out, /已拦截 连接 accounts\.google\.com/)
      const node = await runAsync(process.execPath, ['-e', `Promise.all([fetch(${JSON.stringify(url)}).then(() => 'ok', (e) => e.cause?.code), new Promise((r) => require('https').get('https://accounts.google.com/x', () => r('ok')).on('error', (e) => r(e.code)))]).then((v) => console.log(v.join(',')))`], env)
      assert.match(node.out, /ELARKEGRESS,ELARKEGRESS/)
      const register = await runAsync(process.execPath, ['-e', "fetch('https://falivepre.fdsser.com/api/user/NewRegisteredByMail', { method: 'POST' }).catch((e) => console.log(e.cause?.code))"], env)
      assert.match(register.out, /注册一律不做[\s\S]*ELARKEGRESS/)
    })],
    ['https.request 发码：请求体先攒着，登录码才写出去，注册码在写出前拦', async () => {
      const got = []
      const server = createServer((req, res) => { let body = ''; req.on('data', (d) => { body += d }); req.on('end', () => { got.push(body); res.end('ok') }) })
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      try {
        // 主机在范围里（egress.test 的子域），用 lookup 指到本机服务：不出本机也走到核对逻辑
        const policy = { scope: 'verification', domains: ['egress.test'], loginCodeTypes: ['3'] }
        const port = server.address().port
        const script = `const http = require('http'); const send = (body) => new Promise((r) => { const req = http.request({ host: 'api.egress.test', port: ${port}, path: '/api/user/sendVerificationCode', method: 'POST', lookup: (h, o, cb) => o && o.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4) }, (res) => { res.resume(); res.on('end', () => r('sent')) }); req.on('error', (e) => r(e.code)); req.write(body); req.end() }); send('type=3').then((a) => send('type=1').then((b) => console.log(a + ',' + b)))`
        const out = await runAsync(process.execPath, ['-e', script], egressGuardEnv({ policy, env: { PATH: process.env.PATH }, binDir: EGRESS_GUARD_BIN_DIR, preloadPath: EGRESS_GUARD_PRELOAD }))
        assert.match(out.out, /sent,ELARKEGRESS/)
        assert.deepEqual(got, ['type=3'], '注册码那次一个字节都没发到服务端')
      } finally {
        server.close()
      }
    }],
    ['回放审计同口径：发码看 purpose，登录码放、注册码 / 用途不明违规；壳只记用途值', () => {
      const line = (path, purpose) => classifyLine({ via: 'curl', method: 'POST', host: 'falivepre.fdsser.com', path, ...(purpose != null ? { purpose } : {}) })
      assert.equal(line('/api/user/sendVerificationCode', '3').kind, 'allowed')
      assert.equal(line('/go-api/api/auth/verification/email/send', 'login').kind, 'allowed')
      assert.match(line('/api/user/sendVerificationCode', '1').reason, /用途 1 不是登录/)
      assert.match(line('/go-api/api/auth/verification/email/send').reason, /用途不明/)
      assert.match(line('/api/user/NewRegisteredByMail', '3').reason, /注册/)
      assert.equal(line('/api/user/NewMailLogin').kind, 'allowed')
      assert.equal(line('/go-api/api/auth/avatar/upload').kind, 'violation')
      // 回放硬拦（latest 的 blockedWrite）同口径：登录码放，注册 / 注册码 / 用途不明 / 上传拦
      assert.equal(blockedWrite({ method: 'POST', url: 'https://falivepre.fdsser.com/api/user/sendVerificationCode', purpose: '3' }), null)
      assert.match(blockedWrite({ method: 'POST', url: 'https://falivepre.fdsser.com/api/user/sendVerificationCode', purpose: '1' }), /发码用途 1/)
      assert.match(blockedWrite({ method: 'POST', url: 'https://falivepre.fdsser.com/go-api/api/auth/verification/email/send' }), /用途不明/)
      assert.match(blockedWrite({ method: 'POST', url: 'https://falivepre.fdsser.com/api/user/NewRegisteredByMail' }), /注册/)
      assert.equal(blockedWrite({ method: 'POST', url: 'https://falivepre.fdsser.com/api/user/NewMailLogin' }), null)
      const dir = mkdtempSync(join(tmpdir(), 'lark-egress-sim-'))
      noteEgress({ via: 'curl', method: 'POST', url: 'https://falivepre.fdsser.com/api/user/sendVerificationCode', purpose: '3', dir })
      noteEgress({ via: 'curl', method: 'GET', url: 'https://falivepre.fdsser.com/', dir })
      const [a, b] = readFileSync(join(dir, 'egress.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      assert.equal(a.purpose, '3')
      assert.equal('purpose' in b, false)
    }],
    ['登录工具（b3 ep-1024-9ebe13）：代答里只有 env-login 进程许发登录 POST；注册 / 发码 / 其它写照拦', () => {
      const tool = { ...answer, loginTool: true }
      assert.deepEqual(checkEgressRequest(tool, { method: 'POST', url: 'https://falivepre.fdsser.com/api/user/NewMailLogin' }), { ok: true })
      assert.match(checkEgressRequest(answer, { method: 'POST', url: 'https://falivepre.fdsser.com/api/user/NewMailLogin' }).reason, /代答只许 GET[\s\S]*env-login/)
      assert.match(checkEgressRequest(tool, { method: 'POST', url: 'https://falivepre.fdsser.com/api/user/NewRegisteredByMail' }).reason, /注册一律不做/)
      assert.match(checkEgressRequest(tool, { method: 'POST', url: 'https://falivepre.fdsser.com/api/user/sendVerificationCode', bodies: ['type=3'] }).reason, /发验证码的用途是 3/, '代答没配登录码 type，工具也只做密码登录')
      assert.equal(checkEgressRequest(tool, { method: 'POST', url: 'https://falivepre.fdsser.com/api/Square/addPost' }).ok, false)
      assert.equal(checkEgressRequest(tool, { method: 'POST', url: 'https://accounts.google.com/login' }).ok, false)
    }],
    ['造测试数据：原话明确要造 + 配置 testData.envs 才放开那个环境的创建 POST；删改 / 别的环境 / 代答 / 登录工具里照拦', async () => {
      const sites = { pre: 'https://falivepre.fdsser.com', online: 'https://www.falive.com' }
      const config = { envSites: sites, testData: { envs: ['pre', 'online', 'uat'] }, testAccounts: { pre: { mail: 'a' } } }
      const verify = { contract: { deliverable: 'verification', testData: true } }
      assert.deepEqual(egressTestDataEnvsOf(verify, config), ['pre'], '没配站点 / 测试号的环境不放')
      assert.deepEqual(egressTestDataEnvsOf({ contract: { deliverable: 'verification' } }, config), [])
      assert.deepEqual(egressTestDataEnvsOf({ contract: { deliverable: 'answer', testData: true } }, config), [])
      assert.deepEqual(egressTestDataEnvsOf(verify, { ...config, testData: { envs: ['pre'], account: 'qa' } }), [], 'account 指的测试号没配')
      assert.deepEqual(egressTestDataEnvsOf(verify, { envSites: sites }), [])
      const policy = egressPolicyFor({ scope: 'verification', envSites: sites, testDataEnvs: ['pre'] })
      assert.deepEqual(policy.testDataDomains, ['falivepre.fdsser.com'])
      assert.equal('testDataDomains' in egressPolicyFor({ scope: 'answer', envSites: sites, testDataEnvs: ['pre'] }), false)
      assert.equal('testDataDomains' in verification, false)
      const at = (method, path, p = policy) => checkEgressRequest(p, { method, url: `https://falivepre.fdsser.com${path}` })
      for (const path of ['/api/Square/addPost', '/bbsv2/tool/upload', '/api/comment/add']) assert.deepEqual(at('POST', path), { ok: true }, path)
      for (const path of ['/api/Square/delPost', '/api/user/updateInfo', '/api/live/sendGift', '/api/order/create', '/api/user/setNickname']) assert.match(at('POST', path).reason, /只放开用测试号建测试内容/, path)
      assert.match(at('POST', '/api/user/NewRegisteredByMail').reason, /注册一律不做/)
      assert.equal(at('PUT', '/api/Square/post').ok, false)
      assert.equal(at('POST', '/api/Square/addPost', verification).ok, false, '没放开的单照旧拦')
      assert.equal(at('POST', '/api/Square/addPost', { ...policy, loginTool: true }).ok, false, '登录工具只登录')
      assert.match(checkEgressRequest(policy, { method: 'POST', url: 'https://www.falive.com/api/Square/addPost' }).reason, /建测试数据只放开 falivepre\.fdsser\.com/)
      assert.equal(createBlockedPath('/api/model/addPost'), null, '按词切，model 不算 del')
      await eachCase([
        ['创建最新的帖子 进行测试', true], ['写脚本在 pre 造帖', true], ['在 pre 造几条测试帖', true], ['发几条新帖测一下', true], ['帮我造一些测试数据', true],
        ['能不能创建帖子', false], ['测试 帖子多语言翻译 以及 AI识图 功能 ！', false], ['测试的tid 发出来', false], ['创建帖子失败了，测试下', false], ['新建帖子页面样式不对', false], ['造帖失败', false],
      ], ([text, want]) => assert.equal(requestsTestData(text), want, text))
      const contract = (deliverable, text) => deriveContract({ text: `@Aven.Bot ${text}`, intake: { classification: { decision: 'question', deliverable } } })
      assert.equal(contract('verification', '创建最新的帖子 进行测试').testData, true)
      assert.equal(contract('answer', '创建最新的帖子 进行测试').testData, false, '代答只读')
      assert.equal(contract('verification', 'Bug-4942 再复测下').testData, false)
      // 回放：线上会放行的创建照样拦，但说清楚是回放拦的；别的写照旧
      const guard = { [EGRESS_GUARD_ENV]: JSON.stringify(policy) }
      assert.equal(simBlockNote({ method: 'POST', url: 'https://falivepre.fdsser.com/api/Square/addPost', env: guard }), TESTDATA_BLOCK_NOTE)
      assert.match(TESTDATA_BLOCK_NOTE, /^回放：真实写入已拦截（线上会用测试号执行）/)
      assert.equal(simBlockNote({ method: 'POST', url: 'https://falivepre.fdsser.com/api/Square/delPost', env: guard }), BLOCK_NOTE)
      assert.equal(simBlockNote({ method: 'POST', url: 'https://falivepre.fdsser.com/api/Square/addPost', env: {} }), BLOCK_NOTE)
      assert.ok(blockedWrite({ method: 'POST', url: 'https://falivepre.fdsser.com/api/Square/addPost' }), '回放硬拦不变')
    }],
    ['回放里放开的造数据：线上核对放行 → 回放预载拦下回「回放：真实写入已拦截」、记 blocked（止损守卫不误停）；没放开的写线上核对先拦、回放不记', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'lark-egress-simtd-'))
      const policy = egressPolicyFor({ scope: 'verification', envSites: { pre: 'https://falivepre.fdsser.com' }, testDataEnvs: ['pre'] })
      const env = { PATH: process.env.PATH, SIM_DIR: dir, NODE_OPTIONS: `--import ${join(import.meta.dirname, '..', 'scripts', 'sim', 'egress-hook.mjs')} --import ${EGRESS_GUARD_PRELOAD}`, [EGRESS_GUARD_ENV]: JSON.stringify(policy) }
      const script = "const post = (p) => fetch('https://falivepre.fdsser.com' + p, { method: 'POST', body: 'a=1' }).then((r) => r.json()).then((j) => j.sim_blocked + ' ' + j.msg, (e) => e.cause?.code); Promise.all([post('/api/Square/addPost'), post('/api/Square/delPost')]).then((v) => console.log(v.join('|')))"
      const out = await runAsync(process.execPath, ['-e', script], env)
      const [created, deleted] = out.out.trim().split('\n').pop().split('|')
      assert.ok(created.startsWith(`testdata ${TESTDATA_BLOCK_NOTE}`), created)
      assert.equal(deleted, 'ELARKEGRESS')
      const lines = readFileSync(join(dir, 'egress.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      assert.deepEqual(lines.map((l) => [l.method, l.path, l.extra]), [['POST', '/api/Square/addPost', 'blocked']])
    }],
    ['测试号配置与登录请求口径（纯函数）', () => {
      const ok = { envSites: { pre: 'https://pre.x/' }, testAccounts: { pre: { mail: 'qa@x', loginModule: '/m.mjs' } }, testData: { envs: ['pre'] } }
      assert.deepEqual(validateTestAccess(ok), [])
      assert.deepEqual(validateTestAccess({}), [])
      const errors = validateTestAccess({ envSites: {}, testAccounts: { pre: { request: { path: '/l' } }, uat: 'x' }, testData: { envs: ['pre'] } }).join('\n')
      for (const re of [/testAccounts\.pre\.mail 必填/, /passwordFile 或 passwordEnv/, /testAccounts\.uat 必须是对象/, /testData\.envs 的 pre 不在 envSites/]) assert.match(errors, re)
      assert.match(validateTestAccess({ testAccounts: { pre: { mail: 'a' } } })[0], /loginModule.*或 request/)
      assert.match(validateTestAccess({ testData: { envs: 'pre' } })[0], /testData 必须是对象/)
      assert.deepEqual(validateTestAccess({ envSites: { pre: 'x' }, testData: { envs: ['pre'] } }), ['testData 要用的测试号 testAccounts.pre 没配'])
      assert.deepEqual(validateTestAccess({ envSites: { pre: 'x' }, testData: { envs: ['pre'], account: 'qa' } }), ['testData 要用的测试号 testAccounts.qa 没配'])
      assert.deepEqual(resolveTestAccount(ok, 'pre'), { env: 'pre', base: 'https://pre.x', account: ok.testAccounts.pre })
      assert.equal(resolveTestAccount({ ...ok, testAccounts: { pre: { ...ok.testAccounts.pre, apiBase: 'https://api.pre.x' } } }, 'pre').base, 'https://api.pre.x')
      assert.match(resolveTestAccount(ok, 'online').error, /online 没有配测试号[\s\S]*已配：pre[\s\S]*不注册新号/)
      assert.match(resolveTestAccount(ok, null).error, /--env <pre>/)
      assert.match(resolveTestAccount({ testAccounts: { pre: { mail: 'a' } } }, 'pre').error, /没有站点地址/)
      assert.equal(readTestPassword({ passwordEnv: 'P', passwordFile: '/f' }, { env: { P: 'from-env' }, readFile: () => 'from-file' }), 'from-env')
      assert.equal(readTestPassword({ passwordEnv: 'P', passwordFile: '/f' }, { env: {}, readFile: () => 'from-file\nrest' }), 'from-file')
      assert.equal(readTestPassword({}, { env: {} }), null)
      assert.equal(readTestPassword({ passwordFile: '/f' }, { env: {} }), null, '没注入读文件就不读')
      const form = buildLoginRequest({ base: 'https://pre.x', request: { path: 'login', form: true, body: { u: '{mail}', p: '{password}', k: 1 } }, mail: 'm', password: 'p' })
      assert.deepEqual(form, { url: 'https://pre.x/login', method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'u=m&p=p&k=1' })
      assert.equal(buildLoginRequest({ base: 'b', request: { path: '/l' }, mail: 'm', password: 'p' }).body, '{"mail":"m","password":"p"}')
      assert.deepEqual(buildLoginRequest({ base: 'b', request: { path: '/l', headers: { 'x-a': '1' } }, mail: 'm', password: 'p' }).headers, { 'content-type': 'application/json', 'x-a': '1' })
      assert.equal(maskToken('abcdefghijkl'), 'abcd…kl（12 位）')
      assert.equal(maskToken('abcdefgh'), '****')
      assert.equal(maskToken('abcdefghi'), 'abcd…hi（9 位）')
      assert.equal(redactSecrets('pw=hunter2 tok=abcd1234 k=abcd x=abc', ['hunter2', 'abcd1234', 'abcd', 'abc', null]), 'pw=**** tok=**** k=**** x=abc')
      const saved = { env: 'pre', mail: 'm', token: 't', at: new Date(1_000_000).toISOString() }
      assert.equal(freshLogin(saved, { env: 'pre', mail: 'm', now: 1_000_000 + 60_000 }), saved)
      assert.equal(freshLogin(saved, { env: 'pre', mail: 'm', now: 1_000_000 + 20 * 60_000 }), null)
      assert.equal(freshLogin(saved, { env: 'uat', mail: 'm', now: 1_000_000 }), null)
    }],
    ['env-login 真跑：代答出网核对下登上、token 存 0600 文件只打码打印、密码不出现；会话自己写的脚本发同样的登录照拦；注册路径工具也拦', async () => {
      const bodies = []
      const server = createServer((req, res) => { let body = ''; req.on('data', (d) => { body += d }); req.on('end', () => { bodies.push(`${req.url} ${body}`); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ code: 0, data: { token: 'tok-0123456789abcdef', uid: 508 } })) }) })
      await new Promise((resolve) => server.listen(0, '::', resolve))
      try {
        // ::ffff:127.0.0.1 不算「本机」（本机不限，测不到方法核对），当成配置的环境主机
        const base = `http://[::ffff:127.0.0.1]:${server.address().port}`
        const runtime = mkdtempSync(join(tmpdir(), 'lark-env-login-'))
        const writeConfig = (path) => writeFileSync(join(runtime, 'lark-bot.local.json'), JSON.stringify({ envSites: { pre: base }, testAccounts: { pre: { mail: 'qa@x.test', passwordEnv: 'T_PWD', request: { path, body: { mail: '{mail}', password: '{password}' }, uidPath: 'data.uid' } } } }))
        writeConfig('/api/user/NewMailLogin')
        const policy = { scope: 'answer', domains: ['::ffff:7f00:1'], loginCodeTypes: [] }
        const env = { ...egressGuardEnv({ policy, env: { PATH: process.env.PATH }, binDir: EGRESS_GUARD_BIN_DIR, preloadPath: EGRESS_GUARD_PRELOAD }), LARK_RUNTIME_DIR: runtime, T_PWD: 'pw-secret-42' }
        const first = await runAsync(process.execPath, [ENV_LOGIN_TOOL, '--env', 'pre'], env)
        assert.equal(first.status, 0, first.out)
        assert.match(first.out, /已登录 pre 测试号 qa@x\.test（uid 508）：token tok-…ef（20 位）/)
        assert.doesNotMatch(first.out, /pw-secret-42|tok-0123456789abcdef/)
        const state = join(runtime, 'lark-env-login', 'pre.json')
        assert.equal(statSync(state).mode & 0o777, 0o600)
        assert.equal(JSON.parse(readFileSync(state, 'utf8')).token, 'tok-0123456789abcdef')
        const token = await runAsync(process.execPath, [ENV_LOGIN_TOOL, '--env', 'pre', '--token'], env)
        assert.equal(token.out, 'tok-0123456789abcdef\n')
        assert.equal(bodies.length, 1, '20 分钟内复用，不重登')
        assert.equal(bodies[0], '/api/user/NewMailLogin {"mail":"qa@x.test","password":"pw-secret-42"}')
        const script = await runAsync(process.execPath, ['-e', `fetch(${JSON.stringify(`${base}/api/user/NewMailLogin`)}, { method: 'POST', body: '{}' }).catch((e) => console.log(e.cause?.code))`], env)
        assert.match(script.out, /代答只许 GET[\s\S]*ELARKEGRESS/)
        writeConfig('/api/user/NewRegisteredByMail')
        const register = await runAsync(process.execPath, [ENV_LOGIN_TOOL, '--env', 'pre', '--fresh'], env)
        assert.equal(register.status, 1)
        assert.match(register.out, /注册一律不做/)
        assert.equal(bodies.length, 1, '注册请求一个字节都没发出去')
        const missing = await runAsync(process.execPath, [ENV_LOGIN_TOOL, '--env', 'online'], env)
        assert.match(missing.out, /online 没有配测试号/)
      } finally {
        server.close()
      }
    }],
  ]))
})
