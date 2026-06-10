// TASK 13.3 — the CLI-path gate TRANSPORT (gate-transport.ts): the wiring that makes the
// D-018/D-024 gate layer actually enforce on real CLI spawns (ARCHITECTURE §2.10e). These
// are the regression tests for the 13.3 finding: before the fix, gates.ts had ZERO
// production callers — buildCliSettings registered no PreToolUse hook and no server
// endpoint consulted gatePreToolUse. Every test here exercises the new wiring; the
// fail-closed cases assert a malformed gate config BLOCKS the tool, never silently allows.

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	encodeGateHookConfig,
	decodeGateHookConfig,
	buildGateHookGroup,
	handleGatePreToolUse,
	gateDenyOutput,
	resetGateSessions,
	GATE_HOOK_TIMEOUT_S
} from './gate-transport';
import { DEFAULT_GATE_POLICY } from './gates';

let root: string;

beforeEach(() => {
	resetGateSessions();
	root = mkdtempSync(join(tmpdir(), 'v2-gate-transport-'));
	return () => rmSync(root, { recursive: true, force: true });
});

function encoded(gates: Record<string, string> = { ...DEFAULT_GATE_POLICY }): string {
	return encodeGateHookConfig({ gates, projectRoot: root });
}

function body(over: Partial<{ config: string; payload: unknown }> = {}): unknown {
	return {
		config: encoded(),
		payload: { session_id: 'cc_s1', tool_name: 'Bash', tool_input: { command: 'echo hi' } },
		...over
	};
}

// ── config encode/decode ────────────────────────────────────────────────────────────

describe('gate hook config — encode/decode (pinned at spawn time)', () => {
	it('round-trips the per-session gate config', () => {
		const cfg = { gates: { ...DEFAULT_GATE_POLICY }, projectRoot: root };
		expect(decodeGateHookConfig(encodeGateHookConfig(cfg))).toEqual(cfg);
	});

	it('throws on garbage / empty / shape-invalid input (callers fail closed)', () => {
		expect(() => decodeGateHookConfig('not-base64-json!!')).toThrow();
		expect(() => decodeGateHookConfig('')).toThrow();
		// valid base64url JSON but missing the gates record
		const noGates = Buffer.from(JSON.stringify({ projectRoot: root })).toString('base64url');
		expect(() => decodeGateHookConfig(noGates)).toThrow(/gates/);
		// missing projectRoot
		const noRoot = Buffer.from(JSON.stringify({ gates: {} })).toString('base64url');
		expect(() => decodeGateHookConfig(noRoot)).toThrow(/projectRoot/);
	});
});

// ── the settings.json hook group ─────────────────────────────────────────────────────

describe('buildGateHookGroup — the PreToolUse entry the CLI backend registers', () => {
	it('points at scripts/gate-hook.mjs with the encoded config, matcher * (every tool gated)', () => {
		const group = buildGateHookGroup({
			nodeBin: 'C:/nodejs/node.exe',
			serverRoot: 'F:/code/server',
			encodedConfig: 'CFG123'
		});
		expect(group.matcher).toBe('*');
		expect(group.hooks).toHaveLength(1);
		const entry = group.hooks[0];
		expect(entry.type).toBe('command');
		expect(entry.command).toBe('"C:/nodejs/node.exe" "F:/code/server/scripts/gate-hook.mjs" CFG123');
		expect(entry.timeout).toBe(GATE_HOOK_TIMEOUT_S);
	});
});

// ── the server-side handler (the /api/gates/pretooluse brain) ────────────────────────

describe('handleGatePreToolUse — fail-closed gate decisions (13.3, D-024)', () => {
	it('DENIES a dangerous bash command (the gate layer is actually consulted)', () => {
		const out = handleGatePreToolUse(
			body({
				payload: {
					session_id: 'cc_s1',
					tool_name: 'Bash',
					tool_input: { command: 'git push --force origin main' }
				}
			})
		);
		expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
		expect(out.hookSpecificOutput.permissionDecisionReason).toContain('dangerous-bash');
	});

	it('ALLOWS a benign call', () => {
		const out = handleGatePreToolUse(body());
		expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
	});

	it('DENIES on a malformed/missing body (never silently allows)', () => {
		expect(handleGatePreToolUse(null).hookSpecificOutput.permissionDecision).toBe('deny');
		expect(handleGatePreToolUse('x').hookSpecificOutput.permissionDecision).toBe('deny');
		expect(handleGatePreToolUse({}).hookSpecificOutput.permissionDecision).toBe('deny');
	});

	it('DENIES on an undecodable gate config', () => {
		const out = handleGatePreToolUse(body({ config: '%%%garbage%%%' }));
		expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
		expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/failing closed/i);
	});

	it('DENIES on a MALFORMED gate config — unknown gate / invalid mode block the tool', () => {
		// The exact fail-closed requirement of the 13.3 finding: malformed gate config
		// must BLOCK, even for an otherwise-benign tool call.
		const unknownGate = handleGatePreToolUse(body({ config: encoded({ 'not-a-gate': 'deny' }) }));
		expect(unknownGate.hookSpecificOutput.permissionDecision).toBe('deny');

		const invalidMode = handleGatePreToolUse(
			body({ config: encoded({ 'dangerous-bash': 'allow' }) })
		);
		expect(invalidMode.hookSpecificOutput.permissionDecision).toBe('deny');
	});

	it('DENIES a config-protection violation (.env read via Bash)', () => {
		const out = handleGatePreToolUse(
			body({
				payload: { session_id: 'cc_s1', tool_name: 'Bash', tool_input: { command: 'cat .env' } }
			})
		);
		expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
		expect(out.hookSpecificOutput.permissionDecisionReason).toContain('config-protection');
	});

	it('tracks read-before-edit state PER cc session across calls', () => {
		const file = join(root, 'src.ts').replace(/\\/g, '/');
		const edit = (sid: string) =>
			handleGatePreToolUse(
				body({ payload: { session_id: sid, tool_name: 'Edit', tool_input: { file_path: file } } })
			);
		const read = (sid: string) =>
			handleGatePreToolUse(
				body({ payload: { session_id: sid, tool_name: 'Read', tool_input: { file_path: file } } })
			);

		// Edit before Read → denied.
		expect(edit('cc_a').hookSpecificOutput.permissionDecision).toBe('deny');
		// Read, then Edit, same session → allowed.
		expect(read('cc_a').hookSpecificOutput.permissionDecision).toBe('allow');
		expect(edit('cc_a').hookSpecificOutput.permissionDecision).toBe('allow');
		// A DIFFERENT session never read it → still denied (state is per-session).
		expect(edit('cc_b').hookSpecificOutput.permissionDecision).toBe('deny');
	});

	it('a missing session_id still evaluates (fresh read-set — strictest, never looser)', () => {
		const out = handleGatePreToolUse(
			body({
				payload: { tool_name: 'Edit', tool_input: { file_path: join(root, 'x.ts') } }
			})
		);
		expect(out.hookSpecificOutput.permissionDecision).toBe('deny'); // no read-set → Edit denied
	});

	it('gateDenyOutput emits the documented PreToolUse deny shape', () => {
		const out = gateDenyOutput('why');
		expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse');
		expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
		expect(out.hookSpecificOutput.permissionDecisionReason).toBe('why');
	});
});
