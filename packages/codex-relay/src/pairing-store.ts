import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { fromByteArray, toByteArray } from "base64-js";

import { connect } from "./libsql-database.js";
import type { SecureSession } from "./secure-transport.js";

export type ClientSession = {
  clientSessionId?: string;
  clientName?: string;
  expiresAt?: number;
  secureSession?: SecureSession;
};

// Preserve the legacy database/API fields without making session validity time-based.
export const permanentClientSessionExpiresAt = Date.parse("9999-12-31T23:59:59.999Z");

export type PendingPairing = {
  approvalCode: string;
  approved: boolean;
  clientEphemeralPublicKey: string;
  clientSessionId?: string;
  clientName?: string;
  clientNonce: string;
  expiresAt: number;
  serverUrl: string;
};

export type PairingSessionStore = {
  approvePendingPairing(approvalCode: string, now: number): Promise<PendingPairing | undefined>;
  clearAll(): Promise<{ pendingPairingsCleared: number; sessionsCleared: number }>;
  countActive(): Promise<number>;
  createPendingPairing(pairing: PendingPairing): Promise<void>;
  createSession(tokenHash: string, session: ClientSession): Promise<number>;
  deleteSession(tokenHash: string): Promise<void>;
  deletePendingPairing(approvalCode: string): Promise<void>;
  getPendingPairing(approvalCode: string, now: number): Promise<PendingPairing | undefined>;
  getValidSession(tokenHash: string): Promise<ClientSession | undefined>;
  pruneExpiredPendingPairings(now: number): Promise<void>;
  rotateSession(
    oldTokenHash: string,
    newTokenHash: string,
    session: ClientSession,
  ): Promise<number>;
  updateSecureSession(tokenHash: string, secureSession: SecureSession): Promise<void>;
};

export async function createTursoPairingSessionStore(path: string): Promise<PairingSessionStore> {
  if (path !== ":memory:") {
    await mkdir(dirname(path), { recursive: true });
  }

  const db = await connect(path);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS pairing_sessions (
      token_hash TEXT PRIMARY KEY,
      client_session_id TEXT,
      client_name TEXT,
      expires_at INTEGER NOT NULL,
      key_epoch INTEGER,
      mobile_to_server_key TEXT,
      server_to_mobile_key TEXT,
      last_mobile_counter INTEGER,
      next_server_counter INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pending_pairings (
      approval_code TEXT PRIMARY KEY,
      client_session_id TEXT,
      client_name TEXT,
      client_ephemeral_public_key TEXT NOT NULL,
      client_nonce TEXT NOT NULL,
      server_url TEXT NOT NULL,
      approved INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- Push notifications (via Expo) were removed; drop the stored device tokens.
    DROP TABLE IF EXISTS push_notification_subscriptions;
  `);
  await ensurePairingSessionColumns();

  async function countActive() {
    const row = await db
      .prepare(
        "SELECT COUNT(DISTINCT COALESCE(client_session_id, token_hash)) AS count FROM pairing_sessions",
      )
      .get();
    return Number(row?.count ?? 0);
  }

  async function deleteSession(tokenHash: string) {
    await db.prepare("DELETE FROM pairing_sessions WHERE token_hash = ?").run(tokenHash);
  }

  async function deletePendingPairing(approvalCode: string) {
    await db.prepare("DELETE FROM pending_pairings WHERE approval_code = ?").run(approvalCode);
  }

  async function getPendingPairing(approvalCode: string, now: number) {
    const row = await db
      .prepare(
        `SELECT approval_code AS approvalCode,
                client_session_id AS clientSessionId,
                client_name AS clientName,
                client_ephemeral_public_key AS clientEphemeralPublicKey,
                client_nonce AS clientNonce,
                server_url AS serverUrl,
                approved,
                expires_at AS expiresAt
         FROM pending_pairings
         WHERE approval_code = ?`,
      )
      .get(approvalCode);
    if (!row) {
      return undefined;
    }

    const expiresAt = Number(row.expiresAt);
    if (now > expiresAt) {
      await deletePendingPairing(approvalCode);
      return undefined;
    }

    return {
      approvalCode: String(row.approvalCode),
      approved: Number(row.approved) === 1,
      clientEphemeralPublicKey: String(row.clientEphemeralPublicKey),
      clientSessionId: typeof row.clientSessionId === "string" ? row.clientSessionId : undefined,
      clientName: typeof row.clientName === "string" ? row.clientName : undefined,
      clientNonce: String(row.clientNonce),
      expiresAt,
      serverUrl: String(row.serverUrl),
    };
  }

  return {
    async approvePendingPairing(approvalCode, now) {
      const pending = await getPendingPairing(approvalCode, now);
      if (!pending) {
        return undefined;
      }

      await db
        .prepare("UPDATE pending_pairings SET approved = 1, updated_at = ? WHERE approval_code = ?")
        .run(now, approvalCode);
      return { ...pending, approved: true };
    },
    async clearAll() {
      const result = await db.transaction(async (transaction) => {
        const sessionRow = await transaction
          .prepare("SELECT COUNT(*) AS count FROM pairing_sessions")
          .get();
        const pendingRow = await transaction
          .prepare("SELECT COUNT(*) AS count FROM pending_pairings")
          .get();
        await transaction.prepare("DELETE FROM pairing_sessions").run();
        await transaction.prepare("DELETE FROM pending_pairings").run();
        return {
          pendingPairingsCleared: Number(pendingRow?.count ?? 0),
          sessionsCleared: Number(sessionRow?.count ?? 0),
        };
      })();
      return result;
    },
    countActive,
    async createPendingPairing(pairing) {
      const now = Date.now();
      await db
        .prepare(
          `INSERT INTO pending_pairings (
             approval_code,
             client_session_id,
             client_name,
             client_ephemeral_public_key,
             client_nonce,
             server_url,
             approved,
             expires_at,
             created_at,
             updated_at
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          pairing.approvalCode,
          pairing.clientSessionId ?? null,
          pairing.clientName ?? null,
          pairing.clientEphemeralPublicKey,
          pairing.clientNonce,
          pairing.serverUrl,
          pairing.approved ? 1 : 0,
          pairing.expiresAt,
          now,
          now,
        );
    },
    async createSession(tokenHash, session) {
      const now = Date.now();
      const secure = encodeSecureSession(session.secureSession);
      if (session.clientSessionId) {
        await db
          .prepare("DELETE FROM pairing_sessions WHERE client_session_id = ?")
          .run(session.clientSessionId);
        if (session.clientName) {
          await db
            .prepare(
              "DELETE FROM pairing_sessions WHERE client_session_id IS NULL AND client_name = ?",
            )
            .run(session.clientName);
        }
      }
      await db
        .prepare(
          `INSERT INTO pairing_sessions (
             token_hash,
             client_session_id,
             client_name,
             expires_at,
             key_epoch,
             mobile_to_server_key,
             server_to_mobile_key,
             last_mobile_counter,
             next_server_counter,
             created_at,
             updated_at
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          tokenHash,
          session.clientSessionId ?? null,
          session.clientName ?? null,
          session.expiresAt ?? permanentClientSessionExpiresAt,
          secure?.keyEpoch ?? null,
          secure?.mobileToServerKey ?? null,
          secure?.serverToMobileKey ?? null,
          secure?.lastMobileCounter ?? null,
          secure?.nextServerCounter ?? null,
          now,
          now,
        );
      return countActive();
    },
    deleteSession,
    deletePendingPairing,
    getPendingPairing,
    async getValidSession(tokenHash) {
      const row = await db
        .prepare(
          `SELECT client_name AS clientName,
                  client_session_id AS clientSessionId,
                  expires_at AS expiresAt,
                  key_epoch AS keyEpoch,
                  mobile_to_server_key AS mobileToServerKey,
                  server_to_mobile_key AS serverToMobileKey,
                  last_mobile_counter AS lastMobileCounter,
                  next_server_counter AS nextServerCounter
           FROM pairing_sessions
           WHERE token_hash = ?`,
        )
        .get(tokenHash);
      if (!row) {
        return undefined;
      }

      return {
        clientSessionId: typeof row.clientSessionId === "string" ? row.clientSessionId : undefined,
        clientName: typeof row.clientName === "string" ? row.clientName : undefined,
        expiresAt: Number(row.expiresAt),
        secureSession: decodeSecureSession(row),
      };
    },
    async pruneExpiredPendingPairings(now) {
      await db.prepare("DELETE FROM pending_pairings WHERE expires_at <= ?").run(now);
    },
    async rotateSession(oldTokenHash, newTokenHash, session) {
      const now = Date.now();
      const secure = encodeSecureSession(session.secureSession);
      await db.transaction(async (transaction) => {
        await transaction
          .prepare("DELETE FROM pairing_sessions WHERE token_hash = ?")
          .run(oldTokenHash);
        if (session.clientSessionId) {
          await transaction
            .prepare("DELETE FROM pairing_sessions WHERE client_session_id = ?")
            .run(session.clientSessionId);
          if (session.clientName) {
            await transaction
              .prepare(
                "DELETE FROM pairing_sessions WHERE client_session_id IS NULL AND client_name = ?",
              )
              .run(session.clientName);
          }
        }
        await transaction
          .prepare(
            `INSERT INTO pairing_sessions (
               token_hash,
               client_session_id,
               client_name,
               expires_at,
               key_epoch,
               mobile_to_server_key,
               server_to_mobile_key,
               last_mobile_counter,
               next_server_counter,
               created_at,
               updated_at
             )
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            newTokenHash,
            session.clientSessionId ?? null,
            session.clientName ?? null,
            session.expiresAt ?? permanentClientSessionExpiresAt,
            secure?.keyEpoch ?? null,
            secure?.mobileToServerKey ?? null,
            secure?.serverToMobileKey ?? null,
            secure?.lastMobileCounter ?? null,
            secure?.nextServerCounter ?? null,
            now,
            now,
          );
      })();
      return countActive();
    },
    async updateSecureSession(tokenHash, secureSession) {
      const secure = encodeSecureSession(secureSession)!;
      const now = Date.now();
      await db
        .prepare(
          `UPDATE pairing_sessions
           SET key_epoch = ?,
               mobile_to_server_key = ?,
               server_to_mobile_key = ?,
               last_mobile_counter = ?,
               next_server_counter = ?,
               updated_at = ?
           WHERE token_hash = ?`,
        )
        .run(
          secure.keyEpoch,
          secure.mobileToServerKey,
          secure.serverToMobileKey,
          secure.lastMobileCounter,
          secure.nextServerCounter,
          now,
          tokenHash,
        );
    },
  };

  async function ensurePairingSessionColumns() {
    const rows = await db.prepare("PRAGMA table_info(pairing_sessions)").all();
    const columns = new Set(resultRows(rows).map((row) => String(row.name)));
    const migrations: Array<[string, string]> = [
      ["client_session_id", "ALTER TABLE pairing_sessions ADD COLUMN client_session_id TEXT"],
      ["key_epoch", "ALTER TABLE pairing_sessions ADD COLUMN key_epoch INTEGER"],
      ["mobile_to_server_key", "ALTER TABLE pairing_sessions ADD COLUMN mobile_to_server_key TEXT"],
      ["server_to_mobile_key", "ALTER TABLE pairing_sessions ADD COLUMN server_to_mobile_key TEXT"],
      [
        "last_mobile_counter",
        "ALTER TABLE pairing_sessions ADD COLUMN last_mobile_counter INTEGER",
      ],
      [
        "next_server_counter",
        "ALTER TABLE pairing_sessions ADD COLUMN next_server_counter INTEGER",
      ],
    ];

    for (const [column, sql] of migrations) {
      if (!columns.has(column)) {
        await db.exec(sql);
      }
    }

    const pendingRows = await db.prepare("PRAGMA table_info(pending_pairings)").all();
    const pendingColumns = new Set(resultRows(pendingRows).map((row) => String(row.name)));
    if (!pendingColumns.has("client_session_id")) {
      await db.exec("ALTER TABLE pending_pairings ADD COLUMN client_session_id TEXT");
    }
  }
}

function encodeSecureSession(session: SecureSession | undefined) {
  if (!session) {
    return undefined;
  }

  return {
    keyEpoch: session.keyEpoch,
    lastMobileCounter: session.lastMobileCounter,
    mobileToServerKey: fromByteArray(session.mobileToServerKey),
    nextServerCounter: session.nextServerCounter,
    serverToMobileKey: fromByteArray(session.serverToMobileKey),
  };
}

function decodeSecureSession(row: Record<string, unknown>) {
  if (
    typeof row.mobileToServerKey !== "string" ||
    typeof row.serverToMobileKey !== "string" ||
    row.keyEpoch === null ||
    row.lastMobileCounter === null ||
    row.nextServerCounter === null
  ) {
    return undefined;
  }

  return {
    keyEpoch: Number(row.keyEpoch),
    lastMobileCounter: Number(row.lastMobileCounter),
    mobileToServerKey: toByteArray(row.mobileToServerKey),
    nextServerCounter: Number(row.nextServerCounter),
    serverToMobileKey: toByteArray(row.serverToMobileKey),
  };
}

function resultRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) {
    return result as Record<string, unknown>[];
  }
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Record<string, unknown>[] }).rows;
  }
  return [];
}
