/**
 * Release Agent — autonomous release preparation via Claw.
 *
 * Spawns a Claude Code agent that runs tests, generates a changelog from
 * conventional commits, determines the version bump, and (unless dry-run)
 * bumps package.json, tags, and creates a GitHub release.
 */
import { PATHS } from '../constants.js';
import {
	getActiveAgents, getMaxConcurrentAgents,
	agentSender, log, ensureTaskSession,
	loadMonitorSession, saveMonitorSession,
	getProjectAgentMap, getProjectLimits, countProjectAgents
} from './shared.js';
import { spawnClaude } from './agent-spawn.js';
import { logAgentCompletion, parseStreamJsonLog } from './agent-tracking.js';
import { recordEvent } from './agent-analytics.js';
import { recordSpawn, recordSpawnCompletion } from './session-pool.js';
import { registerPid, unregisterPid } from './pid-registry.js';
import type { Task } from '$lib/types/tasks.js';

// ── Public API ──────────────────────────────────────────────────────

export interface ReleaseAgentOptions {
	dryRun?: boolean;
}

/**
 * Spawn a release-preparation agent for the given project.
 * Returns true if the agent was spawned, false if skipped (limit reached, already running, etc.).
 */
export async function spawnReleaseAgent(
	projectPath: string,
	projectId: string,
	options?: ReleaseAgentOptions
): Promise<boolean> {
	const dryRun = options?.dryRun ?? false;
	const agents = getActiveAgents();
	const monitorSession = await loadMonitorSession();

	if (agents.size >= getMaxConcurrentAgents()) {
		log(monitorSession, `[release] Skipping release agent — max agents reached (${agents.size}/${getMaxConcurrentAgents()})`);
		await saveMonitorSession(monitorSession);
		return false;
	}

	// Respect per-project limits
	const projMax = getProjectLimits().get(projectId) ?? 2;
	const projActive = countProjectAgents(projectId);
	if (projActive >= projMax) {
		log(monitorSession, `[release] Skipping release agent — project "${projectId}" at agent limit (${projActive}/${projMax})`);
		await saveMonitorSession(monitorSession);
		return false;
	}

	const agentId = `release-${projectId}`;
	if (agents.has(agentId)) {
		log(monitorSession, `[release] Release agent already running for "${projectId}"`);
		await saveMonitorSession(monitorSession);
		return false;
	}

	const prompt = buildReleasePrompt(projectPath, projectId, dryRun);
	const logFile = `${PATHS.headlessLogsDir}/agent-${agentId}.log`;
	const label = dryRun ? 'Release (dry-run)' : 'Release';
	const sender = agentSender(agentId, `${label}: ${projectId}`);

	// Build a synthetic Task for the session/tracking APIs
	const now = new Date().toISOString();
	const syntheticTask: Task = {
		id: agentId,
		title: `${label} preparation for ${projectId}`,
		description: dryRun ? 'Dry-run release — no changes will be made' : 'Prepare and publish a release',
		priority: 'medium',
		status: 'in_progress',
		flagDiscussion: false,
		assignee: null,
		feature: null,
		createdBy: 'claw:release-agent',
		completedAt: null,
		tags: ['release', 'automation'],
		createdAt: now,
		updatedAt: now,
		_sourceProjectId: projectId
	};

	const reportId = await ensureTaskSession(syntheticTask, sender);
	const model = 'claude-sonnet-4-6'; // Sonnet — release steps are well-defined

	try {
		recordEvent({
			taskId: agentId,
			taskTitle: syntheticTask.title,
			type: 'spawned',
			provider: 'claude-code',
			model,
			modelTier: 'sonnet',
			projectId
		}).catch(() => {});

		recordSpawn().catch(() => {});
		const child = await spawnClaude(prompt, logFile, { model });

		const pid = child.pid ?? 0;
		agents.set(agentId, {
			taskId: agentId,
			pid,
			startedAt: new Date().toISOString(),
			sender,
			logFile,
			lastLogPos: 0,
			reportSessionId: reportId
		});

		getProjectAgentMap().set(agentId, projectId);
		registerPid(pid, `agent:${agentId}`, 'agent').catch(() => {});

		child.on('close', async (code) => {
			unregisterPid(`agent:${agentId}`).catch(() => {});
			const agentStarted = agents.get(agentId)?.startedAt;
			agents.delete(agentId);
			getProjectAgentMap().delete(agentId);

			const parsed = await parseStreamJsonLog(logFile);
			const startTime = agentStarted ? new Date(agentStarted).getTime() : Date.now();

			recordSpawnCompletion(
				parsed.usage?.totalTokens ?? 0,
				parsed.usage?.costUsd ?? 0
			).catch(() => {});

			recordEvent({
				taskId: agentId,
				taskTitle: syntheticTask.title,
				type: code === 0 ? 'completed' : 'failed',
				model,
				modelTier: 'sonnet',
				provider: 'claude-code',
				exitCode: code ?? undefined,
				durationMs: parsed.usage?.durationMs ?? (Date.now() - startTime),
				inputTokens: parsed.usage?.inputTokens ?? 0,
				outputTokens: parsed.usage?.outputTokens ?? 0,
				costUsd: parsed.usage?.costUsd ?? 0,
				projectId
			}).catch(() => {});

			logAgentCompletion(
				syntheticTask, sender,
				code === 0 ? 'completed' : `exited ${code}`,
				logFile, reportId
			).catch(() => {});

			loadMonitorSession().then(ms => {
				log(ms, `[release] ${label} agent for "${projectId}" — ${code === 0 ? 'done' : `exit ${code}`}`);
				saveMonitorSession(ms);
			}).catch(() => {});
		});

		log(monitorSession, `[release] Spawned ${label.toLowerCase()} agent (sonnet) for "${projectId}" → chat: ${reportId}`);
		await saveMonitorSession(monitorSession);
		return true;
	} catch (err) {
		const msg = err instanceof Error ? err.message : 'spawn failed';
		log(monitorSession, `[error] Failed to spawn release agent: ${msg}`);
		await saveMonitorSession(monitorSession);
		return false;
	}
}

// ── Prompt builder ──────────────────────────────────────────────────

function buildReleasePrompt(projectPath: string, projectId: string, dryRun: boolean): string {
	const mode = dryRun ? 'DRY-RUN' : 'LIVE';

	return [
		`You are Claw, an autonomous release agent. Prepare a release for project "${projectId}".`,
		``,
		`## Mode: ${mode}`,
		dryRun
			? `This is a dry-run. Do NOT modify any files, create tags, or publish releases. Only report what would happen.`
			: `This is a live release. You will bump the version, create a git tag, and publish a GitHub release.`,
		``,
		`## Project Path`,
		`\`${projectPath}\``,
		``,
		`## Steps`,
		``,
		`### 1. Run Tests`,
		`Run the project's test suite to verify everything passes before releasing:`,
		'```bash',
		`cd "${projectPath}" && npm test`,
		'```',
		`If tests fail, STOP and report the failures. Do not proceed with the release.`,
		``,
		`### 2. Generate Changelog`,
		`Get conventional commits since the last git tag:`,
		'```bash',
		`cd "${projectPath}" && git log $(git describe --tags --abbrev=0 2>/dev/null || echo "HEAD~20")..HEAD --oneline --no-decorate`,
		'```',
		`Parse each commit for type (feat/fix/refactor/docs/etc) and group them.`,
		``,
		`### 3. Determine Version Bump`,
		`Based on the commits:`,
		`- Any \`feat!\` or \`BREAKING CHANGE\` → **major** bump`,
		`- Any \`feat\` → **minor** bump`,
		`- Only \`fix\`, \`docs\`, \`refactor\`, etc → **patch** bump`,
		``,
		`Read the current version from \`${projectPath}/package.json\`.`,
		``,
		...(dryRun ? [
			`### 4. Report (Dry-Run)`,
			`Output a summary:`,
			`- Current version`,
			`- Recommended bump type and next version`,
			`- Formatted changelog grouped by commit type`,
			`- Number of commits included`,
			``,
			`Do NOT modify any files.`,
		] : [
			`### 4. Bump Version`,
			`Update the \`version\` field in \`${projectPath}/package.json\` to the new version.`,
			`Run \`npm run build\` to verify the build passes with the new version.`,
			``,
			`### 5. Create Git Tag`,
			'```bash',
			`cd "${projectPath}" && git add package.json && git commit -m "chore(release): v<NEW_VERSION>" && git tag -a "v<NEW_VERSION>" -m "Release v<NEW_VERSION>"`,
			'```',
			``,
			`### 6. Create GitHub Release`,
			`Use the \`gh\` CLI to create a release with the changelog:`,
			'```bash',
			`cd "${projectPath}" && gh release create "v<NEW_VERSION>" --title "v<NEW_VERSION>" --notes "<CHANGELOG>"`,
			'```',
			`If \`gh\` is not available or fails, report the error but do not fail the whole run.`,
		]),
		``,
		`## Token Budget`,
		`You have a small budget (~50K tokens). Run tests, check commits, ${dryRun ? 'report' : 'release'}, done.`,
		`Do NOT read CLAUDE.md, README, or explore the codebase. Stay focused on the release steps.`,
	].join('\n');
}
