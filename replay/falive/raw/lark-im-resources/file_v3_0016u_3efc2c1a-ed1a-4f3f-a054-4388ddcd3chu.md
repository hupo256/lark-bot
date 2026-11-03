# 对接：uat / online 上线前要补的地址与配置（2026-10-29）

> 发起：aven · 起因：10-29 早 .Ache.l 在群里反馈「UAT 上 SSR 请求显示 PRE 数据」，并定了服务端内网请求统一直连 `http://php-swoole.internal`；Aven.tong 要求进入发 uat / online 阶段，把还要的支持列一份。
> 运维配置类条目（第二、四节）先给 aven 过目再转发。

## 前端现状（一句话）

- pre / uat / online：服务端渲染（SSR）回源的 php、社区 bbsv2 统一直连内网 `http://php-swoole.internal`（按 .Ache.l「都统一地址使用」），路径不改写（`/api/*`、`/bbsv2/*` 原样）；golang、hichat 还按原来的域名走。浏览器里的请求不变，仍走同源 `/api`、`/bbsv2`、`/go-api`、`/hc-api` 转发。
- uat / online 的社区 bbsv2 按「和 php 同一个 swoole」配置（同上内网地址），浏览器侧走同源 `/bbsv2/`。
- 部署机运行时可以用环境变量 `API_ORIGINS`（JSON，按服务覆盖）临时改 SSR 上游，不用重新打包，例如 `{"php":"https://stream.kladhf.com"}`。
- 每个页面源码里有 `<meta name="falive-build" content="环境 提交号">`（如 `uat 7b86a6c…`），可以直接确认部署机跑的是哪个环境的包。

## 一、@.Ache.l（live php 后端）

1. **pre 用内网地址试的结果**：前端合入 pre 并部署后，麻烦看一下 SSR 请求是不是都打到了 `php-swoole.internal`，有没有失败。可以用 `/api/preload/logPreloadHeaderFail` 的记录，或者 swoole 的访问日志。
2. **golang（portal）、hichat 的服务端内网地址**：你说过之后会提供，给了之后前端就把 SSR 一起切过去。

## 二、运维（经 .Ache.l 对接）

1. **UAT 的 SSR 显示 PRE 数据，请核对部署**：前端代码里 uat 的上游没有指向 pre。最可能是 UAT 机打包时执行的是 `pnpm build:pre`（部署邮件模板是 PRE 的，打包命令写的 `build:pre`）。请核对：
   - UAT 机的打包命令是 `pnpm build:uat`、online 是 `pnpm build:online`，不是 `build:pre`；打完后看页面源码 `<meta name="falive-build">` 应是 `uat …` / `online …`；
   - pm2 / 启动脚本里有没有配 `API_ORIGINS` 或 `BASE_API_HOST`，指到了 pre 的域名（运行时变量的优先级高于包里的默认值）。
   - 如果这两点都没问题，再看 `streamuat.fdsser.com` 本身连的是不是 pre 的库。
2. **pre / uat / online 部署机都要能解析 `php-swoole.internal`**：前端各环境包的 SSR 默认就打这个地址，解析不到的话首屏会不带数据（页面不会 500，浏览器拿到页面后会再取一次数据）；临时可在 pm2 配 `API_ORIGINS` 覆盖回公网域名。

## 三、后端（Go：@Arthur.a / @HQUCEncone；社区 bbsv2）

1. **uat / online 的 golang（portal）域名**：目前前端只配了 pre（`falivego.fdsser.com`），uat / online 没有，登录注册、积分任务这些 Go 接口在 uat / online 上会直接不可用。
2. **uat / online 的 bbsv2（社区）**：前端已按「和 php 同一个 swoole、路径 `/bbsv2/`」配置（.Ache.l 10-29 的内网口径 php / bbsv2 同址）。请确认 uat / online 的 bbsv2 已部署在 php 那边；如果是单独的域名，告诉我们。

## 四、运维：uat / online 前台 nginx 转发核对

前端浏览器侧所有请求都走同源路径，需要 uat / online 的前台 nginx 按前缀转发（pre 已配好，可以照着 pre 配）：

| 前缀 | 转到 | 备注 |
|---|---|---|
| `/api/` | php swoole | 路径不改写 |
| `/bbsv2/` | php swoole（和 `/api/` 同端口） | 路径不改写 |
| `/upload/` | php | 礼物动画、封面等相对路径 |
| `/wss/` | 直播聊天 WebSocket | uat / online 的 WS 域名还没给，前端目前只配了 pre（`falivepre.fdsser.com`） |
| `/go-api/` | Go portal | 等第三节第 1 项的域名 |
| `/hc-api/`、`/hc-ws` | hichat（`/hc-api` 前缀剥掉后转 `/api/*`；`/hc-ws` 转 `/ws/im/echo`） | uat：`uat-hailiao.hai-liao-uat.com`；online：`www.4ees1.xyz` |

请确认 uat / online 这几条都已配置，并给出 uat / online 的直播 WebSocket 域名。

## 五、后端：Google 登录

- **uat / online 的 Google OAuth client_id，以及 Google Console 授权来源**：目前只配了 pre 的 client_id，授权来源只加了 pre 主域名和 localhost。uat / online 没配的话，Google 登录按钮不会显示。请给出 uat / online 用的 client_id（可以和 pre 共用），并把 uat / online 的前台域名加进 Authorized JavaScript origins。
