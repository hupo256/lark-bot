#!/bin/sh
# launchd wrapper：把凭据从 0600 文件注入 gateway / worker 进程，再 exec node。
# 为什么要 wrapper：launchd 不 source ~/.zshrc，凭据又不能写进 world-readable 的 plist。
# 凭据目录 $FALIVE_BOT_CONFIG_DIR（缺省 ~/.config/falive-bot）：
#   gateway-secret  本地 HTTP 共享密钥（falive-bot start 自动生成）
#   claude.env      可选：claude 走第三方网关时的 ANTHROPIC_* 与 FIGMA_API_KEY（export 形式）
#   claude-auth     可选：local（本机 claude 登录，缺省）| proxy（用 claude.env 的网关 key）

CONFIG_DIR="${FALIVE_BOT_CONFIG_DIR:-$HOME/.config/falive-bot}"

CRED="$CONFIG_DIR/claude.env"
if [ -f "$CRED" ]; then
  set -a
  . "$CRED"
  set +a
fi

# local：剥掉网关变量，让 claude 走本机钥匙串登录；proxy：用 claude.env 里的网关 key。
CLAUDE_AUTH_MODE="$(cat "$CONFIG_DIR/claude-auth" 2>/dev/null || echo local)"
if [ "$CLAUDE_AUTH_MODE" = "local" ]; then
  unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL ANTHROPIC_MODEL
fi
# 钥匙串凭据按 USER 查找，launchd 不保证注入 USER，缺了会报 "Not logged in"。
: "${USER:=$(id -un)}"
: "${LOGNAME:=$USER}"
export USER LOGNAME

# Gateway 本地 API 共享密钥（gateway 缺它拒绝启动；worker 用它调 gateway）。
SECRET_FILE="$CONFIG_DIR/gateway-secret"
if [ -z "${LARK_GATEWAY_SECRET:-}" ] && [ -s "$SECRET_FILE" ]; then
  LARK_GATEWAY_SECRET="$(cat "$SECRET_FILE")"
  export LARK_GATEWAY_SECRET
fi

# launchd 不带登录会话的 PATH：把 ~/.local/bin（claude 安装位置）放前面。
PATH="$HOME/.local/bin:$PATH"
export PATH

# launchd 不给私有 TMPDIR，git 里的 xcrun 会在 /tmp 撞别的用户建的缓存文件刷报错；给一个本用户私有目录。
TMPDIR="${TMPDIR:-$HOME/Library/Caches/falive-bot/tmp}"
case "$TMPDIR" in
  /tmp|/tmp/) TMPDIR="$HOME/Library/Caches/falive-bot/tmp" ;;
esac
mkdir -p "$TMPDIR"
export TMPDIR

# 任务租约必须长于最长的 AI 超时（仓库 profile 可调到 60min），worker 启动时会断言。
export LARK_TASK_LEASE_MS="${LARK_TASK_LEASE_MS:-4500000}"

exec "${NODE_BIN:-node}" "$@"
