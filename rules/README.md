# rules/：docs_tdd v3.5.0 冻结规则快照

- **来源**：`docs_tdd` 仓库 commit `165b070` 的 `common/rules/` 下同名文件，整份原样复制，未做任何改动。
- **用途**：
  - `lib/lark-rule-context.mjs` 按任务信号从这些文件抽取章节，作为可信规则原文注入 worker 提示词。
  - `rule-router.md` 的「## 4. 上下文与验证节制」是常驻硬规则（required）；缺失时按 `VERIFY-RULE-004` fail-closed，拒绝执行任务。
  - `lark-doc-sync.md` 在命令类任务的提示词里列为必读文档。
- **只读不扩展**：docs_tdd 已于 2026-10-10 冻结，这里只是让 lark-bot 不再依赖 docs_tdd 仓库的快照。
  - 不在这里修改或新增规则。新的通用编码规则放 `~/.ai-rules`；lark-bot 自己的边界写在 `docs/`。
  - 改了章节标题会导致规则被静默丢弃（必需章节会直接 fail-closed）；`__tests__/lark-pure.test.mjs` 会锁住「路由表 → 章节」的对应关系。
- **文内链接**：文件里指向 docs_tdd 其它文档的相对链接保持原样，在本仓库内可能失效，以 docs_tdd `165b070` 为准。
- **过时的工具名**：快照原文里提到的 `verify-code-rules.mjs`、`docs-tdd changed`、`agent/rule-waivers.json`、G5/G6 门禁都是 docs_tdd 的旧机制。lark-bot 现在只用 `scripts/code-rules.mjs` 扫描代码规则，豁免方式是在该行或上一行写 `code-rules-ignore <RULE-ID>: <理由>`。以本仓库的实现为准，不运行这些旧命令。
