// FILE-SNAPSHOT-SPEC §3 (FS-2) — wire captureSnapshot at the three capture points.
//
// This module is the SHARED, best-effort glue between the three host flows (scaffold-create,
// the driven-session transcript, a gauntlet finding) and the FS-1 captureSnapshot helper. It
// owns the two cross-cutting rails every capture point needs, so no caller forks the machinery:
//
//   • captureSnapshotSafe — captureSnapshot wrapped so a capture failure NEVER crashes the host
//     flow (FILE-SNAPSHOT-SPEC §3 "best-effort/non-blocking"; F-008/F-014). A snapshot is
//     observability, not the work: a SnapshotPathError (an absolute/escaping path), a DB error, a
//     screen fault — all are caught, named in a console.warn, and swallowed (returns null). The
//     scaffold/session/finding happy path is byte-for-byte unchanged whether capture succeeds.
//
//   • fileTurnFromToolCall — the PURE extractor that decides whether a transcript tool turn is a
//     FILE turn worth snapshotting, and pulls the (path, content) out of the tool's args. Only the
//     file tools (Read/Edit/Write/NotebookEdit) qualify; a Bash/Grep/Glob turn is NOT a file turn
//     (it carries no single file body) and yields null. The path a tool reports is ABSOLUTE; the
//     caller relativizes it against the project root before capture (captureSnapshot is D-016
//     project-relative). Pure + exported so the file-detection logic is unit-testable without a DB.
//
// The capture is content-addressed (dedup-by-sha), so re-capturing the same file is cheap and safe
// — a file read 50× unchanged is ONE row (FILE-SNAPSHOT-SPEC §2). Every capture is additive: it
// must not change the host flow's behavior on the happy path (the spec's load-bearing constraint).

import { isAbsolute, relative, sep } from 'node:path';
import type { Db } from '../db/client';
import type { RuntimeEvent } from '../runtime/index';
import { captureSnapshot, type CaptureSnapshotResult } from './file-snapshot';

// ── Best-effort capture wrapper (FILE-SNAPSHOT-SPEC §3; F-008/F-014) ──────────────────

/** What a file turn resolved to: the project-relative path + the content to snapshot. */
export interface FileTurn {
	/** The file path the tool referenced (ABSOLUTE as the tool reports it — caller relativizes). */
	path: string;
	/** The content to snapshot — what the agent wrote (Write/Edit) or read (a paired tool_result). */
	content: string;
	/** Which tool produced the turn (audit / debug). */
	tool: string;
	/** 'wrote' (Write/Edit args carry the new content) | 'read' (a Read awaiting its result). */
	disposition: 'wrote' | 'read';
}

/**
 * Capture a snapshot WITHOUT ever throwing into the host flow (best-effort, FILE-SNAPSHOT-SPEC §3).
 * A capture is observability, not the work — so EVERY failure mode is caught and named, never
 * propagated: a SnapshotPathError (an absolute/escaping/`..` path slipped through), a DB write
 * error, a screen fault. On failure we log a single honest warn (naming the path + the error) and
 * return null; the caller proceeds exactly as if no capture were wired (F-008 — honest, the absence
 * of a snapshot is just an un-captured file, never a fabricated one). Returns the FS-1 result on
 * success (so a caller MAY link the row id), null on any failure.
 */
export async function captureSnapshotSafe(
	db: Db,
	input: { path: string; content: string; capturedBy?: string; project?: string }
): Promise<CaptureSnapshotResult | null> {
	try {
		return await captureSnapshot(db, input);
	} catch (err) {
		// EVERY ERROR HAS A NAME: name the path + the concrete error, swallow so the host flow never
		// breaks on an observability write (F-014). A path that is not project-relative (an agent
		// editing a file outside the project root) lands here as a SnapshotPathError — expected, benign.
		console.warn(
			`[file-snapshot] capture skipped for ${JSON.stringify(input.path)} ` +
				`(best-effort, host flow continues): ${(err as Error)?.message ?? String(err)}`
		);
		return null;
	}
}

// ── Project-relative coercion (D-016 — the tool reports an ABSOLUTE path) ──────────────

/**
 * Relativize an ABSOLUTE tool file_path against the project root so captureSnapshot's D-016
 * project-relative confinement accepts it. Returns null when the path is NOT under the root (an
 * agent touched a file outside the project — we honestly do NOT snapshot it rather than force a
 * misleading relative path) or when either input is missing. PURE; mirrors the resolveEntry prefix
 * discipline (case-insensitive compare on win32). A returned path is forward-slash normalized so it
 * is a stable dedup key regardless of the host separator.
 */
export function projectRelativePath(absPath: string, projectRoot: string): string | null {
	if (typeof absPath !== 'string' || absPath.trim() === '') return null;
	if (typeof projectRoot !== 'string' || projectRoot.trim() === '') return null;
	const rel = relative(projectRoot, absPath);
	// `relative` returns a `..`-leading path when absPath is OUTSIDE the root, and '' when it IS the
	// root — both are "not a project file" → honest null (never a fabricated/escaping snapshot path).
	if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
	// A drive-switch on win32 yields an absolute `rel` (caught above); normalize separators to '/'.
	return rel.split(sep).join('/');
}

// ── Pure file-turn extractor (the transcript tool_use/tool_result chokepoint) ─────────

/** The file tools whose turns carry (or imply) a single file body worth snapshotting (§3 b). */
const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const FILE_READ_TOOLS = new Set(['Read', 'NotebookRead']);

/** Read a string field from a loosely-typed tool args blob (the runtime passes `unknown`). */
function strField(args: unknown, key: string): string | undefined {
	if (!args || typeof args !== 'object') return undefined;
	const v = (args as Record<string, unknown>)[key];
	return typeof v === 'string' ? v : undefined;
}

/**
 * Decide whether a `tool_use` (tool_call) event is a FILE turn worth snapshotting, and extract the
 * (path, content, disposition) — PURELY (FILE-SNAPSHOT-SPEC §3 b). The mapping is honest about what
 * content is actually present in a SINGLE event:
 *
 *   • Write          → path=file_path, content=content              → 'wrote' (the new file body).
 *   • Edit/MultiEdit → path=file_path, content=new_string ?? content → 'wrote' (the post-edit text
 *                      the tool args carry; we snapshot WHAT THE AGENT WROTE, the spec's intent).
 *   • NotebookEdit   → path=notebook_path, content=new_source ?? content → 'wrote'.
 *   • Read/NotebookRead → path=file_path, content='' → 'read' (a Read's tool_use carries NO body;
 *                      the body the agent SAW arrives in the following tool_result — the caller
 *                      pairs them, attaching the result output to this path).
 *
 * Returns null for any non-file tool (Bash/Grep/Glob/etc.) or a turn with no usable file_path
 * (nil/empty shadow path) — those are not file turns and must not be snapshotted (F-008 honest).
 * Note the path here is whatever the tool reported (typically ABSOLUTE); the caller relativizes it.
 */
export function fileTurnFromToolUse(toolName: string, args: unknown): FileTurn | null {
	if (typeof toolName !== 'string' || toolName === '') return null;

	if (FILE_WRITE_TOOLS.has(toolName)) {
		const path =
			strField(args, 'file_path') ?? strField(args, 'notebook_path') ?? strField(args, 'path');
		if (!path || path.trim() === '') return null;
		// The new content the tool args carry, by tool. We DO NOT fabricate: if none is present
		// (a malformed turn), content is '' — an honest empty snapshot, never an invented body.
		const content =
			strField(args, 'content') ??
			strField(args, 'new_string') ??
			strField(args, 'new_source') ??
			'';
		return { path, content, tool: toolName, disposition: 'wrote' };
	}

	if (FILE_READ_TOOLS.has(toolName)) {
		const path = strField(args, 'file_path') ?? strField(args, 'notebook_path') ?? strField(args, 'path');
		if (!path || path.trim() === '') return null;
		// A Read's tool_use carries no body; the caller attaches the paired tool_result output.
		return { path, content: '', tool: toolName, disposition: 'read' };
	}

	// Bash / Grep / Glob / WebFetch / etc. — not a single-file turn. Honest null (F-008).
	return null;
}

// ── The transcript capture orchestrator (FILE-SNAPSHOT-SPEC §3 b) ─────────────────────

/** Inputs the launch loop passes per streamed event (the pairing state is threaded in/out). */
export interface CaptureFileTurnInput {
	/** The streamed runtime event for this turn. */
	ev: RuntimeEvent;
	/** The persisted `message:<id>` row this turn became — the captured_by link target. */
	messageId: string;
	/** The session's project root (cwd) — used to relativize the ABSOLUTE tool path (D-016). */
	projectRoot: string;
	/** The owning `project:<slug>` id — scopes the snapshot dedup. */
	projectId: string;
	/** The pending Read's ABSOLUTE path awaiting its tool_result body (pairing state in). */
	pendingReadAbsPath: string | null;
}

/**
 * Capture a file_snapshot for ONE transcript event, threading the Read→result pairing state
 * (FILE-SNAPSHOT-SPEC §3 b). Returns the NEW pending-read path the caller should carry to the next
 * event (an ABSOLUTE path when a Read's tool_use is awaiting its result body; null otherwise).
 *
 * Event handling (honest about what content a single event carries):
 *   • tool_call (tool_use) → fileTurnFromToolUse decides:
 *       – 'wrote' (Write/Edit) → relativize + capture the new content NOW → "what the agent wrote".
 *         Clears any pending Read (a write supersedes a dangling read pairing). Returns null.
 *       – 'read' (Read)        → DEFER: the body arrives in the following tool_result. Return the
 *         ABSOLUTE path so the next tool_result pairs with it. (No capture on this event.)
 *       – non-file tool        → clears the pending Read, returns null.
 *   • tool_result → if a Read is pending, relativize that path + capture THIS result's output →
 *     "what the agent saw". Consume the pairing (return null). A result with no pending Read is a
 *     non-file tool's result — nothing to snapshot (return null).
 *   • any other event (log/thinking/etc.) → clears the pending Read (a turn intervened), returns null.
 *
 * Every capture is BEST-EFFORT (captureSnapshotSafe never throws) so a snapshot failure never
 * affects the driven session (F-014). A path outside the project root → projectRelativePath returns
 * null → no capture (honest, never an escaping/fabricated snapshot path, D-016).
 */
export async function captureFileTurnSnapshot(
	db: Db,
	input: CaptureFileTurnInput
): Promise<string | null> {
	const { ev, messageId, projectRoot, projectId } = input;

	if (ev.type === 'tool_call') {
		const turn = fileTurnFromToolUse(ev.name, ev.args);
		if (!turn) return null; // non-file tool — clear any pending Read.
		if (turn.disposition === 'read') {
			// Defer: the read body is in the following tool_result. Carry the ABSOLUTE path forward.
			return turn.path;
		}
		// 'wrote' — capture the new content NOW, linked to this tool_use turn.
		const rel = projectRelativePath(turn.path, projectRoot);
		if (rel) {
			await captureSnapshotSafe(db, {
				path: rel,
				content: turn.content,
				capturedBy: messageId,
				project: projectId
			});
		}
		return null; // a write clears any dangling Read pairing.
	}

	if (ev.type === 'tool_result') {
		const pending = input.pendingReadAbsPath;
		if (!pending) return null; // not a paired file read — nothing to snapshot.
		const rel = projectRelativePath(pending, projectRoot);
		if (rel) {
			// The tool_result output is what the agent SAW (the file body the Read returned).
			await captureSnapshotSafe(db, {
				path: rel,
				content: ev.output,
				capturedBy: messageId,
				project: projectId
			});
		}
		return null; // pairing consumed.
	}

	// Any other event ends a pending pairing (a turn intervened) — honest, no mis-pair.
	return null;
}
