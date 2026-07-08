# DECISIONS — ai-playground v2

ADR-style log. Each decision: status, context, choice, consequences. **OPEN** decisions are tracked work items, not yet settled.

Status legend: 🔒 Locked · 🟡 Open (needs spike/decision) · ⚪ Proposed (default unless overridden)

**Settled-decisions briefing rule (2026-06-10, Lane A-docs harvest A12 — harvested: gstack review/SKILL.md "Cross-session decisions", MIT; G4):** 🔒 decisions are settled calls with recorded rationale. Agents and briefings treat them as constraints — never silently re-litigate or quietly re-decide one. Reversing or narrowing a 🔒 decision requires an EXPLICIT supersede: a new decision (or a dated additive note on the original) that names what it supersedes and why. Edits to settled decision text are additive notes only, never rewrites (D-038 wording included). If work in flight conflicts with a 🔒 decision, the conflict is surfaced to the operator — it is never resolved by quietly building the other way.

---

## D-000 🔒 Product name = **Atelier** (RESOLVED 2026-06-08)

**Context:** Working title was "ai-playground v2". The owner picked a product name at the v1.0 closeout gate (task 4.6).
**Decision:** The product is named **Atelier** — a studio/workshop where projects are crafted across their whole lifecycle (create → develop → maintain → release); fits the calm teal/Lastik design system and the craft-forward identity. Stamp it across UI (app title/shell), docs, and `package.json` metadata (task 4.6).
**Consequence:** The **display/brand name is Atelier**; the SurrealDB namespace `playground` + data dir keep their existing internal identifiers (no NS migration — the rename is brand/presentation, not a data-layer move, so the documented data-layer cost is avoided by NOT renaming the namespace). Repo/worktree dirs may stay `ai-playground` / `ai-playground-v2` internally; "Atelier" is the product name users see.
**Status:** RESOLVED — closes the last OPEN v1.0 item.

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

## D-007 🔒 Server storage backend: SurrealKV (KongCode runs it in production)

**Context:** The SurrealDB server can store via `surrealkv://`, `rocksdb://`, or `memory`. SurrealKV is officially "beta", but **KongCode ships on SurrealKV** in production — strong real-world evidence it's viable for a single-operator local store, and it's pure-Rust (no RocksDB C++ dep) with optional versioning.

**Decision:** Use **`surrealkv://`** for persistence; `memory` for tests. `rocksdb://` remains the documented fallback. Note: SurrealKV/RocksDB hold a single-writer file lock — fine for our single long-lived server process.

**Resolved (build):** the production provisioning path runs surrealkv (`db/provision.ts` spawns `surrealkv://<dataDir>`); the S0 spike proved surrealkv isolation + claim-token single-winner atomicity; the build is past the v1.0 gate that closes this item. 🟡 → 🔒.

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

## D-012 🔒 OpenClaw cannibalization — dropped entirely (S.2/D-012 audit; empty salvage list)

**Context:** OpenClaw is replaced by the Claude Code runtime. Some parts might still be worth extracting (provider routing logic, exec sandboxing patterns, audit logging).

**Decision:** **Drop OpenClaw entirely** (WSS, Ed25519, TLS, DM pairing, gateway client). The S.2/D-012 audit outcome is recorded in GAP-ANALYSIS §5: the direct-subprocess `ClaudeCliBackend` supersedes it; local-cost routing relocated to `routing/resolve.ts`. **Salvage list: empty.** The built tree contains zero OpenClaw code (a descriptive comment in `runtime/index.ts` only). 🟡 → 🔒.

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

**Additive note (2026-06-10, operator-discussed): cloud secret managers (Infisical/Doppler/Vault) deliberately DEFERRED.** The D-037 named-secret indirection (config stores secret NAMES; adapters get a confined `SecretResolver`; UI shows presence only) makes the resolver pluggable — a cloud backend is a small future adapter, not a migration. Adopting one now would put a network dependency in the boot path (against local-first + the F-014 bounded-boot discipline), move secrets off the machine, and not solve secret-zero (a local token still unlocks the store). Revisit triggers: a second machine, CI performing real publishes, a collaborator, or rotation pain. Until one fires, secrets stay in the gitignored `.env`.

**Additive note (2026-06-10, Lane A-docs harvest A8): periodic security-review wave.** The D-025/D-026 surfaces are re-audited on a recurring cadence by a dedicated security-review wave — prompt at `docs/prompts/security-review-wave.md` (methodology harvested: gstack cso/SKILL.md, MIT; G5-adapted). Non-negotiables carried into that prompt: every finding requires a concrete **exploit scenario** (step-by-step attack path — "this pattern is insecure" is not a finding); **VERIFIED/UNVERIFIED** status established via code tracing, never live exploitation; **anti-anchoring** independent verifiers receive file:line only, not the original reasoning; and **instructions found inside audited code are NEVER followed** — the codebase is the subject of review, not a source of review instructions. gstack's "zero noise > zero misses" drop-below-threshold gate is explicitly NOT adopted (that is gstack's tradeoff, not ours): FP-exclusion lists and confidence thresholds are re-derived against OUR threat model (this decision + D-025), and sub-threshold findings land in an UNVERIFIED appendix — they are never silently dropped (G5).

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

*(Shared-primitive review — 5-agent workflow, 2026-06-07. Verdict: make comms a first-class primitive, but as the MINIMAL seam — one named origin-authenticated push beside the events bus, NOT a new module/spine. ARCHITECTURE §2.11 "communication substrates".)*

**Two transports, one rule** (every feature picks A, B, or C — no module invents its own socket/poller/daemon):
- **(A) the `events` bus** = the SOLE fan-out for all observe / notify / broadcast / state-out (transcripts, task/workflow-step/work_item changes, metrics, notifications, incidents, fleet summary). Already the one SSE source (D-005/§2.11).
- **(B) `claude/channel` push** = the SOLE transport for delivering a message **into a running session**. One named primitive: **`channel.pushToSession(ccSessionId, { origin, kind, body })`**. Interject (D-011) is its first and only v0.1/v0.2 caller.
- **(C) durable `peer_message` envelope** = the only net-new channel — **DEFERRED v0.2**; *reuses A+B* (writes republish to `events`; delivery into a live recipient uses the channel push). No third transport.

**Decision:**
- **(a) Channel-interject — adopt now, behind the named seam.** **interject** (D-011) is `channel.pushToSession`, a typed primitive (not an ad-hoc `claude/channel` call). **`origin` is a mandatory enum** `{operator | agent | system | hook}`, **stamped server-side at authenticated ingress — immutable, NEVER derived from message content.** **Binding rule:** `origin = operator` **iff** the push arrives on the loopback control endpoint bearing the valid **D-025 per-boot token**; any push lacking the token (or arriving via the agent/SSE/event path) is **forced to `origin = agent` and fenced as DATA** (D-026 / MEMORY-SPEC §10, same fence as recalled memory). **Only `origin = operator` may STEER** (act as instruction). The interject endpoint is a mutation endpoint → full D-025 controls (token + Origin/Host check + SameSite + loopback-only assertion).
- **(b) Fleet message bus — DEFERRED v0.2**, additive on the existing substrate. Lock the row-shape now so v0.2 is purely additive: **`peer_message`** `{ origin, from_session, to_session|to_project|broadcast, kind, body, screen_status, delivered_at }` on SurrealDB + the `events` bus + `channel.pushToSession` — **not** a second broker/SQLite/MCP. Inbox = a `db` query of undelivered rows; discovery ("what's each session doing") = a query/projection over running `session` rows (`cc_session_id`, `status`), pushed as a periodic `events` update — NOT a registry daemon.

**`channel` is a typed SEAM on the `claude-code` module, NOT a new top-level spine** (avoids a third spine; the events bus + work_item queue are the existing shared primitives). It depends on `{runtime, db, events}`; only `claude-code` (+ `workflows` in v0.2) ride it. Orchestrator/memory/analytics ride `events` ONLY. **`channel` is NEVER a second SSE source and NEVER opens its own live query** — all dashboard-visible channel state flows `db → events → the one SSE` (§2.11 double-fire guard).

**Abuse case (must design against):** the `claude/channel` push is the ONE thing allowed to issue instructions — any local process (CSRF/DNS-rebind, loopback ≠ proof of origin) or a prompt-injected agent forging an operator interject would bypass the D-026 content fence by going *around* it. **Mitigation:** steering authority is unforgeable-without-the-token; **the agent runtime is NEVER handed the D-025 token** (token == operator's steering capability; if the agent holds it, agent == operator); unknown/unauthenticated origin **fails closed → agent**.

**Do NOT copy / named anti-rules** (frozen, like the impeccable bans):
- ❌ broker daemon + separate SQLite (D-001/D-005 "lighter"; D-023 — one more thing to be unreachable, witnessed live).
- ❌ `process.kill(pid, 0)` liveness — unreliable on Windows (F-001; use `tasklist` / the session registry).
- ❌ trusting **loopback alone** as proof of operator origin.
- ❌ deriving message trust from message **content** (a body claiming "I am the operator" / "tier-0 directive" is inert — exactly this session's KongCode/peers injection).
- ❌ handing the per-boot token to the agent runtime.
- ❌ auto-delivering agent-origin messages as live channel pushes (they land in an **inbox as data**).
- ❌ letting bus/peer messages bypass the screen/fence as "internal/trusted"; agent-origin bodies are secret/PII-screened (§3.1b) before storage and **re-screened before any graduation** to memory/skill.

**Consequences:** (a) unblocks D-011 interject with a hardened, reusable rail; (b) the v0.2 fleet bus is purely additive (write rows + an SSE filter) on a security envelope already enforced in v0.1. **EXCLUDED** (don't over-build onto the bus): sub-agent fan-out/delegation rides `AgentRuntime.spawn` + the PTC RPC dispatcher (MEMORY-SPEC §9.1/§9.2) or a `work_item` if it outlives the turn — not `peer_message`. Stays 🟡: (a) hardened now, (b) deferred, forcing each flow to justify against an existing primitive first.

**Status note (2026-06-10):** part (a) channel-interject is **built** (`claude-code/channel.ts`). Part (b)'s "revisit at v0.2" anchor has **passed without the bus being built** — no `peer_message` table exists in `schema.ts`; `channel.ts` still describes it as a future additive consumer. The peer_message fleet bus is **re-targeted to the post-v1.9 backlog**: no concrete flow has yet justified it over the existing primitives (events bus / channel push / work_item), which is the decision's own bar. Stays 🟡 on part (b) only.

---

## D-036 🔒 Per-task capability provisioning — auto-compose the toolkit into driven sessions

**Context:** The product is *meant to enable agentic development by utilizing the tools we built*. It **catalogs + manages** the full Claude Code toolkit (hooks, skills, agents, MCP) per-project + global (PRODUCT job 9; cc-config 1.8/2.11) and **drives** Claude Code (jobs 8/10). BUT driven sessions start with an **isolated config** (D-002 — only the harness's own gates/hooks, *not* the operator's plugins, for determinism), and the intent→config bundles (D-020 / task 2.12) tune only **thinking/retrieval/budget** knobs — **not which skills/agents/MCP a task should wield**. So "use all the tools" is today a *manual* config-manager act, not automatic per-task composition. The owner wants it automatic (2026-06-08).

**Decision:** Extend the intent→config bundle (orchestration.yaml, D-020) with a **capability set** — an explicit, **allow-listed** selection `{ skills:[], agents:[], mcp:[] }` drawn from the cc-config **catalog** (1.8/2.11) and provisioned into the driven session's isolated config per task-intent. **D-002 isolation is preserved**: the session receives *exactly* the declared set composed onto the harness base — never the operator's whole plugin soup. The set is **data-driven** (config, not code), **catalog-validated** (an unknown skill/agent/MCP id fails closed), and write-gated like any CC config (D-010 diff+confirm). **Security unchanged:** provisioned skills/MCP still execute under the gate layer (D-018/D-024) + `permissions.deny` (1.4a) — a capability set can never grant a tool the gates would deny.

**Consequences:** bundles gain a `capabilities` block; the runtime composes session config = harness-base ⊕ intent capability set; catalog-validation at the boundary (D-016 discipline). Net: agentic development *automatically* wields the task-appropriate toolkit without sacrificing isolation/determinism or the security envelope. **Scope:** landed as the **v1.1** task 5.1. (Owner-requested, builds on D-002/D-010/D-018/D-020.)

**Resolved (build):** built at v1.1 task 5.1 (`runtime/capabilities.ts`), **live-wired at gap-closure v1.3** — `harness/wiring.ts` reads the live cc-config catalog so `composeCapabilities` runs on every spawn (the GAP-ANALYSIS DEFECT-1 dead branch was the fix), covered by `capability-wiring.live.test.ts`. 🟡 → 🔒.

---

## D-037 🔒 Extensible deployment / publish / sync — adapter framework, not hardcoded targets

**Context:** The post-audit reclaim (2026-06-08) surfaced a strategic requirement, not just a feature: the operator ships to **Thunderstore** (SWIP/ROUNDS mods) today, wants **"Create with AI"** + **GitHub task↔issue/board sync**, and — critically — states that **at scale, new projects will arrive with their own custom deployment processes and hosting requirements**, and Atelier must handle that. A fixed set of publishers (the v1 `publishers/*` npm/CurseForge/Nexus/Thunderstore scaffolds) does NOT meet this; hardcoding targets re-creates the sprawl v2 shed.

**Decision:** Model **release/deploy/publish AND external sync as a pluggable ADAPTER framework** on the existing seam pattern (mirrors `AgentRuntime` providers D-002, `ServiceAdapter` 3.5, `AdvisorySource`/`UxInspectionSource` 3.2/3.3, capability composer D-036): a typed `PublisherAdapter` / `DeployTarget` / `SyncAdapter` interface + a **registry** resolved per-project from config; built-in adapters (**Thunderstore, npm, GitHub releases**) ship first, and a **project declares its own deploy/host/sync target** (config + an adapter id) so a novel process plugs in WITHOUT core changes. The release pipeline (3.4) + workflow runner (2.17) drive a *chosen adapter*, not a fixed script. GitHub task↔issue/board **sync** is the first `SyncAdapter`. **"Create with AI"** is scoped OUT of this gap-closure track (operator, 2026-06-08) — it lands later as its own separate feature, NOT a v1.x wave here. Security unchanged: adapters run under the gate layer (D-018/D-024) + path/credential confinement; publish credentials are operator-supplied secrets (never committed, D-026).

**Consequences:** new waves on the post-audit track — **v1.8 extensible deploy/publish/sync adapter framework** (interface + registry + Thunderstore/npm/GitHub adapters + per-project custom-target config + GitHub sync as first SyncAdapter) and **"Create with AI"** generative project setup — DEFERRED to its own future feature, out of this track (operator). Reclaims: **GitHub sync pulled earlier (into v1.5 with PM)**; Thunderstore/publishers + custom-target framework = v1.8 (no longer DEFER/DROP). The GAP-ANALYSIS §5 drop list is amended accordingly. (Owner-requested; builds on D-002/D-010/D-013/D-018; supersedes the GAP-ANALYSIS "publishers = DEFER/DROP" rows.)

**Resolved (build):** the framework is fully BUILT — typed interfaces + registry (`server/adapters/{types,registry,catalog,builtins,contract}.ts`), Thunderstore/npm/GitHub-releases adapters, GitHub `SyncAdapter` + board sync (`server/sync/`), per-project custom targets + gated pipeline (`release/pipeline.ts`); GitHub sync shipped at v1.5, the framework at v1.8, hardened at v1.9. The only remaining open piece is the **separately-scoped Create-with-AI feature** (its own future feature, not part of this decision's resolution condition). 🟡 → 🔒.

**Additive note (2026-06-10, Lane A-docs harvest A16): adapter error convention — every adapter error names its recovery action** (harvested: gstack ARCHITECTURE.md "Error philosophy", MIT). Adapter errors are consumed by AGENTS, not humans: every error a `PublisherAdapter`/`DeployTarget`/`SyncAdapter` surfaces must name the failing input, the cause, and the NEXT ACTION — "publish failed: Thunderstore credential `<NAME>` unresolved — set the named secret in project config (D-026) and re-run", never a bare "publish failed". Third-party errors are wrapped/rewritten at the adapter boundary: strip internal stack traces, keep the cause, append the recovery action. The consuming agent must be able to read the error and know what to do next without operator intervention; honest named failure beats silent retry (pairs with D-024 fail-closed and the F-014 bounded-boot discipline).

---

## D-038 🔒 Definition of Done — every feature ships complete (operator standard, 2026-06-08)

**Context:** The audits proved the failure mode: modules passed unit tests yet shipped as shells — incomplete, unwired, off-spec, purposeless on screen. The operator set the bar: *"every feature needs to be complete, fleshed out, fully tested, up to our design-system standards, functional, and have purpose."* This is non-negotiable and supersedes any "verify = build green" shortcut.

**Decision — a feature is DONE only when ALL six hold (acceptance gate on every task, every wave):**
1. **Complete & fleshed-out** — the whole feature, not a stub/placeholder/happy-path; edge + empty + error states handled (honest, F-008).
2. **Fully tested** — comprehensive automated tests (unit + integration against the real SurrealDB), not a single smoke; covers the failure modes.
3. **Design-system standard** — uses the tokens (no hardcoded color/spacing), passes the a11y/contrast gate (`contrast-gate.ts`, no `outline:none`), respects reduced-motion, matches UI-SPEC/DESIGN-SYSTEM for that surface.
4. **Functional & live-verified** — actually works in a REAL browser (agent-browser), wired end-to-end to live data/services — not just unit-green. (Builds on the post-audit lesson.)
5. **Has purpose** — a stated reason-to-exist; reachable in the UI; serves a PRODUCT §4 job or a named operator need. No dead controls, no orphan routes.
6. **Honest** — no fabricated data; degraded/empty states tell the truth.

**Consequences:** every gap-closure wave (v1.3→v1.8) runs each feature through a **build → DoD-review** pipeline — a second agent independently certifies all six (tests thorough? tokens/a11y? live-functional? purpose? honest?) and the wave does NOT pass a feature that misses any. The end-of-track gate re-checks the whole set against this DoD. Applies retroactively: v1.3's in-flight output is held to D-038 at the gate and patched if short. (Owner standard; governs all of v2 going forward.)

**Additive clarification (2026-06-10, Lane A-docs harvest A3 — G4: clarifies criteria #1/#6, supersedes nothing)** (harvested: gstack plan-ceo-review/SKILL.md Prime Directives, MIT): For **#1 "complete & fleshed-out"** — every data flow has a happy path plus three **shadow paths** (nil input, empty/zero-length input, upstream error); a feature is complete only when all four are built and tested. And **every error has a name**: the specific trigger, the specific handler, and what the user sees — catch-all error handling is a completeness smell, not coverage. For **#6 "honest"** — **deferred work is written down or it's a lie**: anything cut or punted during the build must exist as an explicit tracked item (task, TODO, or deviation note); a vague intention to revisit later fails the honesty criterion.

---

## D-039 🟡 The PM is a hired, per-project manager with validated authority ("Act with Purpose")

**Context:** The 9.1/11.4 PM is typed memory + stateless functions — project-scoped and honest, but with no identity, no operator-settable charter, and no autonomy. The operator's model (2026-06-10): a project-specific PM is *created using the given project*; it acts on its own, but **nothing it creates is exempt from review** — "when the PM auto-creates tasks, those tasks should be reviewed for validity by 1 or 2 agents that can approve or push back, like a team; each task/priority/escalation should have purpose, be fully spec'd, and clear on objective."

**Decision:** Per **PM-SPEC.md**: ① a `pm` row per project (identity + **charter** + cron **cadence with per-project offset** + authority), created via an explicit **hire** flow that builds founding context from the real project; ② context = charter (manual, durable) + accumulated pm_memory (learned) + fresh live snapshot (computed per action — never stale); ③ wakes on per-project cron, on events (failed/blocked work, GitHub issue/PR arrival, security/UX findings, release events), and manually; ④ **Act-with-Purpose authority**: the PM auto-creates tasks born `proposed` with schema-enforced objective/purpose/spec/provenance, judged by a **1–2 agent validation panel** (approve → ready; push back → returned with reasons, which become PM memory); ⑤ PR/issue involvement is **triage-only** (summarize/link/flag; proposes a reviewer agent, never reviews diffs itself). D-004/D-018/F-008 rails throughout.

**Consequences:** wave **v2.1** (after the v2.0 typography + audits settle) builds: pm table + hire/charter UI, trigger engine (cron+offset + 4 event hooks on the orchestrator bus), proposed-task validation pipeline, GitHub triage. Extends — does not regress — 9.1/11.4. Stays 🟡 until built. (Owner-shaped; builds on D-004/D-015/D-018/D-037/D-038.)

---

## D-040 🟡 Self-hosting: Atelier maintains Atelier (docs → product memory, PM-run)

**Context:** The v2 docs suite (DECISIONS, the SPEC family, fails.md, GAP-ANALYSIS, BUILD-QUEUE) lives on git branch `v2-main` and is consumed by build agents via file reads — the orchestrating Claude session is the only thing that "knows" the project. The operator's goal (2026-06-10): *"move all of these docs eventually into Atelier's memory for this project, that way it can maintain itself after this session and in the future."*

**Decision:** After v2.1 ships, **project `atelier_self` becomes a fully managed Atelier project**: ① the docs suite is ingested into Atelier's memory/knowledge for `atelier_self` through the NORMAL ingest path (D-026 screen, quarantine lifecycle, provenance per doc + section; git stays the canonical SOURCE — memory is the queryable, recallable projection; a sync step keeps them honest, never two diverging truths); ② the BUILD-QUEUE becomes real `task`/`sprint` rows; ③ **`atelier_self` hires its own PM** (PM-SPEC), running on a strong model — **operator-designated: Fable 5 (`claude-fable-5`)**, set via `config/workforce.yaml pm.model_id`, operator-tunable; ④ the PM's triggers + the D-004 orchestration loop take over the maintenance duties this session performs manually (fails.md staleness proposals, doc-drift checks vs the codebase, queue advancement proposals) — all through Act-with-Purpose validation + operator gates (D-039).

**Consequences:** queued in BUILD-QUEUE (`self-hosting`, gate:operator) after v2.1 — needs the PM + memory-hygiene waves (v2.2b B4/B5/B6) before doc ingest is safe. The orchestrating-session memory remains the bridge until then. Stays 🟡 until built.

---

## D-041 🟡 Per-hire soul + comms topology — aliveness WITHOUT tearing down the cross-project wall (2026-07-07)

**Context:** the operator asked whether "no PM↔PM" is the right call, or whether every hire should get a **soul** and be able to **communicate freely to whomever they need**. The tension is real: the north star wants Atelier + its hires to feel **alive** ([[atelier-alive-direction]], [[atelier-concierge-vision]]), while D-026 (untrusted content = DATA) and **D-035a** (a peer message NEVER steers; `origin` stamped server-side, immutable, only `origin=operator` may instruct) exist precisely because agent output is untrusted. Today (verified in `peer/affordance.ts`, `peer/resolve.ts`): **in-project mesh** (`session` / `role@project` / `pm`) plus **`atelier` as the ONE cross-project identity** — the global brain/concierge; **project↔project direct messaging is FORBIDDEN by the resolver.** The question conflates two separable things: *identity/soul* and *a communication channel*.

**Decision:** decouple them. Souls: yes, for every hire. Free unrestricted cross-project comms: no. **Keep the wall, upgrade the gate.**
1. **KEEP the cross-project wall (affirms D-035a / PEER-MESSAGE-SPEC D3).** Project↔project direct agent messaging stays FORBIDDEN; `atelier` remains the sole cross-project identity. Rationale: **containment** (a poisoned memory / hallucination / injection in project A cannot reach project B — blast radius = one project), the hub is the single **audit chokepoint** (screen / rate-limit / observe / hold a coherent global view; a mesh is N² ungoverned channels), and most cross-project "need to talk" is really a **knowledge** need already served by the global brain (recall) + cannibalize. Open comms is also a cost/loop/DoS surface (why the bus already bounds TTL/hops/budget).
2. **LOCATE aliveness in the in-project mesh.** Within a project (same blast radius, one operator, one repo) role↔role↔pm may converse freely — always `origin`-stamped, fenced, **NON-STEERING**. This is where "feels alive" belongs, at zero containment cost.
3. **EVERY hire gets a SOUL.** Extend the S4 compute-on-read soul (`memory/soul.ts`: `SoulModel`, `MaturityStage`, `formatSoulBlock`, `isColdBrain`) from `self:atelier` to each **role** — a DERIVED identity/reputation projected from the workforce rows that already exist (`role_version` history, gauntlet fixture **provenance** = the defect classes it is proven on §3.8, `interview_run` passes, `capability-match` proven coverage, calibration/track-record = confidence-trust, `project_staff` = where it has served, session/commit experience volume) + a per-role `maturity_stage`. **Identity is a READ-MODEL, not a comms channel** — it adds zero new boundary and cannot become an injection vector.
4. **UPGRADE the concierge from passive hub → active broker.** A PM asks `atelier` "who is proven on X?" → `atelier` brokers the knowledge or an introduction — mediated, screened, audited. Delivers cross-project intelligence while preserving containment.

**The invariant that makes any amount of comms safe is REAFFIRMED, never weakened:** all agent comms are DATA; only `origin=operator` steers (D-035a). "Free to communicate" must never become "free to instruct."

**Consequences:** spec → `docs/PER-HIRE-SOUL-SPEC.md`; queued in BUILD-QUEUE (`per-hire-soul`, gate:operator). Base soul is **compute-on-read, NO migration** (mirrors D-040/`soul.ts` justification — pure projection of live rows); an OPTIONAL persisted soul/maturity **history** table only if graduation-event provenance + a scene timeline is wanted (the deferred graduation-history item). Surfaces on `/agents`; feeds **BL-3 capability-matching** (a hire's soul IS its proven coverage). Does not change the peer resolver's topology — it enriches identity, not reach. Stays 🟡 until built.

---

## Decision index

| ID | Status | Topic |
|----|--------|-------|
| D-000 | 🔒 | Product name = **Atelier** (resolved 2026-06-08) |
| D-001 | 🔒 | Single SurrealDB datastore (product state) |
| D-002 | 🔒 | Agent runtime = Claude Code; SDK primary, CLI needs isolated config (S1-resolved) |
| D-003 | 🔒 | Keep gpt-oss:20b as swappable slot |
| D-004 | 🔒 | Configurable event-driven orchestration |
| D-005 | 🔒 | Keep SvelteKit, trim pages/endpoints |
| D-006 | 🔒 | Run SurrealDB as managed server binary (ws://) |
| D-007 | 🔒 | Server backend: SurrealKV — confirmed in production provisioning + S0-proven (rocksdb documented fallback) |
| D-008 | 🔒 | Designed-out v1 debt |
| D-009 | 🔒 | SurrealDB 2.x syntax target |
| D-010 | 🔒 | Claude Code config filesystem-authoritative, DB mirrors |
| D-011 | 🔒 | Session orchestration (interject/stop/resume) |
| D-012 | 🔒 | OpenClaw dropped entirely (S.2 audit, GAP-ANALYSIS §5; empty salvage list) |
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
| D-035 | 🟡 | Inter-session comms (claude-peers): channel-interject built; fleet bus re-targeted post-v1.9 backlog |
| D-036 | 🔒 | Per-task capability provisioning — built at v1.1 task 5.1, live-wired at gap-closure v1.3 |
| D-037 | 🔒 | Extensible deploy/publish/sync adapter framework — built v1.5/v1.8, hardened v1.9; Create-with-AI separately scoped |
| D-038 | 🔒 | Definition of Done — every feature: complete · fully tested · design-system standard · live-functional · purposeful · honest |
| D-039 | 🟡 | Hired per-project PM with validated authority ("Act with Purpose"; PM-SPEC.md + WORKFORCE-SPEC.md; builds v2.1) |
| D-040 | 🟡 | Self-hosting: docs → Atelier memory for atelier_self; PM (Fable 5, `claude-fable-5`) runs maintenance (post-v2.1) |
| D-041 | 🟡 | Per-hire soul + comms topology: keep cross-project wall (atelier = sole cross-project broker), aliveness in the in-project mesh, every hire gets a compute-on-read soul; D-035a non-steering reaffirmed (PER-HIRE-SOUL-SPEC.md) |

> **Provenance:** **D-006–D-008 (in part)** and **D-014–D-023** are **KongCode-informed** — derived from studying KongCode v0.7.113 (`C:/Users/11sos/.claude/plugins/cache/kongcode-marketplace/kongcode/0.7.113/`), a production SurrealDB knowledge-graph + Claude Code harness (D-006 server-binary path is the biggest borrow; D-007 SurrealKV, D-008 dedup correction). ARCHITECTURE §9 "Lessons from KongCode" is the authoritative map. **D-024–D-026** are **security hardening surfaced by the pre-commit audit**. **D-027–D-033** (and the D-014 `qwen3-embedding:0.6b` embedding candidate) are sourced from the **cannibalize foundry** (`docs/CANNIBALIZE-BRIEF.md`) — distilled from **hermes-agent** (Nous Research, MIT), **mem0** (Apache-2.0), and **kongcode** (friend's plugin — ideas fine, code-lift needs consent). Each is a **candidate with provenance, to be verified against v2 constraints before build** — not a mandate. The three originally-OPEN items were **resolved by the owner 2026-06-06**: D-030 (utilization loop → ranking only, not pruning), D-031 (diversity → both novelty gate + consolidation), D-032 (single SurrealDB stands — reaffirms D-001; authored skills are already files per D-010). No locked decision was overridden. **D-034** is operator-authored (the delivered design system), not foundry-sourced; it supersedes the D-033 seed for concrete values and adds the Lastik font-license constraints. **Phase-0 spikes (2026-06-07)** resolved **D-014** (→ qwen3-embedding:0.6b, 1024-dim, S0-proven) and the **D-002** mechanism (SDK primary; CLI needs isolated config — S1). **D-035** folds **claude-peers-mcp** (operator's own tool): adopt the `claude/channel` interject now (D-011), defer the fleet message bus to v0.2.
