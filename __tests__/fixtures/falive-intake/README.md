# falive 入口回放集（2026-10-15 真机）

`node scripts/lark-replay-classify.mjs falive --dir __tests__/fixtures/falive-intake --refetch-context`

| 文件（后 8 位） | 消息 | 期望 |
|---|---|---|
| 1746dd0d | Ache 预约改版（只 @ Aven.tong）+ aven 补「@Aven.Bot 帮记录提醒下」 | api_reply / high / forMe，触及 对接-live后端-3#1 |
| ddb15b8a9 | Arthur 引用 bot 卡「@Aven.Bot 把本次请求时间…提供一下」 | question / high |
| 43a64bbe2 | Arthur「@Aven.Bot 重跑一次」（无引用；1 分钟前 bot 说过「需要的话我重跑一次」） | 接上一条（api_reply 或 question），reply 不再是「没看出是哪条」 |
| a4e19c97e | Arthur 引用卡「@Aven.Bot 这个重跑一次」 | 接上一条 |
| 7c2972153 | Arthur 引用 bot「私发给你」的卡「@Aven.Bot 直接发群里」 | 发送人识别为 Arthur，不是 aven 的指示；high |

`intake.classification_at_capture` 是当时线上的判定（基线），不参与回放。

## 回放记录

| 日期 / 阶段 | 1746dd0d | db15b8a9 | 3a64bbe2 | 4e19c97e | c2972153 |
|---|---|---|---|---|---|
| 10-15 线上（基线） | ignored 只记台账 | question/high | ignore/low「没看出是哪条」 | api_reply/medium | requirement/medium「大概率是 aven」 |
| 10-15 阶段 1（上下文 + 发送人） | api_reply/high | question/high | api_reply/medium 主题对 | api_reply/high | api_reply/high 识别为 Arthur |

## 期望值字段（10-21 架构加固 P4）

- `intake.expected_decision`（字符串或数组）：基线判错过的样例写期望值，回放门槛按它比；没有就比基线。c2972153 = api_reply（上表「发送人识别为 Arthur」）；e05b783d = requirement / bug 都认（交付物看 deliverable）。
- `intake.expected_deliverable`：任务契约的交付物（verification / answer / change），标了的必须全对。
- 10-21 回放：改提示前一致率 93.9%（基线口径，门槛本来就没过）；加 deliverable 规则后按期望值口径 95.9%，forMe 召回 100%，deliverable 5/5。
