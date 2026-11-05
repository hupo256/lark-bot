#!/bin/sh
# 【旧跑法，11-04 起由 scripts/sim/run-episodes.mjs 按事件组跑取代（design-v2 §2 / P0-d）；保留给旧轮次复现，新轮次别用】
# 按天跑离线模拟（docs/replay/falive-replay-plan-2026-11-03.md 44）：同一个 sim 目录跨天续跑（任务 / 义务 / 发件簿延续），每天重起进程、重钉业务仓基线。
#   sh scripts/sim/run-days.sh 2026-10-20 2026-10-22 <sim> <port>      # 跑 10-20、10-21 两天（结束日不含）
# 断点续跑：每跑完一天（系统空闲、没有跑到一半的任务）把整个 sim 目录 APFS 克隆一份到 <sim>.ckpt/<日期>/（几乎不占空间）。
# 中断后再跑同一条命令：退回最近的存档点、从下一天接着跑，最多丢一天；存档点的代码指纹（lib / 入口 / case 数据的 git tree）
# 和现在不一样就拒绝续跑（一轮里不许混两版代码），要么换轮名重跑，要么删掉 <sim>.ckpt。
set -eu
start=${1:?start date YYYY-MM-DD}
end=${2:?end date (exclusive) YYYY-MM-DD}
sim=${3:-full}
port=${4:-3105}
cd "$(dirname "$0")/../.."
root="$HOME/github/lark-bot/runtime/falive-replay/sim"
simdir="$root/$sim"
ck="$root/$sim.ckpt"
code=$(git rev-parse HEAD:lib HEAD:lark-gateway.mjs HEAD:lark-worker.mjs HEAD:runtime/lark-worker.mjs HEAD:replay/falive/dataset HEAD:replay/falive/raw | shasum | cut -c1-12)
mkdir -p "$ck"
day=$start
last=""
while [ "$day" != "$end" ] && [ -d "$ck/$day" ]; do
  if [ "$(cat "$ck/$day/.code" 2>/dev/null)" != "$code" ]; then
    echo "!!! $sim 存档点 $day 的代码指纹 $(cat "$ck/$day/.code" 2>/dev/null) ≠ 现在 ${code}：不续跑（换轮名重跑，或删 ${ck}）"
    exit 3
  fi
  last=$day
  day=$(date -j -v+1d -f %Y-%m-%d "$day" +%Y-%m-%d)
done
if [ -n "$last" ]; then
  if [ "$(cat "$simdir/.ckpt-day" 2>/dev/null)" != "$last" ]; then
    echo "=== $sim 从存档点 $last 末恢复（丢弃之后跑了一半的进度）"
    rm -rf "$simdir"
    cp -cR "$ck/$last" "$simdir"
  else
    echo "=== $sim 已在存档点 $last 末，接着跑"
  fi
elif [ -s "$simdir/fed.json" ]; then
  echo "=== $sim 没有存档点、目录里有跑了一半的进度：清掉从头跑"
  rm -rf "$simdir"
fi
while [ "$day" != "$end" ]; do
  next=$(date -j -v+1d -f %Y-%m-%d "$day" +%Y-%m-%d)
  echo "=== $sim $day → $next"
  mkdir -p "$simdir"
  echo "running-$day" > "$simdir/.ckpt-day"
  node scripts/sim/run-sim.mjs --sim "$sim" --from "${day}T00:00:00+00:00" --to "${next}T00:00:00+00:00" --max-wait-min 40 --conc 3 --port "$port"
  echo "$day" > "$simdir/.ckpt-day"
  rm -rf "$ck/$day.tmp"
  cp -cR "$simdir" "$ck/$day.tmp"
  echo "$code" > "$ck/$day.tmp/.code"
  mv "$ck/$day.tmp" "$ck/$day"
  echo "=== $sim 存档点 $day"
  day=$next
done
node scripts/sim/compare-sim.mjs --sim "$sim" --md || true
