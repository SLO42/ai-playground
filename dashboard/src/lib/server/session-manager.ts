import { readFile, writeFile, mkdir } from 'fs/promises';
import { PATHS } from './constants.js';
import type { ChatSession, ChatSessionMeta, ChatMessage, SessionStatus } from '$lib/types/chat.js';
import type { ProviderMessage, ToolCall } from './providers/types.js';
import { ollamaAdapter } from './providers/ollama.js';
import { claudeAdapter } from './providers/claude.js';
import { openclawAdapter } from './providers/openclaw.js';
import { TOOL_DEFINITIONS, executeTool } from './chat-tools.js';
import { pushNotification } from './notifications.js';
import { logRoutingDecision } from './routing-telemetry.js';
import { loadGeneralSettings, shouldAutoExecute, parseTimeoutMs } from './general-settings.js';
import { loadAgentDefaults } from './agent-defaults.js';

const MAX_TOOL_LOOPS = 5;

// ── Index write lock (prevents concurrent read-modify-write races) ──
let _indexLock = Promise.resolve();
function withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
	const prev = _indexLock;
	let release: () => void;
	_indexLock = new Promise(r => { release = r; });
	return prev.then(fn).finally(() => release!());
}

// ── In-memory state for active sessions ───────────────────────────────

export interface PendingToolCall {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

interface ActiveSession {
	id: string;
	status: SessionStatus;
	abortController: AbortController | null;
	subscribers: Set<(event: SessionEvent) => void>;
	idleTimer: ReturnType<typeof setTimeout> | null;
	/** Tool calls waiting for user confirmation before execution */
	pendingConfirmations: PendingToolCall[];
	/** Accumulated assistant text from the turn that produced pending tool calls */
	pendingAssistantText: string;
	/** All tool calls from the turn (including auto-approved ones already executed) */
	pendingAllToolCalls: ToolCall[];
}

export interface SessionEvent {
	type:
		| 'message'
		| 'content_delta'
		| 'tool_call'
		| 'tool_result'
		| 'status'
		| 'error'
		| 'done'
		| 'pending_confirmation';
	sessionId: string;
	message?: ChatMessage;
	content?: string;
	tool_call?: { id: string; name: string; arguments: Record<string, unknown> };
	tool_result?: { call_id: string; name: string; content: string };
	pending_confirmations?: PendingToolCall[];
	status?: SessionStatus;
	error?: string;
}

// Use globalThis to survive HMR module reloads — prevents orphaned timers and leaked sessions
const _g = globalThis as Record<string, unknown>;
if (!_g.__chat_active_sessions) {
	_g.__chat_active_sessions = new Map<string, ActiveSession>();
}
const activeSessions = _g.__chat_active_sessions as Map<string, ActiveSession>;

// ── Helpers ───────────────────────────────────────────────────────────

function getAdapter(provider: string) {
	switch (provider) {
		case 'claude': return claudeAdapter;
		case 'openclaw': return openclawAdapter;
		default: return ollamaAdapter;
	}
}

async function readIndex(): Promise<ChatSessionMeta[]> {
	try {
		const raw = await readFile(`${PATHS.chatsDir}/index.json`, 'utf-8');
		return JSON.parse(raw);
	} catch {
		return [];
	}
}

async function writeIndex(index: ChatSessionMeta[]) {
	await writeFile(`${PATHS.chatsDir}/index.json`, JSON.stringify(index, null, '\t'), 'utf-8');
}

async function loadSession(id: string): Promise<ChatSession | null> {
	try {
		const raw = await readFile(`${PATHS.chatsDir}/${id}.json`, 'utf-8');
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

async function saveSession(session: ChatSession) {
	session.updatedAt = new Date().toISOString();
	await writeFile(`${PATHS.chatsDir}/${session.id}.json`, JSON.stringify(session, null, '\t'), 'utf-8');

	const firstUserMsg = session.messages.find((m) => m.role === 'user');
	const title = firstUserMsg ? firstUserMsg.content.slice(0, 40) : 'New Chat';

	// Wrap index read-modify-write in a lock to prevent concurrent races
	await withIndexLock(async () => {
		const index = await readIndex();
		const idx = index.findIndex((s) => s.id === session.id);
		const meta: ChatSessionMeta = {
			id: session.id,
			title,
			model: session.model,
			provider: session.provider,
			messageCount: session.messages.length,
			createdAt: session.createdAt,
			updatedAt: session.updatedAt,
			source: session.source,
			status: session.status
		};
		if (idx >= 0) {
			index[idx] = meta;
		} else {
			index.unshift(meta);
		}
		await writeIndex(index);
	});
}

function broadcast(sessionId: string, event: SessionEvent) {
	const active = activeSessions.get(sessionId);
	if (!active) return;
	for (const fn of active.subscribers) {
		try { fn(event); } catch { active.subscribers.delete(fn); }
	}
}

// ── Public API ────────────────────────────────────────────────────────

/** Start an idle timeout for a session; cleans up the session after the configured duration */
async function startIdleTimer(sessionId: string) {
	const active = activeSessions.get(sessionId);
	if (!active) return;
	clearIdleTimer(active);

	const settings = await loadGeneralSettings();
	const timeoutMs = parseTimeoutMs(settings.defaultTimeout);
	if (timeoutMs <= 0) return; // "No timeout"

	active.idleTimer = setTimeout(async () => {
		const s = activeSessions.get(sessionId);
		if (s && s.status === 'idle') {
			broadcast(sessionId, { type: 'status', sessionId, status: 'idle' });
			activeSessions.delete(sessionId);
		}
	}, timeoutMs);
}

function clearIdleTimer(active: ActiveSession) {
	if (active.idleTimer) {
		clearTimeout(active.idleTimer);
		active.idleTimer = null;
	}
}

export function subscribe(sessionId: string, fn: (event: SessionEvent) => void): () => void {
	let active = activeSessions.get(sessionId);
	if (!active) {
		active = { id: sessionId, status: 'idle', abortController: null, subscribers: new Set(), idleTimer: null, pendingConfirmations: [], pendingAssistantText: '', pendingAllToolCalls: [] };
		activeSessions.set(sessionId, active);
	}
	active.subscribers.add(fn);
	return () => {
		active!.subscribers.delete(fn);
		if (active!.subscribers.size === 0) {
			clearIdleTimer(active!);
			if (active!.status === 'idle') {
				activeSessions.delete(sessionId);
			} else {
				// No subscribers left but session is still streaming/paused —
				// start a cleanup timer so it doesn't stay in memory forever.
				active!.idleTimer = setTimeout(() => {
					const s = activeSessions.get(sessionId);
					if (s && s.subscribers.size === 0) {
						if (s.abortController) s.abortController.abort();
						clearIdleTimer(s);
						activeSessions.delete(sessionId);
					}
				}, 5 * 60_000); // 5 min grace period
			}
		}
	};
}

export function getSessionStatus(sessionId: string): SessionStatus {
	return activeSessions.get(sessionId)?.status ?? 'idle';
}

/** List all active chat sessions (streaming, paused, etc.) */
export function getActiveSessions(): { id: string; status: SessionStatus }[] {
	return Array.from(activeSessions.entries()).map(([id, s]) => ({ id, status: s.status }));
}

/** Cancel an active session by aborting its request and removing it. */
export function cancelSession(sessionId: string): boolean {
	const active = activeSessions.get(sessionId);
	if (!active) return false;
	if (active.abortController) active.abortController.abort();
	if (active.idleTimer) clearTimeout(active.idleTimer);
	for (const fn of active.subscribers) {
		fn({ type: 'done', sessionId });
	}
	activeSessions.delete(sessionId);
	return true;
}

export async function startAutoSession(opts: {
	model?: string;
	provider?: string;
	systemPrompt?: string;
	userMessage: string;
	source?: string;
}): Promise<string> {
	await mkdir(PATHS.chatsDir, { recursive: true });

	// Apply agent defaults for model/provider when not explicitly provided
	const agentDefaults = await loadAgentDefaults();
	const model = opts.model ?? agentDefaults.defaultModel;
	const provider = opts.provider ?? (model.startsWith('claude') ? 'claude' : 'ollama');

	const id = crypto.randomUUID().slice(0, 8);
	const now = new Date().toISOString();

	const messages: ChatMessage[] = [];
	if (opts.systemPrompt) {
		messages.push({ role: 'system', content: opts.systemPrompt });
	}
	messages.push({ role: 'user', content: opts.userMessage });

	const session: ChatSession = {
		id,
		model,
		provider,
		createdAt: now,
		updatedAt: now,
		messages,
		source: 'claw',
		status: 'streaming'
	};

	await saveSession(session);

	// Fire notification
	await pushNotification({
		severity: 'info',
		category: 'agent',
		title: 'Claw started a session',
		message: opts.userMessage.slice(0, 100),
		source: opts.source ?? 'claw',
		link: `/chat?session=${id}`,
		linkLabel: 'View Session',
		desktop: false
	});

	// Log routing decision
	const startTime = Date.now();
	logRoutingDecision({
		model,
		provider,
		agent: provider === 'ollama' ? 'gpt-oss' : 'claude-code',
		taskType: inferTaskType(opts.userMessage),
		complexity: inferComplexity(opts.userMessage),
		latencyMs: 0,
		success: true,
		source: opts.source ?? 'claw',
		reason: `Auto-session started: ${opts.userMessage.slice(0, 60)}`,
		sessionId: id
	}).catch(() => {});

	// Start streaming in background
	streamSession(id).catch(err => console.error('[session-manager] Stream error:', err.message));

	return id;
}

function inferTaskType(message: string): string {
	const lower = message.toLowerCase();
	const patterns: [string[], string][] = [
		[['fix', 'bug', 'broken', 'error'], 'bugfix'],
		[['implement', 'add', 'create', 'build', 'feature'], 'implement'],
		[['refactor', 'clean', 'reorganize'], 'refactor'],
		[['analyze', 'review', 'audit', 'check'], 'analysis'],
		[['docs', 'document', 'readme', 'update docs'], 'docs'],
		[['config', 'setup', 'configure'], 'config'],
		[['test', 'spec', 'coverage'], 'testing'],
		[['migrate', 'upgrade', 'update all'], 'migration'],
		[['security', 'vulnerability', 'cve'], 'security']
	];
	for (const [keywords, type] of patterns) {
		if (keywords.some((k) => lower.includes(k))) return type;
	}
	return 'general';
}

function inferComplexity(message: string): number {
	const lower = message.toLowerCase();
	if (['migrate', 'rewrite', 'overhaul', 'architecture'].some((k) => lower.includes(k))) return 0.9;
	if (['implement', 'refactor', 'security', 'analyze'].some((k) => lower.includes(k))) return 0.6;
	if (['fix', 'bug', 'update', 'add'].some((k) => lower.includes(k))) return 0.4;
	if (['docs', 'config', 'rename', 'list'].some((k) => lower.includes(k))) return 0.15;
	return 0.5;
}

export async function injectMessage(sessionId: string, message: string): Promise<boolean> {
	const session = await loadSession(sessionId);
	if (!session) return false;

	// Pause if currently streaming
	const active = activeSessions.get(sessionId);
	if (active?.status === 'streaming') {
		active.abortController?.abort();
		active.status = 'paused';
	}

	// Add user message
	session.messages.push({ role: 'user', content: message });
	session.status = 'streaming';
	await saveSession(session);

	broadcast(sessionId, {
		type: 'message',
		sessionId,
		message: { role: 'user', content: message }
	});

	// Continue streaming with the injected message
	streamSession(sessionId).catch(err => console.error('[session-manager] Stream error:', err.message));
	return true;
}

export async function pauseSession(sessionId: string): Promise<boolean> {
	const active = activeSessions.get(sessionId);
	if (!active || active.status !== 'streaming') return false;

	active.abortController?.abort();
	active.status = 'paused';

	const session = await loadSession(sessionId);
	if (session) {
		session.status = 'paused';
		await saveSession(session);
	}

	broadcast(sessionId, { type: 'status', sessionId, status: 'paused' });
	return true;
}

export async function resumeSession(sessionId: string): Promise<boolean> {
	const active = activeSessions.get(sessionId);
	if (active && active.status !== 'paused' && active.status !== 'idle') return false;

	const session = await loadSession(sessionId);
	if (!session) return false;

	session.status = 'streaming';
	await saveSession(session);

	streamSession(sessionId).catch(err => console.error('[session-manager] Stream error:', err.message));
	return true;
}

// ── Streaming Engine ──────────────────────────────────────────────────

async function streamSession(sessionId: string) {
	let active = activeSessions.get(sessionId);
	if (!active) {
		active = { id: sessionId, status: 'streaming', abortController: null, subscribers: new Set(), idleTimer: null, pendingConfirmations: [], pendingAssistantText: '', pendingAllToolCalls: [] };
		activeSessions.set(sessionId, active);
	}
	clearIdleTimer(active);

	const ac = new AbortController();
	active.abortController = ac;
	active.status = 'streaming';
	broadcast(sessionId, { type: 'status', sessionId, status: 'streaming' });

	try {
		const session = await loadSession(sessionId);
		if (!session) throw new Error('Session not found');

		const adapter = getAdapter(session.provider);
		const settings = await loadGeneralSettings();
		const history: ProviderMessage[] = session.messages.map((m) => ({
			role: m.role,
			content: m.content,
			tool_calls: m.tool_calls,
			tool_call_id: m.tool_call_id
		}));

		let loops = 0;

		while (loops < MAX_TOOL_LOOPS) {
			if (ac.signal.aborted) break;
			loops++;

			let fullText = '';
			const pendingToolCalls: ToolCall[] = [];

			// Add empty assistant message to session
			const assistantMsg: ChatMessage = { role: 'assistant', content: '' };
			session.messages.push(assistantMsg);
			broadcast(sessionId, { type: 'message', sessionId, message: assistantMsg });

			for await (const chunk of adapter.stream(history, session.model, TOOL_DEFINITIONS)) {
				if (ac.signal.aborted) break;

				switch (chunk.type) {
					case 'text':
						fullText += chunk.content ?? '';
						assistantMsg.content = fullText;
						broadcast(sessionId, { type: 'content_delta', sessionId, content: chunk.content });
						break;

					case 'tool_call':
						if (chunk.tool_call) {
							pendingToolCalls.push(chunk.tool_call);
							broadcast(sessionId, {
								type: 'tool_call',
								sessionId,
								tool_call: {
									id: chunk.tool_call.id,
									name: chunk.tool_call.name,
									arguments: chunk.tool_call.arguments
								}
							});
						}
						break;

					case 'error':
						broadcast(sessionId, { type: 'error', sessionId, error: chunk.content });
						break;
				}
			}

			if (ac.signal.aborted) break;

			// Update assistant message content
			assistantMsg.content = fullText;
			if (pendingToolCalls.length > 0) {
				assistantMsg.tool_calls = pendingToolCalls;
			}

			// Save progress
			await saveSession(session);

			if (pendingToolCalls.length === 0) break;

			// Execute tools
			history.push({ role: 'assistant', content: fullText, tool_calls: pendingToolCalls });

			// Split tool calls into auto-execute vs needs-confirmation
			const autoExecCalls: ToolCall[] = [];
			const confirmCalls: PendingToolCall[] = [];
			for (const tc of pendingToolCalls) {
				if (shouldAutoExecute(tc.name, settings)) {
					autoExecCalls.push(tc);
				} else {
					confirmCalls.push({ id: tc.id, name: tc.name, arguments: tc.arguments });
				}
			}

			// Execute auto-approved tools immediately
			for (const tc of autoExecCalls) {
				const result = await executeTool(tc);
				broadcast(sessionId, {
					type: 'tool_result',
					sessionId,
					tool_result: { call_id: tc.id, name: tc.name, content: result }
				});

				const toolMsg: ChatMessage = {
					role: 'tool',
					content: result,
					tool_call_id: tc.id,
					tool_name: tc.name
				};
				session.messages.push(toolMsg);
				history.push({ role: 'tool', content: result, tool_call_id: tc.id });
			}

			// If any tools need confirmation, pause the session and wait
			if (confirmCalls.length > 0) {
				console.warn(
					`[session-manager] ${confirmCalls.length} tool(s) require confirmation: ${confirmCalls.map((t) => t.name).join(', ')}`
				);

				// Store pending state on the active session
				active.pendingConfirmations = confirmCalls;
				active.pendingAssistantText = fullText;
				active.pendingAllToolCalls = pendingToolCalls;
				active.status = 'waiting';

				session.status = 'waiting';
				await saveSession(session);

				// Notify all subscribers about the pending confirmations
				broadcast(sessionId, {
					type: 'pending_confirmation',
					sessionId,
					pending_confirmations: confirmCalls
				});
				broadcast(sessionId, { type: 'status', sessionId, status: 'waiting' });

				// Break the streaming loop — execution resumes via confirmToolCalls / denyToolCalls
				return;
			}

			await saveSession(session);
		}

		// Done streaming
		session.status = 'idle';
		await saveSession(session);
		active.status = 'idle';
		broadcast(sessionId, { type: 'done', sessionId });
		broadcast(sessionId, { type: 'status', sessionId, status: 'idle' });
		startIdleTimer(sessionId);

	} catch (err) {
		const msg = err instanceof Error ? err.message : 'Stream failed';
		if (!ac.signal.aborted) {
			broadcast(sessionId, { type: 'error', sessionId, error: msg });
		}
		active.status = active.status === 'streaming' ? 'idle' : active.status;

		const session = await loadSession(sessionId);
		if (session) {
			session.status = (active.status as SessionStatus) === 'paused' ? 'paused' : 'idle';
			await saveSession(session);
		}
	} finally {
		active.abortController = null;
	}
}

// ── Tool Confirmation API ─────────────────────────────────────────────

/** Get pending tool confirmations for a session (empty array if none) */
export function getPendingConfirmations(sessionId: string): PendingToolCall[] {
	const active = activeSessions.get(sessionId);
	if (!active || active.status !== 'waiting') return [];
	return [...active.pendingConfirmations];
}

/** Confirm and execute pending tool calls. Resumes the streaming loop afterward. */
export async function confirmToolCalls(
	sessionId: string,
	toolCallIds?: string[]
): Promise<boolean> {
	const active = activeSessions.get(sessionId);
	if (!active || active.status !== 'waiting' || active.pendingConfirmations.length === 0) {
		return false;
	}

	const session = await loadSession(sessionId);
	if (!session) return false;

	// Determine which pending calls to confirm (all if no specific IDs given)
	const idsToConfirm = toolCallIds
		? new Set(toolCallIds)
		: new Set(active.pendingConfirmations.map((tc) => tc.id));

	const confirmed = active.pendingConfirmations.filter((tc) => idsToConfirm.has(tc.id));
	const denied = active.pendingConfirmations.filter((tc) => !idsToConfirm.has(tc.id));

	// Execute confirmed tools
	for (const tc of confirmed) {
		const fullTc: ToolCall = active.pendingAllToolCalls.find((t) => t.id === tc.id) ?? {
			id: tc.id,
			name: tc.name,
			arguments: tc.arguments
		};
		const result = await executeTool(fullTc);
		broadcast(sessionId, {
			type: 'tool_result',
			sessionId,
			tool_result: { call_id: tc.id, name: tc.name, content: result }
		});

		const toolMsg: ChatMessage = {
			role: 'tool',
			content: result,
			tool_call_id: tc.id,
			tool_name: tc.name
		};
		session.messages.push(toolMsg);
	}

	// Deny remaining tools (return a denial message as the tool result)
	for (const tc of denied) {
		const denialResult = `Tool "${tc.name}" was denied by the user.`;
		const toolMsg: ChatMessage = {
			role: 'tool',
			content: denialResult,
			tool_call_id: tc.id,
			tool_name: tc.name
		};
		session.messages.push(toolMsg);
	}

	// Clear pending state
	active.pendingConfirmations = [];
	active.pendingAssistantText = '';
	active.pendingAllToolCalls = [];

	session.status = 'streaming';
	await saveSession(session);

	// Resume the streaming loop so the LLM can process tool results
	streamSession(sessionId).catch((err) =>
		console.error('[session-manager] Stream error after confirm:', err.message)
	);

	return true;
}

/** Deny all pending tool calls and resume the session with denial messages. */
export async function denyToolCalls(sessionId: string): Promise<boolean> {
	const active = activeSessions.get(sessionId);
	if (!active || active.status !== 'waiting' || active.pendingConfirmations.length === 0) {
		return false;
	}

	const session = await loadSession(sessionId);
	if (!session) return false;

	// Add denial result for every pending tool call
	for (const tc of active.pendingConfirmations) {
		const denialResult = `Tool "${tc.name}" was denied by the user.`;
		broadcast(sessionId, {
			type: 'tool_result',
			sessionId,
			tool_result: { call_id: tc.id, name: tc.name, content: denialResult }
		});

		const toolMsg: ChatMessage = {
			role: 'tool',
			content: denialResult,
			tool_call_id: tc.id,
			tool_name: tc.name
		};
		session.messages.push(toolMsg);
	}

	// Clear pending state
	active.pendingConfirmations = [];
	active.pendingAssistantText = '';
	active.pendingAllToolCalls = [];

	session.status = 'streaming';
	await saveSession(session);

	// Resume streaming so the LLM gets the denial results and can respond
	streamSession(sessionId).catch((err) =>
		console.error('[session-manager] Stream error after deny:', err.message)
	);

	return true;
}
