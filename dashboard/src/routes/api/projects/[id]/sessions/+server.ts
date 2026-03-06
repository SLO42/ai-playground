import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { readdir, readFile } from 'fs/promises';
import { join, resolve } from 'path';
import { createHash } from 'crypto';
import { PATHS } from '$lib/server/constants.js';
import { scanAllProjects } from '$lib/server/project-scanner.js';
import type { ChatSessionMeta } from '$lib/types/chat.js';

interface SessionFile {
	id: string;
	startedAt: string;
	endedAt?: string;
	duration?: number;
	cwd?: string;
	context?: { title?: string };
	metrics?: { edits?: number; commands?: number; tasks?: number; errors?: number };
}

function formatDuration(ms: number): string {
	const minutes = Math.floor(ms / 60000);
	if (minutes < 60) return `0h ${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const mins = minutes % 60;
	return `${hours}h ${String(mins).padStart(2, '0')}m`;
}

export const GET: RequestHandler = async ({ params, url, request }) => {
	const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
	const perPage = Math.min(50, Math.max(1, Number(url.searchParams.get('perPage')) || 10));

	const projects = await scanAllProjects(PATHS.playgroundRegistry, PATHS.root);
	const project = projects.find((p) => p.id === params.id);

	if (!project) throw error(404, 'Project not found');

	// Read agent sessions from .claude-flow/sessions/
	const sessionsDir = PATHS.sessionsDir;
	let sessionFiles: SessionFile[] = [];
	try {
		const entries = await readdir(sessionsDir);
		const jsonFiles = entries.filter((f) => f.endsWith('.json') && f !== 'current.json');
		const results = await Promise.all(
			jsonFiles.slice(0, 20).map(async (file) => {
				try {
					const raw = await readFile(join(sessionsDir, file), 'utf-8');
					return JSON.parse(raw) as SessionFile;
				} catch {
					return null;
				}
			})
		);
		sessionFiles = results.filter((sf): sf is SessionFile => sf !== null);
	} catch {
		// no sessions dir
	}

	// Read chat sessions
	let chatSessions: ChatSessionMeta[] = [];
	try {
		const raw = await readFile(`${PATHS.chatsDir}/index.json`, 'utf-8');
		chatSessions = JSON.parse(raw);
	} catch {
		// no chat sessions
	}

	type SessionRow = {
		name: string;
		id: string;
		type: string;
		status: string;
		agents: number;
		turns: number;
		duration: string;
	};
	const sessions: SessionRow[] = [];
	const timeline: { time: string; label: string; color: string }[] = [];

	for (const sf of sessionFiles) {
		const hasErrors = (sf.metrics?.errors ?? 0) > 0;
		const isEnded = !!sf.endedAt;
		const durationMs =
			sf.duration ??
			(sf.endedAt
				? new Date(sf.endedAt).getTime() - new Date(sf.startedAt).getTime()
				: Date.now() - new Date(sf.startedAt).getTime());
		const status = hasErrors ? 'completed' : isEnded ? 'completed' : 'active';

		sessions.push({
			name: sf.context?.title ?? sf.id,
			id: sf.id.slice(0, 8),
			type: 'agent',
			status,
			agents: 0,
			turns: (sf.metrics?.commands ?? 0) + (sf.metrics?.edits ?? 0),
			duration: formatDuration(durationMs)
		});

		const time = new Date(sf.startedAt).toLocaleTimeString('en-US', {
			hour: '2-digit',
			minute: '2-digit',
			hour12: false
		});
		timeline.push({
			time,
			label: sf.context?.title ?? sf.id.slice(0, 8),
			color: status === 'active' ? 'green' : 'blue'
		});
	}

	for (const cs of chatSessions) {
		const durationMs = new Date(cs.updatedAt).getTime() - new Date(cs.createdAt).getTime();
		const status = cs.status === 'streaming' ? 'active' : 'completed';
		sessions.push({
			name: cs.title,
			id: `chat-${cs.id.slice(0, 4)}`,
			type: 'chat',
			status,
			agents: 0,
			turns: cs.messageCount,
			duration: formatDuration(durationMs)
		});
	}

	// Sort: active first
	sessions.sort((a, b) => {
		if (a.status === 'active' && b.status !== 'active') return -1;
		if (b.status === 'active' && a.status !== 'active') return 1;
		return 0;
	});

	const active = sessions.filter((s) => s.status === 'active').length;
	const paused = sessions.filter((s) => s.status === 'paused').length;
	const completed = sessions.filter((s) => s.status === 'completed').length;
	const totalTurns = sessions.reduce((sum, s) => sum + s.turns, 0);

	// Read agent usage for resource stats
	let apiTokens = 0;
	let localTokens = 0;
	let apiCost = 0;
	try {
		const raw = await readFile(resolve(PATHS.root, '.playground/agent-usage.json'), 'utf-8');
		const entries = JSON.parse(raw) as {
			inputTokens?: number;
			outputTokens?: number;
			costUsd?: number;
			model?: string;
		}[];
		for (const e of entries) {
			const tokens = (e.inputTokens ?? 0) + (e.outputTokens ?? 0);
			if (e.model?.includes('ollama') || e.costUsd === 0) {
				localTokens += tokens;
			} else {
				apiTokens += tokens;
				apiCost += e.costUsd ?? 0;
			}
		}
	} catch {
		// no usage data
	}

	const totalSessions = sessions.length;
	const totalPages = Math.max(1, Math.ceil(totalSessions / perPage));
	const safePage = Math.min(page, totalPages);
	const start = (safePage - 1) * perPage;
	const paginatedSessions = sessions.slice(start, start + perPage);

	const body = {
		summary: { active, paused, completed, totalTurns },
		sessions: paginatedSessions,
		pagination: { page: safePage, perPage, totalSessions, totalPages },
		timeline: timeline.slice(0, 8),
		resources: {
			apiTokens: { value: apiTokens, cost: `$${apiCost.toFixed(2)} estimated` },
			localTokens: { value: localTokens, cost: '$0.00 (Ollama)' },
			memoryNodes: { value: project.memoryNodes ?? 0, label: 'HNSW indexed' }
		}
	};

	const serialized = JSON.stringify(body);
	const etag = `"${createHash('md5').update(serialized).digest('hex').slice(0, 16)}"`;

	if (request.headers.get('if-none-match') === etag) {
		return new Response(null, { status: 304 });
	}

	return json(body, {
		headers: {
			'Cache-Control': 'private, max-age=5, stale-while-revalidate=30',
			'ETag': etag
		}
	});
};
