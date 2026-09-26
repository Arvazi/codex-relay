import { existsSync } from "node:fs";

const userspaceSocketPath = "/tmp/tailscaled-silkrock.sock";

export function tailscaleArgs(args: readonly string[]) {
  const socket = tailscaleSocketPath();
  return socket ? ["--socket", socket, ...args] : [...args];
}

function tailscaleSocketPath() {
  const configured = process.env.TAILSCALE_SOCKET?.trim();
  if (configured) {
    return configured;
  }
  if (existsSync("/var/run/tailscaled.socket")) {
    return undefined;
  }
  if (existsSync(userspaceSocketPath)) {
    return userspaceSocketPath;
  }
  return undefined;
}
