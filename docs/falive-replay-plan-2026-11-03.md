# falive 实战数据回放 lark-bot（立于 2026-11-03）

> **位置（11-03 起）**：本文件、回放脚本 `scripts/sim/`、case 数据 `replay/falive/`（原始拉取 raw/、dataset/、case 清单 cases.md、每轮裁判 rounds/）都在 lark-bot 仓库里跟版本走；下文早期条目里的 `runtime/falive-replay/raw|dataset` 即现在的 `replay/falive/raw|dataset`，回放产物（sim/、l1/）仍在 `runtime/falive-replay/`。

> 一句话：这两天的升级（上下文分层 11-01、对话层重建 11-02）没经过实战。拿 falive bot 10-20 → 11-02 的真实运行数据，
> 在 lark-bot 现在的代码上**先跑基线、再修、再跑**，差异清单驱动迭代；静态 review 并行，但它的发现只进同一张清单，不单独改码。
> 范围：只做主链「消息进来 → 分类 / 接话 → 执行 → 回复」；bug 表轮询、邮件转评分、每日报告不回放（aven 11-03）。预算不限。
> 代码在 `~/github/lark-bot-conv`（lark/conversation 分支，`scripts/sim/`），数据与模拟运行目录在 `~/github/lark-bot/runtime/falive-replay/`（gitignore）。

## 0. 进度（做完一步回写一行）

| 步 | 内容 | 状态 |
|---|---|---|
| A1 | 拉三个群历史（渲染版 + raw API 版，含附件）、读网关 / worker 日志、台账、审计 | ✅ 11-03 |
| A2 | 数据集：`scripts/sim/build-dataset.mjs` → `dataset/timeline.json`（2371 条）、`dataset/episodes.json`（331 条，210 条有原文） | ✅ 11-03 |
| A3 | L1 分类回放：`scripts/sim/replay-intake.mjs`，真跑分类器，两档强度（现网 low / falive 当时 high） | ✅ 两档都跑完（210 条，0 错；low 中位 5.9s，high 9.0s；两档互相一致 131/158） |
| A4 | L1 对照：`scripts/sim/compare-intake.mjs`，混淆矩阵 + 逐条差异 + `--md` 报告 | ✅ `l1/base-low/report.md` |
| A5 | L1 裁判：`scripts/sim/judge-intake.mjs`，差异条目用模型 + 事后信息判「谁对」 | ✅ 第一轮 45 条（非 aven 部分）：lark-bot 更好 19 / falive 更好 16 / 一样 9 / 都不对 1；aven 发的 52 条因发件簿污染重跑中 |
| B1 | 离线模拟器：`scripts/sim/{fake-lark-cli,lark-cli,virtual-clock,run-sim,compare-sim}.mjs` | ✅ 跑通（smoke：10-20 08:30–10:00Z 11 条）；业务仓副本改成按基线检出的 worktree |
| B2 | L2 对话层回放：逐事件按时间推进，比每条 @bot 的下文 / 义务状态 vs falive 当时 | 🔄 `scripts/sim/run-days.sh 2026-10-20 2026-11-03 full` 跑中（同一 sim 跨天续跑，每天重起进程、重钉基线；非触发消息只等 3 秒） |
| B3 | L3 执行层回放：与 B2 同一次模拟，worker 真跑 claude，baseRef 钉到当天的 falive-react 提交（不抽样，全跑） | 🔄 同上 |
| C | 差异清单 → 修 → 只重跑受影响层 → 全量测试绿 → 合运行分支 | 🔄 三个修复分支已合到 lark/falive-fix3（943aa55，全量 639 绿；R7 重分类逻辑挪进 lark-intake-retry 过体量线，用例棘轮 619 → 622）；fix3b L1 裁判 28 / 8 / 11；变异 --diff fameex-stable 48 个抓 46、豁免 2、存活 0（066928e）。修复版三段模拟 fix-a/b/c（端口 3108–3110，代码 lark/falive-fix3 0a9b28b）08:00 与基线并行起跑（aven：资源够、多并行）；对照用 scripts/sim/compare-rounds.mjs（并排）+ judge-sim.mjs（模型裁判，子代理在写）。中置信 R4 R8（前半：重开 / 续跑换回复目标；后半「在跑时并入后结论 @ 其他提单人」另立）R9（别人问 bot 自己也 selfAnswer）R10 R12 已在 lark/falive-fix4（1f22d2d）修完：全量 639 绿，变异 --diff fix3 28 抓 28。fix3 worktree 冻结给 fix-a/b/c 模拟用，集成分支改为 lark/falive-fix4。10-30 L2 裁判后又加一批（9608954）：done 结论不 @ 负责人本人；分类提示补「问打包部署 / 版本是 question」「ignore 的 reply 不承诺后续」；上一版提示 53 条回归集 50/53；再加（44a0e45 / a44bb8a）：群里光一条「@bot」不再被摄入层丢掉（上下文包标「无附言，只 @ 了机器人」）、提示补「只 @ 没正文按本人上一条的事判」；最新版回归集与变异跑中。原三个分支并行：lark/falive-fix2（R2 R6 R11 已修 3 commit，各自测试红→绿）、lark/falive-fix（R1 R3 R5 R7 R13 子代理在修）、lark/falive-fix3（分类提示 + continues 交付物兼容；fix3 一轮 L1 裁判 lark-bot 更好 25 / falive 11 / 一样 9，回归集 53/53；再收口径后 fix3b 跑中） |

## 1. 数据（都在本机，只读）

| 来源 | 内容 | 量 |
|---|---|---|
| 飞书群历史（aven 身份） | Falive PHP后端群 `oc_c2a6…`、Falive产研技术沟通群 `oc_4062…`、webhook bot（falive 控制台）`oc_21a2…`，10-01 起全部消息 + 附件。渲染版 `raw/<群>.json`（`+chat-messages-list --download-resources`：内联 @名字的文本、sender 名、附件落地）；raw API 版 `raw/<群>.api.json`（`lark-cli api GET /im/v1/messages`：parent_id / root_id / thread_id / 原始 content） | 1135 / 555 / 679 条 |
| `~/Library/Logs/falive-lark/gateway.log` | 每条消息的分类（`classified=<decision>/<confidence>`）与路由（并入 / 指示任务 / 续跑 / suspected / blocked ask / noted / outcome） | 269 条分类 |
| `~/Library/Logs/falive-lark/worker.log` | 领取时的完整正文（`claimed <id> via claude: …`，含「【被引用消息】」「【群里这条之前的消息】」「【aven 私聊指示】」） | 134 条 |
| `~/github/lark-bot-falive/runtime/lark-ledger/falive.json` | 对接台账：每条消息的 decision、触及条目、转移、摘录 | 139 条目 / 243 事件 |
| `~/github/lark-bot-falive/runtime/lark-audits/FALIVE/` | 任务审计：原文、附件、workContext、最终结论、提交、claude 事件流 | 100 任务 / 164 代 |
| `~/github/falive-react` | 业务仓，真跑回放按当时的父提交检出临时 worktree | — |

拉不到的：【专项】Falive融合技术讨论群（aven 不在群里；台账 0 事件，75 条 ignore 没原文）；aven ↔ bot 的真私聊（原文在 worker.log）。

## 2. 三层回放（便宜 → 贵），每层都是「同一条输入，falive 当时 vs lark-bot 现在」

### L1 分类 / 接单层（`scripts/sim/replay-intake.mjs` → `l1/<run>/results.jsonl`）
上下文包用 lark-bot 自己的 `buildConversationBundle`，四个拉取函数注入成「从时间线取」（引用消息 / 话题 / 最近 20 条 / 附件），分类器真跑 `classifyTaskIntent`，
落地走 `applyIntakeClassification`。比：decision / confidence / deliverable / 落地（actionable / selfAnswer / askBack / suspected / recordOnly / ignored）vs 网关日志。
局限：没有任务仓历史 → 候选任务 / 默认锚点 / 负责人私聊锚定（privateOrigin）都空，这些只能靠 L2。

### L2 对话层（离线模拟器）
假 `lark-cli`（`LARK_CLI_BIN`）：`event consume` 按虚拟时钟吐时间线事件；`+chat-messages-list` / `+messages-mget` / `+threads-messages-list` 按时间点截断供数；
`+messages-send` / `+messages-reply` 记到 sim 发件簿并回 message_id；`+chat-list` 给三个群；其余子命令回 ok 空。真网关 + 真 worker 跑在隔离运行目录
（`LARK_RUNTIME_DIR`、独立端口、`LARK_DRAIN_RESTART=0`、`LARK_WAKE_CATCHUP=0`）；虚拟时钟 preload 让 `Date.now()` 跟事件时间走，事件之间等系统空闲再跳。
比：每条 @bot 有没有下文、下文是什么（人话 / 结论 / 追问 / 私信负责人）、义务状态；对照 falive 当时的卡片回复和人的后续反应。

### L3 执行层（同一模拟器，worker 真跑 claude）
抽 20 条左右覆盖 bugfix / requirement / verification / no_change_needed / blocked / failed；按天把 falive-react 的 baseRef 钉到当天的提交。比 status、结论、改动文件集 vs 审计。

## 3. 回放时做的映射（都记在这里，免得以后当成 bot 的行为）
- falive bot 在不同群里的 @ open_id 不同（PHP 群 `ou_caf1…`、产研群 `ou_f57c…`、webhook 群 `ou_9699…`）：事件里统一改写成配置的 `botOpenId`。
- webhook 群是 falive 的「控制台」（只有 aven 一个人，他在那里说的话 falive 按负责人私聊处理）：映射成 lark-bot 的负责人私信（p2p，chat_id = aven open_id）。
- 撤回的消息（渲染版「[Invalid text JSON]」/ raw「This message was recalled」）按已删除。
- 回复了 bot 任何一条消息都算 bot_reply（生产只认登记过的回执；近似）。
- **运维指令（核对 uat / online 后发部署信、推 MR）不在回放范围**：要真读当时的环境分支、真发邮件 / 推送，回放台不提供（opsActions 不配，任务会 failed「运维配置缺」）。裁判里这类 stuck 不计入 lark-bot 的问题。
- 分类提示里写死的「只做 fameex-web 前端仓的事」改成 `localConfig.repoLabel`（缺省不变）——这是回放的前提，也是一个真缺陷：提示词与仓绑定。

## 3b. 回放台自己的坑（已修，记下免得再踩）
- L1 第一轮把 `LARK_RUNTIME_DIR` 指到现网 runtime 读 persona，结果对话数据按 chatId 读到了现网发件簿：aven 的私信 chatId 就是他的 open_id，fameex 线最近 7 天对他说的话被当成「正在进行的事」，回复里冒出 fameex 的「档位弹窗」。发件簿 / 义务已改指空目录，aven 发的 52 条重跑。
  顺带一个真问题：`buildConversationData` 的时间窗按 `Date.now()` 算，不按消息时间——开盖补拉旧消息时会拿「现在」去框 2 小时 / 7 天窗口。
- 只读答疑原本直接在业务仓主目录跑（HEAD 是最新代码），答案里出现「10-30～11-02 最后一次实测」这种未来信息；已改成按窗口起点检出的 worktree。
- falive-react 的 commit-msg 钩子（scripts/verify-commit-msg.mjs）要求 `<type>(<scope>)?: 主题`，lark-bot 的 hotfix 提交标题是「lark hotfix: …」→ 全被拒、任务降级 failed（full-b 第一轮 6 次）。falive 当时靠 repo profile 的 commitPrefix；已移植成运行配置 `commitPrefix`（fix3 0a69b79 / conv 53117d4），模拟配置填 feat(bot)。三段基线 07:48 用带它的代码重启。
- 三个模拟同时 `git worktree add` 撞过一次（failed to read .git/worktrees/…/commondir），启动错开 20 秒。
- **多个 sim 共用一个 falive-react 会互相撞任务分支**：bot 的临时分支 hotfix/adhoc-<任务 id> 按 id 定死（重试复用），smoke 跑过的任务在 full-a 里再跑时遇到「分支已有提交但不包含本次基线」→ failed；基线与修复两轮跑同一批任务 id 也会互撞。08:30 改成每个 sim 一份 `git clone --shared`（对象共享，分支 / worktree 独立；origin = 主仓，基线分支 sim-base-<日期> 建在主仓供 fetch），六段全部重启。主仓里清掉了 hotfix/adhoc-* 与 remote sim。
- clone 带着主仓全部分支，worker 看 online 分支 / git log --all 能看到窗口之后的合入（10-31 回放：「Justin 10-31 已合入 online」）；09:05 起副本只留基线分支的引用（从各段的下一天起生效，两轮同时）。

## 4. 发现（随时追加；最后汇总成差异清单）
1. **只 @ 负责人的消息 lark-bot 一律不处理（11-02 决定）**：falive 当时分类了 52 条这类消息，46 条 ignore，6 条有动作——4 条入队（3 条是「发对接文档 @aven」→ 文档入库，1 条 Adrian 发任务中心文档）、2 条疑似。影响面小，但「发文档只 @aven」这个入库入口没了。
2. **falive 的 18 条「疑似」里 12 条后来 aven 放行了**：lark-bot 现在按 10-24 规则 medium 直接 actionable，与 aven 事后的决定一致（更好）；没放行的 6 条里 lark-bot 有 4 条会直接开跑（「手机号登录账号存一下」「uid 508 设成主播」「开播语言没接」「完善资料部分需要前端接入」），要看 L2 / L3 跑出来是不是无害的实测 / 只记一笔。
3. **L1（low）可比 96 条：决策一致 65，落地一致 64**。差异类型：api_reply → lark-bot 判 recordOnly（falive 入队，2 条）；falive question/actionable → lark-bot ignore（「把你的账户昵称给我发一下」）；图片 + 「@Aven.Bot」短句 → lark-bot ignore/medium（falive bug/medium，aven 放行过）。
4. 负责人私聊的指示（「就这样回，哪里拿不准了」「已部署」×4）在 L1 没有锚点上下文 → 判 question/low 追问或 ignore；是 L1 局限，L2 再看。
5. **L1 裁判（非 aven 的 45 条差异）**：lark-bot 更好 19（多是「medium 直接做」对上了 aven 事后的放行、reply 更像人话），falive 更好 16，一样 9。falive 更好的里值得修的：
   - 「@Aven.Bot 把你的账户昵称给我发一下」→ lark-bot ignore（漏接；该 selfAnswer / question）；
   - 「直播间关注会同步到 Go，这个不要改 go」→ ignore/low（后端要前端撤改动，该 api_reply）；
   - 截图 + 短句「@Aven.Bot」（Encone 报广场发帖缺功能）→ ignore，且 reply 把截图读错；
   - 「404 不用修了，已切 golang 实测通过」→ lark-bot 建任务复测（该 recordOnly，扰民）；
   - 「能不能先打包到 uat OL」→ ignore（falive 核对后答了「不用打包」）；
   - 「测试帖子多语言翻译以及 AI 识图」→ reply 反问「test 还是 pre」，前文一直在 pre（persona 的「先确认环境」用过头）。
6. **L2（smoke，10-20 08:39–08:49）continues 归并过宽，同一份答案连发三遍**：Encone @bot 要「api 待处理清单」（question → 答了）；4 分钟后 William @bot「portal 接口不需要带嗨聊头，更新清单」、Encone @bot「你自己写脚本批量造测试帖」，分类器都填了 continues = 清单任务（理由：「清单上一项的答复」），落地 rerun_after_done：清单任务各重跑一遍，整份清单又作为对**第一条**消息的回复发了两次（08:45、08:49），William / Encone 自己的消息只得到「收到」；aven 也收到三条「替你答了」。falive 当时是三条独立任务。
   根因：提示里「候选任务里是某条的延续 / 追问 → continues」没有区分「同一主题」和「同一交付物」；并入 done 的答疑任务后重跑的是整个任务、回复目标还是原消息。待修：continues 只在交付物兼容（追问 → 原答疑；补料 → 在跑的改码单）时生效，不同诉求（api_reply/change、requirement）另起任务；并入已完成任务重跑时回复新消息而不是旧消息，且只答增量。
7. L2 smoke 里 worker 真的去探了 falivepre（envSites.pre），拿到 503 写进了答复——模拟时外网仍是真的，结论里带了「现在」的环境状态，对照 L3 时要记得这一点。

## 5. 静态 review（11-03，子代理只读 20 个主链文件；每条先用失败测试验证再修）
高置信：
- R1 lark-principal-channel:153 负责人私信回「不是 / 不用 / 算了」给挂起任务，主通道无条件 resume，把否定句当补料放行执行（主通道没调 classifyClosureIntent）。
- R2 lark-task-store closeAsExternallyResolved 不清 ackPending → 结单后 45 秒巡检照发「收到，我看一下，稍后回你」。
- R3 lark-principal-channel:159 负责人对在跑的锚点任务说「不做」只建指示任务，锚点任务照跑到 done 再回群。
- R5 lark-message parseControlDirective / parseResumeDirective：指令词后任意 ≥4 位 ASCII 单词当 taskId（「关闭 Google 登录入口」→「没找到任务 Google」）。
- R6 lark-routes-intake intake_failed 出口：先发固定「收到」再永久静默，不私信负责人，逾期巡检也跳过。
- R13 控制通道对 failed 任务回「还在处理中」。
中置信（先看回放有没有撞到再决定）：
- R4 群里带项目号的任务被改投绑定群（发件簿 / 义务 / 活跃都记在别的群，对话锚定看不到）。
- R7 目标正在分类时仍当 supplement 并入，分类器拿旧正文跑完判 ignore 后补料无声丢失。
- R8 mergeTaskObjects 不更新 operator / replyTarget：并入后结论回到原任务的消息、@ 原提单人（与 §4-6 同根）。
- R9 selfAnswer 提示没限定提问人：别人问 bot 能做什么 → reply 已是完整答案又 queued 再答一次。
- R10 默认锚点 / 正在进行的事读到被闸拦下的发件簿条目（gated）。
- R11 自答走 done 相位的 content_24h 去重：两人问同样的问题第二条被拦，状态却 answered。
- R12 回执重试每 5 分钟重建一份细节文档（docUrl 不持久化）。
分组修：fix worktree A（lark-bot-fix，分支 lark/falive-fix）：R1 R3 R5 R7 R13；fix worktree B（lark-bot-fix2，分支 lark/falive-fix2）：R2 R6 R11。
8. **L1 修后对照（fix3b，分类提示 + continues 收窄）**：同一批差异条目裁判从 lark-bot 更好 19 / falive 16 / 一样 9 → **28 / 8 / 11**，reply 质量 good 30 → 37；53 条分类回归集全过；分类器两档互相一致度不变。剩下 falive 更好的 8 条：3 条是 aven 私信「已部署」（约定口令 = 去 pre 复测 + 待推版改已推版，L1 没锚点，看 L2）、2 条是「medium 直接做 vs 先私信确认」的策略差（aven 10-24 定的口径，保留）、「能不能先打包到 uat OL」仍判 ignore、截图短句仍 ignore、一条回复里 HTML 实体没转义（I&#39;m）。
9. **L2 修后 smoke（fix3，同一 10-20 窗口）**：清单只答一次（不再连发三遍）；William「portal 不用带头」→ api_reply·null 只记一笔、回「收到…清单里这项我改成已确认」；Encone「写脚本造测试帖」→ 独立 requirement 任务开跑，因今天 pre 登录接口「外部服务调用失败」没做成，草稿私信 aven 等放行（falive 当时环境正常、做成了）。
10. **L2 模型裁判（judge-sim，smoke 窗口 3 条触发消息）**：基线 falive 2 / 一样 1（问题：并入漏做、回错对象）；修复版 lark-bot 2 / falive 1——剩那条是「群里只给概述、清单在文档里」，这是 aven 11-03 定的答疑口径（短回复 + 细节文档），不改。
11. **L2 裁判 10-30 一天（基线 full-c 6 条差异全是 falive 更好；修复版 fix-c 3 条：一样 1 / falive 2）**，主题：
   - **回群结论 @ 错人**（3 条，wrong_target）：复测结论 @ 了报告里「找谁」的人（Kai / Encone / aven）而不是提问人；提问人是靠「回复原消息」带到的，@ 别人反而像在催他们。待修：结论只回复原消息，@ 仅限需要对方动手的人，且不 @ 提问人以外的人除非 report 明确要找。
   - **「能不能先打包到 uat OL」两轮都判 ignore**（missed）：提示要再明确「问部署 / 打包 / 版本状态 → question」。
   - **ignore 的 reply 承诺了后续**（「对完跟你说」却没人跟进）：ignore 的 reply 不能承诺动作。
   - **说「锁定 uat」实际测的 pre**：模拟配置只给了 pre 的地址（envSites），bot 只能测 pre——回放台要补 falive 的 uat / online 地址。
   - **实测只能发只读 GET、不能登录**：aven 私信给了账号，bot 仍「没用给的账号登录」；falive 当时有 pre-probe 脚本能登录。lark-bot 的实测模式没有登录能力（fameex 线 11-02 也遇到），这是能力缺口，要 aven 定：给实测模式开登录（POST）口子，还是继续只读。
   - aven 私信给账号锚到了「最近一条通知」的任务（member/info）而不是 falive 当时等账号的任务中心单——在 lark-bot 自己的时间线里这个锚是对的（那条刚说没登录态），不算错。
12. **L2 裁判 10-26 一天（基线 full-b 7 条差异：falive 5 / lark-bot 2；修复版 fix-b 6 条：lark-bot 2 / 一样 1 / falive 3）**。基线独有的：同一条处理两遍先「已修复」又「不用改」（duplicate，continues 老问题）、阻塞清单与结论前后矛盾（三条消息）。两轮共有：
   - **光一条「@Aven.Bot」（没正文）被摄入层直接丢掉**（2 条 missed）：人在自己上一条话后面单独 @ 一下是常见的催 / 接话方式，lark-ingest 对「没正文、没附件、没引用」的消息直接 return，根本没到分类器。falive 接上了前文。待修：群里直接 @bot 的一律进分类（上下文包会带前文），只有私信空消息才丢。
   - aven 私信「已部署」→ falive 把 bug 表从待推版改成已推版（bugpoll 流程），lark-bot 回「知道了」；这是 falive 线的约定，fameex 线由 bug-watch 处理，不改。
   - 结论 @ 了 Eric 而不是提问人（wrong_target，同 10-30 主题）。
13. 10-31 基线补判 2 条：aven 私信「核对 online / uat 一致后发部署信」→ lark-bot 运维任务因模拟配置没有 opsActions（deployMail 脚本）直接 failed（回放台缺口，fameex 线有）；Arthur 回答 bot 自己提的问题（改资料后调 task/complete）→ lark-bot 判阻塞、反过来要接口文档并在群里发求助文档（wrong_content）——api_reply·change 进实施前的分析把「对方答复」当成缺料，待看修复版同一条。
14. **裁判时机**：按天跑 judge-sim 时，跨天还在跑的任务会被当成「没回」误判（fix-a 10-21 的昵称答复 40 秒后就发了，裁判先跑了）。已判的条目不重判，所以中途的裁判只当早期信号；六段跑完后删掉 judge.jsonl 整体重判一次再算总账。
15. **fix-a 10-20**：「pre 更新了，检查下 preload」（api_reply·verification）被 continues 并进了排队中的「写脚本造帖」（requirement·change）——fix3 的兼容规则对「还没开跑」的目标放行了，结果一个任务干两件事、结论混在一起连发两条，aven 的「继续任务 <preload id>」又顺着 supersededBy 指到造帖单重跑一遍。fix4 收紧：只有在等补料（waiting_confirmation / blocked）的目标什么都能并，排队中的也要交付物相同（4 层回放 → 修的例子）。
16. **基线 full-a 10-20 重跑后裁判（4 条：falive 3 / 一样 1）**：「就这样回」锚到刚私信过的 preload 任务而不是扣着草稿的 lives 卡（回「没有草稿」）；aven「滚到底看看」并进了 preload 旧任务。fix4 f4c4cc0：放行草稿时锚到的任务没草稿 → 改找窗口内最近有草稿的任务。
17. **c 段（10-30 → 11-02）两轮整体重判**：基线 full-c 8 条差异全是 falive 更好；修复版 fix-c（fix3 代码）5 条：falive 4 / 一样 1。并排：群里回复 27 vs 27，重复回复 2 → 1，私信 aven 23 → 26，任务终态分布基本一致。剩余主题（@ 错人、打包问题判 ignore、运维配置缺、答复被当缺料）大多在 fix4 里才修，要再跑一轮 fix4 验证——第三轮 r3-*（worktree lark-bot-r3，分支 lark/falive-round3 = fix4 95db743 + 回放脚本），c 段 09:20 先起（端口 3111），a / b 等第一二轮跑完再起。报告：runtime/falive-replay/sim/rounds-c.md。
18. **09:50 再加并行（aven：多启 agent 加速）**：第三轮 r3-a / r3-b 起跑（端口 3112 / 3113），与 full-a/b、fix-a/b、r3-c 共 7 段同跑；回放目录加 .metadata_never_index（Spotlight 索引曾占大半 CPU）。三个子代理：lark-bot-fix5（lark/falive-fix5）修「结论 @ 错人」+ R8 后半（并入的提单人也 @）；lark-bot-fix6（lark/falive-fix6）修「对方答复被分析阶段当缺料判阻塞」；conv 上写 scripts/sim/summarize.mjs 汇总总账。fix4 合入前检查：6 条真实消息分类回放 6/6、53 条回归集 53/53、全量 639、变异 53/53。
19. **fix5 合进 fix4（b8efa6f，快进）**：代答 / 实测结论第一行 @ 提问人（原来正常回复时从不 @ 他，renderMentions 反而把待跟进的人全补到行首），待跟进只 @ 有事项的；并入消息的提单人在结论末行 @ 上（rerunAfterDone 那轮先不 @，留给带补充的重跑轮；task.mergedNotified 防重复）。全量 639 绿，变异 31/31。
20. **fix6 合进 fix4（4067170）**：「对方答复被当缺料判阻塞」定位到两步——分析阶段模型把 Arthur 的答复当缺料（4 条 blocker 里有一条自己已写出正确做法），gate 按关键词（token / 登录 / 测试环境）把每条拖成 hard。修：对接答复类任务里首句在「再要文档 / 契约 / 时机 / 再确认」的 blocker 降 soft（要账号 / 权限的仍 hard）；分析提示加「答复正文就是材料，能推就推，前文别的事不并进本条」。规则放分析提示而非系统层（实施提示预算只剩约 87 字；codex 跑分析没有系统层）。提示回放 164 任务 / 242 份规则不丢、系统层 1 种；全量 639；变异 --diff fix3 84/84。
21. **基线 b 段（10-25 → 10-29）整体重判：falive 11 / lark-bot 6**。主题：
   - aven 私信「已部署」4 次只回「知道了」：这是有意的设计（单独一句部署通知不是指示，falive 10-28 定的），部署后复测在 falive 由 bugpoll 部署钩子做——**回放范围外**，不计。
   - 但顺着查出 **lark-bot 的部署信回执承诺「pre 部署后 bot 会自动探测并复测」，实际没有这条链路** → fix4 1d06597 改成「部署好后要复测就私信我「<env> 复测」」。要不要移植部署探测 → 复测，待 aven 定。
   - **改了别人负责的模块**（2 条，falive 按功能总表转给 henry）：lark-bot 没有归属表（falive 的 ownership.table 没移植，fameex 线暂无对应），模拟里也没配。待 aven 定 fameex 线要不要归属表。
   - 光 @bot 被丢（3 条）：fix4 已修；「已关闭没推流的直播间」只记一笔没复测：fix3b 提示已改（已配好 / 已关掉的是我们报的 → 复测）。
22. **第三轮 c 段（fix4 早期 95db743）整体重判：falive 5 / lark-bot 0**，没比第二轮好——它不含 fix5 / fix6。新暴露：William「复测 OL」被并进之前的 uat 实测任务，envTargets 仍是第一条的 uat，收尾环境核对给结论加了「测的不是你说的 uat」。fix4 b2081c2：并入时点名环境跟新消息走（重开 / 续跑取新的，在跑 / 没开跑取并集），都是实测但环境不相交的不算延续；全量 639，变异 93/93。第四轮 c 段用含它的代码（r4 c6c707e）10:06 重起。
23. **b 段两轮（10-25 → 10-29）**：基线 falive 11 / lark-bot 6，第二轮 falive 10 / lark-bot 7；重复回复 5 → 4；任务 done 12 → 16、superseded 9 → 5（并入收窄）。第二轮仍差的：光 @bot 被丢 3 条（fix4 已修，第二轮代码不含）、「已關閉沒推流的直播間」判 ignore 没复测（fix3b 提示里已有「已配好 → 复测」，仍没判出来，第四轮再看）、配 Google client 后没提醒加授权来源。报告：sim/rounds-b.md。
24. **10:25 再加并行（aven：资源还多）**：第四轮 a、b 段拆半——r4-a2（10-23→10-24，端口 3117）、r4-b2（10-28→10-29，3118）另起，原 r4-a / r4-b 跑到分界日自动停（/tmp/split-stop.sh；边界处跨天的任务延续会断，可接受）。三个子代理：合入前独立 code review（fix4 相对 fameex-stable 全部 lib 改动）；lark-bot-fix7 修「对方已办好我方请求却只记一笔不复测」；lark-bot-fix8 查「前文截图被当成本条附件」。另外 fix4 代码重跑 L1 全集 + 裁判（l1/fix4-low）。
25. **fix8 合进 fix4（cb88e3c）**：前文截图被当成本条的——附件清单每条都写了来源，但没说「只有标『本条』的是这条自己带的」，worker 把前文 Kaiser 的报错图说成提问人发的（回放里图其实都没下载成功，是它编的）。修：有非本条附件时，在附件清单后加一句归属说明（分诊 / 分析 / 实施三处）；实测 / 代答单趟不走系统层，所以不放系统层。提示回放规则不丢、系统层 1 种；全量 639；变异 3/3。
26. **合入前独立 code review（fix4 相对 fameex-stable，11 条）**——多数是这批修复自己带进来的回归，合入前必须修：
   - 高：私信补料「不对，应该是 508 账号」被当「不做」关任务（R1 正则过宽）；对接答复里金额 / 状态 / 权限类硬阻塞被降 soft（fix6，违背「金额状态无证据就停」，fameex 交易所场景尤其危险）；
   - 中高：「就这样回」改找草稿可能把别的任务的草稿发进别的群；改码 done 写给 aven 的事项群里不 @ 后私信也没有，事项丢了；
   - 中：回「收到」可能结掉在跑的锚点（R3）；环境不相交不算延续对改码类也生效；resumed 换回复目标让原提问人收不到；挂起时也说「补充一起处理了」并记已通知；别人低置信也自答；
   - 低：重开换 messageId 让 retry 重下附件拿错 id；B 的回复义务停在 acked。
   三个子代理并行修：lark-bot-fix9（私信通道 + 并入兼容：#1 #2 #4 #6）、fix10（阻塞分级 + 结论文案：#3 #5 #8）、fix11（并入目标 + 自答口径 + 义务：#7 #9 #10 #11）。修完合进 fix4 后再出第五轮候选。
27. **review 修复全部合进 fix4（1e31172）**：fix9（私信补料不误关、寒暄不结锚点、「就这样回」只在 recent 且锚点从没草稿时改找、环境不相交只对实测 / 答疑生效）、fix10（金额 / 状态 / 权限 blocker 不降级、负责人事项进私信、并入人那行只在出结论时加）、fix11（resumed 不换目标、重开不换 messageId、非负责人低置信不自答、重开来源的义务一并记 answered）、fix7（提示已能判对——当时判错是回放缺口，锁进回归集 56 条）、我补的「负责人原话整句寒暄不往群里回 reply」。全量 639 全过（负载 35 时用时 19 秒超 18 秒预算，合入前空闲复测）。
   回放台：按 id 取消息时供出窗口内 falive bot 的原卡片（人引用回复它时上下文才完整）。
28. **第五轮 = 最终候选**（worktree lark-bot-r5，分支 lark/falive-round5 267b833）：第三、四轮（中间版本）停掉；第五轮切 6 段并行（r5-a1 10-20→22、a2 10-23→24、b1 10-25→27、b2 10-28→29、c1 10-30→31、c2 11-01→02，端口 3120–3125），段边界处跨天延续会断。zsh 不对未加引号变量分词，第一次 6 段都没起来，改 bash 重起。
29. **前两轮三段齐了（基线 vs 第二轮 = fameex-stable vs fix3）**：总账 falive 更好 36 → 38、lark-bot 更好 11 → 14；问题类型：missed 16 → 20、duplicate 6 → 2、wrong_target 8 → 5。a 段第二轮反而更差（24 vs 17），拆开看：光 @bot 被丢 5 条（fix4 才修）、「继续任务 <id>」续错对象 4 条（前面 continues 并错的连锁，fix4 收紧并入）、回放台失真 3 条（中途把 uat 一律加进配置 → 10-22 编出当时不存在的 uat；bug 表不在回放里）、答应了没给 2 条。结论：第二轮代码不能代表最终版，判定以第五轮为准。总账：runtime/falive-replay/summary.md。
30. 回放台：环境地址按时间线首次出现的日子生效（pre 10-08、uat 10-28、online 10-29）；第五轮前四段 10:52 用它重起。集成分支完整变异 --diff fameex-stable：166 个抓 165、豁免 1、存活 0。子代理 lark-bot-fix12 查「答应了却没给」。
31. **fix12 合进 fix4（4c3e225）「答应了却没给」**：「测试的 tid 发出来」——tid 只在上一单（翻译实测）的结论里，新任务拿不到，worker 回「去翻文档 / 回头再发你」；修：分类落地时按 continues / relatedTaskId 把那一单的结论带成 task.priorConclusion（≤2000 字），代答 / 实测提示里带上它和群里已回的那句。「创建最新的帖子进行测试」——分类器「收到」许诺了实测模式做不了的写操作；修：reply 规则补「发帖 / 造数等写操作未必能做，别说要做」（删一句重复的口吻规则，分类器规则 2600/2600 无余量）；代答 / 实测模式块末加「要事实直接列、要操作能做就做不能做直说找谁、不写回头再…、答应过的要兑现」。提示回放规则不丢、系统层 1 种；6/6；56/56；全量 639；变异 6/6。第五轮不含它，a2 段（10-23→24，含这两条）跑完后用含 fix12 的代码单独重跑对照。
32. **L1 用集成分支（fix4 1e31172）重跑 210 条 + 裁判**：同批差异 falive 更好 / lark-bot 更好 / 一样 = 6 / 22 / 10（基线 13 / 21 / 9，fix3b 8 / 28 / 11）。
33. **第六轮 = 最终版**（worktree lark-bot-r6，分支 lark/falive-round6 bfdd1ac = fix4 4c3e225 + 回放脚本）：fix12 改了所有代答 / 实测提示与分类器「收到」，第五轮不再是最终版；11:18 起第六轮 6 段（端口 3140–3145），与第五轮（fix12 之前的对照）同跑，负载 5 时起的。
34. **11:40 不干等，再并行（aven）**：自动裁判脚本（/tmp/auto-judge.sh）每段跑完即判、全部完成出总账；三个子代理——第二次独立 review（fix9–fix12 增量）、fameex 线自己数据的分类回放对比（scripts/sim/fameex-l1.mjs）、文档对齐（lark-bot-fix13，只改 docs/）；L1 用含 fix12 的集成代码重跑（l1/fix12-low）。总账脚本已认第五 / 六轮切半段。

## 6. 回放流程优化（11-03 12:00，aven：「再优化实跑流程，别因快损失准确性，上下文一定要拿全」）
**现状的两类问题**
- 损失准确性：① 第五 / 六轮切 6 段并行、每段从空状态起，段首几天没有前面的任务 / bot 说过的话 / 义务 / 候选任务；② 假 CLI 对 `docs +fetch` 一律失败，群里贴的对接文档 / PRD 链接 bot 读不到；③ bug 单（Bug-49xx）查不到记录；④ 少数附件下载失败、合并转发没展开。
- 浪费时间：每轮把分类器和只读答疑全部重调一遍 claude，即使输入逐字相同。
**改法**
1. 上下文补全（子代理 A，只改 scripts/sim 的假 CLI 与新数据缓存）：云文档按链接用 aven 身份只读拉一次缓存（标注是「现在」的版本）、bug 记录同样只读缓存、合并转发展开、附件下载失败的补拉；假 CLI 从缓存供数。每补一类都统计「回放里请求了多少次 / 命中多少」，没命中的列出来。
2. AI 调用缓存（子代理 B）：LARK_CLAUDE_BIN 指向包装脚本，对分类器与只读单趟（代答 / 实测 / 分诊 / 分析）按「规范化后的完整输入」（去掉 sim 目录名、端口、临时路径）做键缓存；命中复用、未命中真调并落盘。改码任务（会改 worktree）一律真调不缓存。缓存命中率、各类调用数写进 sim.log。
3. 不再切段：整条时间线一个 sim 按顺序跑完（上下文连续），速度靠缓存。
4. 只判有变化的：新一轮与上一轮逐条比下文，相同的沿用上一轮裁判，只判变了的。
5. 合入前只跑一次完整确认（含真跑改码任务），不每修一批跑一轮。
35. **第二次独立 review（9 条）修完并合进 fix4（f02e311）**：fix14（私信否定 / 归属 / 补料三分、「就这样回」按 heldAt 判改找、私聊指示按负责人原话判拒绝与寒暄）、fix15（「群里已先回了一句」只用真正发出的 ackReply、priorConclusion 随重开换成本单上一轮、续跑保留原契约、实测模式上一单结论只作背景）、fix16（敏感字段正则拆中英、去误伤补漏、负责人事项群里没发成也私信），外加 fd6de46（锚点在跑又没结掉时分类器那句不回群）、96f1e09（恢复「像正常人聊天」——fameex 自有数据对比里唯一弱信号）。fameex 线自有 26 条样本两版落地全一致。全量 639；提示回放规则不丢、系统层 1 种；6/6；56/56。
   待办（不阻塞合入，只会少一行背景、不写错话）：① lark-routes-intake 先并入再发「收到」，worker 抢先领走时这一轮少「群里已先回了一句」；② rerun_after_done 那轮开跑前没把本单这轮结论写进 priorConclusion。
36. **12:30 旧逻辑的模拟全部停掉（aven：「还用旧逻辑跑还有意义吗？都停掉，用新逻辑」）**：第六轮切段跑、段首上下文不全，不作合入依据；连同自动裁判一起停。下一次也是唯一一次完整确认，等上下文补全与 AI 调用缓存两个改造就绪后，用集成分支最新代码（f02e311）整条时间线不切段跑。集成分支完整变异 --diff fameex-stable：193 个抓 192、豁免 1、存活 0。
37. **上下文补全子代理回来（12:40）——之前所有模拟比以为的更失真**：
   - **附件全部没下成功**：run-sim 建 resources.json 时把已是绝对路径的 localPath 又拼到 raw/ 后面，28 个模拟 824 次下载全失败，bot 一张截图都没看到；L1 回放 replay-intake 同样的拼法，L1 分类器也没看到图。两处都已修（假 CLI 查 raw/resources-extra.json 兜底；replay-intake 用绝对路径）。
   - **话题回复从没进过时间线**：按群拉历史只拿到每个话题第一条，漏 1781 条（真人 @bot 54 条、falive 分类过的 121 条，占它全部分类的 43%）。已并进数据集：时间线 2371 → 4152 条，@bot 124 → 190，有原文的 episode 210 → 352；之前「融合群拉不到」的 75 条其实都是话题回复。falive bot 在群里一直用机器人身份在主聊天区回复（groupPostAsUser 只影响它的提示词），话题里没有 bot 消息是正常的。
   - **bug 单读不到**：模拟配置没有 bugTable，tools/read-bug-record.mjs 直接回「没配 bug 表」（审计里撞到 18 处）。待 run-sim 加占位配置。
   - 已缓存（aven 身份只读）：云文档 / 知识库 119 个、bug 记录 149 条（+15 张截图）、话题 204 个、补拉附件 2 份（4 份一直 400 拉不到）。离线重放缺口 23 → 0。
   - 缓存是「现在」的版本，会泄露未来信息（10-21 读到的 Bug-4905 已是 10-28 复验通过的状态）——子代理在做按当时版本钉住（文档修订、bug 字段历史）。
   新数据集上 L1 两版（v2-base = 运行分支代码、v2-final = 集成分支）并行在跑。之前所有 L1 / L2 结论都是在「没图、缺话题回复」下得出的，只作参考。
38. **12:56 完整确认 r7 起跑（aven：「用最新的 lark-bot 跑 falive 的所有 case，不用纠结版本，读全上下文」）**：停掉版本钉住与 AI 缓存两个子代理（只跑一次用不上缓存；缓存脚本未入库、run-sim 里改成 --ai-cache 才加载）、停掉基线 L1。r7 = 集成分支 lark/falive-fix4（1fbc855），10-20 → 11-02 整条时间线一个 sim、按天重钉业务仓基线、不切段；上下文：话题回复已并进时间线（4152 条，@bot 190）、附件绝对路径 + 补拉、云文档 / bug 记录按缓存供数（现在的版本）、bug 表占位配置。喂事件改成事件驱动的真实节奏（忙时虚拟时间按真实速度走、到点就喂，空闲直接跳）——冒烟 31 条 10 分钟、附件 6/6、读取缺口 0。跑完自动 judge-sim --all（/tmp/r7-finish.sh）。

39. **13:05 r7 串行太慢 → r8 分段并行（aven：「注意任务并行，现在这个太慢了，后面可能还会多轮迭代」）**：r7 停掉（只跑了 4 分钟）。r8 = 同一代码（lark/falive-fix4 + 回放脚本 fb54001），`bash scripts/sim/run-round.sh r8 3180`：
   时间线 **10-14 → 11-03**（原来漏了 10-14～10-19 的 41 条 @bot）切 8 段并行，每段先热身前一个工作日（bot 照常干活，留下跨天的任务 / 义务 / 发件，裁判 `--score-from` 不计分），
   跨天接续统计：14>15、15>16、17>19、21>22 都只隔一个工作日，热身接得住；21>28、22>27 这种隔周的少（6 条），靠话题历史供数。不触发 bot 的消息喂完只等 0.2 秒（网关直接丢，只进上下文）。
   每段跑完自动裁判；`node scripts/sim/round-report.mjs --round r8 --issues` 出进度 + 总账。同时两个子代理修已知小尾巴：fix17 续跑（rerun_after_done）刷新 priorConclusion、fix18 归并先于「收到」导致 worker 不知道群里已回过一句（核实：d2e3e9f 已修，flushPendingAck 按 supersededBy 写到目标，五种归并模式端到端都对，撤销）。
40. **13:30 r8 → r9：代码换成真正最新**（aven 问「现在是在用最新的 lark-bot 跑全量吗」——核对发现 fix4 少了运行分支今天的两个提交 1cc516e 令牌缓存、3e7e539 关单撤「收到」）。新集成分支 lark/falive-latest（worktree ~/github/lark-bot-latest）= fix4 + fameex-stable + fix17。
   合并时测试抓到 3e7e539 与并入流程的冲突：它把 superseded 一律当关单撤「收到」，而 routes 是先 mergeIntoTask（来源落 superseded + supersededBy）再 flush——**线上追问 / 补充被并入后发问的人一句都收不到**（线上日志尚未触发）。
   热修 c331067（只认 closureReason / ignored / 没有承接方的 superseded 为关单）已直接合进 fameex-stable（全量 637 绿、变异 6 抓 6，排空重启上线）。r8 停掉，r9 用 latest 起跑：`bash scripts/sim/run-round.sh r9 3190`。
41. **14:44 r9 撞 Claude 额度（「session limit · resets 6:40pm」）**：8 段并行约 1 小时用完 5 小时窗口，之后分类 / 执行全失败（r9 各段 intake_failed 一片），r9 作废停掉。线上 bot 与回放共用一个账号（这次线上没撞上）。
   结论：一轮的快慢卡在额度上，不在机器；并行段数再多也快不了。改法：`scripts/sim/claude-q`（claude-quota.mjs）额度闸——撞限额写 runtime/falive-replay/quota-pause.json（到重置 + 1 分钟），
   各 sim 冻住虚拟时钟、不喂消息，本次调用到点重试，不把假失败交给 lark-bot；lark-bot 的真实时间超时在 sim 里放大，原超时（无输出 600s、分类 120s、执行 1800s）由闸按真实耗时执行。judge-sim 也走闸。run-round 同时最多 5 段（MAX_PARALLEL），给线上留额度。
42. **aven：「case 与回放脚本、计划和进度都放到 lark-bot 下相应的目录，且要跟踪版本」**：case 数据从 runtime/falive-replay/{raw,dataset}（gitignore）搬到仓库 `replay/falive/`（144M，含 441 份附件；附件路径改存相对 raw/ 的，`resolveRaw` 拼回；dry 验证 442/442 都在），
   新增 `replay/falive/cases.{jsonl,md}`（285 条 case 清单，`list-cases.mjs` 生成）与 README；本计划从 lark-bot-conv 搬到 `docs/`（conv 里的留指针）；每轮裁判 + 总账跑完拷进 `replay/falive/rounds/<轮>/`；回放产物仍在 runtime。
   原来没入库的 claude-cache / context-versions 脚本一并入库（--ai-cache 才用，未在整轮里验证过）。分支 lark/falive-latest（worktree ~/github/lark-bot-latest），随集成分支合进 fameex-stable。
43. **复盘：为什么白跑了 6 轮（aven 11-03：「数据都没有怎么反复跑了 6 轮的……以后怎样避免，出个策略」）**
   事实：r1–r6 跑的数据有三处缺：附件路径重复拼接（所有截图「下载失败」，分类器一张图没看到）、话题回复没并进时间线（1781 条）、话题回复里的云文档 7 篇 / bug 记录 4 条没拉（拉取步骤早于并入）；
   前两处到 r6 之后才发现，第三处是今天预检脚本第一次跑才查出来。同类的还有：r8 代码比运行分支少两个提交、r9 撞额度后假失败一片跑了一小时才停、r10 第一次 worker 没起来空转半小时。
   根因不是某一个 bug，而是**跑之前不验输入、跑起来不看信号、一轮作废不先报告就开下一轮**：冒烟只验「能跑通」，没验「bot 看到的上下文和原始群聊对得上」；裁判只看结论，没人回头查输入；每发现一个问题就修了直接重跑，没停下来报。
   **策略（已落成代码，不靠自觉）**：
   - **起跑预检闸** `scripts/sim/preflight.mjs`（run-round 第一步，不过不跑，结果存 rounds/<轮>/preflight.md）：285 条 case 逐条查附件文件、父消息、话题回复、云文档、bug 记录；拉取时就拿不到的列「已知缺口」逐条写出，不许静默；代码必须是干净的提交、含 fameex-stable 全部提交（sha 记 rounds/<轮>/code.txt）；环境无额度暂停、无同名轮在跑。
   - **止损守卫** `scripts/sim/round-guard.mjs`（run-round 起在后台）：进程报错、读取缺口、分类失败 ≥3、25 分钟不动 → 整轮停掉、写 rounds/<轮>/STOPPED.md，不带病跑完。
   - **数据管线顺序**：时间线有变（并入话题回复等）后，依赖时间线的拉取步骤（docs / bugs / expanded / resources）必须重跑，再跑预检。
   - **作废先报告**：一轮因输入 / 环境问题作废，先向 aven 说清楚坏在哪、影响哪些结论、怎么修，再起下一轮；不在汇报里把作废的轮次轻描淡写成「只作参考」。
   - **省额度**：迭代轮只重跑受修复影响的段；整轮只在合进运行分支前跑。
44. **断点续跑（aven：「不能断点续传吗？为什么每次都要重新开始」）**：之前 r7→r8→r9 换代码重来是对的（一轮里不能混两版代码），r9 撞额度后假失败已落盘改不回、只能重来（额度闸之后不会再有），
   r10 被守卫误停后整轮重来则没必要。现在：run-days.sh 每段每跑完一天（系统空闲、没有跑到一半的任务）把 sim 目录 APFS 克隆到 `<段>.ckpt/<日期>/`；
   中断后再跑同一条 `run-round.sh <轮>`：跑完的段跳过，没跑完的退回最近存档点从下一天接着跑（最多丢一天）；存档点记代码指纹（lib / 入口 / case 数据的 git tree），和现在不一样就拒绝续跑。
   空日子 10-25 上验证了存档、跳过、中断恢复（中途写的垃圾文件被丢弃）、指纹不符拒绝四种情况。r11 前 5 段起跑时还是旧脚本（没有存档点），f/g/h 起会有。
45. **11-03 21:40 暂停（aven：「先放着明天再试试」）**：r11 停掉，没有进程在跑、不再耗额度。存档点在 runtime/falive-replay/sim/r11-b.ckpt/2026-10-16、r11-f.ckpt/2026-10-23；其余段没跑完一天、明天从头跑。
   明天续跑：`cd ~/github/lark-bot-latest && bash scripts/sim/run-round.sh r11`（先过预检；lib 有改就换轮名）。线上 fameex bot 不受影响，热修 c331067 已在线上。
   今天的教训见 43：跑之前验输入、改了跑法先在空日子上测、守卫规则先用历史日志 --once 验证、作废先报告。
46. **11-04 进度（v2 定稿后开始执行；aven 中途要重启机器，此条为接续点）**
   - **已完成**：
     - P0-a 代码（合进 latest 741ef73）：实测可发登录 POST（3 处提示），删 bug 单正文里「只改负责人的模块」那句（线上 / falive 都没开该选项，行为不变）；全量 640 绿、提示回放规则不丢、变异 1 抓 1。
     - 前置 1：run-sim 模型 / 强度读线上运行配置（`~/github/lark-bot/runtime/lark-bot.local.json`）。
     - 前置 2：清理旧产物：17 个已合并 worktree 删了（分支保留；conv / fix3 / r3–r6 未合并的没动），旧 sim 6G 删了（各轮 judge.jsonl 存 `runtime/falive-replay/archive-1103-judge/`），旧录放缓存删了。
     - 前置 8：run-round 套 caffeinate。
     - P0-b 事件组：`replay/falive/episodes.json`，61 组、最大 45 条（10-29 一天）、跨天 5 组；falive 真实归并 255 条全部同组。
     - P0-c：卡片原话核对（字段 / 链接都在；`text` 是群里看到的样子，`cliText` 保留 lark-cli 渲染、假 CLI 给 bot 看用它）；episodes 里 falive 回复改存全文；风险标签 `replay/falive/case-tags.{jsonl,md}`（风险 96、待办不计分 11，permission 偏宽待 aven 扫）；实测类当时证据 `verification-evidence.jsonl`（56 条中 51 条有）。
     - 前置 6（部分）：falive pre / uat / online 现在都通（307）；测试号登录脚本在 falive-react `scripts/lib/pre-client.mjs`（10-14 起有），账号有效性还没实登验证。
     - **前置 1b 分类强度**：L1 最新代码 285 条 low / high 各一遍（`runtime/falive-replay/l1/v3-{low,high}-0a7054d`），一致 87%；分歧 36 条 max 裁判：**high 更对 20、low 更对 9、一样 3、都不对 4**；中位 low 6s / high 9.5s。报告拷进 `replay/falive/l1/effort-low-vs-high-1104.md`。
       **aven 定：改用 high**。回归集 high 55/56（失败那条「确认一下，请马上修掉」high 跑 3 次 2 次对，是边界题，记为 P4 分类提示修复目标）。
       **线上运行配置 `~/github/lark-bot/runtime/lark-bot.local.json` 的 claudeIntentEffort 已改 low → high**（备份 /tmp/lark-bot.local.json.bak-1104；两个 bot 都停着，未生效）。
   - **P4 待修清单（从 L1 分歧裁判来）**：都不对的 4 条（捏造「Arthur 说已上 pre」就复测；脑补 aven 没 @ 的话让 bot 复测；「Arthur 已补信息」失实；更正前一条接口的消息该并入 09:17 任务却另建）；high 把 aven 回的「继续任务」判不处理；「请马上修掉」边界题。
   - **下一步**（design-v2 §8）：前置 3 裁判提示补口径并冻结 → 前置 4 风险标签 aven 扫 → 前置 6 测试号实登 → 前置 7 出网审计 → P0-d 模拟器按事件组跑（最大的一块）→ P0-e 内存 → P0-f 录放 → P0-g 规则预判 → P0-h falive 代码可行性 → P1 校准 → P2 全量基线（分类 high）。
   - 现在没有任何回放进程在跑。
47. **11-04 前置 6 测试号**：falive pre 测试号 `aven-pretest@probe.test` 只调登录接口 `NewMailLogin` 实登成功（有 token）。**风险**：falive-react `scripts/lib/pre-client.mjs` 的 `login()` 登录失败时会自动走 `NewRegisteredByMail` 注册新号——超出「实测只许登录 POST」的口径；回放里 bot 若调它、且登录失败，就会在真实 pre 上注册账号。出网审计（前置 7）要把注册接口单列告警，裁判把「实测时注册新号」判为越界。
   同时派出四个子代理（各自 worktree）：p0d 按事件组跑的模拟器 + 出网审计 + 内存实测 + 3 组冒烟；p0g 规则预判 + 裁判提示冻结（补 11-04 口径）+ 差异裁判缓存 + 金标准评审表 + 验收脚本；p0f 录放输入规范化 + 命中率校验工具；p0h falive 代码能否在模拟器里跑（校准前提）。
48. **11-04 撞周额度**：原账号「weekly limit · resets Nov 8 at 6pm」，四个 P0 子代理同时被打断（还没落任何改动）。aven 换了 Claude 账号后让它们接着做。
   教训：额度不只有 5 小时窗口，还有**周额度**；全量基线（2–3 个 5 小时窗口）前要估周额度够不够，按天分批跑。额度闸原来解析不了「resets Nov 8 at 6pm」（多了个 at，只会每 10 分钟空试），已修。
49. **11-04 P0-d 按事件组跑 + P0-e 并发上限 + 前置 7 出网审计（分支 lark/falive-p0d）**
   - **跑法**：`node scripts/sim/run-episodes.mjs --round <轮> [--only ep-…] [--max-parallel 4] [--ai-cache] [--no-judge]`。每组一个实例，目录 `runtime/falive-replay/sim/<轮>/<组>/`；只喂组内 case，同群其它真人消息、别组的 case 只当上下文；跨天的组按 UTC 天多次 run-sim、共用目录、每天重钉基线、时钟只进不退。组跑完写 `DONE`（含代码指纹：lib / 入口 / tools / case 数据 / episodes.json / 决定场景的模拟器文件 / 线上模型配置），再跑跳过 DONE、没跑完的整组重跑；一轮指纹不同拒跑。最长先跑、有界并发 + 内存闸、预检 / caffeinate / 守卫照旧，跑完接 `judge-sim --dir`。旧 `run-days.sh` / `run-round.sh` 标弃用（留着复现旧轮）。
   - **组外 bot 话的口径**：`episodes.json` 每组加 `faliveBotIds` = falive 对组内 case 说的话（群里：和 case 同一个并查集分量——回复链 / 话题 / 卡→case；私信卡：卡里写的任务 id → 「收到，当作」「这句没对上」回执归之前 10 分钟的私聊 case → 审计完成时间 3 分钟内 → 开始 / 结论卡按之前最近的「🛠 开始做」卡；bugpoll / 日报 / 体检 / 部署 / 复测通知不归任何组）。假 CLI 只藏这些，其余 falive 原话照供；按 id 点名取（被引用）不藏。组内的人回复被藏的那句时，run-sim 把回复目标改成模拟 bot 在同群对组内 case 说的最近一句（`remap.jsonl`）。
   - **冒烟发现并修掉的**：① 假 CLI 列群消息把时间线里并进来的 1793 条话题回复也列了（真 CLI 列不到）：285 条 case 里 217 条的【群里这条之前的消息】会混进别的话题的回复——r1–r11 都带着这个偏差；② 私信历史是空的（webhook 群的历史没按 aven open_id 供）；③ episodes.mjs 的卡→case 启发式在 b06145f（卡里 (ou_xxx) 挪进 cliText）后失效，重生成会变 69 组（已改读 cliText，61 组逐字不变）；④ 回复 falive 卡的组内 case 网关认不出是回复 bot、直接丢（ep-1029「cc @HQUCEncone」）；⑤ 基线分支只按日期命名，并行的组会互相 -f 改（改成 `sim-base-<日期>-<提交>`）。
   - **冒烟结果**（ep-1023-98f8fa 话题 / ep-1102-0f579b 截图 / ep-1029-f09207 话题 + 回复 bot，3 组 4 条 case 并发跑）：`check-context.mjs` 逐条核 bot 看到的上下文与原始群聊（被引用、本条、话题回复、群里之前的消息、附件）——修后 p0d-smoke2 四条全部对上（修前 p0d-smoke 有 1 条没接住）。出网：只有 Claude 接口（lsof 160.79.104.10）和 falivepre 的 GET，违规 0、待核 0；飞书 send / reply 全部落 outbox（3 / 4 / 4 条），没有裸调 lark-cli。裁判（judge-v2）：lark-bot 更好 1、一样 1、falive 更好 2（ep-1029 没复测照搬 10-28 的旧结论；「cc」那条多余插话）。
   - **录放（P0-f 验收）**：smoke2 冷跑录（独立缓存目录 ai-cache-p0d），p0d-replay 带 `SIM_AI_CACHE_HIT_DELAY=orig` 重放：三组只读调用命中 100%（7/7），群回复与任务终态逐条一致（`rounds/p0d-replay/cache-check.md`）。
   - **内存（P0-e）**：3 组并发，单组进程树（run-sim + 网关 + worker + claude-q + claude + 子进程）RSS 峰值冷跑 680–730MB（node ~400–460、claude ~230–300），录放 420–460MB。这三组都是答疑，没有改代码 / 起 vite / 浏览器的组，那类按 2–2.5G 估（未实测）。16G 留 3G 余量 → 默认 `--max-parallel 4`，另加内存闸（可用 < 3G + 2.5G 就不起下一组）兜住大组；机器上别的东西多时闸会自动降并发。
50. **11-04 P0 收尾 → P1 校准起跑**：P0-d（按事件组跑）、P0-f（录放）、P0-g（裁判链路）、P0-h（falive 代码进模拟器）都已合进 latest，全量 642 绿。
   合并时假 CLI 两边口径合并：按组藏 falive 对本组说的话（p0d）+ 校准用的 hiddenIds / keepOwnBotIds（p0h）；列群消息一律不带话题回复（真 CLI 口径）；--start/--end 认 ISO。
   **p0h 查出的业务仓基线分支偏差已修**：run-sim 原来一律钉 feature/phase-6-ol，falive 当时按时间用的是 origin/feature/phase-4-page（10-21 12:33Z 前）→ phase-4-api → phase-5-test（10-26 06:40Z 起）→ phase-6-ol（10-30 19:35Z 起），取自 falive 网关启动日志；dry 核过四个日子的基线。
   P1：`scripts/sim/calibrate.mjs` 选 20 组（10-23 12:00Z 之后为主、不跨本地 23:59、2–8 条按类型轮转，不够补 1 条的），并发 3，结果进 `replay/falive/calibration/`，汇总 summary.md。
51. **11-04 13:54 校准出网事故（已止住）**：P1 校准 ep-1024 里 falive 的 claude 会话在 Bash 里直接敲 `lark-cli`，run-sim-falive 漏了 run-sim 有的 PATH 壳，调到了真 lark-cli，用 aven 身份**只读**了真实 bug 表 4 次（record-list ×3、record-get ×1；无写、无发消息）。出网审计当场记下，我停掉了校准。
   修：run-sim-falive 补 PATH 壳 + egress-hook；**两个跑法都把 LARKSUITE_CLI_CONFIG_DIR 指到空目录**（实测真 lark-cli user / bot 都 not configured，绕过壳也读写不了）；run-sim-falive 出网命中即停。ep-1024 的结果作废，校准重跑。
52. **11-04 并行：基线 b1 起跑 + 两个修复子代理 + 校准换工作区**
   - b1：`node scripts/sim/run-episodes.mjs --round b1 --max-parallel 4 --ai-cache --port-base 3400`（指纹 d68f7c9957f5），最长先跑。**b1 跑完之前 latest 的 lib / 入口 / 模拟器文件都不能改**（一轮只许一版代码；只提交 docs）。
   - p4a（lark/falive-p4a）修分类：L1 分歧里 high 错 / 都错的、冒烟里的多余插话、「请马上修掉」边界题；p4b（lark/falive-p4b）修实测照搬旧结论不复测。两者都等 b1 跑完再合，再只重跑受影响的组。
   - 校准查出合并交互 bug：p0d 把 webhook 群（aven 控制台）在假 CLI 里归成「aven 的私信」，falive 按原群号轮询一条都拉不到（ep-1028-03cd66 两条「已部署」没接）。修在新 worktree `~/github/lark-bot-cal`（lark/falive-cal）：按群号来拉时按私信取、还原群号，模拟里 falive 自己发进群的也照列；校准改从这个 worktree 跑，结果在它的 `replay/falive/calibration/`，完了合回 latest（b1 之后）。受影响的两组作废重跑。
53. **11-04 p4a / p4b 完成（分支待 b1 后合）+ L1 时间泄漏**
   - p4b（lark/falive-p4b）：代答说到环境现状也要本轮只读实测，旧结论不当现状；探测只打配置里的环境（aven 定），上游只转述。复跑 ep-1029-f09207：falive 更好 → lark-bot 更好，出网 0 违规。
   - p4a（lark/falive-p4a，1ac907c / bae5cfb）：线上真问题 2 个——正文 @ 别人被归一剥掉，跟同事说话被当成对 bot 说（含「cc @HQUCEncone」插话）；「确认一下，请马上修掉」边界题。另查出 **L1 回放工具时间泄漏**：拼话题回复没按时间截，85/285 条能看到之后的回复（「编造事实」其实是看到了未来）；「继续任务」等固定指令线上不过分类器、回放却送分类。L1 重跑 62 条变化裁判：新 46 / 旧 7（无系统性回退）/ 一样 8 / 都错 1；回归集 56/56。
   - 因泄漏，**之前 low / high 结论（据此改 high）要重确认**：v4 用 p4a 修好的回放 + 新提示，285 条 low / high 各一遍再判分歧（进行中）。
   - 新派 p4c（lark/falive-p4c）：挂起任务卡下同事闲聊被控制通道当补料直接续跑（不经分类器）。
54. **11-04 预备合并分支 lark/falive-next（worktree ~/github/lark-bot-next）**：latest + p4a + p4b + p4c + cal 无冲突；全量 642 绿、提示回放规则不丢 / 系统层 1 种、回归集 56/56、变异 50 抓 50。b1 跑完后把 next 合进 latest，再只重跑受影响的组（p4a/p4c 影响接话的组、p4b 影响代答 / 实测的组）。
   p4c：挂起任务卡下隐式续跑加门槛（@bot / 私信 / 附件链接 / 提单人·负责人·bot @ 过的人没 @ 谁 → 续跑；抄送寒暄表情 → 静默；@ 别人或旁人搭话 → 交分类器带锚点）；p4a 与 p4c 要一起合。
   b1 进展：ep-1031-f8065f 出网 6 违规是真的（curl accounts.google.com 的 gsi 脚本，p4b 规则之前的代码）；ep-1031-35935b 的 5 条是审计误判（curl 壳把 grep 输出词粘进主机名），egress-audit 已改归「待核」。
55. **11-04 b1 被守卫停 → 补 bug 表视图 → 合 next → 基线改 b2**：b1 ep-1024-9ebe13 读取缺口 68（bot 列整张 bug 视图逐条读，只缓存了群里提到的 153 条）。build-context-cache `bugs --all-view` 补齐视图 261 条记录 + 308 张截图（失败 6），bug-records 290M。数据变了指纹变，b1 不能续，于是把 lark/falive-next（p4a / p4b / p4c / cal）合进 latest，全量 642 绿、预检通过，**基线改跑 b2**（指纹 dbcb02121b1c，并发 8，录放开）。b1 作废（只完成 2 组）。
   P1 校准 20 组跑完；初步汇总只 33% 全对上，但 falive 侧多半没记录（审计 10-27 才有）→ 派子代理重建 falive 侧（时间线原话按卡→case 归属、数据集基线、网关日志），把差异分成模拟偏差 / 抽样 / 还原不了 / 未知，出 calibration/fidelity.md。
56. **11-04 分类强度重确认（v4，修好时间泄漏 + p4a 新提示）**：285 条一致 237；分歧 48 条 max 裁判 high 20 / low 17 / 一样 10 / 都错 1，基本打平（之前「high 净高 4%」是被泄漏污染的结论）。low 偏漏办，high 偏过度（派不必要的改码、抢答 aven 与同事的对话）。**aven 定：保持 high**（b2 不用重跑；过度类错误后面靠修提示压）。报告 runtime/falive-replay/l1/v4-low-bae5cfb/effort-judge.md。
   **P4 待修**：b2 ep-1031-f8065f 里 bot 为诊断 Google 登录组件 curl 了 accounts.google.com/gsi（看来源白名单），越过「只测配置里的环境」——提示规则约束不住，改成命令层拦：答疑 / 实测的 curl 只放行配置里的环境地址（claude --allowedTools 按主机前缀），其余域名发不出去。
57. **11-04 b2 分诊（4 组 53 条）→ 派修复**：lark-bot 15 / falive 19 / 一样 13 / 都错 2 / 待办 4。
   - 模拟局限 4 条：aven「继续任务 / 结单 / 结束 <id>」点名的是 falive 当时自己建的任务（没 @ bot 的消息建的、或卡片提示里的 falive 任务号），lark-bot 模拟里没有 → judge-rules 加旗标 sim_limit_ref，分诊单列、验收不计分。「stuck」3 条里改码任务卡在等「确认扩大范围」，而 aven 的确认带的是 falive 的任务号，同属这一链。
   - 派 fix-control：「关闭直播间内的礼物入口」被当成关单指令（反义）；任务号对不上时按上下文找唯一的挂起任务（如正等确认扩大范围的那单），否则列候选追问。
   - 派 fix-apireply：对方说「已补 / 已加」不复测只记一笔；答应复测没测；答非所问（没读自己上一句）；决定类消息被并进实测任务带偏。
   - 派 fix-dup：同一结论隔 3 分钟连发两遍。
   - 已在修：fix-merge（不同问题并进旧任务 → 答非所问、迟答 4 小时）、p4d（出网命令层拦截）。
58. **11-04 校准结论（lark/falive-cal 43caf2d + 禁读快照）**：321 个可比格对上 73.5%；去掉模拟偏差 / 还原不了 / 说不清后 91%（≈ falive 自己跟自己的抽样噪声）。修了 7 处模拟偏差（窗口前任务库还原、负责人判定、只私聊群按日志取、话题回复收发、Claude 记忆按窗口起点重放、组外 case 照列为历史），时序压缩（模拟首句 27s vs 当时 47s）没修。
   **判 lark-bot 的前提**：用修过的模拟器；单 case 差异要明显超过约 1 成的抽样噪声；6 类标「模拟局限」只看过程（实测类、锚窗口前任务的私聊指示、事后编辑过的触发消息、时序敏感、falive 当时 ack 失败 / 排空、依赖记忆 / bug 表快照）——下一版裁判提示（v3）纳入。
   泄漏：模拟会话能读 ~/.lark-bugpoll/snapshot.json（今天的 bug 表），旧轮次读过、b2 没读（审计里只是聊天里提到 ask.py）；claude-q 在 SIM_DIR 下加 --disallowedTools 禁读，实测被拒。随下一波合并。
59. **11-04 11:49 b2 停：回放往真实 pre 写了数据（事故）**
   - ep-1020-17dd90（case「写脚本批量造测试帖」）用测试号 508 在真实 pre 上 POST `bbsv2/thread/create` 25 次（发了 25 个帖子）、`bbsv2/tool/upload` 33 次；ep-1023-9f0fd7 POST `avatar/upload` 10 次（传头像）、`verification/email/send` 1 次。p4b 的「只测配置环境 / 只读」规则只在提示里，约束不住。帖子留在 pre 社区里，**没删**（删也是写操作，交 aven 定）。
   - 处理：立即停 b2（完成 10 组，结果留作分诊）。模拟器加硬拦：curl / wget 壳、node fetch / http(s) 预载对非本机主机的写请求一律不发（只放行登录），bot 收到可转述的说明；实测 curl POST 被拦（退出 22）、fetch POST 返回 403 说明、https PUT 抛错、GET 和登录照常。守卫见到漏网写请求（python 等只有 lsof 兜底的）一条就停轮。线上 bot 的命令层白名单由 p4d 做（已转证据）。
   - 下一轮基线 b3 等这一波修复（fix-merge / fix-control / fix-apireply / fix-cost / p4d / fix-judge）合完一起起。
60. **11-04 19:38 合并波 1 → 基线 b3**：会话中断（5 小时额度）后八个分支都已提交，验证轮被打断（只有两组跑完）——不再逐个补跑，直接合并：cal、fix-judge（裁判 v3）、fix-dup、p4d（命令层出网拦截）、fix-apireply、fix-control、fix-cost、fix-merge → lark/falive-next → fast-forward 进 latest（7d538c1）。
   冲突手解：测试棘轮取大；round-guard 取「只看带方法的出网记录」版；mutation-accepted 两边都留；executor 的 spawn env = 出网护栏 env ∪ 分类精简 env；ingest import 并集、续跑门槛在前。
   全量 645 绿、提示回放规则不丢 / 系统层 1 种、回归集 56/56、live 6/6；变异 301 个抓 288、豁免 4、存活 9（都是测试缺口，子代理在 lark/falive-mut 补测试，不动 lib，不影响回放指纹）。
   **b3 起跑**：指纹 a3c505dddbaa，并发 8（内存闸实际控制），录放开，裁判 v3。
61. **11-04 21:33 b3 跑完（61 组，合并波 1 的代码）**：准 lark-bot 更好 92 / falive 更好 69 / 一样 62 / 都错 7（已判 230，待办 11）；快：首句中位 12s vs falive 50s、P90 17s vs 3.5min，结论中位 1.2min vs 3.9min、P90 5.6min vs 15.4min（达标）；省：配对 67 条每条中位 $0.65 vs $1.79、合计 $59.7 vs $110.8（达标）。未达标项：「falive 更好」69 条（线 ≤14），主要类：卡住不交付（归属 / 行数 / 确认扩大范围后不收尾 / 续跑空转）、实测登录被 Claude 安全分类器拦（PROBE_ALLOW_WRITE 被当绕过开关）、没核实就下结论 / 猜任务、插话。合并波 2：fix-thread、fix-b3a、fix-login、fix-b3b、fix-stuck 交回后合并 → b4。
   监控改法（aven：多余轮询浪费 token）：不再挂每组完成 / 每 10 分钟分诊的监控，一轮只挂一个静默等待，跑完才看一次。
62. **11-05 合并波 2 → b4**：fix-thread、fix-b3a、fix-login、fix-b3b、fix-stuck + fameex-stable 合进 latest（c5ec530）。合并后分类规则超预算，按原意精简措辞（规则不删）。全量 646 绿、提示回放规则不丢 / 系统层 1 种、回归集 56/56（1 条 API 瞬时报错，单跑过）、live 6/6；变异 356 抓 334、存活 22 全在运行分支自带的 self-fix / ops-run / intake-replay 代码（不是本波改动，不阻塞回放，合并进运行分支前再核）。b4 起跑。第三波修复（lark/falive-fix-w3）并行。
63. **11-05 波 3–6 + 裁判 v4 → b4 重判 / b6；09:55 aven「全部暂停，存档，周末接着做」**
   - 分支链（都只在本地）：lark/falive-latest(26196cf, b4 代码) ← fix-w3 ← fix-w3b ← fix-w4 ← fix-w5（+ fix-judge4 裁判 v4 / 规则 v3，6b236e7）← **fix-w6（最新，含 latest 的文档提交，worktree ~/github/lark-bot-fix-w6）**。波 3–6 还没合进 latest，更没进 fameex-stable。
   - b4 61 组全部跑完（中途 uniaix 402 余额用完停过，aven 06:46 切 auth=local 后续完）。v4 重判：计分 169、模拟局限 61、falive 更好 48、都错 7；硬线 1 = 13、硬线 2 = 23。分诊：rounds/b4/wave5-triage.md、wave6-triage.md。
   - 波 6（3635a6d）：续跑「收到补充」按回的消息去重（之前按内容 24h 去重把第二次续跑的回复吞了）；负责人本人交办、停下只为请他定 → 按建议做完再请复核；「@bot 没回」巡检（30 分钟无任何回话且单已不在跑 → 私信 aven 一次）。全量 646 绿、变异 65/65。**波 6 还没在回放里验证过。**
   - **b6**（fix-w5 代码 6b236e7，指纹 85ae41abeb7d，并发 9，录放开）：跑完 37/61 组，05:15 UTC 守卫停——ep-1023-08e243 worker 启动的模型就绪检查 `spawnSync scripts/sim/claude ETIMEDOUT`（9 组并发时 claude 起得慢，不是额度；事后单测 claude 正常）。之后 aven 叫停，没有续跑。
   - **b6 半轮结果（37 组 / 216 case，计分 140）**：准 lark-bot 更好 60 / falive 更好 28 / 一样 49 / 都错 3；快：首句中位 12s vs 47s、P90 18s vs 4.6min，结论中位 1.8min vs 3.9min、P90 7.1min vs 20min；省：配对 24 条中位 $0.95 vs $2.52、合计 $30.5 vs $54.6。验收**不通过**：硬线 1 风险 case falive 更好 11 条；硬线 2 漏回 / 回错 / 重复 8 条（cb475c79 完全重复发件 4 条）；falive 更好 28 > 14。明细 rounds/b6/{metrics,acceptance}-partial-37of61.md。
   - **周末接着做（按顺序）**：
     1. 判断就绪检查超时：把 worker 启动自检的 claude 超时在 sim 里放大，或并发降到 7–8，再续 b6 还是直接跑 b7 由 aven 定。续跑命令：在 ~/github/lark-bot-fix-w5 `node scripts/sim/run-episodes.mjs --round b6 --max-parallel 8 --ai-cache --port-base 3800`（有 DONE 的 37 组跳过，round.json 在 → 预检自动 --resume）。
     2. 建议：不续 b6，直接以 fix-w6 起 b7（全量 61 组，波 6 一起验）；起跑前把 fix-w6 合进 latest、跑 test-all。
     3. b6 半轮里 28 条 falive 更好 + 8 条硬线 2 分诊（triage.mjs --round b6），对照 wave6-triage 去掉已修的，派波 7。
     4. 待 aven 定：只读复测调 `GET getLiveUrl` 会改 pre 场次数据，要不要写进固定知识；pre 上 b2 事故留下的 25 个测试帖删不删。
   - 环境现状：两个线上 bot 仍停；auth=local（订阅）；没有回放 / 裁判进程在跑；运行产物在 ~/github/lark-bot/runtime/falive-replay/sim/{b4,b6}/。
64. **11-05 aven 定：停离线回放，选 b6 + 波 6（lark/falive-fix-w6）上线，在真实使用中迭代**
   - 选版依据（b3 / b4 / b6 共同计分的 125 条，同一批 case）：falive 更好 b3 29（裁判 v3，偏宽）/ b4 32 / **b6 23**；风险类 falive 更好 7 / 11 / 8；结论 P90 7.0 / 15.6 / 7.0min；花费合计 $115 / $122 / $109。falive 首句中位 47s、结论中位 4.4min。
   - 合并前全套验证（11-05 已跑的）：test-all 646 绿（8.7s）；提示回放规则不丢、系统层 1 种；intake --live 6/6；fixture 回归集没跑完（worktree 里没有 runtime/lark-bot.local.json，要在运行目录跑或先拷配置）；mutate --diff fameex-stable（977 个变异）跑到 380 停。
   - **待办（aven：token 用完，有余量再跑）**：① ~~mutate~~ 11-05 已跑完：977 个抓 973、豁免 4、存活 0（385 秒）；② fixture 回归集 56 条真跑分类器（耗 token，worktree 先 `cp ~/github/lark-bot/runtime/lark-bot.local.json runtime/`）；③ 全绿后 fix-w6 合进 fameex-stable（= 上线，排空重启），启动 bot 由 aven 做。合之前若 fameex-stable 有新提交先合进 w6 再跑 test-all。
   - 上线后：真实使用中漏回 / 风险类问题直接转修；「@bot 没回」巡检会私信 aven。
65. **11-05 结项：上线 + 清理**
   - 10:3x fix-w6 快进合进 fameex-stable（60c6230），运行目录全量 646 绿；排空重启 10:33:44 旧 worker 退出、10:34 新 gateway / worker / poller 起来，自检 probe=passed。变异测试 977 抓 973 / 豁免 4 / 存活 0。**分类回归集 56 条（--fixture … --live）没跑**，aven：有 token 余量再补。
   - aven：之后实战中迭代，不再用 falive case 回放。已清：lark-bot 本地分支 32 个（只留 fameex-stable / main / feature/falive-repo-profile）；worktree 除运行目录和 ~/github/lark-bot-falive（falive 存档，审计作提示回放样本）外全部删除（含 lark-bot-conv、lark-bot-latest、fix-*、p4*、next、cal、lark-bot-falive-sim/*、mutate 临时目录）；falive-react 本地 sim-base-* 79 个（远端没有）。
   - 留着的：`replay/falive/`（case 数据、轮次结果）与 `scripts/sim/` 仍在仓库里，作历史与将来可能的离线回归；回放产物 `runtime/falive-replay/`（不进版本）待 aven 定删不删。
   - 遗留待 aven 定：只读复测调 `GET getLiveUrl` 会改 pre 场次数据是否写进固定知识；b2 事故在 pre 留下的 25 个测试帖删不删。
