/**
 * TASK BOARD LOADER + ACTIONS — against a REAL migrated SurrealDB (F-020: a `stubDb()` does not
 * parse SurrealQL and would pass green over a broken query).
 *
 * The board is the first surface to render the §4.1 fields that have been stored since TASK 16.4,
 * so what is under test is the WHOLE round trip, not the repo functions it composes:
 *
 *   (a) THE SET CASE (F-013's lesson — never test only the NONE case). A task written with every
 *       optional field SET comes back with all of them, ISO datetimes, and `provenance.detail`
 *       flattened to printable pairs.
 *   (b) THE NONE CASE. A bare task comes back with those keys ABSENT — not `''`, not `[]` pretending
 *       to be a considered-and-empty answer, and never the literal string "undefined".
 *   (c) POJOs ONLY. `devalue.stringify` (SvelteKit's load serializer) round-trips the payload; it
 *       THROWS on a raw SDK Datetime/RecordId, which is the devalue-500 class.
 *   (d) SCOPING. Another project's task never appears on this board, and no action will write to one.
 *   (e) THE WRITES. moveTask goes through the state machine (an illegal move is a NAMED 400, not a
 *       write); retagTask lands normalized tags and refuses an over-long one by name; setPriority
 *       validates against the stored enum. `description` has no write path at all (D-008).
 *
 * If the SurrealDB binary can't start — or a concurrent sibling suite already holds the runtime
 * singleton — the suite SKIPS honestly rather than faking an artifact.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as devalue from 'devalue';
import { Db, initDb, closeDb } from '$lib/server/db/client';
import { runMigrations } from '$lib/server/db/migrate';
import { schemaMigrations } from '$lib/server/db/schema';
import { startTestDb, type TestDb } from '$lib/server/db/testserver';
import { createProject, createSprint } from '$lib/server/projects/repo';
import { createPm } from '$lib/server/projects/pm-repo';
import { createTask, getTask, setStatus } from '$lib/server/tasks/repo';
import { load, actions, type TaskBoardData } from './+page.server';
import { contextCompleteness, resolveBoard, DEFAULT_BOARD_VIEW } from './task-board-view';

let tdb: TestDb | undefined;
let db: Db | undefined;
let available = false;
/** True ONLY when THIS suite created the process-wide runtime singleton (never tear down a sibling's). */
let ownsSingleton = false;

let richId = '';
let bareId = '';
let foreignId = '';
/** A REAL hired pm row + the two tasks that exercise the `proposed_by` → name join. */
let pmId = '';
let pmTaskId = '';
let ghostTaskId = '';

beforeAll(async () => {
	try {
		tdb = await startTestDb();
		const boot = await Db.connect({
			url: tdb.wsUrl,
			username: tdb.root.username,
			password: tdb.root.password,
			namespace: tdb.namespace,
			database: tdb.database
		});
		await runMigrations(boot, schemaMigrations);
		await boot.close();
		db = await initDb({
			url: tdb.wsUrl,
			username: tdb.root.username,
			password: tdb.root.password,
			namespace: tdb.namespace,
			database: tdb.database
		});
		ownsSingleton = true;
		available = true;
	} catch {
		available = false;
		return;
	}

	const board = await createProject(db!, { slug: 'boarda', name: 'Board A', root_path: '/tmp/boarda' });
	const other = await createProject(db!, { slug: 'boardb', name: 'Board B', root_path: '/tmp/boardb' });
	await createProject(db!, { slug: 'boardempty', name: 'Board Empty', root_path: '/tmp/boarde' });

	// (a) THE SET CASE — every optional column populated, including a provenance carrying evidence
	//     AND a nested detail object (the shape that can hide a devalue-hostile value).
	const rich = await createTask(db!, {
		project: board.id,
		title: 'Migrate the ledger',
		description: 'Move the ledger onto the new table.',
		priority: 'high',
		origin: 'pm',
		status: 'proposed',
		objective: 'Move the ledger onto the m0087 table.',
		purpose: 'The old table cannot express per-subsystem skips.',
		acceptance_criteria: ['db:up runs clean twice', 'no ORDER BY field outside the SELECT'],
		provenance: {
			kind: 'pm_lifecycle',
			evidence: ['pm_memory:abc', 'pm_review:def'],
			authority: 'panel',
			detail: { trigger: 'drift', count: 3, deep: { nested: true } }
		},
		proposal_fingerprint: 'fp_abcdef0123456789',
		tags: ['db', 'careful']
	});
	richId = rich.id;

	// (b) THE NONE CASE — nothing optional set at all.
	const bare = await createTask(db!, {
		project: board.id,
		title: 'Fix the drain',
		description: 'Fix the drain'
	});
	bareId = bare.id;

	// (d) A task on ANOTHER project — must never appear, must never be writable from this board.
	const foreign = await createTask(db!, {
		project: other.id,
		title: 'Not yours',
		description: 'Not yours'
	});
	foreignId = foreign.id;

	// A real sprint row, so the board's sprint counts are measured rather than assumed.
	await createSprint(db!, { project: board.id, name: 'Sprint 1' });

	// …and a project whose sprints ARE time-boxed. `sprintReality.timeBoxed` is an operator-facing
	// claim on the page ("N sprint rows, M of them time-boxed") whose true branch had ZERO coverage:
	// every assertion in the repo pinned it to 0 because the only fixture sprint carried no dates.
	// That is CLAUDE.md §4's named F-013 pattern applied to a COUNT — "unit tests where the field is
	// NONE won't catch it; assert on a row where it's SET". Three rows so both halves of the
	// `!!starts || !!ends` predicate get their own row and one row still lands on the false branch.
	const boxed = await createProject(db!, {
		slug: 'boardsprints',
		name: 'Board Sprints',
		root_path: '/tmp/boardsprints'
	});
	await createSprint(db!, {
		project: boxed.id,
		name: 'Starts only',
		starts: new Date('2026-08-01T00:00:00.000Z')
	});
	await createSprint(db!, {
		project: boxed.id,
		name: 'Ends only',
		ends: new Date('2026-08-31T00:00:00.000Z')
	});
	await createSprint(db!, { project: boxed.id, name: 'Undated' });

	// A project with a REAL hired PM — the `proposed_by` → name join is a real FK read, so it gets a
	// real pm row rather than a stubbed map. It lives on its OWN project because `pm` is UNIQUE per
	// project and the other boards deliberately have none.
	const pmBoard = await createProject(db!, {
		slug: 'boardpm',
		name: 'Board PM',
		root_path: '/tmp/boardpm'
	});
	const pm = await createPm(db!, { project: pmBoard.id, name: 'Vesper', authority: 'act' });
	pmId = pm.id;
	pmTaskId = (
		await createTask(db!, {
			project: pmBoard.id,
			title: 'Proposed by a named PM',
			description: 'Proposed by a named PM',
			origin: 'pm',
			status: 'proposed',
			proposed_by: pm.id
		})
	).id;
	// …and one whose proposer cannot be resolved at all: the honest "(unnamed)" case.
	ghostTaskId = (
		await createTask(db!, {
			project: pmBoard.id,
			title: 'Proposed by nobody resolvable',
			description: 'Proposed by nobody resolvable',
			origin: 'pm',
			status: 'proposed',
			proposed_by: 'pm:ghost0000000000000'
		})
	).id;
}, 120_000);

afterAll(async () => {
	if (ownsSingleton) await closeDb().catch(() => {});
	await tdb?.teardown();
});

/** Invoke the REAL loader exactly as SvelteKit would. */
async function runLoad(slug: string): Promise<TaskBoardData> {
	return (await load({
		params: { id: slug },
		depends: () => {},
		url: new URL(`http://localhost/projects/${slug}/tasks`)
	} as unknown as Parameters<typeof load>[0])) as TaskBoardData;
}

function fd(fields: Record<string, string>): FormData {
	const f = new FormData();
	for (const [k, v] of Object.entries(fields)) f.append(k, v);
	return f;
}

/** Invoke one of the REAL form actions. */
async function runAction(
	name: keyof typeof actions,
	slug: string,
	fields: Record<string, string>
): Promise<{ status?: number; data?: Record<string, unknown> } & Record<string, unknown>> {
	const fn = actions[name] as (e: unknown) => Promise<Record<string, unknown>>;
	return (await fn({
		params: { id: slug },
		request: { formData: async () => fd(fields) }
	})) as { status?: number; data?: Record<string, unknown> } & Record<string, unknown>;
}

/** The `{ board: … }` envelope, whether it came back as a success or a `fail()`. */
function envelope(r: Record<string, unknown>): Record<string, unknown> {
	const inner = (r.data ?? r) as Record<string, unknown>;
	return (inner.board ?? {}) as Record<string, unknown>;
}

describe.runIf(!process.env.SKIP_LIVE)('task board loader — real SurrealDB', () => {
	it('loads this project only, honestly connected', async () => {
		if (!available) return;
		const data = await runLoad('boarda');
		expect(data.connected).toBe(true);
		expect(data.projectName).toBe('Board A');
		expect(data.slug).toBe('boarda');
		const ids = data.tasks.map((t) => t.id);
		expect(ids).toContain(richId);
		expect(ids).toContain(bareId);
		// (d) SCOPING — the other project's task is not on this board.
		expect(ids).not.toContain(foreignId);
	});

	it('(a) THE SET CASE — every stored §4.1 field round-trips onto the wire shape', async () => {
		if (!available) return;
		const data = await runLoad('boarda');
		const t = data.tasks.find((r) => r.id === richId)!;
		expect(t.objective).toBe('Move the ledger onto the m0087 table.');
		expect(t.purpose).toBe('The old table cannot express per-subsystem skips.');
		expect(t.acceptanceCriteria).toEqual([
			'db:up runs clean twice',
			'no ORDER BY field outside the SELECT'
		]);
		expect(t.tags).toEqual(['db', 'careful']);
		expect(t.priority).toBe('high');
		expect(t.origin).toBe('pm');
		expect(t.status).toBe('proposed');
		expect(t.provenanceKind).toBe('pm_lifecycle');
		// REGRESSION: `authority` was WRITTEN by this fixture and asserted by nothing, which is exactly
		// how the projection came to drop it. It is stamped on every real PM proposal
		// (pm-proposals.ts), so the panel's completeness contract requires it on the wire.
		expect(t.provenanceAuthority).toBe('panel');
		expect(t.provenanceEvidence).toEqual(['pm_memory:abc', 'pm_review:def']);
		// The free-form detail object is FLATTENED to printable pairs — nothing SDK-shaped survives.
		const detail = Object.fromEntries(t.provenanceDetail.map((d) => [d.key, d.value]));
		expect(detail.trigger).toBe('drift');
		expect(detail.count).toBe('3');
		expect(detail.deep).toBe('{"nested":true}');
		expect(t.proposalFingerprint).toBe('fp_abcdef0123456789');
		// F-013: both datetimes are real ISO strings, not `str(SDK Datetime)`.
		expect(t.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
		expect(t.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
		// The move targets come from the state machine: `proposed` may only go ready | withdrawn.
		expect([...t.moves].sort()).toEqual(['ready', 'withdrawn']);
		// The completeness chip reads 3/3 off a REAL row, not a fixture.
		expect(contextCompleteness(t).have).toBe(3);
	});

	it('(b) THE NONE CASE — absent fields are ABSENT, never "" / "undefined" / a fake []', async () => {
		if (!available) return;
		const data = await runLoad('boarda');
		const t = data.tasks.find((r) => r.id === bareId)!;
		expect(t).not.toHaveProperty('objective');
		expect(t).not.toHaveProperty('purpose');
		expect(t).not.toHaveProperty('provenanceKind');
		expect(t).not.toHaveProperty('proposedBy');
		expect(t).not.toHaveProperty('revisionOf');
		expect(t).not.toHaveProperty('supersededBy');
		expect(t).not.toHaveProperty('proposalFingerprint');
		expect(t).not.toHaveProperty('parent');
		expect(t.acceptanceCriteria).toEqual([]);
		expect(t.tags).toEqual([]);
		expect(t.provenanceEvidence).toEqual([]);
		expect(t.provenanceDetail).toEqual([]);
		expect(t).not.toHaveProperty('provenanceAuthority');
		expect(t).not.toHaveProperty('proposedByName');
		// The F-013 literal must appear NOWHERE in the serialized row.
		expect(JSON.stringify(t)).not.toContain('undefined');
		expect(contextCompleteness(t).have).toBe(0);
	});

	// ── REGRESSION (the operator's naming rule, 2026-07-26) ───────────────────────────────────
	// `proposed_by` stores `pm.id`, an opaque auto-id. The panel used to print "8qzbfijl (unnamed)"
	// about a PM the SAME database names Vesper — a false claim about live data (F-008 family), and
	// exactly the degrading-fallback defect class the rule targets. The name is ONE FK away, so the
	// loader joins it. This runs against a REAL pm row, because the join is the thing under test.
	it("resolves the PROPOSER'S NAME off the real pm row — never '(unnamed)' for a named PM", async () => {
		if (!available) return;
		const data = await runLoad('boardpm');
		const t = data.tasks.find((r) => r.id === pmTaskId)!;
		expect(t.proposedBy).toBe(pmId);
		expect(t.proposedByName).toBe('Vesper');
		// And it survives the load serializer like every other wire field.
		expect(() => devalue.stringify(data)).not.toThrow();
	});

	it('leaves the proposer name ABSENT when the id is not this project\'s PM — no invented name', async () => {
		if (!available) return;
		// Same board, a task whose proposed_by points at a pm record that does not exist. "unnamed" is
		// then TRUE, which is the only condition under which the panel may say it.
		const data = await runLoad('boardpm');
		const t = data.tasks.find((r) => r.id === ghostTaskId)!;
		expect(t.proposedBy).toBe('pm:ghost0000000000000');
		expect(t).not.toHaveProperty('proposedByName');
		expect(JSON.stringify(t)).not.toContain('undefined');
	});

	it('(c) POJOs ONLY — the whole payload survives devalue (the load-500 class)', async () => {
		if (!available) return;
		const data = await runLoad('boarda');
		expect(() => devalue.stringify(data)).not.toThrow();
		const round = devalue.parse(devalue.stringify(data)) as TaskBoardData;
		expect(round.tasks).toHaveLength(data.tasks.length);
	});

	it('counts describe the set actually shown — over REAL rows, not a fixture', async () => {
		if (!available) return;
		const data = await runLoad('boarda');
		const b = resolveBoard(data.tasks, { ...DEFAULT_BOARD_VIEW, tags: ['db'] }, data.taskStatuses);
		expect(b.visible.map((t) => t.id)).toEqual([richId]);
		expect(b.columns.reduce((n, c) => n + c.shown, 0)).toBe(b.visible.length);
		expect(b.summaryLine).toContain(`showing 1 of ${data.tasks.length} tasks`);
		expect(b.summaryLine).toContain(`${data.tasks.length - 1} hidden by filters`);
	});

	it('a project with no tasks is honestly empty — not an error, not a fabrication', async () => {
		if (!available) return;
		const data = await runLoad('boardempty');
		expect(data.connected).toBe(true);
		expect(data.tasks).toEqual([]);
		expect(data.sprintReality).toEqual({ total: 0, timeBoxed: 0, withTasks: 0 });
	});

	it('sprint reality is MEASURED: rows counted, none time-boxed, and never task-bearing', async () => {
		if (!available) return;
		const data = await runLoad('boarda');
		// The sprint the fixture created has no starts/ends — exactly the live shape §6.2 reports.
		expect(data.sprintReality.total).toBe(1);
		expect(data.sprintReality.timeBoxed).toBe(0);
		// `task` carries no sprint link at all, so this can only ever be 0.
		expect(data.sprintReality.withTasks).toBe(0);
	});

	it('timeBoxed counts a sprint dated on EITHER end — the true branch, over real rows', async () => {
		if (!available) return;
		const data = await runLoad('boardsprints');
		// Three real rows: `starts`-only, `ends`-only, and one with neither. The loader's predicate is
		// `!!s.starts || !!s.ends`, so both dated rows must count and the undated one must not — the
		// claim the page renders as "3 sprint rows, 2 of them time-boxed".
		expect(data.sprintReality.total).toBe(3);
		expect(data.sprintReality.timeBoxed).toBe(2);
		expect(data.sprintReality.withTasks).toBe(0);
		// Still no task link anywhere — a time-boxed sprint is not a task container (§6.2).
		expect(data.tasks).toEqual([]);
	});

	it('an unknown project 404s; a malformed slug 404s — never a silent empty board', async () => {
		if (!available) return;
		await expect(runLoad('nosuchproject')).rejects.toMatchObject({ status: 404 });
		await expect(runLoad('bad id with spaces')).rejects.toMatchObject({ status: 404 });
	});
});

describe.runIf(!process.env.SKIP_LIVE)('task board actions — every write goes through the repo', () => {
	it('moveTask drives the state machine and persists', async () => {
		if (!available) return;
		const res = await runAction('moveTask', 'boarda', { taskId: bareId, to: 'ready' });
		expect(envelope(res)).toMatchObject({ ok: true, action: 'move', to: 'ready' });
		expect((await getTask(db!, bareId))!.status).toBe('ready');
		// Put it back so the ordering of later assertions cannot depend on this test.
		await setStatus(db!, bareId, 'backlog');
	});

	it('an ILLEGAL move is a NAMED 400 and writes nothing (TB-4)', async () => {
		if (!available) return;
		const before = (await getTask(db!, bareId))!.status;
		const res = await runAction('moveTask', 'boarda', { taskId: bareId, to: 'done' });
		expect(res.status).toBe(400);
		expect(String(envelope(res).error)).toContain('illegal task status transition');
		expect((await getTask(db!, bareId))!.status).toBe(before);
	});

	it('an unknown status token is refused before any read', async () => {
		if (!available) return;
		const res = await runAction('moveTask', 'boarda', { taskId: bareId, to: 'archived' });
		expect(res.status).toBe(400);
		expect(String(envelope(res).error)).toContain('Unknown status');
	});

	it('a FOREIGN task is a plain 404 from every action — no write, no confirmation', async () => {
		if (!available) return;
		for (const [name, fields] of [
			['moveTask', { taskId: foreignId, to: 'ready' }],
			['retagTask', { taskId: foreignId, tags: 'pwned' }],
			['setPriority', { taskId: foreignId, priority: 'critical' }]
		] as const) {
			const res = await runAction(name, 'boarda', fields);
			expect(res.status).toBe(404);
		}
		const untouched = (await getTask(db!, foreignId))!;
		expect(untouched.status).toBe('backlog');
		expect(untouched.tags).toBeUndefined();
		expect(untouched.priority).toBe('normal');
	});

	it('a NON-TASK record id is refused (the table-scoped guard), not MERGEd onto', async () => {
		if (!available) return;
		const res = await runAction('retagTask', 'boarda', { taskId: 'project:boarda', tags: 'pwned' });
		expect(res.status).toBe(404);
	});

	it('retagTask normalizes at the repo chokepoint and reports the STORED count', async () => {
		if (!available) return;
		const res = await runAction('retagTask', 'boarda', { taskId: bareId, tags: ' DB , db ,, Careful ' });
		expect(envelope(res)).toMatchObject({ ok: true, action: 'retag', tagCount: 2 });
		expect((await getTask(db!, bareId))!.tags).toEqual(['db', 'careful']);
	});

	it('an empty tag box CLEARS back to an honest absence (not a stored [])', async () => {
		if (!available) return;
		const res = await runAction('retagTask', 'boarda', { taskId: bareId, tags: '  ' });
		expect(envelope(res)).toMatchObject({ ok: true, tagCount: 0 });
		expect((await getTask(db!, bareId))!.tags).toBeUndefined();
	});

	it('an over-long tag is refused by NAME (400), and nothing is stored', async () => {
		if (!available) return;
		const res = await runAction('retagTask', 'boarda', { taskId: bareId, tags: 'x'.repeat(33) });
		expect(res.status).toBe(400);
		expect(String(envelope(res).error)).toContain('exceeds 32 characters');
		expect((await getTask(db!, bareId))!.tags).toBeUndefined();
	});

	it('setPriority validates against the stored enum and persists', async () => {
		if (!available) return;
		const ok = await runAction('setPriority', 'boarda', { taskId: bareId, priority: 'critical' });
		expect(envelope(ok)).toMatchObject({ ok: true, action: 'priority', priority: 'critical' });
		expect((await getTask(db!, bareId))!.priority).toBe('critical');

		const bad = await runAction('setPriority', 'boarda', { taskId: bareId, priority: 'urgent' });
		expect(bad.status).toBe(400);
		expect(String(envelope(bad).error)).toContain('Unknown priority');
		expect((await getTask(db!, bareId))!.priority).toBe('critical');
	});

	it('TB-5 — no action on this route can mutate the immutable description (D-008)', async () => {
		if (!available) return;
		const before = (await getTask(db!, richId))!.description;
		// Every action, fed a description the caller would LIKE to write.
		await runAction('retagTask', 'boarda', { taskId: richId, tags: 'db', description: 'hijacked' });
		await runAction('setPriority', 'boarda', {
			taskId: richId,
			priority: 'low',
			description: 'hijacked'
		});
		expect((await getTask(db!, richId))!.description).toBe(before);
	});
});
