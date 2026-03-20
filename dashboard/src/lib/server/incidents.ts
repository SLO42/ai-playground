/**
 * Incident management — tracks CI failures, service crashes, test regressions,
 * build failures, and security alerts. Persists to .playground/incidents.db (SQLite).
 *
 * Migrated from JSON file storage. On first open, any existing incidents.json
 * entries are imported into SQLite automatically.
 */
import Database from 'better-sqlite3';
import { readFileSync, mkdirSync, renameSync } from 'fs';
import { resolve } from 'path';
import crypto from 'crypto';
import { PATHS } from './constants.js';
import { pushNotification } from './notifications.js';

// ── Types ──────────────────────────────────────────────────────────────

export type IncidentType =
	| 'ci_failure'
	| 'service_crash'
	| 'test_regression'
	| 'build_failure'
	| 'security_alert';

export type IncidentSeverity = 'critical' | 'high' | 'medium' | 'low';
export type IncidentStatus = 'open' | 'investigating' | 'resolved';

export interface Incident {
	id: string;
	projectId: string;
	type: IncidentType;
	title: string;
	description: string;
	severity: IncidentSeverity;
	status: IncidentStatus;
	createdAt: string;
	resolvedAt?: string;
	relatedTaskId?: string;
	context: Record<string, unknown>;
}

// ── SQLite Storage ────────────────────────────────────────────────────

const PLAYGROUND_DIR = resolve(PATHS.root, '.playground');
const DB_PATH = resolve(PLAYGROUND_DIR, 'incidents.db');
const JSON_FILE = resolve(PLAYGROUND_DIR, 'incidents.json');

let cachedDb: Database.Database | null = null;

function getDb(): Database.Database {
	if (cachedDb) return cachedDb;

	mkdirSync(PLAYGROUND_DIR, { recursive: true });

	const db = new Database(DB_PATH);
	db.pragma('journal_mode = WAL');

	db.exec(`
		CREATE TABLE IF NOT EXISTS incidents (
			id TEXT PRIMARY KEY,
			type TEXT NOT NULL,
			severity TEXT NOT NULL DEFAULT 'low',
			title TEXT NOT NULL,
			description TEXT,
			status TEXT NOT NULL DEFAULT 'open',
			project_id TEXT,
			created_at TEXT NOT NULL,
			resolved_at TEXT,
			related_task_id TEXT,
			data TEXT DEFAULT '{}'
		);
		CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status);
		CREATE INDEX IF NOT EXISTS idx_incidents_severity ON incidents(severity);
		CREATE INDEX IF NOT EXISTS idx_incidents_created ON incidents(created_at);
	`);

	cachedDb = db;

	// Migrate existing JSON data on first open
	migrateFromJson(db);

	return db;
}

/** Close the DB handle (for cleanup/testing). */
export function closeDb(): void {
	if (cachedDb) {
		cachedDb.close();
		cachedDb = null;
	}
}

// ── Row mapping ───────────────────────────────────────────────────────

function rowToIncident(row: Record<string, unknown>): Incident {
	const incident: Incident = {
		id: row.id as string,
		projectId: (row.project_id as string) ?? '',
		type: row.type as IncidentType,
		title: row.title as string,
		description: (row.description as string) ?? '',
		severity: row.severity as IncidentSeverity,
		status: row.status as IncidentStatus,
		createdAt: row.created_at as string,
		context: {}
	};

	if (row.resolved_at) {
		incident.resolvedAt = row.resolved_at as string;
	}
	if (row.related_task_id) {
		incident.relatedTaskId = row.related_task_id as string;
	}

	try {
		const data = row.data as string;
		if (data && data !== '{}') {
			incident.context = JSON.parse(data);
		}
	} catch {
		// Ignore malformed JSON in data column
	}

	return incident;
}

// ── JSON Migration ────────────────────────────────────────────────────

function migrateFromJson(db: Database.Database): void {
	// Check if we already migrated (table has rows or JSON file doesn't exist)
	const count = (db.prepare('SELECT COUNT(*) as count FROM incidents').get() as { count: number }).count;
	if (count > 0) return;

	let raw: string;
	try {
		raw = readFileSync(JSON_FILE, 'utf-8');
	} catch {
		return; // No JSON file to migrate
	}

	let incidents: Incident[];
	try {
		incidents = JSON.parse(raw) as Incident[];
	} catch {
		return; // Malformed JSON
	}

	if (!Array.isArray(incidents) || incidents.length === 0) return;

	const insert = db.prepare(`
		INSERT OR IGNORE INTO incidents (id, type, severity, title, description, status, project_id, created_at, resolved_at, related_task_id, data)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);

	const batch = db.transaction(() => {
		for (const inc of incidents) {
			insert.run(
				inc.id,
				inc.type,
				inc.severity ?? 'low',
				inc.title,
				inc.description ?? '',
				inc.status ?? 'open',
				inc.projectId ?? null,
				inc.createdAt,
				inc.resolvedAt ?? null,
				inc.relatedTaskId ?? null,
				JSON.stringify(inc.context ?? {})
			);
		}
	});
	batch();

	// Rename JSON file so we don't re-migrate but keep it as backup
	try {
		renameSync(JSON_FILE, JSON_FILE + '.bak');
	} catch {
		// Not critical — table has data now, migration won't re-run
	}
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Create a new incident. Pushes a notification for critical/high severity.
 */
export async function createIncident(
	data: Omit<Incident, 'id' | 'createdAt'>
): Promise<Incident> {
	const db = getDb();
	const id = crypto.randomUUID().slice(0, 12);
	const createdAt = new Date().toISOString();

	db.prepare(`
		INSERT INTO incidents (id, type, severity, title, description, status, project_id, created_at, resolved_at, related_task_id, data)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).run(
		id,
		data.type,
		data.severity ?? 'low',
		data.title,
		data.description ?? '',
		data.status ?? 'open',
		data.projectId ?? null,
		createdAt,
		data.resolvedAt ?? null,
		data.relatedTaskId ?? null,
		JSON.stringify(data.context ?? {})
	);

	const incident: Incident = {
		...data,
		id,
		createdAt
	};

	// Push notification for critical/high severity incidents
	if (incident.severity === 'critical' || incident.severity === 'high') {
		const severityMap = { critical: 'critical', high: 'warning' } as const;
		await pushNotification({
			severity: severityMap[incident.severity],
			category: 'system',
			title: `Incident: ${incident.title}`,
			message: incident.description.slice(0, 200),
			source: `incident:${incident.type}`,
			link: `/incidents`,
			linkLabel: 'View incidents',
			desktop: incident.severity === 'critical'
		}).catch(() => {});
	}

	return incident;
}

/**
 * Resolve an incident by ID.
 */
export async function resolveIncident(id: string): Promise<boolean> {
	const db = getDb();
	const resolvedAt = new Date().toISOString();
	const result = db.prepare(`
		UPDATE incidents SET status = 'resolved', resolved_at = ?
		WHERE id = ? AND status != 'resolved'
	`).run(resolvedAt, id);
	return result.changes > 0;
}

/**
 * Update an incident's status.
 */
export async function updateIncidentStatus(
	id: string,
	status: IncidentStatus
): Promise<boolean> {
	const db = getDb();
	if (status === 'resolved') {
		const resolvedAt = new Date().toISOString();
		const result = db.prepare(`
			UPDATE incidents SET status = ?, resolved_at = ? WHERE id = ?
		`).run(status, resolvedAt, id);
		return result.changes > 0;
	}
	const result = db.prepare(`UPDATE incidents SET status = ? WHERE id = ?`).run(status, id);
	return result.changes > 0;
}

/**
 * List incidents, optionally filtered by projectId. Ordered by created_at DESC.
 */
export async function listIncidents(projectId?: string): Promise<Incident[]> {
	const db = getDb();
	if (projectId) {
		const rows = db.prepare(
			'SELECT * FROM incidents WHERE project_id = ? ORDER BY created_at DESC'
		).all(projectId) as Record<string, unknown>[];
		return rows.map(rowToIncident);
	}
	const rows = db.prepare(
		'SELECT * FROM incidents ORDER BY created_at DESC'
	).all() as Record<string, unknown>[];
	return rows.map(rowToIncident);
}

/**
 * Get all open (non-resolved) incidents.
 */
export async function getOpenIncidents(): Promise<Incident[]> {
	const db = getDb();
	const rows = db.prepare(
		"SELECT * FROM incidents WHERE status != 'resolved' ORDER BY created_at DESC"
	).all() as Record<string, unknown>[];
	return rows.map(rowToIncident);
}

/**
 * Get a single incident by ID.
 */
export async function getIncident(id: string): Promise<Incident | null> {
	const db = getDb();
	const row = db.prepare('SELECT * FROM incidents WHERE id = ?').get(id) as Record<string, unknown> | undefined;
	return row ? rowToIncident(row) : null;
}

/**
 * Count incidents grouped by severity.
 */
export function countBySeverity(): Record<IncidentSeverity, number> {
	const db = getDb();
	const rows = db.prepare(
		'SELECT severity, COUNT(*) as count FROM incidents GROUP BY severity'
	).all() as { severity: IncidentSeverity; count: number }[];

	const result: Record<IncidentSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
	for (const row of rows) {
		result[row.severity] = row.count;
	}
	return result;
}

/**
 * Count incidents grouped by status.
 */
export function countByStatus(): Record<IncidentStatus, number> {
	const db = getDb();
	const rows = db.prepare(
		'SELECT status, COUNT(*) as count FROM incidents GROUP BY status'
	).all() as { status: IncidentStatus; count: number }[];

	const result: Record<IncidentStatus, number> = { open: 0, investigating: 0, resolved: 0 };
	for (const row of rows) {
		result[row.status] = row.count;
	}
	return result;
}
