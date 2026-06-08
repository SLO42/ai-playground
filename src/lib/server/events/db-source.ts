// server/events — db live-query → bus republisher (TASK 0.d; ARCHITECTURE §2.11).
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

import type { Db, LiveMessage } from '../db/client';
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

/** A handle to one open live query. {@link stop} kills it on the server. */
export interface DbSourceHandle {
	table: string;
	stop: () => Promise<void>;
}

function idToString(record: unknown): string {
	if (record == null) return '';
	return typeof record === 'string' ? record : String(record);
}

/**
 * Open ONE SurrealDB live query on `table` and republish every row change onto the
 * `events` bus as a single `db_change` event. Returns a handle whose `stop()` kills
 * the live query. This is the only sanctioned place a live query is opened (§2.11).
 *
 * `table` is validated (D-016) here and again inside `db.liveTable`.
 */
export async function watchTable(db: Db, bus: EventBus, table: string): Promise<DbSourceHandle> {
	const t = assertTableName(table);
	const sub = await db.liveTable(t);

	const off = sub.subscribe((msg: LiveMessage) => {
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
	});

	return {
		table: t,
		stop: async () => {
			off();
			await sub.kill().catch(() => {});
		}
	};
}
