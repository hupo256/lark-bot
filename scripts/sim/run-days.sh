#!/bin/sh
# 按天串行跑离线模拟（docs/falive-replay-plan-2026-11-03.md B2 / B3）：每天一个 sim 目录（day-MMDD），基线钉到当天 00:00（UTC）的 falive-react 提交。
#   sh scripts/sim/run-days.sh 2026-10-20 2026-10-22      # 跑 10-20、10-21 两天（结束日不含）
# 已喂过的消息（fed.json）会跳过，可随时中断重跑。
set -eu
start=${1:?start date YYYY-MM-DD}
end=${2:?end date (exclusive) YYYY-MM-DD}
sim=${3:-full}
port=${4:-3105}   # 同一个 sim 目录跨天续跑：任务 / 义务 / 发件簿延续，只按天重起进程并重钉基线
cd "$(dirname "$0")/../.."
day=$start
while [ "$day" != "$end" ]; do
  next=$(date -j -v+1d -f %Y-%m-%d "$day" +%Y-%m-%d)
  name="$sim"
  echo "=== $name $day → $next"
  node scripts/sim/run-sim.mjs --sim "$name" --from "${day}T00:00:00+00:00" --to "${next}T00:00:00+00:00" --max-wait-min 40 --conc 3 --port "$port"
  day=$next
done
node scripts/sim/compare-sim.mjs --sim "$sim" --md || true
