# ARCHITECTURE — ai-playground v2

> ## ⚠ This file is a frozen 2026-06 planning snapshot, not current
>
> Kept for original intent and rationale — never as a description of what exists today.
> It plans 16 server modules; `src/lib/server/` now holds 41. The authoritative, current
> doc set lives in the docs checkout: **`F:\code\ai-playground\docs\`** (branch `v2-main`).
> Index of this frozen set: [README.md](./README.md).

This describes the **target** system. It is deliberately simpler than v1. Where v1 had many moving parts, v2 collapses them: one datastore, one orchestrator, one event stream, one runtime interface.

---

## 1. System overview

```
                        ┌──────────────────────────────────────────────┐
                        │                  Dashboard                     │
                        │   SvelteKit 2.x + Svelte 5 (runes) + Tailwind  │
                        │              v4 (SSR)                          │
                        │  pages ── stores ── 1 SSE/event stream         │
                        └───────────────┬────────────────────────────────┘
                                        │ HTTP + SSE
                                        │   ▲ (SSE fan-out)
                        ┌───────────────┴───┴─────────────────────────────┐
                        │              Application / Server               │
                        │  (SvelteKit server routes = thin API layer)     │
                        │                                                 │
                        │  ┌──────────────────────────────────────────┐   │
                        │  │  events bus  ── SOLE SSE source ──────────┼───┘
                        │  │  (db live-queries + transcripts republish │   ▲
                        │  │   here; everything subscribes here only)  │   │
                        │  └────▲─────────▲──────────────▲─────────────┘   │
                        │       │         │              │                 │
                        │  ┌────┴───────┐ │ ┌────────────┴─┐  ┌─────────┐  │
                        │  │ Orchestrator│ │ │ Routing +    │  │ Memory  │  │
                        │  │ (event-     │ │ │ Analytics    │  │ Service │  │
                        │  │  driven)    │ │ │              │  │ (vec+   │  │
                        │  └─────┬──────┘ │ └──────┬───────┘  │  graph) │  │
                        │        │        │        │          └────┬────┘  │
                        │        ▼        │        ▼               │       │
                        │  ┌──────────────────────────────┐      │       │
                        │  │      AgentRuntime (iface)      │      │       │
                        │  │  spawn · stream · tools · route│      │       │
                        │  └───────┬──────────────┬─────────┘      │       │
                        │  ┌───────┴──────────────────────────┐    │       │
                        │  │  Claude Code harness (beside the  │    │       │
                        │  │  orchestrator, all on AgentRuntime)│   │       │
                        │  │  session-orch · cc-config · workflows   │       │
                        │  └───────────────────────────────────┘    │       │
                        └──────────┼──────────────┼────────────────┼───────┘
                                   │              │                │
                   ┌───────────────┘              │                │
                   ▼                              ▼                ▼
        ┌──────────────────┐        ┌──────────────────┐   ┌──────────────────┐
        │  Runtime impl     │        │  Provider adapters│   │   SurrealDB       │
        │  = Claude Code    │        │  Ollama / Claude  │   │  (server binary,  │
        │  (Agent SDK / CLI)│        │                   │   │   ws:// loopback) │
        │  harness (D-002)  │        └──────────────────┘   │  document+graph+  │
        └──────────────────┘                                │  vector+FTS, ACID │
                                                            └──────────────────┘
```

**Key idea:** every box talks to SurrealDB for state (except Claude Code config, which is filesystem-authoritative per D-010 — the DB mirrors it) and to `AgentRuntime` for execution. Nothing else holds authoritative state; nothing else knows *how* agents run. The harness services sit beside the orchestrator, all on `AgentRuntime`, and the `events` bus is the single explicit source for the one SSE fan-out to the dashboard.

---

## 2. Components

### 2.1 Datastore — SurrealDB (managed server binary)
Single source of truth (for product state). Document tables for entities, graph edges for the knowledge graph, HNSW vector index for semantic memory, ACID transactions for safe writes. Runs as a **managed local server binary** over `ws://127.0.0.1` (`surrealkv` backend) — no native addon (D-006, KongCode's path). The services manager provisions/spawns/health-checks the binary; a small **`db` module** owns the single long-lived `Surreal` client (singleton), runs migrations on boot, and exposes typed query helpers. No other module opens the DB directly. See [DATA-MODEL.md](./DATA-MODEL.md).

### 2.2 Orchestrator (configurable, event-driven)
Replaces v1's always-on 60s loop. Responsibilities:
- Subscribe to **triggers**: task created/updated (via SurrealDB live query or an internal event bus), manual run (API), optional file-watch, optional periodic timer.
- For each trigger, build a **work item**, ask Routing to classify + pick a model tier, then call `AgentRuntime.spawn`.
- Enforce concurrency limits via **two distinct queues** (see below) — **not** a busy loop.
- Track lifecycle: spawn → running → complete/failed → post-task (commit/test/follow-up).

**Concurrency caps — two distinct queues.** There are two separate mechanisms; each kind of work uses exactly one:
- **(a) Interactive spawns** — gated by an **in-process semaphore** living in the long-lived SvelteKit server. Caps (max concurrent agents, per-project caps) come from `config/orchestration.yaml`; per-project caps are counted by querying running `session` rows (or an in-memory map of in-flight spawns). This is the path for interactive agent runs via `AgentRuntime.spawn`.
- **(b) Background heavy work** — drained off the interactive path via the DB `work_item` **claim-token queue** (D-021): post-task knowledge extraction, follow-up planning, maintenance.

The two are **separate**: an interactive spawn never sits in the `work_item` queue, and a background job never consumes the interactive semaphore. An interactive agent never blocks on background extraction.

Modes (config, D-004): `event` (default), `periodic` (off by default), `manual`. Idle in `event` mode = subscriptions only, ~zero CPU.

**Background work queue (D-021, KongCode-proven).** Heavy/non-interactive work (post-task knowledge extraction, follow-up planning, maintenance) goes to a `work_item` queue drained off the interactive path: **atomic claim** (`UPDATE … SET claim_token WHERE claim_token IS NONE RETURN count`), **UNIQUE dedup keys** (D-008) for exactly-once-ish semantics, **priority** ordering, a **drain trigger** (event/threshold, never a busy loop), a **daily spawn cap**, stale-item GC, and a **synchronous handoff record** for crash recovery. An interactive agent never blocks on extraction.

### 2.3 AgentRuntime (interface) — the OpenClaw replacement seam
A narrow interface the whole system codes against, so the concrete runtime is swappable. Default impl = **Claude Code** (D-002); the interface keeps direct-provider chat or a future runtime pluggable.

```ts
interface AgentRuntime {
  // Run an agent to completion; streams progress events.
  spawn(req: SpawnRequest): AsyncIterable<RuntimeEvent>;
  // Provider-level routing/health for fallback decisions.
  health(): Promise<RuntimeHealth>;
  // Tools the runtime exposes (file/exec/git), for capability checks.
  tools(): ToolDescriptor[];
  // Cancel a running agent.
  cancel(agentId: string): Promise<void>;
}

interface SpawnRequest {
  agentId: string;
  projectId: string;
  cwd: string;                 // project working dir, passed explicitly
  model: ModelSelection;       // provider + model id, from Routing
  intent: Intent;              // classified intent (from Routing's ResolvedPlan)
  task: { id: string; title: string; description: string };
  context?: ContextBundle;     // recalled memory/graph context — separate field, never mutates task
  budgets: SpawnBudgets;       // thinking level / tool / concurrency budgets (D-020) — separate from toolPolicy
  toolPolicy: ToolPolicy;      // allow-list + confirmation gating (allow-list only; budgets are separate)
  workflowRunId?: string;      // set when this spawn is a workflow step (D-013) — workflow steps spawn through the same runtime
}

type RuntimeEvent =
  | { type: 'log'; message: string }
  | { type: 'tool_call'; name: string; args: unknown; needsConfirm: boolean }
  | { type: 'tool_result'; name: string; ok: boolean; output: string }
  | { type: 'token_usage'; input: number; output: number }
  | { type: 'done'; result: AgentResult }
  | { type: 'error'; error: string };
```

Design constraints (from D-008): concurrent `spawn` calls must be safe (no shared mutable hang state — prefer per-process isolation or a real queue); tool calls requiring confirmation **block** until resolved; no tool/role messages silently dropped; resources cleaned up in `finally`.

**Primary impl: Claude Code (D-002).** v2 is a Claude Code harness — agents run as Claude Code sessions/runs via the **Claude Agent SDK** (programmatic/headless) and/or the **Claude Code CLI** (interactive parity for interject/resume). The S.1 spike fixes the SDK/CLI split. The `AgentRuntime` interface stays stable so direct-provider chat (Ollama/Claude) or a future runtime can still plug in, but Claude Code is the default. Concurrency safety comes from isolated sessions/processes + the orchestrator queue (no shared hang state — kills the v1 gateway bug).

**Runtime → providers dependency applies to the direct-chat impl only.** The **default** runtime impl (Claude Code) talks to the **Anthropic API itself** and does **not** depend on the `providers` adapters. `providers` (Ollama / Claude direct-chat) is used only by **non-Claude-Code runtime paths and simple chat**. So `runtime`'s declared dependency on `providers` (§5) applies to the direct-chat impl only, not to the Claude Code default.

### 2.4 Provider adapters
Behind `AgentRuntime` (or used directly for simple chat). One adapter per provider implementing a common `stream(messages, tools)` contract:
- **Ollama** — REST `127.0.0.1:11434/api/chat` (no `/v1` suffix), default `gpt-oss:20b` (D-003). Local, $0.
- **Claude** — Anthropic API; Opus/Sonnet/Haiku. Tool-use format conversion lives here.
Model identity is config-driven; adding/swapping a model is config, not code.

### 2.5 Routing + Analytics
- **Routing**: one `resolveRoute(task)` function. Order: **explicit override → intent classification → tier selection → adaptive config → provider/health → fallback.** (v1 fail F-005: explicit override must win.) Classification decides **intent** (simple-question / code-read / code-write / code-debug / deep-explore…); tiering maps complexity → cheapest capable model with escalation (Haiku→Sonnet→Opus) and delegation (Opus→cheaper for subtasks). **Intent-adaptive config (D-020):** the resolved intent selects a config bundle — thinking level, tool-call/concurrency budget, and memory-retrieval depth + token share — so trivial requests stay cheap and debug/explore tasks get deep retrieval. Bundles live in `config/orchestration.yaml`. **Provider health has a single owner: `providers`.** Both `routing` and `runtime` *read* provider health from `providers` — they do **not** each probe it independently. **Routing is the producer of `routing_event`**: it writes every routing decision; `analytics` only *queries* `routing_event` (and other event tables) for reports — it never writes routing decisions.
- **Analytics**: first-class. Every routing decision and agent lifecycle event is written to SurrealDB as a queryable record with full rationale (why this provider/model, intent, complexity score, cost, duration, escalations, outcome). Drives the reports/agents pages. **Rollups + anomaly detection (KongCode pattern):** per-turn metrics roll up into daily aggregates (mean tool calls, tokens, p95 duration, tool-failure rate); an anomaly check flags regressions with severity + cooldown so the reports page shows trends ("improving vs degrading"), not just raw events.

### 2.6 Memory service (vector + graph, unified)

> **The memory/learning engine now has a dedicated spec — see [MEMORY-SPEC.md](./MEMORY-SPEC.md) for the full design** (two-tier loop, extraction, recall, lifecycle, SurrealDB gotchas), folded from the cannibalize research. This section keeps the system-level view; the spec holds the detail.

**Learning-loop summary (detail in MEMORY-SPEC.md).** Memory writes happen via a **two-tier learning loop** — a fast in-use writer fork mines each just-finished turn for memory/skill writes async, decoupled from a slow periodic consolidator that merges narrow knowledge into class-level umbrellas and GCs stale items (D-027, *hermes*). Extraction is **ADD-only** (one cheap LLM call), with dedup/supersession/contradiction handled in a separate deterministic/graph conflict pass rather than trusting the LLM to mutate in place (D-028, *mem0 + kongcode*). **Cross-session recall returns raw windowed messages + first/last bookends with no summary-LLM in the path** (D-029, *hermes*) — distinct from the WMR/rerank MEMORY recall ranking below, which scores and bands semantic-memory hits.

- **Store**: memory entries with embeddings (semantic), plus episodic and procedural entries — all SurrealDB records.
- **Recall**: hybrid, modeled on KongCode's proven pipeline — **(1)** multi-table vector KNN (HNSW) with per-table budgets, batched in one round-trip; **(2)** graph expansion (1–2 hop BFS from top seeds along typed edges); **(3)** optional FTS for keyword misses; **(4)** merge + dedup by id; **(5)** **WMR scoring** `0.5·cosine + 0.35·historical_utility + 0.15·recency_decay`; **(6)** optional cross-encoder rerank + salience banding (load-bearing/supporting/background). Returns a ranked, budget-trimmed `ContextBundle`. Bumps `access_count`/`last_accessed` on hit.
- **Knowledge graph**: native SurrealDB `RELATE` edges between memory/entity nodes (typed edges: references/supports/contradicts/derived-from). Replaces v1 `graph-state.json`.
- **Bridge**: imports from Claude auto-memory `.md` files (and optionally other sources), dedup by key+namespace.
- **Session injection (KongCode "wakeup")**: on a Claude Code session start for a project, inject a compact briefing — recent tasks/decisions, unresolved items, relevant memories/conventions — into the session context (via the SessionStart hook, best-effort, D-019). Each injected item carries a **retrieval rationale** and a **citation id** so the model knows *why* it's there and so the learning loop (D-022) can later tell which items proved useful. Retrieval spends a bounded **context budget** (~15–20%), salience-banded (load-bearing / supporting / background) and trimmed — never bloat the prompt.

### 2.7 Project scanner & registry
Carried from v1 (it's good). Scans a code root, detects ecosystem and mod frameworks, writes/updates a `project` record. Registry is a SurrealDB table, not `registry.json`.

### 2.8 Services manager
Start/stop/health/auto-restart for the local model server (Ollama), the SurrealDB server (D-006), and the engine. Uses Windows-safe process control (`tasklist`/`taskkill`, `shell:true` on spawn — fails F-001/F-002). PID registry is a SurrealDB table. The dashboard itself self-reports status only (it can't start/stop itself).

### 2.9 Dashboard
SvelteKit 2.x + Svelte 5 (runes) SSR. Server routes are a **thin** API over the services above. Client uses Svelte 5 runes; **one SSE/event stream** carries live updates (agent events, task changes, metrics, **live Claude Code transcripts**) instead of many independent pollers. Pages gated by feature flags.

### 2.10 Claude Code harness layer
The harness is three services (a–c) plus two cross-cutting mechanisms (d–e), all built on the Claude Code runtime (2.3):

**(a) Session orchestration** (`server/claude-code`) — launches Claude Code sessions (interactive or headless), maps them to `session` records carrying `cc_session_id`, streams **transcript events** (assistant/tool/usage) to the event bus, and exposes control actions: **interject** (send a message into a running session), **stop** (cancel), **resume** (by `cc_session_id`). Fleet view = query of running sessions (D-011).

**(b) Config manager** (`server/cc-config`) — the cross-project control surface for Claude Code configuration. Reads and edits, per-project and global:
- `.claude/settings.json` — hooks, permissions (e.g. valid `mcp__server__*` rules), env, MCP servers, enabled plugins
- `.claude/agents/*.md` — agent definitions (YAML frontmatter)
- `.claude/skills/*/SKILL.md` — skills
- `.mcp.json` — project MCP servers
- `CLAUDE.md` — project instructions

**Filesystem is authoritative** (Claude Code reads from disk); SurrealDB holds a synced **mirror/index** for fast query + the dashboard view (D-010). Flow: dashboard edit → validate → write file → re-sync mirror. A watcher keeps the mirror current when files change outside the app. Never silently overwrite hand edits — diff and confirm.

**(c) Workflow runner** (`server/workflows`) — defines and executes headless multi-step Claude Code pipelines (steps = prompt + agent + model + cwd, with dependencies / parallel fan-out). Built on the Claude Agent SDK. Tracked as `workflow_run` + per-step `session` records, streamed live, with full analytics (D-013). Triggerable manually, by orchestrator events, or opt-in periodically.

**(d) Hook transport + graceful degradation (D-019).** Claude Code hooks fire as **short-lived processes**; our state lives in the long-lived SvelteKit server. Bridge: a tiny **hook-proxy** script (registered in `.claude/settings.json`) that each hook invokes; it POSTs the hook payload to the local server over loopback with a **short, per-hook timeout** (SessionStart ~30s, UserPromptSubmit ~15s, tool hooks ~10s). On any failure/timeout/server-down it **no-ops** (returns empty, never blocks or errors the session). Memory injection, analytics capture, and gates are all best-effort. *(Validated live: KongCode's daemon was down this whole session and Claude Code was unaffected — exactly this design.)*

**(e) Gates — agent guardrails (D-018).** Evaluate the agent's pending tool call against configurable **gates**: config-protection (block edits to our `.claude/`, `.env`, secrets), read-before-edit, dangerous-bash. Soft-warn or hard-block per gate, per project. The runtime complement to D-008/D-016 for *agent-initiated* actions.

Both enforcement paths consult the **same gate config**:
- The **SDK / headless path** enforces gates via the SDK tool-policy callback (`canUseTool`).
- The **CLI / interactive path** enforces gates via the `PreToolUse` hook.

**Safety-critical gates fail CLOSED, enforced via Claude Code's own `permissions.deny`** (D-024) — locally enforced by Claude Code even if our server is down. The `canUseTool` callback and the `PreToolUse` network/hook gates are **defense-in-depth only**; they must not be the sole barrier for a safety-critical action.

### 2.11 Event plumbing
There is **one** path for live state to reach the dashboard, and it is the system's single biggest build-blocker if gotten wrong — so it is specified explicitly:

- **`db` owns all SurrealDB live queries / change-feeds.** No other module opens its own live query. `db` republishes those change events onto the internal **`events` bus**.
- **Runtime transcript streams** (Claude Code assistant/tool/usage events from the harness) also publish onto the **`events` bus**.
- The **`events` bus is the SOLE source** for the **one SSE fan-out** to the dashboard. There is exactly one SSE endpoint; it reads only from `events`.
- **Every consumer subscribes to `events` only — including the orchestrator.** A consumer must **not** open its own SurrealDB live query for state it can get from `events`. This avoids the **double-fire** problem (a change arriving once via a direct live query and again via the bus).

**Per-client SSE subscription model + backpressure.** Each connected dashboard client gets its own SSE subscription off the `events` bus (filtered to what that client/page needs). The fan-out applies **backpressure**: if a client is slow, the server **drops or coalesces** events for that client (latest-wins coalescing for high-frequency event types such as `token_usage`/metrics; drop-oldest for pure log spam) rather than buffering unboundedly or stalling the bus. A slow client never blocks the bus or other clients.

---

## 3. Data flow — a task from creation to done

```
1. User (or scanner, or follow-up) creates a `task` record in SurrealDB.
2. Orchestrator's task subscription fires (live query / event bus).
3. Routing.resolveRoute(task):
     explicit override? → else classify intent → tier → adaptive config → provider/health
     → emits ResolvedPlan { model, intent, adaptiveConfig }
   (decision written to `routing_event`)
4. Memory.recall(task, adaptiveConfig.retrievalDepth/budget) → ContextBundle
     (vector KNN + graph + FTS) — adaptive config resolves BEFORE recall, so retrieval
     depth/budget is driven by the resolved intent
5. Orchestrator.enqueue(SpawnRequest) respecting concurrency caps
6. AgentRuntime.spawn(req) → streams RuntimeEvents:
     - log / tool_call(confirm gate) / tool_result / token_usage
     - analytics rows written as events arrive
7. On 'done':
     - AgentResult persisted; `agent_event` completion row (duration, tokens, cost)
     - Post-task: git commit via execFile(array) [no shell injection],
       run project test command, optionally plan follow-up tasks
8. Memory updated with what was learned (new memory entries + graph edges)
9. Dashboard receives all of the above over the SSE stream → live UI update
```

Everything in steps 1–9 is a SurrealDB transaction where a multi-write must be atomic (e.g. task status + analytics + follow-up creation), removing v1's TOCTOU races.

---

## 4. Dashboard page set (trimmed)

v1 had ~30 pages. v2 consolidates. Proposed global pages:

| Page | Purpose | Consolidates (v1) |
|------|---------|-------------------|
| `/` | Home / portfolio overview | home |
| `/projects` + `/projects/[id]/…` | Project workspace: overview, tasks, roadmap, sessions, memory, release, settings | most `/projects/[id]/*` |
| `/agents` | Pool, usage, catalog, live activity | agents, agents usage/catalog |
| `/chat` | Multi-provider chat (global + project-scoped) | chat, sessions, channels |
| `/memory` | Knowledge graph + semantic search explorer | memory |
| `/reports` | Analytics: routing, cost, outcomes | reports, models analytics |
| `/services` | Health, logs, start/stop | services, diagnostics |
| `/claude-code` | Harness hub: session fleet (live transcripts, interject/stop/resume), config manager (hooks/skills/agents/MCP/`settings.json`/`CLAUDE.md` per-project + global), catalog | hooks + agent/skill scanners (v1) |
| `/workflows` | Define + run headless Claude Code pipelines; run history | (new) |
| `/settings` | General, routing, model slots, orchestration mode, memory, API keys | settings |

Dropped/deferred: standalone `/channels` (Twitch), `/inbox`, `/notifications` as top-level (fold into a header tray), `/templates` and `/apps` (until needed), `/demo` (dev-only).

Per-project tabs: **Overview · Tasks · Roadmap · Sessions · Memory · Release · Settings.**

Page count target: **~8 global + 7 project tabs**, down from 30. Endpoint count target: well under v1's 81, since one SSE stream replaces many polling endpoints.

---

## 5. Module boundaries (server)

Each module has one purpose, a typed interface, and clear dependencies:

```
server/
  db/              SurrealDB connection, migrations, typed query helpers   (depends on: nothing)
  events/          internal event bus + SSE fan-out                        (depends on: db)
  scanner/         ecosystem detection, project registry upsert            (depends on: db)
  projects/        project + plan CRUD, project-plan v3 shape              (depends on: db)
  tasks/           task CRUD, status machine                               (depends on: db, events)
  routing/         resolveRoute, classify, tiering, routing_event write    (depends on: db, providers)
                   (reads provider health from providers; never probes itself)
  providers/       ollama, claude adapters (common stream iface);          (depends on: config)
                   SINGLE owner of provider health
  runtime/         AgentRuntime interface (default impl = claude-code)     (depends on: db; providers only
                   for the direct-chat impl — the Claude Code default talks to Anthropic API itself)
  claude-code/     CC session orchestration: launch/stream/interject/      (depends on: runtime, events, db)
                   stop/resume; SDK + CLI drivers (D-002, D-011)
  cc-config/       Claude Code config manager + mirror sync + watcher       (depends on: db, events)
                   (.claude/settings.json, agents, skills, .mcp.json, CLAUDE.md) (D-010)
  workflows/       headless multi-step CC pipeline runner (D-013)          (depends on: claude-code, db, events)
  orchestrator/    triggers, queue, lifecycle, post-task/test/follow-up    (depends on: tasks, routing, runtime, memory, events)
  memory/          store, recall (vector+graph+fts), bridge, graph edges   (depends on: db, providers)
  analytics/       rollups + query for reports (queries routing_event etc.; (depends on: db)
                   does NOT write routing decisions — routing is the producer)
  services/        process control, health, auto-restart (Windows-safe)    (depends on: db)
  config/          load agent-pool, models, orchestration settings         (depends on: nothing)
```

Dependency rule: arrows point **down/inward** toward `db`/`config`. No cycles. A module is testable by mocking its declared deps.

---

## 6. Configuration

- `config/agent-pool.yaml` — tiers (local/haiku/sonnet/opus), per-agent roles, escalation/delegation rules. (Carried from v1 shape.)
- `config/models.{yaml,json5}` — provider endpoints + model ids (the swappable "model slots", D-003).
- `config/orchestration.yaml` — mode (`event`/`periodic`/`manual`), triggers, interval, concurrency caps.
- `.env` — secrets (API keys), never committed. `.env.example` documents keys.
- Feature flags — env-based, gate dashboard pages (carried from v1).

No TLS certs, no Ed25519 device identity, no gateway ACL files unless the D-002 spike reintroduces a gateway.

---

## 7. Security & threat model

### 7.1 Threat model

**Actors:**
- **Operator** — the trusted human running the machine.
- **The autonomous Claude Code agent** — **semi-trusted and prompt-INJECTABLE**. A task description, a file it reads, or recalled memory can carry adversarial instructions. **Model the agent as an adversary:** assume any tool call it can make, it might be tricked into making.
- **Other local processes / users** on the machine.
- **Browser origins** — a malicious web page the operator visits can attempt **DNS-rebinding / CSRF** against our loopback services.
- **Supply chain** — npm dependencies, the downloaded SurrealDB binary, model artifacts.

**Trust boundaries:** the loopback services (control plane), the **code root**, and **`.env`**. Crossing any of these is a privileged action.

**Assets:** API keys, SurrealDB credentials, source code under the code root, and **memory** (which may contain secrets / PII).

**Single-operator assumption (stated explicitly):** v2 assumes one trusted operator on a single machine. The local-first design leans on this. **If the machine is ever shared** (multiple OS users, remote access, exposed ports), this assumption breaks and the following must change: control-plane auth can no longer rely on loopback alone (needs real per-user auth), path-confinement and DB least-privilege become load-bearing rather than defense-in-depth, and OS-level sandboxing of the agent becomes mandatory.

### 7.2 Controls

- **Safety-critical gates fail CLOSED** via Claude Code's own `permissions.deny` (D-024) — locally enforced by Claude Code even if our server is down. Our `canUseTool` / `PreToolUse` gates are defense-in-depth on top.
- **Control plane authenticated + loopback-only + startup assertion** (D-025): per-boot token, `Origin`/CSRF checks, bind to `127.0.0.1` only, and assert loopback-only binding at startup (defends against DNS-rebind/CSRF from browser origins).
- **Path-confinement** (D-018): agents cannot escape their `cwd` or read other projects' `.env` / files outside the configured code root.
- **SurrealQL injection closed** (D-016): `$param`-binding for all values + id/table-name validation (regex) before `RELATE`/`UPDATE`/`DELETE`. Never string-build queries.
- **Downloaded-binary checksum** (D-006): the SurrealDB server binary is verified against a known checksum before execution.
- **Least-privilege DB user + secret/PII screen + untrusted-memory-as-data** (D-026): the app connects as a least-privilege DB user; content is screened for secrets/PII **before** it is stored as memory; recalled memory is treated as **data, not instructions** (never spliced into a position where it can act as a command).
- **`git push` / remote operations restricted** (D-018): remote-mutating git operations are gated, not freely available to the agent.
- **No shell injection** (D-008): all process spawning uses `execFile`/`spawn` with argument arrays, never interpolated strings. **Windows caveat (F-002):** `shell: true` is sometimes required on Windows — but **never interpolate dynamic or path values into a shell command even with `shell: true`**; validate paths and pass values as arguments.
- **Secrets** only in `.env` (never committed); the security scanner flags secrets in code.

### 7.3 The boundary, stated plainly

**Without OS-level sandboxing, an agent runs with the full file permissions of the operator.** Our gates + `permissions.deny` + the explicit `cwd` are the boundary — they are **defense-in-depth, not a sandbox**. This is acceptable only under the single-operator assumption above; a shared or untrusted-input environment requires real OS-level isolation.

---

## 8. What changed vs v1 (summary)

| Concern | v1 | v2 |
|--------|----|----|
| State stores | ~12 SQLite + HNSW db + many JSON | 1 SurrealDB (doc+graph+vector) |
| Orchestration | always-on 60s loop | configurable, event-driven default |
| Agent execution | OpenClaw WSS gateway | `AgentRuntime`, default impl = **Claude Code** (harness) |
| Claude Code | spawned ad hoc for one task class | first-class: runtime + config manager + session fleet + workflow runner |
| CC config (hooks/skills/agents/MCP) | scattered scanners + `/hooks` page | unified config manager, filesystem-authoritative + DB mirror |
| Knowledge graph | `graph-state.json` | native SurrealDB graph edges |
| Vector memory | separate HNSW store | SurrealDB HNSW index |
| Live UI | many pollers | one SSE/event stream |
| Concurrency safety | file TOCTOU races | DB transactions |
| Git ops | string-interpolated shell | `execFile` arrays |
| Pages / endpoints | 30 / 81 | ~8+7 / far fewer |

---

## 9. Lessons from KongCode (a production SurrealDB Claude-Code memory graph)

KongCode v0.7.113 is a shipping SurrealDB knowledge-graph for Claude Code. **It is a design blueprint only — v2 has no runtime dependency on it (D-023).** We own our datastore + memory; KongCode just enriches Claude Code sessions transparently at the operator level. We mined it (`…/kongcode/0.7.113/`) and adopted these patterns:

| Lesson | Where it lands |
|--------|----------------|
| **Run SurrealDB as a managed server binary over `ws://`** (downloaded per-platform, spawned child) instead of the embedded native addon — proven cross-platform incl. Windows. | ✅ adopted — D-006 🔒 / D-001 |
| **Local embeddings, BGE-M3, 1024-dim.** They use `node-llama-cpp`; we use **Ollama** (already in stack). | D-014, DATA-MODEL §7 |
| **Transactions ≠ dedup safety.** SELECT-then-CREATE still races; use UNIQUE+catch-violation or a computed `VALUE` dedup key. | D-008 |
| **Append-only soft-archive** (`active`/`archived_at`/`archive_reason`/`superseded_by`) with `IS NONE` legacy guard. | D-015, DATA-MODEL §4.5 |
| **Hybrid WMR recall** (0.5 cosine + 0.35 utility + 0.15 recency), per-table budgets, one batched round-trip, optional cross-encoder rerank + salience bands. | §2.6, DATA-MODEL §4.5 |
| **Decay/freshness**: recency half-life ~30d, importance −1/week (cap −3), `access_count`/`last_accessed` bumped on recall; optional Fibonacci resurfacing for proactive memory. | DATA-MODEL §4.5 |
| **Session-id bridging**: store Claude Code UUID as a string bridge field, join on it; transcript rows arrive before the session row. | D-011, DATA-MODEL §7a |
| **Record-id validation regex** before RELATE/UPDATE/DELETE (injection guard). | D-016 |
| **Maintenance as fire-and-forget on trigger**, not a loop (GC, dedup-consolidate cosine>~0.92, archive old transcripts). | D-017 (confirms D-004) |
| **One long-lived process owns the DB connection + the embedding model** (model load is expensive). For us the SvelteKit Node server is that owner — no separate daemon needed. | §2.1 / §2.6 |
| **Backup partition**: knowledge core ≈100× smaller than transcript volume → offer knowledge-only export. | DATA-MODEL §7b |
| **Atomic claim tokens** (UUID + `UPDATE … WHERE`) so only one worker handles a job; PID-file + ping for single-instance. | orchestrator/services concurrency |

**Non-DB lessons (the bigger ones):**

| Lesson | Where it lands |
|--------|----------------|
| **Graceful degradation**: hooks are best-effort; if the backend is down they return empty and the session proceeds (witnessed live this session). | D-019, §2.10(d) |
| **Hook transport**: short-lived hook → tiny proxy → POST to the long-lived server, short timeout, no-op on failure. (Fills a real gap.) | D-019, §2.10(d) |
| **Gates**: evaluate agent tool calls in `PreToolUse` — config-protection, read-before-edit, dangerous-bash; soft-warn or hard-block. | D-018, §2.10(e) |
| **Intent-adaptive config**: classify intent → per-intent thinking level, tool budget, retrieval depth/share. Keeps cheap requests cheap. | D-020, §2.5 |
| **Session injection ("wakeup")**: inject a budgeted, salience-banded briefing at session start, each item with rationale + citation id. | §2.6 |
| **Background job queue**: atomic claim, UNIQUE dedup, priority, threshold-drain (not a loop), daily cap, GC, crash-safe handoff. | D-021, §2.2 |
| **Metrics rollups + anomaly detection**: per-turn → daily aggregates + flagged regressions, for trend-aware reports. | §2.5 analytics |
| **Self-improvement loop** (extract → outcome-label → learned rerank → skill synthesis → reflections → optional per-project "soul/profile"). | D-022 — post-v1.0 vision |
| **Realtime vs batch capture**: lightweight inline capture + heavy batch extraction off the critical path via a spawned subagent. | D-021 / memory bridge |
| **Resource-profile detection**: detect CPU/RAM at boot → adapt concurrency caps. | services/orchestrator (lighter) |

### 9.1 Cannibalize foundry — hermes / mem0 / kongcode

KongCode is one of three memory engines we mined. The broader memory/learning design comes from comparing **hermes-agent** (Nous Research, MIT — liftable), **mem0** (Apache-2.0 — prompts/code liftable), and **kongcode** (a friend's plugin — ideas/findings fine, lifting code needs consent). The strategic positioning (detail in [MEMORY-SPEC.md](./MEMORY-SPEC.md)):

| Dimension | hermes | kongcode | mem0 | → v2 take |
|-----------|--------|----------|------|-----------|
| **Write timing** | in-use per-turn fork | batch end-of-session (hours lag) | per-turn flat facts | in-use fork (hermes) |
| **Consolidation** | dedicated periodic curator (umbrellas) | graph consolidation / audit-drift | fact dedupe only | curator + graph (both) |
| **Storage** | polyglot (files + sqlite + Honcho) | single SurrealDB | vector + 2 sqlite | single SurrealDB (D-001/D-032 — resolved: single store stands) |
| **Utilization signal** | **NONE** (prunes on time) | outcome = best ranker | none | **close the loop into ranking — v2's edge** (D-030 — resolved: ranking-only) |
| **Graph** | n/a | real edges (traversal, graduation) | faked (id arrays) | real edges (lean in) |
| **Extraction** | skill-shaping fork | end-of-session | ADD-only + dedup | ADD-only + kongcode lifecycle (D-028) |

**Net:** copy hermes' two-tier loop + cost-cached fork (background fork inherits the cached system-prompt prefix → ~26% measured cost cut) + the **DO-NOT-CAPTURE guardrail** (never persist environment failures or negative tool claims — they harden into self-cited refusals); keep kongcode's real-graph lifecycle (append-only soft-delete, skill graduation, retrieval-quality scoring); take mem0's cheap **ADD-only extraction** prompt. **v2's winning move = the utilization loop (D-030 — resolved: ranking-only) all three under-use** — hermes ignores it, mem0 lacks it, kongcode has it; v2 feeds the outcome signal into **ranking** (not pruning — pruning stays time-based, D-015). The three formerly-open items in this space are now resolved: **D-030** (utilization loop → ranking-only), **D-031** (BOTH a query-time novelty gate and a periodic consolidation pass), **D-032** (single SurrealDB store stands — no SQLite-FTS5 split, no external Honcho; authored Claude Code skills are already git-diffable files per D-010, so v2 gets hermes' git-diff benefit without splitting the store). Also locked: D-027 (two-tier loop), D-028 (ADD-only extraction + graph consolidation), D-029 (raw-windowed recall), D-033 (design skills). Provenance is preserved above; full design lives in [MEMORY-SPEC.md](./MEMORY-SPEC.md).

---

What we did **not** adopt: KongCode's **separate daemon + IPC + MCP-thin-client** topology — our SvelteKit server is the long-lived owner (but we DO borrow its hook-proxy + graceful-degradation transport); its full 5-pillar/soul identity model (we borrow only a deferred per-project "profile" idea, D-022); SEA single-executable packaging (revisit only if we distribute v2 beyond this machine).
