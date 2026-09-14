/**
 * Lark 轻量终检：不接入 docs_tdd v3.3 状态机，只对 Worker 即将提交的最终工作树生成可复核回执。
 * AI 的 checks 仍作为分析说明保留，但不再是唯一证据；这里的命令由 Worker 直接执行并绑定 HEAD + diffHash。
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const BIOME_FILE_RE = /\.(?:cjs|css|js|jsx|json|mjs|ts|tsx)$/i
const OUTPUT_LIMIT = 4000

const tail = (value, limit = OUTPUT_LIMIT) => String(value || '').trim().slice(-limit)
const normalizeFiles = (files) => [...new Set((files || []).map((file) => String(file).replace(/^\.\//, '').trim()).filter(Boolean))].sort()
const run = (command, args, cwd) => spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })

const commandReceipt = ({ id, command, args, result, startedAt, completedAt }) => ({
  id,
  command: [command, ...args].join(' '),
  status: result.status === 0 ? 'passed' : 'failed',
  ok: result.status === 0,
  exitCode: Number.isInteger(result.status) ? result.status : null,
  signal: result.signal || null,
  startedAt,
  completedAt,
  stdout: tail(result.stdout),
  stderr: tail(result.stderr || result.error?.message),
})

const failedReceipt = ({ id, command, reason, now }) => {
  const at = now().toISOString()
  return {
    id,
    command,
    status: 'failed',
    ok: false,
    exitCode: null,
    signal: null,
    startedAt: at,
    completedAt: at,
    stdout: '',
    stderr: reason,
  }
}

export const selectBiomeFiles = ({ cwd, changedFiles } = {}) =>
  normalizeFiles(changedFiles).filter((file) => BIOME_FILE_RE.test(file) && existsSync(join(cwd, file)))

const runCheck = ({ id, command, args, cwd, now }) => {
  const startedAt = now().toISOString()
  const result = run(command, args, cwd)
  return commandReceipt({ id, command, args, result, startedAt, completedAt: now().toISOString() })
}

// 指纹读取自身先登记 intent-to-add，确保终检后新出现的未跟踪文件也进入提交前比较。
// 这是 Worker 终检与真正 commit 之间的乐观锁；任一 git 命令失败都不能退化成空指纹通过。
export const captureWorkingTreeFingerprint = ({ cwd } = {}) => {
  const intent = run('git', ['add', '-A', '-N'], cwd)
  if (intent.status !== 0) {
    return {
      ok: false,
      headSha: '',
      diffHash: '',
      error: tail(intent.stderr || intent.error?.message || 'git add -A -N 失败'),
    }
  }

  const head = run('git', ['rev-parse', 'HEAD'], cwd)
  const diff = run('git', ['diff', '--binary', 'HEAD'], cwd)
  if (head.status !== 0 || diff.status !== 0) {
    return {
      ok: false,
      headSha: head.status === 0 ? head.stdout.trim() : '',
      diffHash: '',
      error: tail(head.stderr || diff.stderr || head.error?.message || diff.error?.message || '无法读取最终工作树指纹'),
    }
  }

  const headSha = head.stdout.trim()
  return {
    ok: true,
    headSha,
    diffHash: createHash('sha256').update(headSha).update('\0').update(diff.stdout).digest('hex'),
    error: '',
  }
}

export const inspectWorkingTreeFingerprint = ({ cwd, expectedHeadSha, expectedDiffHash } = {}) => {
  const current = captureWorkingTreeFingerprint({ cwd })
  const problems = []
  if (!current.ok) problems.push(`无法读取提交前工作树指纹：${current.error}`)
  if (current.ok && expectedHeadSha && current.headSha !== expectedHeadSha) {
    problems.push(`终检后 HEAD 从 ${expectedHeadSha.slice(0, 12)} 变为 ${current.headSha.slice(0, 12)}`)
  }
  if (current.ok && expectedDiffHash && current.diffHash !== expectedDiffHash) {
    problems.push(`终检后工作树内容从 ${expectedDiffHash.slice(0, 12)} 漂移为 ${current.diffHash.slice(0, 12)}`)
  }
  return {
    ...current,
    ok: current.ok && problems.length === 0,
    expectedHeadSha: expectedHeadSha || '',
    expectedDiffHash: expectedDiffHash || '',
    problems,
  }
}

export const formatWorkerVerificationLine = (receipt) => {
  if (!receipt?.checks?.length) return 'Worker 终检未生成回执'
  const checks = receipt.checks.map((check) => {
    if (check.status === 'not-required') return `${check.id} not-required`
    return `${check.id} ${check.ok ? '✓' : '✗'}`
  })
  return `${checks.join(' · ')} · diff ${receipt.fingerprint?.diffHash?.slice(0, 12) || '(unknown)'}`
}

export const runFinalVerification = ({ cwd, changedFiles, now = () => new Date() } = {}) => {
  const files = normalizeFiles(changedFiles)
  const checks = []

  // 把未跟踪文件登记为 intent-to-add，让下面的 diff/check/fingerprint 都覆盖最终内容；不暂存文件内容。
  // 该命令失败时无法证明未跟踪文件已纳入终检，必须立即 fail-closed。
  const intentToAdd = runCheck({ id: 'intent-to-add', command: 'git', args: ['add', '-A', '-N'], cwd, now })
  checks.push(intentToAdd)
  if (!intentToAdd.ok) {
    return {
      assuranceMode: 'lark-lightweight',
      deliveryAuthority: false,
      scope: 'final-working-tree',
      status: 'failed',
      ok: false,
      generatedAt: now().toISOString(),
      fingerprint: { headSha: '', diffHash: '', changedFiles: files },
      checks,
    }
  }

  checks.push(runCheck({ id: 'git-diff-check', command: 'git', args: ['diff', '--check', 'HEAD', '--', ...files], cwd, now }))

  const biomeFiles = selectBiomeFiles({ cwd, changedFiles: files })
  if (!biomeFiles.length) {
    const at = now().toISOString()
    checks.push({
      id: 'biome',
      command: 'biome check',
      status: 'not-required',
      ok: true,
      reason: '本次无 Biome 支持且仍存在的改动文件',
      startedAt: at,
      completedAt: at,
      stdout: '',
      stderr: '',
    })
  } else {
    const biome = join(cwd, 'node_modules', '.bin', 'biome')
    checks.push(
      existsSync(biome)
        ? runCheck({
            id: 'biome',
            command: biome,
            args: ['check', '--files-ignore-unknown=true', '--no-errors-on-unmatched', ...biomeFiles],
            cwd,
            now,
          })
        : failedReceipt({ id: 'biome', command: `${biome} check`, reason: `找不到可执行文件 ${biome}`, now }),
    )
  }

  const fingerprint = captureWorkingTreeFingerprint({ cwd })
  if (!fingerprint.ok) {
    checks.push(
      failedReceipt({
        id: 'fingerprint',
        command: 'git add -A -N && git rev-parse HEAD && git diff --binary HEAD',
        reason: fingerprint.error,
        now,
      }),
    )
  }

  const { headSha, diffHash } = fingerprint
  const ok = checks.every((check) => check.ok)
  return {
    assuranceMode: 'lark-lightweight',
    deliveryAuthority: false,
    scope: 'final-working-tree',
    status: ok ? 'passed' : 'failed',
    ok,
    generatedAt: now().toISOString(),
    fingerprint: { headSha, diffHash, changedFiles: files },
    checks,
  }
}
