# Falive Web 一期 · 需社区（bbsv2）后端支持的事项

> 致：社区 bbsv2 后端 · 发起：aven（前端，社区广场负责人）· 2026-10-11
> 契约依据：`PM-2954-App对接文档`。pre（`streampreadmin.fdsser.com`）已打通：`thread/listCursor`、`index/recommend`、心跳、`sec` 解密都正常，信息流和无限滚动已上线。

## P0：上线必须

| # | 要什么 | 现在的情况 |
|---|---|---|
| B1 | **uat 和 online 的 bbsv2 域名** | 上次答复「还未部署」。没有域名，广场在 uat / online 只能显示「加载失败」（前端已改成不再显示假帖子） |
| B2 | 部署后确认 `/api` 和 `/bbsv2` 在 uat / online 也是同级路径、host 是否和 pre 一样独立于 php | pre 是独立 admin host |

## P1：设计稿里有、现在没有数据源的区块

| # | 区块（Figma 节点） | 前端现状 | 需要 |
|---|---|---|---|
| B3 | 「关注」信息流（主 Tab `285:209933`） | Tab 不显示 | 需登录的「我关注的人的帖子」游标接口，返回结构同 `thread/listCursor` |
| B4 | 「推荐」信息流分页 | `index/recommend.recommend_threads` 不分页，所以「推荐」「最新」现在内容一样，只显示了「最新」 | 推荐流的游标版本（如 `thread/recommendCursor`） |
| B5 | 「热门」Tab 与右栏「热门话题」（`335:223808`） | 两处都不显示 | ①「热门」直接用 `thread/hot` 吗，要不要分页？②「热门话题」是帖子还是标签（`forum/hotTags`）？每行要标题、作者、评论数 |
| B6 | 分类 chip 行（`285:210011`，14 个分类） | 组件已做好，没有数据，不显示 | 分类字典接口（id、名称、排序、多语言）；列表的筛选参数用 `tag_id` 还是版块 `thread_types` |
| B7 | 收藏 | 只显示图标 | 收藏接口路径 |
| B8 | 帖子分享 | 只显示图标 | 列表项的 `url` 能不能直接对外分享？不能的话前端要做帖子详情页 |

## P2：需要登录才能用（依赖 live / hichat 登录打通）

发帖 `thread/create`、点赞 `thread/recommend`、关注 `member/follow` 的接口已经有了，前端现在的处理是：未登录时弹登录框，已登录时提示「敬请期待」。等登录打通后接上。请确认：

| # | 问题 |
|---|---|
| B9 | bbsv2 用哪个 token：live 的 `data.token`，还是 hichat JWT，还是 bbsv2 自己的？ |
| B10 | 用户资料（`member/info` 等）一期是否要从旧 discuz 迁到 bbsv2？ |
