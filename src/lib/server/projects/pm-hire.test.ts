import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject, updateProjectPlan } from './repo';
import { createTask } from '../tasks/repo';
import { getPm, listPmMemory } from './pm-repo';
import { hirePm, hireInterviewFor, HIRE_QUESTIONS } from './pm-hire';

// TASK 16.1 VERIFY (D-038) — the HIRE flow against a REAL throwaway SurrealDB:
// the pm row is created with the operator-written charter, founding memories are
// REAL rows (scan + history digest + interview in the operator's words), skips are
// recorded as honest gaps (F-008), smart-skip quotes plan evidence verbatim, and a
// re-run absorbs prior partial work instead of duplicating (interrupt contract).

let tdb: TestDb;
let db: Db;

beforeAll(async () => {
	tdb = await startTestDb();
	db = await Db.connect({
		url: tdb.wsUrl,
		username: tdb.root.username,
		password: tdb.root.password,
		namespace: tdb.namespace,
		database: tdb.database
	});
	const applied = await runMigrations(db, schemaMigrations);
	expect(applied).toContain('0029_pm_identity');
}, 90_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

async function freshProject(slug: string) {
	return createProject(db, {
		slug,
		name: `Hire ${slug}`,
		root_path: 'F:/code/hiretest',
		ecosystem: ['node'],
		test_command: 'npm test',
		repo_url: 'https://github.com/x/y'
	});
}

describe('hireInterviewFor — smart-skip (server-authoritative, conservative)', () => {
	it('asks all six when the plan macro is empty (nothing pre-answered)', () => {
		const qs = hireInterviewFor({});
		expect(qs).toHaveLength(6);
		expect(qs.every((q) => q.preAnswered === null)).toBe(true);
		expect(qs.map((q) => q.id)).toEqual(HIRE_QUESTIONS.map((q) => q.id));
	});

	it('pre-answers narrowest_wedge/future_fit from the plan, quoting evidence verbatim', () => {
		const qs = hireInterviewFor({
			plan: {
				definition_of_done: 'one mod published to Thunderstore',
				long_term_vision: 'the standard ROUNDS modding toolkit'
			}
		});
		const wedge = qs.find((q) => q.id === 'narrowest_wedge');
		expect(wedge?.preAnswered).toEqual({
			source: 'plan.definition_of_done',
			evidence: 'one mod published to Thunderstore'
		});
		const fit = qs.find((q) => q.id === 'future_fit');
		expect(fit?.preAnswered?.source).toBe('plan.long_term_vision');
		// Demand/observation can NEVER be evidenced by a scan — always asked (F-008).
		expect(qs.find((q) => q.id === 'demand_reality')?.preAnswered).toBeNull();
		expect(qs.find((q) => q.id === 'observation')?.preAnswered).toBeNull();
	});
});

describe('hirePm — the full hire against the real DB', () => {
	it('creates the pm row (charter persisted) + founding memories: scan, digest, interview', async () => {
		const p = await freshProject('hire_full');
		await updateProjectPlan(db, p.id, {
			purpose: 'Manage ROUNDS mods',
			definition_of_done: 'one mod shipped'
		});
		await createTask(db, { project: p.id, title: 'Seed task', description: 'x' });

		const res = await hirePm(db, {
			project: p.id,
			name: 'Vesper',
			charter: 'Priorities: ship weekly. Escalate releases.',
			persona: 'terse',
			answers: [
				{ id: 'demand_reality', answer: 'Three Discord users ask for it weekly.', push: 'The thread would die if it vanished.' },
				{ id: 'status_quo', answer: 'Manual BepInEx edits, ~2h per change.' },
				{ id: 'specificity', skipped: true },
				{ id: 'observation', skipped: true }
				// narrowest_wedge + future_fit: narrowest_wedge pre-answered by the plan;
				// future_fit unanswered AND not pre-answered ⇒ recorded as a gap.
			]
		});

		expect(res.hired).toBe(true);
		expect(res.alreadyHired).toBe(false);
		expect(res.pm.name).toBe('Vesper');
		expect(res.pm.charter).toBe('Priorities: ship weekly. Escalate releases.');
		expect(res.pm.authority).toBe('act');

		// The pm row is really there (read back from the live DB).
		const read = await getPm(db, p.id);
		expect(read?.charter).toContain('ship weekly');

		const memories = await listPmMemory(db, p.id, { limit: 100 });
		const contents = memories.map((m) => m.content).join('\n---\n');

		// Founding scan (bootstrapPm): the real detected stack + the stated purpose.
		expect(contents).toContain('node');
		expect(contents).toContain('Manage ROUNDS mods');
		// History digest from LIVE rows: the real task count, honest zeros elsewhere.
		expect(contents).toMatch(/Hired with history: 1 task\(s\)/);
		// Interview answers, in the operator's words (+ the push-once follow-up).
		expect(contents).toContain('Three Discord users ask for it weekly.');
		expect(contents).toContain('Pushed once: The thread would die if it vanished.');
		expect(contents).toContain('Manual BepInEx edits');
		// Smart-skip: the plan evidence quoted verbatim.
		expect(contents).toContain('pre-answered by the project scan (plan.definition_of_done): "one mod shipped"');
		// Honest gaps: skipped + never-asked-but-unanswered questions.
		expect(contents).toContain('Unanswered at hire — Specificity');
		expect(contents).toContain('Unanswered at hire — Observation');
		expect(contents).toContain('Unanswered at hire — Future-fit');
		// Six interview rows total — one per question, no more, no less.
		const interview = memories.filter((m) => m.source === 'hire-interview');
		expect(interview).toHaveLength(6);
	});

	it('hires on a clean slate with an honest no-history digest (no fabricated counts)', async () => {
		const p = await freshProject('hire_clean');
		const res = await hirePm(db, { project: p.id, name: 'Quill', answers: [] });
		expect(res.hired).toBe(true);
		const contents = res.foundingMemories.map((m) => m.content).join('\n');
		expect(contents).toContain('Hired on a clean slate');
		expect(contents).not.toMatch(/Hired with history/);
		// No charter written in the flow → none persisted (absent, not "").
		expect(res.pm.charter).toBeUndefined();
	});

	it('is idempotent: a re-run absorbs the existing pm row and writes NO duplicates', async () => {
		const p = await freshProject('hire_rerun');
		const first = await hirePm(db, {
			project: p.id,
			name: 'Vesper',
			answers: [{ id: 'demand_reality', answer: 'real demand' }]
		});
		const countAfterFirst = (await listPmMemory(db, p.id, { limit: 100 })).length;
		expect(first.hired).toBe(true);

		const again = await hirePm(db, {
			project: p.id,
			name: 'Someone Else', // ignored — the existing identity wins (absorb, not overwrite)
			answers: [{ id: 'demand_reality', answer: 'different words' }]
		});
		expect(again.hired).toBe(false);
		expect(again.alreadyHired).toBe(true);
		expect(again.pm.name).toBe('Vesper');
		expect(again.foundingMemories).toHaveLength(0);
		expect((await listPmMemory(db, p.id, { limit: 100 })).length).toBe(countAfterFirst);
	});

	it('completes MISSING interview memories on re-run after a simulated mid-hire death', async () => {
		const p = await freshProject('hire_partial');
		// Simulate the interrupt: the pm row exists (step 1 landed) but the run died
		// before any founding memory was written.
		const { createPm } = await import('./pm-repo');
		await createPm(db, { project: p.id, name: 'Vesper' });

		const res = await hirePm(db, {
			project: p.id,
			name: 'Vesper',
			answers: [{ id: 'demand_reality', answer: 'recovered answer' }]
		});
		expect(res.alreadyHired).toBe(true);
		// The re-run completed the missing founding work: scan + digest + interview rows.
		const memories = await listPmMemory(db, p.id, { limit: 100 });
		expect(memories.some((m) => m.content.includes('recovered answer'))).toBe(true);
		expect(memories.some((m) => m.source === 'hire-scan')).toBe(true);
	});

	it('rejects an unknown question id and a missing name (named boundary errors)', async () => {
		const p = await freshProject('hire_bad');
		await expect(
			hirePm(db, {
				project: p.id,
				name: 'X',
				answers: [{ id: 'favorite_color' as never, answer: 'blue' }]
			})
		).rejects.toThrow(/unknown interview question id "favorite_color"/);
		await expect(hirePm(db, { project: p.id, name: '   ', answers: [] })).rejects.toThrow(
			/name is required/
		);
		await expect(
			hirePm(db, { project: 'project:does_not_exist', name: 'X', answers: [] })
		).rejects.toThrow(/project not found/);
	});
});
