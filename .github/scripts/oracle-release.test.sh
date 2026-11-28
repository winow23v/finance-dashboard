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

# Run the receiver against an isolated filesystem and fake systemd. Keep its
# actual cache preparation, validation, runtime swap and EXIT rollback logic.
sandbox="$fixture/dart-release"
mkdir -p "$sandbox/bin" "$sandbox/live/node_modules" "$sandbox/dropins"
cp -- "$repo/vps-api/server.mjs" "$sandbox/live/server.mjs"
cp -- "$repo/vps-api/market-cache.mjs" "$work/market-cache.mjs"
printf 'candidate runtime\n' > "$work/server.mjs"
tar -cf "$sandbox/incoming.tar" -C "$work" .
cat > "$sandbox/bin/systemctl" <<'SH'
#!/usr/bin/env bash
case "$*" in
  'show -p User --value finance-dashboard-api.service') id -un ;;
  'show -p Group --value finance-dashboard-api.service') id -gn ;;
  'show -p ProtectSystem --value finance-dashboard-api.service') echo strict ;;
  'show -p DynamicUser --value finance-dashboard-api.service') echo no ;;
  'show -p ReadWritePaths --value finance-dashboard-api.service')
    printf '%s\n' "/var/lib/finance-krx /var/lib/finance-us-market $TEST_SANDBOX/state/financials" ;;
  'show -p MainPID --value finance-dashboard-api.service') echo "$TEST_PID" ;;
  'show -p InvocationID --value finance-dashboard-api.service') printf '%032d\n' 1 ;;
  is-active*) exit 0 ;;
  *)
    printf '%s\n' "$1" >> "$TEST_SANDBOX/service-actions"
    if [[ $1 == start && -n ${FAIL_DART_CONFIGURATION:-} ]]; then
      touch "$TEST_SANDBOX/fail-mount"
    elif [[ $1 == restart ]]; then
      rm -f "$TEST_SANDBOX/fail-mount"
    fi ;;

esac
SH
cat > "$sandbox/bin/runuser" <<'SH'
#!/usr/bin/env bash
shift 3
exec "$@"
SH
cat > "$sandbox/bin/npm" <<'SH'
#!/usr/bin/env bash
mkdir -p node_modules
SH
cat > "$sandbox/bin/findmnt" <<'SH'
#!/usr/bin/env bash
if [[ -e $TEST_SANDBOX/fail-mount ]]; then echo ro,nosuid,nodev; else echo rw,nosuid,nodev; fi
SH
cat > "$sandbox/bin/nsenter" <<'SH'
#!/usr/bin/env bash
shift 4
exec "$@"
SH
printf '#!/usr/bin/env bash\necho 200\n' > "$sandbox/bin/curl"
printf '#!/usr/bin/env bash\nexit 0\n' > "$sandbox/bin/restorecon"
chmod +x "$sandbox/bin/"*
sed -e 's|^api=.*|api=$TEST_SANDBOX/live|' \
  -e 's|^dart_parent=.*|dart_parent=$TEST_SANDBOX/state|' \
  -e 's|^dart_dropin_dir=.*|dart_dropin_dir=$TEST_SANDBOX/dropins|' \
  -e 's|^deploy_user=.*|deploy_user=$(id -un)|' \
  -e 's|^dart_user=.*|dart_user=$(id -un)|' \
  -e 's|^dart_group=.*|dart_group=$(id -gn)|' \
  -e 's/\$EUID != 0 || //' \
  -e 's|-o root -g root|-o "$dart_user" -g "$dart_group"|' \
  -e 's|"\$dart_parent" root:root 755|"$dart_parent" "$dart_user:$dart_group" 755|' \
  "$script" > "$sandbox/receiver"
cat > "$sandbox/bin/fixture-release" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
export TEST_PID=$$
{ printf '%s\n' "$1"; cat "$TEST_SANDBOX/incoming.tar"; } | bash "$TEST_SANDBOX/receiver"
SH
chmod +x "$sandbox/bin/fixture-release"
export TEST_SANDBOX="$sandbox"
DART_FINANCIAL_CACHE_DIR="$sandbox/state/financials" DART_FINANCIAL_CACHE_VERIFY=1 bash -euc '
  export PATH="$TEST_SANDBOX/bin:$PATH"
  sandbox=$TEST_SANDBOX
  cache=$DART_FINANCIAL_CACHE_DIR
  dropin="$sandbox/dropins/90-dart-financial-cache.conf"
  release() {
    if [[ -e $dropin || $1 == deploy-dart-cache-v1 ]]; then
      fixture-release "$1"
    else
      env -u DART_FINANCIAL_CACHE_DIR fixture-release "$1"
    fi
  }
  release validate-dart-cache-v1
  if FINANCE_STORAGE_SYNC=1 fixture-release validate-dart-cache-v1; then
    echo "Validation accepted enabled storage sync" >&2
    exit 1
  fi
  if DART_FINANCIAL_CACHE_DIR="$sandbox/alternate" fixture-release validate-dart-cache-v1; then
    echo "Validation accepted a conflicting cache override" >&2
    exit 1
  fi
  mkdir "$sandbox/live/.dart-cache"
  printf legacy > "$sandbox/live/.dart-cache/005930-0.json"
  if release validate-dart-cache-v1; then
    echo "Validation accepted an unmigrated legacy snapshot" >&2
    exit 1
  fi
  printf "[Service]\nEnvironment=DART_FINANCIAL_CACHE_DIR=%s\nEnvironment=DART_FINANCIAL_CACHE_VERIFY=1\nReadWritePaths=%s\n" "$cache" "$cache" > "$dropin"
  if env -u DART_FINANCIAL_CACHE_DIR fixture-release deploy-dart-cache-v1; then
    echo "Deployment accepted unmigrated snapshots with a staged drop-in" >&2
    exit 1
  fi
  [[ ! -e $cache && ! -e $sandbox/service-actions ]]
  mkdir -m 0755 "$sandbox/state"
  mkdir -m 0700 "$cache"
  install -m 0600 "$sandbox/live/.dart-cache/005930-0.json" "$cache/005930-0.json"
  if env -u DART_FINANCIAL_CACHE_DIR fixture-release deploy-dart-cache-v1; then
    echo "Deployment accepted a drop-in that was not active before release" >&2
    exit 1
  fi
  [[ ! -e $sandbox/service-actions ]]
  rm -- "$dropin"
  release validate-dart-cache-v1
  mv "$sandbox/live/.dart-cache" "$sandbox/legacy-fixture"
  mv "$sandbox/state" "$sandbox/migrated-fixture"
  if FAIL_DART_CONFIGURATION=1 release deploy-dart-cache-v1; then
    echo "Expected first deployment to roll back" >&2
    exit 1
  fi
  [[ ! -e $dropin && -d $cache ]]
  release deploy-dart-cache-v1
  [[ $(stat -c %a "$cache") == 700 ]]
  diff -u <(printf "[Service]\\nEnvironment=DART_FINANCIAL_CACHE_DIR=%s\\nEnvironment=DART_FINANCIAL_CACHE_VERIFY=1\\nReadWritePaths=%s\\n" "$cache" "$cache") "$dropin"
  printf snapshot > "$cache/005930-0.json"
  chmod 0600 "$cache/005930-0.json"
  snapshot=$(stat -c "%i:%a:%u:%g" "$cache/005930-0.json")
  actions=$(cat "$sandbox/service-actions")
  release validate-dart-cache-v1
  release deploy-dart-cache-v1
  [[ $(cat "$sandbox/service-actions") == "$actions" ]]
  release redeploy-dart-cache-v1
  [[ $(cat "$sandbox/service-actions") != "$actions" ]]
  actions=$(cat "$sandbox/service-actions")
  mkdir "$sandbox/next"
  tar -xf "$sandbox/incoming.tar" -C "$sandbox/next"
  printf "manually staged runtime\n" > "$sandbox/next/server.mjs"
  tar -cf "$sandbox/incoming.tar" -C "$sandbox/next" .
  cp -- "$sandbox/next/server.mjs" "$sandbox/live/server.mjs"
  release deploy-dart-cache-v1
  [[ $(cat "$sandbox/service-actions") != "$actions" ]]
  printf "replacement runtime\n" > "$sandbox/next/server.mjs"
  tar -cf "$sandbox/incoming.tar" -C "$sandbox/next" .
  if FAIL_DART_CONFIGURATION=1 release deploy-dart-cache-v1; then
    echo "Expected release to roll back after its configuration check failed" >&2
    exit 1
  fi
  cmp -s "$sandbox/live/server.mjs" <(printf "manually staged runtime\\n")
  [[ $(stat -c "%i:%a:%u:%g" "$cache/005930-0.json") == "$snapshot" ]]
  [[ $(cat "$cache/005930-0.json") == snapshot && -f $dropin ]]
  tail -n 1 "$sandbox/service-actions" | grep -Fxq restart
'
echo 'Oracle persistent DART cache validation, redeploy and rollback passed'

# The real entry point probes in the API process before starting other providers.
touch "$sandbox/not-a-directory"
if env -i DART_FINANCIAL_CACHE_VERIFY=1 DART_FINANCIAL_CACHE_DIR="$sandbox/not-a-directory/cache" FINANCE_LOCAL_INDEX_RESEARCH=1 \
  "$(command -v node)" "$repo/vps-api/server.mjs" 2> "$sandbox/startup.log"; then
  echo 'API started with an unusable DART cache' >&2
  exit 1
fi
grep -Fqx '{"event":"dart-financial-cache-error","stage":"directory-prepare","osCode":"ENOTDIR"}' "$sandbox/startup.log"
! grep -Fq "$sandbox" "$sandbox/startup.log"

if env -i DART_FINANCIAL_CACHE_VERIFY=1 FINANCE_STORAGE_SYNC=1 DART_FINANCIAL_CACHE_DIR="$sandbox/not-a-directory/cache" \
  "$(command -v node)" "$repo/vps-api/server.mjs" 2> "$sandbox/storage-startup.log"; then
  echo 'API started with storage sync enabled in verified DART cache mode' >&2
  exit 1
fi
grep -Fq 'Verified DART cache mode requires financial storage sync to be disabled' "$sandbox/storage-startup.log"
! grep -Fq 'dart-financial-cache-error' "$sandbox/storage-startup.log"
