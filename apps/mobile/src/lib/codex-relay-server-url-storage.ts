import { createMMKV } from "react-native-mmkv";

const defaultServerUrl = "http://localhost:8787";
const serverUrlCandidatesStorageKey = "codex-relay.server-url-candidates";
const serverUrlStorageKey = "codex-relay.server-url";

export const codexRelayStorage = createMMKV({ id: "codex-relay" });

export type CodexRelayServerUrlCandidate = {
  label: string;
  url: string;
};

export const fallbackCodexRelayServerUrl =
  process.env.EXPO_PUBLIC_CODEX_RELAY_SERVER_URL?.replace(/\/$/, "") ?? defaultServerUrl;

export function getCodexRelayServerUrl() {
  return codexRelayStorage.getString(serverUrlStorageKey) ?? fallbackCodexRelayServerUrl;
}

export function getCodexRelayServerUrlCandidates(): CodexRelayServerUrlCandidate[] {
  return serverUrlCandidatesFromUrls([
    getCodexRelayServerUrl(),
    ...readStoredServerUrlCandidates(),
  ]);
}

export function setCodexRelayServerUrl(url: string) {
  const normalizedUrl = normalizeServerUrl(url);
  codexRelayStorage.set(serverUrlStorageKey, normalizedUrl);
  return normalizedUrl;
}

export function clearCodexRelayServerUrlState() {
  codexRelayStorage.remove(serverUrlStorageKey);
  codexRelayStorage.remove(serverUrlCandidatesStorageKey);
}

export function saveCodexRelayServerUrlCandidates(urls: string[]) {
  codexRelayStorage.set(serverUrlCandidatesStorageKey, JSON.stringify(dedupeServerUrls(urls)));
}

export function normalizeServerUrl(url: string) {
  const trimmed = url.trim().replace(/\/$/, "");
  if (!trimmed) {
    throw new Error("Server URL is empty.");
  }

  const parsed = new URL(trimmed);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Server URL must start with http:// or https://.");
  }

  return parsed.toString().replace(/\/$/, "");
}

export function dedupeServerUrls(urls: string[]) {
  const deduped = new Set<string>();
  for (const url of urls) {
    try {
      deduped.add(normalizeServerUrl(url));
    } catch {
      continue;
    }
  }
  return [...deduped];
}

export function isPrivateIPv4Host(host: string) {
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

export function isCarrierGradePrivateIPv4Host(host: string) {
  const octets = host.split(".").map(Number);
  return octets.length === 4 && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

export function isLocalIPv6Host(host: string) {
  const normalized = host.replace(/^\[/, "").replace(/\]$/, "");
  return (
    normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd")
  );
}

function readStoredServerUrlCandidates() {
  const stored = codexRelayStorage.getString(serverUrlCandidatesStorageKey);
  if (!stored) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed)
      ? parsed.filter((url): url is string => typeof url === "string")
      : [];
  } catch {
    return [];
  }
}

function serverUrlCandidatesFromUrls(urls: string[]): CodexRelayServerUrlCandidate[] {
  return dedupeServerUrls(urls).map((url) => ({
    label: serverUrlCandidateLabel(url),
    url,
  }));
}

function serverUrlCandidateLabel(url: string) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
      return "Localhost";
    }
    if (host.endsWith(".local")) {
      return "Local network";
    }
    if (host.endsWith(".ts.net") || host.endsWith(".beta.tailscale.net")) {
      return "Tailscale DNS";
    }
    if (host.endsWith(".trycloudflare.com")) {
      return "Internet";
    }
    if (isCarrierGradePrivateIPv4Host(host)) {
      return "Tailscale IP";
    }
    if (isPrivateIPv4Host(host) || isLocalIPv6Host(host)) {
      return "LAN IP";
    }
    return "Server";
  } catch {
    return "Server";
  }
}
