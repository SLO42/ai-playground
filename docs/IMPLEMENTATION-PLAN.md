# IMPLEMENTATION-PLAN — ai-playground v2

How to **build** v2, in what order, with what verification. ROADMAP says *what ships when*; this doc says *how to get there, concretely* — the bridge from the planning docs to code. Read alongside ARCHITECTURE (modules/§5), DATA-MODEL (schema), DECISIONS (D-000–D-033), MEMORY-SPEC, UI-SPEC, AGENTS, DEVELOPMENT.

> **Status:** planning-level. No code exists yet (v2-main is a docs-only orphan branch). This plan is executed on a *new* build branch/worktree once approved.

---

## 1. Overview & how to use

- **Unit of work = a task** with: deliverable · module(s) it touches (ARCHITECTURE §5) · schema deps (DATA-MODEL) · prerequisites · verification command · decision refs.
- **Build philosophy** (DEVELOPMENT + superpowers): **TDD** (test first); **verify-before-done** (never claim done without the verification command passing); **atomic commits** per task; **every wave gated** by `build + test + lint + typecheck` green. No fake data (F-008).
- **Order is law.** §5 is the foundational spine; waves (§4) layer on it. Spikes (§3) gate everything. Don't build a module before its prerequisites exist.
- **Decisions are constraints, not suggestions** — each task cites the decisions it must satisfy. If a task can't satisfy a locked decision, stop and surface it (don't silently deviate — CLAUDE.md rule).

---

## 2. Prerequisites & environment

- **Runtime:** Node 22+, ESM throughout (`"type":"module"`).
- **Datastore:** SurrealDB **server binary** (D-006) — provisioned per-platform, **SHA-256-verified before spawn**, spawned on loopback, `surrealkv` backend (D-007); connect via `surrealdb` JS SDK over `ws://127.0.0.1` (no `@surrealdb/node`).
- **Local model + embeddings:** Ollama; chat = `gpt-oss:20b` (D-003, swappable slot); embeddings = **bge-m3** (default) or **qwen3-embedding:0.6b** (cannibalize-validated) — **1024-dim** either way (D-014 🟡 — pick during S0).
- **Agent runtime:** Claude Agent SDK + Claude Code CLI (D-002; SDK/CLI split fixed by S1).
- **Tooling/skills:** **context7 MCP** (live SvelteKit/Svelte5/Tailwind4/SurrealDB/Agent-SDK docs — install), superpowers (TDD/plans/debugging/review), svelte5-patterns, frontend-design, playwright, claude-api.
- **Security baseline (from day 0):** every listener binds `127.0.0.1` only with a startup assertion; hook/control/mutation endpoints require a per-boot token (D-025). Secrets in `.env` (gitignored).
- **Repo:** new build branch off `v2-main` (or a fresh repo seeded from the docs). SvelteKit 2 + Svelte 5 (runes) + Tailwind v4 + Node adapter. Port `CLAUDE.md` (lean) + seed `docs/fails.md` with F-001…F-012 on day 0.

---

## 3. De-risking spikes — DO FIRST, they gate everything (ROADMAP Phase 0)

The spikes are throwaway proofs; their job is to validate the riskiest locked assumptions before code depends on them. A failure triggers the documented fallback, not a silent workaround.

> **✅ RESULTS (2026-06-07, branch `v2`, Windows + Node 24 — see `spikes/SPIKE-RESULTS.md`):**
> - **S0 SurrealDB — 8/8 PASS.** Pinned server **2.6.5** (2.x; the official installer pulls latest = 3.x — we pin 2.x per D-009); ws+SDK 2.0.3, HNSW (no M0) + **qwen3-embedding:0.6b @ 1024-dim** (resolves D-014), semantic KNN, txn rollback, and **claim-token race = 1 winner of 8** (surrealkv isolation + D-021 queue **proven race-safe** — the DATA-MODEL §5/§8 / MEMORY-SPEC §6.6 "verify" item is closed). No fallback.
> - **S1 Claude Code runtime — PASS + finding.** Concurrency-safe (**no v1 hang**); **SDK clean headless**; CLI streams + resume work. **Finding:** the spawned CLI inherits the operator's global plugins/hooks → must run with **isolated config** (D-002 resolved: SDK primary; isolated-config CLI). Carried to task 1.4.
> Both spikes pass → cleared for the foundational scaffold + v0.1.

> **Spike naming:** PLAN `S0` / `S1` / `S2` map to the other docs as — **S1 ≡ ROADMAP/DECISIONS "S.1"** (Claude Code SDK/CLI split), **S2 ≡ "S.2"** (OpenClaw audit), and **S0 ≡ ROADMAP Phase 0.1** (SurrealDB). One spike, one spelling per doc; cited here as S0/S1/S2.

### S0 — SurrealDB on Windows + Node 22 (gates all storage)
Steps: provision + SHA-verify + spawn the server binary on loopback; connect via `surrealdb` SDK over `ws://`; apply a tiny schema; run CRUD; define an HNSW index **exactly** `DEFINE INDEX … HNSW DIMENSION 1024 DIST COSINE TYPE F32 EFC 150 M 12` (**no `M0`** — invalid in 2.x); run a `<|K,EF|>` KNN query + a `<|K,COSINE|>` brute-force query; run a `BEGIN/COMMIT/CANCEL` transaction; confirm Ollama returns **1024-dim** embeddings for the chosen model.
**Must also verify (flagged unverified):** (a) the **surrealkv transaction isolation level** (DATA-MODEL §5/§8) — does an atomic read-modify-write actually serialize? (b) the **optimistic claim-token** pattern `UPDATE … WHERE status='pending' AND claim_token IS NONE RETURN AFTER` is race-safe under concurrent claimers (MEMORY-SPEC §6.6). **This supersedes MEMORY-SPEC §6.6's "verify in S.1"** — claim-token atomicity is verified here in S0, since it depends on surrealkv isolation (a storage concern), not on the runtime split. If S0 disproves single-winner atomicity, the fallback is a transactional compare-and-set with retry, or a single-writer coordinator.
**Exit:** all green on Windows + Node 22, isolation behavior documented, embedding model + dim locked (resolves D-014). **Fallback:** if the binary path is painful → reconsider; embedded `@surrealdb/node` remains the documented fallback only.

### S1 — Claude Code runtime / D-002 mechanism (gates all agent execution)
Steps: drive a headless Claude Code run via the **Agent SDK**; drive an interactive-parity run via the **CLI** (`claude -p … --output-format stream-json`, `--resume`); validate streaming transcript events, **interject / stop / resume**, and **concurrency-safe parallel sessions** (no shared-state hang — the v1 bug). **Verify the ~26% prefix-cache cost-cut** claim against the actual Agent SDK cache-prefix contract (MEMORY-SPEC §2.3) — do not bake the in-use writer fork's affordability on an unverified figure.
**Exit:** the SDK/CLI split is recorded in D-002; the runtime contract test suite (the swappability guarantee) is drafted from what S1 proves. **Fallback:** if interject/resume is only clean via CLI, the runtime uses CLI for interactive + SDK for headless/workflows.

### S2 — OpenClaw cannibalization audit (D-012)
A non-blocking investigation spike that runs in the **v0.1 → v0.2 window** and gates nothing downstream. Audit the existing OpenClaw gateway against the v2 architecture: is any of it worth salvaging, or is it fully cannibalized by the in-process orchestrator + Claude Code runtime?
**Exit:** D-012 moves 🟡 → 🔒 (OpenClaw dropped), plus the (likely empty) salvage list of any components worth carrying forward.

> Run S0 and S1 in parallel (independent). Nothing in §4/§5 starts until both pass. S2 runs later (v0.1→v0.2 window) and gates nothing.

---

## 4. Build waves (mapped to ROADMAP releases)

Notation per task: **[module(s)]** · *(deps)* · `verify` · (decision refs). “‖” = parallelizable within the wave; “→” = sequential.

> **PLAN↔ROADMAP numbering:** PLAN task numbers are **NOT** 1:1 with ROADMAP — the plan inserts an SSE-harden task (2.1), shifting v0.2 numbering. Cite by description when in doubt.

### Phase 0 (post-spike foundations) — see §5 for the strict spine
- **0.a Repo scaffold ‖** SvelteKit 2 + Svelte 5 + Tailwind v4 + Node adapter; ESM; lint/typecheck/test wired; `CLAUDE.md` + `docs/fails.md` seeded. `verify: npm run build && npm test && npm run lint && npm run typecheck`.
- **0.b-pre SurrealDB production provisioning →** provision + **SHA-256-verify (fail hard on mismatch, SEC-009)** + spawn the SurrealDB **server binary on loopback**; lifecycle stub (3.5 hardens it). This is the production path — S0 was a throwaway spike. `verify: a tampered/mismatched binary aborts startup; a verified binary spawns and accepts a ws:// connection`. (D-006/SEC-009/F-006)
- **0.b `server/db` →** connection singleton over ws://; migration runner; the MEMORY-SPEC §6 gotchas baked in (option<T>-or-DEFAULT; idempotent migrations via `LET + IF count`; `dedup_key` VALUE backfill; **record-id/table validation guard D-016**; least-priv DB user D-026c). `verify: schema applies to a throwaway test DB (dropped namespace per run); CRUD + KNN + transaction tests pass`. (D-006)
- **0.c schema migrations →** all DATA-MODEL tables (project/release/phase/feature/sprint, task, session/message, agent_slot, routing_event, agent_event, memory + memory_history + embedding_cache, entity/references, skill/causal_chain, retrieval_outcome, work_item, service/process/incident/notification, security_finding, cc_* mirror). `verify: migration test asserts every table+index exists; HNSW indexes valid (no M0)`. (D-001/D-008/D-009/D-015)
- **0.d `events` bus + SSE ‖** `db` owns live queries → republish to `events` → single SSE fan-out; per-client subscription + backpressure (ARCHITECTURE §2.11). `verify: a DB change emits exactly one SSE event to a subscriber`.
- **0.e `config` ‖** load agent-pool.yaml, models.*, orchestration.yaml; loopback + per-boot token bootstrap (D-025). `verify: startup assertion fails if any listener is routable`.

### v0.1 — Foundations release (register a project, run one Claude Code session, persisted)
- **1.1 scanner + registry** **[scanner, db]** *(0.c)* — ecosystem/mod detection → upsert `project`. `verify: scanning a real dir under CODE_ROOT creates the expected project row`. (carry v1 scanner)
- **1.2 projects + plan CRUD ‖** **[projects]** *(0.c)* — project + release/phase/feature/sprint. `verify: plan CRUD round-trips`.
- **1.3 tasks ‖** **[tasks]** *(0.c, 0.d)* — task CRUD + status machine; live-query trigger seed. `verify: task status transition emits an event`.
- **1.4 providers + Claude Code runtime →** **[providers, runtime, claude-code]** *(S1, 0.e)* — Ollama + Claude adapters (common stream contract); the Claude Code `AgentRuntime` impl (the S1 split) as default backend; populate `agent_slot` from `config/agent-pool.yaml`. The runtime contract suite runs against a **mocked/sandboxed runtime with no filesystem-capable spawn** — so no real agent runs in 1.4 (which precedes 1.4a's deny-rules); the first real, file-capable spawn is 1.6, gated on 1.4a. `verify: runtime contract test suite passes against the Claude Code impl (mocked runtime — no live fs-capable spawn)`. **(S1-mandated) the impl spawns every Claude Code session — SDK and CLI — with an ISOLATED config** (dedicated `CLAUDE_CONFIG_DIR`/`--settings` carrying only the harness's own gates/hooks, no inherited operator plugins) so driven agents are deterministic. **SDK is primary**; CLI for interject/resume parity. Interject uses the `claude/channel` push (D-011/D-035). (D-002/D-003)
- **1.4a seed safety `permissions.deny` + explicit cwd (primary guardrail) →** **[claude-code, cc-config]** *(1.4)* — programmatically write per-project `.claude/settings.json` deny rules **before any agent can spawn**. This is the PRIMARY boundary: Claude Code's locally-enforced `permissions.deny` is **server-independent** (enforced even with the server down) and can be seeded as generated config without the full config-manager UI (2.11). Rules: **config-protection** across the whole CODE_ROOT (`.env`, secrets, other projects' `.claude/`), **dangerous-bash** (`rm -rf`, `git push`/`git remote set-url`/`--force`), and **path-confinement** (targets must resolve under the project root after symlink + `..` normalization). Set the session **`cwd` to the project root**. The PreToolUse/`canUseTool` network gates at 2.13 are the **defense-in-depth layer ON TOP of** this primary boundary. `verify: a session cannot read another project's .env, cannot git push, cannot escape cwd via ../symlink, AND an unresolvable/broken-symlink target is denied (fail-closed, not allowed) — all enforced even with the server down`. (D-024/D-018)
- **1.5 dashboard shell ‖** **[routes/dashboard]** *(0.d)* — app shell (sidebar/topbar/statusbar per UI-SPEC §3), trimmed page set rendering **live** data, one SSE stream scaffold. `verify: a page renders live DB data, no mocks (F-008); Playwright loads with waitUntil:'load' not networkidle (F-010)`.
- **1.6 manual Claude Code run →** **[claude-code, runtime, tasks, analytics]** *(1.4, 1.4a, 1.5)* — launch a session for a project+task, **stream the transcript live**, persist `session`(+cc_session_id bridge) + `message` + `agent_event`. `verify: a real session's transcript persists and renders live`. (D-011)
- **1.7 v1 data importer (start) ‖** **[scripts]** *(0.c)* — map `registry.json`→project, v1 tasks→task. `verify: importer is idempotent (re-run = no dupes, dedup_key)`.
- **1.8 config-sync (read-only) ‖** **[cc-config]** *(0.c)* — sync `.claude/` + `.mcp.json` (project + global) into the `cc_*` mirror; `/claude-code` lists hooks/skills/agents/MCP. `verify: editing a file on disk → mirror reflects it; "out-of-sync" state shown` (D-010).
- **1.9 hook transport + graceful degradation →** **[claude-code, events]** *(1.5)* — hook-proxy → loopback POST (token, short timeout) → no-op on failure; wire SessionStart/UserPromptSubmit/PostToolUse/Stop for analytics capture. **NO safety decision may be wired through this best-effort hook path** — it no-ops when the server is down (D-019), so it is analytics-only. Safety gates are `permissions.deny` (1.4a, primary) + `canUseTool`/`PreToolUse` (2.13, defense-in-depth) **only**. `verify: a Claude Code session is unaffected when the server is down` (D-019/D-024/D-025).

**v0.1 exit (PRODUCT §7):** register a real project + run one Claude Code agent end-to-end, transcript + result persisted in SurrealDB, visible live; config mirror lists a project's CC config; a session survives the server being down.

### v0.2 — Orchestration & harness
- **2.1 event bus + SSE fan-out (harden) →** *(0.d)* — production SSE; transcript events on the bus. `verify: a slow SSE client gets coalesced token_usage (latest-wins), never stalls the bus`.
- **2.2 orchestrator (event mode) →** **[orchestrator]** *(1.3,1.4,1.4a,2.1,S0)* — task-created trigger → routing → memory recall → enqueue → spawn; in-process semaphore concurrency caps (interactive) + `work_item` claim queue (background); manual mode; periodic present but off (D-004). **Ships a DEGENERATE orchestrator first** — trigger → spawn with a stub route / no recall — so this wave is buildable before routing (2.3) and memory (2.5) exist; 2.3 + 2.5 then wire in routing + recall afterward (no false deps added). Subscribes via the **`events` bus ONLY**, never its own DB live query, to avoid double-fire (ARCHITECTURE §2.11). Builds on the optimistic claim-token atomicity S0 verifies; if S0 disproves single-winner atomicity, fall back to transactional compare-and-set with retry / single-writer coordinator. No spawn before 1.4a's deny-rules.
- **2.3 routing + telemetry ‖** **[routing, analytics]** *(2.2)* — `resolveRoute` order: explicit override → intent classify → tier → adaptive config → provider/health → fallback (F-005); write `routing_event` with rationale + intent (D-020).
- **2.4 analytics + reports ‖** **[analytics, routes/reports]** *(2.3)* — `agent_event` every lifecycle step; daily rollups + anomaly flags; `/reports` + `/agents`.
- **2.5 memory service →** **[memory, providers]** *(0.c, S0)* — store (semantic/episodic/procedural) + HNSW recall; **two-tier loop** (in-use writer fork + periodic consolidator, D-027); **ADD-only extraction** + separate graph conflict pass (D-028); **raw-windowed cross-session recall** (D-029); WMR scoring; **secret/PII screen before embed** (D-026, screen_status); novelty gate + consolidation (D-031); `retrieval_outcome` recorded as ranker input only (D-030); embedding cache (L1+L2). **Fence ALL injection paths (D-026/MEMORY-SPEC §10):** every string entering model context from a memory/learning source — recall, Tier-0 directives, user-model, learned/graduated skills — is wrapped in the §10 "reference, not instructions" fence; future learned-skill injection (D-022) is gated on the same fence. `verify: recall returns ranked context; a planted secret is quarantined and never embedded/exported; every injection path (recall/Tier-0/user-model/learned-skill) emits fenced content`. **No KongCode runtime dependency** (D-023).
- **2.6 memory bridge + graph ‖** **[memory]** *(2.5)* — import Claude auto-memory `.md`; `entity`+`references` edges; knowledge-graph traversal.
- **2.7 post-task loop →** **[orchestrator]** *(2.2)* — commit via `execFile` arrays (no shell injection D-008/D-016), run project test command, optional follow-up — in transactions.
- **2.8 review agent ‖** **[orchestrator, runtime]** *(2.2)* — spawn on N+ changed files.
- **2.9 importer (finish) ‖** **[scripts]** *(1.7)* — migrate remaining v1 stores incl. `.swarm/memory.db` embeddings (re-embed if dim≠1024) + `graph-state.json` edges.
- **2.10 session control →** **[claude-code]** *(1.6)* — interject / stop / resume; fleet view (D-011; mechanism from S1).
- **2.11 config manager (read-write) →** **[cc-config]** *(1.8)* — edit hooks/skills/agents/MCP/settings.json/CLAUDE.md: validate → write file → re-sync; **diff + confirm mandatory** for CC config (D-010); watcher for external edits. `verify: launch a real Claude Code session after a dashboard config edit; assert the session's behavior reflects the edit (e.g. a newly-added permission/hook is active)` — proves PRODUCT §7 v0.2's read-back round-trip, not just the file write.
- **2.12 intent-adaptive routing ‖** **[routing, config]** *(2.3)* — intent → config bundles in orchestration.yaml (D-020).
- **2.13 gates →** **[claude-code, runtime]** *(1.9,2.10)* — the **defense-in-depth layer ON TOP of** 1.4a's primary `permissions.deny` boundary: `PreToolUse` + SDK `canUseTool` network gates; safety-critical gates **fail closed** via Claude Code `permissions.deny` (D-024); config-protection, read-before-edit, dangerous-bash, **path-confinement** (D-018). `verify: a dot-dot or symlink escape outside root_path/CODE_ROOT is denied post-normalization (symlink + ".." resolved first)`.
- **2.14 session injection + metrics rollups ‖** **[memory, analytics]** *(2.5,2.4)* — wakeup briefing (budgeted, salience-banded, rationale+citation, **fenced** D-026); anomaly flags on `/reports`. **Fence ALL injection paths (D-026/MEMORY-SPEC §10):** every string entering model context — recall, Tier-0 directives, user-model, learned/graduated skills — is wrapped in the §10 "reference, not instructions" fence; future learned-skill injection (D-022) gated on the same fence. `verify: every injected path (recall/Tier-0/user-model/learned-skill) is emitted fenced`.
- **2.15 background job queue →** **[orchestrator, db]** *(2.2,S0)* — `work_item` (atomic claim, dedup_key, priority, threshold-drain not loop, daily cap, GC, handoff) for extraction/follow-ups/maintenance; the D-017 maintenance jobs are its canonical producers. Builds on the optimistic claim-token atomicity S0 verifies; fallback if S0 disproves single-winner atomicity = transactional compare-and-set with retry / single-writer coordinator. (D-021)
- **2.16 record retrieval outcomes ‖** **[memory, analytics]** *(2.5,2.14)* — link injected/recalled citation ids → tool success/failure → `retrieval_outcome` (ranker input only, D-030; groundwork for D-022). `historical_utility` defaults to 0 until `retrieval_outcome` data exists (D-030).
- **2.17 workflow runner →** **[workflows]** *(2.2)* — headless multi-step CC pipelines (`workflow` + `workflow_run`); used by the release pipeline (3.4). `verify: a multi-step pipeline runs as a tracked workflow_run with per-step session records`. (D-013)

**v0.2 exit:** create a task → engine picks a model → drives Claude Code → commits → tests → full analytics; idle-cheap when no tasks; memory recall improves context; interject/stop/resume a live session; edit a project's CC config from the dashboard and have a real session read it.

### v0.3 — Maintain & Release
- **3.1 security scan ‖** **[services/scanner]** — `security_finding`; Maintain surface (UI-SPEC). `verify: scanning a real project produces security_finding rows rendered on the Maintain surface`. 3.2 dependency health ‖ — `verify: an outdated/vulnerable dependency is flagged with its advisory`. 3.3 UX inspector ‖ (opt-in, periodic) — `verify: an opt-in inspection run records UX findings without blocking the session`.
- **3.4 release pipeline →** **[workflows, runtime]** *(2.17)* — dry-run → test → changelog → version → tag → publish, driven as a workflow run; Release tab. `verify: a multi-step release runs as a tracked workflow_run with per-step session records (per 2.17)`.
- **3.5 services manager + incidents/notifications ‖** **[services]** — start/stop/health/auto-restart for Ollama/SurrealDB/engine (Windows-safe tasklist/taskkill, F-001/F-002); incidents/notifications surface. `verify: kill the SurrealDB process → services manager auto-restarts it + writes an incident row`.

**v0.3 exit:** take a real project through a versioned release from the dashboard.

### v1.0 — Feature-complete & hardened
- **4.1 debt-closeout audit** — confirm no shell injection, no file races (transactions), no runtime hang, no FD leaks, no tool-execution bypass, no in-place task mutation (D-008). `verify: each of the 6 D-008 debt classes has a passing regression test or audit assertion`.
- **4.2 performance pass** — measure idle CPU≈0 + idle RAM ≤ target vs a v1 baseline; tune HNSW + concurrency caps; **(optional) detect CPU/RAM at boot to set default concurrency caps**. `verify: idle CPU≈0 and idle RAM ≤ target vs a measured v1 baseline`. **4.3 page/endpoint consolidation finished** — `verify: no orphaned/duplicate routes; every page serves live data (F-008)`.
- **4.4 observability complete** (analytics answers how/why for any action) — `verify: pick any agent action and trace its full how/why chain from analytics records`. **4.5 docs updated to built reality** — `verify: docs reference only modules/tasks that exist in the built tree`. **4.6 product name (D-000)** — `verify: D-000 resolved; the chosen name appears across UI/docs/package metadata`. **4.7 security-hardening closeout** — fail-closed gates, control-plane auth, binary checksum, loopback assertions, secret/PII screen all verified against the threat model (ARCHITECTURE §7). `verify: each threat-model control has a passing test (fail-closed gate, control-plane auth, checksum, loopback assertion, secret/PII screen)`.
- **4.x cannibalization visual pass** — fill UI-SPEC §15 token values from v1's `@theme` + the seed (§15.1); run frontend-design + the impeccable a11y gate. `verify: §15 tokens filled; a11y/contrast CI gate passes on every token pair`.

**v1.0 exit:** portfolio runs on v2, benchmarked lighter than v1, all OPEN items resolved, no known critical debt.

---

## 5. Foundational layer ordering (the spine — strict)

```
S0+S1 pass
  ── Phase 0 foundations (below) ──────────────────────────
  → server/db prod provisioning (binary SHA-256-verify + spawn on loopback)
  → server/db (connection + migrations + §6 gotchas + D-016 guard + least-priv)
  → schema migrations (all DATA-MODEL tables; HNSW no-M0; dedup_key VALUE backfill)
  → events bus + SSE (db owns live queries → events → one SSE)  ‖  config (loopback + token bootstrap, D-025)
       (events [0.d] and config [0.e] both gate on db/migrations [0.c] but are mutually PARALLEL — not events→config strict)
  ── v0.1 begins: providers/runtime ──────────────────────
  → providers (ollama, claude) → runtime (Claude Code, D-002)
  → orchestrator (event triggers + work_item queue)
  → feature modules (scanner, projects, tasks, routing, memory, claude-code, cc-config, workflows, analytics, services)
  → dashboard (SvelteKit; one SSE stream; UI-SPEC screens in §12 build order)
```
Nothing above a line builds before everything below it exists and is green.

---

## 6. Cross-cutting concerns (woven through every wave)

- **Analytics-first** — every routing/agent decision writes a queryable record with rationale (PRODUCT principle).
- **Security** — D-024 gates fail closed via `permissions.deny`; D-025 control-plane auth + loopback-only + startup assertion; D-026 secret/PII screen **before embed** + fence **all** injection paths (recall/Tier-0/user-model/learned skills) + least-priv DB; D-016 record-id validation; no shell injection (execFile arrays, even with `shell:true` on Windows — validate paths).
- **Carried fails.md rules** — F-001 tasklist (not `process.kill(0)`); F-002 `shell:true` for detached spawn; F-006 verify native/provisioned binaries; F-008 no fake data; F-009 `.svelte.ts` for runes; F-010 no Playwright `networkidle` with SSE; F-011 `{@const}` placement; F-007/F-012 worktree agents MUST commit.
- **Honest states** — loading/empty/error/stale/unknown are first-class; never fabricate (UI-SPEC §8).

---

## 7. Test & verification strategy

- **TDD** — write the test first (superpowers:test-driven-development).
- **Unit (Vitest)** — each `server/` module against mocked deps; DB tests on a throwaway SurrealDB (test namespace, dropped per run).
- **Schema migration tests** — apply migrations, assert tables/indexes exist, run a KNN query + a transaction rollback + a dedup-key collision.
- **Runtime contract suite** — the shared suite every `AgentRuntime` impl must pass (keeps D-002 swappable).
- **E2E (Playwright)** — core flows (register project, create task, run agent [mocked runtime], live update); `waitUntil:'load'` (F-010).
- **A11y/contrast CI gate** — WCAG-luminance check over `@theme` token pairs; fail build on contrast misses (UI-SPEC §9); `outline:none` lint-banned.
- **Per-wave DoD** — `build + test + lint + typecheck` green + the wave's exit criteria (tied to PRODUCT §7) demonstrated on real data.

---

## 8. Parallelization & agent strategy

- **Spikes S0 ‖ S1** (independent).
- **Within a wave**, tasks marked “‖” dispatch as **parallel implementation subagents**, file-partitioned (the discipline that's worked all through planning — one owner per file, no edit conflicts). Sequential “→” tasks wait on their prereq.
- **Worktree agents MUST commit** before finishing, then merge back (F-007/F-012) — bake this into every dispatched implementation agent's prompt.
- **Foundational spine (§5) is sequential** — do not parallelize db → migrations → events → runtime.
- After each wave: a **review pass** (superpowers:requesting-code-review) before advancing.

---

## 9. Risks & open items

- **D-014 embedding model** (🟡) — resolve at S0 (bge-m3 vs qwen3-embedding:0.6b; both 1024-dim so the index is safe either way).
- **Verify-in-spike claims** — the ~26% prefix-cache cost-cut (S1); surrealkv transaction isolation + claim-token atomicity (S0). Do NOT build the in-use writer fork's economics or the queue's correctness on these until proven.
- **Native/provisioned binary on Windows** — SurrealDB binary + Ollama; checksum + smoke test first (F-006).
- **The in-use writer fork vs "lighter"** — gated cadence + prefix-cache; if S1 disproves the cache saving, fall back to end-of-session batch extraction (D-027 allows tuning the write cadence).
- **Scope creep** — anything requiring an always-on loop, a second datastore, or a bespoke gateway must justify against the "lighter" principle before going in.

---

## 10. Milestone exit gates (checklist per release)

- **Phase 0 / spikes:** S0 + S1 pass on Windows+Node22; spine (db→migrations→events→config) green; D-014 locked.
- **v0.1:** register a real project; run one Claude Code session end-to-end (transcript+result persisted, live); config mirror read-only works; session survives server-down. All green: build/test/lint/typecheck.
- **v0.2:** task → routed → CC run → commit → test → full analytics; idle-cheap; recall improves context + secret-screen verified; interject/stop/resume; config round-trip read by a real session.
- **v0.3:** real project through a versioned release from the dashboard; security/dependency/UX maintenance surfaces live.
- **v1.0:** all 6 D-008 debt classes confirmed closed; idle CPU≈0 + RAM ≤ target vs v1 baseline; observability complete; threat-model controls verified; docs match built reality. **All five remaining 🟡 closed (matching PRODUCT §7):** D-000 (product name), D-007 (surrealkv confirmed), D-012 (OpenClaw dropped — via S2), D-014 (embedding model final lock), S.1 (SDK/CLI split resolved).

---

*Derived from the v2 doc set (README, PRODUCT, ARCHITECTURE, DATA-MODEL, DEVELOPMENT, ROADMAP, DECISIONS D-000–D-033, MEMORY-SPEC, UI-SPEC, AGENTS). Every task is constrained by the cited decisions; deviations get surfaced, not silently taken.*
