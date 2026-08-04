// The ONE external-command seam the orchestrator's post-task family runs through.
//
// This module was EXTRACTED from post-task.ts (unchanged behaviour — the definitions moved
// verbatim and post-task.ts re-exports them, so every existing import site is untouched). The
// extraction exists for one reason: PCG-1 added a pre-commit gate and wired the review decision
// INTO post-task.ts, which would have made post-task ⇄ pre-commit-gate and post-task ⇄ review
// import cycles. Both of those consumers need only the runner seam, so the seam now lives below
// post-task in the graph and nothing imports "up".
//
// D-008 / F-002 discipline (why an ARGUMENT ARRAY, never a shell string): every dynamic value —
// a commit subject, a project path, a configured test command — is passed as its own argv
// element. `execFile` with `shell:false` hands argv to the OS verbatim, so a `; rm -rf /` inside
// a task title is an inert string, not a second command.

import { execFile } from 'node:child_process';

/** The result of running ONE external command. */
export interface CommandResult {
	/** Process exit code (0 = success). null only if the process was signalled. */
	code: number | null;
	stdout: string;
	stderr: string;
}

/**
 * Runs an external program with an ARGUMENT ARRAY (never a shell string). This is the
 * single seam through which the post-task family touches the OS — the default impl wraps
 * `execFile`, which spawns the program directly and passes each `args` element as a
 * literal argv entry (no shell word-splitting / metacharacter expansion). A malformed
 * path or a `;rm -rf …`-style task title therefore cannot inject a second command: it is
 * just one inert argv string handed to the program (D-008).
 */
export type CommandRunner = (
	file: string,
	args: readonly string[],
	opts: { cwd: string }
) => Promise<CommandResult>;

/**
 * The default runner: `execFile` with an argument array. `shell` is FALSE — even though
 * the platform note allows shell:true for binary-paths-with-spaces, this loop never needs
 * it (the programs are `git`/the test launcher on PATH) and shell:false is the strongest
 * no-injection guarantee: argv is passed verbatim, the OS never re-parses it (D-008/F-002).
 */
export const execFileRunner: CommandRunner = (file, args, opts) =>
	new Promise<CommandResult>((resolve) => {
		execFile(
			file,
			[...args],
			{ cwd: opts.cwd, shell: false, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
			(err, stdout, stderr) => {
				// A non-zero exit shows up as an error with a `.code`; we surface it as a
				// CommandResult, never a throw — the caller decides what a failure means.
				const code =
					err && typeof (err as { code?: unknown }).code === 'number'
						? (err as { code: number }).code
						: err
							? 1
							: 0;
				resolve({ code, stdout: stdout?.toString() ?? '', stderr: stderr?.toString() ?? '' });
			}
		);
	});

/**
 * Split a project command string into a program + argv array WITHOUT a shell. We split on
 * whitespace only — there is NO shell, so quoting/`&&`/`;`/`|`/redirections are NOT honoured;
 * each token becomes a literal argv element. This is deliberate: it means a configured
 * `test_command` can never smuggle a second command through a shell operator — the operators
 * are passed inert to the target program (which simply rejects them). D-008.
 */
export function splitCommand(cmd: string): { file: string; args: string[] } | null {
	const tokens = cmd.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return null;
	return { file: tokens[0], args: tokens.slice(1) };
}
