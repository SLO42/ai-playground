// pid-live — Windows-safe process liveness probe (F-001).
//
// `process.kill(pid, 0)` gives wrong answers under MINGW/Windows signal
// emulation, so on win32 liveness is asked of `tasklist /FI "PID eq <pid>"`
// (the documented F-001 prevention). Non-Windows keeps the cheap signal-0
// probe. Invalid pids fail CLOSED: a pid we cannot validate is reported dead,
// which routes callers into the clean-and-start-fresh path instead of trusting
// a garbage state file.

import { execFile } from 'node:child_process';

/** True when `pid` is a usable OS pid (positive integer, sane range). */
export function isValidPid(pid) {
	return Number.isInteger(pid) && pid > 0 && pid <= 0x7fffffff;
}

/**
 * Probe whether a process with `pid` is alive.
 *
 * @param {number} pid
 * @param {{ platform?: string, exec?: typeof execFile }} [deps] injectable for unit tests
 * @returns {Promise<boolean>} false for invalid pids (fail-closed), dead pids,
 *   and probe failures (a liveness probe that errors must not report "alive").
 */
export function isPidAlive(pid, deps = {}) {
	const platform = deps.platform ?? process.platform;
	const exec = deps.exec ?? execFile;
	if (!isValidPid(pid)) return Promise.resolve(false);

	if (platform === 'win32') {
		return new Promise((resolve) => {
			// CSV/no-header output is machine-stable: a live pid yields a row
			// containing `"<pid>"`; a dead pid yields the INFO: no-tasks line.
			exec(
				'tasklist',
				['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
				{ timeout: 10_000, windowsHide: true },
				(err, stdout) => {
					if (err) return resolve(false); // probe failed → fail closed (not alive)
					resolve(String(stdout).includes(`"${pid}"`));
				}
			);
		});
	}

	try {
		process.kill(pid, 0);
		return Promise.resolve(true);
	} catch (err) {
		// EPERM means "alive but not ours" — still alive.
		return Promise.resolve(/** @type {NodeJS.ErrnoException} */ (err).code === 'EPERM');
	}
}
