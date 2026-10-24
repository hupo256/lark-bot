/**
 * 从 falive 实践移植回来的几个小纯函数（2026-10-24）：失败归类只看报错前缀、图片按文件头认扩展名、
 * 原子写、规则去重（Claude 自动加载的章节不重复注入）。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { imageExtFromBytes } from '../lib/lark-cli.mjs'
import { writeFileAtomic, writeJsonAtomic } from '../lib/lark-fs.mjs'
import { AUTO_LOADED_RULE_LABELS, stripAutoLoadedRules } from '../lib/lark-rule-context.mjs'
import { classifyWorkerFailure, failureHead } from '../lib/lark-worker-results.mjs'

describe('失败归类只看报错的固定前缀', () => {
  it('执行器非零退出的尾巴（inputTokens / git diff）不把归类带偏', () => {
    assert.equal(failureHead('pre 文字 claude exec exited with code 137：尾巴'), 'pre 文字 claude exec exited with code 137')
    assert.equal(failureHead('worktree add failed'), 'worktree add failed')
    assert.equal(classifyWorkerFailure(new Error('claude exec exited with code 1：... "inputTokens": 1200 ... git diff ...')).failureKind, 'tool')
    assert.equal(classifyWorkerFailure(new Error('Claude 未登录 login required')).failureKind, 'permission')
    assert.equal(classifyWorkerFailure(new Error('git worktree add failed')).failureKind, 'env')
  })
})

describe('图片按文件头认扩展名（Claude 的 Read 按扩展名判类型，.img 会被当文本读成乱码）', () => {
  const pad = (bytes) => Buffer.from([...bytes, ...new Array(12 - bytes.length).fill(0)])
  it('jpg / png / gif / webp；认不出 / 太短 → null', () => {
    assert.equal(imageExtFromBytes(pad([0xff, 0xd8, 0xff, 0xe0])), 'jpg')
    assert.equal(imageExtFromBytes(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])), 'png')
    assert.equal(imageExtFromBytes(pad([0x47, 0x49, 0x46, 0x38])), 'gif')
    assert.equal(imageExtFromBytes(Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])), 'webp')
    assert.equal(imageExtFromBytes(pad([0x00, 0x01])), null)
    assert.equal(imageExtFromBytes(Buffer.from([0xff])), null)
  })
})

describe('原子写状态文件', () => {
  it('写完没有残留 .tmp，内容完整；目录不存在会建', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lark-fs-'))
    try {
      const path = join(dir, 'nested', 'state.json')
      writeJsonAtomic(path, { seen: ['a'] })
      assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { seen: ['a'] })
      writeFileAtomic(path, 'plain')
      assert.equal(readFileSync(path, 'utf8'), 'plain')
      assert.deepEqual(readdirSync(join(dir, 'nested')), ['state.json'])
      assert.equal(existsSync(`${path}.${process.pid}.tmp`), false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('规则去重：Claude Code 自动加载的章节不再注入提示', () => {
  it('剔掉 CLAUDE.md 与 ~/.ai-rules/AGENT.md 的章节，其余保留；审计记 omittedAutoLoaded；没有 excerpts 原样返回', () => {
    assert.equal(AUTO_LOADED_RULE_LABELS.test('~/.ai-rules/AGENT.md'), true)
    assert.equal(AUTO_LOADED_RULE_LABELS.test('falive-react/CLAUDE.md'), true)
    assert.equal(AUTO_LOADED_RULE_LABELS.test('lark-bot/rules/rule-router.md'), false)
    const ruleContext = {
      fingerprint: 'abc',
      excerpts: [
        { label: '~/.ai-rules/AGENT.md', heading: '## React / TypeScript Hard Rules', text: 'HARD' },
        { label: 'lark-bot/rules/rule-router.md', heading: '## 4. 上下文与验证节制', text: 'ROUTER' },
      ],
      text: 'HARD\n\nROUTER',
    }
    const stripped = stripAutoLoadedRules(ruleContext)
    assert.equal(stripped.text, 'ROUTER')
    assert.deepEqual(stripped.omittedAutoLoaded, ['~/.ai-rules/AGENT.md### React / TypeScript Hard Rules'])
    assert.equal(stripped.fingerprint, 'abc', '指纹不变，审计仍按完整规则记')
    assert.equal(ruleContext.text, 'HARD\n\nROUTER', '不改原对象')
    assert.equal(stripAutoLoadedRules({ text: 'x' }).text, 'x')
  })
})

describe('依赖安装的锁文件漂移（2026-10-24 试跑：pnpm install --frozen-lockfile 仍改了 pnpm-lock.yaml，范围契约误拦）', () => {
  it('没有 package.json 改动、只有锁文件改动才算漂移；改了 manifest 就是真依赖变更，不还原', async () => {
    const { lockfileDriftToRevert } = await import('../lib/lark-worker-git.mjs')
    assert.deepEqual(lockfileDriftToRevert(['apps/admin/a.tsx', 'pnpm-lock.yaml', '']), ['pnpm-lock.yaml'])
    assert.deepEqual(lockfileDriftToRevert(['apps/web/package.json', 'pnpm-lock.yaml']), [])
    assert.deepEqual(lockfileDriftToRevert(['a.tsx']), [])
  })
  it('真实 git 仓：还原锁文件、保留业务改动', async () => {
    const { spawnSync } = await import('node:child_process')
    const { writeFileSync } = await import('node:fs')
    const { revertLockfileDrift } = await import('../lib/lark-worker-git.mjs')
    const cwd = mkdtempSync(join(tmpdir(), 'lark-lock-'))
    const git = (...args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
    try {
      git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@e.x'); git('config', 'user.name', 't')
      writeFileSync(join(cwd, 'pnpm-lock.yaml'), 'lock: 1\n'); writeFileSync(join(cwd, 'a.ts'), 'export const a = 1\n')
      git('add', '-A'); git('commit', '-qm', 'base')
      writeFileSync(join(cwd, 'pnpm-lock.yaml'), 'lock: 2\n'); writeFileSync(join(cwd, 'a.ts'), 'export const a = 2\n')
      assert.deepEqual(revertLockfileDrift(cwd), ['pnpm-lock.yaml'])
      assert.equal(readFileSync(join(cwd, 'pnpm-lock.yaml'), 'utf8'), 'lock: 1\n')
      assert.equal(readFileSync(join(cwd, 'a.ts'), 'utf8'), 'export const a = 2\n')
      assert.deepEqual(revertLockfileDrift(cwd), [])
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe('bug 表「问题截图」（2026-10-24 试跑：BUG-6754 有截图，bot 却回「请补截图」）', () => {
  it('附件列 → 最多 4 张带 file_token 的截图；没有这一列 / 空 → 空数组；列名可配', async () => {
    const { readBugScreenshots } = await import('../lib/lark-bugtable-parse.mjs')
    const shot = (n) => ({ file_token: `tok${n}`, name: `${n}.png`, size: 1 })
    assert.deepEqual(readBugScreenshots({ fields: { 问题截图: [shot(1), { name: 'x' }, shot(2)] } }), [{ fileToken: 'tok1', name: '1.png' }, { fileToken: 'tok2', name: '2.png' }])
    assert.equal(readBugScreenshots({ fields: { 问题截图: [1, 2, 3, 4, 5].map(shot) } }).length, 4)
    assert.deepEqual(readBugScreenshots({ fields: {} }), [])
    assert.deepEqual(readBugScreenshots({ fields: { 截图: [shot(9)] }, bug: { screenshotField: '截图' } }), [{ fileToken: 'tok9', name: '9.png' }])
  })
})
