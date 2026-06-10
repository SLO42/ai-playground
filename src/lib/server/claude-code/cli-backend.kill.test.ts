// TASK 13.5 finding 8 — cli-backend run timeout + cancel() used `child.kill()` (ONE
// SIGTERM to the direct child), which on Windows leaves the claude.exe process TREE
// alive (F-002 — the documented orphan storm). Both paths must go through the existing
// Windows-safe tree-kill primitive (services/proc.killPid → `taskkill /F /T`).
//
// These tests mock node:child_process (a controllable fake child) + services/proc (a
// killPid spy) and FAIL against the old code: cancel()/timeout never invoked killPid.
// Kept in a separate file so the mocks never leak into cli-backend.test.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { CcSpawnPlan } from '../runtime/index';

const killPidMock = vi.fn<(pid: number) => Promise<void>>(async () => {});
vi.mock('../services/proc', () => ({
	killPid: (pid: number) => killPidMock(pid)
}));

class FakeChild extends EventEmitter {
	stdout = new PassThrough();
	stderr = new PassThrough();
	stdin = new PassThrough();
	pid = 4242;
	exitCode: number | null = null;
	killed = false;
	kill(): boolean {
		this.killed = true;
		return true;
	}
}

let fake: FakeChild;
vi.mock('node:child_process', async (importOriginal) => {
	const real = (await importOriginal()) as Record<string, unknown>;
	return { ...real, spawn: () => fake };
});

import { ClaudeCliBackend, treeKillChild, killAllClaudeChildren } from './cli-backend';

function plan(): CcSpawnPlan {
	return {
		agentId: 'opus-1',
		cwd: process.cwd(),
		model: { provider: 'claude', modelId: 'claude-opus-4-8', tier: 'opus' },
		prompt: 'do the thing',
		toolPolicy: { allow: ['Read'] },
		budgets: { thinking: 'high', toolCalls: 5, concurrency: 1 },
		// No hooks/gates ⇒ no trust seeding; env stays untouched.
		isolated: { configDir: '', env: {}, settings: {} }
	};
}

/** Drive the fake child to a clean end so a consumed stream() can finish. */
function endFake(code = 0): void {
	fake.stdout.end();
	fake.exitCode = code;
	fake.emit('close', code);
}

beforeEach(async () => {
	killPidMock.mockClear();
	fake = new FakeChild();
	await killAllClaudeChildren(); // drain any registry leftovers from a prior test
	killPidMock.mockClear();
});

describe('treeKillChild — the Windows-safe tree-kill primitive (F-002)', () => {
	it('tree-kills a LIVE child via services/proc.killPid (taskkill /T on Windows)', async () => {
		await treeKillChild(fake as never);
		expect(killPidMock).toHaveBeenCalledWith(4242);
	});

	it('is a no-op kill for an already-exited child (idempotent)', async () => {
		fake.exitCode = 0;
		await treeKillChild(fake as never);
		expect(killPidMock).not.toHaveBeenCalled();
	});
});

describe('ClaudeCliBackend — cancel() and timeout use the tree-kill (13.5 finding 8)', () => {
	it('cancel() tree-kills the claude child (not a bare child.kill())', async () => {
		const backend = new ClaudeCliBackend({ oauthToken: 'tok', timeoutMs: 60_000 });
		const run = backend.run(plan());
		await run.cancel();
		expect(killPidMock).toHaveBeenCalledWith(4242);
		endFake(); // let the registry close-listener fire
		await killAllClaudeChildren();
	});

	it('the run timeout tree-kills the claude child', async () => {
		const backend = new ClaudeCliBackend({ oauthToken: 'tok', timeoutMs: 25 });
		const run = backend.run(plan());
		// Consume the stream so the timeout timer is armed; the fake child never speaks.
		const consumed = (async () => {
			const events = [];
			for await (const ev of run.stream()) events.push(ev);
			return events;
		})();
		await vi.waitFor(() => expect(killPidMock).toHaveBeenCalledWith(4242), { timeout: 2000 });
		endFake(); // unblock the readline loop so the stream finishes
		await consumed;
	});

	it('killAllClaudeChildren sweeps every tracked live child (the shutdown path, finding 6)', async () => {
		const backend = new ClaudeCliBackend({ oauthToken: 'tok', timeoutMs: 60_000 });
		backend.run(plan());
		const swept = await killAllClaudeChildren();
		expect(swept).toBe(1);
		expect(killPidMock).toHaveBeenCalledWith(4242);
		// Registry is drained — a second sweep finds nothing.
		expect(await killAllClaudeChildren()).toBe(0);
		endFake();
	});
});
