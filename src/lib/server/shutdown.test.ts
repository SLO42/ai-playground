// TASK 13.5 finding 6 — process shutdown teardown. Before 13.5 NOTHING in src handled
// SIGTERM/SIGINT: a stopped server leaked live-query watchers, the orchestrator, the DB
// socket, and any live claude children (the F-014 orphan-storm shape). These tests drive
// the teardown through an injected fake process + spy deps (no real signals, no exit).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registerShutdown, runShutdown, resetShutdownForTest, WATCHDOG_MS, type ShutdownDeps } from './shutdown';

function makeDeps(overrides: Partial<ShutdownDeps> = {}): {
	deps: ShutdownDeps;
	order: string[];
	exit: ReturnType<typeof vi.fn>;
} {
	const order: string[] = [];
	const exit = vi.fn();
	const deps: ShutdownDeps = {
		stopOrchestrators: vi.fn(() => void order.push('orchestrators')),
		killChildren: vi.fn(async () => void order.push('children')),
		stopWatchers: vi.fn(async () => void order.push('watchers')),
		closeDb: vi.fn(async () => void order.push('db')),
		exit: exit as unknown as ShutdownDeps['exit'],
		...overrides
	};
	return { deps, order, exit };
}

beforeEach(() => {
	resetShutdownForTest();
});

describe('registerShutdown — once-only SIGTERM/SIGINT handlers', () => {
	it('SIGTERM runs the ORDERED teardown (orchestrator → children → watchers → DB) then exits 0', async () => {
		const proc = new EventEmitter();
		const { deps, order, exit } = makeDeps();
		expect(registerShutdown(deps, proc)).toBe(true);
		proc.emit('SIGTERM');
		await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
		expect(order).toEqual(['orchestrators', 'children', 'watchers', 'db']);
	});

	it('SIGINT triggers the same teardown', async () => {
		const proc = new EventEmitter();
		const { deps, exit } = makeDeps();
		registerShutdown(deps, proc);
		proc.emit('SIGINT');
		await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
	});

	it('registers ONCE per process — a second registration (dev HMR re-eval) is a no-op', () => {
		const proc = new EventEmitter();
		const { deps } = makeDeps();
		expect(registerShutdown(deps, proc)).toBe(true);
		expect(registerShutdown(deps, proc)).toBe(false);
		// Only ONE handler per signal — a signal must not double-run the teardown.
		expect(proc.listenerCount('SIGTERM')).toBe(1);
		expect(proc.listenerCount('SIGINT')).toBe(1);
	});

	it('a second signal never re-runs the teardown (idempotent)', async () => {
		const proc = new EventEmitter();
		const { deps, exit } = makeDeps();
		registerShutdown(deps, proc);
		proc.emit('SIGTERM');
		await vi.waitFor(() => expect(exit).toHaveBeenCalled());
		proc.emit('SIGINT');
		await new Promise((r) => setTimeout(r, 20));
		expect(deps.closeDb).toHaveBeenCalledTimes(1);
		expect(deps.killChildren).toHaveBeenCalledTimes(1);
	});

	it('a throwing/rejecting step never blocks the later steps (best-effort each)', async () => {
		const { deps, order } = makeDeps({
			stopOrchestrators: vi.fn(() => {
				throw new Error('boom');
			}),
			stopWatchers: vi.fn(async () => {
				throw new Error('watcher kill failed');
			})
		});
		await runShutdown(deps);
		// children + db still ran despite the earlier failures.
		expect(order).toContain('children');
		expect(order).toContain('db');
	});

	it('the watchdog force-exits even when a teardown step HANGS (the shutdown path is bounded, F-014)', async () => {
		vi.useFakeTimers();
		try {
			const proc = new EventEmitter();
			const { deps, exit } = makeDeps({
				killChildren: vi.fn(() => new Promise(() => {})) // hangs forever (dead socket shape)
			});
			registerShutdown(deps, proc);
			proc.emit('SIGTERM');
			await vi.advanceTimersByTimeAsync(WATCHDOG_MS + 100);
			expect(exit).toHaveBeenCalledWith(1);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('hooks.server.ts wiring (static audit — the finding was "no handler anywhere in src")', () => {
	it('the boot path registers the shutdown teardown', () => {
		const src = readFileSync(fileURLToPath(new URL('../../hooks.server.ts', import.meta.url)), 'utf8');
		expect(src).toContain('registerShutdown(');
		expect(src).toContain('killAllClaudeChildren');
		expect(src).toContain('closeDb');
	});
});
