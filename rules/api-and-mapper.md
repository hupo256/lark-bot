# API、Schema 与 Mapper

> 本文是 API/schema/mapper 的权威专题。架构总览只保留入口，不复制本节。

## 1. 调用链与数据链

调用方向和响应数据转换方向必须分开描述，不得用一条 `组件 → hook → mapper → API` 同时表达两种关系：

```text
调用链：Route/Page → Feature/Component → React Query Hook → API Service
数据链：API Response(unknown) → Response/DTO Schema → Mapper → UI Model
                                                    → Hook Result → Component
```

- API 请求放 `apps/web/src/services/api/<domain>/` 或复用现有 service；组件不直接 `fetch`、HTTP client 或 API service，也不消费 raw DTO。
- React Query Hook 负责 query key、请求生命周期、缓存与 mutation 后失效；它调用 API Service，并把已校验、已映射的 UI Model 暴露给组件。
- `transfer` 先确认真实 `data` 是数组、对象还是包装对象；复杂解包抽成可测 `parseXxx`。
- Schema 逐字段遵循 API 名称、类型和可空性，作为运行时真值；type 从 schema 推导或显式对账。
- 禁止 `schema.parse(x) as T` 掩盖 schema 漏字段；mock response 走相同 schema/mapper/UI 类型链路。
- Mapper 是纯转换层，只接收已通过 schema 的 DTO 并返回 UI Model；不得调用 API、React Query、store 或 UI，也不得读取组件状态。
- 金额、精度、排序、状态机和路由决策等风险逻辑放纯函数并测试。
- 集合逐项解析：坏字段/记录不得清空其余合法项；细则见 L1 `api-schema-mapper.md`。

### 1.1 固定层契约

| 层 | 输入 | 输出 | 允许依赖 | 禁止依赖 |
|----|------|------|----------|----------|
| Component | Hook Result / UI Model / props | JSX、用户意图 | UI 组件、领域纯函数、Feature Hook | raw DTO/schema、低层 HTTP client、直接 API 请求 |
| React Query Hook | UI 请求参数、用户意图 | Query/Mutation Result（data 为 UI Model） | query key、API Service、schema/mapper 编排 | JSX/组件、把服务端数据复制进 Zustand |
| API Service | 契约请求参数 | `unknown` response 或经统一 transport 解包的数据 | 统一 HTTP client、endpoint/config | Feature 组件、UI 状态、mock handler/fixture |
| Response/DTO Schema | `unknown` | 已校验 DTO | schema 库、契约字段定义 | React、store、组件、网络请求 |
| Mapper | 已校验 DTO | UI Model | 类型、纯 formatter/calc/resolver | API/HTTP、React Query、Zustand/store、组件/UI |

Hook 可按项目既有 service 封装把 schema/mapper 接在 `transfer` 中，但职责与数据顺序不变。目录位置不是免责依据：G6 Review 按真实 import 和输入输出判断边界。

### 1.2 集合响应韧性证据

列表 parser 须逐项窄化，坏项按契约丢弃/降级且可观测；禁用宽松 schema 吞错或伪造默认。定向纯逻辑测试须证明一个坏字段/项不影响其余项。整批失败仅限 API 明定原子语义且 owner 已确认。

### 1.3 `CODE-ARCH-003` 执行契约（本节的机器覆盖）

- **Trigger**：新增或修改 Component、React Query Hook、API Service、schema/DTO、Mapper，或生产代码的 mock 边界 import。
- **Source**：本节（§1 调用链、数据链和层依赖）是 L3 流程源；通用 schema/mapper 实现正文位于 L1 coding-quality 的 `api-schema-mapper.md`，rule-ids-and-gates.md 只登记机器覆盖。
- **Loader**：编码前按 `write_ui`、`write_query_hook`、`write_api` 或 `write_mapper` 加载；G6 加载 `quality-checklist.md`。
- **Executor**：编辑后由 `verify-code-rules.mjs`/`docs-tdd changed` 扫 changed 文件全量 import，阶段出口由 G6 gate 与 code review 共同执行。
- **Evidence**：扫描 finding 包含 Rule ID、文件、行号和 import source；G6 在 `06-collaboration.md` 记录已修、误报或有期限豁免，并关联 gate fingerprint。
- **Failure**：当前为 warn-first，不单独阻断；高置信命中优先移动依赖或抽中立类型模块。人工判定合法时登记理由与误报形态；连续 2 个真实 PR 零误报后按 rule-ids-and-gates.md §2.1 晋级 error。

## 2. Mapper 命名

Mapper 把 API DTO 转成前端可消费模型，但不重新设计字段词汇表。单一来源字段默认与 API 同名同大小写，方便从 View Model 直接追踪 response。

- **同名直传/转换**：单字段原样传递或格式转换后仍保持 API 名。若同时需要原值和展示值，保留原字段并新增明确派生字段。
- **允许改名仅两类**：
  1. 跨来源统一：多个 DTO 字段进入真实共享模型，服务至少两个来源或通用消费者；写 `// API-RENAME: cross-source source=<fields>`。
  2. 多字段组合/语义派生：输出无法唯一对应单个 DTO 字段；写 `// API-DERIVED: sources=<fields>`。
- 类型/格式变化、来源消歧、前端叫法更顺或名字更短都不是改名理由。消歧优先由模型类型、对象层级和来源边界表达。
- 普通 `// API:` 只记录来源，不能证明改名合理。
- 禁止多个语义不同的 UI 字段兜底到同一个 `dto.xxx`；这通常意味着 mock 臆造或契约缺口。

## 3. 字段对账

Mock 阶段即维护 `前端字段 → mapper 取值 → API 契约字段 → 映射类型`。映射类型只允许：

`同名直传` · `同名转换` · `跨来源统一` · `多字段派生`

G5 对账全部输出字段；无唯一契约来源的字段删除或合并。真实 fixture 到位后用 `schema-fixture-reconcile.mjs` 检查 schema parse 剥离的 key。

机器兜底：`CODE-NAMING-001` 对无结构化理由的改名发 WARN；`CODE-MAPPER-001` 阻断多个语义字段复用同一 fallback 来源。机器只能验证理由格式，跨来源/派生是否真实仍由 review 裁决。
