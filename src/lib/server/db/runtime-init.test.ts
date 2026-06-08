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
});
