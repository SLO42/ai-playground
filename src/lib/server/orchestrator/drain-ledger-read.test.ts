// COMPLETION-LEDGER Wave A — the DRAIN LEDGER read model (queue-monitor.listDrainLedger /
// drainLedgerCounts / normDrainLedgerRow) against a LIVE throwaway SurrealDB.
//
// REAL-SURREAL by necessity, not preference. These queries carry the F-020 trap (`ORDER BY at`
// requires `at` in the SELECT — a 3× recurrence in this repo) and a `<datetime>` cast, neither of
// which a stubDb parses: a stub suite would pass green with the query broken live. They are ALSO
// the happy-path proof standing behind a best-effort WRITE path — if these read rows back, the
// ledger really lands, and a silently-broken writer can no longer look identical to a healthy
// quiet queue (the F-020-sweep rule).
//
// Shadow paths covered: empty ledger, missing/garbage `detail`, absent datetime, unknown
// vocabulary codes, unrelated agent_event rows, rolling-window exclusion.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject } from '../projects/repo';
import { writeAgentEvent } from '../analytics/events';
import { listDrainLedger, drainLedgerCounts, normDrainLedgerRow } from './queue-monitor';
import {
	recordDrainFault,
	recordQueueHold,
	__resetParkThrottle,
	DRAIN_FAULT_KIND,
	QUEUE_HOLD_KIND,
	DRAIN_STAGE_LABELS,
	QUEUE_REASON_LABELS
} from './drain-events';

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
	await runMigrations(db, schemaMigrations);
}, 90_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

beforeEach(async () => {
	await db.query(`DELETE agent_event;`);
	__resetParkThrottle();
});

describe('drain ledger read model', () => {
	it('EMPTY ledger → [] and all-zero counts (the honest idle state, F-008)', async () => {
		expect(await listDrainLedger(db)).toEqual([]);
		const c = await drainLedgerCounts(db);
		expect(c.faults).toBe(0);
		expect(c.holds).toBe(0);
		expect(c.parks).toBe(0);
		expect(c.windowMs).toBeGreaterThan(0);
	});

	it('HAPPY PATH — a recorded fault and hold are both READ BACK (proves the write lands)', async () => {
		await recordDrainFault(db, {
			stage: 'route_spawn',
			error: new Error('spawn ENOENT claude'),
			taskId: 'task:t1',
			workItemId: 'work_item:w1',
			workType: 'task_run',
			absorbed: false,
			context: { consequence: 'the work item is marked failed' }
		});
		await recordQueueHold(db, {
			phase: 'parked',
			reason: 'daily_cap',
			pendingDepth: 7,
			context: { dailyCap: 200 }
		});

		const rows = await listDrainLedger(db);
		expect(rows).toHaveLength(2);

		const fault = rows.find((r) => r.entry === 'fault')!;
		expect(fault.stage).toBe('route_spawn');
		expect(fault.stageLabel).toBe(DRAIN_STAGE_LABELS.route_spawn);
		expect(fault.errorClass).toBe('Error');
		expect(fault.absorbed).toBe(false);
		expect(fault.taskId).toBe('task:t1');
		expect(fault.workItemId).toBe('work_item:w1');
		expect(fault.workType).toBe('task_run');
		expect(fault.message).toContain('ENOENT');
		// The writer's structured extras land in `context` — not lost, not flattened into noise.
		expect(fault.context.consequence).toBe('the work item is marked failed');

		const hold = rows.find((r) => r.entry === 'hold')!;
		expect(hold.phase).toBe('parked');
		expect(hold.reason).toBe('daily_cap');
		expect(hold.reasonLabel).toBe(QUEUE_REASON_LABELS.daily_cap);
		expect(hold.pendingDepth).toBe(7);
		expect(hold.context.dailyCap).toBe(200);
		expect(hold.message).toContain('7 items waiting');
	});

	it('F-020 — ORDER BY `at` really sorts NEWEST FIRST (the field IS in the projection)', async () => {
		for (const [n, iso] of [
			['one', '2026-07-01T00:00:00Z'],
			['two', '2026-07-02T00:00:00Z'],
			['three', '2026-07-03T00:00:00Z']
		] as const) {
			await db.query(
				`CREATE agent_event CONTENT { type: "error", at: <datetime>$at,
				   detail: { kind: $k, stage: "claim", reason: $n, absorbed: true } };`,
				{ at: iso, k: DRAIN_FAULT_KIND, n }
			);
		}
		const rows = await listDrainLedger(db);
		expect(rows.map((r) => r.message)).toEqual(['three', 'two', 'one']);
		// …and `at` came back ISO-coerced (F-013), not a raw SDK datetime that would devalue-500.
		expect(typeof rows[0].at).toBe('string');
		expect(rows[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it('F-013 — a row with NO `at` yields undefined (→ UI "—"), never the string "undefined"', () => {
		// `at` carries a schema DEFAULT so it cannot be omitted at the DB; assert on the normalizer
		// directly — it is the function that would otherwise emit str(undefined) into a page payload.
		const row = normDrainLedgerRow({ id: 'agent_event:x', detail: { kind: DRAIN_FAULT_KIND } });
		expect(row.at).toBeUndefined();
		expect(JSON.stringify(row)).not.toContain('undefined');
	});

	it('SHADOW PATH — a missing / garbage `detail` still renders an HONEST message, never a blank', () => {
		for (const detail of [undefined, null, 'a string', 42, {}]) {
			const row = normDrainLedgerRow({ id: 'agent_event:y', detail });
			expect(row.message.length).toBeGreaterThan(0);
			expect(row.message).not.toContain('undefined');
			expect(row.context).toEqual({});
		}
	});

	it('SHADOW PATH — an UNKNOWN stage/reason code degrades to the code, never a blank or a lie', () => {
		const row = normDrainLedgerRow({
			id: 'agent_event:z',
			detail: { kind: DRAIN_FAULT_KIND, stage: 'from_a_future_version', reason: 'oops' }
		});
		expect(row.stage).toBe('from_a_future_version');
		expect(row.stageLabel).toBe('from_a_future_version');
		expect(row.message).toBe('oops'); // the persisted reason, not an invented sentence
	});

	it('the `entry` filter narrows to one class and never leaks the other', async () => {
		await recordDrainFault(db, { stage: 'complete', error: new Error('a'), absorbed: true });
		await recordQueueHold(db, { phase: 'enqueued', reason: 'new_work', taskId: 'task:q' });

		const faults = await listDrainLedger(db, { entry: 'fault' });
		expect(faults).toHaveLength(1);
		expect(faults[0].entry).toBe('fault');

		const holds = await listDrainLedger(db, { entry: 'hold' });
		expect(holds).toHaveLength(1);
		expect(holds[0].entry).toBe('hold');
	});

	it('does NOT sweep up unrelated agent_event rows (spawns / ordinary errors stay out)', async () => {
		await writeAgentEvent(db, { type: 'spawn', detail: { reason: 'a normal spawn' } });
		await writeAgentEvent(db, {
			type: 'error',
			detail: { error: 'an ordinary error, not a drain fault' }
		});
		await recordDrainFault(db, { stage: 'claim', error: new Error('mine'), absorbed: true });

		const rows = await listDrainLedger(db);
		expect(rows).toHaveLength(1);
		expect(rows[0].message).toContain('mine');
	});

	it('counts faults / holds / parks separately over the rolling window', async () => {
		await recordDrainFault(db, { stage: 'claim', error: new Error('a'), absorbed: true });
		await recordDrainFault(db, { stage: 'post_task', error: new Error('b'), absorbed: true });
		await recordQueueHold(db, { phase: 'enqueued', reason: 'new_work', taskId: 'task:c1' });
		await recordQueueHold(db, { phase: 'parked', reason: 'concurrency' });
		await recordQueueHold(db, { phase: 'parked', reason: 'daily_cap' });

		const c = await drainLedgerCounts(db);
		expect(c.faults).toBe(2);
		expect(c.holds).toBe(3);
		expect(c.parks).toBe(2); // the `enqueued` row is a hold but NOT a park
	});

	it('the rolling window EXCLUDES older rows, so the headline count cannot grow forever', async () => {
		await db.query(
			`CREATE agent_event CONTENT { type: "error", at: <datetime>"2020-01-01T00:00:00Z",
			   detail: { kind: $k, stage: "claim", reason: "ancient", absorbed: true } };`,
			{ k: DRAIN_FAULT_KIND }
		);
		await recordDrainFault(db, { stage: 'claim', error: new Error('recent'), absorbed: true });
		expect((await drainLedgerCounts(db)).faults).toBe(1);
		// …while the LIST (unwindowed) still shows the history, newest first.
		expect(await listDrainLedger(db)).toHaveLength(2);
	});

	it('the `before` cursor pages back through history', async () => {
		for (const iso of ['2026-07-01T00:00:00Z', '2026-07-02T00:00:00Z', '2026-07-03T00:00:00Z']) {
			await db.query(
				`CREATE agent_event CONTENT { type: "queue", at: <datetime>$at,
				   detail: { kind: $k, phase: "parked", reason: "concurrency", summary: $at } };`,
				{ at: iso, k: QUEUE_HOLD_KIND }
			);
		}
		const older = await listDrainLedger(db, { before: '2026-07-03T00:00:00Z' });
		expect(older).toHaveLength(2);
		expect(older[0].message).toContain('2026-07-02');
	});

	it('the `limit` bound really bounds the read (F-014)', async () => {
		for (let i = 0; i < 6; i++) {
			await recordDrainFault(db, { stage: 'claim', error: new Error(`e${i}`), absorbed: true });
		}
		expect(await listDrainLedger(db, { limit: 3 })).toHaveLength(3);
	});

	it('the projectId filter scopes to one project (the project command-center case)', async () => {
		const p = await createProject(db, {
			slug: `ledgerscope${Date.now().toString(36)}`,
			name: 'ledger-scope',
			root_path: '/tmp/ledger-scope'
		});
		await recordDrainFault(db, {
			stage: 'post_task',
			error: new Error('mine'),
			projectId: p.id,
			absorbed: true
		});
		await recordDrainFault(db, { stage: 'post_task', error: new Error('theirs'), absorbed: true });

		const scoped = await listDrainLedger(db, { projectId: p.id });
		expect(scoped).toHaveLength(1);
		expect(scoped[0].projectId).toBe(p.id);
		expect((await drainLedgerCounts(db, { projectId: p.id })).faults).toBe(1);
	});
});
