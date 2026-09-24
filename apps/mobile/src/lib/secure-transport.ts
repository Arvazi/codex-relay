import "react-native-get-random-values";

import { gcm } from "@noble/ciphers/aes.js";
import { bytesToUtf8, randomBytes, utf8ToBytes } from "@noble/ciphers/utils.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  EncryptedPayloadSchema,
  PairEncryptedPayloadSchema,
  type EncryptedPayload,
  type PairResponse,
} from "codex-relay/api-schema";
import { fromByteArray, toByteArray } from "base64-js";
import { createMMKV } from "react-native-mmkv";

const secureProtocolVersion = 1;
const handshakeTag = "codex-relay-e2ee-v1";
const storage = createMMKV({ id: "codex-relay-secure" });
const keyEpochStorageKey = "key-epoch";
const mobileToServerKeyStorageKey = "mobile-to-server-key";
const serverToMobileKeyStorageKey = "server-to-mobile-key";
const nextMobileCounterStorageKey = "next-mobile-counter";
const lastServerCounterStorageKey = "last-server-counter";

export type SecurePairingAttempt = {
  approvalCode?: string;
  clientEphemeralPublicKey: string;
  clientNonce: string;
  clientEphemeralPrivateKey: Uint8Array;
  serverPublicKey: string;
  serverUrl: string;
};

type SecureSession = {
  keyEpoch: number;
  lastServerCounter: number;
  mobileToServerKey: Uint8Array;
  nextMobileCounter: number;
  serverToMobileKey: Uint8Array;
};

export function createSecurePairingAttempt(input: {
  serverPublicKey: string;
  serverUrl: string;
}): SecurePairingAttempt {
  const clientEphemeralPrivateKey = x25519.utils.randomSecretKey();
  return {
    clientEphemeralPrivateKey,
    clientEphemeralPublicKey: bytesToBase64(x25519.getPublicKey(clientEphemeralPrivateKey)),
    clientNonce: bytesToBase64(randomBytes(32)),
    serverPublicKey: input.serverPublicKey,
    serverUrl: input.serverUrl,
  };
}

export function attachApprovalCode(attempt: SecurePairingAttempt, approvalCode: string) {
  attempt.approvalCode = approvalCode;
}

export function completeSecurePairing(attempt: SecurePairingAttempt, response: PairResponse) {
  if (!response.secure) {
    throw new Error("Server did not return a secure pairing response.");
  }

  const transcript = pairingTranscript({
    approvalCode: attempt.approvalCode ?? "",
    clientEphemeralPublicKey: attempt.clientEphemeralPublicKey,
    clientNonce: attempt.clientNonce,
    keyEpoch: response.secure.keyEpoch,
    serverEphemeralPublicKey: response.secure.serverEphemeralPublicKey,
    serverIdentityPublicKey: attempt.serverPublicKey,
    serverNonce: response.secure.serverNonce,
    serverUrl: attempt.serverUrl,
  });
  if (
    !ed25519.verify(
      base64ToBytes(response.secure.serverSignature),
      transcript,
      base64ToBytes(attempt.serverPublicKey),
    )
  ) {
    throw new Error("Server secure pairing signature did not match the scanned QR.");
  }

  const sharedSecret = x25519.getSharedSecret(
    attempt.clientEphemeralPrivateKey,
    base64ToBytes(response.secure.serverEphemeralPublicKey),
  );
  const session = deriveSession(sharedSecret, transcript, response.secure.keyEpoch);
  const decrypted = decryptWithKey(
    session.serverToMobileKey,
    "server",
    0,
    response.secure.encryptedPayload,
  );
  const payload = PairEncryptedPayloadSchema.parse(JSON.parse(decrypted));
  saveSecureSession(session);
  return payload;
}

export function encryptRequestPayload(payload: unknown) {
  const session = readSecureSession();
  if (!session) {
    return JSON.stringify(payload);
  }

  const envelope = encryptWithKey(
    session.mobileToServerKey,
    "mobile",
    session.keyEpoch,
    session.nextMobileCounter,
    JSON.stringify(payload),
  );
  session.nextMobileCounter += 1;
  saveSecureSession(session);
  return JSON.stringify(EncryptedPayloadSchema.parse(envelope));
}

export function decryptResponsePayload(payload: unknown) {
  const session = readSecureSession();
  const envelope = EncryptedPayloadSchema.safeParse(payload);
  if (!session) {
    return payload;
  }
  if (!envelope.success) {
    throw new Error("Server returned an unencrypted response for a secure session.");
  }
  if (
    envelope.data.sender !== "server" ||
    envelope.data.keyEpoch !== session.keyEpoch ||
    envelope.data.counter <= session.lastServerCounter
  ) {
    throw new Error("Server returned an invalid encrypted payload.");
  }

  const decrypted = decryptWithKey(
    session.serverToMobileKey,
    "server",
    envelope.data.counter,
    envelope.data.ciphertext,
  );
  session.lastServerCounter = envelope.data.counter;
  saveSecureSession(session);
  return JSON.parse(decrypted);
}

export function clearSecureSession() {
  storage.clearAll();
}

function deriveSession(
  sharedSecret: Uint8Array,
  transcript: Uint8Array,
  keyEpoch: number,
): SecureSession {
  const salt = sha256(transcript);
  const infoPrefix = `${handshakeTag}|${keyEpoch}|${bytesToBase64(sha256(transcript))}`;
  return {
    keyEpoch,
    lastServerCounter: 0,
    mobileToServerKey: hkdf(
      sha256,
      sharedSecret,
      salt,
      utf8ToBytes(`${infoPrefix}|mobileToServer`),
      32,
    ),
    nextMobileCounter: 0,
    serverToMobileKey: hkdf(
      sha256,
      sharedSecret,
      salt,
      utf8ToBytes(`${infoPrefix}|serverToMobile`),
      32,
    ),
  };
}

function pairingTranscript(input: {
  approvalCode: string;
  clientEphemeralPublicKey: string;
  clientNonce: string;
  keyEpoch: number;
  serverEphemeralPublicKey: string;
  serverIdentityPublicKey: string;
  serverNonce: string;
  serverUrl: string;
}) {
  return utf8ToBytes(
    JSON.stringify({
      tag: handshakeTag,
      approvalCode: input.approvalCode,
      clientEphemeralPublicKey: input.clientEphemeralPublicKey,
      clientNonce: input.clientNonce,
      keyEpoch: input.keyEpoch,
      serverEphemeralPublicKey: input.serverEphemeralPublicKey,
      serverIdentityPublicKey: input.serverIdentityPublicKey,
      serverNonce: input.serverNonce,
      serverUrl: input.serverUrl,
    }),
  );
}

function encryptWithKey(
  key: Uint8Array,
  sender: "mobile" | "server",
  keyEpoch: number,
  counter: number,
  plaintext: string,
): EncryptedPayload {
  const ciphertext = gcm(key, nonceFor(sender, counter)).encrypt(utf8ToBytes(plaintext));
  return {
    ciphertext: bytesToBase64(ciphertext),
    counter,
    keyEpoch,
    protocolVersion: secureProtocolVersion,
    sender,
  };
}

function decryptWithKey(
  key: Uint8Array,
  sender: "mobile" | "server",
  counter: number,
  ciphertext: string,
) {
  const plaintext = gcm(key, nonceFor(sender, counter)).decrypt(base64ToBytes(ciphertext));
  return bytesToUtf8(plaintext);
}

function nonceFor(sender: "mobile" | "server", counter: number) {
  const nonce = new Uint8Array(12);
  nonce[0] = sender === "mobile" ? 1 : 2;
  new DataView(nonce.buffer).setBigUint64(4, BigInt(counter), false);
  return nonce;
}

function saveSecureSession(session: SecureSession) {
  storage.set(keyEpochStorageKey, session.keyEpoch);
  storage.set(mobileToServerKeyStorageKey, bytesToBase64(session.mobileToServerKey));
  storage.set(serverToMobileKeyStorageKey, bytesToBase64(session.serverToMobileKey));
  storage.set(nextMobileCounterStorageKey, session.nextMobileCounter);
  storage.set(lastServerCounterStorageKey, session.lastServerCounter);
}

function readSecureSession() {
  const mobileToServerKey = storage.getString(mobileToServerKeyStorageKey);
  const serverToMobileKey = storage.getString(serverToMobileKeyStorageKey);
  const keyEpoch = storage.getNumber(keyEpochStorageKey);
  if (!mobileToServerKey || !serverToMobileKey || keyEpoch === undefined) {
    return undefined;
  }

  return {
    keyEpoch,
    lastServerCounter: storage.getNumber(lastServerCounterStorageKey) ?? 0,
    mobileToServerKey: base64ToBytes(mobileToServerKey),
    nextMobileCounter: storage.getNumber(nextMobileCounterStorageKey) ?? 0,
    serverToMobileKey: base64ToBytes(serverToMobileKey),
  };
}

function bytesToBase64(bytes: Uint8Array) {
  return fromByteArray(bytes);
}

function base64ToBytes(value: string) {
  return toByteArray(value);
}
