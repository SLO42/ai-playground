// server/auth — the pure login-gate decision + signed-cookie helpers.
//
// Split from hooks.server.ts so the decision logic is unit-testable with no DB and
// no SvelteKit request. The handle (hooks.server.ts) computes a few booleans from
// the live request and delegates the verdict to `decideGate` here.
//
// Cookie: an HMAC-signed opaque token. The payload is the issue time (ms); the cookie
// is `base64url(payload).hmacHex`. Verification recomputes the HMAC with the DB-stored
// secret and compares constant-time. The cookie is httpOnly + sameSite=lax + path=/.
// (Casual gating over plain HTTP — see credential.ts for the honest scope caveat.)

import { createHmac, timingSafeEqual } from 'node:crypto';
import { isLoopbackHost } from '../config/loopback';

/** The session cookie name. */
export const AUTH_COOKIE = 'atelier_auth';

/** Cookie max-age (30 days) — server enforces no expiry; the browser drops it. */
export const AUTH_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

/**
 * Session cookie options. httpOnly (no JS access) + sameSite=lax (sent on top-level
 * navigations, blocks cross-site POST CSRF) + path=/. `secure` is explicitly FALSE:
 * this gate runs over PLAIN HTTP on the LAN, and SvelteKit's `cookies.set` otherwise
 * DEFAULTS `Secure` to true for any non-localhost host — which makes the browser never
 * send the cookie over http, silently breaking LAN login (verified live). Setting it
 * false is the casual-gating tradeoff (the cookie travels in cleartext); it is NOT a
 * TLS substitute. Spread into `cookies.set(...)`.
 */
export const AUTH_COOKIE_OPTIONS = {
	httpOnly: true,
	sameSite: 'lax',
	path: '/',
	secure: false,
	maxAge: AUTH_COOKIE_MAX_AGE
} as const;

/**
 * Sanitize a post-login `?next=` target to an internal absolute path only — defeats
 * open-redirect (`//evil.com`, `https://…`, `/\evil`). Returns '/' for anything not a
 * single-leading-slash app path.
 */
export function safeNext(next: string | null | undefined): string {
	if (!next || typeof next !== 'string') return '/';
	if (!next.startsWith('/')) return '/';
	if (next.startsWith('//') || next.startsWith('/\\')) return '/';
	return next;
}

/** base64url-encode a utf8 string (no padding). */
function b64url(s: string): string {
	return Buffer.from(s, 'utf8').toString('base64url');
}

/** HMAC-SHA256 of `data` under `secret`, lowercase hex. */
function hmacHex(secret: string, data: string): string {
	return createHmac('sha256', secret).update(data).digest('hex');
}

/**
 * Mint a signed session token: `base64url(issuedAtMs).hmacHex`. The HMAC binds the
 * payload to the DB-stored secret, so the token can't be forged without it.
 */
export function signSessionToken(secret: string, issuedAtMs: number = Date.now()): string {
	const payload = b64url(String(issuedAtMs));
	return `${payload}.${hmacHex(secret, payload)}`;
}

/**
 * Verify a signed session token constant-time. Returns false for a malformed token,
 * a wrong/forged signature, or any error — never throws, never leaks why.
 */
export function verifySessionToken(token: string | undefined, secret: string): boolean {
	if (!token || !secret) return false;
	const dot = token.indexOf('.');
	if (dot <= 0 || dot === token.length - 1) return false;
	const payload = token.slice(0, dot);
	const mac = token.slice(dot + 1);
	const expected = hmacHex(secret, payload);
	const a = Buffer.from(mac);
	const b = Buffer.from(expected);
	if (a.length !== b.length) return false;
	try {
		return timingSafeEqual(a, b);
	} catch {
		return false;
	}
}

/** Strip an IPv4-mapped IPv6 prefix (`::ffff:127.0.0.1` → `127.0.0.1`). */
export function normalizeAddr(addr: string): string {
	const a = addr.trim().toLowerCase();
	if (a.startsWith('::ffff:')) return a.slice('::ffff:'.length);
	return a;
}

/**
 * Routes that BYPASS the login gate entirely (machine-to-machine callbacks with
 * their own D-025 token auth, plus the auth pages + the assets the gate must never
 * redirect). Loopback already bypasses; this keeps the control-plane callbacks open
 * for the (rare) non-loopback caller that carries its own token.
 *
 *   - /api/hooks/*              hook ingest          (routes/api/hooks/[event])
 *   - /api/gates/pretooluse     pre-tool-use gate
 *   - /api/memory/pull          memory pull
 *   - /api/peer/send            peer send
 *   - /api/sessions/{id}/control session control      (routes/api/sessions/[id]/control)
 *   - /login /setup /logout     the auth surface itself
 *   - /_app/* /fonts/* favicon  static assets (never redirect a non-document asset)
 */
export function isExemptPath(path: string): boolean {
	if (path === '/login' || path === '/setup' || path === '/logout') return true;
	if (path === '/favicon.svg' || path === '/favicon.ico') return true;
	if (path.startsWith('/_app/') || path.startsWith('/fonts/')) return true;
	if (path.startsWith('/api/hooks/')) return true;
	if (path === '/api/gates/pretooluse') return true;
	if (path === '/api/memory/pull') return true;
	if (path === '/api/peer/send') return true;
	if (/^\/api\/sessions\/[^/]+\/control$/.test(path)) return true;
	return false;
}

/** The gate verdict for one (external, non-exempt) request. */
export type GateDecision =
	| { action: 'pass' }
	| { action: 'redirect'; to: string }
	| { action: 'unauthorized' };

/** Inputs to the pure gate decision (all precomputed from the request). */
export interface GateInput {
	/** A usable credential exists in the DB. */
	hasCredential: boolean;
	/** The request carries a valid signed session cookie. */
	validCookie: boolean;
	/** A browser document navigation we can safely redirect (GET + Accepts text/html). */
	isBrowserGet: boolean;
	/** The request path (for the `?next=` round-trip). */
	path: string;
}

/**
 * The pure gate decision for an EXTERNAL, NON-EXEMPT request (loopback + exempt
 * paths are short-circuited by the handle before this is called):
 *
 *   - no credential set  → first-run: only /setup is reachable (exempt). A browser
 *     GET elsewhere is redirected to /setup; anything else (API / non-GET) → 401.
 *   - credential set + valid cookie → pass.
 *   - credential set + no/invalid cookie → a browser GET is redirected to
 *     /login?next=…; anything else (API / non-GET) → 401 (no redirect/buffering —
 *     so the SSE stream is never wrapped, F-010).
 */
export function decideGate(input: GateInput): GateDecision {
	if (!input.hasCredential) {
		if (input.isBrowserGet) return { action: 'redirect', to: '/setup' };
		return { action: 'unauthorized' };
	}
	if (input.validCookie) return { action: 'pass' };
	if (input.isBrowserGet) {
		return { action: 'redirect', to: `/login?next=${encodeURIComponent(input.path)}` };
	}
	return { action: 'unauthorized' };
}

/** True iff `accept` indicates a browser document navigation (wants HTML). */
export function acceptsHtml(accept: string | null): boolean {
	return !!accept && accept.includes('text/html');
}

/** Re-export for the handle so callers import loopback detection from one place. */
export { isLoopbackHost };
