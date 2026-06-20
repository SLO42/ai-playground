// FILE-SNAPSHOT-SPEC §2 (FS-1) — the content-addressed capture helper.
//
// captureSnapshot(db, {path, content, capturedBy, project?}) takes a point-in-time snapshot
// of a file's content and stores it in `file_snapshot` (schema m0054), returning the row id
// for the caller to LINK from (a transcript turn / a finding / a scaffold). It is the single
// chokepoint for the four rails the spec makes load-bearing:
//
//   D-016 — the `path` is structurally VALIDATED + project-scoped: a relative, non-escaping
//           project path. Absolute paths, `..` that climbs out, and drive-letter switches are
//           REJECTED (SnapshotPathError) — the SAME discipline as create's resolveEntry, but
//           PURE (no realpathSync): a snapshot path is a project-relative REFERENCE, not an
//           existing disk path, so we confine structurally against a synthetic root.
//   D-026 — the content is SCREENED (memory/screen.ts) before anything is stored. A
//           `quarantined` (secret-bearing — a .env / private-key) file is NEVER stored raw:
//           we store a MARKER + sha, no body. A `redacted` span is stored as the SAFE
//           screen().text (mirrors create's writeFileMap disposition). `clean` stores verbatim.
//   §2 content-address — content_sha (sha-256) DEDUPS: identical content for the same
//           (path, project) scope REUSES the existing row (a file read 50× unchanged = one row).
//   §2 bounded — a file over the byte cap OR binary stores a MARKER {bytes, content_sha} not
//           the blob (no DB bloat from huge/binary files).
//
// F-008: a snapshot is explicitly AS-OF `captured_at` — disk stays the source of truth. This
// helper NEVER claims the snapshot is current; the FS-3 surface labels it "may be stale". The
// row is honest: captured_at is a real datetime (coerced to ISO by the normalizer, F-013),
// the marker reason names WHY a body is absent, never a fabricated value.
//
// This module is server-only (it talks to the DB) but every decision-helper below is PURE +
// exported so the screen/dedup/bound/path logic is unit-testable without a DB.

import { createHash } from 'node:crypto';
import { isAbsolute, resolve, sep, relative } from 'node:path';
import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId, assertRecordIdOfTable } from '../db/validate';
import { screen, type ScreenStatus } from './screen';

// ── Errors (EVERY ERROR HAS A NAME) ──────────────────────────────────────────────────

/**
 * The snapshot `path` is not a valid project-relative reference (D-016, fail closed). Names the
 * concrete reason — empty, absolute, a `..` escape, or a drive-letter switch — never a generic
 * "bad path". Thrown BEFORE any DB touch, so a hostile path never reaches a query.
 */
export class SnapshotPathError extends Error {
	override readonly name = 'SnapshotPathError';
	readonly path: string;
	constructor(message: string, path: string) {
		super(message);
		this.path = path;
	}
}

/**
 * The `capturedBy` ref is present but not a well-formed record id (LOW: validate the ref shape —
 * file_snapshot.captured_by is a free-form string column, so a malformed ref would silently land as
 * a dangling pointer). Thrown BEFORE any DB touch — names the bad value, never a silent bad ref.
 * Every real caller passes a record id (`message:…` / `project:…` / `interview_run:…`); a
 * project-less/captured-by-less snapshot is fine (the field is OMITTED), but a NON-EMPTY ref must be
 * a record id.
 */
export class SnapshotRefError extends Error {
	override readonly name = 'SnapshotRefError';
	readonly ref: unknown;
	constructor(message: string, ref: unknown) {
		super(message);
		this.ref = ref;
	}
}

// ── Bounds (FILE-SNAPSHOT-SPEC §2 — bounded) ──────────────────────────────────────────

/**
 * The byte cap above which a file's body is stored as a MARKER, not the blob (§2). 256 KiB —
 * comfortably larger than any source file we expect to snapshot, small enough that the DB can
 * never bloat on a stray huge file. The ORIGINAL byte count is still recorded honestly.
 */
export const SNAPSHOT_BYTES_CAP = 256 * 1024;

// ── Pure helpers (unit-testable without a DB) ─────────────────────────────────────────

/**
 * Structurally confine a snapshot path to a project-relative, non-escaping reference (D-016).
 * PURE — no disk access (a snapshot path is a reference, not an existing file): we resolve the
 * path under a synthetic root and assert it does not climb out, mirroring create's resolveEntry
 * discipline (resolve `..` BEFORE the prefix compare so `a/../../etc` cannot slip through).
 *
 * Returns the NORMALIZED project-relative path (forward/back slashes collapsed by resolve,
 * re-relativized). Throws {@link SnapshotPathError} (named reason) on empty / absolute / `..`
 * escape / drive switch. Windows: case-insensitive compare + drive-letter guard.
 */
export function normalizeSnapshotPath(path: unknown): string {
	if (typeof path !== 'string' || path.trim() === '') {
		throw new SnapshotPathError('snapshot path is empty', String(path));
	}
	const trimmed = path.trim();
	if (isAbsolute(trimmed)) {
		throw new SnapshotPathError(`snapshot path must be project-relative (D-016): ${trimmed}`, trimmed);
	}
	// A Windows drive-relative path ("C:foo") is NOT caught by isAbsolute — reject it explicitly so
	// it cannot smuggle a drive switch past the synthetic-root confinement.
	if (/^[a-zA-Z]:/.test(trimmed)) {
		throw new SnapshotPathError(`snapshot path must not carry a drive letter (D-016): ${trimmed}`, trimmed);
	}
	// Synthetic root: a placeholder we resolve against and then strip — never touches disk.
	const root = resolve(sep === '\\' ? 'C:\\__snap_root__' : '/__snap_root__');
	const abs = resolve(root, trimmed);
	const rootWithSep = root.endsWith(sep) ? root : root + sep;
	const cmpAbs = process.platform === 'win32' ? abs.toLowerCase() : abs;
	const cmpRoot = process.platform === 'win32' ? rootWithSep.toLowerCase() : rootWithSep;
	if (!cmpAbs.startsWith(cmpRoot)) {
		throw new SnapshotPathError(`snapshot path escapes the project root (D-016, fail closed): ${trimmed}`, trimmed);
	}
	// Re-relativize to the normalized project path; normalize separators to '/' for a stable key.
	return relative(root, abs).split(sep).join('/');
}

/** The sha-256 (lowercase hex) of a UTF-8 string — the content address (§2). */
export function contentSha(content: string): string {
	return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * The DETERMINISTIC `file_snapshot:<id>` record id for a dedup scope (content_sha, path, project)
 * — the CONCURRENCY-SAFE dedup guarantee (file-snapshot-harden; mirrors F-026 / gauntlet_key).
 *
 * Identical content for the same (path, project) maps to the SAME record id, so two concurrent
 * captures both `CREATE` on that id and the loser collides ATOMICALLY on the primary key (SurrealDB
 * cannot create two rows at one id) — exactly ONE row, no matter the racer count. This is why the
 * dedup is the id, NOT a secondary UNIQUE index (which was reproduced NOT enforcing under concurrent
 * inserts on this build — F-026/DEFECT 3).
 *
 * The id suffix is a sha-256 of the three scope components joined by SCOPE_SEP (a NUL byte). A NUL
 * can never appear in a sha-hex ([a-f0-9]), a normalized snapshot path (normalizeSnapshotPath would
 * have rejected/stripped it), or a validated `project:slug` id, so the join is UNAMBIGUOUS -- no
 * `a|b` vs `a` + `|b` collision across the three components. project is OPTIONAL; a project-less
 * snapshot uses an empty project component, giving it a distinct deterministic scope from any
 * project-scoped one. The suffix is lowercase hex, satisfying the D-016 record-id charset.
 *
 * PURE + exported -- the id derivation is unit-testable without a DB.
 */
// SCOPE_SEP is a NUL byte BUILT AT RUNTIME via String.fromCharCode(0) -- deliberately NOT a literal
// NUL nor a unicode escape in source, so the file stays pure-ASCII text (git would treat a file
// with a raw NUL byte as binary; this keeps the source diffable).
const SCOPE_SEP = String.fromCharCode(0);
export function snapshotId(sha: string, path: string, project: string | null): string {
	const scopeKey = `${sha}${SCOPE_SEP}${path}${SCOPE_SEP}${project ?? ''}`;
	const suffix = createHash('sha256').update(scopeKey, 'utf8').digest('hex');
	return `file_snapshot:${suffix}`;
}

/**
 * Validate a NON-EMPTY `capturedBy` ref is a well-formed record id (LOW). Returns the validated ref
 * (or undefined when absent — a captured-by-less snapshot is valid; the field is OMITTED). Throws
 * {@link SnapshotRefError} (named, pre-DB) when present-but-malformed, so a bad ref never persists as
 * a dangling free-form pointer. Wraps the db/validate.ts assertRecordId so the charset rule is the
 * SAME single chokepoint (D-016) — re-surfaced as a snapshot-named error for the caller.
 */
export function assertCapturedByRef(ref: unknown): string | undefined {
	if (ref == null || ref === '') return undefined;
	if (typeof ref !== 'string') {
		throw new SnapshotRefError(`capturedBy must be a record-id string, got ${typeof ref}`, ref);
	}
	try {
		return assertRecordId(ref);
	} catch {
		throw new SnapshotRefError(
			`capturedBy must be a '<table>:<id>' record id (D-016), got ${JSON.stringify(ref)}`,
			ref
		);
	}
}

/**
 * Is this the deterministic-id PRIMARY-KEY collision a concurrent identical capture raises (F-026)?
 * On this SurrealDB build the same record-id double-CREATE surfaces as one of two raw shapes (both
 * InternalError): the record-already-exists message, OR a commit-race read/write conflict when two
 * writers reach commit together. This matcher is intentionally narrow — it matches ONLY those real
 * collision phrases (never an unrelated error whose text merely mentions "exists"), and the caller
 * invokes it ONLY around the single deterministic-id CREATE, so a match can be nothing but the dedup
 * collision (mirrors workforce/ceremony.ts isDedupCollision; F-008 — re-raise everything else).
 */
function isSnapshotIdCollision(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return (
		/record `?[^`']*`? already exists/i.test(msg) ||
		/failed transaction|read or write conflict/i.test(msg)
	);
}

/** Byte length of a string as UTF-8 (the honest on-disk size, not the JS char count). */
export function utf8Bytes(content: string): number {
	return Buffer.byteLength(content, 'utf8');
}

/**
 * Heuristic binary detection (§2 — huge/binary files store a marker). A NUL byte in the first
 * 8 KiB is the canonical "this is not text" signal (the same heuristic git uses). Pure; operates
 * on the string's UTF-8 bytes. Empty content is NOT binary (it is honest empty text).
 */
export function isBinaryContent(content: string): boolean {
	if (content.length === 0) return false;
	const buf = Buffer.from(content, 'utf8');
	const scan = Math.min(buf.length, 8192);
	for (let i = 0; i < scan; i++) {
		if (buf[i] === 0) return true;
	}
	return false;
}

/** The reason a snapshot body is a MARKER rather than the file content. */
export type SnapshotMarkerReason = 'quarantined' | 'oversize' | 'binary';

/** The decided storable form of a snapshot's content — the output of the pure planner. */
export interface SnapshotBodyPlan {
	/** What gets written to `file_snapshot.content` — the safe text OR a marker string. */
	body: string;
	/** The ORIGINAL content byte length (honest size, even when body is a marker). */
	bytes: number;
	/** Content-address of the ORIGINAL content (dedup key — computed over the real bytes). */
	sha: string;
	/** D-026 screen outcome of the original content. */
	screenStatus: ScreenStatus;
	/** Why the body is a marker; undefined when the real (clean/redacted) content is stored. */
	markerReason?: SnapshotMarkerReason;
	/** True iff `body` is a marker, not the file content. */
	isMarker: boolean;
	/** The screen rule ids that fired (audit), empty when clean. */
	screenReasons: string[];
}

/**
 * Decide HOW a file's content is stored (§2 + D-026), PURELY. The order is load-bearing:
 *
 *   1. SCREEN FIRST (D-026) — a `quarantined` (un-redactable secret: a .env / private-key)
 *      file is NEVER stored raw: we emit a MARKER, no body, regardless of size. A `redacted`
 *      span is replaced by screen().text (the SAFE version) and that safe text is what we then
 *      size/bound. `clean` keeps the original. So a raw secret can never reach the bounded body.
 *   2. BOUND the SAFE text — if the (screened) text is binary OR exceeds the byte cap, emit a
 *      MARKER (no blob). The sha + bytes are computed over the ORIGINAL content so the content-
 *      address and the honest size are stable whether or not the body is a marker.
 *
 * A marker is a short, honest, machine-readable line naming the reason + sha + size — never a
 * fabricated stand-in for the content (F-008).
 */
export function planSnapshotBody(content: string): SnapshotBodyPlan {
	const original = typeof content === 'string' ? content : '';
	const bytes = utf8Bytes(original);
	const sha = contentSha(original);

	const screened = screen(original);

	// 1. D-026 — un-redactable secret: marker, no raw body, no matter the size.
	if (screened.status === 'quarantined') {
		return {
			body: markerString('quarantined', sha, bytes, screened.reasons),
			bytes,
			sha,
			screenStatus: 'quarantined',
			markerReason: 'quarantined',
			isMarker: true,
			screenReasons: screened.reasons
		};
	}

	// The SAFE text to store/bound: original (clean) or screen().text (redacted span replaced).
	const safeText = screened.status === 'redacted' ? screened.text : original;

	// 2. Bound the safe text — binary OR oversize → marker (no blob).
	if (isBinaryContent(safeText)) {
		return {
			body: markerString('binary', sha, bytes, screened.reasons),
			bytes,
			sha,
			screenStatus: screened.status,
			markerReason: 'binary',
			isMarker: true,
			screenReasons: screened.reasons
		};
	}
	if (utf8Bytes(safeText) > SNAPSHOT_BYTES_CAP) {
		return {
			body: markerString('oversize', sha, bytes, screened.reasons),
			bytes,
			sha,
			screenStatus: screened.status,
			markerReason: 'oversize',
			isMarker: true,
			screenReasons: screened.reasons
		};
	}

	// Store the safe text (clean === original, redacted === safe screened text). Never raw secret.
	return {
		body: safeText,
		bytes,
		sha,
		screenStatus: screened.status,
		isMarker: false,
		screenReasons: screened.reasons
	};
}

/** Build the honest marker line stored in place of a withheld body (F-008 — names the reason). */
function markerString(reason: SnapshotMarkerReason, sha: string, bytes: number, reasons: string[]): string {
	const detail = reasons.length ? ` [${reasons.join(', ')}]` : '';
	return `[file-snapshot:${reason} sha=${sha} bytes=${bytes}${detail}] — content withheld (FILE-SNAPSHOT-SPEC §2; disk is the source of truth).`;
}

// ── The capture helper (FS-1 entry point) ─────────────────────────────────────────────

export interface CaptureSnapshotInput {
	/** The project-relative path the file lives at (D-016 validated here, reject escape). */
	path: string;
	/** The file's content at capture time. nil/non-string is treated as empty (honest). */
	content: string;
	/** The entity/event that referenced the file (a record id / scaffold tag) — FS-2 supplies it. */
	capturedBy?: string;
	/** The owning project id (`project:<slug>`), when the file belongs to one. Optional (§2). */
	project?: string;
}

export interface CaptureSnapshotResult {
	/** The `file_snapshot:<id>` row id — for the caller to LINK from (FS-2). */
	id: string;
	/** The content-address of the captured content. */
	contentSha: string;
	/** True when an existing identical-content row was REUSED (dedup), false when a row was created. */
	deduped: boolean;
	/** The D-026 screen outcome. */
	screenStatus: ScreenStatus;
	/** True when the stored body is a marker (quarantined/oversize/binary), not the content. */
	isMarker: boolean;
	/** The marker reason when isMarker, else undefined. */
	markerReason?: SnapshotMarkerReason;
}

/** A persisted file_snapshot row shape (the fields captureSnapshot reads back). */
interface SnapshotRow {
	id: unknown;
	content_sha: string;
	screen_status: ScreenStatus;
	is_marker: boolean;
	marker_reason?: string | null;
}

/** Build a deduped (REUSE) result from an already-stored row. */
function dedupResult(row: SnapshotRow, sha: string): CaptureSnapshotResult {
	return {
		id: String(row.id),
		contentSha: sha,
		deduped: true,
		screenStatus: row.screen_status,
		isMarker: row.is_marker,
		...(row.marker_reason ? { markerReason: row.marker_reason as SnapshotMarkerReason } : {})
	};
}

/**
 * Capture (or dedup to) a point-in-time snapshot of a file's content (FILE-SNAPSHOT-SPEC §2).
 *
 * Sequence: (1) D-016 — validate + normalize the path (SnapshotPathError on escape, before any DB
 * touch); (1b) LOW — validate the capturedBy ref shape (SnapshotRefError on a malformed ref); (2)
 * D-026 + §2 — plan the storable body (screen → quarantine-marker / redacted-safe / clean, then
 * bound binary/oversize → marker), computing the content_sha over the ORIGINAL bytes; (3) DEDUP —
 * the row id is DETERMINISTIC over (content_sha, path, project), so a fast SELECT-by-id reuses an
 * existing identical capture; (4) CREATE on that deterministic id — a concurrent identical capture
 * COLLIDES ATOMICALLY on the primary key and is RESOLVED to the existing row (deduped:true).
 *
 * CONCURRENCY (closes the TOCTOU dedup MEDIUM — file-snapshot-harden): the OLD path did a
 * SELECT-then-CREATE with NO DB uniqueness guard, so N concurrent identical captures all missed the
 * SELECT and wrote N rows (defeating §2's "identical content stores ONCE"). The fix mirrors F-026 /
 * gauntlet_key: a deterministic record id makes the dedup an ATOMIC primary-key collision — the SELECT
 * is now just a fast-path read; correctness comes from the id, and the loser's collision is caught and
 * resolved to the winner's row. EXACTLY one row regardless of racer count (proven by the Promise.all
 * concurrency test). Interrupt-safe: a re-run CREATEs the same id → collides → resolves to the prior
 * row (idempotent-by-collision; no half-state).
 *
 * Returns the row id (for the caller to link) + whether it deduped + the screen/marker disposition.
 *
 * Shadow paths: nil/empty content → an honest empty-string snapshot (sha of '', bytes 0, clean);
 * an escaping/absolute path → SnapshotPathError (named, pre-DB); a malformed capturedBy →
 * SnapshotRefError (named, pre-DB); a quarantined secret → a marker row (never raw); a CONCURRENT
 * identical capture → the loser's id-collision is resolved to the one row; an upstream DB error
 * (not a dedup collision) → surfaces with its own name (never swallowed as success).
 */
export async function captureSnapshot(
	db: Db,
	input: CaptureSnapshotInput
): Promise<CaptureSnapshotResult> {
	// 1. D-016 — validate + normalize (throws SnapshotPathError on escape, before any DB touch).
	const path = normalizeSnapshotPath(input.path);

	// 1b. LOW — validate the capturedBy ref SHAPE (throws SnapshotRefError on a malformed ref, pre-DB).
	const capturedBy = assertCapturedByRef(input.capturedBy);

	// 2. D-026 + §2 — decide the storable body (screen + bound). sha is over the ORIGINAL content.
	const plan = planSnapshotBody(typeof input.content === 'string' ? input.content : '');

	// Optional project: validated to a `project:<slug>` id (D-016) and bound as a record link.
	const projectId =
		input.project != null && input.project !== ''
			? assertRecordIdOfTable(input.project, 'project')
			: null;
	const projectRid = projectId ? new StringRecordId(projectId) : null;

	// 3. DEDUP — the deterministic record id over (content_sha, path, project) is the concurrency-safe
	// dedup key (F-026). A fast SELECT-by-id reuses an existing identical capture without a CREATE.
	const ridStr = snapshotId(plan.sha, path, projectId);
	const rid = new StringRecordId(assertRecordId(ridStr));
	const [hit] = await db.query<[SnapshotRow[]]>(
		`SELECT id, content_sha, screen_status, is_marker, marker_reason FROM $rid;`,
		{ rid }
	);
	if (hit && hit.length > 0) return dedupResult(hit[0], plan.sha);

	// 4. CREATE on the DETERMINISTIC id. Every value binds as a $param (D-016); the validated record
	// id binds as $rid (never interpolated). captured_at defaults to time::now() (honest as-of). A
	// concurrent identical capture collides on this primary id → caught + resolved to the winner row.
	const content: Record<string, unknown> = {
		path,
		content_sha: plan.sha,
		content: plan.body,
		bytes: plan.bytes,
		screen_status: plan.screenStatus,
		is_marker: plan.isMarker
	};
	if (plan.markerReason) content.marker_reason = plan.markerReason;
	if (capturedBy) content.captured_by = capturedBy;
	if (projectRid) content.project = projectRid;

	try {
		const [created] = await db.query<[SnapshotRow[]]>(`CREATE $rid CONTENT $content RETURN AFTER;`, {
			rid,
			content
		});
		if (!created || created.length === 0) {
			// EVERY ERROR HAS A NAME: a CREATE that returns nothing is a real DB anomaly, not success.
			throw new Error('captureSnapshot: CREATE file_snapshot returned no row (unexpected DB state).');
		}
		return {
			id: String(created[0].id),
			contentSha: plan.sha,
			deduped: false,
			screenStatus: plan.screenStatus,
			isMarker: plan.isMarker,
			...(plan.markerReason ? { markerReason: plan.markerReason } : {})
		};
	} catch (err) {
		// CONCURRENCY (F-026): the deterministic-id CREATE collided — a racer won with the SAME content.
		// This is the dedup invariant biting ATOMICALLY (NOT an error). Re-read the winner's row by id
		// and resolve to it (deduped:true). This is a SINGLE re-read, not a retry loop — it cannot spin.
		if (isSnapshotIdCollision(err)) {
			const [won] = await db.query<[SnapshotRow[]]>(
				`SELECT id, content_sha, screen_status, is_marker, marker_reason FROM $rid;`,
				{ rid }
			);
			if (won && won.length > 0) return dedupResult(won[0], plan.sha);
			// The winner's row is not visible yet — surface honestly rather than fabricate (F-008).
			throw new Error(
				`captureSnapshot: id-collision on ${ridStr} but the winning row is not yet visible (retry capture).`
			);
		}
		throw err; // a non-collision DB error propagates unchanged (named, never swallowed as success).
	}
}

// ── Row normalizer (F-013 — coerce datetimes to ISO; never str(undefined)) ─────────────

/** A normalized file_snapshot row safe to return from a SvelteKit load (F-013). */
export interface FileSnapshotRow {
	id: string;
	path: string;
	content_sha: string;
	content: string;
	bytes: number;
	screen_status: ScreenStatus;
	marker_reason: SnapshotMarkerReason | null;
	is_marker: boolean;
	captured_by: string | null;
	project: string | null;
	/** ISO-8601 capture time (F-013 — coerced from the SDK datetime; never a raw non-POJO). */
	captured_at: string | null;
}

/** Coerce a SurrealDB datetime to an ISO string; absent → null (F-013 — never str(undefined)). */
function isoOrNull(v: unknown): string | null {
	if (v == null) return null;
	if (v instanceof Date) return v.toISOString();
	return String(v);
}

/**
 * Normalize a raw file_snapshot row for client serialization (F-013): id/project/captured_by
 * stringified, the datetime coerced to ISO (absent → null, NEVER str(undefined) which renders the
 * literal "undefined"). The FS-3 view-file surface consumes this — it MUST label `captured_at` as
 * "as-of" and `is_marker` rows as content-withheld; this normalizer is the honest data boundary.
 */
export function normFileSnapshot(row: Record<string, unknown>): FileSnapshotRow {
	return {
		id: String(row.id),
		path: String(row.path ?? ''),
		content_sha: String(row.content_sha ?? ''),
		content: String(row.content ?? ''),
		bytes: typeof row.bytes === 'number' ? row.bytes : 0,
		screen_status: (row.screen_status as ScreenStatus) ?? 'clean',
		marker_reason: row.marker_reason != null ? (String(row.marker_reason) as SnapshotMarkerReason) : null,
		is_marker: row.is_marker === true,
		captured_by: row.captured_by != null ? String(row.captured_by) : null,
		project: row.project != null ? String(row.project) : null,
		captured_at: isoOrNull(row.captured_at)
	};
}
