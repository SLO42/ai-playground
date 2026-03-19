/**
 * PM Memory — SQLite-backed per-project memory for the Project Manager agent.
 *
 * Each project gets its own .playground/pm-memory.db file with:
 * - Structured entries (type, source, confidence, relations)
 * - Full-text search across content
 * - Tiered retrieval: recent "hot" entries + query-based "cold" retrieval
 * - No cap — scales to tens of thousands of entries
 * - Stats tracking (reviews, entry counts by type)
 */
import Database from 'better-sqlite3';
import { resolve } from 'path';
import { mkdirSync } from 'fs';
import type { PMMemoryEntry, PMMemoryQuery, PMMemoryStats, PMMemoryType } from '$lib/types/project-plan.js';

// Cache open DB handles to avoid reopening on every call
const dbCache = new Map<string, Database.Database>();

function dbPath(projectPath: string): string {
	return resolve(projectPath, '.playground', 'pm-memory.db');
}

function getDb(projectPath: string): Database.Database {
	const path = dbPath(projectPath);
	const cached = dbCache.get(path);
	if (cached) return cached;

	// Ensure .playground dir exists
	mkdirSync(resolve(projectPath, '.playground'), { recursive: true });

	const db = new Database(path);
	db.pragma('journal_mode = WAL');
	db.pragma('foreign_keys = ON');

	// Create tables
	db.exec(`
		CREATE TABLE IF NOT EXISTS entries (
			id TEXT PRIMARY KEY,
			type TEXT NOT NULL CHECK(type IN ('observation','learning','risk','pattern','decision-context')),
			content TEXT NOT NULL,
			source TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			related_to TEXT,
			confidence REAL NOT NULL DEFAULT 0.5 CHECK(confidence >= 0 AND confidence <= 1),
			archived INTEGER NOT NULL DEFAULT 0
		);

		CREATE INDEX IF NOT EXISTS idx_entries_type ON entries(type);
		CREATE INDEX IF NOT EXISTS idx_entries_source ON entries(source);
		CREATE INDEX IF NOT EXISTS idx_entries_created ON entries(created_at DESC);
		CREATE INDEX IF NOT EXISTS idx_entries_confidence ON entries(confidence DESC);
		CREATE INDEX IF NOT EXISTS idx_entries_related ON entries(related_to);
		CREATE INDEX IF NOT EXISTS idx_entries_archived ON entries(archived);

		CREATE TABLE IF NOT EXISTS meta (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);
	`);

	// Initialize meta if missing
	const existing = db.prepare('SELECT value FROM meta WHERE key = ?').get('total_reviews') as { value: string } | undefined;
	if (!existing) {
		db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run('total_reviews', '0');
		db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run('last_reviewed_at', '');
		db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run('project_id', resolve(projectPath).split(/[\\/]/).pop() ?? 'unknown');
	}

	dbCache.set(path, db);
	return db;
}

/** Close a project's DB handle (for cleanup). */
export function closeDb(projectPath: string): void {
	const path = dbPath(projectPath);
	const db = dbCache.get(path);
	if (db) {
		db.close();
		dbCache.delete(path);
	}
}

/** Close all open DB handles. */
export function closeAllDbs(): void {
	for (const [path, db] of dbCache) {
		db.close();
		dbCache.delete(path);
	}
}

// ── Write operations ─────────────────────────────────────────────────

function generateId(): string {
	return `pm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

export function addEntry(
	projectPath: string,
	entry: { type: PMMemoryType; content: string; source: string; confidence?: number; relatedTo?: string }
): PMMemoryEntry {
	const db = getDb(projectPath);
	const id = generateId();
	const now = new Date().toISOString();

	db.prepare(`
		INSERT INTO entries (id, type, content, source, created_at, related_to, confidence, archived)
		VALUES (?, ?, ?, ?, ?, ?, ?, 0)
	`).run(id, entry.type, entry.content, entry.source, now, entry.relatedTo ?? null, entry.confidence ?? 0.5);

	return {
		id,
		type: entry.type,
		content: entry.content,
		source: entry.source,
		createdAt: now,
		relatedTo: entry.relatedTo ?? null,
		confidence: entry.confidence ?? 0.5,
		archived: false
	};
}

export function addEntries(
	projectPath: string,
	entries: { type: PMMemoryType; content: string; source: string; confidence?: number; relatedTo?: string }[]
): PMMemoryEntry[] {
	const db = getDb(projectPath);
	const results: PMMemoryEntry[] = [];
	const now = new Date().toISOString();

	const insert = db.prepare(`
		INSERT INTO entries (id, type, content, source, created_at, related_to, confidence, archived)
		VALUES (?, ?, ?, ?, ?, ?, ?, 0)
	`);

	const batch = db.transaction(() => {
		for (const entry of entries) {
			const id = generateId();
			insert.run(id, entry.type, entry.content, entry.source, now, entry.relatedTo ?? null, entry.confidence ?? 0.5);
			results.push({
				id,
				type: entry.type,
				content: entry.content,
				source: entry.source,
				createdAt: now,
				relatedTo: entry.relatedTo ?? null,
				confidence: entry.confidence ?? 0.5,
				archived: false
			});
		}
	});
	batch();

	return results;
}

export function updateEntry(
	projectPath: string,
	id: string,
	updates: Partial<Pick<PMMemoryEntry, 'content' | 'confidence' | 'archived' | 'relatedTo'>>
): boolean {
	const db = getDb(projectPath);
	const sets: string[] = [];
	const values: unknown[] = [];

	if (updates.content !== undefined) { sets.push('content = ?'); values.push(updates.content); }
	if (updates.confidence !== undefined) { sets.push('confidence = ?'); values.push(updates.confidence); }
	if (updates.archived !== undefined) { sets.push('archived = ?'); values.push(updates.archived ? 1 : 0); }
	if (updates.relatedTo !== undefined) { sets.push('related_to = ?'); values.push(updates.relatedTo); }

	if (sets.length === 0) return false;
	values.push(id);

	const result = db.prepare(`UPDATE entries SET ${sets.join(', ')} WHERE id = ?`).run(...values);
	return result.changes > 0;
}

export function archiveOlderThan(projectPath: string, daysOld: number): number {
	const db = getDb(projectPath);
	const cutoff = new Date(Date.now() - daysOld * 86400000).toISOString();
	const result = db.prepare(`
		UPDATE entries SET archived = 1
		WHERE archived = 0 AND created_at < ? AND confidence < 0.7
	`).run(cutoff);
	return result.changes;
}

export function deleteEntry(projectPath: string, id: string): boolean {
	const db = getDb(projectPath);
	const result = db.prepare('DELETE FROM entries WHERE id = ?').run(id);
	return result.changes > 0;
}

// ── Read operations ──────────────────────────────────────────────────

function rowToEntry(row: Record<string, unknown>): PMMemoryEntry {
	return {
		id: row.id as string,
		type: row.type as PMMemoryType,
		content: row.content as string,
		source: row.source as string,
		createdAt: row.created_at as string,
		relatedTo: (row.related_to as string) ?? null,
		confidence: row.confidence as number,
		archived: !!(row.archived as number)
	};
}

export function queryEntries(projectPath: string, query: PMMemoryQuery = {}): PMMemoryEntry[] {
	const db = getDb(projectPath);
	const conditions: string[] = [];
	const params: unknown[] = [];

	if (query.type) { conditions.push('type = ?'); params.push(query.type); }
	if (query.source) { conditions.push('source = ?'); params.push(query.source); }
	if (query.minConfidence !== undefined) { conditions.push('confidence >= ?'); params.push(query.minConfidence); }
	if (query.relatedTo) { conditions.push('related_to = ?'); params.push(query.relatedTo); }
	if (query.archived !== undefined) { conditions.push('archived = ?'); params.push(query.archived ? 1 : 0); }
	if (query.search) { conditions.push('content LIKE ?'); params.push(`%${query.search}%`); }

	const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
	const orderBy = query.orderBy === 'confidence' ? 'confidence DESC, created_at DESC' : 'created_at DESC';
	const limit = query.limit ?? 50;
	const offset = query.offset ?? 0;

	const rows = db.prepare(`
		SELECT * FROM entries ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?
	`).all(...params, limit, offset) as Record<string, unknown>[];

	return rows.map(rowToEntry);
}

/** Get the most recent N entries (hot memory — for agent context). */
export function getRecentEntries(projectPath: string, limit = 20): PMMemoryEntry[] {
	return queryEntries(projectPath, { archived: false, limit, orderBy: 'recent' });
}

/** Get high-confidence entries of a specific type. */
export function getTopEntriesByType(projectPath: string, type: PMMemoryType, limit = 10): PMMemoryEntry[] {
	return queryEntries(projectPath, { type, archived: false, minConfidence: 0.6, limit, orderBy: 'confidence' });
}

/** Get all entries related to a milestone or decision. */
export function getRelatedEntries(projectPath: string, relatedTo: string): PMMemoryEntry[] {
	return queryEntries(projectPath, { relatedTo, limit: 100 });
}

/** Search entries by content keywords. */
export function searchEntries(projectPath: string, searchText: string, limit = 20): PMMemoryEntry[] {
	return queryEntries(projectPath, { search: searchText, limit });
}

// ── Stats & Meta ─────────────────────────────────────────────────────

export function getStats(projectPath: string): PMMemoryStats {
	const db = getDb(projectPath);

	const total = (db.prepare('SELECT COUNT(*) as count FROM entries').get() as { count: number }).count;

	const typeCounts = db.prepare(`
		SELECT type, COUNT(*) as count FROM entries GROUP BY type
	`).all() as { type: PMMemoryType; count: number }[];

	const byType: Record<PMMemoryType, number> = {
		observation: 0, learning: 0, risk: 0, pattern: 0, 'decision-context': 0
	};
	for (const row of typeCounts) {
		byType[row.type] = row.count;
	}

	const oldest = db.prepare('SELECT created_at FROM entries ORDER BY created_at ASC LIMIT 1').get() as { created_at: string } | undefined;
	const newest = db.prepare('SELECT created_at FROM entries ORDER BY created_at DESC LIMIT 1').get() as { created_at: string } | undefined;

	const reviews = db.prepare('SELECT value FROM meta WHERE key = ?').get('total_reviews') as { value: string } | undefined;
	const lastReview = db.prepare('SELECT value FROM meta WHERE key = ?').get('last_reviewed_at') as { value: string } | undefined;

	return {
		totalEntries: total,
		byType,
		oldestEntry: oldest?.created_at ?? null,
		newestEntry: newest?.created_at ?? null,
		totalReviews: parseInt(reviews?.value ?? '0', 10),
		lastReviewedAt: lastReview?.value || null
	};
}

export function recordReview(projectPath: string): void {
	const db = getDb(projectPath);
	const now = new Date().toISOString();
	db.prepare(`UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'total_reviews'`).run();
	db.prepare(`UPDATE meta SET value = ? WHERE key = 'last_reviewed_at'`).run(now);
}

export function getMeta(projectPath: string, key: string): string | null {
	const db = getDb(projectPath);
	const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
	return row?.value ?? null;
}

export function setMeta(projectPath: string, key: string, value: string): void {
	const db = getDb(projectPath);
	db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
}

// ── Context builder for agents ───────────────────────────────────────

/**
 * Build a token-efficient context string for the PM agent.
 * Loads recent entries + high-confidence entries by type.
 * Keeps under ~5K tokens regardless of total DB size.
 */
export function buildAgentContext(projectPath: string): string {
	const recent = getRecentEntries(projectPath, 15);
	const risks = getTopEntriesByType(projectPath, 'risk', 5);
	const decisions = getTopEntriesByType(projectPath, 'decision-context', 5);
	const stats = getStats(projectPath);

	// Deduplicate (recent may overlap with type queries)
	const seen = new Set<string>();
	const all: PMMemoryEntry[] = [];
	for (const entry of [...recent, ...risks, ...decisions]) {
		if (!seen.has(entry.id)) {
			seen.add(entry.id);
			all.push(entry);
		}
	}

	const lines: string[] = [
		`## PM Memory (${stats.totalEntries} total, ${stats.totalReviews} reviews)`,
		''
	];

	if (all.length === 0) {
		lines.push('No memories recorded yet.');
		return lines.join('\n');
	}

	// Group by type for readability
	const grouped = new Map<string, PMMemoryEntry[]>();
	for (const entry of all) {
		if (!grouped.has(entry.type)) grouped.set(entry.type, []);
		grouped.get(entry.type)!.push(entry);
	}

	for (const [type, entries] of grouped) {
		lines.push(`### ${type} (${entries.length})`);
		for (const e of entries.slice(0, 10)) {
			const conf = e.confidence >= 0.8 ? '' : ` [conf: ${e.confidence}]`;
			lines.push(`- ${e.content}${conf}`);
		}
		lines.push('');
	}

	return lines.join('\n');
}
