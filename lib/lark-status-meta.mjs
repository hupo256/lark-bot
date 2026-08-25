/**
 * AI 终态的单一事实源：每个 AI 结果 status → 「Gateway 落态 / 是否算完成态（触发规范闸+可信度评估）/
 * 群卡结论首行 / 卡片配色 kind」的映射。新增一个终态只改这张表，parse/executor/cards/gateway 全部派生自它，
 * 不再各文件散落 status 字面量特判。纯数据 + 纯函数，零副作用、零 IO。
 *
 * 关键区分：
 * - completed=true（done / done_with_warnings）才进规范闸与「done+空 diff 不可信」评估。
 * - no_change_needed 是**非完成态终局**：经核对确认本仓（前端）无对应改动（属后台 API / 别的仓 / 别的职责），
 *   无 diff、无提交，故 completed=false——绝不能进空 diff 可信度评估（否则又被误判成失败）。它既非「缺料等人」
 *   （waiting_confirmation）也非技术失败（failed），单独一档中性终局。
 */

// cardKind 对应 lark-cards 的 RECEIPT_STYLES 键。
export const AI_STATUS_META = {
  done: { gateway: 'done', completed: true, header: '已完成，待发布。', cardKind: 'done' },
  done_with_warnings: { gateway: 'done', completed: true, header: '已完成（有验证提醒），待发布。', cardKind: 'done' },
  no_change_needed: { gateway: 'no_change_needed', completed: false, header: '无需改动。', cardKind: 'no_change' },
  waiting_confirmation: { gateway: 'waiting_confirmation', completed: false, header: '需人工确认 / 补充材料后才能继续。', cardKind: 'waiting' },
  blocked: { gateway: 'blocked', completed: false, header: '已阻塞，需外部材料 / 权限后才能继续。', cardKind: 'blocked' },
  failed: { gateway: 'failed', completed: false, header: '处理失败。', cardKind: 'failed' },
}

// AI 结构化结果允许的 status 白名单（parse 校验用）。
export const AI_RESULT_STATUSES = Object.keys(AI_STATUS_META)

// Worker / AI 结构化结果共用的失败类型及群卡文案。
export const FAILURE_KIND_LABELS = {
  tool: '工具失败',
  env: '环境失败',
  permission: '权限失败',
  requirement: '需求不清',
}
export const FAILURE_KINDS = Object.keys(FAILURE_KIND_LABELS)

// 查表 + 兜底：未知 status 一律按 failed 处理（fail-closed，绝不误判成完成/无需改动）。
export const aiStatusMeta = (status) => AI_STATUS_META[status] || AI_STATUS_META.failed

// 完成态（done/done_with_warnings）才触发规范闸与可信度评估；其余终态（含 no_change_needed）豁免。
export const isCompletedAiStatus = (status) => Boolean(AI_STATUS_META[status]?.completed)

// AI status → Gateway 落态：done_with_warnings 收敛到稳定 done，其余原样透传（含 no_change_needed）。
export const gatewayStatusForAiStatus = (status) => aiStatusMeta(status).gateway
