import { describe, it, expect } from 'vitest';
import {
	isLoopbackHost,
	assertLoopback,
	mintBootToken,
	bootstrapControlPlane,
	decideClientLoopback,
	LoopbackBindError,
	type ListenerSpec
} from './loopback';

describe('isLoopbackHost — only loopback addresses are loopback', () => {
	it('accepts the canonical loopback hosts', () => {
		expect(isLoopbackHost('127.0.0.1')).toBe(true);
		expect(isLoopbackHost('localhost')).toBe(true);
		expect(isLoopbackHost('::1')).toBe(true);
		expect(isLoopbackHost('[::1]')).toBe(true);
		// any 127/8 address is loopback per IPv4 spec
		expect(isLoopbackHost('127.5.6.7')).toBe(true);
	});

	it('rejects routable + wildcard addresses', () => {
		expect(isLoopbackHost('0.0.0.0')).toBe(false); // wildcard = routable exposure
		expect(isLoopbackHost('::')).toBe(false); // IPv6 wildcard
		expect(isLoopbackHost('192.168.1.10')).toBe(false);
		expect(isLoopbackHost('10.0.0.5')).toBe(false);
		expect(isLoopbackHost('example.com')).toBe(false);
		expect(isLoopbackHost('')).toBe(false);
	});
});

describe('assertLoopback — fail-closed on a routable listener (D-025)', () => {
	it('returns silently for a loopback listener', () => {
		expect(() => assertLoopback({ name: 'sveltekit', host: '127.0.0.1', port: 5173 })).not.toThrow();
	});

	it('throws LoopbackBindError naming the offending listener', () => {
		let err: unknown;
		try {
			assertLoopback({ name: 'sveltekit', host: '0.0.0.0', port: 5173 });
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(LoopbackBindError);
		expect((err as LoopbackBindError).message).toContain('sveltekit');
		expect((err as LoopbackBindError).message).toContain('0.0.0.0');
	});
});

describe('mintBootToken — per-boot, unguessable', () => {
	it('produces a long hex token', () => {
		const t = mintBootToken();
		expect(t).toMatch(/^[0-9a-f]{64}$/);
	});

	it('is different every call (per-boot randomness)', () => {
		const seen = new Set(Array.from({ length: 50 }, () => mintBootToken()));
		expect(seen.size).toBe(50);
	});
});

describe('bootstrapControlPlane — D-025 startup gate', () => {
	const loopback: ListenerSpec[] = [
		{ name: 'sveltekit', host: '127.0.0.1', port: 5173 },
		{ name: 'surrealdb', host: '127.0.0.1', port: 8000 },
		{ name: 'ollama', host: 'localhost', port: 11434 }
	];

	it('mints a token and echoes the asserted listeners when all are loopback', () => {
		const cp = bootstrapControlPlane(loopback);
		expect(cp.token).toMatch(/^[0-9a-f]{64}$/);
		expect(cp.listeners).toHaveLength(3);
	});

	it('FAILS (throws) if ANY listener is bound to a routable address', () => {
		const bad: ListenerSpec[] = [
			...loopback,
			{ name: 'embeddings', host: '0.0.0.0', port: 8080 } // the routable one
		];
		expect(() => bootstrapControlPlane(bad)).toThrow(LoopbackBindError);
	});

	it('the error identifies the first routable listener', () => {
		const bad: ListenerSpec[] = [
			{ name: 'sveltekit', host: '127.0.0.1', port: 5173 },
			{ name: 'surrealdb', host: '192.168.0.42', port: 8000 }
		];
		expect(() => bootstrapControlPlane(bad)).toThrow(/surrealdb/);
	});

	it('refuses an empty listener set (nothing to assert == misconfiguration)', () => {
		expect(() => bootstrapControlPlane([])).toThrow();
	});

	it('never persists the token to the returned spec beyond the run (no secret echo in listeners)', () => {
		const cp = bootstrapControlPlane(loopback);
		const serialized = JSON.stringify(cp.listeners);
		expect(serialized).not.toContain(cp.token);
	});
});

describe('decideClientLoopback — SEC-1 fail-closed Host-header fallback', () => {
	// (c) Normal getClientAddress() path — authoritative + unspoofable, byte-identical to
	// the old `isLoopbackHost(normalizeAddr(addr))`: the real peer alone decides regardless
	// of the Host header or the server bind.
	describe('(c) real peer address is authoritative when present', () => {
		it('loopback peer → loopback (true), any bind, ignoring a spoofed Host', () => {
			for (const serverLoopbackBound of [true, false]) {
				expect(
					decideClientLoopback({ clientAddr: '127.0.0.1', hostHeader: 'evil.example.com', serverLoopbackBound })
				).toBe(true);
				expect(
					decideClientLoopback({ clientAddr: '::1', hostHeader: null, serverLoopbackBound })
				).toBe(true);
			}
		});

		it('LAN peer → NOT loopback (false), even when the Host header claims 127.0.0.1', () => {
			for (const serverLoopbackBound of [true, false]) {
				expect(
					decideClientLoopback({ clientAddr: '192.168.1.50', hostHeader: '127.0.0.1', serverLoopbackBound })
				).toBe(false);
			}
		});
	});

	// (a) Missing getClientAddress() + LAN-bound server → the spoofable Host fallback must
	// DENY (fail-closed) so a LAN attacker's `Host: 127.0.0.1` cannot grant login-free access.
	describe('(a) missing peer address + LAN-bound → deny (fail-closed)', () => {
		it('spoofed loopback Host on a LAN-bound server → NOT loopback (gate applies)', () => {
			expect(
				decideClientLoopback({ clientAddr: null, hostHeader: '127.0.0.1', serverLoopbackBound: false })
			).toBe(false);
			expect(
				decideClientLoopback({ clientAddr: undefined, hostHeader: 'localhost', serverLoopbackBound: false })
			).toBe(false);
			expect(
				decideClientLoopback({ clientAddr: '', hostHeader: '::1', serverLoopbackBound: false })
			).toBe(false);
		});

		it('a routable Host on a LAN-bound server with no peer address → also denied', () => {
			expect(
				decideClientLoopback({ clientAddr: null, hostHeader: '10.0.0.9', serverLoopbackBound: false })
			).toBe(false);
		});
	});

	// (b) Missing getClientAddress() + loopback-bound server → unchanged lenient Host
	// fallback (a LAN attacker cannot reach a loopback bind; dev ergonomics stay).
	describe('(b) missing peer address + loopback-bound → lenient Host fallback (unchanged)', () => {
		it('loopback Host on a loopback-bound server → loopback (true)', () => {
			expect(
				decideClientLoopback({ clientAddr: null, hostHeader: '127.0.0.1', serverLoopbackBound: true })
			).toBe(true);
			expect(
				decideClientLoopback({ clientAddr: null, hostHeader: 'localhost', serverLoopbackBound: true })
			).toBe(true);
		});

		it('non-loopback Host on a loopback-bound server → NOT loopback (false)', () => {
			expect(
				decideClientLoopback({ clientAddr: null, hostHeader: 'example.com', serverLoopbackBound: true })
			).toBe(false);
		});

		it('absent Host + no peer address → false (the old `if (!host) return false`)', () => {
			expect(
				decideClientLoopback({ clientAddr: null, hostHeader: null, serverLoopbackBound: true })
			).toBe(false);
			expect(
				decideClientLoopback({ clientAddr: null, hostHeader: undefined, serverLoopbackBound: true })
			).toBe(false);
		});
	});
});
