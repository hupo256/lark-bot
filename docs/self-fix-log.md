# 自修工单教训台账

自修工单（`lib/lark-self-fix.mjs` / `lib/lark-self-fix-run.mjs`，从 falive 移植，aven 2026-10-24）修好一个 bot 自身缺陷时，在下表末尾追加一行。fameex 没有 falive 的 `falive-lessons.md`，自修的教训统一记这里；人工修的 bot 缺陷也可以记。

- **根因层**：`harness`（bot 自己的代码）/ `prompt`（提示词口径）才改代码；`env` / `external` / `model` 只报不改，不进本表（结果在私信和 `lark-bot self-fix list` 里）。
- **落在哪**：改了哪个文件 / 函数，补了哪个测试。
- **怎么验**：能复现这个错的单测名，或真机上看哪行日志。

| 日期 | 工单 | 现象 | 根因层 | 落在哪 | 怎么验 |
|---|---|---|---|---|---|
