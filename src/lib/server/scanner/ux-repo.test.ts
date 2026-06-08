import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { StringRecordId } from 'surrealdb';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject, deleteProject } from '../projects/repo';
import { listFindings } from './findings-repo';
import {
	inspectProjectUx,
	runUxInspection,
	archiveActiveUxFindings
} from './ux-repo';
import type { UxInspectionSource } from './ux-inspect';

// TASK 3.3 VERIFY (integration) — an OPT-IN UX inspection run records UX findings as
// security_finding rows in a LIVE throwaway SurrealDB WITHOUT blocking the active session.
// The inspector input (what a real browser/Playwright run would produce) is MOCKED per the
// no-live-externals standing rule; the live-browser run is a deferredLiveProof. F-008:
// every persisted row is a real check of a real (mocked) inspector snapshot — nothing faked.

let tdb: TestDb;
let db: Db;
let projectId: string;

// A deterministic, fully-mocked inspector source (stands in for a real browser run). Two
// routes, each with a planted UX issue.
const mockSource: UxInspectionSource = {
	inspect: () => [
		{ route: '/dash', title: '', images: [], landmarks: ['main'], buttons: [], contrastIssues: 0 },
		{
			route: '/gallery',
			title: 'Gallery',
			images: [{ src: '/a.png', alt: '' }],
			landmarks: ['main'],
			buttons: [{ label: 'Open' }],
			contrastIssues: 0
		}
	]
};

const cleanSource: UxInspectionSource = {
	inspect: () => [
		{
			route: '/ok',
			title: 'OK',
			images: [{ src: '/x', alt: 'fine' }],
			landmarks: ['main'],
			buttons: [{ label: 'Go' }],
			contrastIssues: 0
		}
	]
};

beforeAll(async () => {
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
		slug: 'ux_app',
		name: 'UX App',
		root_path: 'F:/code/ux_app'
	});
	projectId = p.id;
}, 60_000);

afterAll(async () => {
	if (projectId) await deleteProject(db, projectId).catch(() => {});
	await db?.close();
	await tdb?.teardown();
});

describe('§3.3 inspectProjectUx — opt-in, non-blocking, live persistence', () => {
	it('is a NO-OP when not opted in (disabled by default)', async () => {
		const handle = inspectProjectUx(db, projectId, { enabled: false, source: mockSource });
		expect(handle.started).toBe(false);
		await expect(handle.done).resolves.toEqual([]);
		// Nothing was written.
		const rows = await listFindings(db, projectId);
		expect(rows.length).toBe(0);
	});

	it('returns SYNCHRONOUSLY without blocking — the session is never stalled', async () => {
		// A source whose inspect() does real work; the entry must still return immediately
		// (the work is detached). We assert the call returns BEFORE the work has persisted.
		let inspectCalled = false;
		const slowSource: UxInspectionSource = {
			inspect: () => {
				inspectCalled = true;
				return mockSource.inspect();
			}
		};
		const handle = inspectProjectUx(db, projectId, { enabled: true, source: slowSource });
		expect(handle.started).toBe(true);
		// inspect() runs inside the detached job (a microtask), not synchronously here.
		expect(inspectCalled).toBe(false);
		// Awaiting the handle (only when we WANT completion) drains the background job.
		const written = await handle.done;
		expect(inspectCalled).toBe(true);
		expect(written.length).toBeGreaterThanOrEqual(2); // missing-title + image-missing-alt
	});

	it('records UX findings as security_finding rows under the ux.* rule family', async () => {
		await archiveActiveUxFindings(db, projectId, 'reset'); // clean slate
		const handle = inspectProjectUx(db, projectId, { enabled: true, source: mockSource });
		const written = await handle.done;
		for (const f of written) {
			expect(f.project).toBe(projectId);
			expect(f.status).toBe('active');
			expect(f.rule.startsWith('ux.')).toBe(true);
			expect(f.id.startsWith('security_finding:')).toBe(true);
		}
		const live = await listFindings(db, projectId);
		const rules = live.map((r) => r.rule);
		expect(rules).toContain('ux.missing-title');
		expect(rules).toContain('ux.image-missing-alt');
		// The route is preserved in the `file` column.
		const titleFinding = live.find((r) => r.rule === 'ux.missing-title')!;
		expect(titleFinding.file).toBe('/dash');
	});

	it('re-inspecting soft-archives stale ux findings (D-015) — live set replaced, not doubled', async () => {
		// Establish a known live set first so the assertion is self-contained (prior tests
		// may have left a different number of un-archived active rows).
		await runUxInspection(db, projectId, mockSource);
		const before = await listFindings(db, projectId);
		await runUxInspection(db, projectId, mockSource);
		const after = await listFindings(db, projectId);
		expect(after.length).toBe(before.length); // stable, not doubled
		// Archived rows survive (never DELETEd).
		const [allRows] = await db.query<[unknown[]]>(
			`SELECT * FROM security_finding WHERE project = $p AND string::starts_with(rule, "ux.");`,
			{ p: new StringRecordId(projectId) }
		);
		expect(allRows.length).toBeGreaterThan(after.length);
	});

	it('a clean inspection clears the live ux set without touching history', async () => {
		await runUxInspection(db, projectId, cleanSource); // no issues found
		const live = await listFindings(db, projectId);
		expect(live.filter((r) => r.rule.startsWith('ux.')).length).toBe(0);
	});
});
