// COMPLETION-LEDGER Wave A — the DRAIN LEDGER chokepoint (drain-events.ts) against a LIVE
// throwaway SurrealDB with the REAL schema (m0084's widened agent_event.type ASSERT).
//
// This is a REAL-SURREAL suite on purpose. A stubDb does not parse SurrealQL and does not
// enforce the SCHEMAFULL `type` ASSERT, so it would pass green while `type:'queue'` was being
// REFUSED by the live DB and silently absorbed by the writer's own best-effort catch — the exact
// shape of hole this wave exists to close. Only a live DB proves the row LANDS.
//
// WHAT IS PROVEN:
//   • HAPPY PATH — both writers actually persist a queryable row with the how/why detail
//     (the F-020-sweep rule: a best-effort catch must have a happy-path test behind it).
//   • m0084 — `type:'queue'` is ACCEPTED by the live ASSERT (without the migration this fails).
//   • FAULT INJECTION — a DB fault on the event write is absorbed, returns false, does NOT throw.
//   • DEVELOPER vs OPERATIONAL — a programmer fault is surfaced loudly (console.error) and is
//     never hidden behind the quiet operational path.
//   • D-026 — a secret / home path in an error message is screened before it is persisted.
//   • THROTTLE — repeated parks collapse with an honest `suppressed` count; discrete phases never
//     throttle.
//   • SHADOW PATHS — nil error, empty error, non-Error throw, empty ids, unknown vocabulary.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject } from '../projects/repo';
import {
	recordDrainFault,
	recordQueueHold,
	holdReasonForSpawnError,
	screenErrorText,
	errorClassOf,
	parkSuppressedCount,
	__resetParkThrottle,
	DRAIN_FAULT_KIND,
	QUEUE_HOLD_KIND,
	DRAIN_STAGES,
	DRAIN_STAGE_LABELS,
	QUEUE_REASONS,
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

/** Read every agent_event row back, newest last (the assertion surface). */
async function readEvents(): Promise<Array<{ type: string; detail: Record<string, unknown> }>> {
	const [rows] = await db.query<[Array<{ type: string; detail: Record<string, unknown>; at: unknown }>]>(
		`SELECT type, detail, at FROM agent_event ORDER BY at ASC;`
	);
	return (rows ?? []).map((r) => ({ type: r.type, detail: r.detail ?? {} }));
}

/** A Db-shaped stand-in whose query ALWAYS rejects — the fault-injection seam. */
function faultingDb(message: string): Db {
	return {
		query: async () => {
			throw new Error(message);
		}
	} as unknown as Db;
}

// ── vocabulary integrity ────────────────────────────────────────────────────────────────

describe('drain ledger vocabulary', () => {
	it('every stage has a plain-language label (no bare ids ever reach a human)', () => {
		for (const stage of DRAIN_STAGES) {
			expect(DRAIN_STAGE_LABELS[stage], `stage ${stage} needs a label`).toBeTruthy();
			// A label must not be the id itself — "drain failed" / "route_spawn" is not acceptable.
			expect(DRAIN_STAGE_LABELS[stage]).not.toBe(stage);
		}
	});

	it('every queue reason has a plain-language label', () => {
		for (const reason of QUEUE_REASONS) {
			expect(QUEUE_REASON_LABELS[reason], `reason ${reason} needs a label`).toBeTruthy();
			expect(QUEUE_REASON_LABELS[reason]).not.toBe(reason);
		}
	});

	it('no stage is named a generic catch-all ("drain failed" is explicitly not acceptable)', () => {
		for (const stage of DRAIN_STAGES) {
			expect(['unknown', 'other', 'drain', 'drain_failed', 'error']).not.toContain(stage);
		}
	});
});

// ── HAPPY PATH — the row actually lands (the F-020-sweep guard) ──────────────────────────

describe('recordDrainFault — happy path', () => {
	it('PERSISTS a queryable, named fault row carrying WHICH step and WHY', async () => {
		const ok = await recordDrainFault(db, {
			stage: 'route_spawn',
			error: new RangeError('provider returned 429 after 3 retries'),
			taskId: 'task:abc',
			workItemId: 'work_item:deadbeef',
			workType: 'task_run',
			absorbed: false,
			context: { consequence: 'the work item is marked failed' }
		});
		expect(ok).toBe(true);

		const events = await readEvents();
		expect(events).toHaveLength(1);
		const [ev] = events;
		expect(ev.type).toBe('error');
		expect(ev.detail.kind).toBe(DRAIN_FAULT_KIND);
		expect(ev.detail.stage).toBe('route_spawn');
		expect(ev.detail.stageLabel).toBe(DRAIN_STAGE_LABELS.route_spawn);
		expect(ev.detail.errorClass).toBe('RangeError');
		expect(ev.detail.absorbed).toBe(false);
		expect(ev.detail.taskId).toBe('task:abc');
		expect(ev.detail.workItemId).toBe('work_item:deadbeef');
		expect(ev.detail.workType).toBe('task_run');
		expect(ev.detail.consequence).toBe('the work item is marked failed');
		// The `reason` sentence must name the STEP, the TASK, the ERROR and the OUTCOME —
		// "how and why", never a flat event.
		const reason = String(ev.detail.reason);
		expect(reason).toContain(DRAIN_STAGE_LABELS.route_spawn);
		expect(reason).toContain('task:abc');
		expect(reason).toContain('429');
		expect(reason).toContain('RangeError');
		expect(reason).toContain('marked failed');
	});

	it('an ABSORBED fault says so in its sentence (a survived hiccup reads differently)', async () => {
		await recordDrainFault(db, {
			stage: 'merge_back',
			error: new Error('non-fast-forward'),
			absorbed: true
		});
		const [ev] = await readEvents();
		expect(String(ev.detail.reason)).toContain('the drain continued');
	});

	it('links the row to its project and session so the project surfaces pick it up', async () => {
		// Through the real repo (never a hand-rolled CREATE — the table is SCHEMAFULL with
		// required fields the repo owns, D-016 reuse).
		const project = await createProject(db, {
			slug: `ledgerproj${Date.now().toString(36)}`,
			name: 'ledger-proj',
			root_path: '/tmp/ledger-proj'
		});
		const projectId = project.id;
		await recordDrainFault(db, { stage: 'post_task', error: new Error('boom'), projectId, absorbed: true });
		const [rows] = await db.query<[Array<{ project: unknown }>]>(
			`SELECT project FROM agent_event WHERE detail.kind = $k;`,
			{ k: DRAIN_FAULT_KIND }
		);
		expect(String(rows[0].project)).toBe(projectId);
	});
});

describe('recordQueueHold — happy path (m0084 proves `type:queue` is accepted live)', () => {
	it('PERSISTS a queryable hold row — without m0084 the ASSERT would refuse this write', async () => {
		const ok = await recordQueueHold(db, {
			phase: 'deduped',
			reason: 'active_twin',
			taskId: 'task:xyz',
			workItemId: 'work_item:cafe',
			workType: 'task_run'
		});
		expect(ok).toBe(true);

		const events = await readEvents();
		expect(events).toHaveLength(1);
		const [ev] = events;
		expect(ev.type).toBe('queue');
		expect(ev.detail.kind).toBe(QUEUE_HOLD_KIND);
		expect(ev.detail.phase).toBe('deduped');
		expect(ev.detail.reason).toBe('active_twin');
		expect(ev.detail.reasonLabel).toBe(QUEUE_REASON_LABELS.active_twin);
		// The operator-facing sentence must answer "why is this not running?" on its own.
		expect(String(ev.detail.summary)).toContain('task:xyz');
		expect(String(ev.detail.summary)).toContain('already queued');
	});

	it('a PARK carries the pending depth so it is actionable ("parked with 12 waiting")', async () => {
		await recordQueueHold(db, {
			phase: 'parked',
			reason: 'concurrency',
			pendingDepth: 12,
			context: { maxConcurrent: 3, inUse: 3 }
		});
		const [ev] = await readEvents();
		expect(ev.detail.pendingDepth).toBe(12);
		expect(ev.detail.maxConcurrent).toBe(3);
		expect(String(ev.detail.summary)).toContain('12 items waiting');
		expect(String(ev.detail.summary)).toContain('all agent slots are busy');
	});

	it('an ABSENT depth is OMITTED, never rendered as a fabricated 0 (F-008)', async () => {
		await recordQueueHold(db, { phase: 'parked', reason: 'daily_cap' });
		const [ev] = await readEvents();
		expect(ev.detail.pendingDepth).toBeUndefined();
		// …and the sentence simply does not claim a depth rather than claiming zero.
		expect(String(ev.detail.summary)).not.toContain('0 items waiting');
	});
});

// ── FAULT INJECTION — a DB fault on the ledger write never crashes the drain ─────────────

describe('fault injection (F-014/F-048) — the ledger can never crash what it observes', () => {
	it('recordDrainFault absorbs a DB fault: resolves false, does NOT throw', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const bad = faultingDb('There was a problem with the database: Connection uninitialised');
		await expect(
			recordDrainFault(bad, { stage: 'claim', error: new Error('inner'), absorbed: true })
		).resolves.toBe(false);
		expect(warn).toHaveBeenCalled();
		expect(String(warn.mock.calls[0][0])).toContain('[drain-ledger]');
		warn.mockRestore();
	});

	it('recordQueueHold absorbs a DB fault: resolves false, does NOT throw', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const bad = faultingDb('read or write conflict, this transaction can be retried');
		await expect(
			recordQueueHold(bad, { phase: 'enqueued', reason: 'new_work' })
		).resolves.toBe(false);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it('a UNIQUE/conflict fault is absorbed as a quiet no-op-retry, NOT escalated', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const err = vi.spyOn(console, 'error').mockImplementation(() => {});
		const bad = faultingDb('Database index `agent_event_x` already contains a value');
		await expect(
			recordDrainFault(bad, { stage: 'complete', error: new Error('x'), absorbed: true })
		).resolves.toBe(false);
		expect(warn).toHaveBeenCalled();
		expect(err).not.toHaveBeenCalled(); // operational, not a developer bug
		warn.mockRestore();
		err.mockRestore();
	});

	it('a DEVELOPER error (TypeError) is surfaced LOUDLY — the best-effort catch never hides a bug', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const err = vi.spyOn(console, 'error').mockImplementation(() => {});
		const bad = {
			query: async () => {
				throw new TypeError("Cannot read properties of undefined (reading 'detail')");
			}
		} as unknown as Db;
		await expect(
			recordDrainFault(bad, { stage: 'heartbeat', error: new Error('x'), absorbed: true })
		).resolves.toBe(false);
		expect(err).toHaveBeenCalled();
		expect(String(err.mock.calls[0][0])).toContain('DEVELOPER ERROR');
		expect(warn).not.toHaveBeenCalled(); // NOT routed down the quiet operational path
		warn.mockRestore();
		err.mockRestore();
	});
});

// ── D-026 screening ─────────────────────────────────────────────────────────────────────

describe('screenErrorText (D-026) — a real error is never persisted raw', () => {
	it('redacts a home path (PII) out of an error message before it is stored', async () => {
		await recordDrainFault(db, {
			stage: 'post_task',
			error: new Error('ENOENT: C:\\Users\\11sos\\AppData\\Local\\wt\\session'),
			absorbed: true
		});
		const [ev] = await readEvents();
		expect(String(ev.detail.error)).not.toContain('11sos');
		expect(String(ev.detail.error)).toContain('REDACTED');
	});

	it('a message that is ONLY a secret is withheld with an HONEST marker, never blanked', () => {
		// screen() quarantines on an un-redactable secret; we must say so, not show ''.
		const out = screenErrorText('sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
		expect(out === '' || out === 'undefined').toBe(false);
		expect(out.length).toBeGreaterThan(0);
	});

	it('keeps only the first lines and bounds the length (an event row is not a log dump)', () => {
		const stack = ['line one', 'line two', 'line three', 'line four', 'line five'].join('\n');
		const out = screenErrorText(stack);
		expect(out).toContain('line one');
		expect(out).toContain('line three');
		expect(out).not.toContain('line four');
		expect(screenErrorText('x'.repeat(5000)).length).toBeLessThanOrEqual(600);
	});

	// SHADOW PATHS: nil / empty / non-Error.
	it('nil, undefined and empty errors become an HONEST marker — never the string "undefined"', () => {
		for (const v of [null, undefined, '', '   ']) {
			const out = screenErrorText(v);
			expect(out).toBe('(no error message)');
			expect(out).not.toContain('undefined');
		}
	});

	it('a non-Error throw reports its typeof, never a fabricated class name', () => {
		expect(errorClassOf('just a string')).toBe('non-error:string');
		expect(errorClassOf(undefined)).toBe('non-error:undefined');
		expect(errorClassOf(new TypeError('t'))).toBe('TypeError');
	});

	it('a non-Error throw still produces a complete, persisted row (no crash, no blank)', async () => {
		await recordDrainFault(db, { stage: 'claim', error: { weird: true }, absorbed: true });
		const [ev] = await readEvents();
		expect(ev.detail.errorClass).toBe('non-error:object');
		expect(String(ev.detail.reason)).toContain(DRAIN_STAGE_LABELS.claim);
	});
});

// ── park throttling ─────────────────────────────────────────────────────────────────────

describe('park throttling — visibility without an event storm', () => {
	it('collapses repeated parks and reports the honest folded-in count on the next emit', async () => {
		expect(await recordQueueHold(db, { phase: 'parked', reason: 'concurrency' })).toBe(true);
		// Same (reason, project) inside the window ⇒ folded in, no row.
		for (let i = 0; i < 5; i++) {
			expect(await recordQueueHold(db, { phase: 'parked', reason: 'concurrency' })).toBe(false);
		}
		expect(await readEvents()).toHaveLength(1);
		expect(parkSuppressedCount('concurrency')).toBe(5);

		// Roll the clock past the window: the next park emits AND carries the suppressed count.
		vi.useFakeTimers();
		vi.setSystemTime(Date.now() + 61_000);
		expect(await recordQueueHold(db, { phase: 'parked', reason: 'concurrency' })).toBe(true);
		vi.useRealTimers();

		const events = await readEvents();
		expect(events).toHaveLength(2);
		expect(events[1].detail.suppressed).toBe(5);
		expect(String(events[1].detail.summary)).toContain('5 identical holds in the last minute');
	});

	it('throttles PER (reason, project) — a different reason is never suppressed by another', async () => {
		expect(await recordQueueHold(db, { phase: 'parked', reason: 'concurrency' })).toBe(true);
		expect(await recordQueueHold(db, { phase: 'parked', reason: 'daily_cap' })).toBe(true);
		expect(await recordQueueHold(db, { phase: 'parked', reason: 'token_budget' })).toBe(true);
		expect(await readEvents()).toHaveLength(3);
	});

	it('ONE-OFF phases (enqueued / gate_blocked) are NEVER throttled — each is a real decision', async () => {
		for (let i = 0; i < 4; i++) {
			expect(
				await recordQueueHold(db, { phase: 'enqueued', reason: 'new_work', taskId: `task:t${i}` })
			).toBe(true);
		}
		expect(await recordQueueHold(db, { phase: 'gate_blocked', reason: 'capability_denied' })).toBe(
			true
		);
		expect(await readEvents()).toHaveLength(5);
	});

	// LIVE-VERIFIED REGRESSION: the first real load of /atelier/queue showed TWENTY identical
	// `deduped` rows for ONE task inside 8 minutes (an armed PM re-enqueuing on its cadence),
	// burying every other entry. A dedup repeats exactly like a park, so it throttles like one.
	it('repeated DEDUPS of the SAME task collapse (the live-observed re-enqueue storm)', async () => {
		const taskId = 'task:storm';
		expect(await recordQueueHold(db, { phase: 'deduped', reason: 'active_twin', taskId })).toBe(true);
		for (let i = 0; i < 19; i++) {
			expect(await recordQueueHold(db, { phase: 'deduped', reason: 'active_twin', taskId })).toBe(
				false
			);
		}
		expect(await readEvents()).toHaveLength(1);
		expect(parkSuppressedCount('active_twin', undefined, 'deduped', taskId)).toBe(19);

		vi.useFakeTimers();
		vi.setSystemTime(Date.now() + 61_000);
		expect(await recordQueueHold(db, { phase: 'deduped', reason: 'active_twin', taskId })).toBe(true);
		vi.useRealTimers();
		const events = await readEvents();
		expect(events).toHaveLength(2);
		expect(events[1].detail.suppressed).toBe(19);
		expect(String(events[1].detail.summary)).toContain('19 identical holds in the last minute');
	});

	it('a dedup storm for ONE task never hides a DIFFERENT task’s first dedup', async () => {
		expect(
			await recordQueueHold(db, { phase: 'deduped', reason: 'active_twin', taskId: 'task:a' })
		).toBe(true);
		expect(
			await recordQueueHold(db, { phase: 'deduped', reason: 'active_twin', taskId: 'task:a' })
		).toBe(false);
		// A different task is its own bucket — it must still be recorded.
		expect(
			await recordQueueHold(db, { phase: 'deduped', reason: 'active_twin', taskId: 'task:b' })
		).toBe(true);
		expect(await readEvents()).toHaveLength(2);
	});
});

// ── spawn-error classification ──────────────────────────────────────────────────────────

describe('holdReasonForSpawnError — a policy refusal is a HOLD, not a transient fault', () => {
	it('classifies a D-036 capability refusal as capability_denied', () => {
		class CapabilityValidationError extends Error {}
		expect(holdReasonForSpawnError(new CapabilityValidationError('unknown id'))).toBe(
			'capability_denied'
		);
		class SterileCompositionError extends Error {}
		expect(holdReasonForSpawnError(new SterileCompositionError('sterile'))).toBe(
			'capability_denied'
		);
	});

	it('returns null for everything else (those become named route_spawn faults)', () => {
		expect(holdReasonForSpawnError(new Error('spawn ENOENT'))).toBeNull();
		expect(holdReasonForSpawnError(new TypeError('bug'))).toBeNull();
		expect(holdReasonForSpawnError(null)).toBeNull();
		expect(holdReasonForSpawnError('a string')).toBeNull();
	});
});

// ── shadow paths on the ids ─────────────────────────────────────────────────────────────

describe('shadow paths — nil / empty ids', () => {
	it('empty-string ids are treated as ABSENT (omitted), never persisted as "" or "undefined"', async () => {
		await recordDrainFault(db, {
			stage: 'trigger',
			error: new Error('e'),
			taskId: '   ',
			projectId: '',
			sessionId: '',
			workItemId: '',
			absorbed: true
		});
		const [ev] = await readEvents();
		expect(ev.detail.taskId).toBeUndefined();
		expect(ev.detail.workItemId).toBeUndefined();
		expect(String(ev.detail.reason)).not.toContain('undefined');
		const [rows] = await db.query<[Array<{ project: unknown; session: unknown }>]>(
			`SELECT project, session FROM agent_event;`
		);
		expect(rows[0].project ?? null).toBeNull();
		expect(rows[0].session ?? null).toBeNull();
	});

	it('a malformed project id is absorbed (the D-016 validate throw never escapes the writer)', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const err = vi.spyOn(console, 'error').mockImplementation(() => {});
		// 'not-a-record-id' fails assertRecordId inside writeAgentEvent — a caller bug that must
		// still not crash the drain. It IS absorbed; the console tells us which channel fired.
		await expect(
			recordDrainFault(db, {
				stage: 'trigger',
				error: new Error('e'),
				projectId: 'not-a-record-id',
				absorbed: true
			})
		).resolves.toBe(false);
		expect(warn.mock.calls.length + err.mock.calls.length).toBeGreaterThan(0);
		warn.mockRestore();
		err.mockRestore();
	});
});
