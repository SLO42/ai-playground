# UI-SPEC — ai-playground v2

The UI/UX **design contract** (planning level). Defines information architecture, layout system, per-screen specs, component inventory, the real-time interaction model, and state/feedback patterns for the dashboard.

> **Scope of this doc (read first).** This is the *structural* design — what screens exist, what they show, how they behave, and what states they have. **Concrete visual styling — the actual color values, type scale, spacing numbers — is intentionally DEFERRED** and will be derived from cannibalized sources (the v1 dashboard, already SvelteKit + Tailwind v4, plus other harvested UIs). Token *roles* and the system *structure* are defined here as placeholders; their values come later (see §6 and §15). No mockups, no component code, no `frontend-design` pass yet.

## References (inputs)

| Doc | What it constrains here |
|-----|--------------------------|
| `PRODUCT.md` | jobs (1–10), the two pillars, success bars, "no hardcoded data", analytics-first |
| `ARCHITECTURE.md` | §4 page set, the one SSE event stream, harness layer, gates/confirm |
| `DATA-MODEL.md` | the entities each screen renders + their states (status enums, soft-archive) |
| `DECISIONS.md` | D-005 (SvelteKit 2.x + Svelte 5 runes + Tailwind v4), D-011 (session control), D-010/D-018 (config edit = diff+confirm), D-019 (graceful degradation), D-025 (loopback/local) |
| `ROADMAP.md` | which screens are needed per release → design/build order |

---

## 1. Design principles (UX)

1. **Local-first, single-operator.** One power user on their own machine supervising many projects. Desktop-first, information-dense, no onboarding/marketing chrome, no auth UI. Optimize for *at-a-glance status + fast action*, not first-run hand-holding.
2. **Live by default.** Every screen reflects real state in real time via the one SSE stream — no manual refresh. Streaming transcripts, task status, metrics update in place.
3. **Honest states, never fake.** Loading / empty / error / stale / disconnected are first-class, distinct visual states. Never show placeholder/mock values dressed as real (PRODUCT principle; v1 fail F-008). If data is unknown, say "unknown", not a plausible number.
4. **Analytics is visible, not buried.** Routing rationale, cost, duration, escalations surface where the work happens (per agent run / per task), not only on a separate reports page.
5. **Calm density.** Dense data without noise: strong hierarchy, restrained color (color = meaning/status, not decoration), generous-enough spacing to scan. Lighter product → fast, snappy UI.
6. **Keyboard-driven.** Command palette + shortcuts for power use (carried from v1). Mouse optional.
7. **Constrained autonomy is visible.** When an agent acts autonomously, the UI makes its boundaries legible: which gates are active, what needs confirmation, when something was blocked (D-018/D-024). Config writes always diff-and-confirm (D-010).
8. **Degrade gracefully, visibly.** If the server/SSE drops, the UI shows a clear "disconnected — reconnecting" state and keeps last-known data; it never blanks out or fakes liveness (D-019).

---

## 2. Information architecture

Two navigation contexts, switchable from the sidebar:

**Global context** (portfolio-wide):
```
/                home / portfolio overview
/projects        project list → drills into a project workspace
/agents          agent fleet: pool, live activity, usage, catalog
/chat            multi-provider chat (global)
/memory          knowledge-graph + semantic search explorer
/reports         analytics: routing, cost, outcomes, trends
/services        health, logs, start/stop (Ollama, SurrealDB, engine)
/claude-code     harness hub: session fleet + config manager + catalog
/workflows       define + run headless CC pipelines; run history
/settings        general, routing, model slots, orchestration mode, memory, API keys
```

**Project context** (`/projects/[id]/…`) — tabs:
```
Overview · Tasks · Roadmap · Sessions · Memory · Release · Settings
```

Navigation model: a persistent **left sidebar** lists global nav; entering a project swaps the sidebar's lower region to the project tabs + shows the active project in a context switcher at the top of the sidebar. A **command palette** (Ctrl/Cmd-K) jumps to any page, project, task, or action.

IA rule: global pages aggregate across projects; project pages are scoped to one. The same component (e.g. TaskList, AgentGrid) renders in both, parameterized by scope.

---

## 3. Layout system (app shell)

```
┌────────────┬─────────────────────────────────────────────┬───────────┐
│            │  Top bar: breadcrumb · live-status pill ·     │           │
│  Sidebar   │            command-palette · connection state │  (right   │
│            ├─────────────────────────────────────────────┤   tray:   │
│  global    │                                               │  notifs / │
│  nav       │            Main content region                │  activity │
│  ──────    │            (page-specific)                    │  — slide- │
│  project   │                                               │  over,    │
│  tabs      │                                               │  not      │
│  (when in  │                                               │  always   │
│  a project)│                                               │  pinned)  │
│            ├─────────────────────────────────────────────┤           │
│  context   │  Status bar: services health · active agents  │           │
│  switcher  │  · token/cost ticker · engine mode            │           │
└────────────┴─────────────────────────────────────────────┴───────────┘
```

- **Sidebar** (collapsible): global nav + project context switcher + project tabs. Active item highlighted.
- **Top bar**: breadcrumb (context), a **live-status pill** (engine mode: event/periodic/manual + running-agent count), command-palette trigger, and the **connection state** indicator (green live / amber reconnecting / grey offline — D-019 made visible).
- **Status bar** (bottom, persistent): services up/down, active agent count, running token/cost ticker, orchestration mode. The "always-on awareness" strip.
- **Right tray** (slide-over, not pinned by default): notifications + recent activity feed. Keeps the main region focused; opens on demand or on new high-severity event.
- **Main region**: page content. Single scroll owner; sub-panels scroll independently only where necessary (e.g. a transcript pane).

Density: desktop-first. Comfortable default; an optional compact mode (tighter rows) for data-heavy tables. (Mode is a token toggle, §6.)

---

## 4. Design tokens — structure (VALUES DEFERRED, §15)

Tailwind v4, CSS-first via `@theme` (D-005). Define **roles**, not raw values here; values are harvested from cannibalized sources later. Tokens are CSS custom properties so a later palette swap is one file.

**Color roles** (semantic, not literal):
- Surface: `--color-bg` (app), `--color-surface` (panels/cards), `--color-surface-raised` (popovers/modals), `--color-border`.
- Text: `--color-text` (primary), `--color-text-muted`, `--color-text-inverse`.
- Accent: `--color-accent` (primary actions/active nav), `--color-accent-muted`.
- **Status** (load-bearing — used consistently everywhere): `--color-running`, `--color-success`, `--color-warn`, `--color-error`, `--color-idle/neutral`, `--color-info`. These map to the entity status enums in DATA-MODEL (task/session/service/release status, finding severity).
- Agent-tier accents: `--color-tier-local | -haiku | -sonnet | -opus` (so the fleet view reads tier at a glance).

**Type scale**: `--font-sans` (UI), `--font-mono` (code/transcripts/ids). Size steps `--text-xs … --text-2xl` (role-named: body, label, heading-sm/md/lg, display). Mono is first-class — transcripts, record ids, paths, SurrealQL all render mono.

**Spacing / radius / elevation / motion**: a single spacing scale (`--space-1…8`), radius (`--radius-sm/md/lg`), elevation (shadow tokens for surface/raised/overlay), motion (`--motion-fast/normal`, and a `prefers-reduced-motion` path). Live updates use subtle motion (fade/slide-in of new rows), never jarring.

> Concrete values (hex, px, ms) are NOT set here. Placeholder = inherit v1's existing `@theme` tokens until the cannibalization pass tunes them (§15).

---

## 5. Component inventory

Shared components (scope-parameterized; rendered in both global + project contexts). Each lists **purpose** + **key states**.

| Component | Purpose | Key states |
|-----------|---------|-----------|
| `Sidebar` | global nav + project switcher + tabs | collapsed/expanded, active item |
| `TopBar` | breadcrumb, live pill, palette, connection | live / reconnecting / offline |
| `StatusBar` | persistent services + agents + cost + mode | per-service up/down; agent count 0/N |
| `RightTray` | notifications + activity feed | empty, unread badge, severity tint |
| `CommandPalette` | jump to page/project/task/action | empty query, results, no-match |
| `MetricCard` | single KPI (cost, agents, tasks, health) | value / loading-skeleton / unknown |
| `AgentFleetGrid` | live grid of running/recent sessions | empty, running (animated), done, failed |
| `TranscriptView` | streaming Claude Code transcript | streaming (tokens arriving), tool-call (with confirm), complete, errored |
| `SessionControls` | interject / stop / resume (D-011) | enabled when running; disabled otherwise |
| `TaskList` / `TaskCard` | backlog/board of tasks | per-status styling; empty; optimistic update |
| `RoadmapView` | releases → phases → features/sprints | planned/active/shipped |
| `KnowledgeGraph` (`BubbleGraph`) | memory + entity nodes & typed edges | empty, loading, node-focus, hover-edge |
| `MemorySearch` | semantic + keyword recall, ranked | query, ranked results w/ rationale + citation id, empty |
| `ConfigEditor` | view/edit `.claude/*`, `.mcp.json`, CLAUDE.md | view, dirty, **diff + confirm** (mandatory), validation error |
| `CatalogList` | agents/skills/MCP/hooks discovered | per-scope (project/global), empty |
| `WorkflowBuilder` / `RunView` | define steps + watch a run | draft, running (per-step state), done/failed |
| `ReportChart` / `TimelineChart` | analytics over time + breakdowns | loading, empty, data, anomaly-flag |
| `RoutingRationale` | why this provider/model (inline) | shown on a run/task |
| `ServiceRow` | one service health + actions | running/stopped/crashed/unknown |
| `Markdown` | render docs/plans/CLAUDE.md | — |
| `GateBanner` / `ConfirmDialog` | surface a gate block / require confirm | warn (soft) / block (hard) |
| `ConnectionState` | SSE live indicator | live / reconnecting / offline |
| `EmptyState`, `ErrorState`, `Skeleton` | the honest-state primitives | — |

Primitives: from bits-ui (button, dialog, table, tabs, select, tooltip, badge, etc.) — styled via the §6 tokens. Keep custom components < 200 lines (carry v1 rule); extract sub-components past that.

---

## 6. Per-screen specs

For each: **purpose · primary data (DATA-MODEL) · layout · key components · states · primary actions.** States below assume the four honest states (loading / empty / error / live) unless noted.

### Global

**`/` Home / portfolio overview**
- Purpose: at-a-glance health of the whole portfolio + engine.
- Data: `project` (counts/status), running `session`s, `agent_event` rollups, `service` health, recent `incident`/`notification`.
- Layout: top row of `MetricCard`s (active projects, running agents, today's cost, services up); below, two columns — recent activity (sessions/tasks) + portfolio task summary; `AgentFleetGrid` (live) prominent.
- Actions: jump to project, start a manual run, open command palette.

**`/projects` + `/projects/[id]/…`**
- List: searchable/filterable `project` cards (ecosystem badges, status, open-task count, last activity). Action: open, register-new.
- Project tabs:
  - **Overview** — plan macro (purpose/vision/role/DoD), current release, open tasks, recent sessions, health.
  - **Tasks** — `TaskList` board by status; create/edit; per-task routing rationale + linked sessions.
  - **Roadmap** — `RoadmapView`: releases→phases→features→sprints.
  - **Sessions** — history of this project's Claude Code sessions; open one → `TranscriptView` + `SessionControls`.
  - **Memory** — project-scoped `MemorySearch` + `KnowledgeGraph`.
  - **Release** — release pipeline (dry-run/test/changelog/version/tag/publish) driven as a workflow run; changelog.
  - **Settings** — project config, model routing override, test command, gate config.

**`/agents`** — pool (tiers from `agent_slot`), live `AgentFleetGrid`, usage analytics (per-tier cost/duration), catalog of available agents.

**`/chat`** — multi-provider chat; session list + `TranscriptView`; provider/model picker; project scope selector.

**`/memory`** — global `KnowledgeGraph` explorer + `MemorySearch` (hybrid recall, ranked, with rationale + citation id). Node focus → details + neighbors. Read-only on archived/superseded (shown dimmed).

**`/reports`** — analytics dashboards: routing decisions, cost over time, outcomes, escalations, **daily rollups + anomaly flags** (trend-aware, not raw event lists). Filter by project/time/model.

**`/services`** — `ServiceRow`s for Ollama / SurrealDB / engine: status, logs (streamed), start/stop/restart. Loopback/local only (D-025).

**`/claude-code` — harness hub** (the control surface):
- Session **fleet**: all running/recent CC sessions across projects, live; open → transcript + interject/stop/resume.
- **Config manager**: per-project + global view/edit of hooks, skills, agents, MCP servers, `settings.json`, permissions, `CLAUDE.md` via `ConfigEditor` — **every write is diff-and-confirm** (D-010); validation before save (e.g. permission-rule syntax). Filesystem-authoritative; show "synced / out-of-sync (edited on disk)" state.
- **Catalog**: discovered agents/skills/MCP/hooks (project + global), read-only.

**`/workflows`** — list + `WorkflowBuilder` (steps, deps, parallel) + `RunView` (live per-step state, links to each step's session). Run history.

**`/settings`** — general; routing (tiers, escalation/delegation, intent→config); model slots (local + cloud); orchestration mode (event/periodic/manual + interval); memory (embedding, decay knobs); API keys (`.env`-backed, never shown in full); gate config defaults.

---

## 7. Real-time / live-update UX (the core interaction)

One SSE stream feeds all live regions (ARCHITECTURE event bus → SSE).
- **Transcripts** stream token-by-token in `TranscriptView`; tool calls render as inline cards; a tool call needing confirmation (gate) **pauses** with a `ConfirmDialog` (interject is possible mid-stream via `SessionControls`).
- **Task/session/service status** updates in place (row re-tints, fleet grid animates a new/finished agent) — no full-page reload.
- **Metrics/cost ticker** in the status bar increments live as `agent_event`s arrive.
- **New rows** fade/slide in (subtle motion; respects reduced-motion).
- **Connection loss** (D-019): the `ConnectionState` flips to "reconnecting", live regions freeze at last-known with a subtle dimming + timestamp ("as of …"); on reconnect, re-sync. Never blank, never fake-live.
- Live regions use ARIA live semantics for a11y (§9).

---

## 8. State & feedback patterns

- **Loading**: `Skeleton` placeholders shaped like the content (not spinners) for initial loads; inline shimmer for refreshing rows.
- **Empty**: `EmptyState` with a one-line explanation + the primary action ("No tasks yet — create one"). Never an empty void.
- **Error**: `ErrorState` with the real error + a retry; for partial failures, degrade the affected panel only, not the page.
- **Stale/disconnected**: dim + "as of <time>" badge (§7).
- **Unknown**: literally render "unknown" / "—", never a fabricated value (F-008).
- **Confirmation**: destructive or config-mutating actions (config write, stop agent, delete) require explicit confirm; config writes show a **diff** first (D-010). Gate blocks surface a `GateBanner` explaining what was blocked and why (D-018).
- **Toasts + tray**: transient success/info as toasts; durable items in the right tray.

---

## 9. Accessibility

- Contrast meets WCAG AA (enforced once concrete colors land, §15).
- Full keyboard nav: every action reachable; visible focus rings; command palette as the keyboard backbone.
- Live regions (transcripts, status) use `aria-live="polite"` so updates are announced without stealing focus.
- `prefers-reduced-motion` disables slide/fade for live updates.
- Mono/numeric data aligned; status never conveyed by color alone (pair with icon/label).

---

## 10. Responsive

Target = local **desktop** (the single operator's machine). Design to a comfortable min width (~1280) with graceful reflow down to ~1024 (sidebar collapses, right tray overlays). **Mobile/tablet is out of scope** for v2 (matches single-operator, local-first). Don't spend design budget on small screens.

---

## 11. Content & voice

Terse, technical, honest. Labels are nouns/verbs, not marketing. Numbers carry units. Errors quote the real message. Status words match the data-model enums exactly (running/done/failed/blocked…), so UI vocabulary == system vocabulary.

---

## 12. Build/design order (maps to ROADMAP)

Design the screens in release order, not all at once:
- **v0.1**: app shell (sidebar/topbar/statusbar), `/projects` + Overview, `TranscriptView` + a manual-run view, `/claude-code` read-only catalog. (Minimum to "register a project + watch one CC session".)
- **v0.2**: `/agents` fleet + `SessionControls`, `TaskList`/board, `/memory`, `/reports` (rollups), `ConfigEditor` (read-write, diff+confirm), `/workflows`.
- **v0.3**: Release tab pipeline, `/services` actions, security findings views.
- **v1.0**: polish, consolidation, the cannibalized visual pass (§15).

---

## 13. Out of scope (this doc / this phase)

- Concrete color/type/spacing **values** (deferred — §15).
- Pixel mockups / hi-fi comps (none yet — will sketch/harvest later).
- Component implementation code (no `frontend-design` pass yet).
- Mobile/tablet layouts.
- Marketing/onboarding/auth surfaces (single-operator, none).

---

## 14. Open questions

- Right tray: slide-over vs. an optional pinned column on wide screens? (lean slide-over.)
- Compact-density mode: global toggle vs. per-table? (lean global token.)
- Does `/chat` merge into `/claude-code` later, or stay separate? (keep separate for now.)
- Graph viz library/approach for `KnowledgeGraph` at scale — defer to build.

---

## 15. Deferred: visual styling from cannibalized sources

The concrete look is intentionally **not** designed here. Plan:
1. **Harvest** the v1 dashboard's existing `@theme` tokens (it's already SvelteKit + Svelte 5 + Tailwind v4) as the starting palette/type/spacing — closest, zero-cost source.
2. **Cannibalize** other harvested UIs for patterns worth adopting (note them as we study each source).
3. Fill in this doc's token *values* (§6) from that harvest, then run a `frontend-design` pass on the high-traffic screens.
4. Re-verify contrast/a11y (§9) once values are real.

Until then: token **roles + structure + screen behavior** (this doc) are the contract; **values inherit v1** as a placeholder so the UI is buildable and consistent now, restyleable later in one token file.
