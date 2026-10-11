# 架构、数据与状态公共规则

> 本文包含两类内容：§1-7 是按需加载的代码架构参考；§8 的项目 Gate、台账与证据流程仅适用于 workflowVersion 1/2 存量项目。新需求的 API readiness/MSW 规则以 [web-lite-workflow.md](./web-lite-workflow.md) 为准，不创建 assumptions、manifest 或 waiver 台账。章节号被外部文档锚点引用（§3.1/§8/§8.1/§8.2），勿改编号。路线 A 拆除税（原 §8.0/§8.0.1/§8.0.3/§8.3）已移至 [mock-legacy-route-a.md](./mock-legacy-route-a.md) 并沿用同编号。

## 1. 默认分层

调用链：`Route/Page → Feature/Component → React Query Hook → API Service`

响应数据链：`API Response(unknown) → Response/DTO Schema → Mapper → UI Model → Hook Result → Component`

- 路由文件只挂载页面组件，不写业务逻辑。
- 组件只消费 UI 领域模型，不直接消费 API DTO。
- 外部脏数据先过 schema / mapper / selector / 明确 narrowing。
- Mapper 只做纯数据转换，不调用 API、React Query、store 或 UI；完整输入/输出/依赖契约见 [api-and-mapper.md §1](./api-and-mapper.md)。
- 纯计算、格式化、状态推导、排序、跳转放无 `'use client'` 文件。
- 编码前先盘点同目录、同业务域、共享包的现有组件/hooks/services/stores/utils/样式；可复用或相近的优先复用、组合、轻量封装。
- 不为单次使用引入抽象；同一逻辑 ≥2 处才抽 helper/resolver/map/小组件。

## 2. 复用优先级

**硬性**：先搜索后编码。路径 = 直接复用 → 轻量封装 → 抽公共能力 → 新建。不复用须在 `product/02-technical-design.md` 写明已检查候选与原因。**禁写「跳过复用」四字——触发 DOC-G4-003 / DOC-REUSE-001 gate BLOCK。**

1. **直接复用**：现有组件/hook/service/selector/formatter/route action 满足需求即用。
2. **轻量封装**：相近但不完全匹配，用 props/组合/wrapper/mapper/纯函数扩展，不复制大段代码。
3. **抽公共能力**：同一规则/推导/跳转/UI pattern ≥2 处，抽局部 helper/hook/component，命名贴业务。
4. **新建**：现有明显不适配或复用引入错误耦合时才新建，并在技术方案写明原因。

检查范围：当前及相邻业务域 `apps/web/src/apps/<domain>/`；共享包 `packages/{ui,utils,icon,config}`；现有 API service/RQ hook/Zustand store/mapper/formatter/route action；同类历史项目与其 `02-technical-design.md` 复用候选。

落地：`02-technical-design.md` 须有复用盘点表（检查位置 / 采用方式 / 不复用原因）。G4 前无表或仍「待检查/待确认」→ 不得新增组件/hook/service/store/utils。

### 2.1 跨业务 UI 与弹窗类（强制）

Modal、分享渠道行、底部浮层、分页、状态 CTA **必须先 grep 全站 `apps/**`**，对照 [component-reuse-and-visual-fidelity.md](./component-reuse-and-visual-fidelity.md) §2.3 已知组件表。渠道行优先复用 `ShareActionButtons`。不得因「方案已写新文件名」直接新建。

### 2.2 PRD 面包屑路径 → 代码落点核验（强制）

> 教训来源：PR-01947（2026-07-27）。PRD 给出两条不同导航路径（面包屑），落点探查时其中一条在当前分支 grep 不到真实代码，探查者未如实报「目标缺失」，而是静默顶替映射成了另一个名字相近的 UI 元素（两条面包屑被收敛成同一处）。此后所有任务拆解、代码实现、自测用例全部沿用错误落点，验收「通过」验证的是错的目标，PRD 真正要改的页面全程零改动、零测试，且没有任何 gate 能发现——因为整条链路自己一致地指向了错的地方。

**硬性**：`00-feature-inventory.md` 里每条 PRD 面包屑路径（`【A】--【B】--【C】` 形式的完整导航路径），必须在 `product/02-technical-design.md` 逐条**原文复述**并核验，写入「PRD 路径核验」表：

| PRD 面包屑路径 | grep 关键字 / 命令 | 结果 | 落点代码文件 |
|---|---|---|---|
| 原文照抄，不缩写、不改写 | 用路由名/组件名/页面标题关键字 | 命中 / **缺失（需确认跨 PR 依赖）** | 命中时填真实路径；缺失时写 `N/A，待确认` 并登记待办 |

- grep 不到目标代码，**严禁**用名字相似的其他组件/弹窗/页面顶替填入「落点代码文件」列——必须如实写「缺失」，并升级为待确认事项（可能是跨 PR 依赖、代码尚未合并、或 PRD 路径本身有歧义）。
- 两条不同的面包屑路径（哪怕字段/功能描述相似，例如都涉及"保证金模式/杠杆"），**落点绝不能收敛成同一个代码文件**——路径不同即视为不同页面，除非有明确证据（如路由重定向、组件复用注释）证明二者本就是同一处。
- 该表逐条覆盖 `00-feature-inventory.md` 里出现的全部面包屑，不得遗漏；核验见 `DOC-G4-008`/`DOC-G4-009`（[rule-ids-and-gates.md](./rule-ids-and-gates.md)）。

## 3. API 与 mapper

权威规则已拆到 [api-and-mapper.md](./api-and-mapper.md)。历史引用到本节时，继续读取该专题；字段命名见其 §2，字段对账见其 §3。

## 4. 状态管理

| 数据类型 | 默认位置 |
|----------|----------|
| 服务端数据 | React Query |
| API DTO → UI 数据 | mapper / selector |
| 派生态、按钮态、格式化展示 | 纯函数 / hook → props |
| 用户输入、弹窗 session、跨兄弟最小共享态 | Zustand 或本地 state |
| 页面路由参数 | route / search params |

禁止：接口详情复制进 Zustand；`useMemo`/hook 派生态回写 store；为少传 props 建 runtime store；多组件重复实现同套业务状态判断。

### 4.0 单一事实源与所有权门禁

数据、状态、业务规则、静态映射、配置和项目事实在进入实现前，必须明确一个**权威写入源（single source of truth）**。消费者读取该源或从它派生，不再维护第二个可独立修改的副本；同一事实如果需要改两处才能生效，即视为所有权未收敛。

**触发**：新增或修改会被 2 个以上模块消费的业务事实；发现同一枚举、状态判断、规则、配置或文档结论在多处重复；引入缓存、持久化、兼容层、读模型或跨端同步。

**动作**：G4 前在 `product/02-technical-design.md` 的「单一事实源与所有权」表登记事实、权威来源/唯一写入口、消费者和派生方式。优先删除副本并改为 import、selector、resolver、query key、schema、配置读取或文档链接；不能直接读取时，明确复制边界。

**允许的复制不是第二真值源**：缓存、服务端快照、持久化镜像、反规范化读模型、离线数据和迁移期兼容值可以存在，但必须同时登记：源 → 副本的同步/失效机制、允许陈旧窗口、owner、失败恢复方式和验证证据。没有这些约束的“先复制一份以后同步”不算例外。

**证据与失败处理**：G6 Review 按所有权表反查代码和项目文档，确认每项只有一个业务写入口；派生值不被回写成并列状态，静态规则不在多个组件各写一份，项目结论只在一个文档维护、其他位置只链接。发现多个可写副本时，优先在本次改动收敛；受跨系统/迁移阻塞时登记 `06-collaboration.md`，写清 owner、到期条件和移除计划，不得仅写“后续同步”。

编码落点的完整检查仍由 L1 `coding-quality` 与 L2 `.cursor/rules/state-*`、`architecture-*` 承担；本节只定义项目阶段、所有权证据和例外登记，不复制代码写法清单。

### 4.1 React Query 缓存策略门禁（防临时策略变线上策略）

缓存配置属于产品行为，不是性能装饰。每个非默认 `staleTime`、`gcTime`/`cacheTime`、`refetchOnMount`、`refetchOnWindowFocus`、`enabled`、手动 `setQueryData` 都必须能回答：数据何时会变、谁负责让页面拿到新值、用户能接受多旧的数据。

- **禁止想当然无限 fresh**：用户身份、权限、申请状态、首次进入标记、余额、订单、持仓等可变业务数据，不得使用 `staleTime: Number.POSITIVE_INFINITY` / `Infinity`，除非 API 明确是不可变/版本化数据且评审能核验契约。优先使用有界 TTL，或由 mutation / 页面进入 / 事件流显式 invalidate/refetch。
- **mock 缓存跟 mock 同生同死**：临时 mock / walkthrough 若需要缓存覆盖，必须紧贴 mock `queryFn`/fixture，并标 `@mock-only` + 清理条件；删除 mock 数据时，同一 change 必须删除或重新评估相邻的 `staleTime`、refetch 配置、`enabled` 配置。
- **mutation 必须闭环 freshness**：mutation 改了某个 query 展示的服务端状态时，在 mutation 层补 `invalidateQueries`、`refetchQueries` 或有证明的定向缓存更新；能写测试时覆盖这个关系。
- **测试断言用户可见行为，不固化偶然实现**：测试名若是「避免旧身份/旧状态」，断言必须能抓住 remount/refetch/invalidation 语义；不得只断言 `staleTime === Infinity` 这类实现值，把历史错误写成新真相。
- **收尾搜索高风险项**：涉及 API、mock、状态或 React Query 的改动，收尾前 grep touched files：`@mock-only`、`staleTime`、`gcTime`、`cacheTime`、`refetchOnMount`、`refetchOnWindowFocus`、`enabled: false`、`setQueryData`。每个命中项都要重新对照 freshness contract，临时理由消失即删。

反面案例（PR-02022）：`/fe-ex-api/cptrade/market/userType` 的 `staleTime: Infinity` 最初是 mock 走查期为了固定 leader 场景、防真实请求覆盖 mock 的临时策略。mock `queryFn` 删除后缓存配置遗留，后续又被测试断言固化，导致真实用户身份接口被当成永久 fresh 数据。正确处理：切真实接口时同步重评缓存策略；身份类接口默认不可无限 fresh，需靠页面进入重拉或状态变更 invalidate 保证新鲜度。

## 5. Zustand 使用边界

全部满足才用：① 状态需被两个不相邻兄弟组件同时读写；② 非 API 结果、不可由 props/query/session 派生；③ 关弹窗/离页有明确 reset。

- 允许：交易弹窗 session（选中项/方向/输入金额）、跨兄弟临时 UI 输入。
- 禁止：打开弹窗的 `context`（放 modal props）、`context+session` 可推导态、API 详情/按钮 disabled/进度/文案/格式化结果。

## 6. 状态推导与查表

1. 静态映射用 `Record`/常量对象。
2. 简单优先级先算候选值，再 `??` 或清晰分支。
3. 复杂判断用语义 resolver 收敛，不散落 JSX。
4. 查表只做 `A→B`，resolver 决定何时用哪个结果。
5. 默认分支显式，不让 UI 猜 `undefined`。

不过度抽象：单条边界校验、分支仅 1-2 行且不扩展、抽成规则数组后阅读成本更高 → 直接写 resolver。

## 7. Loading、Empty、Error

每个请求必须有可见状态：首屏（骨架/loading + 错误 + 重试）；局部请求（局部 loading，不阻塞全页）；mutation（当前按钮 disabled+loading，失败不提前改成功态）；局部刷新失败（保留旧数据 + 提示/降级）；空态/错误/无权限/未登录均有明确 UI。

## 7.1 文案契约：像接口 contract 一样管理

文案不是临场散落的 UI 字符串；它与接口字段一样会影响验收、翻译、埋点理解和联调口径。新项目从 G1 起必须在 `product/03-api-contract.md` 维护「文案契约表」，实现只消费已入表文案。

**逐字硬性（PR-02022 反面案例，违反即打回）**：「默认中文」列的值必须**逐字 copy 自 PRD/Figma/运营原文**——禁意译、复述、改写、增删字/标点。契约就是原文本身，不是「意思对就行」。这与接口字段同理：字段名不能自己改，文案值也不能自己改。固定文案实现**必须配「值 === 来源原文」字面契约校验**（优先 Node/source contract 一次批量比对，覆盖标题/按钮/toast/弹窗等每条固定文案），把语义漂移变成红灯；不得为此新增 `.tsx` render 测试。反面根因：PR-02022 有文案契约表仍意译 6 处，原测试只做结构断言（key 存在/渲染/不溢出）拦不住意译，人工 L2 走查被「读起来通顺」骗过——**结构对 ≠ 文字对，只有逐字契约校验锁得住**。

**落地口径**：

1. **入表字段**：文案 ID、页面/组件、来源（PRD/Figma/API/运营）、owner、zh-CN key、默认中文（逐字原文）、动态变量、展示条件、状态。
2. **变更同 contract**：改 key、改中文、增删变量、改展示条件，都要更新文案契约表与契约变更记录；不允许只改 locale 或 JSX。
3. **变量显式声明**：包含金额、币种、时间、人数等动态插值时，变量名、类型、格式化来源必须入表；变量不得在翻译字符串里隐式拼接。
4. **来源优先级**：PRD 定功能语义，Figma 定视觉和近端 UI copy；二者冲突写 `06-collaboration.md` 待确认，不在代码里自行择一。
5. **zh-CN only**：实现阶段只新增/修改 `zh-CN` locale；其他语言不跟改，除非用户明确要求。
6. **假默认禁止**：接口/配置文案缺失时按 §8.2 显 `--` 或不渲染，不用本地兜底文案掩盖 contract 缺失。
7. **字面契约锁死**：每个含固定文案的功能用 Node/source contract 批量验证「值 === 来源原文」；文案改动必须先改契约表原文、再改校验输入、最后改实现，三处同源。若文案恰好位于自然独立的纯 `.ts` 常量模块，可由既有定向测试覆盖；不得为 `.tsx` 组件新增 render 测试或只为测试拆逻辑。

> 泛化：文案只是「按需求原文、不想当然」的一个实例。字段名、枚举值、状态流转、交互行为同理——凡是 PRD/契约已写死的，实现照搬，不自行改写；PRD 没写的显式标 `// ASSUMED:` 待对账（§8.1），不拿「我以为」填空。

快速通道里非 API 的临时业务语义（权限、金额精度、状态机、路由、核心交互）不塞进字段假设台账，统一登记到 [fast-track-incomplete-docs.md](./fast-track-incomplete-docs.md) 定义的 `agent/fast-track.json`；只有语义已确认或有人签认了默认安全、可逆的临时契约才允许实现，Mock 只模拟该契约，不负责发明契约。

## 8. 存量项目 Mock 策略：workflowVersion 1/2

本节中的 manifest、assumptions、waiver、Gate 和证据要求仅用于对应存量项目；不得带入新需求（新需求走 `prd-to-commit`，MSW 约定以该 skill 为准）。

**存量项目主路径**：适用项目按 **MSW 路线 B**（§8.4.1）实施；service/hook/mapper 从第一天只写真实请求，mock 只在 `src/mocks/handlers/`。存量项目的 waiver 和验收要求仍按原规则执行。**遗留 `if(USE_MOCK)` 路线 A 的隔离/拆除税已移至 [mock-legacy-route-a.md](./mock-legacy-route-a.md)**。

**两路线通用关卡（无论走哪条都做）**：字段假设标记（§8.0.2）→ 真实接口字段对账（§8.1）→ 真实接口后禁假默认兜底（§8.2）。Mock 只是真实接口 ready 前写 UI/UX 的临时脚手架，非长期并存层。**全节以 §8.-1 四阶段生命周期为时间线主轴。**

### 8.-1 Mock 四阶段生命周期（本节主轴，细则见各锚点）

本节是 Mock 的**唯一时间线主轴**：下表定每阶段做什么，实现细则不在此展开，只指向对应锚点，避免同一规则多处重述。四阶段与「隔离原则（路线 A，[mock-legacy-route-a.md](./mock-legacy-route-a.md) §8.0）→ 拆除三道闸（同文件 §8.0.3）→ 字段对账（§8.1）→ 禁兜底（§8.2）」是同一条线的不同时点；走 MSW 的新功能只剩后两步。

> **本项目现实（决定主防线在哪）**：常态是「**API 文档都还没有就要写 UI**」——即阶段① 是主路径、阶段② 反而罕见。这意味着 mock 字段大多**从猜测起步**，主防线不在"隔离/拆除"，而在 **①的 `// ASSUMED:` 标记 + ③的 §8.1 字段对账 + `CODE-TYPE-002` gate**：猜的字段必须显式标记，真实接口/文档到位时必须逐字段对账销账。已发生的字段消失 bug（PR-01685 `rewardDescription`、ranking 分页字段）根因都是"schema 从猜来的、后来没对账"。所以在本项目，`diffStrippedKeys` 对账 + `CODE-TYPE-002` 是核心关卡，不是可选加固。

| 阶段 | 触发 | 纲领（一句） | 细则锚点 |
|------|------|--------------|----------|
| ① API 文档未 ready（**本项目常态**） | 需要写 UI/UX | **最小化** mock 只解锁 UI，不臆造未来字段、不铺场景；无依据字段**逐个**打 `// ASSUMED:`（后续必对账销账） | §8.0.2（ASSUMED/场景矩阵/fixture 位置）；路线 A 隔离见 mock-legacy §8.0 |
| ② API 文档 ready（本项目罕见） | 拿到契约 | **严格照 API 文档**重造 mock DTO，模拟联调跑通 schema→mapper→UI | §3（schema 单源）；路线 A 打 `@mock-only` + 登记闸见 mock-legacy §8.0/§8.0.3 |
| ③ 接口 ready | 后端可调 | 切真实 service 与清 mock 同一步，不留「切了没删」窗口 | §8.1（对账=拆除触发点）；路线 A 拆什么/拆除闸/删 flag 见 mock-legacy §8.0.1/§8.0.3/§8.3 |
| ④ 已请求真实接口 | 线上真实数据 | **禁 mock/假默认兜底**：必填缺失显 `--`、可选缺失不渲染，暴露真实状态 | §8.2（CODE-MOCK-003） |

拆不干净的根因 = mock 逻辑散落（组件 `if(mock)`、mapper 假字段、hook 假数据）。故从第一行起就关进隔离边界：拆除 = 删边界 + 删开关。**路线 A 的隔离原则、拆除的 vs 保留的对照、拆除三道闸见 [mock-legacy-route-a.md](./mock-legacy-route-a.md)（§8.0 / §8.0.1 / §8.0.3）；走 MSW 的新功能无此拆除税。**

### 8.0.2 写 mock 期间其他约束（阶段①②，两路线通用）

- **（主防线，本项目常态无文档起步）** `03-api-contract.md` 记录字段假设；无 API 依据的字段在 type 定义处**逐个**打 `// ASSUMED: 待真实接口确认`。这是"猜着写"模式下唯一能标出"哪些字段是猜的"的手段——不标，真实接口到位时就无从知道该核对哪些。**随 §8.1 对账逐条销账**：对账时每个 `ASSUMED` 要么被契约证实（删标记）、要么被证伪（改 schema/type/mapper）。残留的 `ASSUMED` = 对账没做完。
- 建 Mock 场景矩阵：正常/空/错误/权限/边界。
- local/dev/test 运行期需 mock 时，fixture 放随代码发布的源码或 public 目录；`docs_tdd/` 不作运行时依赖。
- 环境策略写清：哪些环境固定 mock、哪些真实、是否允许失败回退。不用含 pre 的通用 testing 判断替代项目约定。

### 8.1 真实接口到位后的字段对账（强制关卡，两路线通用）

坑不在造错字段，而在真实接口来了只做加法不做减法：补真实字段进兜底链让页面显示，却没删 mock 臆造字段。能显示 ≠ 正确。

G5 联调时每个列表/表单/详情页必须做字段对账，非「能显示」即过：

1. 建三列表 `前端字段(type/column) → mapper 取值 → YApi 契约字段`，逐行核对**全部输出字段（含直传/同名字段）**，非仅改名字段——直传字段若在契约无对应来源即为臆造，须一并登记。
2. 任何前端字段在契约里无唯一对应来源 → 删除或合并，同步改 type/column/搜索项/mapper。
3. 契约把多概念合并成一列的（如创建/成交时间同列），前端也合成一列，不拆多列各自兜底。
4. 对账结果落 `03-api-contract.md` 或 `12-*-api-integration.md`；G6/G7 用例补「表格列 ↔ 契约字段一一对应、无冗余列」字段级检查，不只测「可显示」。
5. **对账通过 = mock 拆除触发点**：MSW 删/停 handler 即切真实；路线 A 按 [mock-legacy-route-a.md](./mock-legacy-route-a.md) §8.0.3 G5 闸删光 mock、`@mock-only` 归零。

**机器兜底对账最易漏的一列**：手工三列表最容易漏「真实接口有、schema 没声明 → `.parse()` 静默剥离 → 字段消失」（PR-01685 rewardDescription）。用 `agent-scripts/schema-fixture-reconcile.mjs` 的纯函数 `diffStrippedKeys` 在 `*.realFixture.test.ts` 接线，把这列变成自动断言：

```ts
import { diffStrippedKeys } from '<agent-scripts>/schema-fixture-reconcile.mjs'
const raw = readFixture('codex-detail.json').data
// schema 漏声明任一 fixture 里真实存在的字段 → 断言失败，当场暴露，不必人眼逐行核对
expect(diffStrippedKeys(raw, detailSchema.parse(raw))).toEqual([])
```

原理 = zod `.parse()` 默认剥离未声明 key，故 raw 与 parsed 的 key 路径差集 = schema 漏的字段。适用纯 shape 校验 schema（无 `.transform` 改结构）。`node schema-fixture-reconcile.mjs --self-test` 自证。

> 反面案例（PR-01988）：订单列表 mock 阶段按「常有创建+成交两列」造 `filledAt`，真实契约 `polymarket/order/pageList` 只有一个 `displayTime`（有成交取成交否则取创建，刻意一列）。联调时把 `createdAt`、`filledAt` 双双兜底到 `displayTime` 让页面照显，却没删多余「成交时间」列，两列长期同值。根因即缺此对账关卡。

### 8.2 真实接口后禁 mock/假默认兜底，暴露数据真实状态（强制，CODE-MOCK-003）

切到真实接口后（阶段④），**不得用 mock 值、假常量、假文案给缺失数据兜底**——那会把「接口没给数据」伪装成「有数据」，让缺字段、脏数据在联调期无法被发现。口径：

1. **必填字段缺失 → 显示 `--`**（标题、金额、单位、名次等）。写法 `value || '--'`，不写 `value || '默认标题'`。
2. **可选字段/说明文字缺失 → 不渲染**（条件渲染 `x?.trim() ? <p>{x}</p> : null`），不用占位假文案填充。
3. **mapper 层不造假**：缺失字段留空串/`undefined` 原样传递，交给 UI 决定 `--` 或不渲染；**禁止** `?? '假默认'`、`?? 假常量`（如 `rewardUnit ?? 'USDT'`）、`?? Date.now()`（纯展示时间戳）。仅当缺失值会破坏下游数值运算（倒计时、状态机比较）时，才允许在明确注释下兜安全默认，且该默认不进入展示文案。
4. **孤立兜底 i18n key 一并清理**：为假默认建的 `defaultXxx` 文案（`defaultTitle`/`defaultMetricLabel`…）随兜底一起删，不留孤儿 key。

反面案例（PR-01685）：排行榜 `rewardDescription` 空时回退 `t('campaign:ranking.defaultRewardDescription')` 假文案，联调时页面「有内容」，掩盖了 schema 漏字段导致该字段全程为空的真 bug。正解：可选说明缺失就不渲染，问题当场暴露。

**dev 调试占位（补「不渲染」的盲区）**：「可选缺失不渲染」在 prod 是对的，但 dev/联调期「字段拼错拿不到值」和「字段确实为空」都表现为空白，难分辨。故分环境：**dev 渲染显眼调试占位、prod 真 `null`**，让「没接上」当场可见。

```ts
// 缺失可选字段：dev 显眼提示，prod 静默不渲染
const optionalText = (v?: string) =>
  v?.trim() ? v : process.env.NEXT_PUBLIC_ENV_NAME === 'prod' ? null : `⚠optional-missing`
```

这与 §8.2 第 2 条不冲突：prod 行为不变（不渲染），只在 dev 把静默空白变成可见信号。占位只走非 prod 环境，不进生产包展示。

机器兜底：`CODE-MOCK-003`（verify-code-rules.mjs，warn-first）扫 `apps/web/src/apps/**` 与 mapper 新增行里 `?? '字面量'` / `|| '非--文案'` 的可疑展示兜底，提示人工确认是否假默认；稳定后提 error。

### 8.4 路线 B：存量项目 MSW 标准路线

新功能一律用 MSW 在网络层拦截请求；service/hook/mapper/组件只实现真实请求链路。**PR-01947 已作为首个固化范例验证**「停用 handler 即切真实接口，业务代码不因拆 mock 而修改」，试点结项后本路线晋级为**强制标准**：`DOC-G3-IMPL-001..006` 自模板 v4 起硬阻断（trial+since:4，见 [rule-id-ledger.md](./rule-id-ledger.md)），存量低版本项目 warn。历史决策过程只在 [CHANGELOG.md](../CHANGELOG.md) 保留。遗留 `if (USE_MOCK)` 功能才消费 [mock-legacy-route-a.md](./mock-legacy-route-a.md)。

### 8.4.1 新功能 MSW 执行契约

> 可照抄骨架：handler 见 [`templates/msw-handler-template.ts`](../../templates/msw-handler-template.ts)，契约测试见 [`templates/msw-mock-contract-test-template.ts`](../../templates/msw-mock-contract-test-template.ts)，manifest 由 `start-new-project` 自动落 `agent/msw-manifest.json`。

1. handler 放 `src/mocks/handlers/<feature>.ts`，按 endpoint 注册；业务代码禁止出现 mock flag、mock 分支或 mock DTO 工厂。
2. handler response 必须由真实 schema 契约测试验证；没有 API 文档时，假设同时进入 `agent/assumptions.json`，代码以 `// ASSUMED: ASM-xxx` 关联。**出口条件**：`blockingWhen: api-ready/reconciling` 的 `open` 假设挡 G5（`DOC-ASSUM-001`），`release` 轴再叠加挡 G8（`DOC-ASSUM-002`）；销账=改 `status` 并写 `resolution`，确需带风险交付走 `rule-waivers.json` 具名限期豁免，不得把 `status` 谎报成 `confirmed`。`prd-clarify` 轴不挡 gate，要挡请用 `blockers.json` 的 `blocksGate`。
3. worker 仅在 dev 启动，未声明请求用 `onUnhandledRequest: 'bypass'` 打真实接口；若存在 production Service Worker，需验证注册/清理逻辑互不干扰。
4. 项目 `agent/msw-manifest.json` 是 endpoint、场景、资产和生命周期状态的机器真值；场景按 endpoint 类型裁剪，不适用项写理由。
5. 不采用 MSW 必须在 `agent/rule-waivers.json` 登记 owner、原因、替代隔离方案和失效时间。

### 8.4.2 真实接口到位后的 MSW 拆除流程（PR-01947 固化，2026-07-15）

后端把接口部署到 dev 后，**先按接口粒度拆，不等整项目全部接口齐**。拆除目标是让已就绪接口真实请求贯通，同时未就绪接口仍可用 MSW 支撑 UI 自测。

1. **逐接口登记状态**：项目 `product/03-api-contract.md` 的接口表增加/维护 `mock中`、`dev-ready`、`已切真实`、`blocked` 状态；不要只写项目级「等后端」。
2. **只关已 ready 的 handler**：一个 handler 只 mock 一个 endpoint 时直接删除该 handler 文件与契约测试；多个 endpoint 共用文件时导出 `xxxHandlers`，从 `browser.ts` 注册列表中移除已 ready 的那一项，保留未 ready 的 handler。
3. **保留未 ready 接口的 mock 边界**：未部署接口继续放在 `src/mocks/handlers/<feature>.ts`，service/hook/mapper 仍按真实请求写；禁止为了「部分真实」在业务代码里加 `if (mock)` 分支。
4. **真实接口对账**：每切一个 endpoint，立刻核对 URL、method、query/body、response schema、nullable、枚举值、错误码；对账结果写回 `03-api-contract.md`，销掉对应 ASSUMED/Q 项。
5. **拆契约测试的时机**：`*.mockContract.test.ts` 只验证 handler/fixture，随 handler 生命周期删除；真实响应到位后新增或保留 `*.apiContract.test.ts` / `*.realFixture.test.ts`，长期验证 schema 与脱敏真实样本。若仍有其他 handler，保留对应 mock contract test。
6. **空 worker 收口**：当 `browser.ts` 已无 handlers 时，允许暂留 `setupWorker()` 作为后续试点基建；若项目不再需要任何 MSW，可连同 `useMockWorker()` 挂载点一起删除。二选一必须在项目文档写清。
7. **自测最小集**：跑已切接口的 schema/mapper/hook 单测、受影响表单提交测试、Biome touched files、`verify-code-rules`；能跑 dev 页面时再做真实请求冒烟（记录账号/环境，不记录密钥）。

**分批接口兼容策略**：把「mock/真实」状态控制在 **MSW handler 注册表**，不要控制在业务代码。已 ready 的 endpoint 走真实网络，未 ready 的 endpoint 被 MSW 拦截；`onUnhandledRequest: 'bypass'` 保证未声明请求天然打真实接口。这样同一个功能可以同时存在真实 `before_follow` + mock `save_follow`，或真实列表 + mock 导出，而 UI、service、mapper 不需要知道差异。

最小闭环与当前规则以 §8.4.1 为准；本节只定义接口就绪后的分批拆除动作，不再次枚举准入资产。
