/**
 * PID Registry — persistent tracking of all child processes spawned by the dashboard.
 *
 * Solves the orphaned-process problem: if the server crashes, HMR reloads, or
 * shutdown fails to kill everything, the registry survives on disk.
 * On next startup, `reapStaleProcesses()` reads the DB and kills anything
 * still running from the previous session.
 *
 * Store: .playground/pid-registry.db (SQLite, WAL mode)
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { mkdirSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { resolve } from 'path';
import { PATHS } from '../constants.js';

const execFileAsync = promisify(execFile);

const DB_PATH = resolve(PATHS.root, '.playground/pid-registry.db');
const JSON_PATH = resolve(PATHS.root, '.playground/pid-registry.json');
const IS_WINDOWS = process.platform === 'win32';

export interface PidEntry {
	pid: number;
	label: string;          // human-readable: "agent:task-123", "mcp:claude-flow", etc.
	spawnedAt: string;
	category: 'agent' | 'mcp' | 'test' | 'service';
}

// ── DB handle (cached, singleton) ────────────────────────────────────

let _db: Database.Database | null = null;

function getDb(): Database.Database {
	if (_db) return _db;

	// Ensure .playground dir exists
	mkdirSync(resolve(PATHS.root, '.playground'), { recursive: true });

	const db = new Database(DB_PATH);
	db.pragma('journal_mode = WAL');

	db.exec(`
		CREATE TABLE IF NOT EXISTS processes (
			pid INTEGER NOT NULL,
			label TEXT NOT NULL,
			command TEXT,
			spawned_at TEXT NOT NULL,
			exited_at TEXT,
			exit_code INTEGER,
			PRIMARY KEY (pid, label)
		);
		CREATE INDEX IF NOT EXISTS idx_processes_label ON processes(label);

		CREATE TABLE IF NOT EXISTS meta (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);
	`);

	_db = db;

	// Run one-time migration from JSON
	migrateFromJson();

	return db;
}

/** Close the DB handle (for cleanup / shutdown). */
export function closeDb(): void {
	if (_db) {
		_db.close();
		_db = null;
	}
}

// ── JSON migration (runs once at first open) ─────────────────────────

function migrateFromJson(): void {
	try {
		const raw = readFileSync(JSON_PATH, 'utf-8');
		const data = JSON.parse(raw) as {
			serverPid?: number;
			startedAt?: string;
			processes?: Record<string, { pid: number; label: string; spawnedAt: string; category?: string }>;
		};

		if (!data.processes || Object.keys(data.processes).length === 0) return;

		const db = _db!;
		const insert = db.prepare(`
			INSERT OR IGNORE INTO processes (pid, label, command, spawned_at)
			VALUES (?, ?, ?, ?)
		`);

		const batch = db.transaction(() => {
			for (const entry of Object.values(data.processes!)) {
				insert.run(
					entry.pid,
					entry.label,
					entry.category ?? null,
					entry.spawnedAt ?? new Date().toISOString()
				);
			}
		});
		batch();
	} catch {
		// No JSON file or parse error — nothing to migrate
	}
}

// ── Process liveness helpers ─────────────────────────────────────────

async function isPidAlive(pid: number): Promise<boolean> {
	if (pid <= 0) return false;
	if (IS_WINDOWS) {
		try {
			const { stdout } = await execFileAsync(
				'tasklist',
				['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
				{ timeout: 5000, windowsHide: true }
			);
			return stdout.includes(String(pid));
		} catch { return false; }
	} else {
		try { process.kill(pid, 0); return true; } catch { return false; }
	}
}

async function killPid(pid: number): Promise<boolean> {
	if (pid <= 0) return false;
	try {
		if (IS_WINDOWS) {
			// /T = kill child tree, /F = force
			await execFileAsync('taskkill', ['/F', '/T', '/PID', String(pid)], {
				timeout: 5000, windowsHide: true
			});
		} else {
			process.kill(pid, 'SIGTERM');
			// Give 1s grace, then SIGKILL
			setTimeout(() => {
				try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
			}, 1000);
		}
		return true;
	} catch {
		return false; // already dead
	}
}

// ── SQLite read/write helpers ────────────────────────────────────────

interface ProcessRow {
	pid: number;
	label: string;
	command: string | null;
	spawned_at: string;
	exited_at: string | null;
	exit_code: number | null;
}

function getAllActive(): ProcessRow[] {
	const db = getDb();
	return db.prepare(
		'SELECT * FROM processes WHERE exited_at IS NULL'
	).all() as ProcessRow[];
}

function rowToEntry(row: ProcessRow): PidEntry {
	return {
		pid: row.pid,
		label: row.label,
		spawnedAt: row.spawned_at,
		category: (row.command as PidEntry['category']) ?? 'service'
	};
}

function getServerPid(): number | null {
	const db = getDb();
	const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('server_pid') as { value: string } | undefined;
	return row ? parseInt(row.value, 10) : null;
}

function setServerMeta(pid: number, startedAt: string): void {
	const db = getDb();
	db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('server_pid', String(pid));
	db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('started_at', startedAt);
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Called once at heartbeat startup. Loads the previous registry from the DB,
 * checks if the old server PID is dead (meaning it crashed), and kills
 * any orphaned child processes from the previous run.
 *
 * Returns a summary of what was cleaned up.
 */
export async function reapStaleProcesses(): Promise<{ reaped: string[]; alive: string[] }> {
	const db = getDb();
	const reaped: string[] = [];
	const alive: string[] = [];

	const previousServerPid = getServerPid();

	// If the previous server is still running, this is a concurrent instance or HMR —
	// don't kill processes that may belong to the still-running server.
	if (previousServerPid && previousServerPid !== process.pid && await isPidAlive(previousServerPid)) {
		// Previous server still alive — skip reaping (likely HMR reload)
		// Just take over the meta
		setServerMeta(process.pid, new Date().toISOString());
		const rows = getAllActive();
		return { reaped, alive: rows.map(r => r.label) };
	}

	// Previous server is dead — any remaining active children are orphans
	const rows = getAllActive();
	const aliveChecks = await Promise.all(rows.map(r => isPidAlive(r.pid)));

	const markExited = db.prepare(
		'UPDATE processes SET exited_at = ?, exit_code = ? WHERE pid = ? AND label = ?'
	);
	const now = new Date().toISOString();

	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		if (aliveChecks[i]) {
			if (await killPid(row.pid)) {
				reaped.push(`${row.label} (PID ${row.pid})`);
				markExited.run(now, -1, row.pid, row.label);
			} else {
				alive.push(`${row.label} (PID ${row.pid}) — kill failed`);
			}
		} else {
			// Already dead — mark as exited
			markExited.run(now, null, row.pid, row.label);
		}
	}

	// Record this server instance
	setServerMeta(process.pid, new Date().toISOString());

	return { reaped, alive };
}

/** Register a spawned child process. */
export async function registerPid(
	pid: number,
	label: string,
	category: PidEntry['category']
): Promise<void> {
	if (pid <= 0) return;
	const db = getDb();
	db.prepare(`
		INSERT OR REPLACE INTO processes (pid, label, command, spawned_at)
		VALUES (?, ?, ?, ?)
	`).run(pid, label, category, new Date().toISOString());
}

/** Unregister a process (mark as exited). */
export async function unregisterPid(label: string): Promise<void> {
	const db = getDb();
	db.prepare(
		'UPDATE processes SET exited_at = ? WHERE label = ? AND exited_at IS NULL'
	).run(new Date().toISOString(), label);
}

/** Kill and unregister a specific process by label. */
export async function killAndUnregister(label: string): Promise<boolean> {
	const db = getDb();
	const row = db.prepare(
		'SELECT * FROM processes WHERE label = ? AND exited_at IS NULL'
	).get(label) as ProcessRow | undefined;
	if (!row) return false;

	const killed = await killPid(row.pid);
	db.prepare(
		'UPDATE processes SET exited_at = ?, exit_code = ? WHERE pid = ? AND label = ?'
	).run(new Date().toISOString(), killed ? -1 : null, row.pid, row.label);
	return killed;
}

/** Kill all registered processes (used by shutdown endpoint). */
export async function killAll(): Promise<{ killed: string[]; failed: string[] }> {
	const db = getDb();
	const killed: string[] = [];
	const failed: string[] = [];
	const killPromises: Promise<void>[] = [];

	const rows = getAllActive();
	const aliveChecks = await Promise.all(rows.map(r => isPidAlive(r.pid)));

	const markExited = db.prepare(
		'UPDATE processes SET exited_at = ?, exit_code = ? WHERE pid = ? AND label = ?'
	);
	const now = new Date().toISOString();

	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		if (aliveChecks[i]) {
			if (await killPid(row.pid)) {
				killed.push(row.label);
				markExited.run(now, -1, row.pid, row.label);
				// On POSIX, killPid schedules a SIGKILL after 1s — wait for it
				if (!IS_WINDOWS) {
					killPromises.push(new Promise<void>(resolve => setTimeout(resolve, 1200)));
				}
			} else {
				failed.push(row.label);
			}
		} else {
			// Already dead — clean up
			markExited.run(now, null, row.pid, row.label);
		}
	}

	// Wait for all deferred SIGKILL timeouts before returning
	await Promise.allSettled(killPromises);

	return { killed, failed };
}

/** Get all currently registered (active) processes. */
export function getRegisteredProcesses(): Record<string, PidEntry> {
	const rows = getAllActive();
	const result: Record<string, PidEntry> = {};
	for (const row of rows) {
		result[row.label] = rowToEntry(row);
	}
	return result;
}
