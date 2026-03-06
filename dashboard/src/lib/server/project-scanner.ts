import { resolve, basename } from 'path';
import { readFile, access, readdir, stat } from 'fs/promises';
import type {
	PlaygroundConfig,
	ProjectRegistry,
	Project,
	PaginatedProjects,
	PlaygroundStats,
	PlaygroundService,
	DetectedProjectMeta,
	DetectedWorkflow,
	DetectedAgent,
	DetectedDependency,
	MaintenanceInfo
} from '$lib/types/projects.js';

async function exists(p: string): Promise<boolean> {
	try {
		await access(p);
		return true;
	} catch {
		return false;
	}
}

async function readJson<T>(p: string): Promise<T | null> {
	try {
		const raw = await readFile(p, 'utf-8');
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

async function countFiles(dir: string): Promise<number> {
	try {
		const entries = await readdir(dir);
		return entries.length;
	} catch {
		return 0;
	}
}

async function getMtime(p: string): Promise<Date | null> {
	try {
		const s = await stat(p);
		return s.mtime;
	} catch {
		return null;
	}
}

function timeAgo(date: Date): string {
	const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

function slugify(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

/** Detect tech stack from marker files */
async function detectTechStack(projectPath: string): Promise<string[]> {
	const markers: [string, string][] = [
		['tsconfig.json', 'TypeScript'],
		['pyproject.toml', 'Python'],
		['Cargo.toml', 'Rust'],
		['go.mod', 'Go'],
		['svelte.config.js', 'SvelteKit'],
		['svelte.config.ts', 'SvelteKit'],
		['next.config.js', 'Next.js'],
		['next.config.ts', 'Next.js'],
		['next.config.mjs', 'Next.js'],
		['tailwind.config.js', 'Tailwind'],
		['tailwind.config.ts', 'Tailwind'],
		['.claude-flow/config.yaml', 'Claude Flow v3'],
		['.mcp.json', 'MCP'],
		['docker-compose.yml', 'Docker'],
		['docker-compose.yaml', 'Docker']
	];

	const detected = new Set<string>();

	// Check for .sln files (C#/.NET)
	try {
		const entries = await readdir(projectPath);
		if (entries.some(e => e.endsWith('.sln'))) detected.add('C#/.NET');
		if (entries.some(e => e === 'thunderstore')) detected.add('Thunderstore');
		if (entries.some(e => e === 'nuget.config')) detected.add('NuGet');
		if (entries.some(e => e.endsWith('.csproj'))) detected.add('C#/.NET');
	} catch { /* skip */ }
	await Promise.all(
		markers.map(async ([file, tech]) => {
			if (await exists(resolve(projectPath, file))) detected.add(tech);
		})
	);
	return [...detected];
}

/** Read git branch from .git/HEAD */
async function getGitBranch(projectPath: string): Promise<string | undefined> {
	try {
		const head = await readFile(resolve(projectPath, '.git/HEAD'), 'utf-8');
		const match = head.trim().match(/^ref: refs\/heads\/(.+)$/);
		return match?.[1] ?? undefined;
	} catch {
		return undefined;
	}
}

/** Read the default branch (main or master) from git refs */
async function getDefaultBranch(projectPath: string): Promise<string | undefined> {
	const refsDir = resolve(projectPath, '.git/refs/heads');
	try {
		const branches = await readdir(refsDir);
		if (branches.includes('main')) return 'main';
		if (branches.includes('master')) return 'master';
		return branches[0] ?? undefined;
	} catch {
		return undefined;
	}
}

/** Read git remote URL from .git/config */
async function getGitRemote(projectPath: string): Promise<string | undefined> {
	try {
		const raw = await readFile(resolve(projectPath, '.git/config'), 'utf-8');
		const match = raw.match(/\[remote "origin"\][^[]*url\s*=\s*(.+)/m);
		return match?.[1]?.trim() ?? undefined;
	} catch {
		return undefined;
	}
}

/** Detect build tool from lockfiles and config files */
async function detectBuildTool(projectPath: string): Promise<string | undefined> {
	const lockfiles: [string, string][] = [
		['bun.lockb', 'bun'],
		['bun.lock', 'bun'],
		['pnpm-lock.yaml', 'pnpm'],
		['yarn.lock', 'yarn'],
		['package-lock.json', 'npm'],
		['poetry.lock', 'poetry'],
		['uv.lock', 'uv'],
		['Pipfile.lock', 'pipenv'],
		['Cargo.lock', 'cargo'],
		['go.sum', 'go'],
		['Makefile', 'make'],
		['CMakeLists.txt', 'cmake']
	];
	// Check for .sln or .csproj (dotnet)
	try {
		const entries = await readdir(projectPath);
		if (entries.some(e => e.endsWith('.sln'))) return 'dotnet';
	} catch { /* skip */ }
	for (const [file, tool] of lockfiles) {
		if (await exists(resolve(projectPath, file))) return tool;
	}
	// Fallback: if package.json exists but no lockfile, assume npm
	if (await exists(resolve(projectPath, 'package.json'))) return 'npm';
	if (await exists(resolve(projectPath, 'pyproject.toml'))) return 'pip';
	return undefined;
}

/** Detect primary language from project files */
async function detectLanguage(projectPath: string): Promise<string | undefined> {
	const langFiles: [string, string][] = [
		['package.json', 'JavaScript'],
		['tsconfig.json', 'TypeScript'],
		['pyproject.toml', 'Python'],
		['setup.py', 'Python'],
		['setup.cfg', 'Python'],
		['Cargo.toml', 'Rust'],
		['go.mod', 'Go'],
		['build.gradle', 'Java'],
		['build.gradle.kts', 'Kotlin'],
		['pom.xml', 'Java'],
		['mix.exs', 'Elixir'],
		['Gemfile', 'Ruby'],
		['composer.json', 'PHP']
	];
	// TypeScript takes priority over JavaScript
	if (await exists(resolve(projectPath, 'tsconfig.json'))) return 'TypeScript';
	// .sln or .csproj files indicate C#
	try {
		const entries = await readdir(projectPath);
		if (entries.some(e => e.endsWith('.sln') || e.endsWith('.csproj'))) return 'C#';
	} catch { /* skip */ }
	for (const [file, lang] of langFiles) {
		if (await exists(resolve(projectPath, file))) return lang;
	}
	return undefined;
}

/** Detect framework from dependencies in package.json or pyproject.toml */
async function detectFramework(
	projectPath: string,
	pkg: Record<string, unknown> | null
): Promise<string | undefined> {
	// Check Node.js frameworks from package.json deps
	if (pkg) {
		const deps = {
			...(pkg.dependencies as Record<string, string> | undefined),
			...(pkg.devDependencies as Record<string, string> | undefined)
		};
		const frameworkMap: [string, string][] = [
			['@sveltejs/kit', 'SvelteKit'],
			['next', 'Next.js'],
			['nuxt', 'Nuxt'],
			['@remix-run/node', 'Remix'],
			['@remix-run/react', 'Remix'],
			['astro', 'Astro'],
			['express', 'Express'],
			['fastify', 'Fastify'],
			['hono', 'Hono'],
			['@nestjs/core', 'NestJS'],
			['vue', 'Vue'],
			['react', 'React'],
			['svelte', 'Svelte'],
			['@angular/core', 'Angular'],
			['electron', 'Electron'],
			['expo', 'Expo'],
			['react-native', 'React Native']
		];
		for (const [dep, framework] of frameworkMap) {
			if (dep in deps) return framework;
		}
	}

	// Check Python frameworks from pyproject.toml
	const pyprojectPath = resolve(projectPath, 'pyproject.toml');
	if (await exists(pyprojectPath)) {
		try {
			const raw = await readFile(pyprojectPath, 'utf-8');
			if (raw.includes('fastapi')) return 'FastAPI';
			if (raw.includes('django')) return 'Django';
			if (raw.includes('flask')) return 'Flask';
			if (raw.includes('starlette')) return 'Starlette';
			if (raw.includes('litestar')) return 'Litestar';
		} catch { /* ignore */ }
	}

	// Rust frameworks from Cargo.toml
	const cargoPath = resolve(projectPath, 'Cargo.toml');
	if (await exists(cargoPath)) {
		try {
			const raw = await readFile(cargoPath, 'utf-8');
			if (raw.includes('actix-web')) return 'Actix';
			if (raw.includes('axum')) return 'Axum';
			if (raw.includes('rocket')) return 'Rocket';
			if (raw.includes('warp')) return 'Warp';
			if (raw.includes('tauri')) return 'Tauri';
		} catch { /* ignore */ }
	}

	// C#/.NET mod frameworks
	try {
		const entries = await readdir(projectPath);
		const slnFile = entries.find(e => e.endsWith('.sln'));
		if (slnFile) {
			// Look for csproj files to detect BepInEx / mod frameworks
			const scanCsproj = async (dir: string): Promise<string | undefined> => {
				try {
					for (const entry of await readdir(dir)) {
						if (entry.endsWith('.csproj')) {
							const raw = await readFile(resolve(dir, entry), 'utf-8');
							if (raw.includes('BepInEx')) return 'BepInEx (ROUNDS Mod)';
							if (raw.includes('MonoMod')) return 'MonoMod';
							return 'C#/.NET';
						}
						const full = resolve(dir, entry);
						try {
							const s = await stat(full);
							if (s.isDirectory() && entry !== 'node_modules' && entry !== '.git' && entry !== 'obj' && entry !== 'bin') {
								const result = await scanCsproj(full);
								if (result) return result;
							}
						} catch { /* skip */ }
					}
				} catch { /* skip */ }
				return undefined;
			};
			const framework = await scanCsproj(projectPath);
			if (framework) return framework;
		}
	} catch { /* skip */ }

	// Thunderstore manifest
	try {
		const manifest = await readJson<{ dependencies?: string[] }>(resolve(projectPath, 'thunderstore/manifest.json'));
		if (manifest?.dependencies?.some(d => d.includes('BepInEx'))) return 'BepInEx (ROUNDS Mod)';
	} catch { /* skip */ }

	// Go frameworks
	const goModPath = resolve(projectPath, 'go.mod');
	if (await exists(goModPath)) {
		try {
			const raw = await readFile(goModPath, 'utf-8');
			if (raw.includes('github.com/gin-gonic/gin')) return 'Gin';
			if (raw.includes('github.com/gofiber/fiber')) return 'Fiber';
			if (raw.includes('github.com/labstack/echo')) return 'Echo';
		} catch { /* ignore */ }
	}

	return undefined;
}

/** Parse scripts from package.json */
function parsePackageScripts(pkg: Record<string, unknown> | null): {
	build?: string;
	dev?: string;
	test?: string;
	lint?: string;
	start?: string;
} {
	if (!pkg?.scripts || typeof pkg.scripts !== 'object') return {};
	const scripts = pkg.scripts as Record<string, string>;
	return {
		build: scripts.build,
		dev: scripts.dev ?? scripts.start,
		test: scripts.test,
		lint: scripts.lint ?? scripts['lint:check'],
		start: scripts.start ?? scripts.preview ?? scripts.serve
	};
}

/** Detect release/CI process from workflow files and configs */
async function detectReleaseProcess(projectPath: string): Promise<string[]> {
	const processes: string[] = [];

	// GitHub Actions
	const workflowDir = resolve(projectPath, '.github/workflows');
	if (await exists(workflowDir)) {
		try {
			const files = await readdir(workflowDir);
			if (files.length > 0) processes.push('GitHub Actions');
		} catch { /* ignore */ }
	}

	// Common release tools
	const releaseChecks: [string, string][] = [
		['.releaserc', 'semantic-release'],
		['.releaserc.json', 'semantic-release'],
		['.releaserc.yml', 'semantic-release'],
		['release.config.js', 'semantic-release'],
		['release.config.cjs', 'semantic-release'],
		['.changeset/config.json', 'changesets'],
		['cliff.toml', 'git-cliff'],
		['.goreleaser.yml', 'GoReleaser'],
		['.goreleaser.yaml', 'GoReleaser'],
		['Dockerfile', 'Docker'],
		['fly.toml', 'Fly.io'],
		['vercel.json', 'Vercel'],
		['netlify.toml', 'Netlify'],
		['railway.json', 'Railway'],
		['render.yaml', 'Render']
	];

	await Promise.all(
		releaseChecks.map(async ([file, process]) => {
			if (await exists(resolve(projectPath, file))) processes.push(process);
		})
	);

	return [...new Set(processes)];
}

/** Detect required services from docker-compose, .env, prisma, etc. */
async function detectServices(projectPath: string): Promise<PlaygroundService[]> {
	const services: PlaygroundService[] = [];
	const seen = new Set<string>();

	function addService(name: string, port?: number, command?: string, healthUrl?: string) {
		if (seen.has(name)) return;
		seen.add(name);
		// Infer health URL from port if not provided
		if (!healthUrl && port) {
			const healthPorts: Record<number, string> = {
				5432: '', // PostgreSQL — no HTTP health
				3306: '', // MySQL
				27017: '', // MongoDB
				6379: '', // Redis
				5672: '', // RabbitMQ
				9200: `http://localhost:${port}/_cluster/health`,
				7700: `http://localhost:${port}/health`,
				3000: `http://localhost:${port}/api/health`,
				4000: `http://localhost:${port}/api/health`,
				5173: `http://localhost:${port}`,
				8000: `http://localhost:${port}/health`,
				8080: `http://localhost:${port}/health`,
				18789: `http://127.0.0.1:${port}/health`
			};
			healthUrl = healthPorts[port] || undefined;
		}
		services.push({ name, port, command, healthUrl });
	}

	// Parse docker-compose for service definitions
	for (const dcFile of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
		const dcPath = resolve(projectPath, dcFile);
		if (await exists(dcPath)) {
			try {
				const raw = await readFile(dcPath, 'utf-8');
				// Simple YAML parsing: look for service names under "services:"
				const servicesMatch = raw.match(/^services:\s*\n((?:\s+\S.*\n?)*)/m);
				if (servicesMatch) {
					const lines = servicesMatch[1].split('\n');
					for (const line of lines) {
						const svcMatch = line.match(/^\s{2}(\w[\w-]*):\s*$/);
						if (svcMatch) addService(`docker: ${svcMatch[1]}`);
					}
				}
				// Detect common images
				if (raw.includes('postgres')) addService('PostgreSQL', 5432);
				if (raw.includes('mysql')) addService('MySQL', 3306);
				if (raw.includes('mongo')) addService('MongoDB', 27017);
				if (raw.includes('redis')) addService('Redis', 6379);
				if (raw.includes('rabbitmq')) addService('RabbitMQ', 5672);
				if (raw.includes('elasticsearch')) addService('Elasticsearch', 9200);
				if (raw.includes('meilisearch')) addService('Meilisearch', 7700);
			} catch { /* ignore */ }
		}
	}

	// Detect from .env.example or .env.example
	for (const envFile of ['.env.example', '.env.template', '.env.sample']) {
		const envPath = resolve(projectPath, envFile);
		if (await exists(envPath)) {
			try {
				const raw = await readFile(envPath, 'utf-8');
				if (raw.match(/DATABASE_URL.*postgres/i)) addService('PostgreSQL', 5432);
				if (raw.match(/DATABASE_URL.*mysql/i)) addService('MySQL', 3306);
				if (raw.match(/DATABASE_URL.*mongo/i)) addService('MongoDB', 27017);
				if (raw.match(/REDIS_URL|REDIS_HOST/i)) addService('Redis', 6379);
				if (raw.match(/RABBITMQ|AMQP_URL/i)) addService('RabbitMQ', 5672);
				if (raw.match(/S3_|AWS_S3/i)) addService('S3/Object Storage');
				if (raw.match(/SMTP_|MAIL_HOST/i)) addService('SMTP/Email');
				if (raw.match(/STRIPE_/i)) addService('Stripe');
			} catch { /* ignore */ }
		}
	}

	// Prisma schema implies database
	const prismaPath = resolve(projectPath, 'prisma/schema.prisma');
	if (await exists(prismaPath)) {
		try {
			const raw = await readFile(prismaPath, 'utf-8');
			if (raw.includes('postgresql')) addService('PostgreSQL', 5432);
			else if (raw.includes('mysql')) addService('MySQL', 3306);
			else if (raw.includes('mongodb')) addService('MongoDB', 27017);
			else if (raw.includes('sqlite')) addService('SQLite');
			else addService('Database (Prisma)');
		} catch { /* ignore */ }
	}

	// Drizzle config
	for (const drizzle of ['drizzle.config.ts', 'drizzle.config.js']) {
		if (await exists(resolve(projectPath, drizzle))) addService('Database (Drizzle)');
	}

	return services;
}

/** Detect GitHub Actions workflows with triggers and job names */
async function detectWorkflows(projectPath: string): Promise<DetectedWorkflow[]> {
	const workflowDir = resolve(projectPath, '.github/workflows');
	const workflows: DetectedWorkflow[] = [];
	try {
		const files = await readdir(workflowDir);
		for (const file of files.filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))) {
			try {
				const raw = await readFile(resolve(workflowDir, file), 'utf-8');
				const nameMatch = raw.match(/^name:\s*(.+)/m);
				const name = nameMatch?.[1]?.trim().replace(/^["']|["']$/g, '') ?? file.replace(/\.(yml|yaml)$/, '');

				// Parse triggers from "on:" block
				const triggers: string[] = [];
				const onMatch = raw.match(/^on:\s*\n((?:\s+.+\n)*)/m);
				if (onMatch) {
					const lines = onMatch[1].split('\n');
					for (const line of lines) {
						const trigMatch = line.match(/^\s{2}(\w[\w_-]*):/);
						if (trigMatch) triggers.push(trigMatch[1]);
					}
				}
				// Simple single-line on:
				const simpleOn = raw.match(/^on:\s*\[([^\]]+)\]/m);
				if (simpleOn) {
					triggers.push(...simpleOn[1].split(',').map(t => t.trim()));
				}
				if (triggers.length === 0) {
					const singleOn = raw.match(/^on:\s+(\w+)\s*$/m);
					if (singleOn) triggers.push(singleOn[1]);
				}

				// Parse job names
				const jobs: string[] = [];
				const jobsMatch = raw.match(/^jobs:\s*\n((?:\s+.+\n)*)/m);
				if (jobsMatch) {
					const lines = jobsMatch[1].split('\n');
					for (const line of lines) {
						const jobMatch = line.match(/^\s{2}(\w[\w-]*):/);
						if (jobMatch) jobs.push(jobMatch[1]);
					}
				}

				workflows.push({ name, file, triggers, jobs });
			} catch { /* skip unreadable workflows */ }
		}
	} catch { /* no workflows dir */ }
	return workflows;
}

/** Detect agent directories and types from .claude/agents/ */
async function detectAgents(projectPath: string): Promise<DetectedAgent[]> {
	const agentsDir = resolve(projectPath, '.claude/agents');
	const agents: DetectedAgent[] = [];
	try {
		const entries = await readdir(agentsDir);
		for (const entry of entries) {
			try {
				const entryPath = resolve(agentsDir, entry);
				const s = await stat(entryPath);
				if (s.isDirectory()) {
					const files = await readdir(entryPath);
					agents.push({
						name: entry,
						type: entry,
						fileCount: files.length
					});
				}
			} catch { /* skip */ }
		}
	} catch { /* no agents dir */ }
	return agents;
}

/** Detect git branches */
async function detectBranches(projectPath: string): Promise<string[]> {
	const refsDir = resolve(projectPath, '.git/refs/heads');
	try {
		const branches = await readdir(refsDir);
		return branches.filter(b => !b.startsWith('.'));
	} catch {
		return [];
	}
}

/** Detect key dependencies from various project files */
async function detectDependencies(projectPath: string): Promise<DetectedDependency[]> {
	const deps: DetectedDependency[] = [];
	const seen = new Set<string>();

	function addDep(name: string, version?: string, type: DetectedDependency['type'] = 'runtime') {
		if (seen.has(name)) return;
		seen.add(name);
		deps.push({ name, version, type });
	}

	// package.json
	const pkg = await readJson<{
		dependencies?: Record<string, string>;
		devDependencies?: Record<string, string>;
	}>(resolve(projectPath, 'package.json'));
	if (pkg) {
		for (const [name, ver] of Object.entries(pkg.dependencies ?? {})) {
			addDep(name, ver, 'runtime');
		}
		for (const [name, ver] of Object.entries(pkg.devDependencies ?? {})) {
			addDep(name, ver, 'dev');
		}
	}

	// .csproj — NuGet PackageReferences and DLL References
	try {
		const csprojFiles: string[] = [];
		const scanForCsproj = async (dir: string) => {
			try {
				const entries = await readdir(dir);
				for (const entry of entries) {
					if (entry === 'node_modules' || entry === '.git' || entry === 'obj' || entry === 'bin') continue;
					const full = resolve(dir, entry);
					if (entry.endsWith('.csproj')) {
						csprojFiles.push(full);
					} else {
						try {
							const s = await stat(full);
							if (s.isDirectory()) await scanForCsproj(full);
						} catch { /* skip */ }
					}
				}
			} catch { /* skip */ }
		};
		await scanForCsproj(projectPath);

		for (const csproj of csprojFiles) {
			try {
				const raw = await readFile(csproj, 'utf-8');
				// PackageReferences
				const pkgRefs = raw.matchAll(/<PackageReference\s+Include="([^"]+)"\s+Version="([^"]+)"/g);
				for (const m of pkgRefs) addDep(m[1], m[2], 'runtime');
				// DLL References (mod frameworks, game assemblies)
				const dllRefs = raw.matchAll(/<Reference\s+Include="([^"]+)"/g);
				for (const m of dllRefs) addDep(m[1], undefined, 'mod-framework');
			} catch { /* skip */ }
		}
	} catch { /* skip */ }

	// Thunderstore manifest (mod platform)
	try {
		const manifest = await readJson<{ dependencies?: string[] }>(
			resolve(projectPath, 'thunderstore/manifest.json')
		);
		if (manifest?.dependencies) {
			for (const dep of manifest.dependencies) {
				// Format: "Author-Name-Version"
				const parts = dep.split('-');
				if (parts.length >= 3) {
					const version = parts.pop()!;
					const name = parts.join('-');
					addDep(name, version, 'platform');
				} else {
					addDep(dep, undefined, 'platform');
				}
			}
		}
	} catch { /* skip */ }

	// Cargo.toml dependencies
	try {
		const raw = await readFile(resolve(projectPath, 'Cargo.toml'), 'utf-8');
		const depSection = raw.match(/\[dependencies\]\s*\n((?:[^[].+\n)*)/);
		if (depSection) {
			const lines = depSection[1].split('\n');
			for (const line of lines) {
				const m = line.match(/^(\w[\w-]*)\s*=\s*"([^"]+)"/);
				if (m) addDep(m[1], m[2], 'runtime');
			}
		}
	} catch { /* skip */ }

	// pyproject.toml dependencies
	try {
		const raw = await readFile(resolve(projectPath, 'pyproject.toml'), 'utf-8');
		const depMatch = raw.match(/dependencies\s*=\s*\[([\s\S]*?)\]/);
		if (depMatch) {
			const items = depMatch[1].matchAll(/"([^"]+)"/g);
			for (const m of items) {
				const parts = m[1].split(/[><=~!]/);
				addDep(parts[0].trim(), undefined, 'runtime');
			}
		}
	} catch { /* skip */ }

	return deps;
}

/** Detect maintenance and documentation status */
async function detectMaintenance(projectPath: string, branches: string[]): Promise<MaintenanceInfo> {
	const checks = await Promise.all([
		exists(resolve(projectPath, 'README.md')),
		exists(resolve(projectPath, 'CHANGELOG.md')).then(r => r || exists(resolve(projectPath, 'thunderstore/CHANGELOG.md'))),
		exists(resolve(projectPath, 'docs')).then(r => r || exists(resolve(projectPath, 'documents'))),
		exists(resolve(projectPath, 'CLAUDE.md')),
		exists(resolve(projectPath, '.claude-flow/config.yaml')),
		exists(resolve(projectPath, 'LICENSE')).then(r => r || exists(resolve(projectPath, 'LICENSE.md')))
	]);

	return {
		hasReadme: checks[0],
		hasChangelog: checks[1],
		hasDocsDir: checks[2],
		hasClaude: checks[3],
		hasClaudeFlow: checks[4],
		hasLicense: checks[5],
		branchCount: branches.length,
		activeBranches: branches
	};
}

/** Full auto-detection: parse project files and extract actionable metadata */
export async function detectProjectMeta(projectPath: string): Promise<DetectedProjectMeta> {
	const pkg = await readJson<Record<string, unknown>>(resolve(projectPath, 'package.json'));

	const [language, buildTool, framework, releaseProcess, detectedServices, workflows, agents, branches, dependencies] = await Promise.all([
		detectLanguage(projectPath),
		detectBuildTool(projectPath),
		detectFramework(projectPath, pkg),
		detectReleaseProcess(projectPath),
		detectServices(projectPath),
		detectWorkflows(projectPath),
		detectAgents(projectPath),
		detectBranches(projectPath),
		detectDependencies(projectPath)
	]);

	const scripts = parsePackageScripts(pkg);
	const [gitRemote, defaultBranch] = await Promise.all([
		getGitRemote(projectPath),
		getDefaultBranch(projectPath)
	]);

	const maintenance = await detectMaintenance(projectPath, branches);

	// Infer commands based on build tool if not in package.json
	let buildCommand = scripts.build;
	let devCommand = scripts.dev;
	let testCommand = scripts.test;
	let lintCommand = scripts.lint;
	let startCommand = scripts.start;

	// Check for build.sh / build.ps1 scripts
	if (!buildCommand) {
		if (await exists(resolve(projectPath, 'build.sh'))) buildCommand = 'bash build.sh';
		else if (await exists(resolve(projectPath, 'build.ps1'))) buildCommand = 'pwsh build.ps1';
	}

	if (buildTool && !buildCommand) {
		const buildCommands: Record<string, string> = {
			cargo: 'cargo build',
			go: 'go build ./...',
			make: 'make',
			cmake: 'cmake --build build',
			dotnet: 'dotnet build -c Release'
		};
		buildCommand = buildCommands[buildTool];
	}

	if (buildTool && !devCommand) {
		const devCommands: Record<string, string> = {
			cargo: 'cargo run',
			go: 'go run .',
			poetry: 'poetry run python -m app',
			uv: 'uv run python -m app',
			dotnet: 'dotnet run'
		};
		devCommand = devCommands[buildTool];
	}

	if (buildTool && !testCommand) {
		const testCommands: Record<string, string> = {
			cargo: 'cargo test',
			go: 'go test ./...',
			poetry: 'poetry run pytest',
			uv: 'uv run pytest',
			pip: 'pytest',
			pipenv: 'pipenv run pytest',
			make: 'make test',
			dotnet: 'dotnet test'
		};
		testCommand = testCommands[buildTool];
	}

	if (buildTool && !lintCommand) {
		const lintCommands: Record<string, string> = {
			cargo: 'cargo clippy',
			go: 'golangci-lint run',
			poetry: 'poetry run ruff check .',
			uv: 'uv run ruff check .',
			pip: 'ruff check .',
			pipenv: 'pipenv run ruff check .'
		};
		lintCommand = lintCommands[buildTool];
	}

	// Prefix Node.js commands with the build tool runner
	if (buildTool && ['npm', 'pnpm', 'yarn', 'bun'].includes(buildTool)) {
		const run = buildTool === 'npm' ? 'npm run' : buildTool;
		if (scripts.build) buildCommand = `${run} build`;
		if (scripts.dev) devCommand = `${run} dev`;
		else if ((pkg?.scripts as Record<string, string> | undefined)?.start) devCommand = `${run} start`;
		if (scripts.test) testCommand = `${run} test`;
		if (scripts.lint) lintCommand = `${run} lint`;
		if (scripts.start) startCommand = `${run === 'npm run' ? 'npm' : buildTool} start`;
	}

	return {
		language,
		framework,
		buildTool,
		buildCommand,
		devCommand,
		testCommand,
		lintCommand,
		startCommand,
		gitRemote,
		defaultBranch,
		releaseProcess,
		services: detectedServices,
		workflows,
		agents,
		branches,
		dependencies,
		maintenance
	};
}

export async function scanProject(projectPath: string): Promise<Project> {
	const configPath = resolve(projectPath, '.playground/config.json');
	const config = await readJson<PlaygroundConfig>(configPath);

	// Fallback: read package.json
	const pkg = await readJson<{ name?: string; description?: string; dependencies?: Record<string, string> }>(
		resolve(projectPath, 'package.json')
	);

	const name = config?.name ?? pkg?.name ?? basename(projectPath);
	const id = slugify(name);
	const description = config?.description ?? pkg?.description ?? `Project at ${projectPath}`;
	const tags = config?.tags ?? [];

	// Tech stack: config > detected
	let techStack = config?.techStack ?? [];
	if (techStack.length === 0) {
		techStack = await detectTechStack(projectPath);
	}

	// Git info
	const hasGit = await exists(resolve(projectPath, '.git'));
	const branch = await getGitBranch(projectPath);
	const gitHeadMtime = hasGit ? await getMtime(resolve(projectPath, '.git/HEAD')) : null;

	// Claude Flow info
	const hasClaudeFlow = await exists(resolve(projectPath, '.claude-flow'));
	const hasClaude = await exists(resolve(projectPath, '.claude'));

	// Count agents
	const agentDir = resolve(projectPath, '.claude/agents');
	const agentCount = await countFiles(agentDir);

	// Count sessions
	const sessionsDir = resolve(projectPath, '.claude-flow/sessions');
	const sessionCount = await countFiles(sessionsDir);

	// Memory nodes from graph-state
	let memoryNodes = 0;
	const graphState = await readJson<{ nodeCount?: number; nodes?: unknown[] }>(
		resolve(projectPath, '.claude-flow/data/graph-state.json')
	);
	if (graphState) {
		memoryNodes = graphState.nodeCount ?? (Array.isArray(graphState.nodes) ? graphState.nodes.length : 0);
	}

	// Daemon state for health
	const daemonState = await readJson<{
		status?: string;
		workerFailures?: number;
		running?: boolean;
	}>(resolve(projectPath, '.claude-flow/daemon-state.json'));

	// Derive health
	let health: Project['health'] = 'unknown';
	if (config) {
		if (daemonState?.workerFailures && daemonState.workerFailures > 5) {
			health = 'error';
		} else if (daemonState?.workerFailures && daemonState.workerFailures > 0) {
			health = 'warning';
		} else {
			health = 'healthy';
		}
	}

	// Derive status from last activity
	let status: Project['status'] = 'unconfigured';
	if (config) {
		if (gitHeadMtime) {
			const daysSince = (Date.now() - gitHeadMtime.getTime()) / (1000 * 60 * 60 * 24);
			status = daysSince > 30 ? 'archived' : 'active';
		} else {
			status = 'active';
		}
	}

	const lastOpened = gitHeadMtime ? timeAgo(gitHeadMtime) : 'unknown';

	const stats: PlaygroundStats = config?.stats ?? {
		lastSynced: undefined,
		totalToolUses: 0,
		totalSessions: 0,
		totalAgentSpawns: 0
	};

	return {
		id,
		name,
		description,
		path: projectPath,
		tags,
		techStack,
		health,
		status,
		lastOpened,
		agents: agentCount,
		sessions: sessionCount,
		memoryNodes,
		stats,
		hasClaudeFlow,
		hasClaude,
		hasGit,
		branch,
		commits: undefined
	};
}

export async function scanAllProjects(
	registryPath: string,
	projectRoot: string
): Promise<Project[]> {
	const registry = await readJson<ProjectRegistry>(registryPath);
	if (!registry?.projects?.length) return [];

	const projects = await Promise.all(
		registry.projects.map(async (entry) => {
			const fullPath = entry.path === '.' ? projectRoot : resolve(projectRoot, entry.path);
			try {
				return await scanProject(fullPath);
			} catch {
				return null;
			}
		})
	);

	return projects
		.filter((p): p is Project => p !== null)
		.sort((a, b) => {
			// Active first, then archived, then unconfigured
			const statusOrder = { active: 0, archived: 1, unconfigured: 2 };
			return statusOrder[a.status] - statusOrder[b.status];
		});
}

export async function scanAllProjectsPaginated(
	registryPath: string,
	projectRoot: string,
	page: number = 1,
	perPage: number = 12
): Promise<PaginatedProjects> {
	const all = await scanAllProjects(registryPath, projectRoot);
	const total = all.length;
	const totalPages = Math.max(1, Math.ceil(total / perPage));
	const safePage = Math.max(1, Math.min(page, totalPages));
	const start = (safePage - 1) * perPage;
	const projects = all.slice(start, start + perPage);

	return { projects, total, page: safePage, perPage, totalPages };
}

export async function createDefaultConfig(projectPath: string): Promise<PlaygroundConfig> {
	const pkg = await readJson<{ name?: string; description?: string }>(
		resolve(projectPath, 'package.json')
	);
	const techStack = await detectTechStack(projectPath);
	const meta = await detectProjectMeta(projectPath);

	// Detect OpenClaw-specific agent config
	const agents = await detectAgentConfig(projectPath);

	const config: PlaygroundConfig = {
		name: pkg?.name ?? basename(projectPath),
		description: pkg?.description,
		tags: [],
		techStack,
		primaryLanguage: meta.language,
		framework: meta.framework,
		buildTool: meta.buildTool,
		buildCommand: meta.buildCommand,
		devCommand: meta.devCommand,
		testCommand: meta.testCommand,
		lintCommand: meta.lintCommand,
		startCommand: meta.startCommand,
		gitRemote: meta.gitRemote,
		defaultBranch: meta.defaultBranch,
		releaseProcess: meta.releaseProcess.length > 0 ? meta.releaseProcess : undefined,
		services: meta.services.length > 0 ? meta.services : undefined,
		agents: agents ?? undefined,
		stats: {
			lastSynced: new Date().toISOString(),
			totalToolUses: 0,
			totalSessions: 0,
			totalAgentSpawns: 0
		}
	};

	return config;
}

/** Detect agent/orchestration config from Claude Flow and OpenClaw files */
async function detectAgentConfig(projectPath: string): Promise<PlaygroundConfig['agents'] | null> {
	const hasClaudeFlow = await exists(resolve(projectPath, '.claude-flow/config.yaml'));
	const hasOpenClaw = await exists(resolve(projectPath, 'config/openclaw/gateway.yaml'));

	if (!hasClaudeFlow && !hasOpenClaw) return null;

	const agents: NonNullable<PlaygroundConfig['agents']> = {};

	// Read Claude Flow config for topology and maxAgents
	if (hasClaudeFlow) {
		try {
			const raw = await readFile(resolve(projectPath, '.claude-flow/config.yaml'), 'utf-8');
			const topologyMatch = raw.match(/topology:\s*(\S+)/);
			const maxAgentsMatch = raw.match(/maxAgents:\s*(\d+)/);
			const namespaceMatch = raw.match(/namespace:\s*(\S+)/);
			if (topologyMatch) agents.topology = topologyMatch[1];
			if (maxAgentsMatch) agents.maxAgents = parseInt(maxAgentsMatch[1], 10);
			if (namespaceMatch) agents.memoryNamespace = namespaceMatch[1];
		} catch { /* ignore */ }
	}

	// Read OpenClaw model config for model preferences
	const modelsPath = resolve(projectPath, 'config/openclaw/models.json5');
	if (await exists(modelsPath)) {
		try {
			const raw = await readFile(modelsPath, 'utf-8');
			// Extract model names from JSON5 (simple pattern match)
			const models: string[] = [];
			const nameMatches = raw.matchAll(/"name"\s*:\s*"([^"]+)"/g);
			for (const m of nameMatches) {
				models.push(m[1]);
			}
			if (models.length > 0) agents.modelPreferences = models;
		} catch { /* ignore */ }
	}

	// Set defaults if we detected Claude Flow but couldn't parse specifics
	if (hasClaudeFlow && !agents.topology) agents.topology = 'hierarchical-mesh';
	if (hasClaudeFlow && !agents.maxAgents) agents.maxAgents = 8;
	if (!agents.memoryNamespace) {
		const pkg = await readJson<{ name?: string }>(resolve(projectPath, 'package.json'));
		agents.memoryNamespace = pkg?.name ?? basename(projectPath);
	}

	return agents;
}
