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

import { isScoredStatus } from '$lib/shared/interview-status';

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
	/** The pointer was past the read's hydration cap — never queried. See {@link ceremonyFacts}. */
	runUnfetched?: boolean;
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
	kind:
		| 'status'
		| 'recall'
		| 'fp'
		| 'tier'
		| 'model'
		| 'error'
		| 'stale'
		| 'retry'
		| 'missing'
		| 'unfetched';
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

/** The header count line + the tooltip that keeps it honest. */
export interface CeremonyCountLabel {
	text: string;
	/** The long form for a `title`; null when `text` already says everything. */
	detail: string | null;
}

/**
 * The card's header count.
 *
 * ── DEFECT #2, LIVE-CONFIRMED (2026-08-04, /agents on real data) ────────────────────────────
 * The header read `36 ceremonies · one event each` directly above a list rendering 17 rows,
 * because the list defaults to `showBrokenRuns=false` and 19 of the 36 runs broke. A total that
 * does not describe the visible rows, sitting on top of them. Both integers were true; the
 * PAIRING was the lie (F-008) — the same defect class as the fleet-collapsed inversion, one
 * surface over.
 *
 * THE RULE, taken from how `/claude-code` already solved this (`.fleet-window`: `showing
 * {visibleFleet.length} of {fleet.length}`, plus a separate sentence naming what is excluded):
 * when a filter narrows the list, the header says `showing V of N ceremonies` — the leading
 * number is what you can SEE, the trailing one is what was LOADED — and the detail names the
 * hidden count separately. The two numbers are never folded into a bare "N of M" whose numerator
 * a reader has to infer, which is exactly the shape that inverted in `fleetCollapsedSummary`.
 * This is that convention, not a third one.
 *
 * WHY THE UNFILTERED TEXT IS NOT JUST `${n} ceremonies · ${m} events`. On today's live data the
 * two numbers are EQUAL (36 · 36) — the ledger holds exactly one `interviewed` row per
 * `interview_run`, because `emitGauntletStarted` (workforce/repo.ts) post-dates every run
 * currently in the DB, so no ceremony has yet emitted a second event. The grouping is therefore
 * CORRECT and doing nothing: a 1:1 join, not a broken one. Rendering "36 ceremonies · 36 events"
 * implies threading that has not happened, which is a lie of implication even though both
 * integers are true. So when every thread is a singleton the header says so, and explains why.
 *
 * The event clause is DELIBERATELY dropped from the filtered text and moved into the detail:
 * `totalEvents` counts events across the LOADED set, so printing it beside a filtered ceremony
 * count would re-commit the very defect this rewrite closes.
 *
 * Shadow paths:
 *   • nil/empty ceremonies      → the honest zero (the card renders its empty state anyway).
 *   • `totalEvents` absent / impossible (fewer events than threads, i.e. a read model that could
 *     not count) → state the ceremony count alone rather than publishing arithmetic that cannot
 *     be true.
 *   • `visibleCount` absent / not a number → treated as UNFILTERED. A caller that cannot tell us
 *     what is on screen must not have a "showing …" fabricated on its behalf.
 *   • `visibleCount` out of range (negative, or greater than the loaded count) → clamped into
 *     [0, n]; clamping to n lands on the unfiltered text, which is the honest reading of "the
 *     list is not narrower than what was loaded".
 *   • `visibleCount === 0` with n > 0 (every row filtered out) → `showing 0 of N ceremonies`. The
 *     card also renders its own "every run broke" body; the header must not silently read "N".
 */
export function ceremonyCountLabel(
	ceremonies: readonly HiringCeremonyLike[] | null | undefined,
	totalEvents: number | null | undefined,
	visibleCount?: number | null
): CeremonyCountLabel {
	const n = Array.isArray(ceremonies) ? ceremonies.length : 0;
	const noun = `${n} ceremon${n === 1 ? 'y' : 'ies'}`;
	if (n === 0) return { text: noun, detail: null };

	const eventsKnown =
		typeof totalEvents === 'number' && Number.isFinite(totalEvents) && totalEvents >= n;
	const eventsClause = !eventsKnown
		? 'the ledger event total was not available for this read'
		: totalEvents === n
			? `${n} ledger event${n === 1 ? '' : 's'} loaded — one per ceremony, so grouping has nothing to fold yet`
			: `${totalEvents} ledger events loaded, folded into ${noun}`;

	// FILTERED: the visible count leads, the loaded count follows, the hidden count is named on
	// its own so neither number can be mistaken for the other.
	const visible =
		typeof visibleCount === 'number' && Number.isFinite(visibleCount)
			? Math.min(Math.max(Math.floor(visibleCount), 0), n)
			: n;
	if (visible < n) {
		const hidden = n - visible;
		return {
			text: `showing ${visible} of ${n} ceremonies`,
			detail:
				`${visible} shown · ${hidden} hidden by the broken-run filter · ${n} loaded in this ` +
				`window. ${eventsClause}.`
		};
	}

	// UNFILTERED: the header describes exactly the rows below it, so it states the loaded set.
	if (!eventsKnown) {
		return { text: noun, detail: eventsClause };
	}
	if (totalEvents === n) {
		return {
			text: `${noun} · one event each`,
			detail:
				'every ceremony here carries exactly one ledger event, so grouping has nothing to fold yet — ' +
				'a gauntlet emits its second event (gauntlet_started) only on runs launched since that ' +
				'emitter landed. Threads will fold as soon as one does.'
		};
	}
	return {
		text: `${noun} · ${totalEvents} event${totalEvents === 1 ? '' : 's'}`,
		detail: `${totalEvents} ledger events folded into ${noun}`
	};
}

/** Percentage, rounded, for a 0..1 ratio. */
function pct(r: number): string {
	return `${Math.round(r * 100)}%`;
}

// ── The run-hydration cap notice ─────────────────────────────────────────────────────────

/** Structural mirror of `workforce.HiringRunFetch` (this module must not import from server). */
export interface HiringRunFetchLike {
	pointers?: number | null;
	hydrated?: number | null;
	cap?: number | null;
	unfetched?: number | null;
	capped?: boolean;
}

/** A count safe to print: nil / negative / NaN / non-number → 0. */
function safeCount(n: unknown): number {
	return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * The notice shown when the feed's run-hydration cap actually bit — `null` when it did not, so
 * the surface renders no note at all rather than a reassuring "nothing was truncated" line.
 *
 * THE DEFECT THIS CLOSES. The cap used to drop surplus pointers with no marker anywhere; the
 * affected rows rendered `run not found`, and an operator reading them concluded the ledger
 * pointed at deleted runs. Two separate lies for the price of one silent `if`.
 *
 * NOTE ON COVERAGE — the `.uo-truncation` note already on /agents is about a DIFFERENT window
 * (the capability usage roll-up's session scan). It never described this read and never could;
 * mistaking it for coverage is how this one stayed unsurfaced.
 *
 * The two numbers are NAMED, never folded into a bare "N of M" whose numerator a reader has to
 * infer — the same rule `fleetCollapsedSummary` was rewritten under after that shape inverted
 * live (F-008).
 *
 * TWO CLAIMS THIS NOTE MAY NOT MAKE, both fixed here after the first draft made them (F-008):
 *   • "Those runs exist." It cannot know that. A pointer past the cap was never QUERIED, so a
 *     dangling pointer and a healthy one are indistinguishable from this read — asserting
 *     existence is the same fabrication the chip text avoids ("not missing, not asked for").
 *   • "loaded". `hydrated` is `runIds.length` — pointers this read ASKED ABOUT, not rows that
 *     came back (repo.ts HiringRunFetch says so in its own doc). A malformed pointer inside the
 *     cap is counted here and still resolves to nothing, so "requested" is the only true verb.
 *
 * Shadow paths: nil/undefined → null. `capped:false` → null. `capped:true` with a shortfall that
 * does not add up (0 or negative after the safe-count) → recomputed from pointers − hydrated, and
 * null if THAT is not positive either: a note we cannot state a true number in is worse than none.
 */
export function runFetchNotice(f: HiringRunFetchLike | null | undefined): string | null {
	if (!f || f.capped !== true) return null;
	const pointers = safeCount(f.pointers);
	const hydrated = safeCount(f.hydrated);
	const shortfall = safeCount(f.unfetched) || pointers - hydrated;
	if (shortfall <= 0) return null;
	const rows = `${shortfall} ceremon${shortfall === 1 ? 'y' : 'ies'}`;
	return (
		`Run details were requested for ${hydrated} of ${pointers} ceremonies that name a gauntlet run — ` +
		`${rows} below show “run details not fetched” instead of recall/model, and the broken-run ` +
		`count covers only the ones this read asked about. Every row is still listed; this load ` +
		`stopped fetching at its cap of ${safeCount(f.cap)} (bounded read, F-014), so their run rows ` +
		`were never checked here — a fetch bound, not a finding about the data.`
	);
}

/**
 * State a ceremony's run facts as a list of chips.
 *
 * Every fact is derived from a REAL persisted column; a column that does not exist produces NO
 * chip rather than a placeholder chip, except where the absence is itself the news:
 *   • `runUnfetched` → `run details not fetched` — this read hit its hydration cap and never
 *                      QUERIED this pointer. Checked FIRST, and deliberately so: before this chip
 *                      existed a capped-out pointer fell through to `runMissing` and rendered
 *                      `run not found`, reporting a data-integrity problem where the only fact was
 *                      a fetch bound. An honest state produced by a dishonest cause is the most
 *                      misleading outcome available, because it survives review looking correct.
 *   • `runMissing`   → an explicit `run not found` chip (a dangling pointer is a fact, not a blank).
 *   • recall unknown → `recall —` is emitted ONLY when a TERMINAL run planted nothing, so the
 *                      operator can tell "0 plants" apart from "no run joined".
 *
 * Score facts (recall, FP) require a TERMINAL status — see the gate below for why a non-terminal
 * run's `planted_found` / `false_positives` are uninitialised columns rather than measurements.
 *
 * Shadow paths: nil ceremony → `[]`; a ceremony with no run and no missing-pointer flag (e.g. a
 * `staffed` act, which never had a gauntlet) → `[]`, and the row simply shows its own event detail.
 */
export function ceremonyFacts(c: HiringCeremonyLike | null | undefined): CeremonyFact[] {
	if (!c) return [];
	const facts: CeremonyFact[] = [];
	// UNFETCHED BEFORE MISSING. Both produce `run === null`; only one of them is news about the
	// DATA. If a read ever sets both (it must not — the server makes them exclusive), saying
	// "not fetched" is the claim we can actually stand behind.
	if (c.runUnfetched === true) {
		facts.push({
			kind: 'unfetched',
			text: 'run details not fetched',
			detail:
				'this read hit its per-load cap on interview_run lookups, so this ceremony’s run was ' +
				'never queried — the run is not missing, it was not asked for (bounded read, F-014)'
		});
		return facts;
	}
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
	// SCORE FACTS ARE STATED ONLY BY A RUN THAT TERMINALLY PRODUCED THEM — the single most
	// important honesty rule here, and the one the first cut got only half right.
	//
	// Gating on `status !== 'error'` alone conflated "the run did not break" with "the run produced
	// this number", and still rendered `recall 0/4 (0%)` + `0 FP` on every in-flight gauntlet —
	// from the instant `gauntlet_started` lands, since the run is born 'running'. That reads as
	// "the candidate found none of the 4 planted defects": a damning verdict on an agent that has
	// not answered yet, sitting directly beneath a chip whose own tooltip says "this is not a
	// verdict on the candidate" (F-008). It is the same lie the error path was fixed for, at a
	// sibling status.
	//
	// The rule itself — WHICH statuses have produced a score, and the column provenance that
	// decides it — now lives ONCE in `$lib/shared/interview-status`, anchored to the schema ASSERT
	// by a parity test. It used to be spelled here, in `hire-why-core.ts`, and in
	// `workforce/recruiter-hire.ts` independently; nothing made those three agree, which is exactly
	// how the event line beneath these chips shipped ungated while these chips were correct.
	const scored = isScoredStatus(run.status);
	if (scored) {
		// recall: honest '—' when the run planted nothing (undefined, not zero).
		if (run.planted_total != null && run.planted_total > 0 && run.planted_found != null) {
			const r = run.recall ?? run.planted_found / run.planted_total;
			facts.push({
				kind: 'recall',
				text: `recall ${run.planted_found}/${run.planted_total} (${pct(r)})`,
				detail: 'planted defects the candidate found, over planted defects total'
			});
		} else {
			// `scored` already proves the status is terminal, so no status re-check is needed here.
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
