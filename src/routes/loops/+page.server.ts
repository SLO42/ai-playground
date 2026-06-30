// LOOPS — the global Loops surface loader (LOOP-ENGINEERING.md; operator directive 2026-06-29).
//
// Phase 1 = VIEW + IDENTIFY. Serves the FOUR real recurring loops Atelier runs as one honest typed
// view (LP-1 getLoops) — every global loop plus every project's PM loops — alongside a project-id →
// display-name map so the grouped UI can title each per-project block. Degrades honestly (D-019,
// F-008): a disconnected DB or a cached-but-dead handle yields connected:false + empty loops, never a
// fabricated card. getLoops itself surfaces honest 'not running'/'not yet run' states when the live
// orchestrator/PM singletons are absent.

import { fail } from '@sveltejs/kit';
import { tryGetDb } from '$lib/server/db/runtime-init';
import { classifyDbError } from '$lib/server/db/classify';
import { assertRecordId } from '$lib/server/db/validate';
import { listProjects } from '$lib/server/projects/repo';
import { getLoops, type LoopView } from '$lib/server/loops/read';
import { updatePmSchedule, setPmAutonomous } from '$lib/server/projects/pm-repo';
import { parseCron, parseDurationMs } from '$lib/server/projects/pm-triggers';
import {
	listLoopManifest,
	upsertLoopManifest,
	setLoopChecklistItem,
	setLoopPhase,
	reconcileLoops,
	manifestByIdentifier,
	type LoopManifestRow,
	type LoopManifestKind,
	type ReconciledLoop
} from '$lib/server/loops/manifest';
import { armAutonomousLoop } from '$lib/server/loops/arm-gate';
import type { DeclaredPhase } from '$lib/components/loops/readiness-core';
import type { PageServerLoad, Actions } from './$types';

export interface LoopsData {
	connected: boolean;
	loops: LoopView[];
	/** The declared layer (manifest rows) — keyed for the running cards + the declared-only section. */
	manifest: LoopManifestRow[];
	/** identifier → manifest row, so each running LoopCard finds its declared/readiness state. */
	manifestMap: Record<string, LoopManifestRow>;
	/** Declared loops with NO live counterpart — surfaced honestly as 'not currently running' (F-008). */
	declaredOnly: ReconciledLoop[];
	/** project record id → display name, for the per-project group headings. */
	projectNames: Record<string, string>;
}

function disconnected(): LoopsData {
	return {
		connected: false,
		loops: [],
		manifest: [],
		manifestMap: {},
		declaredOnly: [],
		projectNames: {}
	};
}

const VALID_KINDS: ReadonlySet<string> = new Set([
	'orchestrator',
	'pm-autonomous',
	'pm-cadence',
	'memory-review',
	'game-verify'
]);

function asKind(raw: FormDataEntryValue | null): LoopManifestKind | null {
	const s = String(raw ?? '').trim();
	return VALID_KINDS.has(s) ? (s as LoopManifestKind) : null;
}

function asPhase(raw: FormDataEntryValue | null): DeclaredPhase | null {
	const s = String(raw ?? '').trim();
	return s === 'L1' || s === 'L2' || s === 'L3' ? s : null;
}

export const load: PageServerLoad = async ({ depends }): Promise<LoopsData> => {
	// Live by default (§1.2): a run-history event, a PM arm/cadence change, a session change, or a
	// project change re-invalidates and re-reads getLoops (which re-samples the live armed singletons).
	depends('app:loops');
	depends('app:analytics'); // agent_event — run history + drain activity
	depends('app:pm'); // pm — cadence / authority / autonomous arm changes
	depends('app:fleet'); // session — loop activity
	depends('app:projects'); // project — names + membership

	depends('app:loops-manifest'); // loop — declared manifest + readiness changes

	const db = tryGetDb();
	if (!db) return disconnected();

	try {
		const [loops, projects, manifest] = await Promise.all([
			getLoops(db),
			listProjects(db),
			listLoopManifest(db)
		]);
		const projectNames: Record<string, string> = {};
		for (const p of projects) projectNames[p.id] = p.name;
		// Reconcile declared-vs-running (F-008): running cards are enriched with their manifest row;
		// declared loops with no live counterpart surface as an honest 'not currently running' section.
		const reconciled = reconcileLoops(manifest, loops);
		const declaredOnly = reconciled.filter((r) => r.status === 'declared-not-running');
		return {
			connected: true,
			loops,
			manifest,
			manifestMap: manifestByIdentifier(manifest),
			declaredOnly,
			projectNames
		};
	} catch (err) {
		// A cached-but-dead handle throws here — a non-null handle does not prove liveness. Classify
		// the same way Home/Workflows do and degrade to honest disconnected (D-019), never a fake loop.
		void classifyDbError(err);
		return disconnected();
	}
};

/**
 * Validate a form-supplied project record id at the D-016 boundary. The global Loops surface, unlike
 * the per-project tab, carries the target projectId IN THE FORM (the card knows its own loop.projectId),
 * so it must be validated here — a bad/missing id fails loudly (400), never silently writes elsewhere.
 * Returns the canonical record id string, or null (the action maps that to a named 400).
 */
function formProjectId(raw: FormDataEntryValue | null): string | null {
	const s = String(raw ?? '').trim();
	if (!s) return null;
	try {
		return assertRecordId(s);
	} catch {
		return null;
	}
}

/**
 * Loops Phase 2 — the in-UI EDIT actions for the two NO-restart, DB-MERGE loop controls. These MIRROR
 * the per-project /projects/[id] actions of the same names (the LoopCard form posts to whichever route
 * hosts it); the only difference is projectId comes FROM THE FORM here and is validated at the boundary
 * (D-016). Both reuse the already-validated repo write paths (updatePmSchedule / setPmAutonomous) and the
 * SAME parsers the trigger engine fires with (parseCron / parseDurationMs) — no new write infra, no
 * restart (the orchestrator/trigger engine read these live).
 */
export const actions: Actions = {
	// Set/clear a PM's periodic cadence (5-field cron) + optional duration offset. A malformed cron/offset
	// is a NAMED 400 (an expression that saves is an expression that fires); empty values clear the field.
	pmSchedule: async ({ request }) => {
		const db = tryGetDb();
		if (!db) return fail(503, { pm: { error: 'Database not connected — start SurrealDB and retry.' } });

		const form = await request.formData();
		const projectId = formProjectId(form.get('projectId'));
		if (!projectId) return fail(400, { pm: { error: 'invalid project id' } });

		const cadence = String(form.get('cadence') ?? '').trim();
		const offset = String(form.get('cadenceOffset') ?? '').trim();

		if (cadence && !parseCron(cadence)) {
			return fail(400, {
				pm: {
					error:
						'Cadence must be a 5-field cron expression (minute hour day month weekday), e.g. "0 9 * * 1-5". Leave empty to clear.'
				}
			});
		}
		if (offset && parseDurationMs(offset) === null) {
			return fail(400, {
				pm: { error: 'Offset must be a duration like "5m", "90s" or "1h30m". Leave empty to clear.' }
			});
		}

		try {
			const updated = await updatePmSchedule(db, projectId, {
				cadence: cadence || null,
				cadenceOffset: offset || null
			});
			if (!updated) {
				return fail(409, { pm: { error: 'No PM hired for this project yet — hire one first.' } });
			}
			return {
				pm: {
					ok: true as const,
					action: 'schedule',
					cadence: updated.cadence ?? null,
					cadenceOffset: updated.cadence_offset ?? null
				}
			};
		} catch (err) {
			return fail(500, { pm: { error: (err as Error).message } });
		}
	},

	// ARM/DISARM the autonomous drive. DISARM (the kill switch) is NEVER gated — you can always pause
	// unsupervised work. ARM (promote to L3 autonomy) routes through the READINESS GATE (LOOP-ENGINEERING
	// step 5): the loop's Design Checklist must be green, OR the operator records an explicit override.
	// A not-ready arm is blocked (409) and the missing items are surfaced. Arming never auto-hires (no PM
	// ⇒ 409); it never grants publish/hire authority (D-037/D-039 stay in force in the loop itself).
	pmAutonomous: async ({ request }) => {
		const db = tryGetDb();
		if (!db) return fail(503, { pm: { error: 'Database not connected — start SurrealDB and retry.' } });

		const form = await request.formData();
		const projectId = formProjectId(form.get('projectId'));
		if (!projectId) return fail(400, { pm: { error: 'invalid project id' } });

		const armed = String(form.get('armed') ?? '').trim() === 'true';

		// DISARM — never gated (the kill switch). Direct write.
		if (!armed) {
			try {
				const updated = await setPmAutonomous(db, projectId, false);
				if (!updated) {
					return fail(409, {
						pm: { error: 'No PM hired for this project yet — hire one first (arming never auto-hires).' }
					});
				}
				return { pm: { ok: true as const, action: 'autonomous', autonomous: updated.autonomous } };
			} catch (err) {
				return fail(500, { pm: { error: (err as Error).message } });
			}
		}

		// ARM — gated. The operator may override (override=true + an optional reason).
		const override = String(form.get('override') ?? '').trim() === 'true';
		const overrideReason = String(form.get('overrideReason') ?? '').trim() || undefined;
		try {
			const result = await armAutonomousLoop(db, projectId, { override, overrideReason });
			if (result.ok) {
				return {
					pm: {
						ok: true as const,
						action: 'autonomous',
						autonomous: result.autonomous,
						overridden: result.overridden
					}
				};
			}
			if (result.reason === 'no-pm') {
				return fail(409, {
					pm: { error: 'No PM hired for this project yet — hire one first (arming never auto-hires).' }
				});
			}
			// not-ready — block + surface the missing Design-Checklist items (honest; never a silent arm).
			return fail(409, {
				pm: {
					error:
						'Loop not ready for autonomy — complete the readiness checklist or override the gate.',
					missing: result.missing.map((m) => m.label)
				}
			});
		} catch (err) {
			return fail(500, { pm: { error: (err as Error).message } });
		}
	},

	// LOOP MANIFEST — declare a loop + tick one Design-Checklist item. The first tick DECLARES the loop
	// (idempotent upsert grounded in the live loop identity carried in the form), then sets the item. This
	// is the readiness-config write path (no restart; the gate reads it live).
	loopChecklist: async ({ request }) => {
		const db = tryGetDb();
		if (!db) return fail(503, { loop: { error: 'Database not connected — start SurrealDB and retry.' } });

		const form = await request.formData();
		const identifier = String(form.get('identifier') ?? '').trim();
		if (!identifier) return fail(400, { loop: { error: 'missing loop identifier' } });
		const kind = asKind(form.get('kind'));
		if (!kind) return fail(400, { loop: { error: 'invalid loop kind' } });
		const label = String(form.get('label') ?? '').trim() || identifier;
		const itemId = String(form.get('itemId') ?? '').trim();
		if (!itemId) return fail(400, { loop: { error: 'missing checklist item' } });
		const checked = String(form.get('checked') ?? '').trim() === 'true';

		// Optional project id (project-scoped loops only) — validated at the D-016 boundary when present.
		const rawProject = String(form.get('projectId') ?? '').trim();
		let projectId: string | null = null;
		if (rawProject) {
			projectId = formProjectId(rawProject);
			if (!projectId) return fail(400, { loop: { error: 'invalid project id' } });
		}

		try {
			await upsertLoopManifest(db, { identifier, kind, label, projectId });
			const updated = await setLoopChecklistItem(db, identifier, itemId, checked);
			return { loop: { ok: true as const, action: 'checklist', checklist: updated?.checklist ?? {} } };
		} catch (err) {
			return fail(500, { loop: { error: (err as Error).message } });
		}
	},

	// LOOP MANIFEST — promote/demote a declared loop's maturity phase (L1→L2→L3). Declares the loop if it
	// is not yet in the manifest (idempotent). Promotion to L3 alone does NOT arm the loop — the arm path
	// (pmAutonomous) still enforces the readiness gate.
	loopPhase: async ({ request }) => {
		const db = tryGetDb();
		if (!db) return fail(503, { loop: { error: 'Database not connected — start SurrealDB and retry.' } });

		const form = await request.formData();
		const identifier = String(form.get('identifier') ?? '').trim();
		if (!identifier) return fail(400, { loop: { error: 'missing loop identifier' } });
		const kind = asKind(form.get('kind'));
		if (!kind) return fail(400, { loop: { error: 'invalid loop kind' } });
		const label = String(form.get('label') ?? '').trim() || identifier;
		const phase = asPhase(form.get('phase'));
		if (!phase) return fail(400, { loop: { error: 'phase must be L1, L2 or L3' } });

		const rawProject = String(form.get('projectId') ?? '').trim();
		let projectId: string | null = null;
		if (rawProject) {
			projectId = formProjectId(rawProject);
			if (!projectId) return fail(400, { loop: { error: 'invalid project id' } });
		}

		try {
			await upsertLoopManifest(db, { identifier, kind, label, projectId, phase });
			const updated = await setLoopPhase(db, identifier, phase);
			return { loop: { ok: true as const, action: 'phase', phase: updated?.phase ?? phase } };
		} catch (err) {
			return fail(500, { loop: { error: (err as Error).message } });
		}
	}
};
