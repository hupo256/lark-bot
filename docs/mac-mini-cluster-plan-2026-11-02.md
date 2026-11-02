# 多台 Mac mini 组 bot 执行池：可落地方案（2026-11-02）

> 问题：单台 mini 16G 内存，bot 并行跑测试 / 找 bug / review 时不够用；手上有 3–5 台闲置 mini，能不能组成集群。
> 本文基于 lark-bot 现有架构（fameex 线 `fameex-stable`）给方案，配套上一份 [mac-mini-migration-2026-10-29.md](./mac-mini-migration-2026-10-29.md)（单机迁移与团队化）。
> 结论先行：**不需要「集群」那套东西（k8s / 消息队列 / 共享存储），lark-bot 天生就是「一个 gateway + 若干个来拉任务的 worker」，把多台 mini 做成 worker 池只要改四处代码；但先把一件事做了——量清楚一条任务到底吃多少内存，再决定要几台。**

## 0. 三句话结论

1. **内存瓶颈不在任务数，在单条任务的峰值**：gateway + worker 本身只占 80 MB，吃内存的是每条任务里起的 `claude` 会话（0.5–1.5 GB）加它跑的 `tsc` / `vitest` / dev server（fameex-web 是 7 个 app 的 turbo monorepo，type-check 一个 app 2–4 GB 很正常）。一条「改代码 + 终检」的任务峰值按 4–6 GB 算，16 GB 的 mini 同时跑 2 条重任务、或 4 条只读 / review 类轻任务是安全线。
2. **多台 mini 的正确形态是「1 台控制节点 + N 台执行节点」**：控制节点跑 gateway（Lark 长连接只能有一条）、bug 表轮询、任务库和附件；执行节点只跑 worker + 业务仓 clone + 工具链，通过局域网 / Tailscale 向 gateway 领任务。worker 领任务本来就是拉模式、`claim` 本来就是原子的，多 worker 不用改调度核心。
3. **真正要改的只有四处**：gateway 监听地址可配、worker 心跳改走 HTTP（现在是写本机文件）、附件改由 worker 从 gateway 下载到本机（Claude 不读网络盘）、任务换代重领要「粘」在第一次跑它的节点（分支和 worktree 在那台机器上）。加起来 3–4 天。**而且集群强依赖 D3（bot 分支可 push）**：分支散在 N 台机器上，不 push 没人拿得到产出。

## 1. 先承认的事实

| 事实 | 数据 | 含义 |
|---|---|---|
| bot 自身很轻 | gateway 42 MB、worker 41 MB、`lark-cli event` 11 MB（10-29 实测） | 多开 worker 进程不是问题 |
| 重的是 AI 子进程和它跑的检查 | 本机此刻 7 个空闲 `claude` 进程共 400 MB；一条实施任务里 claude 会话 + 工具调用（样本：33 次 tool_use，Bash 20 次）+ tsc / vitest | 峰值没有实测数据，**先量**（§3 阶段 0） |
| 业务仓重 | fameex-web 16 GB（含 node_modules），7 个 app，`type-check` 是 `turbo run type-check`，`test` 是 `vitest --run` | 每台执行节点都要一份完整 clone + install；磁盘 ≥ 100 GB |
| 现在的量很小 | fameex 10 月 2 条审计；falive 峰值一天 20 条左右、并发 3 | 一台 mini 现阶段绰绰有余；多台是为团队化（5 个前端 + bug 表全量）准备的 |
| 架构已是拉模式 | worker 调 `GET /lark/tasks`（可领列表）→ `POST /lark/tasks/:id/claim`（原子，返回 null 即被别人领走）→ `POST /status` 回写带 epoch；并发上限 `LARK_WORKER_CONCURRENCY` 按 worktree 串行 | 多 worker 同时领不会双跑同一任务 |
| 但有四处默认「同一台机器」 | ① gateway 只绑 `127.0.0.1`（`lib/lark-constants.mjs` `GATEWAY_HOST` 常量）② worker 心跳写 `runtime/lark-worker-state.json`，gateway 读这个文件给 `/lark/health` 和 `lark-bot status` ③ 附件由 gateway 下到 `runtime/lark-attachments/<PR>/<msg>/`，任务 JSON 里是**绝对路径** `localPath`，worker 把它喂给 claude 的 `--image` / Read ④ 任务的 hotfix 分支、临时 worktree、审计都在跑它的那台机器上，`retry` / `resume` / 验退 `reopen` 换代后重领 | 这四处就是全部改动面 |
| Claude Code 不读网络路径 | 官方 CLI 文档：`--allowedTools` 放行也「从网络路径读取除外」 | 附件不能靠 SMB / NFS 挂载解决，必须落到执行节点本地盘 |
| 凭据按机器 | lark-cli 应用身份（app id / secret）+ 用户身份（文档预取 `--as user`、读 bug 表记录）、claude 登录、`gateway-secret`、`FIGMA_API_KEY` | 每台执行节点都要配一遍；订阅制 claude 账号的速率上限是按账号算的，N 台并行会一起撞 |

## 2. 目标拓扑

```text
                 Lark 开放平台（长连接 / 轮询 / webhook）
                           │  只能有一条长连接
                 ┌─────────▼──────────┐
                 │ 控制节点 mini-0     │  gateway:3005（监听 Tailscale / 局域网地址 + 共享密钥）
                 │ · lark-gateway     │  bug 表 poller、chat poller、任务库 runtime/lark-tasks
                 │ · lark-bugtable    │  附件 runtime/lark-attachments（原件）
                 │ · （可选）1 个 worker│  日报 / 体检 / 排空重启 的调度在这里
                 └───┬──────┬──────┬──┘
     领任务 / 回写 / 心跳 / 下附件（HTTP + x-lark-gateway-secret，Tailscale 内网）
         ┌───────────▼┐ ┌───▼────────┐ ┌─▼──────────┐
         │ 执行节点 mini-1│ │ 执行节点 mini-2│ │ 执行节点 mini-N│
         │ · lark-worker │ │ · lark-worker │ │ · lark-worker │   每台：业务仓 clone + pnpm store + 工具链 + claude 登录
         │ · 并发 2 重/4 轻│ │ · 并发 2 重/4 轻│ │ · 并发 2 重/4 轻│   任务分支在本机，做完按 D3 push 到 GitLab 的 lark/* 命名空间
         └──────────────┘ └──────────────┘ └──────────────┘
```

- **节点不分工种**：每台执行节点都能跑任何任务；「重 / 轻」只是每台自己的并发配额（§4 调度）。先不做「测试专用机 / review 专用机」这种划分——任务量撑不起，划分了反而让某类任务排队。
- **控制节点要不要也跑 worker**：要。它是唯一有完整运行态的机器，日报、体检、自修工单这些 bot 自身的任务（repo profile `lark-bot`、`source=daily-*`）钉在它上面跑，业务任务也可以领，但并发给低（1 重）。
- **网络**：Tailscale（每台装一个，mini 之间直连；笔记本在外也能 `lark-bot status`）。局域网固定 IP 也行，但出门就管不了。gateway 只认带密钥的请求，密钥文件 `~/.config/fameex-lark/gateway-secret` 同一份拷到每台。
- **代码分发**：每台节点 `~/github/lark-bot` 都是 git clone，升级 = 控制节点合进 `fameex-stable` 并 push，各节点 `git pull`（脚本 `scripts/cluster.sh pull`，ssh 逐台），已有的排空重启会在磁盘代码变了之后自己跑单测、自己 restart，不用人逐台 restart。

## 3. 分阶段落地

### 阶段 0 · 先量（现在就能做，不等 mini，1 天）

没有数据就定台数是拍脑袋。在现有 worker 里加一项审计：AI 子进程跑完后，记录这棵进程树（claude + 它起的 tsc / vitest / node）的 **峰值 RSS**（`ps -o rss= -g <pgid>` 每 10 秒采一次取最大，task-runner 已经是 `detached: true` 进程组，顺手就能采）和 wall time，写进审计 JSON 的 `resources` 字段。跑两周后用 `lark-metrics` 出三个数：只读 / 代答类任务 p90 峰值、改代码类 p90 峰值、终检（tsc + vitest）单独的峰值。**这三个数决定每台的并发配额和要几台。** 我现在的估计（claude 1–1.5 GB + tsc 2–4 GB）如果实测是对的，16 GB 跑 2 重 + 2 轻；如果 tsc 只要 1 GB，一台就能跑 4 重。

### 阶段 1 · 单机 mini（照迁移文档做，不变）

控制节点就是 [mac-mini-migration-2026-10-29.md](./mac-mini-migration-2026-10-29.md) 里的那台。先把它跑稳：阶段 1 原样搬 → 阶段 2 服务器化。这期间不加执行节点。

### 阶段 2 · 加第一台执行节点（2 节点，3–4 天代码 + 1 天真机）

代码改动（都在 fameex 线，带测试）：

| # | 改动 | 落点 | 大小 |
|---|---|---|---|
| C1 | gateway 监听地址可配：`LARK_GATEWAY_HOST`（默认仍 `127.0.0.1`，不配就和现在一样）；plist / wrapper 注入 Tailscale 地址 | `lib/lark-constants.mjs`、`lark-gateway.mjs`、`runtime/launchd-node.sh` | 小 |
| C2 | worker 身份与心跳走 HTTP：worker 启动时 `nodeId = hostname`，心跳 `POST /lark/workers/:nodeId/heartbeat`（内容同现在的 state 文件：pid / codeHash / readiness / inFlight / draining / 并发配额 / 剩余内存）；gateway 内存里存 `workers` 表，`/lark/health` 的 `worker` 字段改成 `workers[]`，心跳超 2 分钟算掉线；`lark-bot status` 列每个节点一行；doctor 的「心跳新鲜 / 排空中」按节点判。本机文件心跳保留给单机模式（没配 `LARK_GATEWAY_HOST` 时） | `lark-worker.mjs`、`lib/lark-routes.mjs`、`lib/lark-doctor.mjs`、`scripts/lark-bot` | 中 |
| C3 | 附件按需下载：gateway 新增 `GET /lark/tasks/:id/attachments/:n`（带密钥，流式回文件）；worker 领到任务后，凡 `localPath` 在本机不存在的，下载到本机同一路径（`runtime/lark-attachments/<PR>/<msg>/<文件名>`，用户名 / 仓库路径各节点一致时路径天然一样；不一致就改写 `localPath` 再喂给 claude）。7 天保留期清扫在每台各自跑 | `lib/lark-routes.mjs`、`lib/lark-gateway-client.mjs`、`lib/lark-task-runner.mjs` | 中 |
| C4 | 节点亲和：任务第一次被领走时记 `task.nodeId`；`claim` 带 `nodeId` 参数，任务已有 `nodeId` 且不同于请求方 → 拒绝（返回 null，和「被别人领走」同一分支），除非那个节点心跳已掉线超过租约（这时分支丢了，按新任务重跑，结果卡注明「原节点离线，从基线重做」）。`retry` / `resume` / `reopen` 不改，天然跟着 `task.nodeId` 走 | `lib/lark-task-store.mjs`、`lib/lark-routes.mjs`、`lark-worker.mjs` | 中 |
| C5 | 按内存领任务：worker 每轮领任务前看 `os.freemem()` 和本机在飞任务的「重 / 轻」数；配置 `LARK_WORKER_HEAVY=2 LARK_WORKER_LIGHT=4 LARK_WORKER_MIN_FREE_MB=3072`；重 / 轻由任务判定（只读 `status` / 代答 / review = 轻，其余 = 重），不够就这轮不领。不改 gateway | `lark-worker.mjs` | 小 |
| C6 | 运维脚本 `scripts/cluster.sh`：`nodes` 文件列主机；`pull`（逐台 `git pull --ff-only`）、`status`（逐台 `lark-bot status` 或直接读 gateway 的 `workers[]`）、`doctor`、`logs <node>` | `scripts/` | 小 |

真机验收：两台同时在线时，控制节点 `lark-bot status` 两行 worker；同时投 4 条任务（2 重 2 轻）看落点；一条任务挂起后 `resume`，确认回到原节点并在原分支续；把执行节点断网 3 分钟，确认它在飞的任务被当孤儿回收、重领时落到另一台并标注「从基线重做」；附件任务在执行节点上能 Read 到图。

### 阶段 3 · 扩到 3–5 台（只加配置，半天 / 台）

每台：装系统 + 工具链（照迁移手册 §8.1）、clone 业务仓 + install、拷凭据、lark-cli / claude 登录、plist 里填 `LARK_GATEWAY_URL=http://<控制节点 tailscale 地址>:3005`、`lark-bot start`。写一个 `scripts/node-bootstrap.sh` 把这些固化，第 3 台起就是跑脚本。**先加到 3 台（1 控制 + 2 执行）停下来看两周**，闲置的继续闲置——多一台就多一台要保持 Node / pnpm / claude 版本一致的机器，doctor 要加「各节点版本一致」一项。

## 4. 调度口径（写清楚，免得以后争）

- 同一任务永远在一台机器上跑完它的所有代次（C4 亲和）；换代重领只有在原节点掉线时才会换机器。
- 同一业务仓的不同任务可以在不同机器并行：每台有自己的 clone，分支名 `hotfix/<PR>-<id>` 带任务 id 不会撞；合并冲突留给 MR 阶段。
- 「命中人类已有 worktree」（`~/github/PR-xxxx`）这条路径在服务器上不存在，所有任务都走 bot 自己的临时 worktree（迁移文档 C1 已说过）。
- 重 / 轻配额按节点算，不做全局排队优先级；队列里任务按 `createdAt` 先来先领，哪台有空哪台领。要「紧急任务插队」再说。
- bot 自身任务（日报 / 体检 / 自修）只在控制节点跑：这些读写的运行态都在它本机。

## 5. 不做什么，为什么

- **不做共享存储**（SMB / NFS 挂 `runtime/`）：Claude Code 拒读网络路径；网络盘一抖 worker 全体卡死；任务库是单进程 JSON 文件原子写，不是给多机共享设计的。
- **不做多 gateway / 主备**：Lark 应用长连接只能一条，gateway 挂了就是挂了——它 42 MB、无状态的部分很少，launchd `KeepAlive` 拉起比主备切换简单得多。控制节点要做的是备份 `runtime/`（迁移文档阶段 2 的 rsync）。
- **不上 k8s / Docker / 消息队列**：macOS 上跑 Linux 容器要虚拟机，claude / lark-cli 的钥匙串登录在容器里也不好做；任务量三位数以内，HTTP 拉模式足够。
- **不按工种分机器**：见 §2。

## 6. 和「换一台大内存机器」比

| | 3–5 台 16G mini 池 | 1 台 48 / 64 GB（mini M4 Pro / Studio） |
|---|---|---|
| 成本 | 机器已有，电费和运维时间 | 新买 |
| 代码改动 | C1–C6，3–4 天 | 0（照单机方案） |
| 单任务上限 | 还是 16 GB，tsc 超过 8 GB 的任务哪台都跑不了 | 单任务可以很大 |
| 故障域 | 一台跑飞只影响它自己的 2 条任务 | 一台跑飞全停 |
| 运维 | N 份工具链 / 凭据 / 版本要一致 | 1 份 |
| 适合 | 任务多、每条不大（现在 fameex 的 bug 修复、review、代答都是这类） | 任务少、单条大（整仓 build、全量测试） |

**我的建议**：走 mini 池，但只到 3 台。原因是闲置机器是沉没成本、故障域小、而且 C1–C6 这些改动（节点身份、心跳、附件分发、亲和）就算以后换大机器也用得上（大机器上跑 2 个 worker 进程隔离故障域也是同一套代码）。如果阶段 0 量出来 type-check 峰值 > 8 GB，那是业务仓的问题（拆 tsconfig project references、按 app 跑），不是加机器能解决的。

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| claude 订阅账号速率上限按账号算，N 台并行一起撞 429 | 执行节点用 `proxy` 鉴权（`claude.env` 的网关 key）或团队 / API 账号（迁移文档 D4）；worker 已有瞬时错误重试 |
| lark-cli 用户身份（文档预取、读 bug 表记录）要在 N 台登录 | 统一用应用身份能读的就用应用身份（bug 表记录已是）；文档预取仍要用户 token——团队化后换成团队账号（D2），每台登录一次 |
| 各节点 Node / pnpm / claude / lark-cli 版本漂移 | 心跳带版本，gateway 健康检查「版本不一致」warn；`cluster.sh doctor` 逐台核对 |
| 执行节点掉线时在飞任务 | 现有租约 + 孤儿回收已处理；C4 让重领的任务标注「从基线重做」 |
| 分支产出在不同机器上 | **D3 必须放开**：做完 push `lark/*` + 开 MR；否则只能 ssh 到对应节点 fetch |
| 每台 16 GB 的 mini 跑 dev server（页面验证工具）再加 claude | 页面验证算重任务；`verify` 配置只在执行节点上开 |
| 时区 / 时钟 | 日报 19:00、工作时段判断都按本机时区：各节点统一时区、开 NTP |

## 8. 需要 aven 定的

| # | 决策 | 建议 |
|---|---|---|
| K1 | 要不要先做阶段 0 的内存采样再定台数 | 要。一天工作量，省掉以后反复调配额 |
| K2 | 集群前提 D3（bot 分支 push 到 `lark/*` + MR）是否现在就放开 | 是。不放开，多台机器的产出没法交付 |
| K3 | 控制节点要不要同时当执行节点 | 要，并发配 1 重 2 轻 |
| K4 | 第一期几台 | 3 台（1 控制 + 2 执行），其余闲置待命 |
| K5 | 执行节点的 claude 鉴权 | proxy / API key，不用个人订阅 |

## 附 · 代码改动涉及的现有位置（11-02 核对 `fameex-stable`）

- 监听：`lib/lark-constants.mjs` `GATEWAY_HOST = '127.0.0.1'`、`defaultGatewayUrl` 已认 `LARK_GATEWAY_URL`；`lark-gateway.mjs` `server.listen(port, GATEWAY_HOST)`。
- 领任务：`lib/lark-gateway-client.mjs` `listClaimable` / `claimTask`；`lib/lark-routes.mjs` `/lark/tasks/:id/claim` → `store.claimById`（原子）。
- 心跳：`lark-worker.mjs` `writeWorkerHeartbeat({ runtimeDir })` 写文件；gateway 侧 `/lark/health` 读同一文件。
- 附件：`lib/lark-ai-executor.mjs` 按 `item.localPath` 且 `existsSync` 喂 `--image` / `@path`；`lib/lark-worker-prompts.mjs` 列图片路径。
- 审计：worker 写 `runtime/lark-audits/<PR>/`，gateway 侧只有 `lib/lark-audit-metrics.mjs` 读它（指标），其余不依赖——审计留在执行节点本机即可，`lark-metrics` 改成逐节点汇总。
