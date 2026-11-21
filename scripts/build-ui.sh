#!/usr/bin/env bash
set -euo pipefail

plugin_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
upstream_commit=02563a8531e2e73e7194034d0b9ea6efe60b534f
upstream_dir=$(cd -- "${1:?Pass a clean checkout of the pinned Hydro source}" && pwd)
archive=$(realpath -m -- "${2:?Pass an output .tar.gz path}")
patch_file="$plugin_dir/patches/hydro-5.1.0-ui.patch"
cd -- "$upstream_dir"

if [[ $(git rev-parse HEAD) != "$upstream_commit" ]]; then
    echo "Expected Hydro source at $upstream_commit" >&2
    exit 1
fi
if ! git diff --quiet HEAD --; then
    echo 'The Hydro source checkout must have no tracked changes.' >&2
    exit 1
fi

git apply --check "$patch_file"
git apply "$patch_file"
trap 'git apply --reverse "$patch_file"' EXIT
export YARN_ENABLE_IMMUTABLE_INSTALLS=false SENTRY_TELEMETRY=false
corepack yarn@4.18.1 install
node build/prepare.js
export NODE_OPTIONS=--max_old_space_size=8192
node packages/ui-default/build --iconfont
node packages/ui-default/build --production

mapfile -t patched_templates < <(git diff --name-only -- packages/ui-default/templates | sed 's#^packages/ui-default/##')
tar -C packages/ui-default -czf "$archive" public "${patched_templates[@]}"
