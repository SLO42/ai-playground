// server/hooks — server-side hook ingest (TASK 1.9; D-019/D-024/D-025/D-026).
//
// The control-plane endpoint that the hook-proxy POSTs to. Two responsibilities:
//
//   1. AUTHORIZE the request (D-025): require the per-boot token AND a loopback
//      Origin/Host (defeats forged hook responses + browser DNS-rebind/CSRF). Fails
//      CLOSED — if no server token is configured, or the token/Origin is wrong, the
//      request is rejected. (This is auth, not a safety gate: a rejected hook simply
//      isn't recorded; it never alters a tool decision.)
//
//   2. INGEST the payload as ANALYTICS ONLY (D-024): normalize it into an
//      `agent_event` row and write it best-effort. CRITICAL — the response NEVER
//      carries a permission/gate decision. Whatever happens (DB down, bad payload,
//      unknown event) the response is the empty/continue object `{}`, so the session
//      proceeds. No safety decision rides this best-effort path.

import { timingSafeEqual } from 'node:crypto';
import { isLoopbackHost } from '../config/loopback';
import { normalizeHookEvent, isHookEvent, type HookEvent, type HookAgentEvent } from './proxy-config';

/** Env the ingest endpoint reads — the per-boot D-025 token (set at server boot). */
export interface HookIngestEnv {
	HOOK_TOKEN?: string;
}

/** Result of the D-025 authorization check. */
export interface AuthResult {
	ok: boolean;
	/** Why it was rejected (for logs only — never leaked to an unauthenticated caller). */
	reason?: string;
}

/** Extract the host (sans port) from a `Host`/`Origin` header value. */
function bareHost(hostHeader: string): string {
	const v = hostHeader.trim();
	// Origin is a full url; Host is `host:port`. Try url-parse first, fall back to split.
	try {
		return new URL(v).hostname;
	} catch {
		return v.split(':')[0];
	}
}

/**
 * Constant-time token check (TASK 13.5 finding 4 — the docstring claimed constant-ish but
 * the compare was a plain `!==`). Length-guarded `crypto.timingSafeEqual`, matching the
 * channel.ts tokenMatches pattern exactly: a length mismatch is an immediate non-match
 * (timingSafeEqual throws on unequal lengths) and any throw is treated as a non-match,
 * never surfaced to the caller.
 */
function tokenMatches(presented: string | undefined, serverToken: string): boolean {
	if (!presented) return false;
	const a = Buffer.from(presented);
	const b = Buffer.from(serverToken);
	if (a.length !== b.length) return false;
	try {
		return timingSafeEqual(a, b);
	} catch {
		return false;
	}
}

/**
 * D-025 control-plane auth: the request MUST bear the per-boot token AND originate
 * from loopback. Fails CLOSED when no server token is configured (we cannot
 * authenticate → deny). The token compare is constant-time (length-guarded
 * crypto.timingSafeEqual — same as channel.ts), so a forged token can never be
 * narrowed byte-by-byte via timing.
 */
export function authorizeHookRequest(headers: Headers, env: HookIngestEnv): AuthResult {
	const serverToken = env.HOOK_TOKEN?.trim();
	if (!serverToken) return { ok: false, reason: 'no server token configured (fail-closed)' };

	const presented = headers.get('x-hook-token')?.trim();
	if (!tokenMatches(presented, serverToken)) return { ok: false, reason: 'bad or missing token' };

	// Host must be loopback (defeats DNS-rebind: a rebind hits a non-loopback Host).
	const host = headers.get('host');
	if (!host || !isLoopbackHost(bareHost(host))) return { ok: false, reason: 'non-loopback Host' };

	// If an Origin is present (browser-driven CSRF), it too must be loopback.
	const origin = headers.get('origin');
	if (origin && !isLoopbackHost(bareHost(origin))) return { ok: false, reason: 'cross-origin' };

	return { ok: true };
}

/** Persistence seam — writes one analytics row. Injected so ingest is testable/no-DB. */
export interface HookIngestDeps {
	/** Write a row to a table. MAY throw (DB down) — ingest swallows it (D-019). */
	write: (table: string, row: HookAgentEvent) => Promise<void>;
}

/**
 * Ingest one hook event as analytics. Normalizes → writes best-effort → ALWAYS
 * returns the empty/continue response `{}`. Never throws; a DB failure is swallowed
 * (the session must proceed, D-019). A non-wired/safety event is dropped without a
 * write (D-024) — no safety decision is ever made here.
 */
export async function ingestHookEvent(
	event: string,
	payload: unknown,
	deps: HookIngestDeps
): Promise<Record<string, never>> {
	if (!isHookEvent(event)) return {}; // unknown/safety event → ignore, continue
	const row = normalizeHookEvent(event as HookEvent, payload);
	if (!row) return {};
	try {
		await deps.write('agent_event', row);
	} catch {
		// DB down / write error → analytics is best-effort; the session is unaffected.
	}
	return {};
}
