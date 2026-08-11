#!/usr/bin/env node
/**
 * 运行版本指纹单测：常驻进程「跑着旧代码」是无人值守系统的元级故障，检测逻辑本身必须有回归保护。
 *
 *   node --test common/lark-bot/__tests__/lark-runtime-version.test.mjs
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  computeCodeHash,
  createRuntimeVersion,
  listSourceFiles,
  readWorkerHeartbeat,
  versionWarnings,
  writeWorkerHeartbeat,
} from '../lib/lark-runtime-version.mjs'

const makeTree = () => {
  const root = mkdtempSync(join(tmpdir(), 'lark-version-'))
  mkdirSync(join(root, 'lib'), { recursive: true })
  mkdirSync(join(root, 'docs'), { recursive: true })
  mkdirSync(join(root, '__tests__'), { recursive: true })
  mkdirSync(join(root, 'runtime', 'lark-tasks'), { recursive: true })
  writeFileSync(join(root, 'lib', 'a.mjs'), 'export const a = 1\n')
  writeFileSync(join(root, 'lib', 'b.mjs'), 'export const b = 2\n')
  writeFileSync(join(root, 'schemas.json'), '{"x":1}\n')
  writeFileSync(join(root, 'docs', 'guide.md'), '# doc\n')
  writeFileSync(join(root, '__tests__', 'x.test.mjs'), 'assert(true)\n')
  writeFileSync(join(root, 'runtime', 'lark-bot.local.json'), '{"project":"PR-00001"}\n')
  writeFileSync(join(root, 'runtime', 'lark-bugtable-state.json'), '{"seen":[]}\n')
  writeFileSync(join(root, 'runtime', 'lark-tasks', 't1.json'), '{"id":"t1"}\n')
  return root
}

describe('lark-runtime-version', () => {
  it('只收录源文件：排除 docs / __tests__ / 队列数据 / 本地配置 / *-state.json', () => {
    const root = makeTree()
    try {
      assert.deepEqual(listSourceFiles(root), ['lib/a.mjs', 'lib/b.mjs', 'schemas.json'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('改源文件改变 hash；改文档 / 配置 / 队列数据不改变 hash', () => {
    const root = makeTree()
    try {
      const base = computeCodeHash(root).hash
      writeFileSync(join(root, 'docs', 'guide.md'), '# doc changed\n')
      writeFileSync(join(root, 'runtime', 'lark-bot.local.json'), '{"project":"PR-00002"}\n')
      writeFileSync(join(root, 'runtime', 'lark-tasks', 't1.json'), '{"id":"t1","status":"done"}\n')
      assert.equal(computeCodeHash(root).hash, base, '非源文件改动不应触发 codeStale（否则告警成噪音）')

      writeFileSync(join(root, 'lib', 'a.mjs'), 'export const a = 99\n')
      assert.notEqual(computeCodeHash(root).hash, base)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('纯改名也改变 hash（路径进 digest，不只哈希内容）', () => {
    const root = makeTree()
    try {
      const base = computeCodeHash(root).hash
      rmSync(join(root, 'lib', 'b.mjs'))
      writeFileSync(join(root, 'lib', 'c.mjs'), 'export const b = 2\n')
      assert.notEqual(computeCodeHash(root).hash, base)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('observe(): 启动后磁盘被改 → codeStale + 可操作告警；TTL 内不重算', () => {
    const root = makeTree()
    const configPath = join(root, 'runtime', 'lark-bot.local.json')
    try {
      let clock = 1_000_000
      const version = createRuntimeVersion({ root, configPath, ttlMs: 10_000, now: () => clock })
      assert.equal(version.observe().codeStale, false)
      assert.equal(versionWarnings(version.observe()).length, 0)

      writeFileSync(join(root, 'lib', 'a.mjs'), 'export const a = 42\n')
      assert.equal(version.observe().codeStale, false, 'TTL 未过期时应复用缓存')

      clock += 20_000
      const observed = version.observe()
      assert.equal(observed.codeStale, true)
      assert.equal(observed.codeHash, version.codeHash, 'codeHash 始终是启动时加载的那一版')
      assert.notEqual(observed.diskCodeHash, observed.codeHash)
      const warnings = versionWarnings(observed)
      assert.equal(warnings.length, 1)
      assert.match(warnings[0], /lark-bot restart/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('observe(): 改配置文件 → configStale 独立于 codeStale', () => {
    const root = makeTree()
    const configPath = join(root, 'runtime', 'lark-bot.local.json')
    try {
      let clock = 1_000_000
      const version = createRuntimeVersion({ root, configPath, ttlMs: 0, now: () => clock })
      writeFileSync(configPath, '{"project":"PR-09999"}\n')
      clock += 1
      const observed = version.observe()
      assert.equal(observed.configStale, true)
      assert.equal(observed.codeStale, false)
      assert.equal(versionWarnings(observed).length, 1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('worker 心跳：写入可读回，版本不一致与心跳过期各自可判', () => {
    const root = makeTree()
    const runtimeDir = join(root, 'runtime')
    try {
      let clock = 1_000_000
      writeWorkerHeartbeat({
        runtimeDir,
        version: { startedAt: '2026-08-11T00:00:00.000Z', codeHash: 'aaaaaaaaaaaa' },
        extra: { inFlight: 2 },
        now: () => clock,
      })

      const fresh = readWorkerHeartbeat({ runtimeDir, expectedCodeHash: 'aaaaaaaaaaaa', now: () => clock })
      assert.equal(fresh.inFlight, 2)
      assert.equal(fresh.codeStale, false)
      assert.equal(fresh.heartbeatStale, false)

      const drifted = readWorkerHeartbeat({ runtimeDir, expectedCodeHash: 'bbbbbbbbbbbb', now: () => clock })
      assert.equal(drifted.codeStale, true, 'gateway 已是新代码而 worker 仍旧 → 半重启态必须能发现')

      clock += 10 * 60_000
      assert.equal(readWorkerHeartbeat({ runtimeDir, expectedCodeHash: 'aaaaaaaaaaaa', now: () => clock }).heartbeatStale, true)

      // 心跳文件必须落在 *-state.json 命名上，否则它自己会让 codeHash 每分钟漂移。
      assert.equal(listSourceFiles(root).some((f) => f.includes('lark-worker-state')), false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('心跳缺失（worker 未启动 / 旧版本不写心跳）返回 null 而不抛', () => {
    const root = makeTree()
    try {
      assert.equal(readWorkerHeartbeat({ runtimeDir: join(root, 'nope'), expectedCodeHash: 'x' }), null)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
