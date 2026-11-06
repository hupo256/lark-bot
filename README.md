# falive-bot

> 一个常驻在你 Mac 上的飞书（Lark）前端助理：在外部群里被 @ 时，读懂上下文、在你的业务仓里开分支改代码 / 实测 / 答疑，做完把结论回到群里、把细节私信给你。
> 接入步骤见 **[docs/onboarding.md](./docs/onboarding.md)**（第一次用从这里开始）。

## 它做什么

| 场景 | bot 的动作 |
|---|---|
| 群里有人 `@bot` 报 bug / 提需求 / 发对接文档 | 先回「收到」；意图分类（缺陷 / 需求 / 对接答复 / 提问 / 闲聊）→ 只读分析 → 在业务仓的临时 worktree 里实施 → 终检（类型检查、相关测试、代码规则、改动范围核对）→ 本地提交 → 合回你的开发分支 → 群里一句结论 + 私信你改了什么 |
| `@bot` 问「这个接口前端现在怎么处理」「做了没」 | 只读查代码 / 文档 / 对接台账，必要时在测试环境实测接口，代答回群 |
| 消息里带飞书文档 / Figma / bug 表记录链接 | Worker 先把文档、设计稿规格抓下来落盘给 AI 读；bug 记录按需读整条和截图 |
| 别人负责的功能 | 按功能总表判归属，不替别人改，回群 @ 负责人 |
| 拿不准是不是你的活 | 不动手，私信你一张「疑似」卡，你回「继续任务 <id> 做」才开工 |
| 测试环境部署了新版本（可选） | 自动探到部署、按部署进去的提交建复测任务，结论私信你 |
| 每天固定时刻（可选） | 日报：当天进度 / 卡点 / 需要支持 |

bot **只在本地提交，从不 push**（除非你在控制台明确说「推 pre」，它才推你的开发分支并建 MR）。

## 工作方式

```text
外部群（你在群里；群里加了你的「自定义机器人」）
  │  用户身份轮询（lark-cli --as user，工作时段 20s 一次）
  ▼
gateway（launchd 常驻，127.0.0.1:3006）
  · 只认 @bot / 回复 bot / 控制台群里你的消息
  · 任务库 runtime/lark-tasks、附件 runtime/lark-attachments、发件簿 / 台账
  · 群里回话：走各群自定义机器人 webhook；私信你：发到你的「控制台群」
  ▼
worker（launchd 常驻）
  · 领任务 → claude（或 codex / pi / cursor）在业务仓临时 worktree 里干活
  · 终检 → 本地提交 → 合回开发分支 → 回写结论
```

为什么是「轮询 + webhook」：外部群（跨租户）不允许加应用机器人，只能加自定义机器人；自定义机器人只能发不能收，所以消息由你本人的飞书身份去读。

## 命令（`falive-bot …`）

| 命令 | 作用 |
|---|---|
| `start` / `stop` / `restart` | 启停 gateway + worker（launchd 托管，开机自启） |
| `status` | 进程、模型就绪、任务积压、挂起明细；异常时退出码非零 |
| `doctor` | 体检：心跳、代码 / 配置是否落后、轮询失败、挂起超时、失败台账 |
| `logs` | 跟 gateway / worker 日志（`~/Library/Logs/falive-bot/`） |
| `add-chat --name <群名> --webhook <地址> --secret <密钥>` | 接入一个外部群（查群 id、校验 webhook、认机器人、写配置）；加 `--console` 接入控制台群 |
| `failed` / `retry <id>` / `resume <id> "<补充>"` / `close <id>` | 看失败、重跑、补料续跑、结单 |
| `clean [hours]` / `clean --failed [hours]` | 清理陈旧终态任务 |
| `claude-auth [local\|proxy]` | 切换 claude 鉴权：本机登录 / `claude.env` 网关 key |
| `daily-report [repo] [--private]` / `sweep` / `intake-stats` | 日报补跑、日清扫、入口指标 |
| `uninstall` | 停服务并卸载 launchd 条目（配置、凭据、运行态保留） |

控制台群里也能直接说：`继续任务 <id> <补充>`、`结单 <id>`、`取消任务 <id>`，或回复 bot 的某条私信。

## 目录

| 路径 | 内容 |
|---|---|
| `lark-gateway.mjs` / `lark-worker.mjs` | 两个进程的装配入口 |
| `lib/` | 各职责模块（轮询、摄入、分类、执行器、终检、群出口、台账、日报…）；`lib/lark-paths.mjs` 是唯一路径基座 |
| `schemas/` | AI 结构化输出的 JSON Schema |
| `runtime/` | launchd 包装脚本、配置样例 `lark-bot.example.json`；本机配置与运行态也落在这里（gitignore） |
| `scripts/` | `lark-bot`（即 `falive-bot` 命令）、`lark-add-chat.mjs`、体检 / 指标 / 回放 / 测试工具 |
| `tools/` | 给 AI 调用的工具：读 bug 表记录、页面验证 |
| `docs/` | 文档，入口 [docs/README.md](./docs/README.md) |
| `__tests__/` | `node --test` 单测，`node scripts/test-all.mjs` 全量 |

## 依赖

- macOS（launchd、`caffeinate`）、Node ≥ 22，无 npm 依赖。
- [lark-cli](https://www.npmjs.com/package/@larksuite/cli)：已配置一个飞书自建应用，并以**你本人**身份登录（读群消息、读文档、建云文档）。
- Claude Code CLI（`claude`）已登录；或在 `~/.config/falive-bot/claude.env` 配网关 key。
- 业务仓本地 clone，仓库根有 `CLAUDE.md`（含 `## 固定前提（勿偏离）`、`## 硬规则速览（细则见各向导）` 两节，bot 必读）。
- 可选：`~/.ai-rules`（个人规则库，有就注入）、`FIGMA_API_KEY`（读 Figma）、`~/.lark-verify` 下的 `playwright-core`（页面验证工具）。

## 开发

```sh
node scripts/test-all.mjs          # 全量（含 18 秒运行预算）
node scripts/test-affected.mjs     # 只跑改动相关的
node scripts/mutate.mjs --diff <基线分支>   # 变异检查
```

改代码的规则见 [AGENTS.md](./AGENTS.md)；出错沉淀见 [docs/falive-lessons.md](./docs/falive-lessons.md)。
