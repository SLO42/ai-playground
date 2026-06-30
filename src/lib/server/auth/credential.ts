// server/auth — DB-backed app credential store for the non-loopback login gate.
//
// WHY this exists: the control plane binds loopback only (D-025), so LOCAL use is
// login-free. But the operator may reach the dashboard over the LAN (e.g.
// `vite dev --host`), and an unauthenticated LAN listener is an open door. This
// module backs a CASUAL login gate: a single operator password, set on first run
// via the UI, stored as a salted scrypt HASH (never the plaintext) plus a random
// HMAC cookie-signing secret. Both live in a single-row `app_auth` table.
//
// HONEST SCOPE (do not overstate): this is casual gating over PLAIN HTTP. Without
// TLS, credentials and the signed cookie travel in cleartext on the LAN and are
// observable/replayable by anyone on the wire. It deters casual access; it is NOT
// a substitute for TLS + a real auth system. The loopback bypass is the security
// boundary that matters (D-025); this gate only covers the LAN convenience path.
//
// SECRETS (D-026): the plaintext password is NEVER stored, logged, or returned.
// Only the scrypt hash + salt + the HMAC secret are persisted, and the HMAC secret
// stays server-side (used to sign/verify the session cookie) — never sent to a client.

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/client';

/** The single-row record id — one operator credential per deployment. */
export const APP_AUTH_ID = 'app_auth:singleton';

/** scrypt output length in bytes (F-029-independent; pure node:crypto). */
const HASH_LEN = 64;
/** Random salt length in bytes. */
const SALT_LEN = 16;
/** HMAC cookie-signing secret length in bytes. */
const SIGN_SECRET_LEN = 32;

/** A normalized credential row (datetimes coerced to ISO strings — F-013). */
export interface AppCredential {
	/** scrypt hash, lowercase hex. Server-side only. */
	passwordHash: string;
	/** Random salt, lowercase hex. Server-side only. */
	passwordSalt: string;
	/** HMAC cookie-signing secret, lowercase hex. Server-side only — NEVER sent to a client. */
	signSecret: string;
	/** ISO string or null (F-013 — never a raw SDK datetime). */
	createdAt: string | null;
	/** ISO string or null (F-013). */
	updatedAt: string | null;
}

/** Raw SDK row shape (datetimes are non-POJO Date-likes — must be coerced, F-013). */
interface AppAuthRaw {
	password_hash?: unknown;
	password_salt?: unknown;
	sign_secret?: unknown;
	created_at?: unknown;
	updated_at?: unknown;
}

/** Coerce a possibly-absent SDK datetime to an ISO string, else null (F-013). */
function isoOrNull(v: unknown): string | null {
	if (v == null) return null;
	if (v instanceof Date) return v.toISOString();
	const s = String(v);
	const d = new Date(s);
	return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Hash a plaintext password with scrypt + a random salt. Returns lowercase-hex
 * hash and salt. A caller-supplied salt (hex) is used for verification only.
 */
export function hashPassword(password: string, saltHex?: string): { hash: string; salt: string } {
	const salt = saltHex ? Buffer.from(saltHex, 'hex') : randomBytes(SALT_LEN);
	const hash = scryptSync(password, salt, HASH_LEN);
	return { hash: hash.toString('hex'), salt: salt.toString('hex') };
}

/**
 * Constant-time password check: recompute the scrypt hash over the stored salt and
 * compare with `timingSafeEqual`. A length mismatch (or any throw) is a non-match,
 * never surfaced — so a wrong password can't be narrowed by timing.
 */
export function verifyPassword(password: string, storedHashHex: string, storedSaltHex: string): boolean {
	if (!password || !storedHashHex || !storedSaltHex) return false;
	let computed: Buffer;
	try {
		computed = scryptSync(password, Buffer.from(storedSaltHex, 'hex'), HASH_LEN);
	} catch {
		return false;
	}
	let stored: Buffer;
	try {
		stored = Buffer.from(storedHashHex, 'hex');
	} catch {
		return false;
	}
	if (computed.length !== stored.length) return false;
	try {
		return timingSafeEqual(computed, stored);
	} catch {
		return false;
	}
}

/** Generate a fresh HMAC cookie-signing secret (lowercase hex). */
export function generateSignSecret(): string {
	return randomBytes(SIGN_SECRET_LEN).toString('hex');
}

/**
 * Read the single credential row, normalized (datetimes → ISO, F-013). Returns
 * null when no credential has been set yet (first-run state) — an honest absence
 * (F-008), never a fabricated row. A row missing the hash/salt/secret is treated
 * as absent (corrupt/half-written → no credential).
 */
export async function readCredential(db: Db): Promise<AppCredential | null> {
	const res = await db.query<[AppAuthRaw[]]>(`SELECT * FROM ${APP_AUTH_ID};`);
	const row = res?.[0]?.[0];
	if (!row) return null;
	const passwordHash = typeof row.password_hash === 'string' ? row.password_hash : '';
	const passwordSalt = typeof row.password_salt === 'string' ? row.password_salt : '';
	const signSecret = typeof row.sign_secret === 'string' ? row.sign_secret : '';
	if (!passwordHash || !passwordSalt || !signSecret) return null;
	return {
		passwordHash,
		passwordSalt,
		signSecret,
		createdAt: isoOrNull(row.created_at),
		updatedAt: isoOrNull(row.updated_at)
	};
}

/** True iff a usable credential exists. */
export async function credentialExists(db: Db): Promise<boolean> {
	return (await readCredential(db)) !== null;
}

/**
 * First-run: set the operator password. Hashes the password, mints a fresh HMAC
 * sign-secret, and writes the single row (UPSERT — creates it). The plaintext is
 * never persisted. Returns the (server-side) sign-secret so the caller can mint the
 * session cookie immediately. Idempotent at the row level (always the same id).
 */
export async function setCredential(db: Db, password: string): Promise<{ signSecret: string }> {
	const { hash, salt } = hashPassword(password);
	const signSecret = generateSignSecret();
	await db.query(
		`UPSERT ${APP_AUTH_ID} SET password_hash = $h, password_salt = $s, sign_secret = $sec, updated_at = time::now();`,
		{ h: hash, s: salt, sec: signSecret }
	);
	return { signSecret };
}

/**
 * Change the operator password (authed or loopback caller — enforced by the route).
 * Updates the hash + salt, KEEPS the existing sign-secret (so the current session
 * cookie stays valid — casual gating, no forced re-login). No-op if no credential
 * exists yet. The plaintext is never persisted.
 */
export async function changePassword(db: Db, password: string): Promise<void> {
	const { hash, salt } = hashPassword(password);
	await db.query(
		`UPDATE ${APP_AUTH_ID} SET password_hash = $h, password_salt = $s, updated_at = time::now();`,
		{ h: hash, s: salt }
	);
}

/**
 * TEST/operator helper — delete the credential row, returning to the first-run
 * (no-credential) state. Used by the live-verify cleanup so the operator sets the
 * REAL password fresh. No-op when absent.
 */
export async function deleteCredential(db: Db): Promise<void> {
	await db.query(`DELETE ${APP_AUTH_ID};`);
}
