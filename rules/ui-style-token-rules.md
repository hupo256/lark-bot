# UI、Figma 与 Tailwind Token 公共规则

> AI 主用。章节号被外链引用（§1/§4.1 等），勿改编号。

## 1. 设计契约

`packages/config/tailwind-preset.js` = 前端与 UI 共同遵守的**唯一 token 契约**。**硬规则：业务开发不为单页临时改 `tailwind-preset.js`。**

### 1.1 实现优先级（Figma → 代码）

按序决策，**前一步能满足就不进下一步**：

| 优先级 | 策略 | 示例 |
|--------|------|------|
| **① 直接用** | Figma Dev Mode/MCP 的 className **已在 preset** | `rounded-lg`、`gap-4`、`text-2`、`w-100` |
| **② 平替** | 类名不同但**像素值与 preset 某键相同** | `rounded-4`(16px)→`rounded-lg`；`w-[400px]`→`w-100`(spacing 100=400px) |
| **③ 相近** | preset **无精确值**，选视觉最近现有键 | 12px 圆角取 `rounded-m`(8)/`rounded-lg`(16) 更近者；7px gap 用 `gap-1.5`(6)/`gap-2`(8) |
| **④ 高保真 arbitrary** | 仅项目声明高保真 ≥95%（§4.1）且 ①–③ 不够 | `rounded-[12px]`、`gap-[7px]`；**仍不改 preset** |
| **⑤ 升级 preset** | 缺口**多页反复出现**且前端+UI 确认为全站契约 | 独立 PR，同步 `common/` |

**禁止路径**（未经 ⑤）：为单页在 preset 加 `spacing`/`borderRadius`/`fontSize` 键；因「方便 IntelliSense」改 preset；跳过 ②③ 直接 `w-[700px]`/`rounded-[16px]`（非高保真项目）。

### 1.2 决策前必查 preset

编码与写 `07-figma-spec` 映射前**先打开** `packages/config/tailwind-preset.js` 查表，不凭记忆。

**圆角**（`borderRadius`）：`rounded-xxs`=1px、`rounded-xs`=2px、`rounded`/`DEFAULT`=4px、`rounded-sm`=6px、`rounded-m`=8px、`rounded-lg`=16px、`rounded-xl`=32px、`rounded-full`=50%（圆形：Figma `cornerRadius ≥ min(w,h)/2`）。

**常用间距**（`spacing`，节选，完整以 preset 为准）：`1`=4px、`1.5`=6px、`2`=8px、`3`=12px、`4`=16px、`5`=20px、`6`=24px、`7`=28px、`8`=32px、`12`=48px、`100`=400px、`300`=1200px。用于 `w-*`/`h-*`/`gap-*`/`p-*`/`m-*`/`min-w-*`。

**字号**（`fontSize`）：`h-l`、`h1`–`h7`、`subtitle`、`body-regular`、`body-s`、`body-xs`。**颜色**：语义 token `bg-1`–`bg-7`、`text-1`–`text-8`、`brand-1`、`divider-*`、`sem-*`（见 preset `colors`）。

### 1.3 映射落盘

凡 ② 平替或 ③ 相近，须在 `product/07-figma-spec.md` §Figma→preset 映射表写清 Figma 值、采用 class、映射类型、理由。模板见 [templates/07-figma-spec-template.md](../../templates/07-figma-spec-template.md)。

### 1.4 决策口诀（同 §1.1）

Figma class 工程可识别 → 直接用；不识别 → 先找同值平替 → 无精确值选最相近 → 仅多页反复 + 全站契约才评估升级 preset。

### 1.5 Token 对齐链

为了把 Figma 还原落实到可审计的链路，凡涉及颜色、间距、圆角、阴影、字号、主题变量的实现，都要记录完整对齐链：

```text
Figma 变量 -> CSS 源变量 -> Tailwind token -> Tailwind class
```

- Figma 已有变量时，优先以变量名作为唯一命名来源，不用肉眼像素值重命名 token。
- `src/styles/theme.css` 只放 `--fx-*` CSS 源变量和主题覆盖；`tailwind-theme.css` 或 preset 负责对外暴露 Tailwind token。
- 任何一个自定义 token 都应能追溯回 Figma 变量或明确的项目约定；如果只能解释成“看起来差不多”，就不应新建 token。
- 不因多个 CSS 变量当前值相同就合并，链路需要保留独立身份，便于后续 Figma 或主题改动时逐项对账。
- 项目文档里写 token 时，要同时写清 Figma 值、CSS 源变量、Tailwind token、最终 class，以及为何采用平替/相近/高保真 arbitrary。

## 2. 颜色与主题

- dark/light 兼容色一律走语义 token；常用 `bg-1`、`bg-6`、`text-1`、`text-3`、`bg-brand-1`、`border-divider-2`、`bg-sem-r`、`text-sem-g`。
- Figma MCP 的 `var(--BG-1)`/`var(--BG-6)`/`var(--Divider-2)` 须映射为项目类名。
- 不写死 hex/rgb/rgba；不用 `white`/`black` 透明色模拟主题色。
- 首次进入默认 dark；用户切 light 后复用全局主题机制持久化，下次仍 light。
- 不做页面私有主题存储，不绕过全局 `next-themes`/`theme` localStorage。

## 3. 尺寸、间距、圆角

- 一律先查 `packages/config/tailwind-preset.js`，再按 §1.1 优先级决策。示例 `w-300`、`h-120`、`gap-7`、`rounded-m`、`rounded-lg`、`size-12`(48px)。
- `rounded-4=16px` → 平替 `rounded-lg`；`rounded-3=12px` 且不识别 → 相近取 `rounded-m`(8)/`rounded-lg`(16)，不为 12px 改 preset；`cornerRadius:24` 于 48×48 → 圆形 `rounded-full`。
- 间距差 1–2px 优先相近 spacing，非高保真不为此扩 preset。
- 稳定尺寸的卡片/表格行/按钮/图表/FAQ 行明确宽高/min-height/aspect，避免刷新抖动。

## 4. Arbitrary Value 边界

禁止把 Figma 固定数值直接写成 `w-[700px]`、`h-[480px]`、`rounded-[16px]`、`bg-[#0b0c0e]`、`text-[rgb(...)]`。

允许少量：`calc()`、复杂 grid template、动态百分比、第三方库 class 覆盖、token 无法表达且局部隔离的布局公式。使用后须能解释为何现有 token 表达不了。

### 4.1 高保真视觉例外

项目要求接近 Figma 像素级还原（运营落地页/品牌页/活动页）时可进高保真模式，须同时满足：

1. `README.md` 元信息 `visualFidelity: high`（唯一布尔来源，判定标准见 [component-reuse-and-visual-fidelity.md §3.0](./component-reuse-and-visual-fidelity.md)）；在 `engineering/development-rules.md` 或 `07-figma-spec.md` 补验收节点、桌面/H5/dark/light 范围。
2. 固定尺寸/间距/圆角/阴影/图片位置可用局部 arbitrary；颜色仍优先语义 token，仅设计资产、固定 Hero 底色、阴影/半透明覆盖无法用 token 时才写精确值。
3. 精确值集中在该功能视觉组件/常量/专用 wrapper，禁止散落到业务状态计算、mapper、hook、通用组件。
4. 每轮视觉修复后真实开 Browser/Playwright 与 Figma 关键节点逐项对照，报告记 URL/视口/节点/偏差/结论；截图临时不归档。
5. 高保真与公共 token 契约冲突时只在项目私有文档记例外原因，不改全局 preset。

## 5. 样式文件边界

- 新功能样式默认基于 Tailwind class + 语义 token + 现有组件能力。
- **禁止为单个业务页面新增 `.scss`/`.module.scss`/`.less`/`.module.less`。**
- 动画/hover/focus/响应式/暗黑优先用 Tailwind 工具类、配置已有 animation/token 或组件内状态。
- Tailwind 无法表达的动态运行时值可用局部 `style` 传计算结果（动态 `transform`、CSS variable 数值）；颜色/间距/圆角仍不脱离 token。
- 仅维护存量组件、第三方样式隔离、全站样式基建才允许改/增样式文件，须在项目文档说明原因。

## 6. 动画与计时器

- 轮播/marquee/ticker/倒计时/长动画必须处理 Page Visibility：后台 tab 暂停 timer/animation/rAF，可见时先归一化当前位置再恢复，避免 timer drift/补帧跳动。
- hover/focus 暂停的轮播，后台可见性暂停须与 hover/focus 共同参与 `shouldPlay`。
- 无限循环动画处理循环边界，不依赖后台 tab 必触发 `transitionend`/`animationiteration`。

## 7. Figma 规格落文档

读取流程见 [figma-mcp-read-workflow.md](./figma-mcp-read-workflow.md)（原子节点 `get_design_context`、**cornerRadius 必填**、圆角→Tailwind 映射）。读后写入：`07-figma-spec.md`（节点/尺寸/token/截图/差异）、`05-ui-and-interaction.md`（结构/交互/主题/响应式）、`06-collaboration.md`（PRD↔Figma 冲突）。

冲突处理：PRD 功能优先、Figma 视觉优先、冲突必记录，不在代码里静默选择。

## 8. H5 与响应式

- H5 非后补项，每模块开发同步考虑。优先 Tailwind 断点/CSS 响应式 class，确需 JS 判断再用项目已有 viewport hook。
- 主体内容任何尺寸都不顶浏览器边缘；1200px 内容宽页优先参考 Home 容器：`xl:w-300 xl:mx-auto px-4 sm:px-6 xl:px-0`。
- 不在 `lg` 就取消主体 padding；1024–1200px 最易贴边，保留 `px-4`/`sm:px-6`。
- 需视觉溢出的走马灯/横向卡片，限制溢出断点（如仅 `min-[1440px]` 后做负 margin），`main` 用 `overflow-x-hidden` 防横向滚动。
- 移动端按钮优先 `w-full md:w-auto`；表格/阶梯/横向密集组件移动端卡片化/精简列/横向滚动防破版。
- 文本容器处理 `min-w-0`/`truncate`/换行/动态宽度，防长文案挤爆。

## 9. 交付前 UI 走查

L2 必查项、分工、还原度判定唯一权威源见 [component-reuse-and-visual-fidelity.md](./component-reuse-and-visual-fidelity.md) §3.0、§3.3，本节不重复。仅补 token/preset 走查：

- preset 映射（平替/相近/高保真 arbitrary）与实际渲染值一致，无临时改 `tailwind-preset.js`。
- dark/light 语义 token 切换正确，无写死 hex/rgb。
- H5 断点下 preset 间距/圆角未被覆盖或裁切。
