// SVC-3 (SERVICES-SPEC §3) — incidents.ts: the incident/notification repo (DATA-MODEL §4.7).
//
// Covered only INDIRECTLY before (via the manager/runtime tests). Because these are real
// SurrealQL queries, they are proven against a REAL migrated SurrealDB (F-020: a stubDb would
// pass green while the query is broken; F-008: no fakes). This suite asserts the ROW SHAPES +
// the honest shadow paths:
//   • recordIncident — detail OMITTED when absent (option<string> stays NONE, §6.1); severity
//     DEFAULTs to 'info' via the schema; an explicit severity is persisted.
//   • recordNotification — defaults read=false, at=now.
//   • listIncidents — newest-first ORDER BY at (F-020: `at` is in the SELECT *), empty → [].
//   • listUnreadNotifications — filters read=false only.
//   • F-013 — every datetime (`at`) reads back a plain string, never a non-POJO SDK DateTime.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import {
	recordIncident,
	recordNotification,
	listIncidents,
	listUnreadNotifications
} from './incidents';

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
	await db?.close();
	await tdb?.teardown();
});

beforeEach(async () => {
	await db.query('DELETE incident; DELETE notification;');
});

describe('recordIncident — row shape, optional detail, severity default (§6.1 / F-013)', () => {
	it('omits detail when absent and defaults severity to info', async () => {
		const row = await recordIncident(db, { title: 'Service "ollama" went down' });
		expect(row.title).toBe('Service "ollama" went down');
		expect(row.detail).toBeUndefined(); // option<string> stayed NONE (never str(undefined))
		expect(row.severity).toBe('info'); // schema DEFAULT fired
		expect(typeof row.at).toBe('string'); // F-013 — plain ISO string, not an SDK DateTime
		expect(row.at.length).toBeGreaterThan(0);
		expect(Number.isNaN(new Date(row.at).getTime())).toBe(false);
		expect(String(row.id)).toMatch(/^incident:/);
		// JSON-serializable (the SvelteKit load-serializer contract).
		expect(() => JSON.parse(JSON.stringify(row))).not.toThrow();
	});

	it('persists an explicit detail + severity', async () => {
		const row = await recordIncident(db, {
			title: 'Service "surrealdb" exceeded restart limit',
			detail: 'gave up after 3 consecutive restart failures',
			severity: 'critical'
		});
		expect(row.detail).toBe('gave up after 3 consecutive restart failures');
		expect(row.severity).toBe('critical');

		// Read back through the query path — the persisted row matches (real-surreal, F-020).
		const rows = await listIncidents(db);
		expect(rows.some((r) => r.severity === 'critical' && r.detail?.includes('gave up'))).toBe(true);
	});
});

describe('recordNotification — defaults (read=false, at=now)', () => {
	it('writes an unread notification with a coerced datetime', async () => {
		const note = await recordNotification(db, 'Service "ollama" crashed — auto-restarting');
		expect(note.message).toBe('Service "ollama" crashed — auto-restarting');
		expect(note.read).toBe(false);
		expect(typeof note.at).toBe('string'); // F-013
		expect(String(note.id)).toMatch(/^notification:/);
	});
});

describe('listIncidents — newest-first ORDER BY at (F-020: at in SELECT), empty shadow path', () => {
	it('returns [] when there are no incidents (honest empty, not a throw)', async () => {
		expect(await listIncidents(db)).toEqual([]);
	});

	it('orders newest-first and honors the limit', async () => {
		await recordIncident(db, { title: 'first', detail: 'oldest' });
		await new Promise((r) => setTimeout(r, 15));
		await recordIncident(db, { title: 'second' });
		await new Promise((r) => setTimeout(r, 15));
		await recordIncident(db, { title: 'third', detail: 'newest' });

		const rows = await listIncidents(db);
		expect(rows.length).toBe(3);
		// Newest first — the ORDER BY at DESC actually sorted (the F-020 idiom-field trap: `at`
		// MUST be in the projection for the DB to sort on it; a real query proves it did).
		expect(rows[0].title).toBe('third');
		expect(rows[2].title).toBe('first');
		expect(new Date(rows[0].at).getTime()).toBeGreaterThanOrEqual(new Date(rows[2].at).getTime());

		const limited = await listIncidents(db, 2);
		expect(limited.length).toBe(2);
		expect(limited[0].title).toBe('third');
	});
});

describe('listUnreadNotifications — read=false filter + empty shadow path', () => {
	it('returns [] when there are no notifications', async () => {
		expect(await listUnreadNotifications(db)).toEqual([]);
	});

	it('returns only unread notifications (a read one is excluded)', async () => {
		await recordNotification(db, 'unread A');
		await recordNotification(db, 'unread B');
		// Flip B to read directly (the read-path only ever reads; the flip is out of band here).
		await db.query('UPDATE notification SET read = true WHERE message = $m;', { m: 'unread B' });

		const unread = await listUnreadNotifications(db);
		const msgs = unread.map((n) => n.message);
		expect(msgs).toContain('unread A');
		expect(msgs).not.toContain('unread B');
		for (const n of unread) expect(n.read).toBe(false);
	});
});
