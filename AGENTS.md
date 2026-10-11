# lark-bot Agent 规则

- **只本地提交，不 push**：未经当次明确授权不 `git push`。
- **运行中的服务**：launchd 常驻的 gateway / worker / poller 直接跑本仓代码。改完代码不会自动生效，要 `lark-bot restart`；除非任务明确要求，不要执行 `lark-bot restart|start|stop|poll-on`、`launchctl`，也不要改 `~/Library/LaunchAgents/*`、`~/.config/fameex-lark/*`。
- **验证方式**：改动的 `.mjs` 先 `node --check`；测试逐文件跑 `node --test __tests__/<file>.test.mjs`（不支持目录参数），只跑相关文件。本仓没有 Biome / tsc。
- **路径**：一律从 `lib/lark-paths.mjs` 取，不要在别处拼 fameex-web、`~/.prd-cache` 路径。docs_tdd 已归档，lark-bot 不读写它。
- **rules/ 只读**：冻结快照，不修改不扩展（见 `rules/README.md`）。
- **CLI 契约**：`scripts/lark-bot` 的入口路径或参数变了，要同步 `scripts/lark-bot-shim`，并提醒用户重新安装到 `~/.local/bin/lark-bot`。Gateway HTTP 契约变了，同步检查 `scripts/lark-bot` 里的 curl 调用。
- **代码规则扫描器是同步副本**：`scripts/code-rules.mjs` 的权威版本在 `~/.ai-rules/skills/prd-to-commit/scripts/code-rules.mjs`，本仓不直接改。同步方法：先改权威版本并在 `~/.ai-rules` 提交 → 整文件复制到 `scripts/`（保留第 2–3 行同步说明）→ 把第 2 行的 `~/.ai-rules@<sha>` 改成新 sha → `node scripts/code-rules.mjs --self-test` 并跑 `__tests__/lark-pure.test.mjs`（含副本与权威版本一致性检查）。
- **本机数据不进仓库**：`runtime/*.local.json`、任务 / 附件 / 审计 / state 文件都在 `.gitignore` 里，不要 `git add -f`。
