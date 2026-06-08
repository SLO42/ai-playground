// TASK 1.1 — ecosystem / mod-framework detection (carried from v1, ARCHITECTURE §2.7).
//
// Pure, filesystem-reading detection: given a directory, inspect its marker files
// and report the ecosystem(s), build tool, a default test command, and any mod
// framework. NO database, NO process spawn, NO network — this is the deterministic
// core that registry.ts feeds into a `project` upsert.
//
// "Ecosystem" is the DATA-MODEL `project.ecosystem` array (e.g. ["typescript"],
// ["csharp","rounds-mod"]). Mod frameworks (BepInEx/NeoForge/Fabric/Forge) are
// detected from their own metadata files and appended to the ecosystem array so a
// modded project carries both its language and its mod platform.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

/** The outcome of scanning a single directory. */
export interface Detection {
	/** Slug derived from the directory name (lowercase snake/kebab → snake). */
	slug: string;
	/** Human name (the raw directory basename). */
	name: string;
	/** Ordered, de-duplicated ecosystem tags (language(s) first, then mod platforms). */
	ecosystem: string[];
	/** Primary build tool, if one is unambiguous. */
	buildTool?: string;
	/** A sensible default test command for the detected build tool, if any. */
	testCommand?: string;
	/** Mod framework, when the directory is a game mod. */
	modType?: string;
}

/** A directory entry name → predicate that, if a file matches, contributes a signal. */
interface LanguageRule {
	ecosystem: string;
	buildTool?: string;
	testCommand?: string;
	/** True when this rule's marker is present in the directory listing. */
	match: (names: Set<string>, dir: string) => boolean;
}

/** Normalize a directory basename into a D-016-safe slug (snake_case). */
export function slugify(name: string): string {
	const s = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '');
	// Record ids must start with a letter or underscore (validate.ts RECORD_ID_RE).
	return /^[a-z_]/.test(s) ? s : `p_${s}`;
}

/** Language / build-tool rules, evaluated in order; all matches contribute. */
const LANGUAGE_RULES: LanguageRule[] = [
	{
		ecosystem: 'typescript',
		buildTool: 'npm',
		testCommand: 'npm test',
		match: (n) => n.has('package.json') && n.has('tsconfig.json')
	},
	{
		ecosystem: 'javascript',
		buildTool: 'npm',
		testCommand: 'npm test',
		// package.json present but no tsconfig → plain JS.
		match: (n) => n.has('package.json') && !n.has('tsconfig.json')
	},
	{
		ecosystem: 'rust',
		buildTool: 'cargo',
		testCommand: 'cargo test',
		match: (n) => n.has('cargo.toml')
	},
	{
		ecosystem: 'java',
		buildTool: 'gradle',
		testCommand: 'gradle test',
		match: (n) => n.has('build.gradle') || n.has('build.gradle.kts') || n.has('settings.gradle')
	},
	{
		ecosystem: 'java',
		buildTool: 'maven',
		testCommand: 'mvn test',
		match: (n) => n.has('pom.xml')
	},
	{
		ecosystem: 'csharp',
		buildTool: 'dotnet',
		testCommand: 'dotnet test',
		match: (n, dir) => n.has('*.sln') || hasExt(dir, '.csproj') || hasExt(dir, '.sln')
	},
	{
		ecosystem: 'python',
		buildTool: 'pip',
		testCommand: 'pytest',
		match: (n) => n.has('pyproject.toml') || n.has('setup.py') || n.has('requirements.txt')
	},
	{
		ecosystem: 'go',
		buildTool: 'go',
		testCommand: 'go test ./...',
		match: (n) => n.has('go.mod')
	}
];

/**
 * True when any file under `dir` (bounded recursive, depth ≤ `maxDepth`) ends
 * with `ext`. Mod/.NET project files frequently live one or two levels down
 * (e.g. `src/SWIP.csproj`), so a top-level-only check misses them.
 */
function hasExt(dir: string, ext: string, maxDepth = 2): boolean {
	const lowerExt = ext.toLowerCase();
	const walk = (d: string, depth: number): boolean => {
		let entries: string[];
		try {
			entries = readdirSync(d);
		} catch {
			return false;
		}
		for (const e of entries) {
			if (e.toLowerCase().endsWith(lowerExt)) return true;
			if (depth < maxDepth) {
				const child = join(d, e);
				try {
					if (statSync(child).isDirectory() && walk(child, depth + 1)) return true;
				} catch {
					/* skip unreadable */
				}
			}
		}
		return false;
	};
	return walk(dir, 0);
}

/** Detect a game-mod framework from metadata files. Returns the mod tag or undefined. */
function detectModType(names: Set<string>, dir: string): string | undefined {
	// BepInEx / Unity mods (ROUNDS SWIP profile: C# + BepInEx + Thunderstore manifest).
	// A bare top-level manifest.json is ambiguous (npm-adjacent), so require it to
	// live under a thunderstore/ dir, or an explicit BepInEx marker.
	if (
		names.has('bepinex') ||
		findFile(dir, 'manifest.json', (parent) => parent.toLowerCase() === 'thunderstore')
	) {
		return 'bepinex';
	}
	// NeoForge / Forge / Fabric (Minecraft) — their metadata files are diagnostic and
	// commonly buried under src/main/resources/META-INF (deep), so search recursively.
	if (findFile(dir, 'neoforge.mods.toml')) return 'neoforge';
	if (findFile(dir, 'mods.toml')) return 'forge';
	if (findFile(dir, 'fabric.mod.json')) return 'fabric';
	return undefined;
}

/**
 * Bounded recursive search for a file named `file` (case-insensitive) anywhere
 * under `dir` (depth ≤ `maxDepth`). When `parentMatch` is given, the file only
 * counts if its immediate parent directory name satisfies the predicate.
 * Skips node_modules / .git for speed and to avoid false positives.
 */
function findFile(
	dir: string,
	file: string,
	parentMatch?: (parentName: string) => boolean,
	maxDepth = 5
): boolean {
	const lower = file.toLowerCase();
	const SKIP = new Set(['node_modules', '.git', 'target', 'bin', 'obj', 'dist']);
	const walk = (d: string, parentName: string, depth: number): boolean => {
		let entries: string[];
		try {
			entries = readdirSync(d);
		} catch {
			return false;
		}
		for (const e of entries) {
			const child = join(d, e);
			if (e.toLowerCase() === lower) {
				if (!parentMatch || parentMatch(parentName)) return true;
			}
			if (depth < maxDepth && !SKIP.has(e.toLowerCase())) {
				try {
					if (statSync(child).isDirectory() && walk(child, e, depth + 1)) return true;
				} catch {
					/* skip unreadable */
				}
			}
		}
		return false;
	};
	return walk(dir, basename(dir), 0);
}

/**
 * Detect the ecosystem(s) and mod framework of a directory by reading its marker
 * files. Pure (no DB/spawn). Throws if `dir` is not a readable directory.
 */
export function detectEcosystem(dir: string): Detection {
	const stat = statSync(dir); // throws ENOENT/ENOTDIR — caller validates the path first
	if (!stat.isDirectory()) {
		throw new Error(`Not a directory: ${dir}`);
	}

	const entries = readdirSync(dir);
	const names = new Set(entries.map((e) => e.toLowerCase()));

	const ecosystem: string[] = [];
	let buildTool: string | undefined;
	let testCommand: string | undefined;

	for (const rule of LANGUAGE_RULES) {
		if (rule.match(names, dir)) {
			if (!ecosystem.includes(rule.ecosystem)) ecosystem.push(rule.ecosystem);
			// First matching rule wins for the build tool / test command.
			if (!buildTool && rule.buildTool) {
				buildTool = rule.buildTool;
				testCommand = rule.testCommand;
			}
		}
	}

	const modType = detectModType(names, dir);
	if (modType && !ecosystem.includes(modType)) ecosystem.push(modType);

	const name = basename(dir.replace(/[\\/]+$/, ''));
	return {
		slug: slugify(name),
		name,
		ecosystem,
		...(buildTool ? { buildTool } : {}),
		...(testCommand ? { testCommand } : {}),
		...(modType ? { modType } : {})
	};
}

/** Optional: read a project's repo url from a `.git/config` if present (best-effort). */
export function readRepoUrl(dir: string): string | undefined {
	const cfg = join(dir, '.git', 'config');
	try {
		const text = readFileSync(cfg, 'utf8');
		const m = text.match(/url\s*=\s*(\S+)/);
		return m?.[1];
	} catch {
		return undefined;
	}
}
