import type { PageServerLoad } from './$types.js';
import { access, readFile } from 'fs/promises';
import { resolve } from 'path';
import { detectProjectMeta, createDefaultConfig } from '$lib/server/project-scanner.js';
import { WORKSPACE_ROOT } from '$lib/server/constants.js';
import type { DetectedProjectMeta, PlaygroundConfig } from '$lib/types/projects.js';

interface DetectedConfig {
	file: string;
	type: string;
	found: boolean;
}

async function fileExists(p: string): Promise<boolean> {
	try {
		await access(p);
		return true;
	} catch {
		return false;
	}
}

async function scanPath(projectPath: string) {
	const checks: [string, string][] = [
		['.playground/config.json', 'Playground Config'],
		['CLAUDE.md', 'Claude Config'],
		['package.json', 'Node.js Project'],
		['.env.example', 'Environment'],
		['.swarm/memory.db', 'Memory DB'],
		['docker-compose.yml', 'Docker'],
		['.mcp.json', 'MCP Servers'],
		['.claude-flow/config.yaml', 'Claude Flow Config'],
		['config/openclaw/', 'OpenClaw Config'],
		['config/security/', 'Security Policy'],
		['.github/workflows/', 'CI/CD Workflows'],
		['.claude/agents/', 'AI Agents'],
		['tsconfig.json', 'TypeScript'],
		['pyproject.toml', 'Python'],
		['Cargo.toml', 'Rust'],
		['.git', 'Git Repository'],
		// C#/.NET
		['nuget.config', 'NuGet'],
		['thunderstore/manifest.json', 'Thunderstore Mod'],
		['build.sh', 'Build Script (bash)'],
		['build.ps1', 'Build Script (PowerShell)'],
		['documents/', 'Documentation'],
		['scripts/', 'Scripts'],
	];

	// Dynamically detect .sln and .csproj files
	try {
		const { readdir: rd } = await import('fs/promises');
		const entries = await rd(projectPath);
		for (const entry of entries) {
			if (entry.endsWith('.sln')) checks.push([entry, 'C# Solution']);
			if (entry.endsWith('.csproj')) checks.push([entry, 'C# Project']);
		}
		// Check src/ for csproj files too
		try {
			const srcEntries = await rd(resolve(projectPath, 'src'));
			for (const entry of srcEntries) {
				if (entry.endsWith('.csproj')) checks.push([`src/${entry}`, 'C# Project']);
			}
		} catch { /* no src dir */ }
	} catch { /* skip */ }

	const [detectedConfigs, meta] = await Promise.all([
		Promise.all(
			checks.map(async ([file, type]) => ({
				file,
				type,
				found: await fileExists(resolve(projectPath, file))
			}))
		),
		detectProjectMeta(projectPath)
	]);

	// Detect services from known patterns (MCP-specific, merged with auto-detected)
	const detectedServices: { name: string; port?: number; detected: boolean }[] =
		meta.services.map((s) => ({ name: s.name, port: s.port, detected: true }));

	if (await fileExists(resolve(projectPath, '.claude-flow/config.yaml'))) {
		detectedServices.push({ name: 'Claude Flow Daemon', detected: true });
	}
	if (await fileExists(resolve(projectPath, 'config/openclaw/gateway.yaml'))) {
		detectedServices.push({ name: 'OpenClaw Gateway', detected: true });
	}
	if (await fileExists(resolve(projectPath, '.mcp.json'))) {
		try {
			const raw = await readFile(resolve(projectPath, '.mcp.json'), 'utf-8');
			const mcpConfig = JSON.parse(raw);
			const servers = mcpConfig.mcpServers ?? mcpConfig.servers ?? {};
			for (const key of Object.keys(servers)) {
				detectedServices.push({ name: `MCP: ${key}`, detected: true });
			}
		} catch {
			detectedServices.push({ name: 'MCP Servers', detected: true });
		}
	}

	const hasPlaygroundConfig = detectedConfigs.find((c) => c.file === '.playground/config.json')?.found;

	// Generate a config preview from detected data
	let configPreview: PlaygroundConfig | null = null;
	if (hasPlaygroundConfig) {
		try {
			const raw = await readFile(resolve(projectPath, '.playground/config.json'), 'utf-8');
			configPreview = JSON.parse(raw);
		} catch { /* ignore */ }
	} else {
		configPreview = await createDefaultConfig(projectPath);
	}

	return { detectedConfigs, detectedServices, hasPlaygroundConfig, meta, configPreview };
}

export const load: PageServerLoad = async ({ url }) => {
	const defaultPath = url.searchParams.get('path') || WORKSPACE_ROOT;
	const endsWithSep = defaultPath.endsWith('/') || defaultPath.endsWith('\\');
	const scanResult = endsWithSep ? null : await scanPath(defaultPath).catch(() => null);

	return {
		defaultPath,
		detectedConfigs: scanResult?.detectedConfigs ?? [],
		detectedServices: scanResult?.detectedServices ?? [],
		hasPlaygroundConfig: scanResult?.hasPlaygroundConfig ?? false,
		meta: scanResult?.meta ?? null,
		configPreview: scanResult?.configPreview ?? null,
		scanned: !!scanResult
	};
};
