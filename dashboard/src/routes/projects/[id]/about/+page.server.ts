import { resolve } from 'path';
import { readFile, stat } from 'fs/promises';
import type { PageServerLoad } from './$types.js';
import { PATHS } from '$lib/server/constants.js';
import { scanAllProjects, detectProjectMeta } from '$lib/server/project-scanner.js';

interface LanguageStat {
	name: string;
	pct: number;
	color: string;
}

interface AboutData {
	projectId: string;
	identity: {
		name: string;
		description: string;
		path: string;
		health: string;
		status: string;
		branch: string;
		lastOpened: string;
	};
	techStack: string[];
	language: string | null;
	framework: string | null;
	buildTool: string | null;
	commands: {
		build: string | null;
		dev: string | null;
		test: string | null;
		lint: string | null;
		start: string | null;
	};
	gitRemote: string | null;
	defaultBranch: string | null;
	branches: string[];
	dependencies: { name: string; version?: string; type: string }[];
	scripts: Record<string, string>;
	maintenance: {
		hasReadme: boolean;
		hasChangelog: boolean;
		hasDocsDir: boolean;
		hasClaude: boolean;
		hasClaudeFlow: boolean;
		hasLicense: boolean;
	};
	workflows: { name: string; file: string; triggers: string[]; jobs: string[] }[];
	agents: { name: string; type: string; fileCount: number }[];
	releaseProcess: string[];
	timeline: {
		created: string | null;
		lastModified: string | null;
	};
	stats: {
		totalDeps: number;
		totalBranches: number;
		totalAgents: number;
		totalWorkflows: number;
	};
}

async function getTimestamps(projectPath: string): Promise<{ created: string | null; lastModified: string | null }> {
	try {
		const gitDir = resolve(projectPath, '.git');
		const s = await stat(gitDir);
		// .git creation time ~ project init; mtime ~ last git activity
		return {
			created: s.birthtime?.toISOString() ?? null,
			lastModified: s.mtime?.toISOString() ?? null
		};
	} catch {
		try {
			const s = await stat(projectPath);
			return {
				created: s.birthtime?.toISOString() ?? null,
				lastModified: s.mtime?.toISOString() ?? null
			};
		} catch {
			return { created: null, lastModified: null };
		}
	}
}

export const load: PageServerLoad = async ({ parent, params }): Promise<AboutData> => {
	const { project } = await parent();
	const projects = await scanAllProjects(PATHS.playgroundRegistry, PATHS.root);
	const scannedProject = projects.find((p) => p.id === params.id);

	const projectPath = scannedProject?.path ?? project.path;

	// Detect full metadata
	let meta;
	try {
		meta = await detectProjectMeta(projectPath);
	} catch {
		meta = null;
	}

	// Read package.json scripts
	let scripts: Record<string, string> = {};
	try {
		const raw = await readFile(resolve(projectPath, 'package.json'), 'utf-8');
		const pkg = JSON.parse(raw);
		scripts = (pkg.scripts as Record<string, string>) ?? {};
	} catch {
		// no package.json or not JSON
	}

	const timeline = await getTimestamps(projectPath);

	const deps = meta?.dependencies ?? [];
	const branches = meta?.branches ?? [];
	const agents = meta?.agents ?? [];
	const workflows = meta?.workflows ?? [];

	return {
		projectId: params.id,
		identity: {
			name: scannedProject?.name ?? project.name,
			description: scannedProject?.description ?? `Project at ${projectPath}`,
			path: projectPath,
			health: scannedProject?.health ?? project.health,
			status: scannedProject?.status ?? 'unknown',
			branch: scannedProject?.branch ?? project.branch,
			lastOpened: scannedProject?.lastOpened ?? 'unknown'
		},
		techStack: scannedProject?.techStack ?? [],
		language: meta?.language ?? null,
		framework: meta?.framework ?? null,
		buildTool: meta?.buildTool ?? null,
		commands: {
			build: meta?.buildCommand ?? null,
			dev: meta?.devCommand ?? null,
			test: meta?.testCommand ?? null,
			lint: meta?.lintCommand ?? null,
			start: meta?.startCommand ?? null
		},
		gitRemote: meta?.gitRemote ?? null,
		defaultBranch: meta?.defaultBranch ?? null,
		branches,
		dependencies: deps.map((d) => ({ name: d.name, version: d.version, type: d.type })),
		scripts,
		maintenance: meta?.maintenance ?? {
			hasReadme: false,
			hasChangelog: false,
			hasDocsDir: false,
			hasClaude: false,
			hasClaudeFlow: false,
			hasLicense: false
		},
		workflows,
		agents,
		releaseProcess: meta?.releaseProcess ?? [],
		timeline,
		stats: {
			totalDeps: deps.length,
			totalBranches: branches.length,
			totalAgents: agents.length,
			totalWorkflows: workflows.length
		}
	};
};
