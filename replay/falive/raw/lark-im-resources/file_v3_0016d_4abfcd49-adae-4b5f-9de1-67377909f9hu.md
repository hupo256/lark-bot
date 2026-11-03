# Falive Web 一期 · 需 live（php）后端支持的事项

> 致：live 后端（williamWang / broker / eric；后端代码同步 ache）· 发起：aven（前端）· 2026-10-11
> 前端仓库：falive-react，分支 `feature/phase-3-api`。已接通的接口见 [对接状态总览](../apis/对接状态总览.md)，历史答复见 [live-api-后端答复契约](../apis/live-api-后端答复契约.md)。
> **10-12 更正**：部分条目 x9 web 已有现成实现，已撤回或改问法，汇总见 [x9 对齐更正](./x9-对齐更正-2026-10-12.md)。x9 主流程口径见 [x9-main-flows](../architecture/x9-main-flows.md)。
> 前端对缺失的数据不造假：没有接口或字段的地方显示空态或 `--`，所以页面看起来不坏，但功能是缺的。

## 怎么回复

每一项请回复下面三种之一，**直接在条目后面写**就行：

- **有**：给出路径、方法、参数、返回示例（一条真实 JSON 即可）
- **没有，会做**：预计哪天在 pre 上可用
- **没有，不做**：前端会把对应功能下掉，或改成「敬请期待」

## P0：不解决，一期功能不能用

| # | 要什么 | 现在的情况 | 影响的页面 |
|---|---|---|---|
| L0 | **直播流地址一拿到就过期，CDN 返回 403**（最高优先级） | 前端播放器 10-11 已接通（hls.js，取 `getRoomInfo` 的 `pull_m3u8` / `pull`，请求时带 `videoType=m3u8`）。pre 实测房间 128、133：拉流地址 `https://play2zz.sysiyu11.com/live/128_….m3u8?txSecret=…&txTime=…` 全部 403。签名里的 `txTime`（腾讯云的含义是**过期时间**）恰好等于签发时刻，相当于有效期为 0；也可能是密钥或防盗链配置不对。换成公共测试流后前端能正常播放。请修正有效期，并告诉我们有效期多长（SSR 缓存 30 秒 + 前端缓存 3 分钟，过短会在用户停留时失效；前端失败重试时会重新取一次地址）。**10-12 补充**：x9 用的是 `getHot.iframe_url` 外部 iframe 播放器，falive 是 hls.js 直连 pull 地址，403 也可能是防盗链 / referer 造成的；前端会先按 x9 的方式复测，结果出来前请先别改配置 | 直播间视频（一期核心） |
| L1 | **修好 `/api/new_schedule/upcoming`** | pre 先返回 -10501，后来 404。前端已经接好，失败时回落 mock，所以页面看着正常，**实际上没有一条真实数据** | `/upcoming` 全页、首页和直播间的「直播推荐」 |
| L2 | ~~送礼接口~~ 只剩：每个礼物的「免费」标记 + 每日免费额度 + 当前用户钻石余额 | 送礼接口 x9 已有 `GET /api/member/handselGift`（`gift_id` + `anchor_id` + `type=0`），前端照接，不用再给（10-12 按 x9 更正，见 [x9 对齐更正](./x9-对齐更正-2026-10-12.md)）。礼物列表 `Gift/getList` 已接；余额显示 `--` | 直播间礼物面板（一期范围是「免费礼物」） |
| L3 | ~~WebSocket 缺的 4 类消息体~~ **撤回**（10-12 按 x9 更正，见 [x9 对齐更正](./x9-对齐更正-2026-10-12.md)） | x9 web 只按 `action` 分发（`open` / `send` / `msg` / `gift` / `inRoom` / `liveHeat` / `toggle` / `closeLive` 等 19 种），进场特效 `inRoom`、在线人数 `liveHeat`、刷新房间 `toggle` 都已有；x9 web 没有红包，也不调 `getChatToken`（无 MQTT）。连接：同源 `/wss/?userToken=<登录 token，没有就用游客 token>` → 每 10 秒 `"heart"` → `sub` / `unsub`。pre 已实测；uat / online WS 域名找运维（对接-04 O4） | — |
| L4 | **一个 `hc` 平台的测试账号**（手机号 + 邮箱，pre / uat 各一套） | 前端 10-11 已接真实登录（`NewLogin` / `NewMailLogin` / `sendVerificationCode` / `NewRegistered*` / `Member/info` / `Member/SignOut`，RSA 加密同 x9）。pre 实测：验签通过，密文被接受（明文对照返回 500），错误账号返回「用户名或密码错误」。**缺测试账号，登录成功后的链路（关注、改资料、头像、预约）还没验证过** | 所有需要登录的功能 |
| L4b | **邮箱 + 验证码能否登录？** `NewMailLogin` 传 `{mail, code}` 返回「请输入您的密码!」（x9 的传法相同）。请确认字段名，或明确邮箱只支持密码登录 | 前端如实显示后端提示 | 邮箱验证码登录 |

## P1：一期页面上有、现在是 mock 的区块

请逐个回复「有 / 没有 / 路径」。标「撤回」的是 x9 已有现成接口、不用再答的条目。

| # | 要什么 | 前端猜测的路径 | 字段需要 | 影响 |
|---|---|---|---|---|
| L5 | ~~「我的预约」列表~~ **撤回** | x9 已有 `/api/live_streaming/getUserReserveLiveList`，前端照接（10-12 按 x9 更正，见 [x9 对齐更正](./x9-对齐更正-2026-10-12.md)） | — | `/upcoming` 第二个 tab |
| L6 | 推荐视频 / 录播列表：web 走哪个服务？ | ~~`new_playlist/allLiveList`~~ 猜错了，它在 x9 是「开播选赛」。hichat spec 里有 `/b2b/liveList`、`/b2b/recordVideoList`，请确认 web 是否用它们（10-12 按 x9 更正，见 [x9 对齐更正](./x9-对齐更正-2026-10-12.md)） | 标题、封面、时长、播放地址、观看数、主播 | 首页「推荐视频」、`/lives` 录播 tab |
| L7 | 录播详情（单个视频）+ 相关推荐 | — | 同上 + 简介 | 录播「视频播放」页（Figma `221:170177`，目前没有路由） |
| L8 | 留言板提交 + 列表 | — | 内容、用户、时间 | 直播间留言板（现在提交只提示「敬请期待」） |
| L9 | 直播间预告 | — | 标题、开播时间、封面（可空） | 直播间公告 tab 的「直播预告」 |
| L10 | ~~直播间聊天历史~~ **撤回** | x9 已有 `GET /api/chat/history?room_type=0&limit=50`（10-12 按 x9 更正，见 [x9 对齐更正](./x9-对齐更正-2026-10-12.md)） | — | 进直播间时公屏的前 N 条 |
| L11 | ~~主播私聊、群组的会话和消息接口~~ **撤回** | x9 都在 php：`/api/chat/getChatRoomList`、`sendToAnchor` + `anchorHistory`、`sendMessage`（群聊 type=1）、`sendToAssistant`、`/api/chat_msg_video/*`；推送走同一条 WS 的 `msg`（10-12 按 x9 更正，见 [x9 对齐更正](./x9-对齐更正-2026-10-12.md)） | — | 直播间「私聊」「群组」tab（前端 henry） |
| L12 | 直播间「签到」 | — | — | 直播间主播栏的签到按钮（现在提示「敬请期待」）。如果它其实属于任务中心，请直说 |

## P2：字段补齐（页面能用，但和设计稿有差距）

| # | 接口 | 要补的字段 | 用途 |
|---|---|---|---|
| L13 | `new_schedule/upcoming` 每项 | `cover`（节目封面）、主播 `avatar`、主播 `uid` | 节目卡封面、主播头像、点「进行中」跳直播间 |
| L14 | `/api/preload/getBannerList` 每项 | `title`、`subtitle`（可空，按语言返回） | 首页「优惠活动」卡片的两行文字 |
| L15 | ~~`getRoomInfo`~~ **撤回** | 已有 `userData.heat`、`live_room_online_count`，实时值来自 WS `liveHeat`（10-12 按 x9 更正，见 [x9 对齐更正](./x9-对齐更正-2026-10-12.md)） | 直播间主播信息行 |
| L16 | `getRoomInfo` | 这个房间有没有「一键跟单」入口、对应的跟单群 id | 直播间一键跟单按钮。前端用的 `room.copyTrading` 只在 mock 里有，接真实接口后按钮恒隐藏（跟单后端 broker） |
| L17 | 新闻列表和详情 | `tags: string[]` | `/news` 头条标签行 |
| L18 | 客服会话列表 | 最后一条消息的 `sentAt`（ms）、消息 id、未读数 | 全站右下角客服浮窗的时间和角标（前端 henry） |

## P3：口径确认（一句话回复即可）

| # | 问题 |
|---|---|
| L19 | **错误码表**：-666、-888、-10501 各是什么意思？有没有专门表示「不存在」（404）的码？（`±700` 登录/游客失效、`-800` 签名错位已按 x9 处理，不用再答（10-12 按 x9 更正，见 [x9 对齐更正](./x9-对齐更正-2026-10-12.md)）） |
| L20 | **房间不存在**时 `getRoomInfo` 返回什么？前端要据此给 `/room/<id>` 返回 404 页 |
| L21 | ~~关注有两套接口，用哪一个？~~ **撤回**：以 x9 为准用 `/api/Member/attention?id=`（10-12 按 x9 更正，见 [x9 对齐更正](./x9-对齐更正-2026-10-12.md)） |
| L22 | ~~`front/lives` 是否支持分页~~ 前端已在 pre 实测支持（信封顶层 `page.hasNextPage / allCount`），`/lives` 已改无限滚动。**小问题**：末页刚好取满时 `hasNextPage` 仍为 true（如 45 条、limit=5 的第 9 页），要多请求一次空页；能否修正？ |
| L26 | 图片地址返回的是 `http://`（如 `getRoomInfo` 的 `thumb`：`http://streampre.fdsser.com/upload/...`）。站点是 https，会有混合内容警告，og:image 也会被部分平台拒绝。能否统一返回 https 或协议相对地址？（10-12：也可能是前端直连源站 `streampre` 造成的，x9 走品牌站点网关。待确认 falive 的站点网关域名，见 [x9 对齐更正 §四](./x9-对齐更正-2026-10-12.md)） |
| L27 | 连续请求触发 HTTP 429 / code -666「操作太快」：限流阈值是多少？SSR 服务端回源（同一出口 IP 承载所有用户）是否需要单独放宽？ |
| L23 | 直播标签字典 `/api/live_streaming/tags` 在 pre / uat / online 都部署了吗？直播的 `tags` 里第一个是不是「主分类」？ |
| L24 | 即将开播第二个 tab：`follow_only` 的语义是「只看我关注的主播」还是「我预约的节目」？ |
| L25 | 排行榜：贡献榜、话痨榜的统计周期（日 / 周）和数值字段含义；能否在 pre 灌一些测试数据？（pre 现在两个榜都是空的） |

## 前端已经做好、不需要你们动的

- b2b 签名、访客引导 `/api/secret/getHot`、`sec` 解密、SSR 免签 `/api/preload/*` 都已打通。
- 约 20 个端点已接真实数据（banner、直播列表、房间信息、礼物列表、排行榜、新闻、主播排序、关注、改资料、头像列表等）。
- 主播侧开播接口（getLiveUrl / createRoom / startRoom / endRoom）数据层已写好，web 一期不做开播界面。
