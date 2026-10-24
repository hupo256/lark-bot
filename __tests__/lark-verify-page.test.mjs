import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { classifyProblems, parseArgs, problem } from '../tools/verify-page.mjs'
import { DEFAULT_BROWSER_PATTERN } from '../lib/lark-report-render.mjs'
import { VERIFY_PAGE_TOOL, pageToolOf } from '../lib/lark-verify-page.mjs'
import { stopVerifyServer } from '../lib/lark-verify-page-stop.mjs'
import { buildSelfVerifyRule } from '../lib/lark-completion-rule.mjs'

// 页面验证工具（aven 2026-10-23「确保准确的基础上提速」）：标注口径决定 bot 追不追一个问题，标错了要么白追老问题、要么漏掉自己改坏的。
const page = (problems, extra = {}) => ({ path: '/', status: 200, problems, ...extra })

describe('页面验证工具：问题来源标注', () => {
  it('问题来源标注：pre 也有 / 本地新出现 / 已修好，回落 mock 与坏图按 pre 判，不比对时不打标签', () => {
    {
      const t1 = '两边都有的标「pre 上也有」，只在本地的标「本地新出现」，pre 有本地没有的列为已修好'
      const shared = problem('biz', 'GET /api/x -1', '接口返回错误码：GET /api/x → code -1')
      const local = problem('pageError', 'boom', '页面报错：boom')
      const fixed = problem('request', 'GET /hc-api/y', '接口请求失败：GET /hc-api/y → HTTP 404')
      const out = classifyProblems({ result: page([shared, local]), site: page([shared, fixed]) })
      assert.deepEqual(out.items.map((item) => item.tag), ['［pre 上也有］', '［本地新出现］'], t1)
      assert.deepEqual(out.fixedOnLocal.map((item) => item.key), [fixed.key], t1)
      assert.equal(out.total, 2, t1)
      assert.equal(out.fresh, 1, t1)
    }

    {
      const t2 = '没登录导致的回落 mock：pre 上同样登录失效时算「pre 上也有」并注明（本地开发模式才回落，线上显示为空）'
      const mock = problem('mock', 'bbsv2', '回落 mock（假数据）：bbsv2，原因 Bbsv2AuthError: 登陆状态失效，无TOKEN')
      const siteAuth = problem('biz', 'GET /bbsv2/notify/listCursor -700', '接口返回错误码：GET /bbsv2/notify/listCursor → code -700（登录失效）')
      const out = classifyProblems({ result: page([mock]), site: page([siteAuth]) })
      assert.equal(out.items[0].tag, '［pre 上也有］', t2)
      assert.match(out.items[0].note, /没登录调了要登录的接口/, t2)
      assert.equal(out.fresh, 0, t2)
      // 回落原因不是登录（接口报错 / 请求写错）就是本地新问题
      const real = problem('mock', 'php', '回落 mock（假数据）：php，原因 Error: 请求失败 (GET /api/x)')
      assert.equal(classifyProblems({ result: page([real]), site: page([siteAuth]) }).items[0].tag, '［本地新出现］', t2)
    }

    {
      const t3 = '坏图按同一路径直接去 pre 请求的结果定：pre 也打不开是数据问题，pre 正常才算本地新问题'
      const broken = { ...problem('resource', '/upload/a.png', '资源加载失败（image）：/upload/a.png'), siteProbe: 'site-broken' }
      const fine = { ...problem('resource', '/images/b.png', '资源加载失败（image）：/images/b.png'), siteProbe: 'site-ok' }
      const out = classifyProblems({ result: page([broken, fine]), site: page([]) })
      assert.equal(out.items[0].tag, '［pre 上也有］', t3)
      assert.match(out.items[0].note, /数据问题/, t3)
      assert.equal(out.items[1].tag, '［本地新出现］', t3)
      assert.match(out.items[1].note, /地址拼错了/, t3)
    }

    {
      const t4 = '期望文字 / 元素、页面打不开、登录没生效只看本地，不参与比对；不比对时不打标签'
      const want = problem('expect', '新文案', '页面上没看到「新文案」')
      const login = problem('login', '/', '登录可能没生效')
      const out = classifyProblems({ result: page([want, login]), site: page([want]) })
      assert.deepEqual(out.items.map((item) => item.tag), ['', ''], t4)
      assert.equal(out.fresh, 2, '期望没出现永远算本地问题，pre 上没有新功能是正常的')
      assert.equal(classifyProblems({ result: page([want]), site: null }).items[0].tag, '', t4)
    }
  })
})

describe('页面验证工具：参数与接入', () => {
  it('参数解析、证据认工具调用、验证规则给命令、收尾停服务不抛', () => {
    const t1 = '参数：路径补前导斜杠、--expect 可重复、不认识的参数报错'
    const opts = parseArgs(['check', '--cwd', '/tmp/w', '--login', '--expect', '甲', '--expect', '乙', '--no-compare', 'room/260', '/tasks'])
    assert.equal(opts.cmd, 'check', t1)
    assert.equal(opts.login, true, t1)
    assert.equal(opts.noCompare, true, t1)
    assert.deepEqual(opts.expect, ['甲', '乙'], t1)
    assert.deepEqual(opts.paths, ['/room/260', '/tasks'], t1)
    assert.throws(() => parseArgs(['check', '--bogus']), /不认识的参数/)

    const t2 = '证据核对认工具调用（不认会把真用工具验过的降成「待验证」）；只 start 不算看过页面'
    assert.match(`${pageToolOf(null)} check --cwd /w /room/1`, DEFAULT_BROWSER_PATTERN, t2)
    assert.doesNotMatch(`${pageToolOf(null)} start --cwd /w`, DEFAULT_BROWSER_PATTERN, t2)
    assert.equal(pageToolOf({ pageTool: 'node /x/tool.mjs' }), 'node /x/tool.mjs', t2)

    const t3 = '自己验证规则给出工具命令，不再让模型现写 Playwright 脚本'
    const rule = buildSelfVerifyRule({ env: 'pre', localDev: 'pnpm dev:pre', siteUrl: 'https://falivepre.fdsser.com/' })
    assert.ok(rule.includes(VERIFY_PAGE_TOOL), t3)
    assert.match(rule, /页面工具 start --cwd/, t3)
    assert.match(rule, /页面工具 check --cwd/, t3)
    assert.match(rule, /不要自己写 Playwright 脚本/, t3)
    assert.doesNotMatch(rule, /npm i playwright/, t3)

    const t4 = '收尾停服务：调工具 stop；没起过服务不打日志；出错不抛（不影响收尾）'
    const calls = []
    const logs = []
    stopVerifyServer('/w', { spawn: (...args) => { calls.push(args); return { stdout: '已停掉 /w 的本地服务（端口 3391，任务结束）' } }, log: (line) => logs.push(line) })
    assert.deepEqual(calls[0][1], [VERIFY_PAGE_TOOL, 'stop', '--cwd', '/w'], t4)
    assert.equal(logs.length, 1, t4)
    stopVerifyServer('/w', { spawn: () => ({ stdout: '这个工作区没有在跑的本地服务' }), log: (line) => logs.push(line) })
    assert.equal(logs.length, 1, t4)
    assert.doesNotThrow(() => stopVerifyServer('/w', { spawn: () => { throw new Error('x') }, log: () => {} }))
    stopVerifyServer(null, { spawn: () => { throw new Error('不该调') } })
  })
})
