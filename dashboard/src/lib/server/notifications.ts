import { readFile, writeFile, mkdir } from 'fs/promises';
import { resolve, dirname } from 'path';
import { PATHS } from './constants.js';
import crypto from 'crypto';
import { withLock } from './async-mutex.js';

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

// ── Storage ────────────────────────────────────────────────────────────

const NOTIF_FILE = resolve(PATHS.root, '.playground/notifications.json');
const SETTINGS_FILE = resolve(PATHS.root, '.playground/notification-settings.json');
const MAX_STORED = 200;

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

async function readNotifications(): Promise<Notification[]> {
	try {
		const raw = await readFile(NOTIF_FILE, 'utf-8');
		return JSON.parse(raw) as Notification[];
	} catch {
		return [];
	}
}

async function writeNotifications(notifs: Notification[]): Promise<void> {
	await mkdir(dirname(NOTIF_FILE), { recursive: true });
	await writeFile(NOTIF_FILE, JSON.stringify(notifs, null, '\t'), 'utf-8');
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
	let notifs = await readNotifications();

	if (opts?.category) {
		notifs = notifs.filter((n) => n.category === opts.category);
	}
	if (opts?.unreadOnly) {
		notifs = notifs.filter((n) => !n.read);
	}

	// Most recent first
	notifs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

	const total = notifs.length;
	const offset = opts?.offset ?? 0;
	const limit = opts?.limit ?? total;

	notifs = notifs.slice(offset, offset + limit);

	return { items: notifs, total };
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

	await withLock(NOTIF_FILE, async () => {
		// Persist — stack similar sequential notifications
		const notifs = await readNotifications();
		const STACK_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
		const top = notifs[0];
		const isStackable = top
			&& !top.read
			&& top.title === notif.title
			&& top.source === notif.source
			&& top.category === notif.category
			&& (Date.now() - new Date(top.timestamp).getTime()) < STACK_WINDOW_MS;

		if (isStackable && top) {
			// Update existing notification instead of creating a new one
			top.stackCount = (top.stackCount ?? 1) + 1;
			top.message = notif.message;
			top.timestamp = notif.timestamp;
			top.severity = notif.severity;
			// Use the stacked notification for broadcast/desktop below
			Object.assign(notif, { id: top.id, stackCount: top.stackCount });
		} else {
			notifs.unshift(notif);
		}
		// Trim to max
		if (notifs.length > MAX_STORED) {
			notifs.length = MAX_STORED;
		}
		await writeNotifications(notifs);
	});

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
	return withLock(NOTIF_FILE, async () => {
		const notifs = await readNotifications();
		const notif = notifs.find((n) => n.id === id);
		if (!notif) return false;
		notif.read = true;
		await writeNotifications(notifs);
		return true;
	});
}

export async function markAllRead(): Promise<number> {
	return withLock(NOTIF_FILE, async () => {
		const notifs = await readNotifications();
		let count = 0;
		for (const n of notifs) {
			if (!n.read) {
				n.read = true;
				count++;
			}
		}
		if (count > 0) await writeNotifications(notifs);
		return count;
	});
}

export async function dismissNotification(id: string): Promise<boolean> {
	return withLock(NOTIF_FILE, async () => {
		const notifs = await readNotifications();
		const idx = notifs.findIndex((n) => n.id === id);
		if (idx === -1) return false;
		notifs.splice(idx, 1);
		await writeNotifications(notifs);
		return true;
	});
}

export async function clearNotifications(): Promise<void> {
	return withLock(NOTIF_FILE, async () => {
		await writeNotifications([]);
	});
}

export async function getStats() {
	const notifs = await readNotifications();
	const now = new Date();
	const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

	let unread = 0, critical = 0, today = 0, activeJobs = 0, alerts = 0;

	for (const n of notifs) {
		const isUnread = !n.read;
		if (isUnread) {
			unread++;
			if (n.severity === 'critical') critical++;
			if (n.severity === 'critical' || n.severity === 'warning') alerts++;
			if (n.category === 'task') activeJobs++;
		}
		if (new Date(n.timestamp).getTime() >= todayStart) today++;
	}

	return { total: notifs.length, unread, critical, today, activeJobs, alerts };
}
