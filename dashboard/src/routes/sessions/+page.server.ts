import type { PageServerLoad } from './$types.js';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { PATHS } from '$lib/server/constants.js';
import type { ChatSessionMeta } from '$lib/types/chat.js';

interface SessionFile {
	id: string;
	startedAt: string;
	endedAt?: string;
	duration?: number;
	cwd?: string;
	restoredAt?: string;
	context?: {
		title?: string;
		eventsDropped?: number;
	};
	metrics?: {
		edits?: number;
		commands?: number;
		tasks?: number;
		errors?: number;
	};
	provider?: string;
	model?: string;
}

export interface Session {
	id: string;
	title: string | null;
	type: 'agent' | 'chat';
	provider: string | null;
	model: string | null;
	status: 'running' | 'completed' | 'error';
	startedAt: string;
	endedAt: string | null;
	duration: string;
	durationMs: number;
	cwd: string;
	restoredAt: string | null;
	messageCount: number;
	metrics: {
		edits: number;
		commands: number;
		tasks: number;
		errors: number;
	};
}

function formatDuration(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const secs = seconds % 60;
	if (minutes < 60) return `${minutes}m ${secs}s`;
	const hours = Math.floor(minutes / 60);
	const mins = minutes % 60;
	return `${hours}h ${mins}m`;
}

export const load: PageServerLoad = async () => {
	const sessionsDir = PATHS.sessionsDir;
	let files: string[] = [];

	try {
		const entries = await readdir(sessionsDir);
		files = entries.filter((f) => f.endsWith('.json') && f !== 'current.json');
	} catch {
		return { sessions: [], summary: { total: 0, running: 0, completed: 0, errored: 0, totalEdits: 0 } };
	}

	// Also read current session
	let currentSession: SessionFile | null = null;
	try {
		const raw = await readFile(join(sessionsDir, 'current.json'), 'utf-8');
		currentSession = JSON.parse(raw);
	} catch {
		// no current session
	}

	const sessionFiles = await Promise.all(
		files.map(async (file) => {
			try {
				const raw = await readFile(join(sessionsDir, file), 'utf-8');
				return JSON.parse(raw) as SessionFile;
			} catch {
				return null;
			}
		})
	);

	const sessions: Session[] = [];

	for (const sf of sessionFiles) {
		if (!sf) continue;
		const hasErrors = (sf.metrics?.errors ?? 0) > 0;
		const isEnded = !!sf.endedAt;
		const durationMs = sf.duration ?? (sf.endedAt ? new Date(sf.endedAt).getTime() - new Date(sf.startedAt).getTime() : 0);

		sessions.push({
			id: sf.id,
			title: sf.context?.title ?? null,
			type: 'agent',
			provider: sf.provider ?? 'claude-code',
			model: sf.model ?? 'claude-opus-4-6',
			status: hasErrors ? 'error' : isEnded ? 'completed' : 'running',
			startedAt: sf.startedAt,
			endedAt: sf.endedAt ?? null,
			duration: formatDuration(durationMs),
			durationMs,
			cwd: sf.cwd ?? '',
			restoredAt: sf.restoredAt ?? null,
			messageCount: 0,
			metrics: {
				edits: sf.metrics?.edits ?? 0,
				commands: sf.metrics?.commands ?? 0,
				tasks: sf.metrics?.tasks ?? 0,
				errors: sf.metrics?.errors ?? 0
			}
		});
	}

	// Add current session if not already in the list
	if (currentSession && !sessions.some((s) => s.id === currentSession!.id)) {
		const durationMs = Date.now() - new Date(currentSession.startedAt).getTime();
		sessions.push({
			id: currentSession.id,
			title: currentSession.context?.title ?? null,
			type: 'agent',
			provider: currentSession.provider ?? 'claude-code',
			model: currentSession.model ?? 'claude-opus-4-6',
			status: 'running',
			startedAt: currentSession.startedAt,
			endedAt: null,
			duration: formatDuration(durationMs),
			durationMs,
			cwd: currentSession.cwd ?? '',
			restoredAt: currentSession.restoredAt ?? null,
			messageCount: 0,
			metrics: {
				edits: currentSession.metrics?.edits ?? 0,
				commands: currentSession.metrics?.commands ?? 0,
				tasks: currentSession.metrics?.tasks ?? 0,
				errors: currentSession.metrics?.errors ?? 0
			}
		});
	}

	// Load chat sessions from .playground/chats/index.json
	let chatSessions: ChatSessionMeta[] = [];
	try {
		const raw = await readFile(`${PATHS.chatsDir}/index.json`, 'utf-8');
		chatSessions = JSON.parse(raw);
	} catch {
		// no chat sessions
	}

	for (const cs of chatSessions) {
		const durationMs = new Date(cs.updatedAt).getTime() - new Date(cs.createdAt).getTime();
		const chatStatus = cs.status === 'streaming' ? 'running' : 'completed';
		sessions.push({
			id: `chat-${cs.id}`,
			title: cs.title,
			type: 'chat',
			provider: cs.provider,
			model: cs.model,
			status: chatStatus,
			startedAt: cs.createdAt,
			endedAt: cs.updatedAt,
			duration: formatDuration(durationMs),
			durationMs,
			cwd: '',
			restoredAt: null,
			messageCount: cs.messageCount,
			metrics: { edits: 0, commands: 0, tasks: 0, errors: 0 }
		});
	}

	// Sort: running first, then by startedAt descending
	sessions.sort((a, b) => {
		if (a.status === 'running' && b.status !== 'running') return -1;
		if (b.status === 'running' && a.status !== 'running') return 1;
		return new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime();
	});

	const running = sessions.filter((s) => s.status === 'running').length;
	const completed = sessions.filter((s) => s.status === 'completed').length;
	const errored = sessions.filter((s) => s.status === 'error').length;
	const totalEdits = sessions.reduce((sum, s) => sum + s.metrics.edits, 0);
	const chatCount = sessions.filter((s) => s.type === 'chat').length;
	const totalMessages = sessions.reduce((sum, s) => sum + s.messageCount, 0);

	return {
		sessions,
		summary: { total: sessions.length, running, completed, errored, totalEdits, chatCount, totalMessages }
	};
};
