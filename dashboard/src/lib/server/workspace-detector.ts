import { resolve, basename } from 'path';
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';

export interface WorkspaceInfo {
	type: 'npm' | 'yarn' | 'pnpm' | 'cargo' | 'dotnet' | 'gradle' | null;
	root: string;
	packages: WorkspacePackage[];
}

export interface WorkspacePackage {
	name: string;
	path: string;
	version: string | null;
	dependencies: string[];
	devDependencies: string[];
	scripts: Record<string, string>;
}

type WsType = 'npm' | 'yarn' | 'pnpm' | 'cargo' | 'dotnet' | 'gradle';
const SKIP_DIRS = new Set(['node_modules', '.git', 'bin', 'obj']);

function readJsonSync<T>(p: string): T | null {
	try { return JSON.parse(readFileSync(p, 'utf-8')) as T; } catch { return null; }
}

function fileExists(p: string): boolean {
	try { return existsSync(p); } catch { return false; }
}

function readTextSync(p: string): string | null {
	try { return readFileSync(p, 'utf-8'); } catch { return null; }
}

/** Expand workspace globs (e.g. "packages/*") into directories with a marker file */
function expandGlobs(root: string, patterns: string[], marker: string): string[] {
	const dirs: string[] = [];
	for (const pattern of patterns) {
		const cleaned = pattern.replace(/\/\*\*?$/, '').replace(/\*$/, '');
		if (cleaned.includes('*')) continue;
		const base = resolve(root, cleaned);
		if (!fileExists(base)) continue;
		try {
			for (const entry of readdirSync(base)) {
				const full = resolve(base, entry);
				try { if (!statSync(full).isDirectory()) continue; } catch { continue; }
				if (fileExists(resolve(full, marker))) dirs.push(full);
			}
		} catch { /* unreadable */ }
	}
	return dirs;
}

/** Recursively find directories containing .csproj files */
function findCsprojDirs(dir: string, results: string[], depth: number, maxDepth: number): void {
	if (depth > maxDepth) return;
	try {
		for (const entry of readdirSync(dir)) {
			if (SKIP_DIRS.has(entry)) continue;
			if (entry.endsWith('.csproj')) { results.push(dir); return; }
			const full = resolve(dir, entry);
			try { if (statSync(full).isDirectory()) findCsprojDirs(full, results, depth + 1, maxDepth); }
			catch { /* skip */ }
		}
	} catch { /* skip */ }
}

/** Count .csproj files recursively, short-circuiting at threshold */
function countCsprojFiles(dir: string, depth: number, maxDepth: number): number {
	if (depth > maxDepth) return 0;
	let count = 0;
	try {
		for (const entry of readdirSync(dir)) {
			if (SKIP_DIRS.has(entry)) continue;
			if (entry.endsWith('.csproj')) { if (++count >= 2) return count; }
			const full = resolve(dir, entry);
			try {
				if (statSync(full).isDirectory()) {
					count += countCsprojFiles(full, depth + 1, maxDepth);
					if (count >= 2) return count;
				}
			} catch { /* skip */ }
		}
	} catch { /* skip */ }
	return count;
}

/**
 * Detect the workspace/monorepo type from config files.
 * Returns null if the project is not a monorepo.
 */
export function detectWorkspaceType(projectPath: string): WsType | null {
	if (fileExists(resolve(projectPath, 'pnpm-workspace.yaml'))) return 'pnpm';

	const pkg = readJsonSync<{ workspaces?: string[] | { packages?: string[] } }>(
		resolve(projectPath, 'package.json')
	);
	if (pkg?.workspaces) {
		return fileExists(resolve(projectPath, 'yarn.lock')) ? 'yarn' : 'npm';
	}

	const cargoToml = readTextSync(resolve(projectPath, 'Cargo.toml'));
	if (cargoToml && /^\[workspace\]/m.test(cargoToml)) return 'cargo';

	// Gradle multi-project: settings.gradle(.kts) with include statements
	for (const gradleFile of ['settings.gradle.kts', 'settings.gradle']) {
		const gradleSettings = readTextSync(resolve(projectPath, gradleFile));
		if (gradleSettings && /include\s*\(/.test(gradleSettings)) return 'gradle';
	}

	try {
		if (readdirSync(projectPath).some((e) => e.endsWith('.sln'))) {
			if (countCsprojFiles(projectPath, 0, 3) >= 2) return 'dotnet';
		}
	} catch { /* skip */ }

	return null;
}

/** Resolve package directories for a given workspace type */
function resolvePackageDirs(root: string, wsType: WsType): string[] {
	switch (wsType) {
		case 'pnpm': {
			const raw = readTextSync(resolve(root, 'pnpm-workspace.yaml'));
			if (!raw) return [];
			const patterns: string[] = [];
			for (const line of raw.split('\n')) {
				const m = line.match(/^\s*-\s+['"]?([^'"#]+)['"]?\s*$/);
				if (m) patterns.push(m[1].trim());
			}
			return expandGlobs(root, patterns, 'package.json');
		}
		case 'npm':
		case 'yarn': {
			const pkg = readJsonSync<{ workspaces?: string[] | { packages?: string[] } }>(
				resolve(root, 'package.json')
			);
			if (!pkg?.workspaces) return [];
			const patterns = Array.isArray(pkg.workspaces)
				? pkg.workspaces : pkg.workspaces.packages ?? [];
			return expandGlobs(root, patterns, 'package.json');
		}
		case 'cargo': {
			const raw = readTextSync(resolve(root, 'Cargo.toml'));
			if (!raw) return [];
			const wsSection = raw.match(/\[workspace\][^[]*members\s*=\s*\[([\s\S]*?)\]/);
			if (!wsSection) return [];
			const members: string[] = [];
			for (const m of wsSection[1].matchAll(/"([^"]+)"/g)) members.push(m[1]);
			return expandGlobs(root, members, 'Cargo.toml');
		}
		case 'gradle': {
			const dirs: string[] = [];
			for (const gradleFile of ['settings.gradle.kts', 'settings.gradle']) {
				const raw = readTextSync(resolve(root, gradleFile));
				if (!raw) continue;
				// Parse include(":subproject") or include ":subproject", ":other"
				for (const m of raw.matchAll(/include\s*\(?["':]+([^"')]+)["')]/g)) {
					// Gradle uses ':' as path separator for subprojects
					const subPath = m[1].replace(/:/g, '/').replace(/^\//, '');
					const full = resolve(root, subPath);
					if (fileExists(full)) dirs.push(full);
				}
				// Also handle multi-arg include: include(":a", ":b")
				for (const m of raw.matchAll(/include\s*\(([\s\S]*?)\)/g)) {
					const content = m[1];
					for (const sub of content.matchAll(/["']([^"']+)["']/g)) {
						const subPath = sub[1].replace(/^:/, '').replace(/:/g, '/');
						const full = resolve(root, subPath);
						if (fileExists(full) && !dirs.includes(full)) dirs.push(full);
					}
				}
				break;
			}
			return dirs;
		}
		case 'dotnet': {
			const dirs: string[] = [];
			findCsprojDirs(root, dirs, 0, 3);
			return dirs;
		}
	}
}

function readNodePackage(dir: string) {
	const pkg = readJsonSync<{
		name?: string; version?: string;
		dependencies?: Record<string, string>;
		devDependencies?: Record<string, string>;
		scripts?: Record<string, string>;
	}>(resolve(dir, 'package.json'));
	if (!pkg) return null;
	return {
		name: pkg.name ?? basename(dir), path: dir,
		version: pkg.version ?? null,
		allDeps: pkg.dependencies ?? {},
		allDevDeps: pkg.devDependencies ?? {},
		scripts: pkg.scripts ?? {}
	};
}

function parseCargoDepSection(toml: string, header: string): Record<string, string> {
	const deps: Record<string, string> = {};
	const idx = toml.indexOf(header);
	if (idx === -1) return deps;
	for (const line of toml.slice(idx + header.length).split('\n')) {
		const trimmed = line.trim();
		if (trimmed.startsWith('[')) break;
		const simple = trimmed.match(/^([\w-]+)\s*=\s*"([^"]+)"/);
		if (simple) { deps[simple[1]] = simple[2]; continue; }
		const table = trimmed.match(/^([\w-]+)\s*=\s*\{/);
		if (table) deps[table[1]] = '*';
	}
	return deps;
}

function readCargoPackage(dir: string) {
	const raw = readTextSync(resolve(dir, 'Cargo.toml'));
	if (!raw) return null;
	return {
		name: raw.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1] ?? basename(dir),
		path: dir,
		version: raw.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1] ?? null,
		allDeps: parseCargoDepSection(raw, '[dependencies]'),
		allDevDeps: parseCargoDepSection(raw, '[dev-dependencies]'),
		scripts: {} as Record<string, string>
	};
}

function readDotnetPackage(dir: string) {
	let csprojName: string | null = null;
	try {
		csprojName = readdirSync(dir).find((e) => e.endsWith('.csproj')) ?? null;
	} catch { return null; }
	if (!csprojName) return null;

	const raw = readTextSync(resolve(dir, csprojName));
	if (!raw) return null;

	const deps: Record<string, string> = {};
	for (const m of raw.matchAll(/<PackageReference\s+Include="([^"]+)"(?:\s+Version="([^"]+)")?/g))
		deps[m[1]] = m[2] ?? '*';
	for (const m of raw.matchAll(/<ProjectReference\s+Include="([^"]+)"/g))
		deps[basename(m[1]).replace(/\.csproj$/, '')] = '*';

	return {
		name: csprojName.replace(/\.csproj$/, ''), path: dir,
		version: null, allDeps: deps,
		allDevDeps: {} as Record<string, string>,
		scripts: {} as Record<string, string>
	};
}

function readGradlePackage(dir: string): RawPkg | null {
	// Try build.gradle.kts first, then build.gradle
	for (const buildFile of ['build.gradle.kts', 'build.gradle']) {
		const raw = readTextSync(resolve(dir, buildFile));
		if (!raw) continue;

		const deps: Record<string, string> = {};
		// Match: implementation("group:artifact:version") or implementation "group:artifact:version"
		for (const m of raw.matchAll(/(?:implementation|api|compileOnly|runtimeOnly)\s*[\("]+([^"')]+)["')]/g)) {
			const parts = m[1].split(':');
			if (parts.length >= 2) {
				const name = `${parts[0]}:${parts[1]}`;
				deps[name] = parts[2] ?? '*';
			}
		}
		// Match: project(":subproject")
		for (const m of raw.matchAll(/project\s*\(\s*["']:?([^"')]+)["']\s*\)/g)) {
			deps[m[1]] = '*';
		}

		const testDeps: Record<string, string> = {};
		for (const m of raw.matchAll(/testImplementation\s*[\("]+([^"')]+)["')]/g)) {
			const parts = m[1].split(':');
			if (parts.length >= 2) {
				const name = `${parts[0]}:${parts[1]}`;
				testDeps[name] = parts[2] ?? '*';
			}
		}

		const versionMatch = raw.match(/version\s*=\s*["']([^"']+)["']/);
		return {
			name: basename(dir), path: dir,
			version: versionMatch?.[1] ?? null,
			allDeps: deps, allDevDeps: testDeps,
			scripts: {} as Record<string, string>
		};
	}
	return null;
}

type RawPkg = {
	name: string; path: string; version: string | null;
	allDeps: Record<string, string>; allDevDeps: Record<string, string>;
	scripts: Record<string, string>;
};

function readPackageInfo(dir: string, wsType: WsType): RawPkg | null {
	if (wsType === 'cargo') return readCargoPackage(dir);
	if (wsType === 'dotnet') return readDotnetPackage(dir);
	if (wsType === 'gradle') return readGradlePackage(dir);
	return readNodePackage(dir);
}

/** Scan all workspace packages and resolve inter-package dependencies. */
export async function scanWorkspacePackages(projectPath: string): Promise<WorkspacePackage[]> {
	const wsType = detectWorkspaceType(projectPath);
	if (!wsType) return [];

	const packageDirs = resolvePackageDirs(projectPath, wsType);
	if (packageDirs.length === 0) return [];

	const allNames = new Set<string>();
	const rawPackages: RawPkg[] = [];
	for (const dir of packageDirs) {
		const info = readPackageInfo(dir, wsType);
		if (!info) continue;
		allNames.add(info.name);
		rawPackages.push(info);
	}

	return rawPackages.map((raw) => ({
		name: raw.name, path: raw.path, version: raw.version,
		dependencies: Object.keys(raw.allDeps).filter((d) => allNames.has(d)),
		devDependencies: Object.keys(raw.allDevDeps).filter((d) => allNames.has(d)),
		scripts: raw.scripts
	}));
}

/** Build adjacency list: package name -> names of workspace packages it depends on. */
export function buildDependencyGraph(packages: WorkspacePackage[]): Map<string, string[]> {
	const graph = new Map<string, string[]>();
	for (const pkg of packages) {
		graph.set(pkg.name, [...new Set([...pkg.dependencies, ...pkg.devDependencies])]);
	}
	return graph;
}

/**
 * Return packages in topological order (leaves first) using Kahn's algorithm.
 * Cyclic nodes are appended at the end.
 */
export function getTopologicalOrder(packages: WorkspacePackage[]): string[] {
	const graph = buildDependencyGraph(packages);
	const names = packages.map((p) => p.name);

	// in-degree = number of workspace deps this package has
	const inDeg = new Map<string, number>();
	for (const name of names) inDeg.set(name, (graph.get(name) ?? []).length);

	const queue = names.filter((n) => inDeg.get(n) === 0);
	const result: string[] = [];

	while (queue.length > 0) {
		const node = queue.shift()!;
		result.push(node);
		for (const [name, deps] of graph) {
			if (deps.includes(node)) {
				const newDeg = (inDeg.get(name) ?? 1) - 1;
				inDeg.set(name, newDeg);
				if (newDeg === 0) queue.push(name);
			}
		}
	}

	// Append cyclic packages
	for (const name of names) {
		if (!result.includes(name)) result.push(name);
	}
	return result;
}

/**
 * Detect workspace type and resolve all packages with inter-dependencies.
 * Returns null if the project is not a monorepo/workspace.
 */
export async function detectWorkspacePackages(projectPath: string): Promise<WorkspaceInfo | null> {
	const type = detectWorkspaceType(projectPath);
	if (!type) return null;
	const packages = await scanWorkspacePackages(projectPath);
	return { type, root: projectPath, packages };
}

/** Get full workspace info. Returns type: null for non-monorepo projects. */
export async function getWorkspaceInfo(projectPath: string): Promise<WorkspaceInfo> {
	const info = await detectWorkspacePackages(projectPath);
	return info ?? { type: null, root: projectPath, packages: [] };
}
