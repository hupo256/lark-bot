import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import {
  attachmentsDirFor,
  auditDirFor,
  larkAttachmentsRoot,
  larkAuditsRoot,
  larkBotRoot,
  larkRuntimeDir,
  resolveConsumerRoot,
  resolvePrdCacheRoot,
} from '../lib/lark-paths.mjs'
import { prdCacheDocsFor } from '../lib/lark-work-context.mjs'

describe('lark-paths 基座', () => {
  it('larkBotRoot 锚定到本仓根，运行态目录都在 runtime/ 下', () => {
    assert.equal(larkBotRoot, dirname(dirname(fileURLToPath(import.meta.url))))
    assert.equal(larkRuntimeDir, join(larkBotRoot, 'runtime'))
    assert.equal(attachmentsDirFor('PR-00001', 'om_x'), join(larkAttachmentsRoot, 'PR-00001', 'om_x'))
    assert.equal(auditDirFor('PR-00001'), join(larkAuditsRoot, 'PR-00001'))
    assert.equal(auditDirFor(''), join(larkAuditsRoot, '_adhoc'))
  })

  it('consumerRoot：env > local.json > 默认；支持 ~ 展开', () => {
    assert.equal(resolveConsumerRoot({ env: { LARK_BOT_CONSUMER_ROOT: '/tmp/a' }, localConfig: { consumerRoot: '/tmp/b' } }), '/tmp/a')
    assert.equal(resolveConsumerRoot({ env: {}, localConfig: { consumerRoot: '~/x' } }), join(homedir(), 'x'))
    assert.equal(resolveConsumerRoot({ env: { LARK_BOT_CONSUMER_ROOT: '  ' }, localConfig: {} }), '/Users/aven/github/fameex-web')
  })

  it('prdCacheRoot：env > ~/.prd-cache', () => {
    assert.equal(resolvePrdCacheRoot({ env: { LARK_BOT_PRD_CACHE: '/tmp/cache' } }), '/tmp/cache')
    assert.equal(resolvePrdCacheRoot({ env: {} }), join(homedir(), '.prd-cache'))
  })
})

describe('prdCacheDocsFor（项目文档只来自 PRD 缓存）', () => {
  const touch = (path) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, 'x')
  }

  it('取 rev 最大且含 prd.md 的 r<rev>，并带上同项目根下的 checklist / plan', () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), 'lark-prd-cache-'))
    try {
      touch(join(cacheRoot, 'PR-00001/r98/prd.md'))
      touch(join(cacheRoot, 'PR-00001/r1679/prd.md'))
      mkdirSync(join(cacheRoot, 'PR-00001/r2000'), { recursive: true }) // 新 rev 没有 prd.md（抓取未完成）：跳过
      touch(join(cacheRoot, 'PR-00001/checklist.md'))
      assert.deepEqual(prdCacheDocsFor('PR-00001', { cacheRoot }), [
        join(cacheRoot, 'PR-00001/r1679/prd.md'),
        join(cacheRoot, 'PR-00001/checklist.md'),
      ])
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true })
    }
  })

  it('没有 r<rev> 时用 manual/prd.md；项目目录不存在 → 空', () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), 'lark-prd-cache-'))
    try {
      touch(join(cacheRoot, 'PR-00002/manual/prd.md'))
      touch(join(cacheRoot, 'PR-00002/plan.md'))
      assert.deepEqual(prdCacheDocsFor('PR-00002', { cacheRoot }), [
        join(cacheRoot, 'PR-00002/manual/prd.md'),
        join(cacheRoot, 'PR-00002/plan.md'),
      ])
      assert.deepEqual(prdCacheDocsFor('PR-09999', { cacheRoot }), [])
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true })
    }
  })

})
