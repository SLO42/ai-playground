import { describe, it, expect } from 'vitest';
import {
	isLoopbackHost,
	assertLoopback,
	mintBootToken,
	bootstrapControlPlane,
	decideClientLoopback,
	hostnameFromHostHeader,
	serverBindHost,
	isServerLoopbackBound,
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

	// SF2-3(a) — adapter-node returns a SPOOFABLE header value from getClientAddress() when
	// ADDRESS_HEADER is configured. A spoofed `127.0.0.1` there must not bypass loopback
	// determination on a LAN bind.
	describe('SF2-3(a) spoofable client address (ADDRESS_HEADER set) fails closed on a LAN bind', () => {
		it('spoofed loopback client address on a LAN-bound server → NOT loopback (gate applies)', () => {
			expect(
				decideClientLoopback({
					clientAddr: '127.0.0.1',
					hostHeader: 'evil.example.com',
					serverLoopbackBound: false,
					clientAddrSpoofable: true
				})
			).toBe(false);
			expect(
				decideClientLoopback({
					clientAddr: '::1',
					hostHeader: null,
					serverLoopbackBound: false,
					clientAddrSpoofable: true
				})
			).toBe(false);
		});

		it('spoofable loopback client address on a LOOPBACK-bound server → lenient (true)', () => {
			// A remote client cannot reach a loopback bind, so trusting the header stays safe.
			expect(
				decideClientLoopback({
					clientAddr: '127.0.0.1',
					hostHeader: null,
					serverLoopbackBound: true,
					clientAddrSpoofable: true
				})
			).toBe(true);
		});

		it('spoofable NON-loopback client address is not loopback on any bind', () => {
			expect(
				decideClientLoopback({
					clientAddr: '10.0.0.9',
					hostHeader: '127.0.0.1',
					serverLoopbackBound: true,
					clientAddrSpoofable: true
				})
			).toBe(false);
		});

		it('an UNSPOOFABLE (real socket peer) loopback address is authoritative on a LAN bind', () => {
			// ADDRESS_HEADER unset (default / clientAddrSpoofable:false) → byte-identical to prior behavior.
			expect(
				decideClientLoopback({
					clientAddr: '127.0.0.1',
					hostHeader: 'evil.example.com',
					serverLoopbackBound: false,
					clientAddrSpoofable: false
				})
			).toBe(true);
		});
	});
});

// SF2-3(b) — the runtime loopback determination and the D-025 boot gate must share ONE
// bind-host source so they cannot drift; unset HOST defaults to loopback in both.
describe('serverBindHost / isServerLoopbackBound — one determination, no drift (SF2-3(b))', () => {
	it('unset / blank HOST defaults to the loopback 127.0.0.1 bind', () => {
		expect(serverBindHost(undefined)).toBe('127.0.0.1');
		expect(serverBindHost(null)).toBe('127.0.0.1');
		expect(serverBindHost('')).toBe('127.0.0.1');
		expect(serverBindHost('   ')).toBe('127.0.0.1');
		for (const h of [undefined, null, '', '  ']) {
			expect(isServerLoopbackBound(h)).toBe(true);
		}
	});

	it('trims and honors an explicit HOST', () => {
		expect(serverBindHost('  127.0.0.1  ')).toBe('127.0.0.1');
		expect(serverBindHost('0.0.0.0')).toBe('0.0.0.0');
		expect(serverBindHost('192.168.1.10')).toBe('192.168.1.10');
	});

	it('a LAN / wildcard HOST is NOT loopback-bound (fail-closed regime engages)', () => {
		expect(isServerLoopbackBound('0.0.0.0')).toBe(false);
		expect(isServerLoopbackBound('::')).toBe(false);
		expect(isServerLoopbackBound('192.168.1.10')).toBe(false);
	});

	it('a loopback HOST is loopback-bound', () => {
		expect(isServerLoopbackBound('127.0.0.1')).toBe(true);
		expect(isServerLoopbackBound('localhost')).toBe(true);
		expect(isServerLoopbackBound('::1')).toBe(true);
	});

	it('the boot-gate default and the runtime default agree (no drift)', () => {
		// The D-025 boot gate builds its sveltekit listener host from serverBindHost(env.HOST);
		// the login gate calls isServerLoopbackBound(env.HOST). For every HOST value both agree.
		for (const host of [undefined, '', '127.0.0.1', 'localhost', '::1', '0.0.0.0', '192.168.1.5']) {
			expect(isServerLoopbackBound(host)).toBe(isLoopbackHost(serverBindHost(host)));
		}
	});
});

// SF2-3(c) — a bracketed IPv6 Host value must normalize to the loopback literal, not `[`.
describe('hostnameFromHostHeader — bracketed IPv6 normalizes correctly (SF2-3(c))', () => {
	it('strips brackets and port from an IPv6 loopback Host', () => {
		expect(hostnameFromHostHeader('[::1]:5173')).toBe('::1');
		expect(hostnameFromHostHeader('[::1]')).toBe('::1');
		// and the normalized value is recognized as loopback (the whole point)
		expect(isLoopbackHost(hostnameFromHostHeader('[::1]:5173') as string)).toBe(true);
	});

	it('handles a bracketed non-loopback IPv6', () => {
		expect(hostnameFromHostHeader('[2001:db8::1]:8080')).toBe('2001:db8::1');
		expect(isLoopbackHost(hostnameFromHostHeader('[2001:db8::1]:8080') as string)).toBe(false);
	});

	it('strips the port from a host:port / ipv4:port value', () => {
		expect(hostnameFromHostHeader('127.0.0.1:5173')).toBe('127.0.0.1');
		expect(hostnameFromHostHeader('localhost:5173')).toBe('localhost');
		expect(hostnameFromHostHeader('example.com:443')).toBe('example.com');
	});

	it('returns a bare hostname / IPv4 unchanged', () => {
		expect(hostnameFromHostHeader('localhost')).toBe('localhost');
		expect(hostnameFromHostHeader('127.0.0.1')).toBe('127.0.0.1');
	});

	it('treats an unbracketed multi-colon value as an IPv6 literal (no port split)', () => {
		expect(hostnameFromHostHeader('::1')).toBe('::1');
		expect(isLoopbackHost(hostnameFromHostHeader('::1') as string)).toBe(true);
	});

	it('returns null for an absent / blank value', () => {
		expect(hostnameFromHostHeader(null)).toBe(null);
		expect(hostnameFromHostHeader(undefined)).toBe(null);
		expect(hostnameFromHostHeader('')).toBe(null);
		expect(hostnameFromHostHeader('   ')).toBe(null);
	});
});
