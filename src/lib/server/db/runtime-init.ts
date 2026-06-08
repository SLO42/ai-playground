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
	| { ok: true; opts: { url: string; username: string; password: string; namespace: string; database: string } }
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
			namespace: env.SURREAL_NS?.trim() || 'playground',
			database: env.SURREAL_DB?.trim() || 'v2'
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

/** Get the runtime Db if connected, else null (honest — never throws). */
export function tryGetDb(): Db | null {
	try {
		return getDb();
	} catch {
		return null;
	}
}
