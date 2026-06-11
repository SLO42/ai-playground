// TASK 14.6 — the CLI backend's stream-json PROTOCOL, driven for real (spawn + stdin +
// stdout) against a scripted stand-in CLI (`claudeBin: node, claudeArgPrefix: [script]`).
// No credential, no network — but the REAL ClaudeCliBackend code path end-to-end:
//   • the prompt rides stdin as the first stream-json user message (no argv prompt),
//   • interject() writes a REAL mid-run user message and resolves ONLY on the CLI's
//     replay acknowledgment (`--replay-user-messages`),
//   • an unacknowledged interjection rejects within the bound (honest, no false success),
//   • an interject after the run ended rejects honestly,
//   • resume() passes `--resume <session-id>` (the real continuation flag),
//   • replayed stdin messages are SUPPRESSED from the event stream (no duplicated
//     prompt/interjection in the transcript — the channel's message row is the source).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCliBackend } from './cli-backend';
import type { CcSpawnPlan, RuntimeEvent } from '../runtime/index';

// ── The scripted stand-in CLI (stream-json io, mode via FAKE_CLI_MODE) ──────────────
const FAKE_CLI = `
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const mode = process.env.FAKE_CLI_MODE ?? 'single';
const sessionId = process.env.FAKE_CLI_SESSION ?? 'cc-fake-1';
const out = (o) => process.stdout.write(JSON.stringify({ session_id: sessionId, ...o }) + '\\n');

out({ type: 'system', subtype: 'init' });
if (mode === 'echo-argv') {
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'argv:' + args.join(' ') }] } });
}

let userCount = 0;
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type !== 'user') return;
  userCount++;
  const text = Array.isArray(msg.message && msg.message.content)
    ? msg.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
    : String((msg.message && msg.message.content) ?? '');
  // The --replay-user-messages acknowledgment (withheld in no-replay mode).
  if (mode !== 'no-replay') out({ type: 'user', message: msg.message });
  if (mode === 'hold-for-interject') {
    if (userCount === 1) {
      out({ type: 'assistant', message: { content: [{ type: 'text', text: 'started:' + text }] } });
      return; // hold the turn open — the result lands only after the interjection
    }
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'got:' + text }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'done after interject', usage: { input_tokens: 3, output_tokens: 4 } });
    return;
  }
  if (mode === 'no-replay') {
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'started:' + text }] } });
    return; // never acknowledge, never finish — the backend's ack bound must fire
  }
  // 'single' / 'echo-argv': respond + finish after the first user message.
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'echo:' + text }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: { input_tokens: 1, output_tokens: 2 } });
});
rl.on('close', () => process.exit(0));
`;

let dir: string;
let scriptPath: string;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'cc-proto-'));
	scriptPath = join(dir, 'fake-claude.mjs');
	writeFileSync(scriptPath, FAKE_CLI, 'utf8');
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

function makeBackend(opts?: { interjectAckMs?: number }): ClaudeCliBackend {
	return new ClaudeCliBackend({
		claudeBin: process.execPath, // node.exe — spawned DIRECTLY, Windows-safe
		claudeArgPrefix: [scriptPath],
		oauthToken: 'test-token-never-logged',
		timeoutMs: 30_000,
		...(opts?.interjectAckMs !== undefined ? { interjectAckMs: opts.interjectAckMs } : {})
	});
}

function makePlan(prompt: string, mode: string): CcSpawnPlan {
	const configDir = join(dir, `cfg-${mode}`);
	return {
		agentId: `proto-${mode}`,
		cwd: dir,
		model: { provider: 'claude', modelId: 'claude-test', tier: 'haiku' },
		prompt,
		toolPolicy: { allow: ['Read'] },
		budgets: {},
		isolated: {
			configDir,
			// FAKE_CLI_MODE rides the isolated env exactly like CLAUDE_CONFIG_DIR does.
			env: { CLAUDE_CONFIG_DIR: configDir, FAKE_CLI_MODE: mode },
			settings: {}
		}
	};
}

async function waitFor(cond: () => boolean, ms: number): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > ms) throw new Error(`condition not met within ${ms}ms`);
		await new Promise((r) => setTimeout(r, 20));
	}
}

function logs(events: RuntimeEvent[]): string[] {
	return events.filter((e) => e.type === 'log').map((e) => (e as { message: string }).message);
}

describe('cli-backend protocol — prompt via stdin, replay suppression (14.6)', () => {
	it('delivers the prompt as the first stream-json stdin message and completes', async () => {
		const backend = makeBackend();
		const run = backend.run(makePlan('do the proto thing', 'single'));
		const events: RuntimeEvent[] = [];
		for await (const ev of run.stream()) events.push(ev);

		// The stand-in saw the prompt ON STDIN (it echoed it back from the user message).
		expect(logs(events)).toContain('echo:do the proto thing');
		// The replayed prompt acknowledgment is SUPPRESSED — never a duplicated transcript line.
		expect(logs(events)).not.toContain('do the proto thing');
		const done = events.find((e) => e.type === 'done');
		expect(done).toMatchObject({ type: 'done', result: { ok: true } });
		expect(run.ccSessionId).toBe('cc-fake-1');
	}, 30_000);

	it('passes --resume <session-id> for a REAL resume (and never the prompt as argv)', async () => {
		const backend = makeBackend();
		const run = await backend.resume({
			ccSessionId: 'cc-prev-123',
			plan: makePlan('continue the work', 'echo-argv')
		});
		const events: RuntimeEvent[] = [];
		for await (const ev of run.stream()) events.push(ev);

		const argvLine = logs(events).find((l) => l.startsWith('argv:'));
		expect(argvLine).toBeTruthy();
		expect(argvLine).toContain('--resume cc-prev-123');
		expect(argvLine).toContain('--input-format stream-json');
		expect(argvLine).toContain('--replay-user-messages');
		// The prompt is NOT an argv string anymore — it rides stdin.
		expect(argvLine).not.toContain('continue the work');
		expect(logs(events)).toContain('echo:continue the work');
		expect(events.find((e) => e.type === 'done')).toMatchObject({
			type: 'done',
			result: { ok: true }
		});
	}, 30_000);
});

describe('cli-backend interject — real mid-run delivery, bounded honesty (14.6)', () => {
	it('writes a REAL mid-run user message and resolves on the replay acknowledgment', async () => {
		const backend = makeBackend();
		const run = backend.run(makePlan('long task', 'hold-for-interject'));
		const events: RuntimeEvent[] = [];
		const consume = (async () => {
			for await (const ev of run.stream()) events.push(ev);
		})();

		// Wait (bounded) for the CLI to report its session id, then interject mid-turn.
		await waitFor(() => run.ccSessionId === 'cc-fake-1', 10_000);
		await backend.interject({
			ccSessionId: 'cc-fake-1',
			origin: 'operator',
			body: 'steer toward the auth bug',
			steer: true
		});

		await consume;
		// The interjection REACHED the live session: the stand-in answered it mid-run.
		expect(logs(events)).toContain('got:steer toward the auth bug');
		// The replayed interjection itself is suppressed (the channel's message row is
		// the transcript's single source for it).
		expect(logs(events)).not.toContain('steer toward the auth bug');
		expect(events.find((e) => e.type === 'done')).toMatchObject({
			type: 'done',
			result: { ok: true }
		});

		// After the run ended, a further interject is an HONEST error — never queued
		// into nowhere, never false success.
		await expect(
			backend.interject({
				ccSessionId: 'cc-fake-1',
				origin: 'operator',
				body: 'too late',
				steer: true
			})
		).rejects.toThrow(/no live claude session/i);
	}, 30_000);

	it('rejects within the ack bound when the CLI never acknowledges (no false success, no spin)', async () => {
		const backend = makeBackend({ interjectAckMs: 300 });
		const run = backend.run(makePlan('never acked', 'no-replay'));
		const events: RuntimeEvent[] = [];
		const consume = (async () => {
			for await (const ev of run.stream()) events.push(ev);
		})();
		await waitFor(() => run.ccSessionId === 'cc-fake-1', 10_000);

		const started = Date.now();
		await expect(
			backend.interject({
				ccSessionId: 'cc-fake-1',
				origin: 'operator',
				body: 'is anyone there',
				steer: true
			})
		).rejects.toThrow(/not acknowledged/i);
		// Bounded (F-014): the rejection arrives near the configured bound, not minutes later.
		expect(Date.now() - started).toBeLessThan(5_000);

		await run.cancel(); // tree-kill the held-open stand-in (mandatory cleanup)
		await consume;
	}, 30_000);

	it('rejects honestly when no live session matches the cc session id', async () => {
		const backend = makeBackend();
		await expect(
			backend.interject({
				ccSessionId: 'cc-never-existed',
				origin: 'operator',
				body: 'hello?',
				steer: true
			})
		).rejects.toThrow(/no live claude session/i);
	});

	it('declares the HONEST capability matrix (consumed by runtime → channel → UI)', () => {
		const backend = makeBackend();
		expect(backend.supportsInterject).toBe(true);
		expect(backend.supportsResume).toBe(true);
	});

	it('REGRESSION (F-016): a failed spawn is an honest error EVENT — never an uncaught crash', async () => {
		// An unhandled ChildProcess 'error' (spawn ENOENT) killed the WHOLE dev server when
		// the first real resume anchored at a vanished root. The backend must contain it.
		const backend = new ClaudeCliBackend({
			claudeBin: join(dir, 'no-such-claude-binary.exe'),
			oauthToken: 'test-token-never-logged',
			timeoutMs: 5_000
		});
		const run = backend.run(makePlan('boom', 'single'));
		const events: RuntimeEvent[] = [];
		for await (const ev of run.stream()) events.push(ev);
		const err = events.find((e) => e.type === 'error');
		expect(err).toBeTruthy();
		expect((err as { error: string }).error).toMatch(/failed to start/i);
		expect(events.some((e) => e.type === 'done')).toBe(false);
	}, 15_000);
});
