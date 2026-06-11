// TASK 15.1 — the REAL PreToolUse transport round-trip for the scope-lock gate.
//
// Integration through the EXACT production hook path, minus only SvelteKit and the
// claude binary: the real scripts/gate-hook.mjs subprocess (the command cli-backend
// registers in every gated spawn's settings) reads a PreToolUse payload on STDIN and
// POSTs an in-process loopback server running the SAME authorizeHookRequest +
// handleGatePreToolUse the production route consults (the 13.3 harness shape,
// gate-live.test.ts). Proves: a real out-of-scope Edit comes back DENY (Claude Code
// would block the tool BEFORE execution), an in-scope Write comes back ALLOW, the
// config-driven destructive list + full-command safe exception bite through the wire,
// and a dead endpoint still DENIES (the transport fails closed, D-024).
//
// Each subprocess is wall-clock-bounded (SUBPROCESS DISCIPLINE): a hang fails the test
// with a named timeout, never a silent stall. No credentials needed — the credentialed
// end-to-end (real claude session) lives in edit-scope-live.test.ts.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { encodeGateHookConfig, handleGatePreToolUse, resetGateSessions } from './gate-transport';
import { authorizeHookRequest } from '../hooks/index';
import { DEFAULT_GATE_POLICY } from './gates';
import { loadGatesConfig } from '../config/load';

const SCRIPT = join(process.cwd(), 'scripts', 'gate-hook.mjs');
const HOOK_TIMEOUT_MS = 15_000;

let server: Server | null = null;
let baseUrl = '';
const hookToken = randomBytes(24).toString('hex');
let root: string;

beforeAll(async () => {
	resetGateSessions();
	root = mkdtempSync(join(tmpdir(), 'v2-hook-rt-'));
	mkdirSync(join(root, 'src'), { recursive: true });

	server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (c) => chunks.push(c));
		req.on('end', () => {
			const headers = new Headers();
			for (const [k, v] of Object.entries(req.headers)) {
				if (typeof v === 'string') headers.set(k, v);
			}
			const auth = authorizeHookRequest(headers, { HOOK_TOKEN: hookToken });
			if (!auth.ok) {
				res.writeHead(401, { 'content-type': 'application/json' });
				res.end('{}');
				return;
			}
			let body: unknown = null;
			try {
				body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
			} catch {
				body = null;
			}
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify(handleGatePreToolUse(body)));
		});
	});
	await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
	const addr = server.address();
	baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
	if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
	if (root) rmSync(root, { recursive: true, force: true });
});

interface HookDecision {
	hookSpecificOutput: {
		hookEventName: string;
		permissionDecision: string;
		permissionDecisionReason?: string;
	};
}

/** Run the REAL gate-hook script once, wall-clock-bounded; returns its printed decision. */
function runHook(
	encodedConfig: string,
	payload: unknown,
	env: Record<string, string | undefined> = {}
): Promise<HookDecision> {
	return new Promise((resolvePromise, rejectPromise) => {
		const child = execFile(
			process.execPath,
			[SCRIPT, encodedConfig],
			{
				timeout: HOOK_TIMEOUT_MS,
				env: { ...process.env, HOOK_URL: baseUrl, HOOK_TOKEN: hookToken, ...env }
			},
			(err, stdout, stderr) => {
				// The script's contract: ALWAYS prints a decision and exits 0 — even on its own
				// failures (it denies). Name WHICH channel failed otherwise (subprocess discipline).
				if (err && (err as NodeJS.ErrnoException & { killed?: boolean }).killed) {
					rejectPromise(new Error(`gate-hook timed out after ${HOOK_TIMEOUT_MS}ms (wall-clock bound)`));
					return;
				}
				if (err) {
					rejectPromise(
						new Error(`gate-hook exited non-zero: ${err.message}; stderr: ${String(stderr).slice(0, 300)}`)
					);
					return;
				}
				if (!stdout.trim()) {
					rejectPromise(new Error('gate-hook printed NO decision (empty stdout) — silence is not success'));
					return;
				}
				try {
					resolvePromise(JSON.parse(stdout) as HookDecision);
				} catch {
					rejectPromise(new Error(`gate-hook printed non-JSON: ${stdout.slice(0, 300)}`));
				}
			}
		);
		child.stdin?.end(JSON.stringify(payload));
	});
}

function scopedConfig(): string {
	// The REAL shipped pattern lists ride the config, exactly as the launch path pins them.
	const gatesYaml = loadGatesConfig(join(process.cwd(), 'config', 'gates.yaml'));
	return encodeGateHookConfig({
		gates: { ...DEFAULT_GATE_POLICY },
		projectRoot: root,
		editScope: { scopeRoots: ['src'], destructiveBash: gatesYaml.destructiveBash }
	});
}

describe('15.1 — the scope-lock through the REAL gate-hook subprocess + loopback endpoint', () => {
	it('a real out-of-scope Edit is DENIED before execution (the hook prints deny)', async () => {
		const out = await runHook(scopedConfig(), {
			session_id: 'cc_rt_1',
			tool_name: 'Write',
			tool_input: { file_path: join(root, 'outside', 'evil.md') }
		});
		expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
		expect(out.hookSpecificOutput.permissionDecisionReason).toContain('edit-scope');
	}, 30_000);

	it('an in-scope Write PASSES through the same wire', async () => {
		const out = await runHook(scopedConfig(), {
			session_id: 'cc_rt_1',
			tool_name: 'Write',
			tool_input: { file_path: join(root, 'src', 'fine.ts') }
		});
		expect(out.hookSpecificOutput.permissionDecision).toBe('allow');
	}, 30_000);

	it('destructive bash denies with the pattern NAME; the safe exception passes', async () => {
		const denied = await runHook(scopedConfig(), {
			session_id: 'cc_rt_2',
			tool_name: 'Bash',
			tool_input: { command: 'git checkout .' }
		});
		expect(denied.hookSpecificOutput.permissionDecision).toBe('deny');
		expect(denied.hookSpecificOutput.permissionDecisionReason).toContain('git-discard-worktree');

		const allowed = await runHook(scopedConfig(), {
			session_id: 'cc_rt_2',
			tool_name: 'Bash',
			tool_input: { command: 'rm -rf node_modules' }
		});
		expect(allowed.hookSpecificOutput.permissionDecision).toBe('allow');
	}, 45_000);

	it('a DEAD gate endpoint denies (the transport fails closed, never open)', async () => {
		const out = await runHook(
			scopedConfig(),
			{ session_id: 'cc_rt_3', tool_name: 'Bash', tool_input: { command: 'echo hi' } },
			{ HOOK_URL: 'http://127.0.0.1:1' } // nothing listens here
		);
		expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
	}, 30_000);
});
