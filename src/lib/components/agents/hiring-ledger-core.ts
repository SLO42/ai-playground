// THE HIRING FEED — the pure view logic behind the /agents "hiring & certification activity" card.
//
// OPERATOR REVIEW 2026-07-26 §5 + §13: the card rendered 36 near-identical rows, every one
// `Gauntlet scored … recall —`. The server read model (workforce/repo.listHiringActivity) now joins
// the `interview_run` each ledger row already pointed at and groups the events into ceremony
// threads; THIS module owns the two remaining view decisions, kept out of the markup so they are
// unit-testable:
//
//   • WHICH ceremonies to show. 19 of the 36 runs BROKE (§13: 15 spawn_failure + 4 scorer_error,
//     9 of them duplicate auto-retries). They are dead noise in the default view — but they are
//     REAL history, so they are FILTERED, never dropped: the count is disclosed and one control
//     brings them back. The DB rows are never touched.
//   • HOW to state a ceremony's facts. recall / FP / tier / model / status, each rendering an
//     honest '—' when the underlying number genuinely does not exist (a run that planted nothing
//     has an UNDEFINED recall — not 0, not 1).
//
// Nothing here invents a value, and nothing here reaches the DB.

/** The run facts a ceremony carries — structurally mirrors `workforce.HiringRunFacts`. */
export interface HiringRunFactsLike {
	id: string;
	tier?: string | null;
	model_id?: string | null;
	provider?: string | null;
	status?: string | null;
	error_reason?: string | null;
	retry_of?: string | null;
	planted_total?: number | null;
	planted_found?: number | null;
	false_positives?: number | null;
	recall?: number | null;
	stale?: boolean;
	started_at?: string | null;
	ended_at?: string | null;
}

/**
 * The ceremony shape this module needs — declared STRUCTURALLY rather than imported from
 * `$lib/server/**`, because this module compiles into the client bundle and must not reach into
 * the server tree. Every optional field degrades to an honest unknown.
 */
export interface HiringCeremonyLike {
	key: string;
	run?: HiringRunFactsLike | null;
	runMissing?: boolean;
	role?: string | null;
	role_slug?: string | null;
	role_name?: string | null;
	events: ReadonlyArray<{ id: string; op: string; at: string | null; detail?: Record<string, unknown> }>;
	at?: string | null;
	errored?: boolean;
	isRetry?: boolean;
}

/** One stated fact on a ceremony header — `label` is for the a11y/title text, `text` is shown. */
export interface CeremonyFact {
	/** A machine key so the renderer can tint (`status`, `recall`, `fp`, `tier`, `model`, `error`). */
	kind: 'status' | 'recall' | 'fp' | 'tier' | 'model' | 'error' | 'stale' | 'retry' | 'missing';
	text: string;
	/** The long form for a `title` tooltip; null when `text` already says everything. */
	detail: string | null;
}

/** The default view hides ceremonies whose run BROKE — reversible, counted, never destructive. */
export interface CeremonyView {
	/** The ceremonies to render under the current filter. */
	visible: HiringCeremonyLike[];
	/** How many were filtered out. 0 ⇒ the surface shows no filter control at all. */
	hiddenCount: number;
}

/**
 * Apply the errored-run filter.
 *
 * Shadow paths:
 *   • nil / non-array  → `{ visible: [], hiddenCount: 0 }` (the card falls to its honest empty
 *                        state — never a filter control over nothing).
 *   • empty            → same.
 *   • showErrored=true → everything visible, hiddenCount 0.
 *   • ALL errored      → `visible: []` with a non-zero `hiddenCount`; the renderer MUST say
 *                        "all N runs broke" rather than "nothing has happened", which would be a
 *                        lie of omission (F-008).
 */
export function filterCeremonies(
	ceremonies: readonly HiringCeremonyLike[] | null | undefined,
	showErrored: boolean
): CeremonyView {
	if (!Array.isArray(ceremonies) || ceremonies.length === 0) {
		return { visible: [], hiddenCount: 0 };
	}
	if (showErrored) return { visible: [...ceremonies], hiddenCount: 0 };
	const visible = ceremonies.filter((c) => c?.errored !== true);
	return { visible, hiddenCount: ceremonies.length - visible.length };
}

/**
 * Group + filter in one call — the single entry point the page uses.
 * The server already grouped by run; this is the view-side pass.
 */
export function groupHiringCeremonies(
	ceremonies: readonly HiringCeremonyLike[] | null | undefined,
	showErrored: boolean
): CeremonyView {
	return filterCeremonies(ceremonies, showErrored);
}

/** Percentage, rounded, for a 0..1 ratio. */
function pct(r: number): string {
	return `${Math.round(r * 100)}%`;
}

/**
 * State a ceremony's run facts as a list of chips.
 *
 * Every fact is derived from a REAL persisted column; a column that does not exist produces NO
 * chip rather than a placeholder chip, except where the absence is itself the news:
 *   • `runMissing`   → an explicit `run not found` chip (a dangling pointer is a fact, not a blank).
 *   • recall unknown → `recall —` is emitted ONLY when the run exists but planted nothing, so the
 *                      operator can tell "0 plants" apart from "no run joined".
 *
 * Shadow paths: nil ceremony → `[]`; a ceremony with no run and no missing-pointer flag (e.g. a
 * `staffed` act, which never had a gauntlet) → `[]`, and the row simply shows its own event detail.
 */
export function ceremonyFacts(c: HiringCeremonyLike | null | undefined): CeremonyFact[] {
	if (!c) return [];
	const facts: CeremonyFact[] = [];
	if (c.runMissing === true) {
		facts.push({
			kind: 'missing',
			text: 'run not found',
			detail: 'this ledger row points at an interview_run that no longer resolves'
		});
		return facts;
	}
	const run = c.run;
	if (!run) return facts;

	if (run.status) {
		facts.push({
			kind: run.status === 'error' ? 'error' : 'status',
			text: run.status === 'error' ? `run broke · ${run.error_reason ?? 'reason unrecorded'}` : run.status,
			detail:
				run.status === 'error'
					? 'the gauntlet run itself failed — this is not a verdict on the candidate'
					: null
		});
	}
	// SCORE FACTS ARE SUPPRESSED ON A BROKEN RUN — the single most important honesty rule here.
	//
	// A run that died at `spawn_failure` still has `planted_total` SET (the fixtures were planted
	// before the candidate was ever spawned) and `planted_found` sitting at its 0 default. Stating
	// that verbatim renders `recall 0/4 (0%)` — which reads as "the candidate found none of the 4
	// planted defects", a damning verdict on an agent that never got to answer. It sat directly
	// beneath a chip whose own tooltip says "this is not a verdict on the candidate", and it was
	// live on all 19 broken runs. The zero is not a measurement, it is an uninitialised column
	// (F-008: an honest unknown, never a plausible-looking fabricated value).
	//
	// Same argument for false_positives: `0 FP` on a crashed run measures nothing.
	// `status === 'error'` is the ONLY gate — the error chip above already states what happened.
	const scored = run.status !== 'error';
	if (scored) {
		// recall: honest '—' when the run planted nothing (undefined, not zero).
		if (run.planted_total != null && run.planted_total > 0 && run.planted_found != null) {
			const r = run.recall ?? run.planted_found / run.planted_total;
			facts.push({
				kind: 'recall',
				text: `recall ${run.planted_found}/${run.planted_total} (${pct(r)})`,
				detail: 'planted defects the candidate found, over planted defects total'
			});
		} else if (run.status) {
			facts.push({
				kind: 'recall',
				text: 'recall —',
				detail: 'the run planted no defects, so recall is undefined — not zero'
			});
		}
		if (run.false_positives != null) {
			facts.push({
				kind: 'fp',
				text: `${run.false_positives} FP`,
				detail: 'false positives: findings the scorer could not match to a planted defect'
			});
		}
	}
	if (run.tier) facts.push({ kind: 'tier', text: run.tier, detail: 'the tier the gauntlet ran at' });
	if (run.model_id) {
		facts.push({
			kind: 'model',
			text: run.model_id,
			detail: run.provider ? `provider: ${run.provider}` : 'the certification axis (§2.4)'
		});
	}
	if (c.isRetry === true) {
		facts.push({
			kind: 'retry',
			text: 'auto-retry',
			detail: `an automatic re-run of ${run.retry_of ?? 'an earlier run'} (§3.6)`
		});
	}
	if (run.stale === true) {
		facts.push({
			kind: 'stale',
			text: 'fixtures changed since',
			detail: 'the fixture pool moved after this run (§3.7) — an honest flag, not a revocation'
		});
	}
	return facts;
}
