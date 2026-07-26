// /brain — Atelier's highest-level view of ITSELF: the derived soul/identity (S4) + a consolidated
// map of the brain's sections. The cognitive architecture (S0–S4) accrues invisibly; this surface
// makes it legible.
//
// The MUST-HAVE is the SOUL: `loadSoul` computes Atelier's self-model on-read from live brain rows
// (dominant concepts + learned corrections + recall competence + experience volume) and graduates a
// maturity_stage on MEASURABLE thresholds — a cold brain is honestly `nascent`, never a fabricated
// personality (F-008; D-026 screened at the read seam). The consolidation sections REUSE existing
// surfaces: recent architectural `decision` rows (a real source), and links to /reports (spend +
// routing), /memory (recall + search), and /atelier (the global timeline) — no rebuild of those.
//
// Degrades honestly (F-008 / D-019): DB down → connected:false + null soul + empty; a failing read →
// honest error, never a fabricated identity. Live (§1.2): a brain-row change re-invalidates.

import { tryGetDb } from '$lib/server/db/runtime-init';
import { loadSoul, type SoulModel } from '$lib/server/memory/soul';
import {
	listRecentDecisions,
	RECENT_DECISIONS_LIMIT,
	type DecisionRow
} from '$lib/server/memory/decisions';
import {
	listGraduations,
	GRADUATION_TIMELINE_LIMIT,
	ATELIER_SUBJECT,
	type GraduationRow
} from '$lib/server/memory/soul-graduation';
import {
	listConciergeAdvisories,
	CONCIERGE_ADVISORIES_LIMIT,
	type ConciergeAdvisoryRow
} from '$lib/server/projects/concierge-advisories';
import {
	listConciergeTurns,
	CONCIERGE_TURNS_LIMIT,
	type ConciergeTurnRow
} from '$lib/server/concierge/turn-events';
import type { PageServerLoad } from './$types';

export interface BrainData {
	connected: boolean;
	/** The derived self-model, or null when the brain is unreachable. */
	soul: SoulModel | null;
	/** The identity's graduation timeline (newest-first); [] when it has never graduated (S4). */
	graduations: GraduationRow[];
	/** Recent architectural decisions (newest-first); [] when none / unreachable. */
	decisions: DecisionRow[];
	/** Recent concierge advisories across ALL projects (Path-B PM consults, pending → answered),
	 *  newest-first + bounded; [] when no PM has ever consulted (honest empty, F-008). */
	advisories: ConciergeAdvisoryRow[];
	/** COMPLETION-LEDGER Wave A — the concierge's THINKING ledger: one row per advisory turn
	 *  (what was asked, what it decided, which brain served it), newest-first + bounded. [] when
	 *  the concierge has never been consulted (honest empty, F-008 — never a fabricated turn). */
	turns: ConciergeTurnRow[];
	error?: string;
}

export const load: PageServerLoad = async ({ depends }): Promise<BrainData> => {
	depends('app:brain');

	const db = tryGetDb();
	if (!db) {
		return { connected: false, soul: null, graduations: [], decisions: [], advisories: [], turns: [] };
	}

	try {
		const [soul, graduations, decisions, advisories, turns] = await Promise.all([
			loadSoul(db),
			listGraduations(db, ATELIER_SUBJECT, GRADUATION_TIMELINE_LIMIT),
			listRecentDecisions(db, RECENT_DECISIONS_LIMIT),
			listConciergeAdvisories(db, { limit: CONCIERGE_ADVISORIES_LIMIT }),
			// Deliberately NOT wrapped in its own catch: a swallowed read would render "no concierge
			// turns yet", which is exactly the fabricated-empty lie F-008 forbids. A throw lands on
			// the honest connected:false path below, where the operator can SEE that it failed.
			listConciergeTurns(db, { limit: CONCIERGE_TURNS_LIMIT })
		]);
		return { connected: true, soul, graduations, decisions, advisories, turns };
	} catch (err) {
		return {
			connected: false,
			soul: null,
			graduations: [],
			decisions: [],
			advisories: [],
			turns: [],
			error: (err as Error).message
		};
	}
};
