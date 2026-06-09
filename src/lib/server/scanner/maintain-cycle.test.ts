import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject, deleteProject } from '../projects/repo';
import { listFindings } from './findings-repo';
import {
	runProjectUxInspection,
	uxInspectionAllowed,
	readOrchestrationMode
} from './maintain-cycle';
import { PathConfinementError } from './registry';

// TASK 11.5 VERIFY (integration) — the maintain-cycle UX inspection runs the STATIC source over
// a real project's own UI source and persists ux.* findings to a LIVE throwaway SurrealDB. The
// project dir is a real temp SvelteKit-shaped tree path-confined under a code root. F-008: every
// persisted row is a real read of a real route file — nothing fabricated. D-004: the mode gate
// is asserted as a pure policy at the boundary.

let tdb: TestDb;
let db: Db;
let projectId: string;
let codeRoot: string;
let projDir: string;

beforeAll(async () => {
	// A real project tree: <codeRoot>/uxproj/src/routes/{,broken}/+page.svelte. realpath both so
	// the D-018 confinement compare (which realpaths) is symlink-stable on macOS/Windows tmpdirs.
	codeRoot = realpathSync(mkdtempSync(join(tmpdir(), 'v2-maintain-root-')));
	projDir = join(codeRoot, 'uxproj');
	const routes = join(projDir, 'src', 'routes');
	mkdirSync(routes, { recursive: true });
	writeFileSync(
		join(routes, '+page.svelte'),
		`<svelte:head><title>OK</title></svelte:head><main><img src="/a.png" alt="a" /><button>Go</button></main>`
	);
	const broken = join(routes, 'broken');
	mkdirSync(broken, { recursive: true });
	writeFileSync(join(broken, '+page.svelte'), `<section><img src="/x.png" /><button><svg /></button></section>`);

	tdb = await startTestDb();
	db = await Db.connect({
		url: tdb.wsUrl,
		username: tdb.root.username,
		password: tdb.root.password,
		namespace: tdb.namespace,
		database: tdb.database
	});
	await runMigrations(db, schemaMigrations);
	const p = await createProject(db, {
		slug: 'uxproj',
		name: 'UX Proj',
		root_path: projDir
	});
	projectId = p.id;
}, 60_000);

afterAll(async () => {
	if (projectId) await deleteProject(db, projectId).catch(() => {});
	await db?.close();
	await tdb?.teardown();
	rmSync(codeRoot, { recursive: true, force: true });
});

describe('§11.5 uxInspectionAllowed — D-004 mode gate (pure policy)', () => {
	it('always allows a manual trigger, in any mode', () => {
		expect(uxInspectionAllowed('manual', 'manual')).toBe(true);
		expect(uxInspectionAllowed('manual', 'periodic')).toBe(true);
		expect(uxInspectionAllowed('manual', 'event')).toBe(true);
	});
	it('blocks a periodic/event trigger ONLY in manual mode', () => {
		expect(uxInspectionAllowed('periodic', 'manual')).toBe(false);
		expect(uxInspectionAllowed('periodic', 'periodic')).toBe(true);
		expect(uxInspectionAllowed('event', 'manual')).toBe(false);
		expect(uxInspectionAllowed('event', 'event')).toBe(true);
	});
});

describe('§11.5 readOrchestrationMode — honest fallback', () => {
	it('falls back to the conservative "manual" on a missing/bad config', () => {
		expect(readOrchestrationMode(join(codeRoot, 'no-such-orchestration.yaml'))).toBe('manual');
	});
});

describe('§11.5 runProjectUxInspection — static inspect over the project UI, live persistence', () => {
	it('rejects a dir outside the code root (D-018, fail-closed)', async () => {
		await expect(
			runProjectUxInspection(db, projectId, '/etc', { codeRoot })
		).rejects.toBeInstanceOf(PathConfinementError);
	});

	it('writes ux.* findings for the project from its own route source (F-008)', async () => {
		const written = await runProjectUxInspection(db, projectId, projDir, { codeRoot });
		expect(written.length).toBeGreaterThan(0);
		for (const f of written) {
			expect(f.project).toBe(projectId);
			expect(f.status).toBe('active');
			expect(f.rule.startsWith('ux.')).toBe(true);
		}
		const live = await listFindings(db, projectId);
		const rules = live.map((r) => r.rule);
		// The /broken route has all four issues; the clean / route has none.
		expect(rules).toContain('ux.missing-title');
		expect(rules).toContain('ux.image-missing-alt');
		expect(rules).toContain('ux.unlabeled-control');
		expect(rules).toContain('ux.missing-landmark');
		const titleFinding = live.find((r) => r.rule === 'ux.missing-title')!;
		expect(titleFinding.file).toBe('/broken'); // route rides in the `file` column
	});

	it('is idempotent — re-inspecting replaces the live ux set, never doubles it (D-015)', async () => {
		const before = await listFindings(db, projectId);
		await runProjectUxInspection(db, projectId, projDir, { codeRoot });
		const after = await listFindings(db, projectId);
		expect(after.length).toBe(before.length);
	});
});
