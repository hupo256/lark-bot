# lark-bot Agent 规则

- **只本地提交，不 push**：未经当次明确授权不 `git push`。
- **运行中的服务**：launchd 常驻的 gateway / worker / poller 直接跑本仓代码。改完代码不会自动生效，要 `lark-bot restart`；除非任务明确要求，不要执行 `lark-bot restart|start|stop|poll-on`、`launchctl`，也不要改 `~/Library/LaunchAgents/*`、`~/.config/fameex-lark/*`。
- **验证方式**：改动的 `.mjs` 先 `node --check`；测试逐文件跑 `node --test __tests__/<file>.test.mjs`（不支持目录参数），只跑相关文件。本仓没有 Biome / tsc。
- **路径**：一律从 `lib/lark-paths.mjs` 取，不要在别处拼 fameex-web、`~/.prd-cache` 路径。docs_tdd 已归档，lark-bot 不读写它。
- **rules/ 只读**：冻结快照，不修改不扩展（见 `rules/README.md`）。
- **CLI 契约**：`scripts/lark-bot` 的入口路径或参数变了，要同步 `scripts/lark-bot-shim`，并提醒用户重新安装到 `~/.local/bin/lark-bot`。Gateway HTTP 契约变了，同步检查 `scripts/lark-bot` 里的 curl 调用。
- **代码规则扫描器是同步副本**：`scripts/code-rules.mjs` 的权威版本在 `~/.ai-rules/skills/prd-to-commit/scripts/code-rules.mjs`，本仓不直接改。同步方法：先改权威版本并在 `~/.ai-rules` 提交 → 整文件复制到 `scripts/`（保留第 2–3 行同步说明）→ 把第 2 行的 `~/.ai-rules@<sha>` 改成新 sha → `node scripts/code-rules.mjs --self-test` 并跑 `__tests__/lark-pure.test.mjs`（含副本与权威版本一致性检查）。
- **本机数据不进仓库**：`runtime/*.local.json`、任务 / 附件 / 审计 / state 文件都在 `.gitignore` 里，不要 `git add -f`。

## 出错处理原则（aven 2026-10-14 定，2026-10-17 改为「先分类再动手」）

bot 在 falive 群里出错时，**先分类再动手**，每条都记进 `docs/falive-lessons.md`（现象 · 根因 · 类别 · 落在哪 · 怎么验）：
- **bot 逻辑错**（判断 / 流程 / 代码缺陷）→ 改代码 + 闸或测试。**加一道闸必须合并或删一道旧闸**：完成态核验闸注册表 `lib/lark-task-gates.mjs` ≤ 16 道、提示词三档预算（`__tests__/lark-prompt-budget.test.mjs`）、gateway 纯度（`lark-gateway-purity`）、文件体量（`lark-size-budget`）都由测试锁死，超了先做减法。
- **环境问题**（睡眠 / 合盖 / 网络 / Lark 权限 / 外部群策略）→ 改环境或运维文档，不改 bot 代码。
- **噪音**（单次抖动、阈值太敏感）→ 只调阈值 / 配置。
- **先对不变量，再动手**（aven 2026-10-21：出一件补一件不行）：新问题先对到 `docs/falive-lessons.md`「不变量」里的某一条，并在 `__tests__/lark-golden-conversations.test.mjs` 加一个复现它的黄金对话场景（修好前标 todo）；对不上任何一条不变量的，先做架构评审，不直接打补丁。
改提示词或模型输出 schema 之前，先跑回放集：`node scripts/lark-replay-classify.mjs falive --dir __tests__/fixtures/falive-intake --report --gate`（forMe 召回 100%、decision 一致率 ≥ 95%）。
改默认仓（fameex）之外的逻辑一律走仓库 profile 分支，不碰 fameex 路径。
