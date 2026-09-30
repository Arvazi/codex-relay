import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

import { relayDebugLog } from "./debug-log.js";

// The Codex desktop app runs its own app-server and owns the threads it has loaded, so a second
// app-server (the relay's) cannot write to them ("already has an active writer"). The desktop app
// exposes a local IPC router (the one the IDE extension uses) that forwards "thread follower"
// requests to whichever client owns a thread. We use it to start and steer turns on those threads.

const maxFrameBytes = 256 * 1024 * 1024;
const requestTimeoutMs = 15_000;
const discoveryTimeoutMs = 1_500;

// Request versions must match the desktop app's IPC schema; a mismatch is reported as an error
// response ("request-version-mismatch") and callers fall back to the relay's own app-server.
const requestVersions = {
  "thread-owner-discovery": 1,
  "thread-follower-start-turn": 2,
  "thread-follower-steer-turn": 1,
} as const;

type DesktopIpcMethod = keyof typeof requestVersions;

type DesktopIpcResponse =
  | { type: "response"; requestId: string; resultType: "success"; result?: unknown }
  | { type: "response"; requestId: string; resultType: "error"; error?: string };

type PendingRequest = {
  reject: (error: Error) => void;
  resolve: (response: DesktopIpcResponse) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type DesktopTurnInput = {
  clientUserMessageId: string;
  cwd: string;
  input: unknown[];
};

export type DesktopTurnStartRequest = Record<string, unknown> & { threadId: string };

export type DesktopIpcClient = {
  close(): void;
  ownsThread(threadId: string): Promise<boolean>;
  startTurn(threadId: string, request: DesktopTurnStartRequest): Promise<unknown>;
  steerTurn(threadId: string, turn: DesktopTurnInput): Promise<unknown>;
};

export class DesktopIpcError extends Error {
  constructor(
    readonly code: string,
    method: string,
  ) {
    super(`Codex desktop app rejected ${method}: ${code}`);
    this.name = "DesktopIpcError";
  }
}

export function defaultDesktopIpcSocketPath() {
  return join(process.env.CODEX_HOME || join(homedir(), ".codex"), "ipc", "ipc.sock");
}

export function encodeDesktopIpcFrame(message: unknown) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

export function createDesktopIpcFrameReader(onMessage: (message: unknown) => void) {
  let buffered: Buffer = Buffer.alloc(0);
  return (chunk: Buffer) => {
    buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
    while (buffered.length >= 4) {
      const length = buffered.readUInt32LE(0);
      if (length === 0 || length > maxFrameBytes) {
        throw new Error(`Invalid Codex desktop IPC frame length ${length}.`);
      }
      if (buffered.length < 4 + length) {
        return;
      }
      const body = buffered.subarray(4, 4 + length).toString("utf8");
      buffered = buffered.subarray(4 + length);
      onMessage(JSON.parse(body));
    }
  };
}

export function createDesktopIpcClient(options: { socketPath?: string } = {}): DesktopIpcClient {
  const socketPath = options.socketPath ?? defaultDesktopIpcSocketPath();
  const pending = new Map<string, PendingRequest>();
  let socket: Socket | undefined;
  let clientId: string | undefined;
  let connecting: Promise<void> | undefined;

  function failAll(error: Error) {
    for (const [requestId, request] of pending) {
      clearTimeout(request.timer);
      pending.delete(requestId);
      request.reject(error);
    }
  }

  function reset(error: Error) {
    socket?.destroy();
    socket = undefined;
    clientId = undefined;
    connecting = undefined;
    failAll(error);
  }

  function handleMessage(message: unknown) {
    if (!message || typeof message !== "object") {
      return;
    }
    const record = message as Record<string, unknown>;
    if (record.type === "client-discovery-request" && typeof record.requestId === "string") {
      // The relay never owns desktop threads; answer immediately so the router doesn't wait.
      socket?.write(
        encodeDesktopIpcFrame({
          type: "client-discovery-response",
          requestId: record.requestId,
          response: { canHandle: false },
        }),
      );
      return;
    }
    if (record.type !== "response" || typeof record.requestId !== "string") {
      return;
    }
    const request = pending.get(record.requestId);
    if (!request) {
      return;
    }
    clearTimeout(request.timer);
    pending.delete(record.requestId);
    request.resolve(record as DesktopIpcResponse);
  }

  function send(message: Record<string, unknown>, timeoutMs: number) {
    const activeSocket = socket;
    if (!activeSocket) {
      return Promise.reject(new Error("Codex desktop IPC is not connected."));
    }
    const requestId = randomUUID();
    return new Promise<DesktopIpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`Codex desktop IPC ${String(message.method)} timed out.`));
      }, timeoutMs);
      pending.set(requestId, { reject, resolve, timer });
      activeSocket.write(encodeDesktopIpcFrame({ ...message, requestId }));
    });
  }

  async function ensureConnected() {
    if (socket && clientId) {
      return;
    }
    if (!existsSync(socketPath)) {
      throw new Error("Codex desktop app is not running.");
    }
    connecting ??= new Promise<void>((resolve, reject) => {
      const nextSocket = connect(socketPath);
      const readFrames = createDesktopIpcFrameReader(handleMessage);
      nextSocket.on("data", (chunk) => {
        try {
          readFrames(chunk);
        } catch (error) {
          reset(error instanceof Error ? error : new Error(String(error)));
        }
      });
      nextSocket.once("error", (error) => {
        reject(error);
        if (socket === nextSocket) {
          reset(error);
        } else {
          connecting = undefined;
        }
      });
      nextSocket.once("close", () => {
        if (socket === nextSocket) {
          reset(new Error("Codex desktop IPC closed."));
        }
      });
      nextSocket.once("connect", () => {
        socket = nextSocket;
        send(
          { type: "request", method: "initialize", params: { clientType: "codex-relay" } },
          discoveryTimeoutMs,
        )
          .then((response) => {
            const result = response.resultType === "success" ? response.result : undefined;
            const id =
              result && typeof result === "object"
                ? (result as { clientId?: unknown }).clientId
                : undefined;
            if (typeof id !== "string") {
              throw new Error("Codex desktop IPC initialize failed.");
            }
            clientId = id;
            relayDebugLog("desktop_ipc.connected", { clientId: id });
            resolve();
          })
          .catch((error: unknown) => {
            reset(error instanceof Error ? error : new Error(String(error)));
            reject(error);
          });
      });
    });
    await connecting;
  }

  async function request(method: DesktopIpcMethod, params: unknown, timeoutMs = requestTimeoutMs) {
    await ensureConnected();
    const response = await send(
      {
        type: "request",
        sourceClientId: clientId,
        version: requestVersions[method],
        method,
        params,
        timeoutMs,
      },
      timeoutMs + 1_000,
    );
    if (response.resultType === "error") {
      throw new DesktopIpcError(response.error ?? "unknown-error", method);
    }
    return response.result;
  }

  function followerResult(result: unknown) {
    return result && typeof result === "object" ? (result as { result?: unknown }).result : result;
  }

  return {
    close() {
      reset(new Error("Codex desktop IPC closed."));
    },
    async ownsThread(threadId) {
      try {
        await request(
          "thread-owner-discovery",
          { hostId: "local", conversationId: threadId },
          discoveryTimeoutMs,
        );
        return true;
      } catch (error) {
        relayDebugLog("desktop_ipc.owner_discovery.miss", {
          message: error instanceof Error ? error.message : String(error),
          threadId,
        });
        return false;
      }
    },
    async startTurn(threadId, turnRequest) {
      return followerResult(
        await request("thread-follower-start-turn", {
          conversationId: threadId,
          turnStart: { request: turnRequest, context: {} },
        }),
      );
    },
    async steerTurn(threadId, turn) {
      return followerResult(
        await request("thread-follower-steer-turn", {
          conversationId: threadId,
          clientUserMessageId: turn.clientUserMessageId,
          input: turn.input,
          attachments: [],
          restoreMessage: {
            id: turn.clientUserMessageId,
            cwd: turn.cwd,
            context: { workspaceRoots: [turn.cwd], commentAttachments: [] },
            responsesapiClientMetadata: {},
          },
        }),
      );
    },
  };
}
