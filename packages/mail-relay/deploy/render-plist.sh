#!/bin/sh
# 渲染 launchd 配置到标准输出（不安装、不加载）：
#   sh deploy/render-plist.sh <配置 json 绝对路径> [日志文件] > ~/Library/LaunchAgents/com.fameex.mail-relay.plist
# node / lark-cli 取 PATH 里的那个（两者所在目录写进进程 PATH）；本包目录取脚本所在目录的上一级。
set -eu
CONFIG="${1:?用法：sh render-plist.sh <配置 json 绝对路径> [日志文件]}"
LOG="${2:-$HOME/Library/Logs/mail-relay/mail-relay.log}"
case "$CONFIG" in /*) ;; *) echo "配置路径要写绝对路径：$CONFIG" >&2; exit 1 ;; esac
NODE="$(command -v node)" || { echo "找不到 node" >&2; exit 1; }
LARK_CLI="$(command -v lark-cli)" || { echo "找不到 lark-cli（npm i -g @larksuite/cli）" >&2; exit 1; }
RELAY_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# launchd 不读 shell 配置：node / lark-cli 装在 nvm 之类的目录里时，要把它们所在目录写进 PATH（lark-cli 由 node 起子进程调用）。
RUN_PATH="$(dirname "$NODE"):$(dirname "$LARK_CLI"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
sed -e "s#__PATH__#$RUN_PATH#g" -e "s#__NODE__#$NODE#g" -e "s#__RELAY_DIR__#$RELAY_DIR#g" -e "s#__CONFIG__#$CONFIG#g" -e "s#__LOG__#$LOG#g" "$RELAY_DIR/deploy/com.fameex.mail-relay.plist.template"
