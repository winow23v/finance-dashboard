#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

api=/opt/finance-dashboard/vps-api
service=finance-dashboard-api.service
deploy_user=finance-deploy
health_url=http://127.0.0.1:3000/health

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
  *) echo 'Invalid release mode.' >&2; exit 1 ;;
esac

exec 9>"${api}.deploy.lock"
flock -n 9 || { echo 'An Oracle release is already running.' >&2; exit 1; }
[[ -d $api && ! -L $api && -f $api/server.mjs && -d $api/node_modules ]]
work=$(mktemp -d /tmp/finance-api.XXXXXXXX)
release=
backup=
restart_required=0

finish() {
  local result=$?
  trap - EXIT
  trap '' HUP INT TERM
  if (( result != 0 && restart_required )); then
    echo 'Release failed. Restoring the previous API.' >&2
    if [[ -n $backup && -d $backup ]]; then
      if ! systemctl stop "$service" ||
        { [[ -e $api ]] && ! mv -T -- "$api" "$release/failed"; } ||
        ! mv -T -- "$backup" "$api"; then
        echo "Automatic rollback could not restore files. Inspect $backup and $release." >&2
        exit "$result"
      fi
    fi
    if ! systemctl restart "$service" || ! check_health; then
      echo 'Rollback could not verify the restored service. Check systemd and /health.' >&2
      exit "$result"
    fi
    echo 'Previous API restored and healthy.'
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
      server.mjs|market-cache.mjs|*-provider.mjs|*.test.mjs|package.json|package-lock.json) ;;
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
for file in "$work"/server.mjs "$work"/market-cache.mjs "$work"/*-provider.mjs \
  "$work"/package.json "$work"/package-lock.json; do
  target="$release/api/${file##*/}"
  if [[ -f $target && ! -L $target ]]; then
    install -o "$(stat -c %u "$target")" -g "$(stat -c %g "$target")" \
      -m "$(stat -c %a "$target")" -- "$file" "$target"
  else
    install -o "$(stat -c %u "$api")" -g "$(stat -c %g "$api")" -m 0644 -- "$file" "$target"
  fi
done

check_health || { echo 'Current production API is unhealthy.' >&2; exit 1; }
if [[ $mode == validate ]]; then
  echo 'SSH, staged release and existing API health verified.'
  exit 0
fi

backup="${api}.backup.$(date -u +%Y%m%dT%H%M%SZ).${release##*.}"
restart_required=1
systemctl stop "$service"
mv -T -- "$api" "$backup"
echo "Rollback backup: $backup"
mv -T -- "$release/api" "$api"
systemctl start "$service"
check_health || { echo 'Released API failed the health check.' >&2; exit 1; }
restart_required=0
echo 'Oracle API deployed and healthy.'
