# p0d-smoke 按事件组回放（3 组；代码 cfee2bf feat(replay): 按事件组跑（design-v2 §2 / P0-d）——run-episodes.mjs（组级目录 sim/<轮>/<组>、DONE+代码指纹断点、一轮不混指纹、最长先跑有界并发、预检 / caffeinate / 守卫）；run-sim --episode 只喂组内 case、跨天按天续跑时钟只进不退、基线分支名带提交号防并行互改、进程树内存采样；假 CLI 只藏 falive 对组内 case 的原话、私信历史按 aven open_id 供、列群消息不含话题回复；守卫 / 总账认组目录；check-context 逐条核上下文；旧 run-days / run-round 标弃用，指纹 80c823a808a3）

| 组 | case | 喂 | 任务 | 发件 | 内存峰值 MB | 出网 违规/待核 | 裁判 falive/一样/lark-bot/都错 · 待办 | 状态 |
|---|---|---|---|---|---|---|---|---|
| ep-1023-98f8fa | 1 | 1 | done=1 | 3 | 730 | 0/0 | - | 完成（1.6 分钟） |
| ep-1029-f09207 | 2 | 2 | done=1 | 3 | 698 | 0/0 | - | 完成（2.6 分钟） |
| ep-1102-0f579b | 1 | 1 | done=1 | 4 | 728 | 0/0 | - | 完成（1.8 分钟） |

## 出网审计：违规 0，待核 0


## 内存：3 组有采样，单组进程树峰值最高 730MB（ep-1023-98f8fa，2026-11-04T09:19:14.389Z：node 440、claude 283、zsh 3、ps 2、tail 1、timeout 1），中位 728MB

**全轮裁判 0 条：falive 更好 0，一样 0，lark-bot 更好 0，都不对 0；待办不计分 0**
