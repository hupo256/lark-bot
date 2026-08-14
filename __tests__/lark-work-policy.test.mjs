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
  requirementGate,
  resolveAnalysisGate,
  resolveWorkKind,
} from '../lib/lark-work-policy.mjs'

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
  it('缺陷信号 → bugfix；快车道成立', () => {
    const task = larkTask({ text: '导出按钮点了没反应' })
    assert.equal(resolveWorkKind(task), WORK_KINDS.bugfix)
    assert.equal(isFastLaneTask(task), true)
  })

  it('交办新功能 → requirement；不进快车道', () => {
    for (const text of ['加个导出功能', '新增一个数据看板页面', '这块要支持批量审批能力', '新需求：订单列表加筛选']) {
      const task = larkTask({ text })
      assert.equal(resolveWorkKind(task), WORK_KINDS.requirement, text)
      assert.equal(isFastLaneTask(task), false, text)
    }
  })

  it('「改成 X」这类已说清的增量仍是快车道，不被误当新需求拦下', () => {
    const task = larkTask({ text: '标题颜色改成 #1F2329' })
    assert.equal(resolveWorkKind(task), WORK_KINDS.bugfix)
    assert.equal(isFastLaneTask(task), true)
  })

  it('bug 表来源恒为 QA 反馈，不看正文措辞（QA 单里写「新增校验」也不该被拦）', () => {
    const task = { id: 'rec1', source: 'lark-bugtable', commandType: 'fix', text: '需要新增一个校验功能' }
    assert.equal(resolveWorkKind(task), WORK_KINDS.qaFeedback)
    assert.equal(isFastLaneTask(task), true)
  })

  it('@负责人 消息的 AI 前置分类结论优先于正则（它已经花钱判过一次）', () => {
    const asRequirement = larkTask({ text: '这里点了没反应，顺便把导出做出来', intake: { classification: { decision: 'requirement' } } })
    assert.equal(resolveWorkKind(asRequirement), WORK_KINDS.requirement)
    const asBug = larkTask({ text: '订单页要支持导出能力', intake: { classification: { decision: 'bug' } } })
    assert.equal(resolveWorkKind(asBug), WORK_KINDS.bugfix)
  })

  it('自带规格的改动越过 requirement 误判：intake 判 requirement 但「改成 X」是确定性增量，仍走快车道、不被闸拦（PR-01947 回归）', () => {
    const task = larkTask({
      text: '这里改成 合约跟单配置(个人)',
      intake: { classification: { decision: 'requirement', confidence: 'medium' } },
      attachments: [{ type: 'image' }],
    })
    assert.equal(resolveWorkKind(task), WORK_KINDS.bugfix)
    assert.equal(isFastLaneTask(task), true)
    assert.equal(requirementGate(task), null)
  })

  it('但「改成 X 并新增导出功能」这类夹带创造信号的，仍回落 requirement（不放过真新需求）', () => {
    const task = larkTask({ text: '把标题改成 X，并新增导出功能', intake: { classification: { decision: 'requirement' } } })
    assert.equal(resolveWorkKind(task), WORK_KINDS.requirement)
  })

  it('只截图无措辞 → bugfix；既无信号也无附件 → 兜底 requirement（宁可多问一句）', () => {
    assert.equal(resolveWorkKind(larkTask({ text: '看下', attachments: [{ type: 'image' }] })), WORK_KINDS.bugfix)
    assert.equal(resolveWorkKind(larkTask({ text: '看下这个' })), WORK_KINDS.requirement)
  })

  it('status / docs 命令不进快车道，也不被新需求闸拦', () => {
    assert.equal(resolveWorkKind(larkTask({ commandType: 'status', text: '项目状态' })), WORK_KINDS.readonly)
    assert.equal(resolveWorkKind(larkTask({ commandType: 'docs', text: '同步文档' })), WORK_KINDS.docs)
    assert.equal(requirementGate(larkTask({ commandType: 'status', text: '项目状态' })), null)
    assert.equal(requirementGate(larkTask({ commandType: 'docs', text: '同步文档' })), null)
  })

  it('非白名单来源不扩权也不被新需求闸拦（它不是群里的一句话）', () => {
    const external = { id: 'x', source: 'manual-api', commandType: 'qa', text: '修一下报错' }
    assert.equal(isFastLaneTask(external), false)
    assert.equal(requirementGate(external), null)
  })
})

describe('classifyBlocker', () => {
  it('四类各自可判', () => {
    assert.equal(classifyBlocker('消息无法定位目标页面：现货和合约页均有同名控件，需要确认修改范围'), BLOCKER_CLASSES.hard)
    assert.equal(classifyBlocker('缺少测试环境登录账号，无法复现'), BLOCKER_CLASSES.hard)
    assert.equal(classifyBlocker('订单详情接口字段尚未确定，后端未提供 schema'), BLOCKER_CLASSES.soft)
    assert.equal(classifyBlocker('空态有两种实现方案，需要产品确认用哪个'), BLOCKER_CLASSES.decision)
    assert.equal(classifyBlocker('当前项目缺少 G2、README 和技术方案，当前不能依规进入实施'), BLOCKER_CLASSES.process)
  })

  it('读不懂的 blocker 按 hard 处理（fail-closed，而非旧实现的默认放行）', () => {
    assert.equal(classifyBlocker('情况比较复杂，建议先讨论一下'), BLOCKER_CLASSES.hard)
    assert.equal(classifyBlocker(''), BLOCKER_CLASSES.hard)
  })

  it('hard 优先于 process：一条同时提到范围不清与缺 PRD 的 blocker 必须停', () => {
    assert.equal(classifyBlocker('缺少 PRD，且无法定位要改哪个页面'), BLOCKER_CLASSES.hard)
  })
})

describe('resolveAnalysisGate', () => {
  const g2Blocked = blocked(['当前项目缺少 G2、README 和技术方案，当前不能依规进入实施'])

  it('bug / QA 反馈：纯流程材料阻塞放行，且原判断被记录为 suppressed', () => {
    for (const task of [larkTask({ text: '导出点了没反应' }), { id: 'r', source: 'lark-bugtable', commandType: 'qa', text: '错误态不对' }]) {
      const gate = resolveAnalysisGate({ task, analysis: g2Blocked })
      assert.equal(gate.analysis.status, 'ready')
      assert.deepEqual(gate.analysis.blockers, [])
      assert.equal(gate.suppressed.length, 1)
      assert.match(gate.analysis.summary, /无硬阻塞/)
    }
  })

  it('新需求：同样的流程材料阻塞必须保留（缺 PRD 对新需求是真缺）', () => {
    const gate = resolveAnalysisGate({ task: larkTask({ text: '加个导出功能' }), analysis: g2Blocked })
    assert.equal(gate.analysis.status, 'blocked')
    assert.deepEqual(gate.analysis.blockers, g2Blocked.blockers)
    assert.deepEqual(gate.suppressed, [])
  })

  it('范围歧义在任何 workKind 下都停（旧行为保持）', () => {
    const ambiguous = blocked(['消息无法定位目标页面：现货和合约页均有同名控件，需要确认修改范围'])
    const gate = resolveAnalysisGate({ task: larkTask({ text: '按钮点了没反应' }), analysis: ambiguous })
    assert.equal(gate.analysis.status, 'blocked')
    assert.deepEqual(gate.analysis.blockers, ambiguous.blockers)
  })

  it('soft / decision 不构成停机，转成显式假设进 requirements（这才是「自己 MSW 推到 G5」）', () => {
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

  it('有 hard 时只带走 hard，soft / decision 不混进群卡（免得人以为要先去催接口）', () => {
    const gate = resolveAnalysisGate({
      task: larkTask({ text: '点了没反应' }),
      analysis: blocked([
        '缺少测试环境登录账号，无法复现',
        '订单详情接口字段尚未确定',
        '当前项目缺少 G2',
      ]),
    })
    assert.equal(gate.analysis.status, 'blocked')
    assert.deepEqual(gate.analysis.blockers, ['缺少测试环境登录账号，无法复现'])
  })

  it('非 blocked 结论原样透传，不做任何加工', () => {
    const ready = { status: 'ready', summary: 'ok', requirements: [] }
    const gate = resolveAnalysisGate({ task: larkTask({ text: '点了没反应' }), analysis: ready })
    assert.equal(gate.analysis, ready)
    assert.equal(gate.changed, false)
  })

  it('非白名单来源不享受任何压制（旧「不扩权」口径保持）', () => {
    const gate = resolveAnalysisGate({ task: { source: 'manual-api', commandType: 'qa', text: '修报错' }, analysis: g2Blocked })
    assert.equal(gate.analysis.status, 'blocked')
    assert.deepEqual(gate.analysis.blockers, g2Blocked.blockers)
  })
})

describe('requirementGate', () => {
  it('新需求首次执行前被拦下，给出可操作的续跑指令', () => {
    const task = larkTask({ text: '加个导出功能' })
    const gate = requirementGate(task)
    assert.equal(gate.status, 'waiting_confirmation')
    assert.equal(gate.workKind, WORK_KINDS.requirement)
    assert.ok(gate.blockers.length >= 2)
    assert.match(gate.nextStep, /继续任务 t1/)
  })

  it('人补过料（resumeWithSupplement 后 resumeCount/waitingHistory 有值）即视为放行，不再重复拦', () => {
    assert.equal(hasHumanGoAhead(larkTask({ text: '加个导出功能' })), false)
    assert.equal(requirementGate(larkTask({ text: '加个导出功能', resumeCount: 1 })), null)
    assert.equal(requirementGate(larkTask({ text: '加个导出功能', waitingHistory: [{ at: 'x' }] })), null)
  })

  it('缺陷反馈不被拦（无人值守的主路径必须一路跑完）', () => {
    assert.equal(requirementGate(larkTask({ text: '导出按钮点了转圈' })), null)
    assert.equal(requirementGate({ id: 'r', source: 'lark-bugtable', commandType: 'fix', text: '错误态不对' }), null)
  })
})
