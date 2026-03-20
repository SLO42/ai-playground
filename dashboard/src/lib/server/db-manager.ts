/**
 * Shared SQLite connection manager — single source for all .playground DB handles.
 * WAL mode, handle caching via globalThis, graceful close.
 */
import Database from 'better-sqlite3';
import { resolve } from 'path';
import { mkdirSync, statSync } from 'fs';
import { PATHS } from './constants.js';

const _g = globalThis as Record<string, unknown>;
const CACHE_KEY = '__claw_db_handles';

function getCache(): Map<string, Database.Database> {
	if (!_g[CACHE_KEY]) _g[CACHE_KEY] = new Map<string, Database.Database>();
	return _g[CACHE_KEY] as Map<string, Database.Database>;
}

/** Known DB names and their file paths */
const DB_PATHS: Record<string, string> = {
	tasks: '.playground/tasks.db',
	analytics: '.playground/analytics.db',
	'routing-telemetry': '.playground/routing-telemetry.db',
	'pid-registry': '.playground/pid-registry.db',
	notifications: '.playground/notifications.db',
	incidents: '.playground/incidents.db',
	'spawn-stats': '.playground/spawn-stats.db',
};

export function getDb(name: string, customPath?: string): Database.Database {
	const cache = getCache();
	const cached = cache.get(name);
	if (cached) return cached;

	const relPath = customPath ?? DB_PATHS[name];
	if (!relPath) throw new Error(`Unknown DB: ${name}. Register it in DB_PATHS or pass customPath.`);

	const fullPath = resolve(PATHS.root, relPath);
	mkdirSync(resolve(fullPath, '..'), { recursive: true });

	const db = new Database(fullPath);
	db.pragma('journal_mode = WAL');
	db.pragma('foreign_keys = ON');

	cache.set(name, db);
	return db;
}

export function closeDb(name: string): void {
	const cache = getCache();
	const db = cache.get(name);
	if (db) {
		db.close();
		cache.delete(name);
	}
}

export function closeAll(): void {
	const cache = getCache();
	for (const [, db] of cache) {
		db.close();
	}
	cache.clear();
}

/** Get sizes of all known DBs for diagnostics */
export function getDbSizes(): { name: string; path: string; sizeBytes: number }[] {
	const results: { name: string; path: string; sizeBytes: number }[] = [];
	for (const [name, relPath] of Object.entries(DB_PATHS)) {
		const fullPath = resolve(PATHS.root, relPath);
		try {
			const stat = statSync(fullPath);
			results.push({ name, path: relPath, sizeBytes: stat.size });
		} catch {
			// DB doesn't exist yet
		}
	}
	return results;
}
