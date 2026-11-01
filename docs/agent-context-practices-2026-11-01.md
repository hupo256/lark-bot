# lark-bot 提质增效：从「Claude Code 第二阶段 8 个卡点」学到什么（2026-11-01）

> 来源：公众号「脚本之家会员中心」2026-08-23《Claude Code 用到第二阶段，最容易卡在这 8 个问题》（`mp.weixin.qq.com/s/_QUsO9F-K4BcKlh-0AUEVQ`，正文约 9k 字 + 2 张图）。
> 文中引用的同系列 047 / 061 / 062 / 071 / 072 / 073 篇没有给链接、公开搜不到；文末 5 条「文章精选」与主题无关。所以本文的「引用」改为用
> Claude Code 官方文档核对文章的每条说法（[skills](https://code.claude.com/docs/zh-CN/skills)、[CLI 参考](https://code.claude.com/docs/zh-CN/cli-reference)、
> [无头运行](https://code.claude.com/docs/zh-CN/headless)），核对结论标在 §1 的「官方文档怎么说」列。
> **本文只写对 lark-bot（fameex 线，falive-bot 下线后的主力）有用的东西**；每条建议都给出 lark-bot 现在的代码位置、本机实测证据、怎么验收。

## 0. 一句话结论

文章 8 个卡点的共同根因是一句话：**上下文、工具、验证要分层，每层只做自己的事；索引 / 缓存 / 检索结果都是线索，不是真相。**
对照 lark-bot：它在「发现与注入规则」「回源验证」「闸」上已经比文章说的做得多（规则注入是确定性的、预取是回源的、done 有可信度交叉校验），
真正的差距在三处，而且三处都在 Mac mini 迁移时会变成事故：

1. **宿主配置没隔离**：bot 的每次 `claude -p` 都在吃 aven 这台机器的 `~/.claude/settings.json`（6 个 hook、`outputStyle: yolo-chinese`、按模型的 effort 表）、`~/.claude/CLAUDE.md`、`~/.claude/skills/`、fameex-web 的 `.claude/settings.local.json`（133 条 allow）。换到 mini 这些全没了，bot 行为会变但没有任何地方记录「变在哪」。
2. **四层上下文塞在一层**：8.2k 字的任务提示把「驾驶规则」「项目事实」「本轮任务」全放进 user prompt，每次任务重发一遍，既吃预算又没有系统提示缓存；而 fameex-web 的 CLAUDE.md（项目事实）又被 Claude Code 自动加载一遍。
3. **工具给了但不量「会不会选」**：bug 表记录工具、页面验证工具、figma 预取、规则章节——都只做到「能用」，没有一项量过「该用时用了几成」。文章 §5 的 MCP 卡点就是这个：能启动 ≠ 会被选择。

## 1. 文章讲了什么（速查 + 官方核对）

| # | 现象 | 文章给的根因 | 文章的处方 | 官方文档怎么说（核对） |
|---|---|---|---|---|
| 1 | Skill 装了不触发 | 发现 / 路由 / 执行三层只通了一层 | 先显式调用一次，再查 description，最后才怀疑模型；description 写「什么时候用、不适用什么」 | 一致。官方：Claude 只按 `description`（与 `when_to_use` 合计截断 1,536 字符）决定是否加载，正文仅在使用时加载；`disable-model-invocation` 可禁自动触发 |
| 2 | 全局 / 项目 Skill 打架 | 同名 Skill 多个来源 | 一个权威来源；个人习惯放用户级、项目规则放项目级、团队能力走 plugin / 仓库 | 一致且更具体：同名时 **enterprise > personal > project**，`--add-dir` 目录里的同名 skill 加前缀 |
| 3 | 规则写了不听 | system prompt / CLAUDE.md / Skill / 当前对话四层混在一起 | 「复制到另一个项目还成立吗」：成立放全局，不成立放项目，只有某类任务才要放 Skill，只对本轮有效写进当前 prompt | 一致。官方：CLAUDE.md 管「Claude 应始终遵循的项目约定」，持久角色用 output style，每次调用的指令 / 输出格式用 `--append-system-prompt` |
| 4 | 追加 system prompt 后行为变怪 | 把 `--system-prompt`（替换）当 `--append-system-prompt`（追加）；塞互相冲突的约束 | 先 `--help` 核对；只追加安全边界、本轮权限范围、输出格式三类 | 一致。官方补充：替换会丢掉默认的工具指导与安全指令；默认系统提示在对话第一轮记录快照；静态 / 动态部分可用 `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` 切开以命中缓存 |
| 5 | MCP 注册了不用 | 能启动 ≠ 会选择：启动 / 描述 / 任务路由三层 | 四步排障（图 2）：注册 → 进程 → 描述（写「什么时候用、返回后怎么验」）→ 任务给调用理由；工具越多误路由越多 | 一致。官方 `-p` 文档：`system/init` 事件带 `mcp_servers` / `mcp_server_errors`，CI 可据此判「没加载」 |
| 6 | 一套 Skill 换 Agent 失效 | 核心流程和宿主配置绑死 | 拆核心层（清单 / 术语 / 验收步骤）和适配层（工具名 / 路径 / 权限） | 一致。官方：Agent Skills 是开放标准，`name / description / allowed-tools / compatibility / metadata` 是标准字段，其余是 Claude Code 扩展 |
| 7 | 代码图谱越用越错 | 索引是缓存，不是真相 | 先查更新时间和分支；图谱只缩范围，命中必须回源读；写操作再看测试与调用方 | 文章自己的工程判断，官方无对应页；与 lark-bot 的「done 零 diff 不可信」「预取回源」同一思路 |
| 8 | PDF 省 Token 却答错图表 | 文本检索绕过了视觉通道 | 按问题类型分流：条款 / 定义走文本检索，架构图 / 扫描件走多模态，两者都问就两路合并 | 同上，工程判断 |

两张图：**图 1「Claude Code 上下文分层」**——四层各答一个问题：system prompt = 驾驶规则（怎么用工具、怎么拆任务、何时停下确认），CLAUDE.md = 入职手册（技术栈、测试命令、模块边界、禁碰目录），Skill = 操作手册（某类任务的检查 / 修改 / 验证顺序），当前对话 = 本轮边界（文件范围、输出格式、确认条件）；判断标准「复制到另一个项目还成立吗」。
**图 2「MCP 不调用的四步排障」**——注册检查（配置文件存在、CLI 能列出）→ 进程启动（路径 / 运行时 / 环境变量）→ 描述清楚（说什么时候用、返回后如何验证）→ 任务路由（任务给出调用理由、先图谱再回源）；每步失败回查对应层，不先重装。
文末还给了一个只读的 `claude-code-doctor.sh`（列 skill 目录 / 配置文件 / CLI 版本 / `claude mcp list`），思路和 lark-bot 的 `lark-bot doctor` 一样。

## 2. 对照 lark-bot 现状（本机 2026-11-01 实测）

| 文章的层 | lark-bot 现在怎么做 | 证据 | 判断 |
|---|---|---|---|
| Skill 发现 / 路由 / 执行 | 不靠 Claude Code 自己发现 skill：`lib/lark-rule-context.mjs` 按任务信号（UI / COPY / STYLE / API / STATE / MOCK 多标签）**确定性**地把 `~/.ai-rules` 的章节注入提示；`BASE_REFS` 缺失 fail-closed（`VERIFY-RULE-004`）；规则来源 sha 写审计 | `refsFor`、`readRuleRevisions` | **已优于文章**：路由不靠模型猜。差距在「执行层」没体检（见 §3-E） |
| 单一真源 | 代码规则扫描器 `scripts/code-rules.mjs` 是 `~/.ai-rules` 的钉版副本，有漂移测试；`stripAutoLoadedRules` 不重复注入 CLAUDE.md / AGENT.md | `lark-pure` 一致性测试（10-31 刚修过一次 17 行漂移） | 规则层做到了。**宿主配置层没做到**（下一行） |
| 宿主配置隔离 | 无。`claude -p` 默认加载用户级 + 项目级一切 | `~/.claude/settings.json`：hooks `UserPromptSubmit / PreToolUse / SubagentStart / SubagentStop / Stop / SessionEnd` 全指向 `keep-awake.sh`；`outputStyle: yolo-chinese`；`model: claude-fable-5-1`；`modelSettings` 里 `claude-opus-5-5 → effortLevel high`。fameex 配置没写 `claudeEffort`，所以 bot 现在的 effort 实际来自这张表 | **差距最大**。mini 上没有这张表：effort 变默认、输出样式变默认、hook 消失；行为变了无人知道 |
| 四层上下文 | 全部在一个 user prompt 里：`buildTaskPrompt` 8,235 字符（bug / requirement / api / fix 都约 8.2k，只读 4.2k）、分析提示 2,061、分类器 700；没有 `--append-system-prompt`；fameex-web 的 CLAUDE.md（5.6k）由 Claude Code 自动再加载一遍 | 11-01 用 `buildTaskPrompt` 实测；`lib/lark-ai-executor.mjs` 无 `--append-system-prompt` | 差距。每任务重发「驾驶规则」，没有系统提示缓存收益 |
| 工具描述三要素（何时用 / 做什么 / 返回后怎么验） | bug 表记录工具提示句有「何时用」（标题够用就不读 / 要复现步骤截图备注时用）；页面工具规则有三要素；figma 预取是 Worker 确定性做的，不靠模型选 | `lark-worker-prompts.mjs`、`lark-verify-page.mjs` | 描述合格。**没有「会不会选」的度量** |
| 工具集最小 | 只读阶段 `--tools Read,Grep,Glob,Bash` + Bash 白名单；无头去掉 `ScheduleWakeup / Cron* / Workflow / …`；实施阶段 `--dangerously-skip-permissions`（全工具） | `CLAUDE_HEADLESS_DISALLOWED_TOOLS`、`triageReadOnlyBashRules` | 只读侧做对了；实施侧全开但靠终检兜底，可接受 |
| 索引 ≠ 真相 | done 零 diff 降级 failed；AI 自报 changedFiles 与 `git diff` 交叉校验；Lark 文档 / Figma 每次现抓；worktree 基线 `origin/online` 现 fetch；`codeStale / configStale` 自比对 | `assessDoneResult`、`prefetchTaskReferences` | 已优于文章。遗漏两处缓存：`~/.prd-cache`（只读 PRD 缓存，无新鲜度）和共享的 Claude 项目记忆 |
| 视觉 vs 文本分流 | 截图按文件头改真实扩展名给 Read；figma 预取同时落 `spec.md`（文本）和 `preview-*.png`（视觉）；页面工具截图 | #12、`figma-spec.mjs`、`verify-page` | 有通道，缺「什么任务必须走视觉通道」的判据（falive #62 做过强制、#92 因噪音删掉） |
| 排障脚本 | `lark-bot doctor`：进程 / 心跳 / 代码配置落后 / 轮询 / 挂起 / 失败台账 / 自修工单 | `lib/lark-doctor.mjs` | 查的是 bot 自己的健康，**没查 AI 执行层的环境**（§3-E） |
| 度量 | 审计 `.log` 是 stream-json，每次工具调用都在（样本：一条任务 33 次 tool_use，Bash 20、Write 2） | `runtime/lark-audits/<PR>/*-e0.log` | 原料齐全，没有汇总脚本（falive 有 `scripts/lark-metrics.mjs`，fameex 没搬） |

## 3. 适用于 lark-bot 的最佳实践（按文章 8 条归并成 6 组，每条可落地）

格式：**做什么** → 为什么（证据）→ 落点 → 怎么验 → 工作量。

### A. 宿主配置隔离：bot 的行为只由仓库和 `runtime/lark-bot.local.json` 决定（文章 §2 §3 §4）

- **A1 显式钉住 effort 与模型。** 现在 fameex 配置没写 `claudeEffort`，effort 实际来自 aven 用户设置 `modelSettings`（opus-5-5 → high）。→ `runtime/lark-bot.local.json` 补 `claudeModel` / `claudeEffort` / `claudeAnalysisModel` / `claudeAnalysisEffort`（代码已支持，`claudeModelArgs`），并在 `validateConfig` 里把「没配 effort」升为 warning。验：审计命令行含 `--effort`；mini 上跑同一任务 `system/init` 事件里 model 一致。半小时。
- **A2 `-p` 只读项目级设置源，不读用户级。** 用户级 6 个 keep-awake hook、`outputStyle: yolo-chinese`、同步 skills 都不该进 bot 会话。→ claude 命令加 `--setting-sources project`（本机 2.1.289 支持），把 hooks / outputStyle / permissions 的来源限制在业务仓 `.claude/` 和 `--settings`；bot 需要的权限本来就走 `--allowedTools` / `--dangerously-skip-permissions`。注意：`--bare` 更彻底（连 CLAUDE.md、skill、MCP、自动记忆都跳过，官方称将来会成为 `-p` 默认），但官方写明 **bare 模式不用订阅登录、只认 `ANTHROPIC_API_KEY`**，fameex 现在 `claude-auth=local`（订阅 OAuth）用不了；切 `proxy` 模式后可改 `--bare` + `--add-dir` 显式给目录。验：`system/init` 事件 `output_style` 为 default；mini 与笔记本审计命令行逐字一致。1 小时 + 一次 restart。
- **A3 把「驾驶规则」挪进系统提示，user prompt 只留本轮。** 任务提示里每次重发的稳定块（验证策略分级、status 契约、待确认边界、禁区路径规则、「不 push / 不碰 runtime」）属于文章说的 system prompt 层；`-p` 下用 `--append-system-prompt-file <lark-bot>/prompts/worker-system.md`（**不是** `--system-prompt`，那会把默认工具指导和安全指令一起换掉）。收益：这块在对话第一轮记录成快照、跨任务内容相同可命中提示缓存；user prompt 从 8.2k 降到约 4k，提示词预算测试相应下调上限而不是上调。风险：`--resume` 续会话沿用首轮快照，续分析会话时追加的文本不生效（官方「恢复对话中的系统提示词标志」），所以**续会话别改系统提示**。验：`lark-prompt-budget` 新口径；一条任务的审计里 `--append-system-prompt-file` 存在；两条连续任务第二条首轮 `usage.cache_read_input_tokens` 明显升高。1 天（含拆提示 + 调测试）。
- **A4 项目事实只放一处。** fameex-web 的 CLAUDE.md 已含 monorepo 结构、包管理器，lark-bot 提示里又写了「`pnpm --filter fameex install …` / `./node_modules/.bin/biome …`」。按「复制到别的项目还成立吗」：这些是项目事实，应只在 fameex-web 的 CLAUDE.md（或 `config.installHint`）里，bot 提示只说「按仓库 CLAUDE.md 的安装 / 检查命令」。验：提示里 `grep -c 'pnpm --filter fameex'` 为 0；`stripAutoLoadedRules` 的 `omittedAutoLoaded` 审计字段非空。2 小时。
- **A5 冲突约束 lint。** 文章 §4 的第二个坑：互相冲突的规则让模型随机取舍。lark-bot 提示里已知的成对约束：「必需检查完成后立即结束，不追加顺手扫描」vs「改了页面要用页面工具自己验」（配 `verify` 后两条同时在）；「任务没有明确要求视觉验证：跳过 Browser」vs 页面工具规则。→ 在 `lark-prompt-budget.test.mjs` 加一张「互斥句对」表：同一提示里不许同时出现（和 falive 的 `SINGLE_USE_BLOCKS` 同类，fameex 版 10-31 没搬这段）。验：测试红即发现。1 小时。

### B. 工具路由：每个给模型的工具都要「何时用 / 返回后怎么验」，并量「该用时用了没」（文章 §5）

- **B1 工具描述统一模板。** 现有三条（bug 表记录、页面工具、figma 预取说明）各写各的。→ 在 `lark-worker-prompts.mjs` 收成一个 `TOOL_HINTS` 表：`{ when, command, verifyAfter, dontUseWhen }` 四个字段，渲染成同一格式；新增工具必须进表（和群出口规则表 `lark-group-phases` 一个思路：加工具 = 加一行，每列必填）。验：单测校验每行四列非空。2 小时。
- **B2 工具使用率指标。** 审计 stream-json 里每次 `tool_use` 都有 `name` 和 `input.command`。→ 把 falive 的 `scripts/lark-metrics.mjs` 搬来并加三个比率：正文有 bug 记录链接的任务里 `read-bug-record` 被调的比例；改了 `.tsx` 的任务里 `verify-page check` 被调的比例（配了 verify 后）；有 Figma 链接的任务里 `Read preview-*.png` 的比例。目标值先不定，跑两周看基线；低于基线就改描述（文章：失败先改 tool description，不是先重装）。验：`node scripts/lark-metrics.mjs --days 7` 出表。半天。
- **B3 Bash 白名单按阶段收口。** 只读阶段白名单现在是 `git log/show/diff/status/branch/rev-parse/merge-base/blame + rg` + 两个工具；实施阶段全开。文章说工具越多误路由越多，但实施阶段确实需要改文件和跑检查；折中：实施阶段用 `--permission-mode acceptEdits` + `--allowedTools "Bash(pnpm *)" "Bash(./node_modules/.bin/*)" "Bash(git *)" "Bash(node *)"` 代替 `--dangerously-skip-permissions`，再加 `--permission-prompts none`（无人回答时直接拒绝且告诉模型别重试，顺手摘掉 `AskUserQuestion`）。收益：`rm -rf` / `curl | sh` 这类命令被拒绝而不是靠提示词自律。风险：白名单漏了常用命令会把任务卡成 failed，所以先在审计里统计 30 天内实施阶段实际跑过的 Bash 前缀再定名单。验：先跑统计脚本；切换后一周 `permission_denials` 字段为空。1 天。
- **B4 不要为了「省事」接 MCP。** fameex 线现在 `claude -p` 没有 `--mcp-config`，但也没有 `--strict-mcp-config`，意味着 fameex-web 若日后放了 `.mcp.json`，bot 会在无人确认下连上它（官方 `-p` 文档明确：不会显示逐服务器批准提示）。→ 加 `--strict-mcp-config`（不给 `--mcp-config` = 一个都不连）。验：`system/init` 的 `mcp_servers` 为空数组。10 分钟。

### C. 缓存 ≠ 真相：给每个缓存一个新鲜度判据（文章 §7）

- **C1 PRD 缓存标龄。** `prdCacheDocsFor(project)` 把 `~/.prd-cache/<PR>/` 的文档路径塞进提示，没有时间信息；PRD 改版后 bot 按旧 PRD 做。→ 提示里每个 PRD 文件带 `（抓取于 N 天前）`，超过 `config.prdCacheMaxAgeDays`（建议 7）且正文有同一文档的 Lark 链接时以现抓为准、提示里点明「缓存已过期，以现抓为准」。验：单测；审计 `prdCacheAges`。半天。
- **C2 共享项目记忆标「线索」。** `ensureSharedClaudeMemory` 让临时 worktree 共用主仓的 Claude 项目记忆。记忆写的是当时的事实。→ 提示加一句「`~/.claude/projects/*/memory` 里的内容是以前的记录，涉及文件、分支、接口名先核对再用」（文章 §7 第二条：命中必须回源读）。10 分钟。
- **C3 已有的回源闸别松。** `done` 零 diff 降级、changedFiles 交叉校验、最终提交前 `HEAD + diffHash` 复核——这些正是文章说的「图谱只缩范围，命中必须回源」。写进 `docs/falive-lessons.md` 风格的不变量清单（fameex 线还没有不变量表，Mac mini 团队化前要有）。

### D. 视觉 vs 文本分流：规定什么任务必须走视觉通道（文章 §8）

- **D1 判据写进提示而不是闸。** falive 试过「任务带的 N 张截图执行器一张没打开」硬提醒（#62），因噪音删掉（#92）。改成分流规则：任务有图片附件、或正文含 样式 / 对齐 / 颜色 / 间距 / 截图 等词、或命中 UI+STYLE 信号 → 提示明确「先 Read 截图再定位问题，结论里引用截图看到的现象」；Figma 任务 → 「几何 / token 看 `spec.md`，层级关系和整体感觉看 `preview-*.png`，两者都要读」；纯 API / 数据任务 → 不提图。验：`lark-prompt-budget` 按任务类型断言这句话出现 / 不出现；B2 指标里「有图任务 Read 图片比例」上升。2 小时。
- **D2 页面工具就是「多模态通道」。** `verify` 配上后，改页面的任务结论必须附截图路径（规则已在 `buildPageVerifyRule`）；fameex 启用前要先定 `localDev`（如 `pnpm --filter @fameex/web dev`）和 `compareBase`（测试站）。这是配置事项，不是代码。

### E. 排障与体检：把文章的 doctor 思路加到 `lark-bot doctor` 的「AI 执行层」（文章 §1 §5、文末脚本）

现有 doctor 查 bot 自身。加一组「执行层」检查（只读、不改配置），每项 ok / warn + 建议动作：
- `claude --version` 可执行、`claude auth status --text` 已登录且 `authMethod` 与 `claude-auth` 文件一致（local ↔ `claude.ai`，proxy ↔ `api_key`）；
- `~/.ai-rules` 存在、`BASE_REFS` 每个文件和标题都能找到（现在只在任务开跑时 fail-closed，体检先报出来）；
- `scripts/code-rules.mjs` 与权威版本一致（已有测试，体检再报一次，免得排空自检红了才知道）；
- `FIGMA_API_KEY` / `FIGMA_TOKEN` 在 wrapper 注入的环境里可见；
- 配了 `verify` 时 `~/.lark-verify/node_modules/playwright-core` 和 `~/Library/Caches/ms-playwright/chromium*` 存在；
- `--setting-sources` / `--append-system-prompt-file` / `--strict-mcp-config` 这些 bot 要用的 flag 在当前 `claude --help` 里存在（文章 §4：先 `--help` 核对参数，别假设）；
- 用户级 `~/.claude/settings.json` 有 hooks / outputStyle 时给 info 行「bot 会话已用 `--setting-sources project` 隔离」或 warn「未隔离，以下用户设置会进 bot 会话：…」。
落点 `lib/lark-doctor.mjs` 新增一节 + `lark-doctor.test.mjs` 表格加行。半天。

### F. 治理：让「分层」被测试锁死（文章「我的判断」）

- **F1 提示词预算改成「每层各有上限」。** A3 之后：系统提示文件 ≤ 5k、user prompt ≤ 4.5k、分析 ≤ 2.6k、分类器 ≤ 1.5k，加规则先合并旧规则（文章：规则不是越集中越好，职责清楚才是省 Token）。
- **F2 回放集。** falive 有 `scripts/lark-replay-classify.mjs` + 14 条固定样例，分类口径一改就回放（forMe 召回 100%、decision 一致率 ≥ 95%）；fameex 线分类器（@负责人代理触发的意图分类）没有回放集。→ 从 `runtime/lark-audits/*/*.json` 的 `intake` 字段导出近 30 天样例（`lark-replay-export.mjs` 可搬），建 `__tests__/fixtures/fameex-intake/`；改分类提示前必跑。1 天。
- **F3 不变量表。** 把 C3 那几条和 I8（两线分开部署）一起写成 fameex 线的不变量表（`docs/` 新文件），新事故先对不变量再动手——这是 falive 10-21 之后少出「补丁连环」的关键机制，fameex 线还没有。

## 4. 建议落地顺序

| 批 | 内容 | 为什么先做 | 产出 |
|---|---|---|---|
| 第 1 批（迁 mini 前，1 天） | A1 钉 effort / 模型；A2 `--setting-sources project`；B4 `--strict-mcp-config`；E 体检执行层 | 这四项不做，mini 上 bot 的行为就和现在不一样，而且没人知道差在哪 | 审计命令行可逐字对比两台机器 |
| 第 2 批（2 天） | A3 系统提示拆层；A4 项目事实归位；A5 冲突 lint；F1 分层预算 | 提质（规则冲突少）+ 增效（user prompt 减半、提示缓存） | `lark-prompt-budget` 新口径全绿 |
| 第 3 批（2 天） | B1 工具描述表；B2 使用率指标；D1 视觉分流判据；C1 PRD 缓存标龄；C2 记忆标线索 | 先有度量再调描述，避免凭感觉改提示 | `lark-metrics` 周报 |
| 第 4 批（按需） | B3 实施阶段权限收口；F2 回放集；F3 不变量表 | B3 要先统计 30 天命令前缀；F2 要先积累审计 | — |

需要 aven 拍板的两件事：① A2 用 `--setting-sources project` 还是等切 `proxy` 鉴权后直接 `--bare`（后者更干净但依赖 API key）；② B3 实施阶段是否放弃 `--dangerously-skip-permissions`（更安全，但白名单漏项会多出一类 failed）。

## 5. 刻意不做的

- 不给 lark-bot 接 MCP（文章 §5 的教训是接了不用、越接越乱；lark-bot 的 figma / Lark 文档 / bug 表都是 Worker 确定性预取，比让模型选工具稳）。
- 不把 `~/.ai-rules` 的 skill 改成靠 Claude Code 自动路由（文章 §1 的三层链路，lark-bot 用确定性注入已经绕开了「路由靠猜」）。
- 不上代码图谱（文章 §7：小仓人工读目录比维护索引快；fameex-web 是 monorepo 但 bot 任务都限定在单 app 内，`rg` + 范围契约够用）。
- 不为省 Token 砍附件 / 截图（文章 §8：省 Token 的前提是没省掉答案需要的证据）。

## 附：本机实测数据（2026-11-01，fameex 线 `fameex-stable@fe01d99`，claude 2.1.289）

| 项 | 值 |
|---|---|
| `buildTaskPrompt` 首轮字符数 | bug 8,235 / requirement 8,235 / api 8,237 / fix 8,234 / 只读 4,241 |
| `buildAnalysisPrompt` / 分类器 | 2,061 / 700 |
| 用户级 `~/.claude/settings.json` 会进 bot 会话的内容 | hooks ×6（keep-awake.sh）、`outputStyle: yolo-chinese`、`model: claude-fable-5-1`、`modelSettings` 6 个模型的 effort |
| fameex-web `.claude/settings.local.json` | `permissions.allow` 133 条 |
| fameex-web `CLAUDE.md` | 5,587 字节（Claude Code 自动加载） |
| 一条真实任务的审计（`om_x100b6244bcdcc0a8ff53fe8f9a6d756-e0.log`） | tool_use 33 次：Bash 20、Write 2，其余 Read / Grep |
| 本机 `claude --help` 已有的相关 flag | `--setting-sources` `--strict-mcp-config` `--append-system-prompt-file` `--json-schema` `--bare` `--exclude-dynamic-system-prompt-sections` `--permission-prompts` `--max-budget-usd` `--restricted` `--system-prompt-snapshot` |
| lark-bot 现在给 claude 的 flag | `-p --tools --allowedTools --disallowedTools --model --effort --json-schema --output-format stream-json --verbose --include-partial-messages --resume --dangerously-skip-permissions`（实施）|
