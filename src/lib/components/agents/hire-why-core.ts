// THE WHY LINE — the pure per-event view logic behind each row of the /agents "hiring &
// certification activity" ceremony threads. Sibling of `hiring-ledger-core.ts`, which owns the
// ceremony HEADER chips; this module owns the EVENT LINE that renders beneath them.
//
// It lived inline in `src/routes/agents/+page.svelte` and was therefore untestable in place —
// which is precisely how the defect below survived a passing review while its sibling shipped a
// 20-case status sweep. The two surfaces state facts about the SAME run, so they must obey the
// SAME honesty rule; keeping them in sibling modules with sibling tests is what makes that
// checkable instead of aspirational.
//
// Nothing here invents a value, and nothing here reaches the DB: every fragment is read out of
// the event's OWN recorded `detail`.

// A run states a SCORE only once it has terminally produced one — the SAME gate as
// `hiring-ledger-core.ts` (`ceremonyFacts`, the `scored` const), because the two modules state
// facts about the same run and a disagreement between them IS the defect. That rule, and the
// column provenance behind it, is defined once in `$lib/shared/interview-status` and pinned to
// the schema ASSERT by a parity test — it used to be a private copy in this file.
import { isScoredStatus } from '$lib/shared/interview-status';

/**
 * The WHY line for one ledger row, built from the event's OWN recorded detail — never
 * inferred and never fabricated. Each op explains itself with the facts that decided it; an
 * op whose detail is missing the expected keys falls through to '' and the row still renders
 * (honest partial, never a fake reason).
 */
export function hireWhy(op: string, detail: Record<string, unknown> | undefined): string {
	const d = detail ?? {};
	const num = (k: string): number | null => (typeof d[k] === 'number' ? (d[k] as number) : null);
	const str = (k: string): string | null => (typeof d[k] === 'string' ? (d[k] as string) : null);
	/**
	 * The recall fragment for THIS ledger row's own detail, or null when the row never recorded
	 * the numbers.
	 *
	 * Returning null (rather than the literal `recall —`) matters now that the row sits inside a
	 * ceremony thread: the ceremony HEADER states the authoritative recall joined from the
	 * `interview_run` (`recall 4/4 (100%)`), and the pre-wave flat detail (`{run, status}`) has no
	 * numbers of its own. Emitting `recall —` here printed a contradiction directly beneath the
	 * real figure — and it was the exact string the operator flagged as papering the card. The
	 * honest-unknown case is still stated, once, by `ceremonyFacts` (which can tell "planted
	 * nothing" apart from "no run joined"); repeating a weaker guess here only adds noise.
	 *
	 * CALLERS OWN TERMINALITY. This helper only reports what the detail holds — whether the
	 * numbers are a VERDICT or an in-flight lower bound depends on the op, so each case gates it.
	 */
	const recallPart = (): string | null => {
		const found = num('planted_found');
		const total = num('planted_total');
		const r = num('recall');
		if (found === null || total === null || total === 0) return null;
		return `recall ${found}/${total}${r !== null ? ` (${Math.round(r * 100)}%)` : ''}`;
	};
	switch (op) {
		case 'gauntlet_started': {
			const bits = [str('trigger'), str('tier'), str('model_id')].filter(Boolean);
			const plants = num('planted_total');
			return [bits.join(' · '), plants !== null ? `${plants} plants` : null].filter(Boolean).join(' · ');
		}
		case 'interviewed': {
			// THE SCORE GATE. `emitGauntletScored` fires on EVERY finalize status, not only the
			// terminal ones (`workforce/repo.ts` — an 'adjudicating' outcome previously left no trace
			// at all), and the 'adjudicating' finalize in `workforce/gauntlet.ts` DOES pass
			// planted_total/planted_found, so `detail.recall` is a real 0..1 number on a run that is
			// still parked on the operator. Ungated, this line stated `adjudicating · recall 2/4
			// (50%)` directly beneath a header whose chips deliberately withhold that very figure —
			// the card contradicting itself, and the provisional number reading as the verdict.
			const status = str('status');
			const scored = isScoredStatus(status);
			const bits = [status, scored ? recallPart() : null];
			// FP rides the same gate: the pass bar is the only writer, so a non-terminal run's
			// `false_positives` is an uninitialised column, never a measurement.
			const fp = scored ? num('false_positives') : null;
			if (fp !== null) bits.push(`${fp} FP`);
			const err = str('error_reason');
			if (err) bits.push(err);
			if (d.demotion_withheld === true) bits.push('evidence only — no demotion');
			return bits.filter(Boolean).join(' · ');
		}
		case 'adjudicated': {
			const bits = [
				`${num('items') ?? 0} item(s)`,
				`${num('confirmed_hits') ?? 0} confirmed`,
				`${num('false_positives') ?? 0} FP`,
				`${num('dismissed') ?? 0} dismissed`
			];
			const after = str('status_after');
			if (after) bits.push(`→ ${after}`);
			return bits.join(' · ');
		}
		case 'reversioned':
			return str('reason') ?? `from ${str('from_lifecycle') ?? 'a failed version'}`;
		case 'candidate_considered': {
			// NOT gated, and that is not an oversight: a cert_hire brief can only be raised off a
			// TERMINAL run — `workforce/recruiter-hire.ts` refuses anything outside
			// {passed, failed} before `emitCandidateConsidered` is ever reached — so these numbers
			// are a verdict by construction. The detail carries no `status` key to gate on precisely
			// because terminality was already enforced upstream.
			const bits = [`recommends ${str('recommendation') ?? '—'}`, recallPart()];
			const esc = num('escalated');
			if (esc) bits.push(`${esc} escalated`);
			return bits.filter(Boolean).join(' · ');
		}
		case 'hired':
		case 'hire_rejected': {
			const bits = [`recruiter recommended ${str('recommendation') ?? '—'}`];
			if (d.overrode_recommendation === true) bits.push('OPERATOR OVERRODE');
			if (op === 'hired') bits.push(d.cert_flipped === true ? 'cert flipped' : 'cert already set');
			if (d.staffed_in_same_act === true) bits.push('staffed in same act');
			return bits.join(' · ');
		}
		case 'staffed': {
			const bits = [str('project') ?? '', str('source') ?? ''].filter(Boolean);
			if (d.re_staff === true) bits.push('re-staff');
			return bits.join(' · ');
		}
		default:
			return '';
	}
}

/** The falsifier — the honest strongest reason NOT to follow the recommendation (D-038).
 *  Surfaced only where the event actually recorded one. */
export function hireFalsifier(detail: Record<string, unknown> | undefined): string | null {
	const f = detail?.falsifier;
	return typeof f === 'string' && f.trim() ? f : null;
}
