// scripts/db-up.ts — boot the local SurrealDB control-plane datastore (TASK 6.1; D-006/D-007/D-025/D-026c).
//
// Run via `npm run db:up` (vite-node, so the real server modules resolve under
// Vite's resolver). Brings the datastore from a CLEAN state to a CONNECTED,
// MIGRATED state the dashboard can boot against:
//
//   1. Spawn the provisioned, checksum-verified SurrealDB 2.6.5 server binary on
//      LOOPBACK with the surrealkv backend (reuses SurrealServer — provision.ts).
//      D-025: the bind host is asserted loopback inside SurrealServer; we never
//      expose a routable listener.
//   2. Open a ROOT provisioning connection and run ALL schema migrations
//      idempotently (reuses runMigrations + schemaMigrations — migrate.ts/schema.ts).
//      DDL is root-only (D-026c); re-running is a no-op (the _migration ledger).
//   3. ASSERT the connected/migrated state programmatically (every migration id is
//      recorded) and print the connection facts the operator pastes into .env.
//
// Idempotent + safe to re-run: a second `db:up` reuses the same .data dir, the
// migration ledger skips already-applied migrations, and an already-listening
// server simply fails the spawn's health wait — so we detect a live server first
// and migrate against it instead of double-spawning.
//
// This script does NOT mint the per-boot control-plane token — that is minted by
// the SvelteKit server at boot (hooks.server.ts / D-025), surfaced to the operator
// there. db:up only owns the datastore lifecycle + schema.

import { Surreal } from 'surrealdb';
import { SurrealServer } from '../src/lib/server/db/provision.ts';
import { Db } from '../src/lib/server/db/client.ts';
import { runMigrations, isApplied } from '../src/lib/server/db/migrate.ts';
import { schemaMigrations } from '../src/lib/server/db/schema.ts';
import { isLoopbackHost } from '../src/lib/server/config/loopback.ts';
import {
	provisionRuntimeUser,
	DEFAULT_RUNTIME_USERNAME
} from '../src/lib/server/db/provision-user.ts';
import { runtimeHandoffLines } from '../src/lib/server/db/runtime-handoff.ts';

const WS = (process.env.SURREAL_WS || 'ws://127.0.0.1:8000').trim();
const NS = (process.env.SURREAL_NS || 'playground').trim();
const DB = (process.env.SURREAL_DB || 'v2').trim();
// Root provisioning credentials (DDL/migrations only — D-026c). The runtime
// least-priv user is NOT used here. Defaults match the dev server defaults.
const ROOT_USER = (process.env.SURREAL_ROOT_USER || process.env.SURREAL_USER || 'root').trim();
const ROOT_PASS = process.env.SURREAL_ROOT_PASS ?? process.env.SURREAL_PASS ?? 'root';
const DATA_DIR = (process.env.SURREAL_DATA_DIR || '.data').trim();
// Scoped least-priv runtime user (DBR-1 / D-026c). Name is configurable; password is
// taken from SURREAL_RUNTIME_PASS if set, else generated (crypto) and printed ONCE.
const RUNTIME_USER = (process.env.SURREAL_RUNTIME_USER || DEFAULT_RUNTIME_USERNAME).trim();
const RUNTIME_PASS = process.env.SURREAL_RUNTIME_PASS;

/** Parse `ws://host:port/...` → { host, port }. */
function wsParts(url: string): { host: string; port: number } {
	const u = new URL(url);
	return { host: u.hostname, port: Number(u.port || '8000') };
}

/**
 * True if a ws:// server already answers a signin at `url` (so we don't double-spawn).
 * The surrealdb SDK `connect()` HANGS indefinitely against a dead port rather than
 * rejecting, so we race it against a short timeout — a timeout means "nothing there".
 */
async function alreadyListening(url: string, timeoutMs = 1500): Promise<boolean> {
	const probe = new Surreal();
	const attempt = (async () => {
		await probe.connect(url);
		await probe.signin({ username: ROOT_USER, password: ROOT_PASS });
		return true;
	})();
	const timeout = new Promise<boolean>((r) => setTimeout(() => r(false), timeoutMs));
	try {
		return await Promise.race([attempt, timeout]);
	} catch {
		return false; // connect/signin rejected (e.g. wrong creds on a live server)
	} finally {
		await probe.close().catch(() => {});
	}
}

async function main(): Promise<void> {
	const { host, port } = wsParts(WS);
	// D-025 fail-closed: never boot a routable datastore listener.
	if (!isLoopbackHost(host)) {
		throw new Error(
			`SURREAL_WS host "${host}" is not loopback — refusing to boot a routable datastore (D-025).`
		);
	}

	const rpcUrl = `ws://${host}:${port}/rpc`;
	let server: SurrealServer | null = null;

	// 1. Spawn the server unless one is already listening (idempotent re-run).
	if (await alreadyListening(rpcUrl)) {
		console.log(`[db:up] SurrealDB already listening on ${host}:${port} — migrating against it.`);
	} else {
		server = new SurrealServer({
			dataDir: DATA_DIR,
			bind: `${host}:${port}`,
			username: ROOT_USER,
			password: ROOT_PASS
		});
		console.log(`[db:up] starting SurrealDB (surrealkv://${DATA_DIR}) on ${host}:${port} …`);
		await server.start();
		console.log(`[db:up] SurrealDB up (pid ${server.pid}).`);
	}

	// 2. Root provisioning connection → run ALL migrations idempotently.
	const root = await Db.connect({
		url: rpcUrl,
		username: ROOT_USER,
		password: ROOT_PASS,
		namespace: NS,
		database: DB
	});
	const applied = await runMigrations(root, schemaMigrations);
	if (applied.length) {
		console.log(`[db:up] applied ${applied.length} migration(s): ${applied.join(', ')}`);
	} else {
		console.log('[db:up] schema already current — no migrations to apply.');
	}

	// 3. ASSERT the connected + fully-migrated state programmatically.
	const missing: string[] = [];
	for (const m of schemaMigrations) {
		if (!(await isApplied(root, m.id))) missing.push(m.id);
	}
	if (missing.length) {
		await root.close();
		throw new Error(
			`[db:up] post-migration assertion FAILED — ${missing.length} migration(s) not recorded: ${missing.join(', ')}`
		);
	}

	// 4. Provision the scoped least-priv runtime user (DBR-1 / D-026c) — idempotent
	//    DEFINE USER IF NOT EXISTS on the CURRENT database, run as ROOT (user admin is
	//    root-only). NOT a schema migration: DB users are instance/db auth objects, and
	//    a migration would wedge every throwaway test DB. Password: SURREAL_RUNTIME_PASS
	//    if set, else generated + printed ONCE below (never logged elsewhere).
	const runtime = await provisionRuntimeUser(root, {
		username: RUNTIME_USER,
		password: RUNTIME_PASS
	});
	await root.close();

	console.log(
		`[db:up] CONNECTED — ${schemaMigrations.length}/${schemaMigrations.length} migrations applied on ${NS}/${DB}.`
	);
	// The operator handoff is built by db/runtime-handoff.ts (SF3-1) so it stays pinned to
	// the seam that actually reads the env (db/runtime-init.ts) — it drifted once already,
	// printing SURREAL_USER/SURREAL_PASS + a code edit the seam does not need, which left
	// a following operator silently disconnected. runtime-handoff.test.ts is the anti-drift
	// gate. Nothing is flipped automatically — the root user stays provisioning-only.
	for (const line of runtimeHandoffLines({
		ws: WS,
		namespace: NS,
		database: DB,
		username: runtime.username,
		role: runtime.role,
		alreadyExisted: runtime.alreadyExisted,
		generated: runtime.generated,
		password: runtime.password
	})) {
		console.log(line);
	}
	console.log(
		`[db:up]   Nothing is flipped automatically — root (${ROOT_USER}) stays provisioning/migration-only (D-026c).`
	);

	if (server) {
		// Keep the server in the FOREGROUND so `db:up` owns its lifecycle in dev (Ctrl-C
		// stops it). A second terminal runs `npm run dev`.
		console.log('[db:up] SurrealDB running in the foreground — Ctrl-C to stop. Run `npm run dev` in another terminal.');
		const stop = async () => {
			await server!.stop();
			process.exit(0);
		};
		process.on('SIGINT', stop);
		process.on('SIGTERM', stop);
		// Park forever.
		await new Promise<never>(() => {});
	}
}

main().catch((err) => {
	console.error(`[db:up] FAILED: ${(err as Error).message}`);
	process.exit(1);
});
