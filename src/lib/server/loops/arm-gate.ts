// LOOP ARM GATE — the readiness gate on promoting a loop to autonomy (LOOP-ENGINEERING.md step 5).
//
// A loop may arm for the unsupervised autonomous drive (L3 — auto-act) ONLY after its Loop Design
// Checklist is green (readiness/readiness-core.ts) — OR the operator records an explicit OVERRIDE (the
// operator is sovereign; the gate is a guard rail, not a wall). This is the gate the /loops `pmAutonomous`
// ARM path routes through. It NEVER weakens the deeper gates: arming still grants no publish/hire authority
// (D-037/D-039 stay in force in the loop itself), and DISARM (the kill switch) is NEVER gated — you can
// always pause unsupervised work.
//
// Composition: this layers ON TOP of setPmAutonomous (pm-repo) — it does not replace it, so PROGRAMMATIC
// arming (e.g. the autonomous-to-v1 directive) that calls setPmAutonomous directly is unchanged; only the
// operator UI arm path is gated. The pm-autonomous loop's manifest identifier mirrors loops/read.ts:
// `pm-auto:<projectId>`.

import type { Db } from '../db/client';
import { getPm, setPmAutonomous } from '../projects/pm-repo';
import { getLoopManifest, upsertLoopManifest, setLoopOverride } from './manifest';
import { evaluateReadiness, type ChecklistItem } from '../../components/loops/readiness-core';

/** The pm-autonomous loop's stable manifest identifier (matches the runtime LoopView id, read.ts:59). */
export function pmAutonomousLoopIdentifier(projectId: string): string {
	return `pm-auto:${projectId}`;
}

/** The result of an arm attempt — a discriminated union the route action maps to an HTTP status. */
export type ArmResult =
	| { ok: true; autonomous: boolean; overridden: boolean }
	| { ok: false; reason: 'no-pm' }
	| { ok: false; reason: 'not-ready'; missing: ChecklistItem[] };

export interface ArmOptions {
	/** The operator's sovereign override of the readiness gate (arm even when not green). */
	override?: boolean;
	/** Why the override was taken — recorded on the manifest for the run log. */
	overrideReason?: string;
}

/**
 * ARM a project's autonomous PM loop, gated on readiness. Order:
 *   1. No hired PM ⇒ 'no-pm' (arming never auto-hires — integrity LOCKED), checked FIRST so a no-PM
 *      project reports honestly rather than being masked by a readiness block.
 *   2. Readiness gate: if the loop's Design Checklist is NOT green AND no override is recorded/requested,
 *      return 'not-ready' with the missing items — NOTHING is armed.
 *   3. Override: when requested, DECLARE the loop (idempotent upsert grounded in the live PM name) and
 *      record the override (override + reason + when) BEFORE arming, so the decision is in the run log.
 *   4. Arm via setPmAutonomous (the existing validated write path).
 * A persisted override on the manifest also satisfies the gate on subsequent arms without re-requesting it.
 */
export async function armAutonomousLoop(
	db: Db,
	projectId: string,
	opts: ArmOptions = {}
): Promise<ArmResult> {
	const pm = await getPm(db, projectId);
	if (!pm) return { ok: false, reason: 'no-pm' };

	const identifier = pmAutonomousLoopIdentifier(projectId);
	const existing = await getLoopManifest(db, identifier);
	const readiness = evaluateReadiness(existing?.checklist);
	const overrideRequested = opts.override === true;
	const overrideAlreadyRecorded = existing?.override === true;

	if (!readiness.green && !overrideRequested && !overrideAlreadyRecorded) {
		return { ok: false, reason: 'not-ready', missing: readiness.missing };
	}

	const overridden = !readiness.green && (overrideRequested || overrideAlreadyRecorded);
	if (overrideRequested) {
		// Declare the loop (idempotent) so there is a row to stamp the override on, grounded in the live
		// PM identity (F-008 — never an invented label), then record the operator's override decision.
		await upsertLoopManifest(db, {
			identifier,
			kind: 'pm-autonomous',
			label: `${pm.name} — autonomous drive`,
			projectId,
			cadence: null,
			phase: 'L3'
		});
		await setLoopOverride(db, identifier, true, opts.overrideReason);
	}

	const updated = await setPmAutonomous(db, projectId, true);
	if (!updated) return { ok: false, reason: 'no-pm' };
	return { ok: true, autonomous: updated.autonomous, overridden };
}
