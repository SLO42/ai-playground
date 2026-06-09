// TASK 11.4 — the board-sync CONFIG + incident store (migration 0025; D-016 / F-008).
//
// `board_sync_config` is the per-project, opt-in column mapping for the GitHub project-BOARD
// sync adapter: task-status → board-column NAME, plus the board number, an `enabled` gate,
// and the HONEST last-run status (ok | error) + last_synced + last_error surfaced in the UI.
// One row per project (the project link is UNIQUE — an upsert is a no-dup).
//
// `sync_incident` records a sync FAILURE (never silent, F-008): which adapter/project failed
// and why. The board adapter writes one per failed run so the surface shows an honest error.
//
// Boundary discipline (D-016): the project id passes the db/validate chokepoint and binds as
// StringRecordId; every value binds via $param. Optional fields are OMITTED (option<T> rejects
// NULL); MERGE preserves untouched columns on update. Datetimes are coerced to ISO strings in
// the normalizer (F-013 — SurrealDB 2.x datetime is a non-POJO).

import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';

/** A persisted `board_sync_config` row — one per project (migration 0025). */
export interface BoardSyncConfigRow {
	id: string;
	project: string;
	enabled: boolean;
	boardNumber?: number;
	/** task-status → board-column NAME map (the configurable mapping; per-project opt-in). */
	mapping: Record<string, string>;
	lastSynced?: string;
	lastStatus?: 'ok' | 'error';
	lastError?: string;
	created_at: string;
}

export interface SaveBoardConfigInput {
	project: string;
	enabled: boolean;
	boardNumber?: number;
	mapping: Record<string, string>;
}

/** A recorded sync failure (never-silent — F-008). */
export interface SyncIncidentRow {
	id: string;
	project: string;
	adapter: string;
	message: string;
	at: string;
}

function link(id: string): StringRecordId {
	return new StringRecordId(assertRecordId(id));
}

function normConfig(r: Record<string, unknown>): BoardSyncConfigRow {
	const rawMap = r.mapping;
	const mapping: Record<string, string> = {};
	if (rawMap && typeof rawMap === 'object') {
		for (const [k, v] of Object.entries(rawMap as Record<string, unknown>)) {
			if (typeof v === 'string') mapping[k] = v;
		}
	}
	return {
		id: String(r.id),
		project: String(r.project),
		enabled: r.enabled === true,
		...(r.board_number != null ? { boardNumber: Number(r.board_number) } : {}),
		mapping,
		// F-013: coerce SurrealDB 2.x datetime (non-POJO) to an ISO string for the loader.
		...(r.last_synced != null ? { lastSynced: String(r.last_synced) } : {}),
		...(r.last_status != null ? { lastStatus: String(r.last_status) as 'ok' | 'error' } : {}),
		...(r.last_error != null ? { lastError: String(r.last_error) } : {}),
		created_at: String(r.created_at)
	};
}

function normIncident(r: Record<string, unknown>): SyncIncidentRow {
	return {
		id: String(r.id),
		project: String(r.project),
		adapter: String(r.adapter),
		message: String(r.message),
		at: String(r.at)
	};
}

/** Read a project's board-sync config, or null if none has been saved yet. */
export async function getBoardConfig(
	db: Db,
	projectId: string
): Promise<BoardSyncConfigRow | null> {
	const project = link(projectId);
	const [rows] = await db.query<[Array<Record<string, unknown>>]>(
		`SELECT * FROM board_sync_config WHERE project = $project LIMIT 1;`,
		{ project }
	);
	return rows.length ? normConfig(rows[0]) : null;
}

/**
 * Upsert a project's board-sync config (idempotent by the UNIQUE project index). Preserves
 * the last-run status fields on update (MERGE) so saving the mapping never wipes history.
 */
export async function saveBoardConfig(
	db: Db,
	input: SaveBoardConfigInput
): Promise<BoardSyncConfigRow> {
	const project = link(input.project);
	const [existing] = await db.query<[Array<{ id: unknown }>]>(
		`SELECT id FROM board_sync_config WHERE project = $project LIMIT 1;`,
		{ project }
	);
	if (existing.length) {
		const rid = new StringRecordId(assertRecordId(String(existing[0].id)));
		// SET (not MERGE): MERGE deep-merges the nested `mapping` object, so removed status
		// keys would linger. SET overwrites the field wholesale — the config IS the mapping.
		// board_number is option<int> — bind it only when present (never NULL, §6.1); when
		// absent we UNSET so clearing the field is honest rather than a stale leftover.
		if (input.boardNumber != null) {
			const [rows] = await db.query<[Array<Record<string, unknown>>]>(
				`UPDATE $rid SET enabled = $enabled, board_number = $board, mapping = $mapping RETURN AFTER;`,
				{ rid, enabled: input.enabled, board: input.boardNumber, mapping: input.mapping }
			);
			return normConfig(rows[0]);
		}
		// board_number is option<int>: clear it to NONE (never NULL, §6.1) when absent.
		const [rows] = await db.query<[Array<Record<string, unknown>>]>(
			`UPDATE $rid SET enabled = $enabled, mapping = $mapping, board_number = NONE RETURN AFTER;`,
			{ rid, enabled: input.enabled, mapping: input.mapping }
		);
		return normConfig(rows[0]);
	}
	const content = {
		project,
		enabled: input.enabled,
		...(input.boardNumber != null ? { board_number: input.boardNumber } : {}),
		mapping: input.mapping
	};
	const [rows] = await db.query<[Array<Record<string, unknown>>]>(
		`CREATE board_sync_config CONTENT $content RETURN AFTER;`,
		{ content }
	);
	return normConfig(rows[0]);
}

/** Record the honest result of a board-sync run (ok | error) on the config row. */
export async function recordBoardSyncResult(
	db: Db,
	projectId: string,
	result: { status: 'ok' | 'error'; error?: string }
): Promise<void> {
	const project = link(projectId);
	// last_error is option<string> — NEVER bind NULL (§6.1 rejects NULL). On SUCCESS we UNSET
	// any stale error so the surface shows a clean last-run; on FAILURE we SET the reason.
	if (result.status === 'error') {
		await db.query(
			`UPDATE board_sync_config SET last_synced = $now, last_status = "error", last_error = $err WHERE project = $project;`,
			{ project, now: new Date(), err: result.error ?? 'unknown error' }
		);
	} else {
		// On success: clear any stale error. last_error is option<string> — NONE is the empty
		// state (never NULL); set it to NONE so the surface shows a clean last-run honestly.
		await db.query(
			`UPDATE board_sync_config SET last_synced = $now, last_status = "ok", last_error = NONE WHERE project = $project;`,
			{ project, now: new Date() }
		);
	}
}

/** Record a sync incident (a failure — never silent, F-008). */
export async function recordSyncIncident(
	db: Db,
	input: { project: string; adapter: string; message: string }
): Promise<SyncIncidentRow> {
	const content = {
		project: link(input.project),
		adapter: input.adapter,
		message: input.message
	};
	const [rows] = await db.query<[Array<Record<string, unknown>>]>(
		`CREATE sync_incident CONTENT $content RETURN AFTER;`,
		{ content }
	);
	return normIncident(rows[0]);
}

/** A project's sync incidents, newest first (the honest failure history surface). */
export async function listSyncIncidents(
	db: Db,
	projectId: string,
	limit = 20
): Promise<SyncIncidentRow[]> {
	const project = link(projectId);
	const cap = Math.min(Math.max(limit, 1), 100);
	const [rows] = await db.query<[Array<Record<string, unknown>>]>(
		`SELECT * FROM sync_incident WHERE project = $project ORDER BY at DESC LIMIT ${cap};`,
		{ project }
	);
	return rows.map(normIncident);
}
