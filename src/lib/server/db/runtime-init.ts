// server/db — env-driven runtime connection bootstrap (TASK 1.5; D-019/D-025/D-026c).
//
// The long-lived SvelteKit server holds ONE least-priv runtime connection
// (db/client.ts singleton). This module reads the loopback connection params from
// the environment and opens that singleton ONCE at startup — but it degrades
// GRACEFULLY (D-019): if SurrealDB is not running / unreachable, the dashboard
// MUST still boot and render honest "disconnected" states, never crash. So a
// failed connect is reported, not thrown.
//
// D-025: the WS url MUST be loopback. We assert it before connecting — refusing a
// routable endpoint is fail-closed, the one case we DO reject rather than degrade.
// D-026c: signs in as the scoped least-priv runtime user (root is provisioning-only).

import { initDb, getDb, type Db } from './client';
import { isLoopbackHost } from '../config/loopback';

/** The env keys this reads (mirrors .env.example). */
export interface DbEnv {
	SURREAL_WS?: string;
	SURREAL_NS?: string;
	SURREAL_DB?: string;
	SURREAL_USER?: string;
	SURREAL_PASS?: string;
	/**
	 * Opt-in scoped least-privilege runtime creds (SF2-1 / DBR-1 / D-026c). The
	 * DATABASE-level user `provision-user.ts` mints (`atelier_runtime`, ROLES EDITOR)
	 * signs in DIFFERENTLY from root: SurrealDB 2.x requires a `DEFINE USER … ON
	 * DATABASE` user to include `{namespace, database}` in the signin payload
	 * (`authLevel:'database'`), which the historical root path does NOT send. When
	 * BOTH of these are set, {@link resolveDbConnect} uses them + `authLevel:'database'`
	 * so the operator who flips the runtime to the scoped user is not met with a failed
	 * signin → disconnected dashboard. When UNSET, the connect path is BYTE-IDENTICAL to
	 * the historical root path — no `authLevel`, `SURREAL_USER`/`SURREAL_PASS` unchanged
	 * (additive opt-in, D-024/F-053: an un-wired env never changes an existing caller).
	 */
	SURREAL_RUNTIME_USER?: string;
	SURREAL_RUNTIME_PASS?: string;
}

/** Outcome of a runtime-init attempt — honest, never throws on an unreachable DB. */
export interface DbInitResult {
	/** True once the runtime singleton is connected. */
	connected: boolean;
	/** Why we are not connected (config gap or unreachable), for honest UI/logs. */
	reason?: string;
}

/** Extract the host from a `ws://host:port/...` (or `wss://`) url. Empty on parse fail. */
export function wsHost(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return '';
	}
}

/**
 * Resolve the connection options from env, or a reason string if config is missing.
 * Pure + synchronous so it is unit-testable without a live server. Enforces the
 * D-025 loopback assertion on the parsed host (fail-closed on a routable endpoint).
 */
export function resolveDbConnect(env: DbEnv):
	| {
			ok: true;
			opts: {
				url: string;
				username: string;
				password: string;
				namespace: string;
				database: string;
				authLevel?: 'database';
			};
	  }
	| { ok: false; reason: string } {
	const url = env.SURREAL_WS?.trim();
	if (!url) return { ok: false, reason: 'SURREAL_WS not set' };

	const host = wsHost(url);
	if (!host) return { ok: false, reason: `SURREAL_WS is not a valid ws url (${url})` };
	// D-025 fail-closed: never connect the control plane to a routable endpoint.
	if (!isLoopbackHost(host)) {
		throw new Error(
			`SURREAL_WS host "${host}" is not loopback — refusing a routable DB endpoint (D-025).`
		);
	}

	const namespace = env.SURREAL_NS?.trim() || 'playground';
	const database = env.SURREAL_DB?.trim() || 'v2';

	// SF2-1 opt-in: scoped least-priv runtime user at DATABASE auth level (DBR-1/D-026c).
	// Engaged ONLY when the operator has explicitly wired BOTH runtime creds — an empty
	// string counts as unset. A PARTIAL config (one set, the other blank) is an honest
	// misconfiguration reason, NEVER a silent fall-through to root: falling back would
	// mask the operator's intent and connect with the WRONG (higher-privilege) identity.
	const runtimeUser = env.SURREAL_RUNTIME_USER?.trim();
	const runtimePass = env.SURREAL_RUNTIME_PASS;
	const runtimeUserSet = Boolean(runtimeUser);
	const runtimePassSet = runtimePass !== undefined && runtimePass !== '';
	if (runtimeUserSet || runtimePassSet) {
		if (!runtimeUserSet || !runtimePassSet) {
			return {
				ok: false,
				reason: 'SURREAL_RUNTIME_USER and SURREAL_RUNTIME_PASS must both be set for scoped runtime auth'
			};
		}
		// Non-null by the guards above; assert for the type-narrower.
		return {
			ok: true,
			opts: {
				url,
				username: runtimeUser as string,
				password: runtimePass as string,
				namespace,
				database,
				authLevel: 'database'
			}
		};
	}

	// Historical root path — UNCHANGED. No `authLevel` key: Db.connect defaults to 'root',
	// so this branch is byte-identical to the pre-SF2-1 behavior (F-053 additive opt-in).
	const username = env.SURREAL_USER?.trim();
	const password = env.SURREAL_PASS;
	if (!username || password === undefined || password === '') {
		return { ok: false, reason: 'SURREAL_USER / SURREAL_PASS not set' };
	}

	return {
		ok: true,
		opts: {
			url,
			username,
			password,
			namespace,
			database
		}
	};
}

/**
 * Open the process-wide runtime DB connection from env, ONCE. Idempotent: if the
 * singleton is already up this is a no-op success. NEVER throws on an unreachable
 * server (D-019) — it returns `{ connected:false, reason }` so the dashboard boots
 * and renders honest disconnected states. The ONLY throw is the D-025 loopback gate.
 */
export async function initDbFromEnv(env: DbEnv = process.env): Promise<DbInitResult> {
	// Already connected? (initDb throws if so — treat as success.)
	try {
		getDb();
		return { connected: true };
	} catch {
		/* not yet initialised — continue */
	}

	const resolved = resolveDbConnect(env); // may throw on a routable host (D-025) — intended.
	if (!resolved.ok) return { connected: false, reason: resolved.reason };

	try {
		await initDb(resolved.opts);
		return { connected: true };
	} catch (err) {
		// Unreachable / auth failure → degrade, don't crash the boot (D-019).
		return { connected: false, reason: `cannot reach SurrealDB: ${(err as Error).message}` };
	}
}

/**
 * Get the runtime Db if the singleton was initialised, else null (honest — never throws).
 *
 * NOTE (TASK 6.11): a non-null handle does NOT prove LIVENESS. The SDK keeps handing
 * back the singleton after the SurrealDB process is killed / the socket drops, so a
 * subsequent query throws a connection-loss error rather than a real query failure.
 * Callers MUST classify that thrown error via `db/classify.ts` (`classifyDbError`) to
 * render an honest DISCONNECTED state — every distinguishing surface now does.
 *
 * A synchronous cheap-liveness signal here is non-trivial (the SDK exposes only an
 * async/ping-style status, and this is a sync getter), and a fresh boot recovers the
 * connection — so we keep classification at the call site rather than bolt on
 * auto-reconnect. TODO(6.11+): if reconnect becomes a requirement, expose an async
 * `tryGetLiveDb()` that pings + re-`initDbFromEnv()` on a dead handle.
 */
export function tryGetDb(): Db | null {
	try {
		return getDb();
	} catch {
		return null;
	}
}
