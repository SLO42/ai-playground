import { describe, it, expect } from 'vitest';
import {
	signSessionToken,
	verifySessionToken,
	decideGate,
	isExemptPath,
	normalizeAddr,
	safeNext,
	isLoopbackHost,
	AUTH_COOKIE_OPTIONS
} from './gate';

describe('signed session cookie (HMAC)', () => {
	const secret = 'a'.repeat(64);

	it('a freshly minted token verifies under its secret', () => {
		const token = signSessionToken(secret, 1_700_000_000_000);
		expect(verifySessionToken(token, secret)).toBe(true);
	});

	it('rejects a token signed with a different secret', () => {
		const token = signSessionToken(secret);
		expect(verifySessionToken(token, 'b'.repeat(64))).toBe(false);
	});

	it('rejects a tampered payload (re-signing required)', () => {
		const token = signSessionToken(secret, 1);
		const [, mac] = token.split('.');
		const forged = `${Buffer.from('999').toString('base64url')}.${mac}`;
		expect(verifySessionToken(forged, secret)).toBe(false);
	});

	it('rejects a tampered signature', () => {
		const token = signSessionToken(secret);
		const [payload] = token.split('.');
		expect(verifySessionToken(`${payload}.deadbeef`, secret)).toBe(false);
	});

	it('rejects malformed / empty tokens', () => {
		expect(verifySessionToken(undefined, secret)).toBe(false);
		expect(verifySessionToken('', secret)).toBe(false);
		expect(verifySessionToken('nodot', secret)).toBe(false);
		expect(verifySessionToken('.onlymac', secret)).toBe(false);
		expect(verifySessionToken('onlypayload.', secret)).toBe(false);
	});

	it('cookie options are httpOnly + sameSite=lax + path=/ + secure:false (plain HTTP LAN)', () => {
		expect(AUTH_COOKIE_OPTIONS.httpOnly).toBe(true);
		expect(AUTH_COOKIE_OPTIONS.sameSite).toBe('lax');
		expect(AUTH_COOKIE_OPTIONS.path).toBe('/');
		// Explicitly false: SvelteKit defaults Secure=true for non-localhost hosts, which
		// would break the cookie over plain HTTP on the LAN (the whole point of this gate).
		expect(AUTH_COOKIE_OPTIONS.secure).toBe(false);
	});
});

describe('decideGate — external, non-exempt requests only', () => {
	it('no credential + browser GET → redirect to /setup', () => {
		expect(decideGate({ hasCredential: false, validCookie: false, isBrowserGet: true, path: '/' })).toEqual({
			action: 'redirect',
			to: '/setup'
		});
	});

	it('no credential + API/non-GET → 401', () => {
		expect(
			decideGate({ hasCredential: false, validCookie: false, isBrowserGet: false, path: '/api/x' })
		).toEqual({ action: 'unauthorized' });
	});

	it('credential + valid cookie → pass', () => {
		expect(
			decideGate({ hasCredential: true, validCookie: true, isBrowserGet: true, path: '/projects' })
		).toEqual({ action: 'pass' });
	});

	it('credential + no cookie + browser GET → redirect to /login?next=', () => {
		expect(
			decideGate({ hasCredential: true, validCookie: false, isBrowserGet: true, path: '/projects/x' })
		).toEqual({ action: 'redirect', to: '/login?next=%2Fprojects%2Fx' });
	});

	it('credential + no cookie + API/non-GET → 401 (never redirect/buffer SSE)', () => {
		expect(
			decideGate({ hasCredential: true, validCookie: false, isBrowserGet: false, path: '/api/events' })
		).toEqual({ action: 'unauthorized' });
	});
});

describe('isExemptPath', () => {
	it('exempts the auth surface', () => {
		for (const p of ['/login', '/setup', '/logout']) expect(isExemptPath(p)).toBe(true);
	});
	it('exempts assets', () => {
		for (const p of ['/favicon.svg', '/favicon.ico', '/_app/immutable/x.js', '/fonts/lastik.woff2'])
			expect(isExemptPath(p)).toBe(true);
	});
	it('exempts the token-authenticated control-plane callbacks (they enforce authorizeHookRequest themselves)', () => {
		for (const p of [
			'/api/hooks/PreToolUse',
			'/api/gates/pretooluse',
			'/api/memory/pull',
			'/api/peer/send'
		])
			expect(isExemptPath(p)).toBe(true);
	});
	it('does NOT exempt the session-control endpoint — it checks no caller credential and stamps operator origin (D-035a), so it sits behind the login gate', () => {
		expect(isExemptPath('/api/sessions/abc123/control')).toBe(false);
		expect(isExemptPath('/api/sessions/s_0xdead/control')).toBe(false);
	});
	it('does NOT exempt ordinary pages or other API routes', () => {
		for (const p of ['/', '/projects', '/api/events', '/api/sessions/abc123', '/api/sessions'])
			expect(isExemptPath(p)).toBe(false);
	});
});

describe('session-control endpoint gating (was the isExemptPath hole: unauthenticated LAN callers reached the operator-origin-stamping handler)', () => {
	const controlPath = '/api/sessions/abc123/control';

	it('a non-loopback unauthenticated POST to the control path is 401 (API semantics — plain unauthorized, never an HTML redirect)', () => {
		// The handle computes isBrowserGet = GET && accepts text/html; control is a POST,
		// so a gated request always takes the unauthorized branch (401), not a redirect.
		expect(
			decideGate({ hasCredential: true, validCookie: false, isBrowserGet: false, path: controlPath })
		).toEqual({ action: 'unauthorized' });
		// First-run (no credential set) fails closed the same way.
		expect(
			decideGate({ hasCredential: false, validCookie: false, isBrowserGet: false, path: controlPath })
		).toEqual({ action: 'unauthorized' });
	});

	it('a logged-in remote browser (valid signed cookie) passes', () => {
		expect(
			decideGate({ hasCredential: true, validCookie: true, isBrowserGet: false, path: controlPath })
		).toEqual({ action: 'pass' });
	});

	// Loopback never reaches decideGate at all — the handle short-circuits loopback
	// requests before the gate (login-free local use, D-025); asserted structurally by
	// the isExemptPath + isLoopbackHost tests above.
});

describe('loopback detection helpers', () => {
	it('normalizeAddr strips the IPv4-mapped IPv6 prefix', () => {
		expect(normalizeAddr('::ffff:127.0.0.1')).toBe('127.0.0.1');
		expect(normalizeAddr('::1')).toBe('::1');
	});
	it('isLoopbackHost is loopback for 127.0.0.1 / ::1, not for a LAN IP', () => {
		expect(isLoopbackHost('127.0.0.1')).toBe(true);
		expect(isLoopbackHost('::1')).toBe(true);
		expect(isLoopbackHost(normalizeAddr('::ffff:127.0.0.1'))).toBe(true);
		expect(isLoopbackHost('192.168.4.85')).toBe(false);
		expect(isLoopbackHost('10.0.0.5')).toBe(false);
	});
});

describe('safeNext (open-redirect guard)', () => {
	it('keeps internal absolute paths', () => {
		expect(safeNext('/projects/x')).toBe('/projects/x');
	});
	it('rejects protocol-relative + absolute URLs + backslash tricks', () => {
		expect(safeNext('//evil.com')).toBe('/');
		expect(safeNext('https://evil.com')).toBe('/');
		expect(safeNext('/\\evil.com')).toBe('/');
		expect(safeNext('relative')).toBe('/');
		expect(safeNext(null)).toBe('/');
		expect(safeNext(undefined)).toBe('/');
	});
});
