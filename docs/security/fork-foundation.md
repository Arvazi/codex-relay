# Fork foundation: security review checkpoint

Upstream: https://github.com/gronxb/codex-relay
Reviewed baseline: 57735a80a5fddcc78aaf887db2ea3a0f2999d92e.

This is an initial patch, not a completed security audit or production-ready fork.
The remote fork is https://github.com/Arvazi/codex-relay, branch `arvazi/security-foundation`. A SilkBank gateway and Mac/Xcode setup are prepared under `infra/`. No live NAS deployment or iPhone installation has been performed.

## Changes

- Reject failed encrypted request validation independently of the endpoint's Zod schema. Previously, schemas accepting optional fields could strip an invalid-payload marker and accept the request.
- Reject plaintext responses on mobile while a secure session exists.
- Require the normal bearer authentication middleware for image attachment downloads. Mobile MessageBubble image requests already include authorization headers.
- Add ten regression tests for rejected requests before thread/terminal side effects, valid encryption, replay, tampering, and image authorization.

## Verification

After a frozen-lockfile workspace installation, the server build and complete workspace typecheck pass. Repository lint and formatting pass without warnings.
Full Vitest run: 344 passed, six failed, four skipped (35 files). The remaining failures are in app-server Unix-socket startup/reconnection tests, with EPERM and timeouts in this environment. Do not report a fully green suite.
The application/security-boundary/HTTPS URL suites pass. The initial unpatched boundary suite exposed six failures; all ten boundary tests pass after the fixes. Seven additional tests cover the explicit HTTPS origin and rejected URL forms.
Expo's generated public configuration was checked for the owned bundle identifier, absent upstream EAS project, disabled OTA plugin, and disabled arbitrary cleartext access. Caddy 2.11.4 validates the gateway configuration, and bash syntax checks pass for all deployment scripts. The Docker container and iOS app have not been executed here.
Dependencies were installed with pnpm 11.19.0 and the existing frozen lockfile; the root manifest specifies pnpm 12.4.2. Verify with that exact version on the Mac/CI as well.

## Remaining security work

- Protect the entire transport, including bearer headers, attachments and bodyless mutations. Payload encryption alone is insufficient on plain HTTP.
- Review token expiration/revocation and session-key persistence, and migrate mobile credentials to Keychain-backed storage.
- Bound the privileges of terminal sessions: they currently run a normal user shell outside Codex sandboxing.
- Review pairing, concurrent counters, authorized attachment access, updates and push privacy end to end.
- Replace upstream update/push/deployment services with resources owned by the user. Preserve update signature verification and use independent signing keys.
- Test error handling and image loading in the real mobile app after these boundary changes.

## Infrastructure status

Inspected `Arvazi/ari-cal` using GitHub CLI authenticated as Arvazi. Adapted its dedicated Compose/loopback/DSM model for a Mac-hosted Relay behind an outbound reverse SSH tunnel. See `infra/README.md` for installation, trust boundaries, acceptance and rollback.
The upstream Expo project and store submission identifier are removed from this build. OTA and insights are disabled by default, and an owned signing key path is required to enable OTA. Push registration requires an explicitly supplied owned Expo project. Self-hosted OTA and direct APNs integration remain unimplemented; native updates use Xcode initially.
GitHub Actions are disabled on the fork to prevent the inherited release workflow from publishing against upstream services. Establish owned release automation before re-enabling Actions.
Live setup remains blocked: `silkbank.synology.me` does not resolve in this environment and there is no established NAS SSH session or Mac/Xcode access. Do not request secrets in chat or attempt to retrieve existing GitHub secret values. No ari-cal production service was changed.
