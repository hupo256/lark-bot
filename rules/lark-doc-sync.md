# Lark 文档只读同步规则

> 本文只适用于需要将来源持久化到项目 `inbox/` 的 workflowVersion 1/2 存量项目。新需求按 [web-lite-workflow.md](./web-lite-workflow.md) 直接一次性读取用户给定来源，不同步到 `docs_tdd`、不重复拉取同一 revision。群内 @ 应用任务链路见 [lark-bot 子系统文档](../lark-bot/docs/README.md)。

## 1. 目标

在开发前把 Lark 上的最新 PRD、QA、API 说明、Wiki / Drive 资料，或用户提供的本地 Markdown PRD，同步为本地副本，让 Agent 以 `apps/web/docs_tdd/**` 为开发依据，避免直接依赖过期导出或记忆。

## 2. 安全边界

- 只允许读取：`doc`、`wiki`、`drive`、`markdown` 的 `read/search` 类命令。
- 不允许创建、更新、patch、删除 Lark 云文档，除非负责人后续单独确认写权限边界。
- 不同步到业务代码目录；所有输出只能落到 `apps/web/docs_tdd/prds/<PROJECT-ID>/inbox/lark-sync/` 或项目指定的 `docs_tdd` 子目录。
- 敏感项(OAuth token、App Secret、Webhook、Cookie、账号密码)不写仓库、不写 `docs_tdd` 正文、不发群——「禁止同步」硬清单见 [collaboration-and-notifications.md](./collaboration-and-notifications.md) §2。
- 同步失败不能静默使用旧资料；开发报告必须标明失败来源和下一步需要谁补权限或链接。

## 3. 本地副本要求

每个同步产物必须在文件顶部带元信息：

```markdown
---
sourceName: <资料名称>
sourceType: doc | wiki | drive | markdown
sourceUrl: <Lark URL 或 token>
syncedAt: <ISO 时间>
readOnly: true
---
```

若 CLI 只能返回 JSON 或二进制导出，必须同时写 `*.metadata.json`，记录 `sourceUrl`、`sourceType`、`syncedAt`、`command`、`status`。

## 4. 项目配置

项目在 `<PROJECT-ID>/agent/lark-sources.json` 维护资料源清单：

```json
{
  "projectId": "PR-00000",
  "outputDir": "apps/web/docs_tdd/prds/PR-00000/inbox/lark-sync",
  "sources": [
    {
      "type": "doc",
      "name": "需求 PRD",
      "url": "https://example.larksuite.com/docx/xxx",
      "target": "prd-latest.md"
    }
  ]
}
```

`target` 必须是相对路径，不允许 `..` 或绝对路径。

## 5. 推荐命令

安装和登录只在本机执行一次：

```bash
npx @larksuite/cli@latest install
lark-cli config init --new
lark-cli auth login --recommend
lark-cli auth status
```

当前本机已配置全局命令：`~/.local/bin/lark-cli` 指向已安装的 Lark CLI，且 `~/.zshrc` 已把 `~/.local/bin` 加入 `PATH`。后续项目直接使用 `lark-cli` 或项目同步脚本即可，不需要再传 `LARK_CLI_BIN`。

项目同步：

```bash
node apps/web/docs_tdd/prds/<PROJECT-ID>/agent/scripts/sync-lark-docs.mjs --dry-run
node apps/web/docs_tdd/prds/<PROJECT-ID>/agent/scripts/sync-lark-docs.mjs
```

## 6. 新项目接入两步

每个新项目只需要做项目差异配置，不需要重新实现脚本：

1. 在 `<PROJECT-ID>/agent/lark-sources.json` 填真实资料源链接或本地 Markdown 路径，`type` 按来源填写 `doc` / `wiki` / `drive` / `markdown`，`target` 写入 `inbox/lark-sync/` 下的本地副本文件名。
2. 执行项目薄包装脚本：

```bash
node apps/web/docs_tdd/prds/<PROJECT-ID>/agent/scripts/sync-lark-docs.mjs --dry-run
node apps/web/docs_tdd/prds/<PROJECT-ID>/agent/scripts/sync-lark-docs.mjs
```

`doc` / `wiki` 链接会统一走官方推荐的只读命令，并显式使用当前用户身份与 JSON 信封以读取 revision / 正文 hash：

```bash
lark-cli docs +fetch --api-version v2 --doc <Lark URL> --doc-format markdown --as user --format json
```

如果 PRD 来源是 `apps/web/docs_tdd/**/inbox/*.md` 这类本地 Markdown，项目 `lark-sources.json` 登记为 `type: "markdown"` 即可；同步脚本会直接读取本地文件并写入 `inbox/lark-sync/`，不调用 `lark-cli`。

dry-run 也必须校验本地 Markdown 路径是否存在且位于 `apps/web/docs_tdd/` 下；路径错误时要立即失败，不能输出看似成功的同步计划。

仅当新机器或临时环境没有全局 `lark-cli` 时，才使用 `LARK_CLI_BIN` 指向 npm/npx 缓存或手动安装的二进制作为兜底：

```bash
LARK_CLI_BIN=/path/to/lark-cli node apps/web/docs_tdd/prds/<PROJECT-ID>/agent/scripts/sync-lark-docs.mjs
```

## 7. Worker 接入策略

- `文档 / docs`、`修复 / fix`、`自测 / test`、`API / api`、`QA / qa` 任务开始前，应先尝试同步项目 `lark-sources.json`。
- `状态 / status` 和端口查询类任务不需要同步，避免慢任务和权限噪音。
- 同步成功后，开发依据是本地副本和 `sync-report.md`；同步失败时进入待确认或失败，不拿旧 PRD 冒充最新。

## 8. 富媒体与删除线读取规则

> 本节的 intake manifest、PRD drift 和 G2 动作只用于 workflowVersion 1/2 存量项目。新需求（`prd-to-commit`）由 skill 的 fetch-prd 单次落盘读取；无法读到影响 Web 的内容时说明具体缺口，不重试或改读其他 revision。

Lark CLI 导出的 Markdown 不是完整视觉还原稿。Agent 读取 PRD 时必须同时检查正文、表格、图片、白板 / 思维导图占位和删除线，不能把“CLI 已导出 Markdown”等同于“全部需求已读”。

同步完成后先运行 `prd-intake.mjs <PROJECT-ID> --init --source <repo-relative-prd.md>`。逐项补齐 `agent/prd-source-manifest.json` 后，在 G2 前运行 `prd-intake.mjs <PROJECT-ID> --approve`；开发期由 `docs-tdd changed` 持续检查正文、表格、图片二进制和映射 fingerprint 漂移。

### 8.0 远端 PRD 漂移检查

- **Trigger**：已配置 Lark `doc` / `docs` / `wiki` 来源的项目执行 `prd-intake --stage`、`docs-tdd changed` 或任一项目 gate。
- **Action**：同步器把远端正文做稳定规范化（换行统一、剔除每次 fetch 会变化的临时媒体下载 URL）后计算 SHA-256，并把 `contentHash`、document ID、revision、`syncedAt` 写入 metadata；`prd-intake --init` 将该快照登记到 manifest。每次 gate 都重新只读 fetch 远端正文，并比较当前 hash 与 intake baseline（同 revision 且上次一致的结果按 `DOC_PRD_DRIFT_TTL_MS`（默认 5min）TTL 缓存，减少重复 lark-cli 拉取；仅缓存"一致"结果，检出漂移或拉取失败绝不缓存）。revision 仅用于诊断，是否漂移以正文 hash 为准。
- **Evidence**：`inbox/lark-sync/*.metadata.json`、`agent/prd-source-manifest.json#remoteSources` 与 gate 中的 `DOC-PRD-010` 结果。
- **Failure（分级）**：**真漂移**（远端 hash 与 baseline 不一致）与 **baseline 缺失**永远 `error` fail-closed，阻塞 gate——必须重新同步、重新 intake、补齐 Feature / task 后再批准，不得继续信任旧快照或豁免。**"拉不到远端"≠"确有漂移"**：网络 / 权限 / CLI 失败导致无法核对时，基线仍新鲜（`syncedAt` 距今 ≤ `DOC_PRD_DRIFT_MAX_STALE_DAYS`，默认 7 天）且门禁 < G5 时降为 `warning`（附基线年龄），不阻断整个 PRD intake；仅当基线过旧或已到 G5+（临近推版必须确认远端一致）才升级为 `error` 阻断。

### 8.1 图片

- 普通图片通常会导出为 `![alt](url)` 或 `<img ... alt="...">`，`alt` 可能包含 Lark / OCR 生成的文字说明。
- `alt` 只能作为辅助线索，不能当作权威需求来源；如果需求文字写在图片像素里，必须做视觉检查 / OCR，或要求产品补一份文字版。
- G2 前图片必须同步为 `docs_tdd` 内的本地附件或内嵌数据，使二进制内容可 fingerprint；只有远程 URL、链接失效或本地附件缺失时保持 unresolved，不得批准 intake。
- 图片出现在“示意图、规则图、流程图、后台字段截图、活动规则截图”等位置时，Agent 必须判断图片里是否可能含有字段、状态、枚举、交互、文案或验收要求。
- 无法读取图片内容时，必须在 `<PROJECT-ID>/product/06-collaboration.md` 记录“图片需求未完全可读”，并在已启用 Lark 通知时发群索取文字版或可访问导出。

### 8.2 白板 / 思维导图

- 白板、思维导图、流程图可能被导出为 `<whiteboard token="..."></whiteboard>`、`<sheet ...></sheet>`、`<cite ...></cite>` 等占位。
- 只看到占位时，不能视为已读取完整内容，也不能凭标题推断需求范围。
- 若白板 / 思维导图可能承载功能拆解、流程、状态机、字段或验收标准，Agent 必须将其标为“待补读”，并通过可用方式读取原始内容：补充导出、截图 OCR、让负责人补文字版，或使用 Lark 权限重新同步。
- 待补读内容影响 scope 时，G2 不能定稿；只影响细节时，可继续 G0 / G1 文档，但必须把风险写入协作清单。

### 8.3 删除线 / 划掉内容

- Lark Markdown 中的删除线通常会保留为 `~~被删除内容~~`。
- `~~...~~` 默认表示不做、已删除、暂不支持或被替换，Agent 不得把删除线内文字生成开发项、API 字段、埋点枚举或验收项。
- 同一行若存在删除线外的新文本，以删除线外的新文本为准；例如 `~~旧方案~~ 新方案` 只生成“新方案”。
- 若删除线语义不明确，记录到 `06-collaboration.md` 等待确认；确认前不得把删除线内容纳入本期 scope。
