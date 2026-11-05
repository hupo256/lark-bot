# 自修工单教训台账

自修工单（`lib/lark-self-fix.mjs` / `lib/lark-self-fix-run.mjs`，从 falive 移植，aven 2026-10-24）修好一个 bot 自身缺陷时，在下表末尾追加一行。fameex 没有 falive 的 `falive-lessons.md`，自修的教训统一记这里；人工修的 bot 缺陷也可以记。

- **根因层**：`harness`（bot 自己的代码）/ `prompt`（提示词口径）才改代码；`env` / `external` / `model` 只报不改，不进本表（结果在私信和 `lark-bot self-fix list` 里）。
- **落在哪**：改了哪个文件 / 函数，补了哪个测试。
- **怎么验**：能复现这个错的单测名，或真机上看哪行日志。

| 日期 | 工单 | 现象 | 根因层 | 落在哪 | 怎么验 |
|---|---|---|---|---|---|
| 2026-11-03 | sf-20261103-ed68bd0e | bug 发现入口「notify」读通知会话连续失败：`strict mode is "bot", only bot-identity commands are available` | harness | 1cc516e 起 runLarkCli 缺省 identity=bot 就注入应用令牌（lark-cli 进 strict mode bot）；lib/lark-bug-watch-io.mjs 把 `--as user` 写在 args 里没走 identity 选项，被注了令牌后 user 身份被拒。改：messagesArgs 去掉 `--as user`、两处 run 传 `{ identity: 'user' }`；lib/lark-cli.mjs shouldInjectToken 加「args 自带 --as 不注」兜底 | lark-bug-watch.test「读通知会话…」钉 identity=user 且 args 不含 --as；lark-tenant-token.test「runLarkCli：bot 身份注入…」加 args 自带 --as 不注；真机看 poller.log 读通知会话不再报 strict mode |
