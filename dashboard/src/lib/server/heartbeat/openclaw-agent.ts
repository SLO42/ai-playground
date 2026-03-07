/**
 * OpenClaw agent — runs tasks through local Ollama instead of Claude Code.
 * Used for discussions, reviews, analysis — anything that doesn't need file editing.
 */
import { writeFile } from 'fs/promises';
import { APIS, PATHS } from '../constants.js';
import {
	MONITOR_SESSION_ID, agentSender, getActiveAgents,
	log, trimSession, loadMonitorSession, saveMonitorSession,
	readSessionIndex, upsertSessionMeta, ensureTaskSession
} from './shared.js';
import { recordEvent } from './agent-analytics.js';
import type { ChatSession, ChatSender } from '$lib/types/chat.js';
import type { Task } from '$lib/types/tasks.js';

const DEFAULT_MODEL = 'gpt-oss:20b';

/** Classify whether a task needs Claude Code (file edits) or can be handled by OpenClaw. */
export function classifyTask(task: Task): 'openclaw' | 'claude-code' {
	const text = `${task.title} ${task.description ?? ''} ${task.tags.join(' ')}`.toLowerCase();

	// Tasks that explicitly need code changes — must go to Claude Code
	const codeKeywords = [
		'implement', 'fix bug', 'refactor', 'create component', 'add feature',
		'write code', 'edit file', 'update code', 'migrate',
		'add endpoint', 'add route', 'add api', 'wire up', 'connect',
		'style css', 'tailwind', 'svelte component', 'typescript',
		'fix error', 'fix crash', 'fix 500', 'fix build',
		'create file', 'delete file', 'rename file',
		'git commit', 'git merge', 'git rebase'
	];

	if (codeKeywords.some(k => text.includes(k))) {
		return 'claude-code';
	}

	// Everything else OpenClaw can handle — planning, analysis, task creation, discussion
	const openclawKeywords = [
		'review', 'audit', 'analyze', 'discuss', 'plan', 'evaluate',
		'prioritize', 'triage', 'assess', 'recommend', 'summarize',
		'report', 'index', 'scan', 'check', 'investigate', 'research',
		'create task', 'plan feature', 'break down', 'decompose',
		'estimate', 'design', 'architect', 'propose', 'outline',
		'categorize', 'organize', 'group', 'milestone', 'roadmap',
		'release plan', 'sprint', 'backlog', 'groom', 'refine backlog',
		'identify', 'list', 'inventory', 'compare', 'benchmark',
		'document plan', 'write spec', 'requirements', 'acceptance criteria'
	];

	if (openclawKeywords.some(k => text.includes(k))) {
		return 'openclaw';
	}

	// Tags that indicate OpenClaw territory
	if (task.flagDiscussion) return 'openclaw';
	const openclawTags = ['review', 'analysis', 'planning', 'triage', 'design', 'roadmap', 'feature-planning'];
	if (task.tags.some(t => openclawTags.includes(t))) {
		return 'openclaw';
	}

	// Default to claude-code for anything ambiguous (safer — it can do everything)
	return 'claude-code';
}

interface OllamaResponse {
	message?: { content?: string; role?: string };
	done?: boolean;
	error?: string;
}

/** Run a prompt through Ollama and collect the full response. */
async function queryOllama(messages: Array<{ role: string; content: string }>, model?: string): Promise<string> {
	const res = await fetch(`${APIS.ollama}/api/chat`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			model: model ?? DEFAULT_MODEL,
			messages,
			stream: false
		})
	});

	if (!res.ok) {
		const text = await res.text().catch(() => 'unknown error');
		throw new Error(`Ollama error ${res.status}: ${text}`);
	}

	const data = await res.json() as OllamaResponse;
	return data.message?.content ?? '';
}

/** Escalation check — ask OpenClaw if it can handle this or needs Claude Code. */
export async function shouldEscalate(task: Task): Promise<{ escalate: boolean; reason: string }> {
	const keyword = classifyTask(task);
	if (keyword === 'claude-code') {
		return { escalate: true, reason: `keyword match: task needs code changes` };
	}

	// Double-check with the model for borderline cases
	try {
		const response = await queryOllama([
			{
				role: 'system',
				content: 'You are a task router. Respond with ONLY "local" or "escalate" followed by a brief reason. "local" means the task is analysis/discussion/review that doesn\'t need file editing. "escalate" means the task requires writing/editing code files, running builds, or git operations.'
			},
			{
				role: 'user',
				content: `Task: ${task.title}\nDescription: ${task.description ?? 'none'}\nTags: ${task.tags.join(', ') || 'none'}`
			}
		]);

		const lower = response.toLowerCase().trim();
		if (lower.startsWith('escalate')) {
			return { escalate: true, reason: response.slice(0, 100) };
		}
		return { escalate: false, reason: response.slice(0, 100) };
	} catch {
		// If Ollama is down, escalate to Claude Code since OpenClaw can't run
		return { escalate: true, reason: 'ollama unreachable — escalating to Claude Code' };
	}
}

/** Spawn an OpenClaw agent — runs the task through Ollama and logs results to a chat session. */
export async function spawnOpenClawAgent(
	task: Task,
	prompt: string,
	monitorSession: ChatSession
): Promise<boolean> {
	const agents = getActiveAgents();
	const sender = agentSender(task.id, task.title.slice(0, 30));
	const reportId = await ensureTaskSession(task, sender);
	const startTime = Date.now();

	agents.set(task.id, {
		taskId: task.id,
		pid: 0, // no child process — runs inline
		startedAt: new Date().toISOString(),
		sender,
		logFile: '',
		lastLogPos: 0,
		reportSessionId: reportId
	});

	log(monitorSession, `[spawn] OpenClaw agent → "${task.title}" → chat: ${reportId} (local, $0)`);

	// Run async — don't block the heartbeat
	runOpenClawTask(task, prompt, sender, reportId, startTime).catch((err) => {
		const msg = err instanceof Error ? err.message : 'openclaw agent failed';
		log(monitorSession, `[error] OpenClaw agent "${task.title}": ${msg}`);
	}).finally(() => {
		agents.delete(task.id);
	});

	return true;
}

async function runOpenClawTask(
	task: Task,
	prompt: string,
	sender: ChatSender,
	reportId: string,
	startTime: number
): Promise<void> {
	let session: ChatSession;
	try {
		const { readFile } = await import('fs/promises');
		const raw = await readFile(`${PATHS.chatsDir}/${reportId}.json`, 'utf-8');
		session = JSON.parse(raw);
	} catch {
		session = await loadMonitorSession();
	}

	try {
		const response = await queryOllama([
			{ role: 'system', content: 'You are Claw, an autonomous AI agent for the ai-playground project. Respond concisely and actionably.' },
			{ role: 'user', content: prompt }
		]);

		const durationMs = Date.now() - startTime;

		log(session, response, sender);
		log(session, `**Routed**: OpenClaw (local Ollama, $0) — ${(durationMs / 1000).toFixed(1)}s`, sender);

		// Analytics: OpenClaw completion
		recordEvent({
			taskId: task.id, taskTitle: task.title,
			type: 'completed',
			model: DEFAULT_MODEL, modelTier: 'local', provider: 'openclaw',
			durationMs, costUsd: 0, inputTokens: 0, outputTokens: 0,
			sessionId: reportId,
			projectId: task._sourceProjectId
		}).catch(() => {});

		trimSession(session);
		session.status = 'idle';
		session.updatedAt = new Date().toISOString();
		await writeFile(`${PATHS.chatsDir}/${reportId}.json`, JSON.stringify(session, null, '\t'), 'utf-8');

		await upsertSessionMeta({
			id: reportId,
			title: task.title,
			model: DEFAULT_MODEL,
			provider: 'openclaw',
			messageCount: session.messages.length,
			createdAt: session.createdAt,
			updatedAt: session.updatedAt,
			source: 'claw',
			status: 'idle'
		});

		// Also log to monitor
		const monitor = await loadMonitorSession();
		log(monitor, `[done] OpenClaw agent for "${task.title}" — completed in ${(durationMs / 1000).toFixed(1)}s ($0)`);
		await saveMonitorSession(monitor);

	} catch (err) {
		const msg = err instanceof Error ? err.message : 'unknown error';
		log(session, `**Error**: ${msg}`, sender);

		// Analytics: OpenClaw failure
		recordEvent({
			taskId: task.id, taskTitle: task.title,
			type: 'failed',
			model: DEFAULT_MODEL, modelTier: 'local', provider: 'openclaw',
			durationMs: Date.now() - startTime, costUsd: 0,
			projectId: task._sourceProjectId
		}).catch(() => {});

		session.status = 'idle';
		session.updatedAt = new Date().toISOString();
		await writeFile(`${PATHS.chatsDir}/${reportId}.json`, JSON.stringify(session, null, '\t'), 'utf-8');
	}
}
