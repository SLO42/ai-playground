/**
 * Heartbeat cycle — the main orchestration loop for Claw.
 * Coordinates service health, task scanning, agent spawning, and review cycles.
 */
import { readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';
import { SERVICES, PATHS } from '../constants.js';
import { isOllamaOnline } from '../ollama-client.js';
import { pushNotification, loadSettings } from '../notifications.js';
import { getAllTasks, migrateIfNeeded, updateTask, getBlockedStatus } from '../task-store.js';
import { scanAllProjects, detectProjectMeta } from '../project-scanner.js';
import { loadAgentDefaults } from '../agent-defaults.js';
import {
	DEFAULT_INTERVAL_MS, MONITOR_SESSION_ID,
	getActiveAgents, getDiscussionMap, ensureChatsDir,
	loadMaxAgents, getMaxConcurrentAgents,
	loadMonitorSession, saveMonitorSession, readSessionIndex,
	log, trimSession, agentSender, ensureTaskSession, taskSessionId,
	upsertSessionMeta,
	loadProjectMaxAgents, countProjectAgents, getProjectAgentMap, getProjectLimits,
	reapOrphanedAgents,
	loadHeartbeatConfig, getHeartbeatConfig, updateHeartbeatConfig, saveHeartbeatConfig,
	getDefaultConfig,
} from './shared.js';
import type { HeartbeatConfig } from './shared.js';
import { spawnClaude, buildTaskPrompt, pickModelForTask } from './agent-spawn.js';
import { logAgentCompletion, tailAgentLogs, cleanupPromptFiles, captureGitBaseline, parseStreamJsonLog } from './agent-tracking.js';
import { spawnReviewAgent } from './review-agent.js';
import { createDiscussionSession, checkDiscussionReplies } from './discussion.js';
import { classifyTask, shouldEscalate, spawnOpenClawAgent, gatherContext } from './openclaw-agent.js';
import type { TaskRoute } from './openclaw-agent.js';
import { recordEvent } from './agent-analytics.js';
import { recordSpawn, recordSpawnCompletion, requestSlot, releaseSlot } from './session-pool.js';
import { buildContextForTask } from './context-loader.js';
import { commitAgentChanges, planFollowUps, spawnFollowUp } from './post-task.js';
import { runPostCommitTests } from './post-test.js';
import { reapStaleProcesses, registerPid, unregisterPid } from './pid-registry.js';
import { processSuggestions, suggestTasks } from '../task-suggestions.js';
import { syncMemoryBridge } from '../memory-bridge.js';
import { runUxInspection } from './ux-inspector.js';
import { loadRestartConfigAsync, shouldRestart, attemptRestart, resetRestartCount, getRestartState } from './auto-restart.js';
import { runMemoryGuardian, loadGuardianConfig } from './memory-guardian.js';
import type { ChatSession } from '$lib/types/chat.js';
import type { Task } from '$lib/types/tasks.js';

// Re-export public API
export { startHeartbeat, stopHeartbeat, isHeartbeatRunning };
export { loadHeartbeatConfig, getHeartbeatConfig, updateHeartbeatConfig, saveHeartbeatConfig, getDefaultConfig };
export type { HeartbeatConfig };

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
		const { execFile } = await import('child_process');
		const { promisify } = await import('util');
		const execFileAsync = promisify(execFile);
		const { stdout: out } = await execFileAsync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { timeout: 5000, windowsHide: true, encoding: 'utf-8' });
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
	blocked: Task[];
}

const EMPTY_TASK_SCAN: TaskScanResult = {
	total: 0, pending: 0, inProgress: 0, completed: 0,
	clawAssigned: [], unassignedPending: [], flaggedForDiscussion: [], blocked: []
};

async function scanTasks(): Promise<TaskScanResult> {
	const result: TaskScanResult = {
		total: 0, pending: 0, inProgress: 0, completed: 0,
		clawAssigned: [], unassignedPending: [], flaggedForDiscussion: [], blocked: []
	};

	try {
		await migrateIfNeeded(PATHS.root);
		const rootTasks = await getAllTasks(PATHS.root);

		// Annotate root tasks with project info
		const allProjects = await scanAllProjects(PATHS.playgroundRegistry, PATHS.root).catch(() => [] as Awaited<ReturnType<typeof scanAllProjects>>);
		const rootProject = allProjects.find(p => resolve(p.path) === resolve(PATHS.root));
		for (const t of rootTasks) {
			t._sourceProjectId = rootProject?.id ?? 'root';
			t._sourceProjectPath = PATHS.root;
		}

		let allTasks = [...rootTasks];
		const scannedPaths = new Set<string>([resolve(PATHS.root)]);
		try {
			for (const project of allProjects) {
				const resolved = resolve(project.path);
				if (scannedPaths.has(resolved)) continue; // skip duplicate (e.g. "." entry)
				scannedPaths.add(resolved);
				try {
					await migrateIfNeeded(project.path);
					const projectTasks = await getAllTasks(project.path);
					for (const t of projectTasks) {
						t._sourceProjectId = project.id;
						t._sourceProjectPath = project.path;
					}
					allTasks.push(...projectTasks);
				} catch { /* skip inaccessible projects */ }
			}
		} catch { /* registry might not exist */ }

		result.total = allTasks.length;
		for (const task of allTasks) {
			if (task.status === 'pending') result.pending++;
			else if (task.status === 'in_progress') result.inProgress++;
			else if (task.status === 'completed') result.completed++;

			// Skip blocked tasks — they can't be worked yet
			if (task.status === 'pending' && task.blockedBy?.length) {
				const { blocked, blockers } = getBlockedStatus(task.id, allTasks);
				if (blocked) {
					result.blocked.push(task);
					continue;
				}
			}

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
	task = structuredClone(task);
	const agents = getActiveAgents();

	if (agents.has(task.id)) {
		log(monitorSession, `[skip] Agent already working on "${task.title}"`);
		return false;
	}

	// On-demand slot allocation — checks both global and per-project limits
	const projectId = task._sourceProjectId ?? 'unknown';
	const slot = requestSlot(task.id, projectId);
	if (!slot) {
		const projActive = countProjectAgents(projectId);
		const projMax = getProjectLimits().get(projectId) ?? 2;
		if (agents.size >= getMaxConcurrentAgents()) {
			log(monitorSession, `[skip] Max agents (${getMaxConcurrentAgents()}) already running — deferring "${task.title}"`);
		} else {
			log(monitorSession, `[skip] Project "${projectId}" at agent limit (${projActive}/${projMax}) — deferring "${task.title}"`);
		}
		return false;
	}

	// Load project-specific context for the agent (non-blocking, falls back to generic)
	let projectContext: Awaited<ReturnType<typeof buildContextForTask>> | undefined;
	if (task._sourceProjectPath) {
		try {
			const meta = await detectProjectMeta(task._sourceProjectPath);
			projectContext = await buildContextForTask(task, task._sourceProjectPath, meta);
			if (projectContext.systemPrompt) {
				log(monitorSession, `[context] Loaded ${meta.language ?? 'unknown'}/${meta.framework ?? 'generic'} context for "${task.title}"`);
			}
		} catch {
			// Context loading failed — proceed with generic prompt
		}
	}

	// ── Route: OpenClaw (local, $0) vs Claude Code (API, $$) ──
	const route: TaskRoute = classifyTask(task);

	// Analytics: classification event — Claw (gpt-oss:20b) makes this decision
	recordEvent({ taskId: task.id, taskTitle: task.title, type: 'classified', route, model: 'gpt-oss:20b', modelTier: 'local', provider: 'openclaw', projectId: task._sourceProjectId }).catch(() => {});

	if (route === 'openclaw') {
		const { escalate, reason } = await shouldEscalate(task);

		// Analytics: escalation check — Claw (gpt-oss:20b) evaluates whether to escalate
		recordEvent({ taskId: task.id, taskTitle: task.title, type: 'escalation_check', route, escalated: escalate, escalationReason: reason, model: 'gpt-oss:20b', modelTier: 'local', provider: 'openclaw', projectId: task._sourceProjectId }).catch(() => {});

		if (!escalate) {
			log(monitorSession, `[route] "${task.title}" → OpenClaw (gateway + tools, $0) — ${reason}`);
			const prompt = buildTaskPrompt(task, projectContext);

			// Analytics: spawn event for OpenClaw
			recordEvent({ taskId: task.id, taskTitle: task.title, type: 'spawned', provider: 'openclaw', model: 'gpt-oss:20b', modelTier: 'local', projectId: task._sourceProjectId }).catch(() => {});

			const ok = await spawnOpenClawAgent(task, prompt, monitorSession);
			if (!ok) releaseSlot(task.id);
			return ok;
		}
		log(monitorSession, `[route] "${task.title}" → escalated to Claude Code — ${reason}`);

		// Analytics: handoff event — Claw decides to hand off
		recordEvent({ taskId: task.id, taskTitle: task.title, type: 'handoff', fromProvider: 'openclaw', toProvider: 'claude-code', handoffReason: reason, model: 'gpt-oss:20b', modelTier: 'local', provider: 'openclaw', projectId: task._sourceProjectId }).catch(() => {});
	} else if (route === 'openclaw-context') {
		// Context-first route: OpenClaw gathers context, then Claude Code executes
		log(monitorSession, `[route] "${task.title}" → OpenClaw context-first → Claude Code`);

		// Analytics: context gathering phase
		recordEvent({ taskId: task.id, taskTitle: task.title, type: 'context_gathering', provider: 'openclaw', model: 'gpt-oss:20b', modelTier: 'local', projectId: task._sourceProjectId }).catch(() => {});

		// Gather context via OpenClaw (async, non-blocking with timeout)
		const contextPromise = gatherContext(task);
		const context = await Promise.race([
			contextPromise,
			new Promise<null>(resolve => setTimeout(() => resolve(null), 30000))
		]);

		if (context) {
			log(monitorSession, `[context] OpenClaw gathered ${context.length} chars of context for "${task.title}"`);
			// Clone task to avoid mutating the original (which lives in the scan results)
			const taskCopy = { ...task };
			taskCopy.description = `${task.description ?? ''}\n\n---\n## Pre-gathered Context (via OpenClaw)\n${context}`;
			task = taskCopy;

			recordEvent({ taskId: task.id, taskTitle: task.title, type: 'context_gathered', provider: 'openclaw', model: 'gpt-oss:20b', modelTier: 'local', contextLength: context.length, projectId: task._sourceProjectId }).catch(() => {});
		} else {
			log(monitorSession, `[context] OpenClaw context gathering timed out — proceeding without`);
		}
		// Fall through to Claude Code path below
	} else {
		log(monitorSession, `[route] "${task.title}" → Claude Code (needs file ops)`);
	}

	// ── Claude Code path (file edits, builds, git) ──
	const prompt = buildTaskPrompt(task, projectContext);
	const logFile = `${PATHS.headlessLogsDir}/agent-${task.id}.log`;
	const sender = agentSender(task.id, task.title.slice(0, 30));

	const reportId = await ensureTaskSession(task, sender);

	try {
		const baseline = await captureGitBaseline();
		const model = pickModelForTask(task);
		const modelTier = model.includes('sonnet') ? 'sonnet' as const : 'opus' as const;
		const maxTurns = modelTier === 'sonnet' ? 15 : 25;

		// Analytics: model selection
		recordEvent({ taskId: task.id, taskTitle: task.title, type: 'model_selected', model, modelTier, provider: 'claude-code', projectId: task._sourceProjectId }).catch(() => {});

		// Each task gets a fresh session — no resume, no accumulated context
		recordSpawn().catch(() => {});
		const child = await spawnClaude(prompt, logFile, { model });

		if (!child.pid) {
			log(monitorSession, `[error] spawnClaude returned no PID for "${task.title}" — aborting`);
			return false;
		}

		const pid = child.pid;
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

		// Track in PID registry (survives crashes/HMR)
		registerPid(pid, `agent:${task.id}`, 'agent').catch(() => {});

		// Analytics: spawned
		recordEvent({ taskId: task.id, taskTitle: task.title, type: 'spawned', provider: 'claude-code', model, modelTier, pid, maxTurns, sessionId: reportId, projectId: task._sourceProjectId }).catch(() => {});

		child.on('close', async (code) => {
			unregisterPid(`agent:${task.id}`).catch(() => {});
			releaseSlot(task.id);
			const agentInfo = agents.get(task.id);
			const agentSnd = agentInfo?.sender ?? sender;
			const rId = agentInfo?.reportSessionId ?? reportId;
			const agentBaseline = agentInfo?.gitBaseline;
			agents.delete(task.id);
			getProjectAgentMap().delete(task.id);

			const exitMsg = code === 0 ? 'completed successfully' : `exited with code ${code}`;

			// Parse log for final stats before recording analytics
			const parsed = await parseStreamJsonLog(logFile);
			const startTime = agentInfo ? new Date(agentInfo.startedAt).getTime() : Date.now();
			const durationMs = parsed.usage?.durationMs ?? (Date.now() - startTime);

			// Record spawn stats
			recordSpawnCompletion(
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
				sessionId: rId,
				projectId: task._sourceProjectId
			}).catch(() => {});

			logAgentCompletion(task, agentSnd, exitMsg, logFile, rId, agentBaseline).catch(() => {});
			if (rId !== MONITOR_SESSION_ID) {
				logAgentCompletion(task, agentSnd, exitMsg, logFile, MONITOR_SESSION_ID, agentBaseline, { skipUsageRecord: true }).catch(() => {});
			}

			// ── Post-task: git commit + follow-up agents ──
			if (code === 0 && agentBaseline) {
				(async () => {
					const commitResult = await commitAgentChanges(task, agentBaseline, model);
					const ms = await loadMonitorSession();

					// Analytics: commit event
					recordEvent({
						taskId: task.id, taskTitle: task.title,
						type: 'committed',
						model, modelTier, provider: 'claude-code',
						commitHash: commitResult.hash,
						commitFiles: commitResult.filesCommitted,
						commitError: commitResult.error,
						projectId: task._sourceProjectId
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
								parentTaskId: task.id,
								projectId: task._sourceProjectId
							}).catch(() => {});

							await spawnFollowUp(task, fu.type, commitResult, ms);
						}
					}

					await saveMonitorSession(ms);

					// Fire-and-forget: run post-commit tests (non-blocking)
					runPostCommitTests(task, commitResult).catch(() => {});
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

			const taskRoot = task._sourceProjectPath ?? PATHS.root;
			if (code === 0) {
				updateTask(taskRoot, task.id, { status: 'completed' }).catch(() => {});
			} else {
				updateTask(taskRoot, task.id, { status: 'pending', assignee: null }).catch(() => {});
			}
		});

		log(monitorSession, `[spawn] Claude Code (${modelTier}) → "${task.title}" → chat: ${reportId}`);
		return true;
	} catch (err) {
		releaseSlot(task.id);
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
	const hbConfig = getHeartbeatConfig();

	heartbeatCount++;
	g.__claw_heartbeat_count = heartbeatCount;
	const session = await loadMonitorSession();
	session.status = 'streaming';

	const ts = new Date().toLocaleTimeString();
	log(session, `\n--- Heartbeat #${heartbeatCount} — ${ts} ---`);
	log(session, `[wake] Claw waking up`);

	await loadMaxAgents();

	// ── Phase 1: Plan (dynamically based on enabled phases)
	const enabledPhases: string[] = [];
	if (hbConfig.phases.healthChecks) enabledPhases.push('Check service health');
	if (hbConfig.phases.taskScanning) enabledPhases.push('Scan tasks across projects');
	enabledPhases.push('Check running agents');
	if (hbConfig.phases.agentSpawning) enabledPhases.push('Spawn agents for actionable tasks');
	if (hbConfig.phases.reviewCycle) enabledPhases.push('Review cycle');
	if (hbConfig.phases.memorySync) enabledPhases.push('Memory sync');
	log(session, `[plan] ${enabledPhases.join(' → ')}`);

	// ── Phase 2: Service health (gated by config.phases.healthChecks)
	let onlineCount = 0;
	let totalCount = 0;
	const changes: string[] = [];

	if (hbConfig.phases.healthChecks) {
		log(session, `[health] Probing services...`);
		const [ollama, gateway, daemon] = await Promise.all([
			isOllamaOnline(),
			checkHealth(SERVICES.openclaw.healthUrl!),
			isDaemonRunning()
		]);

		const statuses: Record<string, boolean> = { ollama, gateway, daemon };
		const services = Object.entries(statuses);
		onlineCount = services.filter(([, v]) => v).length;
		totalCount = services.length;
		const statusList = services.map(([n, v]) => `${n}: ${v ? 'up' : 'down'}`).join(', ');

		log(session, `[health] ${onlineCount}/${totalCount} up — ${statusList}`);

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

		// ── Phase 2b: Auto-restart offline services
		const serviceNameMap: Record<string, string> = { ollama: 'ollama', gateway: 'gateway', daemon: 'daemon' };
		const restartConfig = await loadRestartConfigAsync();
		if (restartConfig.enabled) {
			for (const [name, online] of services) {
				const restartName = serviceNameMap[name];
				if (!restartName) continue;

				if (online) {
					resetRestartCount(restartName);
				} else if (shouldRestart(restartName, restartConfig)) {
					log(session, `[restart] Attempting auto-restart of ${name}...`);
					const ok = await attemptRestart(restartName);
					if (ok) {
						log(session, `[restart] Restart command fired for ${name}`);
						await pushNotification({
							severity: 'warning',
							category: 'service',
							title: `Auto-restarting ${name}`,
							message: `Service ${name} is offline — restart attempt initiated`,
							source: 'claw',
							link: '/services',
							linkLabel: 'View Services'
						}).catch(() => {});
					} else {
						log(session, `[restart] No restart command available for ${name}`);
					}
				} else {
					const state = getRestartState().get(restartName);
					if (state && state.status === 'failed') {
						log(session, `[restart] ${name} exceeded max restart attempts (${restartConfig.maxAttempts}) — manual intervention required`);
						await pushNotification({
							severity: 'critical',
							category: 'service',
							title: `${name} restart failed`,
							message: `Exceeded ${restartConfig.maxAttempts} restart attempts — manual intervention required`,
							source: 'claw',
							link: '/services',
							linkLabel: 'View Services',
							desktop: true
						}).catch(() => {});
					} else if (state && state.status === 'cooldown') {
						log(session, `[restart] ${name} in cooldown — next attempt after ${Math.round(restartConfig.cooldownMs / 1000)}s`);
					}
				}
			}
		}
	} else {
		log(session, `[health] Phase disabled — skipping service health checks`);
	}

	// ── Phase 3: Task scan (gated by config.phases.taskScanning)
	let taskScan: TaskScanResult;

	if (hbConfig.phases.taskScanning) {
		log(session, `[tasks] Scanning tasks...`);
		taskScan = await scanTasks();
		log(session, `[tasks] ${taskScan.total} total — ${taskScan.pending} pending, ${taskScan.inProgress} in progress, ${taskScan.completed} completed`);

		if (taskScan.blocked.length > 0) {
			for (const t of taskScan.blocked) {
				const depCount = t.blockedBy?.length ?? 0;
				log(session, `[skip] Task "${t.title}" blocked by ${depCount} incomplete task(s)`);
			}
		}
		if (taskScan.clawAssigned.length > 0) {
			log(session, `[tasks] ${taskScan.clawAssigned.length} task(s) assigned to Claw: ${taskScan.clawAssigned.map((t) => `${t.title}${t._sourceProjectId ? ` [${t._sourceProjectId}]` : ''}`).join(', ')}`);
		}
		if (taskScan.unassignedPending.length > 0) {
			const byProject = new Map<string, number>();
			for (const t of taskScan.unassignedPending) {
				const pid = t._sourceProjectId ?? 'unknown';
				byProject.set(pid, (byProject.get(pid) ?? 0) + 1);
			}
			const projectBreakdown = [...byProject.entries()].map(([id, count]) => `${id}: ${count}`).join(', ');
			log(session, `[tasks] ${taskScan.unassignedPending.length} pending task(s) available — ${projectBreakdown}`);
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

		// Reset stale in_progress tasks across all projects
		if (taskScan.inProgress > 0) {
			const activeAgents = getActiveAgents();
			let staleReset = 0;
			const staleNames: string[] = [];
			try {
				const allProjects = await scanAllProjects(PATHS.playgroundRegistry, PATHS.root).catch(() => [] as Awaited<ReturnType<typeof scanAllProjects>>);
				const projectPaths = new Set<string>([PATHS.root]);
				for (const project of allProjects) {
					projectPaths.add(resolve(project.path));
				}

				for (const projPath of projectPaths) {
					try {
						const tasks = await getAllTasks(projPath);
						for (const task of tasks) {
							if (task.status === 'in_progress' && task.assignee === 'claw' && !activeAgents.has(task.id)) {
								await updateTask(projPath, task.id, { status: 'pending', assignee: null }).catch(() => {});
								staleNames.push(task.title);
								staleReset++;
							}
						}
					} catch { /* skip inaccessible project */ }
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

		// ── Phase 3a: Process suggestion inbox (from agents, daemon, etc.)
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
	} else {
		log(session, `[tasks] Phase disabled — skipping task scan`);
		taskScan = { ...EMPTY_TASK_SCAN };
	}

	// ── Phase 4: Check running agents + reap orphans (always runs)
	checkAgents(session);

	// Reap agents whose PIDs are no longer alive (orphaned by HMR, crash, etc.)
	try {
		const reaped = await reapOrphanedAgents();
		if (reaped > 0) {
			log(session, `[cleanup] Reaped ${reaped} orphaned agent(s) — PID no longer alive`);
		}
	} catch { /* reap failed gracefully */ }

	await tailAgentLogs(session);

	// ── Phase 5: Agent spawning (gated by config.phases.agentSpawning)
	let spawned = 0;

	if (hbConfig.phases.agentSpawning) {
		const projectLimits = getProjectLimits();
		const seenProjects = new Map<string, string>();
		for (const t of [...taskScan.clawAssigned, ...taskScan.unassignedPending]) {
			if (t._sourceProjectId && t._sourceProjectPath && !seenProjects.has(t._sourceProjectId)) {
				seenProjects.set(t._sourceProjectId, t._sourceProjectPath);
			}
		}
		for (const [projId, projPath] of seenProjects) {
			await loadProjectMaxAgents(projPath, projId);
		}
		if (seenProjects.size > 0) {
			const limitSummary = [...seenProjects.keys()].map(id => `${id}: ${projectLimits.get(id) ?? 2}`).join(', ');
			log(session, `[spawn] Per-project limits: ${limitSummary} (global max: ${getMaxConcurrentAgents()})`);
		}

		// ── Phase 5b: On-demand agent spawning (round-robin across projects)
		// For each eligible task: requestSlot → spawn if slot available → skip if not
		const actionable = [...taskScan.clawAssigned, ...taskScan.unassignedPending];

		if (actionable.length > 0) {
			const agents = getActiveAgents();
			const slotsAvailable = getMaxConcurrentAgents() - agents.size;

			if (slotsAvailable > 0) {
				log(session, `[spawn] ${slotsAvailable} global slot(s) available — evaluating ${actionable.length} actionable task(s)`);

				// Group tasks by project, preserving priority order within each group
				const tasksByProject = new Map<string, Task[]>();
				for (const task of actionable) {
					const projId = task._sourceProjectId ?? 'unknown';
					if (!tasksByProject.has(projId)) tasksByProject.set(projId, []);
					tasksByProject.get(projId)!.push(task);
				}

				// Round-robin: interleave tasks across projects so no single project
				// drains all global slots before others get a turn
				const projectQueues = [...tasksByProject.entries()];
				const interleaved: Task[] = [];
				let remaining = true;
				while (remaining) {
					remaining = false;
					for (const [, tasks] of projectQueues) {
						if (tasks.length > 0) {
							interleaved.push(tasks.shift()!);
							remaining = remaining || tasks.length > 0;
						}
					}
				}

				for (const task of interleaved) {
					if (spawned >= slotsAvailable) break;
					if (agents.has(task.id)) continue;

					// spawnAgent() calls requestSlot() internally — handles both
					// global and per-project limits, logs skip reasons
					if (await spawnAgent(task, session)) {
						const projId = task._sourceProjectId;
						if (projId) {
							getProjectAgentMap().set(task.id, projId);
						}

						const taskRoot = task._sourceProjectPath ?? PATHS.root;
						await updateTask(taskRoot, task.id, {
							status: 'in_progress',
							assignee: 'claw'
						}).catch(() => {});
						spawned++;

						if (notificationsEnabled) {
							await pushNotification({
								severity: 'info',
								category: 'agent',
								title: `Claw spawned agent: ${task.title}`,
								message: `Working on ${task.id} [${task.priority}] — ${pickModelForTask(task)}${projId ? ` (${projId})` : ''}`,
								source: 'claw',
								link: `/chat?session=${taskSessionId(task.id)}`,
								linkLabel: 'View Task'
							});
						}
					}
				}
			} else {
				log(session, `[spawn] No agent slots — ${agents.size}/${getMaxConcurrentAgents()} running`);
			}
		} else {
			log(session, `[spawn] No actionable tasks — nothing to spawn`);
		}

		// ── Phase 5c: Audit project agent associations
		// Check every 5th heartbeat for projects with no agents configured
		if (heartbeatCount % 5 === 1) {
			try {
				const allProjects = await scanAllProjects(PATHS.playgroundRegistry, PATHS.root).catch(() => []);
				for (const project of allProjects) {
					try {
						const assocRaw = await readFile(resolve(project.path, '.playground', 'agents.json'), 'utf-8').catch(() => '{"agents":[]}');
						const assoc = JSON.parse(assocRaw) as { agents: string[] };
						if (assoc.agents.length === 0 && project.status === 'active') {
							// Only log once per project per session by checking monitor session content
							const alreadyNotified = session.messages.some(m =>
								m.content.includes(`[agents] Project "${project.id}" has no agents`)
							);
							if (!alreadyNotified) {
								const meta = await detectProjectMeta(project.path).catch(() => null);
								const profileHints: string[] = [];
								if (meta?.language) profileHints.push(meta.language);
								if (meta?.framework) profileHints.push(meta.framework);
								if (!meta?.testCommand) profileHints.push('no tests');
								if (meta?.workflows.length === 0) profileHints.push('no CI/CD');
								if (!meta?.maintenance.hasDocsDir) profileHints.push('no docs');

								log(session, `[agents] Project "${project.id}" has no agents configured` +
									(profileHints.length > 0 ? ` (${profileHints.join(', ')})` : '') +
									` — use Suggest Agents on /projects/${project.id}/agents to auto-configure`);

								if (notificationsEnabled) {
									await pushNotification({
										severity: 'info',
										category: 'agent',
										title: `Project "${project.name}" needs agents`,
										message: `No agents configured${profileHints.length > 0 ? ` — detected: ${profileHints.join(', ')}` : ''}. Click to configure.`,
										source: 'claw',
										link: `/projects/${project.id}/agents`,
										linkLabel: 'Configure Agents'
									});
								}
							}
						}
					} catch { /* skip individual project errors */ }
				}
			} catch { /* project scan failed */ }
		}

		// ── Phase 5d: UX Inspection (every 5th heartbeat)
		// UX inspector (Playwright) disabled — wastes VRAM and blocks GPU for art gen
		if (false && heartbeatCount % 5 === 0 && heartbeatCount > 0) {
			try {
				await runUxInspection(session);
			} catch (err) {
				const msg = err instanceof Error ? err.message : 'ux inspection failed';
				log(session, `[error] UX inspection failed: ${msg}`);
			}
		}
	} else {
		log(session, `[spawn] Phase disabled — skipping agent spawning`);
	}

	// ── Phase 6: Project review cycle (gated by config.phases.reviewCycle)
	if (hbConfig.phases.reviewCycle) {
		const agents = getActiveAgents();
		const timeSinceReview = Date.now() - lastReviewAt;
		const reviewCooldown = hbConfig.intervals.reviewCycle;
		const shouldReviewNow = taskScan.pending === 0
			&& taskScan.clawAssigned.length === 0
			&& taskScan.unassignedPending.length === 0
			&& taskScan.flaggedForDiscussion.length === 0
			&& agents.size === 0
			&& timeSinceReview > reviewCooldown;

		if (shouldReviewNow) {
			log(session, `[review] No pending tasks — launching project review`);
			lastReviewAt = Date.now();
			g.__claw_last_review = lastReviewAt;
			await spawnReviewAgent(session);
		}
	}

	// ── Phase 7: Notifications
	if (notificationsEnabled) {
		const allUp = onlineCount === totalCount && totalCount > 0;
		const hasErrors = !allUp || changes.some((c) => c.includes('went offline'));

		const parts: string[] = [];
		if (hbConfig.phases.healthChecks) {
			parts.push(`checked services (${onlineCount}/${totalCount} up)`);
		}
		if (hbConfig.phases.taskScanning) {
			parts.push(`scanned tasks (${taskScan.pending} pending, ${taskScan.inProgress} active)`);
		}
		if (spawned > 0) parts.push(`spawned ${spawned} agent(s)`);
		if (changes.length > 0) parts.push(changes.join(', '));
		if (taskScan.flaggedForDiscussion.length > 0) parts.push(`${taskScan.flaggedForDiscussion.length} flagged for discussion`);

		await pushNotification({
			severity: hasErrors ? 'warning' : 'success',
			category: 'system',
			title: `Heartbeat #${heartbeatCount}`,
			message: parts.join(', ') || 'cycle complete',
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

	// ── Phase 8: Memory bridge sync (gated by config.phases.memorySync)
	if (hbConfig.phases.memorySync) {
		try {
			const bridgeResult = await syncMemoryBridge();
			if (bridgeResult.added > 0 || bridgeResult.updated > 0) {
				log(session, `[memory] Bridge sync: +${bridgeResult.added} new, ${bridgeResult.updated} updated — sources: ${bridgeResult.sources.join(', ')}`);
			}
			if (bridgeResult.errors.length > 0) {
				log(session, `[memory] Bridge errors: ${bridgeResult.errors.join('; ')}`);
			}
		} catch { /* memory bridge is best-effort */ }

		// ── Phase 9: Memory Guardian
		try {
			const guardianCfg = await loadGuardianConfig();
			const guardianReport = await runMemoryGuardian(session, guardianCfg);
			if (guardianReport && (guardianReport.agentsKilled > 0 || guardianReport.agentsWarned > 0)) {
				await pushNotification({
					severity: guardianReport.agentsKilled > 0 ? 'critical' : 'warning',
					category: 'system',
					title: 'Memory Guardian alert',
					message: `${guardianReport.agentsWarned} warned, ${guardianReport.agentsKilled} killed — ${(guardianReport.logBytesFreed / 1024 / 1024).toFixed(1)} MB freed`,
					source: 'claw',
					link: `/chat?session=${MONITOR_SESSION_ID}`,
					linkLabel: 'View Monitor',
					desktop: guardianReport.agentsKilled > 0
				}).catch(() => {});
			}
		} catch { /* guardian is best-effort */ }
	} else {
		log(session, `[memory] Phase disabled — skipping memory sync`);
	}

	// ── Phase 10: Cleanup & Idle
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
	// Use the smallest enabled phase interval as the heartbeat tick rate
	const hbConfig = getHeartbeatConfig();
	const interval = Math.min(
		hbConfig.intervals.healthChecks,
		hbConfig.intervals.taskScanning,
		hbConfig.intervals.agentSpawning,
	);
	setTimer(setTimeout(() => {
		heartbeat().catch(() => { scheduleNext(); });
	}, interval));
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
	ensureChatsDir().then(async () => {
		cleanupStuckSessions().catch(() => {});

		// Load config from disk on startup
		await loadHeartbeatConfig();

		// Kill orphaned processes from previous server instance
		try {
			const { reaped } = await reapStaleProcesses();
			if (reaped.length > 0) {
				console.log(`[heartbeat] Reaped ${reaped.length} orphaned process(es): ${reaped.join(', ')}`);
			}
		} catch { /* don't block startup */ }

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
