#!/usr/bin/env node
/**
 * 任务性质 + 阻塞分类单测。这层决定「什么时候该停、什么时候该自己往下推」，判错的两个方向代价都很实：
 * 判松 → bot 凭一句话发明功能并写进仓库；判紧 → 每条 bug 都来问人，无人值守就没了意义。
 *
 *   node --test common/lark-bot/__tests__/lark-work-policy.test.mjs
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  BLOCKER_CLASSES,
  WORK_KINDS,
  classifyBlocker,
  hasHumanGoAhead,
  isFastLaneTask,
  isPrincipalAssigned,
  requirementGate,
  requirementHasSpecContext,
  resolveAnalysisGate,
  resolveTaskPolicy,
  resolveWorkKind,
} from '../lib/lark-work-policy.mjs'

// 合并用例的分段：失败时把原用例标题拼到报错最前面，仍能看出是哪一条（异步段要 await）。
const step = (name, fn) => {
  const tag = (error) => {
    if (error instanceof Error) {
      error.message = `[${name}] ${error.message}`
      error.stack = `[${name}] ${error.stack}`
    }
    throw error
  }
  try {
    const out = fn()
    return typeof out?.then === 'function' ? out.catch(tag) : out
  } catch (error) {
    return tag(error)
  }
}

const larkTask = (extra) => ({ id: 't1', source: 'lark', commandType: null, text: '', ...extra })
const blocked = (blockers, extra = {}) => ({
  status: 'blocked',
  summary: '第一阶段结论',
  applicableRules: [],
  requirements: [],
  blockers,
  ...extra,
})

describe('resolveWorkKind', () => {
  // 每行：name 保留原用例标题；kind 必断言；fastLane / gateNull 有值时才断言。
  const kindCases = [
    { name: '缺陷信号 → bugfix；快车道成立', task: larkTask({ text: '导出按钮点了没反应' }), kind: WORK_KINDS.bugfix, fastLane: true },
    ...['加个导出功能', '新增一个数据看板页面', '这块要支持批量审批能力', '新需求：订单列表加筛选'].map((text) => ({
      name: `交办新功能 → requirement；不进快车道：${text}`, task: larkTask({ text }), kind: WORK_KINDS.requirement, fastLane: false,
    })),
    { name: '「改成 X」这类已说清的增量仍是快车道，不被误当新需求拦下', task: larkTask({ text: '标题颜色改成 #1F2329' }), kind: WORK_KINDS.bugfix, fastLane: true },
    ...[
      '把「合约跟单」重命名为「跟单合约」',
      '这个筛选项移到搜索框右边',
      '列表默认按创建时间排序',
      '把这条置顶',
      '表格加一列「结算币种」',
      '订单详情补字段：手续费',
    ].map((text) => ({
      name: `位置/命名/列增删这类自带规格的改动也走快车道（D3.1 补词表前会被兜底成 requirement 退回补 PRD）：${text}`,
      task: larkTask({ text }), kind: WORK_KINDS.bugfix, fastLane: true, gateNull: true,
    })),
    {
      name: 'bug 表来源恒为 QA 反馈，不看正文措辞（QA 单里写「新增校验」也不该被拦）',
      task: { id: 'rec1', source: 'lark-bugtable', commandType: 'fix', text: '需要新增一个校验功能' }, kind: WORK_KINDS.qaFeedback, fastLane: true,
    },
    {
      name: '@负责人 消息的 AI 前置分类结论优先于正则（它已经花钱判过一次）：判 requirement',
      task: larkTask({ text: '这里点了没反应，顺便把导出做出来', intake: { classification: { decision: 'requirement' } } }), kind: WORK_KINDS.requirement,
    },
    {
      name: '@负责人 消息的 AI 前置分类结论优先于正则（它已经花钱判过一次）：判 bug',
      task: larkTask({ text: '订单页要支持导出能力', intake: { classification: { decision: 'bug' } } }), kind: WORK_KINDS.bugfix,
    },
    {
      name: '自带规格的改动越过 requirement 误判：intake 判 requirement 但「改成 X」是确定性增量，仍走快车道、不被闸拦（PR-01947 回归）',
      task: larkTask({
        text: '这里改成 合约跟单配置(个人)',
        intake: { classification: { decision: 'requirement', confidence: 'medium' } },
        attachments: [{ type: 'image' }],
      }),
      kind: WORK_KINDS.bugfix, fastLane: true, gateNull: true,
    },
    {
      name: '但「改成 X 并新增导出功能」这类夹带创造信号的，仍回落 requirement（不放过真新需求）',
      task: larkTask({ text: '把标题改成 X，并新增导出功能', intake: { classification: { decision: 'requirement' } } }), kind: WORK_KINDS.requirement,
    },
    { name: '只截图无措辞 → bugfix', task: larkTask({ text: '看下', attachments: [{ type: 'image' }] }), kind: WORK_KINDS.bugfix },
    { name: '既无信号也无附件 → 兜底 requirement（宁可多问一句）', task: larkTask({ text: '看下这个' }), kind: WORK_KINDS.requirement },
  ]

  it('性质判定用例表：缺陷 / 自带规格增量 / 截图 / bug 表 / intake 前置分类 / 兜底 requirement', () => {
    for (const { name, task, kind, fastLane, gateNull } of kindCases) {
      assert.equal(resolveWorkKind(task), kind, name)
      if (fastLane !== undefined) assert.equal(isFastLaneTask(task), fastLane, name)
      if (gateNull) assert.equal(requirementGate(task), null, name)
    }
  })

  it('status / docs 命令不进快车道，也不被新需求闸拦；非白名单来源不扩权也不被新需求闸拦（它不是群里的一句话）', () => {
    step('status / docs 命令不进快车道，也不被新需求闸拦', () => {
      assert.equal(resolveWorkKind(larkTask({ commandType: 'status', text: '项目状态' })), WORK_KINDS.readonly)
      assert.equal(resolveWorkKind(larkTask({ commandType: 'docs', text: '同步文档' })), WORK_KINDS.docs)
      assert.equal(requirementGate(larkTask({ commandType: 'status', text: '项目状态' })), null)
      assert.equal(requirementGate(larkTask({ commandType: 'docs', text: '同步文档' })), null)
    })
    step('非白名单来源不扩权也不被新需求闸拦（它不是群里的一句话）', () => {
      const external = { id: 'x', source: 'manual-api', commandType: 'qa', text: '修一下报错' }
      assert.equal(isFastLaneTask(external), false, '非白名单来源不扩权')
      assert.equal(requirementGate(external), null, '非白名单来源不被新需求闸拦')
    })
  })

  // 10-23 #78：仓库任务带了对接文档，网关补成 api，旧口径 api 一律 bugfix，新需求被套缺陷修复的行数上限。
  const repoTask = (extra) => larkTask({ repo: 'falive', addressedToBot: true, commandType: 'api', commandTypeSource: 'explicit',
    contract: { v: 1, deliverable: 'doc_intake', source: 'attachment', expectsCode: true }, attachments: [{ type: 'file', fileName: 'PM-2954-App对接文档.md' }], ...extra })
  it('仓库任务 api 命令与自带规格判定（#78）：分类器结论定性质、显式 api 前缀与默认仓照旧 bugfix、只看本条原话', () => {
    const migrate = repoTask({ text: '社区还有 发帖、评论 两个功能没有从 x9 项目迁移过来。现在要完成这两个功能的迁移，api 已经 ready 了，如上。', intake: { classification: { decision: 'requirement' } } })
    assert.equal(resolveWorkKind(migrate), WORK_KINDS.requirement, '仓库任务：网关因对接文档补的 api 不决定性质，分类器判 requirement 就是新需求（#78）')
    assert.equal(isFastLaneTask(migrate), false, '仓库任务：网关因对接文档补的 api 不决定性质，分类器判 requirement 就是新需求（#78）')

    const keepBugfix = '仓库任务：bug / 对接答复带文档仍是 bugfix；原话写了「api：」前缀照旧按显式命令（#78 不放宽缺陷）'
    assert.equal(resolveWorkKind(repoTask({ text: '发帖按钮点了没反应', intake: { classification: { decision: 'bug' } } })), WORK_KINDS.bugfix, keepBugfix)
    assert.equal(resolveWorkKind(repoTask({ text: 'intro 接口上线了，按文档接上', intake: { classification: { decision: 'api_reply' } } })), WORK_KINDS.bugfix, keepBugfix)
    assert.equal(resolveWorkKind(repoTask({ text: '@Aven.Bot api：按文档把评论接上', intake: { classification: { decision: 'requirement' } } })), WORK_KINDS.bugfix, keepBugfix)

    const defaultRepo = larkTask({ commandType: 'api', text: 'api：接口文档更新了', intake: { classification: { decision: 'requirement' } } })
    assert.equal(resolveWorkKind(defaultRepo), WORK_KINDS.bugfix, '默认仓（无契约）的 api 命令照旧 bugfix，不受 #78 影响')

    const ownText = '仓库任务：「自带规格改动」只看本条原话，话题回复 / 群里之前的消息里的「调整 / 改成」不把新需求翻成缺陷（#78）'
    const contract = { v: 1, deliverable: 'change', source: 'classifier', expectsCode: true }
    const fromContext = larkTask({ repo: 'falive', contract, intake: { classification: { decision: 'requirement' } },
      text: '【本条 @】把 x9 的评论迁过来\n\n【话题其它回复】\nKevin：顺便把标题改成 16px' })
    assert.equal(resolveWorkKind(fromContext), WORK_KINDS.requirement, ownText)
    const own = larkTask({ repo: 'falive', contract, intake: { classification: { decision: 'requirement' } }, text: '【本条 @】标题改成 16px\n\n【话题其它回复】\nKevin：好的' })
    assert.equal(resolveWorkKind(own), WORK_KINDS.bugfix, ownText)
  })
})

describe('classifyBlocker', () => {
  it('四类各自可判；读不懂的按 hard 处理（fail-closed）；hard 优先于 process', () => {
    step('四类各自可判', () => {
      assert.equal(classifyBlocker('消息无法定位目标页面：现货和合约页均有同名控件，需要确认修改范围'), BLOCKER_CLASSES.hard)
      assert.equal(classifyBlocker('缺少测试环境登录账号，无法复现'), BLOCKER_CLASSES.hard)
      assert.equal(classifyBlocker('订单详情接口字段尚未确定，后端未提供 schema'), BLOCKER_CLASSES.soft)
      assert.equal(classifyBlocker('空态有两种实现方案，需要产品确认用哪个'), BLOCKER_CLASSES.decision)
      assert.equal(classifyBlocker('当前项目缺少 G2、README 和技术方案，当前不能依规进入实施'), BLOCKER_CLASSES.process)
    })
    step('读不懂的 blocker 按 hard 处理（fail-closed，而非旧实现的默认放行）', () => {
      assert.equal(classifyBlocker('情况比较复杂，建议先讨论一下'), BLOCKER_CLASSES.hard)
      assert.equal(classifyBlocker(''), BLOCKER_CLASSES.hard)
    })
    step('hard 优先于 process：一条同时提到范围不清与缺 PRD 的 blocker 必须停', () => {
      assert.equal(classifyBlocker('缺少 PRD，且无法定位要改哪个页面'), BLOCKER_CLASSES.hard)
    })
  })
})

describe('resolveAnalysisGate', () => {
  const g2Blocked = blocked(['当前项目缺少 G2、README 和技术方案，当前不能依规进入实施'])

  it('流程材料阻塞按性质取舍：bug / QA 放行并记 suppressed，新需求与非白名单来源保留，范围歧义任何 workKind 都停', () => {
    for (const task of [larkTask({ text: '导出点了没反应' }), { id: 'r', source: 'lark-bugtable', commandType: 'qa', text: '错误态不对' }]) {
      const gate = resolveAnalysisGate({ task, analysis: g2Blocked })
      const name = 'bug / QA 反馈：纯流程材料阻塞放行，且原判断被记录为 suppressed'
      assert.equal(gate.analysis.status, 'ready', name)
      assert.deepEqual(gate.analysis.blockers, [], name)
      assert.equal(gate.suppressed.length, 1, name)
      assert.match(gate.analysis.summary, /无硬阻塞/, name)
    }

    const requirement = resolveAnalysisGate({ task: larkTask({ text: '加个导出功能' }), analysis: g2Blocked })
    const requirementName = '新需求：同样的流程材料阻塞必须保留（缺 PRD 对新需求是真缺）'
    assert.equal(requirement.analysis.status, 'blocked', requirementName)
    assert.deepEqual(requirement.analysis.blockers, g2Blocked.blockers, requirementName)
    assert.deepEqual(requirement.suppressed, [], requirementName)

    const ambiguous = blocked(['消息无法定位目标页面：现货和合约页均有同名控件，需要确认修改范围'])
    const ambiguousGate = resolveAnalysisGate({ task: larkTask({ text: '按钮点了没反应' }), analysis: ambiguous })
    assert.equal(ambiguousGate.analysis.status, 'blocked', '范围歧义在任何 workKind 下都停（旧行为保持）')
    assert.deepEqual(ambiguousGate.analysis.blockers, ambiguous.blockers, '范围歧义在任何 workKind 下都停（旧行为保持）')

    const external = resolveAnalysisGate({ task: { source: 'manual-api', commandType: 'qa', text: '修报错' }, analysis: g2Blocked })
    assert.equal(external.analysis.status, 'blocked', '非白名单来源不享受任何压制（旧「不扩权」口径保持）')
    assert.deepEqual(external.analysis.blockers, g2Blocked.blockers, '非白名单来源不享受任何压制（旧「不扩权」口径保持）')
  })

  it('soft / decision 转成显式假设进 requirements（自己 MSW 推到 G5）；有 hard 时只带走 hard；非 blocked 原样透传', () => {
    step('soft / decision 不构成停机，转成显式假设进 requirements（这才是「自己 MSW 推到 G5」）', () => {
      const gate = resolveAnalysisGate({
        task: larkTask({ text: '列表加载失败时没提示' }),
        analysis: blocked([
          '订单详情接口字段尚未确定，后端未提供 schema',
          '空态有两种实现方案，需要产品确认用哪个',
        ]),
      })
      assert.equal(gate.analysis.status, 'ready')
      assert.deepEqual(gate.analysis.blockers, [])
      assert.equal(gate.assumptions.length, 2)
      assert.match(gate.assumptions[0], /Mock 假设推进/)
      assert.match(gate.assumptions[1], /写清选择与理由/)
      // 假设必须真的下发给实施阶段，否则等于没记录。
      for (const item of gate.assumptions) assert.ok(gate.analysis.requirements.includes(item))
      assert.deepEqual(gate.analysis.assumptions, gate.assumptions)
    })

    step('有 hard 时只带走 hard，soft / decision 不混进群卡（免得人以为要先去催接口）', () => {
      const hardGate = resolveAnalysisGate({
        task: larkTask({ text: '点了没反应' }),
        analysis: blocked([
          '缺少测试环境登录账号，无法复现',
          '订单详情接口字段尚未确定',
          '当前项目缺少 G2',
        ]),
      })
      assert.equal(hardGate.analysis.status, 'blocked')
      assert.deepEqual(hardGate.analysis.blockers, ['缺少测试环境登录账号，无法复现'])
    })

    step('非 blocked 结论原样透传，不做任何加工', () => {
      const ready = { status: 'ready', summary: 'ok', requirements: [] }
      const readyGate = resolveAnalysisGate({ task: larkTask({ text: '点了没反应' }), analysis: ready })
      assert.equal(readyGate.analysis, ready)
      assert.equal(readyGate.changed, false)
    })
  })
})

describe('requirementGate', () => {
  it('裸一句话新需求首次执行前被拦下给续跑指令；带可自评上下文（长正文 / 附件）放行到 AI 自评；缺陷反馈不被拦', () => {
    step('裸一句话新需求（无附件、无上下文）首次执行前被拦下，给出可操作的续跑指令', () => {
      const task = larkTask({ text: '加个导出功能' })
      const gate = requirementGate(task)
      assert.equal(gate.status, 'waiting_confirmation')
      assert.equal(gate.workKind, WORK_KINDS.requirement)
      assert.ok(gate.blockers.length >= 2)
      assert.match(gate.nextStep, /继续任务 t1/)
    })

    step('混合兜底：带可自评上下文的新需求不再盲拦，放行到 AI 自评（少烦人）', () => {
      // 混合兜底：正文已带细节（≥ 阈值）→ 放行
      const detailed = larkTask({ text: '新增一个数据看板页面，展示当日成交量、活跃用户和留存曲线' })
      assert.equal(resolveWorkKind(detailed), WORK_KINDS.requirement)
      assert.equal(requirementHasSpecContext(detailed), true)
      assert.equal(requirementGate(detailed), null)
      // 带附件（设计稿 / 截图即规格）→ 放行；用 intake 锁定为 requirement，绕过「有图即 bug」的兜底
      const withAttachment = larkTask({
        text: '做个新的对账页面',
        intake: { classification: { decision: 'requirement' } },
        attachments: [{ type: 'image' }],
      })
      assert.equal(resolveWorkKind(withAttachment), WORK_KINDS.requirement)
      assert.equal(requirementHasSpecContext(withAttachment), true)
      assert.equal(requirementGate(withAttachment), null)
    })

    step('requirementHasSpecContext：裸一句话无料，附件或长正文才算有料', () => {
      assert.equal(requirementHasSpecContext(larkTask({ text: '加个导出功能' })), false)
      assert.equal(requirementHasSpecContext(larkTask({ text: '加个导出功能', attachments: [{ type: 'image' }] })), true)
    })

    step('缺陷反馈不被拦（无人值守的主路径必须一路跑完）', () => {
      assert.equal(requirementGate(larkTask({ text: '导出按钮点了转圈' })), null)
      assert.equal(requirementGate({ id: 'r', source: 'lark-bugtable', commandType: 'fix', text: '错误态不对' }), null)
    })
  })

  // aven 2026-10-23 亲自确认：我本人交办的任务不设行数上限、不因缺 PRD / 设计稿阻塞（#78）。
  it('人的放行：补过料（resumeCount / waitingHistory）不再重复拦；负责人本人交办的仓库任务视为已放行、免流程阻塞，别人发起的照旧要放行', () => {
    step('人补过料（resumeWithSupplement 后 resumeCount/waitingHistory 有值）即视为放行，不再重复拦', () => {
      assert.equal(hasHumanGoAhead(larkTask({ text: '加个导出功能' })), false)
      assert.equal(requirementGate(larkTask({ text: '加个导出功能', resumeCount: 1 })), null)
      assert.equal(requirementGate(larkTask({ text: '加个导出功能', waitingHistory: [{ at: 'x' }] })), null)
    })

    step('负责人本人交办的仓库任务：视为已放行、免流程阻塞；别人发起的新需求照旧要放行', () => {
      const contract = { v: 1, deliverable: 'change', source: 'classifier', expectsCode: true }
      const requirement = { intake: { classification: { decision: 'requirement' } }, text: '把 x9 的发帖、评论迁过来' }
      const mine = larkTask({ repo: 'falive', contract, fromPrincipal: true, ...requirement })
      const viaPrivate = larkTask({ repo: 'falive', contract, privateOrigin: { anchorHead: 'x' }, ...requirement })
      const others = larkTask({ repo: 'falive', contract, ...requirement })
      assert.equal(isPrincipalAssigned(mine), true)
      assert.equal(isPrincipalAssigned(viaPrivate), true)
      assert.equal(isPrincipalAssigned(others), false)
      assert.equal(isPrincipalAssigned(larkTask({ fromPrincipal: true, ...requirement })), false, '默认仓（无契约）不受影响')
      assert.equal(hasHumanGoAhead(mine), true)
      assert.equal(requirementGate(mine), null, '缺设计稿也不拦')
      assert.equal(resolveTaskPolicy(mine).suppressProcessBlockers, true)
      assert.equal(hasHumanGoAhead(others), false)
      assert.equal(resolveTaskPolicy(others).suppressProcessBlockers, false)
    })
  })
})
