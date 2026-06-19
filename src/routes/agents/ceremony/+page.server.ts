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
	adjudicateInterviewRun,
	autoAdjudicateRun,
	ceremonyAuthoringState,
	ceremonyExecutionState,
	classifyAmbiguousItem,
	registeredInjectionSlugs,
	confirmLaunchKey,
	CeremonyGateError,
	isSentinelShape,
	newSentinelUlid,
	reversionFailedRole,
	seedLaunchPool,
	seedRecruiterRole,
	seedResearcherRole,
	triggerAdmissionReferenceRun,
	triggerBootstrapInterview,
	WorkforceInputError,
	type AmbiguousResolution,
	type CeremonyAuthoringState,
	type CeremonyExecutionState,
	type GauntletOutcome,
	type InterviewRunRow,
	type ItemDecision,
	type Tier
} from '$lib/server/workforce';
import { StringRecordId } from 'surrealdb';
import { assertRecordId } from '$lib/server/db/validate';
import { getRuntime } from '$lib/server/harness';
import { loadAgentPool, loadWorkforce, type AgentPool } from '$lib/server/config';
import { fail, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/**
 * HR-1 — one adjudicating interview_run, fully unpacked for the operator's judgment.
 * This is the surface the operator HAD to query SurrealDB by hand for: per ambiguous item
 * the finding (file/class/verbatim evidence) + the scorer note + the item type; per run the
 * per-fixture found/missed plant ids + basis (from interview_run.results) and the snapshot
 * pass bar. NO engine read change — the data is already populated on the run by the scorer /
 * adjudicateInterviewRun; this loader surfaces what was always there (F-008: real rows only).
 */
export interface CeremonyAdjudicationCard {
	run: string;
	roleSlug: string;
	tier: string;
	modelId: string;
	plantedFound: number;
	plantedTotal: number;
	falsePositives: number;
	at: string | null;
	/** Verbatim interview_run.ambiguous — each item {type, fixture, plant?, finding, note}. */
	ambiguous: Array<Record<string, unknown>>;
	/**
	 * HR-4 audit surface — the recruiter's classification of EVERY still-queued ambiguous item
	 * (one per `ambiguous` entry, same order/index). Computed by classifyAmbiguousItem (REUSED
	 * verbatim from auto-adjudicate.ts — NOT forked; the same logic the pre-pass runs). For each
	 * item: HR either CLEARED it (resolution + basis — these are auto-resolved before the operator
	 * ever sees the run; on a still-adjudicating run a clear item only persists when a SIBLING
	 * escalated, so batch-or-nothing held the whole batch) or ESCALATED it (recommendation + basis)
	 * to the operator. Lets the operator audit HR's calls and resolve only the escalations. */
	hrDecisions: Array<
		| { kind: 'clear'; index: number; resolution: AmbiguousResolution; basis: string }
		| { kind: 'escalate'; index: number; recommendation: AmbiguousResolution | 'unresolved'; basis: string }
	>;
	/** Per-fixture scorer results: {fixture, kind, found[], missed[], extra, evidence[]}.
	 *  Synthetic non-fixture rows (verdict/env/scorer_control) are filtered out — only the
	 *  per-fixture found/missed/basis rows the operator needs to read the run are surfaced. */
	results: Array<Record<string, unknown>>;
	/** The SNAPSHOT pass bar the run will finalize against (§3.5) — honest null if absent. */
	passCriteria: { passRecall: number | null; maxFalsePositives: number | null } | null;
}

export interface CeremonyPageData {
	connected: boolean;
	state: CeremonyAuthoringState | null;
	/** CER2 — the step-③/④/⑤ execution substrate (proofs, interview lines, readiness). */
	execution: CeremonyExecutionState | null;
	/** HR-1 — the §3.4 adjudication queue, each run unpacked with finding/plant/basis/bar. */
	adjudication: CeremonyAdjudicationCard[];
	/** Honest live-spend availability (F-008): the Claude Code credential gates real runs.
	 *  When false, the trigger buttons render disabled-with-reason rather than failing on click. */
	runtimeAvailable: boolean;
	runtimeReason: string | null;
	error?: string;
}

/** F-013 — coerce a SurrealDB datetime (or anything) to an ISO string, never str(undefined).
 *  Absent / the literal 'undefined'/'null'/'' → null (UI renders '—'). */
function isoOrNull(v: unknown): string | null {
	if (v === null || v === undefined) return null;
	const s = v instanceof Date ? v.toISOString() : String(v);
	return s === '' || s === 'undefined' || s === 'null' ? null : s;
}

/** Coerce a pass_criteria field to a finite number or null (honest '—' when absent/malformed). */
function numOrNull(v: unknown): number | null {
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

/**
 * HR-1 — build the adjudication queue for the ceremony surface: every interview_run in
 * status 'adjudicating', with its ambiguous queue, per-fixture results, and snapshot bar.
 * Read-only; bounded (LIMIT 100, newest first). Shadow paths: an empty queue → [] (honest);
 * a run whose ambiguous/results are absent/non-array → [] for that field (never a throw).
 * The candidate role's slug is resolved per run (small N) for a human-readable header.
 */
async function buildCeremonyAdjudication(
	db: NonNullable<ReturnType<typeof tryGetDb>>
): Promise<CeremonyAdjudicationCard[]> {
	const [rows] = await db.query<
		[
			Array<{
				id: unknown;
				role: unknown;
				tier?: string;
				model_id?: string;
				planted_found?: number;
				planted_total?: number;
				false_positives?: number;
				ambiguous?: unknown;
				results?: unknown;
				pass_criteria?: { pass_recall?: unknown; max_false_positives?: unknown } | null;
				started_at?: unknown;
			}>
		]
	>(
		`SELECT id, role, tier, model_id, planted_found, planted_total, false_positives,
		        ambiguous, results, pass_criteria, started_at
		   FROM interview_run WHERE status = 'adjudicating'
		  ORDER BY started_at DESC LIMIT 100;`
	);

	const cards: CeremonyAdjudicationCard[] = [];
	const slugCache = new Map<string, string>();
	for (const r of rows ?? []) {
		const roleId = r.role != null ? String(r.role) : '';
		let slug = roleId ? slugCache.get(roleId) : '';
		if (roleId && slug === undefined) {
			const [sr] = await db.query<[Array<{ slug?: string }>]>(`SELECT slug FROM $rid;`, {
				rid: new StringRecordId(assertRecordId(roleId))
			});
			slug = sr?.[0]?.slug ?? roleId;
			slugCache.set(roleId, slug);
		}
		// Per-fixture results only — drop the synthetic verdict/env/scorer_control audit rows
		// (they carry no found/missed/fixture; surfacing them would be noise, not basis).
		const rawResults = Array.isArray(r.results) ? (r.results as Array<Record<string, unknown>>) : [];
		const results = rawResults.filter(
			(x) => typeof x.fixture === 'string' && (Array.isArray(x.found) || Array.isArray(x.missed))
		);
		const pc = r.pass_criteria ?? null;
		const ambiguous = Array.isArray(r.ambiguous) ? (r.ambiguous as Array<Record<string, unknown>>) : [];
		// HR-4 split — classify each still-queued item exactly as the pre-pass does (classify-
		// AmbiguousItem reused verbatim, B3: read-only, no rescore). Maps the engine's ItemDecision
		// to the card's narrowed shape so the UI can render auto-cleared vs escalated per item.
		// Build the run's REGISTERED injection-fixture slug set (kind 'hallucination_bait') from the
		// scorer's read-only results — the same un-forgeable gate the pre-pass uses, so the card's HR
		// split matches autoAdjudicateRun exactly (a forged/unregistered injection slug escalates, never
		// auto-dismisses).
		const injectionSlugs = registeredInjectionSlugs({ results: rawResults } as unknown as InterviewRunRow);
		const hrDecisions = ambiguous.map((item, i) => {
			const d: ItemDecision = classifyAmbiguousItem(item, i, injectionSlugs);
			return d.kind === 'clear'
				? { kind: 'clear' as const, index: d.index, resolution: d.resolution, basis: d.basis }
				: { kind: 'escalate' as const, index: d.index, recommendation: d.recommendation, basis: d.basis };
		});
		cards.push({
			run: String(r.id),
			roleSlug: slug || roleId || '—',
			tier: r.tier ?? '—',
			modelId: r.model_id ?? '—',
			plantedFound: Number(r.planted_found ?? 0),
			plantedTotal: Number(r.planted_total ?? 0),
			falsePositives: Number(r.false_positives ?? 0),
			at: isoOrNull(r.started_at),
			ambiguous,
			hrDecisions,
			results,
			passCriteria: pc
				? { passRecall: numOrNull(pc.pass_recall), maxFalsePositives: numOrNull(pc.max_false_positives) }
				: null
		});
	}
	return cards;
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
			adjudication: [],
			runtimeAvailable: false,
			runtimeReason: 'database not connected'
		};
	}
	try {
		const [state, execution, adjudication, runtime] = await Promise.all([
			ceremonyAuthoringState(db),
			ceremonyExecutionState(db),
			buildCeremonyAdjudication(db),
			getRuntime(db)
		]);
		return {
			connected: true,
			state,
			execution,
			adjudication,
			runtimeAvailable: runtime.available,
			runtimeReason: runtime.available ? null : runtime.reason
		};
	} catch (err) {
		return {
			connected: false,
			state: null,
			execution: null,
			adjudication: [],
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

/** HR-1 — the three legal §3.4 resolutions (matches AmbiguousResolution; validated at the
 *  boundary so a hand-posted resolution can never reach the engine malformed). */
const VALID_RESOLUTIONS = new Set<AmbiguousResolution>(['confirm_hit', 'false_positive', 'dismiss']);

export const actions: Actions = {
	// Step 0 — ENTRY + SEED. Idempotent: re-running absorbs prior partial work (F-015 /
	// interrupt contract) and never duplicates. The would-be over-spend is impossible —
	// seeding writes only draft/proposed rows, no keys, no interviews (F-008).
	//
	// Seeds BOTH the §8 five LAUNCH roles (seedLaunchPool) AND the §7b SIXTH catalog role
	// (seedResearcherRole) — the researcher is seeded SEPARATELY (never added to LAUNCH_ROLES,
	// preserving the 'exactly five launch roles' §8 invariant), but folded into the SAME
	// operator click so the researcher's draft + 4 fixtures land ready for its own cert. Both
	// are idempotent: a re-run (or a crash mid-seed) absorbs prior partial work. The researcher
	// then surfaces on the ceremony/agents surface as an un-certified role via listRoles (it
	// reuses the same authoring/execution infra) — it is NOT auto-certified; the operator runs
	// its cert through the existing flow.
	seed: async () => {
		const db = tryGetDb();
		if (!db) return fail(503, { ceremony: { error: 'database not connected' } });
		try {
			const result = await seedLaunchPool(db);
			const created = result.roles.filter((r) => r.createdRole).length;
			// §7b — seed the sixth catalog role alongside the launch pool (idempotent, separate).
			const researcher = await seedResearcherRole(db);
			// HR-RECRUITER-SPEC §7b.2 — seed the SEVENTH catalog role (recruiter) alongside, the
			// SAME way the researcher is (separate seed, NEVER added to LAUNCH_ROLES, idempotent).
			// It lands DRAFT/uncertified — NOT auto-certified (B1); the operator bootstrap-certifies it.
			const recruiter = await seedRecruiterRole(db);
			return {
				ceremony: {
					ok: true,
					seeded: true,
					rolesTotal: result.roles.length,
					rolesCreated: created,
					researcherSeeded: true,
					researcherCreated: researcher.createdRole,
					recruiterSeeded: true,
					recruiterCreated: recruiter.createdRole
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
	},

	// RECOVERY — RE-VERSION a role whose newest version is terminally FAILED (§2.2). NO real
	// spend: this only creates a fresh DRAFT version cloning the failed version's content (new
	// prompt_sha by construction, computed mechanically — never hand-rolled). The failed
	// version is NEVER mutated/un-failed (cert-integrity). Operator-gated by the confirm tick.
	// Idempotent/guarded: a role that already has a drivable version (incl. a just-created one)
	// no-ops rather than spawning an unbounded version chain — double-submit safe.
	reversion: async ({ request }) => {
		const db = tryGetDb();
		if (!db) return fail(503, { ceremony: { error: 'database not connected' } });
		const form = await request.formData();
		const role = String(form.get('role') ?? '').trim();
		if (!role) return fail(400, { ceremony: { error: 'missing role id' } });
		if (form.get('operatorConfirmed') !== 'on') {
			return fail(400, {
				ceremony: {
					role,
					reversion: true,
					error: 'confirm the re-version — it creates a NEW draft version cloning the failed one (the failed version stays failed and immutable, §2.2)'
				}
			});
		}
		try {
			const result = await reversionFailedRole(db, role);
			return {
				ceremony: {
					ok: true,
					role,
					reversion: true,
					reversioned: result.reversioned,
					...(result.version ? { newVersion: result.version.version } : {}),
					...(result.from ? { fromVersion: result.from.version } : {}),
					...(result.reason ? { reason: result.reason } : {})
				}
			};
		} catch (err) {
			if (err instanceof WorkforceInputError) {
				return fail(400, { ceremony: { role, reversion: true, error: err.message } });
			}
			return fail(500, { ceremony: { role, reversion: true, error: (err as Error).message } });
		}
	},

	// HR-1 — §3.4 ADJUDICATE an 'adjudicating' run's ambiguous queue (the operator is the
	// judge; there is no judge agent — B4). BATCH-OR-NOTHING: adjudicateInterviewRun resolves
	// ALL items of one run in a single call and finalizes vs the SNAPSHOT pass bar, or fails;
	// the write-path is REUSED verbatim from 16.6 (the same one /agents uses — not forked).
	// Every field is validated at the boundary (named errors: bad JSON / non-array / bad
	// index|resolution) before the engine sees it.
	adjudicate: async ({ request }) => {
		const db = tryGetDb();
		if (!db) return fail(503, { ceremony: { adjudicate: true, error: 'database not connected' } });
		const form = await request.formData();
		const run = String(form.get('run') ?? '').trim();
		const raw = String(form.get('resolutions') ?? '');
		if (!run) return fail(400, { ceremony: { adjudicate: true, error: 'missing run id' } });

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return fail(400, { ceremony: { adjudicate: true, run, error: 'resolutions must be valid JSON' } });
		}
		if (!Array.isArray(parsed)) {
			return fail(400, { ceremony: { adjudicate: true, run, error: 'resolutions must be an array' } });
		}
		const resolutions: Array<{ index: number; resolution: AmbiguousResolution; note?: string }> = [];
		for (const r of parsed) {
			const o = r as Record<string, unknown>;
			const index = Number(o.index);
			const resolution = String(o.resolution) as AmbiguousResolution;
			if (!Number.isInteger(index) || !VALID_RESOLUTIONS.has(resolution)) {
				return fail(400, {
					ceremony: {
						adjudicate: true,
						run,
						error: 'each resolution needs an integer index and a valid resolution (confirm_hit / false_positive / dismiss)'
					}
				});
			}
			resolutions.push({
				index,
				resolution,
				...(typeof o.note === 'string' && o.note.trim() ? { note: o.note.trim() } : {})
			});
		}

		try {
			const updated = await adjudicateInterviewRun(db, run, { resolutions });
			return { ceremony: { ok: true, adjudicate: true, run: updated.id, status: updated.status } };
		} catch (err) {
			// WorkforceInputError = a named operator/validation error (bad index, wrong status,
			// partial queue) — surface its message; anything else is a 500-class.
			if (err instanceof WorkforceInputError) {
				return fail(400, { ceremony: { adjudicate: true, run, error: err.message } });
			}
			return fail(500, { ceremony: { adjudicate: true, run, error: (err as Error).message } });
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
		// HR-4 PRE-PASS — the operator ask: HR (autoAdjudicateRun) clears the CLEAR cases of an
		// 'adjudicating' run everywhere the operator/ceremony flow scores ambiguous, NOT only the
		// recruiter campaign. REUSED verbatim (no fork of the clear-vs-escalate logic, B3):
		//   • ALL-clear → HR finalizes the run via the EXISTING batch-or-nothing adjudicate bar
		//     (B4 — the shared pass/fail bar, never a hand-flip); the queue empties, the run goes
		//     off the operator's adjudication list entirely.
		//   • ANY escalate (incl. EVERY partial — a judgment HR never auto-confirms; and ANY
		//     fabrication — HR NEVER auto-FPs) → HR resolves NOTHING (batch-or-nothing); the run
		//     STAYS 'adjudicating' with the genuine-doubt items for the operator, who sees HR's
		//     per-item recommendation+basis on the surface and resolves only those.
		// A run that did not finalize as 'adjudicating' (clear pass/fail, queued, or error) skips
		// the pre-pass and surfaces as before. autoAdjudicateRun is read-only on B3 (the scorer is
		// untouched); the only finalize path is the shared adjudicate bar (B4).
		if (outcome.kind === 'ran' && outcome.run.status === 'adjudicating') {
			const auto = await autoAdjudicateRun(db, outcome.run.id);
			if (auto.kind === 'auto_resolved') {
				// HR cleared every item and finalized against the snapshot bar — surface the finalized
				// run (status passed/failed) plus how many items HR auto-resolved, so the operator audits.
				return {
					ceremony: {
						ok: true,
						roleVersion: roleVersionId,
						kind: 'interview',
						...outcomeResult({ kind: 'ran', run: auto.run }),
						hrAutoResolved: auto.plan.decisions.length,
						hrEscalated: 0
					}
				};
			}
			// ANY escalate (or an empty queue) — the run stays 'adjudicating' for the operator. The
			// per-item split renders on the adjudication card (buildCeremonyAdjudication.hrDecisions).
			return {
				ceremony: {
					ok: true,
					roleVersion: roleVersionId,
					kind: 'interview',
					...outcomeResult(outcome),
					hrAutoResolved: auto.plan.decisions.length - auto.plan.escalated.length,
					hrEscalated: auto.plan.escalated.length
				}
			};
		}
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
