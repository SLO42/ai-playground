// TASK 16.4 — the proposed-task pipeline (PM-SPEC §4 "Act with Purpose"; D-039).
//
// The PM auto-creates tasks — but nothing it creates is born actionable. Every
// PM-created task enters status 'proposed' carrying the §4.1 contract: a single
// clear OBJECTIVE, a PURPOSE tying it to plan/charter/finding, a FULL SPEC
// (acceptance criteria a build agent could execute against) and PROVENANCE (which
// trigger/evidence produced it). The fields live in the schema (migration 0032);
// the CONTRACT is enforced HERE, at the single write chokepoint — a SurrealDB field
// ASSERT cannot reference sibling fields, so "schema-enforced" means this function
// is the only path that may create a 'proposed' task and it fails loud + named on
// any missing piece (missing purpose = honest fail, never a half-specified row).
//
// Anti-spam (PM-SPEC §4 (d) / WORKFORCE-SPEC §5): open proposals are capped per
// project (config/workforce.yaml workforce.max_open_proposals, default 2) — at cap
// the PM records the would-be proposal to pm_memory instead. Defer identity is
// STRUCTURAL: a fingerprint over (project, kind, trigger, sorted evidence ids), so
// cosmetic re-wording cannot dodge an operator's defer window, and a re-run of the
// same trigger absorbs the already-open proposal (interrupt contract).
//
// Safety rail (PM-SPEC §4 (f) / D-018/D-024): this module only CREATES 'proposed'
// rows + pm_memory notes — it spawns nothing, executes nothing, and touches nothing
// external. External/destructive actions still hit the gate layer elsewhere.

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import { ConfigError, loadWorkforce } from '../config/index';
import {
	createTask,
	getTask,
	listTasksByProject,
	setStatus,
	type TaskPriority,
	type TaskProvenance,
	type TaskRow
} from '../tasks/repo';
import { closeOpenPanelVerdictsForArtifact } from '../workforce/repo';
import { isFingerprintDeferred, supersedeOpenBrief } from './briefs';
import { addPmMemory, getPm, type PmMemoryRow } from './pm-repo';

// ── Named errors ──────────────────────────────────────────────────────────────────

/** The §4.1 Act-with-Purpose contract was violated (missing objective/purpose/spec/
 *  provenance, no hired PM, observe-only authority, wrong status…). Loud + named. */
export class ProposalContractError extends Error {
	override readonly name = 'ProposalContractError';
}

// ── Shapes ────────────────────────────────────────────────────────────────────────

export interface ProposeTaskInput {
	project: string;
	title: string;
	/** §4.1: clear, single objective. */
	objective: string;
	/** §4.1: why this, why now — ties to plan/charter/finding. */
	purpose: string;
	/** §4.1: acceptance criteria a build agent could execute against (≥1). */
	acceptance_criteria: string[];
	/** §4.1: which trigger/evidence produced it (REAL ids/refs — F-008). */
	provenance: TaskProvenance;
	priority?: TaskPriority;
	/** Set by the revise loop — links the successor to the row it replaces. */
	revision_of?: string;
}

export type ProposeOutcome = 'created' | 'duplicate_open' | 'capped' | 'defer_suppressed';

export interface ProposeTaskResult {
	outcome: ProposeOutcome;
	/** The proposed task row — set for 'created' AND 'duplicate_open' (the absorbed
	 *  already-open row); absent when the proposal was suppressed. */
	task?: TaskRow;
	/** The pm_memory row written INSTEAD when capped/defer-suppressed (§5 anti-spam). */
	memory?: PmMemoryRow;
	/** The honest one-line reason for every non-'created' outcome. */
	reason?: string;
}

export interface ProposalOpts {
	/** Config dir override (tests); defaults to CONFIG_DIR || 'config'. */
	configDir?: string;
}

// ── Structural fingerprint (PM-SPEC §4 (d)) ──────────────────────────────────────

/**
 * The STRUCTURAL identity of a proposal: sha256 over (project, artifact kind,
 * trigger kind, sorted evidence ids). Deliberately excludes every free-text field
 * (title/objective/purpose) — cosmetic re-wording cannot dodge a defer window or
 * duplicate past the open-proposal check.
 */
export function proposalFingerprint(project: string, provenance: TaskProvenance): string {
	const basis = JSON.stringify({
		project,
		kind: 'task',
		trigger: provenance.kind,
		evidence: [...provenance.evidence].sort()
	});
	return createHash('sha256').update(basis, 'utf8').digest('hex');
}

/** D-016 chokepoint: validate a `table:id` link, wrap as a true record link. */
function linkParam(id: string): StringRecordId {
	return new StringRecordId(assertRecordId(id));
}

function workforceConfigPath(opts: ProposalOpts): string {
	const dir = opts.configDir?.trim() || process.env.CONFIG_DIR?.trim() || 'config';
	return join(dir, 'workforce.yaml');
}

/** Read the open-proposal cap; an unreadable workforce.yaml degrades to the §5
 *  default (2) — the cap is an anti-spam rail, not a safety gate (named fallback). */
function readProposalCap(opts: ProposalOpts): number {
	try {
		return loadWorkforce(workforceConfigPath(opts)).workforce.max_open_proposals;
	} catch (err) {
		if (err instanceof ConfigError) return 2;
		throw err;
	}
}

// ── Contract enforcement (the "schema-enforced" chokepoint) ──────────────────────

function assertContract(input: ProposeTaskInput): void {
	const missing: string[] = [];
	if (!input.title?.trim()) missing.push('title');
	if (!input.objective?.trim()) missing.push('objective');
	if (!input.purpose?.trim()) missing.push('purpose');
	if (
		!Array.isArray(input.acceptance_criteria) ||
		input.acceptance_criteria.length === 0 ||
		input.acceptance_criteria.some((c) => typeof c !== 'string' || !c.trim())
	) {
		missing.push('acceptance_criteria (≥1 non-empty criterion)');
	}
	if (!input.provenance || typeof input.provenance !== 'object') {
		missing.push('provenance');
	} else {
		if (!input.provenance.kind?.trim()) missing.push('provenance.kind');
		if (
			!Array.isArray(input.provenance.evidence) ||
			input.provenance.evidence.length === 0 ||
			input.provenance.evidence.some((e) => typeof e !== 'string' || !e.trim())
		) {
			missing.push('provenance.evidence (≥1 real ref)');
		}
	}
	if (missing.length) {
		throw new ProposalContractError(
			`Act-with-Purpose contract violated (PM-SPEC §4.1) — missing/empty: ${missing.join(', ')}. ` +
				`A proposal without them is not reviewable and is refused, never half-created.`
		);
	}
}

/** The immutable run-seed description composed from the §4.1 fields (D-008 — the
 *  stored description is never mutated; a revision is a NEW row). */
function composeDescription(input: ProposeTaskInput): string {
	return [
		`Objective: ${input.objective.trim()}`,
		`Purpose: ${input.purpose.trim()}`,
		'Acceptance criteria:',
		...input.acceptance_criteria.map((c, i) => `  ${i + 1}. ${c.trim()}`),
		`Provenance: ${input.provenance.kind} — evidence: ${input.provenance.evidence.join(', ')}`
	].join('\n');
}

// ── The propose chokepoint ────────────────────────────────────────────────────────

/**
 * Create a PM proposal: a task BORN status 'proposed' (origin 'pm') carrying the
 * full §4.1 contract. Fail-closed preconditions, each a named error:
 *   • the project must have a HIRED PM (no implicit PM may propose);
 *   • pm.authority must be 'propose' or 'act' — an 'observe' PM records nothing;
 *   • the §4.1 contract must be complete (assertContract).
 * Anti-spam ladder, in order (each outcome honest + typed):
 *   1. same-fingerprint proposal already OPEN → absorbed ('duplicate_open');
 *   2. fingerprint inside an active operator defer window → 'defer_suppressed'
 *      + a pm_memory note (the PM learns the operator deferred this matter);
 *   3. open-proposal cap reached → 'capped' + the would-be proposal recorded to
 *      pm_memory instead (WORKFORCE-SPEC §5).
 */
export async function proposeTask(
	db: Db,
	input: ProposeTaskInput,
	opts: ProposalOpts = {}
): Promise<ProposeTaskResult> {
	const pm = await getPm(db, input.project);
	if (!pm) {
		throw new ProposalContractError(
			`project ${input.project} has no hired PM — proposals require the hired identity (PM-SPEC §1)`
		);
	}
	if (pm.authority !== 'propose' && pm.authority !== 'act') {
		throw new ProposalContractError(
			`PM authority is '${pm.authority}' — an observe-only PM records observations, it does not propose (PM-SPEC §4)`
		);
	}
	assertContract(input);

	const fingerprint = proposalFingerprint(input.project, input.provenance);
	const open = await listTasksByProject(db, input.project, 'proposed');

	// 1. Absorb an already-open structural duplicate (interrupt contract: a re-run
	//    of the same trigger returns the standing proposal instead of erroring).
	const dup = open.find((t) => t.proposal_fingerprint === fingerprint);
	if (dup) {
		return {
			outcome: 'duplicate_open',
			task: dup,
			reason: `an open proposal with the same structural fingerprint already stands (${dup.id})`
		};
	}

	// 2. Operator defer window (structural — re-wording cannot dodge it).
	if (await isFingerprintDeferred(db, fingerprint)) {
		const memory = await addPmMemory(db, {
			project: input.project,
			kind: 'observation',
			content:
				`Proposal suppressed by an active operator defer: "${input.title.trim()}" ` +
				`(trigger ${input.provenance.kind}; fingerprint ${fingerprint.slice(0, 12)}…). ` +
				`Re-proposes only after the defer window lapses.`,
			source: 'pm-proposals',
			confidence: 1.0
		});
		return {
			outcome: 'defer_suppressed',
			memory,
			reason: 'the operator deferred this matter — its defer window is still active'
		};
	}

	// 3. Open-proposal cap (per project for task artifacts — §5 keying).
	const cap = readProposalCap(opts);
	if (open.length >= cap) {
		const memory = await addPmMemory(db, {
			project: input.project,
			kind: 'observation',
			content:
				`Proposal held at the open-proposal cap (${open.length}/${cap} open): ` +
				`"${input.title.trim()}" — objective: ${input.objective.trim()} ` +
				`(trigger ${input.provenance.kind}, evidence: ${input.provenance.evidence.join(', ')}). ` +
				`Recorded to memory instead (WORKFORCE-SPEC §5 anti-spam).`,
			source: 'pm-proposals',
			confidence: 1.0,
			importance: 5
		});
		return {
			outcome: 'capped',
			memory,
			reason: `open-proposal cap reached (${open.length}/${cap})`
		};
	}

	const task = await createTask(db, {
		project: input.project,
		title: input.title.trim(),
		description: composeDescription(input),
		priority: input.priority,
		origin: 'pm',
		status: 'proposed',
		objective: input.objective.trim(),
		purpose: input.purpose.trim(),
		acceptance_criteria: input.acceptance_criteria.map((c) => c.trim()),
		provenance: { ...input.provenance, authority: pm.authority },
		proposed_by: pm.id,
		revision_of: input.revision_of,
		proposal_fingerprint: fingerprint
	});
	return { outcome: 'created', task };
}

// ── The revise / withdraw loop (PM-SPEC §4 (c); §2.2 outcome closure) ─────────────

export interface ReviseProposalInput {
	title?: string;
	objective: string;
	purpose: string;
	acceptance_criteria: string[];
	/** Defaults to the predecessor's provenance (the trigger has not changed). */
	provenance?: TaskProvenance;
	priority?: TaskPriority;
}

export interface ReviseProposalResult {
	/** The successor proposal (born 'proposed', revision_of = the old row). */
	successor: TaskRow;
	/** The superseded predecessor (now 'withdrawn', superseded_by = successor). */
	predecessor: TaskRow;
	/** How many open panel verdicts on the predecessor were closed 'revised'. */
	verdictsClosed: number;
}

/** Load + guard a proposal row for the revise/withdraw loop. */
async function requireProposed(db: Db, taskId: string): Promise<TaskRow> {
	const task = await getTask(db, taskId);
	if (!task) throw new ProposalContractError(`task not found: ${taskId}`);
	if (task.status !== 'proposed') {
		throw new ProposalContractError(
			`task ${taskId} is '${task.status}' — only a 'proposed' task moves through the revise/withdraw loop`
		);
	}
	return task;
}

/**
 * PM revision: the §4.1 fields are immutable on the stored row (D-008), so a
 * revision is a NEW proposed task (revision_of → predecessor) and the predecessor
 * is mechanically retired: superseded_by stamped, status → 'withdrawn', its open
 * panel verdicts closed 'revised' (§2.2 — the verdicts DID move the PM), and any
 * open operator brief on it superseded (the question is moot — never auto-decided).
 * The successor bypasses the open-proposal cap (net open count is unchanged) but
 * still passes the full §4.1 contract.
 */
export async function revisePmProposal(
	db: Db,
	taskId: string,
	revision: ReviseProposalInput
): Promise<ReviseProposalResult> {
	const old = await requireProposed(db, taskId);
	const pm = await getPm(db, old.project);
	if (!pm) throw new ProposalContractError(`project ${old.project} has no hired PM`);

	const provenance = revision.provenance ?? old.provenance;
	const input: ProposeTaskInput = {
		project: old.project,
		title: revision.title?.trim() || old.title,
		objective: revision.objective,
		purpose: revision.purpose,
		acceptance_criteria: revision.acceptance_criteria,
		provenance: provenance ?? { kind: 'unknown', evidence: [] }, // contract check rejects the fallback
		priority: revision.priority,
		revision_of: old.id
	};
	assertContract(input);

	// Create the successor FIRST (a crash between steps leaves both rows visible and
	// honest: an open successor + a still-open predecessor whose fingerprint matches —
	// the duplicate_open absorb makes the re-run converge instead of double-creating).
	const successor = await createTask(db, {
		project: input.project,
		title: input.title,
		description: composeDescription(input),
		priority: input.priority,
		origin: 'pm',
		status: 'proposed',
		objective: input.objective.trim(),
		purpose: input.purpose.trim(),
		acceptance_criteria: input.acceptance_criteria.map((c) => c.trim()),
		provenance: { ...input.provenance, authority: pm.authority },
		proposed_by: pm.id,
		revision_of: old.id,
		proposal_fingerprint: proposalFingerprint(input.project, input.provenance)
	});

	// Retire the predecessor: link, then terminal status, then mechanical closures.
	await db.query(`UPDATE $rid MERGE { superseded_by: $sid, updated_at: time::now() };`, {
		rid: linkParam(old.id),
		sid: linkParam(successor.id)
	});
	const predecessor = (await setStatus(db, old.id, 'withdrawn')) ?? old;
	const verdictsClosed = await closeOpenPanelVerdictsForArtifact(db, old.id, 'revised');
	await supersedeOpenBrief(db, old.id);

	return { successor, predecessor, verdictsClosed };
}

export interface WithdrawProposalResult {
	task: TaskRow;
	verdictsClosed: number;
}

/**
 * PM withdrawal: the proposal leaves the pipeline. Status → 'withdrawn', open
 * panel verdicts close 'withdrawn' (§2.2), any open operator brief is superseded
 * (mechanical — never recorded as an operator decision).
 */
export async function withdrawPmProposal(db: Db, taskId: string): Promise<WithdrawProposalResult> {
	const old = await requireProposed(db, taskId);
	const task = (await setStatus(db, old.id, 'withdrawn')) ?? old;
	const verdictsClosed = await closeOpenPanelVerdictsForArtifact(db, old.id, 'withdrawn');
	await supersedeOpenBrief(db, old.id);
	return { task, verdictsClosed };
}
