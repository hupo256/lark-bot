import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { isOpsOwner, manualDeployText, OPS_HELP, OPS_INTENT_RE, parseOpsAction, resolveOpsCommandType } from '../lib/lark-ops-task.mjs'
import { runOpsAction, runPreExecutionGates } from '../lib/lark-ops-run.mjs'
import { resolveWorkContext } from '../lib/lark-work-context.mjs'
import { classifyCommandType } from '../lib/lark-message.mjs'
import { runSteps } from './support/steps.mjs'

// aven 2026-11-01：负责人私信下达固定运维动作，固定代码执行。11-06 起只有「部署 dev / test」（lark-ship.test 钉）；
// 「部署 pre / online」「发 pre」这类 falive 时期的部署信 / 发 MR 已删，只回一句怎么做（manual）。
const OWNER = 'ou_owner'
const config = { notifyOpenId: OWNER, allowedOpenIds: ['ou_second'] }
const ASK = 'uat 环境通过了，确认一下相同的改动是不是合到 online 上了。如果是，就运行 "部署 online" 指令，不用我确认草稿，直接发就好了。发完告诉我'
const dm = (text, sender = OWNER, chatType = 'p2p') => ({ text, senderOpenId: sender, chatType })

describe('运维指令：负责人私信下达固定动作', () => {
  it('识别、解析、摘要、部署邮件、发 MR、入口', () => runSteps([
    ['只认负责人私信：显式「运维：」或按原话推断；别人 / 群里一律不算', () => {
      assert.deepEqual(resolveOpsCommandType({ config, msg: dm(ASK), classified: classifyCommandType(ASK) }), { type: 'ops', source: 'inferred' })
      assert.deepEqual(resolveOpsCommandType({ config, msg: dm(ASK, 'ou_second'), classified: { type: null } }), { type: 'ops', source: 'inferred' })
      assert.deepEqual(resolveOpsCommandType({ config, msg: dm(ASK, 'ou_x'), classified: { type: null, source: null } }), { type: null, source: null })
      assert.deepEqual(resolveOpsCommandType({ config, msg: dm(ASK, OWNER, 'group'), classified: { type: null, source: null } }), { type: null, source: null })
      const explicit = classifyCommandType('运维：发 pre')
      assert.deepEqual(explicit, { type: 'ops', source: 'explicit' })
      assert.deepEqual(resolveOpsCommandType({ config, msg: dm('运维：发 pre'), classified: explicit }), explicit)
      assert.deepEqual(resolveOpsCommandType({ config, msg: dm('运维：发 pre', 'ou_x'), classified: explicit }), { type: null, source: null })
      const status = { type: 'status', source: 'inferred' }
      assert.equal(resolveOpsCommandType({ config, msg: dm('部署 uat'), classified: status }), status, '已判成别的类型不改')
      assert.deepEqual(resolveOpsCommandType({ config, msg: dm('这个按钮颜色不对'), classified: { type: null, source: null } }), { type: null, source: null })
      // 11-02 真机：问能不能发邮件、问清楚之类的话有「发邮件」字样但解析不出动作，不当运维（进分类器自答）
      assert.deepEqual(resolveOpsCommandType({ config, msg: dm('你能发邮件吗'), classified: { type: null, source: null } }), { type: null, source: null })
      assert.deepEqual(resolveOpsCommandType({ config, msg: dm('确认一下，现在你可以按指令发邮件吗？'), classified: { type: null, source: null } }), { type: null, source: null })
      assert.deepEqual(resolveOpsCommandType({ config, msg: dm('帮我部署 pre'), classified: { type: null, source: null } }), { type: 'ops', source: 'inferred' })
      for (const t of ['部署 online', '发 pre', '推pre', '合到 uat 了吗', '发信给运维', '发邮件']) assert.ok(OPS_INTENT_RE.test(t), t)
      for (const t of ['修一下登录页', 'preview 页面', '发布会']) assert.equal(OPS_INTENT_RE.test(t), false, t)
      assert.equal(isOpsOwner(config, ''), false)
      assert.equal(isOpsOwner({}, OWNER), false)
    }],
    ['解析动作：部署 dev / test → ship；部署 / 发信 / 发推 pre·uat·online → manual（不代办）；认不出给 null', () => {
      assert.deepEqual(parseOpsAction(ASK), { action: 'manual', env: 'online' })
      assert.deepEqual(parseOpsAction('部署 uat'), { action: 'manual', env: 'uat' })
      assert.deepEqual(parseOpsAction('运维：发信部署 pre，无需确认'), { action: 'manual', env: 'pre' })
      assert.deepEqual(parseOpsAction('发部署邮件给 online 直接发送'), { action: 'manual', env: 'online' })
      assert.deepEqual(parseOpsAction('发 pre'), { action: 'manual', env: 'pre' })
      assert.deepEqual(parseOpsAction('add commit 推 uat'), { action: 'manual', env: 'uat' })
      assert.deepEqual(parseOpsAction('部署 test PR-02463'), { action: 'ship', env: 'test', projectId: 'PR-02463' })
      assert.equal(parseOpsAction('看下 pre 怎么了'), null)
      assert.equal(parseOpsAction(''), null)
      assert.match(OPS_HELP, /^我能办的运维动作（只认你私信）：\n- 部署 dev \/ test/)
      assert.doesNotMatch(OPS_HELP, /部署邮件|uat/)
      assert.equal(manualDeployText('online'), 'online 我不代办：合完 MR 要你在 Jenkins 手动点构建，再拿版本号发邮件给 OPS。我能代办的是「部署 dev / test」。')
      assert.equal(manualDeployText('uat'), 'fameex 没有 uat 环境。我能代办的是「部署 dev / test」。')
    }],
    ['入口：非负责人不跑；认不出回帮助；pre / online 只回怎么做、不动手', async () => {
      const reports = []
      const reportStatus = async (...a) => { reports.push(a) }
      const ship = async () => assert.fail('不该跑 ship')
      assert.equal((await runOpsAction({ task: { text: '发 pre', operator: 'ou_x' }, workerConfig: { localConfig: config }, reportStatus, ship })).status, 'failed')
      assert.match(reports.at(-1)[1], /只接受负责人本人私信/)
      assert.equal((await runOpsAction({ task: { text: '看看 pre', operator: OWNER }, workerConfig: { localConfig: config }, reportStatus, ship })).status, 'done')
      assert.match(reports.at(-1)[1], /^没认出要办哪件事，没动手。\n我能办的运维动作/)
      reports.length = 0
      const audits = []
      assert.equal((await runOpsAction({ task: { text: '部署 online', operator: OWNER }, workerConfig: { localConfig: config }, reportStatus, updateAudit: (p) => audits.push(p.status), ship })).status, 'done')
      assert.deepEqual(reports.map((r) => r[0]), ['done'])
      assert.deepEqual(reports[0][5], { outcome: { kind: 'ops', summary: manualDeployText('online'), text: manualDeployText('online'), blockers: [], warnings: [] } })
      assert.deepEqual(audits, [])
    }],
    ['开工前出口与工作上下文：运维任务进业务主仓根并接管；普通任务没触发需求闸就放行', async () => {
      const task = { id: 't', text: '运维：发 pre', commandType: 'ops', commandTypeSource: 'explicit', operator: OWNER }
      const ctx = resolveWorkContext({ localConfig: { ...config, opsActions: { repo: '/r/falive' } } }, task)
      assert.equal(ctx.ops.root.length > 0, true)
      assert.notEqual(ctx.cwd, '/r/falive', '不再读 falive 的 opsActions.repo')
      assert.deepEqual({ ...ctx, cwd: null, ops: null }, { cwd: null, projectId: '(ops)', projectName: '运维指令', projectDocs: [], readOnly: false, ops: null })
      const reports = []
      assert.equal(await runPreExecutionGates({ task, workContext: { ops: { root: '/r' } }, workerConfig: { localConfig: config }, auditContext: null, executor: 'claude', reportStatus: async (s) => { reports.push(s) } }), true)
      assert.deepEqual(reports, ['done'])
      assert.equal(await runPreExecutionGates({ task: { id: 'b', text: '修复：登录页报错，复现步骤见截图', attachments: [{ type: 'image' }] }, workContext: {}, workerConfig: { localConfig: {} }, auditContext: null, executor: 'claude', reportStatus: async () => {} }), false)
      const parked = []
      assert.equal(await runPreExecutionGates({ task: { id: 't1', source: 'lark', commandType: null, text: '加个导出功能' }, workContext: {}, workerConfig: { localConfig: {} }, auditContext: null, executor: 'claude', reportStatus: async (...r) => { parked.push(r) } }), true, '裸一句话新需求停下等确认（原需求闸，挪过来行为不变）')
      assert.equal(parked[0][0], 'waiting_confirmation')
      assert.match(parked[0][1], /被判定为新需求而非缺陷反馈/)
      assert.equal(parked[0][2], 'claude')
    }],
  ]))
})
