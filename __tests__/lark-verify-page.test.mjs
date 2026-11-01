import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { classifyProblems, isActiveState, judgeReaction, markSuspectTabs, parseArgs, problem, resolveVerifyConfig, shouldSkipControl, summarizeSweep, sweepProblems } from '../tools/verify-page.mjs'
import { VERIFY_PAGE_TOOL, buildPageVerifyRule, pageToolOf } from '../lib/lark-verify-page.mjs'
import { stopVerifyServer } from '../lib/lark-verify-page-stop.mjs'
import { buildTaskPrompt, buildValidationRequirements } from '../lib/lark-worker-prompts.mjs'
import { runSteps } from './support/steps.mjs'

// 页面验证工具（从 falive 移植，aven 2026-10-23「确保准确的基础上提速」）：标注口径决定 bot 追不追一个问题，标错了要么白追老问题、要么漏掉自己改坏的。
const page = (problems, extra = {}) => ({ path: '/', status: 200, problems, ...extra })

describe('页面验证工具：问题来源标注与点击走查', () => {
  it('问题来源标注：已部署站点也有 / 本地新出现 / 已修好，回落 mock 与坏图按站点判，不比对时不打标签；点击走查：反应判定 / 跳过口径 / 只有没反应的进问题', () => runSteps([
    ['两边都有的标「pre 上也有」，只在本地的标「本地新出现」，站点有本地没有的列为已修好', () => {
      const shared = problem('biz', 'GET /api/x -1', '接口返回错误码：GET /api/x → code -1')
      const local = problem('pageError', 'boom', '页面报错：boom')
      const fixed = problem('request', 'GET /hc-api/y', '接口请求失败：GET /hc-api/y → HTTP 404')
      const out = classifyProblems({ result: page([shared, local]), site: page([shared, fixed]) })
      assert.deepEqual(out.items.map((item) => item.tag), ['［pre 上也有］', '［本地新出现］'])
      assert.deepEqual(out.fixedOnLocal.map((item) => item.key), [fixed.key])
      assert.equal(out.total, 2)
      assert.equal(out.fresh, 1)
    }],
    ['没登录导致的回落 mock：站点上同样登录失效时算「pre 上也有」并注明', () => {
      const mock = problem('mock', 'bbsv2', '回落 mock（假数据）：bbsv2，原因 Bbsv2AuthError: 登陆状态失效，无TOKEN')
      const siteAuth = problem('biz', 'GET /bbsv2/notify/listCursor -700', '接口返回错误码：GET /bbsv2/notify/listCursor → code -700（登录失效）')
      const out = classifyProblems({ result: page([mock]), site: page([siteAuth]) })
      assert.equal(out.items[0].tag, '［pre 上也有］')
      assert.match(out.items[0].note, /没登录调了要登录的接口/)
      assert.equal(out.fresh, 0)
      const real = problem('mock', 'php', '回落 mock（假数据）：php，原因 Error: 请求失败 (GET /api/x)')
      assert.equal(classifyProblems({ result: page([real]), site: page([siteAuth]) }).items[0].tag, '［本地新出现］')
    }],
    ['坏图按同一路径直接去站点请求的结果定：站点也打不开是数据问题，站点正常才算本地新问题', () => {
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
      assert.equal(out.fresh, 2, '期望没出现永远算本地问题，站点上没有新功能是正常的')
      assert.equal(classifyProblems({ result: page([want]), site: null }).items[0].tag, '')
    }],
    ['什么都没变 → 没反应；页面本底在动（轮播）但点击后没超过本底两倍 → 仍算没反应', () => {
      const base = { url: 'http://x/', popups: 0, dialogs: 0, requests: 3, aria: '-/-/-/-/-', html: '<button>a</button>', mutations: 0 }
      assert.equal(judgeReaction({ before: base, after: { ...base } }).reacted, false)
      assert.match(judgeReaction({ before: base, after: { ...base, mutations: 1 } }).why, /DOM 变化 1 处（本底 0）/, '静止页面点后加一个 toast DIV 就算有反应')
      assert.equal(judgeReaction({ before: { ...base, mutations: 10 }, after: { ...base, mutations: 18 } }).reacted, false, '本底 10，点击后 18 ≤ 10*2+2，算抖动')
      assert.equal(judgeReaction({ before: { ...base, mutations: 10 }, after: { ...base, mutations: 23 } }).reacted, true, '超过本底两倍 + 2 才算反应')
    }],
    ['各维度任一变化都算有反应，why 说清是哪种', () => {
      const base = { url: 'http://x/', popups: 0, dialogs: 0, requests: 3, aria: '-/-/-/-/-', html: '<button>a</button>', mutations: 0 }
      assert.match(judgeReaction({ before: base, after: { ...base, url: 'http://x/room/1' } }).why, /跳转/)
      assert.match(judgeReaction({ before: base, after: { ...base, popups: 1 } }).why, /新窗口/)
      assert.match(judgeReaction({ before: { ...base, choosers: 0 }, after: { ...base, choosers: 1 } }).why, /文件选择框/)
      assert.match(judgeReaction({ before: base, after: { ...base, dialogs: 1 } }).why, /弹出层/)
      assert.match(judgeReaction({ before: base, after: { ...base, requests: 4 } }).why, /请求 1 个/)
      assert.match(judgeReaction({ before: base, after: { ...base, aria: 'true/-/-/-/-' } }).why, /状态/)
      assert.match(judgeReaction({ before: base, after: { ...base, html: '<button>b</button>' } }).why, /自身内容变化/)
      assert.match(judgeReaction({ before: base, after: { ...base, html: null } }).why, /消失/)
      assert.match(judgeReaction({ before: { ...base, stateSig: 'expanded|' }, after: { ...base, stateSig: 'collapsed|' } }).why, /页面状态变化/)
    }],
    ['跳过口径：发布 / 关注 / 退出等副作用词、表单内的不点；普通按钮不跳过', () => {
      assert.match(shouldSkipControl({ text: '发布帖子' }), /发布/)
      assert.match(shouldSkipControl({ text: '退出登录' }), /退出/)
      assert.equal(shouldSkipControl({ text: '提交', inForm: true }), '表单内')
      assert.equal(shouldSkipControl({ text: '静音' }), '')
      assert.equal(shouldSkipControl({ text: '签到规则 ›' }), '', '规则说明钮不是动作本身，要点')
      assert.match(shouldSkipControl({ text: '签到' }), /签到/)
      assert.equal(isActiveState('true/-/-/-/-'), true)
      assert.equal(isActiveState('-/-/-/-/active'), true)
      assert.equal(isActiveState('-/-/-/-/-'), false)
      assert.equal(isActiveState('false/-/-/-/inactive'), false, 'inactive 不含整词 active')
    }],
    ['只有 dead 的进问题，key 带页面 + 文字；同组兄弟有反应的 dead 降为疑似 tab；汇总按结果计数', () => {
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
      const tabs = markSuspectTabs([
        { id: 0, tag: 'button', text: '广场', outcome: 'dead', why: '', parentKey: 'DIV#.tabs@5' },
        { id: 1, tag: 'button', text: '私聊', outcome: 'reacted', why: '自身内容变化', parentKey: 'DIV#.tabs@5' },
        { id: 2, tag: 'button', text: '孤零零', outcome: 'dead', why: '', parentKey: 'DIV#.other@1' },
      ])
      assert.deepEqual(tabs.map((item) => item.outcome), ['suspect', 'reacted', 'dead'])
      assert.deepEqual(sweepProblems({ path: '/room/1', controls: tabs }).map((item) => item.key), ['deadControl:/room/1 孤零零'])
      assert.equal(classifyProblems({ result: page(items), site: page(items) }).items[0].tag, '［pre 上也有］')
      assert.equal(parseArgs(['check', '--click-sweep', '/']).clickSweep, true)
    }],
  ]))
})

describe('页面验证工具：配置、参数与接入', () => {
  it('配置归一（dev 命令 / 站点 / 登录模块 / 正则，env 覆盖）、参数解析、提示词按有没有 verify 切换、收尾停服务不抛', () => runSteps([
    ['配置：缺省 pnpm dev、不比对、不认第三方主机；配了就用配的；env 覆盖；mock 日志样式缺省认 [api] … 回落 mock', () => {
      const bare = resolveVerifyConfig({ raw: {}, env: {} })
      assert.deepEqual([bare.localDev, bare.compareBase, bare.compareLabel, bare.appHosts, bare.loginModule, bare.loginProbePath, bare.visitorKey], [['pnpm', 'dev'], null, 'pre', null, null, null, null])
      assert.ok(bare.mockLogPattern.test('[api] php 接口不可用，回落 mock'))
      assert.equal('[api] php 接口不可用，回落 mock'.match(bare.mockLogPattern)[1], 'php')
      const cfg = resolveVerifyConfig({ raw: { localDev: ['pnpm', '--filter', 'web', 'dev'], compareBase: 'https://test.example.com/', compareLabel: 'test', appHosts: 'example\\.com', loginModule: '/x/login.mjs', loginProbePath: '/user/info$', visitorKey: 'visitor' }, env: {} })
      assert.deepEqual(cfg.localDev, ['pnpm', '--filter', 'web', 'dev'])
      assert.equal(cfg.compareBase, 'https://test.example.com', '去掉末尾斜杠')
      assert.equal(cfg.compareLabel, 'test')
      assert.ok(cfg.appHosts.test('api.example.com'))
      assert.ok(cfg.loginProbePath.test('/api/user/info'))
      const env = resolveVerifyConfig({ raw: cfg, env: { VERIFY_DEV_CMD: 'npm run dev', VERIFY_COMPARE_BASE: 'https://pre.example.com', VERIFY_APP_HOSTS: 'other\\.com', VERIFY_LOGIN_MODULE: '/y.mjs' } })
      assert.deepEqual([env.localDev, env.compareBase, env.loginModule], [['npm', 'run', 'dev'], 'https://pre.example.com', '/y.mjs'])
      assert.ok(env.appHosts.test('x.other.com'))
    }],
    ['参数：路径补前导斜杠、--expect 可重复、不认识的参数报错', () => {
      const opts = parseArgs(['check', '--cwd', '/tmp/w', '--login', '--expect', '甲', '--expect', '乙', '--no-compare', 'room/260', '/tasks'])
      assert.equal(opts.cmd, 'check')
      assert.equal(opts.login, true)
      assert.equal(opts.noCompare, true)
      assert.deepEqual(opts.expect, ['甲', '乙'])
      assert.deepEqual(opts.paths, ['/room/260', '/tasks'])
      assert.throws(() => parseArgs(['check', '--bogus']), /不认识的参数/)
      assert.equal(pageToolOf(null), `node ${VERIFY_PAGE_TOOL}`)
      assert.equal(pageToolOf({ pageTool: 'node /x/tool.mjs' }), 'node /x/tool.mjs')
    }],
    ['自己验证规则给出工具命令，不让模型现写 Playwright 脚本；配了比对站点才提比对；没配 verify 规则为空', () => {
      const rule = buildPageVerifyRule({ localDev: ['pnpm', 'dev'], compareBase: 'https://test.example.com', compareLabel: 'test' })
      assert.ok(rule.includes(VERIFY_PAGE_TOOL))
      assert.match(rule, /页面工具 start --cwd/)
      assert.match(rule, /页面工具 check --cwd/)
      assert.match(rule, /不要自己写 Playwright 脚本/)
      assert.match(rule, /test 上也有/)
      assert.doesNotMatch(buildPageVerifyRule({ localDev: ['pnpm', 'dev'] }), /上也有/)
      assert.match(buildPageVerifyRule({}), /后台起本地 dev 服务 `pnpm dev`/, '没配 localDev 用缺省命令')
      assert.match(buildPageVerifyRule({ localDev: ['npm', 'run', 'dev'] }), /`npm run dev`/)
      assert.equal(buildPageVerifyRule(null), '')
    }],
    ['提示词：没配 verify 保持老口径（不要启动 dev server）；配了 verify 实施提示带「自己验证」规则和页面工具，只读任务不带', () => {
      const ctx = { projectId: 'TR-99999', projectName: 'test', projectDocs: [], cwd: '/tmp/repo', hotfixBranch: 'hotfix/x', baseRef: 'origin/online' }
      const task = { id: 't', text: '修复：按钮颜色', attachments: [], chatId: 'oc' }
      const plain = buildTaskPrompt(ctx, task, 'claude', { ruleContext: { text: '', sources: [] } })
      assert.match(plain, /禁止启动 dev server|不要启动 dev server/)
      assert.doesNotMatch(plain, /自己验证（硬规则）/)
      const verify = { localDev: ['pnpm', 'dev'], compareBase: 'https://test.example.com' }
      const withTool = buildTaskPrompt(ctx, task, 'claude', { ruleContext: { text: '', sources: [] }, verify })
      assert.match(withTool, /自己验证（硬规则）/)
      assert.ok(withTool.includes(VERIFY_PAGE_TOOL))
      assert.doesNotMatch(withTool, /禁止启动 dev server|不要启动 dev server/)
      assert.match(buildValidationRequirements({ verify }), /页面 \/ 交互改动要自己验/)
      const readOnly = buildTaskPrompt(ctx, { ...task, text: '状态：项目进度', commandType: 'status' }, 'claude', { ruleContext: { text: '', sources: [] }, verify })
      assert.doesNotMatch(readOnly, /自己验证（硬规则）/, '只读查询不起 dev 服务')
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
      const failLogs = []
      stopVerifyServer('/w', { spawn: () => { throw 'raw string' }, log: (line) => failLogs.push(line) })
      assert.match(failLogs[0], /停验证服务失败.*raw string/, '抛的不是 Error 对象也要把原文记进日志')
      stopVerifyServer(null, { spawn: () => { throw new Error('不该调') } })
    }],
  ]))
})
