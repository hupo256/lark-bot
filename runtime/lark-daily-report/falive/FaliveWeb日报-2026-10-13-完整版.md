# Falive Web 一期 · 日报（2026-10-13）

> 范围：本地 `feature/phase-3-api`（`ce476b2`，aven 今天 19 个提交）与 `origin/pre`（`2a074a7`）。
> 分支关系：aven 今天前 7 个提交（`9ff6b6f` … `791c2ae`）已合入 pre；后 12 个（`6a7e2a8` … `ce476b2`：后端第二轮答复落地、播文件房间、预约探针、本报告等）只在本地。**pre 上有本地没有的提交**：henry 今天 14 个（直播间 / help / user / auth 按稿二轮对齐、IM 图标与气泡提升到 `@/ui`、SEO head 补齐），以及 eric 的 2 个（`5f4b615` 配 hichat pre host、`9506cd9` 个人资料请求改走 hichat）。合入前先 merge `origin/pre`，冲突按负责人取舍（henry 的聊天 / 播放器 / help / user 样式、eric 的 user 模块改动以他们为准）。另：群里通知已建 `dev` 分支，后续新分支从 `dev` 开出（与 pre 的关系待确认）。
> 负责人依据：[一期功能总表](../lark-migration-source/requirements/phase1-feature-table.md)「前端」列。待对接文档：[`pending/`](./pending/README.md)。

## 一、功能进度总览（白板一期 54 项 + 产品 10-12 新增搜索 1 项 = 55）

✅ = 写完且接真实接口。未打勾的写明还剩什么、卡在哪、找谁。今天有变化的行以「10-13：」开头。

| # | 功能 | 负责人 | 状态 | 还剩什么 / 卡在哪 | 需要谁支持 |
|---|---|---|---|---|---|
| 1 | 用户资料 | henry | ⬜ | 自己资料走 MSW / discuz（上线必 404），要改接 bbsv2 `member/info`；他人资料纯 mock；pre 上 eric 已把个人资料请求改走 hichat，JWT 未通前等于不可用 | hichat JWT（arthur / william）；社区后端已答复不用迁 |
| 2 | 登录 / 注册 | henry | ⬜ | 邮箱注册 / 登录 pre 已通；剩手机号注册 / 登录、刷新恢复登录态回归；hichat JWT 未打通 | hichat 后端 H1 / H2 |
| 3 | 直播预告-节目表 | aven | ✅ | 10-13：pre 已有 30 条预告，主播昵称 / 是否已预约字段齐，SSR 出真实卡片，升 ✅ | |
| 4 | 直播预告-预约 | aven | ⬜ | 10-13：pre 脚本实测关注、`follow_only`、`is_reserve` 都正常，但 `reserveMatch` 对 upcoming 的 `live_id` 回「预约的直播不存在」；前端 UI / 调用都齐，不用改 | live 后端 Ache（对接-live后端-3 §1） |
| 5 | 首页 banner | aven | ✅ | | |
| 6 | 正在直播-标签 | aven | ✅ | pre 标签字典为空，tab 只剩「全部」 | live 后端配 `live_streaming/tags`（L23） |
| 7 | 正在直播-封面 | aven | ✅ | | |
| 8 | 首页直播推荐 | aven | ✅ | 10-13：同 #3，pre 数据齐升 ✅；接口忽略 `limit`，前端截前 6 条 | |
| 9 | 首页推荐视频 | aven | ⬜ | 10-13：按后端答复改接 `video/getList` + `getInfo` + `addView`，新增播放页 `/video/<id>`（mp4 / m3u8），区块由 home 移入 live；pre 无数据 | live 后端灌 `video/getList` 数据（§2） |
| 10 | 主播推荐→个人主页 | aven | ✅ | 跳转目标他人主页是 #46 | |
| 11 | 首页热门新闻 | aven | ✅ | | |
| 12 | 积分总额 | adrian | ⬜ | `/tasks` 纯 mock；preview 页用 MSW | hichat JWT；合 `codex/points-task-center` |
| 13 | 每日签到 | adrian | ⬜ | 同上；签到后状态不变 | 同上 |
| 14 | 补签 | adrian | ⬜ | 组件未挂载；按周 / 按月口径待定（H5） | hichat 后端 |
| 15 | 七日大礼包 | adrian | ⬜ | 组件未挂载 | hichat JWT |
| 16 | 积分流水 | adrian | ⬜ | 纯 mock | hichat JWT |
| 17–20 | 新手 / 每日任务（直播、fameex 联动） | adrian | ⬜ | 列表 MSW；完成上报 `complete` / `report` 未接；fameex 联动判定待定 | hichat 后端 H5 |
| 21 | 积分兑换 | adrian | ⬜ | 面板未挂载；`mallRights/*` 未接；一期是否上线待定 | hichat 后端 H6 |
| 22 | 任务中心热门新闻 | aven | ✅ | | |
| 23 | 客服 | henry | ⬜ | 本地关键词应答；未读角标写死。10-13：henry 按稿重排 `/help`（拆会话列表 / 消息面板），数据仍 mock | 按 x9 接 `user_xing/help` + `sendToAssistant`（H-3） |
| 24 | 群组 | henry | ⬜ | 会话 / 消息 mock | 按 x9 接 `getChatRoomList` + `history(room_type=1)`（H-2） |
| 25 | 私聊 | henry | ⬜ | 主播私聊 aven 已接；help 模块私聊仍 mock | 同上 |
| 26 | 热门主播卡 | aven | ✅ | | |
| 27 | 热门主播→个人主页 | aven | ⬜ | 链接已有；目标页他人主页 mock（#46） | henry |
| 28 | 主播主页-直播存档 | broker | ⬜ | 10-13：后端给了直播站接口 `front/anchorRecordListCursor?uid=`（取代嗨聊内网接口），pre uid 260 有数据，已转 broker；还没有 UI | —（对接-前端同事-2 B3） |
| 29 | 正在直播列表 | aven | ✅ | | |
| 30 | 录播 tab | aven | ⬜ | 10-13：同 #9，录播 tab 改接 `video/getList`，pre 无数据 | live 后端灌数据 |
| 31 | 直播频道热门新闻 | aven | ✅ | | |
| 32 | 直播视频区域 | henry | ✅ | 10-13：房间 260 实测 m3u8 拉流 200（此前 403 只因无推流），升 ✅；补了播文件房间（283，mp4 / webm 原生播放，三个 pull 字段是同一个 mp4，按扩展名识别）；henry 撤回自定义控制条（播放器本体在 iframe 内不可改）。flv、清晰度切换未做（非阻塞） | 非 mp4 是否转码等 live 后端（§6） |
| 33 | 直播间公屏 | henry | ⬜ | aven 已接 WS + 历史 + 发言，待 henry pre 回归；置顶 / 禁言 / 公告 / 红点未做。10-13：henry 输入栏、广场 tab 按稿对齐 | |
| 34 | 直播间私聊 | henry | ⬜ | 主播私聊已接，待回归；图片 / 视频 / 分页未做 | |
| 35 | 直播间群组 | henry | ⬜ | mock。10-13：henry 群组 tab 按稿改单列（搜索行 + 气泡消息流 + 输入栏），数据仍 mock | 同 #24 |
| 36 | 排行榜 | aven | ✅ | pre 无数据；10-13 话痨榜标题改「话痨榜（今日）」（全平台口径） | live 后端灌榜单（L25） |
| 37 | 直播间直播预告 | aven | ✅ | | |
| 38 | 礼物（付费） | aven | ✅ | 10-13：周会定礼物只保留老 falive 付费送礼，免费礼物 / 每日额度 / 分类 Tab 不做，升 ✅；pre 送礼待登录回归 | 测送礼要带钻石账号（L4） |
| 39 | 表情 | aven | ✅ | 10-13：定为本地表情（同 x9，无接口），升 ✅；贴纸 = 免费礼物，不做 | |
| 40 | 热门直播 | aven | ✅ | | |
| 41 | 留言板（= 举报） | aven | ✅ | 10-13：按后台口径接通举报（`report/classifyList` + `report_user/insert`），升 ✅；pre 无举报分类，区块不显示 | live 后端 / 运营配分类（§3） |
| 42 | 直播间直播推荐 | aven | ✅ | 10-13：同 #8，升 ✅ | |
| 43 | 直播间热门新闻 | aven | ✅ | | |
| 44 | 社区广场 | aven | ✅ | 10-13：分享改为前端拼本站链接，新增帖子落地页 `/square/<tid>`（产品 G4）。pre 无帖子没法验收；uat / online 要 `/bbsv2/` 转发 | 社区后端造帖（C3）；运维 O10 |
| 45 | 新闻 | aven | ✅ | | |
| 46 | 个人主页基础信息 | henry | ⬜ | 他人主页 mock；`isSelf` 只判 `id==="me"`；资料改接 bbsv2。10-13：henry 资料头按稿改样式 | 社区后端已答复，无阻塞 |
| 47 | fameex 入口 | eric | ⬜ | 无 UI | hichat 后端 H8 + JWT |
| 48 | 个人简介 | henry | ⬜ | 写入真实；读取 mock（同 #46） | |
| 49 | 个人主页-直播存档 | broker | ⬜ | 同 #28 | |
| 50 | 基础送礼 | aven | ✅ | 10-13：同 #38，升 ✅ | |
| 51 | 行情跑马灯 | eric | ⬜ | 生产是写死行情；接口提交在 `origin/rescue/eric-ticker-81010d6` 未接回，目标要改 hichat | hichat 后端 H7 |
| 52 | 一键跟单 | broker | ⬜ | mock gateway（SSR 串数据风险）；跟单群 id 接口没有。10-13：后端确认 `info.start_the_transaction` 为 1 显示跟单、0 不显示；充值按钮何时显示未定，要对照 hichat 原逻辑确认 | hichat / 跟单后端 H9；broker 确认充值规则 |
| 53 | SEO | henry | ⬜ | 10-13：henry 在 pre 补齐 `/help` `/tasks` `/tasks/flow` `/user/$id` `/copy-trading` 的 head 和 `/news` 列表 og（本地未合）；剩 robots、sitemap、canonical | 运维给正式域名（O8） |
| 54 | adjust 与 ex 对接 | 后端 | — | 无 web 工作 | |
| 55 | 搜索（新增） | aven | ✅ | 按结构实现，待设计走查；排序规则等产品 | 设计、产品 P17 |

**计数**（不含 #54）：✅ 24 项 = aven 23 + henry 1（#32）；今天升 ✅ 8 项（aven #3 #8 #42 #38 #50 #39 #41，henry #32）。未完成 30 项：henry 11（#1 #2 #23 #24 #25 #33 #34 #35 #46 #48 #53）、adrian 10（#12–#21）、aven 4（#4 等后端修预约数据；#9 #30 代码已完，等 pre 灌视频；#27 等 henry 的他人主页）、broker 3（#28 #49 #52）、eric 2（#47 #51）。

## 二、API：还缺什么、哪些有问题

### 2.1 缺接口 / 缺数据 / 缺配置（已在 `pending/` 各文档里，这里汇总）

| 缺什么 | 影响 | 找谁 | 文档 |
|---|---|---|---|
| **预约接口认不到 `front/upcoming` 的 `live_id`**（`reserveMatch` 回「预约的直播不存在」，10-13 实测） | #4 预约按钮 | live 后端 Ache | [对接-live后端-3 §1](./pending/对接-live后端-3.md) |
| pre 没有点播视频数据（`video/getList` total=0） | #9 推荐视频、#30 录播、`/video/<id>` | live 后端 | 同上 §2 |
| pre 没配举报分类（`classifyList` 返回空） | #41 留言板区块不显示 | live 后端 / 运营 | 同上 §3 |
| 后台没配 APK 地址（`getHot.webDownloadPageLinkList` 为空） | 下载页 APK 按钮置灰 | live 后端 / 运营 | 同上 §4 |
| 非 mp4 直播文件是否转码 | 播文件房间 | live 后端 | 同上 §6 |
| 「我的预约」接口改造（L5）、非主播 `getRoomInfo` 500、各环境 tags、排行榜数据、带钻石测试号 | #4 / #32 / #6 / #36 / #38 | live 后端 | 同上「等排期」 |
| **hichat 登录打通 H1 / H2**（live 用户 ↔ hichat id、怎么拿 JWT） | 任务中心 #12–#21、跑马灯 #51、跟单 #52、fameex #47、个人资料（eric 已改走 hichat） | hichat 后端 arthur / william | [对接-hichat后端-2](./pending/对接-hichat后端-2.md) |
| 按主播取跟单群 id 的接口（H9）；直播间充值按钮显示规则 | #52 | 跟单后端；broker 对照 hichat 原逻辑（充值规则尚未写进待对接文档） | 对接-hichat后端-2 H9 |
| pre 重新部署（交 QA 前发邮件给 OPS）、SSR 出口 IP、uat / online WS 域名、前端域名、uat / online 反代、`/bbsv2/` 转发 | 上线 | 运维 | [对接-运维-2](./pending/对接-运维-2.md) |
| pre 的 hc 平台没有社区帖子 | #44 广场、话题、点赞 / 收藏、分享落地页验收 | 社区后端 | [对接-社区bbsv2-2](./pending/对接-社区bbsv2-2.md) |
| 搜索排序规则 + 设计走查、看直播领积分规则、社交链接表 | P17 / P10 / P6 | 产品、设计 | [对接-产品与设计-2](./pending/对接-产品与设计-2.md) |

### 2.2 接过但有问题的接口

| 接口 | 问题 | 处理 | 负责人 |
|---|---|---|---|
| `POST /api/live/reserveMatch` | 对 upcoming 的 `live_id` 返回 -1 | 等后端（上表第一条） | live 后端 |
| `GET /api/video/getInfo` | 不存在的 id 抛 PHP 异常文案 | 前端已按 404 兜住，建议后端改成业务错误（§5） | live 后端 |
| `GET /api/front/upcoming` | 忽略 `limit`，整页返回 | 前端截前 6 条，不阻塞 | — |
| `/discuz/v2/api/users/info`（user 模块） | nginx 不转发 `/discuz`，上线必 404；Encone 确认前端不需要 | 删掉，改接 bbsv2 `member/info`（H-12） | **henry** |
| `/api/member/profile/my`（user 模块） | pre 上 eric 已改走 hichat，但 hichat JWT 未打通，现在等于不可用；MSW handler 仍登记为 aven | 等 H1 / H2；`pending-endpoints.json` 两条 owner 改 henry | **henry / eric** |
| 任务中心 `points/task/*`、跑马灯 `thirdConfigManage/*`、跟单 gateway | 代码指向 hichat / mock，JWT 未打通 | 等 H1 / H2 | adrian / eric / broker |
| 直播间群组 `chat/getChatRoomList` + `history(room_type=1)`、客服 `user_xing/help` + `sendToAssistant` | 未接，仍 mock（10-13 henry 只改了 UI） | 按 x9 接 | **henry** |
| 头像上传 `uploadAvatar` | 需 multipart，原 GET 实现已移除，未重做 | | **henry** |
| `robotManualList` | 后端定不是录播数据源，已弃用 | — | — |
| `getHiChatUidRecordVideoCursor` / `hi_chat_program/*` | 嗨聊内网接口，后端说前端不该直连 | 直播存档改用 `front/anchorRecordListCursor?uid=`（B3） | broker |

### 2.3 已接通并在 pre 实测过的（不用再管）

banner、直播列表 / 分页 / 标签、房间详情、拉流（房间 260 m3u8、283 mp4）、礼物列表 / 付费送礼 / 余额、排行榜、直播预告、公屏 WS / 聊天历史 / 发言、主播私聊、关注、签到、即将开播（含 `follow_only` / `is_reserve`）、首页 & 直播间直播推荐、新闻列表 / 分类 / 详情、搜索（直播间 / 主播 / 新闻）、社区信息流 / 话题 / 点赞 / 收藏 / 关注 / 帖子落地页 / 心跳、登录 / 注册 / 验证码 / 登出、举报分类 + 举报提交（接口通、pre 无分类）、`video/getList` / `getInfo` / `addView`（接口通、pre 无数据）、`getHot` 下载链接（接口通、未配）、`front/anchorRecordListCursor`（uid 260 有数据，待 broker 接）。

## 三、其它没做的工作

| 事项 | 说明 | 负责人 |
|---|---|---|
| **合 `origin/pre` → 推 → 合 pre** | 本地 12 个提交未推；pre 上 henry 今天 14 个、eric 2 个提交未合回本地；henry 改了直播间聊天 / 播放器样式，冲突按负责人取舍 | **aven** |
| pre 重新部署 | 交 QA 前发邮件给 OPS（O-P1）；前端自验走 `dev:pre` | **aven** |
| pre 登录态回归 | WS 公屏收发、送礼动画、主播私聊、刷新恢复登录、手机号注册 | **henry**（H-1 / H-6） |
| 广场 / 留言板 / 录播 / 预约 的 pre 回归 | 全部卡在上面的后端数据 | **aven** |
| 合入 `codex/points-task-center`，修生产启动 MSW 的开关，MSW handler 登记 | | **adrian** |
| 跑马灯提交接回（`origin/rescue/eric-ticker-81010d6`），请求目标改 hichat | | **eric** |
| 跟单 mock gateway 的 SSR 串数据风险；直播间跟单入口用 `start_the_transaction`，充值按钮规则对照 hichat 原逻辑确认；群 id 接口；直播存档按 B3 接 | | **broker** |
| help 模块按原型改名「聊天」、去「小 fa」介绍行 | 10-13 henry 按稿重排了 `/help`，改名做没做待确认 | **henry** |
| 生产环境仍展示 mock 的区块用 `mockOnly` 包起来（help、user 的 posts / collections / medals / messages / records） | | **henry** |
| SEO 收尾：robots、sitemap、canonical | 各路由 head 10-13 已在 pre 补齐；剩下的等运维给正式域名 | **henry** |
| 播放器 flv / 清晰度切换 | | **henry** |
| 验证码倒计时用后端 `seconds` | | **henry** |
| 设计走查：搜索页、录播播放页、H5 底部导航 | | 设计 / **aven** 改 |
| L27 SSR 限流：出口 IP 免限流 | 等运维给 IP → live 后端配 | 运维 / live 后端 |
| 英文文案运营审校 | 产品说上线后再做 | 运营 |
| 五服务模型收敛（golang / dz 占位、`chat` 别名） | 等后端说明 web 是否用 golang / dz | aven |

## 四、一句话现状

aven 负责的 27 项里 23 项 ✅（今天升 7 项：#3 #8 #42 #38 #50 #39 #41）；#9 / #30 代码已完，只等 pre 灌视频，#4 等后端修预约数据，#27 等 henry 的他人主页。henry 今天在 pre 完成二轮按稿对齐和 SEO head，#32 拉流实测通过升 ✅。aven 侧没有不等外部就能继续推进的功能，下一步是合 `origin/pre` 后推送；最大的两个外部阻塞仍是 **hichat 登录打通**（卡住 4 个负责人、约 1/3 的功能）和 **预约接口数据**。

---

这份日报是按模板更新到今天的版本。我只读了文件，没有改动仓库。这次会话里写文件的工具用不了，所以没写计划文件，也没建云文档，直接把 Markdown 放在上面。

和模板相比改了这几处：

- **pre 版本**：`origin/pre` 已从 `70b0de8` 前进到 `2a074a7`。henry 今天的 14 个提交在 pre 上，本地没有：本地代码里搜不到他新加的 `ImBubble`。
- **#53 SEO**：henry 的 a3a70f4 已在 pre 补上 `/news` `/help` `/tasks` `/user` 的 head，所以第一节和第三节去掉了这几项，只剩 robots、sitemap、canonical。
- **今天升 ✅ 的 8 项**：根据功能总表 10-13 的更新记录和提交 56d2cd3。功能总表底部的「汇总」还停在 10-12，数字对不上，我没有用它。
- **待确认的地方**：
  - help 改名「聊天」：本地还是「帮助中心」，henry 的提交说明也没提到改名，所以留作待办，写了待确认。
  - `dev` 分支：谁建的、和 pre 什么关系，都写了待确认。
- **#52 充值按钮**：显示规则还没写进待对接文档，日报里注明了这一点。
