// AGENT LIBRARY (operator brain — "Available Agents") — read-only disk index.
//
// The operator wants to BROWSE every specialist agent definition with its CONTEXT
// (when-to-use body, capabilities, type/color/priority, the raw file). Those
// definitions live as `.claude/agents/**/*.md` in the PLATFORM repo's main worktree
// (NOT the v2 app worktree, which has no `.claude`). The cc_agent MIRROR (cc-config
// sync) is no good for this view: (a) its scanner is flat — the library agents are
// nested in category subdirs (development/, core/, …) — and (b) it DROPS the markdown
// body at parse (parse.ts), which is exactly the "when-to-use" the operator asked for.
//
// So this module reads the library DIRECTLY off disk at request time (the persisted
// file is authoritative; F-008 — never fabricated), reusing the existing frontmatter
// splitter. It is READ-only, bounded, and degrades honestly when the library dir is
// not configured/resolvable (the view shows an honest "library not found" state, never
// invented agents).
//
// Boundary discipline: the single-file reader confines the caller-supplied relative
// path under the resolved agents dir (realpath/`..`-normalized) before reading — a
// traversal attempt fails closed (validate-at-the-edge).

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { splitFrontmatter } from '../cc-config/parse';

/** One specialist agent definition, enriched with its frontmatter context. */
export interface LibraryAgent {
	/** Agent name (frontmatter.name, or the filename stem). The catalog key + usage-bridge slug. */
	name: string;
	/** One-line role/description from frontmatter, or null. */
	description: string | null;
	/** frontmatter.type (e.g. "developer", "development"), or null. */
	type: string | null;
	/** frontmatter.color (hex), used for the type badge accent, or null. */
	color: string | null;
	/** frontmatter.priority (e.g. "high"), or null. */
	priority: string | null;
	/** frontmatter.category, else the first agents-dir subfolder (e.g. "development"), or null. */
	category: string | null;
	/** frontmatter.capabilities coerced to a clean string[] (empty when none declared). */
	capabilities: string[];
	/** Path RELATIVE to the agents dir (POSIX-style) — the stable id + the content-read key. */
	relPath: string;
}

/** The full content of one agent file (for the detail view). */
export interface LibraryAgentContent {
	relPath: string;
	/** The markdown BODY after the frontmatter — the "when-to-use" / instructions. */
	whenToUse: string;
	/** The complete raw file (frontmatter + body) for the collapsible raw view. */
	raw: string;
}

/** Hard cap on files walked — a runaway/looping tree never blocks the loader (F-014). */
const MAX_FILES = 2000;
/** Hard cap on a single returned raw file (defensive — agent files are ~tens of KB). */
const MAX_RAW_BYTES = 256 * 1024;

const LIBRARY_DIR_ENV = 'AGENT_LIBRARY_CLAUDE_DIR';

function asStringList(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	return v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim());
}

function str(v: unknown): string | null {
	if (v == null) return null;
	if (typeof v === 'string') return v.trim() || null;
	if (typeof v === 'number' || typeof v === 'boolean') return String(v);
	return null;
}

/**
 * Resolve the platform repo's `.claude` dir WITHOUT a subprocess. The app may run from a
 * linked git WORKTREE (e.g. F:\code\ai-playground-v2) whose `<cwd>/.git` is a FILE pointing
 * at the common git dir; the agent library lives in the MAIN worktree's `.claude`. A normal
 * checkout has `<cwd>/.git` as a directory, so `<cwd>/.claude` is the library. Returns null
 * if the relationship cannot be resolved (the caller falls back to the honest "not found").
 */
function deriveMainWorktreeClaudeDir(cwd: string): string | null {
	try {
		const dotGit = join(cwd, '.git');
		if (!existsSync(dotGit)) return null;
		if (statSync(dotGit).isDirectory()) return join(cwd, '.claude');
		// Linked worktree: ".git" is a file "gitdir: <commonGit>/worktrees/<name>".
		const txt = readFileSync(dotGit, 'utf8');
		const m = /gitdir:\s*(.+)/.exec(txt);
		if (!m) return null;
		const gitdirPosix = m[1].trim().replace(/\\/g, '/');
		const wtIdx = gitdirPosix.toLowerCase().indexOf('/worktrees/');
		// commonGit = "<repo>/.git"; strip "/worktrees/<name>" if present.
		const commonGit = wtIdx >= 0 ? gitdirPosix.slice(0, wtIdx) : gitdirPosix;
		// repo root = parent of the ".git" dir.
		const repoRoot = commonGit.replace(/\/\.git$/i, '');
		if (repoRoot === commonGit) return null; // pointer didn't end in /.git — unrecognized
		return join(repoRoot, '.claude');
	} catch {
		return null;
	}
}

/**
 * The absolute path to the agent library's `.claude/agents` dir, or null when it cannot be
 * resolved. Resolution (most → least specific):
 *   1. `$AGENT_LIBRARY_CLAUDE_DIR/agents` when the env points at a `.claude` dir (operator/test);
 *   2. else the MAIN git-worktree's `.claude/agents`, derived from the cwd's `.git` pointer.
 * The chosen path is validated: it must EXIST and be a directory. `env`/`cwd` are injectable
 * for tests.
 */
export function agentLibraryAgentsDir(
	env: NodeJS.ProcessEnv = process.env,
	cwd: string = process.cwd()
): string | null {
	const explicit = env[LIBRARY_DIR_ENV]?.trim();
	const claudeDir = explicit ? resolve(explicit) : deriveMainWorktreeClaudeDir(cwd);
	if (!claudeDir) return null;
	const agentsDir = join(claudeDir, 'agents');
	try {
		if (existsSync(agentsDir) && statSync(agentsDir).isDirectory()) return agentsDir;
	} catch {
		/* fall through to null */
	}
	return null;
}

/** Recursively collect `*.md` file paths under `dir` (bounded by MAX_FILES). */
function walkMd(dir: string, out: string[], budget: { n: number }): void {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const e of entries) {
		if (budget.n >= MAX_FILES) return;
		const full = join(dir, e);
		let isDir = false;
		try {
			isDir = statSync(full).isDirectory();
		} catch {
			continue;
		}
		if (isDir) {
			walkMd(full, out, budget);
		} else if (e.toLowerCase().endsWith('.md')) {
			out.push(full);
			budget.n++;
		}
	}
}

/** POSIX-style relative path (stable across platforms) of `file` under `agentsDir`. */
function relPosix(agentsDir: string, file: string): string {
	return relative(agentsDir, file).split(sep).join('/');
}

/**
 * List every specialist agent in the library (recursively), parsed into {@link LibraryAgent}.
 * Sorted by name. Returns [] when the library dir is not configured/resolvable or empty — an
 * HONEST empty (the caller renders "library not found", never fabricated agents; F-008). One
 * malformed file degrades to its filename + empty metadata rather than dropping the rest.
 */
export function listLibraryAgents(
	env: NodeJS.ProcessEnv = process.env,
	cwd: string = process.cwd()
): LibraryAgent[] {
	const agentsDir = agentLibraryAgentsDir(env, cwd);
	if (!agentsDir) return [];
	const files: string[] = [];
	walkMd(agentsDir, files, { n: 0 });

	const out: LibraryAgent[] = [];
	for (const file of files) {
		let text: string;
		try {
			text = readFileSync(file, 'utf8');
		} catch {
			continue;
		}
		const { frontmatter: fm } = splitFrontmatter(text);
		const rel = relPosix(agentsDir, file);
		const stem = (rel.split('/').pop() ?? rel).replace(/\.md$/i, '');
		const firstSeg = rel.includes('/') ? rel.split('/')[0] : null;
		out.push({
			name: str(fm.name) ?? stem,
			description: str(fm.description),
			type: str(fm.type),
			color: str(fm.color),
			priority: str(fm.priority),
			category: str(fm.category) ?? firstSeg,
			capabilities: asStringList(fm.capabilities),
			relPath: rel
		});
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Read ONE agent file's full content for the detail view: its body (when-to-use) and the raw
 * file. `relPath` is the value listed in {@link LibraryAgent.relPath}; it is CONFINED under the
 * resolved agents dir (`..`/absolute-escape attempts fail closed) and must resolve to an
 * existing `.md` file. Returns null when the library is unresolvable or the path is invalid /
 * unreadable (the detail panel shows an honest "file not readable", never fabricated text).
 */
export function readLibraryAgentContent(
	relPath: string,
	env: NodeJS.ProcessEnv = process.env,
	cwd: string = process.cwd()
): LibraryAgentContent | null {
	const agentsDir = agentLibraryAgentsDir(env, cwd);
	if (!agentsDir) return null;
	if (typeof relPath !== 'string' || !relPath.trim()) return null;
	// Confine: the resolved target must stay strictly under agentsDir and be a .md file.
	const target = resolve(agentsDir, relPath);
	const rootWithSep = agentsDir.endsWith(sep) ? agentsDir : agentsDir + sep;
	const cmp = process.platform === 'win32' ? target.toLowerCase() : target;
	const cmpRoot = process.platform === 'win32' ? rootWithSep.toLowerCase() : rootWithSep;
	if (!cmp.startsWith(cmpRoot)) return null; // escaped the library — fail closed
	if (!target.toLowerCase().endsWith('.md')) return null;
	let raw: string;
	try {
		if (!statSync(target).isFile()) return null;
		raw = readFileSync(target, 'utf8');
	} catch {
		return null;
	}
	if (raw.length > MAX_RAW_BYTES) raw = raw.slice(0, MAX_RAW_BYTES) + '\n…[truncated]';
	const { body } = splitFrontmatter(raw);
	return { relPath: relPosix(agentsDir, target), whenToUse: body.trim(), raw };
}
