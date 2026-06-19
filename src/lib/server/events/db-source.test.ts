import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Db, type LiveMessage, type LiveTableSubscription } from '../db/client';
import { startTestDb, type TestDb } from '../db/testserver';
import { EventBus, type BusEvent } from './bus';
import { SseClient } from './sse';
import { watchTable, type DbChange, type LiveStatus } from './db-source';

// TASK 0.d VERIFY (ARCHITECTURE §2.11): a DB change emits EXACTLY ONE SSE event to
// a subscriber — assert NO double-fire. This proves the bus is the single source:
// db owns the one live query → republishes to `events` → the SSE client off the bus
// sees the change once, not twice.

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
	await db.query(`
		DEFINE TABLE thing SCHEMAFULL;
		DEFINE FIELD label ON thing TYPE string;
	`);
}, 60_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

/** Wait until `predicate()` is true or time out (live events are async). */
async function waitFor(predicate: () => boolean, ms = 4000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > ms) throw new Error('timeout waiting for live event');
		await new Promise((r) => setTimeout(r, 25));
	}
	// settle: give any *extra* (erroneous) events a chance to arrive so a
	// double-fire would be caught rather than missed by racing the assertion.
	await new Promise((r) => setTimeout(r, 150));
}

describe('db-source — one DB change → exactly one SSE event (no double-fire)', () => {
	it('a CREATE republishes to the bus and reaches a per-client SSE subscriber once', async () => {
		const bus = new EventBus();
		const seen: BusEvent[] = [];
		bus.subscribe((e) => seen.push(e));

		const handle = await watchTable(db, bus, 'thing');
		try {
			await db.query('CREATE thing SET label = $l;', { l: 'alpha' });
			await waitFor(() => seen.length >= 1);

			// EXACTLY ONE event — the double-fire assertion.
			expect(seen).toHaveLength(1);
			const e = seen[0];
			expect(e.type).toBe('db_change');
			expect(e.topic).toBe('thing');
			const change = e.data as DbChange;
			expect(change.action).toBe('CREATE');
			expect(change.record).toMatch(/^thing:/);
			expect((change.result as { label?: string })?.label).toBe('alpha');
		} finally {
			await handle.stop();
		}
	});

	it('exactly one live query owns the change — an SSE client off the bus sees it once', async () => {
		const bus = new EventBus();
		const client = SseClient.from(bus, { filter: (e) => e.topic === 'thing' });

		const handle = await watchTable(db, bus, 'thing');
		try {
			await db.query('CREATE thing SET label = $l;', { l: 'beta' });
			await waitFor(() => client.queued >= 1);
			// No second copy from any other live query — strictly one queued frame.
			expect(client.queued).toBe(1);
		} finally {
			await handle.stop();
			client.close();
		}
	});

	it('UPDATE and DELETE each republish once with the right action', async () => {
		const bus = new EventBus();
		const seen: DbChange[] = [];
		bus.subscribe((e) => seen.push(e.data as DbChange));

		const handle = await watchTable(db, bus, 'thing');
		try {
			const created = await db.query<[{ id: unknown }[]]>('CREATE thing SET label = $l;', {
				l: 'gamma'
			});
			const id = created[0][0].id;
			await db.query('UPDATE $id SET label = $l;', { id, l: 'gamma2' });
			await db.query('DELETE $id;', { id });

			await waitFor(() => seen.filter((c) => c.action === 'DELETE').length >= 1);

			const actions = seen.map((c) => c.action);
			// Exactly one of each — no duplicates from a second live query.
			expect(actions.filter((a) => a === 'CREATE')).toHaveLength(1);
			expect(actions.filter((a) => a === 'UPDATE')).toHaveLength(1);
			expect(actions.filter((a) => a === 'DELETE')).toHaveLength(1);
		} finally {
			await handle.stop();
		}
	});

	it('after stop(), further DB changes do NOT reach the bus', async () => {
		const bus = new EventBus();
		const seen: BusEvent[] = [];
		bus.subscribe((e) => seen.push(e));

		const handle = await watchTable(db, bus, 'thing');
		await handle.stop();

		await db.query('CREATE thing SET label = $l;', { l: 'after-stop' });
		// Give a generous window; nothing should arrive.
		await new Promise((r) => setTimeout(r, 400));
		expect(seen).toHaveLength(0);
	});
});

// ── F-042 established-subscription self-heal ────────────────────────────────────
// The real SDK's silent-death of an ESTABLISHED LIVE subscription on token lapse
// (the gap) cannot be forced without a token TTL elapsing AND a WS-level drop, so we
// drive the watcher with a CONTROLLABLE fake Db + subscription. This exercises the
// exact heal seam: an unexpected iterator end/throw → ONE de-duped reauth probe +
// ONE re-subscribe, honest live_status, no stampede, no spin. (The live query-path
// reauth itself is covered against real SurrealDB in db/client.test.ts.)

/** A fake live subscription whose iterator we can end or throw on command. */
class FakeSub implements LiveTableSubscription {
	#resolve: ((r: IteratorResult<LiveMessage>) => void) | null = null;
	#reject: ((e: unknown) => void) | null = null;
	#pending: LiveMessage[] = [];
	#ended = false;
	#throw: unknown = undefined;
	killed = false;
	gen: number;
	constructor(gen: number) {
		this.gen = gen;
	}
	#clearWaiter(): void {
		this.#resolve = null;
		this.#reject = null;
	}
	/** Push one row notification to the live iterator. */
	emit(msg: LiveMessage): void {
		if (this.#resolve) {
			const r = this.#resolve;
			this.#clearWaiter();
			r({ value: msg, done: false });
		} else {
			this.#pending.push(msg);
		}
	}
	/** End the iterator SILENTLY (the F-042 death shape — no error). */
	die(): void {
		this.#ended = true;
		const r = this.#resolve;
		this.#clearWaiter();
		r?.({ value: undefined as unknown as LiveMessage, done: true });
	}
	/** End the iterator by THROWING (e.g. a LiveSubscriptionError death). */
	fail(err: unknown): void {
		this.#throw = err;
		this.#ended = true;
		const rej = this.#reject;
		this.#clearWaiter();
		// Reject a waiting next() so the for-await loop throws this exact error.
		rej?.(err);
	}
	subscribe(): () => void {
		throw new Error('events layer must drive the iterator, not subscribe()');
	}
	async kill(): Promise<void> {
		this.killed = true;
		this.die();
	}
	#next(): Promise<IteratorResult<LiveMessage>> {
		if (this.#pending.length > 0) {
			return Promise.resolve({ value: this.#pending.shift()!, done: false });
		}
		if (this.#throw !== undefined) {
			const e = this.#throw;
			this.#throw = undefined;
			return Promise.reject(e);
		}
		if (this.#ended) {
			return Promise.resolve({ value: undefined as unknown as LiveMessage, done: true });
		}
		return new Promise<IteratorResult<LiveMessage>>((res, rej) => {
			this.#resolve = res;
			this.#reject = rej;
		});
	}
	[Symbol.asyncIterator](): AsyncIterator<LiveMessage> {
		return { next: () => this.#next() };
	}
}

interface FakeDbController {
	db: Db;
	subs: FakeSub[];
	latest: () => FakeSub;
	probeCalls: number;
	liveCalls: number;
	/** Make the NEXT probeAuth reject (simulates a failed reauth → honest disconnected). */
	failNextProbe: (err: unknown) => void;
	/** Make the NEXT liveTable re-subscribe reject. */
	failNextLive: (err: unknown) => void;
}

/** Build a fake Db that hands out FakeSubs and counts probe/live calls. */
function makeFakeDb(): FakeDbController {
	const ctl = {
		subs: [] as FakeSub[],
		probeCalls: 0,
		liveCalls: 0,
		latest: () => ctl.subs[ctl.subs.length - 1],
		failNextProbe: (e: unknown) => {
			probeErr = e;
		},
		failNextLive: (e: unknown) => {
			liveErr = e;
		}
	} as FakeDbController;
	let probeErr: unknown = undefined;
	let liveErr: unknown = undefined;
	const fake = {
		async liveTable(): Promise<LiveTableSubscription> {
			ctl.liveCalls++;
			if (liveErr !== undefined) {
				const e = liveErr;
				liveErr = undefined;
				throw e;
			}
			const sub = new FakeSub(ctl.subs.length);
			ctl.subs.push(sub);
			return sub;
		},
		async probeAuth(): Promise<void> {
			ctl.probeCalls++;
			if (probeErr !== undefined) {
				const e = probeErr;
				probeErr = undefined;
				throw e;
			}
		}
	};
	ctl.db = fake as unknown as Db;
	return ctl;
}

function statusFrames(seen: BusEvent[]): LiveStatus[] {
	return seen.filter((e) => e.type === 'live_status').map((e) => e.data as LiveStatus);
}

async function tick(ms = 30): Promise<void> {
	await new Promise((r) => setTimeout(r, ms));
}

describe('db-source — established-subscription auth-expiry self-heal (F-042)', () => {
	it('a SILENT death re-establishes via ONE reauth probe + ONE re-subscribe, emits live again', async () => {
		const ctl = makeFakeDb();
		const bus = new EventBus();
		const seen: BusEvent[] = [];
		bus.subscribe((e) => seen.push(e));

		const handle = await watchTable(ctl.db, bus, 'thing');
		await tick();
		expect(ctl.subs.length).toBe(1);

		// Established subscription dies silently (token lapsed, WS session dropped).
		ctl.subs[0].die();
		await tick(60);

		// Exactly ONE reauth probe and ONE re-subscribe — bounded, no stampede/loop.
		expect(ctl.probeCalls).toBe(1);
		expect(ctl.liveCalls).toBe(2); // initial + one re-establish
		const phases = statusFrames(seen).map((s) => s.phase);
		expect(phases).toEqual(['reconnecting', 'live']);

		// The re-established (gen-1) subscription genuinely carries row changes again.
		ctl.latest().emit({ queryId: 'q', action: 'CREATE', recordId: 'thing:reborn', value: { label: 'x' } });
		await tick();
		const changes = seen.filter((e) => e.type === 'db_change').map((e) => e.data as DbChange);
		expect(changes.at(-1)?.record).toBe('thing:reborn');

		await handle.stop();
	});

	it('a genuine NON-auth (connection-loss) death surfaces honest disconnected, NO reauth probe', async () => {
		const ctl = makeFakeDb();
		const bus = new EventBus();
		const seen: BusEvent[] = [];
		bus.subscribe((e) => seen.push(e));

		const handle = await watchTable(ctl.db, bus, 'thing');
		await tick();

		// Death THROWS a connection-loss error (not auth-expiry) — must not be healed.
		ctl.subs[0].fail(new Error('connection closed: socket hang up'));
		await tick(60);

		expect(ctl.probeCalls).toBe(0); // never tried to reauth a dead socket
		expect(ctl.liveCalls).toBe(1); // no re-subscribe
		const phases = statusFrames(seen).map((s) => s.phase);
		expect(phases).toEqual(['reconnecting', 'disconnected']);

		await handle.stop();
	});

	it('a FAILED reauth probe → honest disconnected, bounded (no re-subscribe, no spin)', async () => {
		const ctl = makeFakeDb();
		const bus = new EventBus();
		const seen: BusEvent[] = [];
		bus.subscribe((e) => seen.push(e));

		const handle = await watchTable(ctl.db, bus, 'thing');
		await tick();

		ctl.failNextProbe(new Error('IAM error: Not enough permissions'));
		ctl.subs[0].die();
		await tick(60);

		expect(ctl.probeCalls).toBe(1);
		expect(ctl.liveCalls).toBe(1); // probe failed → never re-subscribed
		const phases = statusFrames(seen).map((s) => s.phase);
		expect(phases).toEqual(['reconnecting', 'disconnected']);
		// No spin: give it more time, nothing else fires.
		await tick(80);
		expect(ctl.probeCalls).toBe(1);

		await handle.stop();
	});

	it('a re-subscribe failure after a HEALTHY probe → honest disconnected, no loop', async () => {
		const ctl = makeFakeDb();
		const bus = new EventBus();
		const seen: BusEvent[] = [];
		bus.subscribe((e) => seen.push(e));

		const handle = await watchTable(ctl.db, bus, 'thing');
		await tick();

		ctl.failNextLive(new Error('LIVE SELECT failed: lost connection'));
		ctl.subs[0].die();
		await tick(60);

		expect(ctl.probeCalls).toBe(1); // auth probed healthy…
		expect(ctl.liveCalls).toBe(2); // …re-subscribe attempted once and threw
		const phases = statusFrames(seen).map((s) => s.phase);
		expect(phases).toEqual(['reconnecting', 'disconnected']);

		await handle.stop();
	});

	it('an intentional stop() does NOT trigger a heal (no reconnecting/reauth)', async () => {
		const ctl = makeFakeDb();
		const bus = new EventBus();
		const seen: BusEvent[] = [];
		bus.subscribe((e) => seen.push(e));

		const handle = await watchTable(ctl.db, bus, 'thing');
		await tick();
		await handle.stop(); // kills the sub → iterator ends, but intentionally
		await tick(60);

		expect(ctl.probeCalls).toBe(0);
		expect(statusFrames(seen)).toHaveLength(0); // no honest-status churn on a clean stop
		expect(ctl.subs[0].killed).toBe(true);
	});

	it('concurrent deaths on multiple tables share ONE in-flight reauth (no stampede)', async () => {
		// Two watchers over ONE shared fake Db whose probeAuth de-dupes via an in-flight
		// promise — mirrors db.probeAuth → the single reauthenticate() promise. We assert
		// the probe BODY runs once for two simultaneous deaths.
		let inFlight: Promise<void> | null = null;
		let bodyRuns = 0;
		const ctl = makeFakeDb();
		const realProbe = (ctl.db as unknown as { probeAuth: () => Promise<void> }).probeAuth.bind(ctl.db);
		(ctl.db as unknown as { probeAuth: () => Promise<void> }).probeAuth = () => {
			if (inFlight) return inFlight;
			inFlight = (async () => {
				bodyRuns++;
				await realProbe();
			})().finally(() => {
				inFlight = null;
			});
			return inFlight;
		};

		const bus = new EventBus();
		const seen: BusEvent[] = [];
		bus.subscribe((e) => seen.push(e));

		const hA = await watchTable(ctl.db, bus, 'thing');
		const hB = await watchTable(ctl.db, bus, 'project');
		await tick();
		expect(ctl.subs.length).toBe(2);

		// Both established subscriptions die in the same tick.
		ctl.subs[0].die();
		ctl.subs[1].die();
		await tick(60);

		// One shared in-flight reauth body for both deaths — no N-signin stampede.
		expect(bodyRuns).toBe(1);
		// Both tables re-established and report live again.
		const live = statusFrames(seen).filter((s) => s.phase === 'live');
		expect(live.length).toBe(2);

		await hA.stop();
		await hB.stop();
	});
});
