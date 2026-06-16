// BL-6 CANNIBALIZE-SPEC §4 — the DISTILL → SCREEN → FENCE → EMBED → INGEST pipeline.
//
// The middle of the foundry pipeline (CANNIBALIZE-SPEC §10.3): given RAW captured content +
// its candidate provenance (from CB1's capture layer — captureUrl/captureRepo/captureFile/
// captureText → CaptureResult), DISTILL it into discrete findings, then write each finding
// THROUGH THE EXISTING MEMORY STORE PATH (storeMemories → gateCandidate screen → fence-on-
// recall → embed → insert) carrying provenance = ingest_source id + license. NO parallel
// datastore (invariant §2.4) — the brain stays MEMORY-SPEC. An ingest_source row tracks the
// run through its status enum (capturing → distilling → ingesting → done | quarantined |
// failed) and its finding_count.
//
// LOCKED INVARIANTS enforced here (CANNIBALIZE-SPEC §2/§7):
//   • UNTRUSTED-BY-DEFAULT (§2.1): every finding goes through screen() (via storeMemories'
//     gateCandidate) THEN fence() (via recall) before it can reach a model. A QUARANTINED
//     finding is NOT counted as ingested — honest (the ingest_source status reflects it).
//   • PROVENANCE ALWAYS (§2.2): every ingested finding's memory row carries provenance =
//     the ingest_source id created HERE (server-side, NOT content-derived → un-forgeable)
//     plus the license/consent note for code-lifting.
//   • BOUNDED (§2.5, F-014/D-024): the distill pass is wall-clock-bound and finding-count-
//     capped — hostile/oversized content cannot spin or flood. Every error has a NAME.
//
// D2 (CANNIBALIZE-SPEC §9): the distiller is a PLAIN BOUNDED EXTRACTION PASS now, injected as
// a `DistillFn` (mock in tests; no live model / no creds this wave — the store.ts ExtractFn
// convention). TODO(§7b): swap the injected DistillFn for the `researcher` role when §7b lands
// — the call site here is unchanged (it only depends on the DistillFn contract).

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import type { Embedder } from '../memory/embed';
import { storeMemories, type MemoryCandidate, type StoredMemory } from '../memory/store';
import { gateCandidate } from '../memory/screen';
import type { CaptureResult, IngestKind } from './capture';

function link(id: string): StringRecordId {
	return new StringRecordId(assertRecordId(id));
}

// ── Bounds (F-014/D-024) — the distill pass cannot spin or flood the brain ──────────────

/** Wall-clock cap on the (injected) distill LLM pass — no spin on hostile/huge content. */
export const DEFAULT_DISTILL_TIMEOUT_MS = 30_000;
/** Hard cap on findings ingested from ONE source — a flood is truncated, not absorbed. */
export const DEFAULT_MAX_FINDINGS = 64;
/** Cap on the raw bytes handed to the distiller (defence-in-depth atop the capture byte cap). */
export const DEFAULT_MAX_DISTILL_BYTES = 1024 * 1024; // 1 MiB

// ── A distilled finding (the distiller's output, UNTRUSTED) ──────────────────────────────

/**
 * One discrete finding the distiller extracted from the captured content. UNTRUSTED DATA: it
 * is validated at the store boundary (assertCandidateShape) and screened (gateCandidate)
 * before anything persists. `content` is the finding text; `license` is the distiller's
 * candidate consent note for a code-lift (overridden by the run's declared license when set).
 */
export interface DistilledFinding {
	content: string;
	/** Candidate license/consent for THIS finding (§2.2); the run-level license wins when set. */
	license?: string;
}

/**
 * The injected distill pass. Given the (already size-bounded) raw captured content + the
 * candidate provenance kind/ref, return discrete findings. Modelled as an injected Fn so the
 * pipeline is verifiable against a scripted runtime (no live model / NO creds this wave) — the
 * store.ts ExtractFn convention. TODO(§7b): the `researcher` role implements this contract.
 */
export type DistillFn = (input: DistillInput) => Promise<DistilledFinding[]>;

/** What the distiller reasons over — raw captured content + its candidate provenance. */
export interface DistillInput {
	raw: string;
	kind: IngestKind;
	ref: string;
	/** The operator's NL intent for the run (already screened upstream) — steers extraction. */
	intent: string;
}

// ── Named errors (every error has a name) ────────────────────────────────────────────────

/**
 * The distill pass exceeded its WALL-CLOCK bound (F-014/D-024 — no spin on hostile/oversized
 * content). Trigger: the injected DistillFn did not resolve within timeoutMs. Catcher:
 * runBoundedDistill's race. Caller sees: this typed bound — the run is marked `failed`, NOTHING
 * partial reaches the brain. Distinct from a distiller that THREW (DistillFailedError).
 */
export class DistillTimeoutError extends Error {
	override readonly name = 'DistillTimeoutError';
	constructor(readonly timeoutMs: number) {
		super(`distill pass exceeded ${timeoutMs}ms wall-clock bound (no spin — run failed)`);
	}
}

/**
 * The distiller THREW or returned a non-array (untrusted output, D-026). Trigger: the injected
 * DistillFn rejected, or its resolved value is not an array of findings. Catcher: runBoundedDistill.
 * Caller sees: this typed failure naming WHICH channel failed (reject vs bad-shape) — never a
 * silent empty success (F-008). The run is marked `failed`.
 */
export class DistillFailedError extends Error {
	override readonly name = 'DistillFailedError';
	constructor(
		message: string,
		/** 'threw' when the DistillFn rejected; 'shape' when it returned a non-array / bad element. */
		readonly channel: 'threw' | 'shape'
	) {
		super(message);
	}
}

// ── Bounded distill ──────────────────────────────────────────────────────────────────────

function isFinding(v: unknown): v is DistilledFinding {
	return typeof v === 'object' && v !== null && !Array.isArray(v) && typeof (v as { content?: unknown }).content === 'string';
}

/**
 * Run the injected distill pass under a HARD wall-clock bound + output validation (F-014/D-024).
 * The raw content is pre-truncated to maxBytes (defence-in-depth — the capture layer already
 * bounded it, but a distiller must never be handed an unbounded blob). On timeout → DistillTimeoutError;
 * on a reject / non-array / bad-element → DistillFailedError (named channel); otherwise the
 * count-capped, well-shaped findings. NEVER spins, NEVER returns a silent empty on failure.
 */
export async function runBoundedDistill(
	distill: DistillFn,
	input: DistillInput,
	opts: { timeoutMs?: number; maxFindings?: number; maxBytes?: number } = {}
): Promise<DistilledFinding[]> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_DISTILL_TIMEOUT_MS;
	const maxFindings = opts.maxFindings ?? DEFAULT_MAX_FINDINGS;
	const maxBytes = opts.maxBytes ?? DEFAULT_MAX_DISTILL_BYTES;

	// Pre-truncate the raw blob (Buffer-accurate byte cap) before the distiller sees it.
	let raw = input.raw;
	if (typeof raw !== 'string') {
		throw new DistillFailedError(`distill input.raw must be a string, got ${raw === null ? 'null' : typeof raw}`, 'shape');
	}
	if (Buffer.byteLength(raw, 'utf8') > maxBytes) {
		raw = Buffer.from(raw, 'utf8').subarray(0, maxBytes).toString('utf8');
	}
	const bounded: DistillInput = { ...input, raw };

	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new DistillTimeoutError(timeoutMs)), timeoutMs);
	});

	let result: unknown;
	try {
		result = await Promise.race([Promise.resolve().then(() => distill(bounded)), timeout]);
	} catch (err) {
		if (err instanceof DistillTimeoutError) throw err;
		throw new DistillFailedError(`distill pass threw: ${(err as Error).message}`, 'threw');
	} finally {
		if (timer) clearTimeout(timer);
	}

	if (!Array.isArray(result)) {
		throw new DistillFailedError(`distiller returned a non-array (${result === null ? 'null' : typeof result}); output is untrusted (D-026)`, 'shape');
	}
	const findings: DistilledFinding[] = [];
	for (const el of result) {
		if (!isFinding(el)) {
			throw new DistillFailedError(`distiller returned a malformed finding element (${el === null ? 'null' : typeof el}); output is untrusted (D-026)`, 'shape');
		}
		findings.push(el);
		if (findings.length >= maxFindings) break; // count cap — a flood is truncated, not absorbed.
	}
	return findings;
}

// ── ingest_source row lifecycle ──────────────────────────────────────────────────────────

// The terminal statuses are DISTINCT and HONEST (CB2 red-team §7, F-008):
//   • done        — at least one finding entered the brain.
//   • quarantined — a screen() SECRET/PII hit fired (a real security event); nothing was ingested
//                   because the offending finding(s) were quarantined. The ONLY status that may
//                   render the SECURITY badge in the /cannibalize UI.
//   • dropped     — an all-noise run: every finding was DROPPED by the DO-NOT-CAPTURE / empty /
//                   not-useful gate and NO secret/PII ever fired. Nothing worth keeping — NOT a
//                   security event. Rendered as a NEUTRAL state, never the security badge.
//   • failed      — a distill error (timeout/throw/bad-shape); nothing partial reached the brain.
export type IngestStatus =
	| 'capturing'
	| 'distilling'
	| 'ingesting'
	| 'done'
	| 'failed'
	| 'quarantined'
	| 'dropped';

/** A created/updated ingest_source row (the run record). */
export interface IngestSourceRow {
	id: string;
	status: IngestStatus;
	findingCount: number;
}

/**
 * Create the ingest_source run row (status `distilling` — capture already happened in CB1).
 * `intent` is SCREENED here at the write boundary (D-026): an operator NL intent is still
 * untrusted text and must never carry a secret into the row. `ref`/`kind` come from the
 * capture provenance (NON-secret locator, D-026). `license` is the run-level declared consent.
 * Returns the new row id — the un-forgeable provenance every finding will carry.
 */
export async function createIngestSource(
	db: Db,
	args: { kind: IngestKind; ref: string; intent: string; license?: string }
): Promise<IngestSourceRow> {
	// Screen the operator intent before it lands (it can carry a pasted secret). A quarantined
	// intent is stored REDACTED — the run still proceeds (the intent is metadata, not a finding).
	const intentGate = gateCandidate(args.intent);
	const intent = intentGate.capture && intentGate.screen ? intentGate.screen.text : '';
	const content: Record<string, unknown> = {
		kind: args.kind,
		ref: args.ref,
		intent,
		status: 'distilling'
	};
	if (args.license !== undefined) content.license = args.license;
	const [rows] = await db.query<[Array<{ id: unknown; status: IngestStatus; finding_count: number }>]>(
		`CREATE ingest_source CONTENT $content RETURN AFTER;`,
		{ content }
	);
	return { id: String(rows[0].id), status: rows[0].status, findingCount: rows[0].finding_count };
}

/** Set the run's terminal/intermediate status + finding_count, stamping completed_at on terminal. */
export async function setIngestStatus(
	db: Db,
	sourceId: string,
	status: IngestStatus,
	findingCount?: number
): Promise<void> {
	const terminal = status === 'done' || status === 'failed' || status === 'quarantined' || status === 'dropped';
	const set: string[] = ['status = $status'];
	const params: Record<string, unknown> = { src: link(sourceId), status };
	if (findingCount !== undefined) {
		set.push('finding_count = $fc');
		params.fc = findingCount;
	}
	// Pass a Date OBJECT (SDK → SurrealDB datetime); an ISO string would fail option<datetime> (F-013).
	if (terminal) set.push('completed_at = $completed');
	if (terminal) params.completed = new Date();
	await db.query(`UPDATE $src SET ${set.join(', ')};`, params);
}

// ── The pipeline ───────────────────────────────────────────────────────────────────────

export interface IngestDeps {
	db: Db;
	embedder: Embedder;
	/** The injected distill pass (D2 default: a plain bounded extraction; §7b researcher later). */
	distill: DistillFn;
}

export interface IngestRequest {
	/** RAW captured content + candidate provenance from CB1's capture layer. */
	capture: CaptureResult;
	/** The operator's NL intent for the run (steers distill; screened into the source row). */
	intent: string;
	/** Run-level declared license/consent for code-lifting (§2.2); overrides per-finding. */
	license?: string;
	/** Restrict the ingested findings to a project (table:id) — omit for global. */
	project?: string;
	/** Bounds override (tests tighten; never loosen past the capture/F-014 ethos). */
	bounds?: { timeoutMs?: number; maxFindings?: number; maxBytes?: number };
}

/** One ingested finding's outcome — its memory row id + how it screened. */
export interface IngestedFinding {
	memoryId: string;
	/** false ⇒ the finding was QUARANTINED (secret/PII) or DROPPED — NOT ingested (honest). */
	ingested: boolean;
	screenStatus: StoredMemory['screenStatus'];
	dropReason?: string;
}

export interface IngestResult {
	sourceId: string;
	status: IngestStatus;
	/** How many findings actually entered the brain (non-quarantined, non-dropped). */
	ingestedCount: number;
	/** Every distilled finding's per-row outcome (in order) — quarantined/dropped included (honest). */
	findings: IngestedFinding[];
}

/**
 * Run the full DISTILL → SCREEN → FENCE → EMBED → INGEST pipeline for ONE captured source.
 *
 * Shadow paths (all four built + tested):
 *   • happy: captured doc → findings → screened-clean → ingested as provenance-bearing memory rows.
 *   • nil/empty distill: a distiller that returns [] → run is `done`, finding_count 0 (honest — no
 *     fabricated findings; a source with no extractable knowledge is a legitimate empty result).
 *   • quarantine: a finding carrying a secret is screened OUT (storeMemory → screenStatus
 *     'quarantined', persisted:true-for-audit / excluded-from-recall) → NOT counted as ingested;
 *     if nothing ingested AND a real screen() secret/PII hit fired, the run status is `quarantined`
 *     (honest security event — nothing reached the brain).
 *   • all-noise drop: every finding was DROPPED by the DO-NOT-CAPTURE / empty / not-useful gate
 *     and NO secret/PII fired → status `dropped` (honest — nothing worth keeping; distinct from the
 *     security `quarantined`, F-008/CB2 red-team §7, so the UI shows a neutral state not a security badge).
 *   • upstream error: a distiller that THREW or TIMED OUT → DistillFailedError / DistillTimeoutError,
 *     run status `failed`, NOTHING partial in the brain (the source row is created first, so a crash
 *     mid-run leaves a `distilling`/`failed` row — never a silent half-state; re-run is idempotent
 *     against the captured content, creating a fresh run row).
 *
 * Provenance is set SERVER-SIDE (the ingest_source id created here) onto every finding — a hostile
 * finding cannot forge it. License is the run-level declared consent, falling back to the finding's
 * candidate license. RANKING-only utilization downstream (applied_count); never auto-deletes (G3).
 */
export async function ingestCaptured(deps: IngestDeps, req: IngestRequest): Promise<IngestResult> {
	const { db, embedder, distill } = deps;
	const { capture, intent } = req;

	// (1) Create the run row FIRST (un-forgeable provenance id; a crash now leaves a `distilling`
	//     row, never a silent half-state — INTERRUPT CONTRACT). Intent screened at the boundary.
	const source = await createIngestSource(db, {
		kind: capture.provenance.kind,
		ref: capture.provenance.ref,
		intent,
		license: req.license ?? capture.provenance.license
	});

	// (2) DISTILL — bounded (wall-clock + count + bytes). A timeout/throw/bad-shape → named error;
	//     mark the run `failed` and re-throw (NOTHING partial reached the brain — distill is read-only).
	let distilled: DistilledFinding[];
	try {
		distilled = await runBoundedDistill(
			distill,
			{ raw: capture.raw, kind: capture.provenance.kind, ref: capture.provenance.ref, intent },
			req.bounds
		);
	} catch (err) {
		await setIngestStatus(db, source.id, 'failed', 0).catch(() => {});
		throw err;
	}

	// Empty distill (nil/empty shadow path): an honest zero-finding result — `done`, count 0.
	if (distilled.length === 0) {
		await setIngestStatus(db, source.id, 'done', 0);
		return { sourceId: source.id, status: 'done', ingestedCount: 0, findings: [] };
	}

	// (3) SCREEN → FENCE → EMBED → INGEST through the EXISTING memory store path. Each finding
	//     becomes a memory candidate carrying provenance = source.id (server-side, un-forgeable)
	//     + license. storeMemories runs gateCandidate (screen) BEFORE embed; a quarantined finding
	//     is written for audit but flagged persisted:false-for-recall — we count only the clean/
	//     redacted persisted rows as ingested (honest). The run-level license wins over per-finding.
	await setIngestStatus(db, source.id, 'ingesting');
	const candidates: MemoryCandidate[] = distilled.map((f) => ({
		content: f.content,
		kind: 'semantic',
		namespace: 'ingest',
		source: `cannibalize:${capture.provenance.kind}`,
		project: req.project,
		provenance: source.id,
		license: req.license ?? f.license ?? capture.provenance.license
	}));
	const stored = await storeMemories({ db, embedder }, candidates);

	const findings: IngestedFinding[] = stored.map((s) => ({
		memoryId: s.id,
		// Ingested ⇔ it persisted AND was not quarantined. A quarantined row IS persisted (audit)
		// but excluded from recall — it never reaches the brain, so it is NOT ingested (honest §2.1/§7).
		ingested: s.persisted && s.screenStatus !== 'quarantined',
		screenStatus: s.screenStatus,
		dropReason: s.dropReason
	}));
	const ingestedCount = findings.filter((f) => f.ingested).length;

	// (4) Terminal status (honest, CB2 red-team §7 — distinguish a SECURITY quarantine from an
	//     all-noise drop, F-008). A genuine `screen()` secret/PII hit produces a PERSISTED row
	//     (written for audit) stamped screenStatus 'quarantined' — that, and ONLY that, is the
	//     security-bearing outcome. A finding the DO-NOT-CAPTURE / empty / not-useful gate dropped
	//     returns persisted:false (no row); a per-item insert FAILURE also returns persisted:false
	//     (its screenStatus is a placeholder 'quarantined' from the storeMemories catch — NOT a
	//     screen hit). So "a real screen quarantine fired" ⇔ at least one PERSISTED quarantined row.
	//       • some ingested            → `done`.
	//       • none ingested, a real screen quarantine fired → `quarantined` (security badge stays).
	//       • none ingested, NO screen quarantine (all dropped/empty)        → `dropped` (neutral —
	//         nothing worth keeping; must NOT show the security badge).
	//     finding_count = the ingested count (§6 contract: findings that entered the brain).
	const quarantinedByScreen = stored.some((s) => s.persisted && s.screenStatus === 'quarantined');
	const status: IngestStatus = ingestedCount > 0 ? 'done' : quarantinedByScreen ? 'quarantined' : 'dropped';
	await setIngestStatus(db, source.id, status, ingestedCount);
	return { sourceId: source.id, status, ingestedCount, findings };
}

// ── Read side — list ingest runs for the UI (§5 front door) ──────────────────────────────

/**
 * A read-only view of an ingest_source row for the UI (§5). Every datetime is coerced to an
 * ISO string or null at the read boundary (F-013 — a raw SDK datetime would break SvelteKit
 * load serialization); an absent license/completed_at is null (rendered '—', NEVER str(undefined)).
 * `ref`/`intent` are the already-screened NON-secret locator/intent (D-026) the write path stored.
 */
export interface IngestSourceView {
	id: string;
	kind: IngestKind;
	ref: string;
	intent: string;
	license: string | null;
	status: IngestStatus;
	findingCount: number;
	createdAt: string | null;
	completedAt: string | null;
}

/** F-013/F-008: SurrealDB 2.x datetime (non-POJO) → ISO string; absent/unparseable → null. */
function isoOrNull(v: unknown): string | null {
	if (v == null) return null;
	const s = v instanceof Date ? v.toISOString() : String(v);
	if (s === '' || s === 'undefined' || s === 'null') return null;
	return s;
}

function strOrNull(v: unknown): string | null {
	if (v == null) return null;
	const s = String(v);
	return s === '' || s === 'undefined' || s === 'null' ? null : s;
}

interface IngestSourceDbRow {
	id: unknown;
	kind: string;
	ref: unknown;
	intent: unknown;
	license: unknown;
	status: string;
	finding_count: number;
	created_at: unknown;
	completed_at: unknown;
}

/** Normalize a raw ingest_source DB row into the serialization-safe UI view (F-013). */
function normIngestSource(r: IngestSourceDbRow): IngestSourceView {
	return {
		id: String(r.id),
		kind: r.kind as IngestKind,
		ref: r.ref == null ? '' : String(r.ref),
		intent: r.intent == null ? '' : String(r.intent),
		license: strOrNull(r.license),
		status: r.status as IngestStatus,
		findingCount: typeof r.finding_count === 'number' ? r.finding_count : Number(r.finding_count ?? 0),
		createdAt: isoOrNull(r.created_at),
		completedAt: isoOrNull(r.completed_at)
	};
}

/**
 * List the most recent ingest runs (newest first) for the §5 front door — the live "runs"
 * feed the page subscribes to via the `ingest_source` SSE watcher. Read-only. `limit` is
 * clamped to a sane bound so a malformed caller cannot ask for an unbounded scan.
 */
export async function listIngestSources(db: Db, limit = 50): Promise<IngestSourceView[]> {
	const lim = Math.min(Math.max(1, Math.trunc(Number.isFinite(limit) ? limit : 50)), 200);
	const [rows] = await db.query<[IngestSourceDbRow[]]>(
		`SELECT id, kind, ref, intent, license, status, finding_count, created_at, completed_at
		 FROM ingest_source ORDER BY created_at DESC LIMIT $lim;`,
		{ lim }
	);
	return (rows ?? []).map(normIngestSource);
}

// ── The default distiller (D2: a plain bounded extraction pass; NO live model this wave) ──

/**
 * The D2-default DistillFn: a DETERMINISTIC, model-free extraction pass that splits the
 * captured content into discrete findings on blank-line / heading boundaries. NO live model
 * and NO creds this wave (the spec's D2 default — swap in the §7b `researcher` role later;
 * the call site is unchanged). Honest by construction:
 *   • empty/whitespace-only content → [] (the empty shadow path — an honest zero-finding run,
 *     NOT a fabricated finding, F-008).
 *   • a non-string raw blob → runBoundedDistill rejects it as DistillFailedError('shape').
 * Each finding is trimmed and capped at `maxFindingChars` so one giant paragraph cannot
 * produce a single unbounded memory row; the run-level count cap (runBoundedDistill) still
 * truncates a flood. The finding text is UNTRUSTED — it is screened+fenced downstream.
 */
export function plainDistill(opts: { maxFindingChars?: number } = {}): DistillFn {
	const maxFindingChars = opts.maxFindingChars ?? 4_000;
	return async (input: DistillInput): Promise<DistilledFinding[]> => {
		const raw = typeof input.raw === 'string' ? input.raw : '';
		// Split on blank lines (paragraph/section boundaries) — the simplest honest segmentation.
		const segments = raw
			.split(/\r?\n\s*\r?\n/)
			.map((s) => s.replace(/\s+/g, ' ').trim())
			.filter((s) => s.length > 0);
		return segments.map((s) => ({
			content: s.length > maxFindingChars ? s.slice(0, maxFindingChars) : s
		}));
	};
}
