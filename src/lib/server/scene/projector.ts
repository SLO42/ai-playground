// MEMORY-SCENE-SPEC §5 / §7.1 — the scene_event PROJECTION WRITER + its bus wiring.
//
// What this is (and is NOT):
//   • scene_event is a DERIVED, APPEND-ONLY activity feed (like agent_event) — the
//     "what's happening now" stream that drives the living-brain scene's animation
//     timeline. It is NOT node state (F-008): the node/edge TRUTH still derives LIVE
//     from the source tables (§2/§3); this feed keeps NO denormalized mutable copy.
//   • Every row mirrors a REAL row-change. We NEVER author/fabricate a scene_event —
//     each one is emitted in direct response to a db_change the SSE already observed.
//
// Trigger surface (RAILS — REUSE, do not build a parallel change detector):
//   db-source.ts opens the ONE live query per WATCHED table and republishes each
//   CREATE/UPDATE/DELETE onto the `events` bus as a `db_change`. This projector is
//   just another bus consumer (exactly like the orchestrator + PmTriggerEngine): it
//   subscribes to the SAME bus, never opens its own live query (§2.11 no-double-fire).
//
// v1 emission map (MEMORY-SCENE-SPEC §5; operator fork #2 = MEMORY + USAGE/JOBS only):
//   session   CREATE              → job_fired        (a new job firing)
//   session   UPDATE→terminal     → job_done         (a session ended)
//   work_item CREATE              → job_fired        (a queued job)
//   work_item UPDATE→terminal     → job_done         (a work item finished)
//   memory    CREATE              → memory_added     (a new memory node)
//   entity    CREATE              → node_spawned     (a new knowledge-graph node)
//   references CREATE             → connection_formed (a new graph edge)
//   (node_retired / hire_staffed are in the v1 vocabulary but layered with the
//    hires/ateliers node classes in a later wave — operator fork #2. Reserved.)
//
// HONESTY + SAFETY rails:
//   • DERIVED ONLY (F-008): emit a scene_event ONLY for an action/transition we
//     actually observed; a no-op transition (e.g. a non-terminal UPDATE) emits nothing.
//   • BEST-EFFORT / NON-BLOCKING: a write failure here NEVER crashes the host flow —
//     it is tracked, logged, swallowed. The scene is augmenting, not load-bearing.
//   • D-026: any surfaced meta is screened — a secret in a changed row's surfaced
//     field is redacted, never leaked into the feed (and we surface only a tiny,
//     label-class subset of fields, never raw row content).
//   • ROLLING RETENTION (operator fork #3): the feed is a live window, not an audit
//     log (agent_event already audits). After each append we prune to the newest
//     SCENE_EVENT_CAP rows — bounded, oldest-first, idempotent.
//   • F-014 teardown: stop() tears down the subscription; in-flight appends are
//     tracked so idle()/shutdown can await them.

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import type { BusEvent, EventBus, Unsubscribe } from '../events/bus';
import type { DbChange } from '../events/db-source';
import { screen } from '../memory/screen';

/** The v1 scene_event vocabulary (MEMORY-SCENE-SPEC §5; matches the schema ASSERT).
 *  LIFECYCLE-GRAPH adds three causal-root kinds (m0066): `continue`/`batch_drained` (a
 *  Continue/drain root) + `pm_tick` (a PM re-tick) — emitted by the controls/PM loop, not
 *  the projector's db_change classifier (they are explicit causal markers, not row mirrors).
 *  COMPLETION-LEDGER Wave A adds the HIRE/CERTIFICATION kinds (m0083) — likewise explicit
 *  markers emitted by workforce/hire-events.ts at each decision chokepoint, NOT row mirrors.
 *  `hire_staffed` was in the m0055 vocabulary but never emitted until that wave. */
export type SceneEventKind =
	| 'node_spawned'
	| 'job_fired'
	| 'job_done'
	| 'connection_formed'
	| 'node_retired'
	| 'memory_added'
	| 'hire_staffed'
	| 'continue'
	| 'batch_drained'
	| 'pm_tick'
	| 'candidate_considered'
	| 'hired'
	| 'hire_rejected'
	| 'gauntlet_started'
	| 'gauntlet_scored'
	| 'gauntlet_adjudicated'
	| 'role_reversioned';

/** Input to {@link appendSceneEvent} — a single derived viz event. */
export interface AppendSceneEventInput {
	kind: SceneEventKind;
	/** The record that changed (a free-form ref string, e.g. 'session:abc' / an edge id). */
	ref: string;
	/** The source table the changed row belongs to (the SSE topic). */
	source: string;
	/** Optional owning project record-id string (validated + linked at the D-016 chokepoint). */
	project?: string;
	/** Optional bounded meta — SCREENED here (D-026) before it lands. Never raw row content. */
	meta?: Record<string, unknown>;
}

/** Rolling-window cap: keep only the newest N scene_event rows (operator fork #3). */
export const SCENE_EVENT_CAP = 500;

/** Drop undefined keys so an absent optional is OMITTED, not stored as NONE (§6.1). */
function omitUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
	const out: Partial<T> = {};
	for (const [k, v] of Object.entries(obj)) {
		if (v !== undefined) out[k as keyof T] = v as T[keyof T];
	}
	return out;
}

/**
 * D-026 — screen a bounded meta object before it can land in the feed. Each string
 * VALUE is run through the secret/PII screen; a quarantined value is dropped to a
 * marker (never the raw text), a redacted value keeps its redacted form. Non-string
 * primitives pass through (they cannot carry a secret span); nested objects/arrays are
 * NOT surfaced (we only ever build flat label-class metas) — if one appears it is
 * dropped, fail-closed. Pure + total: never throws, never returns raw secret material.
 */
export function screenSceneMeta(meta: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(meta)) {
		if (v === undefined || v === null) continue;
		if (typeof v === 'string') {
			const r = screen(v);
			// A quarantined value cannot be safely surfaced — keep the screened (redacted)
			// body, but mark it so the feed never implies it is the clean original.
			out[k] = r.status === 'quarantined' ? '[screened]' : r.text;
		} else if (typeof v === 'number' || typeof v === 'boolean') {
			out[k] = v;
		}
		// else: nested object/array — never surfaced into the scene meta (fail-closed).
	}
	return out;
}

/**
 * Write ONE scene_event row (MEMORY-SCENE-SPEC §5). The single chokepoint every
 * emission routes through. The project link passes the D-016 guard + binds as a
 * StringRecordId; meta is D-026-screened; absent optionals are omitted (§6.1). Returns
 * the new row id. This is the LOW-LEVEL writer — callers (the projector) decide WHEN
 * to emit (only on a real, observed row-change), so this function does not itself
 * inspect any source row.
 */
export async function appendSceneEvent(db: Db, input: AppendSceneEventInput): Promise<string> {
	const screenedMeta =
		input.meta && Object.keys(input.meta).length ? screenSceneMeta(input.meta) : undefined;
	const content = omitUndefined({
		kind: input.kind,
		ref: input.ref,
		source: input.source,
		project: input.project ? new StringRecordId(assertRecordId(input.project)) : undefined,
		meta: screenedMeta && Object.keys(screenedMeta).length ? screenedMeta : undefined
	});
	const [rows] = await db.query<[Array<{ id: unknown }>]>(
		`CREATE scene_event CONTENT $content RETURN AFTER;`,
		{ content }
	);
	return String(rows[0].id);
}

/**
 * Prune the scene_event feed to its newest {@link SCENE_EVENT_CAP} rows (operator
 * fork #3: rolling window, not an audit log). Idempotent + bounded: deletes only the
 * rows beyond the cap, oldest first. A prune failure is the caller's to swallow (the
 * feed staying slightly over-cap for one append is harmless). Returns rows deleted.
 */
export async function pruneSceneEvents(db: Db, cap = SCENE_EVENT_CAP): Promise<number> {
	// Select ids of rows beyond the cap (newest CAP kept; everything older is stale).
	// `id` is selected alongside the ORDER BY field (SurrealDB 2.x "Missing order idiom"
	// guard) — we order newest-first, START AT the cap, and delete the remainder.
	const [stale] = await db.query<[Array<{ id: unknown }>]>(
		`SELECT id, at FROM scene_event ORDER BY at DESC START $cap;`,
		{ cap }
	);
	if (!stale.length) return 0;
	const ids = stale.map((r) => new StringRecordId(assertRecordId(String(r.id))));
	await db.query(`DELETE scene_event WHERE id IN $ids;`, { ids });
	return ids.length;
}

// ── The projector (a bus consumer; mirrors PmTriggerEngine's lifecycle) ─────────────

/** Terminal session/work_item statuses → a job_done emission. */
const TERMINAL_STATUSES = new Set(['done', 'failed', 'cancelled', 'completed', 'stopped']);

/** The source tables this projector reacts to (the v1 MEMORY + USAGE/JOBS scope). */
const SCENE_TOPICS = new Set(['session', 'work_item', 'memory', 'entity', 'references']);

export interface SceneProjectorOptions {
	db: Db;
	bus: EventBus;
	/** Rolling-window cap (tests override). */
	cap?: number;
}

export class SceneProjector {
	readonly #db: Db;
	readonly #bus: EventBus;
	readonly #cap: number;

	#unsub?: Unsubscribe;
	#started = false;
	#stopped = false;

	/** In-flight async appends — awaited by idle() (tests + shutdown). */
	readonly #inFlight = new Set<Promise<unknown>>();

	/** scene_events appended this process (diagnostics / verify count). */
	appendCount = 0;

	constructor(opts: SceneProjectorOptions) {
		this.#db = opts.db;
		this.#bus = opts.bus;
		this.#cap = opts.cap ?? SCENE_EVENT_CAP;
	}

	/**
	 * Subscribe to the SAME bus db_change stream the SSE already publishes (RAILS: no
	 * parallel change detector, no own live query). One subscription, filtered to the
	 * v1 source topics. Idempotent — a second start() is a no-op.
	 */
	start(): void {
		if (this.#started || this.#stopped) return;
		this.#started = true;
		this.#unsub = this.#bus.subscribe(
			(e) => {
				this.#track(this.#onBusEvent(e));
			},
			(e) => e.type === 'db_change' && SCENE_TOPICS.has(e.topic)
		);
	}

	/** Tear down the subscription (F-014). Idempotent. */
	stop(): void {
		this.#stopped = true;
		this.#unsub?.();
		this.#unsub = undefined;
		this.#started = false;
	}

	/** Await every in-flight append (tests/shutdown). */
	async idle(): Promise<void> {
		while (this.#inFlight.size > 0) {
			await Promise.allSettled([...this.#inFlight]);
		}
	}

	/** Track a fire-and-forget append so idle() can await it; a failure is logged +
	 *  swallowed — a projection write must NEVER crash the host flow (best-effort). */
	#track(p: Promise<unknown>): void {
		const tracked = p.catch((err) => {
			console.warn(`[scene] projection append failed (host flow unaffected): ${(err as Error).message}`);
		});
		this.#inFlight.add(tracked);
		void tracked.finally(() => this.#inFlight.delete(tracked));
	}

	/**
	 * Map ONE observed db_change to (at most) one derived scene_event. Returns without
	 * emitting for any change that is not one of the v1 transitions — DERIVED ONLY
	 * (F-008): we never invent an event for a change we did not actually classify.
	 */
	async #onBusEvent(e: BusEvent): Promise<void> {
		if (this.#stopped) return;
		const change = e.data as DbChange | undefined;
		if (!change) return;
		// DELETE carries no row body — the v1 emission set is CREATE/terminal-UPDATE driven.
		if (change.action === 'DELETE') return;
		const row = change.result as Record<string, unknown> | null;
		if (!row) return;
		const ref = change.record;
		if (!ref) return;

		const emit = this.#classify(e.topic, change.action, row);
		if (!emit) return;
		await this.#append(emit.kind, ref, e.topic, row, emit.meta);
	}

	/**
	 * Pure classification of an observed change → the scene_event kind to emit (or null
	 * for "no emission"). Exposed-shape kept pure so tests can assert the mapping
	 * without a DB. `meta` is the RAW (pre-screen) label subset; appendSceneEvent screens it.
	 */
	#classify(
		topic: string,
		action: 'CREATE' | 'UPDATE',
		row: Record<string, unknown>
	): { kind: SceneEventKind; meta?: Record<string, unknown> } | null {
		switch (topic) {
			case 'session': {
				if (action === 'CREATE') {
					return { kind: 'job_fired', meta: labelMeta(row, ['status', 'kind']) };
				}
				// UPDATE → job_done only when the row reached a terminal status.
				if (isTerminal(row.status)) {
					return { kind: 'job_done', meta: labelMeta(row, ['status']) };
				}
				return null;
			}
			case 'work_item': {
				if (action === 'CREATE') {
					// work_item is SCHEMAFULL with work_type (schema.ts §446), NOT kind — surface
					// the real job-class label so job_fired isn't reduced to {status} only.
					return { kind: 'job_fired', meta: labelMeta(row, ['status', 'work_type']) };
				}
				if (isTerminal(row.status)) {
					return { kind: 'job_done', meta: labelMeta(row, ['status']) };
				}
				return null;
			}
			case 'memory': {
				if (action === 'CREATE') {
					return { kind: 'memory_added', meta: labelMeta(row, ['kind', 'namespace']) };
				}
				return null;
			}
			case 'entity': {
				if (action === 'CREATE') {
					// entity is SCHEMAFULL with label/type/project/status (schema.ts §294-299) —
					// NOT kind/name. Surface the real label fields so node_spawned carries an
					// identifying label in production (regression: the headline MEMORY node-class).
					return { kind: 'node_spawned', meta: labelMeta(row, ['label', 'type']) };
				}
				return null;
			}
			case 'references': {
				// A new graph edge (RELATION CREATE) draws a connection in the scene.
				if (action === 'CREATE') {
					return { kind: 'connection_formed', meta: labelMeta(row, ['kind']) };
				}
				return null;
			}
			default:
				return null;
		}
	}

	/** Append one derived event, then roll the window. project is lifted off the changed
	 *  row when present (so a per-atelier lens can filter). Best-effort: errors propagate
	 *  to #track which swallows them — the host flow is never affected. */
	async #append(
		kind: SceneEventKind,
		ref: string,
		source: string,
		row: Record<string, unknown>,
		meta?: Record<string, unknown>
	): Promise<void> {
		const project = projectRef(row.project);
		await appendSceneEvent(this.#db, {
			kind,
			ref,
			source,
			...(project ? { project } : {}),
			...(meta && Object.keys(meta).length ? { meta } : {})
		});
		this.appendCount++;
		// Roll the window AFTER the append (rolling retention). A prune hiccup must not
		// fail the append we just made — swallow it (the feed self-corrects next append).
		try {
			await pruneSceneEvents(this.#db, this.#cap);
		} catch (err) {
			console.warn(`[scene] retention prune failed (feed stays bounded next append): ${(err as Error).message}`);
		}
	}
}

/** Pull a small, flat label subset off a changed row (never raw content). undefined
 *  values are dropped; the result is screened downstream (D-026). */
function labelMeta(row: Record<string, unknown>, fields: string[]): Record<string, unknown> | undefined {
	const out: Record<string, unknown> = {};
	for (const f of fields) {
		const v = row[f];
		if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[f] = v;
	}
	return Object.keys(out).length ? out : undefined;
}

/** A terminal session/work_item status → emit job_done. */
function isTerminal(status: unknown): boolean {
	return typeof status === 'string' && TERMINAL_STATUSES.has(status);
}

/** Coerce a changed row's `project` field to a record-id string, or undefined. */
function projectRef(project: unknown): string | undefined {
	if (project == null) return undefined;
	const s = String(project);
	return s.includes(':') ? s : undefined;
}
