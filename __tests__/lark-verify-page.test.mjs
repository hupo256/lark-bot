import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { classifyProblems, isActiveState, judgeReaction, markSuspectTabs, parseArgs, problem, shouldSkipControl, summarizeSweep, sweepProblems } from '../tools/verify-page.mjs'
import { DEFAULT_BROWSER_PATTERN } from '../lib/lark-report-render.mjs'
import { VERIFY_PAGE_TOOL, pageToolOf } from '../lib/lark-verify-page.mjs'
import { stopVerifyServer } from '../lib/lark-verify-page-stop.mjs'
import { buildSelfVerifyRule } from '../lib/lark-completion-rule.mjs'
import { runSteps } from './support/steps.mjs'

// 页面验证工具（aven 2026-10-23「确保准确的基础上提速」）：标注口径决定 bot 追不追一个问题，标错了要么白追老问题、要么漏掉自己改坏的。
const page = (problems, extra = {}) => ({ path: '/', status: 200, problems, ...extra })

describe('页面验证工具：问题来源标注', () => {
  it('问题来源标注：pre 也有 / 本地新出现 / 已修好，回落 mock 与坏图按 pre 判，不比对时不打标签', () => runSteps([
    ['两边都有的标「pre 上也有」，只在本地的标「本地新出现」，pre 有本地没有的列为已修好', () => {
      const shared = problem('biz', 'GET /api/x -1', '接口返回错误码：GET /api/x → code -1')
      const local = problem('pageError', 'boom', '页面报错：boom')
      const fixed = problem('request', 'GET /hc-api/y', '接口请求失败：GET /hc-api/y → HTTP 404')
      const out = classifyProblems({ result: page([shared, local]), site: page([shared, fixed]) })
      assert.deepEqual(out.items.map((item) => item.tag), ['［pre 上也有］', '［本地新出现］'])
      assert.deepEqual(out.fixedOnLocal.map((item) => item.key), [fixed.key])
      assert.equal(out.total, 2)
      assert.equal(out.fresh, 1)
    }],
    ['没登录导致的回落 mock：pre 上同样登录失效时算「pre 上也有」并注明（本地开发模式才回落，线上显示为空）', () => {
      const mock = problem('mock', 'bbsv2', '回落 mock（假数据）：bbsv2，原因 Bbsv2AuthError: 登陆状态失效，无TOKEN')
      const siteAuth = problem('biz', 'GET /bbsv2/notify/listCursor -700', '接口返回错误码：GET /bbsv2/notify/listCursor → code -700（登录失效）')
      const out = classifyProblems({ result: page([mock]), site: page([siteAuth]) })
      assert.equal(out.items[0].tag, '［pre 上也有］')
      assert.match(out.items[0].note, /没登录调了要登录的接口/)
      assert.equal(out.fresh, 0)
      // 回落原因不是登录（接口报错 / 请求写错）就是本地新问题
      const real = problem('mock', 'php', '回落 mock（假数据）：php，原因 Error: 请求失败 (GET /api/x)')
      assert.equal(classifyProblems({ result: page([real]), site: page([siteAuth]) }).items[0].tag, '［本地新出现］')
    }],
    ['坏图按同一路径直接去 pre 请求的结果定：pre 也打不开是数据问题，pre 正常才算本地新问题', () => {
      const broken = { ...problem('resource', '/upload/a.png', '资源加载失败（image）：/upload/a.png'), siteProbe: 'site-broken' }
      const fine = { ...problem('resource', '/images/b.png', '资源加载失败（image）：/images/b.png'), siteProbe: 'site-ok' }
      const out = classifyProblems({ result: page([broken, fine]), site: page([]) })
      assert.equal(out.items[0].tag, '［pre 上也有］')
      assert.match(out.items[0].note, /数据问题/)
      assert.equal(out.items[1].tag, '［本地新出现］')
      assert.match(out.items[1].note, /地址拼错了/)
    }],
    ['期望文字 / 元素、页面打不开、登录没生效只看本地，不参与比对；不比对时不打标签', () => {
      const want = problem('expect', '新文案', '页面上没看到「新文案」')
      const login = problem('login', '/', '登录可能没生效')
      const out = classifyProblems({ result: page([want, login]), site: page([want]) })
      assert.deepEqual(out.items.map((item) => item.tag), ['', ''])
      assert.equal(out.fresh, 2, '期望没出现永远算本地问题，pre 上没有新功能是正常的')
      assert.equal(classifyProblems({ result: page([want]), site: null }).items[0].tag, '')
    }],
  ]))
})

describe('页面验证工具：参数与接入', () => {
  it('参数解析、证据认工具调用、验证规则给命令、收尾停服务不抛', () => runSteps([
    ['参数：路径补前导斜杠、--expect 可重复、不认识的参数报错', () => {
      const opts = parseArgs(['check', '--cwd', '/tmp/w', '--login', '--expect', '甲', '--expect', '乙', '--no-compare', 'room/260', '/tasks'])
      assert.equal(opts.cmd, 'check')
      assert.equal(opts.login, true)
      assert.equal(opts.noCompare, true)
      assert.deepEqual(opts.expect, ['甲', '乙'])
      assert.deepEqual(opts.paths, ['/room/260', '/tasks'])
      assert.throws(() => parseArgs(['check', '--bogus']), /不认识的参数/)
    }],
    ['证据核对认工具调用（不认会把真用工具验过的降成「待验证」）；只 start 不算看过页面', () => {
      assert.match(`${pageToolOf(null)} check --cwd /w /room/1`, DEFAULT_BROWSER_PATTERN)
      assert.doesNotMatch(`${pageToolOf(null)} start --cwd /w`, DEFAULT_BROWSER_PATTERN)
      assert.equal(pageToolOf({ pageTool: 'node /x/tool.mjs' }), 'node /x/tool.mjs')
    }],
    ['自己验证规则给出工具命令，不再让模型现写 Playwright 脚本', () => {
      const rule = buildSelfVerifyRule({ env: 'pre', localDev: 'pnpm dev:pre', siteUrl: 'https://falivepre.fdsser.com/' })
      assert.ok(rule.includes(VERIFY_PAGE_TOOL))
      assert.match(rule, /页面工具 start --cwd/)
      assert.match(rule, /页面工具 check --cwd/)
      assert.match(rule, /不要自己写 Playwright 脚本/)
      assert.doesNotMatch(rule, /npm i playwright/)
    }],
    ['收尾停服务：调工具 stop；没起过服务不打日志；出错不抛（不影响收尾）', () => {
      const calls = []
      const logs = []
      stopVerifyServer('/w', { spawn: (...args) => { calls.push(args); return { stdout: '已停掉 /w 的本地服务（端口 3391，任务结束）' } }, log: (line) => logs.push(line) })
      assert.deepEqual(calls[0][1], [VERIFY_PAGE_TOOL, 'stop', '--cwd', '/w'])
      assert.equal(logs.length, 1)
      stopVerifyServer('/w', { spawn: () => ({ stdout: '这个工作区没有在跑的本地服务' }), log: (line) => logs.push(line) })
      assert.equal(logs.length, 1)
      assert.doesNotThrow(() => stopVerifyServer('/w', { spawn: () => { throw new Error('x') }, log: () => {} }))
      stopVerifyServer(null, { spawn: () => { throw new Error('不该调') } })
    }],
  ]))
})

// 点击走查（aven 2026-10-27，Bug-5030）：判「点了没反应」的口径决定报不报死控件，松了漏（喇叭钮再漏一次）、紧了误报（轮播页全报）。
describe('页面验证工具：点击走查', () => {
  it('反应判定：跳转 / 新窗口 / 弹层 / 请求 / aria / 自身内容 / 明显超过本底的 DOM 变化算有反应，纯本底抖动不算；副作用词与表单内跳过；只有没反应的进问题并可与 pre 比对', () => runSteps([
    ['什么都没变 → 没反应；页面本底在动（轮播）但点击后没超过本底两倍 → 仍算没反应', () => {
      const base = { url: 'http://x/', popups: 0, dialogs: 0, requests: 3, aria: '-/-/-/-/-', html: '<button>a</button>', mutations: 0 }
      assert.equal(judgeReaction({ before: base, after: { ...base } }).reacted, false)
      assert.match(judgeReaction({ before: base, after: { ...base, mutations: 1 } }).why, /DOM 变化 1 处（本底 0）/, '静止页面点后加一个 toast DIV 就算有反应（广场「分享」）')
      assert.equal(judgeReaction({ before: { ...base, mutations: 10 }, after: { ...base, mutations: 18 } }).reacted, false, '本底 10，点击后 18 ≤ 10*2+2，算抖动')
      assert.equal(judgeReaction({ before: { ...base, mutations: 10 }, after: { ...base, mutations: 23 } }).reacted, true, '超过本底两倍 + 2 才算反应')
    }],
    ['各维度任一变化都算有反应，why 说清是哪种', () => {
      const base = { url: 'http://x/', popups: 0, dialogs: 0, requests: 3, aria: '-/-/-/-/-', html: '<button>a</button>', mutations: 0 }
      assert.match(judgeReaction({ before: base, after: { ...base, url: 'http://x/room/1' } }).why, /跳转/)
      assert.match(judgeReaction({ before: base, after: { ...base, popups: 1 } }).why, /新窗口/)
      assert.match(judgeReaction({ before: { ...base, choosers: 0 }, after: { ...base, choosers: 1 } }).why, /文件选择框/, '「添加图片」打开系统文件框，DOM 不变也算反应')
      assert.match(judgeReaction({ before: base, after: { ...base, dialogs: 1 } }).why, /弹出层/)
      assert.match(judgeReaction({ before: base, after: { ...base, requests: 4 } }).why, /请求 1 个/)
      assert.match(judgeReaction({ before: base, after: { ...base, aria: 'true/-/-/-/-' } }).why, /状态/)
      assert.match(judgeReaction({ before: base, after: { ...base, html: '<button>b</button>' } }).why, /自身内容变化/, '喇叭钮换图标就是这种')
      assert.match(judgeReaction({ before: base, after: { ...base, html: null } }).why, /消失/)
      assert.match(judgeReaction({ before: { ...base, stateSig: 'expanded|' }, after: { ...base, stateSig: 'collapsed|' } }).why, /页面状态变化/, '侧栏收展只改一个 data-sidebar 属性，靠状态签名识别')
    }],
    ['跳过口径：发布 / 关注 / 退出等副作用词、表单内的不点；普通按钮不跳过', () => {
      assert.match(shouldSkipControl({ text: '发布帖子' }), /发布/)
      assert.match(shouldSkipControl({ text: '退出登录' }), /退出/)
      assert.equal(shouldSkipControl({ text: '提交', inForm: true }), '表单内')
      assert.equal(shouldSkipControl({ text: '静音' }), '')
      assert.equal(shouldSkipControl({ text: '签到规则 ›' }), '', '规则说明钮不是签到动作，要点（含「签到」但有「规则」豁免）')
      assert.match(shouldSkipControl({ text: '签到' }), /签到/, '真正的签到钮仍跳过')
      assert.equal(isActiveState('true/-/-/-/-'), true, '已按下的 tab 再点不算死控件')
      assert.equal(isActiveState('-/-/-/-/active'), true)
      assert.equal(isActiveState('-/-/-/-/-'), false)
      assert.equal(isActiveState('false/-/-/-/inactive'), false, 'inactive 不含整词 active')
    }],
    ['只有 dead 的进问题，key 带页面 + 文字，kind 可与 pre 同页比对；汇总按结果计数', () => {
      const controls = [
        { id: 0, tag: 'button', text: '静音', outcome: 'reacted', why: '自身内容变化' },
        { id: 1, tag: 'button', text: '签到规则 ›', outcome: 'dead', why: '' },
        { id: 2, tag: 'button', text: '发布', outcome: 'skipped', why: '含「发布」' },
        { id: 3, tag: 'a', text: '无文字的 a.x', outcome: 'lost', why: '点不到' },
      ]
      const items = sweepProblems({ path: '/tasks', controls })
      assert.deepEqual(items.map((item) => item.key), ['deadControl:/tasks 签到规则 ›'])
      assert.match(items[0].text, /点了没反应：「签到规则 ›」（button）/)
      assert.deepEqual(summarizeSweep({ controls }), { total: 4, reacted: 1, dead: 1, skipped: 1, lost: 1, suspect: 0 })
      // 同组兄弟有反应、它没反应 → 疑似当前 tab，不进问题（直播间「广场」tab 没写 aria-selected）
      const tabs = markSuspectTabs([
        { id: 0, tag: 'button', text: '广场', outcome: 'dead', why: '', parentKey: 'DIV#.tabs@5' },
        { id: 1, tag: 'button', text: '私聊', outcome: 'reacted', why: '自身内容变化', parentKey: 'DIV#.tabs@5' },
        { id: 2, tag: 'button', text: '孤零零', outcome: 'dead', why: '', parentKey: 'DIV#.other@1' },
      ])
      assert.deepEqual(tabs.map((item) => item.outcome), ['suspect', 'reacted', 'dead'])
      assert.deepEqual(sweepProblems({ path: '/room/1', controls: tabs }).map((item) => item.key), ['deadControl:/room/1 孤零零'])
      const out = classifyProblems({ result: page(items), site: page(items) })
      assert.equal(out.items[0].tag, '［pre 上也有］', 'pre 同页也点了没反应 → 不是本次改动带来的')
      assert.equal(parseArgs(['check', '--click-sweep', '/']).clickSweep, true)
    }],
  ]))
})
