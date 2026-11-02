/**
 * 分类回归集（__tests__/fixtures/intake-regression-1102.json，scripts/lark-replay-intake.mjs）的纯函数：
 * fixture 条目 → 分类器看到的任务形状；分类结果对照 expected（可接受值集合）判过没过。
 */

// expected：decision / deliverable / continues 是可接受值数组（单值也行），selfAnswer 是布尔；缺的字段不比。
export const judgeIntakeCase = (expected = {}, cls = {}) => {
  const mismatches = []
  const accepts = (field, got) => {
    if (!(field in expected)) return
    const allowed = (Array.isArray(expected[field]) ? expected[field] : [expected[field]]).map((v) => v ?? null)
    if (!allowed.includes(got ?? null)) mismatches.push(`${field}=${got ?? null}（应为 ${allowed.map(String).join(' / ')}）`)
  }
  accepts('decision', cls?.decision)
  accepts('deliverable', cls?.deliverable)
  accepts('continues', cls?.continues)
  if (typeof expected.selfAnswer === 'boolean' && Boolean(cls?.selfAnswer) !== expected.selfAnswer) mismatches.push(`selfAnswer=${Boolean(cls?.selfAnswer)}（应为 ${expected.selfAnswer}）`)
  return { ok: mismatches.length === 0, mismatches }
}

// fixture 里 fromPrincipal：true = 负责人本人，null = 存档里没记发送人（describeSender 显示「未知」）。
export const regressionTaskOf = (item, { principalOpenId = 'ou_aven' } = {}) => ({
  id: item.id,
  source: 'lark',
  text: item.text,
  operator: item.fromPrincipal ? principalOpenId : null,
  chatType: item.trigger === 'dm' ? 'p2p' : 'group',
  addressedToBot: item.addressedToBot !== false,
  privateOrigin: Boolean(item.privateOrigin),
  conversation: item.conversation || null,
  attachments: item.attachments || [],
  intake: { required: true, trigger: item.trigger === 'dm' ? 'dm' : 'bot_mention' },
})
