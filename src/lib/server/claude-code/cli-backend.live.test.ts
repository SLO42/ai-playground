// LIVE 14.6 — REAL credentialed interject + resume against the actual `claude` CLI.
//
// The protocol suite (cli-backend.proto.test.ts) proves the backend's stream-json io
// against a scripted stand-in; THIS suite proves the same path against the real CLI:
//   • interject: a mid-run stream-json user message is ACKNOWLEDGED by the live CLI
//     (`--replay-user-messages` replay) — the bounded, honest delivery receipt;
//   • resume: `--resume <session-id>` REALLY continues the same conversation (the
//     resumed turn can recall a codeword only the first turn established).
//
// F-008 discipline: skipped honestly when no CLAUDE_CODE_OAUTH_TOKEN is available —
// never a faked artifact. Bounded wall-clock (F-014): every run rides the backend's
// own timeout; nothing spins. Runs cwd-confined in an OS temp dir with an isolated
// CLAUDE_CONFIG_DIR (D-002); the spawned children are the backend's own tracked
// children (tree-killed on any teardown path).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCliBackend } from './cli-backend';
import type { CcSpawnPlan, RuntimeEvent } from '../runtime/index';

/** Read CLAUDE_CODE_OAUTH_TOKEN from process env or the worktree .env (never logged). */
function readToken(): string | undefined {
	if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return process.env.CLAUDE_CODE_OAUTH_TOKEN;
	const candidates = [join(process.cwd(), '.env')];
	for (const p of candidates) {
		if (!existsSync(p)) continue;
		const line = readFileSync(p, 'utf8')
			.split(/\r?\n/)
			.find((l) => l.startsWith('CLAUDE_CODE_OAUTH_TOKEN='));
		if (line) {
			return line
				.slice('CLAUDE_CODE_OAUTH_TOKEN='.length)
				.trim()
				.replace(/^["']|["']$/g, '');
		}
	}
	return undefined;
}

const TOKEN = readToken();
const live = TOKEN ? describe : describe.skip;

let workDir: string;
let harnessDir: string;

beforeAll(() => {
	if (!TOKEN) return;
	workDir = mkdtempSync(join(tmpdir(), 'live-1446-'));
	harnessDir = mkdtempSync(join(tmpdir(), 'live-1446-cfg-'));
});

afterAll(() => {
	if (workDir) rmSync(workDir, { recursive: true, force: true });
	if (harnessDir) rmSync(harnessDir, { recursive: true, force: true });
});

/** One shared isolated config dir + cwd — resume MUST reuse both (the CLI keys its
 *  conversation transcripts by config dir + cwd). */
function makePlan(prompt: string): CcSpawnPlan {
	const configDir = join(harnessDir, 'agent-live').replace(/\\/g, '/');
	return {
		agentId: 'live-1446',
		cwd: workDir,
		model: { provider: 'claude', modelId: 'haiku', tier: 'haiku' },
		prompt,
		toolPolicy: { allow: ['Read'] },
		budgets: { thinking: 'low', toolCalls: 1, concurrency: 1 },
		isolated: { configDir, env: { CLAUDE_CONFIG_DIR: configDir }, settings: {} }
	};
}

async function waitFor(cond: () => boolean, ms: number): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > ms) throw new Error(`condition not met within ${ms}ms`);
		await new Promise((r) => setTimeout(r, 50));
	}
}

live('LIVE 14.6 — real CLI interject + resume (token-gated, bounded)', () => {
	it(
		'interject: a mid-run message is acknowledged by the LIVE claude CLI',
		async () => {
			const backend = new ClaudeCliBackend({
				oauthToken: TOKEN!,
				maxTurns: 2,
				timeoutMs: 150_000,
				interjectAckMs: 30_000
			});
			// A reply long enough that the turn is still open when the interjection lands.
			const run = backend.run(
				makePlan(
					'Count from 1 to 30, one number per line, then stop. Do not use any tools.'
				)
			);
			const events: RuntimeEvent[] = [];
			const consume = (async () => {
				for await (const ev of run.stream()) events.push(ev);
			})();

			// The CLI reports its session id on the init line — interject the moment it does.
			await waitFor(() => run.ccSessionId !== '', 60_000);
			// Resolving WITHOUT throwing = the live CLI replayed (acknowledged) the message.
			await backend.interject({
				ccSessionId: run.ccSessionId,
				origin: 'operator',
				body: 'Operator note: when you finish counting, also print the word ZEBRA.',
				steer: true
			});

			await consume;
			// The run completed for real (a done event with a real result).
			const done = events.find((e) => e.type === 'done');
			expect(done).toBeTruthy();
			expect(events.some((e) => e.type === 'log')).toBe(true);
		},
		180_000
	);

	it(
		'resume: --resume continues the SAME conversation (recalls the first turn)',
		async () => {
			const backend = new ClaudeCliBackend({
				oauthToken: TOKEN!,
				maxTurns: 1,
				timeoutMs: 120_000
			});

			// Turn 1 — establish a fact only THIS conversation knows.
			const run1 = backend.run(
				makePlan(
					'Remember this codeword: AMBERWOLF. Reply with exactly the single word OK and nothing else. Do not use any tools.'
				)
			);
			let cc = '';
			let ok1 = false;
			for await (const ev of run1.stream()) {
				if (ev.type === 'done') {
					ok1 = ev.result.ok;
					cc = ev.result.ccSessionId ?? '';
				}
			}
			expect(ok1).toBe(true);
			expect(cc).toMatch(/[0-9a-f-]{8,}/i);

			// Turn 2 — a REAL resume of that conversation (same config dir + cwd).
			const run2 = await backend.resume({
				ccSessionId: cc,
				plan: makePlan(
					'What was the codeword I asked you to remember? Reply with exactly that single word and nothing else. Do not use any tools.'
				)
			});
			const logs: string[] = [];
			let ok2 = false;
			for await (const ev of run2.stream()) {
				if (ev.type === 'log') logs.push((ev as { message: string }).message);
				if (ev.type === 'done') ok2 = ev.result.ok;
			}
			expect(ok2).toBe(true);
			// The PROOF of a real continuation: the resumed turn recalls the codeword that
			// only the first turn's conversation established.
			expect(logs.join('\n').toUpperCase()).toContain('AMBERWOLF');
		},
		240_000
	);
});
