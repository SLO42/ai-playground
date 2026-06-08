// REAL Claude Code CLI backend (the credentialed CcBackend the live capstone needs).
// Drives the headless `claude -p --output-format stream-json` subprocess under the
// S1-mandated ISOLATED config (D-002): CLAUDE_CONFIG_DIR forced to the plan's isolated
// dir, --settings = the harness-only bundle (no inherited operator plugins). The OAuth
// token is passed via env (CLAUDE_CODE_OAUTH_TOKEN) and NEVER logged.
//
// This is the SDK/CLI seam the runtime/index.ts CcBackend interface describes; until the
// credential wave it existed only as a mock. It maps the CLI's stream-json events onto
// the common RuntimeEvent union so launchSession persists session(+cc_session_id) +
// message + agent_event rows identically to the mocked path.
//
// Windows note (MEMORY/CLAUDE.md): `claude` is a native .exe, so it is spawned DIRECTLY
// (NOT shell:true) — Node escapes args itself, so the prompt + the --settings path never
// pass through a shell that would mangle the JSON. Settings ride a temp FILE (not an inline
// JSON arg) for the same reason. Stop via the run's own kill; no process.kill(pid,0) probing.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
	CcBackend,
	CcBackendRun,
	CcSpawnPlan,
	RuntimeEvent
} from '../runtime/index';

export interface CliBackendOptions {
	/** Path/command for the claude CLI (default: `claude` on PATH). */
	claudeBin?: string;
	/** OAuth token — passed via env only, never logged. */
	oauthToken: string;
	/** Hard ceiling on turns for a driven session (default 1 — a single bounded turn). */
	maxTurns?: number;
	/** Overall timeout in ms (default 180s). */
	timeoutMs?: number;
}

/** Map a stream-json CLI line (already parsed) → zero-or-more RuntimeEvents. */
function mapCliEvent(obj: Record<string, unknown>): RuntimeEvent[] {
	const out: RuntimeEvent[] = [];
	const t = obj.type as string;

	if (t === 'assistant' || t === 'user') {
		// A turn message; surface its text blocks as a log and any tool_use as tool_call.
		const message = obj.message as { content?: unknown[] } | undefined;
		const content = Array.isArray(message?.content) ? message!.content : [];
		for (const block of content as Array<Record<string, unknown>>) {
			if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
				out.push({ type: 'log', message: block.text });
			} else if (block.type === 'tool_use') {
				out.push({
					type: 'tool_call',
					name: String(block.name ?? 'tool'),
					args: block.input ?? {},
					needsConfirm: false
				});
			} else if (block.type === 'tool_result') {
				const c = block.content;
				const text = typeof c === 'string' ? c : JSON.stringify(c ?? '');
				out.push({ type: 'tool_result', name: 'tool', ok: !block.is_error, output: text });
			}
		}
	} else if (t === 'result') {
		const usage = obj.usage as { input_tokens?: number; output_tokens?: number } | undefined;
		if (usage) {
			out.push({
				type: 'token_usage',
				input: usage.input_tokens ?? 0,
				output: usage.output_tokens ?? 0
			});
		}
		const isError = obj.is_error === true || obj.subtype !== 'success';
		out.push({
			type: 'done',
			result: {
				ok: !isError,
				summary: typeof obj.result === 'string' ? obj.result : String(obj.subtype ?? ''),
				ccSessionId: typeof obj.session_id === 'string' ? obj.session_id : undefined
			}
		});
	}
	// 'system'/'init' etc. are not transcript or lifecycle events we persist.
	return out;
}

export class ClaudeCliBackend implements CcBackend {
	readonly kind = 'cli';
	private readonly opts: Required<Omit<CliBackendOptions, 'claudeBin'>> & { claudeBin: string };
	private readonly procs = new Map<string, ChildProcessWithoutNullStreams>();

	constructor(opts: CliBackendOptions) {
		this.opts = {
			claudeBin: opts.claudeBin ?? 'claude',
			oauthToken: opts.oauthToken,
			maxTurns: opts.maxTurns ?? 1,
			timeoutMs: opts.timeoutMs ?? 180_000
		};
	}

	run(plan: CcSpawnPlan): CcBackendRun {
		// Write the harness-only settings to a temp FILE and pass its path (D-002). Passing
		// the JSON inline as an arg is fragile under shell quoting on Windows; a file path has
		// no special chars. The CLI accepts a file path OR a JSON string for --settings.
		const settingsDir = mkdtempSync(join(tmpdir(), 'cc-settings-'));
		const settingsPath = join(settingsDir, 'settings.json');
		writeFileSync(
			settingsPath,
			JSON.stringify({ ...plan.isolated.settings, enabledPlugins: [] }),
			'utf8'
		);

		const args = [
			'-p',
			plan.prompt,
			'--output-format',
			'stream-json',
			'--verbose',
			'--max-turns',
			String(this.opts.maxTurns),
			'--model',
			plan.model.modelId,
			'--permission-mode',
			'default',
			'--settings',
			settingsPath
		];

		const env: NodeJS.ProcessEnv = {
			...process.env,
			...plan.isolated.env, // CLAUDE_CONFIG_DIR pinned to the isolated dir (operator's stripped)
			CLAUDE_CODE_OAUTH_TOKEN: this.opts.oauthToken
		};

		// claude is a native .exe — spawn it DIRECTLY (no shell:true) so Node escapes args
		// itself and the prompt/settings path never pass through a shell that would mangle them.
		const child = spawn(this.opts.claudeBin, args, {
			cwd: plan.cwd,
			env,
			windowsHide: true
		}) as ChildProcessWithoutNullStreams;
		this.procs.set(plan.agentId, child);

		const opts = this.opts;
		const procs = this.procs;
		const agentId = plan.agentId;
		// ccSessionId is reported by the result event; we expose the plan-derived placeholder
		// until then (launchSession reads the authoritative one off the done event).
		let reportedCc = '';

		async function* stream(): AsyncIterable<RuntimeEvent> {
			const timer = setTimeout(() => child.kill(), opts.timeoutMs);
			const rl = createInterface({ input: child.stdout });
			let stderr = '';
			child.stderr.on('data', (d) => {
				stderr += String(d);
			});
			try {
				for await (const line of rl) {
					const trimmed = line.trim();
					if (!trimmed) continue;
					let obj: Record<string, unknown>;
					try {
						obj = JSON.parse(trimmed);
					} catch {
						continue; // non-JSON noise
					}
					if (typeof obj.session_id === 'string') reportedCc = obj.session_id;
					for (const ev of mapCliEvent(obj)) yield ev;
				}
				const code: number | null = await new Promise((resolve) => {
					if (child.exitCode !== null) resolve(child.exitCode);
					else child.once('close', (c) => resolve(c));
				});
				if (code && code !== 0) {
					yield { type: 'error', error: `claude CLI exited ${code}: ${stderr.slice(0, 500)}` };
				}
			} finally {
				clearTimeout(timer);
				procs.delete(agentId);
				rmSync(settingsDir, { recursive: true, force: true });
			}
		}

		return {
			get ccSessionId() {
				return reportedCc;
			},
			stream,
			async cancel() {
				child.kill();
			}
		} as CcBackendRun;
	}

	async resume(req: { ccSessionId: string; plan: CcSpawnPlan }): Promise<CcBackendRun> {
		// Resume parity is out of scope for the live capstone proof; the run() path is the
		// proven one. Resume would add `--resume <id>`; not exercised here.
		throw new Error(
			`ClaudeCliBackend.resume not implemented for the live proof (${req.ccSessionId})`
		);
	}

	async interject(msg: {
		ccSessionId: string;
		origin: string;
		body: string;
		steer: boolean;
	}): Promise<void> {
		throw new Error(
			`ClaudeCliBackend.interject not implemented for the live proof (${msg.ccSessionId})`
		);
	}
}
