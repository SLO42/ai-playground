// G-C INBOX-LENS VERIFY — the §5b fleet peer_message inbox lens end-to-end against a REAL
// throwaway SurrealDB (D-038 integration vs real DB). Asserts:
//   • STATUS FILTER: pending / delivered / expired / quarantined each return only their rows; the
//     per-status COUNTS rollup is correct over the whole window+scope regardless of the active
//     filter; an absent status reads an explicit 0 (never absent-as-unknown).
//   • SCOPE FILTER: global includes every project's comms; a per-project scope filters to that
//     project's `project` column only.
//   • PAGINATION bound: a page is at most pageSize; nextBefore pages older deterministically with
//     no dup/skip across the boundary; the page is newest-first.
//   • IDENTITY + D-040 PLACEHOLDER: a session/role address carries a concrete recipient
//     (recipientPending:false); a pm/atelier address is honestly recipientPending:true ("awaiting
//     recipient identity") — never a fabricated session.
//   • BODY is read VERBATIM as the already-screened+fenced envelope (D-026 — not unscreened).
//   • SHADOW PATHS: empty inbox (honest empty + all-zero counts); a bad project scope id
//     (fail-loud at the D-016 chokepoint).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { IdentifierError } from '../db/validate';
import { readInbox, DEFAULT_INBOX_PAGE_SIZE } from './inbox';

let tdb: TestDb;
let db: Db;
let seq = 0;

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

// Anchor seed times ~1h ago so every row is inside the default 7-day window; offsets are seconds
// apart, deterministically ordered.
const BASE = Date.now() - 60 * 60 * 1000;
function ts(offsetSec: number): Date {
	return new Date(BASE + offsetSec * 1000);
}

async function freshProject(): Promise<string> {
	const slug = `inb_proj_${++seq}`;
	const [rows] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE type::thing('project', $slug) SET slug = $slug, name = $slug, root_path = "/tmp", status = "active" RETURN id;`,
		{ slug }
	);
	return String(rows[0].id);
}

async function freshRole(): Promise<string> {
	const slug = `inb_role_${++seq}`;
	const [rows] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE type::thing('role', $slug) SET slug = $slug, name = $slug, purpose = "test", status = "active" RETURN id;`,
		{ slug }
	);
	return String(rows[0].id);
}

async function freshSession(project?: string): Promise<string> {
	const set: string[] = [
		`kind = "task"`,
		`status = "running"`,
		`model = { provider: 'claude', model_id: 'claude-test' }`
	];
	const bind: Record<string, unknown> = {};
	if (project) {
		set.push(`project = type::thing('project', $pj)`);
		bind.pj = project.split(':')[1];
	}
	const [rows] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE session SET ${set.join(', ')} RETURN id;`,
		bind
	);
	return String(rows[0].id);
}

interface SeedOpts {
	from: string;
	toKind: 'session' | 'role' | 'pm' | 'atelier';
	toSession?: string;
	toRole?: string;
	project?: string;
	body?: string;
	status?: string;
	hops?: number;
	created_at: Date;
}

async function seedPeer(o: SeedOpts): Promise<string> {
	// peer_seq is stamped per-row: the UNIQUE (from_session, peer_seq) index (m0041) rejects two
	// rows from the SAME sender that both carry peer_seq=NONE — so a seed that sends multiple from
	// one session must assign a distinct seq (the live writer does this AT CREATE inside the budget
	// tx). A global monotonic counter keeps each seed row's (sender, seq) unique.
	const set: string[] = [
		`from_session = type::thing('session', $f)`,
		`to_kind = $tk`,
		`body = $body`,
		`status = $status`,
		`hops = $hops`,
		`peer_seq = $pseq`,
		`created_at = $at`
	];
	const bind: Record<string, unknown> = {
		f: o.from.split(':')[1],
		tk: o.toKind,
		body: o.body ?? '[FENCED] peer note',
		status: o.status ?? 'pending',
		hops: o.hops ?? 1,
		pseq: ++seq,
		at: o.created_at
	};
	if (o.toSession) {
		set.push(`to_session = type::thing('session', $ts)`);
		bind.ts = o.toSession.split(':')[1];
	}
	if (o.toRole) {
		set.push(`to_role = type::thing('role', $tr)`);
		bind.tr = o.toRole.split(':')[1];
	}
	if (o.project) {
		set.push(`project = type::thing('project', $pj)`);
		bind.pj = o.project.split(':')[1];
	}
	const [rows] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE peer_message SET ${set.join(', ')} RETURN id;`,
		bind
	);
	return String(rows[0].id);
}

describe('readInbox — status filter + counts', () => {
	it('filters by status and rolls up per-status counts over the whole scope', async () => {
		const proj = await freshProject();
		const sA = await freshSession(proj);
		const sB = await freshSession(proj);
		const pend = await seedPeer({ from: sA, toKind: 'session', toSession: sB, project: proj, status: 'pending', created_at: ts(10) });
		const del = await seedPeer({ from: sA, toKind: 'session', toSession: sB, project: proj, status: 'delivered', created_at: ts(20) });
		const exp = await seedPeer({ from: sA, toKind: 'session', toSession: sB, project: proj, status: 'expired', created_at: ts(30) });
		const quar = await seedPeer({ from: sA, toKind: 'session', toSession: sB, project: proj, status: 'quarantined', created_at: ts(40) });

		// Filter pending — only the pending row, but counts cover all four.
		const pendPage = await readInbox(db, { scope: { kind: 'project', project: proj }, status: 'pending' });
		expect(pendPage.items.map((i) => i.id)).toEqual([pend]);
		expect(pendPage.status).toBe('pending');
		expect(pendPage.counts).toMatchObject({ pending: 1, delivered: 1, expired: 1, quarantined: 1 });

		// No filter (all) — all four newest-first.
		const allPage = await readInbox(db, { scope: { kind: 'project', project: proj } });
		expect(allPage.status).toBeNull();
		expect(allPage.items.map((i) => i.id)).toEqual([quar, exp, del, pend]);

		// quarantined filter shows only the quarantined row (it is VISIBLE, never dropped).
		const qPage = await readInbox(db, { scope: { kind: 'project', project: proj }, status: 'quarantined' });
		expect(qPage.items.map((i) => i.id)).toEqual([quar]);
	});
});

describe('readInbox — scope filter', () => {
	it('global includes every project; per-project filters to that project only', async () => {
		const projX = await freshProject();
		const projY = await freshProject();
		const sX = await freshSession(projX);
		const sY = await freshSession(projY);
		const inX = await seedPeer({ from: sX, toKind: 'session', toSession: sX, project: projX, created_at: ts(110) });
		const inY = await seedPeer({ from: sY, toKind: 'session', toSession: sY, project: projY, created_at: ts(120) });

		const xPage = await readInbox(db, { scope: { kind: 'project', project: projX } });
		const xIds = xPage.items.map((i) => i.id);
		expect(xIds).toContain(inX);
		expect(xIds).not.toContain(inY);

		const gPage = await readInbox(db, { scope: { kind: 'global' } });
		const gIds = gPage.items.map((i) => i.id);
		expect(gIds).toContain(inX);
		expect(gIds).toContain(inY);
	});
});

describe('readInbox — D-040 recipient placeholder + identity', () => {
	it('session/role addresses carry a concrete recipient; pm/atelier are recipientPending', async () => {
		const proj = await freshProject();
		const role = await freshRole();
		const s = await freshSession(proj);
		const sTo = await freshSession(proj);
		const toRoleId = await seedPeer({ from: s, toKind: 'role', toRole: role, project: proj, created_at: ts(210) });
		const toSessId = await seedPeer({ from: s, toKind: 'session', toSession: sTo, project: proj, created_at: ts(220) });
		const toPmId = await seedPeer({ from: s, toKind: 'pm', project: proj, created_at: ts(230) });
		const toAtelierId = await seedPeer({ from: s, toKind: 'atelier', created_at: ts(240) });

		const page = await readInbox(db, { scope: { kind: 'global' }, pageSize: 200 });
		const byId = new Map(page.items.map((i) => [i.id, i]));

		expect(byId.get(toRoleId)!.recipientPending).toBe(false);
		expect(byId.get(toRoleId)!.toKind).toBe('role');
		expect(byId.get(toSessId)!.recipientPending).toBe(false);
		expect(byId.get(toSessId)!.to).toMatch(/^session /);

		// D-040 placeholder — pm/atelier have no concrete recipient identity yet (honest).
		expect(byId.get(toPmId)!.recipientPending).toBe(true);
		expect(byId.get(toPmId)!.to).toBe('pm');
		expect(byId.get(toAtelierId)!.recipientPending).toBe(true);
		expect(byId.get(toAtelierId)!.to).toBe('atelier');
		expect(byId.get(toAtelierId)!.project).toBe('—'); // project-less address
	});
});

describe('readInbox — body verbatim + age/hops fields', () => {
	it('returns the screened+fenced body verbatim and the hops/timestamps as plain fields', async () => {
		const proj = await freshProject();
		const s = await freshSession(proj);
		const body = '[FENCED] already screened envelope';
		const id = await seedPeer({ from: s, toKind: 'session', toSession: s, project: proj, body, hops: 3, created_at: ts(310) });
		const page = await readInbox(db, { scope: { kind: 'project', project: proj } });
		const it = page.items.find((i) => i.id === id)!;
		expect(it.body).toBe(body); // verbatim — not unscreened, not re-fenced
		expect(it.hops).toBe(3);
		expect(typeof it.createdAt).toBe('string'); // ISO string (F-013)
		expect(it.deliveredAt).toBeNull(); // pending → no delivery stamp → null → '—'
	});
});

describe('readInbox — pagination bound', () => {
	it('caps a page at pageSize and pages older with no dup/skip', async () => {
		const proj = await freshProject();
		const s = await freshSession(proj);
		const ids: string[] = [];
		for (let i = 0; i < 5; i++) {
			ids.push(await seedPeer({ from: s, toKind: 'session', toSession: s, project: proj, created_at: ts(400 + i) }));
		}
		// Newest-first: ids[4] is newest.
		const p1 = await readInbox(db, { scope: { kind: 'project', project: proj }, pageSize: 2 });
		expect(p1.items.length).toBe(2);
		expect(p1.items.map((i) => i.id)).toEqual([ids[4], ids[3]]);
		expect(p1.nextBefore).toBeTruthy();

		const p2 = await readInbox(db, { scope: { kind: 'project', project: proj }, pageSize: 2, before: p1.nextBefore });
		expect(p2.items.map((i) => i.id)).toEqual([ids[2], ids[1]]);

		const p3 = await readInbox(db, { scope: { kind: 'project', project: proj }, pageSize: 2, before: p2.nextBefore });
		expect(p3.items.map((i) => i.id)).toEqual([ids[0]]);
		expect(p3.nextBefore).toBeNull(); // last page

		// No overlap across pages.
		const all = [...p1.items, ...p2.items, ...p3.items].map((i) => i.id);
		expect(new Set(all).size).toBe(all.length);
	});
});

describe('readInbox — shadow paths', () => {
	it('empty inbox → honest empty + all-zero counts', async () => {
		const proj = await freshProject(); // no peer rows for this project
		const page = await readInbox(db, { scope: { kind: 'project', project: proj } });
		expect(page.items).toEqual([]);
		expect(page.nextBefore).toBeNull();
		expect(page.counts).toEqual({ pending: 0, delivered: 0, expired: 0, quarantined: 0 });
	});

	it('a malformed project scope id fails loud at the D-016 chokepoint', async () => {
		await expect(
			readInbox(db, { scope: { kind: 'project', project: 'project:bad id!' } })
		).rejects.toBeInstanceOf(IdentifierError);
	});

	it('default page size is the documented bound', () => {
		expect(DEFAULT_INBOX_PAGE_SIZE).toBe(50);
	});
});
