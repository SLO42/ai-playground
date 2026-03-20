/**
 * PM API — Project Manager plan, memory, and actions.
 *
 * GET  — Load plan + memory stats + recent entries
 * POST — Actions: bootstrap, add-memory, update-memory, delete-memory,
 *         update-plan, create-sprint, complete-sprint, sync-github,
 *         start-discussion, review
 */
import { json } from '@sveltejs/kit';
import { resolve } from 'path';
import { scanAllProjects, detectProjectMeta } from '$lib/server/project-scanner.js';
import { PATHS } from '$lib/server/constants.js';
import {
	loadPlan, savePlan, bootstrapProjectManager, syncToGitHubBoard,
	buildPMDiscussionPrompt, gatherBootstrapContext, reviewProjectPlan
} from '$lib/server/project-manager.js';
import * as pmDb from '$lib/server/pm-memory-db.js';
import { writeFile, mkdir } from 'fs/promises';
import type { PMMemoryQuery } from '$lib/types/project-plan.js';
import type { ChatSession } from '$lib/types/chat.js';

async function resolveProjectPath(id: string): Promise<string | null> {
	const projects = await scanAllProjects(PATHS.playgroundRegistry, PATHS.root);
	const project = projects.find(p => p.id === id);
	return project?.path ?? null;
}

export async function GET({ params, url }) {
	const projectPath = await resolveProjectPath(params.id);
	if (!projectPath) return json({ error: 'Project not found' }, { status: 404 });

	const plan = await loadPlan(projectPath);
	let stats = null;
	try { stats = pmDb.getStats(projectPath); } catch { /* not init */ }

	const query: PMMemoryQuery = {
		type: (url.searchParams.get('type') as PMMemoryQuery['type']) || undefined,
		source: url.searchParams.get('source') || undefined,
		minConfidence: url.searchParams.has('minConfidence') ? parseFloat(url.searchParams.get('minConfidence')!) : undefined,
		search: url.searchParams.get('search') || undefined,
		archived: url.searchParams.has('archived') ? url.searchParams.get('archived') === 'true' : false,
		limit: url.searchParams.has('limit') ? parseInt(url.searchParams.get('limit')!, 10) : 50,
		offset: url.searchParams.has('offset') ? parseInt(url.searchParams.get('offset')!, 10) : 0,
		orderBy: (url.searchParams.get('orderBy') as PMMemoryQuery['orderBy']) || 'recent'
	};

	let entries: ReturnType<typeof pmDb.queryEntries> = [];
	try { entries = pmDb.queryEntries(projectPath, query); } catch { /* not init */ }

	return json({ plan, stats, entries });
}

export async function POST({ params, request }) {
	const projectPath = await resolveProjectPath(params.id);
	if (!projectPath) return json({ error: 'Project not found' }, { status: 404 });

	const body = await request.json();
	const action = body.action as string;

	switch (action) {
		case 'bootstrap': {
			const result = await bootstrapProjectManager(projectPath);
			let stats = null;
			try { stats = pmDb.getStats(projectPath); } catch { /* */ }
			return json({ plan: result.plan, context: result.context, stats });
		}

		case 'add-memory': {
			if (!body.type || !body.content || !body.source) {
				return json({ error: 'type, content, and source are required' }, { status: 400 });
			}
			const entry = pmDb.addEntry(projectPath, {
				type: body.type, content: body.content, source: body.source,
				confidence: body.confidence ?? 0.5, relatedTo: body.relatedTo
			});
			return json({ entry });
		}

		case 'update-memory': {
			if (!body.id) return json({ error: 'id is required' }, { status: 400 });
			const ok = pmDb.updateEntry(projectPath, body.id, {
				content: body.content, confidence: body.confidence,
				archived: body.archived, relatedTo: body.relatedTo
			});
			return json({ ok });
		}

		case 'delete-memory': {
			if (!body.id) return json({ error: 'id is required' }, { status: 400 });
			return json({ ok: pmDb.deleteEntry(projectPath, body.id) });
		}

		case 'update-plan': {
			const plan = await loadPlan(projectPath);
			if (!plan) return json({ error: 'No plan — bootstrap first' }, { status: 400 });

			if (body.macro !== undefined) plan.macro = { ...plan.macro, ...body.macro };
			if (body.sprints !== undefined) plan.sprints = body.sprints;
			if (body.activeSprint !== undefined) plan.activeSprint = body.activeSprint;
			if (body.decisions !== undefined) plan.decisions = body.decisions;
			plan.lastUpdated = new Date().toISOString();
			plan.updatedBy = body.updatedBy ?? 'user';

			await savePlan(projectPath, plan);
			return json({ plan });
		}

		case 'create-sprint': {
			const plan = await loadPlan(projectPath);
			if (!plan) return json({ error: 'No plan — bootstrap first' }, { status: 400 });
			if (!body.name || !body.phaseId || !body.goal) {
				return json({ error: 'name, phaseId, and goal are required' }, { status: 400 });
			}

			const phase = plan.macro.phases.find(p => p.id === body.phaseId);
			if (!phase) return json({ error: `Phase ${body.phaseId} not found` }, { status: 404 });

			const sprint = {
				id: `sprint-${Date.now()}`,
				name: body.name,
				status: (body.activate ? 'active' : 'planned') as 'active' | 'planned',
				phaseId: body.phaseId,
				goal: body.goal,
				tasks: body.tasks ?? [],
				startDate: body.activate ? new Date().toISOString() : body.startDate,
				endDate: body.endDate
			};

			plan.sprints.push(sprint);
			phase.sprints.push(sprint.id);
			if (body.activate) plan.activeSprint = sprint.id;
			plan.lastUpdated = new Date().toISOString();
			plan.updatedBy = body.updatedBy ?? 'user';

			await savePlan(projectPath, plan);
			pmDb.addEntry(projectPath, {
				type: 'observation',
				content: `Sprint "${sprint.name}" created under phase "${phase.name}" — goal: ${sprint.goal}`,
				source: 'user', confidence: 1.0, relatedTo: sprint.id
			});

			return json({ sprint, plan });
		}

		case 'complete-sprint': {
			const plan = await loadPlan(projectPath);
			if (!plan) return json({ error: 'No plan' }, { status: 400 });
			if (!body.sprintId) return json({ error: 'sprintId required' }, { status: 400 });

			const sprint = plan.sprints.find(s => s.id === body.sprintId);
			if (!sprint) return json({ error: 'Sprint not found' }, { status: 404 });

			sprint.status = 'completed';
			sprint.completedAt = new Date().toISOString();
			if (body.retrospective) sprint.retrospective = body.retrospective;
			if (plan.activeSprint === sprint.id) plan.activeSprint = null;
			plan.lastUpdated = new Date().toISOString();
			plan.updatedBy = body.updatedBy ?? 'user';

			await savePlan(projectPath, plan);
			pmDb.addEntry(projectPath, {
				type: 'learning',
				content: `Sprint "${sprint.name}" completed.${body.retrospective ? ` Retro: ${body.retrospective}` : ''}`,
				source: 'sprint-completion', confidence: 1.0, relatedTo: sprint.id
			});

			return json({ sprint, plan });
		}

		case 'sync-github': {
			const plan = await loadPlan(projectPath);
			if (!plan) return json({ error: 'No plan' }, { status: 400 });
			return json(await syncToGitHubBoard(projectPath, plan, body.gitRemote));
		}

		case 'start-discussion': {
			const plan = await loadPlan(projectPath);
			if (!plan) return json({ error: 'No plan — bootstrap first' }, { status: 400 });

			const meta = await detectProjectMeta(projectPath);
			const ctx = await gatherBootstrapContext(projectPath, meta);
			const prompt = buildPMDiscussionPrompt(ctx, plan);

			const sessionId = `pm-${params.id}`;
			const now = new Date().toISOString();
			const session: ChatSession = {
				id: sessionId, model: 'claude-opus-4-6', provider: 'internal',
				createdAt: now, updatedAt: now,
				messages: [
					{ role: 'system', content: `Project Manager discussion for ${ctx.projectName}` },
					{ role: 'assistant', content: prompt, sender: { id: 'pm', label: 'Project Manager', color: '#10b981' } }
				],
				source: 'claw', status: 'waiting'
			};

			await mkdir(resolve(PATHS.root, '.playground/chats'), { recursive: true });
			await writeFile(resolve(PATHS.root, `.playground/chats/${sessionId}.json`), JSON.stringify(session, null, '\t'), 'utf-8');

			const { upsertSessionMeta } = await import('$lib/server/heartbeat/shared.js');
			await upsertSessionMeta({
				id: sessionId, title: `PM: ${ctx.projectName}`, model: session.model, provider: session.provider,
				messageCount: session.messages.length, createdAt: now, updatedAt: now, source: 'claw', status: 'waiting'
			});

			pmDb.addEntry(projectPath, {
				type: 'observation', content: 'Discussion session opened for roadmap planning',
				source: 'user-initiated', confidence: 1.0
			});

			return json({ sessionId });
		}

		case 'review':
			return json(await reviewProjectPlan(projectPath));

		default:
			return json({ error: `Unknown action: ${action}` }, { status: 400 });
	}
}
