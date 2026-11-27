#!/usr/bin/env bash
set -euo pipefail

repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
workflow="$repo/.github/workflows/oracle-vps.yml"
script="$repo/.github/scripts/oracle-release.sh"
bash -n "$script"
fixture=$(mktemp -d)
trap 'rm -rf -- "$fixture"' EXIT

required=(
  server.mjs market-cache.mjs krx-backfill.mjs oci-monitor-status-provider.mjs oci-monitor-web-provider.mjs package.json package-lock.json
  membership-provider.mjs market-index-provider.mjs krx-provider.mjs krx-calendar-provider.mjs us-market-provider.mjs
  fred-provider.mjs ecos-provider.mjs dart-provider.mjs fx-provider.mjs public-provider.mjs
)

# Check the production sender's pathspec against a disposable repository
# containing the retired file, even after that file has been deleted from main.
selection=$(sed -n '/^[[:space:]]*release_files=($/,/^[[:space:]]*)$/p' "$workflow")
[[ -n $selection ]]
mkdir -p "$fixture/sender/vps-api"
git init -q "$fixture/sender"
ship_tests=(krx-provider.test.mjs)
excluded=(sec-provider.mjs krx-backfill-extra.mjs api.env .env)
for file in "${required[@]}" "${ship_tests[@]}" "${excluded[@]}"; do
  touch "$fixture/sender/vps-api/$file"
done
for file in krx-backfill.mjs krx-provider.mjs krx-calendar-provider.mjs public-provider.mjs oci-monitor-status-provider.mjs oci-monitor-web-provider.mjs; do
  cp -- "$repo/vps-api/$file" "$fixture/sender/vps-api/$file"
done
mkdir "$fixture/sender/vps-api/.krx-cache"
touch "$fixture/sender/vps-api/.krx-cache/krx-request-budget.json"
git -C "$fixture/sender" add -- vps-api
work="$fixture/staged"
mkdir "$work"
(
  cd "$fixture/sender"
  bash -euo pipefail -c "$selection"$'\n''git ls-files -z -- "${release_files[@]}" |
    tar --null --transform="s|^vps-api/||" -cf "$1" -T -' bash "$fixture/api.tar"
)
diff -u <(printf '%s\n' "${required[@]}" "${ship_tests[@]}" | sort) <(tar -tf "$fixture/api.tar" | sort)
tar -xf "$fixture/api.tar" -C "$work"

# Run the receiver's actual filename rules against permitted and retired files.
rules=$(sed -n '/^[[:space:]]*case "\$entry" in$/,/^[[:space:]]*esac$/p' "$script")
[[ -n $rules ]]
for file in "${required[@]}" "${ship_tests[@]}"; do
  bash -euc 'entry=$1'$'\n'"$rules" bash "$file"
done
for file in "${excluded[@]}" .krx-cache; do
  if bash -euc 'entry=$1'$'\n'"$rules" bash "$file"; then
    echo "Oracle receiver accepted excluded entry: $file" >&2
    exit 1
  fi
done

# Execute only the candidate-copy section. No service commands are executed.
copy_candidate=$(awk '
  /^cp -a -- "\$api" "\$release\/api"$/ { copying=1 }
  /^rm -rf -- "\$release\/api\/node_modules"$/ { copying=0; bounded=1; exit }
  copying { print }
  END { if (!bounded) exit 1 }
' "$script")
[[ -n $copy_candidate ]]
api="$fixture/live"
release="$fixture/release"
backup="$fixture/backup"
mkdir -p "$api/.krx-cache/member" "$release" "$backup"
printf 'old runtime\n' > "$api/sec-provider.mjs"
printf 'untouched rollback\n' > "$backup/sec-provider.mjs"
printf 'local settings fixture\n' > "$api/api.env"
printf 'existing OHLCV fixture\n' > "$api/.krx-cache/member/ohlcv-KOSPI-2026-11-20.json"
chmod 0600 "$api/api.env" "$api/.krx-cache/member/ohlcv-KOSPI-2026-11-20.json"
api="$api" release="$release" bash -euc "$copy_candidate"
[[ ! -e $release/api/sec-provider.mjs && ! -L $release/api/sec-provider.mjs ]]
grep -Fxq 'old runtime' "$api/sec-provider.mjs"
grep -Fxq 'untouched rollback' "$backup/sec-provider.mjs"
cmp -s "$api/api.env" "$release/api/api.env"
install_candidate=$(awk '
  /^runtime_files=\(/ { copying=1 }
  copying { print }
  copying && /^done$/ { bounded=1; exit }
  END { if (!bounded) exit 1 }
' "$script")

# Older archives still stage without a CLI. The new archive installs it
# without running it or changing the live tree or its rollback backup.
mv -- "$work/krx-backfill.mjs" "$fixture/krx-backfill.mjs"
api="$api" release="$release" work="$work" bash -euc "$install_candidate"
[[ ! -e $release/api/krx-backfill.mjs ]]
mv -- "$fixture/krx-backfill.mjs" "$work/krx-backfill.mjs"
api="$api" release="$release" work="$work" bash -euc "$install_candidate"
cmp -s "$repo/vps-api/oci-monitor-status-provider.mjs" "$release/api/oci-monitor-status-provider.mjs"
cmp -s "$repo/vps-api/oci-monitor-web-provider.mjs" "$release/api/oci-monitor-web-provider.mjs"
cli="$release/api/krx-backfill.mjs"
cmp -s "$work/krx-backfill.mjs" "$cli"
[[ $(stat -c '%a:%u:%g' "$cli") == "644:$(stat -c '%u:%g' "$api")" ]]
[[ ! -e $release/api/krx-provider.test.mjs && ! -e $api/krx-backfill.mjs ]]
printf 'previous CLI\n' > "$api/krx-backfill.mjs"
cp -p -- "$api/krx-backfill.mjs" "$backup/krx-backfill.mjs"
install -m 0640 -- "$api/krx-backfill.mjs" "$cli"
api="$api" release="$release" work="$work" bash -euc "$install_candidate"
cmp -s "$work/krx-backfill.mjs" "$cli"
[[ $(stat -c '%a:%u:%g' "$cli") == "640:$(stat -c '%u:%g' "$api/krx-backfill.mjs")" ]]
cmp -s "$api/krx-backfill.mjs" "$backup/krx-backfill.mjs"
for local_file in api.env .krx-cache/member/ohlcv-KOSPI-2026-11-20.json; do
  cmp -s "$api/$local_file" "$release/api/$local_file"
  [[ $(stat -c '%a:%u:%g' "$api/$local_file") == "$(stat -c '%a:%u:%g' "$release/api/$local_file")" ]]
done

# Run the installed CLI on a disposable member cache. It sees the collector's
# rolling ledger and cannot dispatch while the collection lock is held.
cache="$fixture/member-cache"
mkdir "$cache"
cat > "$fixture/no-upstream.mjs" <<'EOF'
Date.now = () => Date.parse('2026-11-25T01:10:00Z')
globalThis.fetch = () => { throw new Error('Unexpected upstream call in release fixture') }
EOF
printf '%s\n' '{"requests":[1795568940000],"blockedUntil":0,"lastDispatch":0}' > "$cache/krx-request-budget.json"
export KRX_MEMBER_CACHE_DIR="$cache" KRX_CALENDAR_OVERRIDES='' KRX_API_KEY=fixture
plan=$(node --import "$fixture/no-upstream.mjs" "$cli" --member --plan 2026-11-23)
node -e '
  const plan = JSON.parse(process.argv[1])
  if (plan.root !== process.env.KRX_MEMBER_CACHE_DIR || plan.attempts !== 0 ||
      plan.maxRequests !== 4 || plan.remainingRequests !== 299) process.exit(1)
' "$plan"
if flock "$cache/backfill.flock" node --import "$fixture/no-upstream.mjs" "$cli" \
  --member --apply 2026-11-23 > "$fixture/busy-out" 2> "$fixture/busy-err"; then
  echo 'Oracle-installed CLI ignored the collector lock' >&2
  exit 1
fi
grep -Fq '"stopped":"KRX_BACKFILL_BUSY"' "$fixture/busy-err"
[[ ! -e $cache/krx-missing-recovery.json ]]
echo 'Oracle packaging, CLI installation and shared cache controls passed'
