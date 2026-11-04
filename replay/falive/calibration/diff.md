# 校准差异汇总（54 条 case，待办不计分 6 条）

计分的 48 条：完全对得上 16（33%）

| 差异 | 条数 |
|---|---|
| 分类不同 | 6 |
| 模拟没分类 | 3 |
| falive 当时没分类 | 1 |
| 终态不同 | 24 |
| 模拟没说话 | 2 |
| 模拟多说话 | 16 |
| 上下文差 >20% | 26 |

## 有差异的 case

| 组 | case | 原话 | 分类 falive→模拟 | 终态 | 群里句数 | 上下文差 | 差异 |
|---|---|---|---|---|---|---|---|
| ep-1023-98f8fa | C1 | 我记得 2 已经有定论了，帮忙解答一下 @Aven.Bot | question→question | —→done | 0→2 | 40/55 | 终态不同、模拟多说话、上下文差 40 行 |
| ep-1024-9ebe13 | C1 | @Aven.Bot Bug-4942 再复测下 ！ | api_reply→bug | —→blocked | 0→2 | 40/44 | 分类不同、终态不同、模拟多说话、上下文差 40 行 |
| ep-1024-9ebe13 | C3 | 存「I'm QA.」读回来还是「I'm QA.」 有什么问题 ？ @Aven.Bot | api_reply→api_reply | —→waiting_confirmation | 0→1 | 0/1 | 终态不同、模拟多说话 |
| ep-1024-9ebe13 | C4 | @Aven.Bot 测试 帖子多语言翻译 以及 AI识图 功能 ！ | api_reply→api_reply | —→waiting_confirmation | 0→1 | 0/1 | 终态不同、模拟多说话 |
| ep-1024-9ebe13 | C5 | @Aven.Bot 所以不是Bug ? | question→question | —→done | 0→2 | 40/51 | 终态不同、模拟多说话、上下文差 40 行 |
| ep-1024-9ebe13 | C6 | <p>测试的tid 发出来 @Aven.Bot</p> | —→question | —→superseded | 0→2 | 40/47 | falive 当时没分类、终态不同、模拟多说话、上下文差 40 行 |
| ep-1024-9ebe13 | C7 | @Aven.Bot | question→requirement | —→done | 0→2 | 40/45 | 分类不同、终态不同、模拟多说话、上下文差 40 行 |
| ep-1024-9ebe13 | C8 | @Aven.Bot 创建最新的帖子 进行测试 | requirement→api_reply | —→no_change_needed | 0→2 | 40/54 | 分类不同、终态不同、模拟多说话、上下文差 40 行 |
| ep-1024-b22368 | C1 | https://qfglxo2m3dc.sg.larksuite.com/record/H6oZrTxWMeZZGbcj | bug→bug | —→ignored | 0→1 | 40/43 | 终态不同、模拟多说话、上下文差 40 行 |
| ep-1026-350ff1 | C1 | ![Image](img_v3_0216r_c9207012-b1fe-4410-b6c0-697b18d3c5ix)  | bug→bug | —→no_change_needed | 0→2 | 40/64 | 终态不同、模拟多说话、上下文差 40 行 |
| ep-1026-350ff1 | C2 | https://falivepre.fdsser.com/bbsv2/member/threadsCursor?type | api_reply→api_reply | —→no_change_needed | 0→2 | 40/66 | 终态不同、模拟多说话、上下文差 40 行 |
| ep-1026-350ff1 | C3 | @Aven.Bot 测试一下pre环境真实验证码接入 | api_reply→api_reply | —→no_change_needed | 0→2 | 40/62 | 终态不同、模拟多说话、上下文差 40 行 |
| ep-1026-4f9abc | C1（待办） | 已部署 | requirement→— | —→— | 0→0 | 0/1 | 模拟没分类 |
| ep-1026-9769e5 | C1 | https://falivepre.fdsser.com/hc-api/api/fameEx/market/symbol | ignore→ignore | —→no_change_needed | 0→2 | 40/43 | 终态不同、模拟多说话、上下文差 40 行 |
| ep-1026-9769e5 | C2 | @Aven.Bot | api_reply→question | —→done | 0→2 | 40/44 | 分类不同、终态不同、模拟多说话、上下文差 40 行 |
| ep-1027-63a6f3 | C1（待办） | 已发布 | ignore→— | —→— | 0→0 | 0/1 | 模拟没分类 |
| ep-1027-63a6f3 | C2（待办） | 已部署 | requirement→— | —→— | 0→0 | 0/1 | 模拟没分类 |
| ep-1027-63a6f3 | C3 | @Aven.Bot | api_reply→api_reply | done→done | 2→2 | 22/55 | 上下文差 22 行 |
| ep-1027-63a6f3 | C4 | @Aven.Bot 已關閉沒推流的直播間 | api_reply→api_reply | done→done | 2→2 | 18/40 | 上下文差 18 行 |
| ep-1027-6e06d2 | C1 | 508 主播这条，我已经加过了，现在前端还不对吗？ @Aven.Bot | api_reply→api_reply | —→done | 2→2 | 40/45 | 终态不同、上下文差 40 行 |
| ep-1027-6e06d2 | C2 | \| C1 \| 某账号发帖回 HTTP 500（Bug-4994） \| 10-26 核对：live uid 19650 的 | question→question | —→done | 2→2 | 40/44 | 终态不同、上下文差 40 行 |
| ep-1027-6e06d2 | C3 | https://falivepre.fdsser.com/bbsv2/member/otherInfo?uid=1969 | api_reply→api_reply | —→done | 2→1 | 40/47 | 终态不同、上下文差 40 行 |
| ep-1027-6e06d2 | C4 | \| Q5 \| 帖子「AI 识图」在哪个页面、哪支接口、哪个字段（10-24 起） \| tid 18610 详情里只有图片 | —→— | —→ignored | 2→1 | 0/1 | 终态不同 |
| ep-1027-c4346b | C1 | @Aven.Bot 请根据 @Mateo 给的信息，同步更新 web 端的相应逻辑 | requirement→requirement | —→done | 0→2 | 40/50 | 终态不同、模拟多说话、上下文差 40 行 |
| ep-1027-d756ea | C1 | <p>@Aven.Bot 请给我提供一下bug-4970的curl信息</p> | question→question | —→done | 0→2 | 32/32 | 终态不同、模拟多说话、上下文差 32 行 |
| ep-1027-d756ea | C2 | <p>@Aven.Bot 文档在哪里</p> | question→— | —→— | 0→0 | 0/1 | 模拟没分类 |
| ep-1028-03cd66 | C1（待办） | 已部署 | requirement→— | done→— | 0→0 | 9/9 | 模拟没分类、终态不同、上下文差 9 行 |
| ep-1028-03cd66 | C2（待办） | 已部署 | requirement→— | done→— | 0→0 | 10/10 | 模拟没分类、终态不同、上下文差 10 行 |
| ep-1030-167d28 | C2 | 这有更多点的信息，请整体看看 @Aven.Bot | bug→— | blocked→— | 2→0 | 40/45 | 模拟没分类、终态不同、模拟没说话、上下文差 40 行 |
| ep-1030-167d28 | C5 | bug 列表还需要 web 端修的 bug ，确认一下，请马上修掉 @Aven.Bot | bug→— | no_change_needed→— | 2→0 | 40/47 | 模拟没分类、终态不同、模拟没说话、上下文差 40 行 |
| ep-1030-337e3d | C1 | @Aven.Bot OL 个人主页 帮忙看下api 返回资料 https://www.falive.com/bbsv2/ | question→bug | blocked→blocked | 2→2 | 4/33 | 分类不同 |
| ep-1030-337e3d | C3 | 个人资料必须要登陆才行，请aven 给你一个账户 @Aven.Bot 帮忙看下 api 返回资料」 | api_reply→api_reply | blocked→blocked | 1→1 | 25/41 | 上下文差 25 行 |
| ep-1030-b864a1 | C1 | @Aven.Bot 能不能将全部功能先打包到 uat OL 这样后端可以明显的排查缺哪些配置？ | requirement→requirement | no_change_needed→blocked | 2→1 | 4/55 | 终态不同 |
| ep-1030-b864a1 | C2 | ### U2 前台 nginx 没转发 `/hc-ws`（行情推送） - **现象**：WebSocket 握手 `ws | api_reply→api_reply | done→done | 2→2 | 16/62 | 上下文差 16 行 |
| ep-1030-b864a1 | C4 | @Aven.Bot 再测试一下 | api_reply→api_reply | done→done | 2→2 | 32/73 | 上下文差 32 行 |
| ep-1030-b864a1 | C5 | check 一下这个问题，根据现有信息，同步相关逻辑，做好回群汇报 @Aven.Bot | bug→api_reply | failed→blocked | 1→2 | 35/69 | 分类不同、终态不同、上下文差 35 行 |
| ep-1030-b864a1 | C6 | @Aven.Bot OL 再复测下 | api_reply→api_reply | done→done | 2→2 | 60/66 | 上下文差 60 行 |
