// server/db connection singleton + query helper (TASK 0.b, D-006).
//
// Connects to the managed SurrealDB server over ws://127.0.0.1 via the `surrealdb`
// JS SDK (no native addon). Signs in as the scoped LEAST-PRIVILEGE runtime user by
// default (D-026c) — the root user is reserved for provisioning/migrations only.
//
// The query helper is the single boundary where the D-016 guard lives: callers
// bind ALL values via $param bindings; ONLY validated table-names / record-ids
// may be interpolated, and only after passing validate.ts. `queryTable` /
// `relate` give safe, guarded interpolation for the two unavoidable cases
// (dynamic table-name selection + RELATE endpoints).

import { Surreal } from 'surrealdb';
import { assertTableName, assertRecordId } from './validate';

export interface DbConnectOptions {
	/** ws:// RPC URL of the running server (e.g. from SurrealServer.wsUrl). */
	url: string;
	/** Auth username. Default is the least-priv runtime user (D-026c). */
	username: string;
	/** Auth password. */
	password: string;
	/** Namespace to USE after signin. */
	namespace: string;
	/** Database to USE after signin. */
	database: string;
}

/** A bound parameter set — every VALUE flows through here, never interpolation. */
export type Bindings = Record<string, unknown>;

/**
 * A live, authenticated SurrealDB connection scoped to one ns/db. Wraps the SDK
 * `Surreal` handle and enforces the D-016 interpolation boundary. Construct via
 * {@link connect}; close via {@link close}.
 */
export class Db {
	private constructor(
		private readonly handle: Surreal,
		readonly namespace: string,
		readonly database: string
	) {}

	/**
	 * Open a connection, sign in (least-priv by default — D-026c), and USE ns/db.
	 * Throws if the server is unreachable or auth fails.
	 */
	static async connect(opts: DbConnectOptions): Promise<Db> {
		const handle = new Surreal();
		try {
			await handle.connect(opts.url);
			await handle.signin({ username: opts.username, password: opts.password });
			await handle.use({ namespace: opts.namespace, database: opts.database });
		} catch (err) {
			await handle.close().catch(() => {});
			throw err;
		}
		return new Db(handle, opts.namespace, opts.database);
	}

	/** The raw SDK handle. Use the guarded helpers below in preference. */
	get raw(): Surreal {
		return this.handle;
	}

	/**
	 * Run a query with $param bindings. SurrealQL is supplied by the CALLER as a
	 * literal/template that contains NO interpolated user values — every value is
	 * a `$name` resolved from {@link bindings}. Returns the raw SDK result array
	 * (one entry per statement).
	 */
	query<T = unknown>(surql: string, bindings: Bindings = {}): Promise<T> {
		return this.handle.query<T extends unknown[] ? T : [T]>(
			surql,
			bindings
		) as Promise<T>;
	}

	/**
	 * Guarded dynamic-table query (D-016): interpolates ONLY a validated table
	 * name, then delegates to {@link query} for value binding. `build` receives
	 * the validated name and returns the SurrealQL; all values still bind via
	 * `$param`.
	 */
	async queryTable<T = unknown>(
		table: string,
		build: (t: string) => string,
		bindings: Bindings = {}
	): Promise<T> {
		const t = assertTableName(table);
		return this.query<T>(build(t), bindings);
	}

	/**
	 * Guarded RELATE (D-016): both endpoint record-ids are validated before
	 * interpolation; the edge table name is validated; edge data binds as $data.
	 */
	async relate<T = unknown>(
		from: string,
		edge: string,
		to: string,
		data: Bindings = {}
	): Promise<T> {
		const f = assertRecordId(from);
		const e = assertTableName(edge);
		const t = assertRecordId(to);
		return this.query<T>(`RELATE ${f}->${e}->${t} CONTENT $data;`, { data });
	}

	/** Close the underlying connection. Idempotent / best-effort. */
	async close(): Promise<void> {
		await this.handle.close().catch(() => {});
	}
}

// ── Process-wide singleton ───────────────────────────────────────────────────
// The long-lived SvelteKit server holds ONE runtime connection (D-026c least-priv).
// Provisioning/migrations use their own root connection (see migrate.ts), never
// this singleton.

let singleton: Db | null = null;

/** Initialise the process-wide runtime connection. Throws if already initialised. */
export async function initDb(opts: DbConnectOptions): Promise<Db> {
	if (singleton) {
		throw new Error('Db singleton already initialised — call closeDb() first.');
	}
	singleton = await Db.connect(opts);
	return singleton;
}

/** Get the initialised runtime connection. Throws if {@link initDb} hasn't run. */
export function getDb(): Db {
	if (!singleton) {
		throw new Error('Db singleton not initialised — call initDb() at startup.');
	}
	return singleton;
}

/** Close + clear the process-wide connection. Idempotent. */
export async function closeDb(): Promise<void> {
	const db = singleton;
	singleton = null;
	if (db) await db.close();
}
