# 接入 falive-bot：一步一步来

> 读者：要在自己 Mac 上跑一个 falive-bot、让它在 Falive 的外部群里替自己干活的前端同事。
> 全程大约 1 小时，其中等飞书管理员审批权限的时间不算。每一步末尾都有「验证」，没通过别往下走。
> 名词：**你的 bot** = 你在群里加的「自定义机器人」（只能发消息）；**控制台群** = 只有你和你的 bot 的小群，bot 把它当成和你的私聊。

## 0. 先准备好

| 要什么 | 从哪来 |
|---|---|
| 一台常开的 Mac（合盖 bot 就暂停，开盖自动补拉） | 自己的电脑即可 |
| 业务仓 `falive-react` 的 clone 权限，以及你自己的开发分支 | GitLab |
| 一个飞书企业自建应用的 `app_id` / `app_secret`（团队共用一个即可） | 找发包给你的同事要，或在飞书开放平台自建 |
| Claude Code 账号（订阅登录），或一个 Claude API 网关的 key | 自备 |
| 你要接入的外部群：你本人必须在群里，并且有权限在群里加自定义机器人 | 群主 / 群管理员 |
| 你在「功能总表」里的名字（bot 按它判断哪些功能归你） | 业务仓 `docs/lark-migration-source/requirements/phase1-feature-table.md` 的「前端」列 |

## 1. 装工具

```sh
brew install node git pnpm            # Node 需要 ≥ 22：node -v
npm i -g @larksuite/cli               # 飞书命令行：lark-cli --version
curl -fsSL https://claude.ai/install.sh | bash   # Claude Code：claude --version
mkdir -p ~/.local/bin                 # 确认 ~/.local/bin 在 PATH 里（echo $PATH）
```

**验证**：`node -v`（≥ v22）、`pnpm -v`、`lark-cli --version`、`claude --version` 都有输出。

## 2. 放好 bot 代码

```sh
mkdir -p ~/github && cd ~/github
tar -xzf ~/Downloads/falive-bot-*.tar.gz        # 解压出 ~/github/falive-bot
cd falive-bot
node scripts/test-all.mjs                         # 全量单测
ln -sf "$PWD/scripts/lark-bot" ~/.local/bin/falive-bot
```

**验证**：最后一行是「测试 N 个：通过 N，失败 0」；`falive-bot` 不带参数会打印用法。

## 3. 准备业务仓

```sh
cd ~/github
git clone <falive-react 的 GitLab 地址> falive-react
cd falive-react
git checkout <你的开发分支>        # bot 从这个分支开任务分支、做完合回这个分支
pnpm install --frozen-lockfile
```

bot 在业务仓**同级目录** `~/github/.lark-falive/` 里建临时 worktree，不碰你主目录的工作区；做完的任务分支叫 `lark/falive-<id>`，合回成功后自动删除。你主目录在用的时候（有暂存、不在开发分支、未提交改动和要合的文件重叠）它会排队等，结果私信你。

**验证**：`grep -E '^## (固定前提（勿偏离）|硬规则速览（细则见各向导）)' CLAUDE.md` 能找到两行——这两节是 bot 的必读规则，缺了任务会直接拒绝执行。

## 4. 飞书：让 lark-cli 能以「你」的身份读群

```sh
lark-cli config init                    # 填 app_id；app_secret 按提示从 stdin 输入
lark-cli auth login --domain im,docs,drive,base,wiki,contact   # 浏览器里用你自己的飞书账号授权
lark-cli whoami                         # 记下 onBehalfOf.openId（ou_ 开头），第 6 步要用
```

需要的用户身份权限：读取群消息（**「获取群组中所有消息」要企业管理员审批**，没批下来 bot 读不到群）、搜索群、读云文档 / 知识库、创建云文档、读多维表格（bug 表）。授权页面提示哪个权限没开，就在开放平台为这个应用申请。

**验证**：`lark-cli im +chat-search --query "<某个你在的外部群群名>" --as user --format json` 能返回这个群的 `chat_id`。

## 5. Claude

二选一：

- **本机登录（推荐）**：终端里跑一次 `claude`，按提示登录后退出。bot 默认就是这个模式。
- **网关 key**：把下面内容写进 `~/.config/falive-bot/claude.env`（`chmod 600`），再在第 8 步之后执行 `falive-bot claude-auth proxy`。

  ```sh
  export ANTHROPIC_BASE_URL=https://<网关地址>
  export ANTHROPIC_API_KEY=<key>
  ```

同一个文件里还可以放（两种模式都会读它）：

```sh
export FIGMA_API_KEY=<Figma personal access token>   # 读 Figma 设计稿
export VERIFY_MAIL=<测试环境测试号邮箱>                # 页面验证工具 --login 用
export VERIFY_PWD=<测试号密码>
```

**验证**：`cd ~/github/falive-react && claude -p "回复 ok"` 输出 ok。

## 6. 写配置

```sh
mkdir -p ~/.config/falive-bot && chmod 700 ~/.config/falive-bot
cd ~/github/falive-bot
cp runtime/lark-bot.example.json runtime/lark-bot.local.json
chmod 600 runtime/lark-bot.local.json
```

打开 `runtime/lark-bot.local.json`，**只改 `repos.falive` 里这几项**，其余保持样例值：

| 键 | 填什么 |
|---|---|
| `root` | 业务仓路径，如 `~/github/falive-react` |
| `baseRef` | 你的开发分支名（第 3 步检出的那个） |
| `mergeBack.upstream` | 开任务前先把哪个远端分支同步进开发分支，通常 `origin/pre`；不想让 bot 合回就删掉整个 `mergeBack` |
| `botName` | 你准备给自定义机器人起的名字，如 `Henry.Bot`（第 7 步每个群都用这个名字） |
| `ownership.me` | 你在功能总表「前端」列里的名字 |
| `ownership.meOpenIds` | 第 4 步 `whoami` 拿到的 open_id |
| `ownership.meAliases` | 别人在群里对你的其它叫法（英文名、带后缀的名字） |
| `verify.siteUrl` | 测试环境站点地址（bot 实测接口 / 页面用） |

`chatIds`、`webhooksByChat`、`chatLabels`、`notifyChatId` 留空，第 7 步的命令会自动写。
其它可选项（模型、并发、轮询频率、终检命令、日报、部署盯梢）的含义见 [falive-repo-profile.md](./falive-repo-profile.md) §4、§7。

## 7. 建控制台群、接入外部群

每个群都做同样两件事：**加自定义机器人**，然后**跑一条 `add-chat`**。

1. **控制台群**：在飞书里新建一个群，只拉你自己。群设置 → 群机器人 → 添加机器人 → 自定义机器人，名字填第 6 步的 `botName`，**勾选「签名校验」**，复制 webhook 地址和签名密钥。然后：

   ```sh
   falive-bot add-chat --console --name "<控制台群群名>" --webhook "<webhook 地址>" --secret "<签名密钥>"
   ```

2. **每个外部群**：同样在群里加自定义机器人（同一个名字），复制 webhook 和密钥：

   ```sh
   falive-bot add-chat --name "<外部群群名>" --webhook "<webhook 地址>" --secret "<签名密钥>"
   ```

`add-chat` 会按群名找到 chat_id、用签名校验 webhook（故意发一条会被拒收的消息，**群里看不到任何东西**）、认出群里的机器人、把凭据存成 `~/.config/falive-bot/` 下的 0600 文件、写进配置（写前备份）。群名重名或找不到时会列出候选，改用 `--chat-id oc_xxx`。

**验证**：每条命令都输出「✅ 已接入…」；`runtime/lark-bot.local.json` 里 `notifyChatId` 是控制台群，`chatIds` 是外部群。

## 8. 启动

```sh
falive-bot start
falive-bot status
falive-bot doctor
```

`start` 会生成 launchd 服务（`~/Library/LaunchAgents/com.falive-bot.gateway.plist` / `.worker.plist`，开机自启）、生成 gateway 密钥、等 gateway 和 worker 就绪（worker 会真实调用一次模型做就绪探测）。

**验证**：`status` 里 `lark-gateway: running`、`lark-worker: running`、`executor: claude … probe=passed`，退出码 0；`doctor` 没有 ✖。日志里能看到轮询：`grep chat-poller ~/Library/Logs/falive-bot/gateway.log | tail -3`。

## 9. 第一次试用

在一个外部群里发一条**提问**（只读，不会改代码）：

```text
@<你的 bot> 首页 banner 现在调的是哪个接口？
```

预期：十几秒到一分钟内群里出现「收到」，几分钟后出现答复；控制台群里收到一条私信说明。没反应就看：

```sh
falive-bot logs                              # 实时日志
grep -E "ingest|收到|chat-poller" ~/Library/Logs/falive-bot/gateway.log | tail -20
```

常见原因：你不在那个群里（用户身份读不到）；「获取群组中所有消息」权限还没批；@ 的是你本人而不是你的 bot（bot 只认 @bot、回复 bot、控制台里你的消息）。

然后可以试一个小改动，例如 `@<你的 bot> 修复：<某页面> 的 <某文案> 改成 <新文案>`，看它在控制台私信你改了哪些文件、合回开发分支的结果。

## 10. 日常

| 想做 | 怎么做 |
|---|---|
| 看状态 / 体检 | `falive-bot status` / `falive-bot doctor` |
| 疑似任务放行 | 控制台群回 `继续任务 <id> 做`，或直接回复那条私信 |
| 补材料让挂起的任务继续 | 回复那条私信，或 `falive-bot resume <id> "<补充>"` |
| 结单 / 取消 | 控制台 `结单 <id>` / `取消任务 <id>`，或 `falive-bot close <id>` |
| 看失败、重跑 | `falive-bot failed` / `falive-bot retry <id>` |
| 新加一个群 | 第 7 步第 2 条，不用重启（配置变了 worker 会在空闲时自检后自动重启） |
| 改了配置 / 升级了 bot 代码 | 什么都不用做，同上；急的话 `falive-bot restart` |
| 换 claude 鉴权 | `falive-bot claude-auth local` / `proxy` |
| 暂时停用 | `falive-bot stop`（开机仍会自启）；彻底卸载 `falive-bot uninstall` |

运行态都在 `~/github/falive-bot/runtime/`（任务、附件、审计、台账、发件簿），日志在 `~/Library/Logs/falive-bot/`，凭据在 `~/.config/falive-bot/`。这三处都不要提交、不要发给别人。

## 附：bot 不做什么

- 不 push、不开 MR（你在控制台明确说「推 pre」才推你的开发分支并建 MR）。
- 不改别人负责的功能，回群 @ 负责人。
- 外部群里只认 @bot（只 @ 你本人的消息不管，那是你的事）。
- 群里能不说就不说：失败、超时、被拦下的结论只私信你。
