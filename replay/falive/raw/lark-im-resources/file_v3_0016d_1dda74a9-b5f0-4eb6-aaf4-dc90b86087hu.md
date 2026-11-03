# Falive Web 一期 · 部署与运维对接

> 致：运维 · 发起：aven（前端）· 2026-10-11
> 前端是 TanStack Start 的 SSR 应用：构建产物是一个 Node 服务（Nitro `node-server`）加静态资源。下面是上线需要运维配合的全部事项，**P0 不做就上不了线**。

## 一、部署形态

| 项 | 说明 |
|---|---|
| 构建命令 | `pnpm install --frozen-lockfile && pnpm build:pre`（uat / online 换成 `build:uat` / `build:online`）。**不要用裸 `pnpm build`**：它默认指向 pre，站点平台也不对 |
| 产物 | `.output/`：`.output/server/index.mjs`（Node 服务）+ `.output/public/`（静态资源） |
| 启动 | `node .output/server/index.mjs`，端口由 `PORT` 环境变量指定（默认 3000），Node ≥ 20 |
| 进程管理 | PM2 或容器均可；无状态，可多实例 |
| CI | `.gitlab-ci.yml` 已有：在 pre / uat / online 分支跑质量闸（typecheck、lint、格式、测试；uat / online 另跑 MSW 审计），通过后构建。需要 runner 有 Node 20 和 pnpm |

## 二、P0：nginx 反向代理（必须）

浏览器端的所有接口请求都发到**同源**路径，由 nginx 按前缀转发到各后端。没有这层，客户端请求全部 404。

> 10-12 更正：和 x9（klive / nlive）一样，`/api/`、`/bbs/`、`/discuz`、`/wss`、`/upload` 都转发到**同一个 php 后端**；独立 host 只有 bbsv2 和 hichat。另补了 `/upload` 一行。见 [x9 对齐更正](./x9-对齐更正-2026-10-12.md)。

| 同源前缀 | 转发到 | 备注 |
|---|---|---|
| `/api/` | php（live） | pre `https://streampre.fdsser.com` · uat `http://streamuat.fdsser.com` · online `https://stream.kladhf.com` |
| `/bbs/` | php（live） | 注意是 `/bbs/`，不能写成 `/bbs`，否则会把 `/bbsv2` 吞掉 |
| `/discuz` | php（live） | |
| `/upload` | php（live） | 礼物动画用 `fetch` 下载，`/upload/` 下的资源会被改写成同源路径，不转发就 404（x9 同样要求） |
| `/wss` | falive 聊天 WebSocket | pre `wss://falivepre.fdsser.com`（10-11 后端已给并实测；php host 行为相同，但以 falivepre 为准）；uat / online 待给（O4）。需要 `Upgrade` / `Connection` 头透传 |
| `/bbsv2` | 社区 bbsv2 | pre `https://streampreadmin.fdsser.com`；uat / online 等社区后端给域名 |
| `/hc-api` | hichat | pre `https://pre-hailiao.hai-liao-pre.com` · uat `https://uat-hailiao.hai-liao-uat.com` · online `https://www.4ees1.xyz`（10-12 后端域名表）。**转发时去掉 `/hc-api` 前缀**：上游接口是 `/api/*`，即 `/hc-api/api/x` → `<hichat>/api/x` |
| `/go-api` | golang | 等后端确认 web 是否需要（私聊已确认在 php，不走这里） |
| 其他所有路径 | Node SSR 服务 | 包括页面路由和 `/assets/*` 静态资源（也可以由 nginx 直接托管 `.output/public`） |

## 三、P0：SSR 回源需要的配置

SSR 服务在服务器上直接请求后端，不经过 nginx 代理，需要两样东西：

| # | 事项 | 说明 |
|---|---|---|
| O1 | **`X-Site-Platform` 请求头** | nginx 转发到 SSR 服务时注入 `X-Site-Platform: hc`（首选）；或者给 SSR 进程设环境变量 `SITE_PLATFORM=hc`。构建时已默认写入 `hc`，两者都不配也能工作，但请确认 online 正式值是不是 `hc` |
| O2 | **SSR 服务器出口 IP 加白** | php 后端有 IP 白名单。pre / uat 已加，**online 的 SSR 服务器出口 IP 需要加白** |
| O2b | **SSR 出口 IP 的限流要放宽** | 10-11 用生产构建实测：约 2 秒内连续 11 个页面请求，php 就对 SSR 回源返回 HTTP 429（code -666「操作太快」）。线上所有用户的 SSR 请求都从同一个出口 IP 发出，按现在的阈值，稍有流量首屏就会拿不到数据。请和 live 后端一起给 SSR 出口 IP 单独的限流规则（对接-01 L27） |
| O3 | 运行时环境变量（可选） | 构建时已把各环境上游地址写进服务端包，不配也能回源。需要临时切上游时可设 `API_ORIGINS`（JSON，如 `{"php":"https://stream.kladhf.com"}`）。完整说明见 [`dev-scripts.md` 的「生产部署运行时环境变量」](../migration/dev-scripts.md) |

## 四、P1：还需要运维确认或提供的

| # | 事项 | 原因 |
|---|---|---|
| O4 | **聊天 WebSocket 的域名**：pre ✅ `falivepre.fdsser.com`（10-11 已给并实测可连）；**uat / online 请提供** | 前端连同源 `/wss/?userToken=…`，由 nginx 转发到该域名（见上表 `/wss` 行） |
| O5 | ~~响应头暴露 `b2b-Visitor`、`b2b-Visitor-Token`~~ **不需要** | 浏览器全走同源代理，不涉及 CORS（10-12 按 x9 更正，见 [x9 对齐更正](./x9-对齐更正-2026-10-12.md)） |
| O6 | uat 的 php 改成 https | 现在 uat 是 `http://streamuat.fdsser.com`，SSR 回源是明文 |
| O7 | 正式的 `channel_code` | 现在 pre / uat 都用 `hc`，online 是否一致 |
| O8 | 各环境的**前端访问域名** | 用于 SEO 的 canonical、sitemap、og:url，以及后端的跨域白名单 |
| O9 | 一个 `hc` 平台的测试账号（和 QA 一起） | 登录态功能联调 |

## 五、分支与发布

- 发布分支：`pre`、`uat`、`online`。前端最新代码在 `feature/phase-3-api`，由 aven 按 pre → uat → online 往上合。
- `origin/main`、`origin/test` 已长期不更新，请确认是否还有流水线依赖它们；不用的话冻结。
- 已合并的 `feature/*`、`merge/*` 远端分支可以清理（CI 里的 cleanup 任务目前是只预览不删除）。
