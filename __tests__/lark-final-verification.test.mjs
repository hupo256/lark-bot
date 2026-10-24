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
  it('实跑 git diff --check + Biome 并绑定回执；profile finalChecks 按改动跑 typecheck / tests', () => {
    {
      const t1 = '实跑 git diff --check + Biome，并把回执绑定到 HEAD/diffHash'
      const cwd = makeRepo()
      try {
        writeFileSync(join(cwd, 'source.ts'), 'export const value = 2\n')
        const receipt = runFinalVerification({ cwd, changedFiles: ['source.ts'], now: fixedNow })
        assert.equal(receipt.ok, true, t1)
        assert.equal(receipt.assuranceMode, 'lark-lightweight', t1)
        assert.equal(receipt.deliveryAuthority, false, t1)
        assert.equal(receipt.fingerprint.headSha.length, 40, t1)
        assert.equal(receipt.fingerprint.diffHash.length, 64, t1)
        assert.deepEqual(receipt.checks.map((check) => check.status), ['passed', 'passed', 'passed'], t1)
        assert.match(formatWorkerVerificationLine(receipt), /intent-to-add ✓.*git-diff-check ✓.*biome ✓.*diff [a-f0-9]{12}/, t1)
      } finally {
        rmSync(cwd, { recursive: true, force: true })
      }
    }

    {
      const t2 = '仓库 profile 的 finalChecks：改了 .ts 跑 typecheck、改了 *.test.ts 对该文件跑 tests，任一失败整体不通过'
      const cwd = makeRepo()
      try {
        writeFileSync(join(cwd, 'source.ts'), 'export const value = 2\n')
        writeFileSync(join(cwd, 'source.test.ts'), 'export const t = 1\n')
        const tsc = join(cwd, 'node_modules', '.bin', 'tsc')
        writeFileSync(tsc, '#!/bin/sh\necho "$@" > tsc.args\nexit 0\n'); chmodSync(tsc, 0o755)
        const vitest = join(cwd, 'node_modules', '.bin', 'vitest')
        writeFileSync(vitest, '#!/bin/sh\necho "$@" > vitest.args\nexit 1\n'); chmodSync(vitest, 0o755)
        const finalChecks = { typecheck: ['node_modules/.bin/tsc', '--noEmit'], tests: ['node_modules/.bin/vitest', 'run'], timeoutMs: 60_000 }
        const receipt = runFinalVerification({ cwd, changedFiles: ['source.ts', 'source.test.ts', 'tsc.args', 'vitest.args'], now: fixedNow, finalChecks })
        const byId = Object.fromEntries(receipt.checks.map((check) => [check.id, check]))
        assert.equal(byId.typecheck.ok, true, t2)
        assert.equal(byId.tests.ok, false, 'vitest 退出 1 → 终检失败')
        assert.equal(receipt.ok, false, t2)
        assert.match(formatWorkerVerificationLine(receipt), /typecheck ✓ · tests ✗/, t2)
        // 只改 markdown：两项都不跑
        const mdOnly = runFinalVerification({ cwd, changedFiles: ['note.md'], now: fixedNow, finalChecks })
        assert.ok(!mdOnly.checks.some((check) => check.id === 'typecheck' || check.id === 'tests'), t2)
      } finally {
        rmSync(cwd, { recursive: true, force: true })
      }
    }
  })

  it('终检失败与阻断：whitespace error、Biome 非零、intent-to-add 失败、提交前指纹变化', () => {
    {
      const t1 = '最终内容有 whitespace error 时 Worker 终检失败'
      const cwd = makeRepo()
      try {
        writeFileSync(join(cwd, 'source.ts'), 'export const value = 2  \n')
        const receipt = runFinalVerification({ cwd, changedFiles: ['source.ts'], now: fixedNow })
        assert.equal(receipt.ok, false, t1)
        assert.equal(receipt.checks.find((check) => check.id === 'git-diff-check').status, 'failed', t1)
      } finally {
        rmSync(cwd, { recursive: true, force: true })
      }
    }

    {
      const t2 = 'Biome 非零退出被记录并阻断，不采信 AI checks'
      const cwd = makeRepo({ biomeExit: 7 })
      try {
        writeFileSync(join(cwd, 'source.ts'), 'export const value = 2\n')
        const receipt = runFinalVerification({ cwd, changedFiles: ['source.ts'], now: fixedNow })
        const biome = receipt.checks.find((check) => check.id === 'biome')
        assert.equal(receipt.ok, false, t2)
        assert.equal(biome.exitCode, 7, t2)
        assert.equal(biome.status, 'failed', t2)
      } finally {
        rmSync(cwd, { recursive: true, force: true })
      }
    }

    {
      const t3 = 'intent-to-add 失败时立即 fail-closed，不伪造未跟踪文件已纳入终检'
      const cwd = mkdtempSync(join(tmpdir(), 'lark-final-verify-not-git-'))
      try {
        const receipt = runFinalVerification({ cwd, changedFiles: [], now: fixedNow })
        assert.equal(receipt.ok, false, t3)
        assert.deepEqual(receipt.checks.map((check) => check.id), ['intent-to-add'], t3)
        assert.equal(receipt.checks[0].status, 'failed', t3)
        assert.equal(receipt.fingerprint.diffHash, '', t3)
      } finally {
        rmSync(cwd, { recursive: true, force: true })
      }
    }

    {
      const t4 = '终检后同路径内容变化会被提交前指纹校验拒绝'
      const cwd = makeRepo()
      try {
        writeFileSync(join(cwd, 'source.ts'), 'export const value = 2\n')
        const receipt = runFinalVerification({ cwd, changedFiles: ['source.ts'], now: fixedNow })
        assert.equal(receipt.ok, true, t4)

        writeFileSync(join(cwd, 'source.ts'), 'export const value = 3\n')
        const identity = inspectWorkingTreeFingerprint({
          cwd,
          expectedHeadSha: receipt.fingerprint.headSha,
          expectedDiffHash: receipt.fingerprint.diffHash,
        })
        assert.equal(identity.ok, false, t4)
        assert.ok(identity.problems.some((problem) => problem.includes('工作树内容')), t4)
      } finally {
        rmSync(cwd, { recursive: true, force: true })
      }
    }
  })
})
