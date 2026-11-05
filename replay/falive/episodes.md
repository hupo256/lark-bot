# falive 回放事件组（61 组 / 285 个 case）

由 `node scripts/sim/episodes.mjs` 生成（规则见 docs/replay/falive-replay-design-v2.md §2），别手改；明细与每次并组的理由在 `episodes.json`。时间 UTC。

- 最大一组 45 条；跨天的 5 组；单条成组 30 组
- 逐步组数：规则 1 同话题 / 回复链 / 引用 id → 156；规则 2 同群相邻 < 30 分钟 → 75；规则 3 falive 真实归并 / 续跑 → 62；规则 4 同天改同一批代码文件 → 61
- 各规则实际并掉的组数：r1-reply-chain 76、r1-bot-card 33、r1-text-ref 18、r1-draft-reply 2、r2-adjacent 81、r3-falive 13、r4-same-code 1
- falive 真实归并 / 续跑共 255 条，两端都是 case 的 174 条：规则 1–2 已同组 161、校验补并 13（私聊原话在 case 里找不到的日志行 5，是 webhook 拉取之后 / 原话不全的）；改代码任务 8 个，同天同文件 11 对（其中 1 对真并了组）

## 大小分布

| 组大小 | 组数 |
|---|---|
| 1 | 30 |
| 2 | 11 |
| 3–5 | 7 |
| 6–10 | 6 |
| 11–20 | 3 |
| 21–40 | 3 |
| 41+ | 1 |

## 类型构成（按组里 case 类型的组合）

| 类型组合 | 组数 |
|---|---|
| at_bot | 37 |
| at_bot+principal_dm | 8 |
| principal_dm | 6 |
| at_bot+reply_to_bot | 5 |
| at_bot+principal_dm+reply_to_bot | 4 |
| reply_to_bot | 1 |

## 每组

| 组 | 条数 | 首条 → 末条 | 跨度（天） | 天数 | 群 | 类型 |
|---|---|---|---|---|---|---|
| ep-1014-c631b0 | 2 | 10-14 08:15 → 10-14 10:08 | 0.1 | 1 | Falive PHP后端群 | at_bot 2 |
| ep-1014-f3a009 | 4 | 10-14 13:09 → 10-14 13:22 | 0 | 1 | Falive PHP后端群 | at_bot 4 |
| ep-1014-d74f19 | 17 | 10-14 14:08 → 10-16 11:02 | 1.9 | 3 | Falive PHP后端群 | at_bot 17 |
| ep-1015-a1af28 | 2 | 10-15 12:20 → 10-15 12:34 | 0 | 1 | Falive PHP后端群 | at_bot 2 |
| ep-1015-78c768 | 1 | 10-15 13:27 → 10-15 13:27 | 0 | 1 | Falive PHP后端群 | at_bot 1 |
| ep-1015-2c9c2f | 1 | 10-15 15:07 → 10-15 15:07 | 0 | 1 | Falive PHP后端群 | at_bot 1 |
| ep-1015-9cb0e5 | 1 | 10-15 17:04 → 10-15 17:04 | 0 | 1 | Falive PHP后端群 | at_bot 1 |
| ep-1016-ec6464 | 2 | 10-16 14:55 → 10-16 15:00 | 0 | 1 | Falive PHP后端群 | at_bot 2 |
| ep-1017-cbbda8 | 1 | 10-17 13:52 → 10-17 13:52 | 0 | 1 | Falive PHP后端群 | at_bot 1 |
| ep-1019-57332a | 13 | 10-19 10:21 → 10-19 15:17 | 0.2 | 1 | Falive PHP后端群 | at_bot 11、reply_to_bot 2 |
| ep-1020-437502 | 1 | 10-20 04:09 → 10-20 04:09 | 0 | 1 | Falive产研技术沟通群 | at_bot 1 |
| ep-1020-404fe6 | 1 | 10-20 06:53 → 10-20 06:53 | 0 | 1 | webhook bot | principal_dm 1 |
| ep-1020-17dd90 | 7 | 10-20 08:39 → 10-20 11:30 | 0.1 | 1 | Falive PHP后端群、webhook bot | at_bot 4、principal_dm 3 |
| ep-1020-5e48f5 | 6 | 10-20 12:33 → 10-20 14:30 | 0.1 | 1 | Falive PHP后端群、webhook bot | at_bot 3、reply_to_bot 2、principal_dm 1 |
| ep-1021-8cca5c | 8 | 10-21 06:23 → 10-21 13:13 | 0.3 | 1 | Falive PHP后端群、webhook bot | at_bot 7、principal_dm 1 |
| ep-1021-2a6dec | 1 | 10-21 06:55 → 10-21 06:55 | 0 | 1 | Falive PHP后端群 | at_bot 1 |
| ep-1021-193c03 | 22 | 10-21 07:45 → 10-22 12:35 | 1.2 | 2 | Falive PHP后端群、webhook bot、Falive产研技术沟通群 | at_bot 10、principal_dm 12 |
| ep-1021-48bdf5 | 1 | 10-21 09:55 → 10-21 09:55 | 0 | 1 | Falive PHP后端群 | at_bot 1 |
| ep-1021-d4e64d | 22 | 10-21 16:24 → 10-22 16:40 | 1 | 2 | Falive PHP后端群、webhook bot、Falive产研技术沟通群 | at_bot 11、principal_dm 7、reply_to_bot 4 |
| ep-1022-aec9b0 | 1 | 10-22 07:19 → 10-22 07:19 | 0 | 1 | Falive PHP后端群 | at_bot 1 |
| ep-1022-0f9c78 | 3 | 10-22 13:33 → 10-28 10:23 | 5.9 | 2 | Falive产研技术沟通群 | at_bot 3 |
| ep-1022-40e078 | 2 | 10-22 13:36 → 10-22 13:41 | 0 | 1 | Falive PHP后端群、webhook bot | at_bot 1、principal_dm 1 |
| ep-1022-4794fb | 1 | 10-22 17:04 → 10-22 17:04 | 0 | 1 | Falive PHP后端群 | at_bot 1 |
| ep-1023-50decc | 2 | 10-23 06:36 → 10-23 06:36 | 0 | 1 | Falive PHP后端群 | at_bot 2 |
| ep-1023-0b66c5 | 1 | 10-23 07:12 → 10-23 07:12 | 0 | 1 | Falive PHP后端群 | at_bot 1 |
| ep-1023-7de965 | 2 | 10-23 07:45 → 10-23 07:56 | 0 | 1 | Falive产研技术沟通群 | at_bot 2 |
| ep-1023-9f0fd7 | 27 | 10-23 09:08 → 10-26 12:28 | 3.1 | 2 | Falive PHP后端群、webhook bot | at_bot 14、reply_to_bot 12、principal_dm 1 |
| ep-1023-f6c6cc | 1 | 10-23 10:06 → 10-23 10:06 | 0 | 1 | Falive PHP后端群 | at_bot 1 |
| ep-1023-9a8f8d | 1 | 10-23 11:18 → 10-23 11:18 | 0 | 1 | Falive PHP后端群 | at_bot 1 |
| ep-1023-08e243 | 1 | 10-23 13:52 → 10-23 13:52 | 0 | 1 | webhook bot | principal_dm 1 |
| ep-1023-98f8fa | 1 | 10-23 15:19 → 10-23 15:19 | 0 | 1 | Falive PHP后端群 | at_bot 1 |
| ep-1024-f34b24 | 1 | 10-24 06:01 → 10-24 06:01 | 0 | 1 | webhook bot | principal_dm 1 |
| ep-1024-b22368 | 1 | 10-24 08:49 → 10-24 08:49 | 0 | 1 | Falive PHP后端群 | at_bot 1 |
| ep-1024-9ebe13 | 8 | 10-24 10:07 → 10-24 15:44 | 0.2 | 1 | Falive PHP后端群、webhook bot | at_bot 7、principal_dm 1 |
| ep-1026-350ff1 | 3 | 10-26 09:17 → 10-26 09:39 | 0 | 1 | Falive PHP后端群 | at_bot 3 |
| ep-1026-4f9abc | 1 | 10-26 11:42 → 10-26 11:42 | 0 | 1 | webhook bot | principal_dm 1 |
| ep-1026-9769e5 | 2 | 10-26 13:31 → 10-26 13:48 | 0 | 1 | Falive PHP后端群 | at_bot 2 |
| ep-1027-63a6f3 | 5 | 10-27 07:29 → 10-27 13:53 | 0.3 | 1 | webhook bot、Falive PHP后端群 | principal_dm 3、at_bot 2 |
| ep-1027-c4346b | 1 | 10-27 09:47 → 10-27 09:47 | 0 | 1 | Falive产研技术沟通群 | at_bot 1 |
| ep-1027-d756ea | 2 | 10-27 10:27 → 10-27 10:33 | 0 | 1 | Falive PHP后端群 | at_bot 2 |
| ep-1027-5e6172 | 1 | 10-27 11:00 → 10-27 11:00 | 0 | 1 | Falive产研技术沟通群 | at_bot 1 |
| ep-1027-6e06d2 | 4 | 10-27 12:23 → 10-27 12:28 | 0 | 1 | Falive产研技术沟通群 | at_bot 4 |
| ep-1028-a784cd | 1 | 10-28 06:43 → 10-28 06:43 | 0 | 1 | Falive产研技术沟通群 | at_bot 1 |
| ep-1028-70632a | 1 | 10-28 06:44 → 10-28 06:44 | 0 | 1 | Falive PHP后端群 | at_bot 1 |
| ep-1028-03cd66 | 2 | 10-28 09:14 → 10-28 10:13 | 0 | 1 | webhook bot | principal_dm 2 |
| ep-1028-ee9885 | 2 | 10-28 10:59 → 10-28 11:02 | 0 | 1 | Falive PHP后端群、webhook bot | at_bot 1、principal_dm 1 |
| ep-1028-ce8964 | 1 | 10-28 11:09 → 10-28 11:09 | 0 | 1 | Falive产研技术沟通群 | at_bot 1 |
| ep-1029-8aca6e | 45 | 10-29 04:23 → 10-29 16:13 | 0.5 | 1 | Falive产研技术沟通群、Falive PHP后端群 | at_bot 20、reply_to_bot 25 |
| ep-1029-f09207 | 2 | 10-29 06:58 → 10-29 07:04 | 0 | 1 | Falive产研技术沟通群 | at_bot 1、reply_to_bot 1 |
| ep-1030-b864a1 | 6 | 10-30 06:29 → 10-30 07:53 | 0.1 | 1 | Falive产研技术沟通群 | at_bot 6 |
| ep-1030-83e8e3 | 1 | 10-30 06:51 → 10-30 06:51 | 0 | 1 | webhook bot | principal_dm 1 |
| ep-1030-04e660 | 1 | 10-30 10:12 → 10-30 10:12 | 0 | 1 | Falive PHP后端群 | at_bot 1 |
| ep-1030-337e3d | 5 | 10-30 14:32 → 10-30 15:09 | 0 | 1 | Falive PHP后端群 | at_bot 2、reply_to_bot 3 |
| ep-1030-167d28 | 5 | 10-30 17:30 → 10-30 18:30 | 0 | 1 | Falive产研技术沟通群、webhook bot | at_bot 3、principal_dm 1、reply_to_bot 1 |
| ep-1031-f8065f | 14 | 10-31 08:51 → 10-31 09:05 | 0 | 1 | Falive产研技术沟通群 | at_bot 4、reply_to_bot 10 |
| ep-1031-35935b | 9 | 10-31 09:11 → 10-31 15:42 | 0.3 | 1 | Falive PHP后端群、webhook bot | at_bot 5、principal_dm 4 |
| ep-1031-c9eab7 | 1 | 10-31 10:38 → 10-31 10:38 | 0 | 1 | Falive PHP后端群 | at_bot 1 |
| ep-1102-c63787 | 1 | 11-02 06:22 → 11-02 06:22 | 0 | 1 | Falive PHP后端群 | reply_to_bot 1 |
| ep-1102-0f579b | 1 | 11-02 08:26 → 11-02 08:26 | 0 | 1 | Falive产研技术沟通群 | at_bot 1 |
| ep-1102-9319b3 | 1 | 11-02 11:30 → 11-02 11:30 | 0 | 1 | Falive PHP后端群 | at_bot 1 |
| ep-1102-326837 | 1 | 11-02 16:04 → 11-02 16:04 | 0 | 1 | Falive PHP后端群 | at_bot 1 |
