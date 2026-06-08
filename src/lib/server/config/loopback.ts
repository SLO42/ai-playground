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
