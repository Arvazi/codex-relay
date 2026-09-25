# Ari Relay: owned deployment

Based on Arvazi/ari-cal's SilkBank deployment: dedicated Compose project, loopback listener, DSM HTTPS reverse proxy and local secret ownership. Relay executes on the Mac, not in a NAS container. This is a prepared deployment; it has NOT been installed on SilkBank or an iPhone.

## Traffic and trust

`iPhone HTTPS → DSM TLS → 127.0.0.1:3048 Caddy → 127.0.0.1:18787 reverse SSH → Mac 127.0.0.1:8787 Relay`

The Mac makes the outbound SSH connection, so it needs no inbound router port. The tunnel stops when the Mac sleeps or disconnects. Caddy supports streamed responses and WebSocket upgrades. Treat the NAS as trusted: TLS terminates there and bearer credentials and attachments are visible there, although supported JSON messages also use application encryption. Root/admin on either machine is inside this trust boundary. Do not expose either loopback port directly.

Do not add a Keycloak browser redirect in front of the API: the native pairing/API client does not implement that flow. Relay pairing and local approval provide app authentication. A future admin web console can use the existing Keycloak realm with a separate client. Never automatically approve pairing.

## SilkBank installation

1. Review `silkbank/compose.yaml` and `Caddyfile`. Install with `bash infra/silkbank/deploy.sh` on the NAS under an account permitted to run Docker. It owns only `/volume1/docker/ari-relay` and the `ari-relay` Compose project. The deployment validates the Caddy configuration and keeps the previous release for rollback.
2. Create a dedicated unprivileged SSH tunnel account and key for the Mac. Restrict it to remote forwarding at `127.0.0.1:18787`, without shell, PTY, agent or X11 access. For an OpenSSH server supporting these options use an `sshd_config` Match block: `AllowTcpForwarding remote`, `PermitListen 127.0.0.1:18787`, `GatewayPorts no`, `MaxSessions 0`, `AllowAgentForwarding no`, `X11Forwarding no`, `PermitTTY no`. Validate with `sshd -t` and preserve a separate working administrator session before applying SSH settings. Check the NAS OpenSSH version and effective configuration first. Do not grant Docker or sudo access to the tunnel account.
3. Configure a Mac SSH host alias, for example `ari-relay-nas`, with that account and key. Verify the NAS host key out of band and add it to known_hosts. No `StrictHostKeyChecking=no` or automatic trust-on-first-use in scripts.
4. In DSM create a separate HTTPS hostname, proposed `codex-relay.silkbank.synology.me`, with a valid certificate, forwarding to `http://127.0.0.1:3048`. Enable WebSocket support. Do not copy or replace ari-cal's existing rule. DNS and certificate provisioning are required; the proposed hostname is not assumed to exist.
5. Do NOT restart NAS nginx as part of the application deploy. ari-cal documents interactions with Docker, Samba AD and SMBService.

No NAS password/key is stored here. No existing ari-cal GitHub secret can be read back or reused automatically. CI deployment can be connected once a separately scoped deploy identity and reviewed NAS wrapper are available. Do not grant CI unrestricted root/Docker access just to deploy the gateway.

## Mac setup

Use a dedicated macOS account if you need isolation from personal files: Relay's interactive terminal runs as that user and is outside Codex's sandbox.

```sh
pnpm install --frozen-lockfile
pnpm --filter codex-relay build
export CODEX_RELAY_PUBLIC_URL=https://codex-relay.silkbank.synology.me
export CODEX_RELAY_WORKSPACE_PATH="$HOME/Developer/my-project"
bash infra/macos/start-relay.sh
```

In another terminal:

```sh
export RELAY_SSH_HOST=ari-relay-nas
bash infra/macos/start-tunnel.sh
```

Use the local pairing approval prompt. `CODEX_RELAY_PUBLIC_URL` makes the QR advertise ONLY the HTTPS origin, with no cleartext LAN fallback. Scripts run this fork's compiled server, never `npx codex-relay@latest`. Keep both processes in the foreground for the initial verified setup. After validation they can be supervised with per-user launchd agents; do not run Relay as root. `start-relay.sh stop` is only relevant if deliberately using the CLI's `--bg` mode.

## iPhone / Xcode

Run `bash infra/macos/prepare-ios.sh` on the Mac. In Xcode select your Apple team (the same team used for ari-cal), the attached iPhone, and enable Developer Mode on the phone. The distinct bundle identifier is `de.silkrock.arirelay`; name is Ari Relay. Use Release configuration for a build that runs without Metro. Signing/provisioning and the native SDK must be validated on that Mac. Xcode and iOS builds cannot be executed in this Linux workspace.

The upstream Expo project and App Store submission ID have been removed. Push registration is unavailable unless an owned Expo project ID is explicitly supplied via `RELAY_EXPO_PROJECT_ID`; enabling it uses Expo's push service and Apple APNs, not a self-hosted push service. APNs credentials are still necessary for iOS pushes. Direct APNs support remains future work.

OTA startup checks and insights are disabled by default. Updates initially use reviewed native Xcode builds. To enable OTA later, deploy an owned compatible updater, set `EXPO_PUBLIC_RELAY_OTA_ENABLED=1`, an HTTPS `EXPO_PUBLIC_HOT_UPDATER_BASE_URL`, and `RELAY_OTA_PUBLIC_KEY_PATH` for an independently generated public signing key; retain its private key outside the repository. Do not use the upstream key, Cloudflare deployment or upstream release workflow. A self-hosted OTA backend is not included in this checkpoint. Historical `deployments/` files describe upstream resources and are not instructions for Ari's infrastructure.

## Acceptance and rollback

- `curl http://127.0.0.1:3048/gateway-health` on NAS: 200 means gateway alive, NOT Mac connected.
- With tunnel stopped, proxied Relay routes must fail (typically 502).
- With tunnel active, HTTPS pairing must require approval on the Mac. Invalid/missing bearer tokens on protected endpoints and image downloads must return 401.
- On iPhone test pairing, encrypted chat, terminal streaming, image upload/download, background/resume, and reconnect after tunnel loss. Verify a release build launches without Metro and does not contact upstream updater/push projects.
- Confirm ports 3048/18787 on NAS and 8787 on Mac are not externally reachable.
- Roll back gateway with `docker compose -p ari-relay -f /volume1/docker/ari-relay/releases/<previous>/compose.yaml up -d --wait gateway`. Stop tunnel to remove remote access immediately; use the local CLI `clear` command to revoke paired clients.

Remaining hardening includes credential storage in Keychain, finite token lifetimes, and terminal privilege controls. This checkpoint is not a claim that all security findings are resolved.
