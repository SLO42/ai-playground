/**
 * SQLite-backed agent analytics store.
 *
 * Replaces the JSON-based store with a proper database for scalability.
 * Uses better-sqlite3 with WAL mode for concurrent reads.
 */
import Database from 'better-sqlite3';
import { resolve } from 'path';
import { mkdirSync, readFileSync, existsSync } from 'fs';
import { PATHS } from '../constants.js';
import type { AgentEvent, AgentAnalytics } from './agent-analytics.js';

// ── DB handle cache ─────────────────────────────────────────────────

const _g = globalThis as Record<string, unknown>;
let cachedDb: Database.Database | null = (_g.__claw_analytics_db as Database.Database | null) ?? null;

const ANALYTICS_JSON_PATH = resolve(PATHS.root, '.playground/agent-analytics.json');

function dbPath(rootPath: string): string {
	return resolve(rootPath, '.playground', 'analytics.db');
}

export function getAnalyticsDb(rootPath?: string): Database.Database {
	if (cachedDb) return cachedDb;

	const root = rootPath ?? PATHS.root;
	const path = dbPath(root);

	mkdirSync(resolve(root, '.playground'), { recursive: true });

	const db = new Database(path);
	db.pragma('journal_mode = WAL');

	db.exec(`
		CREATE TABLE IF NOT EXISTS events (
			id TEXT PRIMARY KEY,
			task_id TEXT,
			task_title TEXT,
			type TEXT NOT NULL,
			timestamp TEXT NOT NULL,
			project_id TEXT,
			data TEXT NOT NULL DEFAULT '{}'
		);
		CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
		CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id);
		CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
		CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id);
		CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events(type, timestamp);
		CREATE INDEX IF NOT EXISTS idx_events_project_type ON events(project_id, type);
		CREATE INDEX IF NOT EXISTS idx_events_task_type ON events(task_id, type);
	`);

	// Retention: keep 90 days of events
	const cutoff90d = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
	const pruned = db.prepare('DELETE FROM events WHERE timestamp < ?').run(cutoff90d);
	if (pruned.changes > 0) console.log(`[analytics] Pruned ${pruned.changes} events older than 90 days`);

	cachedDb = db;
	_g.__claw_analytics_db = db;
	return db;
}

// ── ID generation ───────────────────────────────────────────────────

if (!('__claw_sql_event_counter' in _g)) _g.__claw_sql_event_counter = 0;

// ── Column fields (extracted from AgentEvent into dedicated columns) ─

const COLUMN_FIELDS = new Set(['id', 'taskId', 'taskTitle', 'type', 'timestamp', 'projectId']);

/**
 * Build the JSON `data` blob from an event, excluding column fields.
 */
function extractDataBlob(event: Record<string, unknown>): string {
	const rest: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(event)) {
		if (!COLUMN_FIELDS.has(key) && value !== undefined) {
			rest[key] = value;
		}
	}
	return JSON.stringify(rest);
}

/**
 * Reconstruct a full AgentEvent from a DB row.
 */
function rowToEvent(row: Record<string, unknown>): AgentEvent {
	const data = JSON.parse((row.data as string) || '{}');
	return {
		...data,
		id: row.id as string,
		type: row.type as AgentEvent['type'],
		timestamp: row.timestamp as string,
		...(row.task_id != null ? { taskId: row.task_id as string } : {}),
		...(row.task_title != null ? { taskTitle: row.task_title as string } : {}),
		...(row.project_id != null ? { projectId: row.project_id as string } : {}),
	};
}

// ── Record event ────────────────────────────────────────────────────

export function recordEventSql(event: Omit<AgentEvent, 'id' | 'timestamp'>): void {
	const db = getAnalyticsDb();
	const counter = (_g.__claw_sql_event_counter as number) + 1;
	_g.__claw_sql_event_counter = counter;

	const id = `evt-${Date.now()}-${counter}`;
	const timestamp = new Date().toISOString();
	const taskId = (event as Record<string, unknown>).taskId as string | undefined ?? null;
	const taskTitle = (event as Record<string, unknown>).taskTitle as string | undefined ?? null;
	const projectId = (event as Record<string, unknown>).projectId as string | undefined ?? null;
	const dataBlob = extractDataBlob(event as Record<string, unknown>);

	db.prepare(`
		INSERT INTO events (id, task_id, task_title, type, timestamp, project_id, data)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`).run(id, taskId, taskTitle, event.type, timestamp, projectId, dataBlob);
}

// ── Query analytics ─────────────────────────────────────────────────

interface CompletionRow {
	type: string;
	model: string;
	costUsd: number;
	durationMs: number;
	inputTokens: number;
	outputTokens: number;
	provider: string | null;
	project_id: string | null;
}

export function getAgentAnalyticsSql(): AgentAnalytics {
	const db = getAnalyticsDb();

	// All events (for the events array and recentEvents)
	const allRows = db.prepare('SELECT * FROM events ORDER BY timestamp ASC').all() as Record<string, unknown>[];
	const events = allRows.map(rowToEvent);

	// ── Summary: completed/failed counts, cost, duration ────────────
	const summaryRow = db.prepare(`
		SELECT
			COUNT(*) as total,
			SUM(CASE WHEN type = 'completed' THEN 1 ELSE 0 END) as completed,
			SUM(CASE WHEN type = 'failed' THEN 1 ELSE 0 END) as failed,
			SUM(CASE WHEN type IN ('completed','failed') THEN COALESCE(json_extract(data, '$.costUsd'), 0) ELSE 0 END) as totalCost,
			SUM(CASE WHEN type IN ('completed','failed') THEN COALESCE(json_extract(data, '$.durationMs'), 0) ELSE 0 END) as totalDuration
		FROM events
	`).get() as { total: number; completed: number; failed: number; totalCost: number; totalDuration: number };

	const totalTasks = summaryRow.completed + summaryRow.failed;

	// ── By model ────────────────────────────────────────────────────
	const modelRows = db.prepare(`
		SELECT
			COALESCE(json_extract(data, '$.model'), 'unknown') as model,
			COUNT(*) as count,
			SUM(CASE WHEN type = 'completed' THEN 1 ELSE 0 END) as completedCount,
			SUM(CASE WHEN type = 'failed' THEN 1 ELSE 0 END) as failedCount,
			SUM(COALESCE(json_extract(data, '$.costUsd'), 0)) as totalCost,
			SUM(COALESCE(json_extract(data, '$.durationMs'), 0)) as totalDuration,
			SUM(COALESCE(json_extract(data, '$.inputTokens'), 0)) as totalInput,
			SUM(COALESCE(json_extract(data, '$.outputTokens'), 0)) as totalOutput
		FROM events
		WHERE type IN ('completed', 'failed')
		GROUP BY model
	`).all() as {
		model: string; count: number; completedCount: number; failedCount: number;
		totalCost: number; totalDuration: number; totalInput: number; totalOutput: number;
	}[];

	const byModel: AgentAnalytics['byModel'] = {};
	for (const m of modelRows) {
		const tier = m.model.includes('sonnet') ? 'sonnet' : m.model.includes('opus') ? 'opus' : 'local';
		byModel[m.model] = {
			model: m.model,
			tier,
			count: m.count,
			completedCount: m.completedCount,
			failedCount: m.failedCount,
			totalCost: m.totalCost,
			totalDuration: m.totalDuration,
			avgCost: m.count > 0 ? m.totalCost / m.count : 0,
			avgDuration: m.count > 0 ? m.totalDuration / m.count : 0,
			totalInput: m.totalInput,
			totalOutput: m.totalOutput,
		};
	}

	// ── By route ────────────────────────────────────────────────────
	const classifiedRows = db.prepare(`
		SELECT
			json_extract(data, '$.route') as route,
			COUNT(*) as count
		FROM events
		WHERE type = 'classified'
		GROUP BY route
	`).all() as { route: string | null; count: number }[];

	let openclawCount = 0, ccCount = 0;
	for (const r of classifiedRows) {
		if (r.route === 'openclaw' || r.route === 'openclaw-context') openclawCount += r.count;
		else ccCount += r.count;
	}

	const escalatedRow = db.prepare(`
		SELECT COUNT(*) as count FROM events
		WHERE type = 'escalation_check' AND json_extract(data, '$.escalated') = 1
	`).get() as { count: number };
	const openclawEscalated = escalatedRow.count;

	const contextGatheredRow = db.prepare(`
		SELECT COUNT(*) as count FROM events WHERE type = 'context_gathered'
	`).get() as { count: number };

	const modelSelectedRows = db.prepare(`
		SELECT
			json_extract(data, '$.modelTier') as tier,
			COUNT(*) as count
		FROM events
		WHERE type = 'model_selected'
		GROUP BY tier
	`).all() as { tier: string | null; count: number }[];

	let ccSonnet = 0, ccOpus = 0;
	for (const r of modelSelectedRows) {
		if (r.tier === 'sonnet') ccSonnet += r.count;
		else if (r.tier === 'opus') ccOpus += r.count;
	}

	// Cost by route from completion events
	const routeCostRows = db.prepare(`
		SELECT
			json_extract(data, '$.provider') as provider,
			SUM(COALESCE(json_extract(data, '$.costUsd'), 0)) as totalCost
		FROM events
		WHERE type IN ('completed', 'failed')
		GROUP BY provider
	`).all() as { provider: string | null; totalCost: number }[];

	let openclawCost = 0, ccCost = 0;
	for (const r of routeCostRows) {
		if (r.provider === 'openclaw') openclawCost += r.totalCost;
		else ccCost += r.totalCost;
	}

	// ── Model distribution ──────────────────────────────────────────
	const totalModeled = Object.values(byModel).reduce((s, m) => s + m.count, 0);
	const modelDistribution = Object.values(byModel)
		.map(m => ({
			model: m.model,
			percentage: totalModeled > 0 ? (m.count / totalModeled) * 100 : 0,
			count: m.count,
		}))
		.sort((a, b) => b.count - a.count);

	// ── Timeline (last 24h) ─────────────────────────────────────────
	const h24ago = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
	const timelineRows = db.prepare(`
		SELECT
			substr(timestamp, 1, 13) || ':00' as hour,
			COUNT(*) as eventCount,
			SUM(COALESCE(json_extract(data, '$.costUsd'), 0)) as cost,
			COUNT(DISTINCT task_id) as taskCount
		FROM events
		WHERE timestamp >= ?
		GROUP BY hour
		ORDER BY hour ASC
	`).all(h24ago) as { hour: string; eventCount: number; cost: number; taskCount: number }[];

	const timeline = timelineRows.map(r => ({
		hour: r.hour,
		events: r.eventCount,
		cost: r.cost,
		tasks: r.taskCount,
	}));

	// ── By project ──────────────────────────────────────────────────
	const projectRows = db.prepare(`
		SELECT
			COALESCE(project_id, 'unknown') as projectId,
			COUNT(*) as taskCount,
			SUM(CASE WHEN type = 'completed' THEN 1 ELSE 0 END) as completedCount,
			SUM(CASE WHEN type = 'failed' THEN 1 ELSE 0 END) as failedCount,
			SUM(COALESCE(json_extract(data, '$.costUsd'), 0)) as totalCost,
			SUM(COALESCE(json_extract(data, '$.durationMs'), 0)) as totalDuration
		FROM events
		WHERE type IN ('completed', 'failed')
		GROUP BY projectId
	`).all() as {
		projectId: string; taskCount: number; completedCount: number;
		failedCount: number; totalCost: number; totalDuration: number;
	}[];

	const byProject: AgentAnalytics['byProject'] = {};
	for (const r of projectRows) {
		byProject[r.projectId] = {
			projectId: r.projectId,
			taskCount: r.taskCount,
			completedCount: r.completedCount,
			failedCount: r.failedCount,
			totalCost: r.totalCost,
			totalDuration: r.totalDuration,
		};
	}

	const escalationRate = openclawCount > 0 ? openclawEscalated / openclawCount : 0;

	return {
		events,
		summary: {
			totalTasks,
			completedTasks: summaryRow.completed,
			failedTasks: summaryRow.failed,
			totalCostUsd: summaryRow.totalCost,
			totalDurationMs: summaryRow.totalDuration,
			avgCostPerTask: totalTasks > 0 ? summaryRow.totalCost / totalTasks : 0,
			avgDurationMs: totalTasks > 0 ? summaryRow.totalDuration / totalTasks : 0,
		},
		byModel,
		byRoute: {
			openclaw: {
				count: openclawCount,
				escalated: openclawEscalated,
				completedLocally: openclawCount - openclawEscalated,
				contextGathered: contextGatheredRow.count,
				totalCost: openclawCost,
			},
			claudeCode: {
				count: ccCount,
				sonnet: ccSonnet,
				opus: ccOpus,
				totalCost: ccCost,
			},
		},
		escalationRate,
		modelDistribution,
		timeline,
		recentEvents: events.slice(-50).reverse(),
		byProject,
	};
}

// ── Migration from JSON ─────────────────────────────────────────────

export function migrateFromJson(): { migrated: boolean; count: number } {
	const db = getAnalyticsDb();

	// Only migrate if DB is empty
	const countRow = db.prepare('SELECT COUNT(*) as count FROM events').get() as { count: number };
	if (countRow.count > 0) {
		return { migrated: false, count: 0 };
	}

	// Check if JSON file exists
	if (!existsSync(ANALYTICS_JSON_PATH)) {
		return { migrated: false, count: 0 };
	}

	let jsonEvents: AgentEvent[];
	try {
		const raw = readFileSync(ANALYTICS_JSON_PATH, 'utf-8');
		jsonEvents = JSON.parse(raw) as AgentEvent[];
	} catch {
		return { migrated: false, count: 0 };
	}

	if (!Array.isArray(jsonEvents) || jsonEvents.length === 0) {
		return { migrated: false, count: 0 };
	}

	const insert = db.prepare(`
		INSERT OR IGNORE INTO events (id, task_id, task_title, type, timestamp, project_id, data)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`);

	const migrate = db.transaction(() => {
		for (const event of jsonEvents) {
			const dataBlob = extractDataBlob(event as unknown as Record<string, unknown>);
			insert.run(
				event.id,
				event.taskId ?? null,
				event.taskTitle ?? null,
				event.type,
				event.timestamp,
				event.projectId ?? null,
				dataBlob,
			);
		}
	});

	migrate();
	return { migrated: true, count: jsonEvents.length };
}
