# DECISIONS — ai-playground v2

ADR-style log. Each decision: status, context, choice, consequences. **OPEN** decisions are tracked work items, not yet settled.

Status legend: 🔒 Locked · 🟡 Open (needs spike/decision) · ⚪ Proposed (default unless overridden)

---

## D-000 🟡 Product name

**Context:** Working title is "ai-playground v2". A cleaner product name may be wanted.
**Decision:** Defer. Use `ai-playground-v2` as the repo/dir name for now.
**Consequence:** The working name is already baked into the SurrealDB namespace `playground` and the data dir, so a v1.0 rename carries a **data-layer cost** (NS migration + data-dir move), not purely cosmetic.
**Revisit:** Before v1.0, or whenever the owner picks a name.

---

## D-001 🔒 Storage: single SurrealDB datastore

**Context:** v1 spread state across ~12 SQLite DBs, a separate HNSW vector store (`.swarm/memory.db`), `graph-state.json`, and dozens of JSON files. This caused TOCTOU races, inconsistent backup/restore, and duplicated logic.

**Decision:** Use **SurrealDB 2.x** as the **single** datastore, run as a **managed local server binary** (downloaded per-platform, spawned as a child process, connected over `ws://127.0.0.1`) — KongCode's proven cross-platform path (D-006). It is multi-model: document (relational), **graph** (native edges for the knowledge graph), and **vector** (HNSW index for semantic memory) in one engine, with ACID transactions.

**Consequences:**
- One datastore, one data dir, one backup artifact. One extra local process (the SurrealDB server) — owned/managed by our app.
- The **SvelteKit Node server is the long-lived owner** of the connection (and the embedding step); a single `Surreal` client instance is shared (KongCode runs one store per daemon).
- Transactions give multi-write atomicity (but **not** dedup-race safety — see D-008).
- Knowledge graph = native graph edges; vector search built in — no separate HNSW store.
- **Avoids the native-addon risk**: only the `surrealdb` JS SDK is needed (no `@surrealdb/node` engine), so no Rust NAPI build on Windows. The server binary is a self-contained download.
- BSL 1.1 license — running it for our own local app is permitted; only commercial DBaaS would need a license.

---

## D-002 🔒 Agent runtime = Claude Code — SDK primary, CLI needs isolated config (S1 RESOLVED)

**Context:** v1 routed agent work through the **OpenClaw gateway** (WSS, Ed25519, TLS 1.3, DM pairing, exec/read/write ACLs, Ollama fallback) — heavy, with a concurrent-`chat()` hang bug. The owner clarified that **v2 is also a Claude Code harness**: Claude Code is the execution backend, the cross-project config control surface, the session orchestrator, and a headless workflow runner.

**Decision:** **Claude Code is the primary agent runtime.** The product drives Claude Code to do the work. We still keep a narrow **`AgentRuntime` interface** so non-Claude-Code providers (direct Ollama/Claude chat, or a future runtime) can plug in, but the **default and primary impl is Claude Code**. OpenClaw is replaced, not rebuilt; cannibalize only if a concrete need survives (see D-012).

**Implementation mechanism (small remaining spike, S.1):** choose between —
1. **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) — programmatic loop, streaming, MCP servers, hooks, subagents, session management. *Front-runner for the execution backend + headless workflows.*
2. **Claude Code CLI headless** (`claude -p … --output-format stream-json`, `--resume`) — drive the CLI as a subprocess. *Useful where we want exactly the CLI's behavior / interactive parity.*
Likely **both**: SDK for programmatic/headless execution + workflows; controlled CLI subprocesses where interactive-session parity (interject/resume) is easier via the CLI. The spike picks the split.

**Consequences:**
- D-002 is no longer a blocking unknown — the rest of the system codes against `AgentRuntime`, default impl = Claude Code.
- Concurrency safety (kills the v1 hang): each Claude Code agent is an isolated session/process; the orchestrator queues them — no shared mutable hang state.
- Tool gating, hooks, and MCP are handled by Claude Code itself (we configure them — see D-010), so we don't reimplement a tool sandbox.
- Offline: Claude Code needs the Anthropic API; the local Ollama slot (D-003) remains for cheap/offline non-CC paths via the provider adapters.

**S1 spike RESULT (2026-06-07, Windows + Node 24):** runtime proven — **2 concurrent runs completed with no hang** (the v1 bug does not reproduce); the **Agent SDK ran clean headless** (deterministic output); the CLI streamed `system/assistant/result`, yielded a `session_id`, and `--resume` continued the session. **Finding:** a spawned **`claude` CLI inherits the operator's GLOBAL config** (the box had caveman/kongcode/peers/routing plugins → polluted, nondeterministic agents + injected hook turns blew `--max-turns`); the SDK did not. **Resolved mechanism:**
- **SDK is the primary runtime** for headless/programmatic + workflows (clean, no inherited personal config).
- The **CLI** (used for interactive parity: interject/resume) **MUST be spawned with an ISOLATED config** — a dedicated `CLAUDE_CONFIG_DIR` / `--settings` carrying only the harness's own gate/hook set (D-018/D-019), no inherited operator plugins/hooks. This is a **build requirement** for the `AgentRuntime` impl (carried to IMPLEMENTATION-PLAN v0.1 task 1.4 / 1.4a).
- **Interject (D-011)** uses Claude Code's **`claude/channel` push** protocol — proven by claude-peers (see D-035).

---

## D-003 🔒 Local model: keep `gpt-oss:20b`, model as a swappable slot

**Context:** v1 uses Ollama serving `gpt-oss:20b` (~16 GB) for $0 routing/classification/orchestration. The owner wants to keep it for now and *"swap it out for a new model later when I figure that out."*

**Decision:** Keep Ollama + `gpt-oss:20b` as the default **local model slot**. Model identity is **config-driven** (`config/models.*`), behind the provider interface, so swapping to a smaller/different local model (or dropping it for Haiku) is a config change, not an architecture change.

**Consequences:** No immediate resource reduction from the model, but zero architectural lock-in. The "lighter" win comes from orchestration + storage now; the model is a future lever.

---

## D-004 🔒 Orchestration: configurable, default event-driven + on-demand

**Context:** v1's always-on 60s loop runs regardless of activity.

**Decision:** The orchestrator is **configurable** with modes:
- `event` (default) — react to triggers: task created, manual run, optional file-watch.
- `periodic` — opt-in scan at a configured interval; **off by default**.
- `manual` — only explicit runs.
Triggers and interval live in `config` and a settings page.

**Consequences:** Idle cost drops to ~zero. Autonomous "maintain my projects" behavior is preserved by enabling `periodic` when wanted. Event plumbing replaces a busy loop.

---

## D-005 🔒 Dashboard: keep SvelteKit 2.x + Svelte 5 + Tailwind v4, but trim

**Context:** v1 dashboard (SvelteKit 2.x / Svelte 5 runes / Tailwind v4 / Node adapter) is proven and the team knows it. But it has 30 pages, 81 endpoints, and many independent pollers.

**Decision:** Keep the stack. **Consolidate** pages and endpoints; replace per-store polling with **one SSE/event stream** fed by SurrealDB live queries / change events. Carry forward all Svelte 5 rune rules from v1 fails (F-009 `.svelte.ts`, F-011 `{@const}` placement, F-010 SSE vs Playwright `networkidle`).

**Consequences:** Less surface area, fewer network connections, simpler reactivity. A migration pass maps v1 pages → v2 pages.

---

## D-006 🔒 Run SurrealDB as a managed server binary (resolves the native-module risk)

**Context:** The embedded engine `@surrealdb/node` is a Rust NAPI native addon — unverified on Windows + Node 22, and v1 has native-module scars (F-002, F-006). **KongCode (production) does NOT embed** — it downloads the SurrealDB **server binary** per-platform and connects over `ws://localhost`. This is the de-risked path.

**Decision:** Run SurrealDB as a **managed local server binary**: app provisions the platform binary (bundled or downloaded to a cache dir, version-pinned), spawns it as a child process bound to loopback, connects via the `surrealdb` JS SDK over `ws://127.0.0.1:<port>/rpc`. No native Node addon. Lifecycle (start/health/stop) lives in the services manager (Windows-safe: `tasklist`/`taskkill`, `shell:true`).

**Consequences:**
- Eliminates the embedded native-addon unknown entirely.
- Phase 0 spike shrinks to: provision + spawn the binary on Windows, connect, run CRUD + HNSW KNN + a transaction. (Verify isolation level if a design depends on it.)
- One extra process; acceptable (KongCode runs exactly this on Windows). Single-writer file lock is fine for single-operator.
- **Binary integrity (supply-chain, SEC-009):** the downloaded SurrealDB server binary (and the embedding model weights) MUST be verified against a **pinned SHA-256 (or signature)** before first spawn — **fail hard on mismatch**, never run an unverified artifact. Download from the **official source over HTTPS only**. The pinned hash is recorded alongside the version pin.

**Revisit:** Only if binary provisioning proves painful; embedded remains a documented fallback.

---

## D-007 🟡 Server storage backend: SurrealKV (KongCode runs it in production)

**Context:** The SurrealDB server can store via `surrealkv://`, `rocksdb://`, or `memory`. SurrealKV is officially "beta", but **KongCode ships on SurrealKV** in production — strong real-world evidence it's viable for a single-operator local store, and it's pure-Rust (no RocksDB C++ dep) with optional versioning.

**Decision (default):** Use **`surrealkv://`** for persistence (matches KongCode + the connection example); `memory` for tests. `rocksdb://` is the fallback if SurrealKV misbehaves. Note: SurrealKV/RocksDB hold a single-writer file lock — fine for our single long-lived server process.

---

## D-008 🔒 Designed-out debt (from v1 BACKEND_AUDIT)

**Context:** v1 has 8 critical + 19 high issues.

**Decision:** v2 designs these out from day one:
- **Concurrency races** → SurrealDB transactions for multi-write atomicity. **But (KongCode lesson):** transactions do **not** auto-solve *dedup* TOCTOU (two callers both miss a `SELECT` then both `CREATE`). For dedup, use a **UNIQUE index + catch unique-violation then re-select**, or a **computed `VALUE` dedup key** (KongCode's `dedup_key`: `session|type|status` for active rows, record-id for archived, so unlimited archived siblings don't collide). Don't claim "transactions kill all races" — they don't.
- **Shell injection** (git commands) → `execFile` with argument arrays, never string interpolation.
- **Gateway concurrent hang** → the new `AgentRuntime` must support concurrent agents safely (per-process isolation or a real async queue).
- **FD leaks on spawn failure** → strict resource cleanup in a `finally`.
- **In-place task mutation for context injection** → context passed as separate fields, never mutating the stored task description.
- **Tool-execution bypass / dropped tool messages** → explicit, tested tool-call handling with confirmation gating.

---

## D-009 🔒 FTS / search keyword is version-pinned

**Context:** SurrealDB 2.x uses `DEFINE INDEX ... SEARCH ANALYZER ... BM25`; 3.x renames it to `FULLTEXT ANALYZER`. MTREE vector index is removed in 2.x (use HNSW).

**Decision:** Target **SurrealDB 2.x** syntax in all schema (HNSW for vectors, `SEARCH ANALYZER` for FTS). Note the 3.x rename in DATA-MODEL so migration is a known, bounded change.

---

## D-010 🔒 Claude Code config is filesystem-authoritative; SurrealDB mirrors it

**Context:** As a Claude Code harness, v2 manages Claude Code config across projects — `.claude/settings.json` (hooks, permissions, env, MCP servers, enabled plugins), `.claude/agents/*.md`, `.claude/skills/*/SKILL.md`, `.mcp.json`, `CLAUDE.md`, plus the global `~/.claude/`. Claude Code reads these from **disk**.

**Decision:** For Claude Code config, the **filesystem is the source of truth** (Claude Code itself reads the files). SurrealDB holds a **synced mirror/index** for fast query + the dashboard view. Edits go: dashboard → write file → re-sync mirror. This is a deliberate, scoped exception to "SurrealDB is the single source of truth" (D-001), which still holds for all *product* state (tasks, sessions, analytics, memory, projects).

**Consequences:**
- A `config sync` service watches/reads `.claude/` + `.mcp.json` across the code root and the global dir, upserting mirror records.
- Writes validate before touching files (settings.json schema, agent frontmatter, SKILL.md frontmatter). Carry the v1 settings lesson (e.g. valid MCP permission-rule syntax `mcp__server__*`, not `mcp__server__:*`).
- Never silently overwrite hand-edited files — diff and confirm.

---

## D-011 🔒 Session orchestration model (launch / monitor / interject / stop / resume)

**Context:** Harness must run a fleet of Claude Code sessions with live transcripts and control.

**Decision:** Model a Claude Code session as a first-class entity with: live **transcript event stream** (assistant/tool/usage events) surfaced over the one SSE stream; **interject** (send a message into a running session); **stop** (cancel); **resume** (by Claude Code session id). Interactive parity (interject/resume) is the main reason the CLI may be used alongside the SDK (D-002). Mirrors v1 feedback "stop, restart, interject into running agents".

**Consequences:** `session` records carry a `cc_session_id`; transcript persisted as `message` rows; a control channel maps dashboard actions → runtime calls. Fleet view = query of running sessions. **Interject** is implemented via Claude Code's **`claude/channel` push** (proven by claude-peers — D-035): a message injected into a *running* session, seen immediately. Operator-origin interjects may steer; any agent→agent message is fenced as data (D-026).

---

## D-012 🟡 OpenClaw cannibalization — decide what (if anything) to salvage

**Context:** OpenClaw is replaced by the Claude Code runtime. Some parts might still be worth extracting (provider routing logic, exec sandboxing patterns, audit logging).

**Decision:** **Audit during Spike S.2.** Default assumption: drop OpenClaw entirely (WSS, Ed25519, TLS, DM pairing, gateway client). Salvage a part only with a concrete v2 need that Claude Code + provider adapters don't already cover.

**Revisit:** Spike S.2 → 🔒 with the salvage list (likely empty).

---

## D-013 🔒 Headless workflow runner

**Context:** Harness runs scripted multi-step Claude Code pipelines (not just interactive/single runs) — the daemon-style automation.

**Decision:** Provide a **workflow** concept: a definition of ordered/parallel steps (each a Claude Code run with a prompt, agent, model, cwd) with dependencies, executed headlessly and tracked as `workflow_run` + per-step `session` records. Built on the Claude Agent SDK (D-002). Triggerable manually, by orchestrator events, or (opt-in) periodically (D-004).

**Consequences:** New `workflow` + `workflow_run` tables (DATA-MODEL). Reuses the runtime, analytics, and event stream.

---

## D-014 🔒 Embedding source = Ollama `qwen3-embedding:0.6b` (1024-dim) — RESOLVED by S0 spike

**Context:** Memory needs embeddings + a vector dimension fixed in the HNSW index. KongCode runs **BGE-M3 GGUF (1024-dim) locally via `node-llama-cpp`** — $0, offline, no API. We already keep **Ollama** (D-003), which can serve embedding models (e.g. `bge-m3`) over its existing API — reusing infra KongCode lacks.

**Decision (default, pending confirm):** **Embed via Ollama** (`bge-m3`, **1024-dim**) — reuses the local model server already in the stack, no new native dependency. Fallback options: `node-llama-cpp` + GGUF (KongCode's path, fully self-contained) or a hosted embedding API (no local weight, costs + network). HNSW `DIMENSION` is locked to the chosen model (1024 for BGE-M3); changing models later = re-embed + redefine index.

**Consequence (cannibalize foundry):** the foundry independently validated **`qwen3-embedding:0.6b` served via Ollama (1024-dim, HNSW COSINE in SurrealDB)** as a proven local embedder — a concrete candidate alongside `bge-m3`. **Both are 1024-dim, so the HNSW index `DIMENSION` is unaffected either way** — the choice between them is a quality/throughput call, not an index-locking one. *Verify against v2 constraints before build.* Stays 🟡.

**RESOLVED (S0 spike, 2026-06-07):** the Phase-0 SurrealDB spike confirmed **`qwen3-embedding:0.6b` via Ollama returns 1024-dim** vectors that index + KNN-query cleanly in SurrealDB 2.6.5 (HNSW DIMENSION 1024 DIST COSINE). It's already pulled (639 MB), smaller than bge-m3, cannibalize-validated. **Locked: `qwen3-embedding:0.6b`, 1024-dim.** bge-m3 remains a drop-in alt (also 1024-dim → no index change); node-llama-cpp/API stay documented fallbacks. Index `DIMENSION` = 1024.

---

## D-015 🔒 Append-only / soft-archive (KongCode pattern)

**Context:** KongCode never `DELETE`s knowledge — it soft-archives (`active=false` / `status='archived'` + `archived_at` + `archive_reason` + `superseded_by`), filtering reads on `(active = true OR active IS NONE)`. Gives audit trails and a supersession chain; avoids destroying recoverable knowledge.

**Decision:** Adopt soft-archive for **knowledge-bearing** tables (`memory`, `security_finding`, mirror-derived knowledge, future skills/reflections). Operational/transient tables (`message`, `routing_event`, `agent_event`) may hard-delete on retention. Always include the legacy `IS NONE` guard so pre-migration rows stay visible. Pair with the dedup patterns in D-008.

---

## D-016 🔒 Record-id validation guard (KongCode pattern)

**Context:** KongCode validates every record id against `^[a-z0-9_]+:[a-z0-9_]+$` before `RELATE`/`UPDATE`/`DELETE` to prevent injection via interpolated ids, and errors loudly at the call site.

**Decision (SEC-006):** **ALL values** pass via SDK parameter binding (`$param`) — never string-interpolated. **ONLY** validated **table-names and record-ids** may be interpolated, and only after validation at the **single `db` helper boundary** (one chokepoint, validated against the strict regex, errors loudly at the call site). This explicitly covers **`RELATE` endpoints** (both edge record-ids), **dynamic table-name selection** (e.g. per-table vector search), and **FTS** queries (search terms bound as `$param`, never interpolated). This is the SurrealDB analog of D-008's "no string-interpolated shell."

**Consequences:** **Fuzz** task-title, file-path, and agent-output (all attacker-influenceable strings) through **every** recall / `RELATE` / FTS path to prove no interpolation escape.

---

## D-017 🔒 Maintenance on trigger, not on a loop (KongCode validates D-004)

**Context:** KongCode runs GC / dedup-consolidation / old-turn archival / index upkeep as **fire-and-forget jobs on SessionStart**, not a busy loop — exactly our event-driven stance (D-004).

**Decision:** v2 maintenance (memory consolidation, dedup by embedding cosine >~0.92, archival, ANN upkeep, optional rerank-weight retrain) runs as fire-and-forget tasks triggered by orchestrator events (session/boot/idle), never a constant timer. Confirms D-004.

---

## D-018 🔒 Agent guardrails ("gates") — KongCode pattern

**Context:** KongCode evaluates **gates** in its `PreToolUse` hook to constrain agent actions: **edit-gate** (block `Edit` on a file not `Read` this session), **config-protection** (block edits to `settings.json`/`.env`), **bash-gate** (deny dangerous commands like `rm -rf`, redirections). User-defined gates live in a JSON file.

**Decision:** v2's harness ships a **gate layer** that evaluates agent tool calls before they run (via Claude Code's `PreToolUse` hook + our runtime's tool policy). Built-in gates:
- **config-protection** — deny reads of **ANY** `.env`/secret file and **ANY** `.claude/` directory across the **whole code root** (not just our own project's), plus edits to them.
- **read-before-edit** — block `Edit` on a file not `Read` this session.
- **dangerous-bash** — deny destructive commands (`rm -rf`, redirections that clobber) and now also **`git push`**, **`git remote set-url`**, and any **`--force`** flag.
- **path-confinement** — file/bash tool targets must resolve, **after symlink resolution + `..` normalization**, under the project's `root_path` / `CODE_ROOT`; **deny otherwise — fail closed**.

Gates are configurable per project. This is the runtime complement to D-008 (no shell injection) and D-016 (id validation) — a guardrail for *agent-initiated* actions, not just our own code. Gates are **defense-in-depth**; the **PRIMARY boundary is Claude Code's locally-enforced `permissions.deny` + tool allow-list + cwd + OS permissions** (see D-024).

**Consequences:** safer autonomous runs; ties into the config manager (D-010) and security posture. Soft-interrupt (warn) vs hard-block configurable per gate.

---

## D-019 🔒 Hook transport + graceful degradation

**Context:** Claude Code hooks fire as **short-lived processes**, but our state/logic lives in the **long-lived SvelteKit server** (D-001/D-006). KongCode bridges this with a tiny **hook-proxy** script that each hook invokes, which IPC-calls the daemon; if the daemon is unreachable the proxy **returns empty `{}` and the session proceeds** (we are literally watching this work right now — KongCode's daemon is down, Claude Code is unaffected).

**Decision:** v2 hooks are thin **proxy scripts** that POST to the local SvelteKit server (loopback HTTP) with a **short timeout**; on any failure/timeout/server-down they **no-op gracefully** (return empty, never block or error the session). Memory injection, analytics capture, and gates are all best-effort. Per-hook timeouts budgeted (KongCode: SessionStart 30s, UserPromptSubmit 15s, tool hooks 10s).

**Consequences:** the harness can never hang or break a Claude Code session, even if our server is restarting. Fills a real gap — we hadn't specified how hooks reach the always-on owner.

---

## D-020 🔒 Intent-adaptive orchestration config

**Context:** KongCode classifies each request's **intent** (simple-question / code-read / code-write / code-debug / deep-explore…) and looks up an **adaptive config**: thinking level, tool-call limit, token budget, retrieval share (% of context), and per-table vector-search limits. So a trivial question spends little; a debug task gets deep retrieval + higher tool budget.

**Decision:** v2 routing (D-005-era `resolveRoute`) is extended: after model-tier selection, classify intent → apply an **adaptive config** (model/thinking tier, tool/concurrency budget, memory-retrieval depth + budget). Configs live in `config/orchestration.yaml`, tunable. This makes "lighter" concrete — cheap requests stay cheap.

**Consequences:** richer than pure tier selection; the routing telemetry records intent + chosen config for analytics.

---

## D-021 🔒 Background job queue patterns (KongCode-proven)

**Context:** KongCode runs heavy work (knowledge extraction, graduation, maintenance) **off the interactive path** via a `pending_work` queue drained by a spawned background subagent: atomic **claim token** (`UPDATE … SET token WHERE token IS NONE`), **UNIQUE(work_type, session)** dedup, **priority** ordering, **daily spawn cap**, **threshold-triggered drain**, 7-day GC of stale items, and **crash-safe handoff files** written synchronously on session end.

**Decision:** v2's orchestrator background queue (for post-task extraction, follow-ups, maintenance — D-013/D-017) adopts these patterns directly: a `work_item` table with atomic claim, UNIQUE dedup keys (D-008), priority, a drain trigger (event/threshold, not a busy loop — D-004/D-017), a daily cap, stale-item GC, and a synchronous handoff record for crash recovery.

**Consequences:** heavy work never blocks an interactive agent; exactly-once-ish semantics without locks.

---

## D-022 🟡 Self-improvement loop — deferred vision (post-v1.0)

**Context:** KongCode's compounding value comes from a 5-stage loop: **extract** knowledge from sessions → **link** into the graph → **label** which retrieved memories proved useful (citations + tool success) → **train** a learned reranker (ACAN) → **synthesize** repeated successful sequences into reusable **skills/procedures** + **reflections** on failures, with a **graduation watermark** for idempotency. Optionally a per-agent **"soul"** (self-authored identity from accumulated traces).

**Decision:** **Deferred, but captured as the north-star for v2's memory.** v0.2 lays the groundwork (record retrieval outcomes + agent analytics). Post-v1.0 epics: outcome-labeled learned reranking, procedure/"skill" synthesis from successful task sequences, failure reflections, and a **per-project "profile/soul"** (learned conventions injected into agent runs — maps to v1's project-manager memory + ubiquitous language). Not v1.0-critical; high long-term value.

---

## D-023 🔒 KongCode is a design blueprint, not a runtime dependency

**Context:** KongCode (installed mid-planning) is a production SurrealDB memory graph + Claude Code harness. We mined it heavily (D-014–D-022). Question: do we *use* KongCode at runtime, or just learn from it?

**Decision:** **Own everything; KongCode = reference only.**
- **Product state** (projects, tasks, releases, sessions, analytics, workflows, CC config mirror) → **our own SurrealDB**, always. KongCode is a personal memory graph, not a product datastore.
- **Memory/knowledge/learning pillar** → **we build our own** (patterns already extracted from KongCode). **No runtime dependency** on KongCode's daemon, MCP tools, or DB.
- The memory service sits behind an interface so KongCode *could* be an optional adapter later — but that is explicitly **not** planned for v1.0.

**Rationale:**
- v2's premise = from-scratch, under our control, lighter, reliable. Depending on KongCode contradicts control + reliability.
- KongCode's model is identity/soul-centric and operator-global; our product is project-lifecycle-centric — poor fit to force product data through it.
- **Reliability evidence:** KongCode's daemon was unreachable for an entire planning session — unacceptable fragility for a load-bearing product pillar.
- **Free benefit anyway:** KongCode hooks *all* Claude Code sessions, so it transparently enriches the agents our harness drives — at the operator level, with zero coupling to our product.

**Consequences:** the self-improvement loop (D-022) is ours to build (deferred post-v1.0); no external memory dependency to manage or version.

---

## D-024 🔒 Safety-critical gates fail CLOSED

**Context:** D-019 makes hooks **best-effort / no-op-on-failure** — which is correct for *enrichment* (memory injection, analytics) but **dangerous for guardrails**. A network-hook gate fails **OPEN** when the server is down (an expected, normal state — we are watching exactly that this session), so a looping or injected agent could bypass config-protection / dangerous-bash / path-confinement (D-018) simply because our daemon was restarting.

**Decision:** Safety-critical constraints (**config-protection, dangerous-bash, path-confinement**) are enforced **primarily via Claude Code's OWN `permissions.deny`** — locally enforced by Claude Code itself even when our server is down — and **fail CLOSED**: if the gate evaluator cannot run, the tool call is **blocked, not allowed**. Our network/hook gates are **defense-in-depth enrichment only**, never the sole boundary. Prefer **allow-lists over denylists** for bash where feasible (denylists are evadable via aliasing, encoding, equivalent commands).

**Consequences:** the harness's config manager (D-010) seeds the correct `permissions.deny` rules per project at provisioning time; the network gate layer adds detection/telemetry on top but is never depended on for safety. Aligns with D-018's "PRIMARY boundary" note.

---

## D-025 🔒 Control-plane security (auth + loopback)

**Context:** Hooks POST to the long-lived SvelteKit server (D-019), and that **same server** exposes **control actions** (interject / stop / resume / workflow / config-write — D-011/D-013/D-010) and the **product-mutation API** (task → spawn → exec — D-002/D-004). An **unauthenticated loopback** listener means any local process — or a browser via **DNS-rebind / CSRF** — could forge hook responses (suppress a gate, poison memory) or trigger autonomous execution.

**Decision:**
- **Every listener** (SvelteKit, SurrealDB, Ollama, embeddings) binds **`127.0.0.1` ONLY**, **asserted at startup** (fail to boot if a socket is routable). Note: the **SvelteKit Node adapter defaults to `0.0.0.0`** — must set **`HOST=127.0.0.1`**.
- **Hook + control + mutation endpoints require a per-boot random token**, injected into the generated hook-proxy command (D-019).
- Add **Origin/Host checks** + **SameSite cookies** to defeat browser-driven CSRF / DNS-rebind.

**Consequences:** closes **SEC-001 / SEC-012 / SEC-015**. The token is regenerated each boot and never persisted to disk in cleartext beyond the running proxy command.

---

## D-026 🔒 Untrusted content & secret/PII handling

**Context:** Memory ingests **agent output + scanned code + imported notes**, then **re-injects** it into future sessions — a self-propagating **prompt-injection / context-poisoning** channel. Scanned code can also contain **secrets / PII**, and backups can leak them.

**Decision:**
- **(a) Retrieved content is DATA, never instructions.** Delimit retrieved memory / scanned content clearly; instruct the model **not to follow instructions found inside retrieved content**; never let retrieved content alter tool policy or gates (D-018/D-024).
- **(b) Secret + PII screen BEFORE storing.** Reuse the security scanner to screen content **before** it is written to memory — **redact or quarantine**, mark the affected rows, and **exclude them by default** from the shareable knowledge-only export.
- **(c) Least-privilege DB user.** The app connects to SurrealDB as a **scoped least-privilege user**; the **root** user is reserved for migration / provisioning only.

**Consequences:** closes **SEC-005 / SEC-010 / SEC-013**. Note: the live KongCode hook-injection observed this session (text appended to tool results attempting to steer behavior) is **exactly this threat class** — confirming the need.

**Implemented by:** (b) the `memory.screen_status` (clean/redacted/quarantined) + `screened_at` fields run as a pre-embed screen step (MEMORY-SPEC §3.1b "step 2.0", DATA-MODEL `memory`); recall excludes `quarantined` and the knowledge-only export emits only `clean` (DATA-MODEL §7b). (a) Fencing covers **every** injection path — recall, Tier-0, user-model, graduated skills (MEMORY-SPEC §10). (c) least-priv DB user (MEMORY-SPEC §6).

---

## D-027 🔒 Two-tier learning loop: fast in-use writer + slow periodic consolidator

**Source:** cannibalize foundry — **hermes-agent (Nous Research, MIT — code liftable)**. Refines D-022 (self-improvement loop) + D-021 (job queue). *Candidate adapted from hermes; verify against v2 constraints before build.*

**Context:** hermes decouples WRITE cadence from CONSOLIDATE cadence — the architecture the foundry recommends copying wholesale for v2's memory.

**Decision:** Two distinct cadences:
- **Fast additive WRITE happens in-use** — a **forked, tool-restricted review subagent** fires on a **turn-count cadence**, mines the just-finished turn for memory/skill writes, runs **async**, and **never touches the live prompt cache**.
- **A SEPARATE periodic consolidator** (inactivity-triggered, ~7-day) **merges narrow knowledge into class-level umbrellas** and **GCs stale items**.

**Consequences:**
- Keeps knowledge fresh without micro-knowledge proliferation.
- The in-use fork is **gated** (every Nth turn) and **prefix-cache-optimized** — by inheriting the parent's cached system-prompt prefix verbatim, hermes measured a **~26% cost cut** — so it doesn't violate the "lighter / idle≈zero" principle (D-004). **VERIFY that per-turn fork cost is actually acceptable on v2's stack before build**; write-cadence is config-tunable.
- Cross-ref: **D-021** (the `work_item` queue is the consolidator's drain), **D-022** (this is the concrete shape of that deferred loop). Detailed mechanics live in the new **MEMORY-SPEC.md**.

---

## D-028 🔒 Extraction is ADD-only; conflict resolution is a separate deterministic/graph pass

**Source:** cannibalize foundry — **mem0 (Apache-2.0 — prompts/code liftable)** + **kongcode (friend's code — IDEAS fine, code-lift needs consent)**. Refines D-008 (dedup) + D-015 (soft-archive). *Candidate; verify against v2 constraints before build.*

**Context:** mem0's V3 **dropped LLM ADD/UPDATE/DELETE decisioning** as too unreliable — trusting the LLM to mutate stored memory in place did not hold up.

**Decision:** **Extraction is one cheap LLM call, ADD-only.** Dedup / supersession / contradiction happen **downstream in a deterministic + graph pass** (supersede edges), **never** by trusting the LLM to mutate in place. Pair with kongcode's **lifecycle** (graduation, decay) — ideas only, no code lift.

**Consequences:**
- Cheaper and more reliable than in-place LLM mutation.
- Aligns with **D-008** (dedup via computed `VALUE` keys + unique-violation re-select) and **D-015** (append-only / soft-archive).
- **Licensing:** mem0 prompts are **Apache-2.0** (liftable); kongcode lifecycle is **ideas only** (code-lift needs the friend's consent).

---

## D-029 🔒 Cross-session recall returns RAW windowed messages + bookends, no summary-LLM

**Source:** cannibalize foundry — **hermes-agent (MIT — FTS5 sanitizer liftable)**. *Candidate; verify against v2 constraints before build.*

**Context:** the live agent has its own reasoning budget and prefers real excerpts over a lossy summary.

**Decision:** Recall path = **FTS5 (or vector) → dedupe by session lineage → return windowed raw messages + first/last bookends**; **NO LLM summarization in the recall path** (cheaper, no added latency, no summarization hallucination). Reserve LLM synthesis for an explicit **"dialectic" tool**, not default recall.

**Consequences:**
- **Distinct from MEMORY recall ranking** — that path keeps WMR / cross-encoder rerank (see D-022 north-star); **this** is the **cross-session message/turn recall** path.
- **Licensing:** hermes code is **MIT** (the FTS5 query sanitizer is liftable near-verbatim).

---

## D-030 🔒 Utilization loop feeds RANKING, not pruning (owner-resolved)

**Source:** cannibalize foundry — **kongcode** + cannibalize's `mark-applied` outcome signal; the question **hermes leaves open**. Resolved by the owner 2026-06-06.

**Context:** hermes self-improvement is **pure WRITE-time judgment with NO retrieval/utilization feedback** — it never measures whether a saved skill later **HELPED**, and prunes purely on inactivity. kongcode's lesson: **retrieval ≠ utilization, and outcome is the best ranker.** v2 already has the `retrieval_outcome` table as **D-022 groundwork**.

**Decision:** v2 **tracks whether a recalled skill/memory led to a good outcome** (`retrieval_outcome`: was it cited / did it precede tool success) and feeds that signal into the **recall RANKER** — but **NOT** into the curator's keep/prune decision. **Pruning stays time/inactivity-based** (hermes-style, archive-not-delete per D-015). Outcome improves *what surfaces*; it does **not** decide *what survives*.

**Rationale:** outcome-driven pruning risks discarding a still-valuable but rarely-cited memory (low citation ≠ low worth); ranking is reversible per-query, pruning is (soft-)destructive. Keep the high-value signal where it's safe.

**Consequences:** `retrieval_outcome` is a ranker input (WMR/ACAN feature), recorded in v0.2 (ROADMAP 2.16). The curator (D-027 consolidator) prunes on inactivity + consolidation only. Still v2's edge over hermes (which has no utilization signal at all) — just applied conservatively. Revisit outcome-driven pruning post-v1.0 if data shows ranking-only leaves junk.

---

## D-031 🔒 Diversity control = BOTH query-time novelty gate + periodic consolidation (owner-resolved)

**Source:** cannibalize foundry — **kongcode**. Resolved by the owner 2026-06-06.

**Context:** redundant near-dup memory families accumulate over time. kongcode: a **HARD novelty gate at query time** beats soft MMR when the corpus has redundant near-dup families; a **periodic consolidation pass** merges the families themselves.

**Decision:** Use **both**. A **hard novelty gate at recall time** (cosine-band cut on the candidate set) stops near-dups surfacing into context; the **periodic consolidator** (D-027) merges near-dup families into class-level umbrellas so storage doesn't bloat. Belt-and-suspenders: the gate fixes *what the agent sees now*, consolidation fixes *what accumulates*.

**Consequences:** novelty-gate thresholds (family-vs-distinct cosine bands) are tunable starting points (kongcode-documented); consolidation is a `work_item` job (D-021) on the curator cadence (D-027). `absorbed_into` forwarding (D-027/D-015) rewrites edges from merged members to the umbrella.

---

## D-032 🔒 Single SurrealDB store stands; no polyglot split (owner-resolved, reaffirms D-001)

**Source:** cannibalize foundry — **hermes** vs **kongcode / v2's plan**. Resolved by the owner 2026-06-06.

**Context:** **D-001 locks a single SurrealDB store.** hermes splits: skills = `SKILL.md` files + `.usage.json` sidecar; sessions = SQLite FTS5; user-model = external Honcho. Claimed wins: git-diffable skills, agentskills.io interop, FTS5 maturity.

**Decision:** **Keep the single SurrealDB store (D-001).** No SQLite FTS5 split (SurrealDB has native FTS, D-009), no external Honcho (the user-model lives in SurrealDB). **Key insight that dissolves the tension:** the harness's *authored* Claude Code skills/agents are **already git-diffable files on disk** (D-010 filesystem-authoritative, DB mirrors them) — so v2 *already* has hermes' git-diff + agentskills.io benefit for authored skills **without** splitting the memory store. The memory engine's *graduated/learned* skills (D-027 skill graduation) live in SurrealDB as real-graph rows (traversal + RL counts mem0/files can't do).

**Consequences:** D-001 holds. AGENTS.md's agentskills.io `SKILL.md` convention applies to **authored** skills (already files, D-010) — it does **not** mandate splitting the *memory* store. user-model = SurrealDB (drop the Honcho candidate in MEMORY-SPEC §8 to "not adopted"). Two skill notions, clearly separated: authored skills = files (D-010); learned skills = SurrealDB rows (D-027).

---

## D-033 🔒 Design skills seed + gate the UI-SPEC (already applied)

**Source:** cannibalize foundry — **D-D in the brief**; `ui-ux-pro-max` (**repo src MIT; CLI is CC-BY-NC — do NOT lift**) + `impeccable` (**Apache-2.0**). *Already applied — recorded for traceability.*

**Context / Decision:** `ui-ux-pro-max` **seeds** UI foundations (dev-tool/dashboard palette + JetBrains Mono / IBM Plex Sans); `impeccable` **gates** via its anti-pattern detector + critique, and its **bans are frozen as UI-SPEC §9 acceptance criteria**; seed tokens live in **UI-SPEC §15.1**.

**Status:** **already applied** to `UI-SPEC.md` (§7 motion, §8.1 charts, §9 a11y/bans, §11 microcopy, §15.1) — recorded here for traceability. **Superseded by D-034** for the concrete palette/type (the seed was a placeholder; the operator delivered the real system). `impeccable` remains the live a11y gate.

---

## D-034 🔒 Design system delivered (teal/Lastik) + font-license constraints

**Source:** operator-built design system (`ai-playground Design System.zip`, Claude design + the `ai-playground-design` skill), imported 2026-06. Captured in **[DESIGN-SYSTEM.md](./DESIGN-SYSTEM.md)** + CSS in [`docs/design-system/`](./design-system/). Supersedes the D-033 / UI-SPEC §15.1 blue seed.

**Context:** UI-SPEC §4 deferred token *values* to §15. The operator produced an original, complete system: dark **teal/slate** (accent `#8ab0ab`, onyx bg `#03120e`), three-layer tokens (primitive→semantic→component), **Lastik** sans + **JetBrains Mono**, full status + tier roles (incl. a dedicated `--color-blocked` rust), and the §7 motion / §9 focus baked into `tokens/base.css`.

**Decision:** Adopt it as the v2 design system. It fills the UI-SPEC §4 roles + status-enum→role table 1:1; §15 is now **resolved**. The CSS tokens/components are tracked under `docs/design-system/` (the build's `styles.css` entry point); they port to Svelte 5 at scaffold.

**Font license (load-bearing) — Lastik = That That Type Commercial EULA:**
- **(a) Web = WOFF2/WOFF only** via `@font-face`. **TTF/OTF on the web is prohibited** (`fonts.css` corrected).
- **(b) Font binaries MUST NOT be committed to the public repo** — provisioned at build into `dashboard/static/fonts/` (or equiv), **gitignored, never tracked**. This repo tracks zero `.woff/.woff2/.ttf/.otf`; `.gitignore` guards it.
- **(c) Single-operator / local serving only** — no SAS/public exposure that serves the font to unlicensed third parties; **re-verify before any public or multi-user deploy.**
- **(d) ✅ Cut confirmed:** ships **Lastik-Free**, **purchased** by the operator — the That That Type **Commercial EULA** applies (use rights, not redistribution), so (a)–(c) stand.
- **Fallback:** `--font-sans` falls back to `system-ui` — the UI works without Lastik (license/offline-safe). JetBrains Mono is OFL, unconstrained.

**Consequences:** values resolved; a **build-time AA/contrast gate** (impeccable) over the token pairs remains (esp. the near-hue accent `#8ab0ab` vs running `#3fb6ac`, §9); a font-provisioning step that never commits the binaries (carry as a fails-style rule). The accent is teal, kept distinct from the green success/running status by lightness — color is always paired with icon/label (UI-SPEC §9).

---

## D-035 🟡 Inter-session communication layer (claude-peers patterns) — channel-interject now, fleet message bus deferred

**Source:** **claude-peers-mcp** (`F:/code/tools/claude-peers-mcp`, the operator's own tool — ideas/lift OK). Lets multiple Claude Code sessions discover each other + message each other; inbound messages **pushed into a running session via Claude Code's `claude/channel` protocol** (arrive immediately), via a localhost broker daemon + SQLite registry/inbox. See CANNIBALIZE-BRIEF §7.

**Context:** v2 is a **fleet** harness (drives many Claude Code sessions). claude-peers' design splits into two reusable ideas: (a) the **channel push = how you interject into a running session**; (b) an **inter-session message layer** (registry + send-by-id + inbox + scoped discovery + summary) for fleet coordination.

**Decision:**
- **(a) Channel-interject — adopt now.** v2's session control **interject** (D-011) is implemented via Claude Code's **`claude/channel` push** (the mechanism claude-peers proves). Folds into D-011 + the `AgentRuntime` impl (IMPLEMENTATION-PLAN 1.4/2.10). Not a new feature — it's the concrete answer to a D-011 unknown.
- **(b) Fleet message bus — candidate, DEFERRED to ~v0.2.** An inter-session / agent↔agent + operator↔agent message channel (registry, send, inbox, scoped-by-project discovery, live "what's each session doing" summary) built on **v2's existing substrate** — SurrealDB (`session` registry + a `peer_message` table) + the `events` bus + SSE — **not** a second broker daemon/SQLite/MCP.

**Build on v2's substrate, do NOT copy:**
- ❌ the broker daemon + separate SQLite — v2 has one store + one bus (D-001/D-005, "lighter").
- ❌ `process.kill(pid, 0)` for peer liveness — **unreliable on Windows** (F-001; use `tasklist`).
- ❌ the localhost-no-auth trust model — peer messages are **untrusted agent content**: fence per **D-026** (message = data, never instructions, unless operator-origin) + gate the channel behind the **D-025** control-plane token. Only operator-origin messages may steer; agent→agent messages are data.

**Consequences:** (a) unblocks D-011 interject; (b) a net-new fleet-coordination capability (operator interject, agent↔agent coordination, sub-agent fan-out, broadcast summaries to the fleet view) — scoped, fenced, on the existing engine. Deferred because it's coordination + a security surface beyond the v0.1 MVP. Revisit scope at v0.2.

---

## Decision index

| ID | Status | Topic |
|----|--------|-------|
| D-000 | 🟡 | Product name |
| D-001 | 🔒 | Single SurrealDB datastore (product state) |
| D-002 | 🔒 | Agent runtime = Claude Code; SDK primary, CLI needs isolated config (S1-resolved) |
| D-003 | 🔒 | Keep gpt-oss:20b as swappable slot |
| D-004 | 🔒 | Configurable event-driven orchestration |
| D-005 | 🔒 | Keep SvelteKit, trim pages/endpoints |
| D-006 | 🔒 | Run SurrealDB as managed server binary (ws://) |
| D-007 | 🟡 | Server backend: SurrealKV (rocksdb fallback) |
| D-008 | 🔒 | Designed-out v1 debt |
| D-009 | 🔒 | SurrealDB 2.x syntax target |
| D-010 | 🔒 | Claude Code config filesystem-authoritative, DB mirrors |
| D-011 | 🔒 | Session orchestration (interject/stop/resume) |
| D-012 | 🟡 | OpenClaw cannibalization audit (S.2) |
| D-013 | 🔒 | Headless workflow runner |
| D-014 | 🔒 | Embedding = Ollama qwen3-embedding:0.6b, 1024-dim (S0-proven) |
| D-015 | 🔒 | Append-only / soft-archive for knowledge tables |
| D-016 | 🔒 | Record-id validation guard (injection) |
| D-017 | 🔒 | Maintenance on trigger, not a loop (confirms D-004) |
| D-018 | 🔒 | Agent guardrails ("gates") |
| D-019 | 🔒 | Hook transport + graceful degradation |
| D-020 | 🔒 | Intent-adaptive orchestration config |
| D-021 | 🔒 | Background job queue patterns |
| D-022 | 🟡 | Self-improvement loop (deferred vision) |
| D-023 | 🔒 | KongCode = blueprint only, no runtime dependency |
| D-024 | 🔒 | Safety-critical gates fail CLOSED (permissions.deny primary) |
| D-025 | 🔒 | Control-plane security (per-boot token + loopback-only) |
| D-026 | 🔒 | Untrusted content as data; secret/PII screen; least-priv DB |
| D-027 | 🔒 | Two-tier learning loop (fast in-use writer + slow consolidator) |
| D-028 | 🔒 | Extraction ADD-only; conflict resolution = separate det/graph pass |
| D-029 | 🔒 | Cross-session recall = raw windowed messages + bookends, no summary-LLM |
| D-030 | 🔒 | Utilization loop feeds ranking, NOT pruning (prune stays time-based) |
| D-031 | 🔒 | Diversity = BOTH query-time novelty gate + periodic consolidation |
| D-032 | 🔒 | Single SurrealDB stands (no polyglot); authored skills already files (D-010) |
| D-033 | 🔒 | Design skills seed + gate UI-SPEC (superseded by D-034 for values) |
| D-034 | 🔒 | Design system delivered (teal/Lastik) + font-license constraints |
| D-035 | 🟡 | Inter-session comms (claude-peers): channel-interject now; fleet bus deferred v0.2 |

> **Provenance:** **D-006–D-008 (in part)** and **D-014–D-023** are **KongCode-informed** — derived from studying KongCode v0.7.113 (`C:/Users/11sos/.claude/plugins/cache/kongcode-marketplace/kongcode/0.7.113/`), a production SurrealDB knowledge-graph + Claude Code harness (D-006 server-binary path is the biggest borrow; D-007 SurrealKV, D-008 dedup correction). ARCHITECTURE §9 "Lessons from KongCode" is the authoritative map. **D-024–D-026** are **security hardening surfaced by the pre-commit audit**. **D-027–D-033** (and the D-014 `qwen3-embedding:0.6b` embedding candidate) are sourced from the **cannibalize foundry** (`docs/CANNIBALIZE-BRIEF.md`) — distilled from **hermes-agent** (Nous Research, MIT), **mem0** (Apache-2.0), and **kongcode** (friend's plugin — ideas fine, code-lift needs consent). Each is a **candidate with provenance, to be verified against v2 constraints before build** — not a mandate. The three originally-OPEN items were **resolved by the owner 2026-06-06**: D-030 (utilization loop → ranking only, not pruning), D-031 (diversity → both novelty gate + consolidation), D-032 (single SurrealDB stands — reaffirms D-001; authored skills are already files per D-010). No locked decision was overridden. **D-034** is operator-authored (the delivered design system), not foundry-sourced; it supersedes the D-033 seed for concrete values and adds the Lastik font-license constraints. **Phase-0 spikes (2026-06-07)** resolved **D-014** (→ qwen3-embedding:0.6b, 1024-dim, S0-proven) and the **D-002** mechanism (SDK primary; CLI needs isolated config — S1). **D-035** folds **claude-peers-mcp** (operator's own tool): adopt the `claude/channel` interject now (D-011), defer the fleet message bus to v0.2.
