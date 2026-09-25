import { gcm } from "@noble/ciphers/aes.js";
import { fromByteArray } from "base64-js";
import * as pty from "@lydell/node-pty";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

import type { CodexClient, CodexThread } from "../src/codex.js";
import { createApp } from "../src/app.js";
import { EncryptedPayloadSchema } from "../src/api-schema.js";
import type { PairingSessionStore } from "../src/pairing-store.js";
import {
  createServerIdentity,
  encryptForMobile,
  type SecureSession,
} from "../src/secure-transport.js";

// Never launch a real shell, including when this test detects a regression.
vi.mock("@lydell/node-pty", () => ({
  spawn: vi.fn<() => never>(() => {
    throw new Error("Unexpected shell launch");
  }),
}));

function fixture() {
  vi.clearAllMocks();
  const secureSession: SecureSession = {
    keyEpoch: 1,
    mobileToServerKey: new Uint8Array(32).fill(1),
    serverToMobileKey: new Uint8Array(32).fill(2),
    lastMobileCounter: -1,
    nextServerCounter: 0,
  };
  const sessions = {
    getValidSession: vi.fn<
      (token: string) => Promise<{ secureSession: SecureSession } | undefined>
    >(async (token) => (token === "test-token" ? { secureSession } : undefined)),
    updateSecureSession: vi.fn<() => Promise<void>>(async () => {}),
  } as unknown as PairingSessionStore;
  const startThread = vi.fn<CodexClient["startThread"]>(() => ({
    id: "test-thread",
    run: vi.fn<CodexThread["run"]>(async () => ({})),
  }));
  const app = createApp({
    appServer: null,
    codex: { startThread, resumeThread: vi.fn<CodexClient["resumeThread"]>() },
    pairing: {
      approvalSecret: "test-approval-secret",
      serverIdentity: createServerIdentity(),
      sessions,
      createClientToken: () => "test-token",
      hashClientToken: (token) => token,
    },
    workspacePath: process.cwd(),
  });
  return { app, startThread, secureSession };
}

function encryptedRequest(session: SecureSession, payload: unknown) {
  const nonce = new Uint8Array(12);
  nonce[0] = 1;
  return {
    ciphertext: fromByteArray(
      gcm(session.mobileToServerKey, nonce).encrypt(
        new TextEncoder().encode(JSON.stringify(payload)),
      ),
    ),
    counter: 0,
    keyEpoch: 1,
    protocolVersion: 1,
    sender: "mobile",
  };
}

describe("server security boundaries", () => {
  for (const path of ["/v1/threads", "/v1/workspace/terminal/sessions"]) {
    for (const [name, body] of [
      ["plaintext", "{}"],
      ["invalid JSON", "{"],
      [
        "invalid ciphertext",
        JSON.stringify({
          ciphertext: "AAAA",
          counter: 0,
          keyEpoch: 1,
          protocolVersion: 1,
          sender: "mobile",
        }),
      ],
    ]) {
      it(`rejects ${name} on ${path} before side effects`, async () => {
        const { app, startThread } = fixture();
        const response = await app.request(path, {
          method: "POST",
          body,
          headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        });
        expect(response.status).toBe(400);
        expect(startThread).not.toHaveBeenCalled();
        expect(pty.spawn).not.toHaveBeenCalled();
      });
    }
  }

  it("accepts a valid encrypted request and rejects its replay", async () => {
    const { app, secureSession } = fixture();
    const body = JSON.stringify(encryptedRequest(secureSession, { title: "Encrypted thread" }));
    const request = () =>
      app.request("/v1/threads", {
        method: "POST",
        body,
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      });
    expect((await request()).status).toBe(201);
    expect((await request()).status).toBe(400);
  });

  it("requires authentication before looking up an image", async () => {
    const { app } = fixture();
    const path = "/v1/attachments/images/unknown.png";
    expect((await app.request(path)).status).toBe(401);
    expect((await app.request(path, { headers: { authorization: "Bearer invalid" } })).status).toBe(
      401,
    );
    expect(
      (await app.request(path, { headers: { authorization: "Bearer test-token" } })).status,
    ).toBe(404);
  });
});

describe("mobile encrypted response boundary", () => {
  // Execute the actual mobile function without loading React Native in Node.
  // Storage and native setup are substituted; payload validation and crypto are real.
  function mobileBoundary() {
    const { secureSession } = fixture();
    const source = readFileSync(
      new URL("../../../apps/mobile/src/lib/secure-transport.ts", import.meta.url),
      "utf8",
    );
    const start = source.indexOf("export function decryptResponsePayload(");
    const end = source.indexOf("export function clearSecureSession(", start);
    if (start < 0 || end < 0) throw new Error("Mobile function could not be located");
    const code = ts.transpileModule(
      source.slice(start, end).replace("export function", "function"),
      {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      },
    ).outputText;
    const mobileSession = { ...secureSession, lastServerCounter: -1 };
    const context = createContext({
      readSecureSession: () => mobileSession,
      EncryptedPayloadSchema,
      saveSecureSession: vi.fn<() => void>(),
      decryptWithKey: (key: Uint8Array, _sender: string, counter: number, ciphertext: string) => {
        const nonce = new Uint8Array(12);
        nonce[0] = 2;
        new DataView(nonce.buffer).setBigUint64(4, BigInt(counter), false);
        return new TextDecoder().decode(gcm(key, nonce).decrypt(Buffer.from(ciphertext, "base64")));
      },
    });
    runInContext(code, context);
    return {
      decrypt: context.decryptResponsePayload as (payload: unknown) => unknown,
      secureSession,
    };
  }

  it("rejects plaintext while a secure session exists", () => {
    const { decrypt } = mobileBoundary();
    expect(() => decrypt({ ok: true, result: "forged response" })).toThrow("unencrypted response");
  });

  it("accepts encrypted responses and rejects replay and tampering", () => {
    const { decrypt, secureSession } = mobileBoundary();
    const envelope = encryptForMobile(secureSession, JSON.stringify({ ok: true }));
    expect(decrypt(envelope)).toEqual({ ok: true });
    expect(() => decrypt(envelope)).toThrow("invalid encrypted payload");
    expect(() => decrypt({ ...envelope, counter: 1, ciphertext: "AAAA" })).toThrow(
      /ciphertext|tag/i,
    );
  });
});
