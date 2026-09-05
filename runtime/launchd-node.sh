#!/bin/sh
# launchd wrapper：把 claude 走第三方网关所需的凭据（ANTHROPIC_API_KEY / BASE_URL / MODEL）
# 从 0600 的 ~/.config/fameex-lark/claude.env 注入进 worker/gateway 进程，再 exec node。
#
# 为什么要 wrapper：launchd 不 source ~/.zshrc，直接跑 node 会让 worker 里 spawn 的 claude
# 拿不到 key/base_url → "Not logged in"。凭据只存 0600 文件、不落进 world-readable 的 plist。
# WorkingDirectory 由 launchd 在 exec 前设好，wrapper 原样继承，不影响 config/roots 解析。

CRED="$HOME/.config/fameex-lark/claude.env"
if [ -f "$CRED" ]; then
  set -a
  . "$CRED"
  set +a
fi

# Gateway 本地 API 共享密钥：lark-bot 早就生成了 0600 的 gateway-secret 并在 curl 里带上，
# 但服务端进程从来没拿到过这个环境变量 —— gatewaySecret 恒为空字符串，鉴权分支恒不成立，
# 于是本机任何进程都能无凭证投递任务 / 回写任务状态 / prune 队列。密钥必须在这里注入
# （而不是写进 plist：LaunchAgents 目录里的 plist 是 world-readable 的）。
SECRET_FILE="$HOME/.config/fameex-lark/gateway-secret"
if [ -z "${LARK_GATEWAY_SECRET:-}" ] && [ -s "$SECRET_FILE" ]; then
  LARK_GATEWAY_SECRET="$(cat "$SECRET_FILE")"
  export LARK_GATEWAY_SECRET
fi

# TMPDIR：launchd 不给登录会话那个私有 /var/folders/... TMPDIR，进程回落到 /tmp。
# 于是 git 里的 xcrun 每次都想在 /tmp 写共享缓存、撞上别的 uid 建的同名文件，
# worker.log 里就持续刷 `git: couldn't create cache file '/tmp/xcrun_db-*'`——
# 无害但把真实报错埋掉。给一个本用户私有目录即可彻底消掉这类噪音。
# 登录会话的 PATH（nvm、~/.local/bin 等）不会自动带进 launchd 进程，
# worker 里 spawn 的 codex/pi/cursor-agent 等 CLI 会找不到二进制。
PATH="$HOME/.local/bin:$PATH"
NVM_PI="$(find "$HOME/.nvm/versions/node" -maxdepth 2 -name pi -print -quit 2>/dev/null)"
[ -n "$NVM_PI" ] && PATH="$(dirname "$NVM_PI"):$PATH"
export PATH

TMPDIR="${TMPDIR:-$HOME/Library/Caches/fameex-lark/tmp}"
case "$TMPDIR" in
  /tmp|/tmp/) TMPDIR="$HOME/Library/Caches/fameex-lark/tmp" ;;
esac
mkdir -p "$TMPDIR"
export TMPDIR

exec /opt/homebrew/bin/node "$@"
