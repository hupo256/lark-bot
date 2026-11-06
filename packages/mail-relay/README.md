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

## 升级发布（11-06 起）

在自己的电脑上改代码、跑测试，然后一条命令发到 Mac mini（全程不用碰 Mac mini）：

```sh
bash scripts/mail-relay-publish.sh --dry-run   # 只跑测试、连通性和远端自检，不动线上
bash scripts/mail-relay-publish.sh             # 测试 → 备份 → 替换 → 重启 → 验活，失败自动回滚到上一版
```

目标机 `MAIL_RELAY_HOST`（缺省 `ex-user@ex-userdeMac-mini.local`，只在同一局域网可达）；只替换 `~/mail-relay` 代码，配置 / 凭证 / 台账在 `~/.config/mail-relay` 不动。
Mac mini 上 `~/mail-relay/DEPLOYED` 记着当前版本（git sha + 时间）。改配置（路由、群、间隔）不走这个脚本：ssh 上去改 `~/.config/mail-relay/config.json` 后 `launchctl kickstart -k gui/$(id -u)/com.fameex.mail-relay`。

## 扩展（不写死）

- **新增一类只转发的邮件**：配置里加一条路由（`label` + `match.subject` 正则 + `chatId`，`scorer: null`），不改代码。
- **新增评分**：`scorers/` 加一个评分器（`score(mail) → { score, max, tier, items… }`、`render(result, ctx) → markdown`），在 `presets.mjs` 注册，再在路由里引用。先按「收件箱集齐 ≥10 封同类首封 → 归纳 → 范本回放」定规则。
- **新的群 / 新的组**：路由的 `chatId`；告警收件人 `alert.openId`；另一个邮箱或应用：`cliConfigDir` + `stateFile` 各起一个实例。

## 约束

- 本目录只 import `node:` 内置和包内文件（`__tests__/mail-relay-package.test.mjs` 守着），这样整个目录拷走就能单独跑。
- `lark.mjs` 拼的发 / 回消息参数要和 lark-bot `lib/lark-cli.mjs` 保持一致（同一个测试里有对照）。
