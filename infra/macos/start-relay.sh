#!/usr/bin/env bash
set -euo pipefail
umask 077
repo=$(cd "$(dirname "$0")/../.." && pwd)
: "${CODEX_RELAY_PUBLIC_URL:?Set the HTTPS origin configured in DSM}"
: "${CODEX_RELAY_WORKSPACE_PATH:?Set the workspace this Mac should serve}"
node -e 'const u=new URL(process.env.CODEX_RELAY_PUBLIC_URL); if(u.protocol!=="https:" || u.username || u.password || u.pathname!=="/" || u.search || u.hash) throw Error("PUBLIC_URL must be an HTTPS origin")'
test -d "$CODEX_RELAY_WORKSPACE_PATH"
test -f "$repo/packages/codex-relay/dist/cli.js" || { echo 'Build first: pnpm --filter codex-relay build' >&2; exit 1; }
export HOST=127.0.0.1 PORT=8787
unset CODEX_RELAY_DANGEROUSLY_AUTO_APPROVE
cd "$CODEX_RELAY_WORKSPACE_PATH"
exec node "$repo/packages/codex-relay/dist/cli.js" "$@"
