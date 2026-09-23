import { describe, expect, it } from "vitest";

import {
  evaluateRelayVersion,
  relayCompatibilityPolicy,
  relayUpdateCommand,
} from "./version-policy";

function relayVersion(packageVersion: string) {
  return {
    ok: true as const,
    packageName: "codex-relay" as const,
    packageVersion,
    service: "codex-relay-server" as const,
  };
}

describe("relay version policy", () => {
  it("warns when the connected relay is below the 1.6.0 minimum", () => {
    const requiredVersion = "1.6.0";

    expect(relayCompatibilityPolicy.packageVersion).toBe(requiredVersion);
    expect(relayUpdateCommand).toBe("npx codex-relay@latest");
    for (const olderVersion of ["1.4.14", "1.5.0", "1.5.3"]) {
      expect(evaluateRelayVersion(relayVersion(olderVersion), undefined)).toMatchObject({
        compatible: false,
        current: olderVersion,
        required: requiredVersion,
      });
    }
  });

  it("accepts the required release and newer same-major releases", () => {
    for (const packageVersion of ["1.6.0", "1.6.1", "1.7.0"]) {
      expect(evaluateRelayVersion(relayVersion(packageVersion), undefined)).toMatchObject({
        compatible: true,
        current: packageVersion,
        required: "1.6.0",
      });
    }
  });

  it("rejects prereleases, unparseable versions, and unsupported major releases", () => {
    for (const packageVersion of ["1.6.0-beta.1", "latest", "2.0.0"]) {
      expect(evaluateRelayVersion(relayVersion(packageVersion), undefined)).toMatchObject({
        compatible: false,
        current: packageVersion,
      });
    }
  });

  it("reports an unavailable relay for the sidebar", () => {
    expect(evaluateRelayVersion(undefined, new Error("offline"))).toMatchObject({
      compatible: false,
      current: "Unavailable",
      required: "1.6.0",
    });
  });
});
