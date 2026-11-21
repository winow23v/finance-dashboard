#!/usr/bin/env bash
set -euo pipefail

repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
workflow="$repo/.github/workflows/oracle-vps.yml"
script="$repo/.github/scripts/oracle-release.sh"
bash -n "$script"
fixture=$(mktemp -d)
trap 'rm -rf -- "$fixture"' EXIT

required=(
  server.mjs market-cache.mjs package.json package-lock.json
  membership-provider.mjs market-index-provider.mjs krx-provider.mjs
  fred-provider.mjs ecos-provider.mjs dart-provider.mjs fx-provider.mjs public-provider.mjs
)

# Check the production sender's pathspec against a disposable repository
# containing the retired file, even after that file has been deleted from main.
selection=$(sed -n '/^[[:space:]]*release_files=($/,/^[[:space:]]*)$/p' "$workflow")
[[ -n $selection ]]
mkdir -p "$fixture/sender/vps-api"
git init -q "$fixture/sender"
for file in "${required[@]}" sec-provider.mjs; do
  touch "$fixture/sender/vps-api/$file"
done
selection_result=$(
  cd "$fixture/sender"
  bash -euc "$selection"$'\n''git ls-files --others --exclude-standard -- "${release_files[@]}"'
)
for file in "${required[@]}"; do
  grep -Fxq "vps-api/$file" <<< "$selection_result"
done
if grep -Fxq 'vps-api/sec-provider.mjs' <<< "$selection_result"; then
  echo 'Oracle sender included the retired SEC provider' >&2
  exit 1
fi

# Run the receiver's actual filename rules against permitted and retired files.
rules=$(sed -n '/^[[:space:]]*case "\$entry" in$/,/^[[:space:]]*esac$/p' "$script")
[[ -n $rules ]]
for file in "${required[@]}"; do
  bash -euc 'entry=$1'$'\n'"$rules" bash "$file"
done
if bash -euc 'entry=$1'$'\n'"$rules" bash sec-provider.mjs; then
  echo 'Oracle receiver accepted the retired SEC provider' >&2
  exit 1
fi

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
mkdir -p "$api" "$release" "$backup"
printf 'old runtime\n' > "$api/sec-provider.mjs"
printf 'untouched rollback\n' > "$backup/sec-provider.mjs"
printf 'local settings fixture\n' > "$api/api.env"
api="$api" release="$release" bash -euc "$copy_candidate"
[[ ! -e $release/api/sec-provider.mjs && ! -L $release/api/sec-provider.mjs ]]
grep -Fxq 'old runtime' "$api/sec-provider.mjs"
grep -Fxq 'untouched rollback' "$backup/sec-provider.mjs"
cmp -s "$api/api.env" "$release/api/api.env"
echo 'Oracle SEC retirement, provider packaging and rollback tree preservation passed'
