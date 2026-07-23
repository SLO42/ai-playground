// SVC-1 (SERVICES-SPEC §3) — ServicesTicker: the production scheduler for the supervision loop.
//
// The manager's crash/auto-restart is already integration-proven against a REAL SurrealDB
// (manager.test.ts). This suite proves the SCHEDULER contract in isolation with an INJECTED
// reconcile fn (no DB / OS processes needed), covering the four required behaviors:
//   • the tick FIRES on the configured interval,
//   • a slow tick is SINGLE-FLIGHT — an overlapping fire is skipped, never run concurrently,
//   • tickMs=0 DISABLES the timer (the manual-only contract preserved),
//   • a faulting tick is absorbed — it NEVER throws / crashes (F-014), and the interval survives.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { ServicesTicker, DEFAULT_SERVICES_TICK_MS } from './ticker';
import type { TickResult } from './manager';

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

/** A deferred promise handle so a test can hold a tick "in flight" deterministically. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe('ServicesTicker — the periodic supervision scheduler (SVC-1)', () => {
	it('defaults to the 5-min backstop cadence when no tickMs is given', () => {
		const ticker = new ServicesTicker({ db: {} as never, tick: async () => [] });
		expect(ticker.tickMs).toBe(DEFAULT_SERVICES_TICK_MS);
		expect(DEFAULT_SERVICES_TICK_MS).toBe(300_000);
	});

	it('FIRES the tick on the configured interval (unref\'d timer, armed)', async () => {
		vi.useFakeTimers();
		let calls = 0;
		const ticker = new ServicesTicker({
			db: {} as never,
			tickMs: 1000,
			tick: async (): Promise<TickResult[]> => {
				calls += 1;
				return [];
			}
		});
		ticker.start();
		expect(ticker.periodicArmed).toBe(true);
		expect(calls).toBe(0); // not fired until the first interval elapses

		await vi.advanceTimersByTimeAsync(1000);
		expect(calls).toBe(1);
		await vi.advanceTimersByTimeAsync(2000);
		expect(calls).toBe(3);
		expect(ticker.runCount).toBe(3);
		expect(ticker.faultCount).toBe(0);

		ticker.stop();
	});

	it('is SINGLE-FLIGHT — an overlapping fire is skipped, never run concurrently', async () => {
		let started = 0;
		const gate = deferred<TickResult[]>();
		const ticker = new ServicesTicker({
			db: {} as never,
			tickMs: 1000,
			tick: async (): Promise<TickResult[]> => {
				started += 1;
				return gate.promise; // stays pending until we resolve it
			}
		});

		// First tick starts and stays in flight; a second concurrent tickOnce must be SKIPPED.
		const first = ticker.tickOnce();
		const second = ticker.tickOnce();
		await second; // the skipped one returns immediately
		expect(started).toBe(1);
		expect(ticker.skippedOverlaps).toBe(1);
		expect(ticker.runCount).toBe(0); // first still in flight

		// Release the first; now a fresh (non-overlapping) tick runs and completes.
		gate.resolve([]);
		await first;
		expect(ticker.runCount).toBe(1);

		await ticker.tickOnce(); // gate.promise is resolved now → this tick runs to completion
		expect(started).toBe(2); // a new, non-overlapping tick did run
		expect(ticker.runCount).toBe(2);
		expect(ticker.skippedOverlaps).toBe(1); // still just the one overlap skip
	});

	it('tickMs=0 DISABLES periodic supervision (arms no timer)', async () => {
		vi.useFakeTimers();
		let calls = 0;
		const ticker = new ServicesTicker({
			db: {} as never,
			tickMs: 0,
			tick: async (): Promise<TickResult[]> => {
				calls += 1;
				return [];
			}
		});
		ticker.start();
		expect(ticker.periodicArmed).toBe(false);
		await vi.advanceTimersByTimeAsync(1_000_000);
		expect(calls).toBe(0);
	});

	it('a FAULTING tick is absorbed — never throws, and the interval survives (F-014)', async () => {
		vi.useFakeTimers();
		let calls = 0;
		const ticker = new ServicesTicker({
			db: {} as never,
			tickMs: 1000,
			tick: async (): Promise<TickResult[]> => {
				calls += 1;
				throw new Error('boom: probe DB down');
			}
		});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		ticker.start();

		await vi.advanceTimersByTimeAsync(1000);
		expect(calls).toBe(1);
		expect(ticker.faultCount).toBe(1);
		expect(ticker.runCount).toBe(0);
		// The interval SURVIVES the fault — a second fire still happens.
		await vi.advanceTimersByTimeAsync(1000);
		expect(calls).toBe(2);
		expect(ticker.faultCount).toBe(2);
		expect(warn).toHaveBeenCalled();

		ticker.stop();
	});

	it('tickOnce never throws even on a synchronous reconcile rejection', async () => {
		const ticker = new ServicesTicker({
			db: {} as never,
			tickMs: 1000,
			tick: async (): Promise<TickResult[]> => {
				throw new Error('boom');
			}
		});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		await expect(ticker.tickOnce()).resolves.toBeUndefined();
		expect(ticker.faultCount).toBe(1);
	});

	it('stop() is idempotent and disarms the timer; a stopped ticker will not tick', async () => {
		vi.useFakeTimers();
		let calls = 0;
		const ticker = new ServicesTicker({
			db: {} as never,
			tickMs: 1000,
			tick: async (): Promise<TickResult[]> => {
				calls += 1;
				return [];
			}
		});
		ticker.start();
		ticker.stop();
		ticker.stop(); // idempotent
		expect(ticker.periodicArmed).toBe(false);
		await vi.advanceTimersByTimeAsync(5000);
		expect(calls).toBe(0);
		// A direct tickOnce after stop is a no-op too.
		await ticker.tickOnce();
		expect(calls).toBe(0);
	});
});
