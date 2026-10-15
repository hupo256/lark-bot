# falive 接管：出错 → 规则或闸（沉淀台账）

> 原则（aven 2026-10-14 同意）：每次 bot 出错，不只修那一次，必须落成**规则**（提示词 / 文档里的硬口径）或**闸**（代码里的机械检查），并写明怎么验。
> 规则管「怎么理解」，闸管「说出口之前查一遍」。只有规则没有闸的，默认再出一次就补闸。
> 新条目追加在最下面；每条四栏：现象 · 根因 · 落在哪（规则 / 闸）· 怎么验。
>
> **防膨胀（aven 2026-10-14：规则越补越多、干活越来越慢的坑不能再踩）**：
> 1. 机制 > 闸 > 规则：先问能不能用结构解决（台账、待命指令、显式通道都是），不能才写闸（便宜、确定、不占模型注意力），最后才写规则。
> 2. 规则只能替换或合并，不能叠加：加一条必须删或并一条旧的，同一件事只说一次。
> 3. 预算当测试：`__tests__/lark-prompt-budget.test.mjs` 锁住分类器规则（4800 字符）和实施提示骨架（12000 字符）的上限，超了提交就红。10-14 整理前分类提示 12.2k 字符（规则约 5k、重复说三遍），整理后 8.4k（规则约 1.6k）。
> 4. 数据块按需裁剪：台账只收「等答复的条目」文档（`ledgerDocPattern`），标题截 40 字、最多 50 行；总表只按负责人列功能名。

| # | 日期 | 现象 | 根因 | 落在哪 | 怎么验 |
|---|---|---|---|---|---|
| 1 | 10-13 | 群里说「接口都已对完」又列了 getRoomInfo 500 | 把「前端代码写了」当完成、后端问题不算数 | 规则：`COMPLETION_RULE` 三档口径；闸：`findCompletionContradiction` 总括词 + 未完成信号同现不发群 | 单测；真实回放通过 |
| 2 | 10-13 | 「pre 没数据」是抄文档的，没实测 | 回答前不打接口 | 规则：`buildVerifyRule` 实测后才能说 pre 状态；闸：`findUnverifiedPreClaim` 无 preChecks 不发群 | 单测；真实问答带 11 条 preChecks |
| 3 | 10-13 | 「能用：A、B；C 不需要接口」混排看不懂 | 格式没规定 | 规则：`GROUP_REPLY_FORMAT` 一行一个功能 + 固定标记；闸：`findCountMismatch` 结论数 ≠ 条目数不发群 | 单测；真实回复 |
| 4 | 10-13 | 阻塞卡在私聊里一轮轮催办 | fameex 催办逻辑误用于仓库任务 | 闸：仓库任务不进 `remindParkedTasks` | 单测 |
| 5 | 10-13 | 直接 @aven 的提问被判「问进度」忽略 | 规则把提问和催办混在一起 | 规则：点名问就是 question；question medium 也答 | 单测；真实回放 |
| 6 | 10-14 | 提问被并进第 11 代的旧任务 | 「话题 = 任务」模型错 | 架构：台账 + 按条目派工单；提问不归并；任务 id = 消息 id | 单测；真实改代码路端到端 |
| 7 | 10-14 | 重启丢在跑任务 | 先停 gateway 再停 worker | 闸：stop 等 worker 交还后再停 gateway | 实跑重启 |
| 8 | 10-14 | 改了 schema 类型错也判完成 | 终检只有 biome | 闸：`finalChecks` tsc + 改到的测试 | 单测 |
| 9 | 10-14 | 归别人的对接文档被直接忽略 / 判阻塞时文档没提交 | 分类短路；提交依赖 AI 状态 | 闸：文档附件一律进执行器；机械存档；非 done 也入库并转交 | 真实 PM-3217 文档 |
| 10 | 10-14 | 群里「要材料」带出内部分工 | 阻塞条目不分内外 | 闸：`externalBlockers` 过滤归属类条目 | 单测 |
| 11 | 10-14 | 群里 @ 机器人被当普通文字 | 没有显式通道 | 规则 + 闸：`botMentionOpenIds` 按群识别、先回收到、判不用处理也回一句 | 真实消息 |
| 12 | 10-14 | 「分给 @Aven 做」读成「分给 做」 | 解析时把 @名字 删了 | 闸：仓库群保留 @名字；规则：别名表、本人指令最高优先级 | 真实转发 |
| 13 | 10-14 | 交办说「等 X 再做」，X 到了又重新找理由 | 等待条件没闭环 | 架构：待命指令挂台账，X 到了直接派工单；规则：材料不完美也开工 | 单测；待下一次真实触发 |
| 14 | 10-14 | 「收到，我查一下」千篇一律 | 固定句 | 规则：小模型按消息写一句（≤40 字） | 真实消息 |
| 15 | 10-14 | 答应后端「我来修 API」 | 没写边界 | 规则：只做 web 前端，越界礼貌拒绝 | 真实消息 + 补发更正 |
| 16 | 10-14 | 日报群发 19002 | webhook post 格式没在真实群验过 | 闸：群消息统一卡片 | 真实补发 |
| 17 | 10-14 | 正文里抄进署名；「✅ … 没通 1 项」 | 模型抄上下文；前缀机械加 | 闸：剥署名；有逐项状态不加 ✅ | 单测 |
| 18 | 10-14 | bot 的 claude 拿不到主仓项目记忆 | memory 按 cwd 分目录 | 闸：worktree memory 软链主仓 | 单测 + 真实目录 |
| 19 | 10-14 | aven 名下很好清的待办（部署、复测、LN10 / LN5、同步文档）从 10-13 挂到 10-14 | 日报只写不做，没有环节执行第三节；bot 回填的文档只在集成分支，日报从 pre 读看不到 | 架构：`lib/lark-daily-sweep.mjs` 日报发布后确定性抽 aven 待办建清扫任务，单趟实施、A/B/C/D 收尾契约（D 必须有当天实测证据），结果只私信；私信「推 pre」确定性合 pre 并推、回部署邮件；推完盯 VITE_BUILD_TIME 自动复测 | 单测 `lark-daily-sweep.test.mjs`；10-14 真实日报抽取 10 条 + 计数行 |
| 20 | 10-14 | aven 在 bot 私聊里回的「是」「继续」「这个要礼貌拒绝」各建成一条 fameex 主仓 hotfix 任务，4h 后收到 fameex 催办卡 | 仓库通知全发到私聊，但私聊消息永远走默认仓路径（p2p 不解析 repo profile）；回复没锚到它答的那条通知 | 机制：`lib/lark-principal-channel.mjs` 私聊先锚定 bot 最近一条私聊通知所属的仓库任务（回复命中 / 窗口内最近一条且比 fameex 回执新）→ 挂着的续跑、其它建「私聊指示」任务走 @Aven.Bot 同一路径、回群对着原发送人；锚不到才放行 fameex 私聊 hotfix。「判不处理」私信也登记回执 | 单测 `lark-principal-channel.test.mjs`；三条误建任务已结单 |
| 21 | 10-15 | 后端问「是不是没文档权限」：其实是 bot 把卡片里的 `[URL](URL)` 抓成一个 `URL](URL` 去读，lark-cli 失败，报错再贴回群里变成嵌套链接 | 文档 / Figma 链接正则收尾只排除 `)`，没排除 `[` `]` `(` `\\` | 闸：`LARK_DOC_URL_RE` / `FIGMA_URL_RE` 遇方括号 / 圆括号 / 反斜杠即止 | 单测 `lark-doc.test.mjs`、`lark-figma.test.mjs` 用 10-14 卡片原文回归 |
| 22 | 10-15 | Ache 的预约改版答复只 @ 了 Aven.tong，aven 回复「@Aven.Bot 帮记录提醒下」，分类判 api_reply / forMe / high，仍落 ignored「只记台账」 | 回复在安静期内被并成「话题补充」，只拼了正文；`passiveLedgerOnly` 在主消息入库时按主消息的 @ 算死，补充里的 @ 机器人没人看 | 闸：`resolveRepoAddressing` 主消息与话题补充共用；`applySupplementAddressing` 补充走显式通道（@ 机器人 / 带对接文档）就解除只记台账、标 `addressedToBot`（负责人本人再标 `fromPrincipal`），首次 @ 补发收到 | 单测 `lark-thread-intake.test.mjs` 用 10-15 这条的形状回归 |
| 23 | 10-15 | Arthur「@Aven.Bot 重跑一次」被答「没看出是哪条」，1 分钟前 bot 自己刚说「需要的话我重跑一次」 | ① 轮询拉到的 `create_time` 是 `2026-10-15 13:49` 字符串，`Number()` 成 NaN → `createTimeMs` 空 → 「群里这条之前的消息」从没拉过（37 条任务 0 条有）；② 拉上下文只留 `sender_type=user`，bot 自己的卡全丢 | 闸：`toEpochMs` 统一进 `normalizeMessage`；`pickRecentContext` 放行本群自定义机器人（`open_bot_id ∈ botMentionOpenIds`）的卡，剥署名、标「（bot，我们自己）」 | 单测 `lark-pure`（三种时间形态）、`lark-chat-poller`（bot 卡保留 / 别家机器人丢）；回放集 `__tests__/fixtures/falive-intake` |
| 24 | 10-15 | Arthur 回复 bot 卡说「直接发群里」，分类器写「有人（大概率是 aven）…发送人没有标明」判 medium 还要 aven 确认 | 分类提示里没有发送人；ownerMap 有名字但没用 | 规则 + 数据：`describeSender` 把「本条发送人：Arthur（后端）」写进身份段；profile 新增 `memberRoles` | 回放集第 5 条；`lark-prompt-budget` |
| 25 | 10-15 | `lark-prompt-budget` 红了但没人管（5740 / 4800） | 测试量的是整份提示，台账数据块从真实 runtime 读，台账涨到 50 行就超 | 闸修正：`buildIntentClassificationPrompt` 可注入 `ledger`，测试传空台账只量规则 | 测试转绿 |
| 26 | 10-15 | aven 回复 Encone「google 登陆好了，再试试」并 @Aven.Bot「帮我在 pre 上试一下」，bot 没反应；Encone 原消息按被动只记台账 | 原消息是主楼（无话题 id），「话题补充」只按 threadRootId 找目标找不到；发送人不同「同人连发」也不中；落到控制通道，回复「还没了结的任务」被判 notice 整条吞掉 | 闸：① 话题补充目标也认 `replyTo === 任务 id`（直接回复原消息）；② 控制通道 notice 分支外部群里 @ 了机器人的回复放行成自己的任务，不再吞 | 真实重发同一条；回放集待补（原消息 + 回复两条） |
| 27 | 10-15 | Encone 发资料页截图说「google 登陆好了」，分类器写「截图内容也读不出来」 | 图片落盘统一叫 `<n>-<key>.img`，Claude 的 Read 按扩展名判类型，`.img` 当文本读成乱码 | 闸：下载后按文件头（JPEG / PNG / GIF / WebP）改真实扩展名（`imageExtFromBytes` + 重命名） | 单测 `lark-chat-poller`；同一张图改 `.jpg` 后 Read 能看见内容 |
| 28 | 10-15 | aven 在 Encone 15 分钟前的消息上建话题 @Aven.Bot「测试一下，报告回群」，bot 没反应 | 轮询只拉最近 2 分钟窗口；话题回复挂在 host 下一起返回，host 在窗口外就永远看不到；「活跃话题补抓」只认见过的话题 | 闸：每 `poll.threadScanEveryMs`（2 分钟）回看 `poll.threadScanWindowMs`（6 小时）内的消息，只喂展开的话题回复 | 单测 `lark-chat-poller`（老 host 新话题三轮轮询）；真实消息重启后自动捞到 |
| 29 | 10-15 | bot 把 PM-3217 的答复原文存到 `docs/delivery/pending/reply/`，仓库约定是 `docs/delivery/reply/`（与人工存的回复同级） | 实施提示里写死 `${docIntakeDir}/reply/` | 闸：profile 新增 `docReplyDir`（缺省 = 收件目录的兄弟目录 reply），提示改读它并明说不要建 pending/reply | `lark-repo-profile` 单测；下一次答复存档看路径 |

## 还没有闸、只有规则的（再出一次就补闸）
- （10-15 起群里重复消息有机械闸：`shouldSend`，见 falive-repo-profile.md「出口闸」；再出现刷屏先查发件簿 `runtime/lark-outbox/`。）
- #13 待命指令触发后「材料不完美也开工」：目前靠提示词；若再出现「找理由不开工」，加闸：待命触发的工单不允许 blocked，只能 done + 待确认清单。
- #14 场景化「收到」：靠小模型；若出现承诺结果 / 答非所问，加闸：输出含「我来修 / 一定 / 保证」不发，回落固定句。
- #19 清扫只靠契约判「依赖外部」：若再出现没证据就归 D，加闸：summary 里 D 类行不含时间 + 响应码就退回重跑。
- #15 只做 web：靠提示词；若再答应改后端，加闸：reply 含「我来修 / 我改接口」且消息提到后端 → 替换为固定拒绝句。
