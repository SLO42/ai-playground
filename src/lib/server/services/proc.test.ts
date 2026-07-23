// SVC-3 (SERVICES-SPEC §3) — proc.ts: the Windows-safe process liveness/kill primitives.
//
// These are the F-001/F-002 substrate the whole services manager rests on, and they were
// covered only INDIRECTLY (through the manager integration test). This suite exercises them
// directly, stubbing the OS edge (execFile) so it is deterministic on any host:
//   • safePid range-check — garbage pids are REJECTED before any command line is built (F-001:
//     never let a bad pid reach tasklist/taskkill; the D-008 argv-injection guard for OS commands).
//   • isPidAlive — the Windows `tasklist /FI "PID eq <pid>" /NH` path: a pid present in stdout is
//     alive; absent is dead; a spawn failure is treated as NOT alive (fail-safe toward re-spawn).
//   • killPid — the Windows `taskkill /F /PID <pid> /T` path: correct argv, idempotent + best-
//     effort (a gone pid / spawn error is swallowed, never thrown).
//
// The execFile stub uses callback style so the module's promisify(execFile) resolves against it.

import { describe, it, expect, vi, beforeEach } from 'vitest';

type ExecCb = (err: Error | null, out?: { stdout: string; stderr: string }) => void;
const execFileMock = vi.fn<(cmd: string, args: string[], cb: ExecCb) => void>();

vi.mock('node:child_process', () => ({
	execFile: (cmd: string, args: string[], cb: ExecCb) => execFileMock(cmd, args, cb)
}));

import { isPidAlive, killPid } from './proc';

const isWindows = process.platform === 'win32';

beforeEach(() => {
	execFileMock.mockReset();
});

describe('safePid — garbage pids are rejected before any OS command (F-001/D-008)', () => {
	it('isPidAlive rejects a zero / negative / fractional / out-of-range pid', async () => {
		await expect(isPidAlive(0)).rejects.toThrow(/Invalid pid/);
		await expect(isPidAlive(-1)).rejects.toThrow(/Invalid pid/);
		await expect(isPidAlive(1.5)).rejects.toThrow(/Invalid pid/);
		await expect(isPidAlive(0x1_0000_0000)).rejects.toThrow(/Invalid pid/); // > 32-bit
		await expect(isPidAlive(Number.NaN)).rejects.toThrow(/Invalid pid/);
		expect(execFileMock).not.toHaveBeenCalled(); // never reached the command line
	});

	it('killPid rejects a garbage pid before building a taskkill command', async () => {
		await expect(killPid(0)).rejects.toThrow(/Invalid pid/);
		await expect(killPid(-42)).rejects.toThrow(/Invalid pid/);
		expect(execFileMock).not.toHaveBeenCalled();
	});
});

describe.runIf(isWindows)('isPidAlive — Windows tasklist path (F-001, never process.kill(pid,0))', () => {
	it('a pid present in tasklist stdout is ALIVE, with the exact safe argv', async () => {
		execFileMock.mockImplementation((_cmd, _args, cb) =>
			cb(null, { stdout: 'node.exe                      1234 Console      1     50,000 K', stderr: '' })
		);
		expect(await isPidAlive(1234)).toBe(true);
		expect(execFileMock).toHaveBeenCalledWith('tasklist', ['/FI', 'PID eq 1234', '/NH'], expect.any(Function));
	});

	it('a pid absent from stdout ("No tasks") is DEAD', async () => {
		execFileMock.mockImplementation((_cmd, _args, cb) =>
			cb(null, { stdout: 'INFO: No tasks are running which match the specified criteria.', stderr: '' })
		);
		expect(await isPidAlive(4242)).toBe(false);
	});

	it('a spawn failure is treated as NOT alive (fail-safe toward re-spawn)', async () => {
		execFileMock.mockImplementation((_cmd, _args, cb) => cb(new Error('tasklist not found')));
		expect(await isPidAlive(4242)).toBe(false);
	});
});

describe.runIf(isWindows)('killPid — Windows taskkill path (F-002 tree kill), idempotent + best-effort', () => {
	it('force-kills the process tree with the exact safe argv', async () => {
		execFileMock.mockImplementation((_cmd, _args, cb) => cb(null, { stdout: '', stderr: '' }));
		await expect(killPid(1234)).resolves.toBeUndefined();
		expect(execFileMock).toHaveBeenCalledWith('taskkill', ['/F', '/PID', '1234', '/T'], expect.any(Function));
	});

	it('swallows a taskkill error (a gone pid is a no-op, never throws)', async () => {
		execFileMock.mockImplementation((_cmd, _args, cb) => cb(new Error('process not found')));
		await expect(killPid(9999)).resolves.toBeUndefined();
	});
});

describe.runIf(!isWindows)('POSIX fallback — signal-0 liveness / SIGTERM (host is not Windows)', () => {
	it('isPidAlive returns a boolean without using execFile', async () => {
		const alive = await isPidAlive(process.pid);
		expect(alive).toBe(true);
		expect(execFileMock).not.toHaveBeenCalled();
	});
});
