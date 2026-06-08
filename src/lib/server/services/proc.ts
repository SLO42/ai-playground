// TASK 3.5 — Windows-safe process liveness + kill primitives (F-001/F-002).
//
// The services manager must decide "is this pid still alive?" and "stop this pid"
// WITHOUT ever calling `process.kill(pid, 0)` — on Windows/MINGW that signal-0
// probe is unreliable and has bitten us repeatedly (F-001). So:
//   - liveness   → `tasklist /FI "PID eq <pid>"` and look for the pid in the output.
//   - stop       → `taskkill /F /PID <pid> /T` (force, whole tree).
// On POSIX we fall back to the standard `process.kill(pid, 0)` probe / SIGTERM,
// which IS reliable there.
//
// execFile is invoked with an ARRAY of args (never a concatenated string) so a pid
// can never be interpreted as a shell token (D-008 analog for OS commands). pid is
// coerced + range-checked before it ever reaches the command line.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const isWindows = process.platform === 'win32';

/** Coerce + validate a pid to a positive 32-bit integer. Throws on garbage. */
function safePid(pid: number): number {
	if (!Number.isInteger(pid) || pid <= 0 || pid > 0xffffffff) {
		throw new Error(`Invalid pid: ${JSON.stringify(pid)}`);
	}
	return pid;
}

/**
 * Is the given pid currently a running process? Windows uses `tasklist` (F-001 —
 * NEVER process.kill(pid,0) on Windows). POSIX uses the signal-0 probe. Best-effort:
 * any spawn failure is treated as "not alive" (fail safe — we'd rather re-spawn a
 * service than wrongly believe a dead one is up).
 */
export async function isPidAlive(pid: number): Promise<boolean> {
	const p = safePid(pid);
	if (isWindows) {
		try {
			// /NH = no header; /FI filters by pid. A live pid appears in stdout; a dead
			// one yields "INFO: No tasks are running…" (which won't contain the pid).
			const { stdout } = await execFileP('tasklist', [
				'/FI',
				`PID eq ${p}`,
				'/NH'
			]);
			return stdout.includes(String(p));
		} catch {
			return false;
		}
	}
	// POSIX: signal 0 throws ESRCH if the process is gone.
	try {
		process.kill(p, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Force-stop a pid. Windows uses `taskkill /F /PID <pid> /T` (force + whole tree —
 * the shell:true wrapper used at spawn means the real server is a child, F-002).
 * POSIX sends SIGTERM. Idempotent + best-effort: a gone pid is a no-op.
 */
export async function killPid(pid: number): Promise<void> {
	const p = safePid(pid);
	if (isWindows) {
		await execFileP('taskkill', ['/F', '/PID', String(p), '/T']).catch(() => {});
		return;
	}
	try {
		process.kill(p, 'SIGTERM');
	} catch {
		/* already gone */
	}
}
