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
// (NOT shell:true) — Node escapes args itself, so the --settings path never passes
// through a shell that would mangle the JSON. Settings ride a temp FILE (not an inline
// JSON arg) for the same reason. Stop via the run's own kill; no process.kill(pid,0) probing.
//
// TASK 14.6 — io is `--input-format stream-json` + `--output-format stream-json`: the
// prompt is the FIRST stdin user message and stdin stays open during the turn, so
// interject() is a REAL mid-run user message (replay-acknowledged), and resume() is a
// REAL `--resume <session-id>` continuation. supportsInterject/supportsResume declare
// the honest capability matrix the channel/UI consume (F-008 — no stubbed controls).

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { writeFileSync, readFileSync, rmSync, mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { killPid } from '../services/proc';
import type {
	CcBackend,
	CcBackendRun,
	CcSpawnPlan,
	RuntimeEvent
} from '../runtime/index';
import { buildGateHookGroup, encodeGateHookConfig } from './gate-transport';
import type { EditScopeInput } from './gates';

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
	'gates',
	'editScope',
	// TASK B10 (fix) — `mcpServers` is NOT a load-path key in the --settings file. Claude Code
	// loads MCP servers ONLY from --mcp-config / .mcp.json / ~/.claude.json; an mcpServers block
	// placed in a settings.json is SILENTLY IGNORED (CLI reference: --settings carries settings.json
	// keys; --mcp-config "Load MCP servers from JSON files or strings"). Leaving it in the --settings
	// file made the granted registration inert (F-016/F-008 class: a config key inferred-honored
	// without testing the real consumer). It is now delivered via buildMcpConfigArgs → a .mcp.json
	// passed with --mcp-config (+ --strict-mcp-config for D-002 isolation), and stripped from here.
	'mcpServers'
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

/**
 * TASK 13.3 — build the FINAL settings.json content for one spawn: the Claude-Code-valid
 * subset of the harness settings, PLUS the D-018/D-024 `PreToolUse` GATE hook whenever the
 * plan's config carries gates. Until 13.3 the harness `gates` key was (correctly) stripped
 * from the settings file but NOTHING enforced it on the CLI path — the gate layer
 * (gates.ts) had zero production callers. Now every gated spawn registers the gate hook
 * (gate-transport.buildGateHookGroup → scripts/gate-hook.mjs → /api/gates/pretooluse →
 * gatePreToolUse), with the session's gate config + project root pinned AT SPAWN TIME on
 * the hook command (base64url — config, not a secret; the D-025 token rides env only).
 * The hook transport fails CLOSED (an unreachable gate endpoint denies the tool). Exported
 * for the 13.3 regression test (which fails without this wiring).
 */
export function buildCliSettings(
	plan: CcSpawnPlan,
	opts: { nodeBin: string; serverRoot: string }
): Record<string, unknown> {
	const out = toClaudeSettings(plan.isolated.settings);
	const gates = plan.isolated.settings.gates as Record<string, string> | undefined;
	// TASK 15.1 (B1 scope-lock): a declared editScope rides the SAME pinned hook config.
	// It also FORCES the hook on — a session that declared a scope must never spawn with
	// the scope silently dropped (D-024), even if no gate modes were configured.
	const editScope = plan.isolated.settings.editScope as EditScopeInput | undefined;
	if ((gates && Object.keys(gates).length > 0) || editScope !== undefined) {
		const group = buildGateHookGroup({
			nodeBin: opts.nodeBin,
			serverRoot: opts.serverRoot,
			encodedConfig: encodeGateHookConfig({
				gates: gates ?? {},
				projectRoot: plan.cwd,
				...(editScope !== undefined ? { editScope } : {})
			})
		});
		const hooks = { ...((out.hooks as Record<string, unknown>) ?? {}) };
		const existing = hooks.PreToolUse;
		hooks.PreToolUse = [...(Array.isArray(existing) ? existing : []), group];
		out.hooks = hooks;
	}
	return out;
}

/**
 * TASK B10 (fix) — deliver the plan's GRANTED `mcpServers` to a CLI-honored load path.
 *
 * The B10 capability-wiring seam composes a granted `mcpServers` block into the isolated
 * settings (runtime/index.isolatedConfigFor). But Claude Code does NOT read MCP servers from
 * the settings.json the harness passes with `--settings` — per the CLI reference, `--settings`
 * carries settings.json keys, while MCP servers load ONLY from `--mcp-config` (".mcp.json" /
 * "~/.claude.json" / the `--mcp-config` flag). So the granted block was silently inert on the
 * real CLI path (F-016/F-008): looked live, never reachable by a granted session.
 *
 * This writes the granted servers to a `.mcp.json` in the per-session settings dir (the SAME
 * dir we already own for `--settings`, so it is torn down with the session) and returns the
 * spawn args that load it: `--mcp-config <path>` + `--strict-mcp-config`. `--strict-mcp-config`
 * makes the CLI use ONLY this file's servers and ignore every other MCP source — preserving the
 * D-002 isolation guarantee (no operator `~/.claude.json` / project `.mcp.json` servers leak in),
 * exactly as the isolated CLAUDE_CONFIG_DIR does for the rest of the config.
 *
 * Honest OFF (F-008): when the plan grants NO servers (the default-deny path — no `memory-pull`
 * capability, or the control plane is unwired so buildMemoryPullMcpServer returned undefined),
 * NOTHING is written and NO flag is added — a non-granted session spawns byte-identically to a
 * legacy spawn. Exported for the B10 delivery-path regression test (asserts the registration
 * reaches a load-path the CLI honors, not merely that the object was built).
 */
export function buildMcpConfigArgs(plan: CcSpawnPlan, settingsDir: string): string[] {
	const servers = plan.isolated.settings.mcpServers as Record<string, unknown> | undefined;
	// Default deny / honest OFF: nothing granted ⇒ no file, no flag (byte-identical legacy spawn).
	if (!servers || typeof servers !== 'object' || Object.keys(servers).length === 0) return [];
	const mcpJsonPath = join(settingsDir, '.mcp.json');
	// Claude Code's --mcp-config file is `{ "mcpServers": { name: entry, ... } }` — the same shape
	// .mcp.json uses (cc-config/parse.parseSettings reads servers from exactly this key).
	writeFileSync(mcpJsonPath, JSON.stringify({ mcpServers: servers }), 'utf8');
	return ['--mcp-config', mcpJsonPath, '--strict-mcp-config'];
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

// ── Windows-safe TREE kill + the live-children registry (TASK 13.5 findings 6+8) ─────────
//
// `child.kill()` sends ONE SIGTERM to the direct child — on Windows that leaves the
// claude.exe process TREE alive (F-002), exactly the orphan storm F-014 documented.
// services/proc.killPid is the existing Windows-safe primitive (`taskkill /F /PID <pid> /T`;
// SIGTERM on POSIX) — reuse it for the run timeout, cancel(), and process shutdown.

/** Every live claude child this process has spawned — drained by killAllClaudeChildren()
 *  at process shutdown (hooks.server.ts SIGTERM/SIGINT teardown, finding 6). */
const liveChildren = new Set<ChildProcessWithoutNullStreams>();

/** Tree-kill ONE claude child, Windows-safe (taskkill /T via services/proc). Idempotent /
 *  best-effort: an already-dead child is a no-op. Exported for the 13.5 regression tests. */
export async function treeKillChild(child: ChildProcessWithoutNullStreams): Promise<void> {
	if (child.pid != null && child.exitCode === null) {
		await killPid(child.pid); // taskkill /F /T on Windows; SIGTERM on POSIX (never throws)
	} else {
		child.kill(); // no pid (spawn failed) — best-effort direct signal
	}
}

/**
 * Tree-kill EVERY live claude child this process spawned (the shutdown teardown's child
 * sweep, finding 6). Returns how many children were swept. Safe to call repeatedly.
 */
export async function killAllClaudeChildren(): Promise<number> {
	const children = [...liveChildren];
	liveChildren.clear();
	await Promise.all(children.map((c) => treeKillChild(c).catch(() => {})));
	return children.length;
}

export interface CliBackendOptions {
	/** Path/command for the claude CLI (default: `claude` on PATH). */
	claudeBin?: string;
	/**
	 * TEST SEAM (14.6): args prepended BEFORE the protocol args — lets the protocol tests
	 * drive the REAL spawn/stdin/stdout path against a scripted stand-in
	 * (`claudeBin: process.execPath, claudeArgPrefix: [fakeCliScript]`). Never set in
	 * production wiring.
	 */
	claudeArgPrefix?: string[];
	/** OAuth token — passed via env only, never logged. */
	oauthToken: string;
	/** Hard ceiling on turns for a driven session (default 1 — a single bounded turn). */
	maxTurns?: number;
	/** Overall timeout in ms (default 180s). */
	timeoutMs?: number;
	/**
	 * Bound on waiting for the CLI to ACKNOWLEDGE an interjected message (default 10s).
	 * Delivery is only reported once the CLI replays the message back
	 * (`--replay-user-messages`) — un-acknowledged ⇒ an honest error, never false success
	 * (14.6/F-008). Bounded, no spin (F-014).
	 */
	interjectAckMs?: number;
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
			} else if (block.type === 'thinking') {
				// HONEST thinking (F-008): surface the extended-thinking block VERBATIM, including
				// an empty one (stored honestly as empty downstream — never invented). A block with
				// a non-string/absent `thinking` is normalized to '' so the persist layer records
				// an honest empty thinking turn rather than dropping the fact that the model thought.
				out.push({ type: 'thinking', text: typeof block.thinking === 'string' ? block.thinking : '' });
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

// ── Live-run registry for REAL interjection (TASK 14.6) ──────────────────────────────
//
// The CLI is driven with `--input-format stream-json`: the prompt is the FIRST user
// message written to stdin, and stdin stays open while the turn runs — so an operator
// interjection (channel.pushToSession → runtime.interject → here) is a REAL additional
// user message written into the live session's stdin, not a stub. Delivery is only
// reported once the CLI ACKNOWLEDGES the message by replaying it on stdout
// (`--replay-user-messages`) — bounded by interjectAckMs, honest error otherwise (F-008).

/** One stdin-written user message awaiting its replay acknowledgment (or, for the
 *  initial prompt, just its replay-suppression slot — no waiter). */
interface PendingStdinMessage {
	text: string;
	resolve?: () => void;
	reject?: (err: Error) => void;
	timer?: NodeJS.Timeout;
}

/** The live state of one spawned claude child the backend can still interject into. */
interface LiveCliRun {
	agentId: string;
	child: ChildProcessWithoutNullStreams;
	/** The CLI-reported session id ('' until the init line arrives). */
	ccSessionId: string;
	/** False once the final result landed / stdin closed — interjects then refuse. */
	acceptingInput: boolean;
	/** stdin-written messages not yet replayed back by the CLI (FIFO). */
	pending: PendingStdinMessage[];
}

/** Join the text blocks of a stream-json `user` message (string or block-array form). */
function userMessageText(obj: Record<string, unknown>): string {
	const message = obj.message as { content?: unknown } | undefined;
	const content = message?.content;
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	return (content as Array<Record<string, unknown>>)
		.filter((b) => b.type === 'text' && typeof b.text === 'string')
		.map((b) => String(b.text))
		.join('');
}

export class ClaudeCliBackend implements CcBackend {
	readonly kind = 'cli';
	// HONEST capability matrix (14.6/F-008): both are REALLY implemented below — interject
	// via live stream-json stdin (replay-acknowledged), resume via `--resume <session-id>`.
	readonly supportsInterject = true;
	readonly supportsResume = true;
	private readonly opts: Required<Omit<CliBackendOptions, 'claudeBin' | 'claudeArgPrefix'>> & {
		claudeBin: string;
		claudeArgPrefix: string[];
	};
	private readonly procs = new Map<string, ChildProcessWithoutNullStreams>();
	/** Every live (still-accepting) run, scanned by ccSessionId on interject. */
	private readonly liveRuns = new Set<LiveCliRun>();

	constructor(opts: CliBackendOptions) {
		this.opts = {
			claudeBin: opts.claudeBin ?? 'claude',
			claudeArgPrefix: opts.claudeArgPrefix ?? [],
			oauthToken: opts.oauthToken,
			maxTurns: opts.maxTurns ?? 1,
			timeoutMs: opts.timeoutMs ?? 180_000,
			interjectAckMs: opts.interjectAckMs ?? 10_000
		};
	}

	run(plan: CcSpawnPlan): CcBackendRun {
		return this.start(plan);
	}

	/**
	 * REAL resume (TASK 14.6 — replaces the 'not implemented' stub that made the UI's
	 * Resume control a lie). Continues the SAME Claude Code conversation via
	 * `--resume <session-id>`, with the plan prompt as the next user message. Requires
	 * the SAME isolated config dir + cwd the original run used (that is where the CLI
	 * stores the transcript) — a missing conversation is an HONEST error event from the
	 * CLI's own exit, never a fabricated success.
	 */
	async resume(req: { ccSessionId: string; plan: CcSpawnPlan }): Promise<CcBackendRun> {
		return this.start(req.plan, req.ccSessionId);
	}

	/**
	 * REAL interject (TASK 14.6 — replaces the 'not implemented' stub). Writes the
	 * already-origin-stamped message (raw operator steering, or fenced agent DATA — the
	 * channel resolved that, D-035a) into the live session's stdin as a stream-json user
	 * message, then waits (bounded) for the CLI to replay it back as receipt. Resolves
	 * ONLY on real acknowledgment; every other path is an honest throw — no live child
	 * for the session, input no longer accepted (turn already finished), write failure,
	 * or ack timeout. Never false success (F-008); never unbounded (F-014).
	 */
	async interject(msg: {
		ccSessionId: string;
		origin: string;
		body: string;
		steer: boolean;
	}): Promise<void> {
		const live = [...this.liveRuns].find(
			(r) => r.ccSessionId === msg.ccSessionId && r.acceptingInput && r.child.exitCode === null
		);
		if (!live) {
			throw new Error(
				`no live claude session '${msg.ccSessionId}' is accepting input — interjection NOT delivered (the session may have finished its turn)`
			);
		}
		await this.writeUserMessage(live, msg.body, this.opts.interjectAckMs);
	}

	/** Write one stream-json user message to a live child's stdin. With `ackMs` set the
	 *  promise resolves only when the CLI replays the message back (real receipt); the
	 *  initial prompt passes ackMs=0 (registered for replay-suppression only). */
	private writeUserMessage(live: LiveCliRun, text: string, ackMs: number): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const entry: PendingStdinMessage = { text };
			const drop = () => {
				const i = live.pending.indexOf(entry);
				if (i >= 0) live.pending.splice(i, 1);
			};
			if (ackMs > 0) {
				entry.resolve = resolve;
				entry.reject = reject;
				entry.timer = setTimeout(() => {
					drop();
					reject(
						new Error(
							`interjection was written but NOT acknowledged by the claude CLI within ${ackMs}ms — delivery unconfirmed`
						)
					);
				}, ackMs);
			}
			live.pending.push(entry);
			const line =
				JSON.stringify({
					type: 'user',
					message: { role: 'user', content: [{ type: 'text', text }] }
				}) + '\n';
			try {
				live.child.stdin.write(line, (err) => {
					if (err) {
						if (entry.timer) clearTimeout(entry.timer);
						drop();
						reject(new Error(`stdin write to claude session failed: ${err.message}`));
					} else if (ackMs <= 0) {
						resolve();
					}
				});
			} catch (err) {
				if (entry.timer) clearTimeout(entry.timer);
				drop();
				reject(new Error(`stdin write to claude session failed: ${(err as Error).message}`));
			}
		});
	}

	/** Spawn one driven session (fresh run, or `--resume <id>` continuation). */
	private start(plan: CcSpawnPlan, resumeCcSessionId?: string): CcBackendRun {
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
		// TASK 13.3 — buildCliSettings ALSO registers the D-018 PreToolUse GATE hook whenever the
		// plan carries gates, so the gate layer is actually consulted on the CLI path (§2.10e).
		const claudeSettings = buildCliSettings(plan, {
			nodeBin: process.execPath,
			serverRoot: process.cwd()
		});
		writeFileSync(settingsPath, JSON.stringify(claudeSettings), 'utf8');

		// TASK 8.4 — when the isolated settings wire hooks (D-019 lifecycle and/or the 13.3 gate
		// hook), pre-accept hook trust for THIS session's cwd in the isolated config dir, or
		// Claude Code silently disables the `--settings` hooks (its per-project hook-trust gate)
		// and no hook ever fires for a driven session. Checked against the FINAL merged map (the
		// gate hook alone must also seed trust). Seeded only for the one cwd this session runs in
		// (isolation preserved). Best-effort — never blocks the spawn; the gate hook's own
		// fail-closed deny (and 1.4a's permissions.deny primary) carry the safety guarantee.
		const hookMap = claudeSettings.hooks as Record<string, unknown> | undefined;
		const configDir = plan.isolated.env.CLAUDE_CONFIG_DIR;
		if (hookMap && Object.keys(hookMap).length > 0 && configDir) {
			seedHookTrust(configDir, plan.cwd);
		}

		// TASK B10 (fix) — deliver any GRANTED mcpServers via a CLI-honored --mcp-config file
		// (the --settings file does NOT load MCP servers — see buildMcpConfigArgs). Written into
		// the same per-session settings dir so it is torn down with the session; [] when nothing
		// is granted (honest OFF — a non-granted session keeps a byte-identical legacy spawn).
		const mcpConfigArgs = buildMcpConfigArgs(plan, settingsDir);

		// TASK 14.6 — stream-json INPUT io. The prompt is NOT an argv string anymore: it is
		// the first stream-json user message written to stdin, and stdin stays OPEN while
		// the turn runs so a REAL interjection can be written into the live session.
		// `--replay-user-messages` makes the CLI echo every stdin user message back on
		// stdout — the honest delivery acknowledgment interject() waits (bounded) for.
		const args = [
			...this.opts.claudeArgPrefix,
			'-p',
			'--output-format',
			'stream-json',
			'--input-format',
			'stream-json',
			'--replay-user-messages',
			'--verbose',
			'--max-turns',
			String(this.opts.maxTurns),
			'--model',
			plan.model.modelId,
			'--permission-mode',
			'default',
			'--settings',
			settingsPath,
			// TASK B10 (fix): load the granted memory-pull MCP server from a CLI-honored config
			// (--mcp-config + --strict-mcp-config); empty when nothing was granted.
			...mcpConfigArgs,
			// REAL resume (14.6): continue the SAME conversation by its Claude Code session id.
			...(resumeCcSessionId ? ['--resume', resumeCcSessionId] : [])
		];

		const env: NodeJS.ProcessEnv = {
			...process.env,
			...plan.isolated.env, // CLAUDE_CONFIG_DIR pinned to the isolated dir (operator's stripped)
			CLAUDE_CODE_OAUTH_TOKEN: this.opts.oauthToken
		};

		// claude is a native .exe — spawn it DIRECTLY (no shell:true) so Node escapes args
		// itself and the settings path never passes through a shell that would mangle it.
		const child = spawn(this.opts.claudeBin, args, {
			cwd: plan.cwd,
			env,
			windowsHide: true
		}) as ChildProcessWithoutNullStreams;
		this.procs.set(plan.agentId, child);
		// Track for the process-shutdown sweep (finding 6): every spawned claude child is
		// tree-killed by killAllClaudeChildren() if the server goes down while it runs.
		liveChildren.add(child);
		child.once('close', () => liveChildren.delete(child));
		// CRITICAL (F-016): a ChildProcess 'error' event (spawn ENOENT — e.g. a resume
		// anchored at a project root that no longer exists — or a missing claude binary)
		// with NO listener is an UNCAUGHT EXCEPTION that kills the whole server process.
		// Capture it; the stream below surfaces it as an honest `error` event instead.
		let spawnError: Error | undefined;
		child.once('error', (err) => {
			spawnError = err;
			liveChildren.delete(child);
		});
		// A dying child can EPIPE a pending stdin write — surfaced via the write callback /
		// pending-ack rejection, never as an unhandled 'error' crash.
		child.stdin.on('error', () => {});

		// Register the live run so interject() can reach THIS child by its session id.
		const live: LiveCliRun = {
			agentId: plan.agentId,
			child,
			ccSessionId: resumeCcSessionId ?? '',
			acceptingInput: true,
			pending: []
		};
		this.liveRuns.add(live);

		// The PROMPT rides stdin as the first user message (ackMs=0: registered only so its
		// replay echo is suppressed below — never duplicated into the transcript). A write
		// failure surfaces on the stream as the child's own exit/error path.
		void this.writeUserMessage(live, plan.prompt, 0).catch(() => {});

		const opts = this.opts;
		const procs = this.procs;
		const liveRuns = this.liveRuns;
		const agentId = plan.agentId;
		// ccSessionId is reported by the CLI's init/result lines; we expose '' (or the
		// resume id) until then (launchSession reads the authoritative one off `done`).
		let reportedCc = resumeCcSessionId ?? '';

		async function* stream(): AsyncIterable<RuntimeEvent> {
			// Timeout = Windows-safe TREE kill (finding 8/F-002): child.kill() alone leaves
			// the claude.exe subtree alive on Windows — the documented orphan storm.
			const timer = setTimeout(() => void treeKillChild(child), opts.timeoutMs);
			const rl = createInterface({ input: child.stdout });
			let stderr = '';
			child.stderr.on('data', (d) => {
				stderr += String(d);
			});
			// Diagnostic tail (F-029): a non-zero exit often carries its reason on STDOUT (a
			// stream-json is_error result) with EMPTY stderr — keep the last raw lines so the
			// exit-error surfaces something actionable instead of "exited 1: ".
			const stdoutTail: string[] = [];
			try {
				for await (const line of rl) {
					const trimmed = line.trim();
					if (!trimmed) continue;
					stdoutTail.push(trimmed);
					if (stdoutTail.length > 12) stdoutTail.shift();
					// GAUNTLET_TRACE=1 mirrors every stream-json line to the server log so an
					// operator can watch a driven session's thinking / tools / result live. Off by
					// default (loopback dev aid; a persisted transcript view is the real follow-up).
					if (process.env.GAUNTLET_TRACE === '1') {
						try {
							const o = JSON.parse(trimmed) as Record<string, unknown>;
							const m = o.message as { content?: unknown } | undefined;
							const blocks = Array.isArray(m?.content)
								? (m!.content as Array<Record<string, unknown>>)
								: [];
							if (o.type === 'assistant' && blocks.length) {
								for (const b of blocks) {
									if (b.type === 'thinking' && b.thinking) console.error(`[trace] 🧠 ${String(b.thinking)}`);
									else if (b.type === 'text' && b.text) console.error(`[trace] 💬 ${String(b.text)}`);
									else if (b.type === 'tool_use') console.error(`[trace] 🔧 ${String(b.name)} ${JSON.stringify(b.input).slice(0, 300)}`);
								}
							} else if (o.type === 'user' && blocks.length) {
								for (const b of blocks) {
									if (b.type === 'tool_result') console.error(`[trace] ↩️  ${(typeof b.content === 'string' ? b.content : JSON.stringify(b.content)).slice(0, 300)}`);
								}
							} else if (o.type === 'result') {
								console.error(`[trace] ✅ result: ${String(o.subtype)} (${String(o.num_turns)} turns, $${String(o.total_cost_usd)})`);
							}
						} catch {
							/* non-JSON noise — skip in trace */
						}
					}
					let obj: Record<string, unknown>;
					try {
						obj = JSON.parse(trimmed);
					} catch {
						continue; // non-JSON noise
					}
					if (typeof obj.session_id === 'string') {
						reportedCc = obj.session_id;
						live.ccSessionId = obj.session_id;
					}
					// A replayed stdin message (--replay-user-messages) is the CLI's RECEIPT for
					// something WE wrote (the prompt or an interjection): resolve its waiter and
					// suppress it from the event stream — the interjection's transcript presence
					// is the channel's own message row (single source), and the prompt is the
					// task text, not an assistant turn. Genuine user events (tool_results) have
					// no matching pending text and flow through to mapCliEvent untouched.
					if (obj.type === 'user') {
						const text = userMessageText(obj);
						const idx = live.pending.findIndex((p) => p.text === text);
						if (idx >= 0) {
							const [entry] = live.pending.splice(idx, 1);
							if (entry.timer) clearTimeout(entry.timer);
							entry.resolve?.();
							continue;
						}
					}
					for (const ev of mapCliEvent(obj)) {
						if (ev.type === 'done') {
							// The turn's final result landed: stop accepting interjections and close
							// stdin so the CLI exits (stream-json input keeps it alive otherwise).
							// The loop keeps reading — a message queued BEFORE the result may still
							// produce a trailing turn + result (last `done` wins downstream).
							live.acceptingInput = false;
							child.stdin.end();
						}
						yield ev;
					}
				}
				const code: number | null = await new Promise((resolve) => {
					if (spawnError || child.exitCode !== null) return resolve(child.exitCode);
					child.once('close', (c) => resolve(c));
					// A failed spawn may never emit 'close' — resolve on 'error' too (F-016).
					child.once('error', () => setImmediate(() => resolve(child.exitCode)));
				});
				if (spawnError) {
					yield {
						type: 'error',
						error: `claude CLI failed to start: ${spawnError.message}`
					};
				} else if (code && code !== 0) {
					// A non-zero exit often carries its reason on STDOUT (a stream-json is_error
					// result) with EMPTY stderr — surface the stdout tail so the error is not blank
					// (F-029: a blank "exited 1:" hid a 401, then a gate-deny, then error_max_turns).
					const detail =
						stderr.trim() ||
						stdoutTail.slice(-3).join(' ⏎ ').slice(0, 800) ||
						'(no stdout/stderr captured)';
					yield { type: 'error', error: `claude CLI exited ${code}: ${detail}` };
				}
			} finally {
				clearTimeout(timer);
				procs.delete(agentId);
				liveRuns.delete(live);
				live.acceptingInput = false;
				// Any interjection still awaiting its ack can no longer be confirmed — reject
				// honestly (the caller persisted nothing; no false success).
				for (const entry of live.pending.splice(0)) {
					if (entry.timer) clearTimeout(entry.timer);
					entry.reject?.(
						new Error('claude session ended before the interjection was acknowledged')
					);
				}
				rmSync(settingsDir, { recursive: true, force: true });
			}
		}

		return {
			get ccSessionId() {
				return reportedCc;
			},
			stream,
			async cancel() {
				// Windows-safe TREE kill (finding 8/F-002) — same primitive as the timeout path.
				await treeKillChild(child);
			}
		} as CcBackendRun;
	}
}
