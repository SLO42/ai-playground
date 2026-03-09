/**
 * Post-task actions — git commit and follow-up agent spawning.
 *
 * After a code agent completes successfully:
 * 1. Commit the agent's file changes with a task-specific message
 * 2. Spawn a lightweight documenter agent to update memory/docs if needed
 */
import { execSync } from 'child_process';
import { PATHS } from '../constants.js';
import { pushNotification } from '../notifications.js';
import {
	MONITOR_SESSION_ID, getActiveAgents, maxConcurrentAgents,
	agentSender, log, trimSession, ensureTaskSession,
	loadMonitorSession, saveMonitorSession,
	getProjectAgentMap, getProjectLimits, countProjectAgents
} from './shared.js';
import { spawnClaude, pickModelForTask } from './agent-spawn.js';
import { logAgentCompletion, parseStreamJsonLog } from './agent-tracking.js';
import { recordEvent } from './agent-analytics.js';
import { resolveSession, releaseSession, watchForSessionId } from './session-pool.js';
import { registerPid, unregisterPid } from './pid-registry.js';
import type { ChatSession } from '$lib/types/chat.js';
import type { Task } from '$lib/types/tasks.js';

// ── Git commit for completed tasks ──────────────────────────────────

export interface CommitResult {
	committed: boolean;
	hash?: string;
	filesCommitted: number;
	message?: string;
	error?: string;
}

/**
 * Commit only the files an agent changed (delta from baseline).
 * Returns info about the commit or why it was skipped.
 */
export function commitAgentChanges(
	task: Task,
	baseline: Set<string>,
	model: string
): CommitResult {
	try {
		// Get current modified files
		const currentRaw = execSync('git diff --name-only', {
			cwd: PATHS.root, encoding: 'utf-8', timeout: 5000
		}).trim();
		const currentFiles = new Set(currentRaw.split('\n').filter(Boolean));

		// Also check for new untracked files the agent may have created
		const untrackedRaw = execSync('git ls-files --others --exclude-standard', {
			cwd: PATHS.root, encoding: 'utf-8', timeout: 5000
		}).trim();
		const untrackedFiles = new Set(untrackedRaw.split('\n').filter(Boolean));

		// Delta: files that are modified now but weren't before the agent ran
		const agentFiles: string[] = [];
		for (const f of currentFiles) {
			if (!baseline.has(f)) agentFiles.push(f);
		}
		// Include new files the agent created (weren't tracked before)
		for (const f of untrackedFiles) {
			if (!baseline.has(f)) agentFiles.push(f);
		}

		if (agentFiles.length === 0) {
			return { committed: false, filesCommitted: 0, message: 'no new changes to commit' };
		}

		// Filter out sensitive files
		const safeFiles = agentFiles.filter(f =>
			!f.includes('.env') &&
			!f.includes('credentials') &&
			!f.includes('secret') &&
			!f.endsWith('.key') &&
			!f.endsWith('.pem') &&
			!f.includes('node_modules/')
		);

		if (safeFiles.length === 0) {
			return { committed: false, filesCommitted: 0, message: 'only sensitive files changed — skipped' };
		}

		// Stage only the agent's files
		const fileArgs = safeFiles.map(f => `"${f}"`).join(' ');
		execSync(`git add ${fileArgs}`, {
			cwd: PATHS.root, encoding: 'utf-8', timeout: 10000
		});

		// Build commit message
		const scope = inferCommitScope(safeFiles);
		const verb = inferCommitVerb(task);
		const commitMsg = `${verb}(${scope}): ${task.title}\n\nTask: ${task.id}\nModel: ${model}\nFiles: ${safeFiles.length}\n\nCo-Authored-By: Claw Agent <noreply@openclaw.ai>`;

		const result = execSync(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, {
			cwd: PATHS.root, encoding: 'utf-8', timeout: 15000
		});

		// Extract commit hash
		const hashMatch = result.match(/\[[\w/]+ ([a-f0-9]+)\]/);
		const hash = hashMatch?.[1] ?? 'unknown';

		return {
			committed: true,
			hash,
			filesCommitted: safeFiles.length,
			message: `${hash} — ${safeFiles.length} file(s)`
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message.split('\n')[0] : 'git commit failed';
		return { committed: false, filesCommitted: 0, error: msg };
	}
}

function inferCommitScope(files: string[]): string {
	// Find the most common directory
	const dirs = files.map(f => {
		const parts = f.split('/');
		if (parts[0] === 'dashboard' && parts[1] === 'src') {
			if (parts[2] === 'routes') return parts[3] ?? 'routes';
			if (parts[2] === 'lib' && parts[3] === 'server') return parts[4]?.replace(/\.ts$/, '') ?? 'server';
			if (parts[2] === 'lib' && parts[3] === 'components') return 'components';
			return parts[2] ?? 'dashboard';
		}
		return parts[0] ?? 'root';
	});

	const counts = new Map<string, number>();
	for (const d of dirs) counts.set(d, (counts.get(d) ?? 0) + 1);
	const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
	return sorted[0]?.[0] ?? 'dashboard';
}

function inferCommitVerb(task: Task): string {
	const text = `${task.title} ${task.description ?? ''}`.toLowerCase();
	if (/\bfix\b|\bbug\b|\bbroken\b|\bcrash\b/.test(text)) return 'fix';
	if (/\brefactor\b|\brework\b|\bclean\b|\breorganize\b/.test(text)) return 'refactor';
	if (/\btest\b|\bspec\b|\be2e\b/.test(text)) return 'test';
	if (/\bdoc\b|\breadme\b|\bcomment\b/.test(text)) return 'docs';
	if (/\bstyle\b|\bcss\b|\btailwind\b|\bresponsive\b/.test(text)) return 'style';
	if (/\bci\b|\bworkflow\b|\bdeploy\b|\bdocker\b/.test(text)) return 'ci';
	return 'feat';
}

// ── Follow-up agent spawning ────────────────────────────────────────

export type FollowUpType = 'documenter';

interface FollowUpConfig {
	type: FollowUpType;
	shouldSpawn: boolean;
	reason: string;
}

/**
 * Decide which follow-up agents (if any) should run after a task completes.
 * Memory follow-up agents were removed — the heartbeat maintains a compact
 * project map automatically via the memory bridge. Agents should read memory
 * (memory_search) but never write to it.
 */
export function planFollowUps(
	task: Task,
	commitResult: CommitResult,
	_parsed: { mcpTools: string[]; usedClaudeFlow: boolean }
): FollowUpConfig[] {
	const followUps: FollowUpConfig[] = [];

	if (!commitResult.committed || commitResult.filesCommitted === 0) {
		return followUps; // No changes = nothing to document
	}

	// Documenter: runs when the agent changed 3+ files or touched server/types
	const manyFiles = commitResult.filesCommitted >= 3;
	const touchedServer = commitResult.message?.includes('server') ?? false;
	const touchedTypes = commitResult.message?.includes('types') ?? false;
	const isFeature = inferCommitVerb(task) === 'feat';

	if (manyFiles || touchedServer || touchedTypes || isFeature) {
		followUps.push({
			type: 'documenter',
			shouldSpawn: true,
			reason: manyFiles ? `${commitResult.filesCommitted} files changed` :
				isFeature ? 'new feature' :
				touchedServer ? 'server module changed' : 'type definitions changed'
		});
	}

	return followUps;
}

/**
 * Spawn a lightweight follow-up agent (Sonnet tier, low max turns).
 */
export async function spawnFollowUp(
	parentTask: Task,
	type: FollowUpType,
	commitResult: CommitResult,
	monitorSession: ChatSession
): Promise<boolean> {
	const agents = getActiveAgents();
	if (agents.size >= maxConcurrentAgents) {
		log(monitorSession, `[follow-up] Skipping ${type} — max agents reached`);
		return false;
	}

	// Respect per-project limits for follow-ups (same as normal spawns)
	const projId = parentTask._sourceProjectId;
	if (projId) {
		const projMax = getProjectLimits().get(projId) ?? 2;
		const projActive = countProjectAgents(projId);
		if (projActive >= projMax) {
			log(monitorSession, `[follow-up] Skipping ${type} — project "${projId}" at agent limit (${projActive}/${projMax})`);
			return false;
		}
	}

	const followUpId = `${parentTask.id}-${type}`;
	if (agents.has(followUpId)) return false;

	const prompt = buildFollowUpPrompt(type, parentTask, commitResult);
	const logFile = `${PATHS.headlessLogsDir}/agent-${followUpId}.log`;
	const label = type === 'documenter' ? 'Documenter' : 'Memory';
	const sender = agentSender(followUpId, `${label}: ${parentTask.title.slice(0, 20)}`);
	const reportId = await ensureTaskSession(
		{ ...parentTask, id: followUpId, title: `${label}: ${parentTask.title}` } as Task,
		sender
	);

	const model = 'claude-sonnet-4-6'; // Always Sonnet for follow-ups (cheap + fast)

	try {
		const session = await resolveSession(
			{ ...parentTask, id: followUpId } as Task,
			model
		);

		recordEvent({
			taskId: followUpId, taskTitle: `${label}: ${parentTask.title}`,
			type: 'spawned', provider: 'claude-code', model, modelTier: 'sonnet',
			projectId: parentTask._sourceProjectId
		}).catch(() => {});

		const child = spawnClaude(prompt, logFile, {
			model,
			resumeSessionId: session.sessionId,
			slotId: session.slotId
		});

		const pid = child.pid ?? 0;
		agents.set(followUpId, {
			taskId: followUpId,
			pid,
			startedAt: new Date().toISOString(),
			sender,
			logFile,
			lastLogPos: 0,
			reportSessionId: reportId
		});

		// Track follow-up in project agent map so it counts against per-project limits
		if (projId) {
			getProjectAgentMap().set(followUpId, projId);
		}

		// Track in PID registry (survives crashes/HMR)
		registerPid(pid, `agent:${followUpId}`, 'agent').catch(() => {});

		if (!session.isResume) {
			watchForSessionId(logFile, session.slotId).catch(() => {});
		}

		child.on('close', (code) => {
			unregisterPid(`agent:${followUpId}`).catch(() => {});
			const agentStarted = agents.get(followUpId)?.startedAt;
			agents.delete(followUpId);
			getProjectAgentMap().delete(followUpId);

			const parsed = parseStreamJsonLog(logFile);
			const startTime = agentStarted ? new Date(agentStarted).getTime() : Date.now();

			releaseSession(
				session.slotId,
				parsed.usage?.totalTokens ?? 0,
				parsed.usage?.costUsd ?? 0
			).catch(() => {});

			// Record on parent task so events group together
			recordEvent({
				taskId: parentTask.id,
				taskTitle: parentTask.title,
				type: 'follow_up_done',
				model, modelTier: 'sonnet', provider: 'claude-code',
				exitCode: code ?? undefined,
				durationMs: parsed.usage?.durationMs ?? (Date.now() - startTime),
				inputTokens: parsed.usage?.inputTokens ?? 0,
				outputTokens: parsed.usage?.outputTokens ?? 0,
				costUsd: parsed.usage?.costUsd ?? 0,
				followUpType: type,
				parentTaskId: parentTask.id,
				projectId: parentTask._sourceProjectId
			}).catch(() => {});

			logAgentCompletion(
				{ ...parentTask, id: followUpId, title: `${label}: ${parentTask.title}` } as Task,
				sender, code === 0 ? 'completed' : `exited ${code}`,
				logFile, reportId
			).catch(() => {});

			// Also log to monitor
			loadMonitorSession().then(ms => {
				log(ms, `[follow-up] ${label} for "${parentTask.title}" — ${code === 0 ? 'done' : `exit ${code}`}`);
				saveMonitorSession(ms);
			}).catch(() => {});
		});

		log(monitorSession, `[follow-up] Spawned ${type} agent (sonnet) for "${parentTask.title}" → chat: ${reportId}`);
		return true;
	} catch (err) {
		const msg = err instanceof Error ? err.message : 'spawn failed';
		log(monitorSession, `[error] Failed to spawn ${type} follow-up: ${msg}`);
		return false;
	}
}

// ── Follow-up prompts ───────────────────────────────────────────────

function buildFollowUpPrompt(_type: FollowUpType, task: Task, commit: CommitResult): string {
	return buildDocumenterPrompt(task, commit);
}

function buildDocumenterPrompt(task: Task, commit: CommitResult): string {
	// Get the actual diff for context
	let diffSummary = '';
	try {
		diffSummary = execSync(`git show ${commit.hash} --stat`, {
			cwd: PATHS.root, encoding: 'utf-8', timeout: 10000
		}).trim();
	} catch { /* no diff available */ }

	return [
		`You are a documentation agent. A code agent just completed a task and committed changes.`,
		`Your job is to update relevant documentation and architecture notes.`,
		``,
		`## Completed Task`,
		`**Title**: ${task.title}`,
		`**ID**: ${task.id}`,
		`**Description**: ${task.description ?? 'none'}`,
		`**Tags**: ${task.tags.join(', ') || 'none'}`,
		``,
		`## Commit`,
		`**Hash**: ${commit.hash}`,
		`**Files**: ${commit.filesCommitted}`,
		``,
		`## Diff Summary`,
		'```',
		diffSummary,
		'```',
		``,
		`## Instructions`,
		`1. Read the committed changes using \`git show ${commit.hash}\` to understand what changed`,
		`2. Update ONLY the files that need documentation updates:`,
		`   - \`dashboard/ARCHITECTURE.md\` — if the architecture changed (new modules, new routes, new patterns)`,
		`   - Inline JSDoc comments — if new exported functions lack documentation`,
		`   - \`docs/api-contracts.md\` — if API endpoints were added or changed`,
		`3. Do NOT:`,
		`   - Create new documentation files`,
		`   - Add comments to code you didn't change`,
		`   - Update README or CLAUDE.md`,
		`   - Touch any code logic — documentation only`,
		`4. Run \`npm run build\` in dashboard/ to verify nothing broke`,
		`5. Keep changes minimal — only document what the code agent actually changed`,
		``,
		`## Token Budget`,
		`You have a small budget (~50K tokens). Read only the diff, update only what's needed, build, done.`,
	].join('\n');
}

