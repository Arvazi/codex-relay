#!/usr/bin/env bash
set -euo pipefail
: "${RELAY_SSH_HOST:?Set the SSH host alias configured for the dedicated NAS tunnel account}"
# A host alias avoids embedding credentials and uses the Mac's SSH agent/keychain.
case "$RELAY_SSH_HOST" in -*|*[!a-zA-Z0-9._-]*) echo 'Use a plain SSH host alias' >&2; exit 1;; esac
exec ssh -NT -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -R 127.0.0.1:18787:127.0.0.1:8787 "$RELAY_SSH_HOST"
