// Scoped least-privilege runtime user provisioning (DBR-1 / D-026c / SEC-4).
//
// The DB floor runs DDL/migrations as ROOT, but until now runtime traffic ALSO ran
// as root — client.ts honored whatever user was configured and dev printed
// `SURREAL_USER=root` (db-up.ts). A SurrealQL-injection or buggy loop query therefore
// executed with FULL instance authority. This module closes that gap: it DEFINEs a
// scoped, least-privilege runtime user the operator can flip the runtime to.
//
// Why a DATABASE-level EDITOR (verified live against the pinned 2.6.5 binary):
//   SurrealDB 2.x has exactly THREE fixed system-user roles — VIEWER (read-only),
//   EDITOR (record read+write), OWNER (everything incl. user management + DDL). There
//   is NO finer, table-scoped grant, so "record CRUD yes / DDL no" is NOT expressible.
//   VIEWER cannot write (the runtime needs CRUD), OWNER is root-equivalent — so EDITOR
//   at DATABASE level is the least-privilege role that still permits the runtime's
//   CRUD. Its scope, VERIFIED against 2.6.5, is:
//     CAN  — SELECT/CREATE/UPDATE/DELETE on any table in THIS database; and (a
//            limitation of the coarse 3-role model) DEFINE/REMOVE TABLE/FIELD/INDEX
//            WITHIN this one database.
//     CANNOT — DEFINE USER at ANY level (no privilege escalation: it cannot mint a
//            backdoor OWNER, even in its own db); INFO FOR ROOT / INFO FOR NS (no
//            root/namespace admin); reach ANY other namespace or database (confined).
//   Security win vs root: root holds full instance authority (every ns/db, user
//   management, system ops). The scoped user is confined to one database and cannot
//   escalate — so injection/runaway under it cannot mint users or read/write beyond
//   the product database. The residual table-DDL reach is documented, not a defect:
//   the security-relevant boundaries (privilege escalation + cross-db blast radius)
//   hold, and 2.x offers no tighter role.
//
// This is NOT a schema migration — DB users are instance/database-level auth objects,
// not product schema, and a `DEFINE USER` in a migration would wedge every throwaway
// test DB (which never wants a scoped user). It is an idempotent provisioning STEP
// run by db-up after migrations, using the ROOT connection (D-026c: only root does
// user administration).

import { Db } from './client';

/** SurrealDB system-user identifier: start letter/underscore, then word chars. */
const USERNAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Default runtime username when `SURREAL_RUNTIME_USER` is unset. */
export const DEFAULT_RUNTIME_USERNAME = 'atelier_runtime';

/** Bytes of entropy for a generated password (→ 43-char base64url string). */
const GENERATED_PASSWORD_BYTES = 32;

/** Thrown when a username/password is unsafe to embed in the DEFINE USER statement. */
export class ProvisioningError extends Error {
	override readonly name = 'ProvisioningError';
}

export interface ProvisionRuntimeUserOptions {
	/** System-user name to define. Validated against {@link USERNAME_RE}. */
	username?: string;
	/**
	 * Password to set. If omitted, a cryptographically-random base64url password is
	 * GENERATED and returned (printed ONCE by db-up, never persisted or logged here).
	 * A provided password may NOT contain `'`, `\`, or a newline — `DEFINE USER …
	 * PASSWORD` takes a strand LITERAL and CANNOT be `$param`-bound (SurrealQL parser
	 * limitation, same constraint noted in client.test.ts), so those characters could
	 * break out of the literal. Generated passwords use a quote-free charset.
	 */
	password?: string;
}

export interface ProvisionedRuntimeUser {
	/** The defined user's name. */
	username: string;
	/**
	 * The user's password IFF this call CREATED the user (`alreadyExisted === false`);
	 * empty string when the user already existed (IF NOT EXISTS is a no-op, so neither a
	 * supplied nor a generated password takes effect — the pre-existing one is retained).
	 * Printed ONCE by db-up when non-empty + {@link generated}; never logged here.
	 */
	password: string;
	/** True when the password was crypto-generated (only meaningful when created). */
	generated: boolean;
	/**
	 * True when the user was ALREADY defined and this call was a no-op (IF NOT EXISTS).
	 * The caller must NOT present {@link password} as authoritative in this case — the
	 * existing credential is unchanged (verified 2.6.5: re-run does not reset it).
	 */
	alreadyExisted: boolean;
	/** Fixed for DBR-1: the least-priv role granted. */
	role: 'EDITOR';
	/** Fixed for DBR-1: the auth level the user is scoped to. */
	level: 'database';
}

/**
 * Generate a quote-free, crypto-random password. base64url yields only
 * `[A-Za-z0-9_-]`, so it is always safe inside a single-quoted SurrealQL literal.
 */
async function generatePassword(): Promise<string> {
	const { randomBytes } = await import('node:crypto');
	return randomBytes(GENERATED_PASSWORD_BYTES).toString('base64url');
}

/**
 * Idempotently DEFINE the scoped least-privilege runtime user on the CURRENT database
 * of the given ROOT connection (DBR-1). Uses `DEFINE USER IF NOT EXISTS` so re-running
 * is a no-op — VERIFIED against 2.6.5: a second run does NOT reset the password of an
 * existing user (the stored argon2id hash is unchanged), so the generated/env password
 * from the FIRST provisioning remains authoritative. Callers therefore must treat a
 * generated password as write-once: if the user already exists, a freshly-generated
 * password will NOT take effect and the operator must reuse the original (or set
 * `SURREAL_RUNTIME_PASS`). The single `DEFINE USER` statement is atomic, so there is no
 * half-applied state to recover — the interrupt-safety analog of a multi-statement
 * migration here is exactly the IF NOT EXISTS re-run.
 *
 * The password is NEVER logged or thrown from here (D-026); it is returned to the
 * caller (db-up) which prints it ONCE in the .env block. Runs as root only (D-026c).
 *
 * @throws {ProvisioningError} on an invalid username or an unsafe supplied password.
 */
export async function provisionRuntimeUser(
	root: Db,
	opts: ProvisionRuntimeUserOptions = {}
): Promise<ProvisionedRuntimeUser> {
	const username = (opts.username ?? DEFAULT_RUNTIME_USERNAME).trim();
	if (!USERNAME_RE.test(username)) {
		throw new ProvisioningError(
			`Invalid runtime username ${JSON.stringify(username)} — must match ${USERNAME_RE} ` +
				`(it is interpolated into a DEFINE USER statement and cannot be $param-bound).`
		);
	}

	// Validate a supplied password up-front (before any DB round-trip), even if the user
	// already exists — an unsafe value is a caller bug worth surfacing regardless.
	const supplied = opts.password;
	if (supplied !== undefined && supplied !== '' && /['\\\n\r]/.test(supplied)) {
		// Never echo the password in the error (D-026) — name the offending class only.
		throw new ProvisioningError(
			`Supplied runtime password contains a quote, backslash, or newline — ` +
				`DEFINE USER … PASSWORD takes a string LITERAL (no $param binding), so those ` +
				`characters are rejected. Use a password without ' \\ or newlines.`
		);
	}

	// Does the user already exist? INFO FOR DB lists DEFINEd users by name. This decides
	// only what we RETURN/print — the DEFINE below is idempotent either way. Advisory
	// (not atomic) which is fine for a single-operator provisioning step.
	const info = await root.query<[{ users?: Record<string, unknown> }]>('INFO FOR DB;');
	const alreadyExisted = Boolean(info[0]?.users && username in info[0].users);

	if (alreadyExisted) {
		// Idempotent no-op: the user stands as-is. We do NOT re-run DEFINE (IF NOT EXISTS
		// would ignore it anyway) and do NOT generate/claim a password — the existing
		// credential is retained (verified 2.6.5: a re-run never resets the password).
		return { username, password: '', generated: false, alreadyExisted: true, role: 'EDITOR', level: 'database' };
	}

	// Creating the user: resolve the password (supplied env value, else crypto-generated).
	const password = supplied !== undefined && supplied !== '' ? supplied : await generatePassword();
	const generated = !(supplied !== undefined && supplied !== '');

	// username + password are validated/quote-free above; ROLES is a fixed literal.
	await root.query(
		`DEFINE USER IF NOT EXISTS ${username} ON DATABASE PASSWORD '${password}' ROLES EDITOR;`
	);

	return { username, password, generated, alreadyExisted: false, role: 'EDITOR', level: 'database' };
}
