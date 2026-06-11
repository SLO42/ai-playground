// TASK 15.1 (HARVEST B1) — the SCOPE-LOCK edit gate unit matrix (D-018/D-024).
//
// Mechanizes "files to modify is your scope lock": a session that declares an editScope
// gets out-of-scope Edit/Write/NotebookEdit + detectable bash write redirections DENIED
// and a CONFIG-DRIVEN destructive-bash list enforced — all fail-closed, Windows-safe
// (mixed separators, ".." traversal, case games, nonexistent paths, symlinks).
//
// PROVENANCE: boundary shape from gstack freeze/bin/check-freeze.sh, destructive patterns
// from gstack careful/bin/check-careful.sh (MIT) — both fail OPEN upstream; the mechanism
// here is the fail-closed TS reimplementation. The destructive pattern LISTS are loaded
// from the REAL operator config (config/gates.yaml) so this suite also proves the shipped
// defaults compile and bite (requirement (b): patterns ship in config, not hardcoded).
//
// SHADOW PATHS covered per flow: nil input (no editScope ⇒ no scope gating), empty input
// (scopeRoots: [] ⇒ malformed ⇒ throw/deny), upstream error (booby-trapped input ⇒ deny).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
	evaluateGate,
	createGateSession,
	parseEditScope,
	EditScopeError,
	DEFAULT_GATE_POLICY,
	type EditScope,
	type EditScopeInput,
	type GateContext,
	type ToolCall
} from './gates';
import { loadGatesConfig } from '../config/load';

const IS_WINDOWS = process.platform === 'win32';

// The REAL shipped pattern lists (config/gates.yaml) — loaded once; a failure to load or
// compile here is itself a defect (the config must always be loadable).
const GATES_YAML = loadGatesConfig(join(process.cwd(), 'config', 'gates.yaml'));

let root: string;
let outside: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'v2-scope-root-'));
	outside = mkdtempSync(join(tmpdir(), 'v2-scope-out-'));
	mkdirSync(join(root, 'src', 'lib'), { recursive: true });
	mkdirSync(join(root, 'docs'), { recursive: true });
	writeFileSync(join(root, 'src', 'lib', 'a.ts'), 'export const a = 1;\n');
	writeFileSync(join(root, 'docs', 'notes.md'), '# notes\n');
	writeFileSync(join(root, 'docs', 'fails.md'), '# fails\n');
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	rmSync(outside, { recursive: true, force: true });
});

function scope(input?: Partial<EditScopeInput>): EditScope {
	const parsed = parseEditScope({
		scopeRoots: ['src'],
		destructiveBash: GATES_YAML.destructiveBash,
		...input
	});
	if (!parsed) throw new Error('test scope unexpectedly absent');
	return parsed;
}

function ctx(editScope?: EditScope, over: Partial<GateContext> = {}): GateContext {
	return {
		projectRoot: root,
		codeRoot: resolve(root, '..'),
		session: createGateSession(),
		policy: DEFAULT_GATE_POLICY,
		editScope,
		...over
	};
}

function fileCall(name: 'Read' | 'Edit' | 'Write' | 'NotebookEdit', path: string): ToolCall {
	return { name, input: name === 'NotebookEdit' ? { notebook_path: path } : { file_path: path } };
}

function bash(command: string): ToolCall {
	return { name: 'Bash', input: { command } };
}

// ── parseEditScope — strict, fail-closed config parsing (requirement (c)) ───────────

describe('parseEditScope — malformed scope config THROWS (deny upstream), absent is off', () => {
	it('absent (undefined/null) parses to undefined — no scope gating (opt-in)', () => {
		expect(parseEditScope(undefined)).toBeUndefined();
		expect(parseEditScope(null)).toBeUndefined();
	});

	it('compiles a valid scope (roots + allow globs + the shipped pattern lists)', () => {
		const s = parseEditScope({
			scopeRoots: ['src', 'F:/abs/path'],
			scopeAllow: ['**/docs/fails.md'],
			destructiveBash: GATES_YAML.destructiveBash
		});
		expect(s).toBeDefined();
		expect(s!.scopeRoots).toEqual(['src', 'F:/abs/path']);
		expect(s!.scopeAllow).toHaveLength(1);
		expect(s!.destructiveDeny.length).toBeGreaterThan(0);
		expect(s!.destructiveAllow.length).toBeGreaterThan(0);
	});

	it.each([
		['non-object', 'nope'],
		['array', ['src']],
		['missing scopeRoots', {}],
		['EMPTY scopeRoots (shadow path: empty input)', { scopeRoots: [] }],
		['non-string root', { scopeRoots: [42] }],
		['blank root', { scopeRoots: ['  '] }],
		['non-array scopeAllow', { scopeRoots: ['src'], scopeAllow: 'glob' }],
		['non-string scopeAllow entry', { scopeRoots: ['src'], scopeAllow: [1] }],
		['array destructiveBash', { scopeRoots: ['src'], destructiveBash: [] }],
		['non-list deny', { scopeRoots: ['src'], destructiveBash: { deny: 'x' } }],
		['entry without id', { scopeRoots: ['src'], destructiveBash: { deny: [{ pattern: 'x' }] } }],
		['entry without pattern', { scopeRoots: ['src'], destructiveBash: { deny: [{ id: 'x' }] } }],
		[
			'UNCOMPILABLE pattern',
			{ scopeRoots: ['src'], destructiveBash: { deny: [{ id: 'bad', pattern: '(' }] } }
		]
	])('throws EditScopeError on %s', (_label, raw) => {
		expect(() => parseEditScope(raw)).toThrow(EditScopeError);
	});
});

// ── the scope check: file-writing tools ──────────────────────────────────────────────

describe('edit-scope — file-writing tools inside/outside the declared roots', () => {
	it('allows Write inside a scope root, and Edit/NotebookEdit after a Read', () => {
		const c = ctx(scope());
		expect(evaluateGate(fileCall('Write', join(root, 'src', 'new.ts')), c).decision).toBe('allow');
		expect(evaluateGate(fileCall('Read', join(root, 'src', 'lib', 'a.ts')), c).decision).toBe(
			'allow'
		);
		expect(evaluateGate(fileCall('Edit', join(root, 'src', 'lib', 'a.ts')), c).decision).toBe(
			'allow'
		);
		// NotebookEdit is read-before-edit-gated like Edit (pre-existing 2.13 family) —
		// in-scope + previously-Read passes BOTH families.
		const nb = join(root, 'src', 'nb.ipynb');
		writeFileSync(nb, '{}\n');
		expect(evaluateGate(fileCall('Read', nb), c).decision).toBe('allow');
		expect(evaluateGate(fileCall('NotebookEdit', nb), c).decision).toBe('allow');
	});

	it('DENIES Write outside the scope roots (inside the project — confinement alone would allow)', () => {
		const r = evaluateGate(fileCall('Write', join(root, 'docs', 'notes.md')), ctx(scope()));
		expect(r.decision).toBe('deny');
		expect(r.gate).toBe('edit-scope');
		expect(r.reason).toMatch(/outside the declared edit scope/);
	});

	it('DENIES Edit outside the scope even after a Read (scope is not read-before-edit)', () => {
		const c = ctx(scope());
		expect(evaluateGate(fileCall('Read', join(root, 'docs', 'notes.md')), c).decision).toBe(
			'allow'
		);
		const r = evaluateGate(fileCall('Edit', join(root, 'docs', 'notes.md')), c);
		expect(r.decision).toBe('deny');
		expect(r.gate).toBe('edit-scope');
	});

	it('Read outside the scope is ALLOWED — the scope lock gates writes, not reads', () => {
		const r = evaluateGate(fileCall('Read', join(root, 'docs', 'notes.md')), ctx(scope()));
		expect(r.decision).toBe('allow');
	});

	it('a scopeAllow glob excepts a shared file outside the roots (docs/fails.md)', () => {
		const s = scope({ scopeAllow: ['**/docs/fails.md'] });
		const allowed = evaluateGate(fileCall('Write', join(root, 'docs', 'fails.md')), ctx(s));
		expect(allowed.decision).toBe('allow');
		// …and the exception is exact: a sibling file still denies.
		const denied = evaluateGate(fileCall('Write', join(root, 'docs', 'notes.md')), ctx(s));
		expect(denied.decision).toBe('deny');
	});

	it('a scope root may be a single FILE (editing exactly that file is in scope)', () => {
		const s = scope({ scopeRoots: ['docs/fails.md'] });
		expect(evaluateGate(fileCall('Write', join(root, 'docs', 'fails.md')), ctx(s)).decision).toBe(
			'allow'
		);
		expect(evaluateGate(fileCall('Write', join(root, 'docs', 'notes.md')), ctx(s)).decision).toBe(
			'deny'
		);
	});

	it('nil editScope (shadow path: nil input) ⇒ NO scope gating — legacy behaviour intact', () => {
		const r = evaluateGate(fileCall('Write', join(root, 'docs', 'notes.md')), ctx(undefined));
		expect(r.decision).toBe('allow');
	});

	it('a booby-trapped input (shadow path: upstream error) still fails CLOSED', () => {
		const evil: ToolCall = {
			name: 'Write',
			input: new Proxy(
				{},
				{
					get() {
						throw new Error('boom');
					}
				}
			)
		};
		expect(evaluateGate(evil, ctx(scope())).decision).toBe('deny');
	});
});

// ── Windows path tricks (requirement (a)) ────────────────────────────────────────────

describe('edit-scope — Windows-safe path comparison', () => {
	it('mixed separators: a backslash target matches a forward-slash scope root (and vice versa)', () => {
		const s = scope({ scopeRoots: [join(root, 'src').replace(/\\/g, '/')] });
		const target = join(root, 'src', 'x.ts').replace(/\//g, '\\');
		expect(evaluateGate(fileCall('Write', target), ctx(s)).decision).toBe('allow');
	});

	it('".." traversal: an in-scope-LOOKING path that escapes the root after normalization denies', () => {
		const sneaky = join(root, 'src', '..', 'docs', 'notes.md');
		const r = evaluateGate(fileCall('Write', sneaky), ctx(scope()));
		expect(r.decision).toBe('deny');
		expect(r.gate).toBe('edit-scope');
	});

	it.runIf(IS_WINDOWS)('case games: a case-respelled SCOPE ROOT still matches its real target (NTFS)', () => {
		// The scope comparison itself is case-insensitive on win32: a root declared in the
		// "wrong" case must still confine/match the on-disk spelling. (A case-respelled
		// TARGET path is additionally denied upstream by the 13.5 path-confinement resolver
		// — conservative fail-closed, never a hole.)
		const s = scope({ scopeRoots: [join(root, 'SRC')] });
		expect(evaluateGate(fileCall('Write', join(root, 'src', 'x.ts')), ctx(s)).decision).toBe(
			'allow'
		);
	});

	it.runIf(IS_WINDOWS)('case games cannot smuggle an out-of-scope path either', () => {
		const upper = join(root, 'docs', 'notes.md').toUpperCase();
		expect(evaluateGate(fileCall('Write', upper), ctx(scope())).decision).toBe('deny');
	});

	it('nonexistent target under a scope root is allowed (creates are in-scope writes)', () => {
		const fresh = join(root, 'src', 'brand', 'new', 'file.ts');
		expect(evaluateGate(fileCall('Write', fresh), ctx(scope())).decision).toBe('allow');
	});

	it('nonexistent target outside the roots denies (nearest-ancestor discipline)', () => {
		const fresh = join(root, 'docs', 'brand', 'new.md');
		expect(evaluateGate(fileCall('Write', fresh), ctx(scope())).decision).toBe('deny');
	});

	it('a symlink INSIDE the scope whose REAL target is outside is denied (realpath first)', () => {
		const target = join(outside, 'victim.txt');
		writeFileSync(target, 'outside\n');
		const link = join(root, 'src', 'link-out');
		symlinkSync(target, link, 'file');
		const r = evaluateGate(fileCall('Write', link), ctx(scope()));
		expect(r.decision).toBe('deny');
		expect(r.gate).toBe('edit-scope');
	});

	it('a BROKEN symlink target is unresolvable ⇒ deny (never treated as a fresh create)', () => {
		const link = join(root, 'src', 'dangling');
		symlinkSync(join(outside, 'gone-' + Date.now()), link, 'file');
		const r = evaluateGate(fileCall('Write', link), ctx(scope()));
		expect(r.decision).toBe('deny');
		expect(r.gate).toBe('edit-scope');
	});

	it('relative scope roots resolve against the project root', () => {
		// `scope()` declares 'src' relative — already exercised above; prove an absolute
		// root behaves identically.
		const s = scope({ scopeRoots: [join(root, 'src')] });
		expect(evaluateGate(fileCall('Write', join(root, 'src', 'y.ts')), ctx(s)).decision).toBe(
			'allow'
		);
	});
});

// ── bash write redirections ──────────────────────────────────────────────────────────

describe('edit-scope — detectable bash write redirections', () => {
	it('denies `>` and `>>` targeting outside the scope', () => {
		for (const cmd of [
			`echo hi > ${join(root, 'docs', 'out.txt')}`,
			`echo hi >> ${join(root, 'docs', 'out.txt')}`
		]) {
			const r = evaluateGate(bash(cmd), ctx(scope()));
			expect(r.decision, cmd).toBe('deny');
			expect(r.gate, cmd).toBe('edit-scope');
		}
	});

	it('allows redirections into the scope', () => {
		const r = evaluateGate(bash(`echo hi >> ${join(root, 'src', 'log.txt')}`), ctx(scope()));
		expect(r.decision).toBe('allow');
	});

	// REGRESSION (fix 15.1 gap-2, fail-OPEN): the `>|` clobber-override operator is a real
	// write redirection — its target must be scope-checked. Previously the target char-class
	// aborted on the `|`, extracting NO target, so an out-of-scope `>|` write slipped through.
	it('denies the `>|` clobber-override redirection targeting outside the scope', () => {
		for (const cmd of [
			`echo malicious >| ${join(root, 'docs', 'out.txt')}`,
			`echo malicious >>| ${join(root, 'docs', 'out.txt')}`
		]) {
			const r = evaluateGate(bash(cmd), ctx(scope()));
			expect(r.decision, cmd).toBe('deny');
			expect(r.gate, cmd).toBe('edit-scope');
		}
	});

	it('allows a `>|` clobber-override into the scope', () => {
		const r = evaluateGate(bash(`echo hi >| ${join(root, 'src', 'log.txt')}`), ctx(scope()));
		expect(r.decision).toBe('allow');
	});

	it('denies tee writing outside the scope; allows tee -a inside', () => {
		const denied = evaluateGate(
			bash(`echo x | tee ${join(root, 'docs', 'out.txt')}`),
			ctx(scope())
		);
		expect(denied.decision).toBe('deny');
		expect(denied.gate).toBe('edit-scope');
		const allowed = evaluateGate(
			bash(`echo x | tee -a ${join(root, 'src', 'log.txt')}`),
			ctx(scope())
		);
		expect(allowed.decision).toBe('allow');
	});

	it('ignores the null sinks and fd duplication (no false deny from THIS gate)', () => {
		for (const cmd of ['npm test 2>&1', 'cmd > nul', 'node x.mjs > $null']) {
			expect(evaluateGate(bash(cmd), ctx(scope())).decision, cmd).toBe('allow');
		}
		// `/dev/null` is skipped by the scope gate too — the deny it still gets comes from
		// the PRE-EXISTING path-confinement family (a `/`-rooted token resolves outside the
		// project root — conservative fail-closed, unchanged by 15.1), never from edit-scope.
		const r = evaluateGate(bash('npm test > /dev/null 2>&1'), ctx(scope()));
		expect(r.gate).not.toBe('edit-scope');
	});

	it('denies an AMBIGUOUS redirection target (variable / tilde expansion) — fail closed', () => {
		for (const cmd of ['echo x > $OUT_FILE', 'echo x > ~/escape.txt', 'echo x > `which f`']) {
			const r = evaluateGate(bash(cmd), ctx(scope()));
			expect(r.decision, cmd).toBe('deny');
			expect(r.gate, cmd).toBe('edit-scope');
		}
	});
});

// ── destructive-bash: the CONFIG-DRIVEN deny-list + full-command safe exceptions ─────

describe('edit-scope — destructive-bash patterns (from config/gates.yaml) + safe exceptions', () => {
	it.each([
		['surreal sql --conn ws://127.0.0.1:8000 "REMOVE TABLE project"', 'surreal-remove-ddl'],
		['psql -c "DROP TABLE users"', 'sql-drop'],
		['mysql -e "TRUNCATE sessions"', 'sql-truncate'],
		['git checkout .', 'git-discard-worktree'],
		['git checkout -- .', 'git-discard-worktree'],
		['git restore .', 'git-discard-worktree'],
		['git clean -fd', 'git-clean-force'],
		['git clean -xfd', 'git-clean-force'],
		['docker system prune -a', 'docker-prune'],
		['docker rm -f my-container', 'docker-rm-force'],
		['rm -r src', 'rm-recursive'],
		['npm publish', 'npm-publish'],
		['taskkill /IM node.exe /F', 'taskkill-image']
	])('denies `%s` naming pattern %s', (cmd, id) => {
		const r = evaluateGate(bash(cmd), ctx(scope()));
		expect(r.decision).toBe('deny');
		expect(r.gate).toBe('edit-scope');
		expect(r.reason).toContain(`'${id}'`);
	});

	it('rm -rf of build artifacts passes SILENTLY (full-command safe exception)', () => {
		for (const cmd of [
			'rm -rf node_modules',
			'rm -rf dist build',
			'rm -rf .svelte-kit',
			'rm -rf ./node_modules',
			'rm -rf node_modules/.cache'
		]) {
			expect(evaluateGate(bash(cmd), ctx(scope())).decision, cmd).toBe('allow');
		}
	});

	it('the exception is FULL-COMMAND: a chained destructive command still denies', () => {
		const r = evaluateGate(bash('rm -rf node_modules && git checkout .'), ctx(scope()));
		expect(r.decision).toBe('deny');
	});

	// REGRESSION (fix 15.1 gap-1, fail-OPEN): the artifact safe-exception must NOT permit a
	// `..` traversal suffix after a whitelisted artifact name — `rm -rf node_modules/../src`
	// resolves OUT of scope and previously rode the allow anchor (skipping the deny list AND
	// the static rm rule), defeating the scope-lock. It must now DENY (the allow no longer
	// matches ⇒ the recursive-rm rule fires).
	it.each([
		'rm -rf node_modules/../src',
		'rm -rf dist/../src/lib',
		'rm -rf node_modules/../../etc',
		'rm -rf .svelte-kit/..',
		'rm -rf node_modules\\..\\src'
	])('DENIES `..` traversal smuggled past the artifact exception: %s', (cmd) => {
		const r = evaluateGate(bash(cmd), ctx(scope()));
		expect(r.decision, cmd).toBe('deny');
	});

	it('legitimate artifact SUBPATHS (no `..`) still pass the exception', () => {
		for (const cmd of [
			'rm -rf node_modules/.cache',
			'rm -rf node_modules/.vite/deps',
			'rm -rf coverage/tmp',
			'rm -rf node_modules/' // trailing separator
		]) {
			expect(evaluateGate(bash(cmd), ctx(scope())).decision, cmd).toBe('allow');
		}
	});

	it('rm -rf of a NON-artifact still denies (the static dangerous-bash family)', () => {
		const r = evaluateGate(bash('rm -rf src'), ctx(scope()));
		expect(r.decision).toBe('deny');
		expect(r.gate).toBe('dangerous-bash');
	});

	it('targeted taskkill by PID does not trip the image-wide pattern (only /IM is destructive)', () => {
		// Assert the PATTERN semantics directly: /IM (image-wide) matches, /PID (targeted)
		// does not. (The full evaluator still conservatively denies `/`-style flag tokens
		// via the pre-existing path-confinement family — a fail-closed false positive that
		// predates 15.1, not an edit-scope decision.)
		const s = scope();
		const taskkillImage = s.destructiveDeny.find((d) => d.id === 'taskkill-image');
		expect(taskkillImage).toBeDefined();
		expect(taskkillImage!.re.test('taskkill /im node.exe /f')).toBe(true);
		expect(taskkillImage!.re.test('taskkill /f /pid 1234')).toBe(false);
		const r = evaluateGate(bash('taskkill /F /PID 1234'), ctx(s));
		expect(r.gate).not.toBe('edit-scope');
	});

	it('benign commands pass untouched', () => {
		for (const cmd of ['npm test', 'git status', 'git commit -m "feat: x"', 'npx vitest run']) {
			expect(evaluateGate(bash(cmd), ctx(scope())).decision, cmd).toBe('allow');
		}
	});

	it('WITHOUT an editScope the safe exception does not exist — rm -rf node_modules still denies (unchanged 2.13 behaviour)', () => {
		const r = evaluateGate(bash('rm -rf node_modules'), ctx(undefined));
		expect(r.decision).toBe('deny');
		expect(r.gate).toBe('dangerous-bash');
	});

	it('git push / --force are NEVER exception-able, even under a scope with allow patterns', () => {
		for (const cmd of ['git push origin main', 'git checkout --force x']) {
			const r = evaluateGate(bash(cmd), ctx(scope()));
			expect(r.decision, cmd).toBe('deny');
			expect(r.gate, cmd).toBe('dangerous-bash');
		}
	});
});
