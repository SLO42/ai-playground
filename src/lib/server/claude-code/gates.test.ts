import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
	evaluateGate,
	createGateSession,
	gateCanUseTool,
	gatePreToolUse,
	DEFAULT_GATE_POLICY,
	type GateContext,
	type ToolCall
} from './gates';

// TASK 2.13 — the defense-in-depth gate layer ON TOP of 1.4a's primary
// permissions.deny. A single pure evaluator (`evaluateGate`) consulted by BOTH the SDK
// `canUseTool` callback and the CLI `PreToolUse` hook (ARCHITECTURE §2.10e). Four gate
// families: config-protection, read-before-edit, dangerous-bash, path-confinement
// (D-018). Safety-critical families fail CLOSED (D-024): any evaluator error, or an
// unresolvable/escaping path, is DENY — never silently allowed.
//
// These tests touch NO server/DB. Path-confinement reuses 1.4a's resolveConfinedTarget,
// so the symlink/.. cases use a real temp tree (symlink + ".." resolved FIRST).

let root: string;
let outside: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'v2-gates-root-'));
	outside = mkdtempSync(join(tmpdir(), 'v2-gates-out-'));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	rmSync(outside, { recursive: true, force: true });
});

function ctx(over: Partial<GateContext> = {}): GateContext {
	return {
		projectRoot: root,
		codeRoot: resolve(root, '..'),
		session: createGateSession(),
		policy: DEFAULT_GATE_POLICY,
		...over
	};
}

function fileCall(name: 'Read' | 'Edit' | 'Write', path: string): ToolCall {
	return { name, input: { file_path: path } };
}

// ── config-protection ────────────────────────────────────────────────────────────

describe('config-protection gate', () => {
	it('denies reading a .env file', () => {
		const r = evaluateGate(fileCall('Read', join(root, '.env')), ctx());
		expect(r.decision).toBe('deny');
		expect(r.gate).toBe('config-protection');
	});

	it('denies editing another project .claude/settings.json (cross-project)', () => {
		const other = join(resolve(root, '..'), 'other-proj', '.claude', 'settings.json');
		const r = evaluateGate(fileCall('Edit', other), ctx());
		expect(r.decision).toBe('deny');
		expect(r.gate).toBe('config-protection');
	});

	it('denies reading a secret key file', () => {
		const r = evaluateGate(fileCall('Read', join(root, 'deploy', 'id_rsa')), ctx());
		expect(r.decision).toBe('deny');
		expect(r.gate).toBe('config-protection');
	});

	it('allows reading an ordinary source file under the root', () => {
		const f = join(root, 'src', 'app.ts');
		mkdirSync(join(root, 'src'), { recursive: true });
		writeFileSync(f, 'export const x = 1;\n');
		const r = evaluateGate(fileCall('Read', f), ctx());
		expect(r.decision).toBe('allow');
	});
});

// ── path-confinement (the headline verify) ───────────────────────────────────────

describe('path-confinement gate — symlink + ".." resolved FIRST, fail closed', () => {
	it('denies a ".." escape outside the project root post-normalization', () => {
		const escape = join(root, '..', 'other-proj', 'steal.txt');
		const r = evaluateGate(fileCall('Write', escape), ctx());
		expect(r.decision).toBe('deny');
		expect(r.gate).toBe('path-confinement');
	});

	it('denies a symlink whose REAL target is outside the root (symlink resolved first)', () => {
		const target = join(outside, 'secret.txt');
		writeFileSync(target, 'top secret\n');
		const link = join(root, 'link-out');
		symlinkSync(target, link, 'file');
		const r = evaluateGate(fileCall('Read', link), ctx());
		expect(r.decision).toBe('deny');
		expect(r.gate).toBe('path-confinement');
	});

	it('denies a Bash command whose target path escapes via ".."', () => {
		const escape = join(root, '..', 'other-proj', 'x');
		const r = evaluateGate(
			{ name: 'Bash', input: { command: `cat ${escape}` } },
			ctx()
		);
		expect(r.decision).toBe('deny');
		expect(r.gate).toBe('path-confinement');
	});

	it('allows a target safely under the root', () => {
		const r = evaluateGate(fileCall('Write', join(root, 'out', 'new.txt')), ctx());
		expect(r.decision).toBe('allow');
	});
});

// ── dangerous-bash ───────────────────────────────────────────────────────────────

describe('dangerous-bash gate', () => {
	it.each([
		'rm -rf /',
		'rm -rf node_modules',
		'git push origin main',
		'git remote set-url origin https://evil',
		'git checkout --force',
		'git reset --hard HEAD~3'
	])('denies %s', (command) => {
		const r = evaluateGate({ name: 'Bash', input: { command } }, ctx());
		expect(r.decision).toBe('deny');
		expect(r.gate).toBe('dangerous-bash');
	});

	it('allows a benign command', () => {
		const r = evaluateGate({ name: 'Bash', input: { command: 'npm test' } }, ctx());
		expect(r.decision).toBe('allow');
	});
});

// ── read-before-edit ─────────────────────────────────────────────────────────────

describe('read-before-edit gate', () => {
	it('blocks Edit on a file not Read this session', () => {
		const f = join(root, 'src', 'a.ts');
		mkdirSync(join(root, 'src'), { recursive: true });
		writeFileSync(f, 'x\n');
		const r = evaluateGate(fileCall('Edit', f), ctx());
		expect(r.decision).toBe('deny');
		expect(r.gate).toBe('read-before-edit');
	});

	it('allows Edit after the file was Read this session (read-set is recorded)', () => {
		const f = join(root, 'src', 'a.ts');
		mkdirSync(join(root, 'src'), { recursive: true });
		writeFileSync(f, 'x\n');
		const c = ctx();
		const read = evaluateGate(fileCall('Read', f), c);
		expect(read.decision).toBe('allow');
		const edit = evaluateGate(fileCall('Edit', f), c);
		expect(edit.decision).toBe('allow');
	});

	it('Write does not require a prior Read (creating new files is allowed)', () => {
		const f = join(root, 'src', 'fresh.ts');
		const r = evaluateGate(fileCall('Write', f), ctx());
		expect(r.decision).toBe('allow');
	});
});

// ── fail-closed: evaluator error → deny, never allow (D-024) ──────────────────────

describe('fail closed (D-024)', () => {
	it('an unresolvable project root denies every target', () => {
		const r = evaluateGate(
			fileCall('Read', join(root, 'a.ts')),
			ctx({ projectRoot: join(root, 'does-not-exist-xyz') })
		);
		expect(r.decision).toBe('deny');
	});

	it('a malformed tool call (missing path) on a file tool is denied, not allowed', () => {
		const r = evaluateGate({ name: 'Edit', input: {} }, ctx());
		expect(r.decision).toBe('deny');
	});

	it('an internal evaluator throw is caught and turned into deny (never allow)', () => {
		// A frozen/booby-trapped input that throws on property access still fails closed.
		const evil: ToolCall = { name: 'Read', input: new Proxy({}, { get() { throw new Error('boom'); } }) };
		const r = evaluateGate(evil, ctx());
		expect(r.decision).toBe('deny');
	});

	it('safety-critical gates cannot be downgraded to warn by policy (always deny)', () => {
		// Even if an operator misconfigures the policy to "warn", config-protection /
		// dangerous-bash / path-confinement stay hard-block (D-024 fail-closed).
		const loose = {
			'config-protection': 'warn',
			'dangerous-bash': 'warn',
			'path-confinement': 'warn',
			'read-before-edit': 'warn'
		} as const;
		const r = evaluateGate(fileCall('Read', join(root, '.env')), ctx({ policy: loose }));
		expect(r.decision).toBe('deny');
	});

	it('read-before-edit (non-safety-critical) CAN be downgraded to warn', () => {
		const f = join(root, 'src', 'b.ts');
		mkdirSync(join(root, 'src'), { recursive: true });
		writeFileSync(f, 'x\n');
		const r = evaluateGate(fileCall('Edit', f), ctx({ policy: { 'read-before-edit': 'warn' } }));
		expect(r.decision).toBe('warn');
		expect(r.gate).toBe('read-before-edit');
	});
});

// ── both enforcement paths consult the SAME evaluator (ARCHITECTURE §2.10e) ───────

describe('canUseTool (SDK path) + PreToolUse (CLI hook path) — same gate config', () => {
	it('gateCanUseTool denies a config-protection violation with behavior:deny', async () => {
		const c = ctx();
		const res = await gateCanUseTool(c)('Read', { file_path: join(root, '.env') });
		expect(res.behavior).toBe('deny');
		if (res.behavior !== 'deny') throw new Error('expected deny');
		expect(res.message).toContain('config-protection');
	});

	it('gateCanUseTool allows a benign call with behavior:allow + updatedInput', async () => {
		const f = join(root, 'src', 'ok.ts');
		mkdirSync(join(root, 'src'), { recursive: true });
		writeFileSync(f, 'x\n');
		const res = await gateCanUseTool(ctx())('Read', { file_path: f });
		expect(res.behavior).toBe('allow');
	});

	it('gatePreToolUse returns the PreToolUse deny JSON shape on a violation', () => {
		const out = gatePreToolUse(ctx())({
			tool_name: 'Bash',
			tool_input: { command: 'git push origin main' }
		});
		expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
		expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse');
	});

	it('gatePreToolUse allows a benign call', () => {
		const out = gatePreToolUse(ctx())({
			tool_name: 'Bash',
			tool_input: { command: 'npm run build' }
		});
		expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
	});

	it('a malformed PreToolUse payload fails closed (deny)', () => {
		// @ts-expect-error — deliberately malformed external payload
		const out = gatePreToolUse(ctx())(null);
		expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
	});
});
