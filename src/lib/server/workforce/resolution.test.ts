import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { StringRecordId } from 'surrealdb';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import type { WorkforceConfig } from '../config/index';
import { DEFAULT_GATE_POLICY } from '../claude-code/gates';
import {
	ClaudeCodeRuntime,
	type CanUseToolResult,
	type CcBackend,
	type CcBackendRun,
	type CcSpawnPlan,
	type RuntimeEvent
} from '../runtime/index';
import { activateGauntletFixture, newSentinelUlid } from './activation';
import { KNOWN_FAIL_PATH, KNOWN_PASS_PATH } from './scorer';
import {
	createGauntletFixture,
	createGauntletKey,
	createReviewProposal,
	createRole,
	createRoleVersion,
	getReviewProposal,
	getRole,
	getRoleVersion,
	listOpenProposals,
	swapActiveVersion,
	transitionLifecycle,
	WorkforceInputError,
	type RoleRow,
	type RoleVersionRow
} from './repo';
import {
	authorChallenger,
	buildProposalCard,
	diffLines,
	proposalDiff,
	regauntletChallenger,
	rejectProposal,
	ResolutionGateError,
	swapFromProposal
} from './resolution';
import { type GauntletDeps } from './gauntlet';

// WORKFORCE-SPEC §5 RESOLUTION — the operator-gated half, end-to-end vs a REAL throwaway
// SurrealDB + the REAL ClaudeCodeRuntime over a scripted backend (gauntlet.test.ts
// discipline: the logic is real, only the LLM is scripted). Certifies:
//   • the full proposed → author(diff) → re-gauntlet → compared → swap path activates the
//     challenger; reject closes with reason + feeds cooldown;
//   • THE GOVERNANCE RED-TEAM (the locked invariants): no swap without an operator confirm
//     AND a passing challenger gauntlet; the challenger never inherits the incumbent's cert;
//     the diff shown matches the real prompt_core delta; D-026 screens shown/stored text.

let tdb: TestDb;
let db: Db;
let wsRoot: string;
let harnessRoot: string;

function rid(id: string): StringRecordId {
	return new StringRecordId(id);
}

beforeAll(async () => {
	tdb = await startTestDb();
	db = await Db.connect({
		url: tdb.wsUrl,
		username: tdb.root.username,
		password: tdb.root.password,
		namespace: tdb.namespace,
		database: tdb.database
	});
	await runMigrations(db, schemaMigrations);
	wsRoot = mkdtempSync(join(tmpdir(), 'resolution-ws-'));
	harnessRoot = mkdtempSync(join(tmpdir(), 'resolution-harness-'));
}, 90_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
	rmSync(wsRoot, { recursive: true, force: true });
	rmSync(harnessRoot, { recursive: true, force: true });
});

function testConfig(): WorkforceConfig {
	return {
		pm: { provider: 'claude', model_id: 'claude-opus-4-8', triggers: { failure_threshold: null } },
		panel: { scope: { max_files: null, max_new_services: null } },
		gauntlet: { pass_recall: 1.0, max_false_positives: 0, session_timeout_minutes: 15 },
		budget: { max_auto_interviews_per_day: null, allowed_auto_tiers: [] },
		drift: {
			escaped_defect: true,
			operator_feedback: true,
			confidence_miscalibration: true,
			confidence_miscalibration_rate: 0.5,
			refutation_rate: null,
			fixloop_rate: null
		},
		research: { max_wall_clock_minutes: null, max_fetches: null },
		workforce: { max_open_proposals: 2, track_window_days: 14, min_events_for_claim: 5 }
	};
}

let seedCount = 0;
const MODEL = 'claude-sonnet-x';

interface RoleSeed {
	role: RoleRow;
	incumbent: RoleVersionRow;
	defectSlug: string;
}

/** Seed a role with a planted_defect + scorer_control fixture (both activated). The
 *  incumbent version is created BUT left un-certified unless `certifyIncumbent` is set. */
async function seedRole(): Promise<RoleSeed> {
	const n = ++seedCount;
	const role = await createRole(db, {
		slug: `res-host-${n}`,
		name: `Resolution Host ${n}`,
		purpose: 'resolution test bed'
	});
	const incumbent = await createRoleVersion(db, {
		role: role.id,
		prompt_core: `You are reviewer #${n}.\nHunt platform bugs.\nQuote verbatim evidence.`,
		default_tier: 'sonnet',
		source: 'operator'
	});
	const defectSlug = `fx-defect-${n}`;
	const fixture = await createGauntletFixture(db, {
		role: role.id,
		slug: defectSlug,
		kind: 'planted_defect',
		work: { 'a.ts': 'line1\nline2\nprocess.kill(pid, 0);\n' },
		sentinel: newSentinelUlid()
	});
	await createGauntletKey(db, {
		fixture: fixture.id,
		plants: [
			{
				id: 'p1',
				class: 'platform-bug',
				location: 'a.ts:3',
				severity: 'high',
				detection: { file: 'a.ts', lines: [3, 3], evidence_pattern: 'process\\.kill' }
			}
		],
		fp_tolerance: 0
	});
	await activateGauntletFixture(db, fixture.id);

	const controlSlug = `ctrl-${n}`;
	const control = await createGauntletFixture(db, {
		role: role.id,
		slug: controlSlug,
		kind: 'scorer_control',
		work: {
			'c.ts': 'l1\nl2\nconst r = eval(input);\n',
			[KNOWN_PASS_PATH]: JSON.stringify([
				{ fixture: controlSlug, file: 'c.ts', lines: [3, 3], class: 'injection', evidence: 'eval(input)' }
			]),
			[KNOWN_FAIL_PATH]: JSON.stringify([])
		},
		sentinel: newSentinelUlid()
	});
	await createGauntletKey(db, {
		fixture: control.id,
		plants: [{ id: 'c1', detection: { file: 'c.ts', lines: [3, 3], evidence_pattern: 'eval\\(' } }]
	});
	await activateGauntletFixture(db, control.id);
	return { role, incumbent, defectSlug };
}

// ── Scripted backend (writes a perfect findings.json for the seed's defect) ─────────

interface ScriptedBackend extends CcBackend {
	plans: CcSpawnPlan[];
	probes: { inside?: CanUseToolResult; outside?: CanUseToolResult };
}

function candidateBackend(defectSlug: string, write = true): ScriptedBackend {
	const plans: CcSpawnPlan[] = [];
	const probes: ScriptedBackend['probes'] = {};
	return {
		plans,
		probes,
		kind: 'mock',
		run(plan: CcSpawnPlan): CcBackendRun {
			plans.push(plan);
			return {
				ccSessionId: `cc_res_${Math.random().toString(36).slice(2, 10)}`,
				async *stream() {
					yield { type: 'log', message: 'challenger reviewing' } as RuntimeEvent;
					if (plan.canUseTool) {
						probes.inside = await plan.canUseTool('Write', { file_path: join(plan.cwd, 'findings.json') });
						probes.outside = await plan.canUseTool('Write', {
							file_path: resolve(plan.cwd, '..', '..', 'escape.txt')
						});
					}
					if (write) {
						writeFileSync(
							join(plan.cwd, 'findings.json'),
							JSON.stringify([
								{ fixture: defectSlug, file: 'a.ts', lines: [3, 3], class: 'platform-bug', evidence: 'process.kill(pid, 0)' }
							]),
							'utf8'
						);
					}
					yield { type: 'tool_call', name: 'Write', args: { file_path: 'findings.json' }, needsConfirm: false } as RuntimeEvent;
					yield { type: 'token_usage', input: 800, output: 100 } as RuntimeEvent;
					yield { type: 'done', result: { ok: true, summary: 'done' } } as RuntimeEvent;
				},
				async cancel() {}
			};
		},
		async resume() {
			throw new Error('not in this test');
		},
		async interject() {}
	};
}

function depsFor(backend: CcBackend): GauntletDeps {
	const runtime = new ClaudeCodeRuntime({
		backend,
		harnessConfigRoot: harnessRoot.replace(/\\/g, '/'),
		gates: { ...DEFAULT_GATE_POLICY }
	});
	return { db, runtime, config: testConfig(), workspaceRoot: wsRoot };
}

/** Drive a freshly-seeded role's incumbent through a real PASSING gauntlet so it is
 *  certified at (prompt_sha × MODEL) — the §5 comparison baseline + the swap target source. */
async function certifyIncumbent(seed: RoleSeed): Promise<RoleVersionRow> {
	const { runGauntlet } = await import('./gauntlet');
	const out = await runGauntlet(depsFor(candidateBackend(seed.defectSlug)), {
		roleVersionId: seed.incumbent.id,
		tier: 'sonnet',
		provider: 'claude',
		modelId: MODEL,
		trigger: 'operator'
	});
	expect(out.kind).toBe('ran');
	if (out.kind !== 'ran') throw new Error('incumbent gauntlet did not run');
	expect(out.run.status).toBe('passed');
	const v = await getRoleVersion(db, seed.incumbent.id);
	await swapActiveVersion(db, seed.role.id, seed.incumbent.id);
	return v!;
}

/** Open a proposed prompt_revision proposal targeting the incumbent (mirrors drift auto-raise). */
async function openProposal(seed: RoleSeed) {
	return createReviewProposal(db, {
		role: seed.role.id,
		kind: 'prompt_revision',
		incumbent: seed.incumbent.id,
		trigger: { signal: 'confidence_miscalibration', evidence: [], reason: 'test' }
	});
}

// ── diffLines (pure) ────────────────────────────────────────────────────────────────

describe('diffLines — the D-010 substrate is computed over real text', () => {
	it('adds/dels/contexts line-for-line', () => {
		const d = diffLines('a\nb\nc', 'a\nB\nc');
		expect(d.filter((l) => l.op === 'context').map((l) => l.text)).toEqual(['a', 'c']);
		expect(d.filter((l) => l.op === 'del').map((l) => l.text)).toEqual(['b']);
		expect(d.filter((l) => l.op === 'add').map((l) => l.text)).toEqual(['B']);
	});
	it('handles empty before (all-add) and empty after (all-del)', () => {
		expect(diffLines('', 'x\ny').every((l) => l.op === 'add')).toBe(true);
		expect(diffLines('x\ny', '').every((l) => l.op === 'del')).toBe(true);
		expect(diffLines('', '')).toEqual([]);
	});

	// REGRESSION (review gap 3): diffLines emits structurally-DUPLICATE lines (same op+text)
	// for repeated blank lines. The surface keyed `{#each lines as l (l.text + l.op)}`, which
	// throws Svelte each_key_duplicate (client crash, dev+prod) once the block is reachable.
	// The fix keys by index; this asserts the duplicates that forced it actually occur, so the
	// (l.op + '·' + i) key is provably load-bearing — not a cosmetic change.
	it('emits non-unique (op,text) lines for repeated blanks → key must be index-based', () => {
		const lines = diffLines('head\n\n\ntail', 'head\n\n\n\ntail');
		const composite = lines.map((l) => l.text + l.op);
		expect(new Set(composite).size).toBeLessThan(composite.length); // duplicate composite keys exist
		const indexed = lines.map((l, i) => l.op + '·' + i);
		expect(new Set(indexed).size).toBe(indexed.length); // index key is unique → no crash
	});
});

// ── review_diff reachability (review gaps 1+2): the operator is NOT blind ────────────

describe('§5 review_diff stage — the D-010 diff is reachable BEFORE authoring', () => {
	it('proposed card carries no server diff, but the previewDiff path yields the real delta', async () => {
		const seed = await seedRole();
		await certifyIncumbent(seed);
		const proposal = await openProposal(seed);

		// The card at the proposed/review_diff stage: challenger is null, so the server-card
		// `diff` is null and nextAction is the author/diff stage. (This is exactly why the old
		// `{#if p.diff}` block never rendered — the operator authored blind.)
		const card = await buildProposalCard(db, proposal);
		expect(card.nextAction).toBe('review_diff');
		expect(card.challenger).toBeNull();
		expect(card.diff).toBeNull();

		// The wired previewDiff path (resolution.proposalDiff with a draft) IS the honest diff the
		// operator now inspects before approving — non-empty, computed over the REAL incumbent text.
		const draft = `You are reviewer #X.\nHunt platform bugs AND injection.\nQuote verbatim evidence.`;
		const preview = await proposalDiff(db, proposal.id, draft);
		expect(preview.lines.length).toBeGreaterThan(0);
		expect(preview.added + preview.removed).toBeGreaterThan(0);
		expect(preview.incumbentPromptCore).toBe((await getRoleVersion(db, seed.incumbent.id))!.prompt_core);
	});
});

// ── The full happy path: proposed → author → re-gauntlet → compared → swap ──────────

describe('§5 full resolution path', () => {
	it('proposed → author(diff) → re-gauntlet → compared → operator swap activates the challenger', async () => {
		const seed = await seedRole();
		await certifyIncumbent(seed);
		const proposal = await openProposal(seed);
		expect(proposal.status).toBe('proposed');

		// The diff the operator reviews matches the REAL incumbent text vs the draft challenger.
		const challengerText = `You are reviewer #X.\nHunt platform bugs AND injection.\nQuote verbatim evidence.`;
		const previewed = await proposalDiff(db, proposal.id, challengerText);
		expect(previewed.incumbentPromptCore).toBe((await getRoleVersion(db, seed.incumbent.id))!.prompt_core);
		expect(previewed.added).toBeGreaterThan(0);
		expect(previewed.challenger).toBeNull(); // not yet authored

		// ① author the challenger (D-010 confirm) → a NEW pm_proposal version, status interviewing.
		const authored = await authorChallenger(db, {
			proposal: proposal.id,
			promptCore: challengerText,
			operatorConfirmed: true
		});
		expect(authored.created).toBe(true);
		expect(authored.challenger.source).toBe('pm_proposal');
		expect(authored.challenger.lifecycle).toBe('draft');
		expect(authored.challenger.prompt_sha).not.toBe(seed.incumbent.prompt_sha); // fresh sha
		expect(authored.proposal.status).toBe('interviewing');
		expect(authored.proposal.challenger).toBe(authored.challenger.id);

		// Now the diff reads the STORED challenger text (the certified bytes — no forgery).
		const storedDiff = await proposalDiff(db, proposal.id);
		expect(storedDiff.challengerPromptCore).toBe(challengerText);
		expect(storedDiff.challenger).toBe(authored.challenger.id);

		// ② re-gauntlet at the incumbent's certified (tier × model) → comparison + 'compared'.
		const re = await regauntletChallenger(depsFor(candidateBackend(seed.defectSlug)), {
			proposal: proposal.id,
			tier: 'sonnet',
			provider: 'claude',
			modelId: MODEL,
			trigger: 'operator'
		});
		expect(re.outcome.kind).toBe('ran');
		if (re.outcome.kind !== 'ran') return;
		expect(re.outcome.run.status).toBe('passed');
		expect(re.proposal.status).toBe('compared');
		expect(re.comparison).toBeTruthy();
		// Same fixture pool + model → comparable, with a real delta.
		expect(re.comparison!.comparable).toBe(true);
		expect(re.comparison!.incumbent).toBeTruthy();
		expect(re.comparison!.delta).toBeTruthy();
		expect(re.comparison!.challenger.recall).toBe(1);

		// The challenger EARNED its own cert (a real passing run at prompt_sha × MODEL).
		const persisted = await getReviewProposal(db, proposal.id);
		expect(persisted!.comparison).toBeTruthy();

		// ③ operator swap (D-039 confirm) → challenger becomes active; proposal closes 'swapped'.
		const before = await getRole(db, seed.role.id);
		expect(before!.active_version).toBe(seed.incumbent.id);
		const swapped = await swapFromProposal(db, {
			proposal: proposal.id,
			modelId: MODEL,
			operatorConfirmed: true
		});
		expect(swapped.role!.active_version).toBe(authored.challenger.id);
		expect(swapped.proposal.status).toBe('swapped');
		expect(swapped.proposal.decided_at).not.toBeNull();
		// The old incumbent stays 'passed' (pinnable, §2.3).
		expect((await getRoleVersion(db, seed.incumbent.id))!.lifecycle).toBe('passed');
		// A role_event{op:'swap', operator_confirmed:true} was written.
		const [evs] = await db.query<[Array<{ op: string; detail?: { operator_confirmed?: boolean } }>]>(
			`SELECT op, detail FROM role_event WHERE role = $r AND op = 'swap' LIMIT 10;`,
			{ r: rid(seed.role.id) }
		);
		expect(evs.some((e) => e.detail?.operator_confirmed === true)).toBe(true);
	}, 60_000);
});

// ── Reject + cooldown ────────────────────────────────────────────────────────────────

describe('§5 reject', () => {
	it('closes rejected_by_operator with a screened reason + decided_at (feeds cooldown)', async () => {
		const seed = await seedRole();
		const proposal = await openProposal(seed);
		const res = await rejectProposal(db, { proposal: proposal.id, reason: 'degradation looks environmental, not the prompt' });
		expect(res.proposal.status).toBe('rejected_by_operator');
		expect(res.proposal.decided_at).not.toBeNull();
		const persisted = await getReviewProposal(db, proposal.id);
		expect(persisted!.trigger.reject_reason).toContain('environmental');
	});

	it('D-026: a reject reason carrying a credential is screened before storage', async () => {
		const seed = await seedRole();
		const proposal = await openProposal(seed);
		const res = await rejectProposal(db, {
			proposal: proposal.id,
			reason: 'rejecting; api_key=SK12345supersecretvalue is in the prompt'
		});
		expect(res.screened.length).toBeGreaterThan(0);
		const persisted = await getReviewProposal(db, proposal.id);
		expect(String(persisted!.trigger.reject_reason)).not.toContain('SK12345supersecret');
		expect(String(persisted!.trigger.reject_reason)).toContain('[REDACTED');
	});

	it('a terminal proposal absorbs a re-reject idempotently', async () => {
		const seed = await seedRole();
		const proposal = await openProposal(seed);
		await rejectProposal(db, { proposal: proposal.id, reason: 'no' });
		const again = await rejectProposal(db, { proposal: proposal.id, reason: 'no again' });
		expect(again.proposal.status).toBe('rejected_by_operator');
	});
});

// ── GOVERNANCE RED-TEAM (the locked invariants) ──────────────────────────────────────

describe('§5 RED-TEAM — no swap without operator confirm AND a passing challenger gauntlet', () => {
	it('swapFromProposal REFUSES without an operator D-039 confirm (no auto-swap path)', async () => {
		const seed = await seedRole();
		await certifyIncumbent(seed);
		const proposal = await openProposal(seed);
		await authorChallenger(db, { proposal: proposal.id, promptCore: 'You are reviewer.\nNew text.', operatorConfirmed: true });
		await regauntletChallenger(depsFor(candidateBackend(seed.defectSlug)), {
			proposal: proposal.id, tier: 'sonnet', provider: 'claude', modelId: MODEL, trigger: 'operator'
		});
		await expect(
			swapFromProposal(db, { proposal: proposal.id, modelId: MODEL, operatorConfirmed: false })
		).rejects.toThrow(ResolutionGateError);
		// The role is unchanged — incumbent still active.
		expect((await getRole(db, seed.role.id))!.active_version).toBe(seed.incumbent.id);
	}, 60_000);

	it('swapFromProposal REFUSES a proposal that has not reached "compared" (re-gauntlet not run)', async () => {
		const seed = await seedRole();
		await certifyIncumbent(seed);
		const proposal = await openProposal(seed);
		await authorChallenger(db, { proposal: proposal.id, promptCore: 'You are reviewer.\nNew.', operatorConfirmed: true });
		// status is 'interviewing' — the re-gauntlet never ran.
		await expect(
			swapFromProposal(db, { proposal: proposal.id, modelId: MODEL, operatorConfirmed: true })
		).rejects.toThrow(ResolutionGateError);
		expect((await getRole(db, seed.role.id))!.active_version).toBe(seed.incumbent.id);
	}, 60_000);

	it('a challenger whose own gauntlet FAILED cannot be swapped (no inherited cert)', async () => {
		const seed = await seedRole();
		await certifyIncumbent(seed);
		const proposal = await openProposal(seed);
		await authorChallenger(db, { proposal: proposal.id, promptCore: 'You are reviewer.\nWeak.', operatorConfirmed: true });
		// The challenger writes NO findings → misses the plant → FAILS its own gauntlet.
		const re = await regauntletChallenger(depsFor(candidateBackend(seed.defectSlug, false)), {
			proposal: proposal.id, tier: 'sonnet', provider: 'claude', modelId: MODEL, trigger: 'operator'
		});
		expect(re.outcome.kind).toBe('ran');
		if (re.outcome.kind !== 'ran') return;
		expect(re.outcome.run.status).toBe('failed');
		expect(re.proposal.status).toBe('compared'); // comparison still recorded (honest)
		expect(re.comparison!.challenger.recall).toBe(0);
		// The swap is refused — the challenger never earned a passing cert.
		await expect(
			swapFromProposal(db, { proposal: proposal.id, modelId: MODEL, operatorConfirmed: true })
		).rejects.toThrow(ResolutionGateError);
		expect((await getRole(db, seed.role.id))!.active_version).toBe(seed.incumbent.id);
	}, 60_000);

	it('a challenger passed at model A cannot be swapped at model B (cert is per prompt_sha × model_id)', async () => {
		const seed = await seedRole();
		await certifyIncumbent(seed);
		const proposal = await openProposal(seed);
		const authored = await authorChallenger(db, { proposal: proposal.id, promptCore: 'You are reviewer.\nXYZ.', operatorConfirmed: true });
		await regauntletChallenger(depsFor(candidateBackend(seed.defectSlug)), {
			proposal: proposal.id, tier: 'sonnet', provider: 'claude', modelId: MODEL, trigger: 'operator'
		});
		// Challenger passed at MODEL; ask to swap at a DIFFERENT model_id → §2.4 hard fail.
		await expect(
			swapFromProposal(db, { proposal: proposal.id, modelId: 'claude-haiku-y', operatorConfirmed: true })
		).rejects.toThrow(ResolutionGateError);
		expect((await getRole(db, seed.role.id))!.active_version).toBe(seed.incumbent.id);
		// Sanity: the challenger row exists and is passed, just not at the wrong model.
		expect((await getRoleVersion(db, authored.challenger.id))!.lifecycle).toBe('passed');
	}, 60_000);

	it('authorChallenger REFUSES without the D-010 diff confirm', async () => {
		const seed = await seedRole();
		const proposal = await openProposal(seed);
		await expect(
			authorChallenger(db, { proposal: proposal.id, promptCore: 'text', operatorConfirmed: false })
		).rejects.toThrow(ResolutionGateError);
		expect((await getReviewProposal(db, proposal.id))!.challenger).toBeNull();
	});

	it('D-026: authorChallenger SCREENS a prompt_core carrying a credential (redacted before storage)', async () => {
		const seed = await seedRole();
		const proposal = await openProposal(seed);
		// A credential embedded in the methodology text is REDACTED in place (the screened
		// text is what gets stored + certified); the reasons are surfaced honestly.
		const authored = await authorChallenger(db, {
			proposal: proposal.id,
			promptCore: 'You are reviewer.\nUse api_key=SK12345supersecretvalue when calling out.',
			operatorConfirmed: true
		});
		expect(authored.screened.length).toBeGreaterThan(0);
		const stored = await getRoleVersion(db, authored.challenger.id);
		expect(stored!.prompt_core).not.toContain('SK12345supersecret');
		expect(stored!.prompt_core).toContain('[REDACTED');
	});

	it('D-026: authorChallenger REFUSES a prompt_core carrying a quarantine-class payload (private key)', async () => {
		const seed = await seedRole();
		const proposal = await openProposal(seed);
		const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIfakekeymaterial\n-----END RSA PRIVATE KEY-----';
		await expect(
			authorChallenger(db, {
				proposal: proposal.id,
				promptCore: `You are reviewer.\n${pem}`,
				operatorConfirmed: true
			})
		).rejects.toThrow(WorkforceInputError);
		expect((await getReviewProposal(db, proposal.id))!.challenger).toBeNull();
	});
});

// ── Idempotency / interrupt contract ─────────────────────────────────────────────────

describe('§5 interrupt contract', () => {
	it('re-authoring an already-authored proposal absorbs (no second challenger)', async () => {
		const seed = await seedRole();
		const proposal = await openProposal(seed);
		const first = await authorChallenger(db, { proposal: proposal.id, promptCore: 'You are reviewer.\nA.', operatorConfirmed: true });
		const second = await authorChallenger(db, { proposal: proposal.id, promptCore: 'You are reviewer.\nDIFFERENT.', operatorConfirmed: true });
		expect(second.created).toBe(false);
		expect(second.challenger.id).toBe(first.challenger.id); // same row, not a second version
	});

	it('a swapped proposal absorbs a re-swap idempotently', async () => {
		const seed = await seedRole();
		await certifyIncumbent(seed);
		const proposal = await openProposal(seed);
		const authored = await authorChallenger(db, { proposal: proposal.id, promptCore: 'You are reviewer.\nQQ.', operatorConfirmed: true });
		await regauntletChallenger(depsFor(candidateBackend(seed.defectSlug)), {
			proposal: proposal.id, tier: 'sonnet', provider: 'claude', modelId: MODEL, trigger: 'operator'
		});
		await swapFromProposal(db, { proposal: proposal.id, modelId: MODEL, operatorConfirmed: true });
		const again = await swapFromProposal(db, { proposal: proposal.id, modelId: MODEL, operatorConfirmed: true });
		expect(again.proposal.status).toBe('swapped');
		expect(again.role!.active_version).toBe(authored.challenger.id);
	}, 60_000);
});

// ── listOpenProposals (the §8 RightTray feed) ─────────────────────────────────────────

describe('listOpenProposals', () => {
	it('returns only non-terminal proposals across roles', async () => {
		const seed = await seedRole();
		const open = await openProposal(seed);
		const toReject = await openProposal(await seedRole());
		await rejectProposal(db, { proposal: toReject.id, reason: 'x' });
		const list = await listOpenProposals(db);
		expect(list.some((p) => p.id === open.id)).toBe(true);
		expect(list.some((p) => p.id === toReject.id)).toBe(false);
	});
});

// ── status machine guard (validated → swapped is illegal) ─────────────────────────────

describe('proposal status machine', () => {
	it('cannot leap proposed → swapped (skipping diff + gauntlet + comparison)', async () => {
		const seed = await seedRole();
		const proposal = await openProposal(seed);
		// No challenger, status proposed → swapFromProposal refuses on the no-challenger guard.
		await expect(
			swapFromProposal(db, { proposal: proposal.id, modelId: MODEL, operatorConfirmed: true })
		).rejects.toThrow(WorkforceInputError);
	});

	it('transitionLifecycle still governs the version side (unaffected)', async () => {
		const seed = await seedRole();
		// draft → passed is illegal (must go through interviewing) — sanity the version machine holds.
		await expect(transitionLifecycle(db, seed.incumbent.id, 'passed')).rejects.toThrow();
	});
});
