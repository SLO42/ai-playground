// Unit: state-file lifecycle, stale-pid recovery, crash marker, spawn lock
// (TASK 15.2 B3). Pure fs against a per-test temp dir; pid liveness INJECTED
// so the Windows tasklist probe (F-001) never makes these tests flaky.
// Shadow paths covered per data flow: missing file, empty file, corrupt JSON,
// wrong shape — every one a NAMED reason, never a crash.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	writeStateFile,
	readStateFile,
	cleanStateFile,
	discoverDaemon,
	writeCrashMarker,
	readAndClearCrashMarker,
	acquireSpawnLock,
	releaseSpawnLock,
	lockHeld,
	statePaths,
	stateShapeDefect,
	LOCK_STALE_MS
} from './state-file.mjs';

const VALID = {
	pid: 4242,
	browserPid: 4243,
	wsEndpoint: 'ws://127.0.0.1:50000/abc',
	controlPort: 50001,
	token: 'tok',
	startedAt: '2026-06-11T00:00:00.000Z',
	workspace: 'F:/code/ai-playground-v2',
	idleMs: 600000
};

const alive = async () => true;
const dead = async () => false;

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'bv-state-'));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe('writeStateFile / readStateFile', () => {
	it('round-trips a valid state atomically (no .tmp staging file left behind)', () => {
		writeStateFile(dir, VALID);
		const read = readStateFile(dir);
		expect(read).toEqual({ ok: true, state: VALID });
		expect(readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([]);
	});

	it('refuses to persist a bad shape with a NAMED error (fail-closed)', () => {
		const bad = { ...VALID } as Record<string, unknown>;
		delete bad.pid;
		expect(() => writeStateFile(dir, bad)).toThrowError(/state-shape-invalid.*pid/);
		expect(existsSync(statePaths(dir).state)).toBe(false);
	});

	it('missing file → reason "missing" (shadow path: nil)', () => {
		expect(readStateFile(dir)).toEqual({ ok: false, reason: 'missing' });
	});

	it('empty file → reason "corrupt-json" (shadow path: empty)', () => {
		writeFileSync(statePaths(dir).state, '');
		expect(readStateFile(dir)).toMatchObject({ ok: false, reason: 'corrupt-json' });
	});

	it('truncated JSON → reason "corrupt-json" (shadow path: upstream error mid-write)', () => {
		writeFileSync(statePaths(dir).state, '{"pid": 42, "browserP');
		expect(readStateFile(dir)).toMatchObject({ ok: false, reason: 'corrupt-json' });
	});

	it('valid JSON of the wrong shape → reason "bad-shape" with the field named', () => {
		writeFileSync(statePaths(dir).state, JSON.stringify({ pid: 1 }));
		const read = readStateFile(dir);
		expect(read).toMatchObject({ ok: false, reason: 'bad-shape' });
		expect((read as { detail: string }).detail).toMatch(/browserPid/);
	});

	it('stateShapeDefect names arrays and primitives as not-an-object', () => {
		expect(stateShapeDefect([])).toBe('not-an-object');
		expect(stateShapeDefect(null)).toBe('not-an-object');
		expect(stateShapeDefect(VALID)).toBeNull();
	});
});

describe('discoverDaemon', () => {
	it('live pid → kind live with the state', async () => {
		writeStateFile(dir, VALID);
		expect(await discoverDaemon(dir, { isPidAlive: alive })).toEqual({ kind: 'live', state: VALID });
	});

	it('dead pid → kind stale, file CLEANED, reason names the pid (stale-pid recovery)', async () => {
		writeStateFile(dir, VALID);
		const found = await discoverDaemon(dir, { isPidAlive: dead });
		expect(found.kind).toBe('stale');
		expect((found as { reason: string }).reason).toMatch(/4242.*dead/);
		expect(existsSync(statePaths(dir).state)).toBe(false);
		// Recovery: the NEXT discovery starts clean.
		expect(await discoverDaemon(dir, { isPidAlive: dead })).toEqual({ kind: 'none' });
	});

	it('corrupt state file → kind stale, cleaned, honest reason', async () => {
		writeFileSync(statePaths(dir).state, 'not json at all');
		const found = await discoverDaemon(dir, { isPidAlive: alive });
		expect(found.kind).toBe('stale');
		expect((found as { reason: string }).reason).toMatch(/corrupt-json/);
		expect(existsSync(statePaths(dir).state)).toBe(false);
	});

	it('no state file → kind none', async () => {
		expect(await discoverDaemon(dir, { isPidAlive: alive })).toEqual({ kind: 'none' });
	});
});

describe('crash marker', () => {
	it('write → read-and-clear returns the info ONCE (second read null)', () => {
		writeCrashMarker(dir, { reason: 'browser ws connection lost', browserPid: 7 });
		const first = readAndClearCrashMarker(dir);
		expect(first).toMatchObject({ reason: 'browser ws connection lost', browserPid: 7 });
		expect(typeof (first as { at: string }).at).toBe('string');
		expect(readAndClearCrashMarker(dir)).toBeNull();
	});

	it('absent marker → null (shadow path: nil)', () => {
		expect(readAndClearCrashMarker(dir)).toBeNull();
	});

	it('corrupt marker → still REPORTED with a named reason, and cleared', () => {
		writeFileSync(statePaths(dir).crash, '{{nope');
		expect(readAndClearCrashMarker(dir)).toMatchObject({ reason: expect.stringMatching(/crash-marker-corrupt/) });
		expect(readAndClearCrashMarker(dir)).toBeNull();
	});
});

describe('spawn lock', () => {
	it('exclusive: second acquire fails until release', () => {
		expect(acquireSpawnLock(dir)).toBe(true);
		expect(acquireSpawnLock(dir)).toBe(false);
		releaseSpawnLock(dir);
		expect(acquireSpawnLock(dir)).toBe(true);
	});

	it('a stale lock (owner died mid-spawn) is stolen after LOCK_STALE_MS', () => {
		expect(acquireSpawnLock(dir)).toBe(true);
		// Backdate the lock file past the staleness horizon.
		const old = (Date.now() - LOCK_STALE_MS - 1000) / 1000;
		utimesSync(statePaths(dir).lock, old, old);
		expect(acquireSpawnLock(dir)).toBe(true);
		expect(lockHeld(dir)).toBe(true);
	});

	it('a FRESH lock is honored via the injected clock (no steal before the horizon)', () => {
		expect(acquireSpawnLock(dir)).toBe(true);
		const now = () => Date.now(); // lock just created — age ~0
		expect(acquireSpawnLock(dir, { now })).toBe(false);
	});

	it('lock file content is the holder pid', () => {
		acquireSpawnLock(dir);
		expect(readFileSync(statePaths(dir).lock, 'utf8')).toBe(String(process.pid));
	});
});

describe('cleanStateFile', () => {
	it('is idempotent (interrupt contract — safe on every exit path, twice)', () => {
		writeStateFile(dir, VALID);
		cleanStateFile(dir);
		expect(() => cleanStateFile(dir)).not.toThrow();
		expect(existsSync(statePaths(dir).state)).toBe(false);
	});
});
