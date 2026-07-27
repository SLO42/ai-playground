// Shared throwaway-server harness for db integration tests (TASK 0.b).
// Spawns the provisioned SurrealDB binary on an OS-assigned loopback port, and
// hands tests a fresh, per-run namespace that is DROPPED on teardown so no state
// leaks between runs (IMPLEMENTATION-PLAN §7: DB tests on a throwaway namespace).
//
// NOTE: this lives outside *.test.ts so vitest does not treat it as a suite.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Surreal } from 'surrealdb';
import { SurrealServer } from './provision';
import { retryOnConflict } from './retry';

export interface TestDb {
	server: SurrealServer;
	wsUrl: string;
	/** Unique per-run namespace, dropped on teardown. */
	namespace: string;
	database: string;
	/** Root provisioning user (DDL/migrations — D-026c). */
	root: { username: string; password: string };
	teardown: () => Promise<void>;
}

let counter = 0;

/**
 * Start a throwaway SurrealDB server with a fresh namespace. The caller must call
 * `teardown()` (drops the namespace, stops the server, removes the data dir).
 */
export async function startTestDb(): Promise<TestDb> {
	const dir = mkdtempSync(join(tmpdir(), 'db-test-'));
	const server = new SurrealServer({
		dataDir: dir,
		bind: '127.0.0.1:0', // OS-assigned free loopback port — no collisions across parallel files
		username: 'root',
		password: 'root'
	});
	await server.start();

	const namespace = `test_ns_${process.pid}_${Date.now()}_${counter++}`;
	const database = 'main';

	const teardown = async () => {
		// Drop the namespace so nothing leaks, then stop + clean up.
		const db = new Surreal();
		try {
			await db.connect(server.wsUrl);
			await db.signin({ username: 'root', password: 'root' });
			await db.query('REMOVE NAMESPACE IF EXISTS type::namespace($ns);', { ns: namespace });
		} catch {
			/* best effort */
		} finally {
			await db.close().catch(() => {});
		}
		await server.stop().catch(() => {});
		rmSync(dir, { recursive: true, force: true });
	};

	return {
		server,
		wsUrl: server.wsUrl,
		namespace,
		database,
		root: { username: 'root', password: 'root' },
		teardown
	};
}

/**
 * DELETE every row of `table`, absorbing the retryable commit conflict (see `./retry`).
 *
 * A bare `DELETE <table>` in a suite's setup is the ROTATING-RED class: it races writers a
 * previous case left in flight and, when it loses, kills the whole FILE — a different file
 * each run, with a fault the DB explicitly says to retry. A DELETE is idempotent, so the
 * retry is safe by construction.
 *
 * `table` is an identifier, not a value, so it cannot be a `$param` (D-016); it is validated
 * against the SurrealDB identifier grammar before it is ever interpolated.
 */
export async function clearTable(
	db: { query: (sql: string) => Promise<unknown> },
	table: string,
	attempts = 5
): Promise<void> {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
		throw new Error(`clearTable: refusing to interpolate unsafe table identifier "${table}"`);
	}
	await retryOnConflict(() => db.query(`DELETE ${table};`), attempts);
}

/** A 1024-dim fixture vector (deterministic, normalized) for HNSW/KNN tests. */
export function fixtureVector(seed: number, dim = 1024): number[] {
	const v = new Array<number>(dim);
	let x = (seed * 2654435761) >>> 0;
	let norm = 0;
	for (let i = 0; i < dim; i++) {
		// xorshift32 → [-1, 1)
		x ^= x << 13;
		x >>>= 0;
		x ^= x >> 17;
		x ^= x << 5;
		x >>>= 0;
		const f = (x / 0xffffffff) * 2 - 1;
		v[i] = f;
		norm += f * f;
	}
	norm = Math.sqrt(norm) || 1;
	for (let i = 0; i < dim; i++) v[i] /= norm;
	return v;
}
