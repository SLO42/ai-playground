// GUARD — no tracked `.mjs` may carry a shebang terminated by CRLF.
//
// THE FAILURE THIS CLOSES (F-054 family, root-caused 2026-08-05):
// This repo is developed on Windows with `core.autocrlf=true` and, until now, had NO
// `.gitattributes`. Git therefore stored every file LF in the object database but materialised
// it CRLF in the working tree — and normalised CRLF back to LF on the way in, so `git status`
// stayed clean in both cases. The consequence: two worktrees checked out at the SAME sha could
// disagree about the bytes on disk, with git reporting nothing.
//
// For `.mjs` that is not cosmetic. Vite/vitest does not run its esbuild transform over `.mjs`,
// and its shebang strip does not survive a CRLF terminator, so a module beginning
//
//     #!/usr/bin/env node\r\n
//
// fails to parse the instant any vitest test imports it:
//
//     SyntaxError: Invalid or unexpected token
//
// reported at COLLECT time against the IMPORTING test file — which collects 0 tests. The same
// file with LF parses fine, and `node --check` passes on BOTH (Node strips the shebang itself),
// so the breakage is invisible to every check except actually running vitest.
//
// Concretely this silently zeroed 53 passing tests across three suites
// (scripts/memory-pull-mcp.test.js, scripts/peer-send-mcp.test.js,
// tests/verify-flows/lib/runner.test.ts) while looking like a mysterious pre-existing red —
// and produced two agents making irreconcilable "it passes"/"it fails" claims about one commit.
//
// `.gitattributes` (`*.mjs text eol=lf`) fixes it going forward. THIS test is the guard that
// catches a worktree checked out BEFORE that landed, or an editor that re-flips the bytes.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', '.svelte-kit', 'build', 'dist', '.vite']);

/**
 * Classify how a module's shebang line (if any) is terminated.
 *
 * Pure and total — this is the load-bearing predicate, so it is exercised against the nil,
 * empty and malformed inputs below as well as against the real tree.
 *
 * @param {unknown} text file contents
 * @returns {'none'|'lf'|'crlf'} 'none' when there is no shebang at all
 */
export function shebangEol(text) {
	// Shadow path — nil / non-string input: a caller that hands us a read failure, a Buffer,
	// or undefined gets 'none', never a throw. An unreadable file cannot carry a bad shebang.
	if (typeof text !== 'string') return 'none';
	// Shadow path — empty / too-short input: no shebang is possible.
	if (!text.startsWith('#!')) return 'none';
	const nl = text.indexOf('\n');
	// A shebang with no newline at all (single-line file) cannot have a CRLF terminator.
	if (nl === -1) return 'none';
	return text[nl - 1] === '\r' ? 'crlf' : 'lf';
}

/** Recursively collect repo-relative paths of every non-vendored `.mjs` file. */
function listMjs(absDir, out = []) {
	let entries;
	try {
		entries = readdirSync(absDir, { withFileTypes: true });
	} catch {
		// Shadow path — upstream error (unreadable dir: permissions, a race with a deleting
		// process). Skip it rather than failing the guard; the guard's job is to flag bad
		// bytes it CAN see, not to assert the filesystem is readable.
		return out;
	}
	for (const e of entries) {
		if (e.name.startsWith('.') && e.name !== '.') continue;
		const abs = join(absDir, e.name);
		if (e.isDirectory()) {
			if (SKIP_DIRS.has(e.name)) continue;
			listMjs(abs, out);
		} else if (e.isFile() && e.name.endsWith('.mjs')) {
			out.push(relative(REPO_ROOT, abs).split(sep).join('/'));
		}
	}
	return out;
}

describe('guard — `.mjs` shebang line endings (vitest collect-time SyntaxError, F-054)', () => {
	it('classifies shebang terminators, including the nil/empty/no-shebang shadow paths', () => {
		// The bug shape this guard exists to catch.
		expect(shebangEol('#!/usr/bin/env node\r\nexport const a = 1;\n')).toBe('crlf');
		// The healthy shape.
		expect(shebangEol('#!/usr/bin/env node\nexport const a = 1;\n')).toBe('lf');
		// A CRLF file WITHOUT a shebang is not this bug — vite parses it fine, so the guard
		// must not flag it (over-flagging would push people to churn unrelated files).
		expect(shebangEol('export const a = 1;\r\n')).toBe('none');
		// Shadow path — nil / non-string / empty.
		expect(shebangEol(undefined)).toBe('none');
		expect(shebangEol(null)).toBe('none');
		expect(shebangEol('')).toBe('none');
		expect(shebangEol(Buffer.from('#!/usr/bin/env node\r\n'))).toBe('none');
		// Shadow path — a shebang with no newline at all (single-line file).
		expect(shebangEol('#!/usr/bin/env node')).toBe('none');
	});

	it('finds the real `.mjs` files (the guard is actually scanning something)', () => {
		// Without this, a broken walker would make the assertion below vacuously green —
		// the "exclusion that silently retires a suite" failure mode, one level up.
		const files = listMjs(REPO_ROOT);
		expect(files.length).toBeGreaterThan(0);
		expect(files).toContain('scripts/memory-pull-mcp.mjs');
	});

	it('NO tracked `.mjs` terminates its shebang with CRLF', () => {
		const offenders = listMjs(REPO_ROOT).filter((rel) => {
			let text;
			try {
				text = readFileSync(join(REPO_ROOT, rel), 'utf8');
			} catch {
				// Shadow path — upstream read error: skip, do not crash the guard.
				return false;
			}
			return shebangEol(text) === 'crlf';
		});
		expect(
			offenders,
			`These .mjs files terminate their shebang with CRLF. Vitest cannot parse them — any test ` +
				`importing one dies at COLLECT time with "SyntaxError: Invalid or unexpected token" and ` +
				`contributes 0 tests, while \`node --check\` still passes.\n\n` +
				`This is a WORKING-TREE artifact, not a content bug: the git blobs are already LF. ` +
				`Repo .gitattributes pins \`*.mjs text eol=lf\`, but a worktree checked out BEFORE that ` +
				`landed still holds the old CRLF bytes. Repair in place (do NOT use \`git checkout --\`, ` +
				`F-058). Stage-then-rename, never a bare writeFileSync: writeFileSync TRUNCATES first, ` +
				`so an interrupt part-way through the loop would leave a source file empty or half — ` +
				`the exact half-state a re-runnable step must never produce:\n` +
				`  node -e "const fs=require('fs');for(const f of ${JSON.stringify(offenders)}){` +
				`const t=fs.readFileSync(f,'utf8').replace(/\\r\\n/g,'\\n');` +
				`fs.writeFileSync(f+'.eolfix',t);fs.renameSync(f+'.eolfix',f)}"\n\n` +
				`Offenders:`
		).toEqual([]);
	});
});
