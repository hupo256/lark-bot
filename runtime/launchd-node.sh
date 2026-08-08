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

exec /opt/homebrew/bin/node "$@"
