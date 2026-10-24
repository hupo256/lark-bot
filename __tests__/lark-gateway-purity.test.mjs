import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, it } from 'node:test'

// gateway 纯度闸（第 1 批）：gateway 进程只做接入 + 存储 + HTTP。日报曾在它里面 spawnSync 跑 git / 探针，把 HTTP、
// 长连接、轮询全冻住几分钟；「收到」曾在它里面起 claude。这里把 lark-gateway.mjs 的 import 闭包整个扫一遍，
// 以后任何人把同步子进程 / 模型调用 / worker 专属模块带进 gateway，这条测试先红。
const root = resolve(new URL('..', import.meta.url).pathname)
const closureOf = (entry) => {
  const seen = new Set()
  const queue = [resolve(root, entry)]
  while (queue.length) {
    const file = queue.pop()
    if (seen.has(file)) continue
    seen.add(file)
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/from '(\.{1,2}\/[^']+)'/g)) queue.push(resolve(dirname(file), match[1]))
  }
  return [...seen].map((file) => relative(root, file))
}

// 只看代码不看注释：注释里提到「不再 spawnSync」不算。
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/[^:'"]\/\/.*$/gm, '')
const CHILD_PROCESS_ALLOWED = new Set(['lib/lark-cli.mjs', 'lib/lark-consumer.mjs', 'lib/lark-keep-awake.mjs', 'lib/lark-power.mjs', 'lib/lark-git-read.mjs', 'lib/lark-daily-sweep.mjs'])
const WORKER_ONLY = /lib\/lark-(daily-report|ai-executor|doc|worker-run|worker-git|worker-prompts|task-runner|quality-gate|final-verification|system-runner|triage|rule-context)\.mjs$/

describe('gateway 纯度闸', () => {
  const closure = closureOf('lark-gateway.mjs')
  it('gateway 闭包无同步子进程与模型调用，child_process 只在固定模块，worker 专属模块不进闭包', () => {
    {
      // 闭包里没有同步子进程、没有模型调用
      const offenders = closure.filter((file) => {
        const source = stripComments(readFileSync(join(root, file), 'utf8'))
        return /\b(spawnSync|execSync|execFileSync)\b/.test(source) || /spawn\(['"](claude|codex|pi|cursor-agent)['"]/.test(source)
      })
      assert.deepEqual(offenders, [], `gateway 闭包里出现同步子进程 / 模型调用：${offenders.join('、')}`)
    }

    {
      // node:child_process 只允许在固定几个模块里出现
      const offenders = closure.filter((file) => /node:child_process/.test(stripComments(readFileSync(join(root, file), 'utf8'))) && !CHILD_PROCESS_ALLOWED.has(file))
      assert.deepEqual(offenders, [], `child_process 越界：${offenders.join('、')}`)
    }

    {
      // worker 专属模块不进 gateway 闭包
      const offenders = closure.filter((file) => WORKER_ONLY.test(file))
      assert.deepEqual(offenders, [], `worker 模块进了 gateway：${offenders.join('、')}`)
    }
  })
})
