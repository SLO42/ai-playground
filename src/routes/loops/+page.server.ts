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
import type { PageServerLoad, Actions } from './$types';

export interface LoopsData {
	connected: boolean;
	loops: LoopView[];
	/** project record id → display name, for the per-project group headings. */
	projectNames: Record<string, string>;
}

function disconnected(): LoopsData {
	return { connected: false, loops: [], projectNames: {} };
}

export const load: PageServerLoad = async ({ depends }): Promise<LoopsData> => {
	// Live by default (§1.2): a run-history event, a PM arm/cadence change, a session change, or a
	// project change re-invalidates and re-reads getLoops (which re-samples the live armed singletons).
	depends('app:loops');
	depends('app:analytics'); // agent_event — run history + drain activity
	depends('app:pm'); // pm — cadence / authority / autonomous arm changes
	depends('app:fleet'); // session — loop activity
	depends('app:projects'); // project — names + membership

	const db = tryGetDb();
	if (!db) return disconnected();

	try {
		const [loops, projects] = await Promise.all([getLoops(db), listProjects(db)]);
		const projectNames: Record<string, string> = {};
		for (const p of projects) projectNames[p.id] = p.name;
		return { connected: true, loops, projectNames };
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

	// ARM/DISARM the autonomous drive (the kill switch). A SAFETY toggle — disarming halts unsupervised
	// work; it never grants authority or bypasses a gate. Arming never auto-hires (no PM ⇒ 409).
	pmAutonomous: async ({ request }) => {
		const db = tryGetDb();
		if (!db) return fail(503, { pm: { error: 'Database not connected — start SurrealDB and retry.' } });

		const form = await request.formData();
		const projectId = formProjectId(form.get('projectId'));
		if (!projectId) return fail(400, { pm: { error: 'invalid project id' } });

		const armed = String(form.get('armed') ?? '').trim() === 'true';
		try {
			const updated = await setPmAutonomous(db, projectId, armed);
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
};
