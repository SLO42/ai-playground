// server/harness/wiring — the UI-action wiring seam for PRODUCT §4 jobs 8/9/10 (TASK 6.7).
//
// The dashboard's write surfaces (launch a session, interject/stop/resume, run a workflow,
// run a release) all need the SAME three things assembled once per boot:
//   • the AgentRuntime  — drives Claude Code (the real CLI backend when credentialed)
//   • the events bus    — the ONE bus the SSE fan-out reads (§2.11), so every action's
//                         effect renders LIVE; we NEVER open a second source
//   • the per-boot token — the D-025 control-plane token, minted in hooks.server.ts and
//                         surfaced as HOOK_TOKEN; the channel seam compares it to decide
//                         operator-origin steering (D-035a). It is NEVER handed to the
//                         runtime — only to the channel seam's `bootToken`.
//
// HONEST AVAILABILITY (F-008 / PRODUCT "honest reporting"): a real Claude Code run needs
// CLAUDE_CODE_OAUTH_TOKEN. When it is absent this wave, `getRuntime()` returns
// { available:false } and the action surfaces an honest "Claude Code credential not
// configured" error rather than spawning a fake/mock run dressed as real. The backend
// LOGIC is the proven mock-tested path; only the credential gates the live spawn.
//
// This module is server-only (imports node child_process via the CLI backend). It is the
// single place the runtime is constructed for UI actions — keeping the construction out of
// every route loader.

import { getEventBus, type EventBus } from '../events';
import {
	ClaudeCodeRuntime,
	type ModelSelection,
	type SpawnBudgets,
	type ToolPolicy,
	type Intent,
	type CapabilityCatalog,
	type CapabilitySet
} from '../runtime/index';
import { OllamaProvider, collectText, type ProviderHealth } from '../providers/index';
import { MemoryService, OllamaEmbedder, type ExtractFn, type MemoryCandidate } from '../memory/index';
import { ClaudeCliBackend } from '../claude-code/cli-backend';
import { catalogIds } from '../cc-config/index';
import { DEFAULT_GATE_POLICY } from '../claude-code/gates';
import { buildDrivenHookSettings } from './hooks-wiring';
import { buildMemoryPullMcpServer, memoryPullGranted } from '../agent/tool-catalog';
import { loadOrchestration, resolveAdaptiveConfig, type IntentClass } from '../config/index';
import type { Db } from '../db/client';

/** The events bus the SSE fan-out reads — the SOLE source (§2.11). */
export function getBus(): EventBus {
	return getEventBus();
}

/**
 * The D-025 per-boot control-plane token (minted in hooks.server.ts → HOOK_TOKEN). Used
 * ONLY as the channel seam's `bootToken` to authenticate operator-origin steering (D-035a).
 * Returns undefined if the boot gate has not run (e.g. a unit context) — the channel then
 * treats every push as a non-operator agent push (fail-closed).
 */
export function getBootToken(): string {
	return process.env.HOOK_TOKEN?.trim() ?? '';
}

/** The runtime, or an honest reason it is unavailable. The concrete ClaudeCodeRuntime is
 *  returned so the channel seam (interject/resume/stop) — which needs the class, not just
 *  the AgentRuntime interface — can use it directly. */
export type RuntimeAvailability =
	| { available: true; runtime: ClaudeCodeRuntime }
	| { available: false; reason: string };

let cachedRuntime: ClaudeCodeRuntime | null = null;

/**
 * Read the LIVE cc-config catalog id-set (the D-036 allow-list, cc-config/sync.catalogIds)
 * from the runtime DB. This is the source of truth `composeCapabilities` validates each
 * spawn's per-task capability set against (fail closed on an unknown id). LIVE DB ONLY
 * (F-008) — never hard-coded. Returns undefined if the read fails, so the runtime still
 * builds (capability provisioning OFF rather than blocking the whole spawn path).
 */
async function resolveCatalog(db: Db): Promise<CapabilityCatalog | undefined> {
	try {
		const ids = await catalogIds(db);
		return { skills: ids.skills, agents: ids.agents, mcp: ids.mcp };
	} catch (err) {
		console.warn(
			'[harness] cc-config catalog read failed — spawning with capability provisioning OFF (harness base only):',
			(err as Error).message
		);
		return undefined;
	}
}

/**
 * Assemble the Claude Code runtime for UI actions. Real CLI backend when
 * CLAUDE_CODE_OAUTH_TOKEN is present (the credentialed live path); otherwise honestly
 * unavailable (no fake run, F-008). Constructed once and cached for the process.
 *
 * The runtime is built with the harness-only isolated config (D-002): the harness's OWN
 * gates (DEFAULT_GATE_POLICY, D-018) ride the per-session --settings, and the LIVE
 * cc-config catalog (D-036 / TASK 5.1) is wired in so `composeCapabilities` actually RUNS
 * on every spawn — validating the task's `req.capabilities` against the real catalog and
 * composing harness-base ⊕ the (catalog-validated) set into the isolated config. Without
 * the catalog this was a DEAD BRANCH (composeCapabilities never ran); passing it here is
 * the fix. `plugins`/`marketplaces` stay empty regardless (D-002 isolation preserved).
 *
 * The catalog is read once at first credentialed construction (the runtime is a per-boot
 * singleton; a cc-config re-sync takes effect on the next process boot / runtime rebuild).
 */
export async function getRuntime(db?: Db): Promise<RuntimeAvailability> {
	if (cachedRuntime) return { available: true, runtime: cachedRuntime };

	const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
	if (!oauthToken) {
		return {
			available: false,
			reason:
				'Claude Code credential not configured (set CLAUDE_CODE_OAUTH_TOKEN). Backend is verified; live spawn is gated on the credential.'
		};
	}

	const backend = new ClaudeCliBackend({ oauthToken });
	// The live catalog is the D-036 allow-list. When a db is supplied, read it so
	// composeCapabilities runs against the REAL catalog (the dead-branch fix). When no db
	// is in hand (e.g. a non-DB caller), capability provisioning stays OFF for that boot.
	const catalog = db ? await resolveCatalog(db) : undefined;
	// TASK 8.4 — the D-019 hook block. Built from the boot-minted loopback coordinates
	// (HOOK_URL/HOOK_TOKEN, surfaced into process.env by hooks.server.ts) so EVERY driven
	// session's isolated settings.json carries the lifecycle-hook commands that invoke the
	// loopback proxy → ingest → agent_event. Without this the runtime built with NO hooks and
	// the hook→agent_event path was dead for live sessions (the 8.4 gap). Honestly OFF (F-008)
	// when the boot gate has not surfaced the coordinates — the session then spawns hook-less
	// rather than half-wired. The proxy no-ops on any failure, so this never blocks a session.
	const hooks = buildDrivenHookSettings({
		env: process.env,
		projectRoot: process.cwd()
	});
	// TASK B10 — the capability-gated agent-tool wiring seam. The runtime calls this with each
	// spawn's COMPOSED, catalog-validated capability set; it registers the B10 memory pull-tool
	// (an isolated-config MCP stdio server) ONLY when the bundle granted `memory-pull` AND the
	// loopback control plane is wired (HOOK_URL/HOOK_TOKEN — D-025). FAIL CLOSED: a non-granted
	// set ⇒ undefined ⇒ no registration (a non-capability'd session can never invoke the tool).
	// The token is NEVER baked into the command — the MCP server reads it from the inherited
	// spawn env, like the hook proxy (hooks-wiring). serverRoot resolves scripts/ under cwd.
	const serverRoot = process.cwd();
	const mcpToolWiring = (capabilities: CapabilitySet): Record<string, unknown> | undefined => {
		if (!memoryPullGranted(capabilities)) return undefined;
		return buildMemoryPullMcpServer({ env: process.env, serverRoot });
	};
	cachedRuntime = new ClaudeCodeRuntime({
		backend,
		harnessConfigRoot: process.env.HARNESS_CONFIG_ROOT?.trim() || '.harness/claude-config',
		// D-018 harness gates ride every isolated --settings (the gate layer still evaluates
		// each tool call regardless; this seeds the composed settings' gate map).
		gates: { ...DEFAULT_GATE_POLICY },
		// D-019 lifecycle hooks (analytics-only) ride every isolated --settings so a driven
		// session POSTs SessionStart/UserPromptSubmit/PostToolUse/Stop to the loopback ingest.
		hooks,
		catalog,
		mcpToolWiring
	});
	return { available: true, runtime: cachedRuntime };
}

/**
 * TASK 14.6 — the HONEST session-control capability matrix the UI consumes (F-008).
 * Derived from the REAL wired backend's declared flags (ClaudeCodeRuntime.capabilities),
 * never assumed: a control the backend cannot really perform is surfaced as disabled-
 * with-reason instead of a button that claims to work and does nothing. `stop` is the
 * runtime's own cancel (always implemented when a runtime exists). When the runtime is
 * unavailable (no credential) every control is off, with the honest reason.
 */
export interface ControlCapabilities {
	/** Whether a runtime exists at all (credential present). */
	available: boolean;
	/** Honest reason when unavailable / a control is off. */
	reason?: string;
	interject: boolean;
	resume: boolean;
	stop: boolean;
}

export async function getControlCapabilities(db?: Db): Promise<ControlCapabilities> {
	const avail = await getRuntime(db);
	if (!avail.available) {
		return { available: false, reason: avail.reason, interject: false, resume: false, stop: false };
	}
	const caps = avail.runtime.capabilities();
	return {
		available: true,
		interject: caps.interject,
		resume: caps.resume,
		stop: true,
		...(caps.interject && caps.resume
			? {}
			: { reason: 'not supported by this backend' })
	};
}

/**
 * The provider-health source resolveRoute reads to decide fallback (TASK 2.3; §2.5; F-005).
 * Routing READS health here and never probes a provider itself — this is the single owner.
 *
 * HONEST mapping (F-008):
 *   • `claude` — the spawn backend for every claude-tier is the Claude Code CLI (driven by
 *     CLAUDE_CODE_OAUTH_TOKEN), NOT the Anthropic direct-chat API. The orchestrator only
 *     starts once getRuntime() confirmed that credential (boot.ts gate), so `claude` is up
 *     exactly when a live spawn is possible. We report it `up` to reflect the REAL backend
 *     that will run the session — using the direct-chat ClaudeProvider.health() (a separate
 *     ANTHROPIC_API_KEY probe) here would falsely fail every credentialed CLI spawn.
 *   • `ollama` — the local-tier floor: probed LIVE against OLLAMA_HOST (no /v1, D-003). A
 *     real GET /api/tags decides up/down; an unreachable Ollama honestly reports down so a
 *     local-tier route falls back up the ladder.
 */
export async function getProviderHealth(): Promise<ProviderHealth[]> {
	const claudeUp = !!process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
	const claude: ProviderHealth = {
		provider: 'claude',
		up: claudeUp,
		detail: claudeUp ? undefined : 'Claude Code credential not configured'
	};

	const endpoint = process.env.OLLAMA_HOST?.trim() || 'http://127.0.0.1:11434';
	let ollama: ProviderHealth;
	try {
		ollama = await new OllamaProvider({ endpoint, model: 'gpt-oss:20b' }).health();
	} catch (err) {
		ollama = { provider: 'ollama', up: false, detail: (err as Error).message };
	}
	return [claude, ollama];
}

/**
 * Resolve the per-task capability set (D-036) for an intent from the live orchestration
 * config's intent→bundle map (D-020). The bundle's `capabilities` block is an explicit,
 * allow-listed `{ skills, agents, mcp }` selection; the runtime catalog-validates it at
 * spawn (fail closed). An intent with no configured bundle/capabilities yields undefined
 * (⇒ the harness base only, no extra capabilities). Degrades to undefined if the config
 * is unreadable — never throws into the launch path.
 */
export function resolveCapabilitiesForIntent(intent: Intent): CapabilitySet | undefined {
	try {
		const dir = process.env.CONFIG_DIR?.trim() || 'config';
		const orch = loadOrchestration(`${dir}/orchestration.yaml`);
		const bundle = resolveAdaptiveConfig(orch, intent as IntentClass);
		const caps = bundle.capabilities;
		if (!caps) return undefined;
		// Normalize the optional-array bundle shape → the runtime's required-array CapabilitySet.
		return { skills: caps.skills ?? [], agents: caps.agents ?? [], mcp: caps.mcp ?? [] };
	} catch {
		return undefined;
	}
}

// ── Sensible defaults the UI actions seed a manual run with ──────────────────────────────
//
// A manual operator-initiated run picks the most-capable tier by default (the operator can
// route differently once 5.x routing UI lands; explicit-override is honored upstream). These
// are the same shapes the launch/runner tests exercise — kept here so every action seeds a
// consistent, valid SpawnRequest.

/** Default model for a manually-launched session (operator picks the powerful tier). */
export const DEFAULT_MODEL: ModelSelection = {
	provider: 'claude',
	modelId: 'claude-opus-4-8',
	tier: 'opus'
};

/** Default agent slot a manual launch runs as. */
export const DEFAULT_AGENT = 'opus-1';

/** Default spawn budgets for a manual run. */
export const DEFAULT_BUDGETS: SpawnBudgets = { thinking: 'high', toolCalls: 20, concurrency: 1 };

/** Default tool policy for a manual run — read/edit/bash, the common code-work surface. */
export const DEFAULT_TOOL_POLICY: ToolPolicy = { allow: ['Read', 'Edit', 'Bash'] };

/** Default intent for a manually-launched session. */
export const DEFAULT_INTENT: Intent = 'code-write';

// ── Memory loop wiring (TASK 8.3) — the live recall/extract surface ─────────────────────
//
// The MemoryService (recall / extractAndStore / buildBriefing) is built + unit/live tested
// but had ZERO production callers. This is the single seam that constructs it for the live
// loop: a real Ollama embedder (qwen3-embedding:0.6b, 1024-dim — D-014) wired to the runtime
// DB, plus the ADD-only extraction LLM call (D-028) driven by the same local Ollama generate
// path. Both degrade HONESTLY (F-008): when Ollama is unreachable, getMemoryService returns
// unavailable and the launch path skips recall/extract rather than fabricating a vector or a
// memory. The memory loop is best-effort (D-019) — it NEVER blocks a spawn.

/** The locked embedding model id (D-014). The dimension is fixed at EMBEDDING_DIM in embed.ts. */
export const EMBEDDING_MODEL = 'qwen3-embedding:0.6b';

/** The local model the ADD-only extraction LLM call runs on (D-028 — one cheap local call). */
export const EXTRACTION_MODEL = 'gpt-oss:20b';

/** The wired memory service, or an honest reason it is unavailable (F-008). */
export type MemoryAvailability =
	| { available: true; memory: MemoryService; extract: ExtractFn }
	| { available: false; reason: string };

let cachedMemory: MemoryService | null = null;

/** The Ollama base host (no /v1 — D-003). Shared by the embedder + the extraction call. A
 *  scheme-less OLLAMA_HOST (e.g. the daemon's bind form `0.0.0.0:11434`) is normalized to a
 *  loopback http URL — a bind address is not a reachable client URL; default to 127.0.0.1. */
function ollamaEndpoint(): string {
	let host = process.env.OLLAMA_HOST?.trim() || 'http://127.0.0.1:11434';
	if (!/^https?:\/\//i.test(host)) {
		// A scheme-less value is a bind/host:port form. 0.0.0.0 is a listen address, not a
		// dialable client target — map it to loopback so the client can actually connect.
		host = `http://${host.replace(/^0\.0\.0\.0/, '127.0.0.1')}`;
	}
	return host;
}

/**
 * The THREE distinct probe outcomes — never conflated (F-008). The earlier code returned a
 * bare boolean, so a cold-boot fetch timeout (Ollama busy loading a large model from a custom
 * OLLAMA_MODELS path) was indistinguishable from a genuinely-absent model and surfaced the
 * MISLEADING 'has no <model>' reason while latching the memory loop OFF. Distinguishing the
 * three lets `getMemoryService` report an honest, actionable reason for each:
 *   • 'present'     — Ollama reachable AND the embedding model exact-matches EMBEDDING_MODEL.
 *   • 'absent'      — Ollama reachable (a real /api/tags response) but the model is NOT listed.
 *   • 'unreachable' — the probe could not get a verdict: connection refused, DNS/socket error,
 *                     a non-OK HTTP status, OR the request TIMED OUT. This is TRANSIENT — the
 *                     memory loop must retry next call, NOT latch off with a 'no model' lie.
 */
export type EmbeddingProbeOutcome = 'present' | 'absent' | 'unreachable';

/** Cold-boot tolerance (task fix #2): a warm Ollama answers /api/tags instantly, but a cold one
 *  loading a large model can exceed a couple seconds. 8s is forgiving without wedging the spawn
 *  path; combined with ONE retry on a transient failure (timeout/refused), a slow cold boot is
 *  given a fair chance before we conclude unavailable. */
const EMBED_PROBE_TIMEOUT_MS = 8000;

/** One single /api/tags probe attempt. Returns the verdict, or 'unreachable' for ANY failure to
 *  obtain one (throw — connection refused / DNS / TimeoutError from AbortSignal.timeout — or a
 *  non-OK status). NEVER reports a transient failure as 'absent'. */
async function probeOnce(endpoint: string): Promise<EmbeddingProbeOutcome> {
	let res: Response;
	try {
		res = await fetch(`${endpoint}/api/tags`, { signal: AbortSignal.timeout(EMBED_PROBE_TIMEOUT_MS) });
	} catch {
		// Connection refused (TypeError), DNS/socket error, or AbortSignal.timeout → TimeoutError.
		// All are transient/unreachable — the caller retries / surfaces the retry reason, never 'absent'.
		return 'unreachable';
	}
	// A reachable Ollama that answers with a non-OK status is also treated as no-verdict (transient),
	// not as proof the model is absent — we only conclude 'absent' from a real, parsed model list.
	if (!res.ok) return 'unreachable';
	let j: { models?: { name?: string }[] };
	try {
		j = (await res.json()) as { models?: { name?: string }[] };
	} catch {
		return 'unreachable'; // a truncated/garbled body is not proof of absence
	}
	return (j.models ?? []).some((m) => m.name === EMBEDDING_MODEL) ? 'present' : 'absent';
}

/**
 * Probe the local Ollama for the embedding model, distinguishing the three honest outcomes
 * above. The memory loop needs LIVE embeddings to recall/extract; we only skip it on a true
 * 'absent' (with a pull hint) — never on a transient 'unreachable', which the loop retries.
 *
 * Cold-boot tolerance + ONE retry (task fix #2/#3): on a transient 'unreachable' first attempt
 * we probe ONCE more before concluding, so an Ollama still loading a large model at cold boot
 * gets a second chance instead of latching the loop off. A definitive 'absent' (Ollama clearly
 * answered, model not listed) is NOT retried — retrying a clear answer would only add latency.
 */
export async function embeddingModelReady(endpoint: string): Promise<EmbeddingProbeOutcome> {
	const first = await probeOnce(endpoint);
	if (first !== 'unreachable') return first; // 'present' or definitive 'absent' — no retry needed
	// Transient on the first attempt — retry ONCE (cold Ollama may have just finished loading).
	return await probeOnce(endpoint);
}

/**
 * The ADD-only extraction LLM call (D-028 / MEMORY-SPEC §3.2). ONE cheap local Ollama call
 * over the just-finished turn → additive candidates only (it NEVER decides update/delete —
 * that is the deterministic consolidator's job, D-028). The model is asked for a strict JSON
 * array of `{content, kind}`; a non-JSON / empty reply yields zero candidates (best-effort,
 * never throws into the launch path). The screen-before-embed gate (store.ts) still runs on
 * every returned candidate, so a poisoned/secret-bearing extraction is screened before storage.
 */
function makeExtractFn(endpoint: string): ExtractFn {
	const provider = new OllamaProvider({ endpoint, model: EXTRACTION_MODEL });
	return async (prompt: string): Promise<MemoryCandidate[]> => {
		const sys =
			'You extract durable, additive memories from a coding-agent session transcript. ' +
			'Return ONLY a JSON array of objects {"content": string, "kind": "semantic"|"episodic"|"procedural"}. ' +
			'Each content is one concise, durable fact/decision/procedure worth remembering across sessions. ' +
			'Never restate transient state or the prompt itself. If nothing is worth keeping, return [].';
		let text = '';
		try {
			const chunks = [];
			for await (const c of provider.stream([
				{ role: 'system', content: sys },
				{ role: 'user', content: prompt }
			])) {
				chunks.push(c);
			}
			text = collectText(chunks);
		} catch {
			return []; // best-effort: an extraction-model failure never breaks the loop
		}
		return parseExtraction(text);
	};
}

/**
 * Undo a DOUBLE-ENCODED backslash artifact in extracted memory content (TASK 14.4e —
 * audit-confirmed F-008). Some local extraction models escape the JSON string contents
 * one extra time (the raw reply carries `F:\\\\code\\\\…`), so even after the real
 * JSON.parse the candidate still holds literal `\\` pairs — which then persist and
 * render as `F:\\code\\…` on /memory, duplicating the clean fact.
 *
 * Targeted to exactly that artifact class: `\\` pairs collapse to `\` ONLY when every
 * backslash in the text is part of a pair. A clean Windows path (`F:\code`) or prose
 * containing a lone `\` (e.g. "split on \n") has unpaired backslashes and is returned
 * untouched — we never "fix" legitimate content.
 */
export function unescapeDoubleEncoded(text: string): string {
	if (!text.includes('\\')) return text;
	// Strip all `\\` pairs; any backslash left over is a REAL single backslash → leave as-is.
	if (text.replace(/\\\\/g, '').includes('\\')) return text;
	return text.replace(/\\\\/g, '\\');
}

/** Parse the extraction model's reply into ADD-only candidates. Tolerant: finds the first JSON
 *  array, ignores malformed entries, caps the batch. A non-array / empty reply ⇒ [].
 *  14.4e: candidate content passes the doubled-backslash de-escape (write-path fix). */
export function parseExtraction(text: string): MemoryCandidate[] {
	const start = text.indexOf('[');
	const end = text.lastIndexOf(']');
	if (start < 0 || end <= start) return [];
	let arr: unknown;
	try {
		arr = JSON.parse(text.slice(start, end + 1));
	} catch {
		return [];
	}
	if (!Array.isArray(arr)) return [];
	const out: MemoryCandidate[] = [];
	for (const raw of arr) {
		if (out.length >= 12) break; // cap one turn's additive batch
		if (!raw || typeof raw !== 'object') continue;
		const r = raw as { content?: unknown; kind?: unknown };
		const content = typeof r.content === 'string' ? unescapeDoubleEncoded(r.content.trim()) : '';
		if (!content) continue;
		const kind = r.kind === 'episodic' || r.kind === 'procedural' ? r.kind : 'semantic';
		out.push({ content, kind, source: 'session-extract' });
	}
	return out;
}

/**
 * Assemble the live memory service for the loop (TASK 8.3). Builds an OllamaEmbedder over the
 * local host (no /v1, D-003) wrapped in the two-tier cache (store/recall hot path, §7.1), plus
 * the ADD-only extraction call. Returns an honest unavailable result when Ollama / the embedding
 * model is not reachable — the launch path then skips recall+extract (F-008), never fabricating
 * a vector or a memory. Cached per process (the embedder is stateless; the cache lives in the DB).
 */
export async function getMemoryService(db: Db): Promise<MemoryAvailability> {
	const endpoint = ollamaEndpoint();
	const outcome = await embeddingModelReady(endpoint);
	if (outcome !== 'present') {
		// HONEST, OUTCOME-SPECIFIC reason (F-008) — NEVER conflate "model absent" with "couldn't
		// reach Ollama / probe timed out". The latter is transient: because we DON'T cache on this
		// path, the very next getMemoryService call re-probes and can enable the loop once a cold
		// Ollama finishes loading — it never latches the loop off for the process (task fix #3).
		const reason =
			outcome === 'absent'
				? `Ollama at ${endpoint} has no ${EMBEDDING_MODEL} — run: ollama pull ${EMBEDDING_MODEL}`
				: `Ollama probe at ${endpoint} timed out/unreachable — memory loop will retry`;
		return { available: false, reason };
	}
	if (!cachedMemory) {
		cachedMemory = new MemoryService({ db, embedder: new OllamaEmbedder({ endpoint, model: EMBEDDING_MODEL }) });
	}
	return { available: true, memory: cachedMemory, extract: makeExtractFn(endpoint) };
}
