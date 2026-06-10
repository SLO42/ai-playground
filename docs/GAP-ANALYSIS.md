# GAP-ANALYSIS — v1 → v2 parity · design-spec · wiring audit + plan

**Date:** 2026-06-08 · **Branch:** `v2-main` (docs) · **Code under audit:** `F:\code\ai-playground-v2\src` (branch `v2`)
**Inputs:** v1 UI surface inventory · v1 systems inventory · v2 UI-vs-spec per-route diff · v2 server+wiring audit · parity-advocate + lighter-advocate deliberation.

> **DELIVERY STATUS (2026-06-10): waves v1.3–v1.8 + the v1.9 hardening pass are EXECUTED on branch `v2`** (through `ecc9c4d`, plus the 14.1 typography wave). The matrices below are the **2026-06-08 audit snapshot** — MISSING/BUILT-UNWIRED/BUILT-SHELL rows describe audit-time state, and most now describe built, wired features (orchestrator/routing/memory wired at v1.4; PM system `5be3f2e`; `/settings` `f844e37`; RightTray/shell `e069c2d`; `/agents` catalog `c78d6ca`; UX-inspector loop `7569137`; gates wired into both spawn paths `0450691`; GitHub sync `883c660`; D-037 adapters `cb8484b`…`858e6f7`). Read §4 for the per-wave closing notes.

This document answers three questions, honestly:
1. **What exists, in what state** — a feature/page/system × design-element matrix with a per-item recommendation.
2. **Why the gap exists** — one honest paragraph.
3. **What to do** — sequenced remediation waves (v1.3+), with intentional drops separated from oversights.

---

## 0. The headline (read this first)

v2's central problem is **not** that it is missing v1 features. It is that **the better, lighter systems v2 already built are not wired into the running app.** The event orchestrator, real routing (`resolveRoute`), per-task capability provisioning (`composeCapabilities`, D-036/TASK 5.1), and the entire memory recall/extract/briefing/consolidation loop are all built and test-proven but reachable from **zero** production code paths. On top of that, the always-visible shell (Statusbar/Topbar) renders hardcoded placeholders, one route (`/claude-code`) has a live nav-click defect, and the highest-value strategic surface (the Project Manager system) was never rebuilt. The fastest path to a product the operator recognizes is **wire-then-surface**, not **port**.

**Status legend**
| Status | Meaning |
|--------|---------|
| **BUILT-FUNCTIONAL** | Built and wired into the live runtime/request path; works. |
| **BUILT-SHELL** | UI/route exists but is thin, hardcoded, or missing most spec regions. |
| **BUILT-UNWIRED** | Module compiles and is unit/proof-tested, but has **no live caller**. |
| **PLANNED-ONLY** | In a spec/roadmap, no code yet. |
| **MISSING** | Not present and (for v1 items) not yet planned in v2. |

**Recommendation legend:** **KEEP/BUILD** (build the missing surface) · **WIRE** (connect built-but-dead code) · **FIX** (defect repair) · **DEFER** (real value, later wave) · **DROP** (intentional non-port; cite deliberation).

---

## 1. MATRIX — v1 systems × status × recommendation

### 1.1 The Project Manager system (operator-flagged #1 gap)

| Element | v1 source | v2 status | Rec | Why |
|---|---|---|---|---|
| Per-project PM agent | `project-manager.ts` `bootstrapProjectManager()` | **MISSING** | KEEP/BUILD | The strategic layer above task execution; defines the product's "maintain" identity. Rebuild lean on SurrealDB — do **not** import v1's plan-migration baggage. |
| PM typed memory (observation/learning/risk/pattern/decision-context, FTS, confidence, uncapped) | `pm-memory-db.ts` (SQLite) | **MISSING** | KEEP/BUILD | The accumulated-learning store. Rebuild on the SurrealDB `memory` spine (lighter principle: no per-feature SQLite). |
| Macro plan (purpose/vision/role/releases/phases/DoD) | `types/project-plan.ts` v3 | **BUILT-FUNCTIONAL (data) / BUILT-SHELL (UI)** | KEEP/BUILD | Data model exists (`projects/repo.ts`); v2 Plan tab renders it. Missing the *behavior* (bootstrap, refine). |
| Sprints + architectural decisions | plan v3 + `create-sprint`/`complete-sprint` | **BUILT-SHELL** | KEEP/BUILD | Read-only flat lists today; needs create/complete + decisions surface. |
| PM chat (talk-to-PM) | `pm` action `chat` | **MISSING** | KEEP/BUILD | Interactive strategy refinement; the richest v1 page. |
| Bootstrap / periodic review | `bootstrapProjectManager`, `reviewProjectPlan` | **MISSING** | DEFER → KEEP/BUILD | Review machinery is v0.2+ layer per lighter advocate; bootstrap is the entry point and should land with the PM tab. |
| GitHub board sync | `syncToGitHubBoard` | **MISSING** | DEFER | Real value, niche; lands after PM core. |

**Net:** v2 has the plan **data model** but none of the PM **behavior**. Highest-value rebuild. Lighter advocate's caution accepted: rebuild lean, no v1 SQLite/migration import.

### 1.2 Heartbeat / orchestration engine

| Element | v1 source | v2 status | Rec | Why |
|---|---|---|---|---|
| 60s idle heartbeat loop | `heartbeat/index.ts` | **DROP (correctly killed)** | DROP | Lighter advocate: the banned idle loop must not return. v2's event-driven design supersedes it. Protect this. |
| Event-driven orchestrator | `orchestrator/orchestrator.ts` (v2) | **BUILT-UNWIRED** | WIRE | `new Orchestrator()` in zero non-test files; `hooks.server.ts` never calls `.start()`. The autonomy promise is inert (DEFECT 3). |
| Work queue / semaphore / concurrency cap | `orchestrator/{workqueue,semaphore}.ts` | **BUILT-UNWIRED** | WIRE | Reachable only via the unwired orchestrator. |
| Routing (intent→model, escalate/delegate) | `routing/resolve.ts` (v2) | **BUILT-UNWIRED** | WIRE | Live launch uses hardcoded `DEFAULT_MODEL='claude-opus-4-8'`. The entire cost-optimization story is fiction until wired (DEFECT 3). |
| Routing telemetry (`routing_event` + rationale) | `analytics/trace.ts`, `routing` | **BUILT-UNWIRED** | WIRE | Depends on routing being live. |
| Post-task commit / post-test | `orchestrator/{post-task,review}.ts` | **BUILT-UNWIRED** | WIRE | Reachable only via orchestrator. |
| On-demand spawn (per-task, no idle pool) | `sessions/launch.ts` | **BUILT-FUNCTIONAL** | KEEP | The single live spawn path works (manual). |
| Capability provisioning per task (D-036/5.1) | `runtime/capabilities.ts` | **BUILT-UNWIRED (dead branch)** | FIX | `wiring.getRuntime()` passes no `catalog`/`gates`/`hooks` → `composeCapabilities` never runs (DEFECT 1). Owner-requested; cheap fix in `wiring.ts`. |

### 1.3 Memory + vector store + graph

| Element | v1 source | v2 status | Rec | Why |
|---|---|---|---|---|
| MemoryService facade (store/recall/extract/briefing) | `memory/index.ts` (v2) | **BUILT-UNWIRED** | WIRE | Instantiated in zero non-test files. The platform's claimed intelligence is inert. |
| Recall on spawn (staged retrieval, WMR, novelty gate) | `memory/recall.ts` | **BUILT-UNWIRED** | WIRE | Live spawn does **no** recall. |
| Extract on session-end | `memory/store.ts` | **BUILT-UNWIRED** | WIRE | Session-end writes a completion event, never extracts. |
| Wake-up briefing | `memory/briefing.ts` | **BUILT-UNWIRED** | WIRE | The thing that proves the agent *remembered* (spec §193/§314); unreachable. |
| Two-tier consolidation / embeddings / secret-screen / fence | `memory/{loop,embed,screen,fence}.ts` | **BUILT-UNWIRED** | WIRE | Reachable only via the unwired MemoryService. |
| Read-side display (list memories, list graph) | `memory/explorer.ts` | **BUILT-FUNCTIONAL** | KEEP | The only live-wired memory module; read-only display. |
| v1 3-source memory-bridge (`.swarm/memory.db` vector store + Claude md + project map) | `memory-bridge.ts` | **DROP** | DROP | Lighter advocate: v2's design is cleaner; do not drag in the v1 bridge or per-feature SQLite. |

### 1.4 Hooks → analytics

| Element | v1 source | v2 status | Rec | Why |
|---|---|---|---|---|
| Hook ingest endpoint (`/api/hooks/[event]`, D-024/025) | `hooks/ingest.ts` | **BUILT-FUNCTIONAL** | KEEP | Wired + authorized. |
| Hook-proxy (CC lifecycle → loopback POST) | `hooks/proxy.ts` | **BUILT-CONDITIONAL** | WIRE (via credential) | Only fires under a real credentialed spawn (`CLAUDE_CODE_OAUTH_TOKEN`). No token → no real session → no hook→agent_event traffic. |
| Direct spawn/completion/error agent_event | `sessions/launch.ts` | **BUILT-FUNCTIONAL** | KEEP | Analytics-on-spawn works for the live launch path. |

### 1.5 OpenClaw gateway + channels

| Element | v1 source | v2 status | Rec | Why |
|---|---|---|---|---|
| OpenClaw WS gateway (Ed25519) | `gateway-client.ts`, `providers/openclaw.ts` | **MISSING** | **DROP** | Lighter advocate #2: heaviest v1 surface; v2's direct-subprocess `ClaudeCliBackend` supersedes it. D-012 audit confirms drop. |
| `/channels` page (TLS/rate-limit/DM-pairing/allowlist) | `channels/` | **MISSING** | **DROP** | Gateway config surface; hobbyist, not core to create/develop/maintain/release. |
| Multi-platform channel scaffolds (Telegram/Discord/WhatsApp/Twitch/iMessage) | `channel-templates.ts` | **MISSING** | **DROP/DEFER** | Drop for now; "external channels" is a roadmap *Deferred* item if a real need appears. |
| Local-first $0 routing | gateway routing | **MISSING** | KEEP (relocate) | If local-cost routing matters it belongs in `routing/resolve.ts`, not a separate daemon. |

### 1.6 Services / daemon manager

| Element | v1 source | v2 status | Rec | Why |
|---|---|---|---|---|
| Service-health manager / proc control / incidents | `services/{manager,proc,incidents}.ts` (v2) | **BUILT-PARTIAL (tooling-wired)** | WIRE/BUILD | Underpins `db:up`; surfaces on Statusbar. No request-loop wiring. |
| `/services` page (start/stop/restart/logs) | `services/`, `services/[id]/logs/stream` | **MISSING** (deliberately deferred in `nav.ts`) | KEEP/BUILD | Real v1 parity; operator-visible control. Deferred, not dropped. |

### 1.7 Analytics + how/why event logging

| Element | v1 source | v2 status | Rec | Why |
|---|---|---|---|---|
| Shared agent_event chokepoint | `analytics/events.ts` | **BUILT-FUNCTIONAL** | KEEP | Wired on spawn/completion. |
| Fleet read-model | `analytics/fleet.ts` | **BUILT-FUNCTIONAL** | KEEP | Wired into project loader. |
| Rollups (/reports, /agents tickers) | `analytics/rollup.ts` | **BUILT-FUNCTIONAL** | KEEP | Wired. |
| Per-task routing→spawn trace | `analytics/trace.ts` | **BUILT-UNWIRED** | WIRE | Depends on routing; surfaces RoutingRationale. |
| v1 50+ typed event taxonomy + hardcoded mock metrics | `agent-analytics.ts` | **PARTIAL / DROP mocks** | KEEP live · DROP mocks | Lighter advocate #5/#6: never port v1's fabricated numbers (99 agents, migration %); wire live `+page.server.ts` sources only. |

### 1.8 Project generation, templates, importer

| Element | v1 source | v2 status | Rec | Why |
|---|---|---|---|---|
| Project scanner / ecosystem + mod detection | `scanner/detect.ts` (v2) | **BUILT-FUNCTIONAL** | KEEP | Wired in `/projects` action. |
| Dependency / security / UX scan | `scanner/{dependencies,security,ux-inspect}.ts` | **BUILT-FUNCTIONAL (read)** | KEEP/SURFACE | `listAllFindings` wired into `/reports`; needs per-project Maintain panel surface. |
| UX-inspector loop (Playwright auto-test gen, 12h cooldown) | `ux-inspector.ts` | **BUILT-SHELL (module only)** | DEFER | Lighter advocate #11: clever but heavy; not v0.1-critical. |
| v1 data importer | `importer/v1.ts` | **BUILT-FUNCTIONAL (tooling)** | KEEP | `db:import` script. |
| Deep import wizard UI (grouped config detection, commands, workflows, deps) | `projects/import/` | **BUILT-SHELL** | DEFER | v2 register form scans path; the rich 3-step wizard is depth, not v0.1-critical. |
| "Create with AI" generative scaffold | `project-generator.ts` | **MISSING** | DEFER | Roadmap *Deferred* item explicitly. |
| Templates / apps catalog pages | `templates/`, `apps/` | **MISSING** | DEFER/DROP | Roadmap *Deferred*; fold any tool listing into `/claude-code` (lighter advocate #4). |

### 1.9 GitHub, release, CI/CD/quality

| Element | v1 source | v2 status | Rec | Why |
|---|---|---|---|---|
| Release pipeline (dry-run→test→changelog→version→tag→publish) | `release/pipeline.ts` (v2) | **BUILT-FUNCTIONAL** | KEEP | Wired into `/release` action (live spawn gated on credential). |
| Changelog content render | spec §196 | **BUILT-SHELL** | KEEP/BUILD | Only a stage dot; the generated changelog isn't rendered. |
| Multi-platform publishers (npm/CurseForge/Nexus/Thunderstore) | `publishers/*` | **MISSING** | DEFER | Lighter advocate #10: GitHub-only for now; per-project niche maintenance surface. |
| GitHub task↔issue sync | `github-sync.ts` | **MISSING** | DEFER | Real value; lands with PM/GitHub board sync. |
| CI / coverage / incidents / dependency-health | `ci-pipeline.ts`, `coverage-tracker.ts`, `incidents.ts`, `dependency-health.ts` | **PARTIAL** (scanner findings wired; incidents/coverage not surfaced) | DEFER/SURFACE | Maintain rollup omits dep-health + UX (§207); incidents history absent (§208). |

### 1.10 Reports & scoring

| Element | v1 source | v2 status | Rec | Why |
|---|---|---|---|---|
| KPI row + daily rollup + anomaly flags + per-tier usage + maintain (security) | v2 `/reports` | **BUILT-FUNCTIONAL** | KEEP | Covers the load-bearing parts. |
| Routing-decision analytics / RoutingRationale aggregate | spec §206 | **MISSING** | KEEP/BUILD | The operator's stated core requirement ("how/why every decision"); depends on routing being wired. |
| Filters (project/time/model) | spec §206 | **MISSING** | KEEP/BUILD | None today. |
| Maintain rollup incl. dep-health + UX | spec §207 | **BUILT-SHELL** | KEEP/BUILD | Security only today. |
| Incidents/notifications history (right-tray "see all" target) | spec §208 | **MISSING** | KEEP/BUILD | No incidents surface anywhere (right-tray also absent). |
| Composite scores (System Health/Business Value/Overall 0-100), GPU kWh/watt, 10-subsystem System Events | `scoring-engine.ts`, reports.ts | **MISSING** | DEFER/DROP | Lighter advocate #12: composite vanity scores + RTX-3090 watt estimates are decorative. Defer scoring; routing analytics first. |
| `/demo` "How Claw Works" pipeline page | `demo/` | **MISSING** | **DROP** | Lighter advocate #3: marketing duplication; real `/workflows`+`/agents`+`/reports` show the actual lifecycle. |

### 1.11 Settings, model routing, config

| Element | v1 source | v2 status | Rec | Why |
|---|---|---|---|---|
| `/settings` page (general/routing/model-slots/orchestration-mode/memory/API-keys/gate-defaults/feature-flags) | `settings/` | **MISSING** | KEEP/BUILD | Most urgent missing route: orchestration mode is shown static and **cannot be changed from the UI**; no routing/API-key surface. |
| Heartbeat phase toggles + intervals | `settings/heartbeat` | **DROP** | DROP | Tied to the killed idle loop; orchestration mode replaces it. |

### 1.12 Notifications / event bus / inbox / chat / sessions

| Element | v1 source | v2 status | Rec | Why |
|---|---|---|---|---|
| In-process event bus + SSE fan-out | `events/{bus,sse,db-source}.ts` (v2) | **BUILT-FUNCTIONAL** | KEEP | One bus, one stream, live-query owner. Lighter principle held. |
| Notifications store + categories | `notifications.ts` | **MISSING (UI)** | KEEP/BUILD | Surfaces via RightTray (below). |
| `/inbox` awaiting-input approve/reject | `inbox/` | **MISSING** | DEFER | Folds into RightTray + session control. |
| `/chat` multi-provider chat | `chat/`, `session-manager.ts`, `chat-tools.ts` | **MISSING** | DEFER | v0.2 spec item; conversational control. |
| Sessions transcript + interject/stop/resume | `sessions/launch.ts`, `channel.ts` (v2) | **BUILT-FUNCTIONAL** | KEEP | Control seam wired (`/api/sessions/[id]/control`). |
| Per-project duplicate page mirrors (Chat/Tasks/Models/Agents/etc.) | `projects/[id]/*` (v1, ~30 pages) | **DROP duplication** | DROP | Lighter advocate #7: build each surface once, scope by context (10 global + 7 project tabs). |

### 1.13 Supporting infra / drop-on-sight

| Element | v1 source | v2 status | Rec | Why |
|---|---|---|---|---|
| Per-feature SQLite sprawl (pm-memory/spawn-stats/incidents/pid-registry/analytics/.swarm) | v1 | **DROP** | DROP | Lighter advocate #6 (principles): rebuild lean on the SurrealDB spine; no SQLite-per-feature import. |
| AgentDB patch scripts / graph-loading monkeypatches | `scripts/patch-*.{sh,js}` | **DROP** | DROP | Lighter advocate #8: v1 plumbing workarounds (+MINGW symlink pain); don't apply on SurrealDB. |
| pid-registry orphan reaping | `pid-registry.ts` | **DROP/rebuild** | DROP | Tied to idle-loop child tracking; v2's single subprocess path is simpler. |

---

## 2. MATRIX — design-spec UI elements × per-screen status

### Shell (app-wide)

| Spec element (§3/§5) | v2 status | Rec | Why |
|---|---|---|---|
| Statusbar live (services/agents/tok/cost/mode) | **BUILT-SHELL (hardcoded)** | FIX/WIRE | Rendered with **no props** → permanent `services unknown · agents — · tok — · $— · mode manual`. Data already flows (`rollup.ts`, SSE). The product *lies* on every screen. |
| Topbar live-status pill (mode + running-agent count) | **BUILT-SHELL** | FIX/WIRE | Mode pill static; no agent count; only `connection` wired. |
| CommandPalette (Cmd/Ctrl-K, §1.6 backbone) | **MISSING** | KEEP/BUILD | Core keyboard principle; absent (word "palette" only in a code comment). |
| RightTray (notifications + activity + unread + "see all") | **MISSING** | KEEP/BUILD | The **only** planned notification/incidents surface — without it there is no notification surface at all. |
| Toast | **MISSING** | KEEP/BUILD | No transient feedback component. |
| GateBanner / ConfirmDialog (tool-call gate, §7.228) | **MISSING (UI)** | KEEP/BUILD | Gate logic exists server-side (`gates.ts`); never surfaced → gates pause invisibly. |
| Project context switcher + tab swap | **MISSING** | KEEP/BUILD | Sidebar doesn't swap to project tabs in a project. |
| Collapsible desktop sidebar | **BUILT-SHELL** | DEFER | Only mobile drawer; spec wants collapsible. Low priority. |
| Motion (§7 row-enter / live-dot pulse / fleet grid) | **PLANNED-ONLY** | DEFER | Keyframes in tokens; pages static. Polish. |

### `/` Home

| Spec region (§6, §181–184) | v2 status | Rec |
|---|---|---|
| MetricCards: active projects · running agents · today's cost · services up | **BUILT-SHELL (1 of 4)** | KEEP/BUILD |
| Recent-activity column (sessions/tasks) | **MISSING** | KEEP/BUILD |
| Portfolio task summary | **MISSING** | KEEP/BUILD |
| Live AgentFleetGrid | **MISSING** | KEEP/BUILD |
| "Start a manual run" action | **MISSING** | KEEP/BUILD |

> Home is the thinnest page vs spec (~1 of 7 regions). Likely the operator's single biggest "missing information" complaint. Backing data is already wired for other pages — mostly assembly.

### `/projects` list

| Spec (§188) | v2 status | Rec |
|---|---|---|
| Register/scan + cards (name/status/ecosystem/purpose) | **BUILT-FUNCTIONAL** | KEEP |
| Search/filter control | **MISSING** | KEEP/BUILD |
| Open-task count per card | **MISSING** | KEEP/BUILD |
| Last-activity timestamp per card | **MISSING** | KEEP/BUILD |

### `/projects/[id]` workspace (spec: 7 tabs)

| Spec tab (§51, §189–196) | v2 status | Rec |
|---|---|---|
| Overview + **Maintain panel** (findings/dep-health/UX) | **BUILT-SHELL (folded into Plan, no Maintain)** | KEEP/BUILD |
| **Tasks board** (by status, create/edit, routing rationale, linked sessions) | **MISSING (flat read-only list)** | KEEP/BUILD |
| Roadmap (releases→phases→features→sprints **hierarchy**) | **BUILT-SHELL (4 flat lists)** | KEEP/BUILD |
| Sessions (transcript + control) | **BUILT-FUNCTIONAL** | KEEP |
| Sessions injected-context / wakeup-briefing panel (§193/§314/§318) | **MISSING** | KEEP/BUILD (after memory wired) |
| Release (inline pipeline) | **BUILT-FUNCTIONAL** (links out) | KEEP |
| **Memory** tab (project MemorySearch + graph) | **MISSING** | KEEP/BUILD |
| **Settings** tab (config/routing override/test cmd/gate config) | **MISSING** | KEEP/BUILD |
| Tool-call GateBanner/ConfirmDialog in transcript | **MISSING** | KEEP/BUILD |

> 4 of 7 tabs missing as distinct surfaces. The workspace is where the operator lives; a read-only task list is a regression from v1.

### `/agents`

| Spec (§198–200) | v2 status | Rec |
|---|---|---|
| Pool tier definitions + per-tier usage | **BUILT-FUNCTIONAL** | KEEP |
| Live fleet (running/done/failed) | **BUILT-SHELL (plain list)** | KEEP/BUILD (AgentFleetGrid) |
| Agent catalog (available agents) | **MISSING** | KEEP/BUILD |

### `/claude-code`

| Spec (§212–216) | v2 status | Rec |
|---|---|---|
| Config catalog (hooks/skills/agents/MCP, synced badges) | **BUILT-FUNCTIONAL** | KEEP |
| ConfigEditor (D-010 diff+confirm) | **BUILT-FUNCTIONAL (exceeds spec)** | KEEP |
| **Cross-project Session FLEET** (live control hub) | **MISSING** | KEEP/BUILD |
| Config round-trip "loaded config @ <time>" evidence | **MISSING** | KEEP/BUILD |
| **Nav-click defect** (strict `getDb()`, unguarded `readCatalog`/`syncState`, `invalidate(()=>true)` storm) | **DEFECT (live)** | FIX |

> **`/claude-code` nav defect (DEFECT 2):** the only loader using strict `getDb()` with unguarded `readCatalog`/`syncState`. On a dropped socket the SDK returns a non-null-but-dead handle → throws an unhandled 500 on hard load, and on client-nav the click "does nothing." Fix = `tryGetDb()` + `classifyDbError` (parity with commit `8ed7659`), and narrow `invalidate(() => true)` to a scoped dep so a `project` row change doesn't re-pull the whole catalog.

### `/memory`

| Spec (§204) | v2 status | Rec |
|---|---|---|
| Recall list + citation id | **BUILT-FUNCTIONAL** | KEEP |
| Semantic/**ranked** recall + retrieval **rationale** | **MISSING (client substring filter only)** | KEEP/BUILD (after memory loop wired) |
| KnowledgeGraph **visual** node/edge | **BUILT-SHELL (flat list)** | DEFER (graph-viz lib deferred) |

### `/reports`

| Spec (§206–208) | v2 status | Rec |
|---|---|---|
| KPI / daily rollup / anomaly / per-tier | **BUILT-FUNCTIONAL** | KEEP |
| Routing-decision analytics / RoutingRationale | **MISSING** | KEEP/BUILD |
| Filters (project/time/model) | **MISSING** | KEEP/BUILD |
| Maintain rollup + dep-health + UX | **BUILT-SHELL (security only)** | KEEP/BUILD |
| Incidents/notifications history | **MISSING** | KEEP/BUILD |

### `/workflows`

| Spec (§218) | v2 status | Rec |
|---|---|---|
| Definitions list + run + run history + detail | **BUILT-FUNCTIONAL** | KEEP |
| **WorkflowBuilder** (define steps/deps/parallel) | **MISSING** | DEFER |
| Step→session transcript link | **MISSING** | KEEP/BUILD (small) |

### Entirely-missing spec routes

| Route | v2 status | Rec |
|---|---|---|
| `/settings` | **MISSING** | KEEP/BUILD (urgent — orchestration mode uncontrollable) |
| `/services` | **MISSING (deferred in nav.ts)** | KEEP/BUILD (parity) |
| `/chat` | **MISSING** | DEFER (v0.2) |

### Cross-cutting components (spec §5 not realized)
CommandPalette · RightTray · GateBanner · ConfirmDialog · Toast · AgentFleetGrid (animated) · MetricCard (Home uses ad-hoc divs) · RoutingRationale · Motion — all **MISSING** as realized UI. See Wave plan §4.

---

## 3. WHY THE GAP EXISTS (the honest paragraph)

v2 was built **vision-forward and "lighter," with no v1 parity inventory as a gate.** The roadmap sequences "datastore and seams first, then the engine," and each wave was executed via per-task TDD — which proved each *module* correct in isolation (the orchestrator, `resolveRoute`, `composeCapabilities`, the entire MemoryService loop all have green unit/proof tests) but **never required a live end-to-end wiring acceptance** that a real boot/request path actually calls them. The result is a codebase where the hard parts are *built and proven* yet reachable from zero production callers, while the UI was scaffolded honest-but-thin (real "—" placeholders instead of v1's mocks — correct in spirit, but the Statusbar/Topbar props were never connected, so the honest placeholders became permanent). Because there was no parity checklist, high-value v1 systems with no direct v2 spec line — most notably the **Project Manager** strategic layer — were simply never scheduled. The gap is therefore three distinct shapes: **(a) wiring debt** (built, tested, unwired), **(b) defect debt** (Statusbar hardcoded, `/claude-code` crash), and **(c) un-scheduled parity** (PM system, `/settings`, `/services`, Maintain panel) — not, for the most part, missing capability.

---

## 4. PLAN — sequenced remediation waves

These are **gap-remediation waves layered on the current v2 build** (the roadmap's own release line is v0.x; these v1.3+ waves are the post-audit close-out track). Priority order: **stop lying → restore identity → connect the dead backend → restore expected UX → restore information depth.** Intentional drops are listed separately in §5 so they remain decisions, not oversights.

### Wave v1.3 — Stop lying + fix live defects (days, mostly wiring/bugfix) — ✅ EXECUTED
**Why:** The app currently misrepresents its own state on every screen and has one route that silently fails on navigation. Lowest effort, highest perceived-quality delta. No new systems.
- **FIX** Statusbar: pass live props from `analytics/rollup.ts` + SSE (services/agents/tok/cost/mode). Topbar: wire mode pill + running-agent count.
- **FIX** `/claude-code` nav defect (DEFECT 2): switch loader to `tryGetDb()`, wrap `readCatalog`/`syncState` in `classifyDbError`; narrow `invalidate(() => true)` to a scoped dependency.
- **FIX** Capability provisioning (DEFECT 1): `wiring.getRuntime()` must resolve and pass `catalog`/`gates`/`hooks` so `composeCapabilities` (D-036/5.1) runs live; populate `req.capabilities` in `launch.ts`.

### Wave v1.4 — Connect the dead backend (wire-only; the biggest ROI) — ✅ EXECUTED
**Why:** The orchestrator, routing, and memory loop are built and test-proven but inert. Wiring them restores v2's actual differentiators without building new systems.
- **WIRE** Orchestrator (DEFECT 3): `hooks.server.ts` starts `new Orchestrator().start()` on the `task`-row event; keep it strictly event-sourced off `watchTable` (no idle-loop resurrection).
- **WIRE** Routing: orchestrator calls `resolveRoute` (explicit-override-first); replace hardcoded `DEFAULT_MODEL`/`DEFAULT_AGENT`; write `routing_event` with rationale; wire `analytics/trace.ts`.
- **WIRE** Memory loop: `launchSession` calls `recall` on spawn (inject context) and `extractAndStore` on session-end; surface the wake-up briefing in the transcript (§193). Instantiate `MemoryService` at boot.
- **WIRE** Hook→analytics end-to-end once a credential is present (proves hook-proxy → `agent_event`).
- **Acceptance:** create a task → engine routes → recalls memory → spawns → commits → tests → logs full analytics, idle-cheap when no tasks.

### Wave v1.5 — Restore product identity (PM + Home + cross-project fleet) — ✅ EXECUTED (PM `5be3f2e`; GitHub task↔issue sync pulled into this wave per D-037, `883c660`)
**Why:** Without these v2 is a task runner, not a project lifecycle platform; Home is near-empty; there's no portfolio-wide "what's running now."
- **BUILD** PM system (lean, on SurrealDB spine): PM tab — bootstrap, talk-to-PM chat, typed PM memory (observation/learning/risk/pattern/decision), sprint create/complete, decisions surface. Defer periodic-review + GitHub board sync to v1.7.
- **BUILD** Home: 4 MetricCards (active projects/running agents/today's cost/services up), recent-activity column, portfolio task summary, live AgentFleetGrid, "start a manual run."
- **BUILD** `/claude-code` cross-project Session Fleet (live control hub; reuse wired `channel.ts` control seam + `messages.ts` transcript) + config round-trip evidence.

### Wave v1.6 — Restore expected UX shell + missing control routes — ✅ EXECUTED (`/settings` `f844e37`; RightTray/shell `e069c2d`; gates surfaced + wired `0450691`)
**Why:** v1 had CommandPalette, Toast, live notifications; their absence makes v2 feel like a prototype. And orchestration mode currently cannot be changed from the UI.
- **BUILD** CommandPalette (Cmd/Ctrl-K), RightTray (notifications + activity + unread + "see all"), Toast, GateBanner/ConfirmDialog (surface server-side `gates.ts`).
- **BUILD** `/settings` (general/routing/model-slots/orchestration-mode/memory/API-keys/gate-defaults/feature-flags) — unblocks UI control of orchestration mode + routing.
- **BUILD** Project workspace tabs: Tasks board (status columns, create/edit, routing rationale, linked sessions), Memory tab, Settings tab, Overview Maintain panel (security + dep-health + UX). Make Roadmap hierarchical.
- **BUILD** `/services` page (start/stop/restart/logs) — wire `services/manager.ts`+`proc.ts` into the request loop.

### Wave v1.7 — Information depth + completeness — ✅ EXECUTED (`/agents` catalog `c78d6ca`; UX-inspector loop `7569137`; PM review + board sync per m0025)
**Why:** Depth on pages that already work; the operator's "how/why every decision" requirement (routing analytics) tops this wave.
- **BUILD** `/reports`: routing-decision analytics + RoutingRationale aggregate; filters (project/time/model); Maintain rollup dep-health+UX; incidents/notifications history (RightTray "see all" target).
- **BUILD** Changelog content render on `/release`; `/agents` catalog; AgentFleetGrid animation + §7 motion; step→session links on `/workflows`.
- **BUILD** PM periodic review + GitHub project-board sync. *(GitHub task↔issue sync was re-homed to **v1.5** by D-037 and shipped there, `883c660`.)*
- **WIRE/BUILD** UX-inspector loop into the maintain cycle.
- Visual KnowledgeGraph (graph-viz lib, deferred); `/chat`; WorkflowBuilder. *(D-037 amendments: multi-platform **publishers** moved from §5 Deferred to a committed **v1.8** wave — delivered; **"Create with AI"** struck from this wave — scoped OUT of the gap-closure track entirely by the operator (commit `644da5f`), its own future feature.)*

### Wave v1.8 — D-037 extensible deploy/publish/sync adapter framework — ✅ EXECUTED (`cb8484b`, `1aea383`, `308e7a1`, `858e6f7`)
Added post-audit by D-037 (supersedes the audit's "publishers = DEFER" rows): typed adapter contract + registry/catalog, built-in **Thunderstore / npm / GitHub-releases** adapters, per-project custom targets (`project_target`/`target_run`, m0026), gated driver with config-bound confirm tokens, release pipeline driving the chosen adapter.

### Wave v1.9 — Hardening / confirmed-findings fixes — ✅ EXECUTED (`67af096`, `ecc9c4d`)
Closeout fixes: catalog-anchored config-edit scope, realpath confinement, bounded DB connect (F-014), SIGTERM teardown + tree-kill, strict lastRun attribution, honest-failure contract checks.

---

## 5. INTENTIONAL DROPS (decisions, not oversights)

| Dropped | Rationale (deliberation) |
|---|---|
| **v1 60s idle heartbeat loop** | Lighter advocate #1: the banned idle loop; v2's event orchestrator supersedes it. Protect this. |
| **OpenClaw gateway + `/channels` + multi-platform channel scaffolds** | Lighter advocate #2 + S.2/D-012 audit: heaviest v1 surface; direct-subprocess `ClaudeCliBackend` supersedes; local-cost routing relocates to `resolve.ts`. |
| **`/demo` "How Claw Works" page** | Lighter advocate #3: marketing duplication of real `/workflows`+`/agents`+`/reports`. |
| **`/about` + `/apps` as top-level pages** | Lighter advocate #4: static stack info + MCP catalog already in `/claude-code`. |
| **All v1 hardcoded mock metrics** (99 agents, V3-migration %, routing-intelligence stats, Learning Intelligence widgets) | Lighter advocate #5/#6: porting mocks is negative work; wire live sources only. Honest "—" is the standard. |
| **Duplicate per-project page mirrors** (~30-page v1 tree) | Lighter advocate #7: build each surface once, scope by context (10 global + 7 project tabs). |
| **AgentDB patch scripts / graph-loading monkeypatches / pid-registry reaping** | Lighter advocate #8: v1 plumbing workarounds; don't apply on the SurrealDB spine. |
| **Per-feature SQLite sprawl** (pm-memory/spawn-stats/incidents/analytics/.swarm DBs) + v1 3-source memory-bridge | Lighter advocate principles 4/6: rebuild lean on SurrealDB; do not re-import old weight. |
| **Heartbeat phase toggles/intervals in settings** | Tied to the killed idle loop; orchestration-mode setting replaces it. |
| **Reports composite vanity scores + GPU watt/kWh estimates** | Lighter advocate #12: decorative; defer/drop in favor of routing analytics. |

**Deferred (real value, scheduled later — not dropped), as amended by D-037 and delivery:** ~~PM periodic-review + GitHub board sync (v1.7)~~ **delivered v1.7** · ~~multi-platform publishers~~ **promoted to the committed v1.8 wave by D-037 and delivered** (Thunderstore/npm/GitHub-releases adapters) · ~~GitHub task↔issue sync~~ **re-homed to v1.5 by D-037 and delivered** · ~~UX-inspector loop~~ **delivered v1.7** · `/chat` · WorkflowBuilder · visual KnowledgeGraph · **"Create with AI" — scoped OUT of the gap-closure track entirely (operator, `644da5f`); its own future feature, not a deferred wave item** · templates/apps catalog · deep import wizard · composite scoring.

---

## 6. The one-line verdict
**v2's backend is ~80% built but unwired; the highest-leverage work is FIX + WIRE (waves v1.3–v1.4), not port.** The only true rebuilds are the **Project Manager** strategic layer and the **shell UX** (CommandPalette/RightTray/Settings) + the missing **project workspace tabs**. Everything heavy from v1 (gateway, idle loop, mock metrics, SQLite sprawl, per-project page duplication) is **intentionally dropped**.
