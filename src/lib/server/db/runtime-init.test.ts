import { describe, it, expect } from 'vitest';
import { resolveDbConnect, wsHost } from './runtime-init';

// TASK 1.5 VERIFY (resolver intent):
//   - env → connect opts when complete; honest reason when not (D-019 degrade)
//   - D-025 fail-closed: a routable SURREAL_WS host THROWS (never connects)

describe('wsHost', () => {
	it('extracts the loopback host from a ws url', () => {
		expect(wsHost('ws://127.0.0.1:8000/rpc')).toBe('127.0.0.1');
		expect(wsHost('ws://localhost:8000/rpc')).toBe('localhost');
	});
	it('returns empty on an unparseable url', () => {
		expect(wsHost('not a url')).toBe('');
	});
});

describe('resolveDbConnect', () => {
	const full = {
		SURREAL_WS: 'ws://127.0.0.1:8000/rpc',
		SURREAL_NS: 'playground',
		SURREAL_DB: 'v2',
		SURREAL_USER: 'runtime',
		SURREAL_PASS: 'pw'
	};

	it('resolves complete env to connect opts', () => {
		const r = resolveDbConnect(full);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.opts).toEqual({
				url: 'ws://127.0.0.1:8000/rpc',
				username: 'runtime',
				password: 'pw',
				namespace: 'playground',
				database: 'v2'
			});
		}
	});

	it('defaults ns/db when omitted', () => {
		const r = resolveDbConnect({ ...full, SURREAL_NS: undefined, SURREAL_DB: undefined });
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.opts.namespace).toBe('playground');
			expect(r.opts.database).toBe('v2');
		}
	});

	it('reports an honest reason when SURREAL_WS is missing (degrade, not throw)', () => {
		const r = resolveDbConnect({ ...full, SURREAL_WS: undefined });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toMatch(/SURREAL_WS/);
	});

	it('reports an honest reason when creds are missing', () => {
		const r = resolveDbConnect({ ...full, SURREAL_USER: '', SURREAL_PASS: '' });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toMatch(/USER|PASS/);
	});

	it('THROWS (fail-closed) on a routable, non-loopback SURREAL_WS host (D-025)', () => {
		expect(() => resolveDbConnect({ ...full, SURREAL_WS: 'ws://10.0.0.5:8000/rpc' })).toThrow(
			/loopback|D-025/i
		);
	});

	// SF2-1 (DBR-1 / D-026c): opt-in scoped least-priv runtime user at DATABASE auth level.
	describe('scoped runtime user (SURREAL_RUNTIME_USER/PASS)', () => {
		it('when BOTH runtime vars set → uses them + authLevel:database (not SURREAL_USER/PASS)', () => {
			const r = resolveDbConnect({
				...full,
				SURREAL_RUNTIME_USER: 'atelier_runtime',
				SURREAL_RUNTIME_PASS: 'scoped-pw'
			});
			expect(r.ok).toBe(true);
			if (r.ok) {
				expect(r.opts).toEqual({
					url: 'ws://127.0.0.1:8000/rpc',
					username: 'atelier_runtime',
					password: 'scoped-pw',
					namespace: 'playground',
					database: 'v2',
					authLevel: 'database'
				});
				// Precedence: the root creds are IGNORED when scoped creds are wired.
				expect(r.opts.username).not.toBe('runtime');
			}
		});

		it('when UNSET → byte-identical root path (no authLevel key)', () => {
			const r = resolveDbConnect(full);
			expect(r.ok).toBe(true);
			if (r.ok) {
				expect(r.opts.username).toBe('runtime');
				expect(r.opts.password).toBe('pw');
				expect('authLevel' in r.opts).toBe(false);
			}
		});

		it('empty-string runtime vars are treated as UNSET (byte-identical root fall-through)', () => {
			const r = resolveDbConnect({ ...full, SURREAL_RUNTIME_USER: '', SURREAL_RUNTIME_PASS: '' });
			expect(r.ok).toBe(true);
			if (r.ok) {
				expect(r.opts.username).toBe('runtime');
				expect('authLevel' in r.opts).toBe(false);
			}
		});

		it('PARTIAL config (only USER) → honest reason, never a silent root fall-through', () => {
			const r = resolveDbConnect({ ...full, SURREAL_RUNTIME_USER: 'atelier_runtime' });
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.reason).toMatch(/RUNTIME_USER.*RUNTIME_PASS|both be set/i);
		});

		it('PARTIAL config (only PASS) → honest reason, never a silent root fall-through', () => {
			const r = resolveDbConnect({ ...full, SURREAL_RUNTIME_PASS: 'scoped-pw' });
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.reason).toMatch(/RUNTIME_USER.*RUNTIME_PASS|both be set/i);
		});

		it('scoped path STILL enforces the D-025 loopback throw (host checked first)', () => {
			expect(() =>
				resolveDbConnect({
					...full,
					SURREAL_WS: 'ws://10.0.0.5:8000/rpc',
					SURREAL_RUNTIME_USER: 'atelier_runtime',
					SURREAL_RUNTIME_PASS: 'scoped-pw'
				})
			).toThrow(/loopback|D-025/i);
		});

		it('scoped path resolves ns/db defaults when omitted', () => {
			const r = resolveDbConnect({
				SURREAL_WS: 'ws://127.0.0.1:8000/rpc',
				SURREAL_RUNTIME_USER: 'atelier_runtime',
				SURREAL_RUNTIME_PASS: 'scoped-pw'
			});
			expect(r.ok).toBe(true);
			if (r.ok) {
				expect(r.opts.namespace).toBe('playground');
				expect(r.opts.database).toBe('v2');
				expect(r.opts.authLevel).toBe('database');
			}
		});
	});
});
