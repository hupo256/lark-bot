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
  resolveLegacyPrdsRoot,
  resolveLegacyProjectRoot,
  resolvePrdCacheRoot,
} from '../lib/lark-paths.mjs'

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

  it('legacyPrdsRoot：目录不存在时为 null（消费方据此跳过）', () => {
    assert.equal(resolveLegacyPrdsRoot({ localConfig: { legacyPrdsRoot: '/no/such/prds' } }), null)
    assert.equal(resolveLegacyPrdsRoot({ localConfig: { legacyPrdsRoot: '/tmp/prds' }, exists: () => true }), '/tmp/prds')
  })

  it('resolveLegacyProjectRoot：无存量根 → null；有 active-change 指针 → changes/<id>；坏指针抛错', () => {
    assert.equal(resolveLegacyProjectRoot('PR-00001', { prdsRoot: null }), null)
    assert.throws(() => resolveLegacyProjectRoot('', { prdsRoot: '/tmp' }), /projectId is empty/)
    const root = mkdtempSync(join(tmpdir(), 'lark-paths-'))
    try {
      assert.equal(resolveLegacyProjectRoot('PR-00001', { prdsRoot: root }), join(root, 'PR-00001'))
      mkdirSync(join(root, 'PR-00002'), { recursive: true })
      writeFileSync(join(root, 'PR-00002', 'active-change.json'), JSON.stringify({ schemaVersion: 1, projectId: 'PR-00002', changeId: 'c1' }))
      assert.equal(resolveLegacyProjectRoot('PR-00002', { prdsRoot: root }), join(root, 'PR-00002', 'changes', 'c1'))
      mkdirSync(join(root, 'PR-00003'), { recursive: true })
      writeFileSync(join(root, 'PR-00003', 'active-change.json'), JSON.stringify({ schemaVersion: 1, projectId: 'PR-00003', changeId: '../x' }))
      assert.throws(() => resolveLegacyProjectRoot('PR-00003', { prdsRoot: root }), /changeId/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
