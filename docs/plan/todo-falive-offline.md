# 待办：falive bot 下线（立于 2026-11-01，未做）

> 一句话：**falive bot 下线 = 停服务，不删目录。** `~/github/lark-bot-falive` 和 docs_tdd 一样冻结成只读存档，它的审计原地保留，作为 lark-bot 回放 / 度量的样本。
> 状态：未下线（11-01 两个 bot 都在跑）。做完下面的清单后，把本行改成「已下线 yyyy-mm-dd」。

## 1. 为什么 lark-bot 要用 falive 的审计

fameex 线自己的审计目前只有 1 份。改提示词、执行器参数、工具描述之前，要拿真实任务回放（核规则有没有丢、行为有没有变），靠的是 falive 线 10-24 → 10-31 的 192 份任务审计（440 个文件）和 108 张截图。11-01 的上下文分层升级就是这么验收的（见 [upgrade-plan-context-layers-2026-11-01.md](./upgrade-plan-context-layers-2026-11-01.md) §5）。

样本位置（下线前后不变，都是原地读，lark-bot 只读不写）：

| 内容 | 路径 |
|---|---|
| 审计（`<任务>-e<代>.json` 结果 + `.log` claude 事件流） | `~/github/lark-bot-falive/runtime/lark-audits/FALIVE/` |
| 截图附件（审计 JSON 里的 `localPath` 指向这里） | `~/github/lark-bot-falive/runtime/lark-attachments/` |
| 对应的业务仓（回放实施要从当时的提交检出临时 worktree） | `~/github/falive-react` |

## 2. lark-bot 怎么用这批审计（没下线、下线后都一样）

```bash
cd ~/github/lark-bot
# 改了 lib/lark-worker-prompts.mjs：核基线每一行规则都还在、系统层跨任务逐字相同
node scripts/lark-replay-prompts.mjs --audits ~/github/lark-bot-falive/runtime/lark-audits
# 改了执行器参数 / 工具描述 / 截图规则：看隔离、工具选择、截图路由、缓存的基线有没有变
node scripts/lark-metrics.mjs --dir ~/github/lark-bot-falive/runtime/lark-audits --days 3650
# 同时看 fameex 线自己的
node scripts/lark-metrics.mjs --days 30
```

真跑 claude 回放（行为级验证，花钱、几分钟一条）：从 `.json` 取 `task` / `attachments` / `workContext`，在 `~/github/falive-react` 用当时 bot 提交的父提交检出临时 worktree，调 `runAI`（`lib/lark-worker-run.mjs`）跑新代码，结果与原 `final` 比对；跑完删临时 worktree。11-01 的一次性脚本没进仓，需要时照这个思路现写。截图路径原地有效，不用改。

## 3. 下线那天的清单

1. 停服务：`bash ~/github/lark-bot-falive/scripts/lark-bot stop`，再 `launchctl list | grep falive` 确认 `com.fameex.lark-falive-gateway` / `-worker` 没有 pid；`com.aven.falive-bugpoll`（`~/.lark-bugpoll/run.sh`，11-01 时已是退出状态 78）一并停掉。要彻底不再拉起，再从 launchd 卸载这三个 plist（`~/Library/LaunchAgents/com.fameex.lark-falive-*.plist`、`com.aven.falive-bugpoll.plist`）。
2. **不删** `~/github/lark-bot-falive`（它是 `feature/falive-repo-profile` 分支的 worktree，删 worktree 就删了审计），**不删**它的 `runtime/lark-audits`、`runtime/lark-attachments`，**不删** `~/github/falive-react`（真跑回放要从里面检出当时的提交）。
3. 在 `~/github/lark-bot-falive/` 根目录放一个 `ARCHIVED.md`：写「yyyy-mm-dd 下线，只读存档；runtime/lark-audits 是 lark-bot 的回放样本，见 lark-bot docs/plan/todo-falive-offline.md」。以后谁看到这个目录都知道为什么不能删。
4. 确认 fameex bot 不受影响：`lark-bot status` / `lark-bot doctor`（两条线是独立的 launchd 服务和端口：falive 3006，fameex 3005）。
5. 回到本文，把顶部状态改成「已下线 yyyy-mm-dd」。

## 4. 什么时候 falive 存档才可以删

满足两条再删（删之前不需要做任何迁移）：

- fameex 线自己攒够样本：`node scripts/lark-metrics.mjs --days 90` 的任务数 ≥ 100，且覆盖缺陷 / 需求 / 带截图 / 带 bug 记录链接四类；
- 最近一次改提示词，只用 fameex 自己的审计回放就够了（`lark-replay-prompts.mjs --audits ~/github/lark-bot/runtime/lark-audits`）。

删的时候连同 `feature/falive-repo-profile` 本地分支一起删（远程分支要不要删另议）。
