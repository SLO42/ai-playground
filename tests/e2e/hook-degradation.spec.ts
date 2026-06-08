import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// TASK 1.9 VERIFY (exact intent, D-019/D-024/D-025):
//   A Claude Code session is UNAFFECTED when the server is down — the hook-proxy
//   no-ops and the session continues. We exercise the REAL script that Claude Code
//   invokes (scripts/hook-proxy.mjs): with the server unreachable it must print the
//   empty/continue response `{}` and exit 0, promptly (never hang, never error).
//
// This is the graceful-degradation guarantee that makes the analytics hook path
// safe to be best-effort (D-019) and is WHY no safety decision may ride it (D-024):
// a down server yields a clean continue, exactly as we watched KongCode behave.

const __dir = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dir, '..', '..', 'scripts', 'hook-proxy.mjs');

/** Run the proxy script with given argv/env/stdin; resolve exit code + stdout. */
function runProxy(
	args: string[],
	env: NodeJS.ProcessEnv,
	stdin: string
): Promise<{ code: number; stdout: string }> {
	return new Promise((resolve, reject) => {
		const child = execFile(
			process.execPath,
			[SCRIPT, ...args],
			{ env: { ...process.env, ...env }, timeout: 20_000 },
			(err, stdout) => {
				// execFile reports a non-zero exit via err.code; the script must exit 0.
				const code = err && typeof (err as { code?: unknown }).code === 'number'
					? ((err as { code: number }).code)
					: 0;
				if (err && (err as { killed?: boolean }).killed) {
					return reject(new Error('hook-proxy HUNG (killed by timeout) — degradation failed'));
				}
				resolve({ code, stdout: stdout.toString() });
			}
		);
		child.stdin?.end(stdin);
	});
}

test('hook-proxy no-ops (exit 0, prints {}) when the server is DOWN — session unaffected', async () => {
	const started = Date.now();
	// Port 9 (discard) — nothing is listening → connection refused, the "server down" case.
	const { code, stdout } = await runProxy(
		['PostToolUse'],
		{ HOOK_URL: 'http://127.0.0.1:9', HOOK_TOKEN: 'tok' },
		JSON.stringify({ session_id: 'cc1', tool_name: 'Bash' })
	);

	expect(code).toBe(0); // the session is NEVER errored by a down server
	expect(JSON.parse(stdout)).toEqual({}); // the empty/continue response
	// Promptly — a connection-refused returns fast, well under the per-hook budget.
	expect(Date.now() - started).toBeLessThan(10_000);
});

test('hook-proxy no-ops (exit 0, {}) when env is unconfigured — nothing to POST to', async () => {
	// Explicitly unset the env so an inherited HOOK_URL/HOOK_TOKEN can't mask the case.
	const { code, stdout } = await runProxy(
		['SessionStart'],
		{ HOOK_URL: '', HOOK_TOKEN: '' },
		JSON.stringify({ session_id: 'x' })
	);
	expect(code).toBe(0);
	expect(JSON.parse(stdout)).toEqual({});
});
