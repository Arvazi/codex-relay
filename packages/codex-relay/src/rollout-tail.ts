import { open, stat } from "node:fs/promises";

import type { AppServerThreadItem } from "./app-server.js";

// Reads appended rollout JSONL without loading the whole file. Desktop-owned threads can have
// rollouts well over 100 MB (inline screenshots), so every read here is bounded by byte offsets.

const initialScanBytes = 512 * 1024;
const maxScanBytes = 32 * 1024 * 1024;
// A turn without a terminal record is only treated as live while its rollout keeps changing;
// crashed turns never write task_complete.
const staleRunningTurnMs = 30 * 60 * 1000;

export type RolloutLifecycleRecord = {
  running: boolean;
  turnId?: string;
};

export type RolloutTailChunk = {
  lines: string[];
  nextOffset: number;
};

export async function rolloutFileSize(path: string) {
  try {
    return (await stat(path)).size;
  } catch {
    return undefined;
  }
}

export async function readRolloutLinesFrom(
  path: string,
  offset: number,
  maxBytes = 8 * 1024 * 1024,
): Promise<RolloutTailChunk> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    if (size <= offset) {
      return { lines: [], nextOffset: Math.min(offset, size) };
    }
    const length = Math.min(size - offset, maxBytes);
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    const chunk = buffer.subarray(0, bytesRead);
    const lastNewline = chunk.lastIndexOf(0x0a);
    if (lastNewline < 0) {
      // A single record larger than maxBytes: grow the window until the line completes.
      if (bytesRead === maxBytes && maxBytes < maxScanBytes * 4) {
        return readRolloutLinesFrom(path, offset, maxBytes * 2);
      }
      return { lines: [], nextOffset: offset };
    }
    const complete = chunk.subarray(0, lastNewline).toString("utf8");
    return {
      // Blank lines are kept so callers can track line numbers.
      lines: complete.split("\n"),
      nextOffset: offset + lastNewline + 1,
    };
  } finally {
    await handle.close();
  }
}

export function rolloutLifecycleRecord(line: string): RolloutLifecycleRecord | undefined {
  if (!line.includes('"event_msg"')) {
    return undefined;
  }
  if (
    !line.includes('"task_started"') &&
    !line.includes('"task_complete"') &&
    !line.includes('"turn_aborted"')
  ) {
    return undefined;
  }
  try {
    const record = JSON.parse(line) as { payload?: Record<string, unknown>; type?: unknown };
    if (record.type !== "event_msg") {
      return undefined;
    }
    const type = record.payload?.type;
    const turnId = typeof record.payload?.turn_id === "string" ? record.payload.turn_id : undefined;
    if (type === "task_started") {
      return { running: true, turnId };
    }
    if (type === "task_complete" || type === "turn_aborted") {
      return { running: false, turnId };
    }
  } catch {
    // Ignore partial lines.
  }
  return undefined;
}

export async function readRolloutActiveTurn(
  path: string,
  now = Date.now(),
): Promise<RolloutLifecycleRecord & { size: number }> {
  const handle = await open(path, "r");
  try {
    const { mtimeMs, size } = await handle.stat();
    const isFresh = now - mtimeMs < staleRunningTurnMs;
    let window = initialScanBytes;
    while (true) {
      const start = Math.max(0, size - window);
      const length = size - start;
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
      // The first line of a window may be cut off; only trust it when the window reaches the start.
      const firstTrusted = start === 0 ? 0 : 1;
      for (let index = lines.length - 1; index >= firstTrusted; index -= 1) {
        const lifecycle = rolloutLifecycleRecord(lines[index]!);
        if (lifecycle) {
          return { ...lifecycle, running: lifecycle.running && isFresh, size };
        }
      }
      if (start === 0 || window >= maxScanBytes) {
        return { running: false, size };
      }
      window *= 4;
    }
  } finally {
    await handle.close();
  }
}

// Number of lines before `offset`, so tailed records get the same `rollout:<line>` keys as a full
// read. Record ordinals are not usable for this: forked threads inherit their parent's ordinals.
export async function countRolloutLinesBefore(path: string, offset: number) {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
    let position = 0;
    let lines = 0;
    while (position < offset) {
      const length = Math.min(buffer.length, offset - position);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead === 0) {
        break;
      }
      for (let index = buffer.indexOf(0x0a, 0); index >= 0 && index < bytesRead; ) {
        lines += 1;
        index = buffer.indexOf(0x0a, index + 1);
      }
      position += bytesRead;
    }
    return lines;
  } finally {
    await handle.close();
  }
}

export type RolloutTurnItem = {
  item: AppServerThreadItem;
  turnId?: string;
};

// Desktop rollouts record each finished item as `event_msg`/`item_completed` with a core TurnItem
// (PascalCase type, snake_case fields). Convert it to the app-server v2 item shape the relay
// already maps, so tailed items render exactly like app-server history.
export function rolloutCompletedTurnItem(line: string): RolloutTurnItem | undefined {
  if (!line.includes('"item_completed"')) {
    return undefined;
  }
  let record: { payload?: { item?: Record<string, unknown>; turn_id?: unknown; type?: unknown } };
  try {
    record = JSON.parse(line) as typeof record;
  } catch {
    return undefined;
  }
  const raw = record.payload?.type === "item_completed" ? record.payload.item : undefined;
  const id = typeof raw?.id === "string" ? raw.id : undefined;
  if (!raw || !id) {
    return undefined;
  }
  const turnId = typeof record.payload?.turn_id === "string" ? record.payload.turn_id : undefined;
  const item = appServerItemFromTurnItem(id, raw);
  return item ? { item, turnId } : undefined;
}

function appServerItemFromTurnItem(
  id: string,
  raw: Record<string, unknown>,
): AppServerThreadItem | undefined {
  switch (raw.type) {
    case "UserMessage":
      return {
        type: "userMessage",
        id,
        clientId: typeof raw.client_id === "string" ? raw.client_id : null,
        content: recordArray(raw.content).flatMap((part) =>
          part.type === "text" && typeof part.text === "string"
            ? [{ type: "text" as const, text: part.text, text_elements: [] }]
            : [],
        ),
      };
    case "AgentMessage":
      return {
        type: "agentMessage",
        id,
        text: recordArray(raw.content)
          .flatMap((part) => (typeof part.text === "string" ? [part.text] : []))
          .join(""),
      };
    case "Reasoning":
      return {
        type: "reasoning",
        id,
        summary: stringList(raw.summary_text),
        content: stringList(raw.raw_content),
      };
    case "CommandExecution":
      return {
        type: "commandExecution",
        id,
        command: Array.isArray(raw.command)
          ? raw.command.filter((part) => typeof part === "string").join(" ")
          : String(raw.command ?? ""),
        aggregatedOutput: typeof raw.aggregated_output === "string" ? raw.aggregated_output : null,
        cwd: typeof raw.cwd === "string" ? raw.cwd.replace(/^file:\/\//, "") : null,
        exitCode: typeof raw.exit_code === "number" ? raw.exit_code : null,
        status: typeof raw.status === "string" ? raw.status : null,
      };
    case "FileChange": {
      const changes =
        raw.changes && typeof raw.changes === "object" && !Array.isArray(raw.changes)
          ? Object.entries(raw.changes as Record<string, Record<string, unknown>>)
          : [];
      return {
        type: "fileChange",
        id,
        changes: changes.map(([path, change]) => ({
          path,
          kind: typeof change?.type === "string" ? change.type : "update",
          diff: typeof change?.unified_diff === "string" ? change.unified_diff : null,
        })),
      };
    }
    case "McpToolCall":
      return {
        type: "mcpToolCall",
        id,
        server: String(raw.server ?? ""),
        tool: String(raw.tool ?? ""),
        status: typeof raw.status === "string" ? raw.status : null,
      };
    default:
      return undefined;
  }
}

function recordArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object",
      )
    : [];
}

function stringList(value: unknown) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}
