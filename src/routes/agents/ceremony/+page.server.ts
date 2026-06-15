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
// NO real spend here: reference-runs / interviews (steps ③/④, CER2) are NOT triggered.
// F-008: seedLaunchPool lands honest (proposed/no-keys/draft); nothing auto-runs.

import { tryGetDb } from '$lib/server/db/runtime-init';
import {
	ceremonyAuthoringState,
	confirmLaunchKey,
	CeremonyGateError,
	seedLaunchPool,
	WorkforceInputError,
	type CeremonyAuthoringState
} from '$lib/server/workforce';
import { fail, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export interface CeremonyPageData {
	connected: boolean;
	state: CeremonyAuthoringState | null;
	error?: string;
}

export const load: PageServerLoad = async ({ depends }): Promise<CeremonyPageData> => {
	// Re-derive live off the ONE SSE stream (D-035): a role/role_version/fixture create (seed)
	// re-invalidates this loader. A key confirm re-loads via its own form-action response (the
	// answer-key table is server-internal, never watched from a route — §4.4 leak boundary).
	depends('app:workforce');

	const db = tryGetDb();
	if (!db) return { connected: false, state: null };
	try {
		const state = await ceremonyAuthoringState(db);
		return { connected: true, state };
	} catch (err) {
		return { connected: false, state: null, error: (err as Error).message };
	}
};

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
	}
};
