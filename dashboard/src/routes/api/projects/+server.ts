import { json } from '@sveltejs/kit';
import { resolve } from 'path';
import { readFile, writeFile, access, mkdir } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { PATHS } from '$lib/server/constants.js';
import { scanAllProjects, scanProject } from '$lib/server/project-scanner.js';
import { startProjectServices } from '$lib/server/service-starter.js';
import { TEMPLATE_MAP, detectTechFromTemplate } from '$lib/server/project-templates.js';
import type { ProjectRegistry, PlaygroundConfig } from '$lib/types/projects.js';

const execFileAsync = promisify(execFile);

const favoritesPath = resolve(PATHS.root, '.playground/favorites.json');

async function readFavorites(): Promise<string[]> {
	try {
		const raw = await readFile(favoritesPath, 'utf-8');
		const data = JSON.parse(raw);
		return Array.isArray(data) ? data : [];
	} catch {
		return [];
	}
}

async function writeFavorites(ids: string[]): Promise<void> {
	await mkdir(resolve(favoritesPath, '..'), { recursive: true });
	await writeFile(favoritesPath, JSON.stringify(ids, null, '\t'), 'utf-8');
}

export async function GET({ url }) {
	const projects = await scanAllProjects(PATHS.playgroundRegistry, PATHS.root);
	const favorites = await readFavorites();

	for (const p of projects) {
		p.favorite = favorites.includes(p.id);
	}

	return json({ projects, favorites });
}

export async function PATCH({ request }) {
	const body = await request.json();
	const { id, favorite } = body as { id: string; favorite: boolean };

	if (!id || typeof favorite !== 'boolean') {
		return json({ error: 'id and favorite (boolean) are required' }, { status: 400 });
	}

	const favorites = await readFavorites();
	const idx = favorites.indexOf(id);

	if (favorite && idx === -1) {
		favorites.push(id);
	} else if (!favorite && idx !== -1) {
		favorites.splice(idx, 1);
	}

	await writeFavorites(favorites);
	return json({ ok: true, favorites });
}

interface CreateProjectBody {
	name: string;
	path: string;
	template: string;
	description?: string;
	initGit?: boolean;
	createGithub?: boolean;
	primaryModel?: string;
	escalation?: string;
	memoryNamespace?: string;
	isolateMemory?: boolean;
	sharePatterns?: boolean;
	maxAgents?: number;
	topology?: string;
	services?: string[];
	startServices?: boolean | string[];
	templateParams?: Record<string, string | boolean>;
}

/** Scaffold files using the centralised template registry */
async function scaffoldTemplate(
	projectPath: string,
	templateId: string,
	name: string,
	description: string,
	params?: Record<string, string | boolean>
) {
	const def = TEMPLATE_MAP.get(templateId) ?? TEMPLATE_MAP.get('blank')!;
	const files = def.generate(name, description, params ?? {});

	for (const [relPath, content] of Object.entries(files)) {
		const fullPath = resolve(projectPath, relPath);
		const dir = resolve(fullPath, '..');
		await mkdir(dir, { recursive: true });
		await writeFile(fullPath, content, 'utf-8');
	}
}

async function addToRegistry(projectPath: string) {
	const registryPath = PATHS.playgroundRegistry;
	let registry: ProjectRegistry;
	try {
		const raw = await readFile(registryPath, 'utf-8');
		registry = JSON.parse(raw);
	} catch {
		registry = { version: 1, projects: [] };
	}

	const normalizedPath = resolve(projectPath);
	const selfPath = resolve(PATHS.root);
	const entryPath = normalizedPath === selfPath ? '.' : normalizedPath;

	if (!registry.projects.some((e) => resolve(PATHS.root, e.path === '.' ? '.' : e.path) === normalizedPath)) {
		registry.projects.push({ path: entryPath, addedAt: new Date().toISOString() });
		// Ensure .playground dir exists for registry
		await mkdir(resolve(PATHS.playgroundRegistry, '..'), { recursive: true });
		await writeFile(registryPath, JSON.stringify(registry, null, '\t'), 'utf-8');
	}
}

export async function POST({ request }) {
	const body: CreateProjectBody = await request.json();

	// Support legacy import flow (just path, no name)
	if (!body.name && body.path) {
		return handleImport(body.path);
	}

	if (!body.name || typeof body.name !== 'string') {
		return json({ error: 'name is required' }, { status: 400 });
	}
	if (!body.path || typeof body.path !== 'string') {
		return json({ error: 'path is required' }, { status: 400 });
	}

	const projectPath = resolve(body.path);
	const template = body.template || 'blank';

	// 1. Create project directory
	await mkdir(projectPath, { recursive: true });

	// 2. Scaffold template files
	await scaffoldTemplate(projectPath, template, body.name, body.description || '', body.templateParams);

	// 3. Create .playground/config.json with all configured settings
	const config: PlaygroundConfig = {
		name: body.name,
		description: body.description || undefined,
		tags: [],
		techStack: detectTechFromTemplate(template),
		agents: {
			topology: body.topology || 'hierarchical-mesh',
			maxAgents: body.maxAgents ?? 8,
			memoryNamespace: body.memoryNamespace || body.name,
			modelPreferences: [body.primaryModel || 'GPT-OSS 20B (local)', body.escalation || 'Claude Sonnet 4.6']
		},
		services: (body.services || []).map((s) => ({ name: s })),
		stats: {
			lastSynced: new Date().toISOString(),
			totalToolUses: 0,
			totalSessions: 0,
			totalAgentSpawns: 0
		}
	};

	const playgroundDir = resolve(projectPath, '.playground');
	await mkdir(playgroundDir, { recursive: true });
	await writeFile(resolve(playgroundDir, 'config.json'), JSON.stringify(config, null, '\t'), 'utf-8');

	// 4. Git init if requested
	let gitInitialized = false;
	if (body.initGit) {
		try {
			await execFileAsync('git', ['init'], { cwd: projectPath });
			gitInitialized = true;
		} catch {
			// git init failed — non-fatal
		}
	}

	// 5. Create GitHub repo if requested
	let githubCreated = false;
	if (body.createGithub && gitInitialized) {
		try {
			await execFileAsync('gh', ['repo', 'create', body.name, '--private', '--source', projectPath], {
				cwd: projectPath
			});
			githubCreated = true;
		} catch {
			// gh CLI not available or failed — non-fatal
		}
	}

	// 6. Add to project registry
	await addToRegistry(projectPath);

	// 7. Scan and return the created project
	const project = await scanProject(projectPath);

	// 8. Fire-and-forget service auto-start (don't block the response)
	const shouldStart = body.startServices;
	if (shouldStart === true || (Array.isArray(shouldStart) && shouldStart.length > 0)) {
		startProjectServices(projectPath).catch(() => {
			// Service start failures are non-fatal — logged in service-starter
		});
	}

	return json({ project, gitInitialized, githubCreated, servicesStarting: !!shouldStart }, { status: 201 });
}

/** Legacy import handler — existing directories only */
async function handleImport(path: string) {
	if (!path || typeof path !== 'string') {
		return json({ error: 'path is required' }, { status: 400 });
	}

	try {
		await access(path);
	} catch {
		return json({ error: 'Directory does not exist' }, { status: 400 });
	}

	const configPath = resolve(path, '.playground/config.json');
	try {
		await access(configPath);
	} catch {
		const { createDefaultConfig } = await import('$lib/server/project-scanner.js');
		const config = await createDefaultConfig(path);
		await mkdir(resolve(path, '.playground'), { recursive: true });
		await writeFile(configPath, JSON.stringify(config, null, '\t'), 'utf-8');
	}

	await addToRegistry(path);
	const project = await scanProject(path);
	return json({ project }, { status: 201 });
}
