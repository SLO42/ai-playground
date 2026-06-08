// TASK 3.5 — incident + notification repo (db-backed; DATA-MODEL §4.7, D-016).
//
// THIS module owns the persistence + read path for `incident` and `notification`
// (the operational surface for the services manager). DATA-MODEL §4.7:
//   incident      { title, detail?, severity in info|warn|error|critical, at }
//   notification  { message, read, at }
// These are operational rows — NOT knowledge (D-015 soft-archive does not apply;
// they are append-only operational facts and may be purged by the GC path later).
//
// Boundary discipline (D-016): every VALUE binds via $param — never interpolated.
// Optional `detail` is OMITTED when absent so the `option<string>` column stays NONE
// rather than being rejected as NULL (§6.1). The DEFAULTs (severity, at, read) fire
// in the SCHEMAFULL definition, so we only send the fields we mean to set.

import type { Db } from '../db/client';

export type IncidentSeverity = 'info' | 'warn' | 'error' | 'critical';

/** A persisted `incident` row (SDK RecordId/Date coerced to plain JSON). */
export interface IncidentRow {
	id: string;
	title: string;
	detail?: string;
	severity: IncidentSeverity;
	at: string;
}

/** A persisted `notification` row (SDK RecordId/Date coerced to plain JSON). */
export interface NotificationRow {
	id: string;
	message: string;
	read: boolean;
	at: string;
}

/** Input for {@link recordIncident}. */
export interface IncidentInput {
	title: string;
	detail?: string;
	severity?: IncidentSeverity;
}

function normIncident(row: { id: unknown; title: string; detail?: unknown; severity: IncidentSeverity; at: unknown }): IncidentRow {
	return {
		id: String(row.id),
		title: row.title,
		detail: row.detail != null ? String(row.detail) : undefined,
		severity: row.severity,
		at: row.at != null ? String(row.at) : ''
	};
}

function normNotification(row: { id: unknown; message: string; read: boolean; at: unknown }): NotificationRow {
	return {
		id: String(row.id),
		message: row.message,
		read: Boolean(row.read),
		at: row.at != null ? String(row.at) : ''
	};
}

/**
 * Write one `incident` row. `detail` is omitted when absent (§6.1); severity defaults
 * to "info" via the schema DEFAULT when not supplied. Returns the persisted row.
 */
export async function recordIncident(db: Db, input: IncidentInput): Promise<IncidentRow> {
	const content: Record<string, unknown> = { title: input.title };
	if (input.detail !== undefined) content.detail = input.detail;
	if (input.severity !== undefined) content.severity = input.severity;

	const [created] = await db.query<[IncidentRow[]]>(
		'CREATE incident CONTENT $content;',
		{ content }
	);
	return normIncident(created[0] as never);
}

/** Write one `notification` row (defaults: read=false, at=now). */
export async function recordNotification(db: Db, message: string): Promise<NotificationRow> {
	const [created] = await db.query<[NotificationRow[]]>(
		'CREATE notification CONTENT $content;',
		{ content: { message } }
	);
	return normNotification(created[0] as never);
}

/** Recent incidents, newest first (for the operational surface). */
export async function listIncidents(db: Db, limit = 50): Promise<IncidentRow[]> {
	const [rows] = await db.query<[IncidentRow[]]>(
		'SELECT * FROM incident ORDER BY at DESC LIMIT $limit;',
		{ limit }
	);
	return (rows ?? []).map((r) => normIncident(r as never));
}

/** Unread notifications, newest first. */
export async function listUnreadNotifications(db: Db, limit = 50): Promise<NotificationRow[]> {
	const [rows] = await db.query<[NotificationRow[]]>(
		'SELECT * FROM notification WHERE read = false ORDER BY at DESC LIMIT $limit;',
		{ limit }
	);
	return (rows ?? []).map((r) => normNotification(r as never));
}
