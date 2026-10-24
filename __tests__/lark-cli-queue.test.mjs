import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { runSteps } from './support/steps.mjs'

// 假 lark-cli：睡 150ms 后吐 ok。LARK_CLI_BIN 在模块加载时读，所以先设环境再动态 import。
const dir = mkdtempSync(join(tmpdir(), 'lark-cli-q-'))
const bin = join(dir, 'fake-lark-cli')
const queueCli = '#!/bin/sh\nsleep 0.3\necho "{\\"ok\\":true,\\"data\\":{}}"\n'
writeFileSync(bin, queueCli)
chmodSync(bin, 0o755)
process.env.LARK_CLI_BIN = bin
process.env.LARK_CLI_CONCURRENCY = '1'
// 运行态（审计目录等）也在模块加载时定根：指到临时目录，测试不往仓库 runtime/ 落文件。
process.env.LARK_RUNTIME_DIR = join(dir, 'runtime')
const { larkCliQueueStats, resolveChatName, runLarkCli } = await import('../lib/lark-cli.mjs')
const { handleStatusUpdate } = await import('../lib/lark-status.mjs')
const { createTaskStore } = await import('../lib/lark-task-store.mjs')
const { createTaskAudit } = await import('../lib/lark-worker-audit.mjs')

after(() => rmSync(dir, { recursive: true, force: true }))

// 按子命令分流的假 lark-cli：每次调用记一行到 calls.log；+chat-list 吐 chats.json；bug 表回写按权限错误失败；其余发送成功。
const scriptedCli = (caseDir) => `#!/bin/sh
echo "$*" >> "${caseDir}/calls.log"
case "$*" in
  *+chat-list*) cat "${caseDir}/chats.json" ;;
  *+record-batch-update*) echo '{"ok":false,"error":{"type":"permission","message":"no scope"}}'; exit 1 ;;
  *) echo '{"ok":true,"data":{"message_id":"om_alert"}}' ;;
esac
`
const callCount = (caseDir, pattern) => {
  try {
    return readFileSync(join(caseDir, 'calls.log'), 'utf8').split('\n').filter((line) => line.includes(pattern)).length
  } catch {
    return 0
  }
}

describe('lark-cli 子进程限流（第 1 批）', () => {
  it('同身份并发受限，其余排队；排队时 send 先于 read（并发 1 使完成顺序可判定，不受调度抖动影响）', () => runSteps([
    ['同身份并发受限，其余排队；排队时 send 先于 read（并发 1 使完成顺序可判定，不受调度抖动影响）', async () => {
      const order = []
      const run = (tag, priority) => runLarkCli(['im', tag], { identity: 'user', priority }).then(() => order.push(tag))
      const until = async (predicate, label) => {
        // 全量跑时几十个测试进程并发，起一个 sh 子进程可能要几百毫秒：最多等 15s。
        for (let i = 0; i < 1500; i += 1) {
          if (predicate()) return
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        assert.fail(`等不到：${label}（${JSON.stringify(larkCliQueueStats().user)}）`)
      }
      const first = run('r1', 'read')
      await until(() => larkCliQueueStats().user.running === 1, '一个在跑')
      const rest = [run('r2', 'read'), run('r3', 'read'), run('s1', 'send')]
      await until(() => larkCliQueueStats().user.queued === 3, '三个排队')
      await Promise.all([first, ...rest])
      assert.deepEqual(order, ['r1', 's1', 'r2', 'r3'], '排队的 send 先于排队的 read')
      assert.deepEqual(larkCliQueueStats().user, { running: 0, queued: 0 })
    }],
    ['群名缓存：TTL 内命中不重拉；新群首次 miss 即刷新拿到群名（bot 刚进的群不能等满 TTL）；不在群里的负缓存不反复拉（变异补测 10-24）', async () => {
      const caseDir = mkdtempSync(join(dir, 'chat-names-'))
      writeFileSync(bin, scriptedCli(caseDir))
      const setChats = (chats) => writeFileSync(join(caseDir, 'chats.json'), JSON.stringify({ ok: true, data: { chats } }))
      setChats([{ chat_id: 'oc_a', name: '[PR-00001] 群 A' }])
      assert.equal(await resolveChatName('oc_a'), '[PR-00001] 群 A')
      assert.equal(callCount(caseDir, '+chat-list'), 1)
      assert.equal(await resolveChatName('oc_a'), '[PR-00001] 群 A')
      assert.equal(callCount(caseDir, '+chat-list'), 1, 'TTL 内已缓存的群不重拉 chat-list')
      setChats([{ chat_id: 'oc_a', name: '[PR-00001] 群 A' }, { chat_id: 'oc_b', name: '[PR-00002] 群 B' }])
      assert.equal(await resolveChatName('oc_b'), '[PR-00002] 群 B', '缓存新鲜但没有这个群：首次 miss 必须刷新')
      assert.equal(callCount(caseDir, '+chat-list'), 2)
      assert.equal(await resolveChatName('oc_outside'), '')
      assert.equal(callCount(caseDir, '+chat-list'), 3)
      assert.equal(await resolveChatName('oc_outside'), '')
      assert.equal(callCount(caseDir, '+chat-list'), 3, '外部群 TTL 内负缓存，不再每次 miss 都拉表')
    }],
    ['bug 表回写失败落 done_pending_writeback 时，done 结果卡仍按本轮回执登记（可被回复锚定），不当成已换代丢弃（变异补测 10-24）', async () => {
      const caseDir = mkdtempSync(join(dir, 'writeback-'))
      writeFileSync(bin, scriptedCli(caseDir))
      const store = createTaskStore({ tasksDir: join(caseDir, 'tasks'), leaseMs: 60_000 })
      store.upsert({ id: 't', status: 'running', epoch: 0, project: 'PR-00001', source: 'lark-bugtable', recordId: 'rec1', commandType: 'fix', chatId: 'oc_x', text: '修复按钮', createdAt: '2026-01-01T00:00:00Z' })
      const outcome = await handleStatusUpdate({
        config: { project: 'PR-00001', bugTable: { appToken: 'app', tableId: 'tbl', statusField: '状态', doneValue: '已修复' } },
        store,
        id: 't',
        status: 'done',
        result: '已修复。',
        epoch: 0,
        resolveGroupChat: async () => null,
        postGroup: async () => ({ ok: true }),
        sendMessage: async () => ({ ok: true, messageId: 'om_result' }),
      })
      assert.ok(callCount(caseDir, '+record-batch-update') >= 1, '确实走了 bug 表回写')
      assert.equal(outcome.ok, true)
      assert.equal(outcome.receiptSuperseded, undefined, '回写挂起不是换代，结果卡不能被当旧发送结果忽略')
      assert.equal(store.get('t').status, 'done_pending_writeback')
      assert.equal(store.findByReceiptMessageId('om_result')?.id, 't')
      assert.equal(store.get('t').lastDeliveredReceipt?.idempotencyKey, 't-e0-done')
      assert.equal(store.get('t').pendingReceipt, undefined)
    }],
    ['任务审计记录执行落点：临时 worktree 记 hotfixBranch，就地改（无 hotfix 分支）落 null 而不是缺字段（变异补测 10-24）', () => {
      const withBranch = createTaskAudit({
        workerConfig: {},
        task: { id: 'om_audit_1', epoch: 2, summary: 'x' },
        workContext: { cwd: '/tmp/wt', projectId: 'PR-00001', hotfixBranch: 'hotfix/PR-00001-abcd1234', baseRef: 'origin/online' },
        executor: 'codex',
      })
      assert.ok(withBranch.jsonPath.startsWith(join(dir, 'runtime')), '审计落在临时运行态目录')
      const saved = JSON.parse(readFileSync(withBranch.jsonPath, 'utf8'))
      assert.equal(saved.workContext.hotfixBranch, 'hotfix/PR-00001-abcd1234')
      assert.equal(saved.workContext.baseRef, 'origin/online')
      const inPlace = createTaskAudit({
        workerConfig: {},
        task: { id: 'om_audit_2', epoch: 0, summary: 'y' },
        workContext: { cwd: '/tmp/PR-00001', projectId: 'PR-00001' },
        executor: 'codex',
      })
      const savedInPlace = JSON.parse(readFileSync(inPlace.jsonPath, 'utf8'))
      assert.equal(savedInPlace.workContext.hotfixBranch, null)
    }],
  ], { before: () => writeFileSync(bin, queueCli) }))
})
