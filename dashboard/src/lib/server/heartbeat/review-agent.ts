/**
 * Project review agent — runs through OpenClaw (local Ollama, $0) by default.
 * Only escalates to Claude Code if Ollama is unreachable.
 */
import { readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';
import { APIS, PATHS } from '../constants.js';
import { pushNotification } from '../notifications.js';
import { getAllTasks, migrateIfNeeded, createTask, updateTask } from '../task-store.js';
import { scanAllProjects } from '../project-scanner.js';
import {
	MONITOR_SESSION_ID, agentSender, getActiveAgents, maxConcurrentAgents,
	log, trimSession, upsertSessionMeta, saveMonitorSession
} from './shared.js';
import { spawnClaude } from './agent-spawn.js';
import { logAgentCompletion, parseStreamJsonLog, captureGitBaseline } from './agent-tracking.js';
import { classifyTask } from './openclaw-agent.js';
import type { ChatSession, ChatSender } from '$lib/types/chat.js';
import type { Task } from '$lib/types/tasks.js';

const REVIEW_SESSION_ID = 'claw-review';
const DEFAULT_MODEL = 'gpt-oss:20b';

export async function spawnReviewAgent(monitorSession: ChatSession): Promise<void> {
	const agents = getActiveAgents();
	if (agents.size >= maxConcurrentAgents) return;

	const sender = agentSender('review', 'Claw Review');
	const reportId = REVIEW_SESSION_ID;

	await ensureReviewSession(sender);

	const prompt = await buildReviewPrompt();

	// Try OpenClaw first ($0) — only fall back to Claude Code if Ollama is down
	const ollamaUp = await isOllamaReachable();

	if (ollamaUp) {
		log(monitorSession, `[review] Running via OpenClaw (local, $0) → chat: ${reportId}`);
		runOpenClawReview(prompt, sender, reportId, monitorSession).catch((err) => {
			const msg = err instanceof Error ? err.message : 'review failed';
			log(monitorSession, `[error] OpenClaw review failed: ${msg}`);
			agents.delete('review');
		});
		return;
	}

	log(monitorSession, `[review] Ollama offline — escalating to Claude Code`);
	spawnClaudeReview(prompt, sender, reportId, monitorSession);
}

async function isOllamaReachable(): Promise<boolean> {
	try {
		const res = await fetch(`${APIS.ollama}/api/tags`, { signal: AbortSignal.timeout(3000) });
		return res.ok;
	} catch {
		return false;
	}
}

async function runOpenClawReview(
	prompt: string,
	sender: ChatSender,
	reportId: string,
	monitorSession: ChatSession
): Promise<void> {
	const agents = getActiveAgents();
	const startTime = Date.now();

	agents.set('review', {
		taskId: 'review',
		pid: 0,
		startedAt: new Date().toISOString(),
		sender,
		logFile: '',
		lastLogPos: 0,
		reportSessionId: reportId
	});

	try {
		const res = await fetch(`${APIS.ollama}/api/chat`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: DEFAULT_MODEL,
				messages: [
					{ role: 'system', content: 'You are Claw, a project review agent. Analyze the project context and output actionable tasks as JSON. Be concise.' },
					{ role: 'user', content: prompt }
				],
				stream: false
			})
		});

		if (!res.ok) throw new Error(`Ollama ${res.status}`);

		const data = await res.json() as { message?: { content?: string } };
		const content = data.message?.content ?? '';
		const durationMs = Date.now() - startTime;

		// Log to review session
		let session = await loadReviewSession();
		log(session, content, sender);
		log(session, `**Routed**: OpenClaw (local Ollama, $0) — ${(durationMs / 1000).toFixed(1)}s`, sender);

		// Parse tasks from the response
		await parseReviewText(content, sender);

		trimSession(session);
		session.status = 'idle';
		session.updatedAt = new Date().toISOString();
		await writeFile(`${PATHS.chatsDir}/${reportId}.json`, JSON.stringify(session, null, '\t'), 'utf-8');

		await upsertSessionMeta({
			id: reportId,
			title: 'Claw Project Review',
			model: DEFAULT_MODEL,
			provider: 'openclaw',
			messageCount: session.messages.length,
			createdAt: session.createdAt,
			updatedAt: session.updatedAt,
			source: 'claw',
			status: 'idle'
		});

		log(monitorSession, `[review] OpenClaw review complete — ${(durationMs / 1000).toFixed(1)}s ($0)`);
		await saveMonitorSession(monitorSession);

		await pushNotification({
			severity: 'info',
			category: 'agent',
			title: 'Claw project review finished (local)',
			message: `Completed in ${(durationMs / 1000).toFixed(1)}s — $0`,
			source: 'claw',
			link: `/chat?session=${reportId}`,
			linkLabel: 'View Review',
			desktop: true
		});

	} finally {
		agents.delete('review');
	}
}

function spawnClaudeReview(
	prompt: string,
	sender: ChatSender,
	reportId: string,
	monitorSession: ChatSession
): void {
	const agents = getActiveAgents();
	const logFile = resolve(PATHS.headlessLogsDir, `agent-review-${Date.now()}.log`);

	try {
		const baseline = captureGitBaseline();
		const child = spawnClaude(prompt, logFile, { model: 'claude-opus-4-6' });

		const pid = child.pid ?? 0;
		agents.set('review', {
			taskId: 'review',
			pid,
			startedAt: new Date().toISOString(),
			sender,
			logFile,
			lastLogPos: 0,
			reportSessionId: reportId,
			gitBaseline: baseline
		});

		child.on('close', async (code) => {
			agents.delete('review');

			const exitMsg = code === 0 ? 'review complete' : `review exited with code ${code}`;

			if (code === 0) {
				await parseReviewOutput(logFile, sender).catch(() => {});
			}

			await logAgentCompletion(
				{ id: 'review', title: 'Project Review' } as Task,
				sender, exitMsg, logFile, reportId, baseline
			).catch(() => {});
			logAgentCompletion(
				{ id: 'review', title: 'Project Review' } as Task,
				sender, exitMsg, logFile, MONITOR_SESSION_ID, baseline, { skipUsageRecord: true }
			).catch(() => {});

			pushNotification({
				severity: code === 0 ? 'info' : 'warning',
				category: 'agent',
				title: 'Claw project review finished',
				message: exitMsg,
				source: 'claw',
				link: `/chat?session=${reportId}`,
				linkLabel: 'View Review',
				desktop: true
			}).catch(() => {});
		});

		log(monitorSession, `[review] Claude Code review agent started → chat: ${reportId}`);
	} catch (err) {
		const msg = err instanceof Error ? err.message : 'spawn failed';
		log(monitorSession, `[error] Failed to spawn review agent: ${msg}`);
	}
}

async function ensureReviewSession(sender: ChatSender): Promise<void> {
	const sessionPath = `${PATHS.chatsDir}/${REVIEW_SESSION_ID}.json`;
	const now = new Date().toISOString();

	const session: ChatSession = {
		id: REVIEW_SESSION_ID,
		model: 'system',
		provider: 'internal',
		createdAt: now,
		updatedAt: now,
		messages: [{
			role: 'system',
			content: 'Claw project review — audits the project and creates tasks for missing features, bugs, and improvements.'
		}],
		source: 'claw',
		status: 'streaming'
	};

	await writeFile(sessionPath, JSON.stringify(session, null, '\t'), 'utf-8');

	await upsertSessionMeta({
		id: REVIEW_SESSION_ID,
		title: 'Claw Project Review',
		model: 'system',
		provider: 'internal',
		messageCount: 1,
		createdAt: now,
		updatedAt: now,
		source: 'claw',
		status: 'streaming'
	});
}

async function buildReviewPrompt(): Promise<string> {
	const context = await collectReviewContext();

	return [
		`You are Claw, a thorough project review agent for the ai-playground dashboard.`,
		``,
		`## Your Job`,
		`Analyze the project context below and produce a comprehensive task list grouped by feature.`,
		`Be thorough — find everything that needs doing. You should produce 5-25 tasks per review.`,
		`Only return an empty list if EVERY project is fully functional, tested, documented, and at a clean release point with no clear next steps.`,
		``,
		`## What to Look For (in priority order)`,
		`1. **Broken** — 500 errors, crashes, non-functional pages, build failures`,
		`2. **Data wiring** — pages showing hardcoded/mock/placeholder data instead of real data`,
		`3. **Missing core features** — referenced but not implemented, half-wired functionality`,
		`4. **Integration gaps** — disconnected services, APIs that return stubs`,
		`5. **UX gaps** — missing feedback (loading states, error states, empty states)`,
		`6. **Quality** — incomplete implementations, type errors, accessibility issues`,
		`7. **Polish** — styling inconsistencies, missing transitions, responsive issues`,
		`8. **Documentation** — missing API docs, setup guides, deployment instructions`,
		`9. **Testing** — untested critical paths, missing integration tests`,
		`10. **DevOps** — CI/CD gaps, missing GitHub Actions, release automation needed`,
		``,
		`## Feature Grouping`,
		`Group related tasks under a feature name. Features represent shippable units of work.`,
		`Example features: "chat-polish", "real-data-wiring", "agent-dashboard", "release-automation"`,
		`When all tasks in a feature are done, that feature is ready to merge/release.`,
		``,
		context,
		``,
		`## Output Format`,
		`Output a JSON block with tasks. This is CRITICAL — your output MUST be valid JSON:`,
		``,
		'```json',
		`[`,
		`  {`,
		`    "title": "Short actionable title (start with a verb)",`,
		`    "description": "What needs to be done, why, and any specific files/routes involved",`,
		`    "priority": "critical|high|medium|low",`,
		`    "tags": ["relevant", "tags"],`,
		`    "feature": "feature-name",`,
		`    "flagDiscussion": false`,
		`  }`,
		`]`,
		'```',
		``,
		`## Rules`,
		`- Do NOT duplicate existing tasks listed above`,
		`- Group tasks by feature — every task MUST have a "feature" field`,
		`- Set flagDiscussion: true only for tasks needing user input on direction`,
		`- Priority: critical = broken/500s, high = missing core, medium = improvement, low = polish/docs`,
		`- Keep titles concise and actionable (start with a verb)`,
		`- 5-25 tasks per review — be thorough, not conservative`,
		`- Only return [] if ALL pages work, ALL data is real, ALL features are complete, and there's genuinely nothing left to build`,
	].join('\n');
}

/** Parse tasks from plain text response (OpenClaw path). */
async function parseReviewText(content: string, sender: ChatSender): Promise<void> {
	if (!content) return;

	const jsonMatch = content.match(/```json\s*\n(\[[\s\S]*?\])\s*\n```/);
	if (jsonMatch) {
		await createTasksFromReview(jsonMatch[1], sender);
		return;
	}

	const rawMatch = content.match(/\[\s*\{[\s\S]*?\}\s*\]/g);
	if (rawMatch) {
		await createTasksFromReview(rawMatch[rawMatch.length - 1], sender);
	}
}

async function collectReviewContext(): Promise<string> {
	const parts: string[] = ['## Project Context (pre-collected)'];

	// 1. Existing tasks (grouped by feature)
	try {
		await migrateIfNeeded(PATHS.root);
		const tasks = await getAllTasks(PATHS.root);
		const pending = tasks.filter(t => t.status === 'pending');
		const inProgress = tasks.filter(t => t.status === 'in_progress');
		const completed = tasks.filter(t => t.status === 'completed');

		parts.push(``, `### Task Backlog (${tasks.length} total: ${pending.length} pending, ${inProgress.length} in-progress, ${completed.length} completed)`);

		// Feature grouping summary
		const featureMap = new Map<string, { pending: number; inProgress: number; completed: number }>();
		for (const t of tasks) {
			const f = t.feature ?? 'ungrouped';
			const entry = featureMap.get(f) ?? { pending: 0, inProgress: 0, completed: 0 };
			if (t.status === 'pending') entry.pending++;
			else if (t.status === 'in_progress') entry.inProgress++;
			else if (t.status === 'completed') entry.completed++;
			featureMap.set(f, entry);
		}

		if (featureMap.size > 1 || (featureMap.size === 1 && !featureMap.has('ungrouped'))) {
			parts.push(``, `**Features:**`);
			for (const [feature, counts] of featureMap) {
				const total = counts.pending + counts.inProgress + counts.completed;
				const pct = total > 0 ? Math.round((counts.completed / total) * 100) : 0;
				const status = pct === 100 ? 'DONE' : `${pct}% done`;
				parts.push(`- **${feature}**: ${total} tasks (${status}) — ${counts.pending} pending, ${counts.inProgress} active, ${counts.completed} done`);
			}
		}

		if (pending.length > 0) {
			parts.push(``, `**Pending tasks** (do NOT duplicate these):`);
			for (const t of pending.slice(0, 30)) {
				const feat = t.feature ? ` [${t.feature}]` : '';
				parts.push(`- [${t.priority}] ${t.title}${feat}${t.assignee ? ` (assigned: ${t.assignee})` : ''}`);
			}
		}
		if (inProgress.length > 0) {
			parts.push(`**In-progress** (do NOT duplicate):`);
			for (const t of inProgress.slice(0, 10)) {
				parts.push(`- ${t.title}`);
			}
		}
		if (completed.length > 0) {
			parts.push(`**Recently completed** (${completed.length} total):`);
			const recent = completed.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()).slice(0, 15);
			for (const t of recent) {
				const feat = t.feature ? ` [${t.feature}]` : '';
				parts.push(`- ${t.title}${feat}`);
			}
		}
	} catch {
		parts.push(``, `### Tasks: could not read task index`);
	}

	// 2. Route listing
	try {
		const { readdirSync, statSync } = await import('fs');
		const routesDir = resolve(PATHS.root, 'dashboard/src/routes');
		const routes: string[] = [];

		function scanRoutes(dir: string, prefix: string) {
			try {
				for (const entry of readdirSync(dir)) {
					const full = resolve(dir, entry);
					const st = statSync(full);
					if (st.isDirectory() && !entry.startsWith('.') && !entry.startsWith('_')) {
						const route = `${prefix}/${entry}`;
						routes.push(route);
						scanRoutes(full, route);
					}
				}
			} catch { /* skip */ }
		}

		scanRoutes(routesDir, '');
		parts.push(``, `### Routes (${routes.length} pages)`);
		parts.push(routes.map(r => `- \`${r || '/'}\``).join('\n'));
	} catch {
		parts.push(``, `### Routes: could not scan`);
	}

	// 3. Server modules listing
	try {
		const { readdirSync } = await import('fs');
		const serverDir = resolve(PATHS.root, 'dashboard/src/lib/server');
		const files = readdirSync(serverDir).filter(f => f.endsWith('.ts'));
		parts.push(``, `### Server Modules (${files.length})`);
		parts.push(files.map(f => `- \`${f}\``).join('\n'));
	} catch { /* skip */ }

	// 4. Components listing
	try {
		const { readdirSync } = await import('fs');
		const compDir = resolve(PATHS.root, 'dashboard/src/lib/components');
		const files = readdirSync(compDir).filter(f => f.endsWith('.svelte'));
		parts.push(``, `### Components (${files.length})`);
		parts.push(files.map(f => `- \`${f}\``).join('\n'));
	} catch { /* skip */ }

	// 5. Recent agent usage
	try {
		const raw = await readFile(resolve(PATHS.root, '.playground/agent-usage.json'), 'utf-8');
		const usage = JSON.parse(raw) as Array<{ taskTitle: string; model: string; inputTokens: number; costUsd: number }>;
		const recent = usage.slice(-5);
		if (recent.length > 0) {
			const totalCost = usage.reduce((s, e) => s + (e.costUsd ?? 0), 0);
			parts.push(``, `### Recent Agent Activity (total cost: $${totalCost.toFixed(2)})`);
			for (const e of recent) {
				parts.push(`- "${e.taskTitle}" — ${e.model} — ${(e.inputTokens / 1000).toFixed(0)}K input — $${(e.costUsd ?? 0).toFixed(4)}`);
			}
		}
	} catch { /* skip */ }

	// 6. Build status
	try {
		const { execSync } = await import('child_process');
		const buildOutput = execSync('cd dashboard && npm run build 2>&1 | tail -5', {
			cwd: PATHS.root,
			timeout: 60_000,
			encoding: 'utf-8'
		});
		parts.push(``, `### Build Status`);
		parts.push('```', buildOutput.trim(), '```');
	} catch (err) {
		const msg = err instanceof Error ? (err as any).stdout ?? err.message : 'build failed';
		parts.push(``, `### Build Status: FAILED`);
		parts.push('```', String(msg).slice(-500), '```');
	}

	return parts.join('\n');
}

async function parseReviewOutput(logFile: string, sender: ChatSender): Promise<void> {
	try {
		const parsed = parseStreamJsonLog(logFile);
		const content = parsed.text;
		if (!content) return;

		const jsonMatch = content.match(/```json\s*\n(\[[\s\S]*?\])\s*\n```/);
		if (!jsonMatch) {
			const rawMatch = content.match(/\[\s*\{[\s\S]*?\}\s*\]/g);
			if (!rawMatch) return;
			await createTasksFromReview(rawMatch[rawMatch.length - 1], sender);
			return;
		}

		await createTasksFromReview(jsonMatch[1], sender);
	} catch { /* parse failed */ }
}

async function createTasksFromReview(jsonStr: string, sender: ChatSender): Promise<void> {
	let tasks: Array<{
		title: string;
		description?: string;
		priority?: 'critical' | 'high' | 'medium' | 'low';
		tags?: string[];
		feature?: string;
		flagDiscussion?: boolean;
	}>;

	try {
		tasks = JSON.parse(jsonStr);
		if (!Array.isArray(tasks)) return;
	} catch { return; }

	const existing = await getAllTasks(PATHS.root);
	const existingTitles = new Set(existing.map(t => t.title.toLowerCase()));

	let created = 0;
	const features = new Map<string, number>();
	const reviewSession = await loadReviewSession();

	for (const t of tasks.slice(0, 25)) {
		if (!t.title || existingTitles.has(t.title.toLowerCase())) continue;

		try {
			const featureName = t.feature || null;

			// Auto-assign: discussion tasks stay unassigned (they'll create discussion sessions),
			// all other tasks get assigned to claw for immediate pickup
			const shouldAssign = !t.flagDiscussion;
			const task = await createTask(PATHS.root, {
				title: t.title,
				description: t.description,
				priority: t.priority ?? 'medium',
				tags: t.tags ?? [],
				feature: featureName,
				assignee: shouldAssign ? 'claw' : null,
				createdBy: 'claw'
			});

			if (t.flagDiscussion) {
				await updateTask(PATHS.root, task.id, { flagDiscussion: true }).catch(() => {});
			}

			// Classify the routing for the log
			const route = shouldAssign ? classifyTask(task) : 'discussion';
			const routeLabel = route === 'openclaw' ? ' → OpenClaw' : route === 'discussion' ? ' → discussion' : ' → Claude Code';
			const featureLabel = featureName ? ` [${featureName}]` : '';
			log(reviewSession, `[created] **${task.title}** [${task.priority}]${featureLabel}${routeLabel}${t.flagDiscussion ? ' (needs discussion)' : ''}`, sender);
			created++;

			if (featureName) {
				features.set(featureName, (features.get(featureName) ?? 0) + 1);
			}
		} catch { /* task creation failed */ }
	}

	if (created > 0) {
		const featureSummary = features.size > 0
			? ` across ${features.size} feature(s): ${[...features.entries()].map(([f, n]) => `${f} (${n})`).join(', ')}`
			: '';
		log(reviewSession, `[summary] Created ${created} new task(s)${featureSummary}`, sender);
		await pushNotification({
			severity: 'info',
			category: 'agent',
			title: `Claw created ${created} task(s) from review`,
			message: features.size > 0 ? `${features.size} features: ${[...features.keys()].join(', ')}` : 'New tasks added to backlog',
			source: 'claw',
			link: `/tasks`,
			linkLabel: 'View Tasks',
			desktop: true
		});
	}

	trimSession(reviewSession);
	reviewSession.updatedAt = new Date().toISOString();
	reviewSession.status = 'idle';
	await writeFile(
		`${PATHS.chatsDir}/${REVIEW_SESSION_ID}.json`,
		JSON.stringify(reviewSession, null, '\t'),
		'utf-8'
	);
}

async function loadReviewSession(): Promise<ChatSession> {
	try {
		const raw = await readFile(`${PATHS.chatsDir}/${REVIEW_SESSION_ID}.json`, 'utf-8');
		return JSON.parse(raw);
	} catch {
		const now = new Date().toISOString();
		return {
			id: REVIEW_SESSION_ID,
			model: 'system',
			provider: 'internal',
			createdAt: now,
			updatedAt: now,
			messages: [],
			source: 'claw',
			status: 'idle'
		};
	}
}
