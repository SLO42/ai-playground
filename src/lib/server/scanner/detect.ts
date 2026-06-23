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
 * Map a BARE detected build tool (what `LANGUAGE_RULES[].buildTool` emits and what
 * `project.build_tool` persists — e.g. 'dotnet'/'npm'/'cargo') to a REAL build INVOCATION
 * (program + args) that actually compiles the project. This is the SINGLE SOURCE OF TRUTH
 * for "given the tool, how do I really build it" — the release gate maps through it so a
 * bare tool name (e.g. `dotnet`, which exits 0 WITHOUT building) can never produce a false
 * GREEN on an unbuilt artifact.
 *
 * Returns null for an unknown OR un-buildable tool (e.g. 'pip' — Python has no single
 * standard build step). A null is the FAIL-CLOSED signal: the caller must treat it as a RED
 * build, never as "no build needed". Each command is split into program + argv (no shell —
 * it is run through execFile, D-008): the args carry the verb/flags as literal argv tokens.
 */
const BUILD_COMMANDS: Record<string, { file: string; args: string[] }> = {
	// .NET: bare `dotnet` is a no-op launcher that exits 0; the real compile is `dotnet build`.
	dotnet: { file: 'dotnet', args: ['build', '-c', 'Release'] },
	npm: { file: 'npm', args: ['run', 'build'] },
	cargo: { file: 'cargo', args: ['build', '--release'] },
	gradle: { file: 'gradle', args: ['build'] },
	maven: { file: 'mvn', args: ['-B', '-q', 'package'] },
	go: { file: 'go', args: ['build', './...'] }
	// 'pip' is intentionally ABSENT — Python has no single standard build step, so it maps to
	// null and the release gate FAILS CLOSED rather than publishing an unverified artifact.
};

export function buildCommandFor(tool: string | undefined | null): { file: string; args: string[] } | null {
	if (!tool) return null;
	const key = tool.trim().toLowerCase();
	if (!key) return null;
	const mapped = BUILD_COMMANDS[key];
	return mapped ? { file: mapped.file, args: [...mapped.args] } : null;
}

/**
 * Resolve a REAL test command for a BARE detected build tool — but ONLY when a meaningful
 * test target actually exists under `projectRoot`. Mirror of {@link buildCommandFor} for the
 * TEST step (HB-2): the post-task loop must NEVER mark a succeeded task failed (nor, with HB-1,
 * trigger a false "tests failed" follow-up) just because a project carries a stored bare
 * `test_command` (e.g. ROUNDS' `dotnet test`) that exits non-zero only because there is NO test
 * project to run.
 *
 * Returns `null` — an HONEST SKIP — whenever there is no detectable test target, or the tool is
 * unknown/un-testable. A `null` means: do NOT attempt a test (it is neither a pass nor a fail).
 * Fail-closed: this never emits a bare/again-unbuildable token; it only ever returns a command
 * we have positively confirmed has something real to run.
 *
 *   • dotnet  → 'dotnet test' ONLY if a test project is detectable under the root (a
 *               `*.Tests.csproj` / a `*Tests.csproj`, or a csproj whose text references a test
 *               SDK such as Microsoft.NET.Test.Sdk / xunit / nunit / mstest). Absent one → null.
 *               (ROUNDS has a `*.csproj` but NO test project → null → honest skip.)
 *   • npm     → 'npm test' ONLY if a `package.json` declares a `scripts.test` that is not the
 *               npm default no-test stub ("Error: no test specified"). Absent/stub → null.
 *   • cargo   → 'cargo test' when a `Cargo.toml` is present (cargo test is a no-op-OK when there
 *               are no tests; it exits 0, so it is safe to always attempt).
 *   • go      → 'go test ./...' when a `go.mod` is present (go test over zero tests exits 0).
 *   • gradle / maven / pip / unknown → null (no reliable cheap "is there a test target" probe
 *               that won't false-fail; fail-closed to an honest skip rather than risk a false RED).
 */
const TEST_COMMANDS: Record<string, string> = {
	dotnet: 'dotnet test',
	npm: 'npm test',
	cargo: 'cargo test',
	go: 'go test ./...'
};

export function testCommandFor(
	tool: string | undefined | null,
	projectRoot: string | undefined | null
): string | null {
	if (!tool || !projectRoot) return null;
	const key = tool.trim().toLowerCase();
	if (!key) return null;
	const cmd = TEST_COMMANDS[key];
	if (!cmd) return null; // unknown / un-testable tool → honest skip (fail-closed)

	switch (key) {
		case 'dotnet':
			return hasDotnetTestProject(projectRoot) ? cmd : null;
		case 'npm':
			return hasNpmTestScript(projectRoot) ? cmd : null;
		case 'cargo':
			// `cargo test` exits 0 even with zero tests; presence of the crate is enough.
			return hasFile(projectRoot, 'cargo.toml') ? cmd : null;
		case 'go':
			// `go test ./...` exits 0 when no package has tests; presence of the module is enough.
			return hasFile(projectRoot, 'go.mod') ? cmd : null;
		default:
			return null;
	}
}

/** True when a directory listing (case-insensitive, top-level only) contains `name`. */
function hasFile(dir: string, name: string): boolean {
	const lower = name.toLowerCase();
	try {
		return readdirSync(dir).some((e) => e.toLowerCase() === lower);
	} catch {
		return false;
	}
}

/**
 * True when a .NET TEST PROJECT is detectable under `dir`. Two signals (either suffices):
 *   1. a project file named `*.Tests.csproj` / `*Tests.csproj` (the conventional test-project name); or
 *   2. ANY `*.csproj` whose text references a test SDK (Microsoft.NET.Test.Sdk) or a test
 *      framework (xunit / nunit / MSTest) — i.e. a project that actually carries tests.
 * Bounded recursion (test projects often live under `test/` or `tests/`, one or two levels down).
 * Absent both → false → the loop SKIPS the test (ROUNDS: a bare `*.csproj`, no test project).
 */
function hasDotnetTestProject(dir: string, maxDepth = 3): boolean {
	const TEST_SDK_RE =
		/microsoft\.net\.test\.sdk|xunit|nunit|mstest\.testframework|<istestproject>\s*true/i;
	const SKIP = new Set(['node_modules', '.git', 'target', 'bin', 'obj', 'dist']);
	const walk = (d: string, depth: number): boolean => {
		let entries: string[];
		try {
			entries = readdirSync(d);
		} catch {
			return false;
		}
		for (const e of entries) {
			const lower = e.toLowerCase();
			if (lower.endsWith('.csproj')) {
				// Name convention: SomeName.Tests.csproj / SomeNameTests.csproj.
				if (/tests?\.csproj$/i.test(lower)) return true;
				// Otherwise read the project file and look for a test SDK / framework reference.
				try {
					if (TEST_SDK_RE.test(readFileSync(join(d, e), 'utf8'))) return true;
				} catch {
					/* unreadable — ignore */
				}
			}
			if (depth < maxDepth && !SKIP.has(lower)) {
				try {
					if (statSync(join(d, e)).isDirectory() && walk(join(d, e), depth + 1)) return true;
				} catch {
					/* skip unreadable */
				}
			}
		}
		return false;
	};
	return walk(dir, 0);
}

/**
 * True when the top-level `package.json` declares a REAL `scripts.test` — i.e. one that is not
 * absent and not the `npm init` default no-test stub (`echo "Error: no test specified" && exit 1`),
 * which always exits 1. Absent/stub → false → honest skip (never a false RED for a no-test project).
 */
function hasNpmTestScript(dir: string): boolean {
	try {
		const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
			scripts?: Record<string, unknown>;
		};
		const test = pkg.scripts?.test;
		if (typeof test !== 'string' || !test.trim()) return false;
		// The npm-init default stub deliberately exits 1 — treat it as "no test target".
		return !/no test specified/i.test(test);
	} catch {
		return false;
	}
}

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
