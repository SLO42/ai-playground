import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import {
	buildTrayData,
	unreadCount,
	markRead,
	markAllRead,
	type NotificationItem,
	type ActivityEventItem
} from './repo';

// TASK 10.2 VERIFY — RightTray read model + mark-read mutations, against the throwaway
// test DB (namespace dropped per run). Every assertion reads back what the live DB
// persisted (F-008); no fabricated rows. Includes the F-013 regression: a SET datetime
// read back through the load-shaped projection must be a plain ISO STRING (not a
// non-POJO SurrealDB DateTime that would break SvelteKit's load serializer).

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
	expect(applied.length).toBeGreaterThan(0);
}, 90_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

describe('notifications repo — tray read model (§3/§85/§147)', () => {
	it('empty engine yields an honest empty tray (F-008)', async () => {
		const data = await buildTrayData(db);
		expect(data.items).toEqual([]);
		expect(data.unread).toBe(0);
		expect(await unreadCount(db)).toBe(0);
	});

	it('merges real notification + agent_event rows newest-first with an unread count', async () => {
		// Real rows with explicit, ordered datetimes so the merge order is deterministic.
		await db.query(
			`CREATE notification:n1 SET message = 'older notice', read = false, at = d'2026-01-01T10:00:00Z';
			 CREATE notification:n2 SET message = 'newer notice', read = false, at = d'2026-01-01T12:00:00Z';
			 CREATE notification:n3 SET message = 'read notice',  read = true,  at = d'2026-01-01T09:00:00Z';
			 CREATE agent_event:e1 SET type = 'spawn',      at = d'2026-01-01T11:00:00Z',
			   model = { provider: 'anthropic', model_id: 'opus' };
			 CREATE agent_event:e2 SET type = 'completion', at = d'2026-01-01T13:00:00Z';`
		);

		const data = await buildTrayData(db);

		// 3 notifications + 2 events = 5 items, newest-first by ISO timestamp.
		expect(data.items).toHaveLength(5);
		expect(data.items.map((i) => i.id)).toEqual([
			'agent_event:e2', // 13:00
			'notification:n2', // 12:00
			'agent_event:e1', // 11:00
			'notification:n1', // 10:00
			'notification:n3' // 09:00
		]);

		// Two unread notifications (n1, n2); n3 is read.
		expect(data.unread).toBe(2);
		expect(await unreadCount(db)).toBe(2);

		// Item shapes are honest: notification carries message/read; activity carries model.
		const n2 = data.items.find((i) => i.id === 'notification:n2') as NotificationItem;
		expect(n2.kind).toBe('notification');
		expect(n2.message).toBe('newer notice');
		expect(n2.read).toBe(false);

		const e1 = data.items.find((i) => i.id === 'agent_event:e1') as ActivityEventItem;
		expect(e1.kind).toBe('activity');
		expect(e1.type).toBe('spawn');
		expect(e1.model).toBe('anthropic/opus');

		const e2 = data.items.find((i) => i.id === 'agent_event:e2') as ActivityEventItem;
		expect(e2.model).toBeNull(); // no model on the row → honest null, not a fabricated tier
	});

	it('F-013: a SET datetime reads back through the load projection as a plain ISO STRING', async () => {
		// SurrealDB 2.x returns datetimes as a non-POJO DateTime class; the projection MUST
		// coerce to a serializable string or SvelteKit's load serializer throws. Read back the
		// rows we created above through the exact load-shaped projection and assert string-ness.
		const data = await buildTrayData(db);
		expect(data.items.length).toBeGreaterThan(0);
		for (const item of data.items) {
			expect(typeof item.at).toBe('string');
			// Round-trips cleanly through structuredClone (what SvelteKit's serializer does).
			expect(() => structuredClone(item)).not.toThrow();
			// And it is a valid ISO instant.
			expect(Number.isNaN(Date.parse(item.at))).toBe(false);
		}
	});

	it('markRead flips one row read and decrements the unread count (idempotent)', async () => {
		const before = await unreadCount(db);
		expect(before).toBe(2);

		const after = await markRead(db, 'notification:n1');
		expect(after).toBe(1);

		// Re-marking is a no-op (idempotent), count unchanged.
		expect(await markRead(db, 'notification:n1')).toBe(1);

		const data = await buildTrayData(db);
		const n1 = data.items.find((i) => i.id === 'notification:n1') as NotificationItem;
		expect(n1.read).toBe(true);
		expect(data.unread).toBe(1);
	});

	it('markRead rejects a malformed record id at the D-016 boundary', async () => {
		await expect(markRead(db, 'notification; DROP')).rejects.toThrow();
	});

	it('markAllRead clears every unread notification', async () => {
		expect(await unreadCount(db)).toBe(1);
		const after = await markAllRead(db);
		expect(after).toBe(0);
		expect(await unreadCount(db)).toBe(0);

		const data = await buildTrayData(db);
		for (const item of data.items) {
			if (item.kind === 'notification') expect(item.read).toBe(true);
		}
	});
});
