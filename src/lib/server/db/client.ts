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
	/**
	 * Auth LEVEL of {@link username} (DBR-1 / D-026c). SurrealDB 2.x scopes the signin
	 * payload by the user's definition level, and the two forms are MUTUALLY EXCLUSIVE
	 * (verified live against the pinned 2.6.5 binary):
	 *   • `'root'` (default) — a `DEFINE USER … ON ROOT` user signs in with `{username,
	 *     password}` ONLY. Passing ns/db in the payload FAILS auth. This is the historical
	 *     path; leaving `authLevel` unset is byte-identical to before DBR-1.
	 *   • `'database'` — a `DEFINE USER … ON DATABASE` user (the scoped least-priv runtime
	 *     user) MUST include `{namespace, database, username, password}` in the signin
	 *     payload; WITHOUT them it FAILS auth. Uses {@link namespace}/{@link database}.
	 * The F-042 re-signin path honors the same level, so a scoped-user session self-heals
	 * identically. Additive/opt-in (F-053): an unset value never changes an existing caller.
	 */
	authLevel?: 'root' | 'database';
	/**
	 * Hard wall-clock bound on connect+signin+use (TASK 13.5 finding 5 / F-014). The
	 * SurrealDB SDK can hang ~90s on a dead/black-holed socket, and connect() sits on
	 * the BOOT path — unbounded, that wedges the whole server start. Default 5000ms;
	 * on timeout connect() rejects honestly and the caller's degraded-boot path
	 * (runtime-init initDbFromEnv) serves disconnected states instead of hanging.
	 */
	connectTimeoutMs?: number;
}

/** Default bound on connect+signin+use (F-014: never sit on a dead socket ~90s). */
export const DEFAULT_CONNECT_TIMEOUT_MS = 5000;

/** A bound parameter set — every VALUE flows through here, never interpolation. */
export type Bindings = Record<string, unknown>;

/**
 * Auth-expiry fingerprint (F-042; narrowed by SF2-2). SurrealDB provisions root with a
 * default `DURATION FOR TOKEN 1h`; on a long-lived singleton the signin token expires and
 * the live session silently drops to UNAUTHENTICATED. An anonymous session querying a
 * `PERMISSIONS NONE` table then fails — and the SDK reports it as a runtime DB error:
 *   "There was a problem with the database: IAM error: Not enough permissions to perform this action"
 * (verified live vs 2.6.5 — the same wrapped shape for an expired ROOT token, a
 * DATABASE-level EDITOR token, and an `invalidate()`d session).
 *
 * The narrowing exists for the least-priv runtime credential (SF2-1 / DBR-1): once the
 * runtime signs in as a DATABASE-level EDITOR, a GENUINE authorization denial — the user
 * lacking a role capability (DEFINE USER, INFO FOR ROOT/NS, cross-db reach) — surfaces
 * WITHOUT the runtime wrapper, as a bare:
 *   "IAM error: Not enough permissions to perform this action"
 * (verified live vs 2.6.5). A bare authz denial is NOT an expiry — re-signing in cannot
 * grant a capability the role does not have, so it must NOT enter the F-042 re-auth/retry
 * (which under the live-subscription probe would churn as a re-signin loop). It surfaces
 * honestly (F-008, D-024 fail-closed).
 *
 * So we match ONLY: unambiguous token/session-expiry wording, OR the wrapped
 * "problem with the database … not enough permissions" (dropped-session) form — never a
 * BARE "not enough permissions" / "iam error" (which is an authorization denial). Distinct
 * from db/classify.ts which matches connection-LOSS (a dead socket), which re-auth cannot fix.
 */
const AUTH_EXPIRED_RE =
	/token (?:has )?expired|expired token|not authenticated|invalid token|there was a problem with the database:.*not enough permissions/i;

/**
 * Build the SurrealDB signin payload for a user's auth LEVEL (DBR-1). A ROOT user
 * signs in with `{username, password}` and REJECTS ns/db in the payload; a DATABASE
 * user REQUIRES `{namespace, database, username, password}` — the forms are mutually
 * exclusive (verified live, 2.6.5). Centralised so {@link Db.connect} and the F-042
 * {@link Db.reauthenticate} path build byte-identical payloads.
 */
function signinAuth(a: {
	authLevel: 'root' | 'database';
	username: string;
	password: string;
	namespace: string;
	database: string;
}):
	| { username: string; password: string }
	| { namespace: string; database: string; username: string; password: string } {
	return a.authLevel === 'database'
		? { namespace: a.namespace, database: a.database, username: a.username, password: a.password }
		: { username: a.username, password: a.password };
}

/**
 * True when a thrown error looks like an expired/dropped auth session (F-042) — as
 * opposed to a genuine authorization denial (SF2-2). Exported for the wording-contract
 * unit test that pins the live-verified expiry vs authz-denial strings.
 */
export function isAuthExpiredError(err: unknown): boolean {
	const message =
		err instanceof Error
			? err.message
			: typeof err === 'string'
				? err
				: String((err as { message?: unknown })?.message ?? err ?? '');
	return AUTH_EXPIRED_RE.test(message);
}

/**
 * A live, authenticated SurrealDB connection scoped to one ns/db. Wraps the SDK
 * `Surreal` handle and enforces the D-016 interpolation boundary. Construct via
 * {@link connect}; close via {@link close}.
 */
export class Db {
	/**
	 * Re-auth credentials retained IN-MEMORY for the self-heal path (F-042). Never
	 * logged / never thrown (D-026) — only fed back to `signin()`/`use()` on expiry.
	 */
	private readonly creds: { username: string; password: string };
	/** Auth level retained for the F-042 re-signin so the scoped user re-auths correctly. */
	private readonly authLevel: 'root' | 'database';
	/**
	 * Single in-flight re-auth promise (F-042 stampede guard). When N concurrent
	 * queries all hit expiry at once, they await ONE re-signin instead of firing N.
	 * Cleared once it settles so a later expiry can re-auth again.
	 */
	private reauth: Promise<void> | null = null;

	private constructor(
		private readonly handle: Surreal,
		readonly namespace: string,
		readonly database: string,
		creds: { username: string; password: string },
		authLevel: 'root' | 'database'
	) {
		this.creds = creds;
		this.authLevel = authLevel;
	}

	/**
	 * Open a connection, sign in (least-priv by default — D-026c), and USE ns/db.
	 * Throws if the server is unreachable or auth fails. The WHOLE sequence is raced
	 * against a hard timeout (default {@link DEFAULT_CONNECT_TIMEOUT_MS}) so a dead /
	 * black-holed socket can never wedge the boot path (F-014 — the SDK alone hangs
	 * ~90s); on timeout this rejects honestly and the degraded-boot path takes over.
	 */
	static async connect(opts: DbConnectOptions): Promise<Db> {
		const handle = new Surreal();
		const authLevel = opts.authLevel ?? 'root';
		const timeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() =>
					reject(
						new Error(`SurrealDB connect timed out after ${timeoutMs}ms (bounded boot — F-014): ${opts.url}`)
					),
				timeoutMs
			);
			timer.unref?.();
		});
		try {
			await Promise.race([
				(async () => {
					await handle.connect(opts.url);
					await handle.signin(
						signinAuth({
							authLevel,
							username: opts.username,
							password: opts.password,
							namespace: opts.namespace,
							database: opts.database
						})
					);
					await handle.use({ namespace: opts.namespace, database: opts.database });
				})(),
				deadline
			]);
		} catch (err) {
			// Fire-and-forget: close() on the same dead socket can itself hang (F-014) —
			// never await it on the failure path.
			void handle.close().catch(() => {});
			throw err;
		} finally {
			clearTimeout(timer);
		}
		return new Db(
			handle,
			opts.namespace,
			opts.database,
			{ username: opts.username, password: opts.password },
			authLevel
		);
	}

	/**
	 * Re-establish auth on the EXISTING handle after token expiry (F-042). De-duped:
	 * concurrent callers share one in-flight promise so we never stampede N signins.
	 * Re-runs signin + use (USE must be re-asserted — a fresh signin resets the
	 * selected ns/db). Throws on failure; the caller then propagates the ORIGINAL
	 * error (no masking, F-008). Creds are never logged (D-026).
	 */
	private async reauthenticate(): Promise<void> {
		if (this.reauth) return this.reauth;
		this.reauth = (async () => {
			await this.handle.signin(
				signinAuth({
					authLevel: this.authLevel,
					username: this.creds.username,
					password: this.creds.password,
					namespace: this.namespace,
					database: this.database
				})
			);
			await this.handle.use({ namespace: this.namespace, database: this.database });
		})();
		try {
			await this.reauth;
		} finally {
			this.reauth = null;
		}
	}

	/**
	 * Run a raw SDK query with the F-042 self-heal: if the call fails with the
	 * auth-expiry signature, transparently re-authenticate ONCE and retry. Bounded —
	 * AT MOST one retry per call (no loop); if the re-auth OR the retry also fails the
	 * ORIGINAL error propagates honestly (F-008, no masking). A non-auth error (parse,
	 * validation, connection-loss, a genuine permission gap that survives re-auth)
	 * propagates immediately with no retry.
	 */
	private async runQuery<R>(surql: string, bindings: Bindings): Promise<R> {
		try {
			return (await this.handle.query(surql, bindings)) as R;
		} catch (err) {
			if (!isAuthExpiredError(err)) throw err;
			// One transparent re-auth + retry. If anything here fails, surface the
			// ORIGINAL expiry error — never the retry's error, never a masked success.
			try {
				await this.reauthenticate();
				return (await this.handle.query(surql, bindings)) as R;
			} catch {
				throw err;
			}
		}
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
		return this.runQuery<T>(surql, bindings);
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

	/**
	 * Open a SurrealDB live query on a single table and return a consumable
	 * subscription (surrealdb 2.x). The table name is VALIDATED (D-016) before it
	 * is interpolated — `LIVE SELECT FROM` requires a literal table identifier and
	 * rejects `type::table($t)`, so binding is impossible here; validation is the
	 * guard. The returned object exposes `.subscribe(handler)` (handler receives
	 * `{ action, recordId, value }`) and `.kill()`.
	 *
	 * This is the LOW-LEVEL primitive. The events module's `watchTable` is the ONLY
	 * sanctioned caller (ARCHITECTURE §2.11: `db` owns all live queries).
	 */
	async liveTable(table: string): Promise<LiveTableSubscription> {
		const t = assertTableName(table);
		// LIVE SELECT returns the live-query UUID; liveOf() attaches a consumer to it.
		// Route the setup query through the F-042 self-heal so a stale-token session
		// re-auths before the subscription is established (rather than silently failing).
		const [uuid] = await this.runQuery<[unknown]>(`LIVE SELECT * FROM ${t};`, {});
		return this.handle.liveOf(uuid as Parameters<Surreal['liveOf']>[0]);
	}

	/**
	 * Liveness/auth probe for the live-subscription self-heal (F-042 established-sub
	 * gap). An ESTABLISHED LIVE subscription dies SILENTLY when the singleton's token
	 * lapses — the SDK gives the subscriber no error, the message stream just ends
	 * (db-source.ts). To re-establish honestly, the watcher needs to ask "is auth
	 * actually back?" — this runs a trivial server round-trip (`RETURN true`) through
	 * the SAME {@link runQuery} self-heal seam, so:
	 *   • a lapsed token transparently triggers ONE de-duped {@link reauthenticate}
	 *     (the existing in-flight promise — NOT a second copy) and the probe succeeds;
	 *   • a GENUINE auth failure (creds rotated away) or a connection loss throws the
	 *     honest error so the watcher surfaces 'disconnected' instead of re-subscribing
	 *     into a dead session (F-008). No new auth logic lives here — it is a thin
	 *     façade over the query path's heal. Resolves on healthy auth; throws otherwise.
	 */
	async probeAuth(): Promise<void> {
		await this.runQuery<unknown>('RETURN true;', {});
	}

	/** Close the underlying connection. Idempotent / best-effort. */
	async close(): Promise<void> {
		await this.handle.close().catch(() => {});
	}
}

/**
 * Minimal shape of the surrealdb 2.x live subscription we depend on. It is an
 * `AsyncIterable<LiveMessage>` (the SDK's LiveSubscription); the events layer drives
 * the ITERATOR directly so it can observe an unexpected COMPLETION as the F-042
 * silent-death signal (a `.subscribe()` handler is never told the stream ended).
 */
export interface LiveTableSubscription extends AsyncIterable<LiveMessage> {
	subscribe(handler: (msg: LiveMessage) => void): () => void;
	kill(): Promise<void>;
}

/** A live-query notification as surrealdb 2.x delivers it over WS. */
export interface LiveMessage {
	queryId: unknown;
	action: 'CREATE' | 'UPDATE' | 'DELETE' | 'KILLED';
	recordId: unknown;
	value: unknown;
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
