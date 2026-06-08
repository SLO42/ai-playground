import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Surreal } from 'surrealdb';
import { BinaryIntegrityError } from './binary';
import { SurrealServer, SURREAL_BINARY_PATH } from './provision';

// TASK 0.b-pre VERIFY (exact intent):
//   - a tampered/mismatched binary aborts startup (SEC-009 fail-hard)
//   - a verified binary spawns and accepts a ws:// connection (loopback only)

const servers: SurrealServer[] = [];
const tmpDirs: string[] = [];

afterEach(async () => {
	for (const s of servers.splice(0)) await s.stop().catch(() => {});
	for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function dataDir(): string {
	const d = mkdtempSync(join(tmpdir(), 'surreal-data-'));
	tmpDirs.push(d);
	return d;
}

describe('SURREAL_BINARY_PATH', () => {
	it('points at the pinned 2.6.5 server binary that exists in bin/', () => {
		expect(SURREAL_BINARY_PATH).toMatch(/surreal-v2\.6\.5/);
		expect(existsSync(SURREAL_BINARY_PATH)).toBe(true);
	});
});

describe('SurrealServer — fail hard on a mismatched binary (SEC-009)', () => {
	it('aborts startup when the binary hash does not match the pin', async () => {
		// Point the server at the real binary but pin a WRONG expected hash —
		// stands in for a tampered/substituted artifact.
		const srv = new SurrealServer({
			binaryPath: SURREAL_BINARY_PATH,
			expectedHash: 'a'.repeat(64), // deliberately wrong
			dataDir: dataDir(),
			bind: '127.0.0.1:0'
		});
		servers.push(srv);
		await expect(srv.start()).rejects.toBeInstanceOf(BinaryIntegrityError);
		// Must NOT have spawned a process.
		expect(srv.pid).toBeNull();
		expect(srv.running).toBe(false);
	});

	it('aborts startup when the binary path does not exist', async () => {
		const srv = new SurrealServer({
			binaryPath: join(dataDir(), 'nope.exe'),
			dataDir: dataDir(),
			bind: '127.0.0.1:0'
		});
		servers.push(srv);
		await expect(srv.start()).rejects.toBeInstanceOf(BinaryIntegrityError);
		expect(srv.running).toBe(false);
	});
});

describe('SurrealServer — verified binary spawns + accepts ws:// (loopback)', () => {
	it('binds loopback only (never 0.0.0.0)', () => {
		const srv = new SurrealServer({ dataDir: dataDir(), bind: '127.0.0.1:0' });
		servers.push(srv);
		expect(srv.host).toBe('127.0.0.1');
		expect(srv.wsUrl).toMatch(/^ws:\/\/127\.0\.0\.1:/);
	});

	it('rejects a non-loopback bind address at construction (SEC startup assertion)', () => {
		expect(
			() => new SurrealServer({ dataDir: dataDir(), bind: '0.0.0.0:8000' })
		).toThrow(/loopback/i);
	});

	it(
		'spawns the verified binary and accepts a ws:// SDK connection',
		async () => {
			const srv = new SurrealServer({
				dataDir: dataDir(),
				bind: '127.0.0.1:18790',
				username: 'root',
				password: 'root'
			});
			servers.push(srv);

			await srv.start();
			expect(srv.running).toBe(true);
			expect(srv.pid).toBeTypeOf('number');

			// health() should report ready.
			await expect(srv.health()).resolves.toBe(true);

			// Independently prove a ws:// client can connect, auth, and query.
			const db = new Surreal();
			try {
				await db.connect(srv.wsUrl);
				await db.signin({ username: 'root', password: 'root' });
				await db.use({ namespace: 'provision_test', database: 'smoke' });
				const out = await db.query<[{ ok: number }[]]>('RETURN { ok: 1 };');
				expect(out[0]).toEqual({ ok: 1 });
			} finally {
				await db.close().catch(() => {});
			}

			await srv.stop();
			expect(srv.running).toBe(false);
			expect(srv.pid).toBeNull();
		},
		60_000
	);
});
