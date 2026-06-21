// PMA — the OBJECTIVE RELEASE-READINESS GATE + the consented auto-publish hand-off.
//
// THE OPERATOR OVERRIDE (explicit, durable): a project created via Create-with-AI may drive FULLY
// hands-off all the way to its FIRST release INCLUDING the public publish — but ONLY safely. This
// module is the "only safely" half. The autonomous loop (pm-autonomous.ts #reachDod) calls
// `runReleaseReadinessGate` when, AND ONLY when, the project's PM has the operator's RECORDED consent
// (pm.auto_publish_preauthorized). The gate then makes the publish decision on OBJECTIVE, MACHINE-
// VERIFIED facts — real exit codes, never a "PM says it's done" vibe (F-008):
//
//   (a) CONSENT  — the operator's recorded auto_publish_preauthorized (read by the caller; re-asserted
//                  here as a hard precondition so this module can never publish without it).
//   (b) TARGET   — the project must have a DECLARED default publish target (D-037). No target ⇒ halt.
//   (c) TOKEN    — the publish adapter's required secret must be present (D-026 presence only). The
//                  build/pack/validate still run (honest preflight), but with no credential we CANNOT
//                  perform a real publish, so we halt at the gate (never a half-publish).
//   (d) BUILD    — the project's own build command is EXECUTED (execFile array, no shell — D-008) in
//                  the project root; a non-zero exit is a RED gate. No build command ⇒ halt honestly
//                  (we will not publish an unbuilt artifact).
//   (e) PACK     — the adapter's package() (the existing Thunderstore pack seam) must produce the
//                  artifact ok:true. A pack failure is RED.
//   (f) VALIDATE — the adapter's validate() (the existing Thunderstore validate seam) must be ok:true
//                  against the manifest. A validate failure is RED.
//
// ONLY when (a)…(f) are ALL green does the gate proceed through the EXISTING D-037 publish path
// (runTargetAction, dryRun:false, with the deterministically-derived confirm token). It NEVER hand-
// rolls a publish, NEVER bypasses the driver's gate/recording/incident machinery, and publishes ONLY
// the project's OWN declared target (resolveTarget inside runTargetAction binds project↔target↔adapter).
//
// On ANY red — no consent / no target / no token / build red / pack red / validate red / a publish that
// did not complete — the gate returns published:false with the EXACT failing reasons surfaced honestly,
// and the caller HALTS at 'awaiting-release-confirm' for the operator's tap. It never spins, never
// retries (F-014), and never auto-hires (D-039 — a capability wall is the caller's concern, not here).
//
// SHADOW PATHS (built + tested): no consent (precondition false), no declared target (resolve null),
// no token (presence false), build command absent/empty (nil), build non-zero (upstream error), pack
// red, validate red, the publish run returning ok:false. EVERY one has a NAMED reason in the result.
//
// TEST SEAMS (NO real publish, NO real build in tests): `runCommand` (the build exec) and `runPublish`
// (the D-037 driver call) are injectable. Production omits them → the real execFileRunner + the real
// runTargetAction are used. The adapter pack/validate run against the real (or a stubbed) adapter.

import type { Db } from '../db/client';
import { getProject } from './repo';
import { resolveDefaultTarget, type ProjectTargetRow } from '../adapters/registry';
import { getAdapterRegistry } from '../adapters/index';
import { resolverForAdapter, type EnvLike } from '../adapters/secrets';
import {
	confirmTokenFor,
	runTargetAction,
	type RunTargetActionResult
} from '../adapters/driver';
import { execFileRunner, splitCommand, type CommandRunner } from '../orchestrator/post-task';
import { buildCommandFor } from '../scanner/detect';
import { existsSync } from 'node:fs';

/** The objective sub-checks a gate ran, each with its honest pass/fail + a one-line reason (F-008). */
export interface ReleaseGateCheck {
	/** The named check: consent | target | token | build | pack | validate | publish. */
	name: 'consent' | 'target' | 'token' | 'build' | 'pack' | 'validate' | 'publish';
	ok: boolean;
	/** Honest human-readable detail (an exit code, a blocker list, a missing-secret name — never a vibe). */
	detail: string;
}

/** The gate's verdict. `published` is true ONLY when EVERY check passed and the real publish completed. */
export interface ReleaseGateResult {
	/** True iff the real publish ran AND completed ok. False on ANY red (the caller then halts). */
	published: boolean;
	/** The ordered checks the gate ran (it stops at the first red — later checks are not attempted). */
	checks: ReleaseGateCheck[];
	/** The first failing check's name when not published (null when published). */
	failedAt: ReleaseGateCheck['name'] | null;
	/** A single honest summary line for the loop's stop reason (F-008). */
	summary: string;
	/** The driver result when a real publish was attempted (null when we halted before publish). */
	publish: RunTargetActionResult | null;
}

export interface ReleaseGateInput {
	db: Db;
	/** Runtime env ($env/dynamic/private) the confined resolver reads the publish secret from (D-026). */
	env: EnvLike;
	projectId: string;
	/**
	 * The operator's RECORDED consent (pm.auto_publish_preauthorized). The caller reads it and passes it;
	 * the gate RE-ASSERTS it as a hard precondition — a false/absent value can NEVER publish (integrity).
	 */
	consent: boolean;
	/** Build-exec seam (tests inject a scripted runner — NO real build). Defaults to execFileRunner. */
	runCommand?: CommandRunner;
	/**
	 * Publish seam (tests inject a stub — NO real upload). Defaults to the real D-037 runTargetAction.
	 * It is handed the SAME (project, target, confirmToken) the production driver would compute, so the
	 * stub can assert the loop drives the EXISTING gated path with a VALID token (not a hand-rolled push).
	 */
	runPublish?: (args: {
		db: Db;
		env: EnvLike;
		projectId: string;
		cwd: string;
		targetId: string;
		confirmToken: string;
	}) => Promise<RunTargetActionResult>;
}

/** Build a single honest check row. */
function check(name: ReleaseGateCheck['name'], ok: boolean, detail: string): ReleaseGateCheck {
	return { name, ok, detail };
}

/** A short, single-line tail of command output for an honest-but-bounded detail (never the whole log). */
function tail(text: string, max = 240): string {
	const oneLine = text.replace(/\s+/g, ' ').trim();
	if (!oneLine) return '';
	return oneLine.length > max ? `…${oneLine.slice(oneLine.length - max)}` : oneLine;
}

/**
 * Run the OBJECTIVE release-readiness gate and, only if ALL checks pass, perform the real publish
 * through the EXISTING D-037 path. Returns an honest verdict — `published` is true ONLY when the gate
 * was fully green AND the real publish completed ok. Never throws for an expected red (a missing target,
 * a non-zero build, a pack/validate blocker) — those are honest `published:false` results with a named
 * `failedAt`. It DOES surface an unexpected internal fault (an adapter throw) as a red publish/validate
 * check rather than crashing the loop.
 */
export async function runReleaseReadinessGate(input: ReleaseGateInput): Promise<ReleaseGateResult> {
	const checks: ReleaseGateCheck[] = [];
	const halt = (failedAt: ReleaseGateCheck['name'], summary: string): ReleaseGateResult => ({
		published: false,
		checks,
		failedAt,
		summary,
		publish: null
	});

	// (a) CONSENT — the hard precondition. A false/absent consent can NEVER publish (re-asserted here so
	// this module is safe even if a future caller forgets the check). No spend, no build, no publish.
	if (input.consent !== true) {
		checks.push(check('consent', false, 'no recorded auto-publish consent (auto_publish_preauthorized is false/absent)'));
		return halt('consent', 'auto-publish is not pre-authorized for this project — halting at the operator publish gate');
	}
	checks.push(check('consent', true, 'auto_publish_preauthorized is recorded for this project'));

	// The project must exist + expose its root (the build cwd) — a missing project is a hard, named stop.
	const project = await getProject(input.db, input.projectId).catch(() => null);
	if (!project) {
		checks.push(check('target', false, 'project not found'));
		return halt('target', 'the project row could not be read — halting (no publish)');
	}
	const cwd = (project.root_path ?? '').trim();

	// (b) TARGET — the project's DECLARED default publish target (D-037). No target ⇒ halt honestly.
	let target: ProjectTargetRow | null = null;
	try {
		target = await resolveDefaultTarget(input.db, input.projectId, 'publish');
	} catch (err) {
		checks.push(check('target', false, `resolving the publish target failed: ${(err as Error).message}`));
		return halt('target', 'could not resolve a declared publish target — halting (no publish)');
	}
	if (!target) {
		checks.push(check('target', false, 'no default publish target declared for this project (D-037)'));
		return halt('target', 'no publish target is declared — declare one, then re-arm (halting, no publish)');
	}
	checks.push(check('target', true, `publish target: ${target.label} (${target.adapter_id})`));

	// Resolve the adapter — an UNKNOWN adapter id fails CLOSED (D-037). A confined resolver gives the
	// adapter ONLY its declared secrets (D-026); we use it for the token-presence check + pack/validate.
	const registry = getAdapterRegistry();
	let adapter;
	try {
		adapter = registry.getPublisher(target.adapter_id);
	} catch (err) {
		checks.push(check('target', false, `unknown publish adapter "${target.adapter_id}": ${(err as Error).message}`));
		return halt('target', `the declared publish adapter is unknown — halting (no publish)`);
	}
	const secrets = resolverForAdapter(input.env, adapter);

	// (c) TOKEN — every REQUIRED secret the adapter declares must be present (presence only — D-026). With
	// no credential a real publish cannot run, so we halt HERE (after recording the honest reason) — we
	// never attempt a publish we know will fail-closed, and we never half-publish.
	const requiredSecrets = adapter.secrets().filter((s) => s.required);
	const missing = requiredSecrets.filter((s) => !secrets.has(s.envVar)).map((s) => s.envVar);
	if (missing.length > 0) {
		checks.push(check('token', false, `required secret(s) not set: ${missing.join(', ')}`));
		return halt('token', `the publish credential is not set (${missing.join(', ')}) — halting (no publish)`);
	}
	checks.push(check('token', true, requiredSecrets.length ? `required secret(s) present: ${requiredSecrets.map((s) => s.envVar).join(', ')}` : 'adapter requires no secret'));

	// (d) BUILD — EXECUTE a REAL build of the project (real exit code, D-008 array, no shell). Two FAIL-
	// CLOSED preconditions first, then a REAL build INVOCATION resolved from the project's build tool.
	//
	// (d.0) ROOT — the build MUST run in the project's own root. An empty/absent root_path, or one that no
	// longer exists on disk, is a RED build: we NEVER run the build in the dashboard cwd (that would compile
	// the wrong thing and could false-GREEN). FAIL CLOSED, honest reason (LOW hole closed).
	if (!cwd) {
		checks.push(check('build', false, 'project root_path is missing/empty — refusing to build in the dashboard cwd'));
		return halt('build', 'the project root_path is missing — halting (cannot build the project safely, no publish)');
	}
	if (!existsSync(cwd)) {
		checks.push(check('build', false, `project root_path not found on disk: ${cwd}`));
		return halt('build', 'the project root_path was not found on disk — halting (cannot build, no publish)');
	}

	// (d.1) COMMAND — resolve a REAL build invocation. `project.build_tool` is a BARE detected tool name
	// (scanner detect.ts: 'dotnet'/'npm'/'cargo'/…), and a bare `dotnet` EXITS 0 WITHOUT BUILDING — a false
	// GREEN that would publish an unbuilt artifact. So a bare tool token is mapped through buildCommandFor()
	// (the single source of truth) to its real build command (e.g. dotnet→`dotnet build -c Release`). An
	// UNKNOWN / un-buildable tool (e.g. 'pip') maps to null ⇒ FAIL CLOSED (RED), never silently green.
	//   • build_tool absent  → fall back to test_command (last-resort real compile/run) or, absent that, RED.
	//   • build_tool a SINGLE bare token → MUST map via buildCommandFor() or RED (no bare-tool-as-command).
	//   • build_tool a MULTI-token string (operator-edited, e.g. "npm run build") → already a real command.
	const buildToolRaw = (project.build_tool ?? '').trim();
	const testCommandRaw = (project.test_command ?? '').trim();
	let split: { file: string; args: string[] } | null;
	if (!buildToolRaw) {
		// No build tool detected/declared. The test_command is the only real compile/run we have.
		if (!testCommandRaw) {
			checks.push(check('build', false, 'no build command declared (project.build_tool / test_command absent)'));
			return halt('build', 'no project build command is declared — halting (cannot verify the build, no publish)');
		}
		split = splitCommand(testCommandRaw);
	} else if (/\s/.test(buildToolRaw)) {
		// Already a multi-token real command (operator-edited). Run it as-is (still execFile array, no shell).
		split = splitCommand(buildToolRaw);
	} else {
		// A BARE tool token — it MUST map to a real build invocation, or we FAIL CLOSED. We do NOT run the
		// bare token (it would no-op-exit-0) and we do NOT fall through to test_command (that would mask an
		// un-buildable tool as green): an un-mappable build_tool is an honest RED.
		const mapped = buildCommandFor(buildToolRaw);
		if (!mapped) {
			checks.push(check('build', false, `build_tool "${buildToolRaw}" has no known real build command (un-buildable/unknown) — refusing to publish an unverified artifact`));
			return halt('build', `the project build tool (${buildToolRaw}) has no real build command — halting (cannot verify the build, no publish)`);
		}
		split = mapped;
	}
	if (!split) {
		checks.push(check('build', false, `build command is empty/unparseable: ${JSON.stringify(buildToolRaw || testCommandRaw)}`));
		return halt('build', 'the project build command is unparseable — halting (no publish)');
	}
	const run = input.runCommand ?? execFileRunner;
	let buildCode: number | null;
	let buildTail: string;
	try {
		const res = await run(split.file, split.args, { cwd });
		buildCode = res.code;
		buildTail = tail(res.stderr || res.stdout);
	} catch (err) {
		// A spawn failure (the program is not on PATH, the cwd is gone) is a RED build, named — not a throw.
		checks.push(check('build', false, `build could not run: ${(err as Error).message}`));
		return halt('build', `the project build could not run (${(err as Error).message}) — halting (no publish)`);
	}
	if (buildCode !== 0) {
		checks.push(check('build', false, `build exited ${buildCode}${buildTail ? `: ${buildTail}` : ''}`));
		return halt('build', `the project build FAILED (exit ${buildCode}) — halting (no publish)`);
	}
	checks.push(check('build', true, `build passed (exit 0)${buildTail ? `: ${buildTail}` : ''}`));

	// (e) PACK — the adapter's package() (the existing pack seam). A pack failure is RED. An adapter throw
	// is caught into a named red check (never crashes the loop).
	try {
		const pack = await adapter.package({ projectId: input.projectId, cwd, dryRun: true, config: target.config, secrets });
		if (!pack.ok) {
			checks.push(check('pack', false, `pack failed: ${tail(pack.summary)}`));
			return halt('pack', `packing the release artifact FAILED — halting (no publish): ${tail(pack.summary)}`);
		}
		checks.push(check('pack', true, tail(pack.summary)));
	} catch (err) {
		checks.push(check('pack', false, `pack threw: ${(err as Error).message}`));
		return halt('pack', `packing the release artifact threw (${(err as Error).message}) — halting (no publish)`);
	}

	// (f) VALIDATE — the adapter's validate() (the existing validate seam) must be ok:true against the
	// manifest. A validate blocker is RED. This closes the "build green but validate skipped" gap: pack and
	// validate BOTH run and BOTH must pass before any publish.
	try {
		const validation = await adapter.validate({ projectId: input.projectId, cwd, dryRun: true, config: target.config, secrets });
		if (!validation.ok) {
			const blockers = validation.blockers.length ? validation.blockers.join('; ') : 'unspecified validation blocker';
			checks.push(check('validate', false, `validate failed: ${tail(blockers)}`));
			return halt('validate', `the release artifact did NOT validate — halting (no publish): ${tail(blockers)}`);
		}
		checks.push(check('validate', true, 'manifest + artifact validate ok'));
	} catch (err) {
		checks.push(check('validate', false, `validate threw: ${(err as Error).message}`));
		return halt('validate', `validating the release artifact threw (${(err as Error).message}) — halting (no publish)`);
	}

	// ALL GREEN → proceed through the EXISTING D-037 publish path. We derive the SAME confirm token the
	// dry-run/confirm ceremony would compute (deterministic over project|kind|adapter|config) so the
	// driver's gate passes for THIS target only — a token from another target/config cannot confirm here.
	const confirmToken = confirmTokenFor({
		projectId: input.projectId,
		kind: 'publish',
		adapterId: target.adapter_id,
		config: target.config
	});
	const publishFn = input.runPublish ?? defaultRunPublish;
	let publishResult: RunTargetActionResult;
	try {
		publishResult = await publishFn({
			db: input.db,
			env: input.env,
			projectId: input.projectId,
			cwd,
			targetId: target.id,
			confirmToken
		});
	} catch (err) {
		// A publish throw (the driver raised, e.g. a stale-token GateConfirmError or an adapter fault) is a
		// RED publish — recorded honestly by the driver as a target_run + incident; surfaced here, no spin.
		checks.push(check('publish', false, `publish errored: ${(err as Error).message}`));
		return halt('publish', `the publish did NOT complete (${(err as Error).message}) — halting (no publish)`);
	}
	if (!publishResult.result.ok) {
		checks.push(check('publish', false, `publish did not complete: ${tail(publishResult.result.summary)}`));
		return {
			published: false,
			checks,
			failedAt: 'publish',
			summary: `the publish did NOT complete — halting at the publish gate: ${tail(publishResult.result.summary)}`,
			publish: publishResult
		};
	}

	checks.push(check('publish', true, tail(publishResult.result.summary)));
	return {
		published: true,
		checks,
		failedAt: null,
		summary: `release-readiness gate GREEN — published ${target.label} (${target.adapter_id}): ${tail(publishResult.result.summary)}`,
		publish: publishResult
	};
}

/** The production publish leg: the EXISTING D-037 gated driver, real upload when the credential is set. */
async function defaultRunPublish(args: {
	db: Db;
	env: EnvLike;
	projectId: string;
	cwd: string;
	targetId: string;
	confirmToken: string;
}): Promise<RunTargetActionResult> {
	return runTargetAction({
		db: args.db,
		env: args.env,
		projectId: args.projectId,
		cwd: args.cwd,
		kind: 'publish',
		targetId: args.targetId,
		dryRun: false,
		confirmToken: args.confirmToken
	});
}
