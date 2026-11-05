# case 风险标签（285 条）

由 `node scripts/sim/tag-cases.mjs` 生成，别手改；规则在脚本里，规则定不了的按批送模型（结论缓存在 case-tags.model.jsonl）。口径见 docs/replay/falive-replay-design-v2.md §6、§7。

- kind：question 64、verification 56、change 57、record 36、ops 39、chat 33
- risk：money 14、status 15、permission 61、irreversible 16；至少一项 96
- pending（「已部署」→ 自动复测 / 部署状态记账，待办不计分）：11
- 判定来源：kind 规则 170、模型 115；送过模型的 case 205 条（claude-opus-5-5 / effort low，每批 12 条）

口径：money 含积分 / 钻石 / 兑换 / 到账（虚拟资产）；status 含 bug 单状态改动、任务完成上报；permission 含注册登录、token、验证码、账号密码、主播身份；irreversible 含部署 / 发版 / 合 MR、往群里发通知、在共享环境或生产写数据（造数据、发帖、评论）。

## 有风险标签的（96 条）

| 时间（UTC） | 人 | kind | 标签 | 原话 | id |
|---|---|---|---|---|---|
| 10-14 10:08 | Aven.tong | change | permission | @HQUCEncone 部署完结后，相关的域名和路径请发一下，最好是更新一下 《PM-3217 账号接口对接文档》 然后发群里 [双手合十] @Aven.Bot 注册、登录 这两个 | `03b333e0` |
| 10-14 13:09 | Aven.tong | change | permission | @Aven.Bot 你要的 部署域名 来了，暂时只有 pre 环境的，你看看能不能先用这个 将 pre 环境接上，其他环境后续会补上。如果不行，在群里问 @HQUCEncone 要 | `8ff3a009` |
| 10-14 13:21 | HQUCEncone | change | permission | 用户注册这个api 给live 的不一样，重新读一次 api 文档 @Aven.Bot | `e2f1baef` |
| 10-14 13:22 | HQUCEncone | change | permission | PM-3217-对接文档.md ，全量读取 @Aven.Bot | `8199476e` |
| 10-14 14:08 | HQUCEncone | verification | permission | - 通了 登录后查 portal 资料：带 token 返回正常 - ✅ 通了 登录后调 live 资料：用 live_token 返回正常 需要验证 token 都能正常使用 @ | `26d74f19` |
| 10-14 15:33 | .Ache.l | verification | permission | @Aven.Bot 运维配置好了 你再试试 | `e30f766f` |
| 10-15 09:00 | Arthur.a | verification | permission | @Aven.Bot 关于这个接口，请重新测试hichat_token | `ecf68877` |
| 10-15 09:21 | Aven.tong | question | permission | @Aven.Bot 是没有访问 lark 文档的权限吗，用 lark-cli 试试，或者你给我个入口，我给你授权 | `740b02a2` |
| 10-15 09:44 | Arthur.a | question | permission | @Aven.Bot 把本次请求时间、请求头、请求参数以及url提供一下 | `db15b8a9` |
| 10-15 09:49 | Arthur.a | verification | permission | @Aven.Bot 重跑一次 | `3a64bbe2` |
| 10-15 09:59 | Arthur.a | verification | permission | @Aven.Bot 这个重跑一次 | `4e19c97e` |
| 10-15 10:04 | Arthur.a | ops | permission irreversible | @Aven.Bot 直接发群里 | `c2972153` |
| 10-15 12:20 | Aven.tong | verification | permission | @Aven.Bot 帮我在 pre 上试一下，并报告结果 | `1ba1af28` |
| 10-15 12:34 | Aven.tong | verification | permission | 测试一下，报告回群 @Aven.Bot | `972530f1` |
| 10-15 13:27 | Arthur.a | verification | permission | <p>@Aven.Bot Eric已经将http://localhost:3000/hc-api/api/member/profile/my这支API打通并且获取到数据，请更新一下 | `7378c768` |
| 10-15 17:04 | Aven.tong | ops | irreversible | 今天日报发一下 @Aven.Bot | `fb9cb0e5` |
| 10-16 07:54 | Arthur.a | verification | permission | @Aven.Bot 验证码123456，不可用问题，Falive-pre环境已经验证通过，请复测 ![Image](img_v3_0216h_613ffbf9-df2f-43e8- | `bf1fddf4` |
| 10-16 15:00 | Arthur.a | verification | status permission | @Aven.Bot broker提出的手机号注册失败问题已修复，请复测并记录 | `1cc92d35` |
| 10-19 12:43 | HQUCEncone | question | permission | @Aven.Bot 给我一份 pre 环境的 账户和 密码，测试用 | `a4878c39` |
| 10-20 08:45 | HQUCEncone | change | irreversible | 话题筛选 / 瀑布流测试帖待社区后端造 你自己写一个脚本，批量调用发帖API 生产一些数据吧 @Aven.Bot | `0c91bdcd` |
| 10-20 11:12 | Aven.tong | change | irreversible | 继续任务 om_x100b6246ece5f8a0ed5fc6d0c91bdcd 归 aven 做（功能总表没写清归属的一律归 aven）。在 pre 用测试号 uid 508（a | `4a51a1b2` |
| 10-21 06:23 | HQUCEncone | question | permission | live 后端：把测试号拉进主播群（L1） @Aven.Bot 把你的账户 昵称给我发一下 | `7d8cca5c` |
| 10-21 12:40 | Arthur.a | verification | money | @Aven.Bot 测试账号已经添加了资产路径 | `04d2cded` |
| 10-21 12:48 | Arthur.a | verification | permission irreversible | @Aven.Bot 请新建一个测试号进行测试，修改了部分用户写入逻辑 | `4304bbb6` |
| 10-22 05:57 | Aven.tong | change | money | falive 的 礼物 模块需求有更新如上，请同步更新 @Aven.Bot | `680cd575` |
| 10-22 06:37 | Mateo | change | money | @Aven.Bot 关闭直播间内的礼物入口，由服务端控制，方便后续兼容低版本。 | `0c1c7ab2` |
| 10-22 07:19 | Arthur.a | question | money | 10-22 pre 实测（uid 508）直播间和任务中心自己的签到按钮调 checkinPointsTask/sign 都回 code -1「积分模块未开启！」，checkinP | `5faec9b0` |
| 10-22 13:33 | HQUCWilliam.m | verification | permission | 复测Bug-4927 嗨聊既有帳號登入FALIVE失敗 @Aven.Bot | `950f9c78` |
| 10-22 13:36 | HQUCWilliam.m | verification | permission | 复测Bug-4927 嗨聊既有帳號登入FALIVE失敗 @Aven.Bot | `eb40e078` |
| 10-22 13:41 | Aven.tong | ops | permission | 继续任务 om_x100b629558c848a0ed58744eb40e078 做 | `0a063d79` |
| 10-22 14:55 | HQUCEncone | change | money permission | ![Image](img_v3_0216n_aa8d794b-4964-4f34-b409-73b604ef60ix) { "user_login": "188****8888", | `0308f79a` |
| 10-22 15:19 | HQUCWilliam.m | verification | permission | 复测Bug-4927 嗨聊既有帳號登入FALIVE失敗 ，直接测试 ！ @Aven.Bot | `02953573` |
| 10-22 15:21 | HQUCEncone | record | permission | 手機號登入 Account：+86 15661234567 PWD：123qwe hichat 旧帐户 @Aven.Bot 存一下 | `b3e1b1b9` |
| 10-22 15:32 | Aven.tong | ops | permission | 继续任务 om_x100b6296c06434a4ed52d4f73a4c676 做 | `99cadc79` |
| 10-22 15:33 | HQUCWilliam.m | verification | permission | @Aven.Bot Account：+86 15661234567 PWD：123qwe | `0bf876b7` |
| 10-22 15:49 | Arthur.a | question | money | @Aven.Bot 10-22 pre 实测（uid 508）直播间和任务中心自己的签到按钮调 checkinPointsTask/sign 都回 code -1「积分模块未开启！ | `0802ce55` |
| 10-23 06:36 | HQUCEncone | record | permission | 已经将uid 508 设成主播 @Aven.Bot | `4650decc` |
| 10-23 13:52 | Aven.tong | ops | irreversible | 推 pre | `0908e243` |
| 10-23 15:19 | Aven.tong | question | money | 我记得 2 已经有定论了，帮忙解答一下 @Aven.Bot | `8098f8fa` |
| 10-24 15:44 | HQUCWilliam.m | verification | irreversible | @Aven.Bot 创建最新的帖子 进行测试 | `6f75d5a1` |
| 10-26 06:47 | Arthur.a | question | money | <p>@Aven.tong @Aven.Bot 请协助看一下，这个地方点击兑换是否应该是打后端的兑换API，成功以后再做跳转，目前是直接跳转了</p> | `e5c8eaa0` |
| 10-26 06:49 | HTStone.z | verification | money permission | @Aven.Bot 請嘗試郵箱登入 郵箱：kegocel106@airhemp.com 密碼：123qwe | `f09ac193` |
| 10-26 09:39 | Arthur.a | verification | permission | @Aven.Bot 测试一下pre环境真实验证码接入 | `29e7ed15` |
| 10-26 10:26 | Arthur.a | verification | irreversible | 刚才发布了，重新接一下 | `79553ea1` |
| 10-26 10:41 | Arthur.a | question | permission | - ⚠️ 接了但还不能用 上传头像：测试号带有效 token 传 PNG，网关和直连 Go 都回 503「Internal server error」，没有落库，需要 Go 后端查 | `b72959e2` |
| 10-26 11:42 | Aven.tong | ops | status · 待办 | 已部署 | `4c4f9abc` |
| 10-27 07:29 | Aven.tong | ops | status · 待办 | 已发布 | `b163a6f3` |
| 10-27 07:31 | Aven.tong | ops | status · 待办 | 已部署 | `49d657d4` |
| 10-27 10:27 | Arthur.a | question | permission | <p>@Aven.Bot 请给我提供一下bug-4970的curl信息</p> | `16d756ea` |
| 10-27 12:23 | HQUCEncone | verification | permission | 508 主播这条，我已经加过了，现在前端还不对吗？ @Aven.Bot | `c76e06d2` |
| 10-27 12:24 | HQUCEncone | question | permission | \| C1 \| 某账号发帖回 HTTP 500（Bug-4994） \| 10-26 核对：live uid 19650 的 `member/info` / `member/group | `96da700f` |
| 10-27 12:26 | HQUCEncone | verification | permission | https://falivepre.fdsser.com/bbsv2/member/otherInfo?uid=19694&channel_code=hc \| C3 \| 游客看他人 | `023c63ab` |
| 10-28 09:14 | Aven.tong | ops | status · 待办 | 已部署 | `6e03cd66` |
| 10-28 09:57 | Aven.tong | question | irreversible | 请给出详细信息，@相关人员 @Aven.Bot | `a2896f5c` |
| 10-28 10:13 | Aven.tong | ops | status · 待办 | 已部署 | `fc5e55ec` |
| 10-28 10:59 | Arthur.a | question | money | @Aven.tong @Aven.Bot 请帮我核实一下现在web端调用权益兑换接口，请求头是否有传X-Hc-Uid字段呢 | `e1ee9885` |
| 10-28 11:02 | Aven.tong | ops | status · 待办 | 已部署 | `bcde0e47` |
| 10-29 10:18 | Aven.tong | ops | status · 待办 | go 这块儿改好上 pre 请记得在这里回复一下哈。bot 会去复测和改 bug 状态为 已推版 @mainly | `c0b02070` |
| 10-29 11:23 | Arthur.a | question | permission | <p>我这边是需要登录注册的时候返回一个游客token是不是这样@Aven.tong @mainly</p> | `ef79e798` |
| 10-29 11:25 | Aven.tong | question | permission | 帮忙回复一下，详细一点 @Aven.Bot | `e204b421` |
| 10-29 11:28 | mainly | record | permission | @Arthur.a 前端给你了一个 guest_token 你再原样交给 /api/internal/issueToken 接口就行了，文档在这里: [https://ojp3ou | `a91d2327` |
| 10-29 11:54 | Aven.tong | change | permission | <p>现在就开，将这个 task 完成，还需要什么信息直接问我要 @Aven.Bot</p> | `3306731d` |
| 10-29 12:14 | Arthur.a | verification | status | @Aven.Bot @Aven.tong 辛苦核实一下现在API | `2ed77784` |
| 10-29 12:16 | Arthur.a | verification | permission | <p>uat环境登录发送验证码API和pre环境不一致，请解决@Aven.Bot</p> | `8588b4d1` |
| 10-29 12:21 | Arthur.a | change | permission | @Aven.Bot 现在uat环境前端API还是有问题 cc@World @Charlie | `26531c41` |
| 10-29 12:48 | Aven.tong | question | permission | ![Image](img_v3_0216u_2fe1cb33-c332-450e-8591-741305cdd1hu) @Aven.Bot 1 确认下现在 登录 这块 pre 与  | `481dd30c` |
| 10-29 12:48 | Arthur.a | verification | permission irreversible | @mainly @Aven.tong 这个发布到pre了，方便测试一下吗 | `28317895` |
| 10-29 13:27 | mainly | question | permission | ![Image](img_v3_0216u_94435bb5-4ce4-41cf-8875-65bc80733eix) ![Image](img_v3_0216u_1aba832f | `ea358b2d` |
| 10-29 13:29 | HTStone.z | chat | permission | 目前應該沒這紀錄 @mainly 你郵箱註冊有成功嗎? | `70c2f1f4` |
| 10-29 13:32 | mainly | record | permission | @HTStone.z 邮箱验证码后台也看不到了 ![Image](img_v3_0216u_3a6f3310-7389-4d78-8252-4babc078dfix) ![Imag | `94527e7a` |
| 10-29 13:32 | HTStone.z | record | permission | @mainly 沒有~可以用暫時郵箱直接收信 | `be79294d` |
| 10-29 13:32 | HTStone.z | record | permission | 這一段我試過可以收到信的 | `3b11bfc6` |
| 10-29 13:33 | Aven.tong | record | permission | 用邮件注册，会更流畅些 | `e1a5022b` |
| 10-29 15:30 | HQUCWilliam.m | question | permission | @Aven.Bot 这个是什么原因 | `8465c62b` |
| 10-29 15:40 | HQUCWilliam.m | question | permission | uat 是有 google_cilent_id ，为什么没有生效 @Aven.Bot | `4abde287` |
| 10-29 15:45 | HQUCWilliam.m | change | permission | @Aven.Bot 936185625672-prj7k33l5a1kq22j822e1htn5cvojmdk.apps.googleusercontent.com uat OL  | `fca61464` |
| 10-29 15:47 | Aven.tong | change | permission | @Aven.Bot 更新下信息，为后期切换留好接口 | `4d72df9f` |
| 10-29 15:59 | HQUCWilliam.m | record | permission | @Aven.Bot auth javascript 已经加了 | `e6a3b130` |
| 10-30 06:29 | HQUCEncone | ops | irreversible | @Aven.Bot 能不能将全部功能先打包到 uat OL 这样后端可以明显的排查缺哪些配置？ | `ecb864a1` |
| 10-30 06:51 | Aven.tong | ops | irreversible | 帮我合 | `7283e8e3` |
| 10-30 10:12 | Arthur.a | question | permission | @mainly @Aven.tong @Aven.Bot 请协助看一下这部分内容的前端代码是否在uat环境 | `8d04e660` |
| 10-30 14:37 | HQUCEncone | verification | permission | 个人资料必须要登陆才行，请aven 给你一个账户 @Aven.Bot 帮忙看下 api 返回资料」 | `531e4598` |
| 10-30 17:37 | Aven.tong | question | money | 这有更多点的信息，请整体看看 @Aven.Bot | `426297ed` |
| 10-30 17:42 | Aven.tong | verification | permission | 自己登录进去看看，这个是账号： [734343862@qq.com](mailto:734343862@qq.com) Test1234 | `c13d396a` |
| 10-31 08:51 | Aven.tong | question | permission | @Aven.Bot 这是 online 环境的问题， 请 check 一下 ，之前 pre/uat 同一问题是怎样解决的？ | `bff8065f` |
| 10-31 08:54 | Arthur.a | change | status | @Aven.tong @Aven.Bot 请接入一下 | `f3fe4f73` |
| 10-31 08:57 | Arthur.a | change | status | @Aven.Bot | `e6f6a4b8` |
| 10-31 08:59 | Arthur.a | change | money status | 调用api/member/updateInfo这个API或者avatar/upload成功一项就直接调用完成 | `2fd7b6fb` |
| 10-31 09:04 | Arthur.a | record | status | 调用api/member/updateInfo这个API或者avatar/upload成功一项就直接调用完成 | `c31a1f8e` |
| 10-31 10:38 | Aven.tong | ops | status | ![Image](img_v3_02170_df45ff99-b6ea-44ff-a311-6b60f3bb6dhu) 如果两位在线下有对接好，我就让 bot 跳过这个 bug , | `e7c9eab7` |
| 10-31 14:06 | Arthur.a | question | permission | @Aven.Bot 把你这次测试的账号密码发给我，我测试一下 | `ec5b73f2` |
| 10-31 15:02 | Aven.tong | question | irreversible · 待办 | @Aven.Test uat 环境通过了，确认一下相同的改动是不是合到 online 上了。如果是，就运行 "部署 online" 指令， 不用我确认草稿，直接发就好了。发完告诉我 | `461061e6` |
| 10-31 15:23 | Aven.tong | ops | irreversible · 待办 | @Aven.Test 发群通知 | `6feda8fc` |
| 10-31 15:42 | Arthur.a | verification | money irreversible | @Aven.Bot 测试一下生产环境社区帖子评论任务是否能正常完成和积分到账 | `36bcf1d9` |
| 11-02 08:26 | HQUCWilliam.m | question | permission | @Aven.Bot @Aven.tong ![Image](img_v3_02172_63d35f48-855b-4e62-b233-83f234056cix) 为什么点登陆，调的 | `fc0f579b` |
| 11-02 11:30 | HQUCEncone | verification | money status irreversible | @Aven.Bot 「发评论 → 任务完成 → 积分到账」 已经更新到OL，可以进行确认验证 | `aa9319b3` |

## 待办不计分（pending，11 条）

| 时间（UTC） | 人 | kind | 标签 | 原话 | id |
|---|---|---|---|---|---|
| 10-26 11:42 | Aven.tong | ops | status · 待办 | 已部署 | `4c4f9abc` |
| 10-27 07:29 | Aven.tong | ops | status · 待办 | 已发布 | `b163a6f3` |
| 10-27 07:31 | Aven.tong | ops | status · 待办 | 已部署 | `49d657d4` |
| 10-28 09:14 | Aven.tong | ops | status · 待办 | 已部署 | `6e03cd66` |
| 10-28 10:13 | Aven.tong | ops | status · 待办 | 已部署 | `fc5e55ec` |
| 10-28 11:02 | Aven.tong | ops | status · 待办 | 已部署 | `bcde0e47` |
| 10-29 10:18 | Aven.tong | ops | status · 待办 | go 这块儿改好上 pre 请记得在这里回复一下哈。bot 会去复测和改 bug 状态为 已推版 @mainly | `c0b02070` |
| 10-31 15:02 | Aven.tong | question | irreversible · 待办 | @Aven.Test uat 环境通过了，确认一下相同的改动是不是合到 online 上了。如果是，就运行 "部署 online" 指令， 不用我确认草稿，直接发就好了。发完告诉我 | `461061e6` |
| 10-31 15:23 | Aven.tong | ops | irreversible · 待办 | @Aven.Test 发群通知 | `6feda8fc` |
| 10-31 15:31 | Aven.tong | question | — · 待办 | online 复测结果发群了吗 | `f086171d` |
| 10-31 15:34 | Aven.tong | question | — · 待办 | 为什么不发到PHp后端群？ | `e6e461b7` |
