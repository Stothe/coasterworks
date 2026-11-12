#!/usr/bin/env bash
# The README's agent demo, headless: a sample park, opened, left to run a week, then asked what its
# guests think; then a carousel with a short queue and a snack stand are built beside the main path,
# opened, and left to run a month. It fails unless guests came in and paid at the gate, on the ride
# and at the stall. Run it from the repository root after `pnpm build`; CI runs it on Linux.
set -euo pipefail

cli=(node apps/cli/dist/index.js)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
park="$work/demo.park"

# The seed is fixed so the free tiles picked below are free: the sample park's layout depends on it.
"${cli[@]}" new --out "$park" --sample --seed 1 >/dev/null
# The sample park opens with its gate open; opening it again is harmless and is what an agent does.
"${cli[@]}" exec --save "$park" --command park_open --out "$park" >/dev/null
status=$("${cli[@]}" run --save "$park" --days 7 --out "$park")
thoughts=$("${cli[@]}" query --save "$park" --name guest_thoughts)

echo "after 7 days: $status"
echo "thoughts: $thoughts"

admissions=$(node -e 'const s = JSON.parse(process.argv[1]); console.log(s.totalAdmissions)' "$status")
entry=$(node -e 'const s = JSON.parse(process.argv[1]); console.log(s.income.entry)' "$status")
if [ "$admissions" -le 0 ] || [ "$entry" -le 0 ]; then
  echo "demo failed: $admissions admissions, $entry cents of entry fees" >&2
  exit 1
fi
echo "demo ok: $admissions admissions, $entry cents of entry fees"

# Field `$2` of the JSON in `$1`, by a dotted path such as `result.entrance.x`.
field() {
  node -e 'let v = JSON.parse(process.argv[1]); for (const k of process.argv[2].split(".")) v = v[k]; console.log(typeof v === "object" ? JSON.stringify(v) : v)' "$1" "$2"
}

exec_cmd() {
  "${cli[@]}" exec --save "$park" --command "$1" --input "$2" --out "$park"
}

# What there is to build, and what the carousel costs.
carousel=$("${cli[@]}" query --save "$park" --name content_list --input '{"kind":"ride"}')
cost=$(node -e 'const t = JSON.parse(process.argv[1]).result.find((r) => r.id === "carousel"); console.log(t.cost)' "$carousel")
echo "a carousel costs $cost cents"

# A carousel just east of the main path, turned so its entrance faces north: (37, 60) to (39, 62)
# on seed 1, entrance (38, 59), exit (36, 61) on the main path.
exec_cmd ride_build '{"type":"carousel","x":37,"y":60,"rot":2}' >/dev/null
# The id of the newest ride or stall of a type, from `ride_list`.
newest() {
  node -e 'const l = JSON.parse(process.argv[1]).result.filter((r) => r.type === process.argv[2]); console.log(l.at(-1).id)' "$("${cli[@]}" query --save "$park" --name ride_list)" "$1"
}
ride=$(newest carousel)
info=$("${cli[@]}" query --save "$park" --name ride_get --input "{\"id\":$ride}")
entrance=$(field "$info" result.entrance)
exit_tile=$(field "$info" result.exit)
if [ "$entrance" != '{"x":38,"y":59}' ] || [ "$exit_tile" != '{"x":36,"y":61}' ]; then
  echo "demo failed: the carousel's entrance is $entrance and exit $exit_tile" >&2
  exit 1
fi
# A short queue: the entrance tile and one more, which meets the main path at (36, 59).
queue='[{"x":38,"y":59},{"x":37,"y":59}]'
check=$("${cli[@]}" query --save "$park" --name path_check_tiles --input "{\"tiles\":$queue,\"kind\":\"queue\"}")
if [ "$(field "$check" result.refused)" != "[]" ]; then
  echo "demo failed: the queue cannot go there: $check" >&2
  exit 1
fi
exec_cmd path_build_tiles "{\"tiles\":$queue,\"kind\":\"queue\"}" >/dev/null
exec_cmd path_build_tiles "{\"tiles\":[$exit_tile],\"kind\":\"foot\"}" >/dev/null

# A snack stand west of the main path, serving onto it at (36, 62).
exec_cmd stall_build '{"type":"snack_stand","x":35,"y":62,"rot":3}' >/dev/null
stall=$(newest snack_stand)
service=$(field "$("${cli[@]}" query --save "$park" --name ride_get --input "{\"id\":$stall}")" result.service)
echo "built ride $ride (entrance $entrance, exit $exit_tile) and stall $stall (serving $service)"

exec_cmd ride_open "{\"id\":$ride}" >/dev/null
exec_cmd ride_open "{\"id\":$stall}" >/dev/null
month=$("${cli[@]}" run --save "$park" --days 31 --out "$park")
finance=$("${cli[@]}" query --save "$park" --name finance_summary)
rides=$(field "$month" rides)
stalls=$(field "$month" stalls)
ride_income=$(field "$finance" result.allTime.rides)
shop_income=$(field "$finance" result.allTime.shops)
running=$(field "$finance" result.allTime.running)

echo "after a month more: $rides ride(s), $stalls stall(s); ride income $ride_income cents, shop income $shop_income cents, running costs $running cents"
if [ "$rides" -ne 1 ] || [ "$stalls" -ne 1 ] || [ "$ride_income" -le 0 ] || [ "$shop_income" -le 0 ]; then
  echo "demo failed: rides and stalls did not take money" >&2
  exit 1
fi
echo "demo ok: $ride_income cents from the carousel, $shop_income cents from the snack stand"
