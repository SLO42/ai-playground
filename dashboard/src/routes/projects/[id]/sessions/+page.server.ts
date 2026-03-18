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
	projectId?: string;
}

export interface ProjectSession {
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

export const load: PageServerLoad = async ({ params, parent }) => {
	const { project } = await parent();
	const projectId = params.id;
	const projectPath = project.path;

	const sessions: ProjectSession[] = [];

	// ── Load agent sessions from .claude-flow/sessions/ ───────────────
	const sessionsDir = PATHS.sessionsDir;
	try {
		const entries = await readdir(sessionsDir);
		const jsonFiles = entries.filter((f) => f.endsWith('.json') && f !== 'current.json');

		const sessionFiles = await Promise.all(
			jsonFiles.map(async (file) => {
				try {
					const raw = await readFile(join(sessionsDir, file), 'utf-8');
					return JSON.parse(raw) as SessionFile;
				} catch {
					return null;
				}
			})
		);

		for (const sf of sessionFiles) {
			if (!sf) continue;

			// Filter: match by projectId field or by cwd containing the project path
			const matchesProject =
				sf.projectId === projectId ||
				(sf.cwd && normalizedIncludes(sf.cwd, projectPath));

			if (!matchesProject) continue;

			const hasErrors = (sf.metrics?.errors ?? 0) > 0;
			const isEnded = !!sf.endedAt;
			const durationMs = sf.duration ?? (sf.endedAt
				? new Date(sf.endedAt).getTime() - new Date(sf.startedAt).getTime()
				: 0);

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
				messageCount: 0,
				metrics: {
					edits: sf.metrics?.edits ?? 0,
					commands: sf.metrics?.commands ?? 0,
					tasks: sf.metrics?.tasks ?? 0,
					errors: sf.metrics?.errors ?? 0
				}
			});
		}

		// Check current session
		try {
			const raw = await readFile(join(sessionsDir, 'current.json'), 'utf-8');
			const currentSession: SessionFile = JSON.parse(raw);
			const matchesCurrent =
				currentSession.projectId === projectId ||
				(currentSession.cwd && normalizedIncludes(currentSession.cwd, projectPath));

			if (matchesCurrent && !sessions.some((s) => s.id === currentSession.id)) {
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
					messageCount: 0,
					metrics: {
						edits: currentSession.metrics?.edits ?? 0,
						commands: currentSession.metrics?.commands ?? 0,
						tasks: currentSession.metrics?.tasks ?? 0,
						errors: currentSession.metrics?.errors ?? 0
					}
				});
			}
		} catch {
			// no current session
		}
	} catch {
		// sessions directory doesn't exist
	}

	// ── Load chat sessions from .playground/chats/index.json ──────────
	try {
		const raw = await readFile(`${PATHS.chatsDir}/index.json`, 'utf-8');
		const chatSessions: ChatSessionMeta[] = JSON.parse(raw);

		for (const cs of chatSessions) {
			// Check if chat session title or context references this project
			// Chat sessions can be linked by title containing the project name
			const titleLower = (cs.title ?? '').toLowerCase();
			const projectNameLower = (project.name ?? projectId).toLowerCase();

			// Only include chats that explicitly reference the project
			if (!titleLower.includes(projectNameLower) && projectNameLower.length > 3) continue;
			if (projectNameLower.length <= 3) continue; // Skip very short names to avoid false matches

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
				messageCount: cs.messageCount,
				metrics: { edits: 0, commands: 0, tasks: 0, errors: 0 }
			});
		}
	} catch {
		// no chat sessions
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

	return {
		projectId,
		sessions,
		summary: {
			total: sessions.length,
			running,
			completed,
			errored,
			totalEdits,
			chatCount
		}
	};
};

/** Normalize path separators and do case-insensitive include check (Windows-safe) */
function normalizedIncludes(haystack: string, needle: string): boolean {
	const h = haystack.replace(/\\/g, '/').toLowerCase();
	const n = needle.replace(/\\/g, '/').toLowerCase();
	return h.includes(n);
}
