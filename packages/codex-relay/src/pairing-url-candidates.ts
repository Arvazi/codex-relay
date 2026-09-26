import { execFileSync } from "node:child_process";
import { networkInterfaces } from "node:os";

import { tailscaleArgs } from "./tailscale-cli.js";

export type ConnectUrlCandidate = {
  label: string;
  url: string;
};

export function getConnectUrlGuidance(url: string) {
  const host = parseUrlHost(url);
  if (!host) {
    return undefined;
  }

  if (isLocalhost(host) || isUnspecifiedHost(host)) {
    return "This address is only reachable from this computer. Use a same-Wi-Fi address or Tailscale for mobile pairing.";
  }

  if (isTailscaleHost(host)) {
    return "Using Tailscale. Keep Tailscale connected on both this computer and the phone.";
  }

  if (isPrivateIPv4Host(host) || isLocalIPv6Host(host)) {
    return "Using a local Wi-Fi/LAN address. Keep the phone and computer on the same network; if pairing is flaky, try Tailscale.";
  }

  return "Using a configured or public address. Make sure the phone can reach it before pairing.";
}

export function createPairingQrPayload(details: { serverPublicKey: string; serverUrls: string[] }) {
  const primaryServerUrl = details.serverUrls[0];
  if (!primaryServerUrl) {
    throw new Error("Pairing QR requires at least one server URL.");
  }

  const url = new URL("codex-relay://pair");
  url.searchParams.set("serverUrl", primaryServerUrl);
  url.searchParams.set("serverPublicKey", details.serverPublicKey);
  const hosts = compactCandidateHosts(primaryServerUrl, details.serverUrls);
  if (hosts.length > 0) {
    url.searchParams.set("h", hosts.join(","));
  }
  const normalizedUrls = details.serverUrls.flatMap((serverUrl) => {
    const normalized = normalizeUrl(serverUrl);
    return normalized ? [normalized] : [];
  });
  const hasUncompressedUrl = normalizedUrls.some(
    (serverUrl) => !isRepresentedByCompactHosts(serverUrl, primaryServerUrl, hosts),
  );
  if (hasUncompressedUrl) {
    url.searchParams.set("serverUrls", JSON.stringify(normalizedUrls));
  }
  return url.toString();
}

export function getConnectUrlCandidates(details: { listenUrl: string; port: number }) {
  return dedupeCandidates(
    [
      ...tailscaleConnectUrlCandidates(details.port),
      ...localNetworkConnectUrlCandidates(details.port),
      { label: "Server", url: details.listenUrl },
    ].filter((candidate) => !isUnspecifiedCandidate(candidate.url)),
  );
}

export function normalizeUrl(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim().replace(/\/$/, "");
  if (!trimmed) {
    return undefined;
  }

  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString().replace(/\/$/, "")
      : undefined;
  } catch {
    return undefined;
  }
}

function tailscaleConnectUrlCandidates(port: number) {
  const status = getTailscaleStatus();
  const candidates: ConnectUrlCandidate[] = [];
  for (const ip of status?.Self?.TailscaleIPs ?? []) {
    if (ip.startsWith("100.") && ip.includes(".")) {
      candidates.push({ label: "Tailscale", url: `http://${ip}:${port}` });
    }
  }

  const dnsName = status?.Self?.DNSName?.replace(/\.$/, "");
  if (dnsName) {
    const servedUrl = getTailscaleServeHttpsUrl(dnsName, port);
    candidates.push({
      label: servedUrl ? "Tailscale Serve" : "Tailscale DNS",
      url: servedUrl ?? `http://${dnsName}:${port}`,
    });
  }

  for (const ip of status?.Self?.TailscaleIPs ?? []) {
    if (ip.includes(".")) {
      candidates.push({ label: "Tailscale", url: `http://${ip}:${port}` });
    }
  }

  return candidates;
}

function localNetworkConnectUrlCandidates(port: number) {
  const candidates: ConnectUrlCandidate[] = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        candidates.push({ label: name, url: `http://${address.address}:${port}` });
      }
    }
  }
  return candidates;
}

function dedupeCandidates(candidates: ConnectUrlCandidate[]) {
  const deduped = new Map<string, ConnectUrlCandidate>();
  for (const candidate of candidates) {
    const url = normalizeUrl(candidate.url);
    if (url && !deduped.has(url)) {
      deduped.set(url, { ...candidate, url });
    }
  }
  return [...deduped.values()];
}

function isRepresentedByCompactHosts(serverUrl: string, primaryServerUrl: string, hosts: string[]) {
  if (serverUrl === primaryServerUrl) {
    return true;
  }
  const primary = parseUrl(primaryServerUrl);
  const candidate = parseUrl(serverUrl);
  return Boolean(
    primary &&
    candidate &&
    candidate.protocol === primary.protocol &&
    candidate.port === primary.port &&
    hosts.includes(candidate.hostname),
  );
}

function compactCandidateHosts(primaryServerUrl: string, serverUrls: string[]) {
  const primary = parseUrl(primaryServerUrl);
  if (!primary) {
    return [];
  }

  const hosts: string[] = [];
  for (const serverUrl of serverUrls.slice(1)) {
    const candidate = parseUrl(serverUrl);
    if (
      candidate &&
      candidate.protocol === primary.protocol &&
      candidate.port === primary.port &&
      !hosts.includes(candidate.hostname)
    ) {
      hosts.push(candidate.hostname);
    }
  }
  return hosts;
}

function parseUrl(url: string) {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

function parseUrlHost(url: string) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function isLocalhost(host: string) {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function isUnspecifiedHost(host: string) {
  return host === "0.0.0.0" || host === "::";
}

function isUnspecifiedCandidate(url: string) {
  const host = parseUrlHost(url);
  return host ? isUnspecifiedHost(host) : false;
}

function isTailscaleHost(host: string) {
  return (
    host.endsWith(".ts.net") || host.endsWith(".beta.tailscale.net") || isTailscaleIPv4Host(host)
  );
}

function isPrivateIPv4Host(host: string) {
  const octets = host.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) {
    return false;
  }
  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 169 && octets[1] === 254)
  );
}

function isTailscaleIPv4Host(host: string) {
  const octets = host.split(".").map(Number);
  return octets.length === 4 && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

function isLocalIPv6Host(host: string) {
  const normalized = host.replace(/^\[/, "").replace(/\]$/, "");
  return (
    normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd")
  );
}

function getTailscaleStatus() {
  try {
    const output = execFileSync("tailscale", tailscaleArgs(["status", "--json"]), {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
    });
    return JSON.parse(output) as {
      Self?: {
        DNSName?: string;
        TailscaleIPs?: string[];
      };
    };
  } catch {
    return undefined;
  }
}

function getTailscaleServeHttpsUrl(dnsName: string, port: number) {
  try {
    const output = execFileSync("tailscale", tailscaleArgs(["serve", "status", "--json"]), {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
    });
    const serveStatus = JSON.parse(output) as {
      TCP?: Record<string, { HTTPS?: boolean }>;
      Web?: Record<string, unknown>;
    };
    const portKey = String(port);
    const hostPort = `${dnsName}:${portKey}`;
    return serveStatus.TCP?.[portKey]?.HTTPS && serveStatus.Web?.[hostPort]
      ? `https://${hostPort}`
      : undefined;
  } catch {
    return undefined;
  }
}
