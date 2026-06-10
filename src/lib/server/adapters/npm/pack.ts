// TASK 12.3 — `npm pack` file-selection SEMANTICS (the publishable file set + the tarball name),
// computed deterministically WITHOUT shelling out to npm or adding a tar dependency.
//
// `npm pack` decides which files land in the published tarball by a layered rule set
// (docs.npmjs.com/cli/commands/npm-pack + the "files" / .npmignore docs). This module reproduces
// the LOAD-BEARING subset honestly:
//   • If package.json has a `files` array → include ONLY paths matching it (a directory entry
//     includes its whole subtree), PLUS the files npm ALWAYS includes.
//   • Else → include everything EXCEPT the default-ignored set (node_modules, .git, the dotfiles
//     npm drops, etc.) — the .npmignore/.gitignore fallback (we honor `.npmignore` patterns).
//   • npm ALWAYS includes: package.json, the README / LICENSE / LICENCE / CHANGELOG variants, and
//     the `main` entry. npm NEVER includes: node_modules, .git, .npmrc, package-lock.json, npm
//     debug logs, the .DS_Store/.gitignore housekeeping files, and the tarball itself.
// The tarball NAME is npm's exact convention: `<name>-<version>.tgz`, scope flattened
// (`@scope/pkg` → `scope-pkg-1.0.0.tgz`). Output is DETERMINISTIC (sorted) so tests assert it.
//
// This is a PLANNER (it lists what WOULD ship + names the tarball), not a tar writer — the real
// tarball bytes are produced by `npm publish` itself at the gated, deferred real-call site. We
// model the SELECTION, which is the part a dry-run must show honestly.

import { readFile, readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** Files npm ALWAYS includes regardless of `files`/.npmignore (case-insensitive bases). */
const ALWAYS_INCLUDED = new Set(
	['package.json', 'readme', 'license', 'licence', 'changelog', 'changes', 'notice'].map((s) => s.toLowerCase())
);

/** Directory/file bases npm NEVER includes (the default ignore set). */
const ALWAYS_IGNORED_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', 'cvs']);
const ALWAYS_IGNORED_FILES = new Set(
	[
		'.npmrc',
		'package-lock.json',
		'yarn.lock',
		'pnpm-lock.yaml',
		'.gitignore',
		'.npmignore',
		'.ds_store',
		'npm-debug.log',
		'.lock-wscript'
	].map((s) => s.toLowerCase())
);

/** The result of the pack plan — the selected files (posix, sorted) + the tarball name. */
export interface PackPlan {
	/** The files (relative posix paths) that WOULD ship, sorted deterministically. */
	files: string[];
	/** The tarball filename npm would produce (`<flat-name>-<version>.tgz`). */
	tarball: string;
	/** True iff a `files` allow-list drove the selection (vs the ignore-fallback). */
	usedFilesArray: boolean;
	/** Honest notes about the selection (e.g. "files[] present", "default ignore set"). */
	notes: string[];
}

/** Flatten an npm name to the tarball basename: `@scope/pkg` → `scope-pkg`, else the name. */
export function flattenName(name: string): string {
	return name.startsWith('@') ? name.slice(1).replace('/', '-') : name;
}

/** The exact tarball filename npm pack produces for a name@version. */
export function tarballName(name: string, version: string): string {
	return `${flattenName(name)}-${version}.tgz`;
}

/** Recursively list every file under `root` as a relative posix path (skips ignored dirs). */
async function walk(root: string, dir = ''): Promise<string[]> {
	const abs = dir ? join(root, dir) : root;
	let entries: Dirent[];
	try {
		entries = await readdir(abs, { withFileTypes: true });
	} catch {
		return [];
	}
	const out: string[] = [];
	for (const e of entries) {
		const relPath = dir ? `${dir}/${e.name}` : e.name;
		if (e.isDirectory()) {
			if (ALWAYS_IGNORED_DIRS.has(e.name.toLowerCase())) continue;
			out.push(...(await walk(root, relPath)));
		} else if (e.isFile()) {
			out.push(relative(root, join(abs, e.name)).split(sep).join('/'));
		}
	}
	return out;
}

/** The basename of a posix path, lowercased (for the always-include/exclude comparisons). */
function baseLower(p: string): string {
	const b = p.split('/').pop() ?? p;
	return b.toLowerCase();
}

/** Strip a known extension so `README.md`/`LICENSE.txt` match the always-included bases. */
function stemLower(p: string): string {
	return baseLower(p).replace(/\.[^.]+$/, '');
}

/** True iff a file is in npm's always-include set (README/LICENSE/CHANGELOG/package.json). */
function isAlwaysIncluded(rel: string): boolean {
	// Only top-level README/LICENSE/etc. are auto-included; nested ones follow the normal rules.
	if (rel.includes('/')) return false;
	return ALWAYS_INCLUDED.has(baseLower(rel)) || ALWAYS_INCLUDED.has(stemLower(rel));
}

/** True iff a file is in npm's always-ignore set. */
function isAlwaysIgnored(rel: string): boolean {
	const segs = rel.split('/');
	if (segs.some((s) => ALWAYS_IGNORED_DIRS.has(s.toLowerCase()))) return true;
	const base = baseLower(rel);
	if (ALWAYS_IGNORED_FILES.has(base)) return true;
	// npm debug logs + the produced tarball itself.
	if (/^npm-debug\.log/.test(base) || /\.tgz$/.test(base)) return true;
	return false;
}

/**
 * Does `rel` match a single `files` entry? npm `files` entries behave like include globs:
 *   • an exact file path matches that file;
 *   • a directory name (or `dir/`) matches the whole subtree;
 *   • a `*` glob matches within a path segment.
 * We implement the load-bearing cases (exact, directory-prefix, simple `*`/`**` glob).
 */
function matchesFilesEntry(rel: string, entry: string): boolean {
	const e = entry.replace(/^\.\//, '').replace(/\/+$/, '');
	if (!e) return false;
	if (rel === e) return true;
	// Directory prefix: "dist" matches "dist/**".
	if (rel.startsWith(`${e}/`)) return true;
	// Glob → regex (safe translation of ** / * with the literals escaped).
	if (e.includes('*')) {
		if (globToRegExp(e).test(rel)) return true;
		// A glob like "dist/*" should also match a directory's subtree when used as a prefix.
		if (e.endsWith('/*') && rel.startsWith(e.slice(0, -1))) return true;
	}
	return false;
}

/** Parse a `.npmignore` (or `.gitignore`) into simple ignore patterns (comments/blank dropped). */
async function readIgnore(root: string): Promise<string[]> {
	for (const f of ['.npmignore', '.gitignore']) {
		try {
			const raw = await readFile(join(root, f), 'utf8');
			return raw
				.split(/\r?\n/)
				.map((l) => l.trim())
				.filter((l) => l && !l.startsWith('#'));
		} catch {
			// try the next file
		}
	}
	return [];
}

/**
 * Translate a glob (supporting `**`, `*`, and literals) to an anchored RegExp SAFELY: split on
 * the glob tokens FIRST, then escape only the literal segments (so `**`/`*` never reach the regex
 * escaper and never produce an invalid quantifier like `^**`). `**` → `.*`, `*` → `[^/]*`.
 */
function globToRegExp(glob: string): RegExp {
	const body = glob
		.split(/(\*\*|\*)/)
		.map((part) => {
			if (part === '**') return '.*';
			if (part === '*') return '[^/]*';
			return part.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
		})
		.join('');
	return new RegExp('^' + body + '$');
}

/** True iff `rel` is ignored by a simple ignore pattern (prefix-dir or glob, no negation). */
function ignoredByPattern(rel: string, pattern: string): boolean {
	const p = pattern.replace(/^\//, '').replace(/\/+$/, '');
	if (!p || p.startsWith('!')) return false; // negation unsupported in this subset
	if (rel === p) return true;
	if (rel.startsWith(`${p}/`)) return true;
	// A bare name (e.g. "node_modules", "dist") matches that path segment at any depth.
	if (!p.includes('/') && !p.includes('*') && rel.split('/').includes(p)) return true;
	if (p.includes('*')) {
		const rx = globToRegExp(p);
		const base = rel.split('/').pop() ?? rel;
		if (rx.test(base) || rx.test(rel)) return true;
	}
	return false;
}

export interface ComputePackPlanInput {
	/** The project root the package lives in. */
	cwd: string;
	/** The parsed package.json (name/version/files/main). */
	pkg: Record<string, unknown>;
}

/**
 * Compute the `npm pack` file selection + tarball name deterministically. Pure of network; the
 * only IO is reading the project tree + an optional `.npmignore`/`.gitignore` (all confined to
 * cwd). The selection mirrors npm's layered rules; the result is SORTED so it is reproducible.
 */
export async function computePackPlan(input: ComputePackPlanInput): Promise<PackPlan> {
	const { cwd, pkg } = input;
	const name = typeof pkg.name === 'string' ? pkg.name : 'package';
	const version = typeof pkg.version === 'string' ? pkg.version : '0.0.0';
	const filesArray = Array.isArray(pkg.files) ? (pkg.files as unknown[]).map(String).filter(Boolean) : null;
	const mainEntry = typeof pkg.main === 'string' ? pkg.main.replace(/^\.\//, '') : null;
	const notes: string[] = [];

	const all = await walk(cwd);
	const selected = new Set<string>();

	if (filesArray && filesArray.length > 0) {
		notes.push(`"files" allow-list (${filesArray.length} pattern(s)) — only matching paths ship, plus npm's always-included files.`);
		for (const rel of all) {
			if (isAlwaysIgnored(rel)) continue;
			if (isAlwaysIncluded(rel)) {
				selected.add(rel);
				continue;
			}
			if (filesArray.some((entry) => matchesFilesEntry(rel, entry))) selected.add(rel);
		}
		// The `main` entry is always included even if `files` would exclude it.
		if (mainEntry && all.includes(mainEntry) && !isAlwaysIgnored(mainEntry)) {
			selected.add(mainEntry);
		}
	} else {
		const ignore = await readIgnore(cwd);
		notes.push(
			ignore.length
				? `No "files" array — shipping everything except npm's default ignores + ${ignore.length} .npmignore/.gitignore pattern(s).`
				: 'No "files" array and no .npmignore — shipping everything except npm\'s default ignore set.'
		);
		for (const rel of all) {
			if (isAlwaysIgnored(rel)) continue;
			if (isAlwaysIncluded(rel)) {
				selected.add(rel);
				continue;
			}
			if (ignore.some((pat) => ignoredByPattern(rel, pat))) continue;
			selected.add(rel);
		}
	}

	// package.json is ALWAYS in the tarball.
	if (all.includes('package.json')) selected.add('package.json');

	return {
		files: [...selected].sort(),
		tarball: tarballName(name, version),
		usedFilesArray: !!(filesArray && filesArray.length > 0),
		notes
	};
}
