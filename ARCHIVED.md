# 已下线存档（2026-11-06）

falive bot 于 2026-11-06 下线：gateway / worker（`com.fameex.lark-falive-*`）和 bugpoll（`com.aven.falive-bugpoll`）三个 launchd 服务已停止并卸载，plist 备份在 `~/.lark-bot-backups/falive-launchagents-20261106/`。

**本目录是只读存档，不要删：**

- `runtime/lark-audits/`、`runtime/lark-attachments/` 是 lark-bot（fameex 线）改提示词 / 执行器时的回放与度量样本，用法和可删条件见 lark-bot 仓 `docs/plan/todo-falive-offline.md`。
- 本目录是 `feature/falive-repo-profile` 分支的 worktree，删 worktree 就删了上面的审计。

要给别人用的干净版本在分支 `falive-bot`（worktree `~/github/falive-bot`）：剥掉了 fameex 线逻辑与 bugpoll，接入步骤见那边的 `docs/onboarding.md`。
