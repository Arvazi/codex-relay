import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp, pageThreadMessages } from "../src/app.js";
import type { ChatMessage } from "../src/api-schema.js";
import {
  createDesktopIpcClient,
  createDesktopIpcFrameReader,
  encodeDesktopIpcFrame,
  type DesktopIpcClient,
} from "../src/desktop-ipc.js";
import { readRolloutActiveTurn, rolloutCompletedTurnItem } from "../src/rollout-tail.js";

const threadId = "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001";

function rolloutLine(type: string, payload: Record<string, unknown>) {
  return `${JSON.stringify({ timestamp: new Date().toISOString(), type, payload })}\n`;
}

function itemCompleted(turnId: string, item: Record<string, unknown>) {
  return rolloutLine("event_msg", {
    type: "item_completed",
    thread_id: threadId,
    turn_id: turnId,
    item,
  });
}

describe("desktop IPC framing", () => {
  it("round-trips length-prefixed JSON frames split across chunks", () => {
    const received: unknown[] = [];
    const read = createDesktopIpcFrameReader((message) => received.push(message));
    const frames = Buffer.concat([
      encodeDesktopIpcFrame({ type: "response", requestId: "a" }),
      encodeDesktopIpcFrame({ type: "broadcast", method: "x", params: { text: "é".repeat(10) } }),
    ]);
    read(frames.subarray(0, 3));
    read(frames.subarray(3, 20));
    read(frames.subarray(20));
    expect(received).toEqual([
      { type: "response", requestId: "a" },
      { type: "broadcast", method: "x", params: { text: "é".repeat(10) } },
    ]);
  });

  it("initializes, answers discovery and forwards follower requests", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-ipc-"));
    const socketPath = join(dir, "ipc.sock");
    const requests: Array<Record<string, unknown>> = [];
    const server = createServer((socket) => {
      const read = createDesktopIpcFrameReader((raw) => {
        const message = raw as Record<string, unknown>;
        requests.push(message);
        if (message.method === "initialize") {
          socket.write(
            encodeDesktopIpcFrame({
              type: "response",
              requestId: message.requestId,
              resultType: "success",
              method: "initialize",
              result: { clientId: "relay-client" },
            }),
          );
          // The router asks every client whether it can handle requests; the relay must decline.
          socket.write(
            encodeDesktopIpcFrame({ type: "client-discovery-request", requestId: "discover-1" }),
          );
          return;
        }
        if (message.type !== "request") {
          return;
        }
        const params = message.params as { conversationId?: string };
        socket.write(
          encodeDesktopIpcFrame(
            params.conversationId === threadId
              ? {
                  type: "response",
                  requestId: message.requestId,
                  resultType: "success",
                  method: message.method,
                  result: { result: { ok: true } },
                }
              : {
                  type: "response",
                  requestId: message.requestId,
                  resultType: "error",
                  error: "no-client-found",
                },
          ),
        );
      });
      socket.on("data", read);
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const client = createDesktopIpcClient({ socketPath });
    try {
      expect(await client.ownsThread(threadId)).toBe(true);
      expect(await client.ownsThread("other-thread")).toBe(false);
      await expect(
        client.startTurn(threadId, { threadId, input: [{ type: "text", text: "hi" }] }),
      ).resolves.toEqual({ ok: true });

      expect(requests).toContainEqual({
        type: "client-discovery-response",
        requestId: "discover-1",
        response: { canHandle: false },
      });
      const startTurn = requests.find((request) => request.method === "thread-follower-start-turn");
      expect(startTurn).toMatchObject({
        sourceClientId: "relay-client",
        version: 2,
        params: { conversationId: threadId, turnStart: { request: { threadId } } },
      });
    } finally {
      client.close();
      server.close();
    }
  });
});

describe("rollout tail", () => {
  it("maps desktop TurnItems to app-server items", () => {
    expect(
      rolloutCompletedTurnItem(
        itemCompleted("turn-1", {
          type: "Reasoning",
          id: "rs_1",
          summary_text: ["**Checking files**\n\nLooking at the config."],
          raw_content: [],
        }),
      ),
    ).toEqual({
      item: {
        type: "reasoning",
        id: "rs_1",
        summary: ["**Checking files**\n\nLooking at the config."],
        content: [],
      },
      turnId: "turn-1",
    });
    expect(
      rolloutCompletedTurnItem(
        itemCompleted("turn-1", {
          type: "CommandExecution",
          id: "exec-1",
          command: ["/bin/zsh", "-lc", "ls"],
          cwd: "file:///tmp/work",
          status: "completed",
          aggregated_output: "a\nb\n",
        }),
      )?.item,
    ).toMatchObject({ type: "commandExecution", command: "/bin/zsh -lc ls", cwd: "/tmp/work" });
  });

  it("detects an unfinished turn from the rollout tail", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-rollout-"));
    const path = join(dir, "rollout.jsonl");
    await writeFile(path, rolloutLine("event_msg", { type: "task_started", turn_id: "turn-1" }));
    expect(await readRolloutActiveTurn(path)).toMatchObject({ running: true, turnId: "turn-1" });
    await appendFile(path, rolloutLine("event_msg", { type: "task_complete", turn_id: "turn-1" }));
    expect(await readRolloutActiveTurn(path)).toMatchObject({ running: false });
    // A turn that never finished but whose rollout went quiet long ago is not live.
    await appendFile(path, rolloutLine("event_msg", { type: "task_started", turn_id: "turn-2" }));
    expect(await readRolloutActiveTurn(path, Date.now() + 60 * 60 * 1000)).toMatchObject({
      running: false,
    });
  });
});

describe("thread message pages", () => {
  const message = (index: number, role: ChatMessage["role"]): ChatMessage => ({
    id: `m${index}`,
    threadId,
    role,
    kind: "chat",
    content: `message ${index}`,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  });
  const messages = Array.from({ length: 10 }, (_, index) =>
    message(index, index % 3 === 0 ? "user" : "assistant"),
  );

  it("returns the latest page starting at a user message", () => {
    const page = pageThreadMessages(messages, { limit: 5 });
    expect(page.messages.map((entry) => entry.id)).toEqual(["m6", "m7", "m8", "m9"]);
    expect(page.hasEarlierMessages).toBe(true);
  });

  it("pages backwards from a message id", () => {
    const page = pageThreadMessages(messages, { before: "m6", limit: 4 });
    expect(page.messages.map((entry) => entry.id)).toEqual(["m3", "m4", "m5"]);
    expect(pageThreadMessages(messages, { before: "m3", limit: 4 })).toMatchObject({
      hasEarlierMessages: false,
    });
  });
});

describe("desktop-owned threads", () => {
  let codexHome: string;
  let previousCodexHome: string | undefined;

  beforeEach(async () => {
    previousCodexHome = process.env.CODEX_HOME;
    codexHome = await mkdtemp(join(tmpdir(), "codex-home-"));
    process.env.CODEX_HOME = codexHome;
  });

  afterEach(() => {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
  });

  async function setup(input: { running: boolean }) {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-relay-workspace-"));
    const sessionsDir = join(codexHome, "sessions", "2026", "01", "02");
    await mkdir(sessionsDir, { recursive: true });
    const rolloutPath = join(sessionsDir, `rollout-2026-01-02T03-04-05-${threadId}.jsonl`);
    await writeFile(
      rolloutPath,
      rolloutLine("session_meta", { id: threadId, cwd: workspacePath }) +
        (input.running
          ? rolloutLine("event_msg", { type: "task_started", turn_id: "turn-1" })
          : ""),
    );
    const now = Date.now() / 1000;
    const appThread = {
      id: threadId,
      cwd: workspacePath,
      createdAt: now,
      name: "Desktop thread",
      preview: "Desktop thread",
      source: "vscode",
      status: { type: "notLoaded" },
      turns: [],
      updatedAt: now,
    };
    const appServer = {
      onNotification: () => () => undefined,
      onRequest: () => () => undefined,
      readThread: vi.fn<() => Promise<unknown>>(async () => appThread),
      startTurn: vi.fn<() => Promise<unknown>>(async () => {
        throw new Error(`thread ${threadId} already has an active writer`);
      }),
    };
    const appendTurn = async (turnId: string, text: string) => {
      await appendFile(
        rolloutPath,
        rolloutLine("event_msg", { type: "task_started", turn_id: turnId }) +
          itemCompleted(turnId, {
            type: "UserMessage",
            id: "user-1",
            content: [{ type: "text", text: "Keep going", text_elements: [] }],
          }) +
          itemCompleted(turnId, {
            type: "Reasoning",
            id: "rs-1",
            summary_text: ["**Planning**"],
            raw_content: [],
          }) +
          itemCompleted(turnId, {
            type: "AgentMessage",
            id: "msg-1",
            content: [{ type: "Text", text }],
          }) +
          rolloutLine("event_msg", { type: "task_complete", turn_id: turnId }),
      );
    };
    const desktopIpc = {
      close: vi.fn<DesktopIpcClient["close"]>(),
      ownsThread: vi.fn<DesktopIpcClient["ownsThread"]>(async () => true),
      startTurn: vi.fn<DesktopIpcClient["startTurn"]>(async () => {
        setTimeout(() => void appendTurn("turn-2", "desktop reply"), 50);
        return {};
      }),
      steerTurn: vi.fn<DesktopIpcClient["steerTurn"]>(async () => {
        setTimeout(
          () =>
            void appendFile(
              rolloutPath,
              itemCompleted("turn-1", {
                type: "AgentMessage",
                id: "msg-2",
                content: [{ type: "Text", text: "steered reply" }],
              }) + rolloutLine("event_msg", { type: "task_complete", turn_id: "turn-1" }),
            ),
          50,
        );
        return {};
      }),
    } satisfies DesktopIpcClient;
    const app = createApp({ appServer: appServer as never, desktopIpc, workspacePath });
    return { app, appServer, desktopIpc };
  }

  it("starts turns through the desktop app and streams them from the rollout", async () => {
    const { app, appServer, desktopIpc } = await setup({ running: false });

    const response = await app.request(`/v1/threads/${threadId}/runs/stream`, {
      method: "POST",
      body: JSON.stringify({ prompt: "Keep going" }),
      headers: { "content-type": "application/json" },
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(appServer.startTurn).not.toHaveBeenCalled();
    expect(desktopIpc.startTurn).toHaveBeenCalledWith(
      threadId,
      expect.objectContaining({
        threadId,
        input: [expect.objectContaining({ text: "Keep going" })],
      }),
    );
    expect(body).toContain("desktop reply");
    expect(body).toContain("**Planning**");
    // The rollout echo of the user's own message is not sent twice.
    expect(body).not.toContain('"id":"user-1"');
    expect(body).toContain('"state":"completed"');
  });

  it("steers a running desktop turn instead of queueing input", async () => {
    const { app, desktopIpc } = await setup({ running: true });

    const detail = await app.request(`/v1/threads/${threadId}`);
    expect((await detail.json()).thread.state).toBe("running");

    const response = await app.request(`/v1/threads/${threadId}/input`, {
      method: "POST",
      body: JSON.stringify({ prompt: "Also check the tests" }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ acceptedAs: "steering", queueLength: 0 });
    expect(desktopIpc.steerTurn).toHaveBeenCalledWith(
      threadId,
      expect.objectContaining({
        input: [expect.objectContaining({ text: "Also check the tests" })],
      }),
    );
  });
});
