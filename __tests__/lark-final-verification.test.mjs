#!/usr/bin/env node
/**
 * Worker 轻量终检真实命令测试：回执必须来自最终 git 工作树，而不是 AI 自报 checks。
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  formatWorkerVerificationLine,
  inspectWorkingTreeFingerprint,
  runFinalVerification,
  selectBiomeFiles,
} from '../lib/lark-final-verification.mjs'

const run = (cwd, command, args) => {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
}

const makeRepo = ({ biomeExit = 0 } = {}) => {
  const cwd = mkdtempSync(join(tmpdir(), 'lark-final-verify-'))
  run(cwd, 'git', ['init', '-b', 'main'])
  run(cwd, 'git', ['config', 'user.email', 'test@example.com'])
  run(cwd, 'git', ['config', 'user.name', 'test'])
  writeFileSync(join(cwd, 'source.ts'), 'export const value = 1\n')
  run(cwd, 'git', ['add', '-A'])
  run(cwd, 'git', ['commit', '-m', 'base'])
  const binDir = join(cwd, 'node_modules', '.bin')
  mkdirSync(binDir, { recursive: true })
  const biome = join(binDir, 'biome')
  writeFileSync(biome, `#!/bin/sh\necho worker-biome\nexit ${biomeExit}\n`)
  chmodSync(biome, 0o755)
  return cwd
}

const fixedNow = () => new Date('2026-09-08T00:00:00.000Z')

describe('selectBiomeFiles', () => {
  it('只选仍存在且受支持的最终改动文件', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'lark-biome-files-'))
    try {
      writeFileSync(join(cwd, 'a.ts'), 'export {}\n')
      writeFileSync(join(cwd, 'note.md'), '# note\n')
      assert.deepEqual(selectBiomeFiles({ cwd, changedFiles: ['./a.ts', 'a.ts', 'note.md', 'deleted.ts'] }), ['a.ts'])
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe('runFinalVerification', () => {
  it('实跑 git diff --check + Biome，并把回执绑定到 HEAD/diffHash', () => {
    const cwd = makeRepo()
    try {
      writeFileSync(join(cwd, 'source.ts'), 'export const value = 2\n')
      const receipt = runFinalVerification({ cwd, changedFiles: ['source.ts'], now: fixedNow })
      assert.equal(receipt.ok, true)
      assert.equal(receipt.assuranceMode, 'lark-lightweight')
      assert.equal(receipt.deliveryAuthority, false)
      assert.equal(receipt.fingerprint.headSha.length, 40)
      assert.equal(receipt.fingerprint.diffHash.length, 64)
      assert.deepEqual(receipt.checks.map((check) => check.status), ['passed', 'passed', 'passed'])
      assert.match(formatWorkerVerificationLine(receipt), /intent-to-add ✓.*git-diff-check ✓.*biome ✓.*diff [a-f0-9]{12}/)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('最终内容有 whitespace error 时 Worker 终检失败', () => {
    const cwd = makeRepo()
    try {
      writeFileSync(join(cwd, 'source.ts'), 'export const value = 2  \n')
      const receipt = runFinalVerification({ cwd, changedFiles: ['source.ts'], now: fixedNow })
      assert.equal(receipt.ok, false)
      assert.equal(receipt.checks.find((check) => check.id === 'git-diff-check').status, 'failed')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('Biome 非零退出被记录并阻断，不采信 AI checks', () => {
    const cwd = makeRepo({ biomeExit: 7 })
    try {
      writeFileSync(join(cwd, 'source.ts'), 'export const value = 2\n')
      const receipt = runFinalVerification({ cwd, changedFiles: ['source.ts'], now: fixedNow })
      const biome = receipt.checks.find((check) => check.id === 'biome')
      assert.equal(receipt.ok, false)
      assert.equal(biome.exitCode, 7)
      assert.equal(biome.status, 'failed')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('intent-to-add 失败时立即 fail-closed，不伪造未跟踪文件已纳入终检', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'lark-final-verify-not-git-'))
    try {
      const receipt = runFinalVerification({ cwd, changedFiles: [], now: fixedNow })
      assert.equal(receipt.ok, false)
      assert.deepEqual(receipt.checks.map((check) => check.id), ['intent-to-add'])
      assert.equal(receipt.checks[0].status, 'failed')
      assert.equal(receipt.fingerprint.diffHash, '')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('终检后同路径内容变化会被提交前指纹校验拒绝', () => {
    const cwd = makeRepo()
    try {
      writeFileSync(join(cwd, 'source.ts'), 'export const value = 2\n')
      const receipt = runFinalVerification({ cwd, changedFiles: ['source.ts'], now: fixedNow })
      assert.equal(receipt.ok, true)

      writeFileSync(join(cwd, 'source.ts'), 'export const value = 3\n')
      const identity = inspectWorkingTreeFingerprint({
        cwd,
        expectedHeadSha: receipt.fingerprint.headSha,
        expectedDiffHash: receipt.fingerprint.diffHash,
      })
      assert.equal(identity.ok, false)
      assert.ok(identity.problems.some((problem) => problem.includes('工作树内容')))
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
