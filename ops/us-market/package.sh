#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 1 ]]; then
  echo 'Usage: package.sh OUTPUT.tar.gz' >&2
  exit 2
fi
repo=$(git -C "$(dirname -- "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)
sha=$(git -C "$repo" rev-parse HEAD)
output=$(realpath -m -- "$1")
stage=$(mktemp -d)
trap 'rm -rf -- "$stage"' EXIT
for file in collect.py collect_us.py indicators.py requirements.txt test_collect.py; do
  git -C "$repo" show "$sha:research/market-data/$file" > "$stage/$file"
done
for file in finance-us-market.service finance-us-market.timer; do
  git -C "$repo" show "$sha:ops/us-market/$file" > "$stage/$file"
done
printf '%s\n' "$sha" > "$stage/COMMIT_SHA"
tar -C "$stage" -czf "$output" -- COMMIT_SHA collect.py collect_us.py indicators.py requirements.txt \
  test_collect.py finance-us-market.service finance-us-market.timer
printf 'Collector package %s (%s)\n' "$output" "$sha"
