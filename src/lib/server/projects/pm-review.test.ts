import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject } from './repo';
import { createTask, setStatus } from '../tasks/repo';
import { writeFindings } from '../scanner/findings-repo';
import { runPmReview } from './pm-review';
import { listPmMemory, listPmReviews, bootstrapPm } from './pm-repo';

// TASK 11.4 VERIFY (D-038) — the PM review pass runs against a REAL throwaway SurrealDB:
// real tasks, real findings, the real pm_memory + pm_review tables. Every assertion checks an
// HONEST derivation (F-008) — a risk memory only when a real blocked task / severe finding
// exists; the snapshot observation always present.

let tdb: TestDb;
let db: Db;
let projectId: string;

const CWD = 'F:/code/pmrevtest';

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
}, 90_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

beforeEach(async () => {
	await db
		.query('DELETE pm_review; DELETE pm_memory; DELETE security_finding; DELETE task; DELETE project;')
		.catch(() => {});
	const p = await createProject(db, {
		slug: 'pmrevtest',
		name: 'PM Review Host',
		root_path: CWD,
		repo_url: 'https://github.com/octo/pmrevtest'
	});
	projectId = p.id;
});

describe('runPmReview', () => {
	it('writes a snapshot observation + a pm_review row for a healthy project (no fabricated risk)', async () => {
		await createTask(db, { project: projectId, title: 'A done task', description: '' });
		const res = await runPmReview(db, projectId, 'manual');

		expect(res.review.trigger).toBe('manual');
		expect(res.review.tasks_examined).toBe(1);
		// At least the snapshot observation is written — and NO risk for a clean project.
		expect(res.written.length).toBeGreaterThanOrEqual(1);
		expect(res.written.every((m) => m.kind !== 'risk')).toBe(true);

		// created_at is an ISO string (F-013 — datetime coerced in the normalizer).
		expect(typeof res.review.created_at).toBe('string');
		expect(Number.isNaN(new Date(res.review.created_at).getTime())).toBe(false);

		const reviews = await listPmReviews(db, projectId);
		expect(reviews).toHaveLength(1);
		expect(reviews[0].id).toBe(res.review.id);
	});

	it('derives a RISK memory from a real blocked task', async () => {
		const t = await createTask(db, {
			project: projectId,
			title: 'Stuck',
			description: '',
			status: 'ready'
		});
		await setStatus(db, t.id, 'in_progress');
		await setStatus(db, t.id, 'blocked');

		const res = await runPmReview(db, projectId, 'manual');
		const risks = res.written.filter((m) => m.kind === 'risk');
		expect(risks.length).toBeGreaterThanOrEqual(1);
		expect(risks.some((r) => /BLOCKED/i.test(r.content))).toBe(true);
		expect(res.review.memories_written).toBe(res.written.length);
	});

	it('derives a RISK memory from a real critical security finding', async () => {
		await createTask(db, { project: projectId, title: 'T', description: '' });
		await writeFindings(db, projectId, [
			{
				rule: 'hardcoded-secret',
				severity: 'critical',
				file: 'src/x.ts',
				line: 3,
				detail: 'token in src/x.ts'
			}
		]);

		const res = await runPmReview(db, projectId, 'manual');
		expect(res.review.findings_examined).toBe(1);
		const risks = res.written.filter((m) => m.kind === 'risk');
		expect(risks.some((r) => /finding/i.test(r.content))).toBe(true);
	});

	it('persists every written memory to pm_memory (read back through the load path)', async () => {
		await bootstrapPm(db, projectId);
		const before = (await listPmMemory(db, projectId)).length;
		const res = await runPmReview(db, projectId, 'periodic');
		const after = (await listPmMemory(db, projectId)).length;
		expect(after - before).toBe(res.written.length);
		// The review records the trigger it was given (D-004 — engine is mode-agnostic).
		expect(res.review.trigger).toBe('periodic');
	});

	it('throws honestly for an unknown project', async () => {
		await expect(runPmReview(db, 'project:nope', 'manual')).rejects.toThrow(/not found/i);
	});
});
