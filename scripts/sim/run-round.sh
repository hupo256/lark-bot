#!/bin/bash
# 中断后再跑同一条命令 = 断点续跑：跑完的段跳过、没跑完的从最近的「一天结束」存档点接着跑（run-days.sh）。
# 一轮完整回放（docs/falive-replay-plan-2026-11-03.md 39）：falive 10-14 → 11-03 切 8 段并行，每段先热身前一个工作日（bot 照常干活、
# 留下跨天的任务 / 义务 / 发件状态，不计分），再跑计分窗口；每段跑完立刻 judge-sim --all --score-from 计分起点。
#   bash scripts/sim/run-round.sh r8 [端口起点 3180]
# 进度：runtime/falive-replay/sim/<轮>-<段>/{sim.log,judge.out,DONE}；汇总：node scripts/sim/round-report.mjs --round r8
set -u
round=${1:?round name}
port=${2:-3180}
cd "$(dirname "$0")/../.."
root="$HOME/github/lark-bot/runtime/falive-replay/sim"
# 起跑预检：数据（285 条 case 的上下文齐不齐）/ 代码（干净、含 fameex-stable 全部提交）/ 环境，不过就不跑（docs/falive-replay-plan-2026-11-03.md 43）
mkdir -p "replay/falive/rounds/$round"
node scripts/sim/preflight.mjs --round "$round" --md "replay/falive/rounds/$round/preflight.md" || { echo "PREFLIGHT-FAIL ${round}（见 replay/falive/rounds/${round}/preflight.md）"; exit 1; }
echo "$(git rev-parse --short HEAD) $(git rev-parse --abbrev-ref HEAD)" > "replay/falive/rounds/$round/code.txt"
# 止损守卫：进程报错 / 读取缺口 / 分类失败 ≥3 / 25 分钟不动 → 整轮停掉并写 STOPPED.md
node scripts/sim/round-guard.mjs --round "$round" --pid $$ > "$root/$round-guard.out" 2>&1 &
guard=$!
segpids=""
MAX_PARALLEL=${MAX_PARALLEL:-5} # 回放和线上 bot 共用一个 Claude 账号：同时最多跑几段，给线上留额度（撞限额由 claude-q 整体暂停，见 claude-quota.mjs）
# 段  热身起点    计分起点    结束（不含）
SEGMENTS="
a 2026-10-14 2026-10-14 2026-10-18
b 2026-10-16 2026-10-18 2026-10-21
c 2026-10-20 2026-10-21 2026-10-22
d 2026-10-21 2026-10-22 2026-10-23
e 2026-10-22 2026-10-23 2026-10-25
f 2026-10-23 2026-10-25 2026-10-28
g 2026-10-27 2026-10-28 2026-10-30
h 2026-10-29 2026-10-30 2026-11-04
"
i=0
while read -r seg warm score end; do
  [ -z "$seg" ] && continue
  sim="$round-$seg"
  # 断点续跑（44）：这段已跑完（DONE）就跳过；没跑完的交给 run-days.sh 从最近的存档点接着跑
  if [ -f "$root/$sim/DONE" ]; then echo "跳过 ${sim}（已跑完）"; continue; fi
  while [ "$(jobs -rp | wc -l)" -ge "$((MAX_PARALLEL + 1))" ]; do sleep 20; done
  (
    sh scripts/sim/run-days.sh "$warm" "$end" "$sim" "$((port + i))" >> "$root/$sim.run-days.out" 2>&1 || exit 1
    node scripts/sim/judge-sim.mjs --sim "$sim" --all --score-from "${score}T00:00:00+00:00" --conc 3 > "$root/$sim/judge.out" 2>&1
    echo "$warm $score $end" > "$root/$sim/DONE"
  ) &
  segpids="$segpids $!"
  i=$((i + 1))
  sleep 20 # 错开起跑：每段要 clone 业务仓、起网关
done <<< "$SEGMENTS"
wait $segpids
kill "$guard" 2>/dev/null
# 每轮的裁判与总账进版本：replay/falive/rounds/<轮>/（sim 目录本身体量大、可重跑，留在 runtime）
out="replay/falive/rounds/$round"
mkdir -p "$out"
for d in "$root/$round"-*; do [ -f "$d/judge.jsonl" ] && cp "$d/judge.jsonl" "$out/$(basename "$d").judge.jsonl"; done
node scripts/sim/round-report.mjs --round "$round" --issues --md "$out/report.md"
echo "ROUND-DONE $round"
