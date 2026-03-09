import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { readFile, writeFile, readdir, mkdir, access } from 'fs/promises';
import { resolve, join, dirname } from 'path';
import { PATHS } from '$lib/server/constants.js';
import { scanAllProjects, detectProjectMeta } from '$lib/server/project-scanner.js';
import type { AgentInfo, AgentStatus } from '$lib/types/agents.js';
import type { DetectedProjectMeta } from '$lib/types/projects.js';
import { populateForProject, getProjectPoolStats, resetProjectPool } from '$lib/server/heartbeat/session-pool.js';
import {
	getActiveAgents, getMaxConcurrentAgents, loadProjectMaxAgents,
	agentSender, ensureChatsDir, upsertSessionMeta, log as sessionLog,
	saveMonitorSession, loadMonitorSession, CLAW_SENDER
} from '$lib/server/heartbeat/shared.js';
import { spawnClaude } from '$lib/server/heartbeat/agent-spawn.js';

interface ProjectAgentAssociation {
	agents: string[]; // agent filenames relative to agentsDir
}

function associationPath(projectPath: string): string {
	return resolve(projectPath, '.playground', 'agents.json');
}

async function readAssociation(projectPath: string): Promise<ProjectAgentAssociation> {
	try {
		const raw = await readFile(associationPath(projectPath), 'utf-8');
		return JSON.parse(raw);
	} catch {
		return { agents: [] };
	}
}

async function writeAssociation(projectPath: string, data: ProjectAgentAssociation): Promise<void> {
	const dir = resolve(projectPath, '.playground');
	await mkdir(dir, { recursive: true });
	await writeFile(associationPath(projectPath), JSON.stringify(data, null, '\t'), 'utf-8');
}

async function resolveProject(projectId: string) {
	const projects = await scanAllProjects(PATHS.playgroundRegistry, PATHS.root);
	return projects.find((p) => p.id === projectId);
}

interface AgentInfoExt extends AgentInfo {
	/** Lowercase text blob for language/framework matching (frontmatter + first 500 chars of body) */
	searchText: string;
}

async function scanAvailableAgents(): Promise<AgentInfoExt[]> {
	const agents: AgentInfoExt[] = [];

	async function scan(dir: string, prefix: string) {
		try {
			const entries = await readdir(dir, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.isDirectory()) {
					await scan(join(dir, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name);
				} else if (entry.name.endsWith('.md')) {
					try {
						const content = await readFile(join(dir, entry.name), 'utf-8');
						const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
						if (fmMatch) {
							const fm = fmMatch[1];
							const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '') ?? entry.name.replace('.md', '');
							const type = fm.match(/^type:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '') ?? 'general';
							const desc = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '';
							const filename = prefix ? `${prefix}/${entry.name}` : entry.name;
							// Build search text from frontmatter + first 500 chars of body
							const body = content.slice(fmMatch[0].length, fmMatch[0].length + 500);
							const searchText = `${fm} ${body} ${name} ${desc} ${filename}`.toLowerCase();
							agents.push({ name, type, description: desc, filename, searchText });
						}
					} catch { /* skip */ }
				}
			}
		} catch { /* dir missing */ }
	}

	await scan(PATHS.agentsDir, '');
	return agents;
}

/** GET /api/projects/[id]/agents — list agents associated with this project */
export const GET: RequestHandler = async ({ params, url }) => {
	const project = await resolveProject(params.id);
	if (!project) {
		return json({ error: 'Project not found' }, { status: 404 });
	}

	const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
	const pageSize = Math.min(50, Math.max(1, parseInt(url.searchParams.get('pageSize') ?? '10', 10) || 10));

	const [association, allAgents, projectMaxAgents] = await Promise.all([
		readAssociation(project.path),
		scanAvailableAgents(),
		loadProjectMaxAgents(project.path, params.id)
	]);

	const associatedSet = new Set(association.agents);
	const associated = allAgents.filter((a) => associatedSet.has(a.filename));
	const available = allAgents.filter((a) => !associatedSet.has(a.filename));

	const typeCounts: Record<string, number> = {};
	for (const a of associated) {
		typeCounts[a.type] = (typeCounts[a.type] || 0) + 1;
	}

	const totalAssociated = associated.length;
	const totalPages = Math.max(1, Math.ceil(totalAssociated / pageSize));
	const safePage = Math.min(page, totalPages);
	const startIndex = (safePage - 1) * pageSize;
	const paginatedAgents = associated.slice(startIndex, startIndex + pageSize);

	return json({
		agents: paginatedAgents,
		availableAgents: available,
		summary: {
			associated: totalAssociated,
			available: available.length,
			total: allAgents.length,
			types: Object.keys(typeCounts).length
		},
		capacity: { current: totalAssociated, max: projectMaxAgents },
		pagination: {
			page: safePage,
			pageSize,
			totalItems: totalAssociated,
			totalPages
		}
	});
};

/** POST /api/projects/[id]/agents — add agent(s) to project */
export const POST: RequestHandler = async ({ params, request }) => {
	const project = await resolveProject(params.id);
	if (!project) {
		return json({ error: 'Project not found' }, { status: 404 });
	}

	const body = await request.json() as { agents: string[] };
	if (!body.agents || !Array.isArray(body.agents) || body.agents.length === 0) {
		return json({ error: 'agents array required' }, { status: 400 });
	}

	const association = await readAssociation(project.path);
	const added: string[] = [];
	for (const filename of body.agents) {
		if (typeof filename === 'string' && !association.agents.includes(filename)) {
			association.agents.push(filename);
			added.push(filename);
		}
	}

	await writeAssociation(project.path, association);
	return json({ ok: true, added, total: association.agents.length });
};

/** DELETE /api/projects/[id]/agents — remove agent(s) from project */
export const DELETE: RequestHandler = async ({ params, request }) => {
	const project = await resolveProject(params.id);
	if (!project) {
		return json({ error: 'Project not found' }, { status: 404 });
	}

	const body = await request.json() as { agents: string[] };
	if (!body.agents || !Array.isArray(body.agents) || body.agents.length === 0) {
		return json({ error: 'agents array required' }, { status: 400 });
	}

	const association = await readAssociation(project.path);
	const toRemove = new Set(body.agents);
	association.agents = association.agents.filter((a) => !toRemove.has(a));

	await writeAssociation(project.path, association);
	return json({ ok: true, removed: body.agents, total: association.agents.length });
};

/** PUT /api/projects/[id]/agents — manage project session pool */
export const PUT: RequestHandler = async ({ params, request }) => {
	const project = await resolveProject(params.id);
	if (!project) {
		return json({ error: 'Project not found' }, { status: 404 });
	}

	const body = await request.json() as { action: string };

	switch (body.action) {
		case 'spawn-pool': {
			const association = await readAssociation(project.path);
			if (association.agents.length === 0) {
				return json({ error: 'No agents associated with this project. Add agents first.' }, { status: 400 });
			}

			const projMax = await loadProjectMaxAgents(project.path, params.id);
			const activeAgents = getActiveAgents();
			if (activeAgents.size >= getMaxConcurrentAgents()) {
				return json({
					error: `Global pool is at capacity (${activeAgents.size}/${getMaxConcurrentAgents()} agents running). Stop some agents before spawning more.`
				}, { status: 400 });
			}

			const allAgents = await scanAvailableAgents();
			const associatedSet = new Set(association.agents);
			const projectAgents = allAgents
				.filter(a => associatedSet.has(a.filename))
				.map(a => ({ filename: a.filename, name: a.name, type: a.type }))
				.slice(0, projMax); // Respect per-project limit

			try {
				const result = await populateForProject(params.id, projectAgents);
				const pool = await getProjectPoolStats(params.id);
				return json({ success: true, ...result, pool });
			} catch (e) {
				return json({ error: e instanceof Error ? e.message : 'Failed to spawn pool' }, { status: 500 });
			}
		}
		case 'reset-pool': {
			await resetProjectPool(params.id);
			const pool = await getProjectPoolStats(params.id);
			return json({ success: true, pool });
		}
		case 'pool-stats': {
			const pool = await getProjectPoolStats(params.id);
			return json(pool);
		}
		case 'suggest': {
			const [meta, allAgents, association, projMax] = await Promise.all([
				detectProjectMeta(project.path),
				scanAvailableAgents(),
				readAssociation(project.path),
				loadProjectMaxAgents(project.path, params.id)
			]);

			const alreadyAssociated = new Set(association.agents);
			const available = allAgents.filter(a => !alreadyAssociated.has(a.filename));
			const slotsLeft = projMax - association.agents.length;
			const { suggestions, missingTypes } = buildSuggestions(meta, available, slotsLeft);

			return json({
				suggestions,
				missingTypes,
				projectProfile: {
					language: meta.language,
					framework: meta.framework,
					hasTests: !!meta.testCommand,
					hasCi: meta.workflows.length > 0,
					hasDocs: meta.maintenance.hasDocsDir || meta.maintenance.hasReadme,
					hasSecurityConfig: meta.dependencies.some(d => d.name.includes('helmet') || d.name.includes('cors') || d.name.includes('auth')),
					dependencyCount: meta.dependencies.length,
					serviceCount: meta.services.length,
					branchCount: meta.maintenance.branchCount
				}
			});
		}
		case 'generate-agent': {
			const { type: agentType, name: agentName, description: agentDesc, language, framework } =
				body as { action: string; type: string; name: string; description: string; language?: string; framework?: string };

			if (!agentType || !agentName) {
				return json({ error: 'type and name required' }, { status: 400 });
			}

			const markdown = generateAgentMarkdown({
				name: agentName,
				type: agentType,
				description: agentDesc || `${agentName} agent`,
				language: language ?? 'general',
				framework: framework ?? ''
			});

			// Compute the target filename
			const slug = agentName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
			const subdir = agentType.toLowerCase().replace(/[^a-z0-9]+/g, '-');
			const filename = `${subdir}/${slug}.md`;

			return json({ markdown, filename, path: join(PATHS.agentsDir, filename) });
		}
		case 'create-agent': {
			const { filename: targetFile, markdown: mdContent } =
				body as { action: string; filename: string; markdown: string };

			if (!targetFile || !mdContent) {
				return json({ error: 'filename and markdown required' }, { status: 400 });
			}

			// Sanitize: prevent directory traversal
			const normalized = targetFile.replace(/\\/g, '/');
			if (normalized.includes('..') || normalized.startsWith('/')) {
				return json({ error: 'Invalid filename' }, { status: 400 });
			}

			const fullPath = join(PATHS.agentsDir, normalized);
			const dir = dirname(fullPath);
			await mkdir(dir, { recursive: true });

			// Don't overwrite existing files
			try {
				await access(fullPath);
				return json({ error: `Agent file already exists: ${normalized}` }, { status: 409 });
			} catch { /* doesn't exist — good */ }

			await writeFile(fullPath, mdContent, 'utf-8');

			// Auto-associate with this project
			const association = await readAssociation(project.path);
			if (!association.agents.includes(normalized)) {
				association.agents.push(normalized);
				await writeAssociation(project.path, association);
			}

			return json({ ok: true, filename: normalized, associated: true });
		}
		case 'design-agent': {
			const { type: dType, name: dName, description: dDesc, language: dLang, framework: dFw } =
				body as { action: string; type: string; name: string; description: string; language?: string; framework?: string };

			if (!dType || !dName) {
				return json({ error: 'type and name required' }, { status: 400 });
			}

			// Build a prompt for Claude Code with agent-creator skill context
			const slug = dName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
			const subdir = dType.toLowerCase().replace(/[^a-z0-9]+/g, '-');
			const targetFile = `${subdir}/${slug}.md`;
			const targetPath = join(PATHS.agentsDir, targetFile);

			const prompt = [
				`You are creating a new agent definition file for the OpenClaw agent pool.`,
				``,
				`## Project Context`,
				`- **Project path**: ${project.path}`,
				`- **Project ID**: ${params.id}`,
				`- **Project name**: ${project.name ?? params.id}`,
				``,
				`## Step 1: Scan the project`,
				`Before creating the agent, read the project to understand its needs:`,
				`- Read the project's main config file (package.json, *.csproj, Cargo.toml, go.mod, etc.) at \`${project.path}\``,
				`- Look at the directory structure to understand the codebase layout`,
				`- Check for existing tests, CI config, and documentation`,
				`- Note specific frameworks, libraries, and patterns used`,
				``,
				`## Step 2: Agent Specification`,
				`- **Type**: ${dType}`,
				`- **Name**: ${dName}`,
				`- **Description**: ${dDesc || `${dName} agent`}`,
				`- **Language**: ${dLang ?? 'general'}`,
				dFw ? `- **Framework**: ${dFw}` : '',
				`- **Target file**: ${targetPath}`,
				``,
				`## Step 3: Create the agent`,
				`1. Read the skill definition at \`.claude/skills/agent-creator/SKILL.md\` for the full agent format specification`,
				`2. Read an existing agent for reference: \`.claude/agents/core/coder.md\``,
				`3. Based on what you learned from scanning the project, generate a complete agent markdown file with:`,
				`   - YAML frontmatter (name, type, color, description, capabilities, priority, hooks)`,
				`   - Pre/post hooks with learning integration (memory search/store)`,
				`   - Language-specific instructions tailored to THIS project's actual stack`,
				`   - Build/test/lint commands matching the project's actual tooling`,
				`   - Quality checklist relevant to the project's patterns`,
				`4. Write the file to: ${targetPath}`,
				``,
				`The file will be automatically associated with the project after you create it — no extra steps needed.`,
				`Make the agent genuinely useful — it should reference the project's actual tools, patterns, and conventions, not generic boilerplate.`
			].filter(s => s !== '').join('\n');

			// Create a session to track the output
			await ensureChatsDir();
			const sessionId = `agent-design-${Date.now()}`;
			const sender = agentSender(sessionId, `Agent Designer: ${dName}`);
			const logFile = resolve(PATHS.headlessLogsDir, `${sessionId}.log`);
			await mkdir(PATHS.headlessLogsDir, { recursive: true });

			const session: import('$lib/types/chat.js').ChatSession = {
				id: sessionId,
				model: 'claude-sonnet-4-6',
				provider: 'claude-code',
				messages: [
					{ role: 'system', content: `Creating agent: ${dName} (${dType}) for ${dLang ?? 'general'} projects` },
					{ role: 'user', content: prompt }
				],
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				status: 'streaming',
				source: 'claw'
			};

			await writeFile(
				resolve(PATHS.chatsDir, `${sessionId}.json`),
				JSON.stringify(session, null, '\t'),
				'utf-8'
			);

			await upsertSessionMeta({
				id: sessionId,
				title: `Design Agent: ${dName}`,
				model: 'claude-sonnet-4-6',
				provider: 'claude-code',
				messageCount: 2,
				createdAt: session.createdAt,
				updatedAt: session.updatedAt,
				status: 'streaming',
				source: 'claw'
			});

			// Log to monitor
			const monitor = await loadMonitorSession();
			sessionLog(monitor, `Spawning agent designer for "${dName}" (${dType}, ${dLang ?? 'general'}) → session ${sessionId}`, CLAW_SENDER);
			await saveMonitorSession(monitor);

			// Spawn Claude Code
			const child = spawnClaude(prompt, logFile, { model: 'claude-sonnet-4-6' });

			// Track in active agents so it shows in the sessions/active endpoint
			const agents = getActiveAgents();
			agents.set(sessionId, {
				taskId: sessionId,
				pid: child.pid ?? 0,
				startedAt: new Date().toISOString(),
				sender,
				logFile,
				lastLogPos: 0,
				reportSessionId: sessionId
			});

			// Tail the log file every 5s and write updates to the session JSON
			let tailPos = 0;
			const tailTimer = setInterval(async () => {
				try {
					const content = await readFile(logFile, 'utf-8');
					const newContent = content.slice(tailPos);
					tailPos = content.length;
					if (!newContent.trim()) return;

					const textChunks: string[] = [];
					for (const line of newContent.split('\n').filter(l => l.trim())) {
						try {
							const msg = JSON.parse(line);
							if (msg.type === 'assistant' && msg.message?.content) {
								for (const block of msg.message.content) {
									if (block.type === 'text' && block.text) textChunks.push(block.text.trim());
								}
							}
						} catch {
							if (line.trim() && !line.startsWith('{')) textChunks.push(line.trim());
						}
					}
					if (textChunks.length === 0) return;

					const snippet = textChunks.join('\n').split('\n').filter(l => l.trim());
					if (snippet.length === 0) return;

					const s = JSON.parse(await readFile(resolve(PATHS.chatsDir, `${sessionId}.json`), 'utf-8'));
					const text = snippet.length <= 5
						? snippet.join('\n')
						: [snippet[0], `... ${snippet.length - 2} more lines ...`, snippet[snippet.length - 1]].join('\n');
					s.messages.push({ role: 'assistant', content: text, sender });
					s.updatedAt = new Date().toISOString();
					await writeFile(resolve(PATHS.chatsDir, `${sessionId}.json`), JSON.stringify(s, null, '\t'), 'utf-8');
				} catch { /* log not ready yet */ }
			}, 5_000);

			child.on('close', async (code) => {
				clearInterval(tailTimer);
				agents.delete(sessionId);

				// Auto-associate: scan for any new .md files Claude Code may have created
				// Don't rely on Claude Code running curl — do it server-side
				let associatedFiles: string[] = [];
				try {
					const allAgents = await scanAvailableAgents();
					const assoc = await readAssociation(project.path);
					const existingSet = new Set(assoc.agents);
					// Find agents that match the requested slug/type
					const slugLower = slug.toLowerCase();
					const typeLower = dType.toLowerCase();
					for (const agent of allAgents) {
						if (existingSet.has(agent.filename)) continue;
						const fLower = agent.filename.toLowerCase();
						// Match by slug name or by type directory containing the slug
						if (fLower.includes(slugLower) || (fLower.includes(typeLower) && fLower.includes(slugLower.split('-')[0]))) {
							assoc.agents.push(agent.filename);
							associatedFiles.push(agent.filename);
						}
					}
					if (associatedFiles.length > 0) {
						await writeAssociation(project.path, assoc);
					}
				} catch { /* best effort */ }

				try {
					const s = JSON.parse(await readFile(resolve(PATHS.chatsDir, `${sessionId}.json`), 'utf-8'));
					s.status = 'idle';
					s.updatedAt = new Date().toISOString();
					const assocMsg = associatedFiles.length > 0
						? ` Auto-associated: ${associatedFiles.map(f => `\`${f}\``).join(', ')}`
						: ' Note: could not auto-detect the created file — check the project agents page to add it manually.';
					s.messages.push({
						role: 'assistant',
						content: code === 0
							? `Agent "${dName}" created successfully.${assocMsg}`
							: `Agent creation finished with exit code ${code}. Check the log for details.${assocMsg}`
					});
					await writeFile(resolve(PATHS.chatsDir, `${sessionId}.json`), JSON.stringify(s, null, '\t'), 'utf-8');
					await upsertSessionMeta({
						id: sessionId,
						title: `Design Agent: ${dName}`,
						model: 'claude-sonnet-4-6',
						provider: 'claude-code',
						messageCount: s.messages.length,
						createdAt: s.createdAt,
						updatedAt: s.updatedAt,
						status: 'idle',
						source: 'claw'
					});
				} catch { /* best effort */ }
			});

			return json({ sessionId, status: 'spawned' }, { status: 201 });
		}
		default:
			return json({ error: `Unknown action: ${body.action}` }, { status: 400 });
	}
};

// ── Agent Suggestion Engine ────────────────────────────────────────

interface AgentSuggestion {
	filename: string;
	name: string;
	type: string;
	description: string;
	reason: string;
	priority: number; // lower = more important
}

interface MissingType {
	type: string;
	reason: string;
	suggestedName: string;
	suggestedDescription: string;
}

interface SuggestionResult {
	suggestions: AgentSuggestion[];
	missingTypes: MissingType[];
}

/**
 * Build language-relevance keywords from project metadata.
 * These are used to score agents: agents that mention the project's
 * language/framework/tools rank higher than generic ones.
 */
function buildLangKeywords(meta: DetectedProjectMeta): string[] {
	const keywords: string[] = [];
	if (meta.language) {
		keywords.push(meta.language.toLowerCase());
		// Add common aliases
		const aliases: Record<string, string[]> = {
			'c#': ['csharp', 'dotnet', '.net', 'asp.net', 'blazor', 'unity', 'nuget'],
			'typescript': ['ts', 'node', 'npm', 'deno', 'bun'],
			'javascript': ['js', 'node', 'npm', 'deno', 'bun'],
			'python': ['py', 'pip', 'poetry', 'django', 'flask', 'fastapi'],
			'rust': ['cargo', 'crate'],
			'go': ['golang', 'goroutine'],
			'java': ['jvm', 'maven', 'gradle', 'spring'],
			'kotlin': ['jvm', 'gradle', 'android'],
			'swift': ['xcode', 'ios', 'macos'],
			'ruby': ['gem', 'rails', 'bundler'],
			'php': ['composer', 'laravel', 'symfony'],
			'c++': ['cpp', 'cmake', 'makefile'],
			'c': ['cmake', 'makefile', 'gcc'],
		};
		const langLower = meta.language.toLowerCase();
		if (aliases[langLower]) keywords.push(...aliases[langLower]);
	}
	if (meta.framework) keywords.push(meta.framework.toLowerCase());
	if (meta.buildTool) keywords.push(meta.buildTool.toLowerCase());
	// Add key dependency names
	for (const dep of meta.dependencies.slice(0, 10)) {
		keywords.push(dep.name.toLowerCase());
	}
	return [...new Set(keywords)];
}

/**
 * Score how relevant an agent is to the project based on language keywords.
 * Higher score = more relevant.
 */
function scoreAgentRelevance(agent: AgentInfoExt, langKeywords: string[]): number {
	if (langKeywords.length === 0) return 0;
	let score = 0;
	for (const kw of langKeywords) {
		if (agent.searchText.includes(kw)) score += 1;
	}
	return score;
}

/**
 * Analyze project metadata and match to the best available agents.
 * Returns suggestions ordered by relevance + types that couldn't be filled.
 */
function buildSuggestions(
	meta: DetectedProjectMeta,
	available: AgentInfoExt[],
	slotsLeft: number
): SuggestionResult {
	if (slotsLeft <= 0 && available.length === 0) return { suggestions: [], missingTypes: [] };

	const langKeywords = buildLangKeywords(meta);

	// Build a map of agent types to agents for fast lookup
	const byType = new Map<string, AgentInfoExt[]>();
	for (const a of available) {
		const list = byType.get(a.type) ?? [];
		list.push(a);
		byType.set(a.type, list);
	}

	const scored: AgentSuggestion[] = [];
	const missing: MissingType[] = [];
	const used = new Set<string>();

	function pick(type: string, reason: string, priority: number, createHint?: { name: string; description: string }) {
		// Try exact type match first, then keyword match in name/description
		let candidates = byType.get(type)?.filter(a => !used.has(a.filename)) ?? [];
		if (candidates.length === 0) {
			// Fuzzy: search all available agents for type keyword in name/description
			candidates = available.filter(a =>
				!used.has(a.filename) &&
				(a.name.toLowerCase().includes(type) ||
				 (a.description ?? '').toLowerCase().includes(type) ||
				 a.filename.toLowerCase().includes(type))
			);
		}
		if (candidates.length === 0) {
			// No agent found — suggest creating one
			if (createHint && !missing.some(m => m.type === type)) {
				missing.push({
					type,
					reason,
					suggestedName: createHint.name,
					suggestedDescription: createHint.description
				});
			}
			return;
		}

		// Sort candidates by language relevance — pick the best match, not the first
		if (langKeywords.length > 0) {
			candidates.sort((a, b) => scoreAgentRelevance(b, langKeywords) - scoreAgentRelevance(a, langKeywords));
		}

		const agent = candidates[0];
		const relevanceScore = scoreAgentRelevance(agent, langKeywords);
		used.add(agent.filename);

		// If the best candidate has zero relevance to this language, still add it
		// but also suggest creating a language-specific one
		if (relevanceScore === 0 && langKeywords.length > 0 && createHint && !missing.some(m => m.type === type)) {
			missing.push({
				type,
				reason: `Existing "${agent.name}" is generic — a ${meta.language ?? 'project'}-specific agent would be more effective`,
				suggestedName: createHint.name,
				suggestedDescription: createHint.description
			});
		}

		scored.push({
			filename: agent.filename,
			name: agent.name,
			type: agent.type,
			description: agent.description ?? '',
			reason: relevanceScore > 0 ? reason : `${reason} (generic — no ${meta.language ?? 'language'}-specific agent available)`,
			priority
		});
	}

	const lang = meta.language ?? 'general';
	const framework = meta.framework ?? '';

	// ── Core: every project needs development agents ──
	pick('development', 'Every project needs code implementation agents', 1,
		{ name: `${lang} Developer`, description: `Code implementation agent for ${lang}${framework ? ` / ${framework}` : ''} projects` });
	pick('development', 'Second coder for parallel implementation work', 2);

	// ── Code quality ──
	pick('code-analyzer', 'Code analysis catches quality issues early', 3,
		{ name: `${lang} Code Analyzer`, description: `Static analysis and code quality checks for ${lang} codebases` });
	if (!byType.has('code-analyzer') && scored.length < 2) {
		pick('analysis', 'Code analysis catches quality issues early', 3);
	}

	// ── Testing — especially if no test command detected ──
	if (!meta.testCommand) {
		pick('tester', 'No test setup detected — a test agent can bootstrap testing', 3,
			{ name: `${lang} Test Agent`, description: `Write and run tests for ${lang}${framework ? ` / ${framework}` : ''} — bootstrap test infrastructure` });
		pick('validator', 'Validation agents verify correctness without existing test infra', 4);
	} else {
		pick('tester', 'Maintain and expand test coverage', 5,
			{ name: `${lang} Test Agent`, description: `Maintain test suite for ${lang} projects (${meta.testCommand})` });
		pick('validator', 'Validation for integration and e2e scenarios', 6);
	}

	// ── Security — higher priority if project has auth deps or many dependencies ──
	const hasAuthDeps = meta.dependencies.some(d =>
		/auth|jwt|passport|helmet|cors|bcrypt|crypto|session/.test(d.name.toLowerCase())
	);
	const manyDeps = meta.dependencies.length > 15;
	if (hasAuthDeps || manyDeps) {
		const secReason = hasAuthDeps
			? `Auth-related dependencies detected (${meta.dependencies.filter(d => /auth|jwt|passport|helmet|cors|bcrypt/.test(d.name.toLowerCase())).map(d => d.name).slice(0, 3).join(', ')})`
			: `${meta.dependencies.length} dependencies — security scanning recommended`;
		pick('security', secReason, 3,
			{ name: `${lang} Security Auditor`, description: `Security scanning for ${lang} projects — OWASP, dependency audit, credential detection` });
	} else {
		pick('security', 'Proactive security auditing for any project', 7);
	}

	// ── Architecture — important for complex projects ──
	const isComplex = meta.services.length > 1 || meta.dependencies.length > 20 || meta.maintenance.branchCount > 5;
	if (isComplex) {
		pick('architect', `Complex project detected (${meta.services.length} services, ${meta.dependencies.length} deps)`, 3,
			{ name: `${framework || lang} Architect`, description: `Architecture review and design for complex ${framework || lang} systems` });
		pick('architecture', `Architecture review for multi-service project`, 4);
	} else {
		pick('architect', 'Architecture guidance for project structure', 8);
	}

	// ── CI/CD — if workflows detected or missing ──
	if (meta.workflows.length > 0) {
		pick('devops', `${meta.workflows.length} CI workflow(s) detected — DevOps agent maintains pipelines`, 5);
	} else {
		pick('devops', 'No CI/CD detected — DevOps agent can set up automation', 4,
			{ name: `${lang} DevOps Agent`, description: `Set up CI/CD pipelines, deployment automation for ${lang} projects` });
	}

	// ── Documentation — based on docs state ──
	if (!meta.maintenance.hasDocsDir && !meta.maintenance.hasReadme) {
		pick('documentation', 'No documentation found — documentation agent can bootstrap docs', 4,
			{ name: `${framework || lang} Documenter`, description: `Create and maintain documentation for ${framework || lang} projects` });
	} else {
		pick('documentation', 'Keep documentation in sync with code changes', 7);
	}

	// ── Coordination — for larger pools ──
	if (slotsLeft >= 5) {
		pick('coordinator', 'Coordinate work across multiple agents in larger pools', 6);
	}

	// ── Data/ML — if relevant dependencies detected ──
	const hasDataDeps = meta.dependencies.some(d =>
		/tensorflow|torch|pandas|numpy|sklearn|keras|transformers|langchain/.test(d.name.toLowerCase())
	);
	if (hasDataDeps) {
		pick('data', 'ML/data dependencies detected — data agent for model and pipeline work', 3,
			{ name: 'ML/Data Agent', description: 'Machine learning model training, data pipeline management' });
	}

	// ── Specialist/Automation ──
	pick('automation', 'Automate repetitive tasks and workflows', 8);
	pick('specialist', 'Specialized domain expertise', 9);

	// Sort by priority, truncate to available slots
	scored.sort((a, b) => a.priority - b.priority);
	const effectiveSlots = Math.max(slotsLeft, 3);
	return {
		suggestions: scored.slice(0, effectiveSlots),
		missingTypes: missing
	};
}

// ── Agent Markdown Generator ──────────────────────────────────────

interface AgentGenInput {
	name: string;
	type: string;
	description: string;
	language: string;
	framework: string;
}

const typeCapabilities: Record<string, string[]> = {
	development: ['code_generation', 'refactoring', 'optimization', 'api_design', 'error_handling'],
	'code-analyzer': ['static_analysis', 'code_review', 'pattern_detection', 'quality_metrics'],
	tester: ['test_generation', 'test_execution', 'coverage_analysis', 'fixture_management'],
	security: ['vulnerability_scanning', 'dependency_audit', 'credential_detection', 'owasp_analysis'],
	documentation: ['doc_generation', 'api_docs', 'architecture_docs', 'changelog_management'],
	devops: ['ci_cd_setup', 'deployment_automation', 'infrastructure_as_code', 'monitoring'],
	architect: ['architecture_review', 'design_patterns', 'system_design', 'dependency_analysis'],
	data: ['data_pipeline', 'model_training', 'data_validation', 'feature_engineering'],
};

const typeColors: Record<string, string> = {
	development: '#FF6B35',
	'code-analyzer': '#4ECDC4',
	tester: '#2ECC71',
	security: '#E74C3C',
	documentation: '#3498DB',
	devops: '#9B59B6',
	architect: '#F39C12',
	data: '#1ABC9C',
};

const langTestCommands: Record<string, string> = {
	'c#': 'dotnet test',
	typescript: 'npm test',
	javascript: 'npm test',
	python: 'pytest',
	rust: 'cargo test',
	go: 'go test ./...',
	java: 'mvn test',
	ruby: 'bundle exec rspec',
	php: 'vendor/bin/phpunit',
};

const langBuildCommands: Record<string, string> = {
	'c#': 'dotnet build',
	typescript: 'npm run build',
	javascript: 'npm run build',
	python: 'python -m build',
	rust: 'cargo build',
	go: 'go build ./...',
	java: 'mvn package',
	ruby: 'bundle exec rake build',
	php: 'composer build',
};

const langLintCommands: Record<string, string> = {
	'c#': 'dotnet format --verify-no-changes',
	typescript: 'npm run lint',
	javascript: 'npm run lint',
	python: 'ruff check .',
	rust: 'cargo clippy',
	go: 'golangci-lint run',
	java: 'mvn checkstyle:check',
	ruby: 'rubocop',
	php: 'vendor/bin/phpcs',
};

function generateAgentMarkdown(input: AgentGenInput): string {
	const { name, type, description, language, framework } = input;
	const langLower = language.toLowerCase();
	const caps = typeCapabilities[type] ?? typeCapabilities.development ?? ['code_generation'];
	const color = typeColors[type] ?? '#6C757D';
	const testCmd = langTestCommands[langLower] ?? 'npm test';
	const buildCmd = langBuildCommands[langLower] ?? 'npm run build';
	const lintCmd = langLintCommands[langLower] ?? 'npm run lint';
	const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

	const lines: string[] = [];
	lines.push('---');
	lines.push(`name: ${slug}`);
	lines.push(`type: ${type}`);
	lines.push(`color: "${color}"`);
	lines.push(`description: ${description}`);
	lines.push('capabilities:');
	for (const cap of caps) lines.push(`  - ${cap}`);
	lines.push('priority: high');
	lines.push('hooks:');
	lines.push('  pre: |');
	lines.push(`    echo "Agent ${name} starting: $TASK"`);
	lines.push('');
	lines.push('    # Learn from past patterns');
	lines.push('    SIMILAR=$(npx claude-flow@v3alpha memory search --query "$TASK" --limit 5 --min-score 0.8 --use-hnsw)');
	lines.push('    if [ -n "$SIMILAR" ]; then');
	lines.push('      echo "Found similar patterns"');
	lines.push('    fi');
	lines.push('');
	lines.push('  post: |');
	lines.push('    echo "Task complete"');
	lines.push('');

	// Post-hook validation based on type
	if (type === 'tester' || type === 'development') {
		lines.push(`    # Run tests`);
		lines.push(`    if command -v ${testCmd.split(' ')[0]} &>/dev/null; then`);
		lines.push(`      ${testCmd} --if-present 2>&1 || true`);
		lines.push('    fi');
	}
	if (type === 'code-analyzer' || type === 'development') {
		lines.push(`    # Lint check`);
		lines.push(`    ${lintCmd} --if-present 2>&1 || true`);
	}

	lines.push('---');
	lines.push('');
	lines.push(`# ${name}`);
	lines.push('');
	lines.push(`> ${description}`);
	lines.push('');
	lines.push(`## Language & Framework`);
	lines.push(`- **Language**: ${language}`);
	if (framework) lines.push(`- **Framework**: ${framework}`);
	lines.push(`- **Build**: \`${buildCmd}\``);
	lines.push(`- **Test**: \`${testCmd}\``);
	lines.push(`- **Lint**: \`${lintCmd}\``);
	lines.push('');
	lines.push('## Instructions');
	lines.push('');

	// Type-specific instructions
	switch (type) {
		case 'development':
			lines.push(`You are a ${language} implementation specialist${framework ? ` for ${framework}` : ''}.`);
			lines.push('');
			lines.push('### Guidelines');
			lines.push(`- Follow ${language} idioms and best practices`);
			lines.push('- Write clean, well-structured code with proper error handling');
			lines.push(`- Use ${language} naming conventions consistently`);
			lines.push('- Keep files under 500 lines');
			lines.push('- Validate input at system boundaries');
			if (framework) lines.push(`- Follow ${framework} conventions and patterns`);
			break;
		case 'tester':
			lines.push(`You write and maintain tests for ${language} projects${framework ? ` using ${framework}` : ''}.`);
			lines.push('');
			lines.push('### Guidelines');
			lines.push(`- Use \`${testCmd}\` to run tests`);
			lines.push('- Write unit tests, integration tests, and edge case coverage');
			lines.push('- Follow Arrange-Act-Assert pattern');
			lines.push('- Mock external dependencies, not internal logic');
			lines.push('- Aim for >80% coverage on changed code');
			break;
		case 'security':
			lines.push(`You perform security audits on ${language} codebases${framework ? ` with ${framework}` : ''}.`);
			lines.push('');
			lines.push('### Guidelines');
			lines.push('- Scan for OWASP Top 10 vulnerabilities');
			lines.push('- Check for hardcoded credentials and secrets');
			lines.push('- Audit dependency versions for known CVEs');
			lines.push('- Review authentication and authorization logic');
			lines.push('- Validate input sanitization at all entry points');
			break;
		case 'code-analyzer':
			lines.push(`You analyze ${language} code quality${framework ? ` in ${framework} projects` : ''}.`);
			lines.push('');
			lines.push('### Guidelines');
			lines.push(`- Run \`${lintCmd}\` and report issues`);
			lines.push('- Identify code smells, dead code, and complexity hotspots');
			lines.push('- Check for consistent naming and structure');
			lines.push('- Flag potential performance issues');
			lines.push('- Suggest refactoring opportunities');
			break;
		case 'documentation':
			lines.push(`You create and maintain documentation for ${language} projects${framework ? ` using ${framework}` : ''}.`);
			lines.push('');
			lines.push('### Guidelines');
			lines.push('- Keep docs concise and up-to-date with code changes');
			lines.push('- Document public APIs, configuration, and architecture decisions');
			lines.push(`- Use ${language}-appropriate doc formats (JSDoc, XML docs, docstrings, etc.)`);
			lines.push('- Include usage examples for complex features');
			break;
		case 'devops':
			lines.push(`You set up and maintain CI/CD and deployment for ${language} projects${framework ? ` with ${framework}` : ''}.`);
			lines.push('');
			lines.push('### Guidelines');
			lines.push(`- Use \`${buildCmd}\` for builds and \`${testCmd}\` for test pipelines`);
			lines.push('- Configure GitHub Actions or similar CI for automated testing');
			lines.push('- Set up linting, type-checking, and security scanning in CI');
			lines.push('- Automate release workflows and versioning');
			break;
		case 'architect':
			lines.push(`You review and design architecture for ${language} systems${framework ? ` using ${framework}` : ''}.`);
			lines.push('');
			lines.push('### Guidelines');
			lines.push('- Apply SOLID principles and appropriate design patterns');
			lines.push('- Review module boundaries and dependency graphs');
			lines.push('- Identify coupling, cohesion, and abstraction issues');
			lines.push('- Recommend scalability and maintainability improvements');
			break;
		default:
			lines.push(`You are a ${type} specialist for ${language} projects${framework ? ` using ${framework}` : ''}.`);
			lines.push('');
			lines.push('### Guidelines');
			lines.push(`- Follow ${language} best practices`);
			lines.push('- Communicate findings clearly');
			lines.push('- Prioritize high-impact items first');
	}

	lines.push('');
	lines.push('## Quality Checklist');
	lines.push('- [ ] Changes follow project conventions');
	lines.push('- [ ] No security vulnerabilities introduced');
	lines.push('- [ ] Error handling is appropriate');
	lines.push(`- [ ] ${type === 'tester' ? 'Tests pass' : 'Tests not broken'}`);
	lines.push('');

	return lines.join('\n');
}
