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
// SHADOW PATHS (all four built + tested): happy (steps run, all green) · nil (no cwd / no
// buildTool / no testCommand → skipped) · empty (a resolvable tool whose scripts are absent →
// skipped) · upstream error (a step exits non-zero → failed; the runner THROWS → failed+errored).
//
// D-008: every step is run through the {@link CommandRunner} seam with an ARGUMENT ARRAY, never a
// shell string, so a project-configured command can never smuggle a second command.

import { existsSync } from 'node:fs';
import {
	execFileRunner,
	splitCommand,
	type CommandRunner
} from './command-runner';
import { buildCommandFor, npmScriptCommandFor } from '../scanner/detect';

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

/** A bounded, single-line tail of command output — honest but never the whole log. */
function tail(text: string, max = 240): string {
	const oneLine = text.replace(/\s+/g, ' ').trim();
	if (!oneLine) return '';
	return oneLine.length > max ? `…${oneLine.slice(oneLine.length - max)}` : oneLine;
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
			summary: cwd
				? `pre-commit gate skipped: working dir not found on disk (${cwd})`
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
				detail: `${command} could not run: ${(err as Error).message}`
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
