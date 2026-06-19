import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { EventBus, type BusEvent } from '../events/bus';
import type { DbChange } from '../events/db-source';
import {
	SceneProjector,
	appendSceneEvent,
	pruneSceneEvents,
	screenSceneMeta,
	SCENE_EVENT_CAP
} from './projector';

// MEMORY-SCENE-SPEC §5 VERIFY — the scene_event projection writer is a DERIVED,
// append-only, rolling activity feed driven off the SAME bus the SSE observes.
// We prove, against a live throwaway SurrealDB (F-008; no fabricated data):
//   • appendSceneEvent writes a valid row (kind/ref/source/project/meta), ISO `at` (F-013).
//   • the projector emits a scene_event ONLY on a real observed row-change, with the
//     correct kind per the v1 emission map — and NOTHING for unmapped/no-op changes.
//   • all four data-flow shadow paths (happy / nil / empty / upstream-terminal) behave.
//   • rolling retention prunes the feed to the cap (the feed stays bounded).
//   • a write failure NEVER crashes the host flow (best-effort: the bus keeps running).
//   • D-026 — a secret in a surfaced meta field is screened, not leaked into the feed.

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
}, 60_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown().catch(() => {});
});

beforeEach(async () => {
	// Each test starts from an empty feed (rolling window — order matters for prune tests).
	await db.query('DELETE scene_event;');
});

/** Build a db_change BusEvent the way db-source.ts publishes them. */
function dbChange(
	topic: string,
	action: 'CREATE' | 'UPDATE' | 'DELETE',
	record: string,
	result: unknown
): BusEvent<DbChange> {
	return {
		type: 'db_change',
		topic,
		key: record,
		data: { action, record, result }
	};
}

async function feed(): Promise<Array<Record<string, unknown>>> {
	const [rows] = await db.query<[Array<Record<string, unknown>>]>(
		'SELECT * FROM scene_event ORDER BY at ASC;'
	);
	return rows;
}

// ── appendSceneEvent — the low-level writer ─────────────────────────────────────────

describe('appendSceneEvent', () => {
	it('writes a valid row with an ISO datetime (F-013) and omits absent optionals', async () => {
		const id = await appendSceneEvent(db, { kind: 'job_fired', ref: 'session:abc', source: 'session' });
		expect(id).toMatch(/^scene_event:/);
		const rows = await feed();
		expect(rows).toHaveLength(1);
		const row = rows[0];
		expect(row.kind).toBe('job_fired');
		expect(row.ref).toBe('session:abc');
		expect(row.source).toBe('session');
		// absent optionals are NONE (omitted), never a fabricated value.
		expect(row.project ?? null).toBeNull();
		expect(row.meta ?? null).toBeNull();
		// `at` round-trips as a Date-like the SDK returns; it must be coercible to an ISO string.
		const iso = new Date(String(row.at)).toISOString();
		expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it('links a project record + stores a screened meta', async () => {
		const [p] = await db.query<[Array<{ id: unknown }>]>(
			'CREATE project SET slug="s", name="N", root_path="/x" RETURN AFTER;'
		);
		const projectId = String(p[0].id);
		await appendSceneEvent(db, {
			kind: 'job_done',
			ref: 'session:xyz',
			source: 'session',
			project: projectId,
			meta: { status: 'done' }
		});
		const rows = await feed();
		expect(String(rows[0].project)).toBe(projectId);
		expect(rows[0].meta).toMatchObject({ status: 'done' });
	});

	it('rejects an unknown kind at the schema boundary (every kind maps to a real change class)', async () => {
		await expect(
			// @ts-expect-error — deliberately invalid kind to prove the ASSERT bites.
			appendSceneEvent(db, { kind: 'fabricated', ref: 'x:1', source: 'x' })
		).rejects.toThrow();
	});
});

// ── screenSceneMeta — D-026 ─────────────────────────────────────────────────────────

describe('screenSceneMeta (D-026)', () => {
	it('redacts a secret-bearing string value, keeps the label', () => {
		const out = screenSceneMeta({ status: 'done', note: 'token sk-ant-ABCDEFGH12345678 leaked' });
		expect(out.status).toBe('done');
		expect(String(out.note)).not.toContain('sk-ant-ABCDEFGH12345678');
		expect(String(out.note)).toContain('[REDACTED');
	});

	it('drops a quarantined value to a marker (never the raw body)', () => {
		const pem =
			'-----BEGIN PRIVATE KEY-----\nMIIBVgIBADANBgkqh\n-----END PRIVATE KEY-----';
		const out = screenSceneMeta({ blob: pem });
		expect(out.blob).toBe('[screened]');
		expect(String(out.blob)).not.toContain('BEGIN PRIVATE KEY');
	});

	it('passes scalar values, drops nested objects (fail-closed, never surfaces raw content)', () => {
		const out = screenSceneMeta({ n: 3, ok: true, nested: { secret: 'x' }, skip: null });
		expect(out).toEqual({ n: 3, ok: true });
	});

	it('a secret surfaced via the writer never lands raw in the feed', async () => {
		await appendSceneEvent(db, {
			kind: 'memory_added',
			ref: 'memory:1',
			source: 'memory',
			meta: { key: 'password=hunter2supersecret', kind: 'semantic' }
		});
		const rows = await feed();
		const meta = rows[0].meta as Record<string, unknown>;
		expect(String(meta.key)).not.toContain('hunter2supersecret');
		expect(meta.kind).toBe('semantic');
	});
});

// ── the projector — derived-only emission map ───────────────────────────────────────

describe('SceneProjector emission map', () => {
	let bus: EventBus;
	let projector: SceneProjector;

	beforeEach(() => {
		bus = new EventBus();
		projector = new SceneProjector({ db, bus });
		projector.start();
	});

	afterAll(() => projector?.stop());

	it('session CREATE → job_fired (a real row change → exactly one derived event)', async () => {
		bus.publish(dbChange('session', 'CREATE', 'session:s1', { status: 'running', kind: 'driven' }));
		await projector.idle();
		const rows = await feed();
		expect(rows).toHaveLength(1);
		expect(rows[0].kind).toBe('job_fired');
		expect(rows[0].ref).toBe('session:s1');
		expect(rows[0].source).toBe('session');
		expect((rows[0].meta as Record<string, unknown>).status).toBe('running');
	});

	it('session UPDATE→terminal → job_done; a non-terminal UPDATE emits NOTHING (derived-only, F-008)', async () => {
		bus.publish(dbChange('session', 'UPDATE', 'session:s2', { status: 'running' }));
		await projector.idle();
		expect(await feed()).toHaveLength(0); // no-op transition → no fabricated event

		bus.publish(dbChange('session', 'UPDATE', 'session:s2', { status: 'failed' }));
		await projector.idle();
		const rows = await feed();
		expect(rows).toHaveLength(1);
		expect(rows[0].kind).toBe('job_done');
	});

	it('work_item CREATE → job_fired; terminal UPDATE → job_done', async () => {
		// Schema-accurate work_item row (SCHEMAFULL: work_type/status — NOT kind, schema.ts §446).
		bus.publish(
			dbChange('work_item', 'CREATE', 'work_item:w1', { status: 'pending', work_type: 'review' })
		);
		bus.publish(dbChange('work_item', 'UPDATE', 'work_item:w1', { status: 'done' }));
		await projector.idle();
		const rows = await feed();
		const kinds = rows.map((r) => r.kind);
		expect(kinds).toEqual(['job_fired', 'job_done']);
		// REGRESSION (gap #2): the job-class label must survive — job_fired meta carries
		// work_type, not be reduced to {status} only. A fixture using {kind} would mask this.
		expect(rows[0].meta as Record<string, unknown>).toMatchObject({
			status: 'pending',
			work_type: 'review'
		});
	});

	it('memory CREATE → memory_added; entity CREATE → node_spawned; references CREATE → connection_formed', async () => {
		// Schema-accurate rows (entity is SCHEMAFULL label/type — NOT kind/name, schema.ts §294-299;
		// memory has kind/namespace §208-210; references has kind §302).
		bus.publish(dbChange('memory', 'CREATE', 'memory:m1', { kind: 'semantic', namespace: 'default' }));
		bus.publish(dbChange('entity', 'CREATE', 'entity:e1', { label: 'Auth', type: 'concept' }));
		bus.publish(dbChange('references', 'CREATE', 'references:r1', { kind: 'relates' }));
		await projector.idle();
		const rows = await feed();
		const kinds = rows.map((r) => r.kind);
		expect(kinds).toEqual(['memory_added', 'node_spawned', 'connection_formed']);
		// REGRESSION (gap #1): the headline node_spawned MUST surface a non-empty identifying
		// label. With the old ['kind','name'] field names this meta was ALWAYS empty against
		// the real schema (the prior fabricated {kind,name} fixture masked it).
		const nodeSpawned = rows.find((r) => r.kind === 'node_spawned')!;
		expect(nodeSpawned.meta as Record<string, unknown>).toMatchObject({
			label: 'Auth',
			type: 'concept'
		});
		expect(Object.keys(nodeSpawned.meta as Record<string, unknown>).length).toBeGreaterThan(0);
	});

	it('lifts the project off the changed row when present', async () => {
		bus.publish(
			dbChange('session', 'CREATE', 'session:s3', { status: 'running', project: 'project:demo' })
		);
		await projector.idle();
		const rows = await feed();
		expect(String(rows[0].project)).toBe('project:demo');
	});

	// ── shadow paths (every data flow: happy / nil / empty / upstream-error) ──────────

	it('SHADOW nil — a db_change with null result emits nothing (no crash)', async () => {
		bus.publish(dbChange('session', 'CREATE', 'session:n1', null));
		await projector.idle();
		expect(await feed()).toHaveLength(0);
	});

	it('SHADOW empty — a CREATE on an unmapped source topic is filtered out entirely', async () => {
		// 'task' is not a scene source topic → the filter rejects it; nothing is appended.
		bus.publish(dbChange('task', 'CREATE', 'task:t1', { status: 'ready' }));
		await projector.idle();
		expect(await feed()).toHaveLength(0);
	});

	it('SHADOW upstream — a DELETE (no row body) emits nothing', async () => {
		bus.publish(dbChange('session', 'DELETE', 'session:d1', null));
		await projector.idle();
		expect(await feed()).toHaveLength(0);
	});

	it('a missing record id emits nothing (defensive — never a ref-less event)', async () => {
		bus.publish(dbChange('session', 'CREATE', '', { status: 'running' }));
		await projector.idle();
		expect(await feed()).toHaveLength(0);
	});

	it('stop() tears down the subscription — no further events after stop (F-014)', async () => {
		projector.stop();
		bus.publish(dbChange('session', 'CREATE', 'session:after', { status: 'running' }));
		await projector.idle();
		expect(await feed()).toHaveLength(0);
	});
});

// ── best-effort: a write failure never crashes the host flow ────────────────────────

describe('SceneProjector resilience (best-effort, non-blocking)', () => {
	it('a projection-write failure is swallowed — the bus keeps delivering to others', async () => {
		const bus = new EventBus();
		// A projector pointed at a CLOSED db: every append throws. It must NOT take down
		// the bus, the publish call, or a co-subscriber.
		const broken = await Db.connect({
			url: tdb.wsUrl,
			username: tdb.root.username,
			password: tdb.root.password,
			namespace: tdb.namespace,
			database: tdb.database
		});
		await broken.close();
		const projector = new SceneProjector({ db: broken, bus });
		projector.start();

		let coSubscriberSaw = 0;
		const unsub = bus.subscribe(
			() => coSubscriberSaw++,
			(e) => e.type === 'db_change' && e.topic === 'session'
		);

		// publish() must not throw even though the projector's append will reject.
		expect(() =>
			bus.publish(dbChange('session', 'CREATE', 'session:boom', { status: 'running' }))
		).not.toThrow();
		await projector.idle(); // the in-flight rejected append is tracked + swallowed
		expect(coSubscriberSaw).toBe(1); // the co-subscriber still got the event
		unsub();
		projector.stop();
	});
});

// ── rolling retention — the feed stays bounded ──────────────────────────────────────

describe('pruneSceneEvents (rolling window)', () => {
	it('keeps the newest `cap` rows, deletes the rest, oldest first', async () => {
		const cap = 5;
		for (let i = 0; i < cap + 4; i++) {
			await appendSceneEvent(db, { kind: 'job_fired', ref: `session:p${i}`, source: 'session' });
		}
		expect((await feed()).length).toBe(cap + 4);
		const deleted = await pruneSceneEvents(db, cap);
		expect(deleted).toBe(4);
		const rows = await feed();
		expect(rows.length).toBe(cap);
		// the SURVIVORS are the newest ones (p4..p8); the oldest (p0..p3) were pruned.
		const refs = rows.map((r) => r.ref);
		expect(refs).toContain('session:p8');
		expect(refs).not.toContain('session:p0');
	});

	it('is a no-op (returns 0) when at or under the cap — empty feed too', async () => {
		expect(await pruneSceneEvents(db, 10)).toBe(0); // empty
		await appendSceneEvent(db, { kind: 'job_fired', ref: 'session:one', source: 'session' });
		expect(await pruneSceneEvents(db, 10)).toBe(0); // under cap
		expect((await feed()).length).toBe(1);
	});

	it('the projector rolls the window as it appends (cap enforced live)', async () => {
		const bus = new EventBus();
		const projector = new SceneProjector({ db, bus, cap: 3 });
		projector.start();
		for (let i = 0; i < 6; i++) {
			bus.publish(dbChange('session', 'CREATE', `session:roll${i}`, { status: 'running' }));
		}
		await projector.idle();
		expect((await feed()).length).toBe(3);
		projector.stop();
	});

	it('SCENE_EVENT_CAP is a sane bounded default', () => {
		expect(SCENE_EVENT_CAP).toBeGreaterThan(0);
		expect(SCENE_EVENT_CAP).toBeLessThanOrEqual(10_000);
	});
});
