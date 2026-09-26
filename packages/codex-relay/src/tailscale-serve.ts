import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";

import { tailscaleArgs } from "./tailscale-cli.js";

export type ExecFileResult = {
  readonly stderr: string;
  readonly stdout: string;
};

export type ExecFileRunner = (
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
) => Promise<ExecFileResult>;

export type ExecFileOptions = {
  readonly maxBuffer: number;
  readonly timeout: number;
};

type StartTailscaleServeInput = {
  readonly execFile?: ExecFileRunner;
  readonly url: string;
};

export type TailscaleServePreviewUrl = {
  readonly port: number;
  readonly sourceUrl: string;
};

export type TailscaleServeResult = {
  readonly port: number;
  readonly url: string;
};

export class TailscaleServeInvalidUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TailscaleServeInvalidUrlError";
  }
}

export class TailscaleServeCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TailscaleServeCommandError";
  }
}

const execFileAsync = promisify(nodeExecFile);
const tailscaleServeOptions = {
  maxBuffer: 1024 * 1024,
  timeout: 15_000,
} as const satisfies ExecFileOptions;
const tailscaleServeUrlPattern = /https:\/\/[^\s]+\.ts\.net\b[^\s]*/;

export function parseTailscaleServePreviewUrl(url: string): TailscaleServePreviewUrl {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new TailscaleServeInvalidUrlError("Preview URL must be a valid URL.");
  }

  if (parsedUrl.protocol !== "http:") {
    throw new TailscaleServeInvalidUrlError("Preview URL must use HTTP.");
  }
  if (!parsedUrl.port) {
    throw new TailscaleServeInvalidUrlError("Preview URL must include an explicit port.");
  }

  const port = Number(parsedUrl.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TailscaleServeInvalidUrlError("Preview URL port must be between 1 and 65535.");
  }
  if (!isAllowedTailscaleHost(parsedUrl.hostname)) {
    throw new TailscaleServeInvalidUrlError(
      "Preview URL must use a Tailscale 100.64.0.0/10 or .ts.net host.",
    );
  }

  return {
    port,
    sourceUrl: parsedUrl.href,
  };
}

export async function startTailscaleServeForPreviewUrl(
  input: StartTailscaleServeInput,
): Promise<TailscaleServeResult> {
  const preview = parseTailscaleServePreviewUrl(input.url);
  const execFile = input.execFile ?? defaultExecFile;
  let result: ExecFileResult;
  try {
    result = await execFile(
      "tailscale",
      ["serve", "--bg", String(preview.port)],
      tailscaleServeOptions,
    );
  } catch (error) {
    throw new TailscaleServeCommandError(errorMessage(error));
  }

  const serveUrl = `${result.stdout}\n${result.stderr}`.match(tailscaleServeUrlPattern)?.[0];
  if (!serveUrl) {
    throw new TailscaleServeCommandError("Tailscale Serve did not report a .ts.net HTTPS URL.");
  }

  return {
    port: preview.port,
    url: serveUrl,
  };
}

async function defaultExecFile(
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
): Promise<ExecFileResult> {
  const result = await execFileAsync(file, tailscaleArgs(args), options);
  return {
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

function isAllowedTailscaleHost(hostname: string) {
  const lowerHostname = hostname.toLowerCase();
  return lowerHostname.endsWith(".ts.net") || isTailscaleIpv4Host(lowerHostname);
}

function isTailscaleIpv4Host(hostname: string) {
  const parts = hostname.split(".");
  if (parts.length !== 4) {
    return false;
  }
  const octets = parts.map((part) => Number(part));
  if (!octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)) {
    return false;
  }
  const first = octets[0];
  const second = octets[1];
  return first === 100 && second !== undefined && second >= 64 && second <= 127;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Tailscale Serve command failed.";
}
