# falive-react 前端接入 · 对接待办清单

> 面向：live/php 后端、hichat 后端、API owner。
> 背景：falive-react（web 前端，TanStack Start + React19）已按 `docs/apis/streampreadmin-live-api.md` 的契约把以下端点接入前端数据层。
> 前端侧已完成、验证通过；下面 3 件事卡在前端之外，需要对应的人确认/提供后才能走通真实数据。
> 通用约定（已对齐）：成功信封 `{"msg":"...","code":0,"data":...}`（实测 `code:0`=成功）；php 端点需 vn-sign 签名（浏览器态）；请求头 `token / pf-version(b2b-version) / x-site-platform / b2b-Visitor / x-accept-language`。

---

## 待办 1：确认首页轮播图的 `banner_type` 值

**端点**：`GET /api/banner/getBannerList?banner_type=<int，必传>`

**现状**：
- 前端已接入（见下「响应字段」），端点**可达、带签名返回 `code:0 成功`**。
- 但前端在 `dev:pre`（streampre.fdsser.com，访客态）实测 `banner_type = 0~10` **全部返回 `code:0` 但 `data` 为空数组**。
- 文档只说「必传、来自后台配置的轮播图分类 ID」，没给首页对应的具体值。

**需要你提供**：
1. **falive 首页轮播图对应的 `banner_type` 真实值**（后台配置的那个分类 ID）。
2. 若该值依赖站点/渠道（`x-site-platform` / `channel_code`），请一并说明 falive（当前 `site_platform=hc`、`channel=hc`）该用哪个。
3. 确认该类型在 `pre` 环境**是否已配置了 banner 数据**（若 pre 没数据，请指出哪个环境有，便于前端联调）。

**前端期望的响应 `data[]` 字段**（已按此建模，`status===1` 过滤、`list_order` 升序）：
`id, type, lang, url, ios_url, android_url, img, fore_img, list_order, status(0取消/1正常), updatetime, addtime, fifa_world_cup_match_time`

**怎么验**：给出值后，前端把 `HOME_BANNER_TYPE` 换成该值，首页轮播图即应渲染真实图。

---

## 待办 2：提供「登录态 + hichat 后端」的联调环境

**受影响端点**（都需**登录态**，且个人主页 `/user/me` 还依赖 hichat 后端）：

| 端点 | 用途 | 归属后端 |
|---|---|---|
| `GET /api/user/attentionList` | 当前登录用户的关注列表 | php(live) |
| `GET /api/member/attention?id=` | 关注/取关切换 | php(live) |
| `GET /api/member/updateInfo?signature=&avatar=&user_nickname=&sex=` | 改资料（只传改动字段） | php(live) |
| `GET /api/user/avatarList` | 预设头像列表 | php(live) |
| `GET /api/avatar/uploadAvatar?avatar=` | 上传自定义头像 | php(live) |
| `GET /member/profile/my` | 个人主页资料（**信封 code:200**，与上面 code:0 不同源） | **hichat** |
| `GET /discuz/v2/api/users/info` | 个签 / 关注统计 | **hichat(discuz)** |

**现状 / 卡点**：
- 前端已接好这些端点（已做成「客户端带签名发起」，环境具备即可拉真实数据）。
- 但 `dev:pre` 环境**只配了 php（streampre.fdsser.com），没有配 hichat/discuz 后端** → `/member/profile/my` 返回 **404** → 个人主页 `/user/me` 整页加载失败 → 挂在它下面的 attentionList / avatarList 等**根本触达不到**，无法验证。
- 且这些端点需要**登录 token**；访客态拿不到真实个人数据。

**需要你提供**：
1. **hichat / discuz 后端在联调环境的域名**（当前 `build/service-hosts.ts` 里 `hichat`/`chat` host 为空）。
2. **一个可用的测试登录账号 / token**（能过 vn-sign 并有关注、头像等数据），或说明前端如何在联调环境登录拿到 token。
3. 确认上述 php 端点所属环境与 hichat 端点所属环境**能在同一前端联调环境共存**（前端按 service 分流到不同 host）。

**怎么验**：拿到 hichat host + 登录 token 后，前端在该环境打开 `/user/me`，逐个确认关注列表/关注切换/改资料/换头像走真实接口（`code:0`/`code:200`）。

---

## 待办 3：主播侧端点 —— 若要做「开播」功能，缺以下契约

**现状**：以下 6 个主播侧端点前端已写好**数据层函数**（`src/modules/live/data/broadcast.ts`，可直接调用），但**观众端 web 没有开播 UI**，本轮不接界面。

`getLiveUrl / createRoom / startRoom / endRoom / localUpload / hi_chat_program/liveList`

**若后续要在 web 做开播流程，文档里还缺这些契约**（请补充）：
1. **`/api/Live/getRoomList`**：`startRoom` 文档注明「直播间 ID 从 getRoomList 返回参数获取」，但 **getRoomList 本身文档里没有**（入参/响应字段缺）。
2. **`/api/LiStre/getRoomInfo`**：WebSocket 订阅房间用的 `vid` 来源，文档未给详情。
3. **WebSocket 各 action 的 payload 字段结构**：现有文档只给了 method×action 清单和握手/心跳/`sub` 流程，**每个 action（send/gift/ban/delmsg/startLive/closeLive…）的消息体字段没有** → 要做直播间弹幕/礼物/实时推送需要补。

**另**：文档页里 `/api/e_sport_game/liveList`（Legacy3 赛事）详情页返回 500、本就标注废弃，前端未接，确认可忽略。

---

## 附：前端已就绪、无需你做的部分（供参考）

- 上述所有端点的前端 schema/mapper/查询/mutation 已按契约写好，mock 仅用于无后端时的本地开发兜底（`pnpm dev`），真实模式（`pnpm dev:pre`）下以真实接口为数据源。
- 完整字段契约见同目录 `streampreadmin-live-api.md`。
- 已实测可用：访客 vn-sign 签名、`/api/secret/getHot`、`/api/banner/getBannerList`（端点通，缺 banner_type 值）。
