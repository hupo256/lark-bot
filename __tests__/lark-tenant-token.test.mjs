import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import {
  MINT_FAIL_BACKOFF_MS,
  SETTINGS_RECHECK_MS,
  TENANT_TOKEN_HOSTS,
  TENANT_TOKEN_PATH,
  TENANT_TOKEN_REFRESH_AHEAD_MS,
  createTenantTokenProvider,
  getTenantToken,
  invalidateTenantToken,
  isTokenFresh,
  isTokenInvalidResult,
  mintTenantToken,
  readAppSecretFile,
  readTokenCache,
  resolveTenantTokenSettings,
  tenantTokenEnv,
  withTokenLock,
  writeTokenCache,
} from '../lib/lark-tenant-token.mjs'
import { runSteps } from './support/steps.mjs'

// 应用令牌跨进程缓存（aven 11-03「第一次撞 429 限流，给个好的解决方案」）：一条 runSteps 合并多段，钉配置解析 / 铸令牌 /
// 新鲜判定边界 / 缓存文件与作废 / 令牌无效码 / 目录锁 / 取令牌主流程与退避 / 提供者 / runLarkCli 注入接线。

const SETTINGS = { appId: 'cli_app', appSecret: 'sec', host: 'https://open.example.test' }
const okFetch = (token = 't-new', expire = 7200) => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return { ok: true, status: 200, json: async () => ({ code: 0, msg: 'ok', tenant_access_token: token, expire }) }
  }
  return { fetchImpl, calls }
}
const silentLog = () => {
  const lines = []
  return { lines, log: (line) => lines.push(line), error: (line) => lines.push(line) }
}
const noFile = () => ''
const bad = (status, body) => async () => ({ ok: status < 400, status, json: async () => body })

// 假 lark-cli：把身份与两个环境变量回显出来；FAIL_ONCE_FILE 没建且令牌是 t-old 时先回一次 99991663。
const FAKE_CLI = `#!/bin/sh
if [ -n "$FAIL_ONCE_FILE" ] && [ ! -f "$FAIL_ONCE_FILE" ] && [ "$LARKSUITE_CLI_TENANT_ACCESS_TOKEN" = "t-old" ]; then
  touch "$FAIL_ONCE_FILE"
  printf '{"ok":false,"error":{"code":99991663}}'
  exit 0
fi
printf '{"ok":true,"as":"%s","app":"%s","token":"%s"}' "$2" "$LARKSUITE_CLI_APP_ID" "$LARKSUITE_CLI_TENANT_ACCESS_TOKEN"
`
// 假二进制放在整组测试共用的目录里：larkCliBin 在 lark-cli.mjs 首次 import 时就定了，不能跟着每段的 dir 走。
const cliDir = mkdtempSync(join(tmpdir(), 'lark-tat-cli-'))
const bin = join(cliDir, 'fake-lark-cli')
const loadRunLarkCli = async () => {
  writeFileSync(bin, FAKE_CLI)
  chmodSync(bin, 0o755)
  process.env.LARK_CLI_BIN = bin
  return (await import('../lib/lark-cli.mjs')).runLarkCli
}
const providerOf = (tokens) => {
  const invalidated = []
  let index = 0
  return {
    invalidated,
    acquire: async () => {
      const token = tokens[index]
      index += 1
      return token ? { appId: 'cli_app', token, env: tenantTokenEnv({ appId: 'cli_app', token }) } : null
    },
    invalidate: (token) => invalidated.push(token),
  }
}
const parse = (result) => JSON.parse(result.stdout)

describe('应用令牌跨进程缓存（lib/lark-tenant-token）', () => {
  after(() => rmSync(cliDir, { recursive: true, force: true }))
  let dir
  it('配置解析 / 铸令牌 / 新鲜边界 / 缓存文件 / 无效码 / 目录锁 / 取令牌与退避 / 提供者 / runLarkCli 注入', () => runSteps([
    ['resolveTenantTokenSettings：缺 secret 或 app_id → null', () => {
      assert.equal(resolveTenantTokenSettings({ readSecret: noFile, env: {}, localConfig: { botAppId: 'cli_x' } }), null)
      assert.equal(resolveTenantTokenSettings({ readSecret: noFile, env: { LARK_APP_SECRET: 's' }, localConfig: {} }), null)
      assert.equal(resolveTenantTokenSettings({ readSecret: noFile, env: { LARK_APP_SECRET: '  ' }, localConfig: { botAppId: 'cli_x' } }), null)
      assert.equal(resolveTenantTokenSettings({ readSecret: noFile, env: { LARK_APP_SECRET: 's' }, localConfig: null }), null)
    }],
    ['resolveTenantTokenSettings：app_id env 优先其次 botAppId；host 按 brand，env 可覆盖并去尾斜杠', () => {
      assert.deepEqual(resolveTenantTokenSettings({ readSecret: noFile, env: { LARK_APP_SECRET: 's' }, localConfig: { botAppId: 'cli_local' } }), { appId: 'cli_local', appSecret: 's', host: TENANT_TOKEN_HOSTS.lark })
      assert.equal(resolveTenantTokenSettings({ readSecret: noFile, env: { LARK_APP_SECRET: 's', LARK_APP_ID: 'cli_env' }, localConfig: { botAppId: 'cli_local' } }).appId, 'cli_env')
      assert.equal(resolveTenantTokenSettings({ readSecret: noFile, env: { LARK_APP_SECRET: 's', LARK_APP_ID: 'a', LARK_BRAND: 'feishu' }, localConfig: {} }).host, TENANT_TOKEN_HOSTS.feishu)
      assert.equal(resolveTenantTokenSettings({ readSecret: noFile, env: { LARK_APP_SECRET: 's', LARK_APP_ID: 'a', LARK_BRAND: 'nope' }, localConfig: {} }).host, TENANT_TOKEN_HOSTS.lark)
      assert.equal(resolveTenantTokenSettings({ readSecret: noFile, env: { LARK_APP_SECRET: 's', LARK_APP_ID: 'a', LARK_OPEN_API_HOST: 'https://h.test/' }, localConfig: {} }).host, 'https://h.test')
    }],
    ['secret 文件：去首尾空白；不存在 / 空 → 空串；env 没有时取文件，env 有时 env 优先', () => {
      const path = join(dir, 'lark-app-secret')
      assert.equal(readAppSecretFile(path), '')
      writeFileSync(path, '  sec-file\n')
      assert.equal(readAppSecretFile(path), 'sec-file')
      writeFileSync(path, '\n')
      assert.equal(readAppSecretFile(path), '')
      assert.deepEqual(resolveTenantTokenSettings({ env: {}, localConfig: { botAppId: 'cli_x' }, readSecret: () => 'sec-file' }), { appId: 'cli_x', appSecret: 'sec-file', host: TENANT_TOKEN_HOSTS.lark })
      assert.equal(resolveTenantTokenSettings({ env: { LARK_APP_SECRET: 'sec-env' }, localConfig: { botAppId: 'cli_x' }, readSecret: () => 'sec-file' }).appSecret, 'sec-env')
    }],
    ['mintTenantToken：POST 正确的 URL / 请求体，expire 换算成 expiresAt', async () => {
      const { fetchImpl, calls } = okFetch('t-1', 3600)
      const entry = await mintTenantToken({ ...SETTINGS, fetchImpl, now: () => 1_000_000 })
      assert.deepEqual(entry, { appId: 'cli_app', token: 't-1', mintedAt: 1_000_000, expiresAt: 1_000_000 + 3600 * 1000 })
      assert.equal(calls[0].url, `${SETTINGS.host}${TENANT_TOKEN_PATH}`)
      assert.equal(calls[0].init.method, 'POST')
      assert.deepEqual(JSON.parse(calls[0].init.body), { app_id: 'cli_app', app_secret: 'sec' })
      assert.match(calls[0].init.headers['content-type'], /application\/json/)
    }],
    ['mintTenantToken：expire 缺失 / 非法 → 按 7200 秒', async () => {
      assert.equal((await mintTenantToken({ ...SETTINGS, fetchImpl: okFetch('t', 'x').fetchImpl, now: () => 0 })).expiresAt, 7200 * 1000)
      assert.equal((await mintTenantToken({ ...SETTINGS, fetchImpl: okFetch('t', 0).fetchImpl, now: () => 0 })).expiresAt, 7200 * 1000)
    }],
    ['mintTenantToken：code 非 0 / HTTP 非 2xx / 没令牌 / 非 JSON 都抛错，错误里带 code 和 msg', async () => {
      await assert.rejects(mintTenantToken({ ...SETTINGS, fetchImpl: bad(200, { code: 10003, msg: 'invalid app_secret' }) }), /code=10003 invalid app_secret/)
      // code 非 0 但响应里带了令牌：照样不能用
      await assert.rejects(mintTenantToken({ ...SETTINGS, fetchImpl: bad(200, { code: 10003, msg: 'x', tenant_access_token: 't-bad' }) }), /code=10003/)
      await assert.rejects(mintTenantToken({ ...SETTINGS, fetchImpl: bad(429, { code: 0, tenant_access_token: 't' }) }), /HTTP 429/)
      await assert.rejects(mintTenantToken({ ...SETTINGS, fetchImpl: bad(200, { code: 0, tenant_access_token: '' }) }), /铸应用令牌失败/)
      await assert.rejects(mintTenantToken({ ...SETTINGS, fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json') } }) }), /code=\?/)
    }],
    ['isTokenFresh：恰好等于提前量不算新鲜，多 1 毫秒算；ahead 可注入', () => {
      const entry = { appId: 'cli_app', token: 't', expiresAt: 10_000_000 }
      assert.equal(isTokenFresh(entry, { appId: 'cli_app', now: 10_000_000 - TENANT_TOKEN_REFRESH_AHEAD_MS }), false)
      assert.equal(isTokenFresh(entry, { appId: 'cli_app', now: 10_000_000 - TENANT_TOKEN_REFRESH_AHEAD_MS - 1 }), true)
      assert.equal(isTokenFresh(entry, { appId: 'cli_app', now: 0, ahead: 0 }), true)
    }],
    ['isTokenFresh：app 不同 / 没令牌 / 到期非数 / 空条目都不新鲜', () => {
      const entry = { appId: 'cli_app', token: 't', expiresAt: 10_000_000 }
      assert.equal(isTokenFresh(entry, { appId: 'cli_other', now: 0 }), false)
      assert.equal(isTokenFresh({ ...entry, token: '' }, { appId: 'cli_app', now: 0 }), false)
      assert.equal(isTokenFresh({ ...entry, expiresAt: 'soon' }, { appId: 'cli_app', now: 0 }), false)
      assert.equal(isTokenFresh(null, { appId: 'cli_app', now: 0 }), false)
      assert.equal(isTokenFresh('t', { appId: 'cli_app', now: 0 }), false)
    }],
    ['缓存文件：写后能读回，权限 0600，没有残留临时文件', () => {
      const path = join(dir, 'sub', 'tat.json')
      writeTokenCache({ appId: 'a', token: 't', expiresAt: 1 }, path)
      assert.deepEqual(readTokenCache(path), { appId: 'a', token: 't', expiresAt: 1 })
      assert.equal(statSync(path).mode & 0o777, 0o600)
      assert.equal(existsSync(`${path}.${process.pid}.tmp`), false)
    }],
    ['缓存文件：不存在 / 非 JSON / 数组 → null', () => {
      const path = join(dir, 'tat.json')
      assert.equal(readTokenCache(path), null)
      writeFileSync(path, '{oops')
      assert.equal(readTokenCache(path), null)
      writeFileSync(path, '[1]')
      assert.equal(readTokenCache(path), null)
    }],
    ['invalidateTenantToken：只删缓存里还是同一枚令牌的文件', () => {
      const path = join(dir, 'tat.json')
      assert.equal(invalidateTenantToken({ token: 't', path }), false)
      writeTokenCache({ appId: 'a', token: 't-newer', expiresAt: 1 }, path)
      assert.equal(invalidateTenantToken({ token: 't-old', path }), false)
      assert.equal(existsSync(path), true)
      assert.equal(invalidateTenantToken({ token: 't-newer', path }), true)
      assert.equal(existsSync(path), false)
    }],
    ['isTokenInvalidResult：99991663 / 99991661（含字符串形态）→ true；别的码 / 非 JSON → false', () => {
      assert.equal(isTokenInvalidResult({ stdout: JSON.stringify({ ok: false, error: { code: 99991663 } }) }), true)
      assert.equal(isTokenInvalidResult({ stdout: JSON.stringify({ ok: false, error: { code: 99991661 } }) }), true)
      assert.equal(isTokenInvalidResult({ stdout: JSON.stringify({ ok: false, error: { code: '99991663' } }) }), true)
      assert.equal(isTokenInvalidResult({ stdout: JSON.stringify({ ok: false, error: { code: 99991672 } }) }), false)
      assert.equal(isTokenInvalidResult({ stdout: JSON.stringify({ ok: true, data: {} }) }), false)
      assert.equal(isTokenInvalidResult({ stdout: 'not json' }), false)
      assert.equal(isTokenInvalidResult(null), false)
      assert.deepEqual(tenantTokenEnv({ appId: 'a', token: 't' }), { LARKSUITE_CLI_APP_ID: 'a', LARKSUITE_CLI_TENANT_ACCESS_TOKEN: 't' })
    }],
    ['withTokenLock：没人持锁直接进，跑完锁释放；fn 抛错也释放', async () => {
      const path = join(dir, 'tat.json')
      const result = await withTokenLock(path, async () => {
        assert.equal(existsSync(`${path}.lock`), true)
        return 42
      })
      assert.equal(result, 42)
      assert.equal(existsSync(`${path}.lock`), false)
      await assert.rejects(withTokenLock(path, async () => { throw new Error('boom') }), /boom/)
      assert.equal(existsSync(`${path}.lock`), false)
    }],
    ['withTokenLock：别人持着新鲜的锁 → 等，锁没了再进（wait 可注入）', async () => {
      const path = join(dir, 'tat.json')
      mkdirSync(`${path}.lock`)
      let waits = 0
      const wait = async () => {
        waits += 1
        if (waits === 2) rmSync(`${path}.lock`, { recursive: true })
      }
      assert.equal(await withTokenLock(path, async () => 'in', { wait }), 'in')
      assert.equal(waits, 2)
    }],
    ['withTokenLock：锁目录超过 staleMs 没动静 → 当持锁方死了，清掉直接进', async () => {
      const path = join(dir, 'tat.json')
      mkdirSync(`${path}.lock`)
      const old = (Date.now() - 120_000) / 1000
      utimesSync(`${path}.lock`, old, old)
      let waits = 0
      assert.equal(await withTokenLock(path, async () => 'in', { wait: async () => { waits += 1 }, staleMs: 30_000 }), 'in')
      assert.equal(waits, 0)
      // 边界：恰好等于 staleMs 不算死锁，还得等
      const fixedNow = 1_800_000_000_000
      mkdirSync(`${path}.lock`)
      utimesSync(`${path}.lock`, (fixedNow - 30_000) / 1000, (fixedNow - 30_000) / 1000)
      let edgeWaits = 0
      const wait = async () => {
        edgeWaits += 1
        rmSync(`${path}.lock`, { recursive: true })
      }
      assert.equal(await withTokenLock(path, async () => 'in', { wait, now: () => fixedNow, staleMs: 30_000 }), 'in')
      assert.equal(edgeWaits, 1)
    }],
    ['withTokenLock：等满 attempts 还拿不到 → 抛错，不动别人的锁', async () => {
      const path = join(dir, 'tat.json')
      mkdirSync(`${path}.lock`)
      let waits = 0
      await assert.rejects(withTokenLock(path, async () => 'in', { wait: async () => { waits += 1 }, attempts: 3 }), /等应用令牌锁超时/)
      assert.equal(waits, 2) // 第 3 次抢不到就放弃，不再多等一轮
      assert.equal(existsSync(`${path}.lock`), true)
    }],
    ['getTenantToken：settings 为 null → null，不打接口', async () => {
      const { fetchImpl, calls } = okFetch()
      assert.equal(await getTenantToken({ settings: null, fetchImpl, cachePath: join(dir, 't.json') }), null)
      assert.equal(calls.length, 0)
    }],
    ['getTenantToken：缓存新鲜 → 返回缓存令牌，不打接口', async () => {
      const cachePath = join(dir, 't.json')
      writeTokenCache({ appId: 'cli_app', token: 't-cached', expiresAt: 5_000_000 }, cachePath)
      const { fetchImpl, calls } = okFetch()
      assert.equal(await getTenantToken({ settings: SETTINGS, cachePath, fetchImpl, now: () => 1_000_000 }), 't-cached')
      assert.equal(calls.length, 0)
    }],
    ['getTenantToken：缓存快到期 → 铸新的、落盘、打一行日志、锁释放', async () => {
      const cachePath = join(dir, 't.json')
      writeTokenCache({ appId: 'cli_app', token: 't-stale', expiresAt: 1_000_000 + 60_000 }, cachePath)
      const { fetchImpl, calls } = okFetch('t-new', 7200)
      const log = silentLog()
      assert.equal(await getTenantToken({ settings: SETTINGS, cachePath, fetchImpl, now: () => 1_000_000, log }), 't-new')
      assert.equal(calls.length, 1)
      assert.equal(readTokenCache(cachePath).token, 't-new')
      assert.equal(readTokenCache(cachePath).expiresAt, 1_000_000 + 7200 * 1000)
      assert.match(log.lines[0], /应用令牌已续，120 分钟后到期/)
      assert.equal(existsSync(`${cachePath}.lock`), false)
    }],
    ['getTenantToken：等锁期间别的进程续好了 → 用它的，不再铸', async () => {
      const cachePath = join(dir, 't.json')
      mkdirSync(`${cachePath}.lock`)
      const { fetchImpl, calls } = okFetch('t-mine')
      const wait = async () => {
        writeTokenCache({ appId: 'cli_app', token: 't-theirs', expiresAt: 9_000_000 }, cachePath)
        rmSync(`${cachePath}.lock`, { recursive: true })
      }
      assert.equal(await getTenantToken({ settings: SETTINGS, cachePath, fetchImpl, wait, now: () => 1_000_000 }), 't-theirs')
      assert.equal(calls.length, 0)
    }],
    ['getTenantToken：铸失败 → null、退避期内不再打接口、退避过了再试', async () => {
      const cachePath = join(dir, 't.json')
      let calls = 0
      const fetchImpl = async () => {
        calls += 1
        return { ok: false, status: 429, json: async () => ({ code: 99991400 }) }
      }
      let clock = 1_000_000
      const now = () => clock
      const state = { mintFailedUntil: 0 }
      const log = silentLog()
      assert.equal(await getTenantToken({ settings: SETTINGS, cachePath, fetchImpl, now, log, state }), null)
      assert.equal(calls, 1)
      assert.equal(state.mintFailedUntil, 1_000_000 + MINT_FAIL_BACKOFF_MS)
      assert.match(log.lines[0], /铸应用令牌失败.*HTTP 429/)
      assert.equal(existsSync(`${cachePath}.lock`), false)
      clock += MINT_FAIL_BACKOFF_MS - 1
      assert.equal(await getTenantToken({ settings: SETTINGS, cachePath, fetchImpl, now, log, state }), null)
      assert.equal(calls, 1)
      clock += 1
      assert.equal(await getTenantToken({ settings: SETTINGS, cachePath, fetchImpl, now, log, state }), null)
      assert.equal(calls, 2)
      // 抛的不是 Error（没有 message）也要把原文打进日志
      const log2 = silentLog()
      assert.equal(await getTenantToken({ settings: SETTINGS, cachePath, fetchImpl: async () => { throw 'boom-str' }, now: () => 5_000_000, log: log2, state: { mintFailedUntil: 0 } }), null)
      assert.match(log2.lines[0], /boom-str/)
    }],
    ['getTenantToken：缓存是别的 app 的 → 当没有，重铸', async () => {
      const cachePath = join(dir, 't.json')
      writeTokenCache({ appId: 'cli_other', token: 't-other', expiresAt: 9_000_000 }, cachePath)
      const { fetchImpl, calls } = okFetch('t-mine')
      assert.equal(await getTenantToken({ settings: SETTINGS, cachePath, fetchImpl, now: () => 1_000_000, log: silentLog() }), 't-mine')
      assert.equal(calls.length, 1)
    }],
    ['createTenantTokenProvider：settings 为 null → 不开，acquire 给 null', async () => {
      const provider = createTenantTokenProvider({ settings: null })
      assert.equal(provider.enabled(), false)
      assert.equal(await provider.acquire(), null)
    }],
    ['createTenantTokenProvider：没传 settings → 按需解析；没解析出来每 recheckMs 才重查一次，解析出来后不再查', async () => {
      let clock = 1_000_000
      let resolves = 0
      let secretPlaced = false
      const resolve = () => {
        resolves += 1
        return secretPlaced ? SETTINGS : null
      }
      const provider = createTenantTokenProvider({ resolve, now: () => clock, recheckMs: SETTINGS_RECHECK_MS })
      assert.equal(provider.enabled(), false)
      assert.equal(resolves, 1)
      secretPlaced = true
      clock += SETTINGS_RECHECK_MS - 1
      assert.equal(provider.enabled(), false)
      assert.equal(resolves, 1)
      clock += 1
      assert.equal(provider.enabled(), true)
      assert.equal(resolves, 2)
      clock += SETTINGS_RECHECK_MS * 5
      assert.equal(provider.enabled(), true)
      assert.equal(resolves, 2)
    }],
    ['createTenantTokenProvider：开了 → acquire 给 app_id / 令牌 / 两个环境变量；invalidate 删缓存', async () => {
      const cachePath = join(dir, 't.json')
      const { fetchImpl } = okFetch('t-p')
      const provider = createTenantTokenProvider({ settings: SETTINGS, cachePath, fetchImpl, now: () => 1_000_000, log: silentLog() })
      assert.equal(provider.enabled(), true)
      assert.deepEqual(await provider.acquire(), { appId: 'cli_app', token: 't-p', env: { LARKSUITE_CLI_APP_ID: 'cli_app', LARKSUITE_CLI_TENANT_ACCESS_TOKEN: 't-p' } })
      assert.equal(provider.invalidate('t-p'), true)
      assert.equal(existsSync(cachePath), false)
    }],
    ['runLarkCli：bot 身份注入两个变量；user 身份 / 带 LARKSUITE_CLI_CONFIG_DIR 的不注；provider 给 null 原样跑', async () => {
      const runLarkCli = await loadRunLarkCli()
      assert.deepEqual(parse(await runLarkCli(['im', 'x'], { tokenProvider: providerOf(['t-1']) })), { ok: true, as: 'bot', app: 'cli_app', token: 't-1' })
      assert.deepEqual(parse(await runLarkCli(['im', 'x'], { identity: 'user', tokenProvider: providerOf(['t-1']) })), { ok: true, as: 'user', app: '', token: '' })
      assert.deepEqual(parse(await runLarkCli(['im', 'x'], { env: { LARKSUITE_CLI_CONFIG_DIR: '/tmp/other-app' }, tokenProvider: providerOf(['t-1']) })), { ok: true, as: 'bot', app: '', token: '' })
      assert.deepEqual(parse(await runLarkCli(['im', 'x'], { tokenProvider: providerOf([]) })), { ok: true, as: 'bot', app: '', token: '' })
      assert.deepEqual(parse(await runLarkCli(['im', 'x', '--as', 'user'], { tokenProvider: providerOf(['t-1']) })), { ok: true, as: 'bot', app: '', token: '' }, 'args 自带 --as 不注（11-03 读通知会话 strict mode 拒 user）')
    }],
    ['runLarkCli：令牌无效（99991663）→ 作废那枚、换新的重试一次；第二次还拿不到就原样跑', async () => {
      const runLarkCli = await loadRunLarkCli()
      const provider = providerOf(['t-old', 't-fresh'])
      const result = await runLarkCli(['im', 'x'], { env: { FAIL_ONCE_FILE: join(dir, 'failed-once') }, tokenProvider: provider })
      assert.deepEqual(parse(result), { ok: true, as: 'bot', app: 'cli_app', token: 't-fresh' })
      assert.deepEqual(provider.invalidated, ['t-old'])
      const provider2 = providerOf(['t-old'])
      const result2 = await runLarkCli(['im', 'x'], { env: { FAIL_ONCE_FILE: join(dir, 'failed-once-2') }, tokenProvider: provider2 })
      assert.deepEqual(parse(result2), { ok: true, as: 'bot', app: '', token: '' })
      assert.deepEqual(provider2.invalidated, ['t-old'])
    }],
    ['runLarkCli：其它失败（非令牌码）不重试、不作废', async () => {
      const runLarkCli = await loadRunLarkCli()
      writeFileSync(bin, '#!/bin/sh\nprintf \'{"ok":false,"error":{"code":99991672}}\'\n')
      const provider = providerOf(['t-1', 't-2'])
      const result = await runLarkCli(['im', 'x'], { tokenProvider: provider })
      assert.equal(parse(result).error.code, 99991672)
      assert.deepEqual(provider.invalidated, [])
    }],
  ], {
    before: () => {
      dir = mkdtempSync(join(tmpdir(), 'lark-tat-'))
    },
    after: () => rmSync(dir, { recursive: true, force: true }),
  }))
})
