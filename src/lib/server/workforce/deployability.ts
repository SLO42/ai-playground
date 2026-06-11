// TASK 16.3 — W-D7a: the §2.4 deployability resolver — THE spawn-time invariant,
// FAIL-CLOSED. A (version, model) pair is spawnable iff there EXISTS an
// interview_run with status='passed' AND model_id=$resolved AND prompt_sha equal
// to the version's prompt_sha. Certification key = (prompt_sha × model_id):
// the tier label is UX; the resolved model_id is integrity — a model swap inside
// a tier honestly demands re-interview ("certified on <old model_id>").
//
// Lifecycle interplay (§2.4, as ruled — G4):
//   • only 'failed'/'withdrawn' lifecycle (or sha mismatch) hard-block;
//   • 'retired' stays pinnable-spawnable indefinitely (pins are a stability
//     contract; surfaced via `retired: true` for the 'produced by retiring vN'
//     annotation, §4.3) — retirement of the global incumbent does NOT break pins;
//   • stale=true runs still certify (honest flag, §3.7), surfaced via `stale`.
//
// The resolver never throws for a "not deployable" answer — it RETURNS the honest
// named reason (the spawn gate renders it); it throws only on caller bugs
// (malformed ids hit the D-016 chokepoint inside repo helpers).

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import { getRole, getRoleVersion } from './repo';

/** The resolver's honest answer. `reason` is non-null EXACTLY when not deployable. */
export interface DeployabilityVerdict {
	deployable: boolean;
	/** Named, honest reason when blocked; null when deployable. */
	reason: string | null;
	/** The certifying interview_run id when deployable (latest fresh, else latest stale). */
	certifiedBy: string | null;
	/** §3.7 — every matching certification predates a fixture-pool change (still valid, flagged). */
	stale: boolean;
	/** The version is lifecycle 'retired' — spawnable for pins, annotated (§2.4/§4.6). */
	retired: boolean;
}

function blocked(reason: string): DeployabilityVerdict {
	return { deployable: false, reason, certifiedBy: null, stale: false, retired: false };
}

interface PassedRunRow {
	id: unknown;
	prompt_sha: string;
	model_id: string;
	stale: boolean;
	started_at: unknown;
}

/**
 * §2.4 — is THIS version spawnable at THIS resolved model_id? Fail-closed: every
 * path that cannot positively prove a passing (prompt_sha × model_id) interview
 * returns deployable:false with the honest named reason. This is also the PIN
 * check (§6 resolveStaff lands in v2.3): pins survive swaps AND retirement because
 * this function never consults role.active_version.
 */
export async function checkDeployability(
	db: Db,
	roleVersionId: string,
	modelId: string
): Promise<DeployabilityVerdict> {
	if (typeof modelId !== 'string' || !modelId.trim()) {
		return blocked('no resolved model_id — deployability is keyed on (prompt_sha × model_id), fail closed (§2.4)');
	}
	const version = await getRoleVersion(db, roleVersionId);
	if (!version) {
		return blocked(`role_version not found: ${roleVersionId} — fail closed`);
	}
	if (version.lifecycle === 'failed' || version.lifecycle === 'withdrawn') {
		return blocked(
			`role_version v${version.version} is lifecycle '${version.lifecycle}' — hard-blocked (§2.4: only failed/withdrawn or sha mismatch block a pin)`
		);
	}

	const vid = new StringRecordId(assertRecordId(version.id));
	// All passed runs at the requested model (F-022: ORDER BY field projected).
	const [atModel] = await db.query<[PassedRunRow[]]>(
		`SELECT id, prompt_sha, model_id, stale, started_at FROM interview_run
		  WHERE role_version = $vid AND status = 'passed' AND model_id = $model
		  ORDER BY started_at DESC LIMIT 100;`,
		{ vid, model: modelId }
	);
	const runs = atModel ?? [];
	const matching = runs.filter((r) => r.prompt_sha === version.prompt_sha);

	if (runs.length > 0 && matching.length === 0) {
		// Passing run(s) exist at this model but certify DIFFERENT prompt text — the
		// §2.4 hard fail (tamper/import drift; content fields are immutable, so a
		// mismatch means the run does not vouch for this version's text).
		return blocked(
			`prompt_sha mismatch — the passing interview(s) at ${modelId} certify different prompt text ` +
				`than role_version v${version.version} carries; re-interview required (§2.4 hard fail)`
		);
	}
	if (matching.length === 0) {
		// Never certified at THIS model. Honest extra: say where it IS certified.
		const [elsewhere] = await db.query<[Array<{ model_id: string }>]>(
			`SELECT model_id FROM interview_run
			  WHERE role_version = $vid AND status = 'passed' AND prompt_sha = $sha LIMIT 100;`,
			{ vid, sha: version.prompt_sha }
		);
		const others = [...new Set((elsewhere ?? []).map((r) => r.model_id))].sort();
		if (others.length > 0) {
			return blocked(
				`no passing interview at ${modelId} — certified on ${others.join(', ')} ` +
					`(a model swap inside a tier demands re-interview, §2.4)`
			);
		}
		return blocked(
			`never certified — no passing interview exists for (prompt_sha × ${modelId}); run the gauntlet (§2.4 fail-closed)`
		);
	}

	// Deployable. Prefer the latest FRESH certification; fall back to the latest
	// stale one (stale still certifies, flagged — §3.7).
	const fresh = matching.find((r) => !r.stale);
	const certifying = fresh ?? matching[0];
	return {
		deployable: true,
		reason: null,
		certifiedBy: String(certifying.id),
		stale: !fresh,
		retired: version.lifecycle === 'retired'
	};
}

/**
 * §2.4 — the UNPINNED consumer path: resolve through role.active_version (the
 * §2.3 single source of truth), then run the (prompt_sha × model_id) check.
 * Fail-closed honest empties: missing role, no incumbent (NONE = not deployable).
 */
export async function resolveActiveDeployability(
	db: Db,
	roleId: string,
	modelId: string
): Promise<DeployabilityVerdict & { roleVersion: string | null }> {
	const role = await getRole(db, roleId);
	if (!role) return { ...blocked(`role not found: ${roleId} — fail closed`), roleVersion: null };
	if (!role.active_version) {
		return {
			...blocked(
				`role '${role.slug}' has no active version — not deployable (run an interview and swap it in, §2.3)`
			),
			roleVersion: null
		};
	}
	const verdict = await checkDeployability(db, role.active_version, modelId);
	return { ...verdict, roleVersion: role.active_version };
}
