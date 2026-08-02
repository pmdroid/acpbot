/**
 * CLI-approved operator pairing.
 *
 * Unclaimed bot (operator_user_id = 0): a Telegram user messages the bot and
 * receives a short pairing code. On the machine running acpbot:
 *
 *   acpbot pair approve <code>
 *
 * That proves control of the host (CLI) + the Telegram account (code).
 */
import { randomBytes } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { resolveStateDir } from "../env/state-dir";

export const PAIRING_DIR_NAME = "pairing";
export const PENDING_FILE = "pending.json";
export const APPLIED_FILE = "applied.json";

/** Default TTL for a pending code (15 minutes). */
export const PAIRING_CODE_TTL_MS = 15 * 60 * 1000;

export type PendingPair = {
  code: string;
  userId: number;
  chatId: number;
  username?: string;
  firstName?: string;
  createdAt: number;
  expiresAt: number;
};

export type AppliedPair = {
  userId: number;
  chatId: number;
  code: string;
  approvedAt: number;
  /** Set when the worker has notified Telegram / applied in-memory. */
  consumedAt?: number;
};

type PendingFile = {
  /** code (uppercase) → pending */
  byCode: Record<string, PendingPair>;
};

function pairingDir(stateDir: string): string {
  return join(resolveStateDir(stateDir), PAIRING_DIR_NAME);
}

function pendingPath(stateDir: string): string {
  return join(pairingDir(stateDir), PENDING_FILE);
}

function appliedPath(stateDir: string): string {
  return join(pairingDir(stateDir), APPLIED_FILE);
}

async function ensurePairingDir(stateDir: string): Promise<string> {
  const dir = pairingDir(stateDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

async function readJsonFile<T>(path: string): Promise<T | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const { dirname } = await import("node:path");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tmp, path);
}

/** Crockford-ish alphabet without ambiguous 0/O/1/I. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generatePairingCode(bytes = 4): string {
  const buf = randomBytes(bytes);
  let out = "";
  for (let i = 0; i < buf.length; i++) {
    out += CODE_ALPHABET[buf[i]! % CODE_ALPHABET.length];
  }
  // Group as XXXX-XXXX when long enough
  if (out.length === 8) return `${out.slice(0, 4)}-${out.slice(4)}`;
  return out;
}

export function normalizePairingCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function formatPairingCodeDisplay(normalized: string): string {
  if (normalized.length === 8) {
    return `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
  }
  return normalized;
}

async function loadPending(stateDir: string): Promise<PendingFile> {
  const data = await readJsonFile<PendingFile>(pendingPath(stateDir));
  if (!data || typeof data.byCode !== "object" || data.byCode === null) {
    return { byCode: {} };
  }
  return { byCode: { ...data.byCode } };
}

async function savePending(stateDir: string, data: PendingFile): Promise<void> {
  await writeJsonAtomic(pendingPath(stateDir), data);
}

function pruneExpired(
  byCode: Record<string, PendingPair>,
  now = Date.now(),
): Record<string, PendingPair> {
  const next: Record<string, PendingPair> = {};
  for (const [k, v] of Object.entries(byCode)) {
    if (v.expiresAt > now) next[k] = v;
  }
  return next;
}

/**
 * Create or refresh a pairing code for this Telegram user.
 * Reuses an unexpired code for the same userId when possible.
 */
export async function issuePairingCode(
  stateDir: string,
  input: {
    userId: number;
    chatId: number;
    username?: string;
    firstName?: string;
    now?: number;
    ttlMs?: number;
  },
): Promise<PendingPair> {
  const now = input.now ?? Date.now();
  const ttl = input.ttlMs ?? PAIRING_CODE_TTL_MS;
  const file = await loadPending(stateDir);
  file.byCode = pruneExpired(file.byCode, now);

  for (const p of Object.values(file.byCode)) {
    if (p.userId === input.userId && p.expiresAt > now) {
      // Refresh chatId / display fields; keep code
      const updated: PendingPair = {
        ...p,
        chatId: input.chatId,
        ...(input.username !== undefined ? { username: input.username } : {}),
        ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
      };
      file.byCode[normalizePairingCode(p.code)] = updated;
      await savePending(stateDir, file);
      return updated;
    }
  }

  // Drop other pending users (single pending claim at a time keeps CLI simple)
  file.byCode = {};
  let code = generatePairingCode(8);
  // collision unlikely; retry a few times
  for (let i = 0; i < 5 && file.byCode[normalizePairingCode(code)]; i++) {
    code = generatePairingCode(8);
  }
  const norm = normalizePairingCode(code);
  const pending: PendingPair = {
    code: formatPairingCodeDisplay(norm),
    userId: input.userId,
    chatId: input.chatId,
    createdAt: now,
    expiresAt: now + ttl,
    ...(input.username !== undefined ? { username: input.username } : {}),
    ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
  };
  file.byCode[norm] = pending;
  await savePending(stateDir, file);
  return pending;
}

export async function listPendingPairs(
  stateDir: string,
  now = Date.now(),
): Promise<PendingPair[]> {
  const file = await loadPending(stateDir);
  const pruned = pruneExpired(file.byCode, now);
  if (Object.keys(pruned).length !== Object.keys(file.byCode).length) {
    await savePending(stateDir, { byCode: pruned });
  }
  return Object.values(pruned).sort((a, b) => b.createdAt - a.createdAt);
}

export async function getPendingByCode(
  stateDir: string,
  codeRaw: string,
  now = Date.now(),
): Promise<PendingPair | undefined> {
  const norm = normalizePairingCode(codeRaw);
  if (!norm) return undefined;
  const file = await loadPending(stateDir);
  file.byCode = pruneExpired(file.byCode, now);
  const p = file.byCode[norm];
  return p;
}

/**
 * CLI approve: mark pair applied for the worker and return the pending record.
 * Does not write config — caller patches config.toml.
 */
export async function approvePairingCode(
  stateDir: string,
  codeRaw: string,
  now = Date.now(),
): Promise<PendingPair> {
  const norm = normalizePairingCode(codeRaw);
  if (!norm) {
    throw new Error("Pairing code is empty. Usage: acpbot pair approve <code>");
  }
  const file = await loadPending(stateDir);
  file.byCode = pruneExpired(file.byCode, now);
  const pending = file.byCode[norm];
  if (!pending) {
    throw new Error(
      `No pending pairing for code ${formatPairingCodeDisplay(norm)}.\n` +
        `Ask the Telegram user to DM the bot again, then run: acpbot pair list`,
    );
  }
  delete file.byCode[norm];
  await savePending(stateDir, file);

  const applied: AppliedPair = {
    userId: pending.userId,
    chatId: pending.chatId,
    code: pending.code,
    approvedAt: now,
  };
  await writeJsonAtomic(appliedPath(stateDir), applied);
  return pending;
}

/** Worker: consume a CLI approval once (apply operator in memory + notify). */
export async function takeAppliedPairing(
  stateDir: string,
): Promise<AppliedPair | undefined> {
  const path = appliedPath(stateDir);
  const applied = await readJsonFile<AppliedPair>(path);
  if (!applied || applied.consumedAt) return undefined;
  const consumed: AppliedPair = { ...applied, consumedAt: Date.now() };
  await writeJsonAtomic(path, consumed);
  return applied;
}

export async function clearAppliedPairing(stateDir: string): Promise<void> {
  try {
    await unlink(appliedPath(stateDir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export function pairingMessageForUser(pending: PendingPair): string {
  const who =
    pending.username
      ? `@${pending.username}`
      : pending.firstName
        ? pending.firstName
        : `user ${pending.userId}`;
  const mins = Math.max(1, Math.round((pending.expiresAt - Date.now()) / 60000));
  return (
    `🔐 <b>Pair this bot</b>\n\n` +
    `Telegram: ${who} (<code>${pending.userId}</code>)\n` +
    `Pairing code: <code>${pending.code}</code>\n\n` +
    `On the machine running acpbot, approve with:\n` +
    `<code>acpbot pair approve ${pending.code}</code>\n\n` +
    `Code expires in ~${mins} min. Only someone with shell access to that machine can approve.`
  );
}
