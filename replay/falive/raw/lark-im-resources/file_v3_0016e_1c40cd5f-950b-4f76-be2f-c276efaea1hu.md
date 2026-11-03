# hichat / golang 后端 · 待答复（第二轮，2026-10-12）

> 致：arthur / william / encone / justin · 抄送 eric、broker、adrian · 发起：aven（前端）
> 域名表 10-12 已给并配好（`build/service-hosts.ts`），第一轮全文见归档 [对接-02](../../archive/2026-10-12-delivery-round-1/对接-02-hichat-golang后端-1.md)。本文只列还开着的。

## P0：登录打通（web 用 live 登录，怎么拿到 hichat 身份）

| # | 问题 | 要的答案形态 |
|---|---|---|
| **H1** | live 用户 id 和 hichat member id 怎么对应？ | 同一个 id / 映射表 / 首次访问自动建号 |
| **H2** | 登录后 web 怎么拿到 hichat JWT？ | 接口路径 + 入参（是否用 live token 换）+ 返回示例 |
| **H3** | JWT 过期、续期、失效错误码 | 可后补 |
| **H4** | 退出登录要不要调 hichat 接口 | 可后补 |
| **H-obs** | pre 上 `NewMailLogin` 响应日志里 `app\job\live\JHiChatAccountSync::fire` 有 error 并「任务重新入队」 | 这是不是登录时给 hichat 同步建号（H1）？失败原因？同步成功后 web 怎么拿 JWT（H2）？ |

> 只要 H1、H2 有答复，任务中心（adrian）、跑马灯 / fameex（eric）、跟单（broker）就能切真实接口。

## P1：各功能接口确认（负责人各自跟进，这里汇总）

| # | 功能 | 负责人 | 要确认 |
|---|---|---|---|
| H5 | 任务中心 `points/task/*` | adrian | 任务完成上报 `complete` / `report`；补签按周还是按月；fameex 联动任务判定；「看直播 10 分钟领积分」的接口与规则（产品 P10 要保留） |
| H6 | 积分兑换 `mallRights/*` | adrian | 一期是否上线 |
| H7 | 行情跑马灯 | eric | 行情 WS 地址与消息格式；走 hichat 域名还是单独域名 |
| H8 | fameex 入口 `fameEx/oneTimeToken/v2`、`fameEx/redirect/{action}` | eric | 未登录 fameex 时的跳转规则 |
| H9 | 一键跟单 | broker | 跟单群、下单、我的跟单接口清单；**按主播取跟单群 id** 的接口（live 后端 L16 说群 id 不在 live） |
| H10 | 直播存档 | broker | live 后端已给 [B2B-04 录播列表](../../apis/B2B-04-anchor-record-list-对接.md)（按 `hiChatUid`）：请确认 web 直接调 live 的这个接口即可，不走 hichat `b2b/recordVideoList`；`hiChatUid` 怎么从 live uid 拿（见对接-live后端-2 R3） |
