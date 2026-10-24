import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

import { archiveDirFor, archiveDocAttachments, buildDocIntakeText, discardUnsavedDocs, shouldSkipDocSave } from '../lib/lark-doc-archive.mjs'
import { runSteps } from './support/steps.mjs'

const profile = { docIntakeDir: 'docs/delivery/pending', docReplyDir: 'docs/delivery/reply' }

describe('对接文档机械存档（教训 #43）', () => {
  it('答复与其余文档分目录存档，同名同内容记 #same、不同内容不覆盖记 #kept', () => runSteps([
    ['答复原文进 docReplyDir，其余进 docIntakeDir', () => {
      assert.equal(archiveDirFor({ name: 'aven-后端待办-自测新增-2026-10-19-回复.md', profile }), 'docs/delivery/reply')
      assert.equal(archiveDirFor({ name: '前端联调阻塞清单-回复文档.md', profile }), 'docs/delivery/reply')
      assert.equal(archiveDirFor({ name: 'PM-3217-对接文档.md', profile }), 'docs/delivery/pending')
      assert.equal(archiveDirFor({ name: 'x-回复.md', profile: { docIntakeDir: 'docs/in' } }), 'docs/in', '没配答复目录回落收件目录')
    }],
    ['新文件拷入；同名同内容记 #same；同名不同内容不覆盖、记 #kept', () => {
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
    }],
  ]))
})

describe('跟负责人无关的文档不进仓库（教训 #53）', () => {
  it('跟负责人无关的不存：按归属判、撤存档恢复 HEAD、私聊写清没存', () => runSteps([
    ['有结构化归属按 mine；没有时只有认出别的负责人才不存，认不出按存', () => {
      assert.equal(shouldSkipDocSave({ declared: { mine: false, owner: 'adrian' } }), true)
      assert.equal(shouldSkipDocSave({ declared: { mine: true } }), false)
      assert.equal(shouldSkipDocSave({ declared: null, mine: false, owners: ['adrian'] }), true)
      assert.equal(shouldSkipDocSave({ declared: null, mine: false, owners: [] }), false)
      assert.equal(shouldSkipDocSave({ declared: null, mine: true, owners: ['adrian'] }), false)
    }],
    ['撤存档：新文件删掉，仓里已有的恢复成 HEAD', () => {
      const cwd = mkdtempSync(join(tmpdir(), 'doc-discard-'))
      try {
        const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' })
        git('init', '-q')
        mkdirSync(join(cwd, 'docs'), { recursive: true })
        writeFileSync(join(cwd, 'docs/old.md'), 'v1')
        git('add', '.')
        git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init')
        writeFileSync(join(cwd, 'docs/old.md'), 'v2')
        writeFileSync(join(cwd, 'docs/new.md'), 'x')
        discardUnsavedDocs({ cwd, paths: ['docs/new.md', 'docs/old.md'] })
        assert.equal(existsSync(join(cwd, 'docs/new.md')), false)
        assert.equal(readFileSync(join(cwd, 'docs/old.md'), 'utf8'), 'v1')
      } finally {
        rmSync(cwd, { recursive: true, force: true })
      }
    }],
    ['私聊结论写清没存', () => {
      assert.match(buildDocIntakeText({ skipped: true, owners: ['adrian'], summary: '问 Go 后端的' }), /^文档内容归 adrian 负责，跟你无关，没存进仓库/)
    }],
  ]))
})
