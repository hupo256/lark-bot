#!/usr/bin/env node
/**
 * 修改范围契约单测。这层决定 bot 的改动能不能无人值守地落进分支，判错两个方向都很实：
 * 判松 → PR-01930 式越界（就近改了「长得像」的邻列常量）照样提交；判紧 → 改一个 key 同步九种语言、
 * 顺手补个同名测试都被打回人工，无人值守就没了意义。
 * 历史回归用例取自 fameex-web 的真实 lark 提交（d91b18a80c、7eab662735）与 PR-01930 / PR-02273 的事故复盘。
 *
 *   node --test __tests__/lark-scope-contract.test.mjs
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  DEFAULT_LINE_BUDGETS,
  FORBIDDEN_PATH_RULES,
  applyScopeApprovals,
  autoAllowedPaths,
  buildScopeBlockedResult,
  buildScopeRequest,
  checkScopeContract,
  extractRepoPaths,
  isScopeApprovalReply,
  normalizeScopeRequest,
  resolveScopeApproval,
  resolveScopeGate,
  scopeRequestFromBlockers,
  countBudgetLines,
  detectSetOperationCue,
  formatScopeSection,
  isSetOperationTask,
  matchForbiddenPath,
  normalizeRepoPath,
  normalizeScope,
  parseNumstat,
  resolveLineBudget,
} from '../lib/lark-scope-contract.mjs'
import { WORK_KINDS } from '../lib/lark-work-policy.mjs'

const target = (path, extra = {}) => ({ path, symbols: [], reason: '缺陷首个出错位置', ...extra })
const sibling = (path, include, reason = '同字段') => ({ path, include, reason })
const scopeOf = (targets, items = [], searchQueries = []) => ({ targets, siblings: { searchQueries, items } })
const numstatOf = (rows) => rows.map(([added, deleted, path]) => `${added}\t${deleted}\t${path}`).join('\n')

describe('normalizeRepoPath / normalizeScope', () => {
  it('`./a` 与 `a` 归一为同一路径，重复 target 合并 symbols', () => {
    const scope = normalizeScope(scopeOf([
      target('./apps/web/src/a.ts', { symbols: ['foo'] }),
      target('apps/web/src/a.ts', { symbols: ['bar', 'foo'] }),
      target('apps\\web\\src\\b.ts'),
    ]))
    assert.equal(scope.missing, false)
    assert.deepEqual(scope.targets.map((item) => item.path), ['apps/web/src/a.ts', 'apps/web/src/b.ts'])
    assert.deepEqual(scope.targets[0].symbols, ['foo', 'bar'])
  })

  it('`../x`、绝对路径、通配符、目录 → 整份 scope 判缺失', () => {
    for (const bad of ['../x.ts', 'apps/../../etc/passwd', '/etc/passwd', '~/x.ts', 'C:\\x.ts', 'apps/web/**/*.ts', 'apps/web/src/']) {
      const result = normalizeScope(scopeOf([target('apps/web/src/a.ts'), target(bad)]))
      assert.equal(result.missing, true, bad)
      assert.match(result.reason, /非法路径/, bad)
    }
    // sibling 里的恶意路径同样拒绝。
    assert.equal(normalizeScope(scopeOf([target('a.ts')], [sibling('../b.ts', false)])).missing, true)
  })

  it('Next.js 路由目录的 [] / () 是合法路径，不当通配符拒绝', () => {
    assert.deepEqual(normalizeRepoPath('apps/admin/src/app/[lang]/(dashboard)/page.tsx'), {
      path: 'apps/admin/src/app/[lang]/(dashboard)/page.tsx',
    })
  })

  it('null / 非对象 / 无任何要改的文件 → missing；已归一结果幂等', () => {
    assert.equal(normalizeScope(null).missing, true)
    assert.equal(normalizeScope('apps/a.ts').missing, true)
    assert.equal(normalizeScope({ targets: 'a.ts' }).missing, true)
    assert.equal(normalizeScope(scopeOf([], [sibling('a.ts', false)])).missing, true)
    // 只有 include=true 的兄弟位置也算声明了要改的文件。
    assert.equal(normalizeScope(scopeOf([], [sibling('a.ts', true)])).missing, false)
    const once = normalizeScope(scopeOf([target('./a.ts')], [sibling('b.ts', true), sibling('./b.ts', false)]))
    assert.deepEqual(normalizeScope(once), once)
    assert.equal(once.siblings.items[0].include, true)
  })
})

describe('isSetOperationTask', () => {
  it('集合型措辞命中', () => {
    const positives = [
      "把'抵扣比例'统一改为'体验金比例'，涉及体验金申请/列表/流水", // PR-02273 原话
      '这两处都是 web/ 下的改动，不涉及后台，请同步更新', // 7eab662735
      '体验金余额/详情展示未减去已过期数量，需按「发放-已使用-已过期=剩余」修正多处显示逻辑', // d91b18a80c
      '所有页面的按钮圆角都改成 8px',
      "把所有'抵扣比例'改为'体验金比例'",
      '这个改动涉及 3 个页面',
      '全局替换旧 logo',
      '其它页面也要一起改',
      '文案全部改成英文',
      '这几个页面的标题样式不一致',
    ]
    for (const text of positives) assert.equal(isSetOperationTask(text), true, text)
  })

  it('名词里带量词 / 单点描述不算集合型', () => {
    const negatives = [
      '全部订单页的某个按钮颜色不对',
      '统一账户页面余额显示错误',
      '统一下单接口报错',
      '按钮颜色和设计稿保持一致',
      '所有用户都看不到资产余额',
      '批量审核按钮点了没反应',
      '批量修改按钮点了没反应',
      '全局搜索框的 placeholder 不对',
      '此处文案错误',
      '这个页面的处理逻辑不对',
      '一个页面白屏',
      '',
    ]
    for (const text of negatives) assert.equal(isSetOperationTask(text), false, text)
  })

  it('detectSetOperationCue 给出命中的 cue 标签', () => {
    assert.equal(detectSetOperationCue('统一改为体验金比例'), '统一')
    assert.equal(detectSetOperationCue('导出按钮点了没反应'), null)
  })
})

describe('autoAllowedPaths', () => {
  it('已声明 locale 文件 → 同 root 同 namespace 的其它语言放行（locales / resources 两种布局）', () => {
    const scope = scopeOf([
      target('apps/web/src/i18n/locales/zh-CN/assets.json'),
      target('apps/web-next/src/i18n/resources/zh-CN/spot.json'),
    ])
    const allowed = autoAllowedPaths(scope, [
      'apps/web/src/i18n/locales/en-US/assets.json',
      'apps/web/src/i18n/locales/zh-TW/assets.json',
      'apps/web-next/src/i18n/resources/tr-TR/spot.json',
      'apps/web/src/i18n/locales/en-US/common.json', // 不同 namespace
      'apps/admin/src/i18n/locales/en-US/assets.json', // 不同 app 的同名 namespace
    ])
    assert.deepEqual(allowed.map((item) => item.path), [
      'apps/web/src/i18n/locales/en-US/assets.json',
      'apps/web/src/i18n/locales/zh-TW/assets.json',
      'apps/web-next/src/i18n/resources/tr-TR/spot.json',
    ])
  })

  it('已声明源文件 → 同名测试放行（x.test / x.spec / __tests__，扩展名可不同）', () => {
    const scope = scopeOf([target('apps/admin/src/apps/Foo/utils/useColumns.tsx'), target('src/lib/calc.ts')])
    const allowed = autoAllowedPaths(scope, [
      'apps/admin/src/apps/Foo/utils/useColumns.test.ts',
      'src/lib/calc.spec.ts',
      'src/lib/__tests__/calc.test.mjs',
      'src/lib/calcHelper.test.ts', // 前缀相同但不是同名
      'src/other/calc.test.ts', // 同名但不同目录
    ])
    assert.deepEqual(allowed.map((item) => item.path), [
      'apps/admin/src/apps/Foo/utils/useColumns.test.ts',
      'src/lib/calc.spec.ts',
      'src/lib/__tests__/calc.test.mjs',
    ])
  })

  it('scope 缺失时不放行任何文件', () => {
    assert.deepEqual(autoAllowedPaths(null, ['a.test.ts']), [])
  })
})

describe('FORBIDDEN_PATH_RULES / 行数口径', () => {
  it('禁区覆盖任意层级的 package.json、lockfile、tsconfig*、配置包与 CI 目录', () => {
    for (const path of [
      'package.json', 'apps/web/package.json', 'pnpm-lock.yaml', 'yarn.lock', 'biome.json',
      'tsconfig.json', 'apps/web/tsconfig.build.json', 'turbo.json', 'packages/config/tailwind-preset.js',
      '.github/workflows/ci.yml', '.husky/pre-commit', 'pnpm-workspace.yaml', '.npmrc', 'apps/web/.npmrc',
    ]) assert.ok(matchForbiddenPath(path), path)
    for (const path of ['apps/web/src/package.ts', 'apps/web/src/config/index.ts', 'packages/ui/src/Button.tsx', 'docs/pnpm-workspace.md', 'apps/web/src/npmrc.ts']) {
      assert.equal(matchForbiddenPath(path), null, path)
    }
    assert.ok(FORBIDDEN_PATH_RULES.every((rule) => rule.re instanceof RegExp && rule.reason))
  })

  it('parseNumstat：普通行、二进制、rename 两种记法', () => {
    const entries = parseNumstat([
      '12\t0\tapps/web/src/apps/Futures/utils/marginRate.test.ts',
      '-\t-\tapps/web/public/logo.png',
      '3\t1\tapps/web/src/{old => new}/x.ts',
      '2\t2\tapps/web/src/a.ts => apps/web/src/b.ts',
      '',
      'garbage line',
    ].join('\n'))
    assert.deepEqual(entries, [
      { path: 'apps/web/src/apps/Futures/utils/marginRate.test.ts', added: 12, deleted: 0, binary: false },
      { path: 'apps/web/public/logo.png', added: 0, deleted: 0, binary: true },
      { path: 'apps/web/src/new/x.ts', added: 3, deleted: 1, binary: false },
      { path: 'apps/web/src/b.ts', added: 2, deleted: 2, binary: false },
    ])
  })

  it('lockfile 与 locale json 不计入行数', () => {
    const entries = parseNumstat(numstatOf([
      [10, 5, 'apps/web/src/a.ts'],
      [500, 300, 'pnpm-lock.yaml'],
      [90, 90, 'apps/web/src/i18n/locales/en-US/assets.json'],
    ]))
    assert.equal(countBudgetLines(entries), 15)
  })

  it('上限按 WORK_KINDS 取值索引，可被配置覆盖（键名 / 取值都认，null = 不设上限）', () => {
    assert.equal(DEFAULT_LINE_BUDGETS[WORK_KINDS.qaFeedback], 200)
    assert.equal(resolveLineBudget(WORK_KINDS.bugfix), 120)
    assert.equal(resolveLineBudget(WORK_KINDS.readonly), null)
    assert.equal(resolveLineBudget(WORK_KINDS.qaFeedback, { qaFeedback: 300 }), 300)
    assert.equal(resolveLineBudget(WORK_KINDS.qaFeedback, { qa_feedback: 250 }), 250)
    assert.equal(resolveLineBudget(WORK_KINDS.bugfix, { bugfix: null }), null)
  })
})

describe('checkScopeContract', () => {
  it('PR-01930 式越界：声明名称列渲染器，实测改了邻近的常量映射 → outOfScope', () => {
    const check = checkScopeContract({
      scope: scopeOf([target('apps/admin/src/apps/TrialFeeClaimLog/utils/useColumns.tsx', { symbols: ['trialFeeName'] })]),
      actualChangedFiles: ['apps/admin/src/apps/TrialFeeClaimLog/utils/formatters.ts'],
      numstat: numstatOf([[4, 4, 'apps/admin/src/apps/TrialFeeClaimLog/utils/formatters.ts']]),
      workKind: WORK_KINDS.qaFeedback,
      taskText: '体验金名称列显示「加强合约体验金20USDT」，应为合约增强体验金',
    })
    assert.equal(check.ok, false)
    assert.deepEqual(check.outOfScope, ['apps/admin/src/apps/TrialFeeClaimLog/utils/formatters.ts'])
    assert.equal(check.setOperation, false)
  })

  it('集合型任务 siblings 为空 → siblingsRequired，不 ok', () => {
    const check = checkScopeContract({
      scope: scopeOf([target('apps/admin/src/apps/TrialBalanceApply/utils/useColumns.tsx')]),
      actualChangedFiles: ['apps/admin/src/apps/TrialBalanceApply/utils/useColumns.tsx'],
      workKind: WORK_KINDS.qaFeedback,
      taskText: "把'抵扣比例'统一改为'体验金比例'，涉及体验金申请/列表/流水",
    })
    assert.equal(check.ok, false)
    assert.equal(check.siblingsRequired, true)
    assert.equal(check.setOperationCue, '统一')
    assert.deepEqual(check.outOfScope, [])
  })

  it('集合型任务漏改 include=true 的兄弟：子集判定发现不了，用 missingIncludedSiblings 提示、不阻断', () => {
    const check = checkScopeContract({
      scope: scopeOf(
        [target('apps/admin/src/apps/TrialBalanceApply/utils/useColumns.tsx')],
        [
          sibling('apps/admin/src/apps/TrialBalanceApplyView/components/Form.tsx', true, '同字段详情页 label'),
          sibling('apps/admin/src/apps/TrialBalanceCreateOrder/components/SearchForm.tsx', true, '同字段建单 label'),
          sibling('apps/admin/src/apps/ContractCredit/utils/useColumns.tsx', false, '「亏损抵扣比例」是另一特性'),
        ],
        ['抵扣比例', 'deductionRate'],
      ),
      actualChangedFiles: [
        'apps/admin/src/apps/TrialBalanceApply/utils/useColumns.tsx',
        'apps/admin/src/apps/TrialBalanceApplyView/components/Form.tsx',
      ],
      workKind: WORK_KINDS.qaFeedback,
      taskText: "把'抵扣比例'统一改为'体验金比例'",
    })
    assert.equal(check.ok, true)
    assert.equal(check.siblingsRequired, false)
    assert.deepEqual(check.missingIncludedSiblings, ['apps/admin/src/apps/TrialBalanceCreateOrder/components/SearchForm.tsx'])
    assert.match(formatScopeSection({ scope: scopeOf([target('a.ts')]), check }), /疑似漏改/)
  })

  it('改了 include=false 的兄弟 → 越界', () => {
    const check = checkScopeContract({
      scope: scopeOf([target('a.ts')], [sibling('b.ts', false, '语义不同')]),
      actualChangedFiles: ['a.ts', 'b.ts'],
      workKind: WORK_KINDS.bugfix,
    })
    assert.deepEqual(check.outOfScope, ['b.ts'])
  })

  it('真实提交 7eab662735：两处 tsx + zh-CN locale，其它语言同 namespace 自动放行', () => {
    const files = [
      'apps/web/src/apps/CashFlow/futures/FuturesCashFlow.tsx',
      'apps/web/src/apps/Futures/components/FuturesOrders/FundsFlow/components/TransactionFilter.tsx',
      'apps/web/src/i18n/locales/zh-CN/assets.json',
    ]
    const check = checkScopeContract({
      scope: scopeOf(
        [target(files[0]), target(files[2], { symbols: ['assets:cashFlow.type'] })],
        [sibling(files[1], true, '同一筛选项文案')],
        ['资金流水类型'],
      ),
      actualChangedFiles: [...files, 'apps/web/src/i18n/locales/en-US/assets.json'],
      numstat: numstatOf([[3, 3, files[0]], [1, 1, files[1]], [3, 3, files[2]], [3, 3, 'apps/web/src/i18n/locales/en-US/assets.json']]),
      workKind: WORK_KINDS.qaFeedback,
      taskText: '这两处都是 web/ 下的改动，不涉及后台，请同步更新',
    })
    assert.equal(check.ok, true)
    assert.equal(check.setOperation, true)
    assert.equal(check.lineCount, 8)
    assert.deepEqual(check.autoAllowed.map((item) => item.path), ['apps/web/src/i18n/locales/en-US/assets.json'])
  })

  it('真实提交 d91b18a80c：声明 marginRate.ts，同名测试自动放行；集合型但给了 siblings', () => {
    const check = checkScopeContract({
      scope: scopeOf(
        [target('apps/web/src/apps/Futures/utils/marginRate.ts')],
        [sibling('apps/web/src/apps/Assets/TrialBalance/Detail.tsx', false, '只读 helper 输出，无需改')],
        ['已过期', 'expired'],
      ),
      actualChangedFiles: ['apps/web/src/apps/Futures/utils/marginRate.test.ts', 'apps/web/src/apps/Futures/utils/marginRate.ts'],
      numstat: numstatOf([[12, 0, 'apps/web/src/apps/Futures/utils/marginRate.test.ts'], [3, 2, 'apps/web/src/apps/Futures/utils/marginRate.ts']]),
      workKind: WORK_KINDS.bugfix,
      taskText: '体验金余额/详情展示未减去已过期数量，需按「发放-已使用-已过期=剩余」修正多处显示逻辑',
    })
    assert.equal(check.ok, true)
    assert.deepEqual(check.autoAllowed, [{ path: 'apps/web/src/apps/Futures/utils/marginRate.test.ts', reason: '已声明源文件的同名测试' }])
    assert.equal(check.lineCount, 17)
  })

  it('改 package.json：即使已声明也 forbidden，且不重复列入 outOfScope', () => {
    const check = checkScopeContract({
      scope: scopeOf([target('apps/web/package.json'), target('apps/web/src/a.ts')]),
      actualChangedFiles: ['apps/web/package.json', 'apps/web/src/a.ts', 'pnpm-lock.yaml'],
      workKind: WORK_KINDS.bugfix,
    })
    assert.equal(check.ok, false)
    assert.deepEqual(check.forbiddenTouched.map((item) => item.path), ['apps/web/package.json', 'pnpm-lock.yaml'])
    assert.deepEqual(check.outOfScope, [])
  })

  it('超行数：bugfix 上限 120，配置可覆盖', () => {
    const args = {
      scope: scopeOf([target('apps/web/src/a.ts')]),
      actualChangedFiles: ['apps/web/src/a.ts'],
      numstat: numstatOf([[100, 21, 'apps/web/src/a.ts']]),
      workKind: WORK_KINDS.bugfix,
    }
    const check = checkScopeContract(args)
    assert.equal(check.ok, false)
    assert.deepEqual(check.overBudget, { limit: 120, actual: 121 })
    assert.equal(checkScopeContract({ ...args, budgets: { bugfix: 200 } }).ok, true)
    // numstat 未传入时不判行数。
    assert.equal(checkScopeContract({ ...args, numstat: null }).overBudget, null)
  })

  it('scope 缺失（会改代码的任务）→ missingScope，不 ok；禁区照判', () => {
    const check = checkScopeContract({
      scope: null,
      actualChangedFiles: ['apps/web/src/a.ts', 'turbo.json'],
      workKind: WORK_KINDS.bugfix,
    })
    assert.equal(check.ok, false)
    assert.equal(check.missingScope, true)
    assert.match(check.missingScopeReason, /未给出/)
    assert.deepEqual(check.outOfScope, [])
    assert.deepEqual(check.forbiddenTouched.map((item) => item.path), ['turbo.json'])
  })

  it('零改动直接 ok（交给 assessDoneResult），即使 scope 缺失、任务是集合型', () => {
    const check = checkScopeContract({ scope: null, actualChangedFiles: [], workKind: WORK_KINDS.bugfix, taskText: '统一改为 X' })
    assert.equal(check.ok, true)
    assert.equal(check.missingScope, false)
    assert.equal(check.siblingsRequired, false)
  })

  it('实测路径 `./a` 与声明 `a` 视为同一个', () => {
    const check = checkScopeContract({
      scope: scopeOf([target('apps/web/src/a.ts')]),
      actualChangedFiles: ['./apps/web/src/a.ts', 'apps/web/src/a.ts'],
      workKind: WORK_KINDS.bugfix,
    })
    assert.equal(check.ok, true)
    assert.deepEqual(check.outOfScope, [])
  })

  it('带恶意路径的 scope 整份作废 → missingScope', () => {
    const check = checkScopeContract({
      scope: scopeOf([target('apps/web/src/a.ts'), target('../../.ssh/config')]),
      actualChangedFiles: ['apps/web/src/a.ts'],
      workKind: WORK_KINDS.bugfix,
    })
    assert.equal(check.ok, false)
    assert.equal(check.missingScope, true)
    assert.match(check.missingScopeReason, /越出仓库/)
  })
})

describe('formatScopeSection / buildScopeBlockedResult', () => {
  it('卡片段落列出目标、搜索词、纳入 / 排除理由与越界项；超过 8 项截断', () => {
    const items = Array.from({ length: 11 }, (_, index) => sibling(`apps/web/src/s${index}.ts`, false, '另一特性'))
    const scope = scopeOf([target('apps/web/src/a.ts', { symbols: ['foo'] })], [sibling('apps/web/src/b.ts', true), ...items], ['抵扣比例'])
    const check = checkScopeContract({ scope, actualChangedFiles: ['apps/web/src/a.ts', 'apps/web/src/c.ts'], workKind: WORK_KINDS.bugfix })
    const text = formatScopeSection({ scope, check })
    assert.match(text, /apps\/web\/src\/a\.ts〔foo〕：缺陷首个出错位置/)
    assert.match(text, /同因搜索词：`抵扣比例`/)
    assert.match(text, /纳入的兄弟位置（1）/)
    assert.match(text, /排除的兄弟位置（11）/)
    assert.match(text, /…另 3 项/)
    assert.match(text, /实测越界（1）：\n {2}- apps\/web\/src\/c\.ts/)
  })

  it('scope 缺失时卡片如实写未给出', () => {
    assert.match(formatScopeSection({ scope: null }), /修改范围契约：未给出/)
  })

  it('阻断文案点名越界文件、禁区、超行数并给出放行出口', () => {
    const check = checkScopeContract({
      scope: scopeOf([target('apps/web/src/a.ts')]),
      actualChangedFiles: ['apps/web/src/a.ts', 'apps/web/src/neighbor.ts', 'package.json'],
      numstat: numstatOf([[200, 0, 'apps/web/src/a.ts']]),
      workKind: WORK_KINDS.bugfix,
    })
    const text = buildScopeBlockedResult({ id: 't1', text: '名称列显示错误\n详情见截图' }, check)
    assert.match(text, /^需人工复核/)
    assert.match(text, /任务：名称列显示错误；/)
    assert.match(text, /契约外的文件：apps\/web\/src\/neighbor\.ts/)
    assert.match(text, /package\.json（依赖清单 package\.json）/)
    assert.match(text, /改动 200 行，超出缺陷修复上限 120 行/)
    assert.match(text, /回复本卡片「确认扩大范围」/)
    assert.match(text, /继续任务 t1 确认扩大范围/)
    assert.match(text, /不要改 X，只改 Y/)
    assert.match(text, /未提交、未回滚/)
  })
})

describe('人工确认扩大范围（scopeRequest → scopeApprovals）', () => {
  const blockedTask = { id: 't-scope', text: '名称列显示错误' }
  const scope = scopeOf([target('apps/web/src/a.ts')])
  const changed = ['apps/web/src/a.ts', 'apps/web/src/neighbor.ts', 'package.json']

  it('确认话术：点明扩大 / 放行 / 允许改才算；裸「确认 / 可以」与带否定的回复不算', () => {
    for (const text of ['确认扩大范围', '同意扩大范围', '确认放行', '可以改', '允许一并修改 b.ts', '批准']) assert.ok(isScopeApprovalReply(text), text)
    for (const text of ['确认', '可以', 'ok', '好的', '确认扩大范围，但 package.json 不要改', '只改 a.ts，其余撤回', '别动 neighbor']) {
      assert.equal(isScopeApprovalReply(text), false, text)
    }
  })

  it('extractRepoPaths：提取带扩展名的仓库相对路径（含 Next.js 路由与 dotfile），拒绝绝对路径与 ..', () => {
    assert.deepEqual(
      extractRepoPaths('确认扩大范围，`apps/web-next/src/app/[lang]/(dashboard)/page.tsx`、apps/web/src/b.test.ts 和 .npmrc 也可以改；/etc/hosts.json 与 ../x.ts 不算'),
      ['apps/web-next/src/app/[lang]/(dashboard)/page.tsx', 'apps/web/src/b.test.ts', '.npmrc'],
    )
    assert.deepEqual(extractRepoPaths('没有路径'), [])
  })

  it('越界 → resolveScopeGate 给出阻断文案、契约段落与待批准请求（含禁区文件）', () => {
    const gate = resolveScopeGate({ task: blockedTask, scope, actualChangedFiles: changed, workKind: WORK_KINDS.bugfix, now: '2026-10-11T00:00:00Z' })
    assert.equal(gate.check.ok, false)
    assert.match(gate.blockedText, /^需人工复核/)
    assert.match(gate.blockedText, /修改范围契约：/)
    assert.match(gate.blockedText, /实测越界（1）/)
    assert.deepEqual(gate.scopeRequest, {
      paths: ['apps/web/src/neighbor.ts', 'package.json'],
      overBudget: false,
      siblingsRequired: false,
      missingScope: false,
      requestedAt: '2026-10-11T00:00:00Z',
    })
  })

  it('放行后重跑：确认话术把被拦文件并入 scopeApprovals，同一份改动不再被拦，卡片注明人工扩大', () => {
    const first = resolveScopeGate({ task: blockedTask, scope, actualChangedFiles: changed, workKind: WORK_KINDS.bugfix })
    const approval = resolveScopeApproval({ request: first.scopeRequest, supplementText: '确认扩大范围', approvedBy: 'ou_x', at: '2026-10-11T01:00:00Z' })
    assert.deepEqual(approval.paths, ['apps/web/src/neighbor.ts', 'package.json'])
    assert.equal(approval.approvedBy, 'ou_x')
    const rerun = resolveScopeGate({ task: { ...blockedTask, scopeApprovals: [approval] }, scope, actualChangedFiles: changed, workKind: WORK_KINDS.bugfix })
    assert.equal(rerun.check.ok, true)
    assert.equal(rerun.blockedText, null)
    assert.deepEqual(rerun.check.approved, ['apps/web/src/neighbor.ts', 'package.json'])
    assert.match(rerun.section, /人工确认扩大范围（2）/)
  })

  it('批准只放行点名的文件：禁区文件不在批准里照样拦，批准外的新越界照样拦', () => {
    const approvals = [{ paths: ['apps/web/src/neighbor.ts'] }]
    const check = checkScopeContract({ scope, actualChangedFiles: [...changed, 'apps/web/src/other.ts'], workKind: WORK_KINDS.bugfix, approvals })
    assert.equal(check.ok, false)
    assert.deepEqual(check.outOfScope, ['apps/web/src/other.ts'])
    assert.deepEqual(check.forbiddenTouched.map((item) => item.path), ['package.json'])
  })

  it('回复里点名的额外文件一并放行；非确认话术不产出批准', () => {
    const request = { paths: ['apps/web/src/neighbor.ts'] }
    assert.deepEqual(
      resolveScopeApproval({ request, supplementText: '确认扩大范围，apps/web/src/extra.ts 也一起' }).paths,
      ['apps/web/src/neighbor.ts', 'apps/web/src/extra.ts'],
    )
    assert.equal(resolveScopeApproval({ request, supplementText: '不要改 neighbor，只改 a.ts' }), null)
    assert.equal(resolveScopeApproval({ request: null, supplementText: '确认扩大范围' }), null)
  })

  it('超行数 / 集合型缺兄弟清单的批准：allowOverBudget / waiveSiblings 解除对应阻断', () => {
    const numstat = numstatOf([[300, 0, 'apps/web/src/a.ts']])
    const blocked = checkScopeContract({ scope, actualChangedFiles: ['apps/web/src/a.ts'], numstat, workKind: WORK_KINDS.bugfix, taskText: '统一改为余额' })
    assert.ok(blocked.overBudget && blocked.siblingsRequired)
    const approval = resolveScopeApproval({ request: buildScopeRequest({ check: blocked, actualChangedFiles: ['apps/web/src/a.ts'] }), supplementText: '确认放行' })
    assert.deepEqual({ allowOverBudget: approval.allowOverBudget, waiveSiblings: approval.waiveSiblings }, { allowOverBudget: true, waiveSiblings: true })
    const passed = checkScopeContract({ scope, actualChangedFiles: ['apps/web/src/a.ts'], numstat, workKind: WORK_KINDS.bugfix, taskText: '统一改为余额', approvals: [approval] })
    assert.equal(passed.ok, true)
  })

  it('分析阶段没给 scope：待批准对象是全部实测改动，批准后以批准清单为契约', () => {
    const blocked = checkScopeContract({ scope: null, actualChangedFiles: ['apps/web/src/a.ts'], workKind: WORK_KINDS.bugfix })
    assert.equal(blocked.missingScope, true)
    const request = buildScopeRequest({ check: blocked, actualChangedFiles: ['apps/web/src/a.ts'] })
    assert.deepEqual(request.paths, ['apps/web/src/a.ts'])
    const approval = resolveScopeApproval({ request, supplementText: '确认扩大范围' })
    assert.deepEqual(applyScopeApprovals(null, [approval]).targets.map((item) => item.path), ['apps/web/src/a.ts'])
    assert.equal(checkScopeContract({ scope: null, actualChangedFiles: ['apps/web/src/a.ts'], workKind: WORK_KINDS.bugfix, approvals: [approval] }).ok, true)
  })

  it('实施阶段自停请求追加文件：从 blockers 提取契约外路径成为待批准请求，契约内路径不重复', () => {
    const request = scopeRequestFromBlockers({
      scope,
      blockers: ['需要同步修改 apps/web/src/detail.tsx 的同字段 label', 'apps/web/src/a.ts 已在契约内'],
      now: '2026-10-11T00:00:00Z',
    })
    assert.deepEqual(request.paths, ['apps/web/src/detail.tsx'])
    assert.equal(request.source, 'implementation')
    assert.equal(scopeRequestFromBlockers({ scope, blockers: ['缺产品口径'] }), null)
  })

  it('normalizeScopeRequest：清洗 HTTP 回写的请求形状，非法路径丢弃，空请求为 null', () => {
    assert.deepEqual(normalizeScopeRequest({ paths: ['./a.ts', '../b.ts', 7], overBudget: 'yes', source: 'x' }), {
      paths: ['a.ts'], overBudget: false, siblingsRequired: false, missingScope: false, requestedAt: null, source: 'scope_check',
    })
    assert.equal(normalizeScopeRequest({ paths: [] }), null)
    assert.equal(normalizeScopeRequest('nope'), null)
  })

  it('missingIncludedSiblings 只进 warnNotes，不阻断', () => {
    const gate = resolveScopeGate({
      task: blockedTask,
      scope: scopeOf([target('a.ts')], [sibling('b.ts', true)]),
      actualChangedFiles: ['a.ts'],
      workKind: WORK_KINDS.bugfix,
    })
    assert.equal(gate.blockedText, null)
    assert.match(gate.warnNotes[0], /疑似漏改.*b\.ts/)
  })
})

describe('resolveScopeGate 豁免目录', () => {
  it('对接文档落点下的文件不算越界、不计行数', async () => {
    const { resolveScopeGate } = await import('../lib/lark-scope-contract.mjs')
    const scope = scopeOf([{ path: 'src/a.ts', reason: 'x' }], [], ['a'])
    const gate = resolveScopeGate({ task: { text: 'fix a' }, scope, actualChangedFiles: ['src/a.ts', 'docs/delivery/pending/PM-3217-对接文档.md'], numstat: numstatOf([[3, 1, 'src/a.ts'], [700, 0, 'docs/delivery/pending/PM-3217-对接文档.md']]), workKind: 'bugfix', budgets: { bugfix: 200 }, exemptPrefixes: ['docs/delivery/pending'] })
    assert.equal(gate.blockedText, null, `应放行：${gate.blockedText}`)
  })
})
