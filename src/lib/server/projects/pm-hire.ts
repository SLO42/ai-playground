// TASK 16.1 — the PM HIRE flow (PM-SPEC §1): hiring = context-building.
//
// "Hire PM" replaces the bare bootstrap: it runs the project scan + plan-macro read
// (the existing bootstrapPm seeds) + a recent-history digest over LIVE rows, conducts
// the Six Forcing Questions interview (harvested: gstack office-hours/SKILL.md, MIT —
// the ONE surface allowed to interrogate), and persists the result as the `pm` row +
// founding `pm_memory` rows. The operator writes the charter IN the same flow.
//
// HONESTY (F-008):
//   • every founding memory derives from a real signal — the detected project row, a
//     live count, or the operator's own words (recorded verbatim);
//   • a question the operator skips is recorded as "unanswered at hire" — an honest
//     gap, never backfilled;
//   • smart-skip is server-authoritative and conservative: a question is pre-answered
//     ONLY when the project's plan macro carries a concrete corresponding field, and
//     the founding memory QUOTES that evidence verbatim (the G1 presence-claim rule —
//     a scan can evidence a written plan, it can never evidence demand or observation,
//     so those questions are never auto-skipped).
//
// INTERRUPT CONTRACT: any step can die and the hire will be RE-RUN. The `pm` row is
// created FIRST (the UNIQUE pm_by_project index makes a concurrent double-hire collide,
// D-008); a re-run detects the existing row and COMPLETES the missing founding memories
// instead of duplicating them (bootstrapPm is already idempotent; interview memories are
// gated on "no hire-interview rows exist yet").

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import { listTasksByProject } from '../tasks/repo';
import { listFindings } from '../scanner/findings-repo';
import { getProject, type ProjectPlan } from './repo';
import {
	addPmMemory,
	bootstrapPm,
	createPm,
	getPm,
	listPmMemory,
	type AddPmMemoryInput,
	type PmMemoryRow,
	type PmRow
} from './pm-repo';

// ── The Six Forcing Questions (PM-SPEC §1, verbatim intent) ──────────────────────

export type HireQuestionId =
	| 'demand_reality'
	| 'status_quo'
	| 'specificity'
	| 'narrowest_wedge'
	| 'observation'
	| 'future_fit';

export interface HireQuestion {
	id: HireQuestionId;
	label: string;
	question: string;
	/** The push-once follow-up — asked once past the first polished answer, skippable. */
	push: string;
}

export const HIRE_QUESTIONS: readonly HireQuestion[] = [
	{
		id: 'demand_reality',
		label: 'Demand reality',
		question:
			"What evidence exists that someone actually wants this project's output — who would be upset if it vanished? \"Interested\" is not evidence.",
		push: 'Push once: name the single strongest piece of that evidence — and what would falsify it?'
	},
	{
		id: 'status_quo',
		label: 'Status quo',
		question:
			'What is done today to solve this, even badly, and what does that workaround cost?',
		push: 'Push once: if the workaround is bearable, why is now the moment to replace it?'
	},
	{
		id: 'specificity',
		label: 'Specificity',
		question:
			'Name the actual human this serves (a category is not a person). What concrete consequence do they face if it stays unsolved?',
		push: 'Push once: when did you last talk to that person about this problem?'
	},
	{
		id: 'narrowest_wedge',
		label: 'Narrowest wedge',
		question:
			'What is the smallest version that delivers real value this week — not after the platform exists?',
		push: 'Push once: what could you cut from even that and still deliver real value?'
	},
	{
		id: 'observation',
		label: 'Observation',
		question:
			'Has anyone watched a real user/run, unaided? What surprised you? ("Nothing surprising" usually means "not watching".)',
		push: "Push once: what did they do that the design didn't expect?"
	},
	{
		id: 'future_fit',
		label: 'Future-fit',
		question:
			"If this project's ecosystem looks meaningfully different in 3 years, does it become more or less essential — and why?",
		push: 'Push once: what single ecosystem change would make this project pointless?'
	}
];

/** A hire question resolved against one project: asked, or pre-answered by the scan. */
export interface HireInterviewQuestion extends HireQuestion {
	/** Set when the project scan already answers it (smart-skip) — evidence quoted verbatim. */
	preAnswered: { source: string; evidence: string } | null;
}

/**
 * Resolve the Six Forcing Questions against one project's plan macro (smart-skip).
 * Pure + conservative: only `narrowest_wedge` (← plan.definition_of_done) and
 * `future_fit` (← plan.long_term_vision) can be pre-answered — a written plan field is
 * real evidence for those two; nothing in a scan can evidence demand, the status quo,
 * a named human, or an unaided observation, so the other four are ALWAYS asked.
 */
export function hireInterviewFor(project: { plan?: ProjectPlan }): HireInterviewQuestion[] {
	const plan = project.plan;
	const pre = (id: HireQuestionId): { source: string; evidence: string } | null => {
		if (id === 'narrowest_wedge' && plan?.definition_of_done?.trim()) {
			return { source: 'plan.definition_of_done', evidence: plan.definition_of_done.trim() };
		}
		if (id === 'future_fit' && plan?.long_term_vision?.trim()) {
			return { source: 'plan.long_term_vision', evidence: plan.long_term_vision.trim() };
		}
		return null;
	};
	return HIRE_QUESTIONS.map((q) => ({ ...q, preAnswered: pre(q.id) }));
}

// ── The hire flow ─────────────────────────────────────────────────────────────────

/** One interview answer in the operator's words (or an explicit skip). */
export interface HireAnswer {
	id: HireQuestionId;
	/** The operator's answer, verbatim. Absent/empty + skipped ⇒ an honest gap. */
	answer?: string;
	/** The push-once follow-up answer, when the operator engaged it. */
	push?: string;
	/** True when the operator used the escape hatch on this question. */
	skipped?: boolean;
}

export interface HirePmInput {
	project: string;
	name: string;
	/** The charter the operator wrote in the hire flow (optional — editable later). */
	charter?: string;
	persona?: string;
	answers: HireAnswer[];
}

export interface HirePmResult {
	pm: PmRow;
	/** False ⇒ a PM already existed (idempotent re-run absorbed it). */
	hired: boolean;
	alreadyHired: boolean;
	/** The founding pm_memory rows THIS call wrote (scan + digest + interview). */
	foundingMemories: PmMemoryRow[];
}

const KNOWN_IDS = new Set<string>(HIRE_QUESTIONS.map((q) => q.id));

/** The hire-interview memory source tags (queried by the re-run absorption gate). */
const SRC_INTERVIEW = 'hire-interview';
const SRC_SCAN = 'hire-scan';

/**
 * Hire the project's PM (PM-SPEC §1). Creates the `pm` row, seeds founding memories
 * from the live project scan (bootstrapPm) + a recent-history digest + the interview
 * answers, and persists the operator-written charter on the pm row. Idempotent over
 * re-runs: an existing pm row is absorbed and only MISSING founding memories are
 * completed — never duplicated, never overwritten.
 */
export async function hirePm(db: Db, input: HirePmInput): Promise<HirePmResult> {
	const project = await getProject(db, input.project);
	if (!project) throw new Error(`project not found: ${input.project}`);

	const name = input.name.trim();
	if (!name) throw new Error('hirePm: a PM name is required');
	for (const a of input.answers) {
		if (!KNOWN_IDS.has(a.id)) {
			throw new Error(`hirePm: unknown interview question id "${a.id}"`);
		}
	}

	// 1. The pm row FIRST (interrupt contract): a re-run finds it and completes the rest;
	//    a concurrent double-hire collides on the UNIQUE index instead of duplicating.
	const existing = await getPm(db, input.project);
	const alreadyHired = existing !== null;
	const pm =
		existing ??
		(await createPm(db, {
			project: input.project,
			name,
			...(input.charter?.trim() ? { charter: input.charter.trim() } : {}),
			...(input.persona?.trim() ? { persona: input.persona.trim() } : {})
		}));

	const founding: PmMemoryRow[] = [];

	// 2. Project scan + plan-macro read — the existing bootstrapPm seeds (idempotent:
	//    a project that already carries PM memory is left intact, rows returned).
	const boot = await bootstrapPm(db, input.project);
	if (boot.bootstrapped) founding.push(...boot.memories);

	// 3. Recent-history digest from LIVE rows (F-008 — real counts or an honest clean
	//    slate; never fabricated). Gated on absence so a re-run does not duplicate it.
	const priorScan = (await listPmMemory(db, input.project)).filter(
		(m) => m.source === SRC_SCAN
	);
	if (priorScan.length === 0) {
		const [tasks, findings, sessionCountRows] = await Promise.all([
			listTasksByProject(db, input.project),
			listFindings(db, input.project),
			db.query<[{ n: number }[]]>(
				`SELECT count() AS n FROM session WHERE project = $project GROUP ALL;`,
				{ project: pmLink(input.project) }
			)
		]);
		const sessions = sessionCountRows[0][0]?.n ?? 0;
		const byStatus = new Map<string, number>();
		for (const t of tasks) byStatus.set(t.status, (byStatus.get(t.status) ?? 0) + 1);
		const statusBits = [...byStatus.entries()].map(([s, n]) => `${n} ${s}`).join(', ');
		const digest =
			tasks.length + findings.length + sessions > 0
				? `Hired with history: ${tasks.length} task(s)` +
					(statusBits ? ` (${statusBits})` : '') +
					`, ${sessions} recorded session(s), ${findings.length} open finding(s).`
				: 'Hired on a clean slate — no tasks, sessions, or findings recorded yet.';
		founding.push(
			await addPmMemory(db, {
				project: input.project,
				kind: 'observation',
				content: digest,
				source: SRC_SCAN,
				confidence: 1.0
			})
		);
	}

	// 4. The interview — answers land as founding memories in the operator's words;
	//    smart-skipped questions quote the plan evidence verbatim; operator skips are
	//    recorded as honest gaps. Gated on absence (interrupt-safe re-run completion).
	const priorInterview = (await listPmMemory(db, input.project)).filter(
		(m) => m.source === SRC_INTERVIEW
	);
	if (priorInterview.length === 0) {
		const answerById = new Map(input.answers.map((a) => [a.id, a]));
		const seeds: AddPmMemoryInput[] = [];
		for (const q of hireInterviewFor(project)) {
			if (q.preAnswered) {
				seeds.push({
					project: input.project,
					kind: 'observation',
					content:
						`Hire interview — ${q.label}: pre-answered by the project scan ` +
						`(${q.preAnswered.source}): "${q.preAnswered.evidence}"`,
					source: SRC_INTERVIEW,
					confidence: 0.9,
					importance: 6
				});
				continue;
			}
			const a = answerById.get(q.id);
			const answer = a?.answer?.trim();
			if (a && answer && !a.skipped) {
				seeds.push({
					project: input.project,
					kind: 'observation',
					content:
						`Hire interview — ${q.label}: ${answer}` +
						(a.push?.trim() ? `\nPushed once: ${a.push.trim()}` : ''),
					source: SRC_INTERVIEW,
					confidence: 1.0,
					importance: 7
				});
			} else {
				// The operator escape hatch — respected immediately, recorded honestly (F-008).
				seeds.push({
					project: input.project,
					kind: 'observation',
					content:
						`Unanswered at hire — ${q.label} ("${q.question}"). ` +
						'The operator skipped this question; recorded as an honest gap, never backfilled.',
					source: SRC_INTERVIEW,
					confidence: 1.0,
					importance: 4
				});
			}
		}
		for (const seed of seeds) founding.push(await addPmMemory(db, seed));
	}

	return { pm, hired: !alreadyHired, alreadyHired, foundingMemories: founding };
}

// Local record-link helper (mirrors pm-repo's): validated at the D-016 chokepoint.
function pmLink(id: string): StringRecordId {
	return new StringRecordId(assertRecordId(id));
}
