import { describe, expect, it, vi } from "vitest";

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  networkInterfaces: () => ({
    en0: [
      {
        address: "192.168.1.10",
        cidr: "192.168.1.10/24",
        family: "IPv4",
        internal: false,
        mac: "00:00:00:00:00:00",
        netmask: "255.255.255.0",
      },
    ],
  }),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: (_command: string, args: readonly string[]) => {
    if (args.includes("status") && !args.includes("serve")) {
      return JSON.stringify({ Self: { TailscaleIPs: ["100.64.0.10"] } });
    }
    throw new Error("tailscale serve is not configured");
  },
}));

const { getConnectUrlCandidates } = await import("../src/pairing-url-candidates.js");

describe("connect URL candidates", () => {
  it("offers Tailscale but not the local network when the relay listens on loopback", () => {
    const urls = getConnectUrlCandidates({ listenUrl: "http://127.0.0.1:8787", port: 8787 }).map(
      (candidate) => candidate.url,
    );

    expect(urls).toContain("http://100.64.0.10:8787");
    expect(urls).not.toContain("http://192.168.1.10:8787");
  });

  it("offers local network addresses when the relay listens on every interface", () => {
    const urls = getConnectUrlCandidates({ listenUrl: "http://0.0.0.0:8787", port: 8787 }).map(
      (candidate) => candidate.url,
    );

    expect(urls).toContain("http://100.64.0.10:8787");
    expect(urls).toContain("http://192.168.1.10:8787");
  });
});
