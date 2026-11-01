import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  bindProjectChat,
  emptyProjectChats,
  formatProjectChatEvents,
  formatProjectChatList,
  loadProjectChats,
  parseProjectChatDirective,
  projectChatFor,
  projectForChat,
  saveProjectChats,
  syncProjectChats,
  unbindProjectChat,
} from '../lib/lark-project-chats.mjs'
import { runProjectChatSync } from '../lib/lark-project-chat-sync.mjs'
import { listBotChats, resolveChatIdByProject, resolveDeliveryChatId } from '../lib/lark-cli.mjs'
import { maybeHandleProjectChatDirective } from '../lib/lark-project-chat-sync.mjs'
import { runSteps } from './support/steps.mjs'

// aven 2026-11-01：项目群按 chat_id 绑定，不按群名找（群名会改、不规范）
const T0 = Date.parse('2026-11-01T08:00:00Z')
const chats = (pairs) => new Map(pairs)

describe('项目群绑定表（入群绑定、换群改绑、改名不影响、回群只认绑定表）', () => {
  let dir
  const hooks = { before: () => { dir = mkdtempSync(join(tmpdir(), 'project-chats-')) }, after: () => rmSync(dir, { recursive: true, force: true }) }
  const path = () => join(dir, 'lark-project-chats.json')

  it('同步、反查、指令、落盘、接入', () => runSteps([
    ['首次：群名唯一对上项目号的直接绑；同项目号多个群不绑、记 ambiguous；群名没项目号的只记已知', () => {
      const { state, events } = syncProjectChats({ chats: chats([['oc_a', '[PR-01947]跟单设置'], ['oc_b', 'PR-02031 联调'], ['oc_b2', 'PR-02031 二群'], ['oc_c', '闲聊群']]), now: T0 })
      assert.equal(projectChatFor(state, 'PR-01947'), 'oc_a')
      assert.equal(projectChatFor(state, 'PR-02031'), '')
      assert.ok(state.baselineAt)
      assert.deepEqual(Object.keys(state.knownChats).sort(), ['oc_a', 'oc_b', 'oc_b2', 'oc_c'])
      assert.deepEqual(events.map((e) => e.type).sort(), ['ambiguous', 'bound'])
    }],
    ['之后新出现的群 = bot 刚被拉进去：按群名绑定；没项目号的记 unmatched；已知的群不重复处理', () => {
      const base = syncProjectChats({ chats: chats([['oc_a', '[PR-01947]跟单']]), now: T0 }).state
      const { state, events } = syncProjectChats({ state: base, chats: chats([['oc_a', '[PR-01947]跟单'], ['oc_n', '[PR-02233] 安全验证'], ['oc_x', '随便聊']]), now: T0 + 1000 })
      assert.equal(projectChatFor(state, 'PR-02233'), 'oc_n')
      assert.deepEqual(events.map((e) => e.type), ['bound', 'unmatched'])
      assert.equal(syncProjectChats({ state, chats: chats([['oc_a', '[PR-01947]跟单'], ['oc_n', '[PR-02233] 安全验证'], ['oc_x', '随便聊']]), now: T0 + 2000 }).events.length, 0)
    }],
    ['换新群：同项目号的新群出现 → 改绑并记 rebound（带原群）', () => {
      const base = syncProjectChats({ chats: chats([['oc_old', '[PR-02233] 一期']]), now: T0 }).state
      const { state, events } = syncProjectChats({ state: base, chats: chats([['oc_old', '[PR-02233] 一期'], ['oc_new', '[PR-02233] 二期']]), now: T0 + 1000 })
      assert.equal(projectChatFor(state, 'PR-02233'), 'oc_new')
      assert.equal(events[0].type, 'rebound')
      assert.equal(events[0].prevChatId, 'oc_old')
    }],
    ['群改名（哪怕名字里的项目号没了 / 变了）不动绑定，只更新显示名', () => {
      const base = syncProjectChats({ chats: chats([['oc_a', '[PR-01947]跟单']]), now: T0 }).state
      const { state, events } = syncProjectChats({ state: base, chats: chats([['oc_a', '跟单设置（已改名）']]), now: T0 + 1000 })
      assert.equal(projectChatFor(state, 'PR-01947'), 'oc_a')
      assert.equal(state.projects['PR-01947'].chatName, '跟单设置（已改名）')
      assert.equal(events.length, 0)
      const renamedToOther = syncProjectChats({ state, chats: chats([['oc_a', '[PR-09999] 别的']]), now: T0 + 2000 })
      assert.equal(projectChatFor(renamedToOther.state, 'PR-01947'), 'oc_a')
      assert.equal(projectChatFor(renamedToOther.state, 'PR-09999'), '')
    }],
    ['绑定的群不见了（bot 被移出）→ 只提醒一次 left，不自动解绑；回来后清掉 left', () => {
      const base = syncProjectChats({ chats: chats([['oc_a', '[PR-01947]跟单']]), now: T0 }).state
      const gone = syncProjectChats({ state: base, chats: chats([]), now: T0 + 1000 })
      assert.deepEqual(gone.events.map((e) => e.type), ['left'])
      assert.equal(projectChatFor(gone.state, 'PR-01947'), 'oc_a')
      assert.equal(syncProjectChats({ state: gone.state, chats: chats([]), now: T0 + 2000 }).events.length, 0)
      const back = syncProjectChats({ state: gone.state, chats: chats([['oc_a', '[PR-01947]跟单']]), now: T0 + 3000 })
      assert.equal(back.state.knownChats.oc_a.leftAt, undefined)
      assert.equal(back.events.length, 0)
    }],
    ['群名带多个项目号（跨项目群）不自动绑', () => {
      const base = syncProjectChats({ chats: chats([]), now: T0 }).state
      const { state, events } = syncProjectChats({ state: base, chats: chats([['oc_m', 'PR-01947 / PR-02031 联合群']]), now: T0 + 1000 })
      assert.equal(projectChatFor(state, 'PR-01947'), '')
      assert.equal(events[0].type, 'unmatched')
    }],
    ['群 → 项目反查；项目号大小写归一', () => {
      const { state } = bindProjectChat(emptyProjectChats(), { project: 'pr-02233', chatId: 'oc_n', chatName: 'x', now: T0 })
      assert.equal(projectForChat(state, 'oc_n'), 'PR-02233')
      assert.equal(projectForChat(state, 'oc_other'), '')
      assert.equal(projectChatFor(state, 'pr-02233'), 'oc_n')
      const { state: after, prev } = unbindProjectChat(state, 'PR-02233')
      assert.equal(prev.chatId, 'oc_n')
      assert.equal(projectChatFor(after, 'PR-02233'), '')
    }],
    ['指令：绑定（带 / 不带群 id）、群是、解绑、列表；别的话放行', () => {
      assert.deepEqual(parseProjectChatDirective('绑定 PR-02233'), { action: 'bind', project: 'PR-02233', chatId: '' })
      assert.deepEqual(parseProjectChatDirective('绑定 pr-02233 oc_abc123'), { action: 'bind', project: 'PR-02233', chatId: 'oc_abc123' })
      assert.deepEqual(parseProjectChatDirective('PR-02233 群是 oc_abc123'), { action: 'bind', project: 'PR-02233', chatId: 'oc_abc123' })
      assert.deepEqual(parseProjectChatDirective('解绑 PR-02233'), { action: 'unbind', project: 'PR-02233' })
      assert.deepEqual(parseProjectChatDirective('项目群'), { action: 'list' })
      assert.equal(parseProjectChatDirective('帮我看下 PR-02233 群里那个 bug'), null)
      assert.equal(parseProjectChatDirective('绑定一下这个'), null)
    }],
    ['私信文案：初始建表汇总一句；入群 / 改绑 / 歧义 / 无项目号 / 退群各一句', () => {
      const text = formatProjectChatEvents([
        { type: 'bound', project: 'PR-1001', chatId: 'oc_1', chatName: 'a', source: 'baseline' },
        { type: 'bound', project: 'PR-1002', chatId: 'oc_2', chatName: 'b', source: 'joined' },
        { type: 'rebound', project: 'PR-1003', chatId: 'oc_3', chatName: 'c', prevChatId: 'oc_0', prevChatName: 'z' },
        { type: 'ambiguous', project: 'PR-1004', chats: [{ chatId: 'oc_4', chatName: 'd' }, { chatId: 'oc_5', chatName: 'e' }] },
        { type: 'unmatched', chatId: 'oc_6', chatName: 'f' },
        { type: 'left', project: 'PR-1001', chatId: 'oc_1', chatName: 'a' },
      ])
      assert.match(text, /项目群绑定表已建立.*PR-1001 → 「a」（oc_1）/)
      assert.match(text, /按群名绑定到 PR-1002/)
      assert.match(text, /PR-1003 换了新群.*改绑到 「c」（oc_3）.*绑定 PR-1003 oc_0/)
      assert.match(text, /PR-1004 对上了多个群/)
      assert.match(text, /群名里看不出项目号/)
      assert.match(text, /bot 已不在 PR-1001 的绑定群/)
      assert.equal(formatProjectChatEvents([]), '')
      assert.match(formatProjectChatList(emptyProjectChats()), /还没有绑定/)
    }],
    ['落盘往返；损坏的文件改名留证并按空表重建', () => {
      const { state } = bindProjectChat(emptyProjectChats(), { project: 'PR-02233', chatId: 'oc_n', now: T0 })
      saveProjectChats(state, { path: path() })
      assert.equal(projectChatFor(loadProjectChats({ path: path() }), 'PR-02233'), 'oc_n')
      writeFileSync(path(), '{ broken')
      assert.deepEqual(loadProjectChats({ path: path() }).projects, {})
      assert.ok(readdirSync(dir).some((name) => name.startsWith('lark-project-chats.json.corrupt-')))
      assert.ok(!existsSync(path()))
    }],
    ['回群只认绑定表：没绑定返回空、由调用方回落私聊 / 通知群，不再按群名猜', async () => {
      const { state } = bindProjectChat(emptyProjectChats(), { project: 'PR-02233', chatId: 'oc_bound', now: T0 })
      assert.equal(await resolveChatIdByProject('PR-02233', { load: () => state }), 'oc_bound')
      assert.equal(await resolveChatIdByProject('PR-09999', { load: () => state }), '')
      assert.equal(await resolveDeliveryChatId({ project: 'PR-09999', fallbackChatId: 'ou_me', resolve: (p) => resolveChatIdByProject(p, { load: () => state }) }), 'ou_me')
      assert.equal(await resolveDeliveryChatId({ project: 'PR-02233', fallbackChatId: 'ou_me', resolve: (p) => resolveChatIdByProject(p, { load: () => state }) }), 'oc_bound')
    }],
    ['同步：有变化才落盘、事件私信负责人；拉群列表失败本轮跳过', async () => {
      let saved = 0; const sent = []
      let state = emptyProjectChats()
      const deps = { load: () => state, save: (next) => { saved += 1; state = next }, send: async (m) => { sent.push(m) }, log: () => {} }
      await runProjectChatSync({ notifyOpenId: 'ou_me', list: async () => chats([['oc_a', '[PR-01947]跟单']]), now: T0, ...deps })
      assert.equal(saved, 1)
      assert.equal(sent.length, 1)
      assert.equal(sent[0].chatId, 'ou_me')
      await runProjectChatSync({ notifyOpenId: 'ou_me', list: async () => chats([['oc_a', '[PR-01947]跟单']]), now: T0 + 1, ...deps })
      assert.equal(saved, 1, '没变化不落盘')
      assert.equal(sent.length, 1)
      const failed = await runProjectChatSync({ notifyOpenId: 'ou_me', list: async () => null, now: T0 + 2, ...deps })
      assert.equal(failed.ok, false)
      assert.equal(projectChatFor(state, 'PR-01947'), 'oc_a', '读失败不当退群')
    }],
    ['指令只认负责人；群里不带群 id = 绑当前群；私聊不带群 id 要求补', async () => {
      let state = emptyProjectChats(); const replies = []
      const deps = { load: () => state, save: (next) => { state = next }, send: async (m) => { replies.push(m.text) }, chatNameOf: async () => '测试群' }
      const config = { notifyOpenId: 'ou_me' }
      assert.equal(await maybeHandleProjectChatDirective({ msg: { text: '绑定 PR-02233', chatId: 'oc_g', chatType: 'group', senderOpenId: 'ou_other', messageId: 'm0' }, config, ...deps }), false)
      assert.equal(await maybeHandleProjectChatDirective({ msg: { text: '绑定 PR-02233', chatId: 'oc_g', chatType: 'group', senderOpenId: 'ou_me', messageId: 'm1' }, config, ...deps }), true)
      assert.equal(projectChatFor(state, 'PR-02233'), 'oc_g')
      assert.equal(await maybeHandleProjectChatDirective({ msg: { text: '绑定 PR-02234', chatId: 'ou_dm', chatType: 'p2p', senderOpenId: 'ou_me', messageId: 'm2' }, config, ...deps }), true)
      assert.equal(projectChatFor(state, 'PR-02234'), '')
      assert.match(replies.at(-1), /群 id 没给/)
      await maybeHandleProjectChatDirective({ msg: { text: '解绑 PR-02233', chatId: 'ou_dm', chatType: 'p2p', senderOpenId: 'ou_me', messageId: 'm3' }, config, ...deps })
      assert.equal(projectChatFor(state, 'PR-02233'), '')
      assert.equal(await maybeHandleProjectChatDirective({ msg: { text: '这个 bug 修一下', chatId: 'oc_g', chatType: 'group', senderOpenId: 'ou_me', messageId: 'm4' }, config, ...deps }), false)
    }],
    ['拉群列表：失败 / 坏 JSON 返回 null（本轮跳过），成功给 chatId → 群名', async () => {
      assert.equal(await listBotChats({ run: async () => ({ code: 1, stdout: '' }) }), null)
      assert.equal(await listBotChats({ run: async () => ({ code: 0, stdout: '{bad' }) }), null)
      const got = await listBotChats({ run: async () => ({ code: 0, stdout: JSON.stringify({ data: { chats: [{ chat_id: 'oc_1', name: '[PR-1001] a' }, { chat_id: 'oc_2' }] } }) }) })
      assert.deepEqual([...got.entries()], [['oc_1', '[PR-1001] a'], ['oc_2', '']])
    }],
    ['细节：改名记进已知群；改绑时原群没名字记空串；绑定不在已知群里的群消失也提醒；手动绑定首次 prev 为 null；旧文件缺字段补空', () => {
      const base = syncProjectChats({ chats: chats([['oc_a', '[PR-01947]跟单']]), now: T0 }).state
      assert.equal(syncProjectChats({ state: base, chats: chats([['oc_a', '改名了']]), now: T0 + 1 }).state.knownChats.oc_a.name, '改名了')
      const noName = { ...base, projects: { 'PR-02233': { chatId: 'oc_old' } } }
      const rebound = syncProjectChats({ state: noName, chats: chats([['oc_a', '[PR-01947]跟单'], ['oc_old', 'x'], ['oc_new', '[PR-02233] 新']]), now: T0 + 2 })
      assert.equal(rebound.events.find((e) => e.type === 'rebound').prevChatName, '')
      const manual = bindProjectChat(base, { project: 'PR-03000', chatId: 'oc_manual', now: T0 })
      assert.equal(manual.prev, null)
      const lost = syncProjectChats({ state: manual.state, chats: chats([['oc_a', '[PR-01947]跟单']]), now: T0 + 3 })
      assert.deepEqual(lost.events, [{ type: 'left', project: 'PR-03000', chatId: 'oc_manual', chatName: '' }])
      assert.equal(lost.state.knownChats.oc_manual.name, '')
      const bare = { ...base, projects: { ...base.projects, 'PR-03001': { chatId: 'oc_bare' } } }
      const lostBare = syncProjectChats({ state: bare, chats: chats([['oc_a', '[PR-01947]跟单']]), now: T0 + 4 })
      assert.deepEqual(lostBare.events, [{ type: 'left', project: 'PR-03001', chatId: 'oc_bare', chatName: '' }])
      assert.equal(lostBare.state.knownChats.oc_bare.name, '')
      writeFileSync(path(), JSON.stringify({ version: 1, baselineAt: 'x' }))
      const loaded = loadProjectChats({ path: path() })
      assert.deepEqual([loaded.projects, loaded.knownChats], [{}, {}])
    }],
    ['文案分得开：只有入群绑定时不出建表汇总，只有建表时不出入群句；单独的无项目号 / 退群各一句；列表标注绑定来源', () => {
      const joined = formatProjectChatEvents([{ type: 'bound', project: 'PR-1002', chatId: 'oc_2', chatName: 'b', source: 'joined' }])
      assert.doesNotMatch(joined, /绑定表已建立/)
      assert.match(joined, /按群名绑定到 PR-1002/)
      const baseline = formatProjectChatEvents([{ type: 'bound', project: 'PR-1001', chatId: 'oc_1', chatName: '', source: 'baseline' }])
      assert.doesNotMatch(baseline, /拉进新群/)
      assert.match(baseline, /「\(无群名\)」/)
      assert.equal(formatProjectChatEvents([{ type: 'unmatched', chatId: 'oc_6', chatName: 'f' }]).split('\n').length, 1)
      assert.doesNotMatch(formatProjectChatEvents([{ type: 'left', project: 'PR-1', chatId: 'oc_1', chatName: 'a' }]), /拉进新群/)
      const list = formatProjectChatList({ projects: { 'PR-2': { chatId: 'oc_2', chatName: 'b', source: 'manual' }, 'PR-1': { chatId: 'oc_1', chatName: 'a', source: 'baseline' }, 'PR-3': { chatId: 'oc_3', chatName: 'c', source: 'joined' } } })
      assert.match(list, /项目群绑定（3 个）：\n- PR-1 → 「a」（oc_1）（初始绑定）\n- PR-2 → 「b」（oc_2）（手动绑定）\n- PR-3 → 「c」（oc_3）（入群绑定）/)
      assert.match(formatProjectChatList({}), /还没有绑定/)
    }],
    ['指令回执：列表 / 解绑 / 改绑都接管并回话，解绑带原群名，改绑带原群，读不到群名有提示', async () => {
      let state = bindProjectChat(emptyProjectChats(), { project: 'PR-02233', chatId: 'oc_old', chatName: '老群', now: T0 }).state
      const replies = []
      const deps = { load: () => state, save: (next) => { state = next }, send: async (m) => { replies.push(m.text) }, chatNameOf: async () => '' }
      const config = { notifyOpenId: 'ou_me' }
      const run = (text, chatId = 'ou_dm', chatType = 'p2p') => maybeHandleProjectChatDirective({ msg: { text, chatId, chatType, senderOpenId: 'ou_me', messageId: `m-${replies.length}` }, config, ...deps })
      assert.equal(await run('项目群'), true)
      assert.match(replies.at(-1), /PR-02233 → 「老群」/)
      assert.equal(await run('绑定 PR-02233 oc_new'), true)
      assert.match(replies.at(-1), /「\(bot 不在该群或读不到群名\)」（oc_new），原来是 老群 oc_old/)
      assert.equal(await run('绑定 PR-02233 oc_new'), true)
      assert.doesNotMatch(replies.at(-1), /原来是/)
      assert.equal(await run('解绑 PR-02233'), true)
      assert.match(replies.at(-1), /已解绑 PR-02233（原群  oc_new）/)
      assert.equal(await run('解绑 PR-02233'), true)
      assert.match(replies.at(-1), /本来就没有绑定群/)
      state = { ...state, projects: { 'PR-02234': { chatId: 'oc_bare' } } }
      await run('解绑 PR-02234')
      assert.match(replies.at(-1), /已解绑 PR-02234（原群  oc_bare）/)
      assert.equal(await maybeHandleProjectChatDirective({ msg: { text: '项目群', chatId: 'oc_g', chatType: 'group', senderOpenId: 'ou_x', messageId: 'z' }, config: { allowedOpenIds: ['ou_x'] }, ...deps }), true, 'allowedOpenIds 里的人也能用')
    }],
  ], hooks))
})
