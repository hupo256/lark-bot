# lark-bot 优化升级策略：宿主隔离 + 上下文分层 + 度量（2026-11-01）

> 输入：① 本仓 `docs/agent-context-practices-2026-11-01.md`（对照《Claude Code 第二阶段 8 个卡点》给出的 A–F 六组建议）；
> ② 另一会话的读书笔记 `~/.ai-rules/labs/reading/2026-11-01-claude-code-web-frontend-best-practices.md`（官方口径修正 6 处：同名 Skill 个人压项目、
> CLAUDE.md 存在时 AGENTS.md 不被加载、MCP 工具搜索默认开启、硬约束用 permissions deny 而不是提示词等）；
> ③ 本机实测（claude 2.1.289）与 falive 线 10-24 → 10-31 的 192 份真实审计。
> 本文是**执行计划 + 验收口径**；每步做完回填 §5 的实测结果。

## 0. 先摆证据：现在的 bot 会话里到底有什么（实测，不是推断）

| 现象 | 证据 | 影响 |
|---|---|---|
| bot 会话挂着 aven 账号的 4 个 claude.ai 连接器（Google Drive / Sheets / Docs / Figma） | falive 96 个实施会话的 `system/init`：40 个 `mcp_servers` 含这 4 个；本机 `claude -p` 探针同样挂上 | 实施阶段是 `--dangerously-skip-permissions`，模型**无需批准**就能写 aven 的 Google Drive / Sheets。到目前一次没用过（`mcp__*` 调用 0 次），但这是暴露面，不是能力 |
| 输出样式、个人 Skill 全进了 bot 会话 | 96/96 `output_style: yolo-chinese`；每个会话 37 个 skill（个人 20 个） | 换到 Mac mini 这些全变，bot 行为变了无处可查 |
| 模型 / 强度来自个人设置 | fameex 配置没写 `claudeModel` / `claudeEffort`，实际 opus-5-5 + high 来自 `~/.claude/settings.json` 的 `model` / `modelSettings` | 同上 |
| 「不 commit / 不 push」只靠提示词 | 提示词写了禁止，命令行没有任何 deny | 探针实测：`--disallowedTools 'Bash(git push:*)' 'Bash(git * push*)' 'Bash(git commit:*)' 'Bash(git * commit*)'` 在跳过权限模式下仍生效，`cd x && git push`、`git -C x push`、`git -c a=b commit` 全拦，`git -c … status` 不误伤 |
| fameex-web 的 `AGENTS.md`（真规范，113 行）没被 Claude Code 加载 | 仓库同时有 `CLAUDE.md`（180 行，泛介绍）；官方口径：有 CLAUDE.md 就不读 AGENTS.md；探针问「上下文里有没有 AGENTS.md」答 no | bot 改 fameex 代码时看不到仓库自己的编码 / 测试 / 高危流程规范 |
| 驾驶规则每次随 user prompt 重发 | 实施提示约 8.2k 字，其中约 5k 是跨任务不变的规则；没有 `--append-system-prompt` | 规则与本轮任务混在一层；无系统提示缓存收益；续会话时还会再发一遍 |
| 工具选择没人量 | falive 1736 次 Bash 里 grep 407 / sed 236 / cat 104 / head 31 —— **约 45% 的 Bash 是在拿 Bash 读文件 / 搜代码**，专用 Read 154、Grep 39 | 文章 §5 的「能用 ≠ 会选」；没有度量就只能凭感觉改提示 |

## 1. 目标（升级后应该成立的事，回放逐条核）

1. **bot 的行为只由本仓代码 + `runtime/lark-bot.local.json` 决定**：会话里没有个人输出样式、个人 Skill、账号连接器；模型 / 强度显式钉在配置里。
2. **四层各归其位**：跨任务不变的「驾驶规则」进系统提示（`--append-system-prompt`，分析与实施共用一份，续会话快照安全）；user prompt 只留本轮（任务、契约、模式边界、结果路径）；项目事实留在业务仓。
3. **一条规则都不丢**：拆层后「系统层 + 用户层」覆盖旧提示的每一行（回放全量真实任务逐行核）。
4. **硬约束硬拦**：不 commit / 不 push 由命令行 deny 保证，提示词只留一句说明。
5. **有度量**：一条命令出「隔离是否生效 / 工具组合 / Bash 代读比例 / 连接器暴露 / 缓存命中」，作为后续调提示的基线。
6. **不改变已验证的行为**：全量单测绿，旧提示里的状态契约、范围契约、根因纪律原样保留；非 claude 执行器（codex / pi / cursor）拿到的仍是一份完整提示。

## 2. 分步实施

| 步 | 内容 | 落点 | 验收 |
|---|---|---|---|
| S1 宿主隔离 | 所有 claude 调用加 `--strict-mcp-config`（不给 `--mcp-config` = 一个都不连）；配置钉了 `claudeModel` + `claudeEffort` 时加 `--setting-sources project`（只读业务仓 `.claude/settings.json`，不读个人 / local 设置），没钉就**不隔离**并告警（防止模型 / 强度静默变成账号默认）；`claudeSettingSources` 可显式覆盖（回滚用）。实施阶段 deny `git push` / `git commit` 四条规则 | `lib/lark-ai-executor.mjs`、`lib/lark-config.mjs` | 单测锁命令行；探针 `system/init`：`output_style=default`、`mcp_servers=[]`、skill 数降到内置 |
| S2 上下文分层 | 新 `buildWorkerSystemPrompt({ verify })`：信任边界、提交边界、Lark 资料规则、编码红线、达标即停、根因分诊、验证策略、页面工具规则、结果字段释义、记忆是线索。`buildTaskPromptParts` 返回 `{ system, user }`；claude 分析 + 实施两阶段都带同一份 `--append-system-prompt` 和 `--exclude-dynamic-system-prompt-sections`（cwd / git status 挪进首条 user，系统层跨任务逐字相同）；只读查询不带系统层；其它执行器拼成一份 | `lib/lark-worker-prompts.mjs`、`lib/lark-worker-run.mjs`、`lib/lark-ai-executor.mjs` | 回放：旧提示每一行都在新 system ∪ user 里；续会话增量提示不再重发规则 |
| S3 项目事实归位 | 业务仓根有 `AGENTS.md` 且 `CLAUDE.md` 没有 `@AGENTS.md` 导入时，claude 提示的「遵守文档」列表加上它并注明「Claude Code 不会自动加载」 | `lib/lark-worker-prompts.mjs`、`lib/lark-work-context.mjs` | fameex 回放任务提示含 AGENTS.md；补救在 fameex-web 侧（`@AGENTS.md`），见 §4 |
| S4 新鲜度 + 视觉分流 | PRD 缓存路径带「抓取于 N 天前」，超 7 天提示以现抓为准；任务带图片附件时明确「先 Read 截图再定位，结论引用截图现象」 | `lib/lark-work-context.mjs`、`lib/lark-worker-prompts.mjs` | 单测 |
| S5 冲突 lint + 分层预算 | 提示词预算按层：系统层 / 实施 user / 续会话 user / 只读 / 分析 / 分类器各有上限；互斥句对表（同一提示里不许同时出现） | `__tests__/lark-prompt-budget.test.mjs` | 测试红即发现 |
| S6 度量 + 体检 | `scripts/lark-metrics.mjs`：读审计 stream-json，出隔离事实、工具组合、Bash 代读比例、连接器暴露、缓存；`lark-bot doctor` 加「AI 执行层」：claude 版本、要用的 flag 在 `--help` 里、模型 / 强度是否钉住、个人设置泄漏、AGENTS.md 遮蔽 | `scripts/lark-metrics.mjs`、`lib/lark-executor-doctor.mjs`、`lib/lark-doctor.mjs` | 对 192 份 falive 审计出基线表 |
| S7 真实案例回放 | 离线：用真实审计里的任务正文重建新旧两版提示，逐行核「规则不丢」、量体积、跑冲突 lint；在线：挑真实历史任务用新命令行真跑 `claude -p`，核 init 事件、结果契约、deny、缓存 | `scripts/lark-replay-prompts.mjs` + 一次性在线脚本 | §5 |

## 3. 刻意不做 / 延后（需要 aven 拍板或要先攒数据）

- **实施阶段放弃 `--dangerously-skip-permissions`、改白名单**（原 B3）：要先用 S6 的指标统计 30 天实施阶段的 Bash 前缀再定名单，否则漏项会多出一类 failed。本批只加 deny，不收白名单。
- **`--bare`**：最干净，但只认 `ANTHROPIC_API_KEY`，fameex 现在是订阅登录（`claude-auth=local`）。切 proxy 后再换。
- **验证命令里的 fameex 安装 / Biome 命令挪回业务仓**（原 A4）：等 fameex-web 把 AGENTS.md 接上（`@AGENTS.md`）后再删 bot 侧的重复，否则删了 Claude 就两头都看不到。
- **意图分类回放集**（原 F2）：fameex 线审计只有 1 条，攒够再建。
- 不接 MCP、不上代码图谱、不砍截图（理由同 `agent-context-practices` §5）。

## 4. 需要在 bot 之外做的（本仓改不了）

1. 上线前在 `runtime/lark-bot.local.json` 钉 `"claudeModel": "claude-opus-5-5", "claudeEffort": "high"`（等于现在从个人设置继承来的值）。不钉，S1 的 `--setting-sources project` 不启用，doctor 持续 warn。
2. fameex-web：`CLAUDE.md` 顶部加 `@AGENTS.md`（或删 CLAUDE.md 只留 AGENTS.md），人和 bot 都受益；做完后 S3 的补丁自动不再触发。

## 5. 实施与回放结果（2026-11-01，分支 `lark/context-practices`，未合进运行分支）

### 5.1 做了什么（对照 §2）

| 步 | 落地 | 与计划的差异 |
|---|---|---|
| S1 | `lib/lark-claude-args.mjs`（从 executor 拆出，executor 体量快照 857 → 829）：`--strict-mcp-config` 全部 claude 调用；钉了模型 / 强度才 `--setting-sources project`；实施阶段 deny `git push` / `git commit` 四条；`validateConfig` 未钉告警 | 加了一条计划外的：`~/.ai-rules/AGENT.md` 章节原来**无条件**从提示里剔掉（假设宿主自动加载），现在只在本机 `~/.claude/CLAUDE.md` 真带着硬规则时才剔，换机器没软链就照常注入 |
| S2 | `buildWorkerSystemPrompt` + `buildTaskPromptParts`；claude 分析 / 实施共用一份 `--append-system-prompt` + `--exclude-dynamic-system-prompt-sections`；只读查询不走系统层 | 回放后补：系统层加「写给人看的字段一律简体中文」（隔离掉个人输出样式后，B1 首跑分析摘要变成英文；历史 58 条分析摘要里本来就有 2 条英文） |
| S3 | `detectShadowedAgentsDoc`：fameex-web 实测被遮蔽 → 系统层点名读 AGENTS.md（只对 claude） | — |
| S4 | PRD 缓存标龄（>7 天标「可能已过期」）；带截图的任务「先 Read 逐张打开」 | 回放后补：截图规则原来只在实施首轮提示里，claude 走「分析 → 续会话实施」时**根本到不了模型**，补进分析提示 |
| S5 | 分层预算（系统层 ≤7.5k、实施 user ≤3.6k、续会话 ≤3.2k、只读 ≤4.8k）+ 4 组互斥句对 + 7 个只许出现一次的块 | — |
| S6 | `scripts/lark-metrics.mjs`；`lark-bot doctor` 加「AI 执行层」（CLI / 参数 / 隔离 / 个人设置泄漏清单 / AGENTS.md / 常驻规则） | 计划外：分析阶段改走 stream-json（`parseClaudeEnvelope` 取末尾 result 事件）——原来分析阶段读了什么在审计里完全看不见，B1 首跑失败时无从查起 |
| S7 | `scripts/lark-replay-prompts.mjs`（离线）+ 一次性在线回放脚本（不进仓） | — |

验证：全量 624 绿（7.9 秒）；变异 `--diff fameex-stable` 107 个点：抓 104、豁免 3（等价 / 只影响展示，理由见 `scripts/mutation-accepted.json`）、存活 0。

### 5.2 离线回放：192 条真实任务（falive 10-24 → 10-31）+ fameex 1 条

| 项 | 结果 |
|---|---|
| 规则不丢 | 296 份提示（首轮 / 分析后 / 续会话），基线每一行都在新版「系统层 + user」里（4 处有意改写登记在脚本 `REWRITES`）；配页面工具再跑一遍同样全过 |
| 系统层跨任务逐字相同 | 1 种（各任务、各模式完全一致） |
| 体积（真实任务均值） | 首轮整份 40.3k → 系统层 6.2k + user 34.9k；续会话 10.5k → 6.2k + 5.0k（**续会话 user 降 52%**）。真实任务的首轮主体是群聊上下文（约 3 万字），规则只占小头，所以首轮 user 只降 13%——省 token 的大头不在规则，在上下文 |

### 5.3 在线回放：拿历史真实任务用新命令行真跑 claude

| 案例 | 原始结果（10 月） | 回放结果（新代码） | 判断 |
|---|---|---|---|
| A fameex 只读「PR-01947 项目进度」 | done，归档 + G5 BLOCK 未补验 | 旧代码 / 新代码各跑一次：两边都 done、结论一致、checks 同为 5 条；新代码 `output_style` default、skill 35 → 17、模型不变；单样本花费 $0.99 → $0.37（缓存写 110k → 34k token） | ✓ 行为不变，宿主依赖已切断 |
| B2 falive「uat / OL 换 Google client_id」 | done，4 个文件 | done，3 个文件（原 4 个中的 3 个），分析 → 续会话实施成功（未回退），HEAD 未动 | ✓ 等价 |
| B1 falive「一期隐藏用户 / 主播等级」（4 张截图，原实施阶段一张没开） | done，4 处 6 个源文件 | 首跑：分析阶段结构化输出 5 次不合 schema 失败（当时看不到分析过程）→ 改分析走事件流、补截图规则与中文规则后重跑：done，**分析阶段逐张打开 4 张截图**，同样 4 处、覆盖原 6 个源文件 + 1，摘要中文 | ✓ 等价；首跑失败原因因当时无事件流已无法复原，修后两次（B1 重跑 / B3）结构化输出都一次成功 |
| B3 falive「侧栏与正在直播图标不一致」（4 张截图） | done，5 个文件（含抽 domain helper + 测试） | done，同一根因、同 3 个核心文件（没抽 helper），分析阶段打开 4 张截图 | ✓ 等价 |

所有在线会话：`output_style` default、`mcp_servers` 0、skill 20（只剩内置 + 业务仓）、权限拒绝 0、无一次 commit / push。
跨任务缓存：B3 分析首轮命中 1.07 万 token（系统层 + 工具定义，B1 之后几分钟内跑），旧口径动态段在系统提示里、这一段每个 worktree 都不同。单样本，只说明「能命中」，不当收益结论。
花费：B1 / B2 / B3 回放 $3.89 / $2.08 / $2.69，原始 $5.66 / $4.23 / $5.55。**不归因于本次升级**：原始跑在 falive 线配置（开着页面验证工具等），口径不同。

### 5.4 度量基线（`node scripts/lark-metrics.mjs --dir <falive 审计>`，96 条任务 / 105 个会话）

| 指标 | 升级前（falive 10-24 → 10-31） | 回放（新代码，6 个会话） | 下一步 |
|---|---|---|---|
| 个人输出样式进会话 | 105 / 105 | 0 / 6 | — |
| 挂着账号连接器 | 41 / 105（Drive / Sheets / Docs / Figma），调用 0 次 | 0 / 6 | — |
| 带截图的任务打开过截图（只计实施阶段） | 21 / 59（36%） | 分析阶段 8 / 8 张（B1、B3） | 合并后用新指标（分析阶段已可见）看两周 |
| 拿 Bash 读文件 / 搜代码 | 876 / 1736（51%） | 23 / 50（46%） | **没改善**：这是模型习惯，不是宿主配置；下一批在系统层加工具选择规则后看比例 |
| bug 记录链接 → 用读记录工具 | 1 / 8（13%） | 无样本 | 同上，先看指标再改描述 |

### 5.5 回放顺带发现、留到下一批的

1. **续会话首轮缓存失配**：分析阶段 `--tools Read,Grep,Glob,Bash`，实施阶段全工具，工具定义不同 → 续会话首轮缓存前缀断开，三条回放实施首轮各重写 7–10 万 token。可考虑分析阶段也给全工具、改用权限规则限写（要先验只读约束不松）。
2. Bash 代读比例（见上表）。
3. 本仓工具：读记录工具使用率低，等合并后积累样本再决定改描述还是改成 Worker 预取。

### 5.6 上线前要做的（本仓之外，需要 aven）

1. 合进运行分支前在 `runtime/lark-bot.local.json` 加 `"claudeModel": "claude-opus-5-5", "claudeEffort": "high"`（= 现在从个人设置继承来的值）；不加则隔离不启用、doctor 持续 warn，其余改动照常生效。
2. 合并：`git -C ~/github/lark-bot merge lark/context-practices`（排空重启会自动上线）。
3. 可选：fameex-web `CLAUDE.md` 顶部加 `@AGENTS.md`。

## 6. 后续增补：新规则放在哪一层（2026-11-03，falive 回放修复批）

按 §1 目标 2 的口径（换一条任务还成立的进系统层，只对本轮成立的留 user），这批新加的提示内容都没进系统层，原因各不相同：

| 内容 | 放在哪 | 为什么不进系统层 |
|---|---|---|
| 附件归属说明（「标『本条』的才是这条消息自己带的，其余是上下文里别人发的」；11-03 falive 回放 r3-c） | 实施 / 分析 / 分诊提示，紧跟 `UNTRUSTED_TASK_INPUT` 数据块之后，只在有非本条来源的附件时出现 | 随数据出现、说明的是本轮附件，不是驾驶规则 |
| 「收到」那句 + 接着的那单结论（`task.priorConclusion`，`buildCarryOverBlock`） | 代答 / 实测模式的 user 层 | 本轮事实；代答 / 实测按只读单趟跑，本来就不带系统层 |
| 「对方要什么本轮就给什么」（`DELIVER_NOW_RULE`：要事实就查出来列，写操作做不了就直说，不写「回头再发你」） | 挂在代答 / 实测两个模式块末尾（user 层） | 是驾驶规则，但这两种模式不走系统层，放系统层到不了模型 |
| 「对接答复就是材料，不把再要文档 / 再确认写成 blocker」（10-31 falive 回放） | 只读分析提示 | blockers 只在分析阶段产出；codex 的分析没有系统层；实施提示总预算（系统层 + user ≤ 9500）已无余量 |

改这几处同样要跑 `node scripts/lark-replay-prompts.mjs --audits <审计目录>`，核系统层跨任务仍逐字相同。
