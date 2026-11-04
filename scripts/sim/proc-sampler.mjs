/**
 * 一个回放实例（run-sim 进程及其全部子孙：网关、worker、claude-q、claude、它们起的 bash / node / vite / 浏览器）的资源采样：
 *   · 内存（design-v2 §8 P0-e）：每 intervalMs 跑一次 ps，按进程树求 RSS 和，落 SIM_DIR/mem.jsonl（每次一行），峰值并进 mem-peak.json
 *     （同一 sim 跨天多次 run-sim 取最大）。RSS 和会把共享页重复算，偏保守，用来定并发上限正合适。
 *   · 出网兜底（前置 7）：每 sockEvery 次采样跑一次 lsof，记进程树里所有已建立的 TCP 连接的对端 IP:端口到 egress.log（via sock，
 *     同一进程名 + 对端只记一次）——curl 壳和 fetch 预载看不到的（claude 本体、浏览器、python 等）都靠它。起跑时把放行主机解析成 IP
 *     存 egress-dns.json，egress-audit.mjs 按它归类。
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { lookup } from 'node:dns/promises'
import { join } from 'node:path'

import { LOCAL_HOST_RE, claudeGatewayHost, noteEgress } from './egress-log.mjs'

// 放行主机里能解析的那几个（通配的子域名靠 egress-audit 的 IP 段 / 反查兜）
export const RESOLVE_HOSTS = ['api.anthropic.com', 'statsig.anthropic.com', 'claude.ai', 'console.anthropic.com', 'falivepre.fdsser.com', 'faliveuat.fdsser.com', 'streampre.fdsser.com', 'falivego.fdsser.com', 'www.falive.com', 'falive.com']

const realNow = () => Math.round(performance.timeOrigin + performance.now())
const descendants = (rows, root) => {
  const kids = new Map()
  for (const r of rows) { if (!kids.has(r.ppid)) kids.set(r.ppid, []); kids.get(r.ppid).push(r) }
  const out = []
  const stack = [root]
  const seen = new Set()
  while (stack.length) {
    const pid = stack.pop()
    if (seen.has(pid)) continue
    seen.add(pid)
    const row = rows.find((r) => r.pid === pid)
    if (row) out.push(row)
    for (const k of kids.get(pid) || []) stack.push(k.pid)
  }
  return out
}
const psRows = () => {
  const out = spawnSync('ps', ['-axo', 'pid=,ppid=,rss=,comm='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  return String(out.stdout || '').split('\n').map((l) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), rssKb: Number(m[3]), comm: m[4].trim().split('/').pop() }))
}

export const startSampler = ({ simDir, rootPid = process.pid, intervalMs = 5000, sockEvery = 2 } = {}) => {
  lookup('localhost').catch(() => {})
  Promise.all([...RESOLVE_HOSTS, ...(claudeGatewayHost() ? [claudeGatewayHost()] : [])].map((h) => lookup(h, { all: true }).then((list) => list.map((x) => [x.address, h])).catch(() => [])))
    .then((pairs) => {
      const path = join(simDir, 'egress-dns.json')
      const prev = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
      writeFileSync(path, JSON.stringify({ ...prev, ...Object.fromEntries(pairs.flat()) }, null, 1))
    })
  const peakPath = join(simDir, 'mem-peak.json')
  let peak = existsSync(peakPath) ? JSON.parse(readFileSync(peakPath, 'utf8')) : { rssMb: 0 }
  const seenSock = new Set()
  let n = 0
  const tick = () => {
    n += 1
    const tree = descendants(psRows(), rootPid)
    const rssMb = Math.round(tree.reduce((s, r) => s + r.rssKb, 0) / 1024)
    const byComm = {}
    for (const r of tree) byComm[r.comm] = (byComm[r.comm] || 0) + r.rssKb
    const top = Object.fromEntries(Object.entries(byComm).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => [k, Math.round(v / 1024)]))
    const at = new Date(realNow()).toISOString()
    appendFileSync(join(simDir, 'mem.jsonl'), `${JSON.stringify({ at, rssMb, procs: tree.length, byCommMb: top })}\n`)
    if (rssMb > peak.rssMb) {
      peak = { rssMb, at, procs: tree.length, byCommMb: top }
      writeFileSync(peakPath, JSON.stringify(peak, null, 1))
    }
    if (n % sockEvery === 0 && tree.length) {
      const out = spawnSync('lsof', ['-nP', '-a', '-iTCP', '-sTCP:ESTABLISHED', '-p', tree.map((r) => r.pid).join(',')], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
      for (const line of String(out.stdout || '').split('\n').slice(1)) {
        const cols = line.trim().split(/\s+/)
        const name = cols.find((c) => c.includes('->'))
        if (!name) continue
        const remote = name.split('->')[1]
        const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(remote)
        if (!m || LOCAL_HOST_RE.test(m[1])) continue // 本机连接（网关、vite）不记：本来就放行，记了全是临时端口
        const key = `${cols[0]} ${m[1]}:${m[2]}`
        if (seenSock.has(key)) continue
        seenSock.add(key)
        noteEgress({ via: 'sock', method: 'TCP', url: `tcp://${m[1].includes(':') ? `[${m[1]}]` : m[1]}:${m[2]}/`, extra: cols[0], dir: simDir })
      }
    }
  }
  const timer = setInterval(() => { try { tick() } catch { /* 采样失败不挡回放 */ } }, intervalMs)
  timer.unref()
  return { stop: () => { clearInterval(timer); try { tick() } catch { /* ignore */ } return peak } }
}
