# Falive Web 一期 · 日报（2026-10-13）

aven 负责 27 项，其中 23 项已 ✅。今天转 ✅ 的有 #3、#8、#42、#38、#50、#39、#41；henry 的 #32 拉流实测通过，也转 ✅。aven 剩下的 4 项代码都写完了，只在等外部：#9 / #30 等 pre 灌点播视频，#4 等后端修预约数据（A5-2），#27 等 henry 的他人主页。前端侧没有不等外部就能继续推进的功能。最大的两个外部阻塞：一是 **hichat 登录打通**（H1 / H2），卡着 adrian、eric、broker、henry 四个负责人约 1/3 的功能；二是 **预约接口数据**。

## 一、功能进度总览（白板一期 54 项 + 产品 10-12 新增搜索 1 项 = 55）

✅ = 写完且接真实接口。没打勾的写明还剩什么、卡在哪、找谁。

| # | 功能 | 负责人 | 状态 | 还剩什么 · 卡在哪 | 需要谁支持 |
|---|---|---|---|---|---|
| 1 | 用户资料 | henry | ⬜ | 自己的资料走 MSW / discuz，上线必 404，要改接 bbsv2 `member/info`；他人资料纯 mock | hichat JWT（arthur / william）；社区后端已答复不用迁 |
| 2 | 登录 / 注册 | henry | ⬜ | 10-13：pre 上登录 / 注册按钮和顶栏登录钮改成品牌渐变（只改样式）。邮箱注册 / 登录 pre 已通；剩手机号注册 / 登录、刷新恢复登录态回归；hichat JWT 未打通 | hichat 后端 H1 / H2 |
| 3 | 直播预告-节目表 | aven | ✅ | 10-13：pre 已有 30 条预告，昵称 / 已预约字段齐，SSR 出真实卡片，转 ✅ | |
| 4 | 直播预告-预约 | aven | ⬜ | 10-13：pre 脚本实测，关注后 `follow_only` / `is_reserve` 正常；但 `reserveMatch` 对 upcoming 的 `live_id` 回「预约的直播不存在」（A5-2）。UI / 调用都齐，前端不用改 | live 后端 Ache（[对接-live后端-3](./pending/对接-live后端-3.md) §1） |
| 5 | 首页 banner | aven | ✅ | | |
| 6 | 正在直播-标签 | aven | ✅ | pre 标签字典为空，tab 只剩「全部」 | live 后端配 `live_streaming/tags`（L23） |
| 7 | 正在直播-封面 | aven | ✅ | | |
| 8 | 首页直播推荐 | aven | ✅ | 10-13：pre 数据齐，转 ✅；接口忽略 `limit`，前端截前 6 条 | |
| 9 | 首页推荐视频 | aven | ⬜ | 10-13：按后端答复改接 `video/getList` + `getInfo` + `addView`，新增播放页 `/video/<id>`（mp4 / m3u8 都能播），区块从 home 移进 live；后端口头说录播先只支持 mp4。pre 无数据 | live 后端灌 `video/getList` 数据（对接-live后端-3 §2） |
| 10 | 主播推荐→个人主页 | aven | ✅ | 跳转目标（他人主页）是 #46 | |
| 11 | 首页热门新闻 | aven | ✅ | | |
| 12 | 积分总额 | adrian | ⬜ | `/tasks` 纯 mock；preview 页用 MSW | hichat JWT；合 `codex/points-task-center` |
| 13 | 每日签到 | adrian | ⬜ | 同上；签到后状态不变 | 同上 |
| 14 | 补签 | adrian | ⬜ | 组件未挂载；按周还是按月待定（H5） | hichat 后端 |
| 15 | 七日大礼包 | adrian | ⬜ | 组件未挂载 | hichat JWT |
| 16 | 积分流水 | adrian | ⬜ | 纯 mock | hichat JWT |
| 17–20 | 新手 / 每日任务（直播、fameex 联动） | adrian | ⬜ | 列表走 MSW；完成上报 `complete` / `report` 未接；fameex 联动怎么判定待定 | hichat 后端 H5 |
| 21 | 积分兑换 | adrian | ⬜ | 面板未挂载；`mallRights/*` 未接；一期上不上线待定 | hichat 后端 H6 |
| 22 | 任务中心热门新闻 | aven | ✅ | | |
| 23 | 客服 | henry | ⬜ | 10-13：pre 上 `/help` 按稿重排样式（会话列表 / 消息面板、输入栏），数据没动。仍是本地关键词应答；未读角标写死 | 按 x9 接 `user_xing/help` + `sendToAssistant`（H-3） |
| 24 | 群组 | henry | ⬜ | 会话 / 消息 mock | 按 x9 接 `getChatRoomList` + `history(room_type=1)`（H-2） |
| 25 | 私聊 | henry | ⬜ | 主播私聊 aven 已接；help 模块私聊仍 mock | 同上 |
| 26 | 热门主播卡 | aven | ✅ | | |
| 27 | 热门主播→个人主页 | aven | ⬜ | 链接已有；目标页（他人主页）是 mock（#46） | henry |
| 28 | 主播主页-直播存档 | broker | ⬜ | 10-13：live 后端给了直播站接口 `front/anchorRecordListCursor?uid=`，不再走嗨聊内网接口；uid 260 实测有数据。还没有 UI | broker 直接接（[对接-前端同事-2](./pending/对接-前端同事-2.md) B3） |
| 29 | 正在直播列表 | aven | ✅ | | |
| 30 | 录播 tab | aven | ⬜ | 同 #9：列表 / 详情 / 播放页已接，pre 无数据 | live 后端灌数据（对接-live后端-3 §2） |
| 31 | 直播频道热门新闻 | aven | ✅ | | |
| 32 | 直播视频区域 | henry | ✅ | 10-13：房间 260 拉流（m3u8）实测通过，转 ✅；房间 283 的 pull 是 mp4 文件，按扩展名改用原生 video 播；henry 撤掉了自定义控制条（播放器本体在 iframe 里改不了），只保留 800×448 容器。剩 flv、清晰度切换（不阻塞） | 非 mp4 文件转不转码：live 后端（对接-live后端-3 §6） |
| 33 | 直播间公屏 | henry | ⬜ | 10-13：pre 上输入栏、广场 tab 按稿调了样式。aven 已接 WS + 历史 + 发言，待 henry 在 pre 回归；置顶 / 禁言 / 公告 / 红点未做 | |
| 34 | 直播间私聊 | henry | ⬜ | 10-13：气泡时间按稿移到右下（只改样式）。主播私聊已接，待回归；图片 / 视频 / 分页未做 | |
| 35 | 直播间群组 | henry | ⬜ | 10-13：pre 上群组 tab 按稿改成单列（只改样式），数据仍 mock | 同 #24 |
| 36 | 排行榜 | aven | ✅ | 10-13：第二榜标题改「话痨榜（今日）」（全平台口径）。pre 无数据 | live 后端灌榜单（L25） |
| 37 | 直播间直播预告 | aven | ✅ | | |
| 38 | 礼物（付费） | aven | ✅ | 10-13：周会定礼物只保留老 falive 的付费送礼，免费礼物 / 每日额度 / 分类 Tab 都不做，代码去掉了预留字段，转 ✅ | 测送礼要有带钻石的账号（L4） |
| 39 | 表情 | aven | ✅ | 10-13：贴纸等于免费礼物，不做，转 ✅ | |
| 40 | 热门直播 | aven | ✅ | | |
| 41 | 留言板（= 举报） | aven | ✅ | 10-13：按后台口径接通举报（`report/classifyList` + `report_user/insert`），转 ✅。pre 没配举报分类，区块不显示 | live 后端 / 运营配分类（对接-live后端-3 §3） |
| 42 | 直播间直播推荐 | aven | ✅ | 10-13：同 #8，转 ✅ | |
| 43 | 直播间热门新闻 | aven | ✅ | | |
| 44 | 社区广场 | aven | ✅ | 10-13：分享改为前端拼本站链接，新增帖子落地页 `/square/<tid>`。信息流 / 话题 / 点赞 / 收藏 / 关注已接；pre 没有帖子，没法验收；uat / online 要配 `/bbsv2/` 转发 | 社区后端造帖（C3）；运维 O10 |
| 45 | 新闻 | aven | ✅ | | |
| 46 | 个人主页基础信息 | henry | ⬜ | 10-13：pre 上 `/user/$id` 资料头按稿重做（只改样式）。他人主页 mock；`isSelf` 只判 `id==="me"`；资料要改接 bbsv2 | 社区后端已答复，无阻塞 |
| 47 | fameex 入口 | eric | ⬜ | 没有 UI | hichat 后端 H8 + JWT |
| 48 | 个人简介 | henry | ⬜ | 写入走真实接口；读取是 mock（同 #46） | |
| 49 | 个人主页-直播存档 | broker | ⬜ | 同 #28 | |
| 50 | 基础送礼 | aven | ✅ | 10-13：同 #38，转 ✅ | |
| 51 | 行情跑马灯 | eric | ⬜ | 生产上是写死的行情；接口提交在 `origin/rescue/eric-ticker-81010d6`，还没接回，请求目标要改成 hichat | hichat 后端 H7 |
| 52 | 一键跟单 | broker | ⬜ | 10-13：后端在 getRoomInfo 文档里补了 `info.start_the_transaction`（1 开、0 不开）。真实数据下 `room.copyTrading` 没接，跟单和充值按钮都不显示；充值按钮的显示规则待 broker 对照 hichat 确认。mock gateway 有 SSR 串数据风险；还没有取跟单群 id 的接口 | hichat / 跟单后端 H9；broker 确认充值规则 |
| 53 | SEO | henry | ⬜ | 10-13：henry 在 pre 补齐了 `/help` `/tasks` `/tasks/flow` `/user/$id` `/copy-trading` 的 head，`/news` 列表补了 og。剩 robots、sitemap、canonical | 运维给正式域名（O8） |
| 54 | adjust 与 ex 对接 | 后端 | — | 没有 web 工作 | |
| 55 | 搜索（新增） | aven | ✅ | 按结构实现，待设计走查；排序规则等产品 | 设计、产品 P17 |

**计数**（不含 #54）：✅ 24 项 = aven 23 + henry 1（#32）。今天转 ✅ 的有 aven 7 项（#3 #8 #42 #38 #50 #39 #41）、henry 1 项（#32）。未完成 30 项：
- henry 11 项：#1 #2 #23 #24 #25 #33 #34 #35 #46 #48 #53
- adrian 10 项：#12–#21
- aven 4 项：#4 等后端修预约数据；#9 #30 代码已完，等 pre 灌视频；#27 等 henry 的他人主页
- broker 3 项：#28 #49 #52
- eric 2 项：#47 #51

## 二、API：还缺什么、哪些有问题

### 2.1 缺接口 / 缺数据 / 缺配置（都已写进 `pending/` 各文档，这里汇总）

| 缺什么 | 影响 | 找谁 | 文档 |
|---|---|---|---|
| **预约接口认不到 `front/upcoming` 给的 `live_id`**（`reserveMatch` 回「预约的直播不存在」，A5-2） | #4 预约按钮 | live 后端 Ache | [对接-live后端-3 §1](./pending/对接-live后端-3.md) |
| pre 没有点播视频（`video/getList` total=0） | #9 推荐视频、#30 录播、`/video/<id>` | live 后端 | 同上 §2 |
| pre 没配举报分类（`report/classifyList` 返回空） | #41 留言板区块不显示 | live 后端 / 运营 | 同上 §3 |
| 后台没配 APK 地址（`getHot.webDownloadPageLinkList` 为空） | 下载页 APK 按钮置灰 | live 后端 / 运营 | 同上 §4 |
| 直播间播的文件不是 mp4 时转不转码。后端口头说录播先只支持 mp4；直播间播文件是不是同一口径，待确认 | 播文件的房间 | live 后端 | 同上 §6 |
| 「我的预约」接口改造（L5）、非主播 `getRoomInfo` 500（L20）、各环境 tags（L23）、排行榜数据（L25）、带钻石的测试号（L4） | #4 / #32 / #6 / #36 / #38 | live 后端 | 同上「还在等排期的」 |
| **hichat 登录打通 H1 / H2**（live 用户 ↔ hichat id、怎么拿 JWT）；登录时 `JHiChatAccountSync` 报错（H-obs） | 任务中心 #12–#21、跑马灯 #51、跟单 #52、fameex #47、个人资料（eric 已改走 hichat） | hichat 后端 arthur / william | [对接-hichat后端-2](./pending/对接-hichat后端-2.md) |
| 按主播取跟单群 id 的接口；直播间充值按钮显示规则 | #52 | hichat / 跟单后端；broker 对照 hichat 确认 | 对接-hichat后端-2 H9、[对接-前端同事-2](./pending/对接-前端同事-2.md) B2 |
| SSR 出口 IP（O2b）、uat / online WS 域名（O4）、前端域名（O8）、uat / online 反代（O-U1）、`/bbsv2/` 转发（O10） | 上线、SEO canonical、SSR 免限流 | 运维 | [对接-运维-2](./pending/对接-运维-2.md) |
| pre 的 hc 平台没有社区帖子（C3） | #44 广场、话题、点赞 / 收藏、分享落地页的验收 | 社区后端 | [对接-社区bbsv2-2](./pending/对接-社区bbsv2-2.md) |
| 搜索排序规则、看直播领积分规则、社交链接表 | P17 / P10 / P6 | 产品 | [对接-产品与设计-2](./pending/对接-产品与设计-2.md) |

### 2.2 接过但有问题的接口

| 接口 | 问题 | 处理 | 负责人 |
|---|---|---|---|
| `POST /api/live/reserveMatch` | 对 upcoming 的 `live_id` 返回 -1 | 等后端（上表第一条，A5-2） | live 后端 |
| `GET /api/video/getInfo` | 不存在的 id 会抛 PHP 异常文案 | 前端已按 404 兜住，建议后端改成业务错误（对接-live后端-3 §5） | live 后端 |
| `GET /api/front/upcoming` | 不认 `limit`，整页返回 | 前端截前 6 条，不阻塞 | — |
| `/discuz/v2/api/users/info`（user 模块） | nginx 不转发 `/discuz`，上线必 404；Encone 确认前端不需要 | 删掉，改接 bbsv2 `member/info`（H-12） | **henry** |
| `/api/member/profile/my`（user 模块） | pre 上 eric 已改走 hichat，但 hichat JWT 没打通，等于现在不可用；MSW handler 仍登记在 aven 名下 | 等 H1 / H2；`pending-endpoints.json` 里两条的 owner 改成 henry | **henry / eric** |
| 任务中心 `points/task/*`、跑马灯 `thirdConfigManage/*`、跟单 gateway | 代码指向 hichat 或 mock，JWT 没打通 | 等 H1 / H2 | adrian / eric / broker |
| 嗨聊内网录播接口（`getHiChatUidRecordVideoCursor` / `hi_chat_program/*`） | 后端说这是给嗨聊内网用的，前端不该直连 | 改用 `front/anchorRecordListCursor?uid=`（B3） | **broker** |
| 直播间群组 `chat/getChatRoomList` + `history(room_type=1)`、客服 `user_xing/help` + `sendToAssistant` | 未接，仍 mock | 按 x9 接 | **henry** |
| 头像上传 `uploadAvatar` | 要 multipart；原来的 GET 实现已删，还没重做 | | **henry** |
| `robotManualList` | 后端定了它不是录播数据源，已弃用 | — | — |

### 2.3 已接通并在 pre 实测过的（不用再管）

- 首页 / 直播：banner、直播列表 / 分页 / 标签、房间详情、拉流（房间 260 m3u8、283 mp4 文件）、直播预告、即将开播（含 `follow_only` / `is_reserve`）、首页和直播间的直播推荐
- 直播间互动：礼物列表 / 付费送礼 / 余额、排行榜、公屏 WS / 聊天历史 / 发言、主播私聊、关注、签到
- 新闻与搜索：新闻列表 / 分类 / 详情、搜索（直播间 / 主播 / 新闻）
- 社区：信息流、话题、点赞、收藏、关注、帖子落地页、心跳
- 账号：登录、注册、验证码、登出
- 接口通但 pre 无数据或未配置：举报分类 + 举报提交（pre 无分类）、`video/getList` / `getInfo` / `addView`（pre 无数据）、`getHot` 下载链接（未配）
- 主播直播回放 `front/anchorRecordListCursor`：uid 260 有数据，待 broker 接

## 三、其它没做的工作

| 事项 | 说明 | 负责人 |
|---|---|---|
| **合 `origin/pre` → 推 → 合 pre** | 本地有 12 个提交没推（含今天的 3 个交接报告提交）。pre 上 henry 今天的 14 个样式 / SEO 提交、eric 的 2 个提交还没合回本地；冲突按负责人取舍 | **aven** |
| pre 重新部署（O-P1） | 交 QA 前发邮件给 OPS；前端自验用 `pnpm dev:pre` | **aven** |
| 分支流程 | 群里有人说已建 `dev` 分支，后续新分支从 dev 开出；和现在合 pre 的流程怎么衔接，待确认 | 待确认 |
| pre 登录态回归 | WS 公屏收发、送礼动画、主播私聊、刷新恢复登录、手机号注册 | **henry**（H-1 / H-6） |
| 广场 / 留言板 / 录播 / 预约的 pre 回归 | 全部卡在上面的后端数据 | **aven** |
| 合入 `codex/points-task-center`，修好会让生产启动 MSW 的开关，登记 MSW handler | | **adrian** |
| 接回跑马灯提交（`origin/rescue/eric-ticker-81010d6`），请求目标改 hichat | | **eric** |
| 跟单与直播存档 | 跟单 mock gateway 的 SSR 串数据风险；直播间跟单入口用 `start_the_transaction`，充值按钮规则对照 hichat 确认，跟单群 id 接口另要；直播存档按 B3 接 `anchorRecordListCursor`，卡片 / 播放器要先提升到 `@/ui` 再用 | **broker** |
| help 模块按原型改名「聊天」、去掉「小 fa」介绍行 | | **henry** |
| 生产环境仍展示 mock 的区块用 `mockOnly` 包起来（help，以及 user 的 posts / collections / medals / messages / records） | | **henry** |
| SEO 收尾：robots、sitemap、canonical | 各路由 head 10-13 已在 pre 补齐；剩下的等运维给正式域名 | **henry** |
| 播放器 flv / 清晰度切换 | | **henry** |
| 验证码倒计时改用后端 `seconds` | | **henry** |
| 设计走查：搜索页、录播播放页、H5 底部导航 | | 设计走查，**aven** 改 |
| L27 SSR 限流：出口 IP 免限流 | 等运维给 IP，再由 live 后端配 | 运维 / live 后端 |
| 英文文案运营审校 | 产品说上线后再做 | 运营 |
| 五服务模型收敛（golang / dz 占位、`chat` 别名） | 等后端说明 web 用不用 golang / dz | aven |
