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
