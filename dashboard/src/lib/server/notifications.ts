import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { mkdirSync, existsSync, readFileSync } from 'fs';
import { PATHS } from './constants.js';
import crypto from 'crypto';
import Database from 'better-sqlite3';

// ── Types ──────────────────────────────────────────────────────────────

export type NotifCategory = 'task' | 'service' | 'agent' | 'chat' | 'memory' | 'model' | 'system';
export type NotifSeverity = 'critical' | 'warning' | 'info' | 'success';

export interface Notification {
	id: string;
	timestamp: string;
	severity: NotifSeverity;
	category: NotifCategory;
	title: string;
	message: string;
	read: boolean;
	source?: string;
	link?: string;
	linkLabel?: string;
	stackCount?: number;
}

// ── SQLite Storage ────────────────────────────────────────────────────

const DB_PATH = resolve(PATHS.root, '.playground/notifications.db');
const NOTIF_JSON_PATH = resolve(PATHS.root, '.playground/notifications.json');
const SETTINGS_FILE = resolve(PATHS.root, '.playground/notification-settings.json');
const MAX_STORED = 200;

// Cached DB handle (same pattern as pm-memory-db.ts)
let _db: Database.Database | null = null;

function getDb(): Database.Database {
	if (_db) return _db;

	// Ensure .playground dir exists
	mkdirSync(resolve(PATHS.root, '.playground'), { recursive: true });

	const db = new Database(DB_PATH);
	db.pragma('journal_mode = WAL');

	// Create table and indices
	db.exec(`
		CREATE TABLE IF NOT EXISTS notifications (
			id TEXT PRIMARY KEY,
			type TEXT NOT NULL,
			severity TEXT NOT NULL DEFAULT 'info',
			title TEXT NOT NULL,
			message TEXT,
			source TEXT,
			link TEXT,
			link_label TEXT,
			stack_count INTEGER,
			read INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_notif_type ON notifications(type);
		CREATE INDEX IF NOT EXISTS idx_notif_created ON notifications(created_at);
	`);

	_db = db;

	// Migrate existing JSON data on first open
	migrateFromJson(db);

	return db;
}

/** Close the DB handle (for cleanup/shutdown). */
export function closeDb(): void {
	if (_db) {
		_db.close();
		_db = null;
	}
}

// ── JSON Migration ────────────────────────────────────────────────────

function migrateFromJson(db: Database.Database): void {
	if (!existsSync(NOTIF_JSON_PATH)) return;

	// Only migrate if the DB is empty
	const count = db.prepare('SELECT COUNT(*) as cnt FROM notifications').get() as { cnt: number };
	if (count.cnt > 0) return;

	try {
		const raw = readFileSync(NOTIF_JSON_PATH, 'utf-8');
		const notifs = JSON.parse(raw) as Notification[];
		if (!Array.isArray(notifs) || notifs.length === 0) return;

		const insert = db.prepare(`
			INSERT OR IGNORE INTO notifications (id, type, severity, title, message, source, link, link_label, stack_count, read, created_at)
			VALUES (@id, @type, @severity, @title, @message, @source, @link, @linkLabel, @stackCount, @read, @createdAt)
		`);

		const migrate = db.transaction((items: Notification[]) => {
			for (const n of items) {
				insert.run({
					id: n.id,
					type: n.category,
					severity: n.severity,
					title: n.title,
					message: n.message ?? null,
					source: n.source ?? null,
					link: n.link ?? null,
					linkLabel: n.linkLabel ?? null,
					stackCount: n.stackCount ?? null,
					read: n.read ? 1 : 0,
					createdAt: n.timestamp
				});
			}
		});

		migrate(notifs);
	} catch {
		// Migration is best-effort — don't crash if JSON is corrupt
	}
}

// ── Row ↔ Notification mapping ────────────────────────────────────────

interface NotifRow {
	id: string;
	type: string;
	severity: string;
	title: string;
	message: string | null;
	source: string | null;
	link: string | null;
	link_label: string | null;
	stack_count: number | null;
	read: number;
	created_at: string;
}

function rowToNotif(row: NotifRow): Notification {
	return {
		id: row.id,
		timestamp: row.created_at,
		severity: row.severity as NotifSeverity,
		category: row.type as NotifCategory,
		title: row.title,
		message: row.message ?? '',
		read: row.read === 1,
		source: row.source ?? undefined,
		link: row.link ?? undefined,
		linkLabel: row.link_label ?? undefined,
		stackCount: row.stack_count ?? undefined
	};
}

// ── Settings (JSON config — unchanged) ────────────────────────────────

interface NotifCategoryPref {
	desktop: boolean;
	inApp: boolean;
}

export interface NotifSettings {
	desktop: boolean;
	inAppToasts: boolean;
	sound: boolean;
	quietHoursStart: string;
	quietHoursEnd: string;
	categories: Record<string, NotifCategoryPref>;
	heartbeatEnabled?: boolean;
	heartbeatIntervalMs?: number;
}

export async function loadSettings(): Promise<NotifSettings> {
	try {
		const raw = await readFile(SETTINGS_FILE, 'utf-8');
		return JSON.parse(raw);
	} catch {
		return {
			desktop: true,
			inAppToasts: true,
			sound: false,
			quietHoursStart: '23:00',
			quietHoursEnd: '08:00',
			categories: {}
		};
	}
}

function isQuietHours(settings: NotifSettings): boolean {
	const now = new Date();
	const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
	const start = settings.quietHoursStart;
	const end = settings.quietHoursEnd;
	if (start <= end) {
		return hhmm >= start && hhmm < end;
	}
	// Wraps midnight (e.g. 23:00 - 08:00)
	return hhmm >= start || hhmm < end;
}

// ── SSE Subscribers ────────────────────────────────────────────────────

type Subscriber = (notif: Notification) => void;
const subscribers = new Set<Subscriber>();

export function subscribe(fn: Subscriber): () => void {
	subscribers.add(fn);
	return () => subscribers.delete(fn);
}

function broadcast(notif: Notification) {
	for (const fn of subscribers) {
		try {
			fn(notif);
		} catch {
			subscribers.delete(fn);
		}
	}
}

// ── Desktop Notifications ──────────────────────────────────────────────

let notifier: any = null;

async function loadNotifier() {
	if (notifier !== null) return notifier;
	try {
		const mod = await import('node-notifier');
		notifier = mod.default || mod;
		return notifier;
	} catch {
		notifier = false;
		return false;
	}
}

async function pushDesktop(notif: Notification) {
	const nn = await loadNotifier();
	if (!nn) return;

	const iconMap: Record<NotifSeverity, string> = {
		critical: '🔴',
		warning: '🟡',
		info: '🔵',
		success: '🟢'
	};

	try {
		nn.notify({
			title: `${iconMap[notif.severity]} ${notif.title}`,
			message: notif.message,
			sound: notif.severity === 'critical',
			wait: false
		});
	} catch {
		// Desktop notification failed — not critical
	}
}

// ── Public API ─────────────────────────────────────────────────────────

export async function getNotifications(opts?: {
	category?: NotifCategory;
	unreadOnly?: boolean;
	limit?: number;
	offset?: number;
}): Promise<{ items: Notification[]; total: number }> {
	const db = getDb();

	// Build dynamic WHERE clause
	const conditions: string[] = [];
	const params: Record<string, string | number> = {};

	if (opts?.category) {
		conditions.push('type = @category');
		params.category = opts.category;
	}
	if (opts?.unreadOnly) {
		conditions.push('read = 0');
	}

	const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

	// Get total count
	const countRow = db.prepare(`SELECT COUNT(*) as cnt FROM notifications ${where}`).get(params) as { cnt: number };
	const total = countRow.cnt;

	// Get paginated results, most recent first
	const offset = opts?.offset ?? 0;
	const limit = opts?.limit ?? (total || MAX_STORED);

	const rows = db.prepare(
		`SELECT * FROM notifications ${where} ORDER BY created_at DESC LIMIT @limit OFFSET @offset`
	).all({ ...params, limit, offset }) as NotifRow[];

	return { items: rows.map(rowToNotif), total };
}

export async function pushNotification(opts: {
	severity: NotifSeverity;
	category: NotifCategory;
	title: string;
	message: string;
	source?: string;
	link?: string;
	linkLabel?: string;
	desktop?: boolean;
}): Promise<Notification> {
	const db = getDb();

	const notif: Notification = {
		id: crypto.randomUUID().slice(0, 12),
		timestamp: new Date().toISOString(),
		severity: opts.severity,
		category: opts.category,
		title: opts.title,
		message: opts.message,
		read: false,
		source: opts.source,
		link: opts.link,
		linkLabel: opts.linkLabel
	};

	// Stack similar sequential notifications (within 5 min window)
	const STACK_WINDOW_MS = 5 * 60 * 1000;
	const cutoff = new Date(Date.now() - STACK_WINDOW_MS).toISOString();

	const top = db.prepare(`
		SELECT * FROM notifications
		WHERE read = 0
			AND title = @title
			AND type = @type
			AND (source = @source OR (source IS NULL AND @source IS NULL))
			AND created_at > @cutoff
		ORDER BY created_at DESC
		LIMIT 1
	`).get({
		title: notif.title,
		type: notif.category,
		source: notif.source ?? null,
		cutoff
	}) as NotifRow | undefined;

	if (top) {
		// Update existing notification (stack)
		const newCount = (top.stack_count ?? 1) + 1;
		db.prepare(`
			UPDATE notifications
			SET stack_count = @stackCount, message = @message, created_at = @createdAt, severity = @severity
			WHERE id = @id
		`).run({
			id: top.id,
			stackCount: newCount,
			message: notif.message,
			createdAt: notif.timestamp,
			severity: notif.severity
		});
		// Use the stacked notification for broadcast/desktop
		notif.id = top.id;
		notif.stackCount = newCount;
	} else {
		// Insert new notification
		db.prepare(`
			INSERT INTO notifications (id, type, severity, title, message, source, link, link_label, stack_count, read, created_at)
			VALUES (@id, @type, @severity, @title, @message, @source, @link, @linkLabel, @stackCount, 0, @createdAt)
		`).run({
			id: notif.id,
			type: notif.category,
			severity: notif.severity,
			title: notif.title,
			message: notif.message,
			source: notif.source ?? null,
			link: notif.link ?? null,
			linkLabel: notif.linkLabel ?? null,
			stackCount: null,
			createdAt: notif.timestamp
		});
	}

	// Trim to MAX_STORED — delete oldest beyond the cap
	const totalRow = db.prepare('SELECT COUNT(*) as cnt FROM notifications').get() as { cnt: number };
	if (totalRow.cnt > MAX_STORED) {
		db.prepare(`
			DELETE FROM notifications WHERE id IN (
				SELECT id FROM notifications ORDER BY created_at DESC LIMIT -1 OFFSET @max
			)
		`).run({ max: MAX_STORED });
	}

	// Load saved settings to decide delivery channels
	const settings = await loadSettings();
	const catPrefs = settings.categories[notif.category];
	const quiet = isQuietHours(settings);

	// In-app toast (SSE broadcast) — respect global + per-category setting
	const inAppAllowed = settings.inAppToasts && (catPrefs?.inApp !== false);
	if (inAppAllowed) {
		broadcast(notif);
	}

	// Desktop toast — respect global + per-category + quiet hours
	const desktopRequested = opts.desktop !== false;
	const desktopAllowed = settings.desktop && (catPrefs?.desktop !== false) && !quiet;
	if (desktopRequested && desktopAllowed) {
		await pushDesktop(notif);
	}

	return notif;
}

export async function markRead(id: string): Promise<boolean> {
	const db = getDb();
	const result = db.prepare('UPDATE notifications SET read = 1 WHERE id = @id AND read = 0').run({ id });
	return result.changes > 0;
}

export async function markAllRead(): Promise<number> {
	const db = getDb();
	const result = db.prepare('UPDATE notifications SET read = 1 WHERE read = 0').run();
	return result.changes;
}

export async function dismissNotification(id: string): Promise<boolean> {
	const db = getDb();
	const result = db.prepare('DELETE FROM notifications WHERE id = @id').run({ id });
	return result.changes > 0;
}

export async function clearNotifications(): Promise<void> {
	const db = getDb();
	db.prepare('DELETE FROM notifications').run();
}

export async function getStats() {
	const db = getDb();
	const now = new Date();
	const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

	const stats = db.prepare(`
		SELECT
			COUNT(*) as total,
			SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) as unread,
			SUM(CASE WHEN read = 0 AND severity = 'critical' THEN 1 ELSE 0 END) as critical,
			SUM(CASE WHEN created_at >= @todayStart THEN 1 ELSE 0 END) as today,
			SUM(CASE WHEN read = 0 AND type = 'task' THEN 1 ELSE 0 END) as activeJobs,
			SUM(CASE WHEN read = 0 AND severity IN ('critical', 'warning') THEN 1 ELSE 0 END) as alerts
		FROM notifications
	`).get({ todayStart }) as {
		total: number;
		unread: number;
		critical: number;
		today: number;
		activeJobs: number;
		alerts: number;
	};

	return {
		total: stats.total ?? 0,
		unread: stats.unread ?? 0,
		critical: stats.critical ?? 0,
		today: stats.today ?? 0,
		activeJobs: stats.activeJobs ?? 0,
		alerts: stats.alerts ?? 0
	};
}
