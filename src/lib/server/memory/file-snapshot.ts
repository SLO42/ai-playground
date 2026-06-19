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
import { assertRecordIdOfTable } from '../db/validate';
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

/**
 * Capture (or dedup to) a point-in-time snapshot of a file's content (FILE-SNAPSHOT-SPEC §2).
 *
 * Sequence: (1) D-016 — validate + normalize the path (SnapshotPathError on escape, before any
 * DB touch); (2) D-026 + §2 — plan the storable body (screen → quarantine-marker / redacted-safe /
 * clean, then bound binary/oversize → marker), computing the content_sha over the ORIGINAL bytes;
 * (3) DEDUP — if a row with the same (content_sha, path, project) already exists, REUSE it (no
 * duplicate write); else (4) CREATE the row.
 *
 * Returns the row id (for the caller to link) + whether it deduped + the screen/marker disposition.
 *
 * Shadow paths: nil/empty content → an honest empty-string snapshot (sha of '', bytes 0, clean);
 * an escaping/absolute path → SnapshotPathError (named, pre-DB); a quarantined secret → a marker
 * row (never raw); an upstream DB error → surfaces with its own name (never swallowed as success).
 */
export async function captureSnapshot(
	db: Db,
	input: CaptureSnapshotInput
): Promise<CaptureSnapshotResult> {
	// 1. D-016 — validate + normalize (throws SnapshotPathError on escape, before any DB touch).
	const path = normalizeSnapshotPath(input.path);

	// 2. D-026 + §2 — decide the storable body (screen + bound). sha is over the ORIGINAL content.
	const plan = planSnapshotBody(typeof input.content === 'string' ? input.content : '');

	// Optional project: validated to a `project:<slug>` id (D-016) and bound as a record link.
	const projectRid =
		input.project != null && input.project !== ''
			? new StringRecordId(assertRecordIdOfTable(input.project, 'project'))
			: null;

	// 3. DEDUP — content-address scope is (content_sha, path, project) per §2. project is optional;
	// the IS NONE / = $project split keeps the match exact (a NULL bind would never equal a NONE
	// column, so a project-less snapshot must match on `project IS NONE`).
	const dedupSurql = projectRid
		? `SELECT id, content_sha, screen_status, is_marker, marker_reason FROM file_snapshot
			 WHERE content_sha = $sha AND path = $path AND project = $project LIMIT 1;`
		: `SELECT id, content_sha, screen_status, is_marker, marker_reason FROM file_snapshot
			 WHERE content_sha = $sha AND path = $path AND project IS NONE LIMIT 1;`;
	const [existing] = await db.query<[SnapshotRow[]]>(dedupSurql, {
		sha: plan.sha,
		path,
		...(projectRid ? { project: projectRid } : {})
	});
	if (existing && existing.length > 0) {
		const row = existing[0];
		return {
			id: String(row.id),
			contentSha: plan.sha,
			deduped: true,
			screenStatus: row.screen_status,
			isMarker: row.is_marker,
			...(row.marker_reason ? { markerReason: row.marker_reason as SnapshotMarkerReason } : {})
		};
	}

	// 4. CREATE — a fresh content-addressed row. Every value binds as a $param (D-016); only the
	// validated table literal is interpolated. captured_at defaults to time::now() (honest as-of).
	const content: Record<string, unknown> = {
		path,
		content_sha: plan.sha,
		content: plan.body,
		bytes: plan.bytes,
		screen_status: plan.screenStatus,
		is_marker: plan.isMarker
	};
	if (plan.markerReason) content.marker_reason = plan.markerReason;
	if (input.capturedBy != null && input.capturedBy !== '') content.captured_by = input.capturedBy;
	if (projectRid) content.project = projectRid;

	const [created] = await db.query<[SnapshotRow[]]>(
		`CREATE file_snapshot CONTENT $content RETURN AFTER;`,
		{ content }
	);
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
