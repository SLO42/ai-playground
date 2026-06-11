#!/usr/bin/env node
// browser-verify CLI — thin client for the singleton browser daemon
// (TASK 15.2 B3; usage: node scripts/browser-verify/cli.mjs <cmd> ...).
//
// Pattern source (provenance): gstack BROWSER.md thin-CLI-over-daemon (MIT).
// Mechanisms OURS, fail-closed and Windows-hardened:
//   - discovery via the .playground/ state file; a live daemon is REUSED
//     (never a sibling), a stale one (dead pid per tasklist — F-001) is
//     cleaned and reported, a crash marker from a previous browser crash is
//     surfaced honestly in the next invocation's output (F-008);
//   - cold concurrent invocations race through an O_EXCL spawn lock so only
//     one spawns the daemon and the rest wait for its readiness state file;
//   - detached spawn uses shell:true on win32 with explicit quoting — node
//     lives under "C:\Program Files\..." (F-002);
//   - EVERY op is wall-clock-bounded client-side (AbortSignal.timeout) on
//     top of the daemon's own bound — no channel can hang a wave verify step.
//
// Commands: start | status | nav <url> | snapshot | act <ref> |
//           screenshot <path> | stop
// Options:  --timeout <ms>  --state-dir <dir>  --idle-ms <ms>

import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { openSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	discoverDaemon,
	readAndClearCrashMarker,
	acquireSpawnLock,
	releaseSpawnLock,
	statePaths
} from './state-file.mjs';
import { isPidAlive } from './pid-live.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DAEMON_PATH = join(HERE, 'daemon.mjs');
const START_DEADLINE_MS = 30_000;
const POLL_MS = 200;

function usage() {
	console.error(
		'usage: node scripts/browser-verify/cli.mjs <start|status|nav <url>|snapshot|act <ref>|screenshot <path>|stop> [--timeout ms] [--state-dir dir] [--idle-ms ms]'
	);
	process.exit(2);
}

function namedError(name, message) {
	const err = new Error(message);
	err.name = name;
	return err;
}

/** Walk up from cwd to the workspace root (first dir owning .playground or .git). */
function findWorkspaceRoot() {
	let dir = process.cwd();
	for (;;) {
		if (existsSync(join(dir, '.playground')) || existsSync(join(dir, '.git'))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return process.cwd();
		dir = parent;
	}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── daemon spawn + readiness ────────────────────────────────────────────────

function spawnDaemon(stateDir, idleMs, workspace) {
	const logFd = openSync(statePaths(stateDir).log, 'a');
	const env = {
		...process.env,
		BV_STATE_DIR: stateDir,
		BV_WORKSPACE: workspace,
		...(idleMs ? { BV_IDLE_MS: String(idleMs) } : {})
	};
	// F-002: detached spawn breaks on paths with spaces (node sits in
	// "C:\Program Files\nodejs") — shell:true on win32. Both segments are
	// CONSTANTS (node's own execPath + this repo's daemon path — no user
	// input), quoted explicitly in ONE command string: args-array+shell is
	// deprecated (DEP0190) because the shell concatenates argv unescaped.
	const win = process.platform === 'win32';
	const child = win
		? spawn(`"${process.execPath}" "${DAEMON_PATH}"`, {
				detached: true,
				shell: true,
				stdio: ['ignore', logFd, logFd],
				env,
				windowsHide: true
			})
		: spawn(process.execPath, [DAEMON_PATH], {
				detached: true,
				stdio: ['ignore', logFd, logFd],
				env
			});
	child.unref();
}

function lastLogLines(stateDir, n = 6) {
	try {
		const raw = readFileSync(statePaths(stateDir).log, 'utf8');
		return raw.trimEnd().split(/\r?\n/).slice(-n).join(' | ');
	} catch {
		return '(no daemon log)';
	}
}

async function waitForLiveDaemon(stateDir, deadlineMs) {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		const found = await discoverDaemon(stateDir, { isPidAlive });
		if (found.kind === 'live') return found.state;
		await sleep(POLL_MS);
	}
	throw namedError(
		'daemon-start-timeout',
		`no live daemon within ${deadlineMs}ms (channel: timeout waiting for readiness state file). Last daemon log: ${lastLogLines(stateDir)}`
	);
}

/**
 * Discover-or-start the singleton daemon.
 * @returns {Promise<{ state: import('./state-file.mjs').DaemonState, notes: { staleRecovered?: string, spawned?: boolean } }>}
 */
async function ensureDaemon(stateDir, idleMs, workspace) {
	const notes = {};
	const found = await discoverDaemon(stateDir, { isPidAlive });
	if (found.kind === 'live') return { state: found.state, notes };
	if (found.kind === 'stale') notes.staleRecovered = found.reason;

	if (acquireSpawnLock(stateDir)) {
		try {
			// Absorb a race: a daemon may have come up between discover and lock.
			const again = await discoverDaemon(stateDir, { isPidAlive });
			if (again.kind === 'live') return { state: again.state, notes };
			spawnDaemon(stateDir, idleMs, workspace);
			notes.spawned = true;
			const state = await waitForLiveDaemon(stateDir, START_DEADLINE_MS);
			return { state, notes };
		} finally {
			releaseSpawnLock(stateDir);
		}
	}
	// Another invocation is spawning — wait for ITS daemon (singleton reuse).
	const state = await waitForLiveDaemon(stateDir, START_DEADLINE_MS);
	return { state, notes };
}

// ─── control transport (bounded) ─────────────────────────────────────────────

async function postOp(state, route, body, timeoutMs) {
	const url = `http://127.0.0.1:${state.controlPort}${route}`;
	let res;
	try {
		res = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-bv-token': state.token },
			body: JSON.stringify(body ?? {}),
			signal: AbortSignal.timeout(timeoutMs)
		});
	} catch (err) {
		if (err.name === 'TimeoutError' || err.name === 'AbortError') {
			throw namedError('op-timeout', `${route}: client wall-clock bound ${timeoutMs}ms exceeded (channel: timeout)`);
		}
		throw namedError(
			'daemon-unreachable',
			`${route}: daemon pid ${state.pid} did not answer on port ${state.controlPort} (${err.cause?.code ?? err.message}). If it is wedged: \`cli.mjs stop\` then retry.`
		);
	}
	let payload;
	try {
		payload = await res.json();
	} catch {
		throw namedError('daemon-bad-response', `${route}: daemon answered non-JSON (HTTP ${res.status})`);
	}
	if (!res.ok || payload.ok !== true) {
		const e = payload?.error ?? { name: 'op-failed', message: `HTTP ${res.status}` };
		throw namedError(e.name, `${route}: ${e.message}`);
	}
	return payload;
}

// ─── main ────────────────────────────────────────────────────────────────────

function emit(obj, code = 0) {
	console.log(JSON.stringify(obj));
	process.exit(code);
}

async function main() {
	const { values, positionals } = parseArgs({
		options: {
			timeout: { type: 'string' },
			'state-dir': { type: 'string' },
			'idle-ms': { type: 'string' }
		},
		allowPositionals: true
	});
	const cmd = positionals[0];
	if (!cmd) usage();

	const workspace = findWorkspaceRoot();
	const stateDir = resolve(values['state-dir'] || process.env.BV_STATE_DIR || join(workspace, '.playground'));
	const idleMs = values['idle-ms'] ? Number(values['idle-ms']) : undefined;
	if (idleMs !== undefined && (!Number.isFinite(idleMs) || idleMs <= 0)) {
		emit({ ok: false, cmd, error: { name: 'idle-ms-invalid', message: '--idle-ms must be a positive number' } }, 2);
	}
	const opTimeout = values.timeout ? Number(values.timeout) : 30_000;
	if (!Number.isFinite(opTimeout) || opTimeout <= 0) {
		emit({ ok: false, cmd, error: { name: 'timeout-invalid', message: '--timeout must be a positive number of ms' } }, 2);
	}
	// Client bound must outlive the daemon-side op bound it requests.
	const clientBound = opTimeout + 10_000;

	try {
		switch (cmd) {
			case 'stop': {
				const found = await discoverDaemon(stateDir, { isPidAlive });
				if (found.kind !== 'live') {
					emit({ ok: true, cmd, noDaemon: true, ...(found.kind === 'stale' ? { staleRecovered: found.reason } : {}) });
				}
				const state = /** @type {Extract<typeof found, {kind:'live'}>} */ (found).state;
				const out = await postOp(state, '/stop', {}, 10_000);
				emit({ ok: true, cmd, daemonPid: state.pid, stopping: out.stopping === true });
				break;
			}
			case 'status': {
				const crash = readAndClearCrashMarker(stateDir);
				const found = await discoverDaemon(stateDir, { isPidAlive });
				if (found.kind !== 'live') {
					emit({
						ok: true,
						cmd,
						running: false,
						...(found.kind === 'stale' ? { staleRecovered: found.reason } : {}),
						...(crash ? { recoveredFromCrash: crash } : {})
					});
				}
				const state = /** @type {Extract<typeof found, {kind:'live'}>} */ (found).state;
				const out = await postOp(state, '/status', {}, 10_000);
				emit({
					ok: true,
					cmd,
					running: true,
					daemonPid: state.pid,
					wsEndpoint: state.wsEndpoint,
					...(crash ? { recoveredFromCrash: crash } : {}),
					...out
				});
				break;
			}
			case 'start':
			case 'nav':
			case 'snapshot':
			case 'act':
			case 'screenshot': {
				const crash = readAndClearCrashMarker(stateDir);
				const { state, notes } = await ensureDaemon(stateDir, idleMs, workspace);
				const base = {
					cmd,
					daemonPid: state.pid,
					browserPid: state.browserPid,
					wsEndpoint: state.wsEndpoint,
					...(crash ? { recoveredFromCrash: crash } : {}),
					...(notes.staleRecovered ? { staleRecovered: notes.staleRecovered } : {}),
					...(notes.spawned ? { spawned: true } : {})
				};
				if (cmd === 'start') emit({ ok: true, ...base, startedAt: state.startedAt });
				if (cmd === 'nav') {
					const url = positionals[1];
					if (!url) usage();
					const out = await postOp(state, '/nav', { url, timeoutMs: opTimeout }, clientBound);
					emit({ ok: true, ...base, url: out.url, title: out.title });
				}
				if (cmd === 'snapshot') {
					const out = await postOp(state, '/snapshot', {}, clientBound);
					emit({ ok: true, ...base, generation: out.generation, count: out.count, nodes: out.nodes });
				}
				if (cmd === 'act') {
					const ref = positionals[1];
					if (!ref) usage();
					const out = await postOp(state, '/act', { ref, timeoutMs: opTimeout }, clientBound);
					emit({
						ok: true,
						...base,
						ref: out.ref,
						changed: out.changed,
						added: out.added,
						removed: out.removed,
						summary: out.summary
					});
				}
				if (cmd === 'screenshot') {
					const path = positionals[1];
					if (!path) usage();
					const out = await postOp(state, '/screenshot', { path, timeoutMs: opTimeout }, clientBound);
					emit({ ok: true, ...base, path: out.path });
				}
				break;
			}
			default:
				usage();
		}
	} catch (err) {
		emit({ ok: false, cmd, error: { name: err.name ?? 'error', message: err.message } }, 1);
	}
}

main().catch((err) => {
	console.error(`[bv-cli] fatal: ${err.message}`);
	process.exit(1);
});
