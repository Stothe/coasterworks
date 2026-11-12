#!/usr/bin/env bash
# The README's agent demo, headless: a sample park, opened, left to run a week, then asked what its
# guests think. It fails unless guests came in and paid. Run it from the repository root after
# `pnpm build`; CI runs it on Linux.
set -euo pipefail

cli=(node apps/cli/dist/index.js)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
park="$work/demo.park"

"${cli[@]}" new --out "$park" --sample >/dev/null
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
