# v1.0 Release Plan

> Created: 2026-03-17
> Goal: Feature-complete across all lifecycle phases, all ecosystems, stable, tested.
> v1.0 means: every feature works, every page is real, every project type is supported.

---

## Current Reality

**What's solid (production-ready):**
- 16/21 global pages are real with live data
- Chat system: all 3 providers working (Claude, Ollama, OpenClaw) + tool execution
- Task CRUD: full lifecycle, dependencies, blocking, GitHub sync (bidirectional)
- Project CRUD: create, delete, settings persist, registry works
- Agent pool: spawn, analytics, tier routing, review agent
- Heartbeat: full automation loop with post-commit testing
- Release: manager + agent + UI (needs real-world validation)
- Services: start/stop/health checks, auto-restart with cooldowns
- Settings: general, model routing, memory, notifications all persist
- Security: local scanning, secret redaction
- Reports: generation + time-series charts
- CI/CD: lint → test (85% cov) → build → Docker/GHCR

**What's incomplete:**
- 8/13 project sub-routes are stubs
- Heartbeat settings don't persist (memory-only)
- Desktop notifications not wired (in-app only)
- Memory entry CRUD partial (only DELETE)
- Agent spawning wastes resources (idle pool vs on-demand)
- 8 critical backend audit issues unresolved
- `ruflo.ts` still Svelte 4
- No game/mod templates
- No multi-platform release targets
- No build detection for non-Node ecosystems
- No monorepo awareness
- No environment management
- No CI/CD pipeline visibility
- No incident management
- No coverage trend tracking
- No multi-workspace support
- 9 global settings API endpoints — not all verified end-to-end

---

## Task List

### Track A: Backend Stability (critical path)

| # | Task | Effort | Files |
|---|------|--------|-------|
| A1 | **Fix file concurrency races (TOCTOU)** — Add AsyncMutex to task-store, notifications, session-pool, pid-registry, agent-analytics. All read-modify-write ops need locking. | Large | `task-store.ts`, `notifications.ts`, `session-pool.ts`, `pid-registry.ts`, `agent-analytics.ts`, `async-mutex.ts` |
| A2 | **Fix shell injection in git/gh commands** — Escape user-controlled strings (task titles, filenames, branch names). Use array-form spawn where possible. | Medium | `post-task.ts`, `github-sync.ts` |
| A3 | **Fix gateway client concurrent chat() hang** — Single WS handler can't serve two concurrent calls. Queue or multiplex. | Medium | `gateway-client.ts` |
| A4 | **Fix tool execution bypass** — Tools requiring confirmation must wait for approval before executing. | Medium | `session-manager.ts` |
| A5 | **Fix file descriptor leak in spawn()** — Close stdio streams on agent completion. | Small | `agent-spawn.ts` |
| A6 | **Fix task description mutation** — Clone task objects before modifying for prompts. | Small | `heartbeat/index.ts` |
| A7 | **Fix dropped discussion replies** — Queue replies when agent pool full instead of discarding. | Medium | `discussion.ts` |
| A8 | **Fix dropped tool messages in OpenClaw** — Include tool role messages in prompt construction. | Small | `providers/openclaw.ts` |

### Track B: Project Sub-Routes (biggest UI gap)

| # | Task | Effort | Pattern |
|---|------|--------|---------|
| B1 | **Project About page** — Project identity, tech stack detection, timeline, resources. | Medium | Read-only display of detected project info |
| B2 | **Project Services page** — Project-scoped service cards. Start/stop per project. | Medium | Mirror global `/services` scoped to project |
| B3 | **Project Memory page** — Scope graph + entries to project via `metadata.sourceFile`. | Medium | Global `/memory` already works — filter it |
| B4 | **Project Security page** — Project-scoped audit findings, dependency vulnerabilities. | Medium | Run language-specific audit per project |
| B5 | **Project Hooks page** — Hooks configured for this project. | Small | Filter existing hook data by project |
| B6 | **Project Channels page** — Which channels can interact with this project. | Small | Filter channel configs |
| B7 | **Project Models page** — Model routing overrides per project. | Small | Project-level routing config |
| B8 | **Project Pipelines page** — CI/CD pipeline status from GitHub Actions. | Medium | `gh run list` per project repo |
| B9 | **Project Sessions page** — Session history scoped to project. | Small | Filter existing session data |

### Track C: Heartbeat & Agent Architecture

| # | Task | Effort | Files |
|---|------|--------|-------|
| C1 | **Heartbeat settings persistence** — Save state to `.playground/heartbeat-config.json`. Restore on startup. | Small | `heartbeat/index.ts`, settings API |
| C2 | **Granular heartbeat phase toggles** — Separate toggles for: health checks, task scanning, agent spawning, review cycle, memory sync. | Medium | `heartbeat/index.ts`, `shared.ts`, settings API + UI |
| C3 | **Configurable heartbeat interval** — Per-phase intervals (health 30s, scan 120s, etc.). | Small | `heartbeat/shared.ts`, settings API |
| C4 | **On-demand agent spawning** — Remove idle pool pre-population. Spawn per task with task-specific context only. | Large | `session-pool.ts`, `agent-spawn.ts`, `shared.ts` |
| C5 | **Agent context specialization** — Context loaders per project type (C# mod vs TypeScript web vs Java/Gradle). | Medium | New `heartbeat/context-loader.ts` |

### Track D: Settings Completeness

9 global settings endpoints exist. Every one must be verified save+load+UI wired.

| # | Task | Effort | Files |
|---|------|--------|-------|
| D1 | **Audit global settings: general** — Verify GET/PUT persists all fields. Ensure UI save button works. | Small | `api/settings/general/`, settings page |
| D2 | **Audit global settings: model-routing** — Verify strategy, thresholds, fallback chain all persist. | Small | `api/settings/model-routing/` |
| D3 | **Audit global settings: agent-defaults** — Verify agent defaults save and are used by spawn logic. | Small | `api/settings/agent-defaults/` |
| D4 | **Audit global settings: memory** — Verify memory config persists (HNSW params, sync interval, graph toggle). | Small | `api/settings/memory/` |
| D5 | **Audit global settings: notifications** — Verify quiet hours, desktop toggle, sound toggle persist. | Small | `api/settings/notifications/` |
| D6 | **Audit global settings: autoscale** — Verify autoscale rules save and are read by heartbeat. | Small | `api/settings/autoscale/` |
| D7 | **Audit global settings: api-keys** — Document that this is read-only by design (security). Show key status, not values. | Small | `api/settings/api-keys/` |
| D8 | **Audit global settings: shutdown** — Verify graceful shutdown signal works (stops heartbeat, drains agents). | Small | `api/settings/shutdown/` |
| D9 | **Heartbeat settings UI** — Add phase toggles, interval config, and status display to settings page. | Medium | Settings page |
| D10 | **Project settings completeness** — Verify project settings page saves: name, description, branch, topology, maxAgents, consensus, build/test commands, auto-start services. | Medium | `routes/projects/[id]/settings/`, project settings API |
| D11 | **Feature flag documentation** — Document all 10 `FF_*` flags in `.env.example` with descriptions and defaults. | Small | `.env.example` |

### Track E: Notifications & UX Polish

| # | Task | Effort | Files |
|---|------|--------|-------|
| E1 | **Desktop notifications** — Wire browser Notification API (permission request + push). Settings UI already exists. | Medium | `notifications.ts`, layout |
| E2 | **Memory entry CRUD** — Implement GET and POST for `/api/memory/entries`. | Small | `api/memory/entries/+server.ts` |
| E3 | **Service log streaming** — Verify SSE log streaming works. Wire to services page. | Small | `api/services/[id]/logs/stream/` |
| E4 | **Loading skeletons** — Add skeleton states for all pages that load server data. | Medium | All `+page.svelte` files |
| E5 | **Keyboard shortcuts** — Cmd+K command palette, common navigation shortcuts. | Small | Layout, CommandPalette |
| E6 | **Responsive breakpoints** — Test and fix at 1440 → 1024 → mobile. | Medium | Component CSS |

### Track F: Code Quality & Migration

| # | Task | Effort | Files |
|---|------|--------|-------|
| F1 | **Migrate `ruflo.ts` to Svelte 5** — Replace `writable`/`derived` with `$state`/`$derived`. | Small | `stores/ruflo.ts` |
| F2 | **Error boundaries on all routes** — Add `+error.svelte` where missing. | Small | Routes without error pages |
| F3 | **Path traversal hardening** — Audit all file path construction. Normalize + validate. | Medium | `task-store.ts`, `file-reader.ts`, path-accepting endpoints |
| F4 | **Test coverage for heartbeat modules** — Unit tests for core heartbeat logic. | Large | `heartbeat/*.test.ts` |
| F5 | **Integration test for release pipeline** — E2E: create project → task → release. | Medium | New test file |

### Track G: Multi-Ecosystem Support

This is what makes the platform work for all project types — not just Node.js.

| # | Task | Effort | Files |
|---|------|--------|-------|
| G1 | **Template parameter system** — Templates accept config options ("include CI?", "modloader version?", "include Docker?"). Each template is already a function returning `Record<string, string>` — extend with params. | Medium | Template system |
| G2 | **BepInEx/Unity mod template** — C# project, .csproj, Thunderstore manifest.json, plugin boilerplate. For SWIP-type mods. | Medium | New template function |
| G3 | **Fabric Minecraft mod template** — Java/Kotlin, Gradle, fabric.mod.json, mixin setup. | Medium | New template function |
| G4 | **Forge Minecraft mod template** — Java/Kotlin, Gradle, mods.toml. | Medium | New template function |
| G5 | **Paper/Spigot plugin template** — Java/Kotlin, Gradle/Maven, plugin.yml. | Medium | New template function |
| G6 | **BG3 mod template** — Lua/XML, mod structure, meta.lsx. | Medium | New template function |
| G7 | **Build system auto-detection** — Extend project scanner to detect: MSBuild/.csproj, Gradle, Maven, Cargo, Go modules, Poetry/pyproject.toml. Map to build/test/release commands. | Large | `project-scanner.ts`, `workspace-detector.ts` |
| G8 | **Multi-platform release targets** — Pluggable release publishers: Thunderstore, CurseForge/Modrinth, Nexus Mods, npm, PyPI, crates.io. Each: auth config, metadata mapping, upload API. | Large | `release-manager.ts`, new `publishers/` directory |
| G9 | **Rust template** — Cargo project, lib/bin, CI, crates.io metadata. | Small | New template function |
| G10 | **Go template** — Go module, cmd/pkg structure, Makefile. | Small | New template function |

### Track H: Platform Features

| # | Task | Effort | Files |
|---|------|--------|-------|
| H1 | **Monorepo/workspace awareness** — Detect yarn/pnpm/npm workspaces, Gradle multi-project, Cargo workspaces. Show inter-package dependency graph. Coordinated task scheduling. | Large | `project-scanner.ts`, new workspace UI |
| H2 | **Environment management** — Define environments per project (dev/staging/prod). Environment-specific config and secrets. Deployment tracking per environment. | Large | New `environments/` module, project settings, new UI |
| H3 | **CI/CD pipeline visibility** — Read GitHub Actions workflow runs. Show pipeline status in project dashboard. Trigger workflows from UI. | Medium | `github-sync.ts`, project pipelines page (B8) |
| H4 | **Incident management** — Auto-detect CI failures, service crashes, test regressions. Create incident tasks with context. Track MTTR. | Medium | New `incidents.ts` module, notifications integration |
| H5 | **Test coverage trend tracking** — Parse coverage reports (lcov, cobertura, JaCoCo) after test runs. Store trends per project. Alert on drops. | Medium | New `coverage-tracker.ts`, project dashboard widget |
| H6 | **Multi-workspace support** — Replace hardcoded `F:\code` with configurable workspace paths. Support multiple base directories. `path.join()` everywhere. | Medium | `constants.ts`, `project-scanner.ts`, settings UI |

### Track I: Release Validation

| # | Task | Effort | Files |
|---|------|--------|-------|
| I1 | **Test release pipeline on SWIP** — Real-world: changelog, semver, git tag, GitHub release, Thunderstore publish. | Medium | Manual testing |
| I2 | **Test all chat providers end-to-end** — Claude, Ollama, OpenClaw individually + fallback chain. | Small | Manual testing |
| I3 | **Test GitHub sync end-to-end** — Push tasks, pull issues, verify bidirectional. | Small | Manual testing |
| I4 | **Test project create → task → agent → commit** — Full lifecycle with heartbeat. | Medium | Manual testing |
| I5 | **Test each template** — Create a project from every template, verify it builds/runs. | Medium | Manual testing |
| I6 | **Test each release publisher** — Thunderstore, CurseForge, Nexus, npm dry-run. | Medium | Manual testing |
| I7 | **Performance profiling** — Memory leaks, slow endpoints, idle resource usage. | Medium | Profiling |
| I8 | **Test monorepo detection** — Import a real monorepo, verify workspace detection + package graph. | Small | Manual testing |

---

## Execution Plan

### Wave 1: Stability (weeks 1-2)

**Goal**: Fix critical bugs, make heartbeat controllable for safe testing.

```
Track A (A1-A8):  Backend audit fixes              ← critical path
Track C (C1-C3):  Heartbeat persistence + toggles  ← enables safe testing
Track F (F1):     Svelte 4→5 migration             ← quick win
Track D (D11):    Document feature flags            ← quick win
```

**Exit criteria**: Backend won't corrupt data or allow injection. Heartbeat phases individually toggleable.

### Wave 2: Complete Core UI (weeks 3-5)

**Goal**: All pages functional, all settings wired, no stubs.

```
Track B (B1-B9):  Project sub-routes               ← biggest UI gap
Track D (D1-D10): Settings audit + wiring          ← ensures all config works
Track E (E1-E3):  Notifications, memory CRUD       ← functional gaps
Track F (F2-F3):  Error boundaries, path hardening ← safety net
```

**Exit criteria**: Every page in the sidebar works with real data. Every setting saves, loads, and survives restart.

### Wave 3: Agent Architecture + Templates (weeks 6-8)

**Goal**: Smart agents, multi-ecosystem templates, build detection.

```
Track C (C4-C5):  On-demand spawning + context specialization
Track G (G1-G7):  Template system + game/mod templates + build detection
Track G (G9-G10): Rust/Go templates
Track E (E4-E6):  Loading skeletons, shortcuts, responsive
```

**Exit criteria**: Agents spawn on-demand with project-specific context. Can create projects for any supported ecosystem.

### Wave 4: Platform Features (weeks 9-11)

**Goal**: Multi-platform releases, monorepo support, environments, CI/CD visibility.

```
Track G (G8):     Multi-platform release publishers
Track H (H1-H6): Monorepo, environments, CI/CD, incidents, coverage, workspaces
Track F (F4-F5):  Test coverage for heartbeat + release pipeline
```

**Exit criteria**: Can release to Thunderstore/CurseForge/Nexus. Monorepo projects detected. Environments configurable. CI/CD visible.

### Wave 5: Validate & Ship (weeks 12-13)

**Goal**: Real-world testing across all project types, fix gaps, tag v1.0.

```
Track I (I1-I8):  End-to-end validation on real projects
Fix issues found during validation
Final documentation pass
Tag v1.0
```

**Exit criteria**: All definition-of-done items checked off.

---

## v1.0 Definition of Done

### Core
- [ ] All 21 global routes render real data (no stubs)
- [ ] All 13 project sub-routes render real data (no stubs)
- [ ] 0 critical backend audit issues
- [ ] Build passes clean (`npm run build`)
- [ ] 85%+ test coverage maintained

### Agent System
- [ ] Heartbeat individually toggleable per phase
- [ ] Heartbeat settings persist across restarts
- [ ] Agents spawn on-demand with task-specific context, not idle
- [ ] Agent context specialized per project type (C#, Java, TypeScript, etc.)

### Settings
- [ ] All 9 global settings endpoints verified: save, load, UI wired
- [ ] Project settings save and load all fields
- [ ] Feature flags documented in `.env.example`

### Ecosystem Support
- [ ] Templates exist for: Node.js, Python, C#/BepInEx, Minecraft (Fabric + Forge), Paper/Spigot, BG3, Rust, Go
- [ ] Template parameter system working ("include CI?", "modloader version?")
- [ ] Build system auto-detection: npm, pip, dotnet, Gradle, Maven, Cargo, Go
- [ ] Release publishers: GitHub Releases, Thunderstore, CurseForge/Modrinth, Nexus Mods, npm

### Platform
- [ ] Monorepo/workspace detection (npm, Gradle, Cargo)
- [ ] Environment management (dev/staging/prod per project)
- [ ] CI/CD pipeline visibility (GitHub Actions)
- [ ] Incident management (auto-detect + track)
- [ ] Test coverage trend tracking
- [ ] Multi-workspace support (configurable base paths)

### Chat & Integration
- [ ] Chat works with all 3 providers + fallback
- [ ] GitHub sync bidirectional
- [ ] Desktop notifications working
- [ ] Service log streaming working

### Code Quality
- [ ] No Svelte 4 code remaining
- [ ] Error boundaries on all routes
- [ ] Path traversal hardened
- [ ] Documentation current (ARCHITECTURE.md, PRODUCT_ROADMAP.md, V1_PLAN.md)

---

## Task Count Summary

| Track | Tasks | Effort Breakdown |
|-------|-------|-----------------|
| A: Backend Stability | 8 | 3S, 4M, 1L |
| B: Project Sub-Routes | 9 | 3S, 6M |
| C: Heartbeat & Agents | 5 | 2S, 2M, 1L |
| D: Settings Completeness | 11 | 8S, 2M, 1S |
| E: Notifications & UX | 6 | 2S, 4M |
| F: Code Quality | 5 | 2S, 2M, 1L |
| G: Multi-Ecosystem | 10 | 2S, 6M, 2L |
| H: Platform Features | 6 | 0S, 4M, 2L |
| I: Release Validation | 8 | 3S, 5M |
| **Total** | **68 tasks** | **25S, 35M, 8L** |

---

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|------------|
| Template quality for unfamiliar ecosystems (BG3, Forge) | Medium | Research modding community conventions first. Start with minimal viable templates. |
| Multi-platform release auth complexity (Thunderstore, CurseForge APIs) | High | Implement dry-run mode first. Test with one real mod before expanding. |
| Monorepo detection false positives | Medium | Start with explicit workspace config files only (package.json workspaces, settings.gradle). |
| Agent context specialization scope creep | High | V1 only needs basic per-language context. Deep framework awareness is v1.1. |
| Performance regression from new features | Medium | Profile after each wave. Set resource budgets. |
| Backend audit fixes cause regressions | Medium | Write tests for each fix before deploying. Run full test suite after each. |
