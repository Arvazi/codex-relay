#!/usr/bin/env bash
# Run on SilkBank from a reviewed checkout. Does not change DSM/nginx or other stacks.
set -euo pipefail
umask 077
root=/volume1/docker/ari-relay
source_dir=$(cd "$(dirname "$0")" && pwd)
docker_bin=${DOCKER_BIN:-/usr/local/bin/docker}
mkdir -p "$root/releases"
release=$(mktemp -d "$root/releases/release.XXXXXXXX")
cp "$source_dir/compose.yaml" "$source_dir/Caddyfile" "$release/"
"$docker_bin" compose -p ari-relay -f "$release/compose.yaml" config --quiet
"$docker_bin" compose -p ari-relay -f "$release/compose.yaml" run --rm --no-deps gateway caddy validate --config /etc/caddy/Caddyfile
previous=$(readlink "$root/current" || true)
"$docker_bin" compose -p ari-relay -f "$release/compose.yaml" up -d --wait --wait-timeout 90 gateway || {
  if [ -n "$previous" ]; then
    "$docker_bin" compose -p ari-relay -f "$previous/compose.yaml" up -d --wait gateway
  fi
  exit 1
}
ln -s "$release" "$root/current.next"
mv -Tf "$root/current.next" "$root/current"
printf 'Gateway deployed. Verify HTTPS, tunnel and app pairing separately.\n'
