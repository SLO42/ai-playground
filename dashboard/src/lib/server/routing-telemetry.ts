import { dirname, resolve } from 'path';
import { mkdirSync, readFileSync } from 'fs';
import Database from 'better-sqlite3';
import { PATHS } from './constants.js';

// ── Types ──────────────────────────────────────────────────────────────

export interface RoutingDecision {
	id: string;
	timestamp: string;
	model: string;
	provider: string;
	agent: string;
	taskType: string;
	complexity: number;
	latencyMs: number;
	success: boolean;
	source: string;
	reason?: string;
	sessionId?: string;
}

export interface RoutingStats {
	totalDecisions: number;
	successRate: number;
	avgLatencyMs: number;
	byModel: Record<string, ModelStats>;
	byAgent: Record<string, AgentStats>;
	byTaskType: Record<string, TaskTypeStats>;
	recentDecisions: RoutingDecision[];
	hourlyActivity: HourlyBucket[];
}

export interface ModelStats {
	model: string;
	provider: string;
	count: number;
	successRate: number;
	avgLatencyMs: number;
	avgComplexity: number;
	costEstimate: number;
}

export interface AgentStats {
	agent: string;
	count: number;
	successRate: number;
	avgLatencyMs: number;
	taskTypes: string[];
}

export interface TaskTypeStats {
	taskType: string;
	count: number;
	preferredAgent: string;
	avgComplexity: number;
	successRate: number;
}

export interface HourlyBucket {
	hour: string;
	count: number;
	successRate: number;
}

export interface WorkflowStep {
	agent: string;
	model: string;
	provider: string;
	taskType: string;
	complexity: number;
	latencyMs: number;
	success: boolean;
}

export interface WorkflowChain {
	sessionId: string;
	source: string;
	steps: WorkflowStep[];
	totalLatencyMs: number;
	escalated: boolean;
	startTime: string;
}

export interface SourceStats {
	source: string;
	count: number;
	successRate: number;
	avgLatencyMs: number;
	escalationRate: number;
	topAgents: { agent: string; count: number }[];
	topTaskTypes: { taskType: string; count: number }[];
}

export interface ChainPattern {
	pattern: string[];        // agent names in order
	count: number;
	successRate: number;
	avgLatencyMs: number;
	escalationRate: number;
	sources: { source: string; count: number }[];
}

export interface AgentRoutingProfile {
	agent: string;
	totalRouted: number;
	asFirst: number;          // times this agent started a chain
	asLast: number;           // times this agent ended a chain
	escalatedFrom: number;    // times work was escalated FROM this agent
	escalatedTo: number;      // times work was escalated TO this agent
	avgComplexityHandled: number;
	modelsUsed: { model: string; count: number }[];
	taskTypes: { taskType: string; count: number }[];
	successRate: number;
	avgLatencyMs: number;
}

export interface WorkflowStats {
	bySource: Record<string, SourceStats>;
	recentWorkflows: WorkflowChain[];
	escalationRate: number;
	avgChainLength: number;
	clawInitiated: number;
	userInitiated: number;
	chainPatterns: ChainPattern[];
	agentProfiles: Record<string, AgentRoutingProfile>;
}

// ── SQLite Storage ────────────────────────────────────────────────────

const DB_PATH = resolve(dirname(PATHS.routingLog), 'routing-telemetry.db');

let _db: Database.Database | null = null;

function getDb(): Database.Database {
	if (_db) return _db;

	mkdirSync(dirname(DB_PATH), { recursive: true });

	const db = new Database(DB_PATH);
	db.pragma('journal_mode = WAL');

	db.exec(`
		CREATE TABLE IF NOT EXISTS decisions (
			id TEXT PRIMARY KEY,
			timestamp TEXT NOT NULL,
			model TEXT NOT NULL DEFAULT '',
			provider TEXT NOT NULL DEFAULT '',
			agent TEXT NOT NULL DEFAULT '',
			task_type TEXT NOT NULL DEFAULT '',
			complexity REAL NOT NULL DEFAULT 0,
			latency_ms REAL NOT NULL DEFAULT 0,
			success INTEGER NOT NULL DEFAULT 0,
			source TEXT NOT NULL DEFAULT '',
			reason TEXT,
			session_id TEXT
		);
		CREATE INDEX IF NOT EXISTS idx_decisions_timestamp ON decisions(timestamp);
		CREATE INDEX IF NOT EXISTS idx_decisions_model ON decisions(model);
		CREATE INDEX IF NOT EXISTS idx_decisions_agent ON decisions(agent);
		CREATE INDEX IF NOT EXISTS idx_decisions_source ON decisions(source);
		CREATE INDEX IF NOT EXISTS idx_decisions_session ON decisions(session_id);
		CREATE INDEX IF NOT EXISTS idx_decisions_session_ts ON decisions(session_id, timestamp);
		CREATE INDEX IF NOT EXISTS idx_decisions_tasktype_agent ON decisions(task_type, agent);
	`);

	// Retention: keep 30 days of routing decisions
	const cutoff30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
	const pruned = db.prepare('DELETE FROM decisions WHERE timestamp < ?').run(cutoff30d);
	if (pruned.changes > 0) console.log(`[routing] Pruned ${pruned.changes} decisions older than 30 days`);

	_db = db;

	// Migrate existing JSON data on first open
	migrateFromJson(db);

	return db;
}

// ── Prepared statements (lazy) ────────────────────────────────────────

let _insertStmt: Database.Statement | null = null;

function getInsertStmt(): Database.Statement {
	if (_insertStmt) return _insertStmt;
	_insertStmt = getDb().prepare(`
		INSERT OR IGNORE INTO decisions
			(id, timestamp, model, provider, agent, task_type, complexity, latency_ms, success, source, reason, session_id)
		VALUES
			(@id, @timestamp, @model, @provider, @agent, @taskType, @complexity, @latencyMs, @success, @source, @reason, @sessionId)
	`);
	return _insertStmt;
}

// ── JSON migration ────────────────────────────────────────────────────

function migrateFromJson(db: Database.Database): void {
	// Check if migration already done by seeing if we have any rows
	const count = db.prepare('SELECT COUNT(*) as c FROM decisions').get() as { c: number };
	if (count.c > 0) return;

	let entries: RoutingDecision[];
	try {
		const raw = readFileSync(PATHS.routingLog, 'utf-8');
		entries = JSON.parse(raw) as RoutingDecision[];
	} catch {
		return; // No JSON file or parse error — nothing to migrate
	}

	if (entries.length === 0) return;

	const insert = db.prepare(`
		INSERT OR IGNORE INTO decisions
			(id, timestamp, model, provider, agent, task_type, complexity, latency_ms, success, source, reason, session_id)
		VALUES
			(@id, @timestamp, @model, @provider, @agent, @taskType, @complexity, @latencyMs, @success, @source, @reason, @sessionId)
	`);

	const migrate = db.transaction((rows: RoutingDecision[]) => {
		for (const d of rows) {
			insert.run({
				id: d.id,
				timestamp: d.timestamp,
				model: d.model ?? '',
				provider: d.provider ?? '',
				agent: d.agent ?? '',
				taskType: d.taskType ?? '',
				complexity: d.complexity ?? 0,
				latencyMs: d.latencyMs ?? 0,
				success: d.success ? 1 : 0,
				source: d.source ?? '',
				reason: d.reason ?? null,
				sessionId: d.sessionId ?? null
			});
		}
	});

	migrate(entries);
}

// ── Row → RoutingDecision mapper ──────────────────────────────────────

interface DecisionRow {
	id: string;
	timestamp: string;
	model: string;
	provider: string;
	agent: string;
	task_type: string;
	complexity: number;
	latency_ms: number;
	success: number;
	source: string;
	reason: string | null;
	session_id: string | null;
}

function rowToDecision(row: DecisionRow): RoutingDecision {
	return {
		id: row.id,
		timestamp: row.timestamp,
		model: row.model,
		provider: row.provider,
		agent: row.agent,
		taskType: row.task_type,
		complexity: row.complexity,
		latencyMs: row.latency_ms,
		success: row.success === 1,
		source: row.source,
		reason: row.reason ?? undefined,
		sessionId: row.session_id ?? undefined
	};
}

// ── Cost estimation (per 1K tokens, approximate) ───────────────────────

const COST_PER_REQUEST: Record<string, number> = {
	'gpt-oss:20b': 0,
	'gpt-oss': 0,
	'ollama': 0,
	'claude-code': 0.01,
	'claude-sonnet-4-6': 0.003,
	'claude-haiku-4-5-20251001': 0.0002
};

function estimateCost(model: string): number {
	for (const [key, cost] of Object.entries(COST_PER_REQUEST)) {
		if (model.includes(key)) return cost;
	}
	return 0;
}

// ── Public API ─────────────────────────────────────────────────────────

export async function logRoutingDecision(opts: {
	model: string;
	provider: string;
	agent: string;
	taskType: string;
	complexity: number;
	latencyMs: number;
	success: boolean;
	source: string;
	reason?: string;
	sessionId?: string;
}): Promise<RoutingDecision> {
	const entry: RoutingDecision = {
		id: crypto.randomUUID().slice(0, 10),
		timestamp: new Date().toISOString(),
		...opts
	};

	// SQLite is the primary store — no JSON write-through
	getInsertStmt().run({
		id: entry.id,
		timestamp: entry.timestamp,
		model: entry.model,
		provider: entry.provider,
		agent: entry.agent,
		taskType: entry.taskType,
		complexity: entry.complexity,
		latencyMs: entry.latencyMs,
		success: entry.success ? 1 : 0,
		source: entry.source,
		reason: entry.reason ?? null,
		sessionId: entry.sessionId ?? null
	});

	return entry;
}

export async function getRoutingStats(): Promise<RoutingStats> {
	const db = getDb();

	// Global aggregates
	const totals = db.prepare(`
		SELECT
			COUNT(*) as total,
			SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successes,
			AVG(latency_ms) as avg_latency
		FROM decisions
	`).get() as { total: number; successes: number; avg_latency: number | null };

	const totalDecisions = totals.total;
	const successRate = totalDecisions > 0 ? totals.successes / totalDecisions : 0;
	const avgLatencyMs = totals.avg_latency ?? 0;

	// By model
	const modelRows = db.prepare(`
		SELECT
			model,
			provider,
			COUNT(*) as count,
			AVG(CASE WHEN success = 1 THEN 1.0 ELSE 0.0 END) as success_rate,
			AVG(latency_ms) as avg_latency,
			AVG(complexity) as avg_complexity
		FROM decisions
		GROUP BY model
	`).all() as { model: string; provider: string; count: number; success_rate: number; avg_latency: number; avg_complexity: number }[];

	const byModel: Record<string, ModelStats> = {};
	for (const r of modelRows) {
		byModel[r.model] = {
			model: r.model,
			provider: r.provider,
			count: r.count,
			successRate: r.success_rate,
			avgLatencyMs: r.avg_latency,
			avgComplexity: r.avg_complexity,
			costEstimate: estimateCost(r.model) * r.count
		};
	}

	// By agent
	const agentRows = db.prepare(`
		SELECT
			agent,
			COUNT(*) as count,
			AVG(CASE WHEN success = 1 THEN 1.0 ELSE 0.0 END) as success_rate,
			AVG(latency_ms) as avg_latency,
			GROUP_CONCAT(DISTINCT task_type) as task_types
		FROM decisions
		GROUP BY agent
	`).all() as { agent: string; count: number; success_rate: number; avg_latency: number; task_types: string | null }[];

	const byAgent: Record<string, AgentStats> = {};
	for (const r of agentRows) {
		byAgent[r.agent] = {
			agent: r.agent,
			count: r.count,
			successRate: r.success_rate,
			avgLatencyMs: r.avg_latency,
			taskTypes: r.task_types ? r.task_types.split(',') : []
		};
	}

	// By task type (with preferred agent via subquery)
	const taskRows = db.prepare(`
		SELECT
			task_type,
			COUNT(*) as count,
			AVG(complexity) as avg_complexity,
			AVG(CASE WHEN success = 1 THEN 1.0 ELSE 0.0 END) as success_rate,
			(
				SELECT agent FROM decisions d2
				WHERE d2.task_type = decisions.task_type
				GROUP BY agent ORDER BY COUNT(*) DESC LIMIT 1
			) as preferred_agent
		FROM decisions
		GROUP BY task_type
	`).all() as { task_type: string; count: number; avg_complexity: number; success_rate: number; preferred_agent: string | null }[];

	const byTaskType: Record<string, TaskTypeStats> = {};
	for (const r of taskRows) {
		byTaskType[r.task_type] = {
			taskType: r.task_type,
			count: r.count,
			preferredAgent: r.preferred_agent ?? '',
			avgComplexity: r.avg_complexity,
			successRate: r.success_rate
		};
	}

	// Hourly activity (last 24 hours)
	const now = Date.now();
	const hourlyActivity: HourlyBucket[] = [];
	for (let h = 23; h >= 0; h--) {
		const hourStart = new Date(now - (h + 1) * 3600_000).toISOString();
		const hourEnd = new Date(now - h * 3600_000).toISOString();
		const bucket = db.prepare(`
			SELECT
				COUNT(*) as count,
				SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successes
			FROM decisions
			WHERE timestamp >= ? AND timestamp < ?
		`).get(hourStart, hourEnd) as { count: number; successes: number };

		const hourLabel = new Date(now - h * 3600_000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
		hourlyActivity.push({
			hour: hourLabel,
			count: bucket.count,
			successRate: bucket.count > 0 ? bucket.successes / bucket.count : 0
		});
	}

	// Recent decisions
	const recentRows = db.prepare(`
		SELECT * FROM decisions ORDER BY timestamp DESC LIMIT 20
	`).all() as DecisionRow[];

	return {
		totalDecisions,
		successRate,
		avgLatencyMs,
		byModel,
		byAgent,
		byTaskType,
		recentDecisions: recentRows.map(rowToDecision),
		hourlyActivity
	};
}

export async function getRecentDecisions(limit = 20): Promise<RoutingDecision[]> {
	const rows = getDb().prepare(`
		SELECT * FROM decisions ORDER BY timestamp DESC LIMIT ?
	`).all(limit) as DecisionRow[];
	return rows.map(rowToDecision);
}

export async function getWorkflowStats(): Promise<WorkflowStats> {
	const db = getDb();

	// Load all decisions from SQLite
	const allRows = db.prepare(`
		SELECT * FROM decisions ORDER BY timestamp ASC
	`).all() as DecisionRow[];
	const log = allRows.map(rowToDecision);

	// Group decisions by sessionId to form workflow chains
	const sessionMap = new Map<string, RoutingDecision[]>();
	const noSession: RoutingDecision[] = [];

	for (const d of log) {
		if (d.sessionId) {
			const arr = sessionMap.get(d.sessionId) ?? [];
			arr.push(d);
			sessionMap.set(d.sessionId, arr);
		} else {
			noSession.push(d);
		}
	}

	// Build workflow chains from sessions
	const workflows: WorkflowChain[] = [];
	for (const [sessionId, decisions] of sessionMap) {
		const sorted = decisions.sort((a, b) =>
			new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
		);
		const steps: WorkflowStep[] = sorted.map((d) => ({
			agent: d.agent,
			model: d.model,
			provider: d.provider,
			taskType: d.taskType,
			complexity: d.complexity,
			latencyMs: d.latencyMs,
			success: d.success
		}));

		const providers = new Set(sorted.map((d) => d.provider));
		const escalated = providers.size > 1 || sorted.some((d) => d.complexity > 0.3 && d.provider !== 'internal');

		workflows.push({
			sessionId,
			source: sorted[0].source,
			steps,
			totalLatencyMs: sorted.reduce((sum, d) => sum + d.latencyMs, 0),
			escalated,
			startTime: sorted[0].timestamp
		});
	}

	// Also create single-step "workflows" for non-session decisions
	for (const d of noSession) {
		workflows.push({
			sessionId: d.id,
			source: d.source,
			steps: [{
				agent: d.agent,
				model: d.model,
				provider: d.provider,
				taskType: d.taskType,
				complexity: d.complexity,
				latencyMs: d.latencyMs,
				success: d.success
			}],
			totalLatencyMs: d.latencyMs,
			escalated: false,
			startTime: d.timestamp
		});
	}

	// Sort by most recent
	workflows.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());

	// By source stats
	const bySource: Record<string, SourceStats> = {};
	for (const wf of workflows) {
		const src = wf.source || 'unknown';
		if (!bySource[src]) {
			bySource[src] = {
				source: src,
				count: 0,
				successRate: 0,
				avgLatencyMs: 0,
				escalationRate: 0,
				topAgents: [],
				topTaskTypes: []
			};
		}
		const s = bySource[src];
		s.count++;
		s.avgLatencyMs += wf.totalLatencyMs;
		if (wf.escalated) s.escalationRate++;
		const allSuccess = wf.steps.every((st) => st.success);
		if (allSuccess) s.successRate++;
	}

	for (const s of Object.values(bySource)) {
		if (s.count > 0) {
			s.avgLatencyMs /= s.count;
			s.successRate /= s.count;
			s.escalationRate /= s.count;
		}

		// Compute top agents and task types from all decisions for this source
		const agentCounts: Record<string, number> = {};
		const taskCounts: Record<string, number> = {};
		for (const wf of workflows) {
			if ((wf.source || 'unknown') !== s.source) continue;
			for (const step of wf.steps) {
				agentCounts[step.agent] = (agentCounts[step.agent] ?? 0) + 1;
				taskCounts[step.taskType] = (taskCounts[step.taskType] ?? 0) + 1;
			}
		}
		s.topAgents = Object.entries(agentCounts)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 5)
			.map(([agent, count]) => ({ agent, count }));
		s.topTaskTypes = Object.entries(taskCounts)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 5)
			.map(([taskType, count]) => ({ taskType, count }));
	}

	const escalatedCount = workflows.filter((w) => w.escalated).length;
	const totalChainSteps = workflows.reduce((sum, w) => sum + w.steps.length, 0);

	// ── Chain pattern analysis ─────────────────────────────────────────
	const patternMap = new Map<string, { count: number; successes: number; latencySum: number; escalations: number; sourceCounts: Record<string, number> }>();
	for (const wf of workflows) {
		if (wf.steps.length === 0) continue;
		const key = wf.steps.map((s) => s.agent).join(' \u2192 ');
		const entry = patternMap.get(key) ?? { count: 0, successes: 0, latencySum: 0, escalations: 0, sourceCounts: {} };
		entry.count++;
		if (wf.steps.every((s) => s.success)) entry.successes++;
		entry.latencySum += wf.totalLatencyMs;
		if (wf.escalated) entry.escalations++;
		entry.sourceCounts[wf.source] = (entry.sourceCounts[wf.source] ?? 0) + 1;
		patternMap.set(key, entry);
	}

	const chainPatterns: ChainPattern[] = [...patternMap.entries()]
		.map(([key, v]) => ({
			pattern: key.split(' \u2192 '),
			count: v.count,
			successRate: v.count > 0 ? v.successes / v.count : 0,
			avgLatencyMs: v.count > 0 ? v.latencySum / v.count : 0,
			escalationRate: v.count > 0 ? v.escalations / v.count : 0,
			sources: Object.entries(v.sourceCounts)
				.sort((a, b) => b[1] - a[1])
				.map(([source, count]) => ({ source, count }))
		}))
		.sort((a, b) => b.count - a.count)
		.slice(0, 15);

	// ── Agent routing profiles ─────────────────────────────────────────
	const agentProfiles: Record<string, AgentRoutingProfile> = {};

	function ensureProfile(agent: string): AgentRoutingProfile {
		if (!agentProfiles[agent]) {
			agentProfiles[agent] = {
				agent,
				totalRouted: 0,
				asFirst: 0,
				asLast: 0,
				escalatedFrom: 0,
				escalatedTo: 0,
				avgComplexityHandled: 0,
				modelsUsed: [],
				taskTypes: [],
				successRate: 0,
				avgLatencyMs: 0
			};
		}
		return agentProfiles[agent];
	}

	const agentModelCounts: Record<string, Record<string, number>> = {};
	const agentTaskCounts: Record<string, Record<string, number>> = {};

	for (const wf of workflows) {
		for (let i = 0; i < wf.steps.length; i++) {
			const step = wf.steps[i];
			const p = ensureProfile(step.agent);
			p.totalRouted++;
			p.avgComplexityHandled += step.complexity;
			p.avgLatencyMs += step.latencyMs;
			if (step.success) p.successRate++;

			if (i === 0) p.asFirst++;
			if (i === wf.steps.length - 1) p.asLast++;

			// Escalation tracking: if next step uses a different provider, this agent escalated
			if (i < wf.steps.length - 1 && wf.steps[i + 1].provider !== step.provider) {
				p.escalatedFrom++;
				const nextP = ensureProfile(wf.steps[i + 1].agent);
				nextP.escalatedTo++;
			}

			// Model and task type tracking
			if (!agentModelCounts[step.agent]) agentModelCounts[step.agent] = {};
			agentModelCounts[step.agent][step.model] = (agentModelCounts[step.agent][step.model] ?? 0) + 1;

			if (!agentTaskCounts[step.agent]) agentTaskCounts[step.agent] = {};
			agentTaskCounts[step.agent][step.taskType] = (agentTaskCounts[step.agent][step.taskType] ?? 0) + 1;
		}
	}

	for (const p of Object.values(agentProfiles)) {
		if (p.totalRouted > 0) {
			p.avgComplexityHandled /= p.totalRouted;
			p.avgLatencyMs /= p.totalRouted;
			p.successRate /= p.totalRouted;
		}
		p.modelsUsed = Object.entries(agentModelCounts[p.agent] ?? {})
			.sort((a, b) => b[1] - a[1])
			.map(([model, count]) => ({ model, count }));
		p.taskTypes = Object.entries(agentTaskCounts[p.agent] ?? {})
			.sort((a, b) => b[1] - a[1])
			.map(([taskType, count]) => ({ taskType, count }));
	}

	return {
		bySource,
		recentWorkflows: workflows.slice(0, 10),
		escalationRate: workflows.length > 0 ? escalatedCount / workflows.length : 0,
		avgChainLength: workflows.length > 0 ? totalChainSteps / workflows.length : 0,
		clawInitiated: workflows.filter((w) => w.source === 'claw').length,
		userInitiated: workflows.filter((w) => w.source === 'user').length,
		chainPatterns,
		agentProfiles
	};
}
