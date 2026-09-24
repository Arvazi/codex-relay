# Fork foundation: security review checkpoint

Upstream: https://github.com/gronxb/codex-relay
Reviewed baseline: 57735a80a5fddcc78aaf887db2ea3a0f2999d92e.

This is an initial patch, not a completed security audit or production-ready fork.
No remote fork, deployment, signing identity, or infrastructure resources have been created.

## Changes

- Reject failed encrypted request validation independently of the endpoint's Zod schema. Previously, schemas accepting optional fields could strip an invalid-payload marker and accept the request.
- Reject plaintext responses on mobile while a secure session exists.
- Require the normal bearer authentication middleware for image attachment downloads. Mobile MessageBubble image requests already include authorization headers.
- Add ten regression tests for rejected requests before thread/terminal side effects, valid encryption, replay, tampering, and image authorization.

## Verification

Targeted Vitest run: 143 tests passed across the application and security-boundaries suites.
The new regression suite alone contains ten tests. Its initial run against unchanged upstream exposed six failures; the fixed code passes all ten. A terminal side-effect assertion was subsequently strengthened.
Oxfmt and Oxlint on the changed TypeScript files completed without warnings.
Full suite attempted: 236 passed, seven failed, and 19 of 35 test files failed overall (including files that could not load). Missing mobile/workspace dependencies and tsx, unsupported Unix socket operations, and socket timeouts prevent a clean full run in this environment.
Typecheck attempted and failed, including unresolved mobile/workspace dependencies and downstream implicit-any errors. No type errors were reported for the changed server app or new regression file in that run.
Dependencies were installed in a temporary server-only npm environment, not from a complete frozen pnpm workspace installation. Native iOS build and device validation have not been performed.

## Remaining security work

- Protect the entire transport, including bearer headers, attachments and bodyless mutations. Payload encryption alone is insufficient on plain HTTP.
- Review token expiration/revocation and session-key persistence, and migrate mobile credentials to Keychain-backed storage.
- Bound the privileges of terminal sessions: they currently run a normal user shell outside Codex sandboxing.
- Review pairing, concurrent counters, authorized attachment access, updates and push privacy end to end.
- Replace upstream update/push/deployment services with resources owned by the user. Preserve update signature verification and use independent signing keys.
- Test error handling and image loading in the real mobile app after these boundary changes.

## Infrastructure dependency

User requested the arical repository as the infrastructure model, possibly silkrockgmbh/arical. The connector authenticates as Arvazi, but cannot read that repository and lists no repositories for silkrockgmbh. A GitHub 404 does not establish that the repository does not exist.

Once access is available, inspect arical's actual deployment definitions, environments, secrets references and CI before selecting services or provisioning anything. Do not copy secret values or assume the upstream Cloudflare/Expo model matches arical.
Then create the authorized fork in the intended user/organization, apply this commit, adapt infrastructure, complete the security work, and validate the macOS server and Xcode device build. Never deploy this checkpoint as a completed hardening effort.
