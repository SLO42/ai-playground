// server/events — db live-query → bus republisher (TASK 0.d; ARCHITECTURE §2.11)
// + established-LIVE-subscription auth-expiry self-heal (F-042 family).
//
// `db` is the SOLE owner of SurrealDB live queries. This module opens a live query
// per watched table and republishes each CREATE/UPDATE/DELETE onto the `events`
// bus as a single `db_change` event. NOTHING else in the codebase may open a live
// query for state it can get from the bus — that is the double-fire trap (§2.11):
// a change must reach a subscriber EXACTLY ONCE, via the bus, not also via a
// second direct live query.
//
// surrealdb 2.x delivers each notification as { queryId, action, recordId, value }
// where action ∈ CREATE|UPDATE|DELETE|KILLED. We map it to a BusEvent
//   { type:'db_change', topic: table, key: recordId, data: { action, record, result } }.
// `key = recordId` lets the SSE layer coalesce rapid UPDATEs to one row latest-wins
// under backpressure.
//
// ── F-042 (established-subscription gap) ────────────────────────────────────────
// `db.liveTable()` self-heals only the SETUP query (LIVE SELECT). Once a subscription
// is ESTABLISHED and the singleton's token lapses, the SDK's UnmanagedLiveSubscription
// stops receiving notifications and its async iterator simply COMPLETES — the
// `.subscribe()` handler is never called again and NO error reaches us (verified in
// surrealdb 2.x: ConnectionController.liveQuery() cancels the channel on the WS
// 'disconnected'/session-drop, so the iterator ends silently). With the SSE heartbeat
// still flushing, the browser shows the region as live while it is actually frozen —
// STALE-SHOWN-AS-LIVE (F-008). So we drive the subscription via its ASYNC ITERATOR
// (not `.subscribe()`), which lets us observe both a throw AND an unexpected
// completion as the death signal, then heal:
//   1. emit live_status 'reconnecting' for the table (honest: NOT live right now),
//   2. probe auth via db.probeAuth() — routes through the query-path self-heal, which
//      de-dupes ONE reauthenticate() across all tables (the existing in-flight promise;
//      we do NOT duplicate the re-auth logic, RAILS),
//   3. on a healthy probe, re-open the LIVE SELECT + re-attach the loop, emit 'live';
//   4. on a failed probe / failed re-subscribe, emit live_status 'disconnected' and
//      STOP — no spin, no infinite retry. A later genuine recovery comes from a fresh
//      boot or a future change re-establishing watchers; we never silently show stale.
// Each death gets AT MOST one reconnect attempt (bounded); concurrent deaths across
// tables share the single in-flight reauth inside db.probeAuth (no stampede).

import type { Db, LiveMessage, LiveTableSubscription } from '../db/client';
import { isDisconnectError } from '../db/classify';
import { assertTableName } from '../db/validate';
import type { BusEvent, EventBus } from './bus';

/** Payload carried on a `db_change` bus event. */
export interface DbChange {
	action: 'CREATE' | 'UPDATE' | 'DELETE';
	/** The record id as a string (e.g. 'thing:abc'). */
	record: string;
	/** Row contents for CREATE/UPDATE; null when the server omits it (e.g. DELETE). */
	result: unknown;
}

/** Health phase of a watched table's LIVE subscription (F-042). */
export type LiveStatusPhase = 'live' | 'reconnecting' | 'disconnected';

/** Payload carried on a `live_status` bus event — honest per-table liveness (F-008). */
export interface LiveStatus {
	/** Health phase: live (receiving), reconnecting (re-establishing), disconnected (gave up). */
	phase: LiveStatusPhase;
	/** Why we are not live, when known (for honest UI/logs). Never carries creds (D-026). */
	reason?: string;
}

/** A handle to one open live query. {@link stop} kills it on the server. */
export interface DbSourceHandle {
	table: string;
	stop: () => Promise<void>;
}

function idToString(record: unknown): string {
	if (record == null) return '';
	return typeof record === 'string' ? record : String(record);
}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err ?? '');
}

/**
 * Open ONE SurrealDB live query on `table` and republish every row change onto the
 * `events` bus as a single `db_change` event. Returns a handle whose `stop()` kills
 * the live query. This is the only sanctioned place a live query is opened (§2.11).
 *
 * The subscription self-heals on auth-expiry (F-042): if the ESTABLISHED stream dies
 * silently because the singleton's token lapsed, we re-establish it ONCE via the
 * de-duped query-path reauth and resume; on persistent failure we publish an honest
 * `live_status` 'disconnected' so consumers never present stale rows as live (F-008).
 *
 * `table` is validated (D-016) here and again inside `db.liveTable`.
 */
export async function watchTable(db: Db, bus: EventBus, table: string): Promise<DbSourceHandle> {
	const t = assertTableName(table);

	// Lifecycle flags shared across reconnect generations.
	let stopped = false; // set by stop() — an intentional kill is NOT a death to heal
	let current: LiveTableSubscription | null = null; // the live SDK subscription handle
	let unsubscribe: (() => void) | null = null; // detaches the current iterator loop

	const publishChange = (msg: LiveMessage): void => {
		// KILLED is a lifecycle signal, not a row change — never republish it.
		if (msg.action === 'KILLED') return;
		const change: DbChange = {
			action: msg.action,
			record: idToString(msg.recordId),
			result: msg.value ?? null
		};
		const event: BusEvent<DbChange> = {
			type: 'db_change',
			topic: t,
			key: change.record || undefined, // coalesce repeated UPDATEs to one row
			data: change
		};
		bus.publish(event);
	};

	const publishStatus = (phase: LiveStatusPhase, reason?: string): void => {
		const event: BusEvent<LiveStatus> = {
			type: 'live_status',
			topic: t,
			data: reason ? { phase, reason } : { phase }
		};
		bus.publish(event);
	};

	/**
	 * Attach a death-observing loop to `sub`. Resolves (and clears `unsubscribe`) when
	 * the subscription ends — either an intentional stop()/kill (no heal) or a silent/
	 * thrown death (→ heal()). We drive the ASYNC ITERATOR directly so an unexpected
	 * COMPLETION (the F-042 silent-death shape) is observable, not only a throw.
	 */
	const attach = (sub: LiveTableSubscription): void => {
		let detached = false;
		unsubscribe = () => {
			detached = true;
		};
		void (async () => {
			let deathErr: unknown = undefined;
			try {
				for await (const msg of sub) {
					if (detached || stopped) return;
					publishChange(msg);
				}
			} catch (err) {
				// A thrown death (e.g. LiveSubscriptionError). Captured, classified in heal().
				deathErr = err;
			}
			// Iterator ENDED. If we tore it down on purpose, stop here — no heal.
			if (detached || stopped) return;
			// Unexpected death of an ESTABLISHED subscription → attempt ONE bounded heal.
			await heal(deathErr);
		})();
	};

	/**
	 * Bounded, single-attempt reconnect after an unexpected death (F-042). De-duped
	 * reauth happens inside db.probeAuth(); here we attempt ONE re-establish. Never
	 * loops — on failure we publish honest 'disconnected' and stay down (no spin).
	 */
	const heal = async (deathErr: unknown): Promise<void> => {
		if (stopped) return;
		// Honest: this region is NOT live while we try to re-establish.
		publishStatus('reconnecting', deathErr ? errMessage(deathErr) : 'live subscription ended');

		// A death whose captured error is a genuine connection loss can't be auth-healed —
		// surface it honestly without a pointless reauth probe (it would just re-throw).
		if (deathErr !== undefined && isDisconnectError(deathErr)) {
			publishStatus('disconnected', errMessage(deathErr));
			return;
		}

		try {
			// Probe auth through the query-path self-heal: a lapsed token transparently
			// triggers the ONE de-duped reauthenticate() (shared in-flight promise); a
			// genuine auth/connection failure throws here and we go honestly down.
			await db.probeAuth();
		} catch (probeErr) {
			if (stopped) return;
			publishStatus('disconnected', errMessage(probeErr));
			return;
		}
		if (stopped) return;

		// Auth is healthy again — re-establish the LIVE SELECT and re-attach the loop.
		try {
			const next = await db.liveTable(t);
			if (stopped) {
				await next.kill().catch(() => {});
				return;
			}
			current = next;
			attach(next);
			publishStatus('live');
		} catch (resubErr) {
			if (stopped) return;
			// Re-subscribe failed even though auth probed healthy (e.g. socket dropped in
			// the gap). Honest down — bounded, no retry loop. Name the cause.
			const phaseReason = errMessage(resubErr);
			publishStatus('disconnected', phaseReason);
		}
	};

	// Open the initial subscription. liveTable() already self-heals the SETUP query.
	const sub = await db.liveTable(t);
	current = sub;
	attach(sub);

	return {
		table: t,
		stop: async () => {
			stopped = true;
			unsubscribe?.();
			const handle = current;
			current = null;
			await handle?.kill().catch(() => {});
		}
	};
}
