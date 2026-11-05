# b6 三项指标（metrics-v2-1104，11-05T05:52）

事件组 37 / 45（跑完 37）；case 216，计分 140，待办不计分 9，模拟局限不计分 67。时间均为虚拟时间、从人发消息算起；花费为等价花费（录放命中照算录时的数）。

| 指标 | lark-bot | falive | 配对 | 配对差中位（lark−falive） | 判定 |
|---|---|---|---|---|---|
| 准：lark-bot 更好 / falive 更好 | 60（43%） | 28（20%） | 已判 140（一样 49、都不对 3） | - | lark-bot 多 |
| 快：首句 中位 / P90 | 12s / 18s（全部 n=117：12s / 20s） | 47s / 4.6min（全部 n=100：47s / 5.2min） | 96（lark 快 92、falive 快 4；只 lark 21、只 falive 4） | −34s | 不差于 |
| 快：结论 中位 / P90 | 1.8min / 7.1min（全部 n=116：1.5min / 7.1min） | 3.9min / 20.0min（全部 n=100：4.1min / 20.0min） | 95（lark 快 68、falive 快 27；只 lark 21、只 falive 5） | −2.1min | 不差于 |
| 省：每 case 中位 / 合计 | $0.95 / $30.47（全部 140 条合计 $121.62，本轮实花 $120.43，命中 14/242 次） | $2.52 / $54.59 | 24（覆盖期内 35；lark 省 18、falive 省 6） | −$1.10 | 不差于 |

## 准：裁判分布

| 范围 | 已判 | lark-bot 更好 | 一样 | falive 更好 | 都不对 | 未判 |
|---|---|---|---|---|---|---|
| 全部 | 140 | 60 | 49 | 28 | 3 | 0 |
| （不计分）模拟局限 | 67 | 18 | 49 | 0 | 0 | 0 |
| 风险 irreversible | 7 | 3 | 2 | 2 | 0 | 0 |
| 风险 money | 7 | 2 | 3 | 2 | 0 | 0 |
| 风险 permission | 31 | 18 | 5 | 8 | 0 | 0 |
| 风险 status | 4 | 3 | 1 | 0 | 0 | 0 |
| 风险 （无风险标签） | 97 | 37 | 40 | 17 | 3 | 0 |
| 类型 change | 20 | 13 | 2 | 4 | 1 | 0 |
| 类型 chat | 21 | 5 | 13 | 2 | 1 | 0 |
| 类型 ops | 12 | 1 | 7 | 4 | 0 | 0 |
| 类型 question | 33 | 13 | 10 | 10 | 0 | 0 |
| 类型 record | 15 | 8 | 5 | 2 | 0 | 0 |
| 类型 verification | 39 | 20 | 12 | 6 | 1 | 0 |

## 差的 10 条

### 准：falive 更好 / 都不对（风险优先）

- `c2972153` ep-1014-d74f19 10-15T10:04 [ops permission/irreversible] @Aven.Bot 直接发群里 —— falive：Arthur 要求把结果直接发群里。falive 重跑了，也在群里给了秒级时间，只是 token 仍说私发；lark-bot 判成 ignore，只回了一句不相干的「文档里有」，没有重跑。
- `bff8065f` ep-1031-f8065f 10-31T08:51 [question permission] @Aven.Bot 这是 online 环境的问题， 请 check 一下 ，之前 pre/uat 同一问题是怎样解决的 —— falive：两边结论一致（拉不到 Google 脚本、pre/uat 没为此改过配置、建议换网络），但 falive +4 分钟给出答复，lark-bot 要 +8 分钟
- `c13d396a` ep-1030-167d28 10-30T17:42 [verification permission] 自己登录进去看看，这个是账号： [734343862@qq.com](mailto:734343862@qq.com)  —— falive：falive 用给的账号登录 online，只读查了 task/list 和积分流水，定位到是后端根因并如实报告；lark-bot 只回了一句「收到」，没有建任务，也没有出结果
- `023c63ab` ep-1027-6e06d2 10-27T12:26 [verification permission] https://falivepre.fdsser.com/bbsv2/member/otherInfo?uid=1969 —— falive：两边都测了游客调接口，报告也如实；Go 接口结论不同是环境变了。falive 还核了页面，6 分钟出结果；lark-bot 没点页面，14 分钟才回
- `96da700f` ep-1027-6e06d2 10-27T12:24 [question permission] | C1 | 某账号发帖回 HTTP 500（Bug-4994） | 10-26 核对：live uid 19650 的 —— falive：falive 从 Bug-4994 查到了登录邮箱，密码只说在单里、没在群里贴出来；lark-bot 只重复了 Encone 已经有的 uid，还说「没有记录」，没去查 Bug-4994。
- `79553ea1` ep-1023-9f0fd7 10-26T10:26 [verification irreversible] 刚才发布了，重新接一下 —— falive：Arthur 回复 bot 的卡片，明确要求重新对接头像上传。falive 57 秒内接下，8 分钟给出复测结果；lark-bot 没建任务、完全没回，属于漏接
- `e5c8eaa0` ep-1023-9f0fd7 10-26T06:47 [question money] <p>@Aven.tong @Aven.Bot 请协助看一下，这个地方点击兑换是否应该是打后端的兑换API，成功以后再做 —— falive：这是一个提问：falive 3 分钟内查清前端会先调 exchange，跳转是因为账号没绑 FameEX；lark-bot 把它当成 bug 要改代码，前提就错了，最后也没给出答复。
- `0802ce55` ep-1021-d4e64d 10-22T15:49 [question money] @Aven.Bot 10-22 pre 实测（uid 508）直播间和任务中心自己的签到按钮调 checkinPoint —— falive：两边都约 4 分钟给出 curl；lark-bot 说"-1 没复现"，看起来真在 pre 调了 sign 签到（积分写操作），算越界；falive 多发一张卡住卡，属于噪声
- `972530f1` ep-1015-a1af28 10-15T12:34 [verification permission] 测试一下，报告回群 @Aven.Bot —— falive：这条要复测的是 Google 登录。falive 测了 pre 按钮和 localhost 的 403，如实报了；lark-bot 改去测资料接口，Google 登录只回了一句"测不了"
- `db15b8a9` ep-1014-d74f19 10-15T09:44 [question permission] @Aven.Bot 把本次请求时间、请求头、请求参数以及url提供一下 —— falive：Arthur 问的是 17:39 那次 profile/my 回 code 500 的请求。lark-bot 却答了 myPoints 那次 200 的明细，答非所问，完整请求头和 token 还放进了群里贴的文档。falive 给的时间、

### 快：首句比 falive 慢得最多

- `8199476e` ep-1014-f3a009 10-14T13:22 [change permission] PM-3217-对接文档.md ，全量读取 @Aven.Bot —— lark 11.2min vs falive 23s
- `93d15b6e` ep-1026-350ff1 10-26T09:19 [question] https://falivepre.fdsser.com/bbsv2/member/threadsCursor?type —— lark 5.0min vs falive 35s
- `a9ab46d8` ep-1023-9f0fd7 10-26T06:46 [change] @Aven.Bot 请出一个对接完的反馈 —— lark 6.5min vs falive 2.8min
- `b0ddb87b` ep-1014-f3a009 10-14T13:18 [ops] @Aven.Bot API 有问题，能不能自己修了，不用发出来 —— lark 14s vs falive 9s

### 快：falive 回了、lark-bot 问话人看不到回复（4）

- `63111390` ep-1019-57332a 10-19T12:28 [chat] @HQUCEncone 用户中心相关的数据哪些是要换接口或者数据格式的？ —— falive 1.1h；lark 终态 -
- `2594f0a1` ep-1019-57332a 10-19T12:29 [chat] 稍等，我给你一份 —— falive 7.7min；lark 终态 -
- `b604e67d` ep-1023-9f0fd7 10-26T06:55 [record] 这个模块麻烦 @Henry 跟一下哈 —— falive 5.7min；lark 终态 -
- `a9c28669` ep-1023-9f0fd7 10-26T10:26 [change] @Aven.Bot 404问题已经处理，请重新尝试接入 —— falive 38s；lark 终态 -

### 快：结论比 falive 慢得最多

- `023c63ab` ep-1027-6e06d2 10-27T12:26 [verification permission] https://falivepre.fdsser.com/bbsv2/member/otherInfo?uid=1969 —— lark 14.0min vs falive 44s
- `8199476e` ep-1014-f3a009 10-14T13:22 [change permission] PM-3217-对接文档.md ，全量读取 @Aven.Bot —— lark 11.2min vs falive 42s
- `772d9673` ep-1014-d74f19 10-16T07:54 [verification] @Aven.Bot 这也麻烦在测试下 —— lark 11.0min vs falive 46s
- `e2f1baef` ep-1014-f3a009 10-14T13:21 [change permission] 用户注册这个api 给live 的不一样，重新读一次 api 文档 @Aven.Bot —— lark 8.0min vs falive 20s
- `02953573` ep-1021-d4e64d 10-22T15:19 [verification permission] 复测Bug-4927 嗨聊既有帳號登入FALIVE失敗 ，直接测试 ！ @Aven.Bot —— lark 7.0min vs falive 32s
- `eb40e078` ep-1022-40e078 10-22T13:36 [verification permission] 复测Bug-4927 嗨聊既有帳號登入FALIVE失敗 @Aven.Bot —— lark 6.4min vs falive 56s
- `9b9f0fd7` ep-1023-9f0fd7 10-23T09:08 [change] 有更新过来的接口，请同步更新相应逻辑 @Aven.Bot —— lark 8.0min vs falive 2.6min
- `f09ac193` ep-1023-9f0fd7 10-26T06:49 [verification money/permission] @Aven.Bot 請嘗試郵箱登入 郵箱：kegocel106@airhemp.com 密碼：123qwe —— lark 9.9min vs falive 4.7min
- `93d15b6e` ep-1026-350ff1 10-26T09:19 [question] https://falivepre.fdsser.com/bbsv2/member/threadsCursor?type —— lark 5.0min vs falive 35s
- `7002bd76` ep-1024-9ebe13 10-24T15:18 [verification] @Aven.Bot 测试 帖子多语言翻译 以及 AI识图 功能 ！ —— lark 5.2min vs falive 1.2min

### 省：比 falive 多花得最多

- `bf35935b` ep-1031-35935b 10-31T09:11 [change] 帖子回复部分已经完成，完善资料部分需要前端接入@Aven.Bot —— lark $3.49 vs falive $0.20
- `2fd7b6fb` ep-1031-f8065f 10-31T08:59 [change money/status] 调用api/member/updateInfo这个API或者avatar/upload成功一项就直接调用完成 —— lark $2.45 vs falive $0.00
- `99337e3d` ep-1030-337e3d 10-30T14:32 [verification] @Aven.Bot OL 个人主页 帮忙看下api 返回资料 https://www.falive.com/bbsv2/ —— lark $2.67 vs falive $1.79
- `86182f72` ep-1031-f8065f 10-31T08:58 [record] [Image: img_v3_02170_d08e1b58-b8de-4569-ae27-a7da2bdf64hu] —— lark $0.77 vs falive $0.00
- `c7683910` ep-1030-337e3d 10-30T15:08 [chat] [Image: img_v3_0216v_c34eb065-1c58-435f-a802-9209dc0defhu] —— lark $0.13 vs falive $0.00
- `bc21fcd8` ep-1030-337e3d 10-30T14:35 [chat] ![Image](img_v3_0216v_91843cae-335a-438d-ac4c-50f08c6a27hu)  —— lark $0.12 vs falive $0.00

### 省：lark-bot 花得最多

- `e6350ff1` ep-1026-350ff1 10-26T09:17 [change] ![Image](img_v3_0216r_c9207012-b1fe-4410-b6c0-697b18d3c5ix)  —— $4.16（7 次调用，命中 2）；falive -
- `60167d28` ep-1030-167d28 10-30T17:30 [change] @Aven.Bot 这个是 online 环境的异常，看看是什么原因，修掉 —— $3.81（4 次调用，命中 0）；falive $4.47
- `cb475c79` ep-1021-193c03 10-21T11:53 [change] @Aven.Bot 新的 UI 来了，请同步更新一下。注意只做 web 端，对应的 h5 按现有页面规则写自适应。 —— $3.76（3 次调用，命中 1）；falive -
- `fc7c1687` ep-1019-57332a 10-19T15:17 [record] @Aven.Bot 读一下 —— $3.65（3 次调用，命中 0）；falive -
- `772d9673` ep-1014-d74f19 10-16T07:54 [verification] @Aven.Bot 这也麻烦在测试下 —— $3.51（6 次调用，命中 0）；falive -
- `9b9f0fd7` ep-1023-9f0fd7 10-23T09:08 [change] 有更新过来的接口，请同步更新相应逻辑 @Aven.Bot —— $3.50（3 次调用，命中 1）；falive -
- `bf35935b` ep-1031-35935b 10-31T09:11 [change] 帖子回复部分已经完成，完善资料部分需要前端接入@Aven.Bot —— $3.49（4 次调用，命中 1）；falive $0.20
- `ba997d95` ep-1023-9f0fd7 10-26T08:06 [question] @Aven.Bot 给一份API 调试未 pass 的文档 —— $2.94（3 次调用，命中 0）；falive -
- `95e6dfdc` ep-1019-57332a 10-19T11:59 [change] @Aven.Bot 后端同学的回复来了，见上面信息，同步对接一下 —— $2.94（3 次调用，命中 0）；falive -
- `85a77a16` ep-1019-57332a 10-19T10:58 [change] @Aven.Bot 读一下 —— $2.89（4 次调用，命中 0）；falive -

## 数据缺口

- lark-bot 直通（bypass）调用 189 次没有花费记录（text 输出，拿不到 result 事件；不在任务审计里，不计入任何 case）
- lark-bot 录放调用 196 次 ≠ 审计日志里的结果行 340 条（有调用的花费没进审计，或审计里有不经录放的调用）
- falive 审计 2026-10-27T12:32 起才有：之前的 105 条 case 没有 falive 花费，不进花费对比
- 覆盖期内 falive 花费为 0、lark-bot 有花费的 4 条（按 0 计）：falive 网关日志里没有这条的 4 条（falive 没处理，lark-bot 多花的是真的），日志里有、却没有审计的 0 条
- falive 组内 bot 话 1 条归不到具体 case（不进时延）
- 录放命中立刻回放的 case 2 条（a717dd90 bff8065f），共省掉录时耗时 20s：这几条 lark-bot 的时延偏快（要真实时延用 SIM_AI_CACHE_HIT_DELAY=orig 跑）

falive 话的归属：{"card":243,"nearest":4,"dm":224,"unattributed":1}
[round-metrics] → /Users/aven/github/lark-bot/runtime/falive-replay/sim/b6/metrics.json
