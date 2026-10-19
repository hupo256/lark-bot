import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { archiveDirFor, archiveDocAttachments } from '../lib/lark-doc-archive.mjs'

const profile = { docIntakeDir: 'docs/delivery/pending', docReplyDir: 'docs/delivery/reply' }

describe('对接文档机械存档（教训 #43）', () => {
  it('答复原文进 docReplyDir，其余进 docIntakeDir', () => {
    assert.equal(archiveDirFor({ name: 'aven-后端待办-自测新增-2026-10-19-回复.md', profile }), 'docs/delivery/reply')
    assert.equal(archiveDirFor({ name: '前端联调阻塞清单-回复文档.md', profile }), 'docs/delivery/reply')
    assert.equal(archiveDirFor({ name: 'PM-3217-对接文档.md', profile }), 'docs/delivery/pending')
    assert.equal(archiveDirFor({ name: 'x-回复.md', profile: { docIntakeDir: 'docs/in' } }), 'docs/in', '没配答复目录回落收件目录')
  })

  it('新文件拷入；同名同内容记 #same；同名不同内容不覆盖、记 #kept', () => {
    const root = mkdtempSync(join(tmpdir(), 'lark-doc-archive-'))
    try {
      const cwd = join(root, 'wt')
      const dl = join(root, 'dl')
      mkdirSync(join(cwd, 'docs/delivery/pending'), { recursive: true })
      mkdirSync(dl, { recursive: true })
      writeFileSync(join(cwd, 'docs/delivery/pending/待办.md'), 'new version\n')
      writeFileSync(join(cwd, 'docs/delivery/pending/same.md'), 'same\n')
      writeFileSync(join(dl, '1-待办.md'), 'old version\n')
      writeFileSync(join(dl, '2-same.md'), 'same\n')
      writeFileSync(join(dl, '3-待办-回复.md'), 'reply\n')
      const attachments = [['1-待办.md', '待办.md'], ['2-same.md', 'same.md'], ['3-待办-回复.md', '待办-回复.md']].map(([file, fileName]) => ({ type: 'file', fileName, localPath: join(dl, file) }))
      const out = archiveDocAttachments({ task: { id: 't', attachments }, cwd, profile })
      assert.deepEqual(out, ['docs/delivery/pending/待办.md#kept', 'docs/delivery/pending/same.md#same', 'docs/delivery/reply/待办-回复.md'])
      assert.equal(readFileSync(join(cwd, 'docs/delivery/pending/待办.md'), 'utf8'), 'new version\n', '仓里的新版没被附件旧版覆盖')
      assert.equal(readFileSync(join(cwd, 'docs/delivery/reply/待办-回复.md'), 'utf8'), 'reply\n')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
