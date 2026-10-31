/**
 * 从 falive 第三批移植（2026-10-31）里需要真起子进程 / 单独设环境的两条：
 *   · lark-cli 子进程在 'close' 上结算（exit 早于 stdout 关闭时不截断输出）；
 *   · 人工 retry 重下失败附件按下载键（文件 fileKey / 图片 imageKey）过滤与回填。
 * LARK_CLI_BIN 要在 import 前设好（模块加载时读），所以本文件用动态 import。
 */

import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const dir = mkdtempSync(join(tmpdir(), 'lark-port-batch3-'))
const bin = join(dir, 'lark-cli')
// 先吐半截 JSON，剩下的交给后台子进程 0.3s 后写完：sh 先退出（'exit'），stdout 管道要等后台进程写完才关（'close'）。
writeFileSync(bin, `#!/bin/sh\nprintf '{"ok":true,'\n(sleep 0.3; printf '"data":{"message_id":"om_late"}}\\n') &\nexit 0\n`)
chmodSync(bin, 0o755)
process.env.LARK_CLI_BIN = bin
process.env.LARK_RUNTIME_DIR = join(dir, 'runtime')
const { parseSentMessageId, runLarkCli } = await import('../lib/lark-cli.mjs')
const { attachmentResourceKey, failedAttachmentsOf, mergeRedownloadedAttachments } = await import('../lib/lark-routes.mjs')

describe('lark-cli 子进程结算时机（falive 10-24 变异补测发现）', () => {
  it('子进程退出早于 stdout 读完时，等 stdout 关闭再结算，拿到完整输出（发消息才有 message_id、+chat-list 不读成空）', async () => {
    const result = await runLarkCli(['im', '+messages-send'])
    assert.equal(result.code, 0)
    assert.equal(result.stdout, '{"ok":true,"data":{"message_id":"om_late"}}\n', 'exit 早于 stdout 关闭时不能截断输出')
    assert.equal(parseSentMessageId(result.stdout), 'om_late')
  })
})

describe('人工 retry 重下失败附件按下载键（falive 10-24：文件附件只有 fileKey，原先永远不重下）', () => {
  it('文件用 fileKey、图片用 imageKey；重下到的覆盖原条目，其余原样保留', () => {
    const file = { type: 'file', fileKey: 'file_bad', fileName: '对接.md', downloadError: 'boom' }
    const image = { type: 'image', imageKey: 'img_bad2', downloadError: 'boom' }
    const fine = { type: 'image', imageKey: 'img_ok', localPath: '/x/1.png' }
    assert.equal(attachmentResourceKey(file), 'file_bad')
    assert.equal(attachmentResourceKey(image), 'img_bad2')
    assert.equal(attachmentResourceKey({ type: 'file' }), null)
    assert.deepEqual(failedAttachmentsOf({ attachments: [file, image, fine] }).map(attachmentResourceKey), ['file_bad', 'img_bad2'], '文件附件也进重下清单；已有 localPath 的不重下')
    assert.deepEqual(failedAttachmentsOf({}), [], '没有附件 → 空')
    assert.deepEqual(failedAttachmentsOf({ attachments: [{ type: 'file', fileName: '无键.md', downloadError: 'boom' }] }), [], '没有下载键的重不了')
    assert.deepEqual(failedAttachmentsOf({ attachments: [{ type: 'image', imageKey: 'img_pending' }] }), [], '没记下载失败的不算（可能还在下）')
    assert.deepEqual(failedAttachmentsOf({ attachments: [{ type: 'image', imageKey: 'img_x', localPath: '/x/2.png', downloadError: '旧的' }] }), [], '已有本地文件就不重下，哪怕留着旧的 downloadError')
    const merged = mergeRedownloadedAttachments([file, image, fine], [{ ...file, localPath: '/x/1-对接.md', downloadError: undefined }])
    assert.equal(merged[0].localPath, '/x/1-对接.md', '按 fileKey 回填')
    assert.equal(merged[1], image, '没重下到的原样保留')
    assert.equal(merged[2], fine)
  })
})
