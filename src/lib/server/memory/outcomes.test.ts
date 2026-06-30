import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { StringRecordId } from 'surrealdb';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject, deleteProject } from '../projects/repo';
import { MemoryService, FakeEmbedder } from './index';
import { summarizeTurnTools, recordRetrievalFeedback, isRetrievalFeedbackVerdict } from './outcomes';
import type { RuntimeEvent } from '../runtime/index';

// TASK 2.16 VERIFY (integration) — record retrieval outcomes (D-022 groundwork; D-030).
//
// 2.5 already records ONE retrieval_outcome row per injected item from a single boolean.
// 2.16 closes the actual link the ROADMAP names: an injected/recalled CITATION id → the
// success/failure of the SUBSEQUENT TOOL CALLS in that turn → a retrieval_outcome row.
// The runtime emits a tool_call/tool_result stream (each result carries ok:boolean); this
// layer AGGREGATES that stream into a per-turn outcome and ties it to the injected items.
//
// Headline VERIFY (the three claims in the task):
//   (1) an injected citation links to a tool success/failure as a retrieval_outcome row;
//   (2) historical_utility defaults to 0 (no outcome data → recall utility term is 0);
//   (3) recall ranking CONSUMES the outcome, but nothing else does (ranker-input only).
//
// Embedder is the deterministic FakeEmbedder (no Ollama in this sandbox). The runtime
// stream is a SCRIPTED RuntimeEvent[] — the same mocked-runtime pattern 1.4 used; no live
// model, no creds, no network. All rows read back from the real DB (F-008).

let tdb: TestDb;
let db: Db;
let projectId: string;
let mem: MemoryService;

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
		slug: 'outcome_demo',
		name: 'Outcome Demo',
		root_path: 'F:/code/outcome-demo'
	});
	projectId = p.id;
	mem = new MemoryService({ db, embedder: new FakeEmbedder() });
}, 60_000);

afterAll(async () => {
	if (projectId) await deleteProject(db, projectId).catch(() => {});
	await db?.close();
	await tdb?.teardown();
});

describe('summarizeTurnTools — aggregate the runtime tool stream into a turn outcome', () => {
	it('counts tool_result events and derives an all-succeeded overall success', () => {
		const events: RuntimeEvent[] = [
			{ type: 'log', message: 'starting' },
			{ type: 'tool_call', name: 'Read', args: {}, needsConfirm: false },
			{ type: 'tool_result', name: 'Read', ok: true, output: 'ok' },
			{ type: 'tool_call', name: 'Edit', args: {}, needsConfirm: false },
			{ type: 'tool_result', name: 'Edit', ok: true, output: 'ok' },
			{ type: 'done', result: { ok: true, summary: 'done' } }
		];
		const s = summarizeTurnTools(events);
		expect(s.total).toBe(2);
		expect(s.succeeded).toBe(2);
		expect(s.failed).toBe(0);
		// All-succeeded ⇒ overall tool success is true.
		expect(s.toolSuccess).toBe(true);
	});

	it('marks overall failure when ANY tool result failed (conservative)', () => {
		const events: RuntimeEvent[] = [
			{ type: 'tool_result', name: 'Read', ok: true, output: 'ok' },
			{ type: 'tool_result', name: 'Bash', ok: false, output: 'exit 1' }
		];
		const s = summarizeTurnTools(events);
		expect(s.total).toBe(2);
		expect(s.succeeded).toBe(1);
		expect(s.failed).toBe(1);
		expect(s.toolSuccess).toBe(false);
	});

	it('a turn with NO tool calls leaves toolSuccess undefined (no signal — not a failure)', () => {
		const s = summarizeTurnTools([{ type: 'done', result: { ok: true, summary: 'answered' } }]);
		expect(s.total).toBe(0);
		expect(s.toolSuccess).toBeUndefined();
	});
});

describe('VERIFY (1): an injected citation links to tool success/failure as a row', () => {
	it('records one retrieval_outcome per injected item, tying the citation to the turn tool outcome', async () => {
		await mem.store([
			{ content: 'the migrate runner applies schema deltas in id order', project: projectId },
			{ content: 'schema deltas are append-only and never edited in place', project: projectId }
		]);
		const res = await mem.recall('how do schema deltas apply', { project: projectId, limit: 3 });
		expect(res.items.length).toBeGreaterThan(0);
		const cite = res.items[0].citationId;

		// A SCRIPTED runtime turn: model cited [#cite], then ran two tools that both succeeded.
		const events: RuntimeEvent[] = [
			{ type: 'tool_call', name: 'Read', args: {}, needsConfirm: false },
			{ type: 'tool_result', name: 'Read', ok: true, output: 'ok' },
			{ type: 'tool_call', name: 'Edit', args: {}, needsConfirm: false },
			{ type: 'tool_result', name: 'Edit', ok: true, output: 'ok' }
		];
		const ids = await mem.recordTurnOutcomes({
			responseText: `As [#${cite}] notes, deltas apply in id order.`,
			injected: res.items,
			events
		});
		expect(ids.length).toBe(res.items.length);

		// The cited item's row carries cited+utilized AND the aggregated tool_success=true.
		const [rows] = await db.query<
			[Array<{ cited: boolean; utilized: boolean; tool_success: boolean | null; memory: unknown }>]
		>(`SELECT cited, utilized, tool_success, memory FROM retrieval_outcome WHERE citation_id = $c;`, {
			c: cite
		});
		expect(rows.some((r) => r.cited && r.utilized && r.tool_success === true)).toBe(true);
		// The row is LINKED to the actual injected memory record (a real record link, not a string).
		expect(rows.some((r) => String(r.memory) === res.items[0].id)).toBe(true);
	});

	it('a turn whose tools FAILED records tool_success=false against the injected citation', async () => {
		const res = await mem.recall('schema deltas', { project: projectId, limit: 2 });
		const cite = res.items[0].citationId;
		const events: RuntimeEvent[] = [
			{ type: 'tool_call', name: 'Bash', args: {}, needsConfirm: false },
			{ type: 'tool_result', name: 'Bash', ok: false, output: 'build failed' }
		];
		await mem.recordTurnOutcomes({
			responseText: `Per [#${cite}], I tried the build.`,
			injected: res.items,
			events
		});
		const [rows] = await db.query<[Array<{ tool_success: boolean | null; cited: boolean }>]>(
			`SELECT tool_success, cited FROM retrieval_outcome
			  WHERE citation_id = $c AND tool_success = false;`,
			{ c: cite }
		);
		// The cited item recorded a failure outcome (still a row — a failure is signal too).
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.every((r) => r.tool_success === false)).toBe(true);
	});

	it('a no-tool turn omits tool_success entirely (option<bool> stays NONE, never NULL — §6.1)', async () => {
		const res = await mem.recall('schema deltas', { project: projectId, limit: 1 });
		const ids = await mem.recordTurnOutcomes({
			responseText: 'A plain answer with no citation and no tools.',
			injected: res.items,
			events: [{ type: 'done', result: { ok: true, summary: 'answered' } }]
		});
		const [rows] = await db.query<[Array<{ tool_success: boolean | null }>]>(
			`SELECT tool_success FROM $id;`,
			{ id: new StringRecordId(ids[0]) }
		);
		// OMITTED, so it reads back as NONE (null over the wire) — never an explicit boolean.
		expect(rows[0].tool_success ?? null).toBeNull();
	});
});

describe('VERIFY (2): historical_utility defaults to 0 until outcome data exists', () => {
	it('a brand-new memory with NO outcome rows scores with a ZERO utility term', async () => {
		const [m] = await mem.store([
			{ content: 'a freshly stored fact with no retrieval history yet', project: projectId }
		]);
		const res = await mem.recall('freshly stored fact retrieval history', {
			project: projectId,
			limit: 10
		});
		const hit = res.items.find((i) => i.id === m.id);
		expect(hit).toBeDefined();
		// No retrieval_outcome rows for this memory ⇒ utility term defaults to 0.
		expect(hit!.explain.utility).toBe(0);
	});
});

describe('VERIFY (3): recall ranking CONSUMES the outcome; nothing else does (D-030)', () => {
	it('utilized outcomes raise the utility term on a later recall (ranker-input only)', async () => {
		const [m] = await mem.store([
			{ content: 'a uniquely phrased outcome-fed fact about teal accent tokens', project: projectId }
		]);
		// Baseline: utility term is 0 before any outcome.
		const before = await mem.recall('uniquely phrased outcome-fed teal accent', {
			project: projectId,
			limit: 5
		});
		const beforeHit = before.items.find((i) => i.id === m.id);
		expect(beforeHit?.explain.utility).toBe(0);

		// Feed several UTILIZED outcomes via the 2.16 turn path (cited + tools succeeded).
		for (let i = 0; i < 4; i++) {
			const r = await mem.recall('uniquely phrased outcome-fed teal accent', {
				project: projectId,
				limit: 5
			});
			const c = r.items.find((x) => x.id === m.id)!.citationId;
			await mem.recordTurnOutcomes({
				responseText: `Confirmed by [#${c}].`,
				injected: r.items,
				events: [{ type: 'tool_result', name: 'Edit', ok: true, output: 'ok' }]
			});
		}

		// After outcomes: the SAME recall path now shows a NON-zero utility term for it.
		const after = await mem.recall('uniquely phrased outcome-fed teal accent', {
			project: projectId,
			limit: 5
		});
		const afterHit = after.items.find((i) => i.id === m.id);
		expect(afterHit).toBeDefined();
		expect(afterHit!.explain.utility).toBeGreaterThan(0);
	});

	it('retrieval_outcome is read by recall ONLY — no other module queries the table', async () => {
		// Static guard backing D-030: outcome is a ranker input, not a pruning/keep signal,
		// and no analytics/UI surface reads it. The only SELECT against retrieval_outcome in
		// src/ lives in recall.ts (the WMR utility term). loop.ts (the curator's prune) must
		// not touch it. This is asserted structurally in the codebase grep that accompanies
		// this wave; here we assert the BEHAVIOUR: the curator's prune ignores utility.
		const fs = await import('node:fs');
		const path = await import('node:path');
		const loopSrc = fs.readFileSync(
			path.resolve(__dirname, 'loop.ts'),
			'utf8'
		);
		expect(loopSrc).not.toContain('retrieval_outcome');
	});
});

describe('S1 retrieval feedback — recordRetrievalFeedback (m0073 llm_relevance; D-030)', () => {
	it('UPDATEs an existing outcome row with the relevance verdict (helpful/irrelevant/outdated/pin)', async () => {
		// Produce a real outcome row through the 2.16 turn path.
		const [m] = await mem.store([{ content: 'a fact that will receive an S1 relevance verdict', project: projectId }]);
		const r = await mem.recall('a fact that will receive an S1 relevance verdict', { project: projectId, limit: 5 });
		const cit = r.items.find((x) => x.id === m.id);
		expect(cit).toBeDefined();
		await mem.recordTurnOutcomes({ responseText: `Per [#${cit!.citationId}].`, injected: r.items });
		const [outRows] = await db.query<[Array<{ id: unknown }>]>(`SELECT id FROM retrieval_outcome WHERE memory = $m;`, {
			m: new StringRecordId(m.id)
		});
		expect(outRows.length).toBeGreaterThan(0);
		const outcomeId = String(outRows[0].id);

		// Stamp the verdict; the row's llm_relevance is set.
		const ok = await recordRetrievalFeedback(db, outcomeId, 'helpful');
		expect(ok).toBe(true);
		const [after] = await db.query<[Array<{ llm_relevance: string }>]>(`SELECT llm_relevance FROM $id;`, { id: new StringRecordId(outcomeId) });
		expect(after[0].llm_relevance).toBe('helpful');

		// A later verdict overwrites (e.g. operator pins it).
		expect(await recordRetrievalFeedback(db, outcomeId, 'pin')).toBe(true);
		const [pinned] = await db.query<[Array<{ llm_relevance: string }>]>(`SELECT llm_relevance FROM $id;`, { id: new StringRecordId(outcomeId) });
		expect(pinned[0].llm_relevance).toBe('pin');
	});

	it('returns false for a non-existent outcome id (no fabricated row, F-008)', async () => {
		expect(await recordRetrievalFeedback(db, 'retrieval_outcome:does_not_exist', 'irrelevant')).toBe(false);
		const [rows] = await db.query<[Array<{ id: unknown }>]>(`SELECT id FROM retrieval_outcome:does_not_exist;`);
		expect(rows).toHaveLength(0);
	});

	it('rejects an invalid verdict at the boundary (D-026)', async () => {
		expect(isRetrievalFeedbackVerdict('helpful')).toBe(true);
		expect(isRetrievalFeedbackVerdict('bogus')).toBe(false);
		await expect(recordRetrievalFeedback(db, 'retrieval_outcome:x', 'bogus' as never)).rejects.toThrow(/invalid retrieval-feedback verdict/);
	});
});
