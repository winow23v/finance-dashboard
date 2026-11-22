#!/usr/bin/env bash
set -euo pipefail
umask 027

base=/opt/finance-us-market
state=/var/lib/finance-us-market
service=finance-us-market.service
timer=finance-us-market.timer
collector=finance-us-collector
group=finance-us-market
python=${US_MARKET_PYTHON:-python3.12}
command=${1:-}

fail() { printf '%s\n' "$*" >&2; exit 1; }
check_sha() { [[ $1 =~ ^[a-f0-9]{40}$ ]] || fail 'Expected a full commit SHA.'; }
check_python() {
  "$python" -c 'import sys; sys.exit(sys.version_info[:2] != (3, 12))' ||
    fail 'Python 3.12 with venv and pip is required.'
}

extract() {
  "$python" - "$1" "$2" "$3" <<'PY'
import pathlib
import sys
import tarfile

archive, directory, expected_sha = sys.argv[1:]
names = {"COMMIT_SHA", "collect.py", "collect_us.py", "indicators.py", "requirements.txt",
         "test_collect.py", "finance-us-market.service", "finance-us-market.timer"}
with tarfile.open(archive, "r:gz") as package:
    members = {}
    for entry in package:
        if (entry.name not in names or entry.name in members
                or not entry.isfile() or not 0 < entry.size <= 256 * 1024):
            sys.exit("Unexpected collector package entry")
        members[entry.name] = entry
    if set(members) != names or package.extractfile(members["COMMIT_SHA"]).read() != (expected_sha + "\n").encode():
        sys.exit("Collector package file list or commit SHA mismatch")
    for name, entry in members.items():
        with (pathlib.Path(directory) / name).open("xb") as destination:
            destination.write(package.extractfile(entry).read())
PY
}

verify_units() {
  local release=$1 executable=$2 scratch
  scratch=$(mktemp -d)
  if ! (
    trap 'rm -rf -- "$scratch"' EXIT
    grep -Fxq 'ExecStart=/opt/finance-us-market/current/venv/bin/python /opt/finance-us-market/current/collect_us.py --cache /var/lib/finance-us-market/data --queue /var/lib/finance-us-market/queue' "$release/$service" || exit 1
    grep -Fxq 'ConditionPathExists=/etc/finance-dashboard/us-market-enabled' "$release/$service" || exit 1
    sed "s|^ExecStart=.*|ExecStart=$executable|" "$release/$service" > "$scratch/$service" || exit 1
    cp -- "$release/$timer" "$scratch/$timer" || exit 1
    systemd-analyze verify "$scratch/$service" "$scratch/$timer"
  ); then
    fail 'Collector systemd unit verification failed.'
  fi
}

build_release() {
  local release=$1
  "$python" -m venv "$release/venv"
  "$release/venv/bin/python" -m pip --disable-pip-version-check --no-cache-dir install \
    --only-binary=:all: -r "$release/requirements.txt"
  "$release/venv/bin/python" -m pip check
  "$release/venv/bin/python" -m py_compile "$release/"*.py
  "$release/venv/bin/python" -m pytest -q -p no:cacheprovider "$release/test_collect.py"
  "$release/venv/bin/python" "$release/collect_us.py" --help >/dev/null
  verify_units "$release" "$release/venv/bin/python"
}

if [[ $command == verify ]]; then
  [[ $# == 3 ]] || fail 'Usage: install.sh verify ARCHIVE SHA'
  check_sha "$3"
  check_python
  work=$(mktemp -d)
  trap 'rm -rf -- "$work"' EXIT
  extract "$2" "$work" "$3"
  build_release "$work"
  printf 'Verified collector %s in an isolated directory.\n' "$3"
  exit
fi

[[ $EUID == 0 ]] || fail 'Use sudo for Oracle installation commands.'
[[ $command == stage || $command == select || $command == check-access ]] ||
  fail 'Usage: install.sh {stage ARCHIVE SHA | select SHA | check-access FASTIFY_USER}'
install -d -o root -g root -m 0755 "$base" "$base/releases"
exec 9>"$base/.install.lock"
flock -n 9 || fail 'Another collector installation operation is active.'

case "$command" in
  stage)
    [[ $# == 3 ]] || fail 'Usage: install.sh stage ARCHIVE SHA'
    check_sha "$3"
    check_python
    release="$base/releases/$3"
    if [[ -f "$release/.ready" ]]; then
      [[ $(cat -- "$release/COMMIT_SHA") == "$3" ]] || fail 'Existing staged SHA is invalid.'
      printf 'Collector %s already staged.\n' "$3"
      exit
    fi
    mkdir -- "$release" || fail 'Release already exists without a ready marker. Inspect it before removing it.'
    trap 'result=$?; if ((result)); then rm -rf -- "$release"; fi' EXIT
    trap 'exit 1' HUP INT TERM
    extract "$2" "$release" "$3"
    build_release "$release"

    getent group "$group" >/dev/null || groupadd --system "$group"
    id "$collector" >/dev/null 2>&1 ||
      useradd --system --gid "$group" --home-dir "$state" --shell /sbin/nologin "$collector"
    [[ $(id -gn "$collector") == "$group" ]] || fail 'Unexpected collector primary group.'
    chgrp -hR "$group" "$release"
    chmod -R g+rX "$release"
    for dir in "$state" "$state/data" "$state/data/indices" "$state/data/stocks" "$state/queue"; do
      [[ ! -L $dir ]] || fail "Unexpected symbolic link at $dir"
      mode=2750
      [[ $dir != "$state/queue" ]] || mode=2770
      install -d -o "$collector" -g "$group" -m "$mode" "$dir"
      chmod "$mode" "$dir"
    done
    runuser -u "$collector" -- env PYTHONDONTWRITEBYTECODE=1 \
      "$release/venv/bin/python" "$release/collect_us.py" --help >/dev/null
    touch "$release/.ready"
    printf 'Staged collector %s. Current version, units and timer are unchanged.\n' "$3"
    ;;
  select)
    [[ $# == 2 ]] || fail 'Usage: install.sh select SHA'
    check_sha "$2"
    release="$base/releases/$2"
    [[ -f "$release/.ready" && $(cat -- "$release/COMMIT_SHA") == "$2" ]] || fail 'Stage this SHA first.'
    for unit in "$service" "$timer"; do
      unit_state=$(systemctl show --property=ActiveState --value "$unit")
      [[ $unit_state == inactive || $unit_state == failed ]] ||
        fail 'Stop the US collector timer and wait for its current collection to finish before switching.'
    done
    [[ ! -e "$base/current" || -L "$base/current" ]] || fail 'Current release path must be a symlink.'
    previous=$(readlink "$base/current" || :)
    [[ -z $previous || $previous =~ ^releases/[a-f0-9]{40}$ ]] || fail 'Unexpected previous selection.'
    for unit in "$service" "$timer"; do
      target="/etc/systemd/system/$unit"
      [[ ! -e $target && ! -L $target || -L $target && $(readlink -- "$target") == "$base/current/$unit" ]] ||
        fail "Existing unit requires manual migration: $target"
    done
    pointer=$(mktemp -d "$base/.switch.XXXXXXXX")
    created_units=()
    switched=0
    finish_selection() {
      local result=$?
      trap - EXIT
      if (( result )); then
        if (( switched )); then
          if [[ -n $previous ]]; then
            ln -s -- "$previous" "$pointer/current"
            mv -T -- "$pointer/current" "$base/current"
          else
            unlink "$base/current"
          fi
        fi
        for target in "${created_units[@]}"; do unlink "$target"; done
        systemctl daemon-reload || :
      fi
      rm -rf -- "$pointer"
      exit "$result"
    }
    trap finish_selection EXIT
    trap 'exit 1' HUP INT TERM
    for unit in "$service" "$timer"; do
      target="/etc/systemd/system/$unit"
      if [[ ! -L $target ]]; then
        ln -s -- "$base/current/$unit" "$target"
        created_units+=("$target")
      fi
    done
    ln -s -- "releases/$2" "$pointer/current"
    mv -T -- "$pointer/current" "$base/current"
    switched=1
    systemctl daemon-reload
    printf 'Collector SHA %s selected. Previous selection: %s\n' "$2" "${previous:-none}"
    ;;
  check-access)
    [[ $# == 2 && $2 != root && $(id -u "$2") != 0 && $2 != "$collector" ]] ||
      fail 'Supply the unprivileged Fastify service account.'
    runuser -u "$collector" -- test -w "$state/data"
    runuser -u "$2" -g "$group" -- bash -euc '
      test -r "$1/data/indices" && test -r "$1/data/stocks" && test -w "$1/queue"
      test ! -w "$1/data" && test ! -w "$1/data/indices" && test ! -w "$1/data/stocks"
    ' bash "$state"
    printf '%s\n' 'Collector and Fastify access verified with the proposed shared group.'
    ;;
esac
