import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { VERIFY_GATES, runVerifyGates } from '../lib/lark-task-gates.mjs'
import { registerRepoProfiles, resetRepoProfiles } from '../lib/lark-repo-profile.mjs'

// 闸门预算（第 2 批）：注册表长度锁死，新增一道必须合并或删一道旧的；每道闸必须有 owner / addedAt / applies / check。
const GATE_BUDGET = 16

describe('完成态核验闸注册表', () => {
  it('注册表 ≤ 预算，元数据齐全，名字唯一', () => {
    assert.ok(VERIFY_GATES.length <= GATE_BUDGET, `闸门 ${VERIFY_GATES.length} 道，超过预算 ${GATE_BUDGET}：先合并旧闸再加`)
    const names = new Set()
    for (const gate of VERIFY_GATES) {
      assert.match(gate.name, /^[a-z][a-z0-9.-]*$/)
      assert.ok(!names.has(gate.name), `闸门重名 ${gate.name}`)
      names.add(gate.name)
      assert.equal(typeof gate.owner, 'string')
      assert.match(gate.addedAt, /^\d{4}-\d{2}-\d{2}$/)
      assert.equal(typeof gate.applies, 'function')
      assert.equal(typeof gate.check, 'function')
    }
  })

  it('按顺序跑，第一道失败即短路；通过时汇总 warnNotes 与各闸产出；证据只采一次', async () => {
    registerRepoProfiles({ repos: { falive: { root: '/tmp/falive-react', baseRef: 'main', chatIds: ['oc'], docIntakeDir: 'docs/pending' } } })
    try {
      const calls = []
      const gitCalls = []
      const deps = {
        enforceCodeQuality: async () => { calls.push('lint'); return { ok: true, remaining: [], hardRemaining: [], softRemaining: [] } },
        gitAt: (cwd, args) => { gitCalls.push(args.join(' ')); return { stdout: args.includes('--name-only') ? 'src/a.ts\n' : args.includes('--numstat') ? '3\t1\tsrc/a.ts\n' : '1 file changed' } },
        inspectWorktreeIdentity: () => { calls.push('identity'); return { ok: true } },
        prepareRootTools: () => { calls.push('tools') },
        runFinalVerification: () => { calls.push('verify'); return { ok: true, fingerprint: { headSha: 'h', diffHash: 'd' }, checks: [] } },
        runCodeRulesScan: () => { calls.push('rules'); return { ran: true, findings: [] } },
        assessDoneResult: () => { calls.push('trust'); return { trustworthy: true, notes: ['AI 漏报 1 个文件'] } },
        resolveScopeGate: () => { calls.push('scope'); return { check: { ok: true }, blockedText: null, warnNotes: ['兄弟位置未改'], scopeRequest: null } },
      }
      const base = { task: { id: 't', repo: 'falive', text: 'x' }, workContext: { cwd: '/tmp/falive-react', readOnly: false, baseRef: 'main' }, aiRun: { result: { changedFiles: ['src/a.ts'], checks: [] }, scope: null }, expectsCode: true, executionIdentity: { branch: 'b', headSha: 'h' }, workerConfig: { localConfig: {} }, deps }
      const ok = await runVerifyGates(base)
      assert.equal(ok.ok, true)
      assert.deepEqual(calls, ['lint', 'identity', 'tools', 'verify', 'rules', 'trust', 'scope'])
      assert.deepEqual(ok.warnNotes, ['AI 漏报 1 个文件', '兄弟位置未改'])
      assert.deepEqual(ok.outputs.actualChangedFiles, ['src/a.ts'])
      assert.equal(gitCalls.filter((args) => args.includes('--name-only')).length, 1, '证据只采一次')
      assert.deepEqual(ok.audit.verifyGates, ['lint', 'evidence', 'identity.stable', 'env.verify', 'code-rules', 'done.trust', 'scope'])

      calls.length = 0
      const failed = await runVerifyGates({ ...base, deps: { ...deps, enforceCodeQuality: async () => { calls.push('lint'); return { ok: false, remaining: [{ kind: 'dead-color', file: 'a', line: 1, text: 'text-green' }], hardRemaining: [{ kind: 'dead-color', file: 'a', line: 1, text: 'text-green' }], softRemaining: [] } } } })
      assert.equal(failed.ok, false)
      assert.deepEqual([failed.gate, failed.status], ['lint', 'failed'])
      assert.deepEqual(calls, ['lint'], 'hard 失败即短路，后面的闸不跑')

      const scoped = await runVerifyGates({ ...base, deps: { ...deps, resolveScopeGate: () => ({ check: { ok: false }, blockedText: '越界', warnNotes: [], scopeRequest: { paths: ['src/b.ts'] } }) } })
      assert.deepEqual([scoped.gate, scoped.status, scoped.extra.scopeRequest.paths], ['scope', 'waiting_confirmation', ['src/b.ts']])

      // 只读任务：lint / 身份 / 终检 / 规则不跑，只剩 evidence + done.trust
      const ro = await runVerifyGates({ ...base, workContext: { ...base.workContext, readOnly: true }, expectsCode: false })
      assert.deepEqual(ro.audit.verifyGates, ['evidence', 'done.trust'])
    } finally {
      resetRepoProfiles()
    }
  })
})
