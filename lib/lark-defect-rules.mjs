/**
 * 缺陷任务专用的提示词片段（10-20 从 lark-worker-prompts 拆出）：分诊步骤与结果里的根因字段说明约 2.2k 字，
 * 只对可能是缺陷的任务有用。明确不是缺陷的（对接答复 / 需求 / 代答 / 只读查询 / 日报清扫）不带，三个字段直接填 null——
 * lark-ai-result 只在字段非 null 时校验 taskState / rootCauseLayer / evidence。拿不准是不是缺陷的照旧全带。
 */

import { resolveCommandType } from './lark-message.mjs'

const NON_DEFECT_DECISIONS = new Set(['api_reply', 'requirement', 'question'])

export const isDefectCandidate = ({ task, isSweep = false, isReadOnly = false }) =>
  !isSweep && !isReadOnly && resolveCommandType(task).type !== 'api'
  && !NON_DEFECT_DECISIONS.has(task?.intake?.classification?.decision)

export const NON_DEFECT_RESULT_FIELDS = '- taskState / rootCauseLayer / evidence：本任务不是缺陷，都填 null。'

export const DEFECT_RESULT_FIELDS = `- taskState：缺陷类任务的诊断状态机，取 diagnosing（待诊断）/ root_cause_confirmed（根因已确认）/ awaiting_owner_fix（待对应端修复）/ fix_verifying（修复验证中）/ completed（已完成）；**未到 root_cause_confirmed 不得改业务代码**。非缺陷 / 纯查询任务填 null；
- rootCauseLayer：根因所在层，取 frontend-logic（前端逻辑）/ frontend-data（前端数据层 mapper）/ backend-data（后端数据错）/ backend-contract（后端契约缺口）/ product-spec（产品口径）/ cross-boundary（跨层）。判定：**API 已错、前端仅原样展示 → backend-\***；API 对但 mapper 映射错 → frontend-data；数据层对但 UI 组合错 → frontend-logic。取不到证据别猜，保持 diagnosing 并填 null；
- evidence：**rootCauseLayer 为 backend-\* / cross-boundary（或金额 / 状态 / 权限类高风险字段）时必填**，对象含 userSeenValue（用户所见错误值）/ apiActualValue（API 实际返回，须有 Network / 日志证据）/ contractExpectedValue（契约或产品口径应有值）/ dataFlowFirstErrorLocation（数据链首个出错位置）；否则填 null。**后端根因严禁前端凑数**：不得用其它字段加减反推权威值、不得用展示文案反推枚举状态、不得改 schema 注释迎合现象、不得写测试自证猜测公式——应把 taskState 置 awaiting_owner_fix，在 blockers 列出转交后端的缺陷项。文件数 / typecheck / 截图**不构成**根因证据。`

export const DEFECT_TRIAGE_RULES = `缺陷根因分诊（显示值 / 状态 / 金额 / 权限 /「缺失·未上报」类 bug 改代码前必做，防「前端凑数掩盖后端根因」，也防「把没发生的缺陷脑补成真」）：
- **「缺失 / 未上报 / 未触发 / 未生效」类报单，改代码前必须先证伪**：这类指控（如「某埋点未上报」「某字段未展示」「某回调未触发」）默认是**待核实的猜测**，不是既成事实。先按被点名的事件名 / 符号 / 文案在代码库精确搜索（如 \`rg 'view_no_code_guide'\`），弄清它当前**到底有没有、在哪些入口已存在 / 已触发**：
  - 已存在且逻辑正确，或该入口按设计 / 产品口径本就不该触发 → 判 no_change_needed，summary 引用搜索证据（在哪个文件已有 / 为何不该有），**绝不新增一份「看起来像修复」的实现来凑 diff**。
  - 确实缺、且补在哪里唯一明确 → 才实施。
  - 搜到了，但「是否应在此入口触发」取决于产品口径、无法从代码唯一判定 → waiting_confirmation，别替产品拍板。
- 先沿数据链 API→schema/mapper→state→UI 找**首个出错位置**，据此定 rootCauseLayer；金额 / 状态 / 权限类必须取到 apiActualValue（Network / 日志）证据后再定性，取不到就 taskState=diagnosing、不猜。
- 若根因是**后端返回字段本身错 / 缺**（前端只是原样透出），这是后端缺陷：taskState=awaiting_owner_fix，evidence 填齐，blockers 写清转交后端的字段 / 接口 / 期望 vs 实际，**不要在前端补偿**——严禁用其它字段加减反推权威值（如 total−avail−frozen）、用展示文案反推枚举状态（如 statusText==='已过期'）、改 schema 注释迎合现象、或写测试自证猜测公式。
- 确属前端根因（frontend-logic / frontend-data）才实施修复；纯计算下沉到 .ts 纯 helper 并补单测，展示组件不就地做多字段加减。
`
