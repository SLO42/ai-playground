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
 * The bind host THIS server uses, from the `HOST` bind env — the SINGLE source of the
 * `127.0.0.1` default shared by the D-025 boot gate ({@link bootstrapControlPlane}'s
 * listener set) and the runtime loopback determination ({@link isServerLoopbackBound}),
 * so the two determinations can never DRIFT (SF2-3(b)). A missing/blank HOST means the
 * SvelteKit/adapter default we assert — 127.0.0.1.
 */
export function serverBindHost(hostEnv: string | null | undefined): string {
	const h = (hostEnv ?? '').trim();
	return h || '127.0.0.1';
}

/**
 * True iff THIS server binds a loopback address, derived from {@link serverBindHost} so it
 * is byte-consistent with the D-025 boot-gate listener host. A LAN bind (HOST set to a
 * routable address) is exactly where the spoofable Host-header / header-derived-address
 * loopback fallbacks must fail closed (SEC-1 / SF2-3).
 */
export function isServerLoopbackBound(hostEnv: string | null | undefined): boolean {
	return isLoopbackHost(serverBindHost(hostEnv));
}

/**
 * Extract the bare hostname from a `Host` header value (`host[:port]`), normalizing a
 * BRACKETED IPv6 literal correctly (SF2-3(c)): `[::1]:5173` → `::1`, `[::1]` → `::1`.
 * A naive `split(':')[0]` turns `[::1]:5173` into `[` and mis-classifies the loopback
 * literal as non-loopback. Returns null for an absent/blank value.
 *
 *   - `[<ipv6>]` / `[<ipv6>]:port` → the inner ipv6 literal (brackets + port stripped).
 *   - a bare, UN-bracketed multi-colon value → treated as an IPv6 literal (a Host header
 *     cannot carry an unbracketed `ipv6:port`, so every `:` is part of the address).
 *   - `host:port` / `ipv4:port` / bare hostname → the substring before the single colon.
 */
export function hostnameFromHostHeader(raw: string | null | undefined): string | null {
	if (!raw) return null;
	const v = raw.trim();
	if (!v) return null;
	if (v.startsWith('[')) {
		const close = v.indexOf(']');
		return close > 1 ? v.slice(1, close) : v.slice(1);
	}
	const firstColon = v.indexOf(':');
	if (firstColon === -1) return v;
	// A second colon with no brackets ⇒ an unbracketed IPv6 literal (no port is possible).
	if (v.indexOf(':', firstColon + 1) !== -1) return v;
	return v.slice(0, firstColon);
}

/**
 * Decide whether a request is loopback for the LOGIN GATE (SEC-1 / SF2-3), given the
 * (possibly absent) client address, WHETHER that address is spoofable, and the Host
 * header — fail-closed on a LAN bind.
 *
 * `getClientAddress()` normally reflects the real socket peer and CANNOT be spoofed by a
 * header. BUT the adapter-node `getClientAddress()` returns a HEADER value instead when
 * `ADDRESS_HEADER` (e.g. `x-forwarded-for`) is configured — and a header IS spoofable
 * (SF2-3(a)). So the caller passes `clientAddrSpoofable` to say which regime it is in:
 *
 *   - `clientAddr` present, NOT spoofable (ADDRESS_HEADER unset) → the real peer alone
 *     decides on ANY bind (unspoofable). Byte-identical to the prior behavior.
 *   - `clientAddr` present, SPOOFABLE (ADDRESS_HEADER set) → same trust class as the Host
 *     header. On a LAN-bound server a spoofed `127.0.0.1` must NOT grant login-free
 *     control-plane access → DENY (fail-closed). On a loopback-bound server keep it
 *     lenient (a remote attacker cannot reach a loopback bind at all).
 *   - `clientAddr` absent → the only signal left is the SPOOFABLE Host header, gated the
 *     same way on the server's own bind.
 *
 * Pure (no request/env access) so the SEC-1/SF2-3 policy is unit-testable without
 * SvelteKit. The caller normalizes the peer address (IPv4-mapped IPv6 strip) and passes
 * the bare Host hostname (see {@link hostnameFromHostHeader}).
 */
export function decideClientLoopback(input: {
	/** Client address from getClientAddress(), already normalized; null/undefined if unavailable. */
	clientAddr: string | null | undefined;
	/** Bare Host-header hostname (port already stripped); null/undefined if absent. */
	hostHeader: string | null | undefined;
	/** True iff THIS server binds a loopback address (from the HOST bind env). */
	serverLoopbackBound: boolean;
	/**
	 * True iff `clientAddr` came from a spoofable HEADER rather than the real socket peer —
	 * i.e. the adapter's `ADDRESS_HEADER` is configured. Defaults to false (the real, unset-
	 * ADDRESS_HEADER deployment), which preserves the prior authoritative-peer behavior.
	 */
	clientAddrSpoofable?: boolean;
}): boolean {
	if (input.clientAddr) {
		// Real, unspoofable socket peer → authoritative on any bind (unchanged behavior).
		if (!input.clientAddrSpoofable) return isLoopbackHost(input.clientAddr);
		// Header-derived (ADDRESS_HEADER set) → spoofable. Fail-closed on a LAN bind so a
		// spoofed loopback value can't bypass the login gate (SF2-3(a)); lenient on a
		// loopback bind (a remote client cannot reach it).
		if (!input.serverLoopbackBound) return false;
		return isLoopbackHost(input.clientAddr);
	}
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
