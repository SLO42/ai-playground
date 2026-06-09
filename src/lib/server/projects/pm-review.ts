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
import { listFindings } from '../scanner/findings-repo';
import { getProject } from './repo';
import {
	addPmMemory,
	addPmReview,
	listPmMemory,
	type AddPmMemoryInput,
	type PmMemoryRow,
	type PmReviewRow,
	type PmReviewTrigger
} from './pm-repo';

/** The outcome of one review pass — the summary row + the typed memories it wrote. */
export interface PmReviewResult {
	review: PmReviewRow;
	/** The typed PM-memory rows this pass wrote (observation / risk / decision). */
	written: PmMemoryRow[];
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
	trigger: PmReviewTrigger = 'manual'
): Promise<PmReviewResult> {
	const project = await getProject(db, projectId);
	if (!project) throw new Error(`project not found: ${projectId}`);

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

	const written: PmMemoryRow[] = [];
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
		memories_written: written.length
	});

	return { review, written };
}

/** Re-export for callers that gate on a status set without importing tasks/repo directly. */
export type { TaskStatus };
