# PRODUCT — ai-playground v2

## 1. One-line definition

A local-first **project lifecycle platform** *and* a **Claude Code harness**: a single dashboard + a lightweight engine that helps you **create, develop, maintain, and release** software projects of any kind — by **driving, orchestrating, and managing Claude Code** across your whole project portfolio.

## 1a. The two pillars

v2 is one product with two tightly-joined pillars:

1. **Project lifecycle platform** — register, plan, develop, maintain, and release projects with a tiered agent fleet (the original ai-playground value).
2. **Claude Code harness** — Claude Code is the engine room. The product:
   - **runs Claude Code as the execution backend** (agents = Claude Code sessions/runs);
   - is the **management/control surface** for Claude Code config across every project — hooks, skills, agents, MCP servers, `settings.json`, permissions, `CLAUDE.md` — from one UI;
   - **orchestrates the session fleet** — launch, monitor (live transcripts), interject, stop, and resume Claude Code sessions;
   - is the **Workflow runner** — scripted, headless multi-step Claude Code pipelines, not just interactive sessions. ("Workflow runner" is the one canonical term for this throughout — see job 10 and §6.1.)

The pillars reinforce each other: the lifecycle platform decides *what* work to do; the harness is *how* it gets done (and how you control it).

## 2. Why a v2

v1 works and proves the concept, but it is **heavy and complex**:

- An **idle loop** — *a mandatory always-on busy loop* (v1's 60-second heartbeat) — runs even when nothing is happening. This is the one thing v2 bans by default (opt-in periodic mode is a separate, allowed thing — see §6.2 and D-004).
- A local 20B model (`gpt-oss:20b`) consumes ~16 GB RAM/VRAM **when loaded** — but it is a swappable, load-on-demand model slot (D-003), idle-free when unused; the "lighter" win comes from dropping the idle loop + collapsing storage, not from removing the model.
- A custom OpenClaw WSS gateway with Ed25519 device identity, TLS 1.3, and DM pairing.
- ~12 separate SQLite databases plus a separate HNSW vector store plus dozens of JSON state files.
- 30 dashboard pages and 81 API endpoints.
- Documented architectural debt: file-level TOCTOU races, shell injection in git commands, a gateway client that hangs on concurrent calls, tool-execution bypass.

v2 keeps the **product value** and sheds the **weight**:

- One datastore (SurrealDB) instead of a dozen.
- Configurable orchestration — event-driven and on-demand by default, no idle loop.
- A pluggable agent runtime so we are not locked into one execution mechanism.
- Fewer, denser pages backed by a single event stream.
- The debt designed out from the start (transactions instead of file races, `execFile` instead of string-interpolated shell, a runtime that does not hang).

## 3. Who it's for

The **primary user is the project owner** running this locally on their own machine to supervise many projects at once. Not a hosted multi-tenant SaaS. Not a public service. **Single-operator** means: one machine, one concurrent operator — a solo developer (or a small team where one person drives at a time), not simultaneous multi-user access. Loopback / single-operator assumptions hold.

## 4. Core jobs the product does

1. **Discover & register projects** — scan a code root (e.g. `F:/code`), detect ecosystem (TypeScript, Python, Rust, Go, C#/.NET, Java/Kotlin, Lua; mod frameworks NeoForge / Fabric / BepInEx / Thunderstore; games Minecraft, BG3), and register each with a profile.
2. **Plan** — maintain a per-project plan: purpose, long-term vision, the owner's role, releases, phases, features, definition of done, sprints.
3. **Develop** — spawn tiered agents (cheap → powerful) to do code work, reviews, tests, and follow-ups against a specific project. *(These agents **are** Claude Code sessions — job 3 and job 8 are the same mechanism seen from two angles: what work to do vs. how it runs.)*
4. **Maintain** — keep projects healthy: dependency checks, security scans, UX inspection, memory/knowledge upkeep.
5. **Release** — run a release pipeline: dry-run, test, changelog, version bump, tag, publish.
6. **Remember** — persist project memory and a knowledge graph; recall relevant context (semantic + graph) when working.
7. **Observe** — analytics on every agent decision: routing, cost, duration, escalations, outcomes. Analytics is **first-class**, not optional.
8. **Drive Claude Code** — spawn and stream Claude Code sessions/runs as the way agents do work; interject, stop, resume; fleet view across projects. *(This is the runtime side of job 3 — the tiered agents are Claude Code sessions.)*
9. **Manage Claude Code config** — view and edit hooks, skills, agents, MCP servers, `settings.json`, permissions, and `CLAUDE.md` per-project and globally, from the dashboard. This includes the **catalog**: discovering the available agents, skills, MCP servers, and hooks (per-project + global) and surfacing them for use. *(Acceptance: the read-only config mirror of ROADMAP 1.8.)*
10. **Run workflows (Workflow runner)** — define and execute headless multi-step Claude Code pipelines with dependencies, tracked end-to-end.

## 5. Product principles

- **Local-first & single-operator.** Everything runs on the owner's machine. No assumption of a remote backend.
- **Lighter by default.** Idle should cost ~nothing — no **idle loop** (the banned always-on busy loop defined in §2). Heavy work happens only when triggered.
- **Constrained autonomy.** Autonomous agents run inside fail-closed gates and Claude Code `permissions.deny`; the control plane is loopback-only with a per-boot token, and recalled memory is treated as untrusted data, never instructions (D-024 / D-025 / D-026).
- **Analytics is first-class.** Every agent event is logged with enough context to explain *how* and *why* a decision was made. (Carried from v1 feedback.)
- **Async execution, reactive UI.** No operation blocks/hangs; every page updates in real time. (Carried from v1 feedback.)
- **No hardcoded runtime data.** UI always reflects live sources — never mock values dressed up as real. (v1 fail F-008.)
- **Memory that learns from outcomes (the intended edge).** v2 **closes the utilization loop** — it tracks whether a recalled memory or skill actually led to a good outcome and feeds that signal into **ranking** (the move hermes ignores, mem0 lacks, and kongcode underuses; D-030 — resolved: ranking-only, pruning stays time-based). It also keeps a **real knowledge graph** — true SurrealDB edges enabling traversal and skill graduation — rather than mem0's faked id-array graph. (Engine detail in [ARCHITECTURE.md §9.1](./ARCHITECTURE.md) / MEMORY-SPEC.md.)
- **One source of truth.** State lives in SurrealDB, not scattered files.
- **Pluggable, not coupled.** Model provider, local model, and agent runtime sit behind interfaces.
- **Honest reporting.** If a task failed, say so with output; never claim done without verification.

## 6. Feature scope

### 6.1 In scope for v2 (the simplified core)

**Project management**
- Project registry with ecosystem detection (the v1 scanner is good — carry it forward).
- Per-project plan (purpose, vision, role, releases, phases, features, DoD, sprints).
- Project dashboard: overview, tasks, roadmap, sessions, memory, settings.

**Agents & orchestration**
- Tiered agent pool (cheap local / Haiku / Sonnet / Opus) with escalation + delegation rules, defined in config.
- A **configurable orchestrator**: event-driven (task created, manual trigger, optional file-watch) + on-demand. Periodic mode is opt-in and off by default.
- Agent lifecycle: spawn → track → complete → commit → test → follow-up, with PID/process registry and orphan reaping.
- Code review agent triggered on N+ changed files; release agent for the ship pipeline.

**Claude Code harness**
- **Runtime:** agents execute as Claude Code sessions/runs (via Claude Agent SDK and/or CLI). Default execution backend.
- **Config manager:** read + edit Claude Code config across all projects and the global dir — `.claude/settings.json` (hooks, permissions, env, MCP servers, enabled plugins), `.claude/agents/*.md`, `.claude/skills/*/SKILL.md`, `.mcp.json`, `CLAUDE.md`. Filesystem stays authoritative; the dashboard validates before writing (D-010).
- **Session orchestration:** launch (interactive or headless), live transcript streaming, interject, stop, resume; multi-session fleet view (D-011).
- **Workflow runner:** define + run headless multi-step Claude Code pipelines with dependencies; track runs and per-step results (D-013).
- **Catalog:** part of the config manager (job 9) — discover available agents, skills, MCP servers, and hooks (per-project + global) and surface them for use; acceptance is the read-only mirror of ROADMAP 1.8.

**Memory & knowledge**
- Unified memory in SurrealDB: semantic (vector) + episodic + procedural entries.
- Knowledge graph as native SurrealDB graph edges (no separate `graph-state.json`).
- Memory bridge: import from Claude auto-memory files and (optionally) external sources.

**Routing & analytics**
- Task classification + model-tier selection behind a single routing function with explicit-override support (v1 fail F-005).
- Routing telemetry + agent analytics persisted as queryable records.

**Dashboard (SvelteKit)**
- A trimmed page set (see ARCHITECTURE §dashboard) backed by one SSE/event stream rather than many pollers.
- Multi-provider chat, services health, analytics/reports, settings.

**Services**
- Start/stop/health for the local model server and the engine, with auto-restart on failure.

### 6.2 Out of scope for v2 (YAGNI / deferred)

- **Multi-tenant / hosted / public-facing** deployment. Single operator only.
- **The full OpenClaw gateway** (WSS, Ed25519 device identity, TLS certs, DM pairing) — replaced by the Claude Code runtime (D-002). Default assumption: dropped entirely; salvage only on concrete need (D-012).
- **Reimplementing tool sandboxing / hooks** — Claude Code owns tool execution, hooks, and MCP; the harness *configures* them, it does not rebuild them.
- **Twitch / external channels** — drop unless explicitly wanted later.
- **"Create with AI" generative project setup** — deferred to a release *after* v2 **v1.0** (it was also a future feature in **v1**, the predecessor product). Intentionally unscoped until promoted into a milestone. *(Note: "v1" = the predecessor product; "v1.0" = a v2 release.)*
- Speculative analytics dashboards beyond the core set.
- Any feature that requires the **idle loop** (the mandatory always-on busy loop banned in §2) to keep running. **Carve-out:** an *opt-in periodic mode* (D-004) is allowed — it is off by default and is user-enabled, so it is not the banned idle loop.

### 6.3 Explicitly carried forward from v1

- The **project scanner** (ecosystem/mod detection) — it's accurate and valuable.
- The **Project Plan v3** data shape (macro / releases / phases / features / DoD / sprints).
- The **tiered agent pool** concept and escalation/delegation rules.
- Every prevention rule in v1 `docs/fails.md` (Windows portability, Svelte 5 rune file extensions, SSE vs Playwright `networkidle`, `{@const}` placement, etc.).
- The **feature-flag** mechanism for gating pages.

## 7. Releases & success criteria

Release detail lives in [ROADMAP.md](./ROADMAP.md); the product-level bar:

- **v0.1 — Foundations.** SurrealDB datastore stands up; project registry + scanner work; dashboard shell renders live data; one **Claude Code** session can be launched manually against a project, its live transcript streamed, and its result recorded; the config mirror lists a project's Claude Code config (read-only); the hook transport degrades gracefully. *Success: register a real project and run one Claude Code agent end-to-end with the transcript + result persisted in SurrealDB; the config mirror lists a project's Claude Code config, and a Claude Code session is unaffected when the server is down (harness-pillar acceptance).*
- **v0.2 — Orchestration & harness.** Event-driven engine spawns Claude Code agents on task creation; routing + analytics persisted; memory (vector + graph) queryable; review/test/commit loop works; session control (interject/stop/resume) and the Claude Code config manager (view/edit hooks, skills, agents, MCP) work. *Success: create a task, watch the engine pick a model, drive Claude Code to do the work, commit, and log full analytics — with the app idle-cheap when no tasks exist — and edit a project's Claude Code config from the dashboard. **Harness-pillar acceptance:** a round-trip test proves a config edit made in the dashboard is READ by an actual Claude Code session (not just written to a file).*
- **v0.3 — Maintain & Release.** Security scan, dependency health, UX inspection, and the release pipeline operate per project. *Success: take a project through a real versioned release from the dashboard. **Harness-pillar acceptance:** the release is driven by a headless Claude Code workflow run, tracked end-to-end.*
- **v1.0 — Feature-complete & hardened.** Claude Code runtime mechanism (D-002 spike S.1: SDK/CLI split) finalized & implemented; OpenClaw drop confirmed (D-012 / S.2); all v1 debt designed out; analytics/observability complete; docs current. The genuinely-open gating items at this bar are: **S.1** (SDK/CLI split), **D-012** (OpenClaw drop), **D-000** (product name), **D-007** (surrealkv vs RocksDB), **D-014** (embedding model/dimension) — all closed. *Success: v2 runs the owner's real project portfolio at lighter idle load than v1 (per ROADMAP 4.1/4.2 metrics), with no known critical debt. **Harness-pillar acceptance:** the full Claude Code control surface — runtime, config manager, session fleet, workflow runner — drives the real portfolio.*

## 8. Non-goals reminder

If a proposed feature requires an **idle loop** (the mandatory always-on busy loop banned in §2 — distinct from the opt-in periodic mode of §6.2 / D-004), a second database, or a bespoke network gateway, it must justify itself against the "lighter" principle before it goes in.
