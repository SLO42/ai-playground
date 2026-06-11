// idle — quiet-period monitor for the browser daemon (TASK 15.2 B3).
//
// Pattern source (provenance): gstack browse/src/server.ts idleCheckTick /
// BROWSE_IDLE_TIMEOUT auto-shutdown (MIT). Reimplemented as a pure factory
// with an INJECTED clock so the unit suite can drive time deterministically
// (no real timers in tests), and fail-closed on a nonsense quiet period.

/**
 * @param {{ quietMs: number, now?: () => number }} opts
 * @returns {{ touch: () => void, idleFor: () => number, due: () => boolean, lastUsedAt: () => number, quietMs: number }}
 */
export function createIdleMonitor(opts) {
	const { quietMs } = opts;
	const now = opts.now ?? Date.now;
	if (!Number.isFinite(quietMs) || quietMs <= 0) {
		const err = new RangeError(
			`idle-quiet-invalid: quietMs must be a positive finite number, got ${String(quietMs)}`
		);
		err.name = 'IdleQuietInvalid';
		throw err;
	}
	let last = now();
	return {
		quietMs,
		/** Record activity — resets the quiet period. */
		touch() {
			last = now();
		},
		idleFor() {
			return now() - last;
		},
		/** True once the daemon has been quiet for >= quietMs. */
		due() {
			return now() - last >= quietMs;
		},
		lastUsedAt() {
			return last;
		}
	};
}
