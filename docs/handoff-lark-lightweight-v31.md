# Lark lightweight 强化交接

> 状态：**实现与验证已完成；本地提交状态以 Git history 为准，未 push**。
> 工作目录：`/Users/aven/github/docs_tdd`
> 业务仓：`/Users/aven/github/fameex-web` **没有业务代码改动**；曾仅借用其 `node_modules/.bin/biome` 做检查，但该配置不适用于 docs_tdd 源码，未据此改写文件。
>
> 本文原为跨会话交接快照；§2–§8 保留接手时的历史状态和检查清单，当前结果以 §0 为准。

## 0. 接手完成结果

- 已补齐提交前 `HEAD + diffHash` 二次校验；终检后同路径内容漂移会 fail-closed。
- `git add -A -N` 失败已纳入 Worker 检查项并立即阻断。
- 已补只读项目主仓回落、错误目录、指纹漂移与 intent-to-add 失败测试。
- 已用真实路径规范化修复 symlink worktree 的 git root 校验误判。
- `node --check` 覆盖本轮触达的 6 个运行时模块，全部通过。
- `node --test common/lark-bot/__tests__/*.test.mjs`：401/401 通过。
- `git diff --check`：通过。

## 1. 已确认的方案边界

本轮用户已经明确同意以下方向：

- **不把 Lark 接入 docs_tdd v3.1 状态机**；避免群内小修复承担完整项目流程，也避免形成两套状态映射和双重真值。
- Lark 保留自己的任务生命周期、AI 分析、质量闸和本地提交链。
- Lark `done` 只代表“候选修复已完成、轻量终检通过并本地提交”，**不是正式交付凭证**。
- 项目正式交付仍只认 v3.1 authoritative PASS：`mode=enforced,status=passed,ok=true,assuranceMode=autonomous,evidenceTrust=cli-attested`。
- 本轮仅做轻量强化：
  1. 项目 / worktree / branch / HEAD 一致性校验；
  2. AI 实施和规范纠正结束后，由 Worker 对最终内容重新验证；
  3. Worker 实跑并保存可核验检查证据，不只采信 AI 自报 checks；
  4. 审计写入 `assuranceMode: lark-lightweight`、`deliveryAuthority: false`；
  5. schema / mapper / API / `.d.ts` / `packages/` 等高风险改动提示最终走项目级 v3.1 验收，但不把 Lark 状态同步进 `work-item.json`。

## 2. 交接时待办的实际完成度（历史）

| 待办 | 当前状态 | 说明 |
|---|---|---|
| 项目 / worktree / branch / HEAD 一致性校验 | 主体完成，未验证 | 已增加路由纯校验和真实 git identity 校验；已有测试改动，但测试未运行 |
| 规范纠正后的最终复验与可核验回执 | 主体完成，未验证 | 新增 `lark-final-verification.mjs`，跑 `git diff --check` 和触达文件 Biome，记录 `HEAD + diffHash + changedFiles` |
| 审计标记 lightweight / 非交付权威 | 已实现，未验证 | 审计 schema 升到 2，增加固定字段和终检/提交记录 |
| 高风险改动提示项目级 v3.1 PASS | 已实现，未验证 | L2 可信完成路径会在结果卡追加提醒 |
| 测试、文档、提交 | **未全部完成** | 文档与测试代码已写；真实测试、最终 diff review、`git add`、`git commit` 尚未完成 |

因此，不能把本轮视为已完成。

## 3. 当前工作区文件

上次成功执行 `git status --short` 时如下；接手后应先重新确认：

```text
 M README.md
 M common/CHANGELOG.md
 M common/lark-bot/__tests__/lark-pure.test.mjs
 M common/lark-bot/__tests__/lark-worker-git.test.mjs
 M common/lark-bot/docs/runtime-and-scheduling.md
 M common/lark-bot/docs/task-boundaries-and-reply.md
 M common/lark-bot/lib/lark-task-runner.mjs
 M common/lark-bot/lib/lark-work-context.mjs
 M common/lark-bot/lib/lark-worker-audit.mjs
 M common/lark-bot/lib/lark-worker-git.mjs
 M common/lark-bot/lib/lark-worker-results.mjs
?? common/lark-bot/__tests__/lark-final-verification.test.mjs
?? common/lark-bot/lib/lark-final-verification.mjs
```

本交接文档创建后还会新增：

```text
?? common/lark-bot/docs/handoff-lark-lightweight-v31.md
```

## 4. 已落地实现

### 4.1 `common/lark-bot/lib/lark-work-context.mjs`

新增 `validateWorkContextRoute({ task, workContext })`：

- 校验 task 项目号与 work context 项目号同源；
- 临时 worktree 必须匹配由当前 task 推导出的目录和 hotfix 分支；
- 有项目的现有 worktree 路由必须指向对应项目目录；
- 只读项目在项目 worktree 不存在时允许回落主仓；
- adhoc 只读任务只允许主仓。

`lark-pure.test.mjs` 已增加基础覆盖：正常临时路由、串项目、串分支、串目录、adhoc 只读主仓。

### 4.2 `common/lark-bot/lib/lark-worker-git.mjs`

新增 `inspectWorktreeIdentity({ cwd, expectedBranch, expectedHeadSha })`：

- 真实执行 `git rev-parse --show-toplevel`；
- 真实读取当前 branch；
- 真实读取 HEAD；
- 校验 cwd 就是 git root，拒绝子目录/串仓；
- 拒绝 detached HEAD、错误分支、任务期间 HEAD 改变。

`lark-worker-git.test.mjs` 已增加真实 git 测试：身份一致通过、分支不符失败、任务期间额外 commit 导致 HEAD 变化失败。

### 4.3 `common/lark-bot/lib/lark-final-verification.mjs`（新文件）

新增 Lark 独立轻量终检：

- 归一化实际 changed files；
- `git add -A -N` 使未跟踪文件进入 diff（只登记 intent-to-add）；
- Worker 实跑 `git diff --check HEAD -- <changedFiles>`；
- 对仍存在且受 Biome 支持的改动文件，实跑 `<cwd>/node_modules/.bin/biome check ...`；
- 保存每条命令、状态、exit code、signal、起止时间、截断后的 stdout/stderr；
- 读取 HEAD，并对 `HEAD + NUL + git diff --binary HEAD` 计算 SHA-256 `diffHash`；
- 固定输出 `assuranceMode: lark-lightweight`、`deliveryAuthority: false`；
- 提供 `formatWorkerVerificationLine()` 给结果卡展示简明回执。

新测试 `lark-final-verification.test.mjs` 已覆盖：

- Biome 文件筛选；
- `git diff --check` + 假 Biome 成功；
- whitespace error 阻断；
- Biome 非零退出阻断；
- HEAD/diffHash 与 lightweight 字段。

### 4.4 `common/lark-bot/lib/lark-task-runner.mjs`

已接入：

- worktree 准备完成后做路由校验和开工 git identity 快照；
- AI 实施与 `enforceCodeQuality` 纠正完成后，再读取真实 changed files；
- 终检前再次核对 root / branch / 开工 HEAD；
- Worker 终检失败则回写 failed，不提交；
- 终检回执写审计并展示在完成卡；
- 提交前再次核对 branch / HEAD；
- 提交 outcome 和 identity 写审计；
- L2 高风险路径在完成卡提示另取 v3.1 authoritative PASS；
- 非只读完成卡固定展示 `deliveryAuthority=false` 交付口径。

### 4.5 `common/lark-bot/lib/lark-worker-audit.mjs`

审计记录改为：

```json
{
  "schemaVersion": 2,
  "assuranceMode": "lark-lightweight",
  "deliveryAuthority": false,
  "deliveryAuthorityReason": "Lark done 仅代表本地候选修复；项目正式交付以 v3.1 authoritative PASS 为准",
  "finalVerification": null,
  "commit": null
}
```

运行时还会补充 route validation、git identity、终检回执和 commit outcome。

### 4.6 结果和文档

- `lark-worker-results.mjs` 新增 Worker 终检失败文案；
- `runtime-and-scheduling.md`、`task-boundaries-and-reply.md`、根 `README.md`、`common/CHANGELOG.md` 已说明 Lark lightweight 与 v3.1 边界；
- 文档明确：Lark 不接状态机、Lark done 无正式交付权、高风险改动另走项目验收。

## 5. 交接时尚未完成及接手者优先检查项（历史）

### P0：真实测试尚未运行

第一次用了：

```bash
node --test common/lark-bot/__tests__/
```

Node 26 把目录当模块加载并报 `MODULE_NOT_FOUND`，所以这**不是测试失败，而是测试根本没启动**。之后 `docs_tdd L2 preflight` 持续拦截所有 bash，未能换正确命令重跑。

接手后至少运行：

```bash
node --test \
  common/lark-bot/__tests__/lark-pure.test.mjs \
  common/lark-bot/__tests__/lark-worker-git.test.mjs \
  common/lark-bot/__tests__/lark-final-verification.test.mjs
```

如局部通过，再根据本仓既有入口展开全部 Lark 测试文件，不能再把目录直接传给 Node 26。可用 shell glob：

```bash
node --test common/lark-bot/__tests__/*.test.mjs
```

### P0：终检与提交之间仍有同路径并发漂移窗口

当前流程是：

1. 跑 Worker 终检并生成 `diffHash`；
2. 执行异步 `supersededMidRun('提交')`；
3. `finalizeWork()` 只复核 branch 和 HEAD；
4. 提交。

若第 2 步等待期间，人类在**同一个已存在 worktree、同一个已记录路径**继续修改文件，HEAD/branch 不变，当前提交前 identity 校验发现不了；最终 commit 可能不再对应终检的 `diffHash`。

建议在 `finalizeWork({ allowCommit: true })` 内、真正提交前重算工作树指纹并与 `workerVerification.fingerprint.diffHash` 比较；不一致则 fail-closed、保留现场。可以：

- 从 `lark-final-verification.mjs` 抽出/导出纯工作树指纹函数；
- 或提交前再跑一次轻量 `git rev-parse HEAD + git diff --binary HEAD`；
- 不必重复跑 Biome，但必须保证提交内容与已通过终检的内容是同一快照。

同时增加真实 git 测试或可注入纯函数测试，证明同路径内容变化会被拒绝。

### P0：`git add -A -N` 失败目前未 fail-closed

`runFinalVerification()` 会先执行 `git add -A -N`，但当前忽略其退出状态。极端情况下该命令失败，未跟踪文件可能没有进入后续 diff/fingerprint，而终检仍可能错误通过。

建议：

- 把 intent-to-add 命令也变成检查项，失败立即使 receipt `ok=false`；或
- 至少检查其 status，失败加入明确的 failed receipt。

需要增加对应测试；可通过让 cwd 非 git 目录，或给 `run` 做最小可注入封装来模拟失败。不要为了测试大改结构。

### P1：补充只读项目错误目录测试

`validateWorkContextRoute` 最后一次修改后，已经让“有项目的只读任务”也校验项目 worktree 或主仓回落路径，但对应测试尚未补：

- 项目 worktree 不存在时，只读任务路由主仓应通过；
- 同一上下文把 cwd 改成 `/tmp/wrong-worktree` 应失败。

### P1：最终 review 审计更新顺序

确认以下失败路径都写入一致审计：

- route validation 失败；
- 开工 identity 失败；
- 终检前 identity 失败；
- Worker 命令终检失败；
- 提交前 identity/fingerprint 失败；
- commit 失败。

当前多数路径已有记录，但 route / 开工 identity 是直接 throw 后由 catch 写通用 error；是否需要结构化字段，由接手者按“轻量、不扩状态机”的边界决定。不要为此引入新的生命周期状态。

## 6. 验证注意事项

### 不要使用业务仓 Biome 配置格式化 docs_tdd 源码

曾执行：

```bash
/Users/aven/github/fameex-web/node_modules/.bin/biome check ...docs_tdd files...
```

它使用业务仓 `biome.json`，要求双引号、分号等，与 docs_tdd 现有 `.mjs` 风格冲突，输出了大量全文件格式差异。**不要运行 `--write`，也不要据此全文件格式化。** 这次输出不能算本仓代码质量失败。

终检实现里运行的是目标业务 worktree 自己的 `<cwd>/node_modules/.bin/biome`，这是正确的：它检查 Lark 修改的业务文件，而不是 docs_tdd 工具源码。

### 已通过的检查

在新增交接文档前，以下命令曾成功：

```bash
git diff --check
```

但代码随后对 `lark-work-context.mjs` 又做了一处只读路由校验调整，并新增了本交接文档，所以接手后必须重新执行，不能把旧结果当最终 PASS。

### 建议的最终命令顺序

```bash
cd /Users/aven/github/docs_tdd

git status --short
git diff --check

node --check common/lark-bot/lib/lark-final-verification.mjs
node --check common/lark-bot/lib/lark-task-runner.mjs
node --check common/lark-bot/lib/lark-work-context.mjs
node --check common/lark-bot/lib/lark-worker-audit.mjs
node --check common/lark-bot/lib/lark-worker-git.mjs
node --check common/lark-bot/lib/lark-worker-results.mjs

node --test \
  common/lark-bot/__tests__/lark-pure.test.mjs \
  common/lark-bot/__tests__/lark-worker-git.test.mjs \
  common/lark-bot/__tests__/lark-final-verification.test.mjs

# 局部稳定后再跑 Lark 子系统全量（shell 展开具体文件）
node --test common/lark-bot/__tests__/*.test.mjs

git diff --check
git diff --stat
git diff
```

验证稳定后：

```bash
git add README.md common/CHANGELOG.md common/lark-bot
git status --short
git diff --cached --check
git diff --cached

git commit -m "feat: harden lark lightweight delivery checks"
```

**不要 push**，除非用户在新请求中明确授权。

## 7. 接手时必须保持的约束

- 不把 Lark task 状态映射到 v3.1 `work-item.json` / `latest-result.json`。
- 不要求每条群内小修都跑完整 v3.1 verify。
- 不把 Lark `done` 描述成正式交付 PASS。
- 不采信 AI 自报 checks 作为唯一验证证据。
- 终检必须发生在所有 AI 修改和规范纠正之后，并与实际提交内容绑定。
- 失败时保留现场，不把半成品自动提交。
- 不改业务仓代码。
- 可以 commit docs_tdd 本仓；没有当前请求的明确授权时不得 push。

## 8. 交接时阻塞原因（历史）

本 chat 后半段的所有 bash 命令被 Pi 扩展拦截：

```text
docs_tdd L2 preflight did not complete before this turn. Retry the user turn or reload the extension.
```

文件读取和写入仍可用，因此实现及本交接文档已落盘，但无法完成真实测试与 commit。新 chat 应先确认 preflight 已恢复；若仍报同样错误，reload Pi extension 后再继续，不要把“命令没运行”误报为“测试通过”。
