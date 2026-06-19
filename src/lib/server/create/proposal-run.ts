// server/create/proposal-run.ts — the ASYNC propose run-row (Create-with-AI; CREATE-SPEC §2.1-2.3).
//
// `propose` no longer BLOCKS ~2 min: after the up-front gates it LAUNCHES the read-only generation
// session, persists a `create_proposal_run` row {status:'generating', session:<launchSession id>}
// and returns {runId, sessionId} IMMEDIATELY. Generation continues in a DETACHED background job
// (runProposalInBackground) that mirrors how launchSession itself runs a non-blocking server-side
// job — on success it validates (generateCreationProposal's UNCHANGED validation path: anti-
// sycophancy / D-026 / defect-class partition / redact-and-keep all still apply) → screens → UPDATEs
// {status:'done', envelope}; on ANY error (contract / agent leg / timeout) it UPDATEs {status:
// 'failed', error_reason} — honest (F-008), never a fake success. The client watches THIS row live
// (the `create_proposal_run` SSE watcher) + the session's live transcript (the existing `message`
// stream — the /claude-code?session= precedent).
//
// D-010 PRESERVED: still propose-only — NOTHING touches disk; the persisted `envelope` carries the
// same confirmToken the synchronous path minted (the executor's ?/create re-validates it via
// assertProposalFresh). The `envelope` is persisted VERBATIM so its bytes still hash to the token
// (validateProposal already guarantees the proposal carries no raw credential — gates 2/3 + the
// config redact-and-keep). D-026: the SEPARATE rendered `brief` column is screen()-passed before it
// lands (operator-typed text is screened for the audit/display column; the agent transcript is
// screened at its existing eventToMessage chokepoint). F-013/F-015: datetime fields coerce to ISO
// (absent → null → '—', never str(undefined)); the migration is additive + OVERWRITE-idempotent.
//
// Boundary discipline (D-016): the run id flows through assertRecordId and binds as a
// StringRecordId; project/session links wrap through the validate chokepoint; no value is
// interpolated into a query.

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId, assertRecordIdOfTable } from '../db/validate';
import { screen } from '../memory/screen';
import {
	generateCreationProposal,
	type CreateBrief,
	type CreationProposalEnvelope,
	type ProposalGenerator
} from './plan';
import { proposeErrorReason } from './template-form';

/** The terminal-or-pending status of a generation run (F-008: honest, never a fake success). */
export type ProposalRunStatus = 'generating' | 'done' | 'failed';

/** A create_proposal_run row projected to plain serializable values for the page (D-016/F-013). */
export interface ProposalRun {
	id: string;
	/** The HOST project the read-only generation session runs under. */
	project: string;
	/** The generation session id (surfaced synchronously at launch) — the live transcript key. */
	session?: string;
	/** The submitted brief, SCREENED for the rendered/audit column (D-026). */
	brief: CreateBrief;
	status: ProposalRunStatus;
	/** The validated envelope (token-bound, verbatim) when status==='done'; absent otherwise. */
	envelope?: CreationProposalEnvelope;
	/** The honest failure reason when status==='failed'; absent otherwise (F-008). */
	errorReason?: string;
	/** ISO string (F-013: never a raw SDK datetime). */
	createdAt?: string;
	endedAt?: string;
}

/** Coerce a SurrealDB datetime (Date / wrapped) to a plain ISO string, or omit (F-013). */
function isoOrUndef(v: unknown): string | undefined {
	if (v == null) return undefined;
	if (v instanceof Date) return v.toISOString();
	return String(v);
}

/** Validate a `table:id` link string at the D-016 chokepoint, then wrap it as a record link. */
function link(id: string): StringRecordId {
	return new StringRecordId(assertRecordId(id));
}

/**
 * Deep-screen every string in the brief (D-026) for the rendered/audit `brief` column. Operator-
 * typed text is screened to its SAFE text BEFORE it lands in a persisted/rendered column — a secret
 * the operator pasted into the description never round-trips raw out of the run row. This screened
 * COPY is what the row stores; the TOKEN-bound brief lives inside `envelope` (persisted verbatim) so
 * the confirmToken still matches at execute (D-010). Shadow paths: nil hints → omitted; empty string
 * → screen('') === '' (clean).
 */
function screenBrief(brief: CreateBrief): CreateBrief {
	const out: CreateBrief = {
		name: screen(brief.name).text,
		description: screen(brief.description).text
	};
	if (brief.hints) {
		const hints: NonNullable<CreateBrief['hints']> = {};
		if (brief.hints.ecosystem) hints.ecosystem = screen(brief.hints.ecosystem).text;
		if (brief.hints.refRepoUrl) hints.refRepoUrl = screen(brief.hints.refRepoUrl).text;
		if (brief.hints.targetPlatform) hints.targetPlatform = screen(brief.hints.targetPlatform).text;
		if (Object.keys(hints).length) out.hints = hints;
	}
	return out;
}

/** Normalize a raw create_proposal_run row → the serializable ProposalRun (F-013/D-016). */
function normRun(row: {
	id: unknown;
	project: unknown;
	session?: unknown;
	brief?: unknown;
	status?: unknown;
	envelope?: unknown;
	error_reason?: unknown;
	created_at?: unknown;
	ended_at?: unknown;
}): ProposalRun {
	const status = String(row.status ?? 'generating') as ProposalRunStatus;
	const out: ProposalRun = {
		id: String(row.id),
		project: String(row.project),
		// brief is stored as a screened object; default to an honest empty shape if somehow absent.
		brief: (row.brief as CreateBrief) ?? { name: '', description: '' },
		status: status === 'done' || status === 'failed' ? status : 'generating'
	};
	if (row.session != null) out.session = String(row.session);
	// envelope/error_reason are option<…> — present only on the matching terminal status (F-008:
	// a 'generating' run carries NEITHER; a 'failed' run carries NO partial envelope).
	if (out.status === 'done' && row.envelope != null) out.envelope = row.envelope as CreationProposalEnvelope;
	if (out.status === 'failed' && typeof row.error_reason === 'string' && row.error_reason.trim() !== '') {
		out.errorReason = row.error_reason;
	}
	const createdAt = isoOrUndef(row.created_at);
	const endedAt = isoOrUndef(row.ended_at);
	if (createdAt !== undefined) out.createdAt = createdAt;
	if (endedAt !== undefined) out.endedAt = endedAt;
	return out;
}

/**
 * CREATE a create_proposal_run row in the 'generating' state, with the host project + the SCREENED
 * brief, and (when already known) the session id. Returns the new run id. The session id is usually
 * stamped LATER via attachSession (it is only known once launchSession CREATEs the session row), so
 * it is optional here. NOTHING touches disk (D-010). `envelope`/`error_reason`/`ended_at` stay NONE
 * (§6.1 — omitted, not nulled) until the run resolves.
 */
export async function createProposalRun(
	db: Db,
	args: { project: string; brief: CreateBrief; session?: string }
): Promise<string> {
	const content: Record<string, unknown> = {
		project: link(args.project),
		brief: screenBrief(args.brief),
		status: 'generating'
	};
	if (args.session) content.session = link(args.session);
	const [created] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE create_proposal_run CONTENT $content RETURN AFTER;`,
		{ content }
	);
	return String(created[0].id);
}

/** Stamp the generation session id onto a run row once launchSession has CREATEd it (D-016). */
export async function attachSession(db: Db, runId: string, sessionId: string): Promise<void> {
	await db.query(`UPDATE $rid MERGE { session: $sid };`, {
		rid: link(runId),
		sid: link(sessionId)
	});
}

/** Mark a run DONE with its validated, token-bound envelope (persisted VERBATIM — D-010 token). */
export async function markProposalDone(
	db: Db,
	runId: string,
	envelope: CreationProposalEnvelope
): Promise<void> {
	await db.query(
		`UPDATE $rid MERGE { status: "done", envelope: $envelope, ended_at: $now };`,
		{ rid: link(runId), envelope, now: new Date() }
	);
}

/** Mark a run FAILED with an HONEST reason; NO partial envelope is ever written (F-008). */
export async function markProposalFailed(db: Db, runId: string, errorReason: string): Promise<void> {
	// Screen the reason too — an error message can echo a leaked value (D-026); keep it bounded.
	const reason = screen(errorReason).text.slice(0, 2000) || 'generation failed (no detail)';
	await db.query(`UPDATE $rid MERGE { status: "failed", error_reason: $reason, ended_at: $now };`, {
		rid: link(runId),
		reason,
		now: new Date()
	});
}

/**
 * Read one run by id (the page poll fallback + the SSE-driven re-read). null when unknown.
 *
 * TABLE-SCOPED (D-016 trust boundary): the id MUST be a `create_proposal_run:…`. The generic
 * `link()`/`assertRecordId` only checks the `table:id` SHAPE, so a crafted/stale `?run=` carrying a
 * FOREIGN id (e.g. `project:…` or `session:…`) would otherwise `SELECT *` that wrong-table row and
 * normRun would read its foreign `status` — fabricating an honest-looking 'generating' spinner (a
 * project row) or a 'failed' alert (a failed session row). That is an F-008 fabricated state from
 * untrusted input. A non-`create_proposal_run` id is therefore treated as UNKNOWN → null (the same
 * honest-empty nil shadow as an unknown run id), never a foreign-row read.
 */
export async function getProposalRun(db: Db, runId: string): Promise<ProposalRun | null> {
	let scopedId: string;
	try {
		scopedId = assertRecordIdOfTable(runId, 'create_proposal_run');
	} catch {
		return null; // foreign-table or malformed id → honest empty, never a fabricated foreign-row state.
	}
	const rid = new StringRecordId(scopedId);
	const [rows] = await db.query<[Array<Record<string, unknown>>]>(`SELECT * FROM $rid;`, { rid });
	const row = Array.isArray(rows) ? rows[0] : undefined;
	return row ? normRun(row as Parameters<typeof normRun>[0]) : null;
}

/**
 * Run the generation in the BACKGROUND for an already-created run row and resolve it on the row.
 * The caller does NOT await this — it fires it as a detached promise and returns {runId, sessionId}
 * to the client (the up-front session id arrives via the generator's onSessionCreated → attachSession).
 *
 * On success → markProposalDone(envelope). On ANY error → markProposalFailed(honest reason) — the
 * SAME mapping the synchronous path used (proposeErrorReason), so the failure text is unchanged.
 * EVERY error has a name: a contract/secret/sycophancy violation surfaces as proposeErrorReason; an
 * agent-leg env/timeout surfaces as its own runtime message; the FINAL catch guards the case where
 * even markProposalFailed throws (DB gone) — logged, never re-thrown into an unhandled rejection.
 *
 * Shadow paths: the generator returns garbage → validateProposal throws → failed (named); the agent
 * leg errors → failed (its reason); a DB write fault mid-resolve → logged (the run stays 'generating'
 * — the page shows the honest in-flight state until a reload re-reads; never a fabricated success).
 */
export async function runProposalInBackground(
	db: Db,
	runId: string,
	brief: CreateBrief,
	generate: ProposalGenerator
): Promise<void> {
	try {
		const envelope = await generateCreationProposal(db, brief, generate);
		await markProposalDone(db, runId, envelope);
	} catch (err) {
		try {
			await markProposalFailed(db, runId, proposeErrorReason(err));
		} catch (writeErr) {
			// The resolve write itself failed (likely the DB that broke the generation). Do not mask
			// the original failure with the write error; the run stays 'generating' and the page shows
			// the honest in-flight state until a reload re-reads. NEVER an unhandled rejection.
			console.warn(
				`[create] failed to mark proposal run ${runId} failed (DB write error, run left in-flight): ${(writeErr as Error).message}`
			);
		}
	}
}
