#!/bin/bash
# 审批邮件转发一键发布到 Mac mini（aven 11-06「升级、迭代在自己的 Mac 上完成，ssh 一键发布到 Mac mini，全程不用动 Mac mini」）。
#   bash scripts/mail-relay-publish.sh            测试 → 备份 → 同步 → 自检 → 重启 → 验活，失败自动回滚
#   bash scripts/mail-relay-publish.sh --dry-run  只跑测试、连通性和远端自检，不同步不重启
# 目标机：MAIL_RELAY_HOST（缺省 ex-user@ex-userdeMac-mini.local，IP 是 DHCP 会变，用主机名；只在同一局域网可达）。
# 连不上时自动改走 IPv6 本地链路地址（11-06：笔记本开着 OpenVPN Connect 全隧道，局域网 10.167.242.0/25 被导进 utun0，
# Mac mini 换到 .93 后 IPv4 报 Network is unreachable；IPv6 本地链路不走 VPN）。主机密钥按原主机名核对（HostKeyAlias），不放宽校验。
# 只动 Mac mini 的 ~/mail-relay（代码）；配置 / 凭证 / 台账在 ~/.config/mail-relay，不碰。部署说明见 packages/mail-relay/deploy/INSTALL.md。
set -euo pipefail

HOST="${MAIL_RELAY_HOST:-ex-user@ex-userdeMac-mini.local}"
LABEL="com.fameex.mail-relay"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/packages/mail-relay/"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

say() { printf '\n▶ %s\n' "$*"; }
die() { printf '\n✖ %s\n' "$*" >&2; exit 1; }
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=8)
# 先按主机名连；不通就用 dns-sd 找它广播的 IPv6 本地链路地址（带网卡后缀，如 fe80::…%en0），
# 给 ssh 加 HostName 覆盖实际连接地址、HostKeyAlias 按原主机名核对密钥；ssh / rsync 的目标写法都不变（rsync 不认带 %en0 的地址）。
resolve_target() {
  ssh "${SSH_OPTS[@]}" "$HOST" true 2>/dev/null && return 0
  local name="${HOST#*@}" v6
  v6="$( (dns-sd -G v6 "$name" & pid=$!; sleep 3; kill $pid 2>/dev/null) 2>/dev/null | awk '$2 == "Add" && $6 ~ /^[Ff][Ee]80:/ {print $6; exit}')"
  [ -n "$v6" ] || return 1
  # HostName 里 % 是占位符（%h %p…），网卡后缀 %en0 要写成 %%en0
  SSH_OPTS+=(-o "HostName=${v6//%/%%}" -o "HostKeyAlias=$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')")
  ssh "${SSH_OPTS[@]}" "$HOST" true 2>/dev/null || return 1
  echo "按主机名连不上（笔记本 VPN 劫持了局域网路由？），改走 IPv6 本地链路 $v6"
}
# 远端跑一段脚本：走登录 shell（PATH 里有用户目录下的 node / lark-cli），locale 警告滤掉。
remote() { ssh "${SSH_OPTS[@]}" "$HOST" 'export LANG=en_US.UTF-8; zsh -l -s' 2> >(grep -vE "^perl|locale|LC_ALL|LANG =|are supported|Falling back" >&2); }

SHA="$(git -C "$ROOT" rev-parse --short HEAD)"
DIRTY=""
[ -n "$(git -C "$ROOT" status --porcelain -- packages/mail-relay)" ] && DIRTY="+未提交改动"

say "1/5 全量测试（发布的代码就是本仓 packages/mail-relay，和 lark-bot 共用测试）"
TEST_LOG="$(mktemp)"
if ! node "$ROOT/scripts/test-all.mjs" > "$TEST_LOG" 2>&1; then
  tail -20 "$TEST_LOG"
  die "测试没过，不发布（完整输出 $TEST_LOG）"
fi
tail -1 "$TEST_LOG"

say "2/5 连通性：$HOST"
resolve_target || die "连不上 $HOST（不在同一局域网？Mac mini 关机了？IPv6 本地链路也找不到）"
remote <<<'echo "已连上 $(hostname)，node $(node -v)，$(lark-cli --version)"' || die "连不上 $HOST（不在同一局域网？Mac mini 关机了？）"

say "3/5 远端自检：用新代码校验线上配置（还没替换线上代码）"
STAGE=".mail-relay-stage"
rsync -a --delete -e "ssh ${SSH_OPTS[*]}" "$SRC" "$HOST:~/$STAGE/" || die "同步到暂存目录失败"
remote <<EOF || die "新代码在 Mac mini 上自检不过（线上没动）"
set -e
cd ~/$STAGE && node bin/mail-relay.mjs check --config ~/.config/mail-relay/config.json
EOF

if [ "$DRY_RUN" = 1 ]; then
  say "--dry-run：到此为止，线上没动"
  exit 0
fi

say "4/5 备份线上版本 → 换上新代码 → 重启"
remote <<EOF || die "替换 / 重启失败（看上面的输出）"
set -e
rm -rf ~/mail-relay.prev && cp -a ~/mail-relay ~/mail-relay.prev
rsync -a --delete ~/$STAGE/ ~/mail-relay/
printf '%s %s %s\n' "$SHA$DIRTY" "\$(date -u +%FT%TZ)" "from \$(echo \$SSH_CLIENT | cut -d' ' -f1)" > ~/mail-relay/DEPLOYED
wc -l < ~/Library/Logs/mail-relay/mail-relay.log | tr -d ' ' > ~/.mail-relay-logmark
launchctl kickstart -k gui/\$(id -u)/$LABEL
EOF

say "5/5 验活：进程在跑、打出「已启用 N 条路由」、watch 模式下长连接连上（最多等 60 秒）"
if remote <<EOF
MARK=\$(cat ~/.mail-relay-logmark)
MODE=\$(node -e 'const c=require(process.env.HOME+"/.config/mail-relay/config.json");console.log((c.mailRelay||c).mode||"poll")')
for i in \$(seq 1 30); do
  NEW=\$(tail -n +\$((MARK + 1)) ~/Library/Logs/mail-relay/mail-relay.log)
  STATE=\$(launchctl print gui/\$(id -u)/$LABEL 2>/dev/null | grep -E "^\s*state =" | head -1)
  if echo "\$STATE" | grep -q running && echo "\$NEW" | grep -q "已启用" && { [ "\$MODE" != watch ] || echo "\$NEW" | grep -q "Waiting for mail events"; }; then
    echo "\$NEW" | grep "已启用" | tail -1 | cut -c1-120
    echo "进程 \$STATE，模式 \$MODE，版本 \$(cat ~/mail-relay/DEPLOYED)"
    exit 0
  fi
  sleep 2
done
echo "60 秒内没等到启动成功的标志，最近日志："; echo "\$NEW" | tail -15
exit 1
EOF
then
  say "✔ 发布完成：$SHA$DIRTY → $HOST"
else
  say "验活失败，回滚到上一版"
  remote <<EOF
rm -rf ~/mail-relay && mv ~/mail-relay.prev ~/mail-relay
launchctl kickstart -k gui/\$(id -u)/$LABEL
sleep 8
launchctl print gui/\$(id -u)/$LABEL | grep -E "^\s*state =" | head -1
echo "已回滚到 \$(cat ~/mail-relay/DEPLOYED 2>/dev/null || echo 上一版)"
EOF
  die "这次发布没生效，线上已回滚到上一版"
fi
