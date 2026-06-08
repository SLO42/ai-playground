import { describe, it, expect } from 'vitest';
import {
	isLoopbackHost,
	assertLoopback,
	mintBootToken,
	bootstrapControlPlane,
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
