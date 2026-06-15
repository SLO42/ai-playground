// TASK W-D7c CER1 — the DAY-0 BOOTSTRAP CEREMONY DRIVER, authoring half (WORKFORCE-SPEC
// §8 steps ①+②). This is the operator-clickable DRIVER for the existing ceremony.ts
// MECHANISM — it does NOT fork it. The /agents workforce panel's empty state had no
// actionable control (the bug the operator hit); this route is the real flow entry that
// replaces the dead /?ceremony=bootstrap placeholder.
//
// Three operator actions, all wired to ceremony.ts / launch-fixtures.ts server functions:
//   • seed       → seedLaunchPool(db)  — IDEMPOTENT: the 5 launch roles + DRAFT prompt
//                  cores + PROPOSED fixtures appear (re-runnable, absorbs prior partial work).
//   • confirmKey → confirmLaunchKey(db, …) — the D-010 diff+confirm key write-path. The
//                  engine's operator guards (teethless-key reject; A8 bait warning;
//                  malformed-plant reject; stale-key drift) surface as named UI feedback.
//
// CER2 — the EXECUTION half (steps ③/④/⑤): admission reference-runs, bootstrap interviews,
// and the panel-flip gate. These DO spend (real gauntlet runs), so every trigger is
// operator-gated (explicit confirm + the engine's CeremonyGateError fail-closed) and the
// real Claude Code runtime is wired in only on the credentialed path (getRuntime → honest
// 'credential not configured' otherwise, F-008). The DB-side budget gate is the engine's
// (§3.7) — operator triggers bypass it (the click IS the budget decision). Fixtures must be
// ACTIVATED (sentinel-injected, keyed) before they can be interviewed — `activate` wires the
// existing activateGauntletFixture (the §3.8 precondition the sampler enforces). No fork.

import { tryGetDb } from '$lib/server/db/runtime-init';
import {
	activateGauntletFixture,
	ceremonyAuthoringState,
	ceremonyExecutionState,
	confirmLaunchKey,
	CeremonyGateError,
	isSentinelShape,
	newSentinelUlid,
	seedLaunchPool,
	triggerAdmissionReferenceRun,
	triggerBootstrapInterview,
	WorkforceInputError,
	type CeremonyAuthoringState,
	type CeremonyExecutionState,
	type GauntletOutcome,
	type Tier
} from '$lib/server/workforce';
import { StringRecordId } from 'surrealdb';
import { assertRecordId } from '$lib/server/db/validate';
import { getRuntime } from '$lib/server/harness';
import { loadAgentPool, loadWorkforce, type AgentPool } from '$lib/server/config';
import { fail, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export interface CeremonyPageData {
	connected: boolean;
	state: CeremonyAuthoringState | null;
	/** CER2 — the step-③/④/⑤ execution substrate (proofs, interview lines, readiness). */
	execution: CeremonyExecutionState | null;
	/** Honest live-spend availability (F-008): the Claude Code credential gates real runs.
	 *  When false, the trigger buttons render disabled-with-reason rather than failing on click. */
	runtimeAvailable: boolean;
	runtimeReason: string | null;
	error?: string;
}

export const load: PageServerLoad = async ({ depends }): Promise<CeremonyPageData> => {
	// Re-derive live off the ONE SSE stream (D-035): a role/role_version/fixture create (seed),
	// a fixture activation, an interview_run finalize, or a role_event all re-invalidate this
	// loader. A key confirm re-loads via its own form-action response (the answer-key table is
	// server-internal, never watched from a route — §4.4 leak boundary).
	depends('app:workforce');

	const db = tryGetDb();
	if (!db) {
		return {
			connected: false,
			state: null,
			execution: null,
			runtimeAvailable: false,
			runtimeReason: 'database not connected'
		};
	}
	try {
		const [state, execution, runtime] = await Promise.all([
			ceremonyAuthoringState(db),
			ceremonyExecutionState(db),
			getRuntime(db)
		]);
		return {
			connected: true,
			state,
			execution,
			runtimeAvailable: runtime.available,
			runtimeReason: runtime.available ? null : runtime.reason
		};
	} catch (err) {
		return {
			connected: false,
			state: null,
			execution: null,
			runtimeAvailable: false,
			runtimeReason: null,
			error: (err as Error).message
		};
	}
};

/** The config dir — same resolution as the rest of the app. */
function configDir(): string {
	return process.env.CONFIG_DIR?.trim() || 'config';
}

/** Resolve a tier name → {provider, model_id} from agent-pool.yaml (D-003: the tier→model
 *  map lives in config, never hard-coded). Fail-closed: an unknown tier or unreadable config
 *  yields a named error so the trigger refuses rather than spending on a guessed model. */
function resolveTierModel(
	tier: Tier
): { ok: true; provider: string; modelId: string } | { ok: false; error: string } {
	let pool: AgentPool;
	try {
		pool = loadAgentPool(`${configDir()}/agent-pool.yaml`);
	} catch (err) {
		return { ok: false, error: `agent-pool config unreadable — cannot resolve tier '${tier}': ${(err as Error).message}` };
	}
	const spec = pool.tiers[tier];
	if (!spec) {
		return { ok: false, error: `tier '${tier}' is not defined in agent-pool.yaml — cannot resolve a model to spend on` };
	}
	return { ok: true, provider: spec.provider, modelId: spec.model };
}

/** Map a GauntletOutcome (ran | queued) into the named action result the UI renders. The
 *  queued branch is the §3.7 count-and-surface path (an AUTO trigger over an unarmed cap) —
 *  here every ceremony trigger is operator='operator', so a ran outcome is the norm; queued
 *  surfaces honestly if it ever occurs. */
function outcomeResult(outcome: GauntletOutcome): Record<string, unknown> {
	if (outcome.kind === 'queued') {
		return { queued: true, reason: outcome.reason };
	}
	const run = outcome.run;
	return {
		ran: true,
		run: run.id,
		status: run.status,
		...(run.error_reason ? { errorReason: run.error_reason } : {}),
		plantedFound: run.planted_found,
		plantedTotal: run.planted_total,
		falsePositives: run.false_positives,
		...(run.cost_usd !== null ? { costUsd: run.cost_usd } : {})
	};
}

/**
 * §4.2 mechanical server-side sentinel injection AT ACTIVATION. The launch fixtures seed
 * with an EMPTY sentinel (so an authoring transcript can never trip its own sweep); the
 * leak tripwire ULID is minted here, at activation, after all authoring. Idempotent: a
 * fixture that already carries a valid 26-char Crockford ULID (re-activation, or a
 * mint-at-create fixture) is left untouched. A proposed fixture with a malformed-but-
 * non-empty sentinel is RE-MINTED (a malformed needle near-match-alls the sweep, F-025) —
 * but ONLY while proposed; an active fixture's sentinel is immutable (the engine's
 * idempotent-absorb returns before we are reached, so this only ever runs on proposed rows).
 */
async function ensureSentinel(
	db: NonNullable<ReturnType<typeof tryGetDb>>,
	fixtureId: string
): Promise<void> {
	const fid = new StringRecordId(assertRecordId(fixtureId));
	const [rows] = await db.query<[Array<{ status?: string; sentinel?: unknown }>]>(
		`SELECT status, sentinel FROM $fid;`,
		{ fid }
	);
	const row = rows?.[0];
	if (!row) return; // not found — let activateGauntletFixture raise the named error
	if (row.status === 'active') return; // immutable once active (engine absorbs the re-run)
	if (isSentinelShape(row.sentinel)) return; // already a valid ULID (idempotent)
	await db.query(`UPDATE $fid SET sentinel = $s;`, { fid, s: newSentinelUlid() });
}

/** Parse the operator-authored plants JSON from the form. Returns the parsed array or a
 *  named error string — every error has a NAME (malformed JSON vs non-array vs nil). */
function parsePlantsField(raw: string): { plants: Array<Record<string, unknown>> } | { error: string } {
	const trimmed = raw.trim();
	if (trimmed === '') return { plants: [] }; // empty is legal input; teeth-guard runs in the engine
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return { error: 'plants must be valid JSON (an array of plant objects)' };
	}
	if (!Array.isArray(parsed)) {
		return { error: 'plants must be a JSON array (one object per planted defect/absence)' };
	}
	return { plants: parsed as Array<Record<string, unknown>> };
}

export const actions: Actions = {
	// Step 0 — ENTRY + SEED. Idempotent: re-running absorbs prior partial work (F-015 /
	// interrupt contract) and never duplicates. The would-be over-spend is impossible —
	// seeding writes only draft/proposed rows, no keys, no interviews (F-008).
	seed: async () => {
		const db = tryGetDb();
		if (!db) return fail(503, { ceremony: { error: 'database not connected' } });
		try {
			const result = await seedLaunchPool(db);
			const created = result.roles.filter((r) => r.createdRole).length;
			return {
				ceremony: {
					ok: true,
					seeded: true,
					rolesTotal: result.roles.length,
					rolesCreated: created
				}
			};
		} catch (err) {
			return fail(500, { ceremony: { error: (err as Error).message } });
		}
	},

	// Step 2 — AUTHOR/CONFIRM KEY (D-010 diff+confirm). The operator authored the answer
	// key (plants + fp_tolerance + justification); this confirms it via confirmLaunchKey.
	// The engine's operator guards are surfaced as named UI feedback (not raw 500s):
	//   • missing operatorConfirmed → CeremonyGateError (fail-closed)
	//   • teethless planted/bait key → WorkforceInputError (override via allowEmptyPlants)
	//   • malformed plant            → WorkforceInputError naming which plant + why
	//   • stale-key drift            → ok with changed:true + the named reason (no throw)
	confirmKey: async ({ request }) => {
		const db = tryGetDb();
		if (!db) return fail(503, { ceremony: { error: 'database not connected' } });
		const form = await request.formData();

		const fixture = String(form.get('fixture') ?? '').trim();
		if (!fixture) return fail(400, { ceremony: { error: 'missing fixture id' } });

		// The confirm checkbox IS the operator's explicit diff+confirm (D-010 / §8).
		const operatorConfirmed = form.get('operatorConfirmed') === 'on';
		if (!operatorConfirmed) {
			// Surface the gate as an affordance, NOT a raw server error — the operator must
			// tick the confirm box (the diff+confirm ceremony has not happened, §8).
			return fail(400, {
				ceremony: {
					fixture,
					error: 'confirm the diff to author this key — tick the confirm box (the §8 diff+confirm ceremony is operator-gated)'
				}
			});
		}

		const parsed = parsePlantsField(String(form.get('plants') ?? ''));
		if ('error' in parsed) return fail(400, { ceremony: { fixture, error: parsed.error } });

		// fp_tolerance is optional; an empty field means "engine default" (omit it).
		const fpRaw = String(form.get('fp_tolerance') ?? '').trim();
		let fp_tolerance: number | undefined;
		if (fpRaw !== '') {
			const n = Number(fpRaw);
			if (!Number.isFinite(n) || n < 0) {
				return fail(400, { ceremony: { fixture, error: 'fp_tolerance must be a non-negative number' } });
			}
			fp_tolerance = n;
		}
		const fp_justification = String(form.get('fp_justification') ?? '').trim() || undefined;

		// The teethless-key override (DEFECT 4 escape hatch) — only when the operator ticks it.
		const allowEmptyPlants = form.get('allowEmptyPlants') === 'on';
		const emptyPlantsJustification =
			String(form.get('emptyPlantsJustification') ?? '').trim() || undefined;

		try {
			const result = await confirmLaunchKey(db, {
				fixture,
				plants: parsed.plants,
				...(fp_tolerance !== undefined ? { fp_tolerance } : {}),
				...(fp_justification !== undefined ? { fp_justification } : {}),
				operatorConfirmed: true,
				...(allowEmptyPlants ? { allowEmptyPlants: true } : {}),
				...(emptyPlantsJustification !== undefined ? { emptyPlantsJustification } : {})
			});
			return {
				ceremony: {
					ok: true,
					fixture,
					created: result.created,
					// stale-key drift (DEFECT 2): the re-confirm was a no-op; tell the operator why.
					...(result.changed ? { changed: true, reason: result.reason } : {})
				}
			};
		} catch (err) {
			// CeremonyGateError / WorkforceInputError = NAMED operator-facing guards (teethless,
			// malformed plant, bad confirm). Anything else is a 500-class.
			if (err instanceof CeremonyGateError || err instanceof WorkforceInputError) {
				return fail(400, { ceremony: { fixture, error: err.message } });
			}
			return fail(500, { ceremony: { fixture, error: (err as Error).message } });
		}
	},

	// Step ③/④ PRECONDITION — ACTIVATE a fixture pool (sentinel injection + key re-bind, the
	// §3.8 substrate the gauntlet sampler requires). NO real spend: activation writes rows
	// only; it marks any passing run stale + queues ONE batched re-interview proposal (no
	// auto-spend, F-008). Idempotent: an already-active fixture absorbs (engine-enforced).
	// Operator-gated by the confirm tick (activation injects a leak tripwire + flips the
	// fixture live — a D-010-class act).
	activate: async ({ request }) => {
		const db = tryGetDb();
		if (!db) return fail(503, { ceremony: { error: 'database not connected' } });
		const form = await request.formData();
		const fixture = String(form.get('fixture') ?? '').trim();
		if (!fixture) return fail(400, { ceremony: { error: 'missing fixture id' } });
		if (form.get('operatorConfirmed') !== 'on') {
			return fail(400, {
				ceremony: {
					fixture,
					error: 'confirm activation — activating injects the leak sentinel and flips the fixture live (§3.8/§4.2)'
				}
			});
		}
		try {
			// §4.2 — the sentinel is injected MECHANICALLY server-side at ACTIVATION (after all
			// agent/operator authoring — an authoring transcript can never trip its own sweep).
			// The launch fixtures seed with an EMPTY sentinel; mint + set a fresh ULID here so
			// activateGauntletFixture (which requires a valid ULID, F-025) can inject it into the
			// work. Idempotent: a fixture already carrying a valid sentinel (re-activation, or a
			// fixture minted at create) is left untouched. Skipped entirely for an already-active
			// fixture (the engine absorbs that as a no-op before reading the sentinel).
			await ensureSentinel(db, fixture);
			const result = await activateGauntletFixture(db, fixture);
			return {
				ceremony: {
					ok: true,
					fixture,
					activated: result.activated,
					staleMarked: result.staleMarked,
					reinterviewQueued: result.reinterviewQueued
				}
			};
		} catch (err) {
			if (err instanceof WorkforceInputError) {
				return fail(400, { ceremony: { fixture, error: err.message } });
			}
			return fail(500, { ceremony: { fixture, error: (err as Error).message } });
		}
	},

	// Step ③ — ADMISSION REFERENCE-RUN (REAL SPEND, operator-gated). Runs the gauntlet at the
	// role's default (tier, model_id) and, on a PASS, the ENGINE records the proof in each keyed
	// fixture's reference_runs (§3.8, provisional-aware) — this route never touches the
	// answer-key table (§4.4 leak boundary). The confirm tick IS the budget decision
	// (trigger='operator'); without it the engine throws CeremonyGateError.
	referenceRun: async ({ request }) => runCeremonyTrigger(request, 'reference'),

	// Step ④ — BOOTSTRAP INTERVIEW (REAL SPEND, operator-gated). Runs the certification
	// gauntlet at the role's default (tier, model_id). An ambiguous run finalizes as
	// 'adjudicating' and routes to the EXISTING §3.4 queue on /agents (not duplicated here);
	// a clear run flips passed/failed. Live results surface via the existing interview_run SSE
	// watcher (D-035) — the loader re-derives in place.
	interview: async ({ request }) => runCeremonyTrigger(request, 'interview'),

	// Step ⑤ — PANEL-FLIP gate (operator-confirmed, D-010). The §8 precondition (all five
	// certified) is REPORTED by ceremonyExecutionState; the flip NEVER auto-fires. This
	// records the operator's flip decision as an auditable marker. The panel-COMPOSITION
	// switch (PM validators inline→catalog_role) is the v2.1 panel concern — declared deferred;
	// here we gate + record the operator's confirmation so the decision is on record.
	flip: async ({ request }) => {
		const db = tryGetDb();
		if (!db) return fail(503, { ceremony: { error: 'database not connected' } });
		const form = await request.formData();
		if (form.get('operatorConfirmed') !== 'on') {
			return fail(400, {
				ceremony: {
					flip: true,
					error: 'confirm the panel-composition flip — it is operator-gated, never automatic (D-010/§8 ⑤)'
				}
			});
		}
		// Fail-closed: re-check readiness server-side (never trust a stale client). The flip is
		// only legal once every launch role is certified (§8 step ⑤ precondition).
		try {
			const exec = await ceremonyExecutionState(db);
			if (!exec.allCertified) {
				return fail(400, {
					ceremony: {
						flip: true,
						error: `not every launch role is certified (${exec.certifiedCount}/${exec.roles.length}) — the panel flip precondition is not met (§8 ⑤)`
					}
				});
			}
			// Record the operator's flip confirmation as an auditable work_item marker (the
			// composition-switch consumer lands with the v2.1 panel work; this is the operator's
			// on-record decision, F-008: no fabricated composition state).
			await db.query(
				`CREATE work_item CONTENT {
					work_type: 'ceremony_panel_flip_confirmed', status: 'done', priority: 5,
					payload: { certified_count: $n, operator_confirmed: true },
					completed_at: time::now()
				};`,
				{ n: exec.certifiedCount }
			);
			return { ceremony: { ok: true, flip: true, certifiedCount: exec.certifiedCount } };
		} catch (err) {
			return fail(500, { ceremony: { flip: true, error: (err as Error).message } });
		}
	}
};

/**
 * Shared driver for the two REAL-SPEND triggers (③ reference-run, ④ bootstrap interview).
 * Both: resolve the role's default tier → model from config (D-003), wire the live runtime
 * (honest 'credential not configured' otherwise, F-008), and pass trigger='operator' +
 * operatorConfirmed (the engine's fail-closed gate). The confirm tick IS the budget decision
 * (§3.7) — there is no auto-spend path here.
 */
async function runCeremonyTrigger(
	request: Request,
	which: 'reference' | 'interview'
): Promise<unknown> {
	const db = tryGetDb();
	if (!db) return fail(503, { ceremony: { error: 'database not connected' } });
	const form = await request.formData();
	const roleVersionId = String(form.get('roleVersion') ?? '').trim();
	const tier = String(form.get('tier') ?? '').trim() as Tier;
	if (!roleVersionId) return fail(400, { ceremony: { error: 'missing role version id' } });
	if (!tier) return fail(400, { ceremony: { roleVersion: roleVersionId, error: 'missing tier' } });

	// Fail-closed spend gate: the operator MUST tick the confirm box (the click IS the budget
	// decision, §3.7). Surfaced as an affordance, not a raw error.
	if (form.get('operatorConfirmed') !== 'on') {
		return fail(400, {
			ceremony: {
				roleVersion: roleVersionId,
				error: 'confirm the spend — this runs a REAL gauntlet at the role tier/model (the click IS the budget decision, §3.7)'
			}
		});
	}

	const resolved = resolveTierModel(tier);
	if (!resolved.ok) {
		return fail(400, { ceremony: { roleVersion: roleVersionId, error: resolved.error } });
	}

	const runtime = await getRuntime(db);
	if (!runtime.available) {
		// HONEST (F-008): no live credential → no fake run; surface the reason.
		return fail(503, { ceremony: { roleVersion: roleVersionId, error: runtime.reason } });
	}

	let config;
	try {
		config = loadWorkforce(`${configDir()}/workforce.yaml`);
	} catch (err) {
		return fail(500, { ceremony: { roleVersion: roleVersionId, error: `workforce config unreadable: ${(err as Error).message}` } });
	}

	const deps = { db, runtime: runtime.runtime, config };
	const input = {
		roleVersionId,
		tier,
		provider: resolved.provider,
		modelId: resolved.modelId,
		trigger: 'operator' as const,
		operatorConfirmed: true
	};

	try {
		if (which === 'reference') {
			const res = await triggerAdmissionReferenceRun(deps, input);
			return {
				ceremony: {
					ok: true,
					roleVersion: roleVersionId,
					kind: 'reference',
					provisional: res.provisional,
					recordedFor: res.recordedFor,
					...outcomeResult(res.outcome)
				}
			};
		}
		const outcome = await triggerBootstrapInterview(deps, input);
		return {
			ceremony: { ok: true, roleVersion: roleVersionId, kind: 'interview', ...outcomeResult(outcome) }
		};
	} catch (err) {
		// CeremonyGateError / WorkforceInputError = NAMED operator-facing guards (missing
		// confirm, no active fixtures, vacuous-recall sample). Anything else is a 500-class.
		if (err instanceof CeremonyGateError || err instanceof WorkforceInputError) {
			return fail(400, { ceremony: { roleVersion: roleVersionId, error: err.message } });
		}
		return fail(500, { ceremony: { roleVersion: roleVersionId, error: (err as Error).message } });
	}
}
