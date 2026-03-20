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
import { readFile, writeFile, mkdir } from 'fs/promises';
import type { PMMemoryQuery } from '$lib/types/project-plan.js';
import type { ChatSession } from '$lib/types/chat.js';

/** Extract structured plan updates from freeform user text. */
function parseUserInput(text: string, plan: import('$lib/types/project-plan.js').ProjectPlan) {
	const lower = text.toLowerCase();
	const result = {
		purpose: '',
		longTermVision: '',
		role: null as import('$lib/types/project-plan.js').ProjectRole | null,
		keyHighlights: [] as string[],
		definitionOfDone: [] as string[],
		featureComplete: [] as string[]
	};

	// Extract purpose — look for "purpose:" or first substantial sentence about what the project is
	const purposeMatch = text.match(/purpose[:\s]*(?:is\s+)?(.+?)(?:\.\s+(?:my role|we will|key feature|feature complete|first release|long.?term|for future))/is);
	if (purposeMatch) {
		result.purpose = purposeMatch[1].trim().replace(/\s+/g, ' ');
	}

	// Extract role
	const roleMatch = text.match(/my role\s+(?:is\s+)?(.+?)(?:\.\s+(?:we |this |key |feature|first|for future))/is);
	if (roleMatch) {
		const roleText = roleMatch[1].trim();
		result.role = {
			title: roleText.includes('sole') ? 'Sole Developer & Owner' : 'Project Lead',
			responsibilities: [roleText.replace(/\s+/g, ' ')]
		};
	}

	// Extract key features
	const featureMatch = text.match(/key feature[s]?\s+(?:would be|are|include)\s+(.+?)(?:\.\s+(?:feature complete|first release|long.?term|for future|done))/is);
	if (featureMatch) {
		result.keyHighlights = featureMatch[1]
			.split(/[,.]/)
			.map(s => s.trim())
			.filter(s => s.length > 5);
	}

	// Extract feature complete definition
	const fcMatch = text.match(/feature complete\s+(?:means|is when|=)\s+(.+?)(?:\.\s+(?:first release|long.?term|for future|apis|it doesn))/is);
	if (fcMatch) {
		result.featureComplete = fcMatch[1]
			.split(/[,.]/)
			.map(s => s.trim())
			.filter(s => s.length > 5);
	}

	// Extract definition of done / feature complete criteria
	const dodPatterns = [
		/(?:the code is|it doesn.t|page still|any data|doesn.t put|apis are|features are)[^.]+/gi
	];
	for (const p of dodPatterns) {
		const matches = text.match(p);
		if (matches) {
			result.definitionOfDone.push(...matches.map(m => m.trim()));
		}
	}

	// Extract long-term vision
	const ltMatch = text.match(/(?:for future releases|long.?term|this project is ongoing|will one day|will see improvements)(.+?)(?:\.|$)/is);
	if (ltMatch) {
		result.longTermVision = ltMatch[0].trim().replace(/\s+/g, ' ');
	}

	// If we couldn't parse structure, store the whole thing as purpose if it's substantial
	if (!result.purpose && text.length > 50) {
		// Take the first 2 sentences as purpose
		const sentences = text.split(/[.!?]\s+/).filter(s => s.length > 10);
		if (sentences.length > 0) {
			result.purpose = sentences.slice(0, 2).join('. ').trim();
		}
	}

	return result;
}

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

		case 'process-reply': {
			// Directly process a PM discussion reply — doesn't wait for heartbeat.
			// Reads user input, updates the plan and memory based on what they said.
			const plan = await loadPlan(projectPath);
			if (!plan) return json({ error: 'No plan — bootstrap first' }, { status: 400 });
			if (!body.content) return json({ error: 'content is required' }, { status: 400 });

			const userInput = body.content as string;

			// Store the user's input as PM memory
			pmDb.addEntry(projectPath, {
				type: 'decision-context',
				content: `User provided project direction: ${userInput.slice(0, 500)}`,
				source: 'user-discussion',
				confidence: 1.0
			});

			// Parse structured updates from the user's input and apply to plan
			const updates = parseUserInput(userInput, plan);
			if (updates.purpose) plan.macro.purpose = updates.purpose;
			if (updates.longTermVision) plan.macro.longTermVision = updates.longTermVision;
			if (updates.role) plan.macro.role = updates.role;
			if (updates.keyHighlights.length > 0) plan.macro.keyHighlights = updates.keyHighlights;
			if (updates.definitionOfDone.length > 0) plan.macro.definitionOfDone = updates.definitionOfDone;
			if (updates.featureComplete.length > 0 && plan.macro.releases[0]) {
				plan.macro.releases[0].featureComplete = updates.featureComplete;
			}
			plan.lastUpdated = new Date().toISOString();
			plan.updatedBy = 'user-discussion';

			await savePlan(projectPath, plan);
			return json({ plan, applied: updates });
		}

		case 'chat': {
			// Spawn Claude Code CLI with PM context — uses existing CLI auth, no API key
			const plan = await loadPlan(projectPath);
			if (!plan) return json({ error: 'No plan — bootstrap first' }, { status: 400 });
			if (!body.message) return json({ error: 'message is required' }, { status: 400 });

			const { spawnClaude } = await import('$lib/server/heartbeat/agent-spawn.js');

			const m = plan.macro;
			const sysCtx = [
				'You are the Project Manager for this project. Refine the plan through conversation.',
				'Suggest concrete updates — exact wording for purpose, vision, releases, phases, features, DoD.',
				'',
				'## Current Plan',
				`Purpose: ${m.purpose}`,
				`Vision: ${m.longTermVision}`,
				`Role: ${m.role.title} — ${m.role.responsibilities.join(', ')}`,
				`Highlights: ${m.keyHighlights.join(', ') || 'none'}`,
				`Releases: ${m.releases.map(r => `${r.version} "${r.name}" (${r.status})`).join(', ') || 'none'}`,
				`Phases: ${m.phases.map(p => `${p.name} (${p.status})`).join(', ') || 'none'}`,
				`DoD: ${m.definitionOfDone.join('; ') || 'none'}`,
				`Features: ${m.featureMap.map(f => f.name).join(', ') || 'none'}`,
			].join('\n');

			const history = (body.history ?? []) as { role: string; content: string }[];
			const prompt = [
				sysCtx,
				'',
				'## Conversation',
				...history.map((h: { role: string; content: string }) =>
					`${h.role === 'user' ? 'User' : 'PM'}: ${h.content}`
				),
				`User: ${body.message}`,
				'',
				'Respond as the PM. Be concise and actionable.'
			].join('\n');

			const logFile = resolve(PATHS.headlessLogsDir, `pm-chat-${Date.now()}.log`);

			try {
				const child = await spawnClaude(prompt, logFile, { model: 'claude-sonnet-4-6' });

				pmDb.addEntry(projectPath, {
					type: 'decision-context',
					content: `User: ${(body.message as string).slice(0, 300)}`,
					source: 'pm-chat', confidence: 1.0
				});

				// Stream the log file as SSE — tail it while Claude runs
				const encoder = new TextEncoder();
				let closed = false;

				const stream = new ReadableStream({
					async start(controller) {
						function send(data: string) {
							if (closed) return;
							try { controller.enqueue(encoder.encode(`data: ${data}\n\n`)); }
							catch { closed = true; }
						}

						let lastPos = 0;
						async function readNewContent() {
							try {
								const content = await readFile(logFile, 'utf-8');
								if (content.length <= lastPos) return;
								const newLines = content.slice(lastPos);
								lastPos = content.length;

								for (const line of newLines.split('\n')) {
									if (!line.trim()) continue;
									try {
										const evt = JSON.parse(line);
										if (evt.type === 'assistant' && evt.message?.content) {
											for (const block of evt.message.content) {
												if (block.type === 'text' && block.text) {
													send(JSON.stringify({ type: 'content', content: block.text }));
												}
											}
										}
									} catch { /* partial line or not json */ }
								}
							} catch { /* file not ready */ }
						}

						const poll = setInterval(() => { if (!closed) readNewContent(); }, 400);

						child.on('close', async () => {
							await new Promise(r => setTimeout(r, 500));
							await readNewContent(); // final flush
							clearInterval(poll);
							send(JSON.stringify({ type: 'done' }));
							if (!closed) { try { controller.close(); } catch {} }
							closed = true;
						});
					}
				});

				return new Response(stream, {
					headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' }
				});
			} catch (err) {
				return json({ error: `Spawn failed: ${err instanceof Error ? err.message : 'unknown'}` }, { status: 500 });
			}
		}

		default:
			return json({ error: `Unknown action: ${action}` }, { status: 400 });
	}
}
