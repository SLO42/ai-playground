# Architecture — ai-playground

> A project lifecycle platform: create, develop, maintain, and release software projects.
> The **Dashboard** is the user-facing app. **Claw** is the automation engine underneath.

---

## System Overview

```
                         ┌──────────────────────────────────────────┐
                         │            SvelteKit Dashboard           │
                         │         (Port 5173 dev / 3000 prod)      │
                         │   Svelte 5 runes · Tailwind v4 · SSR    │
                         └─────────┬──────────────┬────────────────┘
                                   │              │
                    Server routes   │              │  Client stores
                    (.server.ts)    │              │  ($state runes)
                                   │              │
             ┌─────────────────────▼──────────────▼───────────────┐
             │              lib/server/ (Backend)                   │
             │  heartbeat/ · providers/ · task-store · file-reader │
             │  memory-bridge · scoring-engine · github-sync       │
             └──────┬──────────┬──────────────┬──────────────┬────┘
                    │          │              │              │
          ┌────────▼───┐ ┌────▼──────┐ ┌─────▼──────┐ ┌────▼──────────┐
          │  OpenClaw   │ │  Ollama   │ │ Claude Flow│ │  External     │
          │  Gateway    │ │  (Local)  │ │  v3 Daemon │ │  (GitHub,     │
          │  :18789 WS  │ │  :11434   │ │  MCP       │ │   Anthropic)  │
          │  TLS 1.3    │ │  REST     │ │  :3577     │ │               │
          └──────┬──────┘ └───────────┘ └─────┬──────┘ └───────────────┘
                 │                             │
                 │    ┌────────────────────────┘
                 │    │
          ┌──────▼────▼──────────────────────┐
          │        Persistence Layer          │
          │  .playground/  (runtime JSON)     │
          │  .swarm/memory.db (SQLite+HNSW)   │
          │  config/  (YAML/JSON5)            │
          └───────────────────────────────────┘
```

---

## Repository Structure

```
ai-playground/                   # Root — monorepo coordinator
├── dashboard/                   # SvelteKit app (the product)
│   ├── src/
│   │   ├── routes/              # ~30 pages + 81 API endpoints
│   │   │   ├── api/             # REST + SSE endpoints
│   │   │   ├── projects/[id]/   # Project-scoped views (13 sub-routes)
│   │   │   └── ...              # Global views (agents, models, memory, etc.)
│   │   └── lib/
│   │       ├── components/      # 30 custom + 59 UI primitives (bits-ui)
│   │       ├── server/          # 53 backend modules
│   │       │   ├── heartbeat/   # 18 modules — the Claw automation engine
│   │       │   └── providers/   # Chat provider adapters (ollama, claude, openclaw)
│   │       ├── stores/          # 7 Svelte 5 rune-based client stores
│   │       └── types/           # 14 domain type files
│   ├── ARCHITECTURE.md          # Dashboard-specific architecture (route map, API index)
│   └── package.json             # SvelteKit 2.x, Svelte 5, Tailwind v4, Vitest, Playwright
│
├── config/                      # All configuration (YAML, JSON5)
│   ├── agent-pool.yaml          # 14-agent tiered pool (8 opus, 2 claw, 2 sonnet, 2 haiku)
│   ├── openclaw/
│   │   ├── gateway.yaml         # Gateway security: loopback, TLS, rate limits, tool ACL
│   │   ├── models.json5         # Model routing: gpt-oss → sonnet → haiku fallback
│   │   └── channels/            # Channel configs (dashboard WS, twitch)
│   └── security/
│       └── network-policy.yaml  # Firewall rules, input validation, secret rotation
│
├── scripts/                     # Automation scripts
│   ├── daemon-ctl.sh            # Start/stop/restart Claude Flow daemon (Windows+POSIX)
│   ├── patch-agentdb.sh         # Postinstall: fix AgentDB import paths
│   └── pre-commit-checks.sh    # Git hook: lint + type checks
│
├── docs/                        # Project documentation
│   ├── PROJECT_PLAN.md          # Full product plan with build phases
│   ├── PRODUCT_ROADMAP.md       # Feature roadmap with priorities
│   ├── BACKEND_AUDIT.md         # 8 critical + 19 high-priority issues
│   ├── api-contracts.md         # REST API specification
│   └── fails.md                 # Failure log with prevention rules
│
├── .playground/                 # Runtime state (gitignored)
│   ├── tasks.json               # Task registry
│   ├── session-pool.json        # Agent session slots
│   ├── agent-analytics.json     # Performance events
│   ├── graph-state.json         # Knowledge graph
│   ├── auto-memory-store.json   # Auto-memory entries
│   ├── claw-device-identity.json # Ed25519 keypair for gateway auth
│   └── chats/                   # Chat session files
│
├── .swarm/                      # Agent memory database
│   ├── memory.db                # SQLite + HNSW vector index
│   └── schema.sql               # v3.0.0 schema (memory, patterns, trajectories)
│
├── .claude-flow/                # Claude Flow daemon state
│   ├── daemon.pid               # Running process ID
│   ├── daemon-state.json        # Daemon status flags
│   └── daemon.log               # Stdout/stderr capture
│
├── .github/workflows/           # CI/CD
│   ├── ci.yml                   # Lint → test (85% coverage) → build → preview
│   ├── release.yml              # Semver tag → release notes → Docker push to GHCR
│   └── auto-pr-main.yml         # Auto-PR from dev → main
│
├── .claude/                     # Claude Code configuration
│   ├── skills/                  # On-demand skill docs (loaded by file pattern)
│   └── agents/                  # Agent definition files
│
├── package.json                 # Root: orchestration scripts, openclaw + ruflo deps
├── docker-compose.yml           # Dashboard + Ollama containers (GPU support)
├── CLAUDE.md                    # Agent instructions (plan → implement → verify)
└── ARCHITECTURE.md              # This file
```

---

## Layer 1: Dashboard (User-Facing)

**Stack**: SvelteKit 2.x · Svelte 5 (runes) · Tailwind CSS v4 · Node adapter · TypeScript strict

### Two Navigation Modes

| Mode | Routes | Sidebar | Description |
|------|--------|---------|-------------|
| **Global** | `/`, `/models`, `/agents`, `/memory`, `/services`, ... | Platform nav | Manage all projects, monitor agents, configure models |
| **Project** | `/projects/[id]/*` | Project nav | Drill into one project's tasks, agents, releases, memory |

### Data Flow

```
User action → +page.svelte (client, Svelte 5 runes)
  → +page.server.ts (SSR data loading)
  → lib/server/ module (business logic)
  → .playground/ files or external service
```

### Client State (7 stores)

| Store | Source | Update | Style |
|-------|--------|--------|-------|
| `ollama.ts` | REST polling `:11434` | 5s (ps), 30s (tags) | Svelte 5 runes |
| `openclaw.ts` | WebSocket `:18789` | Real-time events | Svelte 5 runes |
| `ruflo.ts` | API polling `/api/v3/*` | 10s (progress, swarm, learning) | **Svelte 4** `writable`/`derived` (needs migration) |
| `services.ts` | API polling | 10s interval | Svelte 5 runes |
| `projects.ts` | API + server load | On navigation | Svelte 5 runes |
| `notifications.ts` | SSE stream | Push (server-sent) | Svelte 5 runes |

### Component Library

- **30 custom components**: Sidebar, StatusBar, MetricCard, BubbleGraph, AgentGrid, CommandPalette, Markdown, TaskList, VramGauge, ScoreGauge, ReportChart, TimelineChart, etc.
- **59 UI primitives** (bits-ui): badge, button, card, dialog, input, select, table, tabs, tooltip, separator
- **Design tokens**: 12 colors (dark theme), Inter + JetBrains Mono typography, 4px grid

### API Surface (81 endpoints)

| Category | Count | Key Endpoints |
|----------|-------|---------------|
| Projects | 20+ | CRUD, agents, memory, releases, tasks, settings per project |
| Agents | 5 | Pool stats, analytics, catalog, teams, usage |
| Chat | 8 | Multi-provider streaming (SSE), history, sessions |
| Memory | 4 | Graph CRUD, entries, context, sync |
| Services | 6 | Health, start/stop, config, logs (streaming) |
| Settings | 8 | General, model routing, memory, heartbeat, API keys |
| Sessions | 4 | CRUD, active list, event streaming |
| Security | 3 | Audit, policy, scan |
| Other | 23 | Health, notifications, reports, routing, hooks, GitHub, MCP |

Full API spec: `docs/api-contracts.md`

---

## Layer 2: Claw Automation Engine

The heartbeat system in `dashboard/src/lib/server/heartbeat/` is the core automation loop. It runs server-side within the SvelteKit process.

### Heartbeat Loop (every 60s)

```
1. Health checks    → probe Ollama, Gateway, Daemon liveness
2. Task scan        → iterate all projects (round-robin fairness)
3. Agent spawn      → pick model, route through provider, spawn agent
4. Completion       → capture output, commit changes, record analytics
5. Follow-ups       → plan next tasks, spawn review agent if 3+ files changed
6. Memory sync      → update patterns, sync memory bridge
```

### 17 Heartbeat Modules (`lib/server/heartbeat/`)

| Module | Purpose |
|--------|---------|
| `index.ts` | Main loop: health → scan → spawn → review cycle |
| `shared.ts` | Chat sessions, agent counting, project limits |
| `agent-spawn.ts` | Model selection (tier routing), task prompting |
| `agent-tracking.ts` | Completion logging, git baseline, log streaming |
| `agent-analytics.ts` | Event recording, per-project breakdowns |
| `openclaw-agent.ts` | Gateway routing, task classification |
| `review-agent.ts` | Code review for multi-file commits |
| `post-task.ts` | Git commit, changelog, follow-up planning |
| `post-test.ts` | Run project test command after commits |
| `discussion.ts` | Multi-agent discussion sessions |
| `release-agent.ts` | Release pipeline: dry-run, test, changelog, tag, publish |
| `session-pool.ts` | Session persistence, `populateFromProjects()` |
| `pid-registry.ts` | Process lifecycle, orphan reaping on startup |
| `memory-guardian.ts` | Memory monitoring and cleanup |
| `ux-inspector.ts` | UX scanning and reporting (2x/day) |
| `auto-restart.ts` | Service restart on failure detection |
| `gateway-client.ts` | OpenClaw WebSocket client |

### Supporting Server Modules (`lib/server/`)

| Module | Purpose |
|--------|---------|
| `ci-pipeline.ts` | CI/CD orchestration |
| `cli-executor.ts` | Shell command execution |
| `service-starter.ts` | Service lifecycle (start/stop) |
| `dependency-health.ts` | Dependency status checking |
| `scoring-engine.ts` | Quality scoring |
| `memory-bridge.ts` | Memory aggregation from auto-memory + claude-flow MCP |
| `routing-telemetry.ts` | Model routing decision logging |
| `mcp-tool-registry.ts` | MCP server tool registry |
| `chat-tools.ts` | LLM tool definitions (list_projects, create_task, etc.) |

### Agent Routing

```
Task arrives
  ↓
classifyTask() → complexity score
  ↓
┌─────────────────────────────────────────────┐
│ Tier Selection (config/agent-pool.yaml)     │
│                                              │
│   Simple → Haiku (2 slots)                  │
│   Moderate → Sonnet (2 slots)               │
│   Complex → Opus (8 slots)                  │
│   Local/routing → Claw/GPT-OSS (2 slots)   │
│                                              │
│   Escalation: Haiku → Sonnet → Opus         │
│   Delegation: Opus → Haiku for subtasks     │
└─────────────────────────────────────────────┘
  ↓
Provider selection:
  1. OpenClaw gateway (if online) → routes to Ollama or Claude
  2. Direct Ollama (fallback if gateway down)
  3. Direct Claude API (escalation)
```

### Chat Providers

| Provider | Transport | Model | Use Case |
|----------|-----------|-------|----------|
| Ollama | REST `:11434` | gpt-oss:20b (MoE, 3.6B active) | Fast local routing, free |
| Claude | HTTPS API | Opus, Sonnet, Haiku | Complex reasoning, code gen |
| OpenClaw | WebSocket `:18789` | Routes to above | Unified gateway, tool ACL |

---

## Layer 3: Persistence

### Runtime State (`.playground/`)

JSON files read/written by server modules. Gitignored. Ephemeral per-machine.

| File | Content | Accessed By |
|------|---------|-------------|
| `tasks.json` | Task registry (all projects) | task-store.ts |
| `session-pool.json` | Agent session slots | session-pool.ts |
| `agent-analytics.json` | Spawn events, costs, durations | agent-analytics.ts |
| `graph-state.json` | Knowledge graph nodes/edges | memory endpoints |
| `auto-memory-store.json` | Auto-memory entries | memory-bridge.ts |
| `chats/` | Chat session files (per-session JSONL) | session-manager.ts |
| `pid-registry.json` | Child process PIDs | pid-registry.ts |
| `claw-device-identity.json` | Ed25519 keypair | gateway auth |

### Vector Memory (`.swarm/memory.db`)

SQLite with WAL mode. Schema v3.0.0.

| Table | Purpose |
|-------|---------|
| `memory_entries` | Semantic/episodic/procedural memory + 768-dim embeddings |
| `patterns` | Learned patterns with confidence scoring (0.0–1.0) |
| `pattern_history` | Pattern evolution tracking |
| `trajectories` | SONA reinforcement learning trajectories |
| `trajectory_steps` | Individual steps with reward signals |
| `vector_indexes` | HNSW index metadata |

Features: temporal decay (30-day half-life), access tracking, TTL support.

### Configuration (`config/`)

YAML and JSON5 files. Checked into git. Define agent tiers, gateway security, model routing, and network policies.

---

## Layer 4: External Services

| Service | Protocol | Endpoint | Purpose |
|---------|----------|----------|---------|
| OpenClaw Gateway | WSS | `127.0.0.1:18789` | Agent routing, tool execution, DM channels |
| Ollama | REST | `127.0.0.1:11434` | Local LLM inference (gpt-oss:20b) |
| Claude Flow v3 | MCP/HTTP | `127.0.0.1:3577` | Multi-agent coordination, memory search |
| Anthropic API | HTTPS | `api.anthropic.com` | Claude models (Opus, Sonnet, Haiku) |
| GitHub | HTTPS | `api.github.com` | Repo sync, releases, PR management |

---

## Security Architecture

### Network

- **All local services loopback-only** (127.0.0.1) — zero external exposure
- **TLS 1.3 minimum** on all transport (gateway, API)
- **Firewall default-deny** with explicit allow rules (`config/security/network-policy.yaml`)
- **Rate limiting**: 60 req/min gateway, 10 msg/sec dashboard channel

### Authentication

- **Gateway**: Token-based + Ed25519 device identity keypair
- **DM channels**: Pairing mode — unknown senders provide short code (5m expiry, 3 attempts)
- **API keys**: Stored in `.env`, never committed. Rotation policy: 90 days.

### Input Validation

- Prompt injection guard (block)
- Path traversal guard (block)
- Command injection guard (block)
- XSS guard (sanitize via DOMPurify)

### Known Vulnerabilities

8 critical issues tracked in `docs/BACKEND_AUDIT.md`:
1. File concurrency races (TOCTOU) across 5 modules
2. Shell injection in git/gh commands
3. Gateway client concurrent `chat()` hang
4. Discussion replies dropped when agent pool full
5. Task description mutated in-place (state corruption)
6. File descriptor leak in `spawn()`
7. Tool messages dropped from OpenClaw prompt
8. Tool execution bypass (no confirmation wait)

See also: `docs/fails.md` for prevention rules (F-001 through F-006).

---

## CI/CD Pipeline

### Continuous Integration (`ci.yml`)

Triggers: push to main/dev, PRs to main.

```
┌─────────────┐     ┌────────────┐     ┌──────────────────┐     ┌───────┐
│ Lint + Types │────▶│ Unit Tests │────▶│ Integration Tests │────▶│ Build │
│  (ESLint,    │     │ (Vitest,   │     │ (Memory, API)     │     │       │
│   Svelte)    │     │  85% cov)  │     │                   │     │       │
└─────────────┘     └────────────┘     └──────────────────┘     └───────┘
```

### Release (`release.yml`)

Triggers: PR merged to main.

```
Determine version (PR labels) → git tag → release notes → GitHub Release → Docker image → GHCR
```

### Docker

```yaml
services:
  dashboard:  # SvelteKit + Node adapter, 512MB limit, health check on :3000
  ollama:     # ollama/ollama:latest, GPU passthrough, persistent volume
```

Startup order: Ollama healthy → Dashboard starts.

---

## Product Coverage

| Lifecycle Phase | Coverage | What Works | Key Gaps |
|----------------|----------|------------|----------|
| **Create** | 70% | 6 templates, import (55+ patterns), git init, GitHub | Service auto-start, game/mod templates, template parameters |
| **Develop** | 90% | Task → Agent → Code → Commit, round-robin, pooling, task dependencies (`blockedBy`), post-commit testing, review agent | UI dependency picker, granular heartbeat controls |
| **Maintain** | 60% | Health scanning, memory graph, UX inspector, analytics, auto-restart, dependency health, feature flags | No incident mgmt, no debt tracking, no coverage trends |
| **Release** | 70% | Release manager (changelog, semver, GitHub releases), release agent, release page UI | Needs real-world validation, no multi-platform release (Thunderstore, CurseForge, Nexus) |

### Known Architectural Debt

- **Idle agent spawning**: Session pool pre-populates agents that idle, wasting resources and carrying stale context. Should spawn fresh per task with task-specific context only.
- **Heartbeat all-or-nothing**: Only start/stop toggle — no granular control over individual phases (health, scan, spawn, review, memory sync). Taxes machine during development.
- **Svelte 4 holdover**: `ruflo.ts` store still uses `writable`/`derived` instead of Svelte 5 runes.
- **Backend audit**: 8 critical issues unresolved (see `docs/BACKEND_AUDIT.md`).

Full roadmap: `docs/PRODUCT_ROADMAP.md`

---

## Project Scope

The platform is designed to manage **any software project** — not just web apps. Current and planned projects span multiple ecosystems:

```
┌─────────────────────────────────────────────────────────────────┐
│                    ai-playground manages:                        │
│                                                                  │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────────────────┐│
│  │ Web Apps     │  │ Game Mods   │  │ Server Plugins           ││
│  │ SvelteKit    │  │ BepInEx/C#  │  │ Paper/Spigot (Java)      ││
│  │ Next.js      │  │ BG3 (Lua)   │  │ Fabric/Forge (Kotlin)    ││
│  │ React/Vue    │  │ Fabric/Forge│  │                          ││
│  └─────────────┘  └─────────────┘  └──────────────────────────┘│
│                                                                  │
│  Per-project, Claw must understand:                             │
│  • Language + framework → which agent context to load           │
│  • Build system → how to compile, test, lint                    │
│  • Release target → where to publish (npm, Thunderstore, etc.) │
│  • Project structure → what files matter for each task          │
└─────────────────────────────────────────────────────────────────┘
```

### Project Type Matrix

| Ecosystem | Language | Build | Test | Release Target | Template |
|-----------|----------|-------|------|---------------|----------|
| SvelteKit web | TypeScript | npm/Vite | Vitest/Playwright | Docker/GHCR | Exists |
| Node.js | TypeScript/JS | npm | Jest/Vitest | npm registry | Exists |
| Python | Python | pip/poetry | pytest | PyPI | Exists |
| BepInEx mod (SWIP) | C# | dotnet/MSBuild | NUnit/xUnit | Thunderstore | Planned |
| BG3 mod | Lua/XML | Mod toolkit | Manual | Nexus Mods | Planned |
| Minecraft mod | Java/Kotlin | Gradle | JUnit | CurseForge/Modrinth | Planned |
| Minecraft plugin | Java/Kotlin | Gradle/Maven | JUnit | SpigotMC/Hangar | Planned |
| Rust | Rust | Cargo | cargo test | crates.io | Planned |
| Go | Go | go build | go test | GitHub releases | Planned |

### What This Means for Architecture

1. **Agent context must be project-specific**: A C# mod agent needs different context than a TypeScript web agent. Generic context wastes tokens and produces worse results.
2. **Build/test/release are per-ecosystem**: Can't assume `npm test` — must detect and route to the correct build system.
3. **Templates are extensible**: Each template is a function returning `Record<string, string>`. New ecosystems just add new template functions.
4. **Release targets are pluggable**: Each target (Thunderstore, CurseForge, npm, etc.) needs its own auth config, metadata mapping, and upload API.

---

## Type System (14 domain types)

| File | Key Types |
|------|-----------|
| `agents.ts` | `AgentPool`, `AgentSlot`, `AgentEvent`, `SpawnConfig` |
| `chat.ts` | `ChatSession`, `ChatMessage`, `ChatSender`, `ChatToolCall` |
| `tasks.ts` | `Task`, `TaskStatus`, `TaskPriority` |
| `projects.ts` | `Project`, `ProjectConfig` |
| `memory.ts` | `MemoryEntry`, `RankedContext`, `AutoMemoryEntry`, `GraphState` |
| `graph.ts` | `GraphNode`, `GraphEdge`, `BubbleGraphProps` |
| `services.ts` | `Service`, `ServiceAction` |
| `models.ts` | `ModelInfo`, `ModelCapabilities` |
| `hooks.ts` | `HookEvent`, `HookConfig` |
| `security.ts` | `SecurityFinding`, `SecurityPolicy` |
| `metrics.ts` | `PerformanceMetrics` |
| `daemon.ts` | `DaemonState`, `DaemonWorker` |
| `channels.ts` | `ChannelConfig` |
| `mcp.ts` | `McpTool`, `McpServer` |

---

## Cross-References

| Document | Location | Covers |
|----------|----------|--------|
| **v1.0 release plan** | **`docs/V1_PLAN.md`** | **42 tasks across 7 tracks, 4-wave execution plan, definition of done** |
| Dashboard architecture | `dashboard/ARCHITECTURE.md` | Route map, API index, component map, data flow |
| Project plan | `docs/PROJECT_PLAN.md` | Full build phases, design tokens, verification checklist |
| Product roadmap | `docs/PRODUCT_ROADMAP.md` | Feature priorities, execution order |
| Backend audit | `docs/BACKEND_AUDIT.md` | 8 critical + 19 high issues with fixes |
| API contracts | `docs/api-contracts.md` | REST endpoint specifications |
| Failure log | `docs/fails.md` | Prevention rules from past mistakes |
| Agent instructions | `CLAUDE.md` | Plan → Implement → Verify workflow |
| Agent pool config | `config/agent-pool.yaml` | Tier definitions, escalation rules |
| Gateway config | `config/openclaw/gateway.yaml` | Security, auth, tool ACL |
| Network policy | `config/security/network-policy.yaml` | Firewall, validation, secrets |

---

## Platform Notes

- **OS**: Windows 11 Pro (dev), Linux (CI/Docker)
- **Windows gotchas**: `process.kill(pid, 0)` unreliable on MINGW — use `tasklist`. `spawn()` with `detached: true` needs `shell: true`. See `docs/fails.md` F-001, F-002.
- **Ollama API**: `http://127.0.0.1:11434` — never append `/v1`
- **Svelte 5 only**: `$state`, `$derived`, `$effect`, `$props` — no Svelte 4 stores
- **Tailwind v4**: CSS-first config via `@theme` — no `tailwind.config.js`
