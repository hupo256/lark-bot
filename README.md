# lark-bot

FameEX 本机常驻的 Lark 自动处理服务：群内 @ 机器人 / bug 多维表格 → 本地 worker 调 AI CLI（claude / codex / pi / cursor）在 fameex-web worktree 里改代码 → 本地提交（从不 push）→ 回群。

2026-10-11 从 docs_tdd `common/lark-bot/` 带历史拆出，不再依赖 docs_tdd 的任何代码。

## 目录

| 路径 | 内容 |
|---|---|
| `lark-gateway.mjs` / `lark-worker.mjs` / `lark-bugtable-poller.mjs` | 三个进程的装配入口（import 无副作用，`runLark*()` 才启动） |
| `lib/` | 各职责模块；`lib/lark-paths.mjs` 是唯一路径基座，`lib/vendor/` 是从 docs_tdd 复制的少量函数 |
| `rules/` | docs_tdd 冻结规则快照（只读，见 `rules/README.md`） |
| `schemas/` | AI 结构化输出的 JSON Schema |
| `runtime/` | launchd 薄包装、plist、`launchd-node.sh`；本机配置与运行态（gitignore）也落在这里 |
| `scripts/` | `lark-bot` CLI、`lark-bot-shim`（`~/.local/bin/lark-bot` 的内容）、`figma-spec.mjs` |
| `docs/` | 运维手册，入口 [docs/README.md](./docs/README.md) |
| `__tests__/` | `node --test` 单测 |

## 路径与配置

路径都在 `lib/lark-paths.mjs` 解析，优先级 env > `runtime/lark-bot.local.json` > 默认值：

| 名称 | env | local.json 键 | 默认 |
|---|---|---|---|
| 业务主仓 `consumerRoot` | `LARK_BOT_CONSUMER_ROOT` | `consumerRoot` | `/Users/aven/github/fameex-web`（worktree 在其同级目录） |
| PRD 缓存 `prdCacheRoot` | `LARK_BOT_PRD_CACHE` | — | `~/.prd-cache`（只读） |
| 存量项目 `legacyPrdsRoot` | — | `legacyPrdsRoot` | `/Users/aven/github/docs_tdd/prds`，不存在则跳过 |

运行态：任务队列 `runtime/lark-tasks/`，附件 `runtime/lark-attachments/<PR>/<messageId>/`，审计 `runtime/lark-audits/<PR>/`。

## 依赖

- Node（launchd 用 `/opt/homebrew/bin/node`），无 npm 依赖。
- 已登录的 `lark-cli`（bot 身份在 keychain）；所用 AI CLI 已登录。
- `~/.ai-rules`（只读规则，L1）；`~/.config/fameex-lark/`（gateway-secret、claude.env、claude-auth）。
- 可选：`scripts/code-rules.mjs` 代码规则扫描器（未放入时扫描记 `ran:false`，不阻断）。

## 测试

只能逐文件跑，不支持目录参数：

```sh
for f in __tests__/*.test.mjs; do node --test "$f"; done
```

改了 `.mjs` 先 `node --check <file>`。
