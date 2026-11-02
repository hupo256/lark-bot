import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { composeDeploySummary, isOpsOwner, OPS_HELP, OPS_INTENT_RE, parseOpsAction, resolveOpsCommandType } from '../lib/lark-ops-task.mjs'
import { runDeployAction, runMrAction, runOpsAction, runPreExecutionGates } from '../lib/lark-ops-run.mjs'
import { resolveWorkContext } from '../lib/lark-work-context.mjs'
import { classifyCommandType } from '../lib/lark-message.mjs'
import { runSteps } from './support/steps.mjs'

// aven 2026-11-01：负责人私信下达固定运维动作（部署邮件 / 发 MR），固定命令执行、不跑模型
const OWNER = 'ou_owner'
const config = { notifyOpenId: OWNER, allowedOpenIds: ['ou_second'], opsActions: { repo: '/r/falive', deployMail: '/m/deploy_mail.py', devBranch: 'feature/phase-6-ol' } }
const ASK = 'uat 环境通过了，确认一下相同的改动是不是合到 online 上了。如果是，就运行 "部署 online" 指令，不用我确认草稿，直接发就好了。发完告诉我'
const dm = (text, sender = OWNER, chatType = 'p2p') => ({ text, senderOpenId: sender, chatType })
const INFO = { sha: 'c1a40982aaaa', baseline: 'c0ff289dbbbb', baselineFrom: 'online 站点已部署', commits: ['88bdfb9b docs(task-center): 记录', '0bc2ab80 test(task-center): 覆盖', '73725b5a fix(task-center): 评论成功后申报新手和每日任务'], job: { id: 17996, status: 'success' } }
const DRAFT = { draft_id: 'D1', subject: '【20261101】…【OL环境】 评论成功后申报新手和每日任务', jobid: '17996', sha: 'c1a40982aaaa', to: ['sysops@x', 'dev@y'] }

// 假命令执行器：按命令前缀给结果，记下调用
const fakeRun = (table) => {
  const calls = []
  const run = (cmd, args) => {
    calls.push([cmd, ...args])
    const key = Object.keys(table).find((k) => [cmd, ...args].join(' ').includes(k))
    return key ? table[key] : { status: 0, stdout: '', stderr: '' }
  }
  return { run, calls }
}
const ok = (stdout) => ({ status: 0, stdout, stderr: '' })

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
    ['解析动作：部署（直接发 / 先查合没合）、发 MR；认不出给 null', () => {
      assert.deepEqual(parseOpsAction(ASK), { action: 'deploy', env: 'online', autoSend: true, mergedFrom: 'uat' })
      assert.deepEqual(parseOpsAction('部署 uat'), { action: 'deploy', env: 'uat', autoSend: false })
      assert.deepEqual(parseOpsAction('运维：发信部署 pre，无需确认'), { action: 'deploy', env: 'pre', autoSend: true })
      assert.deepEqual(parseOpsAction('发部署邮件给 online 直接发送'), { action: 'deploy', env: 'online', autoSend: true })
      assert.deepEqual(parseOpsAction('online 测好了，部署 online'), { action: 'deploy', env: 'online', autoSend: false }, '没问合没合就不查')
      assert.deepEqual(parseOpsAction('合到 online 的话部署 online'), { action: 'deploy', env: 'online', autoSend: false }, '没说从哪个环境来就不查')
      assert.deepEqual(parseOpsAction('发 pre'), { action: 'mr', env: 'pre' })
      assert.deepEqual(parseOpsAction('add commit 推 uat'), { action: 'mr', env: 'uat' })
      assert.equal(parseOpsAction('看下 pre 怎么了'), null)
      assert.equal(parseOpsAction(''), null)
      assert.match(OPS_HELP, /^我能办的运维动作（只认你私信）：\n- 部署 pre/)
    }],
    ['摘要：去掉 docs / test / chore / bot / Merge，去类型前缀与「——」后半，去重；只有杂项给固定说法', () => {
      assert.deepEqual(composeDeploySummary(INFO.commits), { subjectSummary: '评论成功后申报新手和每日任务', update: '评论成功后申报新手和每日任务；其余为文档、测试与 CI 调整。', items: ['评论成功后申报新手和每日任务'] })
      const many = composeDeploySummary(['aaaaaa1 fix(a): 一——细节', 'bbbbbb2 feat: 二', 'cccccc3 fix(c): 三', 'dddddd4 fix(d): 四', 'eeeeee5 fix(e): 一——又一次', `ffffff6 fix: ${'长'.repeat(40)}`])
      assert.equal(many.subjectSummary, '一、二、三 等')
      assert.equal(many.update, `一；二；三；四；${'长'.repeat(40)}。`)
      assert.equal(composeDeploySummary([`aaaaaa1 fix: ${'长'.repeat(40)}`]).subjectSummary, `${'长'.repeat(30)}…`)
      assert.equal(composeDeploySummary([`aaaaaa1 fix: ${'整'.repeat(30)}`]).subjectSummary, '整'.repeat(30), '正好 30 字不截')
      assert.equal(composeDeploySummary(['aaaaaa1 fix: 一', 'bbbbbb2 fix: 二', 'cccccc3 fix: 三']).subjectSummary, '一、二、三', '正好 3 条不加「等」')
      assert.deepEqual(composeDeploySummary(['aaaaaa1 docs: x', 'bbbbbb2 feat(bot): y', 'cccccc3 Merge branch x', 'dddddd4 chore(ci): z']), { subjectSummary: '文档与测试调整', update: '本次只有文档、测试与 CI 调整，无功能改动。', items: [] })
      assert.equal(composeDeploySummary().subjectSummary, '文档与测试调整')
    }],
    ['部署·先查合没合：有没进目标环境的提交就停，列出来，不取信息不发', () => {
      const { run, calls } = fakeRun({ 'cherry origin/online origin/uat': ok('- aaa1111\n+ bbb2222\n+ ccc3333\n'), 'log -1 --format=%h %s bbb2222': ok('bbb2222 fix: 没合的\n') })
      const out = runDeployAction({ action: { action: 'deploy', env: 'online', autoSend: true, mergedFrom: 'uat' }, opts: config.opsActions, run })
      // 11-01：「没合齐 / 没绿 / 没新内容」是查完的结论，落 done 不催办（原来 blocked 被催了两轮）。
      assert.equal(out.status, 'done')
      assert.match(out.text, /^uat 上还有 2 个提交没进 online，没发部署信：\n- bbb2222 fix: 没合的\n- ccc3333\n合齐了回我「部署 online」我再查一次。$/)
      assert.ok(calls.some((c) => c.join(' ') === 'git -C /r/falive fetch -q origin'))
      assert.equal(calls.some((c) => c.includes('info')), false)
      const err = fakeRun({ cherry: { status: 128, stderr: 'bad ref' } })
      assert.match(runDeployAction({ action: { action: 'deploy', env: 'online', mergedFrom: 'uat' }, opts: config.opsActions, run: err.run }).text, /查 uat → online 合没合失败：bad ref/)
    }],
    ['部署·前提不满足：取信息失败 / 不是 JSON / build 没绿 / 没新内容，都不发', () => {
      const act = { action: 'deploy', env: 'online', autoSend: true }
      const r = (info) => runDeployAction({ action: act, opts: config.opsActions, run: fakeRun({ info }).run })
      assert.match(r({ status: 1, stderr: 'boom' }).text, /取 online 部署信息失败：boom/)
      assert.match(r(ok('<html>')).text, /部署信息不是 JSON/)
      assert.deepEqual(r(ok(JSON.stringify({ ...INFO, job: { id: 9, status: 'running' } }))), { status: 'done', text: 'build:online #9 状态是 running，没绿不发。绿了回我「部署 online」。' })
      assert.match(r(ok(JSON.stringify({ ...INFO, job: null }))).text, /^build:online 状态是 取不到，没绿不发/)
      assert.deepEqual(r(ok(JSON.stringify({ ...INFO, baseline: INFO.sha }))), { status: 'done', text: 'online 已经是 c1a40982（online 站点已部署），没有新内容，不发。' })
      assert.match(r(ok(JSON.stringify({ ...INFO, baseline: INFO.sha, baselineFrom: '' }))).text, /（上次部署）/)
    }],
    ['部署·没说直接发：只回将要发的内容，不建草稿', () => {
      const { run, calls } = fakeRun({ info: ok(JSON.stringify(INFO)) })
      const out = runDeployAction({ action: { action: 'deploy', env: 'uat', autoSend: false }, opts: config.opsActions, run })
      assert.equal(out.status, 'done')
      assert.equal(out.text, 'uat 部署信准备好了，还没发：\n- 主题摘要：评论成功后申报新手和每日任务\n- Jobid：17996（uat 分支 c1a40982）\n- 更新说明：评论成功后申报新手和每日任务；其余为文档、测试与 CI 调整。\n确认就回我「部署 uat 直接发」。')
      assert.equal(calls.some((c) => c.includes('draft') || c.includes('send')), false)
    }],
    ['部署·直接发：查合（都已合）→ info → draft → send，回执一项一行；pre 与 uat/online 收尾句不同', () => {
      const { run, calls } = fakeRun({ cherry: ok('- aaa1111\n'), info: ok(JSON.stringify(INFO)), draft: ok(`${JSON.stringify(DRAFT)}\n--- body ---\nHi Ops`), send: ok('{}') })
      const out = runDeployAction({ action: { action: 'deploy', env: 'online', autoSend: true, mergedFrom: 'uat' }, opts: config.opsActions, run })
      assert.equal(out.status, 'done')
      assert.equal(out.text, `已发 online 部署信：\n- 主题：${DRAFT.subject}\n- Jobid：17996（c1a40982）\n- 收件人：sysops@x、dev@y\n运维部署好后会自动探测、在 online 复测并私信你。`)
      const draftCall = calls.find((c) => c.includes('draft'))
      assert.deepEqual(draftCall, ['python3', '-I', '/m/deploy_mail.py', 'draft', '--env', 'online', '--subject-summary', '评论成功后申报新手和每日任务', '--update', '评论成功后申报新手和每日任务；其余为文档、测试与 CI 调整。'])
      assert.deepEqual(calls.at(-1), ['python3', '-I', '/m/deploy_mail.py', 'send', 'D1'])
      const pre = runDeployAction({ action: { action: 'deploy', env: 'pre', autoSend: true }, opts: config.opsActions, run: fakeRun({ info: ok(JSON.stringify(INFO)), draft: ok(JSON.stringify({ ...DRAFT, to: undefined })), send: ok('') }).run })
      assert.match(pre.text, /- 收件人：\npre 部署后 bot 会自动探测并复测。$/)
    }],
    ['部署·起草 / 发送失败：报失败，发送失败带草稿 id', () => {
      const base = { info: ok(JSON.stringify(INFO)) }
      const act = { action: 'deploy', env: 'online', autoSend: true }
      assert.match(runDeployAction({ action: act, opts: config.opsActions, run: fakeRun({ ...base, draft: { status: 1, stderr: 'lark down' } }).run }).text, /起草 online 部署信失败：lark down/)
      assert.match(runDeployAction({ action: act, opts: config.opsActions, run: fakeRun({ ...base, draft: ok('not json') }).run }).text, /起草 online 部署信失败：not json/)
      assert.match(runDeployAction({ action: act, opts: config.opsActions, run: fakeRun({ ...base, draft: ok(JSON.stringify({ subject: 'x' })) }).run }).text, /起草 online 部署信失败/)
      const sendFail = runDeployAction({ action: act, opts: config.opsActions, run: fakeRun({ ...base, draft: ok(JSON.stringify(DRAFT)), send: { status: 1, stdout: 'denied' } }).run })
      assert.deepEqual(sendFail, { status: 'failed', text: '草稿已建但发送失败（草稿 D1）：denied' })
    }],
    ['发 MR：推开发分支带 push option；认出 MR 链接 / 没新提交 / 认不出链接 / 推送失败', () => {
      const { run, calls } = fakeRun({ push: { status: 0, stdout: '', stderr: 'remote: View merge request for feature/phase-6-ol:\nremote:   http://mgit.x/hqoi/web/falive-react/-/merge_requests/212\n' } })
      assert.deepEqual(runMrAction({ action: { action: 'mr', env: 'pre' }, opts: config.opsActions, run }), { status: 'done', text: '已推 feature/phase-6-ol，发往 pre 的 MR：\nhttp://mgit.x/hqoi/web/falive-react/-/merge_requests/212' })
      assert.deepEqual(calls[0], ['git', '-C', '/r/falive', 'push', '-o', 'merge_request.create', '-o', 'merge_request.target=pre', 'origin', 'feature/phase-6-ol'])
      assert.equal(runMrAction({ action: { action: 'mr', env: 'pre' }, opts: config.opsActions, run: fakeRun({ push: ok('Everything up-to-date') }).run }).text, 'feature/phase-6-ol 没有新提交，不用推。')
      assert.match(runMrAction({ action: { action: 'mr', env: 'uat' }, opts: config.opsActions, run: fakeRun({ push: ok('pushed') }).run }).text, /没从输出里认出 MR 链接，去 GitLab 看一下发往 uat 的 MR/)
      assert.deepEqual(runMrAction({ action: { action: 'mr', env: 'pre' }, opts: config.opsActions, run: fakeRun({ push: { status: 1, stderr: 'rejected' } }).run }), { status: 'failed', text: '推 feature/phase-6-ol 失败：rejected' })
    }],
    ['入口：非负责人不跑；认不出回帮助；缺配置报失败；正常跑并回报 running → 结果', async () => {
      const reports = []
      const reportStatus = async (...a) => { reports.push(a) }
      const run = fakeRun({ push: ok('Everything up-to-date') }).run
      assert.equal((await runOpsAction({ task: { text: '发 pre', operator: 'ou_x' }, workerConfig: { localConfig: config }, reportStatus, run })).status, 'failed')
      assert.match(reports.at(-1)[1], /只接受负责人本人私信/)
      assert.equal((await runOpsAction({ task: { text: '看看 pre', operator: OWNER }, workerConfig: { localConfig: config }, reportStatus, run })).status, 'done')
      assert.match(reports.at(-1)[1], /^没认出要办哪件事，没动手。\n我能办的运维动作/)
      assert.equal((await runOpsAction({ task: { text: '部署 pre', operator: OWNER }, workerConfig: { localConfig: { ...config, opsActions: { repo: '/r' } } }, reportStatus, run })).status, 'failed')
      assert.match(reports.at(-1)[1], /缺 opsActions\.deployMail/)
      assert.match((await runOpsAction({ task: { text: '发 pre', operator: OWNER }, workerConfig: { localConfig: { ...config, opsActions: {} } }, reportStatus, run }), reports.at(-1))[1], /缺 opsActions\.repo \/ devBranch/)
      const audits = []
      reports.length = 0
      assert.equal((await runOpsAction({ task: { text: '发 pre', operator: OWNER }, workerConfig: { localConfig: config }, reportStatus, updateAudit: (p) => audits.push(p.status), run })).status, 'done')
      assert.deepEqual(reports.map((r) => r[0]), ['running', 'done'])
      assert.deepEqual(audits, ['running_ops', 'done'])
      // 结构化 outcome：原文就是人话，summary 取第一行
      assert.deepEqual(reports[1][5], { outcome: { kind: 'ops', summary: 'feature/phase-6-ol 没有新提交，不用推。', text: 'feature/phase-6-ol 没有新提交，不用推。', blockers: [], warnings: [] } })
      reports.length = 0
      await runOpsAction({ task: { text: '发 pre', operator: OWNER }, workerConfig: { localConfig: config }, reportStatus, run: fakeRun({ push: { status: 1, stderr: '第一行\n第二行' } }).run })
      assert.deepEqual(reports.at(-1).slice(0, 2), ['failed', '推 feature/phase-6-ol 失败：第一行\n第二行'])
      assert.deepEqual(reports.at(-1)[5].outcome, { kind: 'ops', summary: '推 feature/phase-6-ol 失败：第一行', text: '推 feature/phase-6-ol 失败：第一行\n第二行', blockers: [], warnings: [] })
    }],
    ['开工前出口与工作上下文：运维任务进运维仓根并接管；普通任务没触发需求闸就放行', async () => {
      const task = { id: 't', text: '运维：发 pre', commandType: 'ops', commandTypeSource: 'explicit', operator: OWNER }
      assert.deepEqual(resolveWorkContext({ localConfig: config }, task), { cwd: '/r/falive', projectId: '(ops)', projectName: '运维指令', projectDocs: [], readOnly: false, ops: { root: '/r/falive' } })
      assert.equal(resolveWorkContext({ localConfig: {} }, task).ops.root.length > 0, true)
      const reports = []
      assert.equal(await runPreExecutionGates({ task, workContext: { ops: { root: '/r/falive' } }, workerConfig: { localConfig: config }, auditContext: null, executor: 'claude', reportStatus: async (s) => { reports.push(s) }, run: fakeRun({ push: ok('Everything up-to-date') }).run }), true)
      assert.deepEqual(reports, ['running', 'done'])
      assert.equal(await runPreExecutionGates({ task: { id: 'b', text: '修复：登录页报错，复现步骤见截图', attachments: [{ type: 'image' }] }, workContext: {}, workerConfig: { localConfig: {} }, auditContext: null, executor: 'claude', reportStatus: async () => {} }), false)
      const parked = []
      assert.equal(await runPreExecutionGates({ task: { id: 't1', source: 'lark', commandType: null, text: '加个导出功能' }, workContext: {}, workerConfig: { localConfig: {} }, auditContext: null, executor: 'claude', reportStatus: async (...r) => { parked.push(r) } }), true, '裸一句话新需求停下等确认（原需求闸，挪过来行为不变）')
      assert.equal(parked[0][0], 'waiting_confirmation')
      assert.match(parked[0][1], /被判定为新需求而非缺陷反馈/)
      assert.equal(parked[0][2], 'claude')
    }],
  ]))
})
