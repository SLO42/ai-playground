// state-file — singleton-daemon discovery state in .playground/ (TASK 15.2 B3).
//
// Pattern source (provenance): gstack BROWSER.md "the CLI is a thin client —
// it reads a state file, sends a command, prints the response" + browse/src
// daemon state handling (MIT). Mechanism is OURS, fail-closed:
//   - atomic writes (stage → rename; interrupt contract — a reader can never
//     observe a half-written state file),
//   - shape-validated reads (corrupt/truncated JSON is a named reason, never a
//     crash and never trusted),
//   - stale detection via an INJECTED pid-liveness probe (F-001 Windows-safe
//     in production, deterministic in unit tests),
//   - a crash MARKER file so the invocation AFTER a browser crash can report
//     the crash honestly instead of silently starting over (F-008).

import {
	mkdirSync,
	writeFileSync,
	renameSync,
	readFileSync,
	rmSync,
	existsSync,
	statSync
} from 'node:fs';
import { join } from 'node:path';

export const STATE_FILE_NAME = 'browser-daemon.json';
export const CRASH_FILE_NAME = 'browser-daemon.crash.json';
export const LOCK_FILE_NAME = 'browser-daemon.lock';
export const LOG_FILE_NAME = 'browser-daemon.log';

/** A spawn lock older than this is presumed orphaned (spawner died mid-start). */
export const LOCK_STALE_MS = 30_000;

/** @typedef {{ pid: number, browserPid: number, wsEndpoint: string, controlPort: number, token: string, startedAt: string, workspace: string, idleMs: number }} DaemonState */

export function statePaths(stateDir) {
	return {
		state: join(stateDir, STATE_FILE_NAME),
		crash: join(stateDir, CRASH_FILE_NAME),
		lock: join(stateDir, LOCK_FILE_NAME),
		log: join(stateDir, LOG_FILE_NAME)
	};
}

const REQUIRED = /** @type {const} */ ([
	['pid', 'number'],
	['browserPid', 'number'],
	['wsEndpoint', 'string'],
	['controlPort', 'number'],
	['token', 'string'],
	['startedAt', 'string'],
	['workspace', 'string'],
	['idleMs', 'number']
]);

/** Validate a parsed state object. Returns null when valid, else the named defect. */
export function stateShapeDefect(obj) {
	if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return 'not-an-object';
	for (const [key, type] of REQUIRED) {
		if (typeof (/** @type {Record<string, unknown>} */ (obj)[key]) !== type) {
			return `missing-or-bad-field:${key}`;
		}
	}
	return null;
}

/**
 * Atomically write the daemon state file. Stage → rename so a concurrent
 * reader sees either the old state or the new state, never a torn write.
 * Throws a named error (`state-shape-invalid`) instead of persisting garbage.
 */
export function writeStateFile(stateDir, state) {
	const defect = stateShapeDefect(state);
	if (defect) {
		const err = new Error(`state-shape-invalid: refusing to write state file (${defect})`);
		err.name = 'StateShapeInvalid';
		throw err;
	}
	mkdirSync(stateDir, { recursive: true });
	const { state: statePath } = statePaths(stateDir);
	const tmp = `${statePath}.tmp-${process.pid}`;
	writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
	renameSync(tmp, statePath);
}

/**
 * Read + validate the state file.
 * @returns {{ ok: true, state: DaemonState } | { ok: false, reason: 'missing' | 'corrupt-json' | 'bad-shape', detail?: string }}
 */
export function readStateFile(stateDir) {
	const { state: statePath } = statePaths(stateDir);
	let raw;
	try {
		raw = readFileSync(statePath, 'utf8');
	} catch {
		return { ok: false, reason: 'missing' };
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		return { ok: false, reason: 'corrupt-json', detail: /** @type {Error} */ (err).message };
	}
	const defect = stateShapeDefect(parsed);
	if (defect) return { ok: false, reason: 'bad-shape', detail: defect };
	return { ok: true, state: parsed };
}

/** Remove the state file (idempotent — every daemon exit path calls this). */
export function cleanStateFile(stateDir) {
	rmSync(statePaths(stateDir).state, { force: true });
}

/**
 * Discover the workspace daemon.
 *
 * live  → a daemon process is running per the injected liveness probe.
 * stale → a state file existed but was unusable (dead pid / corrupt / bad
 *         shape); it has been CLEANED so the caller can start fresh. The
 *         reason is reported, never swallowed (F-008 honest states).
 * none  → no state file.
 *
 * @param {string} stateDir
 * @param {{ isPidAlive: (pid: number) => Promise<boolean> }} deps
 * @returns {Promise<{ kind: 'live', state: DaemonState } | { kind: 'stale', reason: string, state?: DaemonState } | { kind: 'none' }>}
 */
export async function discoverDaemon(stateDir, deps) {
	const read = readStateFile(stateDir);
	if (!read.ok) {
		if (read.reason === 'missing') return { kind: 'none' };
		cleanStateFile(stateDir);
		return {
			kind: 'stale',
			reason: `state file unusable (${read.reason}${read.detail ? `: ${read.detail}` : ''}) — cleaned`
		};
	}
	const alive = await deps.isPidAlive(read.state.pid);
	if (!alive) {
		cleanStateFile(stateDir);
		return {
			kind: 'stale',
			reason: `daemon pid ${read.state.pid} is dead (crashed or killed) — state file cleaned`,
			state: read.state
		};
	}
	return { kind: 'live', state: read.state };
}

// ─── crash marker ────────────────────────────────────────────────────────────
// Written by the daemon on a browser crash, immediately before it exits with
// an honest error. The NEXT invocation reads-and-clears it so the crash is
// reported to whoever asked, not lost in a log nobody tails.

export function writeCrashMarker(stateDir, info) {
	mkdirSync(stateDir, { recursive: true });
	const { crash } = statePaths(stateDir);
	const tmp = `${crash}.tmp-${process.pid}`;
	writeFileSync(
		tmp,
		JSON.stringify({ at: new Date().toISOString(), ...info }, null, 2) + '\n',
		'utf8'
	);
	renameSync(tmp, crash);
}

/**
 * Read and remove the crash marker.
 * @returns {{ at?: string, reason?: string } | null} null when no marker; a
 *   corrupt marker is still REPORTED (named reason) rather than silently dropped.
 */
export function readAndClearCrashMarker(stateDir) {
	const { crash } = statePaths(stateDir);
	let raw;
	try {
		raw = readFileSync(crash, 'utf8');
	} catch {
		return null;
	}
	rmSync(crash, { force: true });
	try {
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
		return { reason: 'crash-marker-corrupt: not an object' };
	} catch {
		return { reason: 'crash-marker-corrupt: unparseable JSON' };
	}
}

// ─── spawn lock ──────────────────────────────────────────────────────────────
// Two cold concurrent invocations must NOT each spawn a daemon (the singleton
// guarantee). O_EXCL create is the mutex: the winner spawns, losers poll for
// the state file. A lock whose owner died mid-spawn is stolen after
// LOCK_STALE_MS so a crashed starter can't wedge the workspace.

/**
 * @param {string} stateDir
 * @param {{ now?: () => number }} [deps]
 * @returns {boolean} true when this process now holds the lock.
 */
export function acquireSpawnLock(stateDir, deps = {}) {
	const now = deps.now ?? Date.now;
	mkdirSync(stateDir, { recursive: true });
	const { lock } = statePaths(stateDir);
	const tryCreate = () => {
		try {
			writeFileSync(lock, String(process.pid), { flag: 'wx' });
			return true;
		} catch {
			return false;
		}
	};
	if (tryCreate()) return true;
	// Held — steal only if provably stale.
	try {
		const age = now() - statSync(lock).mtimeMs;
		if (age >= LOCK_STALE_MS) {
			rmSync(lock, { force: true });
			return tryCreate();
		}
	} catch {
		// Lock vanished between existsSync and stat — race with the owner's
		// release; one immediate retry, then defer to the other process.
		return tryCreate();
	}
	return false;
}

export function releaseSpawnLock(stateDir) {
	rmSync(statePaths(stateDir).lock, { force: true });
}

export function lockHeld(stateDir) {
	return existsSync(statePaths(stateDir).lock);
}
