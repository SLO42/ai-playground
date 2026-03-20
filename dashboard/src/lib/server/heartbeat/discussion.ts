/**
 * Discussion sessions — creates discussion prompts for tasks that need user input,
 * monitors for replies, and hands off to Claude Code agents.
 */
import { readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';
import { PATHS } from '../constants.js';
import { pushNotification } from '../notifications.js';
import { getAllTasks, updateTask } from '../task-store.js';
import {
	MONITOR_SESSION_ID, agentSender, getActiveAgents, getDiscussionMap,
	getMaxConcurrentAgents, log, readSessionIndex, upsertSessionMeta
} from './shared.js';
import { spawnClaude, buildTaskPromptWithDiscussion, pickModelForTask } from './agent-spawn.js';
import { logAgentCompletion, captureGitBaseline } from './agent-tracking.js';
import { recordSpawn, recordSpawnCompletion } from './session-pool.js';
import { parseStreamJsonLog } from './agent-tracking.js';
import { registerPid, unregisterPid } from './pid-registry.js';
import type { ChatSession } from '$lib/types/chat.js';
import type { Task } from '$lib/types/tasks.js';

// ── Reply queue for when all agent slots are full ────────────────────
interface PendingReply {
	task: Task;
	discussionContext: string;
	sessionId: string;
	timestamp: number;
}

const MAX_PENDING_REPLIES = 50;
const REPLY_TTL_MS = 10 * 60 * 1000; // 10 minutes

const pendingReplies: PendingReply[] = [];

/** Drain queued replies when an agent slot frees up. Called after agent completion. */
export async function drainPendingReplies(monitorSession: ChatSession): Promise<void> {
	// Expire stale entries first
	const now = Date.now();
	for (let i = pendingReplies.length - 1; i >= 0; i--) {
		if (now - pendingReplies[i].timestamp > REPLY_TTL_MS) {
			const expired = pendingReplies.splice(i, 1)[0];
			log(monitorSession, `[discuss] Queued reply for "${expired.task.title}" expired (>10min) — dropping`);
			pushNotification({
				severity: 'warning',
				category: 'agent',
				title: `Discussion reply expired`,
				message: `Reply for "${expired.task.title}" was queued too long and was dropped. Please reply again.`,
				source: 'claw',
				link: `/chat?session=${expired.sessionId}`,
				linkLabel: 'View Discussion',
				desktop: true
			}).catch(() => {});
		}
	}

	// Process oldest pending reply if there's a free slot
	while (pendingReplies.length > 0 && getActiveAgents().size < getMaxConcurrentAgents()) {
		const next = pendingReplies.shift()!;

		// Verify task is still actionable
		const allTasks = await getAllTasks(PATHS.root);
		const task = allTasks.find(t => t.id === next.task.id);
		if (!task || (task.status !== 'pending' && task.status !== 'in_progress')) {
			log(monitorSession, `[discuss] Queued reply for "${next.task.title}" — task no longer actionable, skipping`);
			continue;
		}

		log(monitorSession, `[discuss] Draining queued reply for "${task.title}"`);
		const success = await spawnAgentWithContext(task, monitorSession, next.discussionContext, next.sessionId);
		if (success) {
			await handleSuccessfulSpawn(task, next.sessionId, monitorSession);
		} else {
			// Still full (shouldn't happen, but be defensive) — re-queue at front
			pendingReplies.unshift(next);
			break;
		}
	}
}

/** Get the current pending reply queue length (for diagnostics). */
export function getPendingReplyCount(): number {
	return pendingReplies.length;
}

export async function createDiscussionSession(task: Task): Promise<string> {
	const sessionId = `discuss-${task.id}`;
	const now = new Date().toISOString();
	const sender = agentSender(task.id, `Discuss: ${task.title.slice(0, 20)}`);

	const session: ChatSession = {
		id: sessionId,
		model: 'system',
		provider: 'internal',
		createdAt: now,
		updatedAt: now,
		messages: [
			{
				role: 'system',
				content: `Discussion session for task: ${task.title}`
			},
			{
				role: 'assistant',
				content: buildDiscussionPrompt(task),
				sender
			}
		],
		source: 'claw',
		status: 'waiting'
	};

	await writeFile(
		`${PATHS.chatsDir}/${sessionId}.json`,
		JSON.stringify(session, null, '\t'),
		'utf-8'
	);

	await upsertSessionMeta({
		id: sessionId,
		title: `Discuss: ${task.title.slice(0, 30)}`,
		model: session.model,
		provider: session.provider,
		messageCount: session.messages.length,
		createdAt: now,
		updatedAt: now,
		source: 'claw',
		status: 'waiting'
	});

	return sessionId;
}

function buildDiscussionPrompt(task: Task): string {
	const lines = [
		`This task was flagged for discussion. The agent that picks this up will have full access to the project, CLAUDE.md, and the entire codebase — so I only need your input on decisions I can't make from the code alone.`,
		``,
		`**Task**: ${task.title}`,
		`**Priority**: ${task.priority}`,
		`**Tags**: ${task.tags.length > 0 ? task.tags.join(', ') : 'none'}`,
	];

	if (task.description) {
		lines.push(`**Description**: ${task.description}`);
	}

	lines.push(``, `**Questions**:`);

	const questions = generateDiscussionQuestions(task);
	for (const q of questions) {
		lines.push(`- ${q}`);
	}

	lines.push(
		``,
		`Reply and I'll hand this straight to a Claude Code agent to implement.`
	);

	return lines.join('\n');
}

function generateDiscussionQuestions(task: Task): string[] {
	const questions: string[] = [];
	const title = task.title.toLowerCase();
	const tags = task.tags.map(t => t.toLowerCase());

	if (tags.includes('settings') || title.includes('settings')) {
		questions.push('Should this be global-only, or do you want per-project overrides too?');
	}
	if (tags.includes('ui') || title.includes('ui') || title.includes('design')) {
		questions.push('Any specific look or behavior you have in mind?');
	}
	if (tags.includes('reports') || title.includes('report')) {
		questions.push('What should this report actually tell you? What decisions does it help with?');
	}
	if (title.includes('rework') || title.includes('remove')) {
		questions.push('Rework into something useful, or just remove it?');
	}
	if (tags.includes('security') || title.includes('api key') || title.includes('secret')) {
		questions.push('How visible should sensitive values be — hidden, masked, or shown?');
	}
	if (title.includes('wire') || title.includes('connect') || title.includes('integrate')) {
		questions.push('Any specific behavior or edge cases you care about?');
	}

	if (questions.length === 0) {
		questions.push('What outcome are you expecting from this?');
	}

	return questions;
}

export async function checkDiscussionReplies(monitorSession: ChatSession): Promise<void> {
	const discussions = getDiscussionMap();

	// Scan for discussion sessions we may have lost track of (HMR, restart)
	// Includes both task discussions (discuss-*) and PM sessions (pm-*)
	try {
		const index = await readSessionIndex();
		for (const meta of index) {
			if (meta.status !== 'waiting') continue;
			if (meta.id.startsWith('discuss-')) {
				const taskId = meta.id.replace('discuss-', '');
				if (!discussions.has(taskId)) {
					discussions.set(taskId, meta.id);
				}
			} else if (meta.id.startsWith('pm-')) {
				// PM sessions use the session ID as the key
				if (!discussions.has(meta.id)) {
					discussions.set(meta.id, meta.id);
				}
			}
		}
	} catch { /* index read failed */ }

	if (discussions.size === 0) return;

	// Hoist task list outside the loop — one read per heartbeat cycle
	const allTasks = await getAllTasks(PATHS.root);

	for (const [taskId, sessionId] of discussions) {
		try {
			const raw = await readFile(`${PATHS.chatsDir}/${sessionId}.json`, 'utf-8');
			const session: ChatSession = JSON.parse(raw);

			if (session.status !== 'waiting') {
				discussions.delete(taskId);
				continue;
			}

			const userReplies = session.messages.filter(m => m.role === 'user');
			if (userReplies.length === 0) continue;

			// Validate that the latest reply has actual content
			const lastReply = userReplies[userReplies.length - 1];
			const content = lastReply.content?.trim();
			if (!content) continue; // skip empty replies

			log(monitorSession, `[discuss] User responded to "${taskId}" — handing off to Claude Code agent`);

			const discussionContext = session.messages
				.filter(m => m.role !== 'system')
				.map(m => `${m.sender?.label ?? m.role}: ${m.content}`)
				.join('\n\n');

			// PM sessions (pm-*) don't have a real task — synthesize one
			let task: Task | undefined;
			if (sessionId.startsWith('pm-')) {
				const projectId = sessionId.replace('pm-', '');
				task = {
					id: sessionId,
					title: `PM roadmap planning: ${projectId}`,
					description: 'Project Manager discussion — update roadmap based on user input',
					status: 'pending',
					priority: 'high',
					flagDiscussion: false,
					assignee: 'claw',
					tags: ['project-manager', 'roadmap'],
					feature: null,
					createdBy: 'pm',
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					completedAt: null
				};
			} else {
				task = allTasks.find(t => t.id === taskId);
			}

			if (task && (task.status === 'pending' || task.status === 'in_progress')) {
				if (!sessionId.startsWith('pm-')) {
					await updateTask(PATHS.root, taskId, {
						flagDiscussion: false,
						assignee: 'claw'
					}).catch(() => {});
				}

				const success = await spawnAgentWithContext(task, monitorSession, discussionContext, sessionId);
				if (success) {
					discussions.delete(taskId);
					await handleSuccessfulSpawn(task, sessionId, monitorSession);
				} else {
					discussions.delete(taskId);
					enqueueReply(task, discussionContext, sessionId, monitorSession);
				}
			} else {
				discussions.delete(taskId);
				log(monitorSession, `[discuss] Task "${taskId}" not found or already completed — closing discussion`);
			}
		} catch { /* session file missing or corrupt */ }
	}
}

async function handleSuccessfulSpawn(task: Task, sessionId: string, monitorSession: ChatSession): Promise<void> {
	await updateTask(PATHS.root, task.id, { status: 'in_progress' }).catch(() => {});

	// Update session file to streaming
	try {
		const raw = await readFile(`${PATHS.chatsDir}/${sessionId}.json`, 'utf-8');
		const session: ChatSession = JSON.parse(raw);
		session.status = 'streaming';
		const agentSnd = agentSender(task.id, task.title.slice(0, 30));
		session.messages.push({
			role: 'assistant',
			content: `Understood. Spawning a Claude Code agent to handle this. I'll post progress updates here.`,
			sender: agentSnd
		});
		await writeFile(
			`${PATHS.chatsDir}/${sessionId}.json`,
			JSON.stringify(session, null, '\t'),
			'utf-8'
		);
	} catch { /* session file missing or corrupt */ }

	try {
		const existingIndex = await readSessionIndex();
		const si = existingIndex.findIndex(s => s.id === sessionId);
		if (si >= 0) {
			await upsertSessionMeta({ ...existingIndex[si], status: 'streaming', updatedAt: new Date().toISOString() });
		}
	} catch { /* index update failed */ }

	await pushNotification({
		severity: 'info',
		category: 'agent',
		title: `Discussion resolved: ${task.title}`,
		message: `Claude Code agent spawned — follow progress in chat`,
		source: 'claw',
		link: `/chat?session=${sessionId}`,
		linkLabel: 'View Progress',
		desktop: true
	});
}

function enqueueReply(task: Task, discussionContext: string, sessionId: string, monitorSession: ChatSession): void {
	// Check if already queued for this task
	if (pendingReplies.some(r => r.task.id === task.id)) {
		log(monitorSession, `[discuss] Reply for "${task.title}" already queued — skipping duplicate`);
		return;
	}

	if (pendingReplies.length >= MAX_PENDING_REPLIES) {
		// Drop the oldest entry to make room
		const dropped = pendingReplies.shift()!;
		log(monitorSession, `[discuss] Reply queue full (${MAX_PENDING_REPLIES}) — dropped oldest: "${dropped.task.title}"`);
		pushNotification({
			severity: 'warning',
			category: 'agent',
			title: `Discussion reply dropped`,
			message: `Queue is full. Reply for "${dropped.task.title}" was dropped. Please reply again when agents are free.`,
			source: 'claw',
			link: `/chat?session=${dropped.sessionId}`,
			linkLabel: 'View Discussion',
			desktop: true
		}).catch(() => {});
	}

	pendingReplies.push({
		task,
		discussionContext,
		sessionId,
		timestamp: Date.now()
	});

	log(monitorSession, `[discuss] Reply for "${task.title}" queued (${pendingReplies.length} pending) — agents busy`);
	pushNotification({
		severity: 'info',
		category: 'agent',
		title: `Reply queued — agents busy`,
		message: `Your reply for "${task.title}" is queued and will be processed when an agent slot opens.`,
		source: 'claw',
		link: `/chat?session=${sessionId}`,
		linkLabel: 'View Discussion',
		desktop: true
	}).catch(() => {});
}

async function spawnAgentWithContext(task: Task, monitorSession: ChatSession, discussionContext: string, discussionSessionId: string): Promise<boolean> {
	const agents = getActiveAgents();

	if (agents.size >= getMaxConcurrentAgents()) {
		log(monitorSession, `[skip] Max agents — deferring discussed task "${task.title}"`);
		return false;
	}

	const prompt = buildTaskPromptWithDiscussion(task, discussionContext);
	const logFile = resolve(PATHS.headlessLogsDir, `agent-${task.id}.log`);
	const sender = agentSender(task.id, task.title.slice(0, 30));

	try {
		const baseline = await captureGitBaseline();
		const model = pickModelForTask(task);
		recordSpawn().catch(() => {});
		const child = await spawnClaude(prompt, logFile, { model });

		const pid = child.pid ?? 0;
		agents.set(task.id, {
			taskId: task.id,
			pid,
			startedAt: new Date().toISOString(),
			sender,
			logFile,
			lastLogPos: 0,
			reportSessionId: discussionSessionId,
			gitBaseline: baseline
		});

		registerPid(pid, `agent:${task.id}`, 'agent').catch(() => {});

		child.on('close', async (code) => {
			unregisterPid(`agent:${task.id}`).catch(() => {});
			const agentInfo = agents.get(task.id);
			const agentSnd = agentInfo?.sender ?? sender;
			const reportId = agentInfo?.reportSessionId ?? discussionSessionId;
			const agentBaseline = agentInfo?.gitBaseline;
			agents.delete(task.id);

			const exitMsg = code === 0 ? 'completed successfully' : `exited with code ${code}`;

			// Parse log for token usage stats
			const parsed = await parseStreamJsonLog(logFile);
			recordSpawnCompletion(
				parsed.usage?.totalTokens ?? 0,
				parsed.usage?.costUsd ?? 0
			).catch(() => {});
			logAgentCompletion(task, agentSnd, exitMsg, logFile, reportId, agentBaseline).catch(() => {});
			if (reportId !== MONITOR_SESSION_ID) {
				logAgentCompletion(task, agentSnd, exitMsg, logFile, MONITOR_SESSION_ID, agentBaseline, { skipUsageRecord: true }).catch(() => {});
			}

			pushNotification({
				severity: code === 0 ? 'success' : 'warning',
				category: 'agent',
				title: `Agent finished: ${task.title}`,
				message: `Task ${task.id} — ${exitMsg} (after discussion)`,
				source: 'claw',
				link: `/chat?session=${reportId}`,
				linkLabel: 'View Discussion',
				desktop: true
			}).catch(() => {});

			if (code === 0) {
				updateTask(PATHS.root, task.id, { status: 'completed' }).catch(() => {});
			} else {
				updateTask(PATHS.root, task.id, { status: 'pending', assignee: null }).catch(() => {});
			}

			// Agent slot freed — drain any queued discussion replies
			drainPendingReplies(monitorSession).catch(() => {});
		});

		log(monitorSession, `[spawn] Agent → "${task.title}" → chat: ${discussionSessionId}`);
		return true;
	} catch (err) {
		const msg = err instanceof Error ? err.message : 'spawn failed';
		log(monitorSession, `[error] Failed to spawn agent for "${task.title}": ${msg}`);
		return false;
	}
}
