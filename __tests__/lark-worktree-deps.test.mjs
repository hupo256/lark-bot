import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { prepareRootTools } from '../lib/lark-worktree-deps.mjs'

test('no hook needs no install; linked node_modules fails before pnpm runs', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lark-deps-'))
  try {
    prepareRootTools(cwd)
    mkdirSync(join(cwd, '.husky'))
    writeFileSync(join(cwd, '.husky', 'pre-commit'), '#!/bin/sh\n')
    writeFileSync(join(cwd, 'pnpm-lock.yaml'), 'lockfileVersion: "9.0"\n')
    writeFileSync(join(cwd, 'package.json'), '{"name":"test-root","packageManager":"pnpm@10.8.0"}\n')
    symlinkSync(cwd, join(cwd, 'node_modules'), 'dir')
    assert.throws(() => prepareRootTools(cwd), /外部软链/)
    assert.equal(existsSync(join(cwd, 'node_modules')), true)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('filtered install prepares root hooks and binaries without installing unrelated packages', {
  skip: spawnSync('pnpm', ['--version'], { encoding: 'utf8' }).status !== 0,
}, () => {
  const cwd = mkdtempSync(join(tmpdir(), 'lark-pnpm-filter-'))
  const tool = join(cwd, 'packages', 'tool')
  const unrelated = join(cwd, 'packages', 'unrelated')
  try {
    mkdirSync(join(cwd, '.husky'))
    mkdirSync(tool, { recursive: true })
    mkdirSync(unrelated, { recursive: true })
    writeFileSync(join(cwd, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({
      name: 'test-root',
      private: true,
      packageManager: 'pnpm@10.8.0',
      scripts: { postinstall: 'node prepare.mjs' },
      devDependencies: { 'test-tool': 'workspace:*' },
    }))
    writeFileSync(join(cwd, 'prepare.mjs'), "import { mkdirSync, writeFileSync } from 'node:fs'; mkdirSync('.husky/_', { recursive: true }); writeFileSync('.husky/_/husky.sh', 'ready');\n")
    writeFileSync(join(cwd, '.husky', 'pre-commit'), '#!/bin/sh\n')
    writeFileSync(join(tool, 'package.json'), JSON.stringify({
      name: 'test-tool',
      version: '1.0.0',
      bin: { 'lint-staged': 'bin.js', biome: 'bin.js' },
    }))
    writeFileSync(join(tool, 'bin.js'), '#!/usr/bin/env node\n', { mode: 0o755 })
    writeFileSync(join(unrelated, 'package.json'), JSON.stringify({
      name: 'unrelated',
      version: '1.0.0',
      scripts: { postinstall: 'node -e "require(\'fs\').writeFileSync(\'installed\', \'yes\')"' },
    }))
    const lock = spawnSync('pnpm', ['install', '--lockfile-only', '--ignore-scripts', '--offline'], {
      cwd, encoding: 'utf8', timeout: 30000,
    })
    assert.equal(lock.status, 0, lock.stderr || lock.stdout)
    prepareRootTools(cwd)
    assert.ok(existsSync(join(cwd, '.husky', '_', 'husky.sh')))
    assert.ok(existsSync(join(cwd, 'node_modules', '.bin', 'lint-staged')))
    assert.ok(existsSync(join(cwd, 'node_modules', '.bin', 'biome')))
    assert.equal(existsSync(join(unrelated, 'node_modules')), false)
    assert.equal(existsSync(join(unrelated, 'installed')), false)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
