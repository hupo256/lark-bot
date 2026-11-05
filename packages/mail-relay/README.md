# mail-relay：审批邮件转发 + 评分

把邮箱里的审批邮件（OL 上线申请、权限 / 白名单申请、B2B 正式环境更新申请……）按路由转进飞书群，可选附规范度评分。
11-05 从 lark-bot 拆出来（计划与决策见 `docs/plan/plan-mail-relay-standalone-2026-11-05.md`，评分口径见 `docs/notes/mail-ol-scoring-2026-11-02.md`）。

## 两种跑法

| | 内置在 lark-bot（现在） | 独立运行（P3 起，Mac mini） |
|---|---|---|
| 入口 | `lark-gateway.mjs` → `lib/lark-mail-relay.mjs` | `node packages/mail-relay/bin/mail-relay.mjs run --config <json>` |
| 配置 | `runtime/lark-bot.local.json` 的 `mailRelay` | 独立 json（`{ notifyOpenId?, mailRelay }` 或直接 mailRelay） |
| lark-cli | lark-bot 的 `runLarkCli`（应用令牌缓存） | 包自带 `lark.mjs`；`cliConfigDir` 指向独立应用的凭证目录 |
| 收信 | `mode: poll`（和 bot 共用应用时不能开 `+watch`） | 独立应用可用 `mode: watch` |
| 台账 | `runtime/lark-mail-relay-state.json` | `<配置所在目录>/mail-relay-state.json`（`stateFile` 可改） |

`bin/mail-relay.mjs` 还有 `check`（校验配置、列路由）和 `forward --message-id <id> [--route <id>] [--dry-run] [--force]`（手动转一封）。

## 扩展（不写死）

- **新增一类只转发的邮件**：配置里加一条路由（`label` + `match.subject` 正则 + `chatId`，`scorer: null`），不改代码。
- **新增评分**：`scorers/` 加一个评分器（`score(mail) → { score, max, tier, items… }`、`render(result, ctx) → markdown`），在 `presets.mjs` 注册，再在路由里引用。先按「收件箱集齐 ≥10 封同类首封 → 归纳 → 范本回放」定规则。
- **新的群 / 新的组**：路由的 `chatId`；告警收件人 `alert.openId`；另一个邮箱或应用：`cliConfigDir` + `stateFile` 各起一个实例。

## 约束

- 本目录只 import `node:` 内置和包内文件（`__tests__/mail-relay-package.test.mjs` 守着），这样整个目录拷走就能单独跑。
- `lark.mjs` 拼的发 / 回消息参数要和 lark-bot `lib/lark-cli.mjs` 保持一致（同一个测试里有对照）。
