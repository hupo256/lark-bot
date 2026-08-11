#!/usr/bin/env node
/**
 * 纯函数单测（能力2/3 的安全边界）。零外部依赖，`node --test` 直跑。
 * 覆盖 review 后加固的四个判定点：白名单 fail-closed、事件归一化、项目号 path-injection 防护、
 * 文档同步禁写校验。这些是无监督改代码的信任边界，回归必须挡住。
 *
 *   node --test common/lark-bot/__tests__/lark-pure.test.mjs
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { handleStatusUpdate } from '../lib/lark-status.mjs'
import {
  buildBugStatusFilter,
  buildBugText,
  classifyBugPollAction,
  classifyBugTaskStatus,
  readBugCommandType,
  readStatusText,
} from '../lib/lark-bugtable-parse.mjs'
import { createTaskStore } from '../lib/lark-task-store.mjs'
import { parkedReminderRound } from '../lib/lark-parked-reminder.mjs'
import { rotateLogIfLarge } from '../lib/lark-log-rotate.mjs'
import { buildResultCard, buildWaitingCard } from '../lib/lark-cards.mjs'
import { parseSentMessageId } from '../lib/lark-cli.mjs'
import {
  classifyCommandType,
  inferCommandType,
  isForBot,
  isReadOnlyCommand,
  isReadOnlyTask,
  isWhitelisted,
  normalizeMessage,
  parseCommandType,
  parseResumeDirective,
  resolveCommandType,
  resolveMessageTrigger,
} from '../lib/lark-message.mjs'
import { isProjectId, matchProjectId } from '../lib/lark-project-id.mjs'
import { allRuleRefs, buildFocusedRuleContext, classifyLarkTask, extractMarkdownSection } from '../lib/lark-rule-context.mjs'
import { assessDoneResult, crossCheckChangedFiles, detectChangeTier, splitViolations } from '../lib/lark-quality-gate.mjs'
import { pruneStaleAudits } from '../lib/lark-worker-audit.mjs'
import { classifyWorkerFailure } from '../lib/lark-worker-results.mjs'
import { resolveWorkContext, safeProject } from '../lib/lark-work-context.mjs'
import { resolveResumeTarget } from '../lib/lark-ingest.mjs'
import { validateSource } from '../../engine/agent-scripts/sync-lark-docs.mjs'

const BOT = 'ou_bot'
const ME = 'ou_me'

// ---------------------------------------------------------------------------
// normalizeMessage：两种信封（lark-cli 拍平 / 官方嵌套）归一
// ---------------------------------------------------------------------------
describe('normalizeMessage', () => {
  it('非对象 / 无 message_id → null', () => {
    assert.equal(normalizeMessage(null), null)
    assert.equal(normalizeMessage('x'), null)
    assert.equal(normalizeMessage({ chat_id: 'oc_1' }), null)
  })

  it('lark-cli 拍平结构：顶层字段 + 字符串 mention.id + 去内联 @名字 + root_id 作 replyTo', () => {
    const msg = normalizeMessage({
      message_id: 'om_1',
      chat_id: 'oc_1',
      chat_type: 'group',
      message_type: 'text',
      sender_id: ME,
      content: '@小助手 修复登录页',
      mentions: [{ id: BOT, key: '@_user_1', name: '小助手' }],
      root_id: 'om_parent',
    })
    assert.equal(msg.messageId, 'om_1')
    assert.equal(msg.chatId, 'oc_1')
    assert.equal(msg.senderOpenId, ME)
    assert.equal(msg.mentions[0].id, BOT) // 字符串形态直接取
    assert.equal(msg.text, '修复登录页') // @小助手 已剥除
    assert.equal(msg.replyTo, 'om_parent')
  })

  it('官方嵌套 webhook：event.message.* + content JSON 串 + mention.id.open_id', () => {
    const msg = normalizeMessage({
      event: {
        message: {
          message_id: 'om_2',
          chat_id: 'oc_2',
          chat_type: 'group',
          message_type: 'text',
          content: JSON.stringify({ text: '看看这个' }),
          mentions: [{ id: { open_id: BOT }, key: '@_user_1', name: 'bot' }],
        },
        sender: { sender_id: { open_id: ME } },
      },
    })
    assert.equal(msg.messageId, 'om_2')
    assert.equal(msg.senderOpenId, ME)
    assert.equal(msg.mentions[0].id, BOT) // { open_id } 形态取 open_id
    assert.equal(msg.text, '看看这个')
  })

  it('post 富文本：抽出文本 + 图片 image_key 进 attachments', () => {
    const post = {
      zh_cn: {
        content: [
          [
            { tag: 'text', text: '背景色不对' },
            { tag: 'img', image_key: 'img_k1', width: 100, height: 200 },
          ],
        ],
      },
    }
    const msg = normalizeMessage({
      message_id: 'om_3',
      chat_id: 'oc_3',
      message_type: 'post',
      content: JSON.stringify(post),
      mentions: [],
    })
    assert.equal(msg.text, '背景色不对')
    assert.equal(msg.attachments.length, 1)
    assert.deepEqual(msg.attachments[0], { type: 'image', imageKey: 'img_k1', width: 100, height: 200 })
  })

  it('引用消息降级文本：恢复两种图片占位格式并按 image_key 去重', () => {
    const msg = normalizeMessage({
      message_id: 'om_4',
      chat_id: 'oc_4',
      message_type: 'text',
      content: '看这里 [Image: img_same] 和 ![Image](img_same)，另一个 ![Image](img_other)',
      mentions: [],
    })
    assert.deepEqual(msg.attachments, [
      { type: 'image', imageKey: 'img_same' },
      { type: 'image', imageKey: 'img_other' },
    ])
  })
})

describe('bug table task status', () => {
  it('blocked/waiting_confirmation 保持等待，不会被 poller 当新任务重入队', () => {
    assert.equal(classifyBugTaskStatus('blocked'), 'waiting')
    assert.equal(classifyBugTaskStatus('waiting_confirmation'), 'waiting')
    assert.equal(classifyBugTaskStatus('verifying'), 'in-flight')
    assert.equal(classifyBugTaskStatus(undefined), 'new')
  })
  it('no_change_needed → no-change 终局，不重入队也不落 seen（转后端待人工重派）', () => {
    assert.equal(classifyBugTaskStatus('no_change_needed'), 'no-change')
  })

  it('同时查询待处理与验退；未配置验退值时保持单状态过滤', () => {
    assert.deepEqual(
      buildBugStatusFilter({ statusField: '处理状态', pendingValue: '待处理', rejectedValue: '验退' }),
      {
        logic: 'or',
        conditions: [
          ['处理状态', '==', '待处理'],
          ['处理状态', '==', '验退'],
        ],
      },
    )
    assert.deepEqual(buildBugStatusFilter({ statusField: '处理状态', pendingValue: '待处理' }), {
      logic: 'and',
      conditions: [['处理状态', '==', '待处理']],
    })
  })

  it('解析 Base 单选字段返回的字符串数组', () => {
    assert.equal(readStatusText(['验退']), '验退')
    assert.equal(readStatusText([{ name: '待处理' }]), '待处理')
  })

  it('验退是新的人工轮次：忽略 seen，并重开旧终态；活动/等待态仍去重', () => {
    const base = { recordStatus: '验退', rejectedValue: '验退', seen: true }
    for (const taskStatus of ['done', 'done_pending_writeback', 'failed', 'no_change_needed']) {
      assert.equal(classifyBugPollAction({ ...base, taskStatus }), 'reopen')
    }
    assert.equal(classifyBugPollAction({ ...base, taskStatus: 'queued' }), 'in-flight')
    assert.equal(classifyBugPollAction({ ...base, taskStatus: 'waiting_confirmation' }), 'waiting')
    assert.equal(classifyBugPollAction({ ...base, taskStatus: undefined }), 'enqueue')
  })

  it('普通待处理仍尊重 seen，failed 不自动重跑', () => {
    const base = { recordStatus: '待处理', rejectedValue: '验退' }
    assert.equal(classifyBugPollAction({ ...base, taskStatus: 'done', seen: true }), 'seen')
    assert.equal(classifyBugPollAction({ ...base, taskStatus: 'failed', seen: false }), 'failed')
  })

  it('验退任务正文要求先分析上一轮未解决根因', () => {
    const text = buildBugText({
      bug: { statusField: '处理状态', rejectedValue: '验退', titleField: '问题标题', descField: '问题描述', projectField: '项目ID' },
      record: {
        record_id: 'rec1',
        fields: { 处理状态: ['验退'], 问题标题: '按钮仍错位', 问题描述: 'test 环境复现', 项目ID: 'PR-12345' },
      },
    })
    assert.match(text, /bug 表验退项/)
    assert.match(text, /深入分析未解决的根因/)
    assert.match(text, /不要原样重复上一轮方案/)
  })

  it('bug 表命令类型只认显式前缀，不做自然语言兜底；QA 验退始终按修复处理', () => {
    const bug = { statusField: '处理状态', rejectedValue: '验退', titleField: '问题标题', descField: '问题描述' }
    // 自然语言问法（无显式「状态：」前缀）不再当 status——否则真 bug 会被静默零改动关单（P0-1）。
    const nl = { 处理状态: '待处理', 问题标题: '这个项目现在的状态是？', 问题描述: '' }
    assert.equal(readBugCommandType({ fields: nl, bug }), null)
    assert.match(buildBugText({ record: { record_id: 'rec-nl', fields: nl }, bug }), /^修复：Lark bug 表待处理项/)
    // 只有标题里显式写「状态：」前缀才当只读查询。
    const explicit = { 处理状态: '待处理', 问题标题: '状态：这个项目现在做到哪了', 问题描述: '' }
    assert.equal(readBugCommandType({ fields: explicit, bug }), 'status')
    assert.match(buildBugText({ record: { record_id: 'rec-status', fields: explicit }, bug }), /^状态：状态：这个项目现在做到哪了/)
    assert.equal(readBugCommandType({ fields: { ...nl, 处理状态: '验退' }, bug }), 'fix')
  })
})

// ---------------------------------------------------------------------------
// isForBot：p2p 恒真；群里需命中 botOpenId / @所有人
// ---------------------------------------------------------------------------
describe('isForBot', () => {
  const config = { botOpenId: BOT }
  it('p2p 直发始终算给 bot', () => {
    assert.equal(isForBot({ msg: { chatType: 'p2p', mentions: [] }, config }), true)
  })
  it('群里 mention 命中 botOpenId → true', () => {
    assert.equal(isForBot({ msg: { chatType: 'group', mentions: [{ id: BOT }] }, config }), true)
  })
  it('群里 mention 未命中 → false', () => {
    assert.equal(isForBot({ msg: { chatType: 'group', mentions: [{ id: 'ou_other' }] }, config }), false)
  })
  it('群里只 @ 配置的负责人 → 进入 task_mention 前置分类', () => {
    const personConfig = { botOpenId: BOT, taskMentionOpenIds: [ME] }
    const msg = { chatType: 'group', mentions: [{ id: ME }] }
    assert.equal(resolveMessageTrigger({ msg, config: personConfig }), 'task_mention')
    assert.equal(isForBot({ msg, config: personConfig }), true)
  })
  it('同时 @bot 与负责人 → 仍是 direct，不重复做前置分类', () => {
    const personConfig = { botOpenId: BOT, taskMentionOpenIds: [ME] }
    const msg = { chatType: 'group', mentions: [{ id: ME }, { id: BOT }] }
    assert.equal(resolveMessageTrigger({ msg, config: personConfig }), 'direct')
  })
  it('普通群消息没有 mention → 不触发', () => {
    assert.equal(resolveMessageTrigger({ msg: { chatType: 'group', mentions: [] }, config }), null)
  })
  it('bot 自己发的含 @负责人消息 → 不回流成任务', () => {
    const personConfig = { botOpenId: BOT, taskMentionOpenIds: [ME] }
    const msg = { chatType: 'group', senderType: 'bot', mentions: [{ id: ME }] }
    assert.equal(resolveMessageTrigger({ msg, config: personConfig }), null)
  })
  it('群里 @所有人（key=@_all）→ true', () => {
    assert.equal(isForBot({ msg: { chatType: 'group', mentions: [{ key: '@_all' }] }, config }), true)
  })
  it('未配置 botOpenId 时：有任意 mention 即算', () => {
    assert.equal(isForBot({ msg: { chatType: 'group', mentions: [{ id: 'x' }] }, config: {} }), true)
    assert.equal(isForBot({ msg: { chatType: 'group', mentions: [] }, config: {} }), false)
  })
})

// ---------------------------------------------------------------------------
// isWhitelisted：fail-closed + 群级信任边界（review P0-1 核心）
// ---------------------------------------------------------------------------
describe('isWhitelisted (fail-closed, 群级信任)', () => {
  it('完全没配白名单 → 拒绝所有事件（fail-closed，绝不 fail-open）', () => {
    assert.equal(isWhitelisted({ msg: { chatType: 'group', chatId: 'oc_1' }, config: {} }), false)
    assert.equal(isWhitelisted({ msg: { chatType: 'p2p', senderOpenId: ME }, config: {} }), false)
    assert.equal(
      isWhitelisted({ msg: { chatType: 'group', chatId: 'oc_1' }, config: { allowedChatIds: [], allowedOpenIds: [] } }),
      false,
    )
  })

  it('群消息按群放行、不按发送人过滤（群内 QA/PM/后台 @ 都能触发）', () => {
    const config = { allowedChatIds: ['oc_ok'] }
    // 白名单群里任意发送人都放行
    assert.equal(isWhitelisted({ msg: { chatType: 'group', chatId: 'oc_ok', senderOpenId: 'ou_qa' }, config }), true)
    assert.equal(isWhitelisted({ msg: { chatType: 'group', chatId: 'oc_ok', senderOpenId: 'ou_pm' }, config }), true)
    // 非白名单群一律拒绝
    assert.equal(isWhitelisted({ msg: { chatType: 'group', chatId: 'oc_bad', senderOpenId: ME }, config }), false)
  })

  it('p2p 直发无群作锚点：只放行白名单用户', () => {
    const config = { allowedOpenIds: [ME] }
    assert.equal(isWhitelisted({ msg: { chatType: 'p2p', senderOpenId: ME }, config }), true)
    assert.equal(isWhitelisted({ msg: { chatType: 'p2p', senderOpenId: 'ou_stranger' }, config }), false)
  })

  it('只配了群白名单时，p2p 直发被拒（用户名单为空）', () => {
    const config = { allowedChatIds: ['oc_ok'] }
    assert.equal(isWhitelisted({ msg: { chatType: 'p2p', senderOpenId: ME }, config }), false)
  })

  it('动态成员制（auto）：群消息按注入的 isMember 放行/拒绝', () => {
    const config = { allowedChatIds: 'auto' }
    assert.equal(isWhitelisted({ msg: { chatType: 'group', chatId: 'oc_x' }, config, isMember: true }), true)
    assert.equal(isWhitelisted({ msg: { chatType: 'group', chatId: 'oc_x' }, config, isMember: false }), false)
    // auto 下 p2p 仍只放行白名单用户，与 isMember 无关
    const withUser = { allowedChatIds: 'auto', allowedOpenIds: [ME] }
    assert.equal(isWhitelisted({ msg: { chatType: 'p2p', senderOpenId: ME }, config: withUser, isMember: true }), true)
    assert.equal(isWhitelisted({ msg: { chatType: 'p2p', senderOpenId: 'ou_x' }, config: withUser, isMember: true }), false)
  })
})

// ---------------------------------------------------------------------------
// safeProject：项目号归一 + path-injection 防护（review P0-4）
// ---------------------------------------------------------------------------
describe('safeProject', () => {
  it('合法项目号归一为大写', () => {
    assert.equal(safeProject('pr-01947'), 'PR-01947')
    assert.equal(safeProject(' PM-1469 '), 'PM-1469')
  })
  it('非法/危险值一律空串（不作为路径/分支片段）', () => {
    assert.equal(safeProject('../../etc'), '')
    assert.equal(safeProject('PR-1'), '') // 位数不足
    assert.equal(safeProject('DROP TABLE'), '')
    assert.equal(safeProject(''), '')
    assert.equal(safeProject(null), '')
    assert.equal(safeProject(undefined), '')
  })
})

// ---------------------------------------------------------------------------
// resolveWorkContext：路由 + 分支命名（tail-8 防撞车）
// ---------------------------------------------------------------------------
describe('resolveWorkContext', () => {
  const cfg = { projectId: 'PR-01947', projectName: 'x' }

  it('非法项目号 → adhoc 临时 worktree（不越目录）', () => {
    const ctx = resolveWorkContext(cfg, { project: '../../x', id: 'om_abcdefgh12345678' })
    assert.equal(ctx.hotfixBranch, 'hotfix/adhoc-12345678')
    assert.equal(ctx.projectId, '(adhoc)')
    assert.ok(ctx.cwd.includes('.lark-hotfix'))
  })

  it('无项目号 → adhoc 临时 worktree', () => {
    const ctx = resolveWorkContext(cfg, { id: 'om_xxxxxxxx87654321' })
    assert.equal(ctx.hotfixBranch, 'hotfix/adhoc-87654321')
  })

  it('合法但本地无 worktree 的项目 → 临时 hotfix 分支（项目号大写归一）', () => {
    const ctx = resolveWorkContext(cfg, { project: 'pr-99999', id: 'om_zzzzzzzzABCDEFGH' })
    assert.equal(ctx.hotfixBranch, 'hotfix/PR-99999-ABCDEFGH')
    assert.equal(ctx.projectId, 'PR-99999')
  })

  it('分支后缀取 id 尾 8 位（同群 messageId 共享长前缀，取头会撞车）', () => {
    const a = resolveWorkContext(cfg, { project: 'PR-99999', id: 'om_x100b68708_AAAA0001' })
    const b = resolveWorkContext(cfg, { project: 'PR-99999', id: 'om_x100b68708_AAAA0002' })
    assert.notEqual(a.hotfixBranch, b.hotfixBranch) // 尾部不同 → 分支不同
    assert.ok(a.hotfixBranch.endsWith('AAAA0001'))
  })

  it('recordId 优先于 id 作分支后缀', () => {
    const ctx = resolveWorkContext(cfg, { project: 'PR-99999', recordId: 'recABCDEFGH', id: 'om_ignored' })
    assert.ok(ctx.hotfixBranch.endsWith('ecABCDEFGH'.slice(-8)))
  })

  it('只读命令（状态/status）本地无 worktree → 主仓就地只读，不建临时 worktree、无分支', () => {
    const ctx = resolveWorkContext(cfg, { project: 'PR-99999', text: '状态：登录改造进度？', id: 'om_ro1234567890' })
    assert.equal(ctx.readOnly, true)
    assert.equal(ctx.hotfixBranch, undefined)
    assert.equal(ctx.projectId, 'PR-99999')
    assert.ok(!ctx.cwd.includes('.lark-hotfix'))
  })

  it('只读命令用 gateway 落的 commandType（无需再解析 text）', () => {
    const ctx = resolveWorkContext(cfg, { commandType: 'status', id: 'om_ro0987654321' })
    assert.equal(ctx.readOnly, true)
    assert.equal(ctx.hotfixBranch, undefined)
  })

  it('非只读命令（修复）仍走临时 worktree', () => {
    const ctx = resolveWorkContext(cfg, { project: 'PR-99999', text: '修复：登录报错', id: 'om_fix1234567890' })
    assert.ok(!ctx.readOnly)
    assert.ok(ctx.hotfixBranch?.startsWith('hotfix/PR-99999-'))
  })
})

// ---------------------------------------------------------------------------
// parseCommandType：命令前缀归一 + 只读命令判定
// ---------------------------------------------------------------------------
describe('parseCommandType', () => {
  it('识别中英前缀（大小写/全半角冒号），取首行', () => {
    assert.equal(parseCommandType('状态：进度？'), 'status')
    assert.equal(parseCommandType('STATUS: progress?'), 'status')
    assert.equal(parseCommandType('文档: 更新'), 'docs')
    assert.equal(parseCommandType('修复：登录报错'), 'fix')
    assert.equal(parseCommandType('自测：跑用例'), 'test')
    assert.equal(parseCommandType('QA：验收'), 'qa')
    assert.equal(parseCommandType('api：补接口'), 'api')
  })

  it('首行无命令前缀 → null（普通 bug 正文）', () => {
    assert.equal(parseCommandType('登录页按钮点不动'), null)
    assert.equal(parseCommandType(''), null)
    assert.equal(parseCommandType(null), null)
  })

  it('只读命令集合仅含 status', () => {
    assert.equal(isReadOnlyCommand('status'), true)
    assert.equal(isReadOnlyCommand('docs'), false)
    assert.equal(isReadOnlyCommand('fix'), false)
    assert.equal(isReadOnlyCommand(null), false)
  })

  it('自然语言明确问状态时推断 status，带写操作或陈述句时不误判', () => {
    assert.equal(inferCommandType('这个项目现在的状态是？'), 'status')
    assert.equal(inferCommandType('看看 PR-01947 目前做到哪一步'), 'status')
    assert.equal(inferCommandType('修复项目状态显示错误'), null)
    assert.equal(inferCommandType('项目状态字段显示错误'), null)
  })

  it('缺陷信号一票否决：报障式描述绝不当只读查询', () => {
    // 这些都含项目级主题词 + 查询提示，但带缺陷信号 → 必须判 null（此前「项目状态一直转圈」被误判成 status）。
    assert.equal(inferCommandType('这个项目的状态一直转圈，是什么原因？'), null)
    assert.equal(inferCommandType('看看项目状态怎么样，字段一直不显示'), null)
    assert.equal(inferCommandType('项目进度页面白屏了是怎么回事'), null)
  })

  it('classifyCommandType 标注来源：显式前缀=explicit，自然语言兜底=inferred，兜不住=null', () => {
    assert.deepEqual(classifyCommandType('状态：这个项目做到哪了'), { type: 'status', source: 'explicit' })
    assert.deepEqual(classifyCommandType('这个项目现在的状态是？'), { type: 'status', source: 'inferred' })
    assert.deepEqual(classifyCommandType('登录页按钮点不动'), { type: null, source: null })
  })

  it('resolveCommandType 是任务级 SSOT：无来源字段时按正文回推 explicit/inferred', () => {
    // 已持久化命令类型 + 无 commandTypeSource：正文有显式前缀 → explicit
    assert.deepEqual(resolveCommandType({ commandType: 'status', text: '状态：做到哪了' }), { type: 'status', source: 'explicit' })
    // 已持久化 status 但正文无显式前缀（自然语言） → inferred
    assert.deepEqual(resolveCommandType({ commandType: 'status', text: '这个项目现在的状态是？' }), { type: 'status', source: 'inferred' })
    // 显式 commandTypeSource 优先于正文回推
    assert.deepEqual(resolveCommandType({ commandType: 'status', commandTypeSource: 'inferred', text: '状态：做到哪了' }), { type: 'status', source: 'inferred' })
    // 无持久化命令类型：直接按正文分类
    assert.deepEqual(resolveCommandType({ text: '登录页按钮点不动' }), { type: null, source: null })
  })

  it('isReadOnlyTask 只在只读命令时为真', () => {
    assert.equal(isReadOnlyTask({ commandType: 'status', text: '状态：x' }), true)
    assert.equal(isReadOnlyTask({ commandType: 'fix', text: '修复：x' }), false)
    assert.equal(isReadOnlyTask({ text: '登录页按钮点不动' }), false)
  })

  it('解析显式续跑指令并保留补料正文', () => {
    assert.deepEqual(parseResumeDirective('继续任务 recABC_123 产品确认按方案 A'), {
      taskId: 'recABC_123',
      supplementText: '产品确认按方案 A',
    })
    assert.equal(parseResumeDirective('继续讨论这个问题'), null)
  })
})

// ---------------------------------------------------------------------------
// resolveResumeTarget：续跑目标解析的边界（B3）——只在明确续跑意图时命中，root_id 需回执命中
// ---------------------------------------------------------------------------
describe('resolveResumeTarget', () => {
  const parked = { id: 'w', status: 'waiting_confirmation' }
  const done = { id: 'd', status: 'done' }
  const makeStore = ({ byId = {}, byReceipt = {} } = {}) => ({
    get: (id) => byId[id] || null,
    findByReceiptMessageId: (id) => byReceipt[id] || null,
  })

  it('显式「继续任务 <id>」即使目标缺失也返回目标（交 handleResume 明确回话）', () => {
    const store = makeStore()
    assert.deepEqual(
      resolveResumeTarget({ msg: {}, store, resumeDirective: { taskId: 'w', supplementText: 'x' } }),
      { taskId: 'w', task: null, explicit: true },
    )
  })

  it('回复机器人回执卡（reply_to 命中回执）→ 命中，不限状态', () => {
    const store = makeStore({ byReceipt: { om_card: parked } })
    assert.equal(resolveResumeTarget({ msg: { replyToDirect: 'om_card', replyTo: 'om_card' }, store }).task, parked)
  })

  it('回复原任务消息：仅当该任务仍待确认/阻塞才算续跑意图', () => {
    assert.equal(
      resolveResumeTarget({ msg: { replyToDirect: 'w', replyTo: 'w' }, store: makeStore({ byId: { w: parked } }) }).task,
      parked,
    )
    // 回复一条已 done 的任务消息 → 视作线程内新请求，不劫持为续跑
    assert.equal(resolveResumeTarget({ msg: { replyToDirect: 'd', replyTo: 'd' }, store: makeStore({ byId: { d: done } }) }), null)
  })

  it('仅有线程根 root_id（无 reply_to）：只在命中回执且仍待确认/阻塞时锚定，绝不 store.get 任意消息', () => {
    // root_id 命中一条无关任务消息 → 不锚定（防误命中）
    assert.equal(resolveResumeTarget({ msg: { replyTo: 'w' }, store: makeStore({ byId: { w: parked } }) }), null)
    // root_id 命中待确认回执 → 锚定
    assert.equal(resolveResumeTarget({ msg: { replyTo: 'root' }, store: makeStore({ byReceipt: { root: parked } }) }).task, parked)
  })

  it('无任何续跑信号 → null（普通新任务）', () => {
    assert.equal(resolveResumeTarget({ msg: {}, store: makeStore() }), null)
  })
})

describe('Lark 回执 message_id 解析', () => {
  it('兼容常见 lark-cli 输出层级，非法输出返回 null', () => {
    assert.equal(parseSentMessageId('{"data":{"message_id":"om_a"}}'), 'om_a')
    assert.equal(parseSentMessageId('{"data":{"message":{"message_id":"om_b"}}}'), 'om_b')
    assert.equal(parseSentMessageId('{"message_id":"om_c"}'), 'om_c')
    assert.equal(parseSentMessageId('not-json'), null)
  })
})

// ---------------------------------------------------------------------------
// validateSource：文档同步只读，禁写校验扫全命令 token（review P2）
// ---------------------------------------------------------------------------
describe('validateSource (read-only guard)', () => {
  it('不支持的 service type → 抛错', () => {
    assert.throws(() => validateSource({ type: 'sheet', url: 'http://x' }), /unsupported Lark source type/)
  })
  it('不支持的 operation → 抛错', () => {
    assert.throws(() => validateSource({ type: 'doc', url: 'http://x', operation: 'write' }), /unsupported Lark source operation/)
  })
  it('缺 url → 抛错', () => {
    assert.throws(() => validateSource({ type: 'doc' }), /requires url/)
  })
  it('合法 docs +fetch → 返回命令数组', () => {
    const cmd = validateSource({ type: 'doc', url: 'http://x' })
    assert.ok(Array.isArray(cmd))
    assert.ok(cmd.includes('+fetch'))
  })
  it('自定义命令里夹带写类 token（delete）→ 抛错（禁写扫全 token）', () => {
    assert.throws(
      () => validateSource({ type: 'docs', url: 'http://x', command: ['lark-cli', 'docs', '+fetch', '--doc', 'http://x', '--mode', 'delete'] }),
      /forbidden write-like token/,
    )
  })
  it('+fetch 只允许 docs，其它 service 用 +fetch → 抛错', () => {
    assert.throws(
      () => validateSource({ type: 'wiki', url: 'http://x', command: ['lark-cli', 'wiki', '+fetch', '--url', 'http://x'] }),
      /\+fetch is only allowed for docs/,
    )
  })
})

// ---------------------------------------------------------------------------
// 项目号解析：matchProjectId（自由文本提取，词边界）/ isProjectId（整串校验）
// 两链路（群 @ 正文 vs bug 表单元格）共用同一正则，回归防「解析不一致导致误路由」。
// ---------------------------------------------------------------------------
describe('matchProjectId（自由文本提取）', () => {
  it('提取正文首个项目号并大写归一', () => {
    assert.equal(matchProjectId('修复 pr-01947 的登录 bug'), 'PR-01947')
    assert.equal(matchProjectId('见 PM-1469 需求'), 'PM-1469')
  })
  it('词边界：SUPR-01947 不吞出 PR-01947（否则误路由）', () => {
    assert.equal(matchProjectId('SUPR-01947 是别的东西'), null)
    assert.equal(matchProjectId('XPM-1469'), null)
  })
  it('无项目号 / 空输入 → null', () => {
    assert.equal(matchProjectId('没有项目号'), null)
    assert.equal(matchProjectId(''), null)
    assert.equal(matchProjectId(null), null)
  })
})

describe('isProjectId（整串校验）', () => {
  it('恰为合法项目号（含尾部空白/换行）→ true', () => {
    assert.equal(isProjectId('PR-01947'), true)
    assert.equal(isProjectId('pm-1469'), true)
    assert.equal(isProjectId('PM-1469\n'), true)
  })
  it('夹带脏字符 / 子串 / 空 → false（交 worker 走 adhoc）', () => {
    assert.equal(isProjectId('../../PR-01947'), false)
    assert.equal(isProjectId('SUPR-01947'), false)
    assert.equal(isProjectId('PR-01947 附注'), false)
    assert.equal(isProjectId(''), false)
    assert.equal(isProjectId(null), false)
  })
})

// ---------------------------------------------------------------------------
// handleStatusUpdate epoch fencing：worker 迟到回写（epoch 过期）被拒，防覆盖新一代执行。
// 只测 network-free 分支：epoch 不匹配 → 早返回 409；epoch 缺省 → 向后兼容放行（running 不发卡）。
// ---------------------------------------------------------------------------
describe('handleStatusUpdate epoch fencing', () => {
  let dir
  const freshStore = () => {
    dir = mkdtempSync(join(tmpdir(), 'lark-gw-'))
    return createTaskStore({ tasksDir: dir, leaseMs: 1000 })
  }
  const cleanup = () => dir && rmSync(dir, { recursive: true, force: true })

  it('epoch 与当前不匹配 → 拒绝 409，不改状态', async () => {
    const store = freshStore()
    store.upsert({ id: 't', status: 'running', epoch: 2, createdAt: '2026-01-01T00:00:00Z' })
    const outcome = await handleStatusUpdate({ config: {}, store, id: 't', status: 'done', epoch: 1 })
    assert.equal(outcome.ok, false)
    assert.equal(outcome.code, 409)
    assert.equal(store.get('t').status, 'running') // 未被旧 worker 覆盖
    cleanup()
  })

  it('epoch 匹配 → 放行（running 态无群卡，纯 network-free）', async () => {
    const store = freshStore()
    store.upsert({ id: 't', status: 'running', epoch: 2, createdAt: '2026-01-01T00:00:00Z' })
    const outcome = await handleStatusUpdate({ config: {}, store, id: 't', status: 'running', epoch: 2 })
    assert.equal(outcome.ok, true)
    cleanup()
  })

  it('epoch 缺省 → 向后兼容放行（不校验）', async () => {
    const store = freshStore()
    store.upsert({ id: 't', status: 'running', epoch: 5, createdAt: '2026-01-01T00:00:00Z' })
    const outcome = await handleStatusUpdate({ config: {}, store, id: 't', status: 'running' })
    assert.equal(outcome.ok, true)
    cleanup()
  })
})

// ---------------------------------------------------------------------------
// 变更分级探测 + changedFiles 交叉校验 + done 可信度评估（worker 侧无人值守验证加强，P2-13）
// ---------------------------------------------------------------------------
describe('detectChangeTier（契约/共享/类型敏感路径 → L2+）', () => {
  it('命中 schema/mapper/api/.d.ts/packages 任一即 L2，附原因', () => {
    assert.equal(detectChangeTier(['apps/web/src/x/order.schema.ts']).tier, 'L2')
    assert.equal(detectChangeTier(['apps/web/src/api/order.ts']).tier, 'L2')
    assert.equal(detectChangeTier(['apps/web/src/mappers/orderMapper.ts']).tier, 'L2')
    assert.equal(detectChangeTier(['packages/ui/src/Button.tsx']).tier, 'L2')
    assert.equal(detectChangeTier(['apps/web/src/types/global.d.ts']).tier, 'L2')
  })
  it('纯样式/文案改动 → L1，无原因', () => {
    const { tier, reasons } = detectChangeTier(['apps/web/src/x/Panel.tsx', 'apps/web/src/x/panel.css'])
    assert.equal(tier, 'L1')
    assert.deepEqual(reasons, [])
  })
})

describe('buildResultCard（结果卡渲染分支行）', () => {
  const config = { project: 'PR-01645', title: '冒烟', bugTable: {} }
  it('有 task.branch → 卡片含分支行', () => {
    const card = buildResultCard({ config, task: { summary: 'x', branch: 'hotfix/PR-01645-ab12cd' }, status: 'done', result: '已完成。' })
    assert.match(card, /hotfix\/PR-01645-ab12cd/)
    assert.match(card, /分支/)
  })
  it('无 task.branch（只读任务）→ 卡片不含分支行', () => {
    const card = buildResultCard({ config, task: { summary: 'x', commandType: 'status' }, status: 'done', result: '查询完成。' })
    assert.ok(!/\*\*分支\*\*/.test(card))
    assert.match(card, /查询成功/)
  })

  it('待确认卡展示任务 ID、轮次和两种续跑入口', () => {
    const card = buildWaitingCard({
      config,
      task: { id: 'rec1234', summary: '缺接口口径', waitRound: 2 },
      status: 'waiting_confirmation',
      result: '需确认全部账户含义。',
    })
    assert.match(card, /rec1234/)
    assert.match(card, /第 2 轮/)
    assert.match(card, /继续任务 rec1234/)
  })
})

describe('crossCheckChangedFiles（AI 自报 vs 真实 git diff）', () => {
  it('一致 → consistent，无差集', () => {
    const r = crossCheckChangedFiles({ reported: ['a.ts', './b.ts'], actual: ['a.ts', 'b.ts'] })
    assert.equal(r.consistent, true)
    assert.equal(r.actualEmpty, false)
  })
  it('漏报 / 虚报分别落到两个差集', () => {
    const r = crossCheckChangedFiles({ reported: ['a.ts', 'ghost.ts'], actual: ['a.ts', 'real.ts'] })
    assert.deepEqual(r.missingFromReport, ['real.ts']) // 真改了 AI 没报
    assert.deepEqual(r.notActuallyChanged, ['ghost.ts']) // AI 报了实际没改
    assert.equal(r.consistent, false)
  })
  it('实际零改动 → actualEmpty', () => {
    assert.equal(crossCheckChangedFiles({ reported: ['a.ts'], actual: [] }).actualEmpty, true)
  })
})

describe('assessDoneResult（done 可信度评估）', () => {
  it('done 但工作区零改动 → 不可信（需人工复核）', () => {
    const a = assessDoneResult({ reportedChangedFiles: ['a.ts'], actualChangedFiles: [], checks: ['tsc'] })
    assert.equal(a.trustworthy, false)
    assert.match(a.notes[0], /无任何改动/)
  })
  it('只读任务（状态/status）豁免零改动降级', () => {
    const a = assessDoneResult({ reportedChangedFiles: [], actualChangedFiles: [], readOnly: true })
    assert.equal(a.trustworthy, true)
    assert.deepEqual(a.notes, [])
  })
  it('L2+ 改动但 AI checks 不含 type-check → 挂 note（仍可信）', () => {
    const a = assessDoneResult({
      reportedChangedFiles: ['x.schema.ts'],
      actualChangedFiles: ['x.schema.ts'],
      checks: ['biome', '单测通过'],
    })
    assert.equal(a.trustworthy, true)
    assert.equal(a.tier, 'L2')
    assert.ok(a.notes.some((n) => /type-check/.test(n)))
  })
  it('L2+ 改动且 checks 含 tsc → 无 type-check note', () => {
    const a = assessDoneResult({
      reportedChangedFiles: ['x.schema.ts'],
      actualChangedFiles: ['x.schema.ts'],
      checks: ['tsc --noEmit 通过'],
    })
    assert.ok(!a.notes.some((n) => /type-check/.test(n)))
  })
  it('漏报改动文件 → 挂 note 但不阻断（可信）', () => {
    const a = assessDoneResult({
      reportedChangedFiles: ['a.tsx'],
      actualChangedFiles: ['a.tsx', 'b.tsx'],
      checks: [],
    })
    assert.equal(a.trustworthy, true)
    assert.ok(a.notes.some((n) => /漏报/.test(n) && /b\.tsx/.test(n)))
  })
})

describe('splitViolations（规范闸残留分级：色类硬拦 / 其余 note）', () => {
  it('失效裸色类进硬桶，arbitrary value 等进软桶', () => {
    const violations = [
      { kind: 'invalid-color-class', token: 'text-green', file: 'a.tsx' },
      { kind: 'arbitrary-value', token: 'rounded-[12px]', file: 'a.tsx' },
      { kind: 'bare-any', token: 'as any', file: 'a.ts' },
    ]
    const { hardRemaining, softRemaining } = splitViolations(violations)
    assert.deepEqual(hardRemaining.map((v) => v.kind), ['invalid-color-class'])
    assert.deepEqual(softRemaining.map((v) => v.kind), ['arbitrary-value', 'bare-any'])
  })
  it('只有 arbitrary value 时硬桶为空（不阻断 done，仅 note）', () => {
    const { hardRemaining, softRemaining } = splitViolations([
      { kind: 'arbitrary-value', token: 'w-[336px]', file: 'a.tsx' },
    ])
    assert.equal(hardRemaining.length, 0)
    assert.equal(softRemaining.length, 1)
  })
})

// ---------------------------------------------------------------------------
// classifyLarkTask 多标签 + 图片/fix 强制 UI/STYLE + extractMarkdownSection（P3-18）
// ---------------------------------------------------------------------------
describe('classifyLarkTask（多标签叠加）', () => {
  it('混合任务 ui+api 同时给标签（不再单一胜出）', () => {
    const { scenarios } = classifyLarkTask('修改接口字段后同步更新弹窗组件样式')
    assert.ok(scenarios.includes('write_api'))
    assert.ok(scenarios.includes('write_ui'))
  })
  it('纯样式任务 → write_ui + style 信号', () => {
    const { scenario, scenarios, signals } = classifyLarkTask('调整按钮圆角和背景色')
    assert.equal(scenario, scenarios[0])
    assert.ok(scenarios.includes('write_ui'))
    assert.ok(signals.includes('style'))
  })
  it('无信号 → g4_coding_worktree 兜底', () => {
    assert.deepEqual(classifyLarkTask('随便改点东西').scenarios, ['g4_coding_worktree'])
  })
  it('有图片附件 → 强制并入 UI+STYLE（防「字段」误判成纯 API 丢样式规则）', () => {
    const withoutImage = classifyLarkTask('字段对不上')
    assert.ok(!withoutImage.scenarios.includes('write_ui')) // 纯文字「字段」判成 API
    const withImage = classifyLarkTask('字段对不上', { hasImage: true })
    assert.ok(withImage.signals.includes('style'))
    assert.ok(withImage.scenarios.includes('write_ui'))
  })
  it('fix 命令 → 强制并入 UI+STYLE', () => {
    const fix = classifyLarkTask('接口返回异常', { isFix: true })
    assert.ok(fix.scenarios.includes('write_ui'))
    assert.ok(fix.scenarios.includes('write_api')) // 原 api 信号仍在
  })
})

describe('extractMarkdownSection', () => {
  const doc = '# T\n\n## A\n\na1\na2\n\n## B\n\nb1\n'
  it('抽出指定标题到下一同级标题前', () => {
    assert.equal(extractMarkdownSection(doc, '## A'), '## A\n\na1\na2')
  })
  it('标题不存在 → 空串（供 buildFocusedRuleContext fail-closed）', () => {
    assert.equal(extractMarkdownSection(doc, '## Z'), '')
  })
})

describe('allRuleRefs（规则路由表 ↔ 真实文档，锁住漂移）', () => {
  it('每条路由的 file+heading 在真实文档上都能抽到非空章节，一个都不能丢', () => {
    const refs = allRuleRefs()
    assert.ok(refs.length >= 20) // 路由表本身不能被误删空
    for (const ref of refs) {
      assert.ok(existsSync(ref.file), `路由文件缺失：${ref.label}（${ref.file}）`)
      const excerpt = extractMarkdownSection(readFileSync(ref.file, 'utf8'), ref.heading)
      assert.ok(excerpt, `路由章节抽空：${ref.label} · ${ref.heading}（源文档可能改了标题）`)
    }
  })
})

describe('buildFocusedRuleContext（正常场景零 warnings，全路由章节命中）', () => {
  it('全信号任务加载全部路由章节，0 warnings', () => {
    const ctx = buildFocusedRuleContext({ taskText: '文案 tooltip 样式颜色圆角 页面组件表单 API接口schema DTO mapper映射 React Query mutation缓存 Zustand store状态管理 MSW mock fixture' })
    assert.equal(ctx.warnings.length, 0)
    assert.equal(ctx.sources.length, allRuleRefs().length)
  })

  it('绑定当前发布指纹；同一章节在规则链变化后上下文指纹必须变化', () => {
    const first = buildFocusedRuleContext({
      taskText: '调整页面样式',
      ruleChain: { ruleReleaseFingerprint: 'l3-a', effectiveRulesFingerprint: 'effective-a' },
    })
    const second = buildFocusedRuleContext({
      taskText: '调整页面样式',
      ruleChain: { ruleReleaseFingerprint: 'l3-b', effectiveRulesFingerprint: 'effective-b' },
    })
    assert.equal(first.ruleReleaseFingerprint, 'l3-a')
    assert.equal(first.effectiveRulesFingerprint, 'effective-a')
    assert.notEqual(first.fingerprint, second.fingerprint)
  })

  it('required（常驻硬规则）章节缺失 → fail-closed 阻断', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lark-rule-context-'))
    const file = join(dir, 'rule.md')
    writeFileSync(file, '# Rule\n\n## Existing\n\ntext\n')
    try {
      assert.throws(
        () => buildFocusedRuleContext({
          taskText: '修复页面',
          ruleRefs: [{ file, label: 'rule.md', heading: '## Missing', required: true }],
        }),
        /VERIFY-RULE-004.*规则上下文构建失败.*常驻硬规则/,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('辅助（非 required）章节缺失 → 降级 + 浮现 warnings，不阻断', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lark-rule-context-'))
    const file = join(dir, 'rule.md')
    writeFileSync(file, '# Rule\n\n## Existing\n\ntext\n')
    try {
      // 一条 required 命中 + 一条 aux 缺失：不抛，aux 缺失以 warnings 浮现，required 章节仍进 sources。
      const ctx = buildFocusedRuleContext({
        taskText: '修复页面',
        ruleRefs: [
          { file, label: 'rule.md', heading: '## Existing', required: true },
          { file, label: 'rule.md', heading: '## Missing' },
        ],
      })
      assert.equal(ctx.sources.length, 1)
      assert.equal(ctx.warnings.length, 1)
      assert.match(ctx.warnings[0], /规则章节缺失.*Missing/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// classifyWorkerFailure：Worker 层技术性失败归因（preflight / timeout / worktree / exit）（P3-17）
// ---------------------------------------------------------------------------
describe('classifyWorkerFailure', () => {
  it('超时类 → tool 失败', () => {
    assert.equal(classifyWorkerFailure(new Error('AI process timeout after 1800000ms')).failureKind, 'tool')
    assert.equal(classifyWorkerFailure(new Error('killed by SIGKILL')).failureKind, 'tool')
  })
  it('登录 / 权限类 → permission 失败', () => {
    const r = classifyWorkerFailure(new Error('Codex 未登录：login required'))
    assert.equal(r.failureKind, 'permission')
    assert.match(r.nextStep, /登录/)
  })
  it('缺二进制 / worktree / git 类 → env 失败', () => {
    assert.equal(classifyWorkerFailure(new Error('spawn codex ENOENT')).failureKind, 'env')
    assert.equal(classifyWorkerFailure(new Error('git worktree add failed')).failureKind, 'env')
  })
  it('未知错误 → tool 兜底，带下一步', () => {
    const r = classifyWorkerFailure(new Error('something odd'))
    assert.equal(r.failureKind, 'tool')
    assert.ok(r.nextStep)
  })
})

// ---------------------------------------------------------------------------
// pruneStaleAudits：按 mtime 龄清理各项目 lark-audits/，只删超期、保留新近与非审计目录
// ---------------------------------------------------------------------------
describe('pruneStaleAudits', () => {
  const mkAudit = (root, project, name, ageMs) => {
    const dir = join(root, project, 'agent/lark-audits')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, name)
    writeFileSync(file, 'x')
    if (ageMs) {
      const t = (Date.now() - ageMs) / 1000
      utimesSync(file, t, t)
    }
    return file
  }

  it('删超过留存期的文件，保留新近文件', () => {
    const root = mkdtempSync(join(tmpdir(), 'lark-audit-'))
    try {
      const stale = mkAudit(root, 'PR-01645', 'old.log', 8 * 24 * 60 * 60 * 1000) // 8 天前
      const fresh = mkAudit(root, 'PR-01645', 'new.log', 60 * 1000) // 1 分钟前
      pruneStaleAudits(root, 7 * 24 * 60 * 60 * 1000)
      assert.throws(() => statSync(stale), '超期文件应被删除')
      assert.ok(statSync(fresh), '新近文件应保留')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('retentionMs=0 时不删任何文件（关闭开关）', () => {
    const root = mkdtempSync(join(tmpdir(), 'lark-audit-'))
    try {
      const stale = mkAudit(root, 'PR-01645', 'old.log', 30 * 24 * 60 * 60 * 1000)
      pruneStaleAudits(root, 0)
      assert.ok(statSync(stale), 'retention=0 应保留')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('无 lark-audits 目录 / 缺失 root 均不抛错', () => {
    const root = mkdtempSync(join(tmpdir(), 'lark-audit-'))
    try {
      mkdirSync(join(root, 'PR-99999'), { recursive: true }) // 有项目目录但无 agent/lark-audits
      assert.doesNotThrow(() => pruneStaleAudits(root, 1000))
      assert.doesNotThrow(() => pruneStaleAudits(join(root, 'does-not-exist'), 1000))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})


// ---------------------------------------------------------------------------
// 挂起催办轮次（waiting_confirmation / blocked 超时未处理）
// ---------------------------------------------------------------------------
describe('parkedReminderRound（挂起催办轮次）', () => {
  const HOUR = 3600000
  const at = (hoursAgo) => new Date(Date.parse('2026-01-02T00:00:00Z') - hoursAgo * HOUR).toISOString()
  const now = Date.parse('2026-01-02T00:00:00Z')
  const round = (task) => parkedReminderRound({ task, now, afterMs: 4 * HOUR, rounds: 3 })

  it('未到一轮间隔 → 不催', () => {
    assert.equal(round({ status: 'waiting_confirmation', parkedAt: at(3) }), 0)
  })

  it('挂起 4h / 9h → 第 1 / 2 轮', () => {
    assert.equal(round({ status: 'waiting_confirmation', parkedAt: at(4) }), 1)
    assert.equal(round({ status: 'blocked', parkedAt: at(9) }), 2)
  })

  it('本轮已催过 → 不重复催', () => {
    assert.equal(round({ status: 'blocked', parkedAt: at(5), parkedRemindedRound: 1 }), 0)
    assert.equal(round({ status: 'blocked', parkedAt: at(9), parkedRemindedRound: 1 }), 2)
  })

  it('超过最大轮次 → 停止催办（不无限刷群）', () => {
    assert.equal(round({ status: 'blocked', parkedAt: at(100) }), 0)
  })

  it('非挂起态 / 无锚点 → 不催', () => {
    assert.equal(round({ status: 'done', parkedAt: at(50) }), 0)
    assert.equal(round({ status: 'blocked' }), 0)
  })

  it('锚点回落 updatedAt（老任务无 parkedAt）仍能催', () => {
    assert.equal(round({ status: 'blocked', updatedAt: at(5) }), 1)
  })
})

describe('handleStatusUpdate 的 parkedAt 锚点', () => {
  const freshStore = () => createTaskStore({ tasksDir: mkdtempSync(join(tmpdir(), 'lark-parked-')), leaseMs: 1000 })
  // 真实项目号占位：appendNotificationLog 走 docsDir(project)，空 project 会抛；日志文件不存在则自动跳过。
  const parkedConfig = { project: 'PR-99999' }

  it('进入挂起态打锚点；同态重复回写不重置；离开挂起态清掉', async () => {
    const store = freshStore()
    store.upsert({ id: 't', status: 'running', createdAt: '2026-01-01T00:00:00Z', chatId: null })
    await handleStatusUpdate({ config: parkedConfig, store, id: 't', status: 'blocked', result: 'x' })
    const first = store.get('t').parkedAt
    assert.ok(first, '进入 blocked 应打上 parkedAt')
    assert.equal(store.get('t').waitRound, 1)
    await handleStatusUpdate({ config: parkedConfig, store, id: 't', status: 'blocked', result: 'x' })
    assert.equal(store.get('t').parkedAt, first, '同态重复回写不得重置挂起时长')
    assert.equal(store.get('t').waitRound, 1, '同态幂等回写不得增加等待轮次')
    await handleStatusUpdate({ config: parkedConfig, store, id: 't', status: 'running' })
    assert.equal(store.get('t').parkedAt, null, '离开挂起态应清掉锚点')
  })
})

describe('handleStatusUpdate no_change_needed 终态', () => {
  const freshStore = () => createTaskStore({ tasksDir: mkdtempSync(join(tmpdir(), 'lark-noop-')), leaseMs: 1000 })
  // bug 表来源 + 配了 doneValue：no_change_needed 绝不能触发 writeBackBugRecord（只有 done 才写「已修复」）。
  const config = { project: 'PR-99999', bugTable: { appToken: 'x', tableId: 'y', doneValue: '已修复' } }

  it('被 VALID_STATUSES 接纳、落终态，且 bug 表来源不写 doneValue（不标已修复）', async () => {
    const store = freshStore()
    store.upsert({ id: 't', status: 'running', source: 'lark-bugtable', recordId: 'rec1', createdAt: '2026-01-01T00:00:00Z', chatId: null })
    const outcome = await handleStatusUpdate({ config, store, id: 't', status: 'no_change_needed', result: '无需改动（不属本仓）。' })
    assert.equal(outcome.ok, true) // 未落到 invalid status 分支
    assert.equal(store.get('t').status, 'no_change_needed') // 直接落终态，未走 done→done_pending_writeback
    assert.equal(store.get('t').parkedAt, null) // 非挂起态，不打锚点
  })
})

// ---------------------------------------------------------------------------
// rotateLogIfLarge：launchd 日志轮转必须是 copy-truncate，且稀疏文件不得触发反复轮转
describe('rotateLogIfLarge（launchd 日志轮转）', () => {
  const mkLog = (bytes) => {
    const dir = mkdtempSync(join(tmpdir(), 'lark-log-'))
    const file = join(dir, 'worker.log')
    writeFileSync(file, 'x'.repeat(bytes))
    return { dir, file }
  }

  it('未超限不动文件', () => {
    const { dir, file } = mkLog(100)
    assert.equal(rotateLogIfLarge({ file, maxBytes: 1024, keep: 1 }), false)
    assert.equal(statSync(file).size, 100)
    rmSync(dir, { recursive: true, force: true })
  })

  it('超限则原文件截零、内容留在 .1（copy-truncate，不改 inode）', () => {
    const { dir, file } = mkLog(4096)
    const inodeBefore = statSync(file).ino
    assert.equal(rotateLogIfLarge({ file, maxBytes: 1024, keep: 1 }), true)
    assert.equal(statSync(file).size, 0, '当前日志应被截零')
    // inode 不变是关键：launchd 持有的那个 fd 指向 inode，rename 式轮转会让新日志永远为空。
    assert.equal(statSync(file).ino, inodeBefore, '轮转不得更换 inode')
    assert.equal(statSync(`${file}.1`).size, 4096, '旧内容应完整留在 .1')
    rmSync(dir, { recursive: true, force: true })
  })

  it('历史代按 keep 上限滚动，超出的被丢弃', () => {
    const { dir, file } = mkLog(4096)
    rotateLogIfLarge({ file, maxBytes: 1024, keep: 2 })
    writeFileSync(file, 'y'.repeat(4096))
    rotateLogIfLarge({ file, maxBytes: 1024, keep: 2 })
    assert.equal(statSync(`${file}.1`).size, 4096)
    assert.equal(statSync(`${file}.2`).size, 4096, '第一代应被推到 .2')
    rmSync(dir, { recursive: true, force: true })
  })

  it('maxBytes=0（关闭）或文件不存在时安全返回 false', () => {
    const { dir, file } = mkLog(4096)
    assert.equal(rotateLogIfLarge({ file, maxBytes: 0, keep: 1 }), false)
    assert.equal(rotateLogIfLarge({ file: join(dir, 'nope.log'), maxBytes: 1, keep: 1 }), false)
    rmSync(dir, { recursive: true, force: true })
  })
})
