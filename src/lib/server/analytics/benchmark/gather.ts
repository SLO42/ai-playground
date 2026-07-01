// MODEL-BENCHMARK-SPEC step 3 (class B — Judged) — the corpus read side.
//
// Reads the raw material the judge scores, all from REAL rows (F-008): the driven-session
// transcript (`message` rows, kind/seq ordered), the thinking corpus (message kind='thinking'
// — always-on, already D-026-screened at write; the opt-in provider-tagged `thinking_capture`
// is the same screened text and is unioned when present), and the session's identity + outcome
// (`session.model.provider/model_id` + `session.status`). Nothing is fabricated — an empty
// session yields an empty corpus, which scoreSession honestly marks insufficient.
//
// Boundary discipline (D-016): every session id flows through assertRecordId + binds as a
// StringRecordId; no value is interpolated into a query.

import { StringRecordId } from 'surrealdb';
import type { Db } from '../../db/client';
import { assertRecordId } from '../../db/validate';
import { deriveObjectiveSignals, type SessionCorpus } from './judge';

/** A session eligible for judging (driven session with an identity). */
export interface JudgeCandidate {
	sessionId: string;
	provider: string;
	modelId: string;
	status: string;
}

export interface CandidateOptions {
	/** Trailing window in days (default 30). */
	windowDays?: number;
	/** Restrict to one session-under-test provider (e.g. 'ollama' | 'claude'). */
	provider?: string;
	/** Hard cap on candidates returned (the batch bound). */
	limit?: number;
}

interface RawSessionRow {
	id: unknown;
	provider?: string | null;
	model_id?: string | null;
	status?: string | null;
}

/**
 * List recent driven sessions eligible for judging, newest first, bounded by `limit`. Only
 * real, model-bearing sessions (a session always carries model.provider/model_id). Returns []
 * honestly when none match.
 */
export async function listJudgeCandidates(
	db: Db,
	opts: CandidateOptions = {}
): Promise<JudgeCandidate[]> {
	const windowDays = opts.windowDays ?? 30;
	const limit = Math.max(1, Math.min(opts.limit ?? 20, 100));
	const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

	const params: Record<string, unknown> = { since, lim: limit };
	let where = 'started_at >= $since';
	if (opts.provider) {
		params.prov = opts.provider;
		where += ' AND model.provider = $prov';
	}

	// started_at is projected because it is an ORDER BY idiom (F-020: SurrealQL requires every
	// ORDER BY field to appear in the SELECT list).
	const [rows] = await db.query<[RawSessionRow[]]>(
		`SELECT id, model.provider AS provider, model.model_id AS model_id, status, started_at
		   FROM session WHERE ${where} ORDER BY started_at DESC LIMIT $lim;`,
		params
	);

	return (rows ?? []).map((r) => ({
		sessionId: String(r.id),
		provider: (r.provider as string) || 'unknown',
		modelId: (r.model_id as string) || '',
		status: (r.status as string) || 'unknown'
	}));
}

interface RawMessageRow {
	kind?: string | null;
	content?: string | null;
	seq?: number | null;
}

const OUTCOMES = new Set(['done', 'failed', 'cancelled', 'running']);

/** Coerce a session status string to the corpus outcome union (unknown when off-taxonomy). */
function toOutcome(status: string): SessionCorpus['outcome'] {
	return OUTCOMES.has(status) ? (status as SessionCorpus['outcome']) : 'unknown';
}

/**
 * Assemble one session's screened corpus for the judge. Reads the transcript (message rows,
 * seq-ordered) + the thinking turns, and derives the objective tool-before-claim signal.
 * Returns null for an unknown session (honest — no fabricated corpus).
 */
export async function gatherSessionCorpus(
	db: Db,
	sessionId: string,
	maxTurns = 400
): Promise<SessionCorpus | null> {
	const sid = new StringRecordId(assertRecordId(sessionId));
	const lim = Math.max(1, Math.min(maxTurns, 2000));

	const [sessRows] = await db.query<[RawSessionRow[]]>(
		`SELECT id, model.provider AS provider, model.model_id AS model_id, status
		   FROM session WHERE id = $sid LIMIT 1;`,
		{ sid }
	);
	const sess = (sessRows ?? [])[0];
	if (!sess) return null;

	// Transcript rows, oldest→newest (seq then at, mirroring the transcript read side).
	// `at` is projected only because it is an ORDER BY idiom (F-020) — it is not otherwise read.
	const [msgRows] = await db.query<[RawMessageRow[]]>(
		`SELECT kind, content, seq, at FROM message
		   WHERE session = $sid ORDER BY seq ASC, at ASC LIMIT $lim;`,
		{ sid, lim }
	);

	const transcript: { kind: string; content: string }[] = [];
	const thinking: string[] = [];
	for (const m of msgRows ?? []) {
		const kind = (m.kind as string) || 'assistant_text';
		const content = (m.content as string) || '';
		if (!content) continue;
		if (kind === 'thinking') thinking.push(content);
		else transcript.push({ kind, content });
	}

	return {
		sessionId,
		provider: (sess.provider as string) || 'unknown',
		modelId: (sess.model_id as string) || '',
		outcome: toOutcome((sess.status as string) || 'unknown'),
		transcript,
		thinking,
		objective: deriveObjectiveSignals(transcript)
	};
}
