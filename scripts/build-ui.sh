#!/usr/bin/env bash
set -euo pipefail

plugin_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
upstream_dir=$(cd -- "${1:?Pass a clean checkout of the pinned Hydro source}" && pwd)
archive=$(realpath -m -- "${2:?Pass an output .tar.gz path}")
cd -- "$upstream_dir"

patches=("$plugin_dir/patches/hydro-5.1.0-ui.patch")
case "$(git rev-parse HEAD)" in
    02563a8531e2e73e7194034d0b9ea6efe60b534f) yarn_version=4.18.1 ;;
    11fc1f59c9dba8f790f363d222d4012267d36be0)
        yarn_version=4.13.0
        patches+=("$plugin_dir/patches/ui-4.58.5-rmj.patch")
        ;;
    *) echo 'Check out one of the supported UI release commits from the README.' >&2; exit 1 ;;
esac
if ! git diff --quiet HEAD --; then
    echo 'The Hydro source checkout must have no tracked changes.' >&2
    exit 1
fi

applied=()
staged=$(mktemp -d)
restore_source() {
    for ((index = ${#applied[@]} - 1; index >= 0; index--)); do
        git apply --reverse "${applied[index]}"
    done
    rm -f -- "$staged/templates/layout/html5.html"
    rmdir -- "$staged/templates/layout" "$staged/templates" "$staged" 2>/dev/null || true
}
trap restore_source EXIT
for patch_file in "${patches[@]}"; do
    git apply --check "$patch_file"
    git apply "$patch_file"
    applied+=("$patch_file")
done
export YARN_ENABLE_IMMUTABLE_INSTALLS=false SENTRY_TELEMETRY=false
corepack "yarn@$yarn_version" install
node build/prepare.js
export NODE_OPTIONS=--max_old_space_size=8192
node packages/ui-default/build --iconfont
node packages/ui-default/build --production

mapfile -t patched_templates < <(git diff --name-only -- packages/ui-default/templates | sed 's#^packages/ui-default/##')
node "$plugin_dir/scripts/version-ui.cjs" packages/ui-default "$staged/templates/layout/html5.html"
tar -C packages/ui-default -czf "$archive" public "${patched_templates[@]}" -C "$staged" templates/layout/html5.html
