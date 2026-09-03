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

import { handleStatusUpdate, resolveReceiptOutcome, retryPendingReceipts, sendQueuedReceipt } from '../lib/lark-status.mjs'
import {
  buildBugStatusFilter,
  buildBugText,
  classifyBugPollAction,
  classifyBugTaskStatus,
  readBugCommandType,
  readStatusText,
} from '../lib/lark-bugtable-parse.mjs'
import { resolveWritebackOutcome } from '../lib/lark-bugtable-writeback.mjs'
import { createTaskStore } from '../lib/lark-task-store.mjs'
import { parkedReminderRound } from '../lib/lark-parked-reminder.mjs'
import { rotateLogIfLarge } from '../lib/lark-log-rotate.mjs'
import { sweepAttachments } from '../lib/lark-retention.mjs'
import { buildResultCard, buildWaitingCard } from '../lib/lark-cards.mjs'
import { messageSendRecipientArgs, parseSentMessageId, pickChatIdByProject, resolveDeliveryChatId, formatLarkCliError, isTransientLarkError } from '../lib/lark-cli.mjs'
import {
  classifyClosureIntent,
  classifyCommandType,
  classifyPauseIntent,
  classifyReopenIntent,
  inferCommandType,
  isForBot,
  isManualResolutionMessage,
  isReadOnlyCommand,
  isReadOnlyTask,
  isWhitelisted,
  normalizeMessage,
  parseCommandType,
  parseControlDirective,
  parseResumeDirective,
  resolveCommandType,
  resolveMessageTrigger,
} from '../lib/lark-message.mjs'
import { isProjectId, matchProjectId, matchProjectIds } from '../lib/lark-project-id.mjs'
import { allRuleRefs, buildFocusedRuleContext, classifyLarkTask, extractMarkdownSection } from '../lib/lark-rule-context.mjs'
import { assessDoneResult, crossCheckChangedFiles, detectChangeTier, splitViolations } from '../lib/lark-quality-gate.mjs'
import { buildCodeRulesBlockedResult, codeRuleErrorsInDiff, formatCodeRulesLine, summarizeCodeRules } from '../lib/lark-code-rules.mjs'
import { validateConfig } from '../lib/lark-config.mjs'
import { pruneStaleAudits } from '../lib/lark-worker-audit.mjs'
import { classifyWorkerFailure } from '../lib/lark-worker-results.mjs'
import { resolveWorkContext, safeProject, tempWorktreeContextFor } from '../lib/lark-work-context.mjs'
import { decideControlAction, isRegisteredBotReceiptReply, resolveManualCloseTarget, resolveResumeTarget } from '../lib/lark-ingest.mjs'
import { isExecutionSuperseded, monitorExecutionCancellation } from '../lib/lark-task-runner.mjs'
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

  it('结果回执 pending 属于 in-flight，不会被 poller 当成新任务重复入队', () => {
    assert.equal(classifyBugTaskStatus('result_pending_receipt'), 'in-flight')
  })

  it('回写重试的三个出口：成功落 done，未到上限继续重试，到上限停在 done_pending_writeback（不伪装成完成）', () => {
    assert.deepEqual(resolveWritebackOutcome({ ok: true, attempts: 5 }), { status: 'done', attempts: 0, gaveUp: false, retry: false })
    assert.deepEqual(resolveWritebackOutcome({ ok: false, attempts: 0, max: 3 }), {
      status: 'done_pending_writeback', attempts: 1, gaveUp: false, retry: true,
    })
    // 到上限：状态**仍是中间态**——落 done 会让「群里说完成、bug 表还挂着待处理」这条不一致被 prune 抹掉
    assert.deepEqual(resolveWritebackOutcome({ ok: false, attempts: 2, max: 3 }), {
      status: 'done_pending_writeback', attempts: 3, gaveUp: true, retry: false,
    })
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

  it('无 @ 的群回复仅在精确命中 Bot 回执时进入控制通道', () => {
    const msg = { chatType: 'group', senderType: 'user', mentions: [], replyToDirect: 'om_receipt' }
    assert.equal(resolveMessageTrigger({ msg, config, isBotReceiptReply: true }), 'bot_reply')
    assert.equal(resolveMessageTrigger({ msg, config, isBotReceiptReply: false }), null)
  })
  it('bot 自己发的含 @负责人消息 → 不回流成任务', () => {
    const personConfig = { botOpenId: BOT, taskMentionOpenIds: [ME] }
    const msg = { chatType: 'group', senderType: 'bot', mentions: [{ id: ME }] }
    assert.equal(resolveMessageTrigger({ msg, config: personConfig }), null)
  })
  it('群里 @所有人（key=@_all）→ true', () => {
    assert.equal(isForBot({ msg: { chatType: 'group', mentions: [{ key: '@_all' }] }, config }), true)
  })
  it('群里 @所有人 → 只读意图分类，不直接入队', () => {
    // 群里任何人喊一句「@所有人」不该等于「让机器人改代码」；仍进 task_mention 以便接住真实反馈。
    assert.equal(resolveMessageTrigger({ msg: { chatType: 'group', mentions: [{ key: '@_all' }] }, config }), 'task_mention')
  })
  it('@所有人 同时 @bot → 仍是 direct（明确在叫机器人）', () => {
    const msg = { chatType: 'group', mentions: [{ key: '@_all' }, { id: BOT }] }
    assert.equal(resolveMessageTrigger({ msg, config }), 'direct')
  })
  it('未配置 botOpenId 时：有任意 mention 即算', () => {
    assert.equal(isForBot({ msg: { chatType: 'group', mentions: [{ id: 'x' }] }, config: {} }), true)
    assert.equal(isForBot({ msg: { chatType: 'group', mentions: [] }, config: {} }), false)
  })
  it('未配置 botOpenId 的兼容分支 → 降为只读分类而非 direct', () => {
    assert.equal(resolveMessageTrigger({ msg: { chatType: 'group', mentions: [{ id: 'x' }] }, config: {} }), 'task_mention')
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
// tempWorktreeContextFor：命中已有 worktree 但有人类 WIP 时的隔离改路由落点
// （runTask 用它把 bot 改动挪出人类脏工作区，绝不自动提交人类 WIP）
// ---------------------------------------------------------------------------
describe('tempWorktreeContextFor', () => {
  it('落点与「本地无 worktree」的默认临时 worktree 完全一致（改路由不引入新分支命名）', () => {
    const task = { project: 'PR-99999', id: 'om_zzzzzzzzABCDEFGH' }
    const rerouted = tempWorktreeContextFor(task)
    const fresh = resolveWorkContext({}, task) // PR-99999 本地无 worktree → 同一临时落点
    assert.equal(rerouted.hotfixBranch, fresh.hotfixBranch)
    assert.equal(rerouted.cwd, fresh.cwd)
    assert.ok(rerouted.hotfixBranch.startsWith('hotfix/PR-99999-'))
  })

  it('同一 task.id 恒定 → retry/补料/QA 验退复用同一隔离 worktree，不丢上一轮', () => {
    const task = { project: 'PR-99999', id: 'om_x100b68708_AAAA0001' }
    assert.equal(tempWorktreeContextFor(task).hotfixBranch, tempWorktreeContextFor(task).hotfixBranch)
    assert.notEqual(
      tempWorktreeContextFor(task).hotfixBranch,
      tempWorktreeContextFor({ ...task, id: 'om_x100b68708_AAAA0002' }).hotfixBranch,
    )
  })

  it('无项目号 → adhoc 隔离分支', () => {
    assert.ok(tempWorktreeContextFor({ id: 'om_xxxxxxxx87654321' }).hotfixBranch.startsWith('hotfix/adhoc-'))
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

  it('「汇报/报告」是常见的状态查询问法，与「汇总」同等判 status（真机漏判修复）', () => {
    // 现场发现：「汇报一下这个项目的状态」曾因 cue 词表只收「汇总」漏「汇报」→ 被当新需求拦。
    assert.equal(inferCommandType('汇报一下这个项目的状态'), 'status')
    assert.equal(inferCommandType('报告下当前项目的进度'), 'status')
    assert.equal(inferCommandType('说一下这个需求现在做到哪了'), 'status')
    // 词表扩充不得越过缺陷/写操作否决：报障、做功能仍判 null。
    assert.equal(inferCommandType('汇报下为什么项目状态一直转圈'), null) // 缺陷信号（转圈）一票否决
    assert.equal(inferCommandType('新增一个项目进度汇报页面'), null) // 写操作（新增）一票否决
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

  it('只把明确的人工完成确认识别为直接结单', () => {
    assert.equal(isManualResolutionMessage('已由另一位 AI 同学完成了，请同步更新状态'), true)
    assert.equal(isManualResolutionMessage('👍 该问题已解决'), true)
    assert.equal(isManualResolutionMessage('这个问题处理好了'), true)
    assert.equal(isManualResolutionMessage('该问题未解决'), false)
    assert.equal(isManualResolutionMessage('只完成了一部分，还需继续处理'), false)
    assert.equal(isManualResolutionMessage('请解决这个问题'), false)
    assert.equal(isManualResolutionMessage('问题解决不了怎么办？'), false)
  })

  it('classifyClosureIntent：取消/无需/外部完成语族 → close(high) + 正确 closureReason', () => {
    assert.deepEqual(classifyClosureIntent('这个不用做了'), { intent: 'close', closureReason: 'no_longer_needed', scope: 'whole_task', confidence: 'high' })
    assert.deepEqual(classifyClosureIntent('取消吧'), { intent: 'close', closureReason: 'cancelled', scope: 'whole_task', confidence: 'high' })
    assert.deepEqual(classifyClosureIntent('这个任务终止'), { intent: 'close', closureReason: 'cancelled', scope: 'whole_task', confidence: 'high' })
    assert.deepEqual(classifyClosureIntent('需求变了，先不做了'), { intent: 'close', closureReason: 'no_longer_needed', scope: 'whole_task', confidence: 'high' })
    assert.deepEqual(classifyClosureIntent('已上线了'), { intent: 'close', closureReason: 'completed_elsewhere', scope: 'whole_task', confidence: 'high' })
    assert.equal(classifyClosureIntent('已经有人在改了').intent, 'close')
    assert.equal(classifyClosureIntent('走线下处理了').intent, 'close')
    assert.equal(classifyClosureIntent('不用继续做了').intent, 'close') // 否定+继续=停，不算 partial
  })

  it('classifyClosureIntent：否定/暂停/条件未来时/转述 → unclear(不自动结单)', () => {
    assert.equal(classifyClosureIntent('不要结束，继续做').intent, 'unclear')
    assert.equal(classifyClosureIntent('先暂停一下').intent, null) // 无结单原因信号 → 非控制表达
    assert.equal(classifyClosureIntent('结束后再通知我').intent, 'unclear')
    assert.equal(classifyClosureIntent('他说不用做了，但我觉得要做').intent, 'unclear')
    assert.equal(classifyClosureIntent('还没解决').intent, null)
  })

  it('结单疑问句不自动关闭；暂停是独立控制动作', () => {
    for (const text of ['是不是已经解决了？', '这个不用做了吗？', '修复了没', '完成没', '已上线了吗', '还没有取消']) {
      assert.equal(classifyClosureIntent(text).intent, 'unclear', text)
    }
    assert.equal(classifyPauseIntent('先暂停一下'), true)
    assert.equal(classifyPauseIntent('不用继续做了'), false)
  })

  it('结单夹带新的缺陷/修改请求时保留残余请求，不静默吞掉', () => {
    for (const text of ['上个问题已解决，现在这个下拉框还是空的', '这个功能已上线后下拉框还是空的', '需求变了，按钮改成蓝色']) {
      const verdict = classifyClosureIntent(text)
      assert.equal(verdict.intent, 'close_with_residual', text)
      assert.ok(verdict.residualRequest, text)
    }
    assert.equal(classifyClosureIntent('已由另一位 AI 同学完成了，请同步更新状态').intent, 'close')
  })

  it('classifyClosureIntent：夹带「另一部分/其余继续」→ unclear + scope=partial', () => {
    const a = classifyClosureIntent('A 不用做了，B 继续')
    assert.equal(a.intent, 'unclear')
    assert.equal(a.scope, 'partial')
    const b = classifyClosureIntent('这个已解决，不过另外那个还要处理')
    assert.equal(b.intent, 'unclear')
    assert.equal(b.scope, 'partial')
  })

  it('classifyClosureIntent：弱结单信号（收工/到此为止/先放着）→ unclear + scope=suspected（轻量仲裁去确认，不猜死）', () => {
    for (const text of ['收工', '就到此为止', '这个先放着吧', '行吧就这样吧', '这事就到这了', '不弄这个了']) {
      const v = classifyClosureIntent(text)
      assert.equal(v.intent, 'unclear', `弱信号「${text}」应升级为 unclear`)
      assert.equal(v.scope, 'suspected', `弱信号「${text}」scope 应为 suspected`)
      assert.equal(v.closureReason, 'cancelled')
    }
  })

  it('classifyClosureIntent：弱信号叠加否决门（先别收工）→ 仍为 null（= 继续，不该问「要结单吗」）', () => {
    assert.equal(classifyClosureIntent('先别收工，继续做').intent, null)
    assert.equal(classifyClosureIntent('别放着，接着弄').intent, null)
    // 普通补料不含弱信号 → 仍是 null，不误升级为 confirm
    assert.equal(classifyClosureIntent('把按钮改成蓝色').intent, null)
  })
})

describe('resolveManualCloseTarget', () => {
  const task = { id: 't', status: 'queued' }
  const makeStore = ({ byId = {}, byReceipt = {}, byAnyReceipt = {}, active = [] } = {}) => ({
    get: (id) => byId[id] || null,
    findByReceiptMessageId: (id) => byReceipt[id] || null,
    findTaskByAnyReceipt: (id) => byAnyReceipt[id] || null,
    listActiveByThread: () => active,
  })

  it('直接回复排队/待确认回执时精确命中原任务', () => {
    const store = makeStore({ byReceipt: { om_card: task } })
    assert.equal(resolveManualCloseTarget({ msg: { replyToDirect: 'om_card' }, store }), task)
  })

  it('回复原任务消息或仅有线程根时也能命中', () => {
    const store = makeStore({ byId: { t: task } })
    assert.equal(resolveManualCloseTarget({ msg: { replyToDirect: 't' }, store }), task)
    assert.equal(resolveManualCloseTarget({ msg: { replyTo: 't' }, store }), task)
  })

  it('忽略代次的回执反查：回复旧代次卡（findTaskByAnyReceipt）仍能命中', () => {
    const store = makeStore({ byAnyReceipt: { om_old: task } }) // findByReceiptMessageId 因 epoch 不匹配返回 null
    assert.equal(resolveManualCloseTarget({ msg: { replyToDirect: 'om_old' }, store }), task)
  })

  it('无直接锚点时，同话题恰好一条活动任务才归并', () => {
    const one = makeStore({ active: [task] })
    assert.equal(resolveManualCloseTarget({ msg: { threadRootId: 'th', messageId: 'm' }, store: one }), task)
    const many = makeStore({ active: [task, { id: 't2', status: 'running' }] })
    assert.equal(resolveManualCloseTarget({ msg: { threadRootId: 'th', messageId: 'm' }, store: many }), null)
  })

  it('无明确回复关联时不猜测目标', () => {
    assert.equal(resolveManualCloseTarget({ msg: {}, store: makeStore() }), null)
  })

  it('direct 精确锚定失败时回落到同话题唯一活动任务', () => {
    const active = { id: 'task-a', status: 'running' }
    const store = {
      findTaskByAnyReceipt: () => null,
      findByReceiptMessageId: () => null,
      get: () => null,
      listActiveByThread: () => [active],
    }
    assert.equal(resolveManualCloseTarget({ msg: { replyToDirect: 'unknown', replyTo: 'unknown', threadRootId: 'th' }, store }), active)
  })
})

// ---------------------------------------------------------------------------
// decideControlAction：任务控制通道路由 + 硬不变量（回复活动任务卡永不 fall through 新建任务）
// ---------------------------------------------------------------------------
describe('decideControlAction', () => {
  const ACTIVE = ['received', 'queued', 'running', 'verifying', 'waiting_confirmation', 'blocked', 'failed']
  const TERMINAL = ['done', 'superseded', 'ignored', 'no_change_needed']

  it('无锚定 → passthrough', () => {
    assert.equal(decideControlAction({ target: null, verdict: { intent: 'close' } }), 'passthrough')
  })

  it('结单意图对任意状态都走 close（终态由 store 幂等挡回）', () => {
    for (const status of [...ACTIVE, ...TERMINAL]) {
      assert.equal(decideControlAction({ target: { status }, verdict: { intent: 'close', closureReason: 'cancelled' } }), 'close')
    }
  })

  it('硬不变量：活动态任务被锚定时，任何非结单意图都不 passthrough（绝不新建任务）', () => {
    for (const status of ACTIVE) {
      for (const intent of ['unclear', null]) {
        const action = decideControlAction({ target: { status }, verdict: { intent } })
        assert.notEqual(action, 'passthrough', `status=${status} intent=${intent} 不应 passthrough`)
      }
    }
  })

  it('活动态路由：unclear→confirm；parked 无结单→resume；其它活动态无结单→notice', () => {
    assert.equal(decideControlAction({ target: { status: 'running' }, verdict: { intent: 'unclear' } }), 'confirm')
    assert.equal(decideControlAction({ target: { status: 'waiting_confirmation' }, verdict: { intent: null } }), 'resume')
    assert.equal(decideControlAction({ target: { status: 'blocked' }, verdict: { intent: null } }), 'resume')
    assert.equal(decideControlAction({ target: { status: 'queued' }, verdict: { intent: null } }), 'notice')
  })

  it('暂停与混合结单分别走独立动作', () => {
    assert.equal(decideControlAction({ target: { status: 'blocked' }, verdict: { intent: null }, pause: true }), 'pause')
    assert.equal(decideControlAction({ target: { status: 'running' }, verdict: { intent: 'close_with_residual' } }), 'close_with_residual')
    assert.equal(decideControlAction({ target: { status: 'done' }, verdict: { intent: 'unclear' } }), 'confirm')
  })

  it('终态任务 + 普通新请求 → passthrough（允许在已了结话题里发起真正的新请求）', () => {
    for (const status of TERMINAL) {
      assert.equal(decideControlAction({ target: { status }, verdict: { intent: null } }), 'passthrough')
    }
  })

  it('误结单可逆：回复「人工结单」任务且有重开意图 → reopen；无重开意图仍 passthrough', () => {
    const closed = { status: 'superseded', externalResolution: { closureReason: 'cancelled' } }
    assert.equal(decideControlAction({ target: closed, verdict: { intent: null }, reopen: true }), 'reopen')
    assert.equal(decideControlAction({ target: closed, verdict: { intent: null }, reopen: false }), 'passthrough')
  })

  it('重开意图只对「人工结单」任务生效：兄弟归并 superseded / done 不可重开 → passthrough', () => {
    // 兄弟归并 supersede 无 externalResolution，done 也非人工结单 → 重开信号不复活，放行老路径
    assert.equal(decideControlAction({ target: { status: 'superseded', supersededBy: 'x' }, verdict: { intent: null }, reopen: true }), 'passthrough')
    assert.equal(decideControlAction({ target: { status: 'done' }, verdict: { intent: null }, reopen: true }), 'passthrough')
  })
})

// ---------------------------------------------------------------------------
// parseControlDirective / classifyReopenIntent：L3 显式控制指令 + 重开意图
// ---------------------------------------------------------------------------
describe('parseControlDirective', () => {
  it('取消任务/撤销 → close + cancelled；结单/关闭任务 → close + completed_elsewhere', () => {
    assert.deepEqual(parseControlDirective('取消任务 om_abcd'), { action: 'close', taskId: 'om_abcd', closureReason: 'cancelled', supplementText: '' })
    assert.deepEqual(parseControlDirective('撤销 om_abcd'), { action: 'close', taskId: 'om_abcd', closureReason: 'cancelled', supplementText: '' })
    assert.deepEqual(parseControlDirective('结单 om_abcd'), { action: 'close', taskId: 'om_abcd', closureReason: 'completed_elsewhere', supplementText: '' })
    assert.deepEqual(parseControlDirective('关闭任务：om_abcd'), { action: 'close', taskId: 'om_abcd', closureReason: 'completed_elsewhere', supplementText: '' })
  })

  it('重开任务/reopen → reopen，可带残余说明', () => {
    assert.deepEqual(parseControlDirective('重开任务 om_abcd'), { action: 'reopen', taskId: 'om_abcd', closureReason: null, supplementText: '' })
    assert.deepEqual(parseControlDirective('reopen om_abcd 其实还要做'), { action: 'reopen', taskId: 'om_abcd', closureReason: null, supplementText: '其实还要做' })
  })

  it('无合法 taskId / 普通正文 → null（不误触发结单）', () => {
    assert.equal(parseControlDirective('取消'), null) // 无 id
    assert.equal(parseControlDirective('这个功能取消了吧'), null) // 动词不在句首
    assert.equal(parseControlDirective('帮我改一下这个页面'), null)
    assert.equal(parseControlDirective(''), null)
  })
})

describe('classifyReopenIntent', () => {
  it('明确重开/恢复/纠错措辞 → true', () => {
    for (const t of ['重开这个任务', '重新做一下', '恢复执行吧', '其实还要做', '关错了', '误关了', '不该取消的']) {
      assert.equal(classifyReopenIntent(t), true, t)
    }
  })
  it('普通补料/结单/空 → false（避免把续跑误判成重开）', () => {
    for (const t of ['继续下一步', '补充一下需求', '取消吧', '', '这个已解决']) {
      assert.equal(classifyReopenIntent(t), false, t)
    }
  })
})

// ---------------------------------------------------------------------------
// isExecutionSuperseded：running 中协作式取消检测（提交前回查，防已取消任务提代码）
// ---------------------------------------------------------------------------
describe('isExecutionSuperseded', () => {
  it('人工结单落 superseded → true（无论 epoch）', () => {
    assert.equal(isExecutionSuperseded({ current: { status: 'superseded', epoch: 2 }, claimedEpoch: 2 }), true)
  })
  it('换代（epoch 变了：retry/resume/reclaim）→ true', () => {
    assert.equal(isExecutionSuperseded({ current: { status: 'running', epoch: 3 }, claimedEpoch: 2 }), true)
    assert.equal(isExecutionSuperseded({ current: { status: 'queued', epoch: 3 }, claimedEpoch: 2 }), true)
  })
  it('同代次仍在跑 / 正常完成 → false（不误弃）', () => {
    assert.equal(isExecutionSuperseded({ current: { status: 'running', epoch: 2 }, claimedEpoch: 2 }), false)
    assert.equal(isExecutionSuperseded({ current: { status: 'done', epoch: 2 }, claimedEpoch: 2 }), false)
  })
  it('读不到当前任务（网关瞬时不可达）→ false，交由 epoch/409 回写兜底，不误判取消', () => {
    assert.equal(isExecutionSuperseded({ current: null, claimedEpoch: 2 }), false)
    assert.equal(isExecutionSuperseded({}), false)
  })
  it('epoch 缺省按 0 比较（旧任务无 epoch 字段）', () => {
    assert.equal(isExecutionSuperseded({ current: { status: 'running' }, claimedEpoch: undefined }), false)
    assert.equal(isExecutionSuperseded({ current: { status: 'running', epoch: 1 }, claimedEpoch: 0 }), true)
  })
})

describe('monitorExecutionCancellation', () => {
  it('AI 运行中检测到 superseded 后 abort', async () => {
    const controller = new AbortController()
    let checks = 0
    const stop = monitorExecutionCancellation({
      getTask: async () => ({ status: ++checks >= 2 ? 'superseded' : 'running', epoch: checks >= 2 ? 2 : 1 }),
      taskId: 't1',
      claimedEpoch: 1,
      controller,
      intervalMs: 10,
    })
    await new Promise((resolve) => setTimeout(resolve, 130))
    stop()
    assert.equal(controller.signal.aborted, true)
  })
})

describe('Bot receipt reply admission', () => {
  it('用持久回执索引限制无 @ 控制入口', () => {
    const msg = { replyToDirect: 'om_receipt' }
    assert.equal(isRegisteredBotReceiptReply({ msg, store: { findTaskByAnyReceipt: () => ({ id: 't1' }) } }), true)
    assert.equal(isRegisteredBotReceiptReply({ msg, store: { findTaskByAnyReceipt: () => null, findByReceiptMessageId: () => null } }), false)
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

  it('仅有线程根 root_id（无 reply_to）：命中回执或原任务消息且仍待确认/阻塞才锚定', () => {
    // root_id 命中待确认回执 → 锚定
    assert.equal(resolveResumeTarget({ msg: { replyTo: 'root' }, store: makeStore({ byReceipt: { root: parked } }) }).task, parked)
    // root_id 就是原任务消息本身且任务仍卡着（话题内直接发补料，Lark 不带 reply_to）→ 锚定，不建孤儿任务
    assert.equal(resolveResumeTarget({ msg: { replyTo: 'w' }, store: makeStore({ byId: { w: parked } }) }).task, parked)
    // 话题根是一条已完成的任务 → 视作线程内新请求，不劫持
    assert.equal(resolveResumeTarget({ msg: { replyTo: 'd' }, store: makeStore({ byId: { d: done } }) }), null)
    // root_id 不对应任何任务 → 不锚定
    assert.equal(resolveResumeTarget({ msg: { replyTo: 'om_other' }, store: makeStore({ byId: { w: parked } }) }), null)
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

describe('sendQueuedReceipt', () => {
  it('排队卡发送成功后保存 message_id 与发送时 epoch', async () => {
    let recorded
    const task = { id: 't1', chatId: 'oc_1', project: 'PR-01930', summary: '测试任务', epoch: 2 }
    const receipt = await sendQueuedReceipt({
      config: { project: 'PR-01930', title: '测试' },
      store: { recordReceipt: (id, value) => { recorded = { id, ...value } } },
      task,
      sendMessage: async () => ({ ok: true, messageId: 'om_queued' }),
    })
    assert.equal(receipt.ok, true)
    assert.deepEqual(recorded, { id: 't1', messageId: 'om_queued', kind: 'queued', epoch: 2 })
  })

  it('发送失败或未返回 message_id 时不伪造关联', async () => {
    let recorded = false
    await sendQueuedReceipt({
      config: { project: 'PR-01930', title: '测试' },
      store: { recordReceipt: () => { recorded = true } },
      task: { id: 't1', chatId: 'oc_1', project: 'PR-01930', summary: '测试任务' },
      sendMessage: async () => ({ ok: false, reason: 'network' }),
    })
    assert.equal(recorded, false)
  })
})

// bug 表跨项目路由：按项目号反查项目群 chat_id（回执/结果卡发到对的群，而非固定通知群）
describe('pickChatIdByProject（项目号 → 项目群反查）', () => {
  const chats = new Map([
    ['oc_02031', '8.26上OL [PR-02031] 管理后台支持体验金手动失效'],
    ['oc_01947', '【8.21上线】[PR-01947]【跟单】跟单设置优化（保证金/杠杆/复制仓位）'],
    ['oc_noise', '闲聊群'],
  ])

  it('命中项目号 → 返回该项目自己的群，不串到别的项目群', () => {
    assert.equal(pickChatIdByProject(chats, 'PR-01947'), 'oc_01947')
    assert.equal(pickChatIdByProject(chats, 'PR-02031'), 'oc_02031')
  })

  it('大小写归一：小写项目号也命中', () => {
    assert.equal(pickChatIdByProject(chats, 'pr-01947'), 'oc_01947')
  })

  it('无对应项目群 / 空项目号 → 返回 ""（由调用方回落到通知群）', () => {
    assert.equal(pickChatIdByProject(chats, 'PR-09999'), '')
    assert.equal(pickChatIdByProject(chats, ''), '')
    assert.equal(pickChatIdByProject(chats, undefined), '')
  })
})

// 收信方按 id 前缀择群/私聊：ou_ 走 --user-id 私聊负责人（bug 兜底），其余 oc_ 群走 --chat-id
describe('messageSendRecipientArgs（chat_id / open_id 择参）', () => {
  it('ou_ 开头 → --user-id 私聊', () => {
    assert.deepEqual(messageSendRecipientArgs('ou_91861d6da6cf6822e08045ba1868241e'), ['--user-id', 'ou_91861d6da6cf6822e08045ba1868241e'])
  })

  it('oc_ 群 → --chat-id', () => {
    assert.deepEqual(messageSendRecipientArgs('oc_51e2bcf0ed6a772c402d6cacd43176b3'), ['--chat-id', 'oc_51e2bcf0ed6a772c402d6cacd43176b3'])
  })

  it('空/缺失 → 仍归为 --chat-id（由 sendChatMessage 的 missing 校验拦下）', () => {
    assert.deepEqual(messageSendRecipientArgs(''), ['--chat-id', ''])
    assert.deepEqual(messageSendRecipientArgs(undefined), ['--chat-id', ''])
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

describe('matchProjectIds（全部项目号，用于判「正文是否明确指向唯一项目」）', () => {
  it('去重 + 大写归一 + 保持出现顺序', () => {
    assert.deepEqual(matchProjectIds('pr-01947 与 PM-1469 都提到过 PR-01947'), ['PR-01947', 'PM-1469'])
  })
  it('恰好一个 → 正文可作权威来源；多个 → 视为引用，调用方回落群名', () => {
    assert.deepEqual(matchProjectIds('PR-02306 这个页面报错'), ['PR-02306'])
    assert.equal(matchProjectIds('参考 PR-01947 的做法改 PR-02306').length, 2)
  })
  it('无项目号 / 空输入 → 空数组（不抛错）', () => {
    assert.deepEqual(matchProjectIds('没有项目号'), [])
    assert.deepEqual(matchProjectIds(null), [])
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
// 终态结果卡登记为回执：回复一条已完成/失败/无需改动的结果卡说「取消任务」时，控制通道要能锚定回原任务，
// 幂等回「已结束、未新建」，而不是 fall through 新建一条名为「取消任务」的任务。
// ---------------------------------------------------------------------------
describe('终态结果卡回执可锚定', () => {
  const cardConfig = { project: 'PR-TEST', title: '任务', bugTable: {} }
  for (const status of ['done', 'failed', 'no_change_needed']) {
    it(`${status} 结果卡的 messageId 被登记为回执，findTaskByAnyReceipt 可反查`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'lark-gw-term-'))
      const store = createTaskStore({ tasksDir: dir, leaseMs: 1000 })
      store.upsert({ id: 't-term', status: 'running', epoch: 0, chatId: 'oc_x', summary: '原任务', createdAt: '2026-01-01T00:00:00Z' })
      const sendMessage = async () => ({ ok: true, messageId: `om_result_${status}` })
      const outcome = await handleStatusUpdate({ config: cardConfig, store, id: 't-term', status, epoch: 0, result: '结束。', sendMessage })
      assert.equal(outcome.ok, true)
      const anchored = store.findTaskByAnyReceipt(`om_result_${status}`)
      assert.ok(anchored, `回复 ${status} 结果卡应能经回执锚定回原任务，否则控制通道会新建任务`)
      assert.equal(anchored.id, 't-term')
      rmSync(dir, { recursive: true, force: true })
    })
  }
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
  it('L2 契约/共享改动但 AI checks 不含 type-check → 不可信，降级人工复核（不再是 note 级）', () => {
    const a = assessDoneResult({
      reportedChangedFiles: ['x.schema.ts'],
      actualChangedFiles: ['x.schema.ts'],
      checks: ['biome', '单测通过'],
    })
    assert.equal(a.trustworthy, false)
    assert.equal(a.tier, 'L2')
    assert.ok(a.notes.some((n) => /type-check/.test(n)))
  })
  it('L2 契约/共享改动且 checks 含 tsc → 可信、无 type-check note', () => {
    const a = assessDoneResult({
      reportedChangedFiles: ['x.schema.ts'],
      actualChangedFiles: ['x.schema.ts'],
      checks: ['tsc --noEmit 通过'],
    })
    assert.equal(a.trustworthy, true)
    assert.ok(!a.notes.some((n) => /type-check/.test(n)))
  })
  it('L1 改动缺 type-check 不受影响（type-check 闸只作用于契约/共享改动）', () => {
    const a = assessDoneResult({
      reportedChangedFiles: ['a.tsx'],
      actualChangedFiles: ['a.tsx'],
      checks: [],
    })
    assert.equal(a.trustworthy, true)
    assert.equal(a.tier, 'L1')
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
// changed-file 静态扫描摘要（D5）：非阻断，但卡片上的数字必须如实
// ---------------------------------------------------------------------------
describe('summarizeCodeRules / formatCodeRulesLine（bot 改动过一次同一把静态尺子）', () => {
  it('按 severity 计数，note 不进点名清单，ruleId 去重', () => {
    const summary = summarizeCodeRules({
      changedFiles: ['a.tsx', 'b.ts'],
      findings: [
        { severity: 'error', ruleId: 'CODE-ANY-001' },
        { severity: 'warn', ruleId: 'CODE-I18N-002' },
        { severity: 'warn', ruleId: 'CODE-I18N-002' },
        { severity: 'note', ruleId: 'CODE-OLD-009' },
        { severity: 'future-level', ruleId: 'CODE-NEW-001' },
      ],
    })
    assert.deepEqual(
      { ok: summary.ok, error: summary.error, warn: summary.warn, note: summary.note, other: summary.other, changedFiles: summary.changedFiles },
      { ok: false, error: 1, warn: 2, note: 1, other: 1, changedFiles: 2 },
    )
    assert.deepEqual(summary.ruleIds, ['CODE-ANY-001', 'CODE-I18N-002', 'CODE-NEW-001'])
    assert.deepEqual(summary.errorFindings, [{ ruleId: 'CODE-ANY-001', file: '', line: 0 }], 'errorFindings 只收 error 级，缺 file/line 归一为 空/0')
  })
  it('无 finding → ok 且计数全 0', () => {
    const summary = summarizeCodeRules({ changedFiles: ['a.ts'], findings: [] })
    assert.deepEqual({ ok: summary.ok, error: summary.error, warn: summary.warn }, { ok: true, error: 0, warn: 0 })
  })
  it('未跑成时如实说未跑成，绝不渲染成 0 违规', () => {
    const line = formatCodeRulesLine({ ran: false, reason: '扫描输出无法解析' })
    assert.match(line, /未跑成/)
    assert.ok(!line.includes('error 0'), '扫描没跑成不能显示成零违规')
  })
  it('跑成时把 error/warn 计数与命中规则写进卡片行', () => {
    const line = formatCodeRulesLine(summarizeCodeRules({
      changedFiles: ['a.tsx'],
      findings: [{ severity: 'warn', ruleId: 'CODE-I18N-002' }],
    }))
    assert.match(line, /改动 1 文件/)
    assert.match(line, /error 0 · warn 1/)
    assert.match(line, /CODE-I18N-002/)
  })
})

describe('codeRuleErrorsInDiff / buildCodeRulesBlockedResult（文件级归因硬闸）', () => {
  const summary = summarizeCodeRules({
    changedFiles: ['apps/web/src/a.tsx', 'apps/web/src/legacy.ts'],
    findings: [
      { severity: 'error', ruleId: 'CODE-MSW-002', file: 'apps/web/src/a.tsx', line: 12 },
      { severity: 'error', ruleId: 'CODE-MSW-002', file: 'apps/web/src/legacy.ts', line: 3 },
      { severity: 'warn', ruleId: 'CODE-I18N-002', file: 'apps/web/src/a.tsx', line: 8 },
    ],
  })
  it('只挑出 error 且文件落在本次实测改动清单里的 finding', () => {
    const hits = codeRuleErrorsInDiff({ summary, changedFiles: ['apps/web/src/a.tsx'] })
    assert.deepEqual(hits.map((h) => h.ruleId), ['CODE-MSW-002'], '本次只改了 a.tsx，legacy.ts 的存量 error 不该命中')
    assert.equal(hits[0].file, 'apps/web/src/a.tsx')
  })
  it('本次改动文件无 error → 空（warn 不算，存量 error 不算）', () => {
    const warnOnly = summarizeCodeRules({ changedFiles: ['a.tsx'], findings: [{ severity: 'warn', ruleId: 'X', file: 'a.tsx' }] })
    assert.deepEqual(codeRuleErrorsInDiff({ summary: warnOnly, changedFiles: ['a.tsx'] }), [])
  })
  it('ran=false（扫描没跑成）恒不命中——降级环境不误伤', () => {
    assert.deepEqual(codeRuleErrorsInDiff({ summary: { ran: false, reason: '缺 rg' }, changedFiles: ['a.tsx'] }), [])
  })
  it('缺参数安全返回空', () => {
    assert.deepEqual(codeRuleErrorsInDiff({}), [])
    assert.deepEqual(codeRuleErrorsInDiff({ summary, changedFiles: null }), [])
  })
  it('阻断卡如实点名 ruleId:file:line 与两条出口，带任务号', () => {
    const hits = codeRuleErrorsInDiff({ summary, changedFiles: ['apps/web/src/a.tsx'] })
    const text = buildCodeRulesBlockedResult({ id: 'PR-02306-1' }, hits)
    assert.match(text, /PR-02306-1/)
    assert.match(text, /命中 1 处 error/)
    assert.match(text, /CODE-MSW-002 apps\/web\/src\/a\.tsx:12/)
    assert.match(text, /rule-waivers\.json/)
  })
})

describe('validateConfig（启动期配置结构校验）', () => {
  const base = {
    project: 'PR-02306',
    botOpenId: 'ou_bot',
    allowedChatIds: 'auto',
    bugTable: { appToken: 'app', tableId: 'tbl', statusField: '状态', assigneeField: '负责人', doneValue: '已处理' },
  }
  it('合法配置：无 error 无 warning', () => {
    const { errors, warnings } = validateConfig(base)
    assert.deepEqual(errors, [])
    assert.deepEqual(warnings, [])
  })
  it('project 缺失 / 空串 → error', () => {
    assert.ok(validateConfig({ ...base, project: undefined }).errors.some((e) => e.includes('project')))
    assert.ok(validateConfig({ ...base, project: '  ' }).errors.some((e) => e.includes('project')))
  })
  it('非对象 config → 单条 error', () => {
    assert.deepEqual(validateConfig(null).errors, ['config 必须是对象'])
    assert.deepEqual(validateConfig([]).errors, ['config 必须是对象'])
  })
  it('allowedChatIds 只接受 "auto" 或字符串数组', () => {
    assert.deepEqual(validateConfig({ ...base, allowedChatIds: ['oc_1', 'oc_2'] }).errors, [])
    assert.ok(validateConfig({ ...base, allowedChatIds: 123 }).errors.some((e) => e.includes('allowedChatIds')))
  })
  it('taskMentionOpenIds 非字符串数组 → error', () => {
    assert.ok(validateConfig({ ...base, taskMentionOpenIds: [1, 2] }).errors.some((e) => e.includes('taskMentionOpenIds')))
  })
  it('botOpenId 缺失 → 只 warning 不 error（有只读降级兼容）', () => {
    const { errors, warnings } = validateConfig({ ...base, botOpenId: undefined })
    assert.deepEqual(errors, [])
    assert.ok(warnings.some((w) => w.includes('botOpenId')))
  })
  it('bugTable 配了就得配全 appToken/tableId/statusField/assigneeField', () => {
    const { errors } = validateConfig({ ...base, bugTable: { appToken: 'app' } })
    for (const field of ['tableId', 'statusField', 'assigneeField']) {
      assert.ok(errors.some((e) => e.includes(`bugTable.${field}`)), `应报 bugTable.${field} 缺失`)
    }
    assert.ok(!errors.some((e) => e.includes('bugTable.appToken')), 'appToken 已配不该报缺失')
  })
  it('bugTable.doneValue 缺失 → 只 warning（回写有优雅降级）', () => {
    const { errors, warnings } = validateConfig({ ...base, bugTable: { ...base.bugTable, doneValue: undefined } })
    assert.deepEqual(errors, [])
    assert.ok(warnings.some((w) => w.includes('doneValue')))
  })
  it('无 bugTable → 合法（bug 表集成可选，poller 侧另有刚需校验）', () => {
    assert.deepEqual(validateConfig({ ...base, bugTable: undefined }).errors, [])
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
    const expectedTopicSources = [
      ['~/.ai-rules/skills/coding-quality/references/reuse-before-new-ui.md', '# Reuse Before New UI'],
      ['~/.ai-rules/skills/coding-quality/references/i18n-keys.md', '# i18n Keys Are What-You-See-In-Source (i18n Ally WYSIWYG)'],
      ['~/.ai-rules/skills/coding-quality/references/copy-contracts.md', '# Copy Contracts'],
      ['~/.ai-rules/skills/coding-quality/references/styling-visual-qa.md', '# Styling And Visual QA'],
      ['~/.ai-rules/skills/coding-quality/references/api-schema-mapper.md', '# API Schema And Mapper Checks'],
      ['~/.ai-rules/skills/coding-quality/references/state-derivation-lookup.md', '# State Derivation And Lookup Resolvers'],
    ]
    for (const [path, section] of expectedTopicSources) {
      assert.ok(ctx.sources.some((source) => source.path === path && source.section === section), `专题规则未加载：${path} · ${section}`)
    }
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

  it('superseded（同话题收尾终态）→ 恒不催，即便还带着旧 parkedAt', () => {
    // supersede() 会清掉 parkedAt，但即使残留旧锚点，superseded 不在 PARKED_STATUSES → 恒 0。
    assert.equal(round({ status: 'superseded', parkedAt: at(50) }), 0)
    assert.equal(round({ status: 'superseded', parkedAt: at(4), parkedRemindedRound: 0 }), 0)
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
    const sendMessage = async () => ({ ok: true })
    await handleStatusUpdate({ config: parkedConfig, store, id: 't', status: 'blocked', result: 'x', sendMessage })
    const first = store.get('t').parkedAt
    assert.ok(first, '进入 blocked 应打上 parkedAt')
    assert.equal(store.get('t').waitRound, 1)
    await handleStatusUpdate({ config: parkedConfig, store, id: 't', status: 'blocked', result: 'x', sendMessage })
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
    const outcome = await handleStatusUpdate({
      config,
      store,
      id: 't',
      status: 'no_change_needed',
      result: '无需改动。',
      sendMessage: async () => ({ ok: true }),
    })
    assert.equal(outcome.ok, true) // 未落到 invalid status 分支
    assert.equal(store.get('t').status, 'no_change_needed') // 直接落终态，未走 done→done_pending_writeback
    assert.equal(store.get('t').parkedAt, null) // 非挂起态，不打锚点
  })
})

describe('任务回执持久化重试', () => {
  const freshStore = () => createTaskStore({ tasksDir: mkdtempSync(join(tmpdir(), 'lark-receipt-')), leaseMs: 1000 })

  it('发送失败不落可清理终态，重试成功后才恢复最终状态', async () => {
    const store = freshStore()
    store.upsert({ id: 't', status: 'running', epoch: 2, project: 'PR-99999', summary: 'fix', chatId: 'oc_x', createdAt: '2026-01-01T00:00:00Z' })
    const first = await handleStatusUpdate({
      config: { project: 'PR-99999' },
      store,
      id: 't',
      status: 'done',
      result: '完成',
      epoch: 2,
      sendMessage: async () => ({ ok: false, reason: 'network down' }),
    })
    assert.equal(first.receiptPending, true)
    assert.equal(store.get('t').status, 'result_pending_receipt')
    assert.equal(store.get('t').pendingReceipt.attempts, 1)
    assert.equal(store.get('t').pendingReceipt.epoch, 2)
    assert.equal(store.get('t').pendingReceipt.idempotencyKey, 't-e2-done')

    await retryPendingReceipts({
      config: { project: 'PR-99999' },
      store,
      sendMessage: async () => ({ ok: true, messageId: 'om_receipt' }),
    })
    assert.equal(store.get('t').status, 'done')
    assert.equal(store.get('t').pendingReceipt, undefined)
    assert.equal(store.get('t').lastDeliveredReceipt.idempotencyKey, 't-e2-done')
  })

  it('达到上限后保持 pending 并停止自动重试', () => {
    assert.deepEqual(resolveReceiptOutcome({ ok: false, attempts: 2, max: 3 }), {
      attempts: 3,
      gaveUp: true,
      retry: false,
    })
  })

  it('旧回执请求返回时不得覆盖更新一代的 pending', async () => {
    const store = freshStore()
    const oldPending = {
      status: 'blocked',
      result: '旧阻塞',
      epoch: 1,
      idempotencyKey: 't-e1-blk',
      attempts: 1,
      gaveUp: false,
    }
    store.upsert({
      id: 't',
      status: 'blocked',
      epoch: 1,
      project: 'PR-99999',
      summary: 'fix',
      chatId: 'oc_x',
      pendingReceipt: oldPending,
      createdAt: '2026-01-01T00:00:00Z',
    })

    let releaseSend
    const sending = retryPendingReceipts({
      config: { project: 'PR-99999' },
      store,
      sendMessage: () => new Promise((resolve) => { releaseSend = resolve }),
    })
    while (!releaseSend) await new Promise((resolve) => setImmediate(resolve))
    store.get('t').pendingReceipt = {
      status: 'done',
      result: '新完成',
      epoch: 2,
      idempotencyKey: 't-e2-done',
      attempts: 1,
      gaveUp: false,
    }
    store.upsert(store.get('t'))
    releaseSend({ ok: true, messageId: 'om_old' })
    await sending

    assert.equal(store.get('t').pendingReceipt.status, 'done')
    assert.equal(store.get('t').pendingReceipt.idempotencyKey, 't-e2-done')
  })

  it('waiting 回执发送期间任务换代时，不登记旧卡也不重新制造 pending', async () => {
    const store = freshStore()
    store.upsert({
      id: 't',
      status: 'running',
      epoch: 1,
      project: 'PR-99999',
      summary: 'fix',
      chatId: 'oc_x',
      text: 'x',
      createdAt: '2026-01-01T00:00:00Z',
    })

    let releaseSend
    const updating = handleStatusUpdate({
      config: { project: 'PR-99999' },
      store,
      id: 't',
      status: 'blocked',
      result: '等待补料',
      epoch: 1,
      sendMessage: () => new Promise((resolve) => { releaseSend = resolve }),
    })
    while (!releaseSend) await new Promise((resolve) => setImmediate(resolve))
    store.retry('t')
    releaseSend({ ok: true, messageId: 'om_old' })
    const outcome = await updating

    assert.equal(outcome.receiptSuperseded, true)
    assert.equal(store.get('t').status, 'queued')
    assert.equal(store.get('t').epoch, 2)
    assert.equal(store.get('t').pendingReceipt, undefined)
    assert.equal(store.findByReceiptMessageId('om_old'), null)
  })

  it('已持久化 delivered marker 时直接结算残留 pending，不重复发送', async () => {
    const store = freshStore()
    store.upsert({
      id: 't',
      status: 'result_pending_receipt',
      epoch: 3,
      project: 'PR-99999',
      summary: 'fix',
      chatId: 'oc_x',
      pendingReceipt: { status: 'done', epoch: 3, idempotencyKey: 't-e3-done', attempts: 1, gaveUp: false },
      lastDeliveredReceipt: { status: 'done', epoch: 3, idempotencyKey: 't-e3-done', deliveredAt: '2026-01-01T00:00:00Z' },
      createdAt: '2026-01-01T00:00:00Z',
    })
    let sends = 0
    await retryPendingReceipts({
      config: { project: 'PR-99999' },
      store,
      sendMessage: async () => { sends += 1; return { ok: true } },
    })
    assert.equal(sends, 0)
    assert.equal(store.get('t').status, 'done')
    assert.equal(store.get('t').pendingReceipt, undefined)
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

// sweepAttachments：按目录 mtime TTL 清理各项目 lark-attachments，天然连孤儿一起回收
describe('sweepAttachments（附件保留期清扫）', () => {
  const mkAttach = (prdsRoot, project, msgId, ageMs, now) => {
    const dir = join(prdsRoot, project, 'agent/lark-attachments', msgId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '1.img'), 'x')
    const t = (now - ageMs) / 1000
    utimesSync(dir, t, t)
    return dir
  }

  it('只删 mtime 超过保留期的 <msgId> 目录，保留期内的不动', () => {
    const now = 1_000_000_000_000
    const prdsRoot = mkdtempSync(join(tmpdir(), 'lark-retention-'))
    const maxAgeMs = 7 * 24 * 3600000
    const oldDir = mkAttach(prdsRoot, 'PR-00001', 'om_old', maxAgeMs + 3600000, now) // 超期
    const freshDir = mkAttach(prdsRoot, 'PR-00001', 'om_fresh', 3600000, now) // 1h 前，保留
    const orphanDir = mkAttach(prdsRoot, 'PR-00002', 'om_orphan', maxAgeMs * 2, now) // 别的项目的孤儿，超期

    const { removed, freedDirs } = sweepAttachments({ prdsRoot, maxAgeMs, now })
    assert.equal(removed, 2)
    assert.equal(existsSync(oldDir), false)
    assert.equal(existsSync(orphanDir), false)
    assert.equal(existsSync(freshDir), true, '保留期内的附件不应被删')
    assert.ok(freedDirs.includes(oldDir) && freedDirs.includes(orphanDir))
    rmSync(prdsRoot, { recursive: true, force: true })
  })

  it('根不存在 / maxAgeMs<=0 时安全返回 0，不误删', () => {
    assert.deepEqual(sweepAttachments({ prdsRoot: '/no/such/root', maxAgeMs: 1000 }), { removed: 0, freedDirs: [] })
    const prdsRoot = mkdtempSync(join(tmpdir(), 'lark-retention-'))
    const dir = mkAttach(prdsRoot, 'PR-00001', 'om_x', 999 * 24 * 3600000, 1_000_000_000_000)
    assert.equal(sweepAttachments({ prdsRoot, maxAgeMs: 0, now: 1_000_000_000_000 }).removed, 0)
    assert.equal(existsSync(dir), true, 'maxAgeMs=0（关闭）不得删任何东西')
    rmSync(prdsRoot, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// resolveDeliveryChatId：发送时按项目号改投项目群，命中则用群 id，否则回落冻结的 fallback。
// 修复「入队时 bot 未进群 → chatId 冻结成私聊，之后进群仍私发」。
describe('resolveDeliveryChatId（发送时改投项目群）', () => {
  it('有 project 且解析命中项目群 → 用群 chat_id（而非冻结的私聊 fallback）', async () => {
    const chatId = await resolveDeliveryChatId({
      project: 'PR-02265',
      fallbackChatId: 'ou_reporter',
      resolve: async (p) => (p === 'PR-02265' ? 'oc_group' : ''),
    })
    assert.equal(chatId, 'oc_group')
  })

  it('解析未命中（bot 不在项目群）→ 回落到冻结的 fallbackChatId', async () => {
    const chatId = await resolveDeliveryChatId({
      project: 'PR-99999',
      fallbackChatId: 'ou_reporter',
      resolve: async () => '',
    })
    assert.equal(chatId, 'ou_reporter')
  })

  it('无 project（adhoc / p2p）→ 短路返回 fallback，不触发解析（network-free）', async () => {
    let called = false
    const chatId = await resolveDeliveryChatId({
      project: null,
      fallbackChatId: 'oc_notify',
      resolve: async () => {
        called = true
        return 'oc_should_not_be_used'
      },
    })
    assert.equal(chatId, 'oc_notify')
    assert.equal(called, false, 'project 为空时不得调用 resolve')
  })
})

// ---------------------------------------------------------------------------
// formatLarkCliError / isTransientLarkError：poller 告警可读化 + 瞬时错误有界重试判定
describe('formatLarkCliError（失败结果压成一行可读原因）', () => {
  it('结构化 error 取 type/subtype/message、单行、不塞截断 JSON', () => {
    const result = { code: -1, stdout: JSON.stringify({ ok: false, identity: 'bot', error: { type: 'network', subtype: 'transport', message: 'API call failed: Post "https://accounts.larksuite.com/oauth/v3/token":\n  dial tcp 1.2.3.4:443: i/o timeout' } }), stderr: '' }
    const reason = formatLarkCliError(result)
    assert.equal(reason, 'network/transport: API call failed: Post "https://accounts.larksuite.com/oauth/v3/token": dial tcp 1.2.3.4:443: i/o timeout')
    assert.doesNotMatch(reason, /[{}]/) // 不再是原始 JSON
  })

  it('非 JSON（超时/spawn error）回落 stderr，压成单行并截断', () => {
    assert.equal(formatLarkCliError({ code: -1, stdout: '', stderr: 'spawn lark ENOENT' }), 'spawn lark ENOENT')
    assert.equal(formatLarkCliError({ code: 0, stdout: '', stderr: '' }), '未知错误')
    assert.ok(formatLarkCliError({ code: -1, stdout: 'x'.repeat(500), stderr: '' }).length <= 200)
  })
})

describe('isTransientLarkError（仅网络层/本地 spawn 超时可重试）', () => {
  it('code=-1（超时/spawn error）与 error.type=network 判为瞬时', () => {
    assert.equal(isTransientLarkError({ code: -1, stdout: '', stderr: 'timeout' }), true)
    assert.equal(isTransientLarkError({ code: 1, stdout: JSON.stringify({ ok: false, error: { type: 'network', subtype: 'transport' } }) }), true)
  })

  it('权限/参数类结构化错误不重试（尽快失败以告警）', () => {
    assert.equal(isTransientLarkError({ code: 1, stdout: JSON.stringify({ ok: false, error: { type: 'permission', subtype: 'missing_scope' } }) }), false)
    assert.equal(isTransientLarkError({ code: 1, stdout: 'not json' }), false)
    assert.equal(isTransientLarkError({ code: 0, stdout: '{}' }), false)
  })
})
