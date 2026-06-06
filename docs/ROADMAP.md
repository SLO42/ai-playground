# ROADMAP — ai-playground v2

Phased build plan. Each phase ends with a concrete, verifiable bar. Releases map to PRODUCT §7. Spikes resolve OPEN decisions (DECISIONS.md). Build later, phase by phase, assisted by skills.

Sequencing principle: **datastore and seams first** (so nothing couples to a store or a runtime), then the engine, then maintain/release, then harden and resolve the runtime.

---

## Phase 0 — Foundations & de-risking  *(precedes v0.1)*

Goal: prove the risky technical assumptions before building on them.

- **0.1 SurrealDB server-binary spike (D-006).** Provision + spawn the SurrealDB **server binary** on Windows + Node 22 (loopback, `surrealkv://`); connect via `surrealdb` SDK over `ws://`; CRUD, HNSW `DEFINE INDEX` + KNN query, transaction `BEGIN/COMMIT/CANCEL`. Confirm Ollama `bge-m3` returns 1024-dim embeddings. **Exit:** documented pass (embedded `surrealdb` JS SDK only — no native addon; embedded mode is a fallback only); confirm `surrealkv` is viable for our access patterns and record the trigger that would force a RocksDB fallback (D-007).
- **0.2 Repo scaffold.** SvelteKit 2 + Svelte 5 + Tailwind v4 + Node adapter, ESM, Node 22. Lint/typecheck/test wired.
- **0.3 `server/db` module.** Connection singleton, migration runner, typed query helpers. Apply the DATA-MODEL schema to a `mem://` test DB in CI. Schema uses SurrealDB 2.x syntax; note the 3.x rename to carry forward (D-009). Add a record-id / table-name validation guard in the query helpers so untrusted identifiers can't reach the DB layer (D-016).
- **0.4 Governance port.** `CLAUDE.md` (lean) + seed `docs/fails.md` with all carried rules (DEVELOPMENT §5).
- **0.5 `AgentRuntime` interface + Claude Code smoke test.** Interface from ARCHITECTURE §2.3 plus the shared runtime contract test suite. Smoke-test the **Claude Code** path on Windows + Node 22: a headless run via the Agent SDK and/or `claude -p … --output-format stream-json`; confirm streamed transcript events parse. (Feeds S.1.)
- **0.6 Baseline security hardening (D-025, D-006).** Bind the control plane loopback-only (`HOST=127.0.0.1`; Ollama/SurrealDB/embeddings on loopback) with a **startup assertion** that refuses to boot on a non-loopback bind. Verify the provisioned SurrealDB server binary against its **pinned checksum** before first execution. (Auth + the rest of the threat-model work lands in v0.2 — see 2.13a.)

**Phase exit:** `npm run build`, `npm test`, `npm run db:migrate` all green on Windows; SurrealDB verified; interfaces in place; loopback-only startup assertion + binary checksum verify proven.

---

## v0.1 — Foundations release

Goal: register real projects and run one agent manually end-to-end, fully persisted.

- **1.1 Scanner + registry.** Port v1 ecosystem/mod detection; upsert `project` records. Round-robin over a configured `CODE_ROOT`.
- **1.2 Project + plan CRUD.** `project`, `release`, `phase`, `feature`, `sprint`. Project Plan v3 shape.
- **1.3 Tasks.** `task` CRUD + status machine.
- **1.4 Provider adapters + Claude Code runtime.** Ollama (`gpt-oss:20b`) + Claude adapters (common `stream` contract); the **Claude Code `AgentRuntime` impl** (SDK/CLI) as the default execution backend. Populate `agent_slot` records by syncing from `config/agent-pool.yaml`.
- **1.5 Dashboard shell.** Layout, sidebar, the trimmed page set rendering **live** data (no mocks — F-008). One SSE stream scaffold (carries CC transcript events).
- **1.6 Manual Claude Code run.** Pick a project + task, choose a model, launch a Claude Code session, **stream its transcript live**, persist `session` (+ `cc_session_id`) + `message` + `agent_event`.
- **1.7 v1 data importer (start).** Script mapping the highest-value v1 stores (`registry.json` → `project`, `tasks` → `task`).
- **1.8 Config-sync (read-only).** Sync service populates the `cc_*` mirror from `.claude/` + `.mcp.json` across the code root + global; `/claude-code` page lists hooks/skills/agents/MCP per project.
- **1.9 Hook transport + graceful degradation (D-019).** Hook-proxy script → loopback POST to the SvelteKit server, short timeouts, no-op on failure. Wire SessionStart/UserPromptSubmit/PostToolUse/Stop for analytics capture. Prove a Claude Code session is unaffected when the server is down.

**Release exit (PRODUCT v0.1):** register a real project, run one agent end-to-end, result persisted in SurrealDB, visible live in the dashboard.

---

## Spike — Claude Code runtime mechanism (D-002 chosen; pick the SDK/CLI split) + OpenClaw audit  *(early in v0.1→v0.2)*

Goal: Claude Code is already the runtime (D-002 🔒). Nail down *how*, and confirm OpenClaw can be dropped.

- **S.1 SDK vs CLI split.** Against the runtime contract suite, validate on Windows + Node 22: **Claude Agent SDK** for programmatic/headless execution + workflows; **CLI subprocess** (`claude -p`, `--resume`) where interactive parity (interject/resume) is cleaner. Confirm streaming transcript events, interject, stop, resume, concurrency-safe parallel sessions (no v1 hang). Record the chosen split in D-002.
- **S.2 OpenClaw cannibalization audit (D-012).** Confirm Claude Code + provider adapters cover what OpenClaw did. Default: drop OpenClaw entirely. Salvage a part only on concrete need; record the (likely empty) salvage list, set D-012 → 🔒.

**Spike exit:** Claude Code runtime in production behind the interface, contract tests green, concurrency-safe; OpenClaw drop confirmed.

---

## v0.2 — Orchestration release

Goal: the configurable, event-driven engine with first-class analytics and unified memory.

- **2.1 Event bus + SSE fan-out.** Internal events + SurrealDB live queries → one client stream.
- **2.2 Orchestrator (event mode).** Task-created trigger → routing → memory recall → enqueue → runtime spawn, with concurrency caps via async queue. `manual` mode too. `periodic` mode present but **off by default** (D-004).
- **2.3 Routing + telemetry.** `resolveRoute` with explicit-override-first (F-005), classification, tiering (escalate Haiku→Sonnet→Opus; delegate down). Write `routing_event` with rationale.
- **2.4 Analytics.** `agent_event` for every lifecycle step; `/reports` + `/agents` pages query it. Cost/duration/escalation views.
- **2.5 Memory service.** `memory` table + HNSW index; hybrid recall (vector + graph + FTS) → `ContextBundle`. `entity` + `references` graph edges. Memory bridge import from Claude auto-memory. Keep the service self-contained behind its interface — no KongCode runtime calls (D-023).
- **2.6 Post-task loop.** Commit (via `execFile` arrays — no injection), run project test command, optional follow-up task creation — all in transactions.
- **2.7 Review agent.** Spawn on N+ changed files.
- **2.8 Importer (finish).** Migrate remaining v1 stores incl. `.swarm/memory.db` embeddings + `graph-state.json` edges.
- **2.9 Session control.** Interject / stop / resume on running Claude Code sessions; fleet view (D-011).
- **2.10 Config manager (read-write).** Edit hooks, skills, agents, MCP servers, `settings.json`, `CLAUDE.md` from `/claude-code`: validate → write file → re-sync mirror; watcher for external edits (D-010).
- **2.11 Workflow runner.** Define + execute headless multi-step Claude Code pipelines; `workflow` + `workflow_run`; live progress (D-013).
- **2.12 Intent-adaptive routing (D-020).** Extend `resolveRoute` with intent classification → per-intent config bundles (thinking/tool budget/retrieval depth) in `config/orchestration.yaml`; record intent in routing telemetry.
- **2.13 Gates (D-018, D-024).** Agent guardrails on `PreToolUse`: config-protection, read-before-edit, dangerous-bash; per-project, soft-warn/hard-block. **Safety-critical gates wire through Claude Code `permissions.deny` and fail CLOSED** (a gate error or unreachable server denies the action, never allows it) (D-024). Add a **path-confinement gate** so agent file/exec access stays inside the registered project + code root.
- **2.13a Control-plane hardening (D-025, D-026).** Require a **per-boot control-plane token** for the loopback API/SSE (alongside the loopback-only bind + startup assertion from 0.6) (D-025). **Screen for secrets/PII before any memory store**, and treat all recalled memory as **untrusted data, not instructions** (no command execution from memory content); least-privilege DB credentials for the memory path (D-026).
- **2.14 Session injection + metrics rollups.** Wakeup briefing at session start (budgeted, salience-banded, with rationale/citation); per-turn metrics → daily rollups + anomaly flags on `/reports`.
- **2.15 Background job queue (D-021).** `work_item` queue (atomic claim, UNIQUE dedup, priority, threshold-drain, daily cap, GC, handoff record) for post-task extraction/follow-ups/maintenance off the interactive path. The D-017 maintenance jobs are the canonical `work_item` producers.
- **2.16 Record retrieval outcomes (D-022 groundwork).** Link each injected/recalled memory citation id to the success/failure of the subsequent tool calls in that turn → write `retrieval_outcome` rows. This is the data feed for the WMR `historical_utility` signal, which **defaults to 0 until this exists**, and the groundwork for the deferred learned-reranking epic (D-022).

**Release exit (PRODUCT v0.2):** create a task → engine picks a model → drives Claude Code → commits → tests → logs full analytics; **idle-cheap** when no tasks exist; memory recall improves context; interject/stop/resume a live session and edit a project's Claude Code config from the dashboard.

---

## v0.3 — Maintain & Release release

Goal: keep projects healthy and ship them.

- **3.1 Security scan.** Per-project scanner → `security_finding`; `/security`-equivalent view.
- **3.2 Dependency health.** Outdated/vulnerable deps surfaced as tasks/findings.
- **3.3 UX inspector.** Periodic (opt-in) UX scan → reports.
- **3.4 Release pipeline.** Release agent: dry-run → test → changelog → version bump → tag → publish, driven from the project Release tab.
- **3.5 Services manager.** Start/stop/health/auto-restart for Ollama + engine, Windows-safe. Surface incidents + notifications (service crash, auto-restart, gate denial, anomaly) as queryable records shown in the dashboard.

**Release exit (PRODUCT v0.3):** take a real project through a versioned release from the dashboard.

---

## v1.0 — Feature-complete & hardened

Goal: run the owner's real portfolio at materially lower load than v1, no known critical debt.

- **4.1 Debt audit (D-008 closeout).** Confirm: no shell injection, no file races (transactions everywhere multi-write), no runtime hang, no FD leaks, no tool-execution bypass, no in-place task mutation.
- **4.2 Performance pass.** Measure idle CPU/RAM against a recorded v1 baseline; confirm the "lighter" win. **Pass/fail target:** idle CPU ≈ 0% (no busy loop) and idle RAM materially below the measured v1 idle baseline (target ≤ 50% of v1 idle RAM, model slot unloaded). Tune HNSW params + concurrency caps.
- **4.3 Page/endpoint consolidation finished.** Hit the ~8 global + 7 project-tab target; one SSE stream; pollers gone.
- **4.4 Observability complete.** Analytics covers every decision; reports answer "how/why" for any agent action.
- **4.5 Docs current.** PRODUCT/ARCHITECTURE/DATA-MODEL/DEVELOPMENT updated to match built reality; `docs/fails.md` reflects anything learned.
- **4.6 Name decision (D-000).**
- **4.7 Security hardening confirmed (threat model closeout).** Verify all hardening landed and holds: loopback-only bind + startup assertion + per-boot control-plane token (D-025); gates fail CLOSED via `permissions.deny` + path-confinement (D-024); binary checksum verification (D-006); secret/PII screen before memory store + untrusted-memory-as-data + least-privilege DB creds (D-026). Tie each item back to the threat model.

**Release exit (PRODUCT v1.0):** portfolio runs on v2; benchmarked lighter; all OPEN decisions resolved.

---

## Deferred (post-v1.0)

- **Self-improvement loop (D-022)** — the north-star epic, built on v0.2's outcome/analytics groundwork:
  - **Outcome-labeled learned reranking** ("ACAN"): track which recalled memories were cited / led to tool success → train a reranker. Needs `retrieval_outcome` data first.
  - **Cross-encoder reranker + salience banding** (KongCode uses bge-reranker-v2-m3) — recall quality boost; lazy-loaded, optional.
  - **Procedure/"skill" synthesis**: distill repeated successful task sequences into reusable procedures (with a graduation watermark for idempotency); **reflections** on recurring failures.
  - **Per-project "profile/soul"**: learned conventions/preferences per project, injected into agent runs (maps to v1's project-manager memory + ubiquitous language).
  - **Proactive memory resurfacing** (Fibonacci-interval "due" memories surfaced into context).
- "Create with AI" generative project setup.
- External channels (Twitch, etc.).
- Templates / apps catalog pages.
- SurrealKV versioning/time-travel evaluation (D-007).
- Multi-machine / remote (explicitly out of scope for now).

---

## Open spikes & decisions tracker

| Item | Where | Resolves |
|------|-------|----------|
| SurrealDB on Windows | Phase 0.1 | D-006 |
| Embedding model + dimension | Phase 0 / v0.2 | DATA-MODEL §7 |
| Claude Code SDK/CLI split | Spike S.1 | D-002 (mechanism) |
| OpenClaw cannibalization audit | Spike S.2 | D-012 |
| Product name | v1.0 (4.6) | D-000 |
| RocksDB vs SurrealKV | as needed | D-007 |

---

## Dependency order (quick view)

```
Phase 0 (DB+seams)
   │ 0.5 (runtime iface + CC smoke)
   ▼
  S.1 (SDK/CLI split) ──┬──▶ v0.1 (register+run)         consumes S.1 at 1.4 / 1.6
                        └──▶ v0.2 (engine+memory+analytics) consumes S.1 at 2.9 / 2.11

Phase 0 ─▶ v0.1 ─▶ v0.2 ─▶ v0.3 (maintain+release) ─▶ v1.0 (harden)

  S.2 (OpenClaw drop audit, D-012): runs in the v0.1→v0.2 window; gates nothing downstream.
```
