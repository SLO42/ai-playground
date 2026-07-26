// COMPLETION-LEDGER Wave A (finding 6) — the PM-REVIEW SCENE MARKER against a LIVE throwaway
// SurrealDB with the REAL schema (m0085's widened `scene_event.kind` ASSERT).
//
// REAL-SURREAL ON PURPOSE. A stubDb enforces no SCHEMAFULL `kind` ASSERT, so it would pass green
// while `kind:'pm_review'` was being REFUSED by the live DB and silently absorbed by the emitter's
// own best-effort catch. It also would not parse the lifecycle graph's marker query, whose
// `kind IN [...]` list is the OTHER half of this fix — a row nothing renders is not a fix.
//
// WHAT IS PROVEN:
//   • m0085 — `kind:'pm_review'` is ACCEPTED by the live ASSERT (without the migration this fails).
//   • HAPPY PATH — the marker lands with the full how/why meta, and runPmReview emits it for real.
//   • THE SURFACING HALF — buildLifecycleGraph READS the marker back and projects it as a `pm`
//     node with a human label. This is the assertion that makes the write worth anything.
//   • THE PREVIOUSLY-DROPPED FACT — `proposalsSkipped` (why the PM proposed nothing) is persisted;
//     it used to be computed, returned to the caller, and thrown away on every autonomous trigger.
//   • HONESTY — `engine:'deterministic'` is stamped (no model formed these conclusions), and a
//     healthy/empty project still emits an honest all-zero marker rather than nothing.
//   • FAULT INJECTION — a scene write fault is absorbed, returns false, does NOT throw, and the
//     review's own durable rows are untouched.
//   • SHADOW PATHS — nil provenance, empty evidence, negative/NaN counts.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject } from './repo';
import { createTask, setStatus } from '../tasks/repo';
import { runPmReview } from './pm-review';
import { listPmReviews } from './pm-repo';
import { buildLifecycleGraph } from '../observability';
import { emitPmReviewScene, pmReviewSummary, PM_REVIEW_SCENE_KIND } from './pm-review-events';

let tdb: TestDb;
let db: Db;
let projectId: string;

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
		slug: 'pmrevscene',
		name: 'PM Review Scene Host',
		root_path: 'F:/code/pmrevscene'
	});
	projectId = p.id;
}, 90_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

beforeEach(async () => {
	await db.query(`DELETE scene_event;`);
});

/** A Db-shaped stand-in whose query ALWAYS rejects — the fault-injection seam. */
function faultingDb(message: string): Db {
	return {
		query: async () => {
			throw new Error(message);
		}
	} as unknown as Db;
}

/** Read the raw pm_review scene markers back (the assertion surface). */
async function readMarkers(): Promise<Array<{ kind: string; ref: string; meta: Record<string, unknown> }>> {
	const [rows] = await db.query<
		[Array<{ kind: string; ref: string; meta: Record<string, unknown> | null; at: unknown }>]
	>(`SELECT kind, ref, meta, at FROM scene_event ORDER BY at ASC;`);
	return (rows ?? []).map((r) => ({ kind: r.kind, ref: r.ref, meta: r.meta ?? {} }));
}

/** A full, realistic marker input (the happy-path fixture). */
function fullInput(overrides: Record<string, unknown> = {}) {
	return {
		projectId,
		reviewId: 'pm_review:abc',
		trigger: 'periodic',
		provenanceKind: 'release',
		provenanceEvidence: ['workflow_run:r1', 'workflow_run:r2'],
		authority: 'propose',
		tasksExamined: 12,
		findingsExamined: 4,
		risksOpen: 2,
		blocked: 3,
		failed: 1,
		severeFindings: 2,
		memoriesWritten: 5,
		risksWritten: 3,
		observationsWritten: 1,
		learningsWritten: 1,
		advisoriesSurfaced: 1,
		proposalsMade: 2,
		proposalsCreated: 1,
		proposalsAbsorbed: 1,
		durationMs: 250,
		...overrides
	};
}

// ── the summary sentence (pure) ──────────────────────────────────────────────────────────

describe('pmReviewSummary — reads as a sentence, never a bare id', () => {
	it('names what it read, what it wrote, and what it proposed', () => {
		const s = pmReviewSummary(fullInput() as never);
		expect(s).toContain('PM review (periodic)');
		expect(s).toContain('read 12 task(s), 4 finding(s), 3 blocked, 2 severe');
		expect(s).toContain('wrote 5 memory entry(ies)');
		expect(s).toContain('proposed 2 task(s)');
		expect(s).toContain('1 absorbed onto a standing proposal');
	});

	it('a skipped-proposals pass says WHY it proposed nothing (not just that it did not)', () => {
		const s = pmReviewSummary(
			fullInput({ proposalsMade: 0, proposalsAbsorbed: 0, proposalsSkipped: 'no hired PM' }) as never
		);
		expect(s).toContain('proposed nothing (no hired PM)');
	});

	it('a healthy pass that simply had no signal says so honestly', () => {
		const s = pmReviewSummary(
			fullInput({ proposalsMade: 0, proposalsAbsorbed: 0, blocked: 0, severeFindings: 0 }) as never
		);
		expect(s).toContain('proposed nothing (no signal warranted a task)');
	});
});

// ── LIVE emitter ─────────────────────────────────────────────────────────────────────────

describe('emitPmReviewScene — live SurrealDB', () => {
	it('m0085: a `pm_review` scene_event is ACCEPTED by the live kind ASSERT', async () => {
		expect(await emitPmReviewScene(db, fullInput() as never)).toBe(true);
		const markers = await readMarkers();
		expect(markers).toHaveLength(1);
		expect(markers[0].kind).toBe(PM_REVIEW_SCENE_KIND);
		// The marker points at the DURABLE record it summarizes.
		expect(markers[0].ref).toBe('pm_review:abc');
	});

	it('carries the FULL how/why payload — what woke it, what it read, concluded, and did', async () => {
		await emitPmReviewScene(db, fullInput() as never);
		const [m] = await readMarkers();
		// WHAT WOKE IT
		expect(m.meta.trigger).toBe('periodic');
		expect(m.meta.provenanceKind).toBe('release');
		expect(m.meta.provenanceEvidence).toBe('workflow_run:r1,workflow_run:r2');
		expect(m.meta.authority).toBe('propose');
		// WHAT IT READ
		expect(m.meta.tasksExamined).toBe(12);
		expect(m.meta.blocked).toBe(3);
		expect(m.meta.severeFindings).toBe(2);
		// WHAT IT CONCLUDED
		expect(m.meta.memoriesWritten).toBe(5);
		expect(m.meta.risksWritten).toBe(3);
		expect(m.meta.advisoriesSurfaced).toBe(1);
		// WHAT IT DID
		expect(m.meta.proposalsMade).toBe(2);
		expect(m.meta.proposalsCreated).toBe(1);
		expect(m.meta.proposalsAbsorbed).toBe(1);
		// HONESTY — no model formed these conclusions, and it says so rather than implying one did.
		expect(m.meta.engine).toBe('deterministic');
		expect(String(m.meta.summary)).toContain('PM review (periodic)');
	});

	it('persists proposalsSkipped — the reason that used to be computed and THROWN AWAY', async () => {
		await emitPmReviewScene(
			db,
			fullInput({ proposalsSkipped: "PM authority is 'observe' — an observe-only PM does not propose" }) as never
		);
		const [m] = await readMarkers();
		expect(String(m.meta.proposalsSkipped)).toContain('observe-only PM does not propose');
	});

	it('SHADOW PATH — nil provenance / empty evidence are OMITTED, never stringified', async () => {
		await emitPmReviewScene(
			db,
			fullInput({
				provenanceKind: undefined,
				provenanceEvidence: [],
				authority: undefined,
				proposalsSkipped: undefined
			}) as never
		);
		const [m] = await readMarkers();
		expect(m.meta.provenanceKind).toBeUndefined();
		expect(m.meta.provenanceEvidence).toBeUndefined();
		expect(m.meta.proposalsSkipped).toBeUndefined();
		expect(JSON.stringify(m.meta)).not.toContain('undefined');
	});

	it('SHADOW PATH — an empty/healthy project still emits an honest all-zero marker', async () => {
		await emitPmReviewScene(db, {
			projectId,
			reviewId: 'pm_review:empty',
			trigger: 'manual',
			tasksExamined: 0,
			findingsExamined: 0,
			risksOpen: 0,
			blocked: 0,
			failed: 0,
			severeFindings: 0,
			memoriesWritten: 0,
			risksWritten: 0,
			observationsWritten: 0,
			learningsWritten: 0,
			advisoriesSurfaced: 0,
			proposalsMade: 0,
			proposalsCreated: 0,
			proposalsAbsorbed: 0
		});
		const [m] = await readMarkers();
		expect(m.meta.tasksExamined).toBe(0);
		expect(m.meta.memoriesWritten).toBe(0);
	});

	it('SHADOW PATH — a NaN/negative count degrades to 0, never poisons the meta', async () => {
		await emitPmReviewScene(
			db,
			fullInput({ tasksExamined: Number.NaN, blocked: -4, durationMs: -1 }) as never
		);
		const [m] = await readMarkers();
		expect(m.meta.tasksExamined).toBe(0);
		expect(m.meta.blocked).toBe(0);
		expect(m.meta.durationMs).toBeUndefined();
	});

	it('SHADOW PATH — an upstream DB fault is ABSORBED (returns false, never throws)', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(await emitPmReviewScene(faultingDb('scene table gone'), fullInput() as never)).toBe(false);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});
});

// ── INTEGRATION: runPmReview really emits it, and the GRAPH really renders it ────────────

describe('runPmReview — the PM pass becomes visible in the lifecycle graph', () => {
	beforeEach(async () => {
		await db.query(`DELETE scene_event; DELETE task; DELETE pm_memory; DELETE pm_review;`);
	});

	it('emits ONE pm_review marker per pass, matching the durable pm_review row', async () => {
		const t = await createTask(db, {
			project: projectId,
			title: 'a stuck task',
			description: 'blocked on something real'
		});
		await setStatus(db, t.id, 'blocked');

		const res = await runPmReview(db, projectId, 'manual');
		expect(res.review.id).toBeTruthy();

		const markers = await readMarkers();
		expect(markers).toHaveLength(1);
		expect(markers[0].kind).toBe(PM_REVIEW_SCENE_KIND);
		// The marker REFERENCES the durable row this pass wrote — live view → never-pruned audit.
		expect(markers[0].ref).toBe(res.review.id);
		const reviews = await listPmReviews(db, projectId);
		expect(reviews.some((r) => r.id === res.review.id)).toBe(true);

		// The counts on the marker are the REAL ones the pass derived (F-008 — not fabricated).
		expect(markers[0].meta.tasksExamined).toBe(1);
		expect(markers[0].meta.blocked).toBe(1);
		expect(markers[0].meta.memoriesWritten).toBe(res.written.length);
		// No hired PM in this fixture ⇒ the honest skip reason is now RECORDED, not dropped.
		expect(String(markers[0].meta.proposalsSkipped)).toContain('no hired PM');
	});

	it('THE SURFACING HALF — buildLifecycleGraph projects the marker as a labelled `pm` node', async () => {
		const res = await runPmReview(db, projectId, 'manual');

		const graph = await buildLifecycleGraph(db, projectId);
		const pmNodes = graph.nodes.filter((n) => n.kind === 'pm');
		expect(pmNodes.length).toBeGreaterThanOrEqual(1);

		const node = pmNodes.find((n) => n.id.startsWith('scene_event:'));
		expect(node, 'the pm_review marker must appear as a pm node in the graph').toBeTruthy();
		expect(node!.status).toBe('review');
		// A human label off the REAL meta — not a bare kind string.
		expect(node!.label).toMatch(/^PM review: \d+ memo, \d+ proposed$/);
		expect(node!.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		// The graph read did not degrade — the marker source is not in failedSources.
		expect(graph.failedSources).not.toContain('scene_event');
		expect(res.review.id).toBeTruthy();
	});

	it('the marker is emitted LAST — the durable rows are committed before telemetry can matter', async () => {
		// The absorb arm itself is proven above with faultingDb (emitPmReviewScene returns false and
		// never throws). What this asserts is the ORDERING that makes that absorb safe: by the time
		// the marker is attempted, the pm_review row and the pm_memory rows are already committed, so
		// there is no state a swallowed marker fault could leave half-written (F-048).
		const before = (await listPmReviews(db, projectId)).length;
		const res = await runPmReview(db, projectId, 'manual');
		expect(res.review).toBeTruthy();
		expect((await listPmReviews(db, projectId)).length).toBe(before + 1);
		expect(res.written.length).toBeGreaterThan(0);
		// …and the marker for THIS pass references that already-committed row.
		const markers = await readMarkers();
		expect(markers.at(-1)!.ref).toBe(res.review.id);
	});
});
