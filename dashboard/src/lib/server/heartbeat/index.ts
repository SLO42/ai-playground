/**
 * Heartbeat cycle — the main orchestration loop for Claw.
 * Coordinates service health, task scanning, agent spawning, and review cycles.
 */
import { readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';
import { SERVICES, PATHS } from '../constants.js';
import { isOllamaOnline } from '../ollama-client.js';
import { pushNotification, loadSettings } from '../notifications.js';
import { getAllTasks, migrateIfNeeded, updateTask } from '../task-store.js';
import { scanAllProjects } from '../project-scanner.js';
import { loadAgentDefaults } from '../agent-defaults.js';
import {
	DEFAULT_INTERVAL_MS, MONITOR_SESSION_ID,
	getActiveAgents, getDiscussionMap, ensureChatsDir,
	loadMaxAgents, maxConcurrentAgents,
	loadMonitorSession, saveMonitorSession, readSessionIndex,
	log, trimSession, agentSender, ensureTaskSession, taskSessionId,
	upsertSessionMeta
} from './shared.js';
import { spawnClaude, buildTaskPrompt, pickModelForTask } from './agent-spawn.js';
import { logAgentCompletion, tailAgentLogs, cleanupPromptFiles, captureGitBaseline, parseStreamJsonLog } from './agent-tracking.js';
import { spawnReviewAgent } from './review-agent.js';
import { createDiscussionSession, checkDiscussionReplies } from './discussion.js';
import { classifyTask, shouldEscalate, spawnOpenClawAgent } from './openclaw-agent.js';
import { recordEvent } from './agent-analytics.js';
import { resolveSession, registerSession, releaseSession, autoScale, watchForSessionId, loadPersistedAutoScaleConfig } from './session-pool.js';
import { commitAgentChanges, planFollowUps, spawnFollowUp } from './post-task.js';
import { processSuggestions, suggestTasks } from '../task-suggestions.js';
import type { ChatSession } from '$lib/types/chat.js';
import type { Task } from '$lib/types/tasks.js';

// Re-export public API
export { startHeartbeat, stopHeartbeat, isHeartbeatRunning };

const g = globalThis as Record<string, unknown>;

function getTimer(): ReturnType<typeof setTimeout> | null {
	return (g.__claw_heartbeat_timer as ReturnType<typeof setTimeout>) ?? null;
}
function setTimer(t: ReturnType<typeof setTimeout> | null) {
	g.__claw_heartbeat_timer = t;
}

let lastStatuses: Record<string, boolean> = (g.__claw_last_statuses as Record<string, boolean>) ?? {};
let heartbeatCount = (g.__claw_heartbeat_count as number) ?? 0;
let lastReviewAt = (g.__claw_last_review as number) ?? 0;
const REVIEW_COOLDOWN_MS = 30 * 60 * 1000;

// ── Health checks ────────────────────────────────────────────────────

async function checkHealth(url: string, timeoutMs = 2000): Promise<boolean> {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
		return res.ok || res.status < 500;
	} catch {
		return false;
	}
}

async function isDaemonRunning(): Promise<boolean> {
	try {
		const raw = await readFile(PATHS.daemonState, 'utf-8');
		const state = JSON.parse(raw);
		if (!state.running) return false;
		const pidRaw = await readFile(PATHS.daemonState.replace('daemon-state.json', 'daemon.pid'), 'utf-8');
		const pid = parseInt(pidRaw.trim(), 10);
		if (isNaN(pid)) return false;
		// Use tasklist on Windows (process.kill(pid, 0) is unreliable on MINGW)
		const { execSync } = await import('child_process');
		const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { timeout: 5000, windowsHide: true, encoding: 'utf-8' });
		return out.includes(String(pid));
	} catch {
		return false;
	}
}

// ── Task scanning ────────────────────────────────────────────────────

interface TaskScanResult {
	total: number;
	pending: number;
	inProgress: number;
	completed: number;
	clawAssigned: Task[];
	unassignedPending: Task[];
	flaggedForDiscussion: Task[];
}

async function scanTasks(): Promise<TaskScanResult> {
	const result: TaskScanResult = {
		total: 0, pending: 0, inProgress: 0, completed: 0,
		clawAssigned: [], unassignedPending: [], flaggedForDiscussion: []
	};

	try {
		await migrateIfNeeded(PATHS.root);
		const rootTasks = await getAllTasks(PATHS.root);

		let allTasks = [...rootTasks];
		const scannedPaths = new Set<string>([resolve(PATHS.root)]);
		try {
			const projects = await scanAllProjects(PATHS.playgroundRegistry, PATHS.root);
			for (const project of projects) {
				const resolved = resolve(project.path);
				if (scannedPaths.has(resolved)) continue; // skip duplicate (e.g. "." entry)
				scannedPaths.add(resolved);
				try {
					await migrateIfNeeded(project.path);
					const projectTasks = await getAllTasks(project.path);
					allTasks.push(...projectTasks);
				} catch { /* skip inaccessible projects */ }
			}
		} catch { /* registry might not exist */ }

		result.total = allTasks.length;
		for (const task of allTasks) {
			if (task.status === 'pending') result.pending++;
			else if (task.status === 'in_progress') result.inProgress++;
			else if (task.status === 'completed') result.completed++;

			if (task.flagDiscussion && task.status === 'pending') {
				result.flaggedForDiscussion.push(task);
			} else if (task.status === 'pending' && (task.assignee === 'claw' || task.assignee === 'claude-code-agent')) {
				result.clawAssigned.push(task);
			} else if (task.status === 'pending' && !task.assignee) {
				result.unassignedPending.push(task);
			}
		}
	} catch { /* task scan failed gracefully */ }

	const priOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
	result.unassignedPending.sort((a, b) => (priOrder[a.priority] ?? 9) - (priOrder[b.priority] ?? 9));

	return result;
}

// ── Agent spawning ───────────────────────────────────────────────────

async function spawnAgent(task: Task, monitorSession: ChatSession): Promise<boolean> {
	const agents = getActiveAgents();

	if (agents.size >= maxConcurrentAgents) {
		log(monitorSession, `[skip] Max agents (${maxConcurrentAgents}) already running — deferring "${task.title}"`);
		return false;
	}

	if (agents.has(task.id)) {
		log(monitorSession, `[skip] Agent already working on "${task.title}"`);
		return false;
	}

	// ── Route: OpenClaw (local, $0) vs Claude Code (API, $$) ──
	const route = classifyTask(task);

	// Analytics: classification event — Claw (gpt-oss:20b) makes this decision
	recordEvent({ taskId: task.id, taskTitle: task.title, type: 'classified', route, model: 'gpt-oss:20b', modelTier: 'local', provider: 'openclaw' }).catch(() => {});

	if (route === 'openclaw') {
		const { escalate, reason } = await shouldEscalate(task);

		// Analytics: escalation check — Claw (gpt-oss:20b) evaluates whether to escalate
		recordEvent({ taskId: task.id, taskTitle: task.title, type: 'escalation_check', route, escalated: escalate, escalationReason: reason, model: 'gpt-oss:20b', modelTier: 'local', provider: 'openclaw' }).catch(() => {});

		if (!escalate) {
			log(monitorSession, `[route] "${task.title}" → OpenClaw (local, $0) — ${reason}`);
			const prompt = buildTaskPrompt(task);

			// Analytics: spawn event for OpenClaw
			recordEvent({ taskId: task.id, taskTitle: task.title, type: 'spawned', provider: 'openclaw', model: 'gpt-oss:20b', modelTier: 'local' }).catch(() => {});

			return spawnOpenClawAgent(task, prompt, monitorSession);
		}
		log(monitorSession, `[route] "${task.title}" → escalated to Claude Code — ${reason}`);

		// Analytics: handoff event — Claw decides to hand off
		recordEvent({ taskId: task.id, taskTitle: task.title, type: 'handoff', fromProvider: 'openclaw', toProvider: 'claude-code', handoffReason: reason, model: 'gpt-oss:20b', modelTier: 'local', provider: 'openclaw' }).catch(() => {});
	} else {
		log(monitorSession, `[route] "${task.title}" → Claude Code (needs file ops)`);
	}

	// ── Claude Code path (file edits, builds, git) ──
	const prompt = buildTaskPrompt(task);
	const logFile = `${PATHS.headlessLogsDir}/agent-${task.id}.log`;
	const sender = agentSender(task.id, task.title.slice(0, 30));

	const reportId = await ensureTaskSession(task, sender);

	try {
		const baseline = captureGitBaseline();
		const model = pickModelForTask(task);
		const modelTier = model.includes('sonnet') ? 'sonnet' as const : 'opus' as const;
		const maxTurns = modelTier === 'sonnet' ? 15 : 25;

		// Session pool: find or create a warm session for this code area
		const session = await resolveSession(task, model);
		const resumeLabel = session.isResume ? `warm (${session.area})` : `cold (${session.area})`;

		// Analytics: model selection
		recordEvent({ taskId: task.id, taskTitle: task.title, type: 'model_selected', model, modelTier, provider: 'claude-code' }).catch(() => {});

		const child = spawnClaude(prompt, logFile, {
			model,
			resumeSessionId: session.sessionId,
			slotId: session.slotId
		});

		const pid = child.pid ?? 0;
		agents.set(task.id, {
			taskId: task.id,
			pid,
			startedAt: new Date().toISOString(),
			sender,
			logFile,
			lastLogPos: 0,
			reportSessionId: reportId,
			gitBaseline: baseline
		});

		// Analytics: spawned
		recordEvent({ taskId: task.id, taskTitle: task.title, type: 'spawned', provider: 'claude-code', model, modelTier, pid, maxTurns, sessionId: reportId }).catch(() => {});

		// Extract Claude Code session ID from stream-json init message for pool registration
		if (!session.isResume) {
			// Cold start — watch log for init message to capture the session UUID
			watchForSessionId(logFile, session.slotId).catch(() => {});
		}

		child.on('close', (code) => {
			const agentInfo = agents.get(task.id);
			const agentSnd = agentInfo?.sender ?? sender;
			const rId = agentInfo?.reportSessionId ?? reportId;
			const agentBaseline = agentInfo?.gitBaseline;
			agents.delete(task.id);

			const exitMsg = code === 0 ? 'completed successfully' : `exited with code ${code}`;

			// Parse log for final stats before recording analytics
			const parsed = parseStreamJsonLog(logFile);
			const startTime = agentInfo ? new Date(agentInfo.startedAt).getTime() : Date.now();
			const durationMs = parsed.usage?.durationMs ?? (Date.now() - startTime);

			// Release session pool slot
			releaseSession(
				session.slotId,
				parsed.usage?.totalTokens ?? 0,
				parsed.usage?.costUsd ?? 0
			).catch(() => {});

			// Analytics: completion/failure event
			recordEvent({
				taskId: task.id, taskTitle: task.title,
				type: code === 0 ? 'completed' : 'failed',
				model, modelTier, provider: 'claude-code',
				exitCode: code ?? undefined,
				durationMs,
				inputTokens: parsed.usage?.inputTokens ?? 0,
				outputTokens: parsed.usage?.outputTokens ?? 0,
				costUsd: parsed.usage?.costUsd ?? 0,
				sessionId: rId
			}).catch(() => {});

			logAgentCompletion(task, agentSnd, exitMsg, logFile, rId, agentBaseline).catch(() => {});
			if (rId !== MONITOR_SESSION_ID) {
				logAgentCompletion(task, agentSnd, exitMsg, logFile, MONITOR_SESSION_ID, agentBaseline, { skipUsageRecord: true }).catch(() => {});
			}

			// ── Post-task: git commit + follow-up agents ──
			if (code === 0 && agentBaseline) {
				(async () => {
					const commitResult = commitAgentChanges(task, agentBaseline, model);
					const ms = await loadMonitorSession();

					// Analytics: commit event
					recordEvent({
						taskId: task.id, taskTitle: task.title,
						type: 'committed',
						model, modelTier, provider: 'claude-code',
						commitHash: commitResult.hash,
						commitFiles: commitResult.filesCommitted,
						commitError: commitResult.error
					}).catch(() => {});

					if (commitResult.committed) {
						log(ms, `[commit] "${task.title}" → ${commitResult.message}`);

						pushNotification({
							severity: 'success',
							category: 'agent',
							title: `Agent committed: ${task.title}`,
							message: `${commitResult.hash} — ${commitResult.filesCommitted} file(s)`,
							source: 'claw',
							link: `/chat?session=${rId}`,
							linkLabel: 'View Task'
						}).catch(() => {});
					} else if (commitResult.error) {
						log(ms, `[commit] "${task.title}" — failed: ${commitResult.error}`);
					}

					// Plan and spawn follow-up agents
					const followUps = planFollowUps(task, commitResult, parsed);
					for (const fu of followUps) {
						if (fu.shouldSpawn) {
							log(ms, `[follow-up] Planning ${fu.type} for "${task.title}" — ${fu.reason}`);

							// Analytics: follow-up spawn event
							recordEvent({
								taskId: task.id, taskTitle: task.title,
								type: 'follow_up_spawned',
								model: 'claude-sonnet-4-6', modelTier: 'sonnet', provider: 'claude-code',
								followUpType: fu.type,
								followUpReason: fu.reason,
								parentTaskId: task.id
							}).catch(() => {});

							await spawnFollowUp(task, fu.type, commitResult, ms);
						}
					}

					await saveMonitorSession(ms);
				})().catch(() => {});
			}

			pushNotification({
				severity: code === 0 ? 'success' : 'warning',
				category: 'agent',
				title: `Agent finished: ${task.title}`,
				message: `Task ${task.id} — ${exitMsg}`,
				source: 'claw',
				link: `/chat?session=${rId}`,
				linkLabel: 'View Task',
				desktop: true
			}).catch(() => {});

			if (code === 0) {
				updateTask(PATHS.root, task.id, { status: 'completed' }).catch(() => {});
			} else {
				updateTask(PATHS.root, task.id, { status: 'pending', assignee: null }).catch(() => {});
			}
		});

		log(monitorSession, `[spawn] Claude Code (${modelTier}, ${resumeLabel}) → "${task.title}" → chat: ${reportId}`);
		return true;
	} catch (err) {
		const msg = err instanceof Error ? err.message : 'spawn failed';
		log(monitorSession, `[error] Failed to spawn agent for "${task.title}": ${msg}`);
		return false;
	}
}

// ── Check running agents ─────────────────────────────────────────────

function checkAgents(session: ChatSession) {
	const agents = getActiveAgents();
	if (agents.size === 0) return;

	const summaries = [...agents.entries()].map(([taskId, info]) => {
		const elapsed = Math.round((Date.now() - new Date(info.startedAt).getTime()) / 1000);
		const mins = Math.floor(elapsed / 60);
		const secs = elapsed % 60;
		return `${taskId} (${mins}m ${secs}s)`;
	});
	log(session, `[agents] ${agents.size} active: ${summaries.join(', ')}`);
}

// ── Main heartbeat cycle ─────────────────────────────────────────────

async function heartbeat() {
	const settings = await loadSettings();
	const notificationsEnabled = settings.heartbeatEnabled !== false;

	heartbeatCount++;
	g.__claw_heartbeat_count = heartbeatCount;
	const session = await loadMonitorSession();
	session.status = 'streaming';

	const ts = new Date().toLocaleTimeString();
	log(session, `\n--- Heartbeat #${heartbeatCount} — ${ts} ---`);
	log(session, `[wake] Claw waking up`);

	await loadMaxAgents();

	// ── Phase 1: Plan
	const plan = [
		'Check service health',
		'Scan tasks across projects',
		'Check running agents',
		'Spawn agents for actionable tasks'
	];
	log(session, `[plan] ${plan.join(' → ')}`);

	// ── Phase 2: Service health
	log(session, `[health] Probing services...`);
	const [ollama, gateway, daemon] = await Promise.all([
		isOllamaOnline(),
		checkHealth(SERVICES.openclaw.healthUrl!),
		isDaemonRunning()
	]);

	const statuses: Record<string, boolean> = { ollama, gateway, daemon };
	const services = Object.entries(statuses);
	const onlineCount = services.filter(([, v]) => v).length;
	const totalCount = services.length;
	const statusList = services.map(([n, v]) => `${n}: ${v ? 'up' : 'down'}`).join(', ');

	log(session, `[health] ${onlineCount}/${totalCount} up — ${statusList}`);

	const changes: string[] = [];
	for (const [name, online] of services) {
		if (lastStatuses[name] !== undefined && lastStatuses[name] !== online) {
			changes.push(`${name} ${online ? 'came online' : 'went offline'}`);
		}
	}
	lastStatuses = statuses;
	g.__claw_last_statuses = statuses;

	if (changes.length > 0) {
		log(session, `[alert] Status changed: ${changes.join('; ')}`);
	}

	// ── Phase 3: Task scan
	log(session, `[tasks] Scanning tasks...`);
	const taskScan = await scanTasks();
	log(session, `[tasks] ${taskScan.total} total — ${taskScan.pending} pending, ${taskScan.inProgress} in progress, ${taskScan.completed} completed`);

	if (taskScan.clawAssigned.length > 0) {
		log(session, `[tasks] ${taskScan.clawAssigned.length} task(s) assigned to Claw: ${taskScan.clawAssigned.map((t) => t.title).join(', ')}`);
	}
	if (taskScan.unassignedPending.length > 0) {
		log(session, `[tasks] ${taskScan.unassignedPending.length} pending task(s) available`);
	}

	if (notificationsEnabled && (taskScan.clawAssigned.length > 0 || taskScan.unassignedPending.length > 0)) {
		const parts: string[] = [`${taskScan.total} total`];
		if (taskScan.clawAssigned.length > 0) parts.push(`${taskScan.clawAssigned.length} assigned to Claw`);
		if (taskScan.unassignedPending.length > 0) parts.push(`${taskScan.unassignedPending.length} unassigned pending`);

		await pushNotification({
			severity: 'info',
			category: 'task',
			title: 'Claw task scan',
			message: parts.join(' | '),
			source: 'claw',
			link: '/tasks',
			linkLabel: 'View Tasks'
		});
	}

	// Reset stale in_progress tasks
	if (taskScan.inProgress > 0) {
		const activeAgents = getActiveAgents();
		let staleReset = 0;
		const staleNames: string[] = [];
		try {
			const allTasks = await getAllTasks(PATHS.root);
			for (const task of allTasks) {
				if (task.status === 'in_progress' && task.assignee === 'claw' && !activeAgents.has(task.id)) {
					await updateTask(PATHS.root, task.id, { status: 'pending', assignee: null }).catch(() => {});
					staleNames.push(task.title);
					staleReset++;
				}
			}
		} catch { /* reset failed */ }
		if (staleReset > 0) {
			log(session, `[tasks] Reset ${staleReset} stale in_progress task(s) back to pending`);

			if (notificationsEnabled) {
				await pushNotification({
					severity: 'warning',
					category: 'task',
					title: `Claw reset ${staleReset} stale task(s)`,
					message: staleNames.join(', '),
					source: 'claw',
					link: '/tasks',
					linkLabel: 'View Tasks'
				});
			}
		}
	}

	// ── Phase 3a: Auto-scale session pool based on task queue depth
	try {
		const pendingCount = taskScan.pending + taskScan.inProgress;
		const scaleConfig = await loadPersistedAutoScaleConfig();
		const scaleResult = await autoScale(pendingCount, scaleConfig);
		if (scaleResult.action !== 'no-op') {
			const changed = scaleResult.slotsAdded || scaleResult.slotsRemoved;
			log(session, `[pool] Auto-scale ${scaleResult.action}: ${changed} slot(s) — active: ${scaleResult.activeSlots}, idle: ${scaleResult.idleSlots} (pending tasks: ${pendingCount})`);
		}
	} catch {
		/* auto-scale failed gracefully */
	}

	// ── Phase 3b: Process suggestion inbox (from agents, daemon, etc.)
	try {
		const suggestions = await processSuggestions();
		if (suggestions.created > 0) {
			log(session, `[suggestions] Created ${suggestions.created} task(s) from inbox (sources: ${suggestions.sources.join(', ')})`);
		}
		if (suggestions.skipped > 0) {
			log(session, `[suggestions] Skipped ${suggestions.skipped} duplicate/invalid suggestion(s)`);
		}
	} catch {
		/* suggestion processing failed gracefully */
	}

	// ── Phase 3c: Heartbeat self-suggestions (detect issues worth tracking)
	try {
		const selfSuggestions: Parameters<typeof suggestTasks>[0] = [];

		// Service flaps — if a service just went offline, suggest investigating
		for (const change of changes) {
			if (change.includes('went offline')) {
				const serviceName = change.split(' ')[0];
				selfSuggestions.push({
					title: `Investigate ${serviceName} service going offline`,
					description: `The heartbeat detected ${serviceName} went offline during cycle #${heartbeatCount}. Check logs and ensure auto-restart is configured.`,
					priority: 'high',
					tags: ['reliability', 'services'],
					feature: 'service-reliability',
					source: 'heartbeat'
				});
			}
		}

		// Stale tasks — if tasks have been pending too long without being picked up
		if (taskScan.unassignedPending.length > 10) {
			selfSuggestions.push({
				title: 'Triage unassigned task backlog — too many pending tasks',
				description: `${taskScan.unassignedPending.length} unassigned pending tasks detected. Consider prioritizing, assigning, or closing stale tasks.`,
				priority: 'medium',
				tags: ['backlog', 'triage'],
				feature: 'task-management',
				source: 'heartbeat'
			});
		}

		if (selfSuggestions.length > 0) {
			await suggestTasks(selfSuggestions);
			log(session, `[suggestions] Heartbeat suggested ${selfSuggestions.length} improvement(s)`);
		}
	} catch { /* self-suggestion failed gracefully */ }

	if (taskScan.flaggedForDiscussion.length > 0) {
		const discussions = getDiscussionMap();
		const newDiscussions: string[] = [];
		const pendingDiscussions: string[] = [];

		for (const task of taskScan.flaggedForDiscussion) {
			if (discussions.has(task.id)) {
				pendingDiscussions.push(task.title);
				continue;
			}

			try {
				const sessionId = await createDiscussionSession(task);
				discussions.set(task.id, sessionId);
				newDiscussions.push(task.title);

				if (notificationsEnabled) {
					await pushNotification({
						severity: 'info',
						category: 'agent',
						title: `Claw wants to discuss: ${task.title}`,
						message: `Flagged for discussion — please review and respond`,
						source: 'claw',
						link: `/chat?session=discuss-${task.id}`,
						linkLabel: 'Join Discussion',
						desktop: true
					});
				}
			} catch { /* session creation failed */ }
		}

		if (newDiscussions.length > 0) {
			log(session, `[discuss] Started ${newDiscussions.length} discussion(s): ${newDiscussions.join(', ')}`);
		}
		if (pendingDiscussions.length > 0) {
			log(session, `[discuss] ${pendingDiscussions.length} awaiting user response: ${pendingDiscussions.join(', ')}`);
		}
	}

	await checkDiscussionReplies(session);

	// ── Phase 4: Check running agents
	checkAgents(session);
	await tailAgentLogs(session);

	// ── Phase 5: Spawn agents
	const actionable = [...taskScan.clawAssigned, ...taskScan.unassignedPending];
	let spawned = 0;

	if (actionable.length > 0) {
		const agents = getActiveAgents();
		const slotsAvailable = maxConcurrentAgents - agents.size;

		if (slotsAvailable > 0) {
			log(session, `[spawn] ${slotsAvailable} agent slot(s) available — evaluating ${actionable.length} actionable task(s)`);

			for (const task of actionable) {
				if (spawned >= slotsAvailable) break;
				if (agents.has(task.id)) continue;

				if (await spawnAgent(task, session)) {
					await updateTask(PATHS.root, task.id, {
						status: 'in_progress',
						assignee: 'claw'
					}).catch(() => {});
					spawned++;

					if (notificationsEnabled) {
						await pushNotification({
							severity: 'info',
							category: 'agent',
							title: `Claw spawned agent: ${task.title}`,
							message: `Working on ${task.id} [${task.priority}] — ${pickModelForTask(task)}`,
							source: 'claw',
							link: `/chat?session=${taskSessionId(task.id)}`,
							linkLabel: 'View Task'
						});
					}
				}
			}
		} else {
			log(session, `[spawn] No agent slots — ${agents.size}/${maxConcurrentAgents} running`);
		}
	} else {
		log(session, `[spawn] No actionable tasks — nothing to spawn`);
	}

	// ── Phase 6: Project review cycle
	const agents = getActiveAgents();
	const timeSinceReview = Date.now() - lastReviewAt;
	const shouldReview = taskScan.pending === 0
		&& taskScan.clawAssigned.length === 0
		&& taskScan.unassignedPending.length === 0
		&& taskScan.flaggedForDiscussion.length === 0
		&& agents.size === 0
		&& timeSinceReview > REVIEW_COOLDOWN_MS;

	if (shouldReview) {
		log(session, `[review] No pending tasks — launching project review`);
		lastReviewAt = Date.now();
		g.__claw_last_review = lastReviewAt;
		await spawnReviewAgent(session);
	}

	// ── Phase 7: Notifications
	if (notificationsEnabled) {
		const allUp = onlineCount === totalCount;
		const hasErrors = !allUp || changes.some((c) => c.includes('went offline'));

		const parts: string[] = [];
		parts.push(`checked services (${onlineCount}/${totalCount} up)`);
		parts.push(`scanned tasks (${taskScan.pending} pending, ${taskScan.inProgress} active)`);
		if (spawned > 0) parts.push(`spawned ${spawned} agent(s)`);
		if (changes.length > 0) parts.push(changes.join(', '));
		if (taskScan.flaggedForDiscussion.length > 0) parts.push(`${taskScan.flaggedForDiscussion.length} flagged for discussion`);

		await pushNotification({
			severity: hasErrors ? 'warning' : 'success',
			category: 'system',
			title: `Heartbeat #${heartbeatCount}`,
			message: parts.join(', '),
			source: 'claw',
			link: `/chat?session=${MONITOR_SESSION_ID}`,
			linkLabel: 'View Monitor'
		});

		if (changes.length > 0) {
			const anyDown = changes.some((c) => c.includes('went offline'));
			await pushNotification({
				severity: anyDown ? 'critical' : 'success',
				category: 'service',
				title: 'Service status changed',
				message: changes.join('; '),
				source: 'claw',
				link: '/services',
				linkLabel: 'View Services',
				desktop: true
			});
		}
		log(session, `[notify] Heartbeat notification pushed`);
	} else {
		log(session, `[skip] Notifications disabled`);
	}

	// ── Phase 8: Cleanup & Idle
	await cleanupPromptFiles();
	const agentCount = getActiveAgents().size;
	log(session, `[idle] Heartbeat #${heartbeatCount} done — ${agentCount} agent(s) running — going idle`);
	session.status = 'idle';
	trimSession(session);
	await saveMonitorSession(session);

	scheduleNext();
}

// ── Scheduling ───────────────────────────────────────────────────────

function scheduleNext() {
	loadSettings().then((settings) => {
		const interval = settings.heartbeatIntervalMs ?? DEFAULT_INTERVAL_MS;
		setTimer(setTimeout(() => {
			heartbeat().catch(() => { scheduleNext(); });
		}, interval));
	}).catch(() => {
		setTimer(setTimeout(() => {
			heartbeat().catch(() => { scheduleNext(); });
		}, DEFAULT_INTERVAL_MS));
	});
}

async function cleanupStuckSessions(): Promise<void> {
	try {
		const index = await readSessionIndex();
		const agents = getActiveAgents();
		let changed = false;
		for (const meta of index) {
			if (meta.status === 'streaming' && !agents.has(meta.id.replace(/^task-/, ''))) {
				meta.status = 'idle';
				changed = true;
			}
		}
		if (changed) {
			await writeFile(`${PATHS.chatsDir}/index.json`, JSON.stringify(index, null, '\t'), 'utf-8');
		}
	} catch { /* index missing */ }
}

function startHeartbeat() {
	if (getTimer()) return;
	ensureChatsDir().then(() => {
		cleanupStuckSessions().catch(() => {});
		setTimer(setTimeout(() => {
			heartbeat().catch(() => { scheduleNext(); });
		}, 5_000));
	}).catch(() => {
		setTimer(setTimeout(() => {
			heartbeat().catch(() => { scheduleNext(); });
		}, 5_000));
	});
}

function stopHeartbeat() {
	const t = getTimer();
	if (t) {
		clearTimeout(t);
		setTimer(null);
	}
}

function isHeartbeatRunning(): boolean {
	return getTimer() !== null;
}
