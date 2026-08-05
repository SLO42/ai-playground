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
// AND THAT SECOND MEMBER IS NOT ABOUT npm (the follow-on review's finding, closed here). The
// mechanism is `execFileRunner`'s: a spawn ENOENT for ANY program comes back as `{code:1, stdout:'',
// stderr:''}` — re-verified by running it. So a `cargo`/`go`/`dotnet` project on a host WITHOUT that
// SDK got a RED gate with an empty reason, landed every task `failed`, and preserved every branch
// unmerged — the identical wedge, found only because npm was the ecosystem that happened to be
// looked at. The spawnability pre-flight therefore asks its question of EVERY program, not just the
// npm family; only the `node_modules`/`package.json` checks stay npm-shaped. A program that IS
// spawnable and exits non-zero is still a genuine RED, in every ecosystem.
//
// NOTE WHAT THIS DELIBERATELY DOES *NOT* DO: it does not install anything, and it does not turn on
// a shell. Provisioning a worktree with dependencies (an `npm ci`, or a linked/shared
// `node_modules`) is a new capability with its own cost, cache-sharing and F-052 concurrency
// questions; spawning through a shell to reach a `.cmd` trades this false RED for a command-
// injection surface (D-008) and is a SECURITY decision. Both are NAMED here as the follow-up work
// that would make this gate genuinely verify a JS worktree, and neither is decided by this fix.
// Until they exist the composition is still safe rather than silent: the gate reports 'skipped'
// (UNVERIFIED) and says WHY on every step, and the completion event + drain ledger carry the whole
// record.
//
// AND THE ONE THING THAT SKIP MUST NOT DO — the follow-on DoD-review's finding, closed here.
// 'skipped' is now reachable for TWO different reasons, and they are not interchangeable:
//   (a) the project declares NOTHING to check — no build/lint/typecheck/test target at all;
//   (b) the project DOES declare checks and THIS working dir could not run them (the two cases
//       above: no dependency tree, un-spawnable `.cmd` shim).
// The merge-hold policy `holdMergeBack:'unverified'` (boot.ts) was written against (a) alone — a
// change with neither a gate nor a review behind it does not silently land. Once (b) started
// producing the same status value, every large change on every npm project became a PERMANENT hold
// (no automated reviewer exists to release it), which is precisely the "cannot stall a healthy
// project" invariant the arming site promises. So the outcome now carries {@link
// GateOutcome.unrunnable} to keep the two apart, and the policy keys on it.
//
// SHADOW PATHS (all four built + tested): happy (steps run, all green) · nil (no cwd / no
// buildTool / no testCommand → skipped) · empty (a resolvable tool whose scripts are absent →
// skipped) · upstream error (a step exits non-zero → failed; the runner THROWS → failed+errored).
//
// D-008: every step is run through the {@link CommandRunner} seam with an ARGUMENT ARRAY, never a
// shell string, so a project-configured command can never smuggle a second command.

import { existsSync } from 'node:fs';
import { basename, delimiter, dirname, extname, join, resolve } from 'node:path';
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
	/**
	 * True when at least one step RESOLVED to a real command that this working dir could not
	 * exercise — the toolchain pre-flight fired (no dependency tree / no manifest / a program the
	 * argv-only seam cannot spawn). It separates the two reasons `status` can be 'skipped':
	 *
	 *   • `unrunnable:false` — there was NOTHING to verify: the project declares no build/lint/
	 *     typecheck/test target. Nobody can check this change, here or anywhere.
	 *   • `unrunnable:true`  — the project DOES declare real checks; THIS environment could not run
	 *     them. Equally unverified, but it is a statement about the working dir, not the project.
	 *
	 * Consumers must not conflate them: `holdMergeBack:'unverified'` (orchestrator.ts
	 * ReviewHoldPolicy) withholds a merge on the first and NOT on the second, because the
	 * second is every healthy npm project on this platform and the hold has no automated release.
	 */
	unrunnable: boolean;
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
 * Is this file something the argv-only seam CANNOT spawn on this platform?
 *
 * `.cmd`/`.bat`/`.ps1` are Windows-only artefacts and are never spawnable without a shell. `.sh` is
 * the platform-conditional one, and it is measured rather than assumed: on win32 `execFile('./x.sh',
 * …, {shell:false})` rejects with `spawn EFTYPE` (reproduced against this host before the fix), so
 * an operator's `./scripts/test.sh --ci` is not a verdict on the change; on a POSIX host the same
 * file with a shebang and the exec bit is a perfectly good argv target and skipping it would be a
 * NEW false skip — exactly what this module must not invent.
 */
function isShellOnly(ext: string): boolean {
	const e = ext.toLowerCase();
	return SHELL_ONLY_EXT.has(e) || (process.platform === 'win32' && e === '.sh');
}

/**
 * Where the argv-only runner would find `prog` among `dirs`, or null. Mirrors what `execFile` with
 * `shell:false` does: a literal name scan, extended by PATHEXT on Windows. We resolve it ourselves
 * because the runner cannot report the difference — `execFile` surfaces a spawn ENOENT as exit
 * code 1 with EMPTY output, which the gate would otherwise record as a build failure with no
 * reason at all.
 *
 * Two callers, ONE scan (F-055 — never a second hand-rolled resolver): {@link resolveOnPath} asks
 * it of PATH for a bare program name, and the explicit-path branch of {@link toolchainSkipReason}
 * asks it of the single directory execFile would actually resolve that path against.
 */
function probeIn(dirs: readonly string[], prog: string): string | null {
	// On Windows a name WITHOUT an extension is executable only via PATHEXT: `C:\Program
	// Files\nodejs\npm` (the extension-less POSIX shell script npm also ships) sits right next to
	// `npm.cmd` on PATH, and probing for the bare name first is how a scan can "find" npm and still
	// be unable to spawn it — so the bare name is deliberately NOT a candidate there. A name that
	// already CARRIES an extension (`node.exe`, `npm.cmd`) is probed literally, or we would look for
	// `node.exe.exe` and wrongly report a present program as missing. Elsewhere the name is the file.
	const exts =
		process.platform === 'win32' && extname(prog) === ''
			? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
			: [''];
	for (const dir of dirs) {
		for (const ext of exts) {
			const candidate = join(dir, prog + ext.toLowerCase());
			if (existsSync(candidate)) return candidate;
		}
	}
	return null;
}

/** {@link probeIn} over PATH — what the seam would find for a BARE program name. */
function resolveOnPath(prog: string): string | null {
	return probeIn((process.env.PATH ?? '').split(delimiter).filter(Boolean), prog);
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
 *  3. THE PROGRAM IS NOT SPAWNABLE BY THIS SEAM — checked for EVERY ecosystem, not just npm (see
 *     below), and only when the DEFAULT argv-only runner is in use (`argvOnly`; an injected runner
 *     has its own spawn rules and this must not speak for it). On Windows `npm`/`npx`/`pnpm`/`yarn`
 *     exist only as `.cmd` shims, and {@link execFileRunner} is `shell:false` for D-008 (argv is
 *     never re-parsed by a shell). Verified against the live runtime: `execFile('npm', …,
 *     {shell:false})` fails ENOENT — which this seam reports as exit code 1 with EMPTY
 *     stdout/stderr — and `npm.cmd` throws EINVAL outright (Node refuses to spawn a batch file
 *     without a shell). So on Windows EVERY npm step was an unexplained RED: not the agent's code,
 *     and not even a real run. The gate says so instead of inventing a verdict. Turning on
 *     `shell:true` to "fix" this would trade a false RED for a command-injection surface (D-008) —
 *     that is a security decision, not a bug fix, and it is NOT taken here; it is named as
 *     follow-up work alongside the dependency provisioning in the header.
 *
 * WHY (3) IS NOT NPM-ONLY (the follow-on review's finding). The npm/`.cmd` story is one INSTANCE of
 * a mechanism that has nothing to do with npm: `execFileRunner` reports a spawn ENOENT as
 * `{code:1, stdout:'', stderr:''}` for ANY program (re-verified by execution: spawning a
 * non-existent program returns exactly that). So a project whose `build_tool` is `cargo`/`go`/
 * `dotnet` on a host where that SDK is NOT INSTALLED produced a RED gate with an empty reason —
 * the task landed `failed`, its branch was preserved and never merged, and the record blamed the
 * agent's change for the absence of a toolchain. That is the same false-RED wedge that closing the
 * npm case was about, wearing a different ecosystem's clothes; it just needed a host without the
 * SDK to show it. The spawnability question ("would this argv-only seam find this program at all?")
 * is answerable for every program with the SAME PATH scan, so it is asked for every program.
 *
 * Still deliberately NARROW where narrowness is right: we do NOT guess at an ecosystem's inner
 * health (an installed-but-broken SDK, a missing workspace file). Only two things are claimed, and
 * both are FACTS about the host rather than opinions: the program is not on PATH at all, or it is
 * on PATH exclusively in a form this seam cannot spawn. A program that IS spawnable and exits
 * non-zero remains a genuine RED, in every ecosystem.
 *
 * The dependency-tree checks (1) and (2) stay npm-family-only — `node_modules` is an npm-shaped
 * fact and asking it of `dotnet` would mean nothing.
 */
function toolchainSkipReason(cwd: string, file: string, argvOnly: boolean): string {
	// A resolution can hand us `npm.cmd` / an absolute path; compare on the bare program name.
	const prog = basename(file).replace(/\.(cmd|exe|bat|ps1)$/i, '').toLowerCase();
	if (NPM_FAMILY.has(prog)) {
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
	}
	if (!argvOnly) return '';
	// An EXPLICIT path (`./scripts/check.sh`, `C:\tools\build.exe`) is not a PATH lookup at all —
	// execFile resolves it against the cwd — so PATH is the wrong place to ask about it, and
	// probing PATH for its basename would invent a "not on PATH" skip for a command that runs
	// perfectly well.
	//
	// BUT "don't ask PATH" is not "don't ask anything" (the follow-on DoD-review's finding, closed
	// here). Returning '' here skipped the WHOLE pre-flight for an explicit path, including the
	// spawnability question, which is a fact about the FILE and not about how it was named — so the
	// exemption REOPENED the very false-RED class this module exists to close. Both halves were
	// reproduced by execution against the real default runner before this fix:
	//   • a real `./probe.cmd` that a shell runs fine → `spawn EINVAL` → status 'failed',
	//     errored:true, "COULD NOT RUN … treated as RED" — task `failed`, branch preserved, never
	//     merged, on a host where `.cmd` is how operators write a check;
	//   • an explicit path that is simply ABSENT → the seam's `{code:1, stdout:'', stderr:''}` →
	//     a RED with no reason at all, the exact signature the PATH probe exists to convert into an
	//     honest skip.
	// It is reachable in production because `resolveTestCommand` (post-task.ts) returns an
	// operator's stored `test_command` VERBATIM for any build_tool the resolver has no opinion on,
	// and it was a REGRESSION for the npm family too: an explicit `…\npm.cmd run build` used to
	// reach the shim skip via the PATH probe and was exempted straight back into an EINVAL RED.
	// So: ask the same two questions, against the one directory execFile would actually resolve
	// against. `resolve` handles both the relative (`./x`) and the absolute form.
	if (/[\\/]/.test(file)) {
		const abs = resolve(cwd, file);
		const found = probeIn([dirname(abs)], basename(abs));
		if (!found) {
			return (
				`not run — \`${file}\` does not exist in this working dir, so this check cannot be ` +
				`performed here; the seam reports an unspawnable path as exit 1 with NO output, which ` +
				`would read as a broken change rather than a missing script (UNVERIFIED, not failed)`
			);
		}
		const explicitExt = extname(found).toLowerCase();
		if (isShellOnly(explicitExt)) {
			return (
				`not run — \`${file}\` is a ${explicitExt} script, which the argv-only command seam refuses ` +
				`to spawn on this platform (shell:false, D-008); the spawn error would describe the seam, ` +
				`not the change (UNVERIFIED, not failed)`
			);
		}
		return '';
	}
	// Probe the name AS WRITTEN (`node`, `node.exe`) — resolveOnPath handles the extension rules.
	const name = basename(file);
	const resolved = resolveOnPath(name);
	if (!resolved) {
		return (
			`not run — \`${name}\` is not on PATH for this server process, so this check cannot be ` +
			`performed here; the seam reports an unspawnable program as exit 1 with NO output, which ` +
			`would read as a broken change rather than a missing toolchain (UNVERIFIED, not failed)`
		);
	}
	const ext = extname(resolved).toLowerCase();
	if (isShellOnly(ext)) {
		return (
			`not run — on this platform \`${name}\` exists only as a ${ext} shim, which the argv-only ` +
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
	/** Set by the toolchain pre-flight — see {@link GateOutcome.unrunnable}. */
	let unrunnable = false;
	/** WHICH steps the pre-flight refused, so the summary can NAME them (see below). */
	const unrunnableNames: GateStepName[] = [];

	const cwd = (input.cwd ?? '').trim();
	if (!cwd || !existsSync(cwd)) {
		// NIL shadow path. We refuse to run ANY command in an unknown cwd (never the dashboard's own
		// cwd — that would gate the wrong repo). Honest skip, not a failure: there is nothing here we
		// can truthfully call red, and the caller's commit/merge decision is unchanged by a skip.
		return {
			status: 'skipped',
			verified: false,
			errored: false,
			// Nothing RESOLVED here at all — we never got as far as asking whether a real command
			// could run, so this is the "nothing to verify" skip, not the environment one.
			unrunnable: false,
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
			// The step resolved to a REAL command we chose not to run here. That is the environment
			// skip, and it is recorded as such: a downstream policy that treats "nothing to check" and
			// "could not check here" alike turns this into a permanent merge hold (see the header).
			unrunnable = true;
			unrunnableNames.push(name);
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
			? unrunnable
				? // PARTLY VERIFIED — the honesty half the follow-on DoD-review caught missing. When some
					// steps ran green and at least one DECLARED check could not be run here, `pre-commit gate
					// passed (build)` is the whole operator-facing sentence on the completion event
					// (post-task.ts persists `gate.summary` verbatim) and on the drain ledger, and it says
					// nothing about the check that never ran. The gate_consequence field had been taught this
					// distinction; the summary had not, so the flat claim was still the line an operator
					// reads. Same rule as everywhere else in this module: never overstate what was checked.
					`pre-commit gate PARTLY verified — passed (${ranNames.join(', ')}), but ` +
					`${unrunnableNames.length} declared check(s) could NOT BE RUN in this working dir ` +
					`(${unrunnableNames.join(', ')}); the work is eligible to merge but is NOT fully verified`
				: `pre-commit gate passed (${ranNames.join(', ')})`
			: unrunnable
				? // HONEST (F-008): saying "no target detected" about a project that declares four of
					// them is a lie the operator would read on /atelier/queue.
					`pre-commit gate skipped: the project's checks could NOT BE RUN in this working dir — the change ` +
					`is UNVERIFIED here, which describes the environment, not the change ` +
					`(${steps.map((s) => `${s.name}: ${s.detail}`).join('; ')})`
				: `pre-commit gate skipped: no build/lint/typecheck/test target detected — the change is UNVERIFIED ` +
					`(${steps.map((s) => `${s.name}: ${s.detail}`).join('; ')})`;

	return { status, verified, errored, unrunnable, steps, failedAt, summary };
}
