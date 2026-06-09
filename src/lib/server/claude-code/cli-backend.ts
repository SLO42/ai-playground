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
import { writeFileSync, readFileSync, rmSync, mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type {
	CcBackend,
	CcBackendRun,
	CcSpawnPlan,
	RuntimeEvent
} from '../runtime/index';

/**
 * Seed the per-session ISOLATED config dir so Claude Code TRUSTS this cwd and is allowed to
 * run the harness's lifecycle hooks (TASK 8.4). Claude Code gates hooks behind a per-project
 * trust dialog — `hasTrustDialogHooksAccepted` in `<CLAUDE_CONFIG_DIR>/.claude.json`. In our
 * headless, freshly-isolated config dir (D-002) that dialog never runs, so WITHOUT this seed
 * the `--settings` hooks are SILENTLY DISABLED and the whole hook→agent_event observability
 * path is dead for driven sessions. We pre-accept trust ONLY for THIS session's own cwd (never
 * a blanket trust) so the isolation guarantee holds: the driven agent trusts exactly the one
 * project root it was spawned to work in. An existing file is merged, never clobbered.
 *
 * This is a TRUST acknowledgement, not a permission grant — the harness gates (D-018) and
 * permissions.deny (1.4a) still evaluate every tool call; trusting the cwd only lets the
 * analytics hooks fire. We do NOT set bypassPermissions or grant any tool here.
 *
 * Two empirically-required pieces (Claude Code 2.x):
 *   1. The config must look INITIALIZED — bare `{hasCompletedOnboarding,projects}` is NOT
 *      enough; Claude Code re-runs first-start (silently disabling hooks) unless scaffolding
 *      fields (userID/firstStartTime/numStartups) are present. We seed SYNTHETIC ones (a random
 *      per-config id, never the operator's userID) so NO operator config is read or leaked (D-002).
 *   2. `hasTrustDialogHooksAccepted:true` for THIS cwd — the actual hook-trust flag.
 */
/**
 * Harness-internal settings keys that are NOT part of the Claude Code settings.json schema and
 * MUST NOT be written into the `--settings` file. Emitting `plugins`/`marketplaces`/`enabledPlugins`
 * (even as empty arrays) makes Claude Code silently disable the file's hooks (TASK 8.4 finding);
 * `gates`/`capabilities` are harness metadata Claude Code does not consume. The D-002 isolation
 * (no operator plugins) is enforced by the fresh isolated CLAUDE_CONFIG_DIR, not by these keys.
 */
const HARNESS_ONLY_SETTINGS_KEYS = new Set([
	'plugins',
	'marketplaces',
	'enabledPlugins',
	'capabilities',
	'gates'
]);

/** Project the harness settings down to the Claude-Code-schema-valid subset (keeps `hooks` and
 *  any standard keys like permissions/env; drops the harness-internal keys above). */
function toClaudeSettings(settings: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(settings)) {
		if (!HARNESS_ONLY_SETTINGS_KEYS.has(k)) out[k] = v;
	}
	return out;
}

function seedHookTrust(configDir: string, cwd: string): void {
	try {
		mkdirSync(configDir, { recursive: true });
		const file = join(configDir, '.claude.json');
		let json: Record<string, unknown> = {};
		if (existsSync(file)) {
			try {
				json = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
			} catch {
				json = {}; // a corrupt file is replaced — the isolated dir is ours to own
			}
		}
		json.hasCompletedOnboarding = true;
		// Scaffolding so Claude Code treats the isolated config as initialized (not first-run, which
		// silently disables hooks). SYNTHETIC + per-config — never the operator's identity (D-002).
		// Only seeded if absent so we never stomp values Claude Code itself wrote on a prior run.
		if (json.userID === undefined) json.userID = randomBytes(32).toString('hex');
		if (json.firstStartTime === undefined) json.firstStartTime = new Date().toISOString();
		if (json.numStartups === undefined) json.numStartups = 5;
		const projects = (json.projects ?? {}) as Record<string, Record<string, unknown>>;
		// Claude Code keys trust by the cwd string it sees, which on Windows may be the native
		// backslash form OR a forward-slash form depending on how the spawn cwd was passed. Seed
		// every equivalent spelling so the trust entry matches however Claude Code normalizes it.
		const variants = new Set<string>([cwd, cwd.replace(/\//g, '\\'), cwd.replace(/\\/g, '/')]);
		for (const key of variants) {
			const existing = projects[key] ?? {};
			projects[key] = {
				...existing,
				hasTrustDialogAccepted: true,
				// THE load-bearing flag — Claude Code runs settings.json hooks only once this is true.
				hasTrustDialogHooksAccepted: true
			};
		}
		json.projects = projects;
		writeFileSync(file, JSON.stringify(json), 'utf8');
	} catch {
		// Best-effort (D-019): if we cannot seed trust the session still runs — hooks just stay
		// off (analytics-only, never a gate), exactly as a down ingest server would behave.
	}
}

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
		// Write ONLY Claude-Code-schema-valid settings. CRITICAL (TASK 8.4): the harness-internal
		// determinism keys `plugins`/`marketplaces`/`enabledPlugins` are NOT Claude Code settings
		// keys — when present (even empty) Claude Code's plugin handling SILENTLY DISABLES the
		// `--settings` hooks, killing the hook→agent_event path. The D-002 "no inherited operator
		// plugins" guarantee comes from the ISOLATED CLAUDE_CONFIG_DIR (a fresh dir has no plugins),
		// NOT from emitting empty plugin arrays here — so we simply omit them. `capabilities` is
		// likewise harness-internal (provisioned by other means), not a CC settings key. We keep
		// `hooks` (D-019) and pass through any genuinely-valid keys (permissions/env/etc.).
		writeFileSync(settingsPath, JSON.stringify(toClaudeSettings(plan.isolated.settings)), 'utf8');

		// TASK 8.4 — when the isolated settings wire D-019 lifecycle hooks, pre-accept hook trust
		// for THIS session's cwd in the isolated config dir, or Claude Code silently disables the
		// `--settings` hooks (its per-project hook-trust gate) and no hook→agent_event row is ever
		// written for a driven session. Seeded only when hooks are actually present; only for the
		// one cwd this session runs in (isolation preserved). Best-effort — never blocks the spawn.
		const hookMap = (plan.isolated.settings as { hooks?: Record<string, unknown> }).hooks;
		const configDir = plan.isolated.env.CLAUDE_CONFIG_DIR;
		if (hookMap && Object.keys(hookMap).length > 0 && configDir) {
			seedHookTrust(configDir, plan.cwd);
		}

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
