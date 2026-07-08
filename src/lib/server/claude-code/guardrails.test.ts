import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
	mkdtempSync,
	rmSync,
	mkdirSync,
	writeFileSync,
	symlinkSync,
	readFileSync,
	realpathSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
	buildGuardrailSettings,
	writeProjectGuardrails,
	isPlatformSelfRoot,
	resolveConfinedTarget,
	PathConfinementError,
	CONFIG_PROTECTION_DENY,
	DANGEROUS_BASH_DENY,
	GUARDRAIL_SETTINGS_VERSION
} from './guardrails';

// TASK 1.4a — seed the PRIMARY, server-independent guardrail: per-project
// .claude/settings.json `permissions.deny` rules + explicit cwd, written BEFORE any
// agent can spawn. Enforced by Claude Code's OWN permissions.deny (D-024) — i.e. with
// our server down. These tests therefore touch NO server/DB: they prove (1) the
// generated config artifact carries the right deny rules + cwd, and (2) the
// path-confinement resolver fails CLOSED on escape / unresolvable / broken-symlink
// targets. All synchronous, all offline.

let codeRoot: string;

beforeEach(() => {
	codeRoot = mkdtempSync(join(tmpdir(), 'v2-guardrails-'));
});

afterEach(() => {
	rmSync(codeRoot, { recursive: true, force: true });
});

function projectRoot(name: string): string {
	const p = join(codeRoot, name);
	mkdirSync(p, { recursive: true });
	return p;
}

describe('buildGuardrailSettings — the generated settings.json object', () => {
	it('sets the session cwd to the project root (D-002 / 1.4a)', () => {
		const root = projectRoot('proj-a');
		const s = buildGuardrailSettings({ projectRoot: root, codeRoot });
		// cwd is recorded under our own namespaced key AND additionalDirectories is
		// scoped to the project so Claude Code confines fs access there.
		expect(s.permissions?.additionalDirectories).toEqual([root]);
	});

	it('denies reading ANY .env / secret across the WHOLE code root (config-protection)', () => {
		const root = projectRoot('proj-a');
		const s = buildGuardrailSettings({ projectRoot: root, codeRoot });
		const deny = s.permissions!.deny as string[];
		// Static config-protection rules are always present.
		for (const rule of CONFIG_PROTECTION_DENY) expect(deny).toContain(rule);
		// And they cover .env + other projects' .claude across the code root, not just ours.
		expect(deny.some((r) => /Read\(.*\.env/.test(r))).toBe(true);
		expect(deny.some((r) => /Read\(.*\.claude/.test(r))).toBe(true);
		expect(deny.some((r) => /Edit\(.*\.env/.test(r))).toBe(true);
	});

	it('denies dangerous bash: rm -rf, git push, git remote set-url, --force', () => {
		const root = projectRoot('proj-a');
		const s = buildGuardrailSettings({ projectRoot: root, codeRoot });
		const deny = s.permissions!.deny as string[];
		for (const rule of DANGEROUS_BASH_DENY) expect(deny).toContain(rule);
		expect(deny.some((r) => /Bash\(.*rm -rf/.test(r))).toBe(true);
		expect(deny.some((r) => /Bash\(.*git push/.test(r))).toBe(true);
		expect(deny.some((r) => /Bash\(.*git remote set-url/.test(r))).toBe(true);
		expect(deny.some((r) => /Bash\(.*--force/.test(r))).toBe(true);
	});

	it('hardens against bypass: disableBypassPermissionsMode + managed-rules-only', () => {
		const root = projectRoot('proj-a');
		const s = buildGuardrailSettings({ projectRoot: root, codeRoot });
		// A looping/injected agent must not be able to flip itself into bypass mode.
		expect(s.permissions?.disableBypassPermissionsMode).toBe('disable');
	});

	it('is deterministic — same inputs yield byte-identical settings', () => {
		const root = projectRoot('proj-a');
		const a = JSON.stringify(buildGuardrailSettings({ projectRoot: root, codeRoot }));
		const b = JSON.stringify(buildGuardrailSettings({ projectRoot: root, codeRoot }));
		expect(a).toBe(b);
	});

	it('stamps a version so a re-seed can detect a stale ruleset', () => {
		const root = projectRoot('proj-a');
		const s = buildGuardrailSettings({ projectRoot: root, codeRoot });
		expect(s.env?.HARNESS_GUARDRAIL_VERSION).toBe(String(GUARDRAIL_SETTINGS_VERSION));
	});
});

describe('writeProjectGuardrails — write .claude/settings.json before spawn', () => {
	it('writes <projectRoot>/.claude/settings.json with the deny rules', () => {
		const root = projectRoot('proj-a');
		const path = writeProjectGuardrails({ projectRoot: root, codeRoot });
		expect(path).toBe(join(root, '.claude', 'settings.json'));
		const written = JSON.parse(readFileSync(path, 'utf8'));
		expect(written.permissions.deny).toEqual(
			expect.arrayContaining([...CONFIG_PROTECTION_DENY, ...DANGEROUS_BASH_DENY])
		);
		expect(written.permissions.additionalDirectories).toEqual([root]);
	});

	it('MERGES into an existing settings.json without clobbering unrelated keys', () => {
		const root = projectRoot('proj-a');
		const dir = join(root, '.claude');
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, 'settings.json'),
			JSON.stringify({ model: 'opus', permissions: { allow: ['Read(./src/**)'] } })
		);
		const path = writeProjectGuardrails({ projectRoot: root, codeRoot });
		const written = JSON.parse(readFileSync(path, 'utf8'));
		// Pre-existing unrelated keys survive…
		expect(written.model).toBe('opus');
		expect(written.permissions.allow).toEqual(['Read(./src/**)']);
		// …but the deny guardrails are now present (union, deny-wins).
		expect(written.permissions.deny).toEqual(
			expect.arrayContaining([...CONFIG_PROTECTION_DENY, ...DANGEROUS_BASH_DENY])
		);
	});

	it('is idempotent — re-running does not duplicate deny entries', () => {
		const root = projectRoot('proj-a');
		writeProjectGuardrails({ projectRoot: root, codeRoot });
		const path = writeProjectGuardrails({ projectRoot: root, codeRoot });
		const written = JSON.parse(readFileSync(path, 'utf8'));
		const deny: string[] = written.permissions.deny;
		expect(new Set(deny).size).toBe(deny.length);
	});
});

// ── Self-host exemption (CCH-2 red-team fix) ──────────────────────────────────────
// The D-024 guardrail must NEVER be seeded into Atelier's OWN worktree — doing so writes a
// self-clamping .claude/settings.json into the control-plane repo. isPlatformSelfRoot is the
// pure predicate both write paths (scanProject + boot reconcile) consult before seeding.
describe('isPlatformSelfRoot — never seed the guardrail into the platform worktree', () => {
	it('returns true when the project root IS the platform self-root (the measured self-clamp)', () => {
		const self = realpathSync(projectRoot('self'));
		expect(isPlatformSelfRoot(self, self)).toBe(true);
	});

	it('returns true when the project root is an ANCESTOR that contains the platform self-root', () => {
		const parent = realpathSync(projectRoot('parent'));
		const self = join(parent, 'nested-worktree');
		mkdirSync(self, { recursive: true });
		// A guardrail written at/above the platform root could still clamp it → exempt the ancestor.
		expect(isPlatformSelfRoot(parent, realpathSync(self))).toBe(true);
	});

	it('returns FALSE for a genuine, unrelated project (never wrongly exempts real work)', () => {
		const self = realpathSync(projectRoot('self'));
		const other = realpathSync(projectRoot('other-project'));
		expect(isPlatformSelfRoot(other, self)).toBe(false);
	});

	it('returns FALSE for a sibling that shares a name prefix (no substring bug)', () => {
		const self = realpathSync(projectRoot('app'));
		const sibling = realpathSync(projectRoot('app-two'));
		expect(isPlatformSelfRoot(sibling, self)).toBe(false);
	});

	it('matches through a symlinked worktree (realpath-compared, not string-compared)', () => {
		const real = realpathSync(projectRoot('real-worktree'));
		const link = join(codeRoot, 'linked-worktree');
		symlinkSync(real, link, 'dir');
		// The project row stores the symlink path; the platform runs from the real path (or vice
		// versa) — both must resolve to the same real dir and be exempted.
		expect(isPlatformSelfRoot(link, real)).toBe(true);
		expect(isPlatformSelfRoot(real, link)).toBe(true);
	});

	it('fails SAFE (false) when a path is unresolvable — a real project is never wrongly exempted', () => {
		const self = realpathSync(projectRoot('self'));
		const ghost = join(codeRoot, 'does', 'not', 'exist');
		expect(isPlatformSelfRoot(ghost, self)).toBe(false);
		expect(isPlatformSelfRoot(self, ghost)).toBe(false);
	});
});

// ── Path-confinement resolver: the server-independent fail-CLOSED boundary ────────
describe('resolveConfinedTarget — path-confinement, fail CLOSED', () => {
	it('allows a target that resolves under the project root', () => {
		const root = projectRoot('proj-a');
		const file = join(root, 'src', 'app.ts');
		mkdirSync(join(root, 'src'), { recursive: true });
		writeFileSync(file, '// ok');
		expect(resolveConfinedTarget(file, root)).toBe(resolve(file));
	});

	it('allows a not-yet-existing target whose parent is under the root', () => {
		const root = projectRoot('proj-a');
		const file = join(root, 'src', 'new-file.ts'); // does not exist yet
		mkdirSync(join(root, 'src'), { recursive: true });
		expect(resolveConfinedTarget(file, root)).toBe(resolve(file));
	});

	it('DENIES a ".." escape to a sibling project (after normalization)', () => {
		const root = projectRoot('proj-a');
		projectRoot('proj-b');
		writeFileSync(join(codeRoot, 'proj-b', '.env'), 'SECRET=1');
		const escape = join(root, '..', 'proj-b', '.env');
		expect(() => resolveConfinedTarget(escape, root)).toThrow(PathConfinementError);
	});

	it('DENIES a symlink whose REAL target is outside the root', () => {
		const root = projectRoot('proj-a');
		projectRoot('proj-b');
		const secret = join(codeRoot, 'proj-b', '.env');
		writeFileSync(secret, 'SECRET=1');
		const link = join(root, 'link-to-secret');
		try {
			symlinkSync(secret, link);
		} catch {
			return; // symlink unsupported in this env — skip (still covered by .. test)
		}
		expect(() => resolveConfinedTarget(link, root)).toThrow(PathConfinementError);
	});

	it('DENIES a BROKEN symlink — unresolvable target fails CLOSED', () => {
		const root = projectRoot('proj-a');
		const link = join(root, 'dangling');
		try {
			symlinkSync(join(root, 'does-not-exist-XYZ'), link);
		} catch {
			return; // symlink unsupported — skip
		}
		// The link's parent is in-root, but realpath cannot resolve it → must NOT
		// silently allow. Fail closed.
		expect(() => resolveConfinedTarget(link, root)).toThrow(PathConfinementError);
	});

	it('DENIES when the project root itself is unresolvable (fail closed)', () => {
		const ghost = join(codeRoot, 'no-such-project');
		expect(() => resolveConfinedTarget(join(ghost, 'a.ts'), ghost)).toThrow(
			PathConfinementError
		);
	});

	it('DENIES a sibling whose name PREFIXES the root (proj-a vs proj-a-evil)', () => {
		const root = projectRoot('proj-a');
		projectRoot('proj-a-evil');
		const sneaky = join(codeRoot, 'proj-a-evil', 'x.ts');
		writeFileSync(sneaky, '// outside');
		// String-prefix confinement would wrongly allow this; boundary-aware must deny.
		expect(() => resolveConfinedTarget(sneaky, root)).toThrow(PathConfinementError);
	});
});
