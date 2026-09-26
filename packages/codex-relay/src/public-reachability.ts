import { execFile as nodeExecFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { dirname } from "node:path";
import { promisify } from "node:util";

import { codexRelayDataPath } from "./paths.js";
import type { ConnectUrlCandidate } from "./pairing-url-candidates.js";
import { tailscaleArgs } from "./tailscale-cli.js";

const execFile = promisify(nodeExecFile);
const metroPort = 8081;

const tunnelUrlPattern = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const stateFileName = "public-tunnel.json";
const ipCheckIntervalMs = 60_000;
const tunnelCheckIntervalMs = 30_000;

type TunnelState = {
  pid?: number;
  publicIp?: string;
  url?: string;
};

let publicUrl: string | undefined;
let localConnectUrls: () => ConnectUrlCandidate[] = () => [];
let tunnelProcess: ChildProcess | undefined;
let maintenanceStarted = false;

export function registerLocalConnectUrls(provider: () => ConnectUrlCandidate[]) {
  localConnectUrls = provider;
}

export function advertisedConnectUrls() {
  const urls = [...localConnectUrls()];
  if (publicUrl && !urls.some((candidate) => candidate.url === publicUrl)) {
    const internet = { label: "Internet", url: publicUrl };
    const firstNonTailscale = urls.findIndex(
      (candidate) => !candidate.label.startsWith("Tailscale"),
    );
    if (firstNonTailscale === -1) {
      urls.push(internet);
    } else {
      urls.splice(firstNonTailscale, 0, internet);
    }
  }
  return urls;
}

export function startPublicReachability(port: number, log: (message: string) => void) {
  if (maintenanceStarted) {
    return;
  }
  maintenanceStarted = true;
  void ensureTailscaleAccess(port, log);
  if (process.env.CODEX_RELAY_PUBLIC_TUNNEL === "0") {
    return;
  }
  void maintainPublicReachability(port, log);
}

async function ensureTailscaleAccess(port: number, log: (message: string) => void) {
  const publishedRelay = await publishTailscalePort(port);
  if (await isLocalPortOpen(metroPort)) {
    await publishTailscalePort(metroPort);
  }
  if (publishedRelay) {
    log("Tailscale can reach this relay from any network.");
  }
}

async function publishTailscalePort(port: number) {
  try {
    await execFile(
      "tailscale",
      tailscaleArgs(["serve", "--bg", "--yes", `--tcp=${port}`, `tcp://127.0.0.1:${port}`]),
      { timeout: 15_000 },
    );
    return true;
  } catch {
    return false;
  }
}

function isLocalPortOpen(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

async function maintainPublicReachability(port: number, log: (message: string) => void) {
  const state = await readState();
  if (state.url && state.pid && isProcessAlive(state.pid)) {
    rememberUrl(state.url, log, false);
  } else {
    await startTunnel(port, log);
  }

  setInterval(() => {
    void watchPublicIp(log);
  }, ipCheckIntervalMs);
  setInterval(() => {
    void ensureTunnel(port, log);
  }, tunnelCheckIntervalMs);
  void watchPublicIp(log);
}

async function ensureTunnel(port: number, log: (message: string) => void) {
  const state = await readState();
  if (state.pid && isProcessAlive(state.pid)) {
    return;
  }
  await startTunnel(port, log);
}

async function startTunnel(port: number, log: (message: string) => void) {
  if (tunnelProcess && tunnelProcess.exitCode === null) {
    return;
  }

  const binary = cloudflaredBinary();
  const child = spawn(binary, ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate"], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.unref();
  tunnelProcess = child;
  child.on("error", (error) => {
    log(`Internet tunnel could not start: ${error.message}`);
  });
  child.on("exit", () => {
    if (tunnelProcess === child) {
      tunnelProcess = undefined;
    }
  });

  const state = await readState();
  await writeState({ ...state, pid: child.pid });
  log("Opening an internet tunnel. The address stays the same when the public IP changes.");

  const handleOutput = (chunk: Buffer) => {
    const match = chunk.toString().match(tunnelUrlPattern);
    if (!match) {
      return;
    }
    void rememberUrl(match[0], log, true);
  };
  child.stdout?.on("data", handleOutput);
  child.stderr?.on("data", handleOutput);
}

async function rememberUrl(url: string, log: (message: string) => void, announce: boolean) {
  if (publicUrl === url && !announce) {
    return;
  }
  const changed = publicUrl !== url;
  publicUrl = url;
  const state = await readState();
  await writeState({ ...state, url });
  if (announce || changed) {
    log(`Internet address ${url}`);
  }
}

async function watchPublicIp(log: (message: string) => void) {
  const nextIp = await readPublicIp();
  if (!nextIp) {
    return;
  }
  const state = await readState();
  if (state.publicIp && state.publicIp !== nextIp) {
    log(
      `Public IP changed from ${state.publicIp} to ${nextIp}. The internet address stays ${state.url ?? "the current tunnel"}.`,
    );
  }
  if (state.publicIp !== nextIp) {
    await writeState({ ...state, publicIp: nextIp });
  }
}

async function readPublicIp() {
  try {
    const response = await fetch("https://api.ipify.org");
    if (!response.ok) {
      return undefined;
    }
    const ip = (await response.text()).trim();
    return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip) ? ip : undefined;
  } catch {
    return undefined;
  }
}

async function readState(): Promise<TunnelState> {
  try {
    return JSON.parse(await readFile(statePath(), "utf8")) as TunnelState;
  } catch {
    return {};
  }
}

async function writeState(state: TunnelState) {
  const path = statePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state), { mode: 0o600 });
}

function cloudflaredBinary() {
  if (process.env.CLOUDFLARED_BIN?.trim()) {
    return process.env.CLOUDFLARED_BIN.trim();
  }
  if (existsSync("/opt/homebrew/bin/cloudflared")) {
    return "/opt/homebrew/bin/cloudflared";
  }
  return "cloudflared";
}

function statePath() {
  return codexRelayDataPath(stateFileName);
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
