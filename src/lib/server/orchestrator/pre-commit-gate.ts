// PCG-1 — THE PRE-COMMIT GATE. Atelier's own Definition of Done, applied to Atelier's own
// autonomous output (D-038; the 2026-07-26 operator review's only correctness finding).
//
// THE DEFECT THIS CLOSES. The post-task loop committed an autonomous session's work FIRST and ran
// the project's test command AFTERWARDS — and the result was discarded: `boot.ts` wires
// `followUpOnTestFail:false`, and post-task explicitly documented "tests only trigger a follow-up,
// they never change the terminal status". Then merge-back FAST-FORWARDED that never-verified branch
// into the project branch. The studio that refuses to let any managed project ship without four
// green checks was landing its OWN agents' work with none.
//
// WHAT "BEFORE THE COMMIT" MEANS HERE, PRECISELY. The gate runs before every state that ASSERTS the
// work landed successfully: before the task's terminal transition (so `done` vs `failed` is decided
// WITH the verdict in hand, not in spite of it), before the ok `completion` event, and before the
// merge-back. It deliberately does NOT run before the git commit itself, and that is the load-
// bearing choice:
//
//   F-007 says uncommitted worktree work is LOST. A session's edits live in a per-session worktree
//   (WI-2) that merge-back tears down. "Refuse to commit on a red gate" would therefore DELETE the
//   agent's work — punishing a failing gate by destroying the very artifact an operator needs to
//   read. So a red gate still COMMITS (to the session BRANCH, which nothing else can see) and then
//   REFUSES TO MERGE. Committing is preservation; merging is the assertion. We preserve, and we
//   withhold the assertion.
//
// WHAT A RED GATE COSTS (all three, none of them silent — F-008 is the whole point):
//   1. the task lands `failed`, never `done` — so the autonomous PM re-ticks on a failure, and no
//      downstream reader can mistake it for success;
//   2. the session branch + worktree are PRESERVED by the EXISTING merge-back function (F-055 — we
//      pass an exit state it already understands rather than hand-rolling a second preserve path),
//      with an honest stamped note naming the failing step;
//   3. the whole gate record — every step, its command, its exit code, a bounded output tail — is
//      written onto the `completion` agent_event AND as a named `pre_commit_gate` drain fault, so
//      "why did my change not land" is answerable from the DB alone (CLAUDE.md §3: analytics is
//      first-class; never a flat event).
//
// FAIL MODE, CHOSEN DELIBERATELY (D-024). fail-CLOSED is for security boundaries; this is not one.
// But the safe direction here is still "do not merge": if the gate MACHINERY errors (the program is
// not on PATH, the cwd vanished mid-run), we cannot claim the work was verified, so `status` is
// 'failed' with `errored:true` — the work is preserved, the failure is named, and the server stays
// up (nothing in this module throws to its caller). The one thing we never do is fabricate a pass.
//
// AND WHERE WE DO *NOT* FAIL: a project with no detectable build/lint/typecheck/test target gets
// status 'skipped' — honestly NOT verified, and NOT a failure. Failing a project for not having a
// test suite would be a false RED (exactly the HB-2 class), and it would wedge every non-JS/.NET
// project in the studio. 'skipped' is recorded as loudly as a failure; it just doesn't block.
//
// THE SECOND MEMBER OF THAT FALSE-RED FAMILY — AN ABSENT TOOLCHAIN (the DoD-review finding that
// sent PCG-1 back). The gate's `cwd` is the per-session WI-2 worktree, and `sessions/worktree.ts`
// creates it with `git worktree add` and NOTHING ELSE — there is no dependency provisioning in that
// module, and `node_modules/` is gitignored, so it is NOT carried over by the checkout. Running
// `npm run build` there therefore exits non-zero with "'vite' is not recognized" — reproduced
// directly: a dir holding only a package.json exits 1 on `npm run build`. That is a statement about
// the ENVIRONMENT, not about the agent's code, and reading it as RED made the armed gate fail EVERY
// write task on EVERY npm project (Atelier's own self-hosting repo first — D-040), preserving every
// branch and merging none. So: an npm-family step whose dependency tree is not installed in `cwd`
// is an honest per-step SKIP with a named reason — the same verdict, for the same reason, as a
// project that declares no test script. We cannot verify here, so we say we did not verify; we
// never say the work is broken, and we never wedge the studio on it.
//
// THE SAME FAMILY, SECOND MEMBER — AN UNSPAWNABLE PROGRAM. Running the gate with its real default
// runner (the test the DoD-review named as missing) turned up the other half: on Windows `npm` is a
// `.cmd` shim, and `execFileRunner` is `shell:false` for D-008, so `execFile('npm', …)` fails ENOENT
// — which this seam reports as EXIT CODE 1 WITH EMPTY OUTPUT. Every npm step on this platform was
// therefore an unexplained RED even in a fully installed tree. Same rule, same reason: we could not
// run the check, so we say we did not, rather than blaming the change. See toolchainSkipReason.
//
// NOTE WHAT THIS DELIBERATELY DOES *NOT* DO: it does not install anything, and it does not turn on
// a shell. Provisioning a worktree with dependencies (an `npm ci`, or a linked/shared
// `node_modules`) is a new capability with its own cost, cache-sharing and F-052 concurrency
// questions; spawning through a shell to reach a `.cmd` trades this false RED for a command-
// injection surface (D-008) and is a SECURITY decision. Both are NAMED here as the follow-up work
// that would make this gate genuinely verify a JS worktree, and neither is decided by this fix.
// Until they exist the composition is still safe rather than silent: the gate reports 'skipped'
// (UNVERIFIED), and the review policy `holdMergeBack:'unverified'` (boot.ts) turns exactly that
// state into a merge HELD for operator review on any large change.
//
// SHADOW PATHS (all four built + tested): happy (steps run, all green) · nil (no cwd / no
// buildTool / no testCommand → skipped) · empty (a resolvable tool whose scripts are absent →
// skipped) · upstream error (a step exits non-zero → failed; the runner THROWS → failed+errored).
//
// D-008: every step is run through the {@link CommandRunner} seam with an ARGUMENT ARRAY, never a
// shell string, so a project-configured command can never smuggle a second command.

import { existsSync } from 'node:fs';
import { basename, delimiter, extname, join } from 'node:path';
import {
	execFileRunner,
	splitCommand,
	type CommandRunner
} from './command-runner';
import { buildCommandFor, npmScriptCommandFor } from '../scanner/detect';
// D-026 — command output is UNTRUSTED text that gets PERSISTED (agent_event.detail.gate + the
// drain-fault context) and RENDERED on /atelier/queue. A failing build/test routinely prints an
// absolute worktree path (home-path PII) and can print an env token, so it goes through the
// codebase's existing screening chokepoint before it is ever put in a detail string — never a
// second, hand-rolled redactor (F-055).
import { screen } from '../memory/screen';

/** The named checks the gate can run, in the order it runs them (CLAUDE.md §1's green bar). */
export const GATE_STEP_NAMES = ['build', 'lint', 'typecheck', 'test'] as const;
export type GateStepName = (typeof GATE_STEP_NAMES)[number];

/** One check's honest record — what ran, what it exited, and a bounded tail of what it said. */
export interface GateStep {
	name: GateStepName;
	/** The resolved command as a display string (e.g. `npm run build`). '' when nothing resolved. */
	command: string;
	/** True when the command was actually spawned (false ⇒ `detail` says WHY it was skipped). */
	ran: boolean;
	/** True only when the step ran AND exited 0. A skipped step is `ok:false, ran:false`. */
	ok: boolean;
	/** The process exit code when it ran (null ⇒ signalled). Absent when it did not run. */
	code?: number | null;
	/** Honest one-line detail: the exit code + output tail, the skip reason, or the spawn error. */
	detail: string;
}

/**
 * The gate verdict.
 *   • 'passed'  — at least one step RAN and every step that ran exited 0.
 *   • 'failed'  — a step exited non-zero, OR the gate machinery itself errored (`errored:true`).
 *   • 'skipped' — nothing was resolvable to run. Honestly UNVERIFIED; deliberately NOT a failure.
 * There is no fourth value and no `passed:boolean` — a two-valued flag is exactly how "we ran
 * nothing" got laundered into "it's green" in the first place.
 */
export type GateStatus = 'passed' | 'failed' | 'skipped';

export interface GateOutcome {
	status: GateStatus;
	/** True iff at least one step actually spawned — the honest "was anything verified at all". */
	verified: boolean;
	/** True when a step could not be RUN (spawn threw / cwd gone), as opposed to running and failing. */
	errored: boolean;
	/** Every step considered, in order — including the ones that did not run and why (F-008). */
	steps: GateStep[];
	/** The first failing step's name, or null when nothing failed. */
	failedAt: GateStepName | null;
	/** One honest operator-facing line. Never an adjective — always the codes/reasons. */
	summary: string;
}

export interface PreCommitGateInput {
	/** The working dir the steps run in — the session worktree (WI-2), NOT the project root. */
	cwd: string;
	/** `project.build_tool` — a bare detected tool ('npm'/'dotnet'/…) or an operator-edited command. */
	buildTool?: string | null;
	/**
	 * The ALREADY-RESOLVED test command (the caller runs `resolveTestCommand`, which only returns a
	 * command when a real test target was positively detected — HB-2). Absent ⇒ the test step is an
	 * honest skip, never a false RED.
	 */
	testCommand?: string | null;
}

export interface PreCommitGateOptions {
	/** Injectable command runner (test seam); defaults to {@link execFileRunner} (execFile arrays). */
	run?: CommandRunner;
	/**
	 * Restrict the gate to these steps (default: all four). Present so a project/config can narrow
	 * the gate without a second gate implementation appearing somewhere else (F-055).
	 */
	steps?: readonly GateStepName[];
}

/**
 * D-026 — screen an untrusted text span before it is embedded in a persisted detail string.
 * `screen()` fails CLOSED (a scan error ⇒ quarantined ⇒ empty text), so a quarantined result
 * degrades to an HONEST marker rather than a blank field or the raw text (F-008) — the same
 * contract drain-events.ts's screenErrorText applies to a drain error.
 */
function screened(text: string): string {
	const res = screen(text);
	return res.status === 'quarantined' ? '(output withheld — it contained a secret)' : res.text;
}

/**
 * A bounded, single-line tail of command output — honest but never the whole log, and SCREENED
 * (D-026) before it can reach an agent_event / the drain ledger / the queue page.
 */
function tail(text: string, max = 240): string {
	const oneLine = screened(text).replace(/\s+/g, ' ').trim();
	if (!oneLine) return '';
	return oneLine.length > max ? `…${oneLine.slice(oneLine.length - max)}` : oneLine;
}

/**
 * The npm-family programs whose steps cannot run at all without an installed dependency tree.
 * (Everything they invoke — vite, eslint, svelte-check, vitest — lives in `node_modules/.bin`.)
 */
const NPM_FAMILY = new Set(['npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'bun', 'bunx']);

/** Extensions that only a SHELL can execute — this seam is argv-only (shell:false) by design. */
const SHELL_ONLY_EXT = new Set(['.cmd', '.bat', '.ps1']);

/**
 * Where the argv-only runner would actually FIND `prog`, or null. Mirrors what `execFile` with
 * `shell:false` does: a literal PATH scan, extended by PATHEXT on Windows. We resolve it ourselves
 * because the runner cannot report the difference — `execFile` surfaces a spawn ENOENT as exit
 * code 1 with EMPTY output, which the gate would otherwise record as a build failure with no
 * reason at all.
 */
function resolveOnPath(prog: string): string | null {
	// On Windows ONLY a PATHEXT extension is executable: `C:\Program Files\nodejs\npm` (the
	// extension-less POSIX shell script npm also ships) sits right next to `npm.cmd` on PATH, and
	// probing for it first is how a scan can "find" npm and still be unable to spawn it. Elsewhere
	// the bare name is the executable.
	const exts =
		process.platform === 'win32'
			? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
			: [''];
	for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
		for (const ext of exts) {
			const candidate = join(dir, prog + ext.toLowerCase());
			if (existsSync(candidate)) return candidate;
		}
	}
	return null;
}

/**
 * PRE-FLIGHT: can this resolved step actually be RUN in `cwd`, or would running it only prove that
 * the ENVIRONMENT is missing? Returns a named skip reason, or '' when the step is safe to spawn.
 *
 * Three named cases, all npm-family, all discovered by running the real thing rather than reading:
 *
 *  1. NO package.json in the working dir. `buildCommandFor('npm')` resolves `npm run build` from
 *     the project's `build_tool` ALONE and never looks at the disk, so a JS project's build step
 *     would otherwise be spawned in a tree that has no manifest at all.
 *  2. NO node_modules — the WI-2 worktree case, which is the DEFAULT for every write session (see
 *     the header). `npm run build` there exits 1 with "'vite' is not recognized".
 *  3. THE PROGRAM IS NOT SPAWNABLE BY THIS SEAM (only checked when the DEFAULT argv-only runner is
 *     in use — `argvOnly`; an injected runner has its own spawn rules and this must not speak for
 *     it). On Windows `npm`/`npx`/`pnpm`/`yarn` exist only as
 *     `.cmd` shims, and {@link execFileRunner} is `shell:false` for D-008 (argv is never re-parsed
 *     by a shell). Verified against the live runtime: `execFile('npm', …, {shell:false})` fails
 *     ENOENT — which this seam reports as exit code 1 with EMPTY stdout/stderr — and `npm.cmd`
 *     throws EINVAL outright (Node refuses to spawn a batch file without a shell). So on Windows
 *     EVERY npm step was an unexplained RED: not the agent's code, and not even a real run. The
 *     gate says so instead of inventing a verdict. Turning on `shell:true` to "fix" this would
 *     trade a false RED for a command-injection surface (D-008) — that is a security decision, not
 *     a bug fix, and it is NOT taken here; it is named as follow-up work alongside the dependency
 *     provisioning in the header.
 *
 * Deliberately NARROW: no other ecosystem is probed. Guessing "is the dotnet SDK installed" would
 * re-introduce exactly the false-verdict class this exists to remove; for those, a genuine non-zero
 * exit remains a genuine RED.
 */
function toolchainSkipReason(cwd: string, file: string, argvOnly: boolean): string {
	// A resolution can hand us `npm.cmd` / an absolute path; compare on the bare program name.
	const prog = basename(file).replace(/\.(cmd|exe|bat|ps1)$/i, '').toLowerCase();
	if (!NPM_FAMILY.has(prog)) return '';
	if (!existsSync(join(cwd, 'package.json'))) {
		return `not run — no package.json in the working dir, so \`${prog}\` has nothing to run here (UNVERIFIED, not failed)`;
	}
	if (!existsSync(join(cwd, 'node_modules'))) {
		return (
			`not run — the working dir has NO installed dependency tree (node_modules absent), so this check ` +
			`cannot be performed here; a non-zero exit would describe the environment, not the change ` +
			`(UNVERIFIED, not failed)`
		);
	}
	if (!argvOnly) return '';
	const resolved = resolveOnPath(prog);
	if (!resolved) {
		return `not run — \`${prog}\` is not on PATH for this server process (UNVERIFIED, not failed)`;
	}
	const ext = extname(resolved).toLowerCase();
	if (SHELL_ONLY_EXT.has(ext)) {
		return (
			`not run — on this platform \`${prog}\` exists only as a ${ext} shim, which the argv-only ` +
			`command seam refuses to spawn (shell:false, D-008); the exit code would describe the shim, ` +
			`not the change (UNVERIFIED, not failed)`
		);
	}
	return '';
}

/**
 * Resolve the BUILD invocation for a project, reusing the single source of truth
 * ({@link buildCommandFor}) rather than inventing a second mapping.
 *
 *   • absent build_tool            → null (honest skip — nothing to build).
 *   • a MULTI-token string         → an operator-edited real command; split it (still argv, no shell).
 *   • a BARE tool token            → MUST map through buildCommandFor(); an unknown/un-buildable tool
 *                                    ('pip') → null. We never run the bare token: `dotnet` alone
 *                                    exits 0 WITHOUT building, which is the false-green this whole
 *                                    module exists to prevent (the same reasoning as release-gate.ts).
 */
function resolveBuild(buildTool: string | null | undefined): {
	split: { file: string; args: string[] } | null;
	command: string;
	skipReason: string;
} {
	const raw = (buildTool ?? '').trim();
	if (!raw) {
		return { split: null, command: '', skipReason: 'no project build_tool declared — nothing to build' };
	}
	if (/\s/.test(raw)) {
		const split = splitCommand(raw);
		return split
			? { split, command: raw, skipReason: '' }
			: { split: null, command: raw, skipReason: `build command is unparseable: ${JSON.stringify(raw)}` };
	}
	const mapped = buildCommandFor(raw);
	if (!mapped) {
		return {
			split: null,
			command: '',
			skipReason: `build_tool "${raw}" has no known real build command (unknown/un-buildable) — not run`
		};
	}
	return { split: mapped, command: `${mapped.file} ${mapped.args.join(' ')}`.trim(), skipReason: '' };
}

/** Resolve an `npm run <script>` step, but only for an npm-family project that declares it. */
function resolveNpmScript(
	buildTool: string | null | undefined,
	cwd: string,
	script: string
): { command: string; skipReason: string } {
	const tool = (buildTool ?? '').trim().toLowerCase();
	// Only claim a lint/typecheck opinion for an npm project. Every other ecosystem has no single
	// standard invocation, and guessing one would produce a false RED on the first run.
	if (!tool.startsWith('npm')) {
		return { command: '', skipReason: `no ${script} step for build_tool ${tool || '(none)'} — not run` };
	}
	const cmd = npmScriptCommandFor(cwd, script);
	return cmd
		? { command: cmd, skipReason: '' }
		: { command: '', skipReason: `package.json declares no "${script}" script — not run` };
}

/**
 * Run the pre-commit gate in `cwd` and return an honest {@link GateOutcome}.
 *
 * NEVER THROWS. Every failure mode — an unresolvable command, a non-zero exit, a runner that
 * rejects, a cwd that does not exist — is converted into a NAMED step detail. A gate that could
 * crash the drain would be a worse defect than the one it fixes (F-014/F-048).
 *
 * STOPS AT THE FIRST FAILING STEP. The first red is the actionable one, and continuing would burn
 * minutes of an autonomous session's wall clock re-confirming a known-broken tree (mirrors
 * release-gate.ts's halt-at-first-red). Steps after the failure are recorded as not-run with that
 * reason, so the record stays complete rather than truncated.
 *
 * IDEMPOTENT / RE-RUNNABLE (interrupt contract): the gate only READS the tree and spawns
 * already-idempotent build/test commands. A gate killed mid-run leaves no state of its own, and a
 * re-run simply re-derives the same verdict from the same tree.
 */
export async function runPreCommitGate(
	input: PreCommitGateInput,
	opts: PreCommitGateOptions = {}
): Promise<GateOutcome> {
	const run = opts.run ?? execFileRunner;
	const wanted = new Set<GateStepName>(opts.steps ?? GATE_STEP_NAMES);
	const steps: GateStep[] = [];
	let failedAt: GateStepName | null = null;
	let errored = false;

	const cwd = (input.cwd ?? '').trim();
	if (!cwd || !existsSync(cwd)) {
		// NIL shadow path. We refuse to run ANY command in an unknown cwd (never the dashboard's own
		// cwd — that would gate the wrong repo). Honest skip, not a failure: there is nothing here we
		// can truthfully call red, and the caller's commit/merge decision is unchanged by a skip.
		return {
			status: 'skipped',
			verified: false,
			errored: false,
			steps: [],
			failedAt: null,
			// SCREENED (D-026): a worktree path is a home path — PII — and this summary is persisted.
			summary: cwd
				? `pre-commit gate skipped: working dir not found on disk (${screened(cwd)})`
				: 'pre-commit gate skipped: no working dir'
		};
	}

	/** Resolve one step to a runnable command, or a named skip reason. */
	const resolve = (name: GateStepName): { split: { file: string; args: string[] } | null; command: string; skipReason: string } => {
		if (name === 'build') return resolveBuild(input.buildTool);
		if (name === 'test') {
			const cmd = (input.testCommand ?? '').trim();
			if (!cmd) {
				return { split: null, command: '', skipReason: 'no resolved test target — not run (HB-2 honest skip)' };
			}
			const split = splitCommand(cmd);
			return split
				? { split, command: cmd, skipReason: '' }
				: { split: null, command: cmd, skipReason: `test command is unparseable: ${JSON.stringify(cmd)}` };
		}
		const { command, skipReason } = resolveNpmScript(input.buildTool, cwd, name);
		if (!command) return { split: null, command: '', skipReason };
		const split = splitCommand(command);
		return split ? { split, command, skipReason: '' } : { split: null, command, skipReason: 'unparseable' };
	};

	for (const name of GATE_STEP_NAMES) {
		if (!wanted.has(name)) {
			steps.push({ name, command: '', ran: false, ok: false, detail: 'not part of the configured gate' });
			continue;
		}
		if (failedAt) {
			// Recorded, not silently dropped: the operator sees the full ordered gate, and WHY the
			// later steps carry no verdict.
			steps.push({
				name,
				command: '',
				ran: false,
				ok: false,
				detail: `not run — the gate stopped at the failing ${failedAt} step`
			});
			continue;
		}
		const { split, command, skipReason } = resolve(name);
		if (!split) {
			steps.push({ name, command, ran: false, ok: false, detail: skipReason || 'not run' });
			continue;
		}
		// The step RESOLVED, but can it truthfully be run HERE? An npm-family command in a worktree
		// with no installed dependency tree exits non-zero for a reason that has nothing to do with
		// the agent's change — recording that as RED is the false-RED wedge (see the header).
		const preflight = toolchainSkipReason(cwd, split.file, run === execFileRunner);
		if (preflight) {
			steps.push({ name, command, ran: false, ok: false, detail: `${command} ${preflight}` });
			continue;
		}
		try {
			const res = await run(split.file, split.args, { cwd });
			const out = tail(res.stderr || res.stdout);
			const ok = res.code === 0;
			steps.push({
				name,
				command,
				ran: true,
				ok,
				code: res.code,
				detail: `${command} exited ${res.code}${out ? `: ${out}` : ''}`
			});
			if (!ok) failedAt = name;
		} catch (err) {
			// UPSTREAM-ERROR shadow path: the program is not on PATH, the cwd vanished, the runner
			// rejected. We could not VERIFY, so we do not claim we did — this is a red gate with
			// `errored` set so the caller can tell "your code is broken" from "we couldn't check".
			errored = true;
			failedAt = name;
			steps.push({
				name,
				command,
				ran: false,
				ok: false,
				// SCREENED (D-026): a spawn rejection embeds the absolute cwd (home-path PII) and can
				// carry environment text — and this string is persisted onto the completion event.
				detail: `${command} could not run: ${screened((err as Error).message)}`
			});
		}
	}

	const verified = steps.some((s) => s.ran);
	const status: GateStatus = failedAt ? 'failed' : verified ? 'passed' : 'skipped';
	const ranNames = steps.filter((s) => s.ran).map((s) => s.name);

	const summary = failedAt
		? errored
			? `pre-commit gate COULD NOT RUN the ${failedAt} step — treated as RED (work preserved, not merged): ` +
				`${steps.find((s) => s.name === failedAt)?.detail ?? ''}`
			: `pre-commit gate FAILED at ${failedAt}: ${steps.find((s) => s.name === failedAt)?.detail ?? ''}`
		: verified
			? `pre-commit gate passed (${ranNames.join(', ')})`
			: `pre-commit gate skipped: no build/lint/typecheck/test target detected — the change is UNVERIFIED ` +
				`(${steps.map((s) => `${s.name}: ${s.detail}`).join('; ')})`;

	return { status, verified, errored, steps, failedAt, summary };
}
