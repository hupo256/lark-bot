# 在 Mac mini 上部署审批邮件转发

对应 `docs/plan/plan-mail-relay-standalone-2026-11-05.md` 的 P3。整体顺序：装好 → 影子跑 1 个工作日 → 对账 → 切换；随时可回滚。

下面的路径约定：代码放 `~/mail-relay`，配置和凭证放 `~/.config/mail-relay`（权限 700）。

## 0. 前提

> 11-06 首次部署实况：Mac mini 用户 `ex-user`、主机名 `ex-userdeMac-mini.local`（IP 是 DHCP，会变，用主机名）、macOS 12.7.6、没有 Homebrew。
> Node 装在用户目录（`~/.local/node` → Node 22 LTS 官方包，校验 SHASUMS256；macOS 12 用不了 Node 23+ 的官方包），`~/.zprofile` 里加 PATH；lark-cli 用 `npm i -g` 装进同一个目录。
> 不要在这台机器上调 `python3`：系统自带的是占位程序，一调就弹「安装命令行开发者工具」对话框。

- 飞书应用「审批邮件助手」（`cli_aa663bfff1b89f04`）已审批发布，可用范围包含邮箱主人；机器人已拉进审批群 `oc_936db…`。
- Mac mini 上装好 Node 20+ 和 lark-cli（`npm i -g @larksuite/cli`），并保持常开、不睡眠：`sudo pmset -a sleep 0 disksleep 0 autorestart 1`。
- 停电重启后 launchd 的用户级服务要等 `ex-user` 登录才会起：系统设置 → 用户与群组 → 自动登录选 `ex-user`（否则重启后转发不会自己恢复）。

## 1. 拷代码

在笔记本上：

```sh
rsync -a --delete ~/github/lark-bot/packages/mail-relay/ <mac-mini>:~/mail-relay/
```

包目录自成一体（只依赖 Node 内置模块），不需要 `npm install`。

## 2. 配置与凭证

```sh
mkdir -p ~/.config/mail-relay/lark-cli && chmod 700 ~/.config/mail-relay ~/.config/mail-relay/lark-cli
cp ~/mail-relay/deploy/config.example.json ~/.config/mail-relay/config.json
```

`config.example.json` 是 11-06 Mac mini 的实际设置：三条路由、`mode: "watch"`（实时监听）+ `pollMs: 300000`（每 5 分钟拉一次收件箱兜底）、`shadow: false`。
首次上线想先观察，可以把路由的 `chatId` 临时指到测试群（11-06 就是这么做的：「lark-bot 测试群」`oc_da69155c32afd9b0b3efe679e638ce5e`），或者开 `shadow: true` 只记台账不发。`cliConfigDir` / `stateFile` 是相对配置文件所在目录的路径。

**`notifyOpenId` 要换成邮箱主人在「审批邮件助手」这个应用下的 open_id**：open_id 按应用区分，同一个人在老 bot 应用下的 id（模板里那个 `ou_9186…`）新机器人私信不到，告警会发不出去。授权完成时 `auth login` 的输出里有 `user_open_id`，填它（aven 是 `ou_645b8e6c31978904e47de5e32efb025e`）。

App Secret 由邮箱主人自己输（从开发者后台「凭证与基础信息」复制，粘贴后回车，屏幕上不显示）：

```sh
LARKSUITE_CLI_CONFIG_DIR=$HOME/.config/mail-relay/lark-cli lark-cli config init --app-id cli_aa663bfff1b89f04 --brand lark --app-secret-stdin
```

邮箱授权（读信 + 监听 + 以用户身份把邮件卡片发进群 + 续期，权限清单同 `engine.mjs` 的 `RELAY_USER_SCOPES`；应用的「用户身份权限」里要先开好这 10 个，`im:message` / `im:message.send_as_user` 漏开会在分享卡片时报 missing_scope）。命令会给一个链接，邮箱主人在浏览器里点授权：

```sh
LARKSUITE_CLI_CONFIG_DIR=$HOME/.config/mail-relay/lark-cli lark-cli auth login --scope "mail:user_mailbox:readonly mail:user_mailbox.message:readonly mail:user_mailbox.message.subject:read mail:user_mailbox.message.body:read mail:user_mailbox.message.address:read mail:event mail:user_mailbox.event.mail_address:read im:message im:message.send_as_user offline_access"
```

## 3. 自检

```sh
cd ~/mail-relay
node bin/mail-relay.mjs check --config ~/.config/mail-relay/config.json
# 找一封已知的 OL 邮件 id（笔记本上 lark-cli mail +triage 能查到），只出评分、不发：
node bin/mail-relay.mjs forward --config ~/.config/mail-relay/config.json --message-id <id> --dry-run
```

评分说明能正常出来，说明读信权限通了。缺权限时 lark-cli 会报缺哪个 scope 并给开通链接：补开、发版本、重新授权。

## 4. 影子跑（1 个工作日）

```sh
mkdir -p ~/Library/Logs/mail-relay
sh ~/mail-relay/deploy/render-plist.sh $HOME/.config/mail-relay/config.json > ~/Library/LaunchAgents/com.fameex.mail-relay.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.fameex.mail-relay.plist
tail -f ~/Library/Logs/mail-relay/mail-relay.log   # 应看到「已启用 3 条路由…（影子模式：只记台账、不往群里发）」
```

影子模式照常读信、判路由、评分、记台账（记录带 `dryRun: true`），不往群里发。笔记本上的 lark-bot 照常转发。
连续 5 次读不到收件箱会私信 `notifyOpenId`（前面带「[影子]」），授权类错误会附重新授权命令。

## 5. 对账

把笔记本上线上的台账拷过来，和影子台账逐封比（`--since` 写影子开始的时间）：

```sh
scp <laptop>:~/github/lark-bot/runtime/lark-mail-relay-state.json /tmp/live-ledger.json
node bin/mail-relay.mjs compare --config ~/.config/mail-relay/config.json --against /tmp/live-ledger.json --since 2026-11-06T01:00:00Z
```

退出码 0 = 全一致；3 = 有差异，逐条列出「只在本机影子 / 只在对照台账 / 两边结果不同」。全一致才切换；有差异先查清原因（路由配置不同？权限缺？笔记本合盖晚转？）。

## 6. 切换（顺序不能反）

1. **笔记本关掉内置转发**：`runtime/lark-bot.local.json` 里 `mailRelay.enabled` 改成 `false`，几分钟内排空重启自动生效；网关日志不再出现「已启用 N 条路由」。
   同时把审批群写进 `chatRetention.keep`（内置转发关了以后，bot 不再在这个群里说话，否则 14 天后会被判成闲置群自动退群）。
2. **补上空档**：再拷一次线上台账，跑一遍第 5 步的 compare。「只在本机影子」的就是笔记本关掉之后、Mac mini 还在影子模式时进来的邮件，没人转过，逐封手动转：
   `node bin/mail-relay.mjs forward --config ~/.config/mail-relay/config.json --message-id <id>`
3. **Mac mini 转正**：配置里 `shadow` 改成 `false`，重启进程：
   `launchctl kickstart -k gui/$(id -u)/com.fameex.mail-relay`
   日志里「影子模式」字样消失；之后的新邮件由 Mac mini 转发、由「审批邮件助手」机器人回评分。

影子期间已记进台账的邮件（`dryRun: true`）不会再转——它们要么笔记本已经转过，要么在第 2 步手动补过。

## 7. 回滚

```sh
launchctl bootout gui/$(id -u)/com.fameex.mail-relay      # Mac mini 停掉
```

笔记本上 `mailRelay.enabled` 改回 `true`。两边台账互不影响；空档里的邮件同第 6 步第 2 条用 compare 找出来补。

## 8. 以后开实时监听（可选）

开发者后台「事件与回调」：订阅方式选「长连接」→ 进程在跑时点「重新验证」变绿 → 保存 → 添加事件「收到新邮件」`mail.user_mailbox.event.message_received_v1` → 发版本。
然后配置里 `mode` 改成 `"watch"`，`launchctl kickstart -k …` 重启。
