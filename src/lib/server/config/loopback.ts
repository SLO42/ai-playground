// server/config — control-plane loopback bootstrap (TASK 0.e; D-025).
//
// D-025: EVERY listener (SvelteKit, SurrealDB, Ollama, embeddings) binds
// 127.0.0.1 ONLY, ASSERTED AT STARTUP — fail to boot if a socket is routable.
// Note: the SvelteKit Node adapter defaults to 0.0.0.0, so HOST=127.0.0.1 must
// be set; this module is the guard that catches a missed HOST as a hard boot
// failure rather than a silently-exposed control plane.
//
// The control plane (hook + control + mutation endpoints) also requires a
// per-boot random token. That token is the operator's steering capability
// (D-035) — it is minted here, never persisted to disk in cleartext, and never
// handed to the agent runtime.

import { randomBytes } from 'node:crypto';

/** A network listener the control plane is responsible for. */
export interface ListenerSpec {
	/** Human name used in assertion failures (e.g. "sveltekit", "surrealdb"). */
	name: string;
	/** Bind host. MUST resolve to a loopback address. */
	host: string;
	/** Bind port (informational; loopback is the security property, not the port). */
	port: number;
}

/** Result of a successful control-plane bootstrap. */
export interface ControlPlane {
	/** Per-boot random token (operator steering capability — D-025/D-035). */
	readonly token: string;
	/** The listeners that PASSED the loopback assertion. */
	readonly listeners: readonly ListenerSpec[];
}

/** Thrown when a listener is bound to a routable (non-loopback) address. */
export class LoopbackBindError extends Error {
	readonly listener: ListenerSpec;
	constructor(listener: ListenerSpec) {
		super(
			`Listener "${listener.name}" is bound to "${listener.host}:${listener.port}", ` +
				`which is NOT a loopback address — refusing to boot a routable control plane (D-025). ` +
				`Set the bind host to 127.0.0.1 (SvelteKit Node adapter: HOST=127.0.0.1).`
		);
		this.name = 'LoopbackBindError';
		this.listener = listener;
	}
}

/**
 * True iff `host` is a loopback address that exposes nothing routable.
 *
 * Loopback: `localhost`, the entire 127.0.0.0/8 block, and IPv6 `::1`
 * (bracketed or not). The IPv4 wildcard `0.0.0.0` and IPv6 wildcard `::` are
 * explicitly NOT loopback — binding a wildcard exposes every interface, which
 * is exactly the routable exposure D-025 fails closed against.
 */
export function isLoopbackHost(host: string): boolean {
	if (!host) return false;
	const h = host.trim().toLowerCase();
	if (h === 'localhost') return true;
	// IPv6 loopback, optionally bracketed.
	if (h === '::1' || h === '[::1]') return true;
	// Wildcards are routable exposure, never loopback.
	if (h === '0.0.0.0' || h === '::' || h === '[::]') return false;
	// Any 127.0.0.0/8 address is IPv4 loopback.
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
	if (m) {
		const octets = m.slice(1, 5).map(Number);
		if (octets.some((o) => o > 255)) return false;
		return octets[0] === 127;
	}
	return false;
}

/**
 * Decide whether a request is loopback for the LOGIN GATE (SEC-1), given the (possibly
 * absent) real TCP peer address and the Host header — fail-closed on a LAN bind.
 *
 * `getClientAddress()` reflects the real socket peer and CANNOT be spoofed by a header;
 * when present, it alone decides. When it is ABSENT (an adapter change leaves it
 * unpopulated), the only signal left is the `Host` header — which a LAN client CAN spoof
 * (`Host: 127.0.0.1`). So the fallback is gated on the SERVER's OWN bind:
 *
 *   - LAN-bound server (`serverLoopbackBound: false`) → DENY (return false, fail-closed):
 *     a spoofed Host must not grant login-free control-plane access (SEC-1). The login
 *     gate then applies.
 *   - loopback-bound server (`serverLoopbackBound: true`) → keep the lenient Host
 *     fallback byte-identical: a LAN attacker cannot reach a loopback bind at all
 *     (unreachable by the D-025 boundary), and dev ergonomics stay.
 *
 * Pure (no request/env access) so the SEC-1 policy is unit-testable without SvelteKit.
 * The caller normalizes the peer address (IPv4-mapped IPv6 strip) and strips the Host
 * port before passing them in.
 */
export function decideClientLoopback(input: {
	/** Real TCP peer from getClientAddress(), already normalized; null/undefined if unavailable. */
	clientAddr: string | null | undefined;
	/** Bare Host-header hostname (port already stripped); null/undefined if absent. */
	hostHeader: string | null | undefined;
	/** True iff THIS server binds a loopback address (from the HOST bind env). */
	serverLoopbackBound: boolean;
}): boolean {
	// Authoritative + unspoofable: when the real peer address is known, it alone decides.
	if (input.clientAddr) return isLoopbackHost(input.clientAddr);
	// Address unavailable → the only remaining signal is the SPOOFABLE Host header.
	// Fail-closed on a LAN-bound server (SEC-1); a loopback-bound server keeps the
	// lenient fallback (a LAN attacker can't reach a loopback bind).
	if (!input.serverLoopbackBound) return false;
	if (!input.hostHeader) return false;
	return isLoopbackHost(input.hostHeader);
}

/**
 * Assert a single listener binds loopback. Throws {@link LoopbackBindError}
 * (fail-closed) on any routable address. Returns silently on loopback.
 */
export function assertLoopback(listener: ListenerSpec): void {
	if (!isLoopbackHost(listener.host)) {
		throw new LoopbackBindError(listener);
	}
}

/**
 * Mint a per-boot control-plane token: 32 random bytes, lowercase hex.
 * Regenerated each boot, never persisted to disk in cleartext (D-025).
 */
export function mintBootToken(): string {
	return randomBytes(32).toString('hex');
}

/**
 * D-025 startup gate. Asserts EVERY listener binds loopback — throwing
 * {@link LoopbackBindError} on the first routable one so the process fails to
 * boot — then mints the per-boot control-plane token.
 *
 * An empty listener set is a misconfiguration (nothing to protect / a control
 * plane was expected) and is refused.
 */
export function bootstrapControlPlane(listeners: readonly ListenerSpec[]): ControlPlane {
	if (listeners.length === 0) {
		throw new Error(
			'bootstrapControlPlane: no listeners supplied — refusing to boot a control plane with nothing asserted (D-025).'
		);
	}
	for (const listener of listeners) {
		assertLoopback(listener);
	}
	return {
		token: mintBootToken(),
		listeners: listeners.map((l) => ({ ...l }))
	};
}
