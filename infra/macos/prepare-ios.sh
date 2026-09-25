#!/usr/bin/env bash
set -euo pipefail
[ "$(uname -s)" = Darwin ] || { echo 'Run this on the Mac with Xcode installed.' >&2; exit 1; }
repo=$(cd "$(dirname "$0")/../.." && pwd)
cd "$repo"
xcodebuild -version
pnpm install --frozen-lockfile
pnpm --filter codex-relay build
cd apps/mobile
pnpm exec expo prebuild --platform ios
workspace=$(find ios -maxdepth 1 -name '*.xcworkspace' -print -quit)
test -n "$workspace"
open "$workspace"
echo 'Select your Apple team (the same team as ari-cal), connected iPhone, and Release configuration for a standalone build.'
