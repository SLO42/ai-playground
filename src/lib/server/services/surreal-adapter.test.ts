// SVC-3 (SERVICES-SPEC §3) — surreal-adapter.ts: the SurrealDB ServiceAdapter wrap.
//
// The crash + auto-restart DELEGATION (start/stop/health against a REAL surreal binary) is
// already integration-proven in manager.test.ts. This suite covers the WRAP surface that does
// NOT need a spawned process, so it is fast + hermetic:
//   • name is the fixed 'surrealdb' ServiceName,
//   • wsUrl reflects the FIXED bind (stable + reconnectable across restarts — the whole point of
//     pinning bind), and follows the default when unset,
//   • pid() is null before any start (nothing spawned yet),
//   • stop() before start is an idempotent no-op (never throws),
//   • the D-025 loopback guard is inherited — constructing with a ROUTABLE bind throws (a stop/
//     restart must never be able to point the managed datastore at a routable listener).

import { describe, it, expect } from 'vitest';
import { SurrealServiceAdapter } from './surreal-adapter';

const OPTS = { dataDir: 'C:/tmp/svc-adapter-unit', bind: '127.0.0.1:19321', username: 'root', password: 'root' };

describe('SurrealServiceAdapter — wrap surface (no spawn)', () => {
	it('exposes the fixed surrealdb ServiceName', () => {
		const a = new SurrealServiceAdapter(OPTS);
		expect(a.name).toBe('surrealdb');
	});

	it('wsUrl reflects the pinned bind (stable/reconnectable across restarts)', () => {
		const a = new SurrealServiceAdapter(OPTS);
		expect(a.wsUrl).toBe('ws://127.0.0.1:19321/rpc');
	});

	it('wsUrl follows the loopback default when bind is unset', () => {
		const a = new SurrealServiceAdapter({ dataDir: OPTS.dataDir });
		expect(a.wsUrl).toBe('ws://127.0.0.1:8000/rpc');
	});

	it('pid() is null before any start (nothing spawned)', () => {
		const a = new SurrealServiceAdapter(OPTS);
		expect(a.pid()).toBeNull();
	});

	it('stop() before start is an idempotent no-op (never throws)', async () => {
		const a = new SurrealServiceAdapter(OPTS);
		await expect(a.stop()).resolves.toBeUndefined();
		expect(a.pid()).toBeNull();
	});

	it('inherits the D-025 loopback guard — a routable bind is refused at construction', () => {
		expect(() => new SurrealServiceAdapter({ dataDir: OPTS.dataDir, bind: '10.0.0.5:8000' })).toThrow(
			/not loopback/
		);
	});
});
