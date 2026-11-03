#!/usr/bin/env node
/**
 * 任务性质 + 阻塞分类单测。这层决定「什么时候该停、什么时候该自己往下推」，判错的两个方向代价都很实：
 * 判松 → bot 凭一句话发明功能并写进仓库；判紧 → 每条 bug 都来问人，无人值守就没了意义。
 *
 *   node --test common/lark-bot/__tests__/lark-work-policy.test.mjs
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { eachCase } from './support/steps.mjs'
import {
  BLOCKER_CLASSES,
  WORK_KINDS,
  classifyBlocker,
  expectsCodeChange,
  hasHumanGoAhead,
  isFastLaneTask,
  requirementGate,
  requirementHasSpecContext,
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

  it('位置/命名/列增删这类自带规格的改动也走快车道（D3.1 补词表前会被兜底成 requirement 退回补 PRD）', () => {
    for (const text of [
      '把「合约跟单」重命名为「跟单合约」',
      '这个筛选项移到搜索框右边',
      '列表默认按创建时间排序',
      '把这条置顶',
      '表格加一列「结算币种」',
      '订单详情补字段：手续费',
    ]) {
      const task = larkTask({ text })
      assert.equal(resolveWorkKind(task), WORK_KINDS.bugfix, text)
      assert.equal(isFastLaneTask(task), true, text)
      assert.equal(requirementGate(task), null, text)
    }
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

  it('status / docs 命令不进快车道，也不被新需求闸拦；任务契约（11-01）优先于正文措辞：交付物不是改代码的性质由契约定', () => {
    assert.equal(resolveWorkKind(larkTask({ commandType: 'status', text: '项目状态' })), WORK_KINDS.readonly)
    assert.equal(resolveWorkKind(larkTask({ commandType: 'docs', text: '同步文档' })), WORK_KINDS.docs)
    assert.equal(requirementGate(larkTask({ commandType: 'status', text: '项目状态' })), null)
    assert.equal(requirementGate(larkTask({ commandType: 'docs', text: '同步文档' })), null)
    // 正文带缺陷措辞 + 「修复：」前缀，没契约会判 bugfix；契约说代答 / 只记一笔 / 运维 → readonly，实测 → verification，改码契约不改判
    const defect = (contract) => larkTask({ commandType: 'fix', text: '修复：导出按钮点了转圈报错', contract })
    return eachCase([
      { name: '无契约 → bugfix', contract: undefined, kind: WORK_KINDS.bugfix, code: true, gate: 'object' },
      { name: 'answer → readonly、不要代码、不拦', contract: { deliverable: 'answer', expectsCode: false }, kind: WORK_KINDS.readonly, code: false, gate: null },
      { name: 'record → readonly', contract: { deliverable: 'record', expectsCode: false }, kind: WORK_KINDS.readonly, code: false, gate: null },
      { name: 'ops → readonly', contract: { deliverable: 'ops', expectsCode: false }, kind: WORK_KINDS.readonly, code: false, gate: null },
      { name: 'verification → verification', contract: { deliverable: 'verification', expectsCode: false }, kind: WORK_KINDS.verification, code: false, gate: null },
      { name: 'change → 仍按正文判 bugfix，要代码，闸照常（bug 不拦）', contract: { deliverable: 'change', expectsCode: true }, kind: WORK_KINDS.bugfix, code: true, gate: null },
      { name: 'change 但契约说不要代码（api 只改文档）→ 以契约为准', contract: { deliverable: 'change', expectsCode: false }, kind: WORK_KINDS.bugfix, code: false, gate: null },
      { name: 'answer 却说要代码 → expectsCode 以契约布尔为准', contract: { deliverable: 'answer', expectsCode: true }, kind: WORK_KINDS.readonly, code: true, gate: null },
      { name: 'expectsCode 不是布尔 → 当没说，按性质判', contract: { deliverable: 'change', expectsCode: 'yes' }, kind: WORK_KINDS.bugfix, code: true, gate: null },
      { name: 'deliverable 空 → 当没契约', contract: { deliverable: null }, kind: WORK_KINDS.bugfix, code: true, gate: null },
    ], ({ contract, kind, code, gate }) => {
      const task = defect(contract)
      assert.equal(resolveWorkKind(task), kind)
      assert.equal(expectsCodeChange({ task }), code)
      assert.equal(expectsCodeChange({ task, readOnly: true }), false, 'readOnly 上下文一律不要代码')
      assert.equal(requirementGate(task), null)
      // 裸一句话新需求：契约 change 照拦，契约 answer 不拦（问一句「你能发邮件吗」不该停下来要 PRD）
      const bare = larkTask({ text: '加个导出功能', contract })
      if (gate === 'object' || contract?.deliverable === 'change') assert.equal(requirementGate(bare)?.status, 'waiting_confirmation')
      else if (contract?.deliverable) assert.equal(requirementGate(bare), null)
    })
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

  it('soft / decision 不构成停机，转成显式假设进 requirements（这才是「自己 MSW 推到 G5」）', async () => {
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
    // 对接答复（api_reply / api: 前缀）：对方的答复本身就是材料，首句在「再要文档 / 再确认」的 blocker 归 soft，细节里顺带的
    // token / 登录 / 测试环境不算（10-31 falive 回放：Arthur 答「完善资料部分需要前端接入」，bot 反过来要接口文档，四条全判 hard 停机）。
    // 首句本身在要账号 / 权限的仍是 hard；非对接答复的同一批 blocker 不受影响。
    const docAsks = [
      '缺「完善资料」的接口契约：要写清路径、鉴权头（`Authorization: hiApp <token>`）和响应结构',
      '缺调用时机和触发方式：是前端在 updateInfo 成功后调 task/complete，还是后端回调？',
      '缺「账户同步问题」的具体内容：要说明前端在登录或注册流程的哪一步调用什么',
      '需后端再确认：Go 是否已放开主动申报，会不会和社区回调重复发奖',
    ]
    const replyTask = larkTask({ text: '帖子回复部分已经完成，完善资料部分需要前端接入', commandType: 'api', intake: { classification: { decision: 'api_reply' } } })
    await eachCase([
      { name: 'api: 前缀 / api_reply 定的 commandType', task: replyTask, blockers: docAsks, status: 'ready', kept: [] },
      { name: '只有契约标了 api（分类器判 api_reply）', task: larkTask({ text: '完善资料部分需要前端接入', contract: { v: 1, deliverable: 'change', api: true } }), blockers: docAsks, status: 'ready', kept: [] },
      { name: '首句在要账号 / 权限：仍停', task: replyTask, blockers: ['缺测试账号：要用真实账号登录后才能验证', ...docAsks], status: 'blocked', kept: ['缺测试账号：要用真实账号登录后才能验证'] },
      { name: '首句没在要文档的读不懂 blocker：仍按 hard 停', task: replyTask, blockers: ['情况比较复杂，建议先讨论一下', ...docAsks], status: 'blocked', kept: ['情况比较复杂，建议先讨论一下'] },
      { name: '不是对接答复：原样按 hard 停', task: larkTask({ text: '完善资料部分需要前端接入', intake: { classification: { decision: 'requirement' } } }), blockers: docAsks, status: 'blocked', kept: docAsks },
    ], ({ name, task, blockers, status, kept }) => {
      const out = resolveAnalysisGate({ task, analysis: blocked(blockers) })
      assert.equal(out.analysis.status, status, name)
      assert.deepEqual(out.analysis.blockers, kept, name)
      if (status === 'ready') assert.equal(out.assumptions.length, docAsks.length, name)
    })
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
  it('裸一句话新需求（无附件、无上下文）首次执行前被拦下，给出可操作的续跑指令', () => {
    const task = larkTask({ text: '加个导出功能' })
    const gate = requirementGate(task)
    assert.equal(gate.status, 'waiting_confirmation')
    assert.equal(gate.workKind, WORK_KINDS.requirement)
    assert.ok(gate.blockers.length >= 2)
    assert.match(gate.nextStep, /继续任务 t1/)
  })

  it('混合兜底：带可自评上下文的新需求不再盲拦，放行到 AI 自评（少烦人）', () => {
    // 正文已带细节（≥ 阈值）→ 放行
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

  it('requirementHasSpecContext：裸一句话无料，附件或长正文才算有料', () => {
    assert.equal(requirementHasSpecContext(larkTask({ text: '加个导出功能' })), false)
    assert.equal(requirementHasSpecContext(larkTask({ text: '加个导出功能', attachments: [{ type: 'image' }] })), true)
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
