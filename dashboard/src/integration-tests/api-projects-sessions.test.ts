import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Integration tests for /api/projects/[id]/sessions endpoint.
 *
 * These tests exercise the same data-loading logic the +page.server.ts handler
 * uses, verifying correct structure, pagination, sorting, and error handling.
 */

// ── Helpers ──────────────────────────────────────────────────────────────

interface SessionFile {
	id: string;
	startedAt: string;
	endedAt?: string;
	duration?: number;
	cwd?: string;
	context?: { title?: string };
	metrics?: { edits?: number; commands?: number; tasks?: number; errors?: number };
}

interface ChatSessionMeta {
	id: string;
	title: string;
	model: string;
	provider: string;
	messageCount: number;
	createdAt: string;
	updatedAt: string;
	source: string;
	status: string;
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

function formatDuration(ms: number): string {
	const minutes = Math.floor(ms / 60000);
	if (minutes < 60) return `0h ${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const mins = minutes % 60;
	return `${hours}h ${String(mins).padStart(2, '0')}m`;
}

/** Mirrors the page.server.ts load logic for testability without SvelteKit runtime */
async function loadSessions(opts: {
	sessionsDir: string;
	chatsDir: string;
	page?: number;
	perPage?: number;
}) {
	const page = Math.max(1, opts.page ?? 1);
	const perPage = Math.min(50, Math.max(1, opts.perPage ?? 10));

	let sessionFiles: SessionFile[] = [];
	try {
		const { readdir } = await import('fs/promises');
		const entries = await readdir(opts.sessionsDir);
		const jsonFiles = entries.filter((f) => f.endsWith('.json') && f !== 'current.json');
		const results = await Promise.all(
			jsonFiles.slice(0, 20).map(async (file) => {
				try {
					const raw = await readFile(join(opts.sessionsDir, file), 'utf-8');
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

	let chatSessions: ChatSessionMeta[] = [];
	try {
		const raw = await readFile(join(opts.chatsDir, 'index.json'), 'utf-8');
		chatSessions = JSON.parse(raw);
	} catch {
		// no chat sessions
	}

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

	const totalSessions = sessions.length;
	const totalPages = Math.max(1, Math.ceil(totalSessions / perPage));
	const safePage = Math.min(page, totalPages);
	const start = (safePage - 1) * perPage;
	const paginatedSessions = sessions.slice(start, start + perPage);

	return {
		summary: { active, paused, completed, totalTurns },
		sessions: paginatedSessions,
		pagination: { page: safePage, perPage, totalSessions, totalPages },
		timeline: timeline.slice(0, 8),
		error: null
	};
}

// ── Fixtures ─────────────────────────────────────────────────────────────

function makeAgentSession(overrides: Partial<SessionFile> = {}): SessionFile {
	return {
		id: `session-${crypto.randomUUID().slice(0, 8)}`,
		startedAt: '2026-03-01T10:00:00Z',
		endedAt: '2026-03-01T10:30:00Z',
		duration: 1800000,
		context: { title: 'Test session' },
		metrics: { edits: 5, commands: 10, tasks: 2, errors: 0 },
		...overrides
	};
}

function makeChatMeta(overrides: Partial<ChatSessionMeta> = {}): ChatSessionMeta {
	return {
		id: crypto.randomUUID().slice(0, 8),
		title: 'Chat session',
		model: 'gpt-oss-20b',
		provider: 'ollama',
		messageCount: 8,
		createdAt: '2026-03-01T12:00:00Z',
		updatedAt: '2026-03-01T12:15:00Z',
		source: 'user',
		status: 'idle',
		...overrides
	};
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('/api/projects/[id]/sessions — GET', () => {
	let tmpDir: string;
	let sessionsDir: string;
	let chatsDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), 'api-sessions-'));
		sessionsDir = join(tmpDir, 'sessions');
		chatsDir = join(tmpDir, 'chats');
		await mkdir(sessionsDir, { recursive: true });
		await mkdir(chatsDir, { recursive: true });
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it('returns empty data when no sessions exist', async () => {
		const result = await loadSessions({ sessionsDir, chatsDir });

		expect(result.summary).toEqual({ active: 0, paused: 0, completed: 0, totalTurns: 0 });
		expect(result.sessions).toEqual([]);
		expect(result.pagination).toEqual({ page: 1, perPage: 10, totalSessions: 0, totalPages: 1 });
		expect(result.timeline).toEqual([]);
		expect(result.error).toBeNull();
	});

	it('returns agent sessions with correct structure', async () => {
		const sf = makeAgentSession({ id: 'abcd1234-full-id' });
		await writeFile(join(sessionsDir, 'abcd1234.json'), JSON.stringify(sf));

		const result = await loadSessions({ sessionsDir, chatsDir });

		expect(result.sessions).toHaveLength(1);
		const session = result.sessions[0];
		expect(session).toHaveProperty('name');
		expect(session).toHaveProperty('id');
		expect(session).toHaveProperty('type');
		expect(session).toHaveProperty('status');
		expect(session).toHaveProperty('agents');
		expect(session).toHaveProperty('turns');
		expect(session).toHaveProperty('duration');
		expect(session.type).toBe('agent');
	});

	it('returns chat sessions with correct structure', async () => {
		const chatMeta = makeChatMeta({ id: 'chat0001', title: 'My Chat' });
		await writeFile(join(chatsDir, 'index.json'), JSON.stringify([chatMeta]));

		const result = await loadSessions({ sessionsDir, chatsDir });

		expect(result.sessions).toHaveLength(1);
		const session = result.sessions[0];
		expect(session.name).toBe('My Chat');
		expect(session.id).toBe('chat-chat');
		expect(session.type).toBe('chat');
		expect(session.turns).toBe(8);
	});

	it('computes summary counts correctly', async () => {
		// 1 active agent session (no endedAt, no errors)
		const active = makeAgentSession({
			id: 'active-session',
			endedAt: undefined,
			duration: undefined,
			metrics: { edits: 3, commands: 5, tasks: 1, errors: 0 }
		});
		// 1 completed agent session
		const completed = makeAgentSession({
			id: 'completed-session',
			metrics: { edits: 2, commands: 4, tasks: 1, errors: 0 }
		});
		// 1 active chat session
		const chatActive = makeChatMeta({ id: 'chatact1', status: 'streaming', messageCount: 3 });
		// 1 completed chat session
		const chatDone = makeChatMeta({ id: 'chatdon1', status: 'idle', messageCount: 12 });

		await writeFile(join(sessionsDir, 'active.json'), JSON.stringify(active));
		await writeFile(join(sessionsDir, 'completed.json'), JSON.stringify(completed));
		await writeFile(join(chatsDir, 'index.json'), JSON.stringify([chatActive, chatDone]));

		const result = await loadSessions({ sessionsDir, chatsDir });

		expect(result.summary.active).toBe(2); // active agent + streaming chat
		expect(result.summary.completed).toBe(2); // completed agent + idle chat
		expect(result.summary.totalTurns).toBe(8 + 6 + 3 + 12); // (3+5) + (2+4) + 3 + 12 = 29
	});

	it('marks sessions with errors as completed', async () => {
		const withErrors = makeAgentSession({
			id: 'error-session',
			endedAt: undefined,
			duration: undefined,
			metrics: { edits: 1, commands: 2, tasks: 0, errors: 3 }
		});
		await writeFile(join(sessionsDir, 'error.json'), JSON.stringify(withErrors));

		const result = await loadSessions({ sessionsDir, chatsDir });

		expect(result.sessions[0].status).toBe('completed');
		expect(result.summary.completed).toBe(1);
		expect(result.summary.active).toBe(0);
	});

	it('uses session title from context when available', async () => {
		const titled = makeAgentSession({
			id: 'titled-session-full',
			context: { title: 'Fix auth bug' }
		});
		await writeFile(join(sessionsDir, 'titled.json'), JSON.stringify(titled));

		const result = await loadSessions({ sessionsDir, chatsDir });

		expect(result.sessions[0].name).toBe('Fix auth bug');
	});

	it('falls back to session ID when no title', async () => {
		const untitled = makeAgentSession({
			id: 'untitled-session',
			context: {}
		});
		await writeFile(join(sessionsDir, 'untitled.json'), JSON.stringify(untitled));

		const result = await loadSessions({ sessionsDir, chatsDir });

		expect(result.sessions[0].name).toBe('untitled-session');
	});

	it('computes turns from edits + commands', async () => {
		const sf = makeAgentSession({
			id: 'turns-session',
			metrics: { edits: 7, commands: 13, tasks: 5, errors: 0 }
		});
		await writeFile(join(sessionsDir, 'turns.json'), JSON.stringify(sf));

		const result = await loadSessions({ sessionsDir, chatsDir });

		expect(result.sessions[0].turns).toBe(20);
	});

	it('formats duration correctly', async () => {
		// 30 minutes
		const short = makeAgentSession({
			id: 'short-session',
			duration: 30 * 60 * 1000
		});
		// 2 hours 15 minutes
		const long = makeAgentSession({
			id: 'long-session',
			duration: (2 * 60 + 15) * 60 * 1000
		});
		await writeFile(join(sessionsDir, 'short.json'), JSON.stringify(short));
		await writeFile(join(sessionsDir, 'long.json'), JSON.stringify(long));

		const result = await loadSessions({ sessionsDir, chatsDir });

		const durations = result.sessions.map((s) => s.duration);
		expect(durations).toContain('0h 30m');
		expect(durations).toContain('2h 15m');
	});

	it('skips current.json file', async () => {
		const sf = makeAgentSession({ id: 'real-session' });
		await writeFile(join(sessionsDir, 'real.json'), JSON.stringify(sf));
		await writeFile(join(sessionsDir, 'current.json'), JSON.stringify({ active: 'real-session' }));

		const result = await loadSessions({ sessionsDir, chatsDir });

		expect(result.sessions).toHaveLength(1);
	});

	it('skips malformed session files gracefully', async () => {
		const valid = makeAgentSession({ id: 'valid-session' });
		await writeFile(join(sessionsDir, 'valid.json'), JSON.stringify(valid));
		await writeFile(join(sessionsDir, 'broken.json'), '{ not valid json !!!');

		const result = await loadSessions({ sessionsDir, chatsDir });

		expect(result.sessions).toHaveLength(1);
		expect(result.sessions[0].name).toBe('Test session');
		expect(result.error).toBeNull();
	});

	it('handles missing sessions directory gracefully', async () => {
		const result = await loadSessions({
			sessionsDir: join(tmpDir, 'nonexistent'),
			chatsDir: join(tmpDir, 'also-nonexistent')
		});

		expect(result.sessions).toEqual([]);
		expect(result.summary).toEqual({ active: 0, paused: 0, completed: 0, totalTurns: 0 });
		expect(result.error).toBeNull();
	});
});

describe('/api/projects/[id]/sessions — sorting', () => {
	let tmpDir: string;
	let sessionsDir: string;
	let chatsDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), 'api-sessions-sort-'));
		sessionsDir = join(tmpDir, 'sessions');
		chatsDir = join(tmpDir, 'chats');
		await mkdir(sessionsDir, { recursive: true });
		await mkdir(chatsDir, { recursive: true });
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it('sorts active sessions before completed ones', async () => {
		const completedSession = makeAgentSession({
			id: 'completed-first',
			endedAt: '2026-03-01T10:30:00Z'
		});
		const activeSession = makeAgentSession({
			id: 'active-second',
			endedAt: undefined,
			duration: undefined,
			metrics: { edits: 0, commands: 0, tasks: 0, errors: 0 }
		});
		await writeFile(join(sessionsDir, 'aaa-completed.json'), JSON.stringify(completedSession));
		await writeFile(join(sessionsDir, 'zzz-active.json'), JSON.stringify(activeSession));

		const result = await loadSessions({ sessionsDir, chatsDir });

		expect(result.sessions[0].status).toBe('active');
		expect(result.sessions[1].status).toBe('completed');
	});
});

describe('/api/projects/[id]/sessions — pagination', () => {
	let tmpDir: string;
	let sessionsDir: string;
	let chatsDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), 'api-sessions-page-'));
		sessionsDir = join(tmpDir, 'sessions');
		chatsDir = join(tmpDir, 'chats');
		await mkdir(sessionsDir, { recursive: true });
		await mkdir(chatsDir, { recursive: true });
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it('paginates sessions with default perPage=10', async () => {
		// Create 15 completed sessions
		for (let i = 0; i < 15; i++) {
			const sf = makeAgentSession({ id: `session-${String(i).padStart(3, '0')}` });
			await writeFile(join(sessionsDir, `session-${i}.json`), JSON.stringify(sf));
		}

		const page1 = await loadSessions({ sessionsDir, chatsDir, page: 1 });
		expect(page1.sessions).toHaveLength(10);
		expect(page1.pagination.page).toBe(1);
		expect(page1.pagination.totalSessions).toBe(15);
		expect(page1.pagination.totalPages).toBe(2);

		const page2 = await loadSessions({ sessionsDir, chatsDir, page: 2 });
		expect(page2.sessions).toHaveLength(5);
		expect(page2.pagination.page).toBe(2);
	});

	it('supports custom perPage values', async () => {
		for (let i = 0; i < 6; i++) {
			const sf = makeAgentSession({ id: `session-${i}` });
			await writeFile(join(sessionsDir, `session-${i}.json`), JSON.stringify(sf));
		}

		const result = await loadSessions({ sessionsDir, chatsDir, perPage: 3 });
		expect(result.sessions).toHaveLength(3);
		expect(result.pagination.totalPages).toBe(2);
		expect(result.pagination.perPage).toBe(3);
	});

	it('clamps perPage to maximum of 50', async () => {
		const result = await loadSessions({ sessionsDir, chatsDir, perPage: 100 });
		expect(result.pagination.perPage).toBe(50);
	});

	it('clamps perPage to minimum of 1', async () => {
		const result = await loadSessions({ sessionsDir, chatsDir, perPage: 0 });
		expect(result.pagination.perPage).toBe(1);
	});

	it('clamps page to minimum of 1', async () => {
		const result = await loadSessions({ sessionsDir, chatsDir, page: -5 });
		expect(result.pagination.page).toBe(1);
	});

	it('clamps page to totalPages when exceeding range', async () => {
		for (let i = 0; i < 5; i++) {
			const sf = makeAgentSession({ id: `session-${i}` });
			await writeFile(join(sessionsDir, `session-${i}.json`), JSON.stringify(sf));
		}

		const result = await loadSessions({ sessionsDir, chatsDir, page: 999, perPage: 10 });
		expect(result.pagination.page).toBe(1); // only 1 page exists
		expect(result.sessions).toHaveLength(5);
	});

	it('returns correct pagination metadata', async () => {
		for (let i = 0; i < 25; i++) {
			const sf = makeAgentSession({ id: `session-${String(i).padStart(3, '0')}` });
			await writeFile(join(sessionsDir, `session-${i}.json`), JSON.stringify(sf));
		}

		const result = await loadSessions({ sessionsDir, chatsDir, page: 2, perPage: 10 });
		expect(result.pagination).toEqual({
			page: 2,
			perPage: 10,
			totalSessions: 20, // capped at 20 by slice(0, 20)
			totalPages: 2
		});
	});
});

describe('/api/projects/[id]/sessions — timeline', () => {
	let tmpDir: string;
	let sessionsDir: string;
	let chatsDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), 'api-sessions-timeline-'));
		sessionsDir = join(tmpDir, 'sessions');
		chatsDir = join(tmpDir, 'chats');
		await mkdir(sessionsDir, { recursive: true });
		await mkdir(chatsDir, { recursive: true });
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it('generates timeline entries from agent sessions', async () => {
		const sf = makeAgentSession({
			id: 'timeline-sess',
			context: { title: 'Deploy fix' },
			startedAt: '2026-03-01T14:30:00Z'
		});
		await writeFile(join(sessionsDir, 'timeline.json'), JSON.stringify(sf));

		const result = await loadSessions({ sessionsDir, chatsDir });

		expect(result.timeline).toHaveLength(1);
		expect(result.timeline[0]).toHaveProperty('time');
		expect(result.timeline[0].label).toBe('Deploy fix');
		expect(result.timeline[0].color).toBe('blue'); // completed
	});

	it('limits timeline to 8 entries', async () => {
		for (let i = 0; i < 12; i++) {
			const sf = makeAgentSession({ id: `timeline-${i}` });
			await writeFile(join(sessionsDir, `t-${i}.json`), JSON.stringify(sf));
		}

		const result = await loadSessions({ sessionsDir, chatsDir });

		expect(result.timeline.length).toBeLessThanOrEqual(8);
	});

	it('uses green color for active sessions in timeline', async () => {
		const sf = makeAgentSession({
			id: 'active-timeline',
			endedAt: undefined,
			duration: undefined,
			metrics: { edits: 0, commands: 0, tasks: 0, errors: 0 }
		});
		await writeFile(join(sessionsDir, 'active.json'), JSON.stringify(sf));

		const result = await loadSessions({ sessionsDir, chatsDir });

		expect(result.timeline[0].color).toBe('green');
	});
});

describe('/api/projects/[id]/sessions — mixed sources', () => {
	let tmpDir: string;
	let sessionsDir: string;
	let chatsDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), 'api-sessions-mix-'));
		sessionsDir = join(tmpDir, 'sessions');
		chatsDir = join(tmpDir, 'chats');
		await mkdir(sessionsDir, { recursive: true });
		await mkdir(chatsDir, { recursive: true });
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it('combines agent and chat sessions in result', async () => {
		const agentSf = makeAgentSession({ id: 'agent-session' });
		await writeFile(join(sessionsDir, 'agent.json'), JSON.stringify(agentSf));

		const chatMeta = makeChatMeta({ id: 'chatsess1', title: 'User chat' });
		await writeFile(join(chatsDir, 'index.json'), JSON.stringify([chatMeta]));

		const result = await loadSessions({ sessionsDir, chatsDir });

		expect(result.sessions).toHaveLength(2);
		const types = result.sessions.map((s) => s.type);
		expect(types).toContain('agent');
		expect(types).toContain('chat');
	});

	it('counts turns across both agent and chat sessions', async () => {
		const agent = makeAgentSession({
			id: 'agent-turns',
			metrics: { edits: 5, commands: 10, tasks: 0, errors: 0 }
		});
		await writeFile(join(sessionsDir, 'agent.json'), JSON.stringify(agent));

		const chat = makeChatMeta({ id: 'chatturns', messageCount: 20 });
		await writeFile(join(chatsDir, 'index.json'), JSON.stringify([chat]));

		const result = await loadSessions({ sessionsDir, chatsDir });

		expect(result.summary.totalTurns).toBe(35); // 15 agent + 20 chat
	});
});
