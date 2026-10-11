<!-- RESIDENT-DOC: 唯一常驻规则；预算和覆盖校验见 check-doc-budget.mjs -->
# docs_tdd 启动路由

> 新需求唯一默认流程是 skill `prd-to-commit`（`~/.ai-rules/skills/prd-to-commit/SKILL.md`，Claude/Codex 已软链）。启动语：`用 prd-to-commit，项目号 PR-xxxxx，PRD：<链接>`。本目录只服务存量项目；不要再为新需求读取 `common/`。

## 1. 新需求默认流程

- 走 `prd-to-commit`：拉 PRD（含内嵌表格）→ 需求清单（原句→落点）→ plan 依赖分批 → 用户确认一次 → worktree → 编码（批次并行）→ 改动文件检查 → 独立冷读 → 修复 → 本地 commit。细节以 skill 为准，本文件不复述。
- Web Lite（[web-lite-workflow.md](./web-lite-workflow.md)）已于 2026-10-10 废弃，仅供查阅。
- 依据：[现状审计](../../docs/prd-to-commit/reports/2026-10-09-status-audit.md)、[正式化评估](../../docs/prd-to-commit/reports/2026-10-10-readiness.md)、回放基准 [benchmarks/replay/](../../benchmarks/replay/)。

## 2. 存量流程路由

- 已有项目按其 README `workflowVersion` 继续：v1 使用原 G0-G8；v2 使用原 work-item/verify。不得静默迁移。
- 新需求禁止运行旧 `docs-tdd run/kickoff/verify`、G0-G8、coverage review 或旧证据套件。旧专题仅在处理对应存量项目时加载。
- 编码规范分层：通用规则走全局 AGENTS/skill；FameEX 锚点走 `.cursor/rules/*.mdc`；本目录只保留流程与项目规则。

## 3. 按需加载

- 新需求：不走本目录，直接用 `prd-to-commit` skill。
- Web UI：`write_ui`；API/schema/mapper：`write_api` / `write_mapper` / `write_query_hook`；MSW：`write_msw`；Figma：`write_figma`。
- 存量 v1：`g0_g2_scope`、`g4_coding_worktree`、`g6_verify` 等原场景；机器路由见 [rule-index.json](./rule-index.json)。
- 不确定时先读任务相关专题 1-3 篇；大文件用 `rg` 定位后读局部，不全读 `common/`。

## 4. 上下文与验证节制

- 主线程只保留决策、风险和结果；规则按需读取。不得为规则系统本身生成状态台账。
- 质量命令不在迭代编辑中反复运行；改动稳定后按风险选 touched-file lint、typecheck、纯逻辑测试或定向浏览器验证。
- 小改动不跑全仓/全套件；`.tsx` 不新增 render/unit tests，不为流程指标制造假测试。
- 未执行的检查标为 `not-required` 或“未运行”，不得称为通过。
- 修改本目录规则后运行 `node common/engine/agent-scripts/check-doc-budget.mjs` 与 `git diff --check`；旧发布引擎只在维护它所覆盖的旧规则执行链时使用。
