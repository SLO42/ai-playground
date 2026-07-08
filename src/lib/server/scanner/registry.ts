// TASK 1.1 — project registry upsert (ARCHITECTURE §2.7; depends on: db).
//
// scanProject(db, dir) is the one public entry: it path-confines `dir` under
// CODE_ROOT (D-018 — resolve symlinks + `..` BEFORE the prefix check, fail
// closed), runs the pure detector, then UPSERTs a `project` row via the guarded
// db helpers (D-016 — slug is validated before it can name a record id; all
// values bind as $params). The registry IS the SurrealDB `project` table — there
// is no registry.json (DATA-MODEL §4.1).

import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import { isPlatformSelfRoot, writeProjectGuardrails } from '../claude-code/guardrails';
import { detectEcosystem, readRepoUrl, slugify, type Detection } from './detect';

/** Thrown when a scan target escapes the configured code root (fail-closed, D-018). */
export class PathConfinementError extends Error {
	override readonly name = 'PathConfinementError';
	constructor(
		message: string,
		readonly target: string,
		readonly root: string
	) {
		super(message);
	}
}

/** A persisted `project` row (the fields scanProject writes/reads back). */
export interface ProjectRow {
	id: string;
	slug: string;
	name: string;
	root_path: string;
	ecosystem: string[];
	build_tool?: string;
	test_command?: string;
	repo_url?: string;
	status: string;
}

/**
 * Resolve `dir` to a real, absolute path and assert it lives under `codeRoot`
 * AFTER symlink + `..` normalization (D-018 / path-confinement). Returns the
 * canonical absolute path. Throws {@link PathConfinementError} on any escape or
 * if the target cannot be resolved (broken symlink → fail closed, never allow).
 */
export function confineToRoot(dir: string, codeRoot: string): string {
	let realDir: string;
	let realRoot: string;
	try {
		// realpathSync resolves symlinks; resolve() collapses `..` first so a
		// non-existent-but-inside path still normalizes. Resolve the ROOT too so the
		// comparison is symlink-stable on both sides.
		realRoot = realpathSync(resolve(codeRoot));
		realDir = realpathSync(resolve(dir));
	} catch (err) {
		throw new PathConfinementError(
			`Cannot resolve scan target or code root (fail-closed): ${(err as Error).message}`,
			dir,
			codeRoot
		);
	}

	// Case-insensitive prefix compare on Windows; the path separator boundary
	// prevents `F:\code-other` from matching root `F:\code`.
	const rootWithSep = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
	const cmpDir = process.platform === 'win32' ? realDir.toLowerCase() : realDir;
	const cmpRoot = process.platform === 'win32' ? rootWithSep.toLowerCase() : rootWithSep;
	const cmpRootExact = process.platform === 'win32' ? realRoot.toLowerCase() : realRoot;

	if (cmpDir !== cmpRootExact && !cmpDir.startsWith(cmpRoot)) {
		throw new PathConfinementError(
			`Scan target ${realDir} is not under code root ${realRoot} (D-018, fail-closed).`,
			dir,
			codeRoot
		);
	}
	return realDir;
}

/**
 * Build the `project` content object from a detection + resolved path. Absent
 * optional fields are OMITTED, never set to null: SurrealDB's `option<string>`
 * rejects an explicit NULL ("Found NULL ... expected option<string>" —
 * MEMORY-SPEC §6.1). Omitting leaves the field unset (NONE).
 */
function toProjectContent(det: Detection, rootPath: string, repoUrl?: string) {
	return {
		slug: det.slug,
		name: det.name,
		root_path: rootPath,
		ecosystem: det.ecosystem,
		...(det.buildTool ? { build_tool: det.buildTool } : {}),
		...(det.testCommand ? { test_command: det.testCommand } : {}),
		...(repoUrl ? { repo_url: repoUrl } : {}),
		status: 'active',
		updated_at: new Date()
	};
}

export interface ScanOptions {
	/** Confinement root (CODE_ROOT). Targets must resolve under this. */
	codeRoot: string;
	/**
	 * The platform's own self-host worktree (D-040) to EXEMPT from D-024 guardrail seeding —
	 * defaults to process.cwd() (the dir the server booted from). Seeding a self-clamping
	 * .claude/settings.json into the control-plane repo Atelier runs from is the CCH-2 red-team
	 * defect this guards. Injectable for tests.
	 */
	selfRoot?: string;
}

/**
 * Scan a real directory under CODE_ROOT and upsert its `project` row. Returns the
 * persisted row. Idempotent: re-scanning the same directory updates the existing
 * row (keyed by the detected slug → `project:<slug>`) rather than duplicating it.
 */
export async function scanProject(
	db: Db,
	dir: string,
	opts: ScanOptions
): Promise<ProjectRow> {
	const rootPath = confineToRoot(dir, opts.codeRoot);
	const det = detectEcosystem(rootPath);
	const repoUrl = readRepoUrl(rootPath);

	// The record id is project:<slug>; validate it through the D-016 chokepoint
	// before it can be interpolated into the UPSERT target.
	const recordId = assertRecordId(`project:${det.slug}`);
	const content = toProjectContent(det, rootPath, repoUrl);

	// UPSERT ... MERGE: on first write SCHEMAFULL DEFAULTs seed created_at (we never
	// send it, so its time::now() default fires); on a re-scan MERGE only touches the
	// keys we send, so created_at is preserved while updated_at/ecosystem refresh.
	// MERGE (not CONTENT) is deliberate — CONTENT would wipe created_at to its default
	// on every scan. This is the idempotent path (re-scan = update, not duplicate).
	const [rows] = await db.query<[ProjectRow[]]>(
		`UPSERT ${recordId} MERGE $content RETURN AFTER;`,
		{ content }
	);
	const row = rows[0];
	if (!row) {
		throw new Error(`UPSERT of ${recordId} returned no row.`);
	}

	// CCH-2 — seed the D-024 PRIMARY guardrail at REGISTRATION, BEFORE any agent can spawn into
	// this project: write `<root>/.claude/settings.json` carrying Claude Code's OWN permissions.deny
	// (the boundary Claude Code enforces LOCALLY — server-down; the runtime network gate is defense-
	// in-depth on top). scanProject is the SOLE upsert-from-detection funnel — the /projects scan
	// action AND Create-with-AI's executeCreation both reach here — so this single hook covers every
	// registration path. `rootPath` was just realpath-confined (it EXISTS), so no phantom-dir risk.
	// Idempotent + merge-preserving (a hand-edited settings.json is never clobbered). BEST-EFFORT
	// (F-014): an unwritable root logs a named warning and the scan STILL succeeds — the boot
	// reconcile (guardrail-reconcile.ts) and the runtime network gate remain as backstops.
	//
	// SELF-HOST EXEMPTION (CCH-2 red-team fix): if the scanned root IS the platform's own worktree
	// (D-040 self-host root, or an ancestor containing it), do NOT seed the guardrail — writing a
	// self-clamping .claude/settings.json into the control-plane repo Atelier runs from would deny
	// the platform's own documented ops (git push / .claude reads / --force) and self-re-inject.
	if (isPlatformSelfRoot(rootPath, opts.selfRoot)) {
		console.warn(
			`[scan] EXEMPT ${recordId} — root is the platform's own self-host worktree (${rootPath}); ` +
				`not seeding a self-clamping .claude/settings.json into the control-plane repo (D-040/CCH-2).`
		);
		return normalizeRow(row);
	}
	try {
		writeProjectGuardrails({ projectRoot: rootPath, codeRoot: opts.codeRoot });
	} catch (err) {
		console.warn(
			`[scan] could not seed permissions.deny guardrail for ${recordId} at ${rootPath} ` +
				`(best-effort; boot reconcile + runtime gate still apply): ${(err as Error).message}`
		);
	}

	return normalizeRow(row);
}

/** Coerce the SDK's RecordId/Date shapes into plain JSON for callers + tests. */
function normalizeRow(row: ProjectRow & { id: unknown }): ProjectRow {
	return {
		...row,
		id: String(row.id),
		build_tool: row.build_tool ?? undefined,
		test_command: row.test_command ?? undefined,
		repo_url: row.repo_url ?? undefined
	};
}

export { slugify };
