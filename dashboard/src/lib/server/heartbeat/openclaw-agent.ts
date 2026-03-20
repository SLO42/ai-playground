/**
 * OpenClaw agent — runs tasks through the OpenClaw gateway (WS on port 18789).
 * The gateway routes to local Ollama but extends with tools, workspace, skills.
 *
 * Capabilities:
 * - Context gathering: scopes projects, reads files, builds context for Claude Code
 * - Task execution: handles analysis, reviews, planning, task creation ($0)
 * - Memory updates: stores learnings and project profiles for future agents
 * - Pre-task scouting: preps context before Claude Code agents start
 */
import { writeFile } from 'fs/promises';
import { join } from 'path';
import { APIS, PATHS, WORKSPACE_ROOT } from '../constants.js';
import {
	MONITOR_SESSION_ID, agentSender, getActiveAgents,
	log, trimSession, loadMonitorSession, saveMonitorSession,
	readSessionIndex, upsertSessionMeta, ensureTaskSession
} from './shared.js';
import { recordEvent } from './agent-analytics.js';
import { queryGateway } from './gateway-client.js';
import type { ChatSession, ChatSender } from '$lib/types/chat.js';
import type { Task } from '$lib/types/tasks.js';

const DEFAULT_MODEL = 'gpt-oss:20b';

// ── Task Classification ──────────────────────────────────────────────

export type TaskRoute = 'openclaw' | 'openclaw-context' | 'claude-code';

/**
 * Classify how a task should be handled:
 * - 'openclaw': fully handled by OpenClaw (analysis, reviews, planning)
 * - 'openclaw-context': needs Claude Code, but OpenClaw should gather context first
 * - 'claude-code': direct to Claude Code (simple fixes, clear scope)
 */
export function classifyTask(task: Task): TaskRoute {
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

	// Tasks where OpenClaw should scope/gather context before Claude Code works
	const contextKeywords = [
		'scope', 'explore', 'understand', 'learn', 'discover',
		'map out', 'profile', 'inventory', 'catalog',
		'cross-project', 'multi-project', 'all projects',
		'new project', 'onboard', 'bootstrap'
	];

	// OpenClaw handles fully — planning, analysis, task creation, discussion
	const openclawKeywords = [
		'review', 'audit', 'analyze', 'discuss', 'plan', 'evaluate',
		'prioritize', 'triage', 'assess', 'recommend', 'summarize',
		'report', 'index', 'scan', 'check', 'investigate', 'research',
		'create task', 'plan feature', 'break down', 'decompose',
		'estimate', 'design', 'architect', 'propose', 'outline',
		'categorize', 'organize', 'group', 'milestone', 'roadmap',
		'release plan', 'sprint', 'backlog', 'groom', 'refine backlog',
		'identify', 'list', 'inventory', 'compare', 'benchmark',
		'document plan', 'write spec', 'requirements', 'acceptance criteria',
		'update memory', 'store context', 'project profile', 'scope project'
	];

	// Context-first tasks: complex code work on unfamiliar projects
	if (contextKeywords.some(k => text.includes(k))) {
		return 'openclaw-context';
	}

	// OpenClaw-only tasks
	if (openclawKeywords.some(k => text.includes(k))) {
		return 'openclaw';
	}

	// Tags that indicate OpenClaw territory
	if (task.flagDiscussion) return 'openclaw';
	const openclawTags = ['review', 'analysis', 'planning', 'triage', 'design', 'roadmap', 'feature-planning', 'context', 'scoping'];
	if (task.tags.some(t => openclawTags.includes(t))) {
		return 'openclaw';
	}

	// Code tasks that reference external projects benefit from context gathering
	if (codeKeywords.some(k => text.includes(k))) {
		// Check if this references a project outside ai-playground
		const externalProjectRefs = ['mods', 'rounds', 'builderproject', 'randofy', 'tools'];
		if (externalProjectRefs.some(p => text.includes(p))) {
			return 'openclaw-context';
		}
		return 'claude-code';
	}

	// Default to claude-code for anything ambiguous (safer — it can do everything)
	return 'claude-code';
}

// ── Gateway Query ────────────────────────────────────────────────────

interface OllamaResponse {
	message?: { content?: string; role?: string };
	done?: boolean;
	error?: string;
	// Token usage fields returned by Ollama API
	prompt_eval_count?: number;
	eval_count?: number;
	total_duration?: number;
}

/** Result from OpenClaw/Ollama query, including token counts when available. */
interface QueryResult {
	content: string;
	inputTokens: number;
	outputTokens: number;
}

/** Run a prompt through the OpenClaw gateway (falls back to direct Ollama). */
async function queryOpenClaw(messages: Array<{ role: string; content: string }>, sessionKey?: string): Promise<QueryResult> {
	const prompt = messages
		.map(m => m.role === 'system' ? `[System] ${m.content}` : m.content)
		.join('\n\n');

	try {
		const content = await queryGateway(prompt, sessionKey);
		// Gateway doesn't return token counts — estimate from text length
		return { content, inputTokens: 0, outputTokens: 0 };
	} catch {
		return queryOllamaFallback(messages);
	}
}

/** Direct Ollama fallback when gateway is unavailable. Returns content + token counts. */
async function queryOllamaFallback(messages: Array<{ role: string; content: string }>): Promise<{
	content: string;
	inputTokens: number;
	outputTokens: number;
}> {
	const res = await fetch(`${APIS.ollama}/api/chat`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			model: DEFAULT_MODEL,
			messages,
			stream: false
		}),
		signal: AbortSignal.timeout(30_000)
	});

	if (!res.ok) {
		const text = await res.text().catch(() => 'unknown error');
		throw new Error(`Ollama error ${res.status}: ${text}`);
	}

	const data = await res.json() as OllamaResponse;
	return {
		content: data.message?.content ?? '',
		inputTokens: data.prompt_eval_count ?? 0,
		outputTokens: data.eval_count ?? 0
	};
}

// ── Escalation Check ─────────────────────────────────────────────────

/** Escalation check — ask OpenClaw if it can handle this or needs Claude Code. */
export async function shouldEscalate(task: Task): Promise<{ escalate: boolean; reason: string }> {
	const route = classifyTask(task);
	if (route === 'claude-code') {
		return { escalate: true, reason: `keyword match: task needs code changes` };
	}
	if (route === 'openclaw-context') {
		return { escalate: false, reason: `context-first: OpenClaw will gather context, then hand off` };
	}

	// Double-check with the model for borderline cases
	try {
		const { content } = await queryOpenClaw([
			{
				role: 'system',
				content: 'You are a task router. Respond with ONLY "local" or "escalate" followed by a brief reason. "local" means the task is analysis/discussion/review that doesn\'t need file editing. "escalate" means the task requires writing/editing code files, running builds, or git operations.'
			},
			{
				role: 'user',
				content: `Task: ${task.title}\nDescription: ${task.description ?? 'none'}\nTags: ${task.tags.join(', ') || 'none'}`
			}
		], `route-${task.id}`);

		const lower = content.toLowerCase().trim();
		if (lower.startsWith('escalate')) {
			return { escalate: true, reason: content.slice(0, 100) };
		}
		return { escalate: false, reason: content.slice(0, 100) };
	} catch {
		return { escalate: true, reason: 'openclaw gateway unreachable — escalating to Claude Code' };
	}
}

// ── Context Gathering ────────────────────────────────────────────────

/**
 * Pre-task context gathering via OpenClaw.
 * Scopes a project, reads key files, and returns structured context
 * that gets injected into the Claude Code agent's prompt.
 */
export async function gatherContext(task: Task): Promise<string | null> {
	const text = `${task.title} ${task.description ?? ''} ${task.tags.join(' ')}`.toLowerCase();

	// Determine which project paths to scope
	const projectHints: string[] = [];
	if (text.includes('mods') || text.includes('rounds')) projectHints.push(join(WORKSPACE_ROOT, 'mods', 'rounds-mod'));
	if (text.includes('builderproject') || text.includes('builder')) projectHints.push(join(WORKSPACE_ROOT, 'builderproject'));
	if (text.includes('randofy')) projectHints.push(join(WORKSPACE_ROOT, 'Randofy'), join(WORKSPACE_ROOT, 'randofy-api'));
	if (text.includes('tools')) projectHints.push(join(WORKSPACE_ROOT, 'tools'));
	if (text.includes('dashboard') || text.includes('heartbeat')) projectHints.push(join(WORKSPACE_ROOT, 'ai-playground', 'dashboard'));

	// If no specific project detected, scope the task's source project
	if (projectHints.length === 0 && task._sourceProjectPath) {
		projectHints.push(task._sourceProjectPath);
	}

	if (projectHints.length === 0) return null;

	const projectPaths = projectHints.join(', ');

	try {
		const context = await queryOpenClaw([
			{
				role: 'system',
				content: `You are a context-gathering agent with access to the filesystem via tools. Your job is to explore project directories and produce a concise context brief for a coding agent that will work on the task next.

You have tool access to read files and execute commands in the ${WORKSPACE_ROOT} directory.

Return ONLY a structured context brief in this format:
## Project Context
- Project name, type, tech stack
- Key files relevant to the task
- Patterns and conventions used
- Any gotchas or known issues

## Task-Relevant Files
- List specific files the coder should read/edit
- Include line numbers if you can identify the relevant sections

## Recommendations
- Suggested approach
- Files to avoid modifying
- Dependencies to be aware of`
			},
			{
				role: 'user',
				content: `Gather context for this task:
**Task**: ${task.title}
**Description**: ${task.description ?? 'none'}
**Tags**: ${task.tags.join(', ') || 'none'}

**Project paths to scope**: ${projectPaths}

Explore the relevant project(s), read key files, and produce a context brief that will help a Claude Code agent work efficiently on this task.`
			}
		], `context-${task.id}`);

		return context.content || null;
	} catch (err) {
		// Context gathering is best-effort — don't block task execution
		return null;
	}
}

// ── Memory Updates ───────────────────────────────────────────────────

/**
 * After a task completes, ask OpenClaw to extract learnings and update memory.
 * This runs async and doesn't block the main flow.
 */
export async function updateMemoryFromResult(task: Task, result: string): Promise<void> {
	try {
		const { content: learning } = await queryOpenClaw([
			{
				role: 'system',
				content: `You are a memory curator. Given a completed task and its result, extract key learnings that future agents should know. Return ONLY a JSON object with these fields:
- "summary": one-line summary of what was learned
- "patterns": array of code patterns or conventions discovered
- "gotchas": array of pitfalls or issues to watch for
- "files": array of key files that were important
Return ONLY valid JSON, no markdown.`
			},
			{
				role: 'user',
				content: `Task: ${task.title}\nDescription: ${task.description ?? 'none'}\n\nResult:\n${result.slice(0, 2000)}`
			}
		], `memory-${task.id}`);

		// Store as analytics event for the memory bridge to pick up
		recordEvent({
			taskId: task.id, taskTitle: task.title,
			type: 'learning_extracted',
			model: DEFAULT_MODEL, modelTier: 'local', provider: 'openclaw',
			learningData: learning,
			projectId: task._sourceProjectId
		}).catch(() => {});

	} catch {
		// Memory extraction is best-effort
	}
}

// ── Agent Spawning ───────────────────────────────────────────────────

/** Spawn an OpenClaw agent — runs the task through the gateway and logs results. */
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
		pid: 0,
		startedAt: new Date().toISOString(),
		sender,
		logFile: '/dev/null',
		lastLogPos: 0,
		reportSessionId: reportId
	});

	log(monitorSession, `[spawn] OpenClaw agent → "${task.title}" → chat: ${reportId} (gateway, $0)`);

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
		const { content: response, inputTokens, outputTokens } = await queryOpenClaw([
			{
				role: 'system',
				content: `You are Claw, an autonomous AI agent with tool access (file read/write, exec) via the OpenClaw gateway. You can explore the filesystem at ${WORKSPACE_ROOT}, read files, and execute commands. Respond concisely and actionably. When the task involves analysis or context gathering, USE YOUR TOOLS to read actual files and explore the codebase — don't guess.`
			},
			{ role: 'user', content: prompt }
		], `task-${task.id}`);

		const durationMs = Date.now() - startTime;

		log(session, response, sender);
		log(session, `**Routed**: OpenClaw gateway (local + tools, $0) — ${(durationMs / 1000).toFixed(1)}s`, sender);

		// I/O previews for analytics
		const promptPreview = prompt.slice(0, 500);
		const responsePreview = response.length > 500 ? response.slice(-500) : response;

		// Analytics: OpenClaw completion (with token counts from Ollama fallback when available)
		recordEvent({
			taskId: task.id, taskTitle: task.title,
			type: 'completed',
			model: DEFAULT_MODEL, modelTier: 'local', provider: 'openclaw',
			durationMs, costUsd: 0, inputTokens, outputTokens,
			promptPreview, responsePreview,
			sessionId: reportId,
			projectId: task._sourceProjectId
		}).catch(() => {});

		// Extract learnings async
		updateMemoryFromResult(task, response).catch(() => {});

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
