// TASK 9.4 — the GitHub CLI boundary (D-008 no-shell-injection; D-026 operator creds).
//
// This is the SINGLE place the `gh` executable is invoked. Every call goes through
// `runGh`, which uses `execFile`/`spawn` with an ARGUMENT ARRAY — NEVER a shell string —
// so a task title or body containing shell metacharacters (`; rm -rf`, backticks, `$(…)`)
// can never escape into a shell (the SurrealDB analog is D-016; this is the process-exec
// analog). Body content that may contain anything is passed over STDIN via `--body-file -`
// rather than as an arg, so it is never even parsed by gh's flag tokenizer.
//
// Credentials (D-026): we NEVER read, store, or log a token here. `gh` authenticates from
// the operator's own `gh auth` keychain or a `GH_TOKEN`/`GITHUB_TOKEN` already present in
// the process env (operator-supplied via .env, never committed). This module just shells
// out to an already-authenticated CLI; if it isn't authenticated, gh exits non-zero and we
// surface an HONEST failure (F-008) — we never fabricate a result.
//
// All calls are time-boxed (default 30s) and capped at a 10 MiB stdout buffer; on Windows
// the binary is invoked directly (no shell) so args are escaped by Node, not a shell.

import { execFile } from 'node:child_process';
import { spawn } from 'node:child_process';

/** A repo slug `owner/name` — the only interpolation-adjacent string we accept from config. */
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Thrown when a `gh` invocation fails (non-zero exit, timeout, or missing binary). */
export class GhError extends Error {
	override readonly name = 'GhError';
	constructor(
		message: string,
		readonly code: number | null,
		readonly stderr: string
	) {
		super(message);
	}
}

/**
 * Validate a `owner/repo` slug at the boundary. We pass it to gh as a `--repo` ARG (never
 * interpolated into a shell), but we still reject anything that is not a clean slug so a
 * misconfigured project surfaces an error rather than a confusing gh failure.
 * @throws {Error} on a malformed slug.
 */
export function assertRepoSlug(repo: string): string {
	if (typeof repo !== 'string' || !REPO_RE.test(repo)) {
		throw new Error(`invalid GitHub repo slug: ${JSON.stringify(repo)} (expected owner/name)`);
	}
	return repo;
}

export interface RunGhOptions {
	/** Working directory (the project root) — gh uses it to resolve the repo when unset. */
	cwd: string;
	/** Content piped to gh's stdin (for `--body-file -`). Never an arg, so never tokenized. */
	stdin?: string;
	/** Per-call timeout. Default 30s. */
	timeoutMs?: number;
	/** Override the gh binary (tests). Default "gh". */
	bin?: string;
	/**
	 * Args prepended before the gh args (tests only). Lets a test point `bin` at the Node
	 * executable and pass a fake-gh script path, exercising the SAME direct-spawn (no shell)
	 * path production uses — production never sets this. Real `gh` is `gh.exe`/`gh`, a true
	 * binary that spawns directly without a shell.
	 */
	prefixArgs?: string[];
}

const DEFAULT_TIMEOUT = 30_000;
const MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Invoke `gh` with an ARGUMENT ARRAY (no shell). Resolves with trimmed stdout on exit 0;
 * rejects with a {@link GhError} otherwise. When `stdin` is supplied we use `spawn` to pipe
 * it (execFile has no stdin write); otherwise `execFile`. The binary is launched directly —
 * on Windows, Node escapes the args, and the prompt/body never pass through a shell.
 */
export function runGh(args: string[], opts: RunGhOptions): Promise<string> {
	const bin = opts.bin ?? 'gh';
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
	const fullArgs = opts.prefixArgs ? [...opts.prefixArgs, ...args] : args;

	if (opts.stdin !== undefined) {
		return new Promise<string>((resolve, reject) => {
			const child = spawn(bin, fullArgs, {
				cwd: opts.cwd,
				windowsHide: true,
				stdio: ['pipe', 'pipe', 'pipe']
			});
			let stdout = '';
			let stderr = '';
			let settled = false;
			const finish = (fn: () => void) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				fn();
			};
			const timer = setTimeout(() => {
				child.kill();
				finish(() => reject(new GhError(`gh ${args[0] ?? ''} timed out`, null, stderr.trim())));
			}, timeoutMs);

			child.stdout.on('data', (d: Buffer) => {
				stdout += d.toString();
				if (stdout.length > MAX_BUFFER) child.kill();
			});
			child.stderr.on('data', (d: Buffer) => {
				stderr += d.toString();
			});
			child.on('error', (err) =>
				finish(() => reject(new GhError(`gh not available: ${err.message}`, null, stderr.trim())))
			);
			// TASK 13.5 finding 7: gh exiting before consuming stdin emits EPIPE on the stdin
			// stream — with NO handler that is an uncaught 'error' event that CRASHES the whole
			// server process. Treat it as a run failure (finish is idempotent; if 'close' with
			// exit 0 already settled the promise, this is a no-op).
			child.stdin.on('error', (err: Error) =>
				finish(() =>
					reject(
						new GhError(`gh ${args[0] ?? ''} stdin write failed: ${err.message}`, null, stderr.trim())
					)
				)
			);
			child.on('close', (code) =>
				finish(() => {
					if (code === 0) resolve(stdout.trim());
					else
						reject(
							new GhError(
								`gh ${args[0] ?? ''} failed (exit ${code}): ${stderr.trim() || 'no stderr'}`,
								code,
								stderr.trim()
							)
						);
				})
			);

			child.stdin.write(opts.stdin);
			child.stdin.end();
		});
	}

	return new Promise<string>((resolve, reject) => {
		execFile(
			bin,
			fullArgs,
			{ cwd: opts.cwd, timeout: timeoutMs, maxBuffer: MAX_BUFFER, windowsHide: true },
			(err, stdout, stderr) => {
				if (err) {
					const code = (err as NodeJS.ErrnoException & { code?: number }).code ?? null;
					reject(
						new GhError(
							`gh ${args[0] ?? ''} failed: ${stderr?.toString().trim() || err.message}`,
							typeof code === 'number' ? code : null,
							stderr?.toString().trim() ?? ''
						)
					);
					return;
				}
				resolve(stdout.toString().trim());
			}
		);
	});
}
