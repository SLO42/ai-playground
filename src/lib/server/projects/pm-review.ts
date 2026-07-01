// TASK 11.4 — PM periodic review (deferred from 9.1; GAP-ANALYSIS §1.1 / wave v1.7).
//
// A schedulable (and manually-triggerable) PM review PASS over one project. The PM examines
// the project's LIVE state — its tasks (by status), its open security findings, and its
// existing open risks — and writes typed PM-memory entries (observation / risk / decision)
// plus a `pm_review` summary row surfaced in the PM tab. This is the strategic-layer
// counterpart to v1's reviewProjectPlan, rebuilt LEAN on the SurrealDB spine (no SQLite).
//
// HONESTY (F-008): EVERY memory the pass writes is derived from a REAL row it read — a real
// blocked task, a real critical finding, a real stale backlog. The pass NEVER fabricates an
// observation; when a project is healthy it says so honestly (one observation, no risks).
//
// D-004 (orchestration mode): the review honors the configured mode. MANUAL mode → the pass
// runs ONLY when the operator triggers it (the route action enforces this by refusing a
// non-manual trigger when mode === "manual"). PERIODIC / EVENT modes permit an automatic
// trigger. The engine itself is mode-agnostic (it just records the trigger it was given);
// the GATE lives at the caller (the route action), so a unit test can drive any trigger and
// the live policy is asserted at the boundary the operator actually hits.
//
// Boundary discipline (D-016): every value binds via $param downstream (addPmMemory /
// addPmReview); the project id is validated at the chokepoint there. This module composes
// existing repos — it adds NO new query surface of its own.

import type { Db } from './../db/client';
import { listTasksByProject, type TaskRow, type TaskStatus } from '../tasks/repo';
import { listFindings, type FindingRow } from '../scanner/findings-repo';
import { getProject } from './repo';
import { assemblePmContext, type PmContextBundle } from './pm-session';
import { proposeTask, type ProposalOpts, type ProposeTaskResult, type ProposeTaskInput } from './pm-proposals';
import { deriveGithubTriage, type GithubTriageResult } from './pm-triage';
import {
	maybeEmitConciergeConsult,
	surfaceConciergeReplies,
	type PmConciergeDeps
} from './pm-concierge';
import {
	addPmMemory,
	addPmReview,
	getPm,
	listPmMemory,
	type AddPmMemoryInput,
	type PmMemoryRow,
	type PmReviewProvenance,
	type PmReviewRow,
	type PmReviewTrigger
} from './pm-repo';

/** The outcome of one review pass — the summary row + the typed memories it wrote. */
export interface PmReviewResult {
	review: PmReviewRow;
	/** The typed PM-memory rows this pass wrote (observation / risk / decision). */
	written: PmMemoryRow[];
	/**
	 * TASK 16.1 (PM-SPEC §2): the fenced context bundle this pass ran under — the
	 * charter (when a PM is hired and a charter is in force) + plan macro + accumulated
	 * memory, assembled by the SAME assemblePmContext pmChat uses. The deterministic
	 * derivation below consumes live rows directly; this bundle is the seam the
	 * session-driven review (PM-SPEC §3, trigger-engine task) hands to its PM session.
	 */
	context: PmContextBundle;
	/**
	 * TASK 16.4 (PM-SPEC §4 "Act with Purpose"): the proposals this pass made — tasks
	 * BORN 'proposed' through the proposeTask chokepoint (full §4.1 contract; anti-spam
	 * absorbed: 'capped'/'defer_suppressed' outcomes carry the pm_memory written
	 * instead). Empty when no real signal warranted one, or when the project has no
	 * hired PM / an observe-only PM (`proposalsSkipped` carries the honest reason).
	 */
	proposals: ProposeTaskResult[];
	/** Why proposal derivation did not run, when it didn't (F-008 — named, not silent). */
	proposalsSkipped?: string;
}

/** Group a project's tasks by status (for the review's activity read). */
function countByStatus(tasks: TaskRow[]): Record<string, number> {
	const out: Record<string, number> = {};
	for (const t of tasks) out[t.status] = (out[t.status] ?? 0) + 1;
	return out;
}

const SOURCE = 'pm-review';

/**
 * Run one PM review pass over a project's LIVE state. Reads tasks + findings + open risks,
 * derives typed PM-memory entries from the REAL signals (F-008), persists them + a
 * `pm_review` summary row, and returns both. `trigger` records WHAT kicked the pass off
 * (manual / periodic / event — D-004); the caller enforces the mode policy.
 *
 * TASK 16.2 (PM-SPEC §3): `provenance` is the trigger-engine variant seam — when present,
 * the pass is SCOPED to the trigger evidence: the provenance (kind + real evidence ids +
 * pm.authority at fire time) is stamped onto the pm_review row (migration 0030), and
 * trigger-specific memory seeds are derived from that evidence (a release completion
 * writes a retro LEARNING; a failed release additionally writes a follow-up RISK).
 * Manual button passes pass no provenance — an honest absence.
 *
 * The derivation rules (every one keyed off a real row):
 *   • blocked tasks (> 0)            → a RISK memory (work is stuck).
 *   • critical/high findings (> 0)   → a RISK memory (security debt).
 *   • a long-stale backlog (no ready/in_progress while backlog > 0) → an OBSERVATION.
 *   • the review itself is anchored  → an OBSERVATION summarizing the activity snapshot.
 * When nothing is wrong, the pass still writes the snapshot observation — an honest
 * "reviewed, healthy" — never a fabricated risk.
 */
export async function runPmReview(
	db: Db,
	projectId: string,
	trigger: PmReviewTrigger = 'manual',
	provenance?: PmReviewProvenance,
	opts: ProposalOpts = {},
	conciergeDeps?: PmConciergeDeps
): Promise<PmReviewResult> {
	const project = await getProject(db, projectId);
	if (!project) throw new Error(`project not found: ${projectId}`);

	// Path B (CONVERSATION-LAYER-SPEC): FIRST drain any async Atelier-concierge advisories that
	// landed since the last pass (replies to earlier consults) into pm_memory — BEFORE assembling
	// the context, so surfaced advice is part of THIS pass's PM view. Fail-open (never throws).
	const surfacedAdvisories = await surfaceConciergeReplies(db, projectId);

	// TASK 16.1 (PM-SPEC §2): assemble the durable context layers (charter + plan +
	// memory) BEFORE deriving — the bundle the pass woke up with, charter first.
	const context = await assemblePmContext(db, projectId);

	const tasks = await listTasksByProject(db, projectId);
	const findings = await listFindings(db, projectId);
	const openRisks = await listPmMemory(db, projectId, { kind: 'risk' });

	const byStatus = countByStatus(tasks);
	const blocked = byStatus['blocked'] ?? 0;
	const inFlight = (byStatus['in_progress'] ?? 0) + (byStatus['review'] ?? 0);
	const ready = byStatus['ready'] ?? 0;
	const backlog = byStatus['backlog'] ?? 0;
	const done = byStatus['done'] ?? 0;
	const failed = byStatus['failed'] ?? 0;

	const severe = findings.filter((f) => f.severity === 'critical' || f.severity === 'high');

	// ── Derive typed memories from the REAL signals (F-008) ──────────────────────────
	const seeds: AddPmMemoryInput[] = [];

	// The anchor observation: the activity snapshot this pass examined.
	const snapshot =
		`Review (${trigger}): ${tasks.length} task(s) — ` +
		`${inFlight} in-flight, ${ready} ready, ${backlog} backlog, ${done} done` +
		(failed ? `, ${failed} failed` : '') +
		(blocked ? `, ${blocked} blocked` : '') +
		`. ${findings.length} open finding(s), ${openRisks.length} open risk(s).`;
	seeds.push({
		project: projectId,
		kind: 'observation',
		content: snapshot,
		source: SOURCE,
		confidence: 1.0
	});

	if (blocked > 0) {
		seeds.push({
			project: projectId,
			kind: 'risk',
			content:
				`${blocked} task(s) are BLOCKED — work is stalled. Unblock or re-scope them so ` +
				`the delivery flow resumes.`,
			source: SOURCE,
			confidence: 0.9,
			importance: 7
		});
	}

	if (failed > 0) {
		seeds.push({
			project: projectId,
			kind: 'risk',
			content: `${failed} task(s) ended in FAILED — review the failures and spawn follow-ups.`,
			source: SOURCE,
			confidence: 0.85,
			importance: 6
		});
	}

	if (severe.length > 0) {
		const topRules = [...new Set(severe.map((f) => f.rule))].slice(0, 3).join(', ');
		seeds.push({
			project: projectId,
			kind: 'risk',
			content:
				`${severe.length} unresolved critical/high finding(s) — security/quality debt ` +
				`(${topRules}${severe.length > 3 ? ', …' : ''}). Triage before release.`,
			source: SOURCE,
			confidence: 0.95,
			importance: 8
		});
	}

	if (backlog > 0 && ready === 0 && inFlight === 0) {
		seeds.push({
			project: projectId,
			kind: 'observation',
			content:
				`${backlog} task(s) sit in BACKLOG with nothing ready or in-flight — the queue is ` +
				`idle. Promote the next slice to "ready" to keep momentum.`,
			source: SOURCE,
			confidence: 0.8
		});
	}

	// ── TASK 16.2 — trigger-scoped seeds (PM-SPEC §3 event ④: release retro) ─────────
	// Derived from the REAL trigger evidence the engine passed in (F-008): a completed/
	// failed release writes a retro LEARNING naming the run; a FAILED release additionally
	// writes a follow-up-proposal RISK. Other trigger kinds add no extra seed — their
	// signals (blocked tasks, findings) are already derived from the live rows above, and
	// the wake reason is recorded as pm_review.provenance, not duplicated into memory.
	if (provenance?.kind === 'release') {
		const runRef = provenance.evidence[0] ?? 'unknown run';
		const runStatus = String(provenance.detail?.status ?? 'done');
		const failedRelease = runStatus === 'failed';
		seeds.push({
			project: projectId,
			kind: 'learning',
			content:
				`Release retro: workflow run ${runRef} ended "${runStatus}". ` +
				(failedRelease
					? 'Capture what broke before the next attempt.'
					: 'Record what worked so the next release repeats it.'),
			source: SOURCE,
			confidence: 1.0,
			related_to: provenance.evidence[0]
		});
		if (failedRelease) {
			seeds.push({
				project: projectId,
				kind: 'risk',
				content:
					`Release run ${runRef} FAILED — propose a follow-up task to diagnose the failing ` +
					`stage and re-attempt the release.`,
				source: SOURCE,
				confidence: 0.95,
				importance: 8,
				related_to: provenance.evidence[0]
			});
		}
	}

	// ── TASK 16.5 — GitHub issue/PR TRIAGE (PM-SPEC §5, triage-only) ─────────────────
	// A github_arrival wake triages each arrival the SyncAdapter detected: an honest
	// summary from the REAL arrival metadata, a link/duplicate-check against the 9.4
	// task_sync ledger + open-task titles, and risk flags — persisted as pm_memory
	// notes (source 'pm-triage') with the issue/PR provenance. The §4 proposals the
	// triage derives (issue → triage task; PR → spawn a code-reviewer, INLINE shape)
	// run through deriveProposals below — same hired-PM/authority gate as every
	// proposal. The PM NEVER fetches the issue body or the PR diff here (role
	// separation — pm-triage.ts imports nothing from the sync/gh boundary).
	let triage: GithubTriageResult | null = null;
	if (provenance?.kind === 'github_arrival') {
		triage = await deriveGithubTriage(db, { projectId, tasks, provenance });
		seeds.push(...triage.notes);
	}

	// Surfaced concierge advisories were already written to pm_memory (above, pre-context) — fold them
	// into this pass's `written` so callers/surfaces see them as memories this pass produced.
	const written: PmMemoryRow[] = [...surfacedAdvisories];
	for (const seed of seeds) written.push(await addPmMemory(db, seed));

	const risksWrittenNow = written.filter((m) => m.kind === 'risk').length;
	const summary =
		`${snapshot} Wrote ${written.length} memory entry(ies)` +
		(risksWrittenNow ? ` (${risksWrittenNow} risk).` : '.');

	const review = await addPmReview(db, {
		project: projectId,
		trigger,
		summary,
		tasks_examined: tasks.length,
		findings_examined: findings.length,
		risks_open: openRisks.length + risksWrittenNow,
		memories_written: written.length,
		// TASK 16.2: the trigger engine's provenance (kind + real evidence + authority)
		// lands on the row; manual passes omit it (honest absence — F-008).
		...(provenance !== undefined ? { provenance } : {})
	});

	// ── TASK 16.4 — Act with Purpose (PM-SPEC §4): derive PROPOSALS from the same
	// real signals. Every proposal goes through the proposeTask chokepoint (full
	// §4.1 contract, structural-fingerprint anti-spam — repeat reviews ABSORB the
	// open proposal instead of duplicating it). Gated on the hired identity +
	// authority ladder: no PM / observe-only ⇒ derivation is skipped with the
	// honest reason, never silently.
	const { proposals, proposalsSkipped } = await deriveProposals(db, {
		projectId,
		tasks,
		severe,
		provenance,
		// TASK 16.5 — the triage-derived proposals lead the queue on an arrival wake
		// (they are the trigger's own purpose; order matters under the open-proposal cap).
		triageProposals: triage?.proposals ?? [],
		opts
	});

	// Path B: LAST, on a NOVEL specialist-need (blocked work / severe findings), EMIT one
	// fire-and-forget atelier consult (deduped per novel need). This is ADVISORY and NON-STEERING —
	// it runs AFTER (and never alters) the deterministic proposals above; the concierge's async reply
	// informs the operator/next pass (surfaced then), it does not act. Fail-open (never throws). The
	// "awaiting advice" note it writes is persisted to pm_memory (surfaces next pass), deliberately NOT
	// folded into this pass's `written`/memories_written — that count already closed on what we derived.
	await maybeEmitConciergeConsult(
		db,
		{ projectId, projectLabel: project.name, tasks, severe },
		conciergeDeps
	);

	return {
		review,
		written,
		context,
		proposals,
		...(proposalsSkipped !== undefined ? { proposalsSkipped } : {})
	};
}

// ── TASK 16.4 — proposal derivation (every rule keyed off REAL rows, F-008) ───────

async function deriveProposals(
	db: Db,
	args: {
		projectId: string;
		tasks: TaskRow[];
		severe: FindingRow[];
		provenance?: PmReviewProvenance;
		/** TASK 16.5 — GitHub-triage proposals (already §4.1-shaped), run first. */
		triageProposals?: ProposeTaskInput[];
		opts: ProposalOpts;
	}
): Promise<{ proposals: ProposeTaskResult[]; proposalsSkipped?: string }> {
	const { projectId, tasks, severe, provenance, triageProposals = [], opts } = args;

	const pm = await getPm(db, projectId);
	if (!pm) {
		return { proposals: [], proposalsSkipped: 'no hired PM — proposals require the hired identity (PM-SPEC §1)' };
	}
	if (pm.authority !== 'propose' && pm.authority !== 'act') {
		return {
			proposals: [],
			proposalsSkipped: `PM authority is '${pm.authority}' — an observe-only PM does not propose (PM-SPEC §4)`
		};
	}

	const proposals: ProposeTaskResult[] = [];

	// ⓪ TASK 16.5 — GitHub-triage proposals (PM-SPEC §5): one per triaged arrival
	// (an UNLINKED issue → a triage task; a PR → spawn-a-code-reviewer, INLINE shape).
	// Run FIRST on an arrival wake — they are the trigger's purpose, and order
	// matters under the open-proposal cap. proposeTask absorbs structural duplicates
	// (a re-fired arrival returns the standing proposal — interrupt contract).
	for (const input of triageProposals) {
		proposals.push(await proposeTask(db, input, opts));
	}

	// ① A FAILED release run (the §3 event-④ retro) → a diagnose-and-retry proposal.
	if (provenance?.kind === 'release' && String(provenance.detail?.status ?? '') === 'failed') {
		const runRef = provenance.evidence[0] ?? 'unknown run';
		proposals.push(
			await proposeTask(
				db,
				{
					project: projectId,
					title: `Diagnose failed release run ${runRef}`,
					objective: `Identify the failing stage of release run ${runRef} and restore a releasable state.`,
					purpose:
						'The release pipeline is the project’s delivery path (plan DoD); a failed run blocks shipping until diagnosed.',
					acceptance_criteria: [
						`The failing stage of ${runRef} is named with its real error evidence (log/step state).`,
						'A fix or a follow-up task for the root cause exists.',
						'A re-run of the release workflow completes, or the blocker is escalated with the named reason.'
					],
					provenance: { kind: 'release', evidence: [...provenance.evidence] },
					priority: 'high'
				},
				opts
			)
		);
	}

	// ② Blocked tasks (real rows) → an unblock proposal carrying their ids as evidence.
	const blockedRows = tasks.filter((t) => t.status === 'blocked').slice(0, 10);
	if (blockedRows.length > 0) {
		proposals.push(
			await proposeTask(
				db,
				{
					project: projectId,
					title: `Unblock ${blockedRows.length} stalled task(s)`,
					objective: `Resolve or re-scope the ${blockedRows.length} blocked task(s) so delivery flow resumes.`,
					purpose: 'Blocked work stalls the plan; every blocked row is dead inventory until unblocked or re-scoped.',
					acceptance_criteria: [
						'Each listed task is moved out of "blocked" (ready/in_progress) or re-scoped with a recorded decision.',
						'The blocker cause for each is recorded as PM memory.'
					],
					provenance: { kind: 'task_blocked', evidence: blockedRows.map((t) => t.id) }
				},
				opts
			)
		);
	}

	// ③ Critical/high findings (real rows) → a triage proposal.
	if (severe.length > 0) {
		proposals.push(
			await proposeTask(
				db,
				{
					project: projectId,
					title: `Triage ${severe.length} critical/high finding(s)`,
					objective: `Triage the ${severe.length} unresolved critical/high finding(s) before the next release.`,
					purpose: 'Unresolved severe findings are security/quality debt that gates the plan’s Definition of Done.',
					acceptance_criteria: [
						'Each listed finding is resolved, suppressed-with-justification, or converted to a scoped fix task.',
						'No critical finding remains unreviewed.'
					],
					provenance: { kind: 'finding', evidence: severe.slice(0, 10).map((f) => f.id) },
					priority: 'high'
				},
				opts
			)
		);
	}

	return { proposals };
}

/** Re-export for callers that gate on a status set without importing tasks/repo directly. */
export type { TaskStatus };
