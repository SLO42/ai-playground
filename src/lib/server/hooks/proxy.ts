// server/hooks — the hook-proxy transport core (TASK 1.9; D-019/D-025).
//
// This is the logic the standalone hook-proxy script (scripts/hook-proxy.mjs) runs,
// extracted here so it is unit-testable without spawning a process. It performs the
// single job of the D-019 bridge: POST the hook payload to the long-lived SvelteKit
// server over LOOPBACK, carrying the D-025 per-boot token, with a SHORT timeout —
// and NO-OP on ANY failure (server down/slow/error/misconfig) by returning {}.
//
// GRACEFUL DEGRADATION INVARIANT (D-019): postHook NEVER throws and NEVER blocks past
// the timeout. Its return value is always a plain object; the proxy prints it and
// exits 0, so the Claude Code session proceeds untouched even when our server is
// down (the exact behavior we watched KongCode exhibit this session).

import { isLoopbackHost } from '../config/loopback';
import { hookTimeoutMs, type HookEvent } from './proxy-config';

/** Env the proxy reads — injected into the spawned session by the runtime (D-025). */
export interface HookProxyEnv {
	/** Loopback base url of the control plane, e.g. http://127.0.0.1:5173. */
	HOOK_URL?: string;
	/** The per-boot D-025 token authorizing this hook POST. */
	HOOK_TOKEN?: string;
}

export interface PostHookOptions {
	/** Override the per-hook timeout (tests). Defaults to hookTimeoutMs(event). */
	timeoutMs?: number;
}

/** The continue/empty hook response — Claude Code reads this as "proceed, no change". */
const CONTINUE: Record<string, never> = {};

/** Extract the hostname from a url, or '' on parse failure. */
function hostOf(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return '';
	}
}

/**
 * POST a hook payload to the control plane and return the server's response, or the
 * empty/continue response `{}` on ANY failure. Best-effort by contract (D-019):
 *
 *   - missing HOOK_URL/HOOK_TOKEN        → {} (nothing to talk to)
 *   - non-loopback HOOK_URL              → {} (D-025: never leave the loopback boundary)
 *   - connection refused (server down)   → {}
 *   - timeout (server slow)              → {} (aborted at the per-hook budget)
 *   - non-2xx (server error)             → {}
 *   - malformed JSON response            → {}
 *
 * It NEVER throws. The caller (proxy script) prints the result and exits 0.
 */
export async function postHook(
	event: HookEvent,
	payload: unknown,
	env: HookProxyEnv,
	opts: PostHookOptions = {}
): Promise<Record<string, unknown>> {
	const base = env.HOOK_URL?.trim();
	const token = env.HOOK_TOKEN?.trim();
	if (!base || !token) return CONTINUE; // not configured → no-op

	// D-025: the proxy must never POST off the loopback boundary, even if misconfigured.
	if (!isLoopbackHost(hostOf(base))) return CONTINUE;

	const timeout = opts.timeoutMs ?? hookTimeoutMs(event);
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeout);
	try {
		const res = await fetch(`${base.replace(/\/+$/, '')}/api/hooks/${event}`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				// D-025: bearer the per-boot token + a same-origin marker for the Origin check.
				'x-hook-token': token,
				origin: base
			},
			body: JSON.stringify(payload ?? {}),
			signal: ctrl.signal
		});
		if (!res.ok) return CONTINUE; // server error → best-effort no-op
		const data = (await res.json().catch(() => CONTINUE)) as unknown;
		return data && typeof data === 'object' ? (data as Record<string, unknown>) : CONTINUE;
	} catch {
		// abort / connection refused / DNS / any transport error → no-op (D-019).
		return CONTINUE;
	} finally {
		clearTimeout(timer);
	}
}
