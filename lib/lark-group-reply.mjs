/**
 * 外部群回复的共用件：负责人名字 → open_id（resolveMentions），repo-delivery 的待跟进 @ 靠它。
 *
 * 原来这里还有 A 方案（aven 2026-10-13）的「以负责人用户身份 +messages-send 发外部群」（postGroupSummary / 发文件 / 发文字）。
 * aven 2026-10-20 review 删掉发送部分：外部群（跨租户）用户身份发会 230027 被拒，falive 实例只走自定义机器人 webhook
 *（lib/lark-repo-delivery.mjs）；仓库任务的群回复早已由 deliverRepoOutcome 接管。postGroupSummary 留成不发送的空壳，
 * 因为 lib/lark-status.mjs 对非仓库任务的 done / no_change_needed 仍会调它（默认仓本来就跳过，行为不变）。
 */

// 负责人名字 → open_id：精确命中 key，否则 key 作为关键词包含匹配（群显示名如 ".Ache.l" 含 "Ache"）。
export const resolveMentions = ({ followUps = [], ownerMap = {} }) => {
  const seen = new Set()
  const out = []
  for (const item of followUps || []) {
    const owner = String(item?.owner || '').trim()
    if (!owner) continue
    const lower = owner.toLowerCase()
    const hit = Object.entries(ownerMap).find(([key]) => key.toLowerCase() === lower)
      || Object.entries(ownerMap).find(([key]) => key && (lower.includes(key.toLowerCase()) || key.toLowerCase().includes(lower)))
    if (hit && !seen.has(hit[1])) {
      seen.add(hit[1])
      out.push({ owner: hit[0], openId: hit[1], items: Array.isArray(item.items) ? item.items : [] })
    } else if (!hit) {
      out.push({ owner, openId: null, items: Array.isArray(item.items) ? item.items : [] })
    }
  }
  return out
}

// 用户身份发群已下线：任何任务都不发，返回 skipped（调用方 lark-status 只在异常时记日志）。
export const postGroupSummary = async () => ({ ok: false, skipped: true, reason: 'user-identity group post retired' })
