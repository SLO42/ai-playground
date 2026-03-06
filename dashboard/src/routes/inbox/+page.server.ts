import type { PageServerLoad } from './$types.js';
import { readFile } from 'fs/promises';
import { PATHS, scopedSettingsPath } from '$lib/server/constants.js';
import { getNotifications, getStats, type Notification } from '$lib/server/notifications.js';
import { getSessionStatus } from '$lib/server/session-manager.js';
import type { ChatSessionMeta, ChatSession } from '$lib/types/chat.js';

export interface InboxItem {
	id: string;
	type: 'session' | 'notification';
	title: string;
	subtitle: string;
	status: 'awaiting' | 'active' | 'paused' | 'resolved' | 'info';
	source: string;
	model?: string;
	provider?: string;
	timestamp: string;
	sessionId?: string;
	notificationId?: string;
	lastMessage?: string;
	messageCount?: number;
	severity?: string;
	category?: string;
	link?: string;
	linkLabel?: string;
	read?: boolean;
	stackCount?: number;
}

export interface NotificationPreference {
	type: string;
	desktop: boolean;
	sound: boolean;
}

async function readSessionIndex(): Promise<ChatSessionMeta[]> {
	try {
		const raw = await readFile(`${PATHS.chatsDir}/index.json`, 'utf-8');
		return JSON.parse(raw);
	} catch {
		return [];
	}
}

async function readSession(id: string): Promise<ChatSession | null> {
	try {
		const raw = await readFile(`${PATHS.chatsDir}/${id}.json`, 'utf-8');
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

function timeAgo(iso: string): string {
	const diff = Date.now() - new Date(iso).getTime();
	const mins = Math.floor(diff / 60000);
	if (mins < 1) return 'just now';
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

function needsUserInput(session: ChatSession | null): boolean {
	if (!session) return false;

	// Check if session is explicitly flagged for discussion
	if ((session as any).flagDiscussion) return true;

	// Look at the last non-system message
	const msgs = session.messages.filter((m) => m.role !== 'system');
	if (msgs.length === 0) return false;
	const last = msgs.at(-1);
	if (!last?.content) return false;

	const text = last.content.toLowerCase();

	// Messages that indicate the AI is waiting for input
	const awaitingPatterns = [
		'what do you think',
		'what would you like',
		'would you like me to',
		'should i ',
		'do you want',
		'please confirm',
		'please let me know',
		'awaiting your',
		'your input',
		'your decision',
		'your thoughts',
		'needs discussion',
		'flagged for discussion',
		'[question]',
		'[awaiting]',
		'[input needed]',
		'which option',
		'which approach'
	];

	// Messages that indicate completion (should NOT be awaiting)
	const donePatterns = [
		'[done]',
		'[complete]',
		'[result]',
		'[summary]',
		'[created]',
		'task created',
		'successfully',
		'completed',
		'review complete'
	];

	// If last message looks like a completion, it's not awaiting
	for (const p of donePatterns) {
		if (text.includes(p)) return false;
	}

	// If last message asks for input, it is awaiting
	for (const p of awaitingPatterns) {
		if (text.includes(p)) return true;
	}

	return false;
}

function sessionToInboxItem(meta: ChatSessionMeta, session: ChatSession | null): InboxItem {
	const liveStatus = getSessionStatus(meta.id);
	const isClaw = meta.source === 'claw';

	let status: InboxItem['status'];
	if (liveStatus === 'streaming') {
		status = 'active';
	} else if (liveStatus === 'paused' || meta.status === 'paused') {
		status = 'paused';
	} else if (isClaw && needsUserInput(session)) {
		status = 'awaiting';
	} else {
		status = 'resolved';
	}

	const lastMsg = session?.messages.filter((m) => m.role !== 'system').at(-1);

	return {
		id: `session-${meta.id}`,
		type: 'session',
		title: meta.title || 'Untitled Session',
		subtitle: isClaw ? `Claw session via ${meta.provider}` : `Chat via ${meta.provider}`,
		status,
		source: meta.source ?? 'user',
		model: meta.model,
		provider: meta.provider,
		timestamp: meta.updatedAt,
		sessionId: meta.id,
		lastMessage: lastMsg?.content?.slice(0, 200),
		messageCount: meta.messageCount
	};
}

function notifToInboxItem(notif: Notification): InboxItem {
	return {
		id: `notif-${notif.id}`,
		type: 'notification',
		title: notif.title,
		subtitle: notif.message,
		status: notif.severity === 'critical' ? 'awaiting' : 'info',
		source: notif.source ?? 'system',
		timestamp: notif.timestamp,
		notificationId: notif.id,
		severity: notif.severity,
		category: notif.category,
		link: notif.link,
		linkLabel: notif.linkLabel,
		read: notif.read,
		stackCount: notif.stackCount
	};
}

export const load: PageServerLoad = async () => {
	const [sessionIndex, notifResult, notifStats] = await Promise.all([
		readSessionIndex(),
		getNotifications({ limit: 50 }),
		getStats()
	]);
	const allNotifications = notifResult.items;
	const notifTotal = notifResult.total;

	// Load full session data for recent sessions (last 20)
	const recentSessions = sessionIndex.slice(0, 20);
	const sessionData = await Promise.all(
		recentSessions.map((meta) => readSession(meta.id))
	);

	const sessionItems = recentSessions.map((meta, i) =>
		sessionToInboxItem(meta, sessionData[i])
	);

	const notifItems = allNotifications.map(notifToInboxItem);

	const allItems = [...sessionItems, ...notifItems]
		.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

	// Add timeAgo to each item
	const items = allItems.map((item) => ({
		...item,
		timeAgo: timeAgo(item.timestamp)
	}));

	const awaiting = items.filter((i) => i.status === 'awaiting').length;
	const active = items.filter((i) => i.status === 'active').length;
	const paused = items.filter((i) => i.status === 'paused').length;
	const unreadNotifs = allNotifications.filter((n) => !n.read).length;

	// Load persisted notification settings
	let notifSettings: Record<string, unknown>;
	try {
		const settingsPath = scopedSettingsPath('notification-settings.json', 'global');
		const raw = await readFile(settingsPath, 'utf-8');
		notifSettings = JSON.parse(raw);
	} catch {
		notifSettings = { desktop: true, inAppToasts: true, sound: false, quietHoursStart: '23:00', quietHoursEnd: '08:00' };
	}

	const preferences: NotificationPreference[] = [
		{ type: 'Desktop Notifications', desktop: notifSettings.desktop as boolean ?? true, sound: false },
		{ type: 'Sound Alerts', desktop: false, sound: notifSettings.sound as boolean ?? false },
		{ type: 'In-App Toasts', desktop: notifSettings.inAppToasts as boolean ?? true, sound: false },
		{ type: 'Quiet Hours', desktop: false, sound: false }
	];

	const quickActions = [
		{ id: 'approve', name: 'Approve', description: "Accept the agent's suggestion and continue", shortcut: 'Ctrl+Enter' },
		{ id: 'reject', name: 'Reject', description: 'Reject and ask agent to try again', shortcut: 'Ctrl+Backspace' },
		{ id: 'skip', name: 'Skip', description: 'Skip this decision, agent proceeds with default', shortcut: 'Ctrl+S' },
		{ id: 'delegate', name: 'Delegate', description: 'Hand off to another agent or escalate', shortcut: 'Ctrl+D' }
	];

	return {
		items,
		preferences,
		quickActions,
		notifStats,
		notifTotal,
		stats: {
			awaitingInput: awaiting,
			active,
			paused,
			totalSessions: sessionIndex.length,
			unreadNotifs
		}
	};
};
