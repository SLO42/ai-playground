// TASK 16.6 (W-D7b) — the §3.3 FINDINGS-FILE CONTRACT (WORKFORCE-SPEC §3.3, G1).
//
// The gauntlet candidate writes `findings.json` at the workspace root. This module is
// the PRODUCT-CODE validator of that file: a strict, named-reason parser that turns the
// raw text into typed findings or an honest rejection. The contract (G1 evidence rule):
//   • presence finding — {fixture, file, lines, class, evidence} where `evidence` is a
//     VERBATIM quote from the work (file:line + quote = G1 presence evidence);
//   • absence finding  — {fixture, absence: {artifact, search}} (a named missing
//     artifact + the search that proves the absence = G1 absence evidence).
//
// An absent or invalid findings.json is a CAPABILITY failure ('findings contract
// violated'), never an env error — the runner finalizes the run honestly `failed` with
// the recorded reason and the raw output preserved as evidence (§3.3).
//
// Shadow paths are first-class here (gstack plan-ceo-review Prime Directive): nil input
// (caller handles the absent file), empty input, non-JSON, a non-array root, and every
// malformed-entry shape return a NAMED reason — never a throw into the runner and never
// a silently-coerced finding. An EMPTY ARRAY is VALID: 'no findings' is a legitimate
// outcome (§4.1 — abstention is surfaced, not punished by the parser).

/** A normalized presence finding (defect seen in the work). */
export interface PresenceFinding {
	kind: 'presence';
	/** Fixture slug the finding targets (folder name in the run workspace). */
	fixture: string;
	/** Relative path within the fixture (POSIX-normalized). */
	file: string;
	/** Inclusive line range; null when the candidate gave none. */
	lines: [number, number] | null;
	/** Defect class label (free string; the scorer matches plants mechanically). */
	class: string;
	/** Verbatim quote from the work (G1 presence evidence). */
	evidence: string;
}

/** A normalized absence finding (an expected artifact is missing). */
export interface AbsenceFinding {
	kind: 'absence';
	fixture: string;
	/** The named missing artifact. */
	artifact: string;
	/** The search that proves the absence (G1 absence evidence). */
	search: string;
}

export type Finding = PresenceFinding | AbsenceFinding;

export type ParseFindingsResult =
	| { ok: true; findings: Finding[] }
	| { ok: false; reason: string };

/** Upper bound on accepted findings — a spray report beyond this is a contract
 *  violation, not a scoring exercise (the FP bar would fail it anyway; bounding the
 *  parse keeps the scorer and the adjudication queue sane). */
export const MAX_FINDINGS = 200;

const POSIX_SLASH = /\\/g;

function nonEmptyString(v: unknown): v is string {
	return typeof v === 'string' && v.trim().length > 0;
}

/** Normalize `lines` input: a single number, "12" / "12-18" strings, or [start, end]. */
function parseLines(v: unknown): [number, number] | null | 'invalid' {
	if (v === undefined || v === null) return null;
	if (typeof v === 'number' && Number.isInteger(v) && v > 0) return [v, v];
	if (typeof v === 'string') {
		const m = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(v);
		if (!m) return 'invalid';
		const a = Number(m[1]);
		const b = m[2] ? Number(m[2]) : a;
		return a > 0 && b >= a ? [a, b] : 'invalid';
	}
	if (Array.isArray(v) && v.length === 2) {
		const [a, b] = v;
		if (
			typeof a === 'number' &&
			typeof b === 'number' &&
			Number.isInteger(a) &&
			Number.isInteger(b) &&
			a > 0 &&
			b >= a
		) {
			return [a, b];
		}
		return 'invalid';
	}
	return 'invalid';
}

/**
 * Parse + validate the raw `findings.json` text against the §3.3 contract.
 * Strict and named: the FIRST violation rejects the whole file with the reason —
 * a half-valid report is not partially scored (the contract is the capability).
 */
export function parseFindingsFile(raw: string): ParseFindingsResult {
	if (typeof raw !== 'string' || raw.trim() === '') {
		return { ok: false, reason: 'findings.json is empty — the contract requires a JSON array (write [] for no findings)' };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		return { ok: false, reason: `findings.json is not valid JSON: ${(err as Error).message}` };
	}
	if (!Array.isArray(parsed)) {
		return { ok: false, reason: 'findings.json root must be a JSON array of findings' };
	}
	if (parsed.length > MAX_FINDINGS) {
		return {
			ok: false,
			reason: `findings.json carries ${parsed.length} findings — beyond the ${MAX_FINDINGS} contract bound`
		};
	}

	const findings: Finding[] = [];
	for (let i = 0; i < parsed.length; i++) {
		const entry = parsed[i];
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
			return { ok: false, reason: `findings[${i}] must be an object` };
		}
		const e = entry as Record<string, unknown>;
		if (!nonEmptyString(e.fixture)) {
			return { ok: false, reason: `findings[${i}].fixture must name the fixture slug` };
		}
		const fixture = e.fixture.trim();

		if (e.absence !== undefined) {
			// ── absence finding ────────────────────────────────────────────────────
			const a = e.absence;
			if (!a || typeof a !== 'object' || Array.isArray(a)) {
				return { ok: false, reason: `findings[${i}].absence must be an object {artifact, search}` };
			}
			const ar = a as Record<string, unknown>;
			if (!nonEmptyString(ar.artifact)) {
				return { ok: false, reason: `findings[${i}].absence.artifact must name the missing artifact` };
			}
			if (!nonEmptyString(ar.search)) {
				return {
					ok: false,
					reason: `findings[${i}].absence.search must record the search proving the absence (G1)`
				};
			}
			findings.push({
				kind: 'absence',
				fixture,
				artifact: ar.artifact.trim(),
				search: ar.search.trim()
			});
			continue;
		}

		// ── presence finding ─────────────────────────────────────────────────────
		if (!nonEmptyString(e.file)) {
			return { ok: false, reason: `findings[${i}].file must be the relative path within the fixture` };
		}
		if (!nonEmptyString(e.class)) {
			return { ok: false, reason: `findings[${i}].class must name the defect class` };
		}
		if (!nonEmptyString(e.evidence)) {
			return {
				ok: false,
				reason: `findings[${i}].evidence must be a verbatim quote from the work (G1)`
			};
		}
		const lines = parseLines(e.lines);
		if (lines === 'invalid') {
			return {
				ok: false,
				reason: `findings[${i}].lines must be a line number, "start-end", or [start, end]`
			};
		}
		findings.push({
			kind: 'presence',
			fixture,
			file: e.file.trim().replace(POSIX_SLASH, '/'),
			lines,
			class: e.class.trim(),
			evidence: e.evidence.trim()
		});
	}
	return { ok: true, findings };
}
