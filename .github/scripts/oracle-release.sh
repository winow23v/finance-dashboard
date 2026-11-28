#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

api=/opt/finance-dashboard/vps-api
service=finance-dashboard-api.service
deploy_user=finance-deploy
health_url=http://127.0.0.1:3000/health

dart_parent=/var/lib/finance-dart
dart_cache=$dart_parent/financials
dart_dropin_dir=/etc/systemd/system/$service.d
dart_dropin=$dart_dropin_dir/90-dart-financial-cache.conf
dart_user=rocky
dart_group=rocky

dart_settings() {
  printf '[Service]\nEnvironment=DART_FINANCIAL_CACHE_DIR=%s\nReadWritePaths=%s\n' "$dart_cache" "$dart_cache"
}

check_dart_directory() {
  local path=$1 owner=$2 mode=$3
  [[ ! -L $path ]] || return 1
  if [[ -e $path ]]; then
    [[ -d $path && $(stat -c '%U:%G:%a' -- "$path") == "$owner:$mode" ]]
  fi
}

prepare_dart_directory() {
  if [[ ! -d $dart_parent ]]; then
    install -d -o root -g root -m 0755 -- "$dart_parent"
  fi
  if [[ ! -d $dart_cache ]]; then
    install -d -o "$dart_user" -g "$dart_group" -m 0700 -- "$dart_cache"
    if command -v restorecon >/dev/null; then
      restorecon -- "$dart_parent" "$dart_cache"
    fi
  fi
}

service_pid() {
  local pid
  pid=$(systemctl show -p MainPID --value "$service") || return 1
  [[ $pid =~ ^[1-9][0-9]*$ ]] || return 1
  printf '%s\n' "$pid"
}

check_storage_disabled() {
  local pid=$1 result=0
  grep -zFxq -- 'FINANCE_STORAGE_SYNC=1' "/proc/$pid/environ" || result=$?
  [[ $result == 1 ]]
}

check_cache_override() {
  local pid=$1 result=0
  grep -zq -- '^DART_FINANCIAL_CACHE_DIR=' "/proc/$pid/environ" || result=$?
  case $result in
    0) grep -zFxq -- "DART_FINANCIAL_CACHE_DIR=$dart_cache" "/proc/$pid/environ" ;;
    1) return 0 ;;
    *) return 1 ;;
  esac
}

check_legacy_snapshots() {
  local legacy destination
  for legacy in "$api"/.dart-cache/??????-[012].json; do
    [[ -e $legacy || -L $legacy ]] || continue
    destination="$dart_cache/${legacy##*/}"
    [[ -f $legacy && ! -L $legacy && -f $destination && ! -L $destination ]] &&
      [[ $(stat -c '%U:%G:%a' -- "$destination") == "$dart_user:$dart_group:600" ]] &&
      cmp -s -- "$legacy" "$destination" || return 1
  done
}

check_dart_service() {
  local pid mounts writable_paths
  writable_paths=$(systemctl show -p ReadWritePaths --value "$service") || return 1
  [[ " $writable_paths " == *" $dart_cache "* ]] || return 1
  pid=$(service_pid) || return 1
  grep -zFxq -- "DART_FINANCIAL_CACHE_DIR=$dart_cache" "/proc/$pid/environ" || return 1
  check_storage_disabled "$pid" || return 1
  mounts=$(nsenter -t "$pid" -m -- findmnt -n -o VFS-OPTIONS -T "$dart_cache") || return 1
  [[ ,$mounts, == *,rw,* ]]
}

check_health() {
  local attempt status
  for ((attempt = 1; attempt <= 15; attempt++)); do
    if systemctl is-active --quiet "$service" &&
      status=$(curl --noproxy '*' --silent --max-time 2 --output /dev/null \
        --write-out '%{http_code}' "$health_url") && [[ $status == 200 ]]; then
      return 0
    fi
    sleep 2
  done
  return 1
}

if [[ $EUID != 0 || $# != 0 ]]; then
  echo 'Run the installed release command as root without arguments.' >&2
  exit 1
fi
IFS= read -r mode
case "$mode" in
  validate|deploy) ;;
  validate-dart-cache-v1|deploy-dart-cache-v1) mode=${mode%-dart-cache-v1} ;;
  *) echo 'Invalid release mode.' >&2; exit 1 ;;
esac

exec 9>"${api}.deploy.lock"
flock -n 9 || { echo 'An Oracle release is already running.' >&2; exit 1; }
[[ -d $api && ! -L $api && -f $api/server.mjs && -d $api/node_modules ]]
work=$(mktemp -d /tmp/finance-api.XXXXXXXX)
release=
backup=
restart_required=0
dart_dropin_added=0
dart_dropin_stage=

finish() {
  local result=$?
  trap - EXIT
  trap '' HUP INT TERM
  if (( result != 0 && (restart_required || dart_dropin_added) )); then
    echo 'Release failed. Restoring the previous API.' >&2
    if [[ -n $backup && -d $backup ]]; then
      if ! systemctl stop "$service" ||
        { [[ -e $api ]] && ! mv -T -- "$api" "$release/failed"; } ||
        ! mv -T -- "$backup" "$api"; then
        echo "Automatic rollback could not restore files. Inspect $backup and $release." >&2
        exit "$result"
      fi
    fi
    if (( dart_dropin_added )); then
      if ! rm -f -- "$dart_dropin" || ! systemctl daemon-reload; then
        echo 'Rollback could not restore the DART systemd configuration.' >&2
        exit "$result"
      fi
    fi
    if (( restart_required )); then
      if ! systemctl restart "$service" || ! check_health; then
        echo 'Rollback could not verify the restored service. Check systemd and /health.' >&2
        exit "$result"
      fi
    fi
    echo 'Previous API restored and healthy.'
  fi
  if [[ -n $dart_dropin_stage ]]; then
    rm -f -- "$dart_dropin_stage"
  fi
  rm -rf -- "$work"
  if [[ -n $release && ! -d $release/failed ]]; then
    rm -rf -- "$release"
  fi
  exit "$result"
}
trap finish EXIT
trap 'exit 1' HUP INT TERM

# Extract and install dependencies as the deployment account, outside the live tree.
chown -- "$deploy_user" "$work"
runuser -u "$deploy_user" -- bash -euc '
  cd "$1"
  tar --extract --file=- --no-same-owner --no-same-permissions
  shopt -s dotglob nullglob
  for entry in *; do
    [[ -f $entry && ! -L $entry ]]
    case "$entry" in
      sec-provider.mjs) exit 1 ;;
      server.mjs|market-cache.mjs|krx-backfill.mjs|*-provider.mjs|*.test.mjs|package.json|package-lock.json) ;;
      *) exit 1 ;;
    esac
  done
  test -f server.mjs
  test -f package-lock.json
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund --maxsockets=4
' bash "$work" 9>&-

# Preserve local configuration, ownership and attributes. Update only the release files.
release=$(mktemp -d "${api}.release.XXXXXXXX")
cp -a -- "$api" "$release/api"
# Retire SEC EDGAR from the candidate only. The live tree and rollback copy stay intact.
rm -f -- "$release/api/sec-provider.mjs"
rm -rf -- "$release/api/node_modules"
cp -a -- "$work/node_modules" "$release/api/node_modules"
chown -hR --reference="$api/node_modules" "$release/api/node_modules"
runtime_files=("$work"/server.mjs "$work"/market-cache.mjs "$work"/*-provider.mjs
  "$work"/package.json "$work"/package-lock.json)
if [[ -f $work/krx-backfill.mjs ]]; then
  runtime_files+=("$work/krx-backfill.mjs")
fi
for file in "${runtime_files[@]}"; do
  target="$release/api/${file##*/}"
  if [[ -f $target && ! -L $target ]]; then
    install -o "$(stat -c %u "$target")" -g "$(stat -c %g "$target")" \
      -m "$(stat -c %a "$target")" -- "$file" "$target"
  else
    install -o "$(stat -c %u "$api")" -g "$(stat -c %g "$api")" -m 0644 -- "$file" "$target"
  fi
done

check_health || { echo 'Current production API is unhealthy.' >&2; exit 1; }
pid=$(service_pid) && check_storage_disabled "$pid" ||
  { echo 'The running API must have financial storage sync disabled.' >&2; exit 1; }
check_cache_override "$pid" ||
  { echo 'Reconcile the existing DART_FINANCIAL_CACHE_DIR setting before release.' >&2; exit 1; }
[[ $(systemctl show -p User --value "$service") == "$dart_user" ]]
[[ $(systemctl show -p ProtectSystem --value "$service") == strict ]]
[[ $(systemctl show -p DynamicUser --value "$service") == no ]]
service_group=$(systemctl show -p Group --value "$service")
[[ ${service_group:-$(id -gn "$dart_user")} == "$dart_group" ]]
check_dart_directory "$dart_parent" root:root 755 &&
  check_dart_directory "$dart_cache" "$dart_user:$dart_group" 700 ||
  { echo 'DART cache directory ownership, permissions or type is invalid.' >&2; exit 1; }
[[ ! -L $dart_dropin_dir && ! -L $dart_dropin ]]
dart_configured=0
legacy_cache_active=0
if ! grep -zFxq -- "DART_FINANCIAL_CACHE_DIR=$dart_cache" "/proc/$pid/environ"; then
  legacy_cache_active=1
  if ! check_legacy_snapshots; then
    echo 'Migrate existing DART snapshots into the persistent cache with mode 0600 before release.' >&2
    exit 1
  fi
fi
if [[ -e $dart_dropin ]]; then
  if [[ ! -f $dart_dropin ]] || ! cmp -s -- "$dart_dropin" <(dart_settings); then
    echo 'Existing DART systemd drop-in conflicts with the release configuration.' >&2
    exit 1
  fi
  if [[ -d $dart_cache ]] && check_dart_service; then
    dart_configured=1
  fi
fi
if [[ $mode == validate ]]; then
  if (( dart_configured )); then
    echo 'Persistent DART cache path and active systemd configuration verified.'
  elif [[ -e $dart_dropin ]]; then
    echo 'Installed DART configuration is not effective in the running service.' >&2
    exit 1
  else
    echo 'DART cache prerequisites verified. Deploy will prepare the cache and install its systemd drop-in.'
  fi
  echo 'SSH, staged release and existing API health verified.'
  exit 0
fi

if (( dart_configured )) && [[ ! -e $api/sec-provider.mjs && ! -L $api/sec-provider.mjs ]] &&
  diff -qr --no-dereference -- "$api/node_modules" "$release/api/node_modules" >/dev/null; then
  unchanged=1
  for file in "${runtime_files[@]}"; do
    if ! cmp -s -- "$file" "$api/${file##*/}"; then
      unchanged=0
      break
    fi
  done
  if (( unchanged )); then
    echo 'Oracle API and persistent DART configuration are already current.'
    exit 0
  fi
fi

prepare_dart_directory
if [[ ! -e $dart_dropin ]]; then
  if [[ ! -d $dart_dropin_dir ]]; then
    install -d -m 0755 -- "$dart_dropin_dir"
  fi
  dart_dropin_stage=$(mktemp "$dart_dropin_dir/.dart-financial-cache.XXXXXXXX")
  dart_settings > "$dart_dropin_stage"
  chmod 0644 -- "$dart_dropin_stage"
  dart_dropin_added=1
  mv -T -- "$dart_dropin_stage" "$dart_dropin"
fi
if (( ! dart_configured )); then
  systemctl daemon-reload
fi
backup="${api}.backup.$(date -u +%Y%m%dT%H%M%SZ).${release##*.}"
restart_required=1
systemctl stop "$service"
if (( legacy_cache_active )) && ! check_legacy_snapshots; then
  echo 'Legacy DART snapshots changed during staging. Reconcile the cache before retrying.' >&2
  exit 1
fi
mv -T -- "$api" "$backup"
echo "Rollback backup: $backup"
mv -T -- "$release/api" "$api"
systemctl start "$service"
check_health || { echo 'Released API failed the health check.' >&2; exit 1; }
check_dart_service || { echo 'Released API failed the DART cache configuration check.' >&2; exit 1; }
restart_required=0
echo 'Oracle API deployed and healthy.'
