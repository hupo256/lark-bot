# falive 实战回放 case

falive bot 10-01 → 11-03 的真实运行数据。用来给 lark-bot 做离线回放：最新代码把 falive 遇到过的每个 case 重新跑一遍，再和 falive 当时的表现逐条比。
计划、进度和每轮结论记在 [docs/replay/falive-replay-plan-2026-11-03.md](../../docs/replay/falive-replay-plan-2026-11-03.md)，回放脚本在 [scripts/sim/](../../scripts/sim)。

| 路径 | 内容 | 怎么来的 |
|---|---|---|
| `cases.jsonl` / `cases.md` | **falive-bot 做过的全部 case**（285 条：@bot、回复 bot、aven 私聊），带 falive 当时的第一句回复 | `node scripts/sim/list-cases.mjs` 生成，别手改 |
| `raw/{php,tech,webhook}-group{,.api}.json` | 三个群的消息：「Falive PHP后端群」「Falive产研技术沟通群」「webhook bot」（falive bot 与 aven 的私聊群，回放里当私信）。`.api` 是原始 API 版（parent_id / root_id / mentions），另一份是渲染版 | aven 身份 lark-cli 只读拉取 |
| `raw/threads/` | 204 个话题的回复 | `build-context-cache.mjs` |
| `raw/docs/` / `raw/bug-records/` | 群里贴的云文档（119 篇）/ 提到的 bug 单记录（149 条，含截图），fake lark-cli 按缓存供数 | `build-context-cache.mjs` |
| `raw/lark-im-resources/` + `raw/resources-extra.json` | 消息里的截图 / 文件，`<message_id>/<key>` → 相对 raw/ 的路径 | 同上 |
| `dataset/timeline.json` | 统一时间线（4152 条，含话题回复；bot 多个 open_id 已归一） | `build-dataset.mjs` |
| `dataset/episodes.json` | 每条真人消息的 falive 基线：当时的分类、路由日志、回复、人的后续、审计结论（取自 `~/github/lark-bot-falive/runtime` 与 `~/Library/Logs/falive-lark/`） | `build-dataset.mjs` |
| `episodes.json` / `episodes.md` | **回放事件组**（docs/replay/falive-replay-design-v2.md §2）：每组的 case、首末时间、起跑窗口（首条前 30 分钟）、跨天、群、每次并组的理由；md 是统计。注意和 `dataset/episodes.json`（逐条基线）不是一回事 | `node scripts/sim/episodes.mjs` 生成，别手改 |
| `gold-review.md` / `gold-review.data.jsonl` | 金标准评审表（每条一屏，aven 勾「falive 对 / lark-bot 对 / 都不对」）与每条的输出指纹 | `node scripts/sim/gold.mjs review --round <轮>` 生成；aven 只改 md |
| `gold.jsonl` | **金标准**（design-v2 §5）：每条 case 的定论、理想做法、审过的那版 lark-bot 输出指纹；by=aven（亲自审）/ judge（定稿那轮裁判判一样 / lark-bot 更好且有把握的） | `node scripts/sim/gold.mjs ingest [--round <轮>]` |
| `explained.jsonl` | 验收用：「falive 更好」的已知原因（`{id, kind: sim_limit\|todo\|followup, why}`），没有就算没解释 | 手写；`scripts/sim/acceptance.mjs` 读 |
| `rounds/<轮>/` | 每轮完整回放的裁判（`<段>.judge.jsonl`）与总账（`report.md`） | `run-round.sh` 跑完自动拷进来 |

回放产物本身（`sim/<轮>-<段>/`：发件簿、任务、审计、日志，单轮几个 G）可重跑，不进版本，在 `runtime/falive-replay/`（gitignore）。
数据是公司内部群聊，只在本地仓库，别推到外部远端。
