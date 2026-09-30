import { describe, expect, it, vi } from "vitest";

import { ListThreadsResponseSchema } from "../src/api-schema.js";
import { CodexAppServerClient, type AppServerThread } from "../src/app-server.js";
import { createApp } from "../src/app.js";
import type { CodexClient } from "../src/codex.js";

function unavailableCodex(): CodexClient {
  return {
    resumeThread() {
      throw new Error("Subagent input reached the legacy Codex client.");
    },
    startThread() {
      throw new Error("Subagent input started a legacy Codex thread.");
    },
  };
}

function appServerThread(id: string, parentThreadId: string | null = null) {
  const now = Date.now() / 1000;
  return {
    id,
    parentThreadId,
    preview: id,
    createdAt: now,
    updatedAt: now,
    status: { type: "idle" },
    cwd: "/tmp/codex-relay",
    source: "cli",
    modelProvider: "openai",
    name: id,
    turns: [],
  };
}

function appServerWithThreads(listedThreads: AppServerThread[], readableThreads = listedThreads) {
  const appServer = new CodexAppServerClient();
  vi.spyOn(appServer, "listThreads").mockResolvedValue(listedThreads);
  vi.spyOn(appServer, "readThread").mockImplementation(async (threadId) => {
    const thread = readableThreads.find((candidate) => candidate.id === threadId);
    if (!thread) {
      throw new Error(`Unknown test thread ${threadId}.`);
    }
    return thread;
  });
  vi.spyOn(appServer, "onNotification").mockImplementation(() => () => false);
  vi.spyOn(appServer, "onRequest").mockImplementation(() => () => false);
  return appServer;
}

describe("subagent thread boundaries", () => {
  it("lists parent threads without spawned subagent threads", async () => {
    // Given
    const parentThread = appServerThread("parent-thread");
    const subagentThread = appServerThread("subagent-thread", parentThread.id);
    const app = createApp({
      appServer: appServerWithThreads([subagentThread, parentThread]),
      codex: unavailableCodex(),
    });

    // When
    const response = await app.request("/v1/threads");
    const body = ListThreadsResponseSchema.parse(await response.json());

    // Then
    expect(response.status).toBe(200);
    expect(body.threads.map((thread) => thread.id)).toEqual([parentThread.id]);
  });

  it("rejects direct reads and chat input for a spawned subagent thread", async () => {
    // Given
    const subagentThread = appServerThread("subagent-thread", "parent-thread");
    const app = createApp({
      appServer: appServerWithThreads([], [subagentThread]),
      codex: unavailableCodex(),
    });

    // When
    const detailResponse = await app.request(`/v1/threads/${subagentThread.id}`);
    const runResponse = await app.request(`/v1/threads/${subagentThread.id}/runs`, {
      method: "POST",
      body: JSON.stringify({ prompt: "Continue directly" }),
      headers: { "content-type": "application/json" },
    });

    // Then
    expect(detailResponse.status).toBe(404);
    expect(runResponse.status).toBe(404);
  });

  it("rejects renaming a spawned subagent thread", async () => {
    // Given
    const subagentThread = appServerThread("subagent-thread", "parent-thread");
    const appServer = appServerWithThreads([], [subagentThread]);
    const setThreadName = vi.spyOn(appServer, "setThreadName").mockResolvedValue(undefined);
    const app = createApp({
      appServer,
      codex: unavailableCodex(),
    });

    // When
    const response = await app.request(`/v1/threads/${subagentThread.id}/name`, {
      method: "POST",
      body: JSON.stringify({ title: "Hidden chat" }),
      headers: { "content-type": "application/json" },
    });

    // Then
    expect(response.status).toBe(404);
    expect(setThreadName).not.toHaveBeenCalled();
  });

  it("rejects rewinding a spawned subagent thread", async () => {
    // Given
    const now = Date.now() / 1000;
    const subagentThread = {
      ...appServerThread("subagent-thread", "parent-thread"),
      turns: [
        {
          id: "subagent-turn",
          items: [
            {
              content: [{ text: "Hidden prompt", text_elements: [], type: "text" }],
              id: "subagent-message",
              type: "userMessage",
            },
          ],
          status: { type: "completed" },
          startedAt: now,
          completedAt: now + 1,
        },
      ],
    } satisfies AppServerThread;
    const appServer = appServerWithThreads([], [subagentThread]);
    const rollbackThread = vi.spyOn(appServer, "rollbackThread").mockResolvedValue(subagentThread);
    const app = createApp({
      appServer,
      codex: unavailableCodex(),
    });

    // When
    const response = await app.request(`/v1/threads/${subagentThread.id}/rollback`, {
      method: "POST",
      body: JSON.stringify({ turnId: "subagent-turn" }),
      headers: { "content-type": "application/json" },
    });

    // Then
    expect(response.status).toBe(404);
    expect(rollbackThread).not.toHaveBeenCalled();
  });
});
