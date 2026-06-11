// LIVE integration (TASK 15.2 B3) — the singleton browser daemon against the
// REAL dev server (F-008: nothing mocked). Proves the three contract points:
//   1. two COLD CONCURRENT invocations share ONE browser (spawn-lock singleton);
//   2. kill -9 the browser → the daemon exits with a crash marker and the NEXT
//      invocation reports the crash honestly, then recovers fresh;
//   3. act() returns a NON-EMPTY snapshot diff for a real toggle (the topbar
//      Notifications bell opens the RightTray).
//
// BOUNDED (F-014): every CLI call has an execFile timeout, polls have
// deadlines, and afterAll force-kills anything we spawned (daemon + browser
// die together — the browser is a child of the daemon's launchServer).
// Honest skip when the dev server is not up (same convention as the other
// *.live.test.ts files); state lives in an isolated temp dir so a real
// workspace daemon is never touched.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { statePaths, readStateFile } from './state-file.mjs';

// 'localhost', not 127.0.0.1: vite dev binds localhost, which resolves to ::1
// only on this host — Node fetch + Chromium both handle the dual-stack lookup.
const BASE = process.env.BV_LIVE_BASE ?? 'http://localhost:5173';
const CLI = join(process.cwd(), 'scripts', 'browser-verify', 'cli.mjs');

async function devServerUp(): Promise<boolean> {
	try {
		const res = await fetch(BASE + '/', { signal: AbortSignal.timeout(3000) });
		return res.ok;
	} catch {
		return false;
	}
}
const up = await devServerUp();
const live = up ? describe : describe.skip;
if (!up) console.warn(`[daemon.live] dev server not reachable at ${BASE} — suite skipped honestly`);

let stateDir: string;
const seenDaemonPids = new Set<number>();

interface CliResult {
	ok: boolean;
	cmd?: string;
	daemonPid?: number;
	browserPid?: number;
	wsEndpoint?: string;
	[k: string]: unknown;
}

/** Run one CLI invocation, bounded; returns its parsed single-line JSON. */
function runCli(args: string[], boundMs = 60_000): Promise<CliResult> {
	return new Promise((resolve, reject) => {
		execFile(
			process.execPath,
			[CLI, ...args],
			{
				timeout: boundMs,
				windowsHide: true,
				env: { ...process.env, BV_STATE_DIR: stateDir, BV_IDLE_MS: String(10 * 60 * 1000) }
			},
			(err, stdout, stderr) => {
				const line = String(stdout).trim().split(/\r?\n/).pop() ?? '';
				try {
					const parsed = JSON.parse(line) as CliResult;
					if (typeof parsed.daemonPid === 'number') seenDaemonPids.add(parsed.daemonPid);
					resolve(parsed); // ok:false results resolve too — callers assert
				} catch {
					reject(
						new Error(
							`cli ${args[0]}: unparseable output (channel: ${err ? `exit ${err.code ?? 'killed'}` : 'empty output'}). stdout=${JSON.stringify(line.slice(0, 300))} stderr=${JSON.stringify(String(stderr).slice(0, 300))}`
						)
					);
				}
			}
		);
	});
}

function killHard(pid: number): Promise<void> {
	return new Promise((resolve) => {
		if (process.platform === 'win32') {
			execFile('taskkill', ['/F', '/PID', String(pid)], { timeout: 10_000, windowsHide: true }, () => resolve());
		} else {
			try {
				process.kill(pid, 'SIGKILL');
			} catch {
				/* already gone */
			}
			resolve();
		}
	});
}

async function pollUntil(check: () => boolean, deadlineMs: number, label: string): Promise<void> {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error(`poll-timeout: ${label} not true within ${deadlineMs}ms`);
}

beforeAll(() => {
	stateDir = mkdtempSync(join(tmpdir(), 'bv-live-'));
});

afterAll(async () => {
	// MANDATORY teardown (F-014): stop politely, then force-kill anything left.
	try {
		await runCli(['stop'], 20_000);
	} catch {
		/* daemon may already be gone */
	}
	const read = readStateFile(stateDir);
	if (read.ok) await killHard(read.state.pid);
	for (const pid of seenDaemonPids) await killHard(pid);
	rmSync(stateDir, { recursive: true, force: true });
}, 60_000);

live('browser-verify daemon against the live dev server', () => {
	it(
		'two cold concurrent invocations share ONE browser (singleton, never a sibling)',
		async () => {
			const [a, b] = await Promise.all([runCli(['nav', BASE + '/']), runCli(['nav', BASE + '/'])]);
			expect(a.ok, JSON.stringify(a)).toBe(true);
			expect(b.ok, JSON.stringify(b)).toBe(true);
			expect(a.daemonPid).toBeTypeOf('number');
			expect(a.daemonPid).toBe(b.daemonPid);
			expect(a.wsEndpoint).toBe(b.wsEndpoint);
			// Exactly one of the two spawned; the other reused over the state file.
			const status = await runCli(['status'], 20_000);
			expect(status.running).toBe(true);
			expect(status.daemonPid).toBe(a.daemonPid);
		},
		120_000
	);

	it(
		'act() returns a NON-EMPTY diff for a real toggle (Notifications bell opens the tray)',
		async () => {
			const nav = await runCli(['nav', BASE + '/']);
			expect(nav.ok, JSON.stringify(nav)).toBe(true);
			const snap = await runCli(['snapshot']);
			expect(snap.ok, JSON.stringify(snap)).toBe(true);
			const nodes = snap.nodes as { ref: string; role: string; name: string }[];
			expect(nodes.length).toBeGreaterThan(0);
			const bell = nodes.find((n) => n.role === 'button' && n.name.startsWith('Notifications'));
			expect(bell, 'topbar Notifications bell not in snapshot').toBeTruthy();

			const act = await runCli(['act', bell!.ref]);
			expect(act.ok, JSON.stringify(act)).toBe(true);
			expect(act.changed as number).toBeGreaterThan(0);
			expect((act.added as string[]).length).toBeGreaterThan(0);
			expect(act.summary).toMatch(/things changed/);
		},
		120_000
	);

	it(
		'a stale ref (after navigation) fails FAST with a named stale-ref error, not a 30s hang',
		async () => {
			const snap = await runCli(['snapshot']);
			const nodes = snap.nodes as { ref: string }[];
			const ref = nodes[0].ref;
			const nav = await runCli(['nav', BASE + '/']); // navigation retires every ref
			expect(nav.ok).toBe(true);
			const started = Date.now();
			const act = await runCli(['act', ref]);
			const elapsed = Date.now() - started;
			expect(act.ok).toBe(false);
			expect((act.error as { name: string }).name).toBe('stale-ref');
			expect((act.error as { message: string }).message).toMatch(/re-snapshot/);
			expect(elapsed).toBeLessThan(15_000); // immediate, nowhere near Playwright's 30s wait
		},
		120_000
	);

	it(
		'kill -9 the browser → daemon exits with crash marker; next invocation reports it honestly and recovers fresh',
		async () => {
			const status = await runCli(['status'], 20_000);
			expect(status.running).toBe(true);
			const oldDaemonPid = status.daemonPid as number;
			const browserPid = status.browserPid as number;
			expect(browserPid).toBeTypeOf('number');

			await killHard(browserPid);
			// Crash contract: EXIT IMMEDIATELY — state file gone, crash marker present.
			await pollUntil(() => !existsSync(statePaths(stateDir).state), 20_000, 'state file removed after crash');
			await pollUntil(() => existsSync(statePaths(stateDir).crash), 10_000, 'crash marker written');
			const marker = JSON.parse(readFileSync(statePaths(stateDir).crash, 'utf8'));
			expect(String(marker.reason)).toMatch(/browser/i);

			const nav = await runCli(['nav', BASE + '/']);
			expect(nav.ok, JSON.stringify(nav)).toBe(true);
			expect(nav.recoveredFromCrash, 'crash must be reported to the next invocation').toBeTruthy();
			expect(String((nav.recoveredFromCrash as { reason: string }).reason)).toMatch(/browser/i);
			expect(nav.daemonPid).not.toBe(oldDaemonPid); // genuinely fresh
		},
		120_000
	);

	it(
		'stop shuts the daemon down and cleans the state file; a second stop is honest about no daemon',
		async () => {
			const stop = await runCli(['stop'], 20_000);
			expect(stop.ok).toBe(true);
			await pollUntil(() => !existsSync(statePaths(stateDir).state), 15_000, 'state file removed on stop');
			const again = await runCli(['stop'], 20_000);
			expect(again.ok).toBe(true);
			expect(again.noDaemon).toBe(true);
		},
		60_000
	);
});
