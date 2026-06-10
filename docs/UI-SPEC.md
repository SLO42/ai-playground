# UI-SPEC — ai-playground v2

The UI/UX **design contract** (planning level). Defines information architecture, layout system, per-screen specs, component inventory, the real-time interaction model, and state/feedback patterns for the dashboard.

> **Scope of this doc (read first).** This is the *structural* design — what screens exist, what they show, how they behave, and what states they have. **Concrete visual styling — the actual color values, type scale, spacing numbers — is intentionally DEFERRED** and will be derived from cannibalized sources (the v1 dashboard, already SvelteKit + Tailwind v4, plus other harvested UIs). Token *roles* and the system *structure* are defined here as placeholders; their values come later (see §6 and §15). No mockups, no component code, no `frontend-design` pass yet.

## References (inputs)

| Doc | What it constrains here |
|-----|--------------------------|
| `PRODUCT.md` | jobs (1–10), the two pillars, success bars, "no hardcoded data", analytics-first |
| `ARCHITECTURE.md` | §4 page set, the one SSE event stream, harness layer, gates/confirm |
| `DATA-MODEL.md` | the entities each screen renders + their states (status enums, soft-archive) |
| `DECISIONS.md` | D-005 (SvelteKit 2.x + Svelte 5 runes + Tailwind v4), D-011 (session control), D-010/D-018 (config edit = diff+confirm), D-019 (graceful degradation), D-024 (gates fail-closed / `permissions.deny`), D-025 (loopback/local) |
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
9. **Both pillars get equal UI surface.** The harness pillar (Claude Code control, config, workflows, gates) is designed with the same weight and screen real estate as the lifecycle pillar (projects, tasks, roadmap, releases) — neither is a second-class afterthought to be eroded later.

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
│  switcher  │  · token/cost ticker · orchestration mode     │           │
└────────────┴─────────────────────────────────────────────┴───────────┘
```

- **Sidebar** (collapsible): global nav + project context switcher + project tabs. Active item highlighted.
- **Top bar**: breadcrumb (context), a **live-status pill** (orchestration mode: event/periodic/manual + running-agent count), command-palette trigger, and the **connection state** indicator (green live / amber reconnecting / grey offline — D-019 made visible).
- **Status bar** (bottom, persistent): services up/down, active agent count, running token/cost ticker, orchestration mode. The "always-on awareness" strip.
- **Right tray** (slide-over, not pinned by default): notifications + recent activity feed (transient). Keeps the main region focused; opens on demand or on new high-severity event. A **"see all"** link opens the durable incidents/notifications history view (§6 `/reports`) for per-item detail + acknowledge.
- **Main region**: page content. Single scroll owner; sub-panels scroll independently only where necessary (e.g. a transcript pane).

Density: desktop-first. Comfortable default; an optional compact mode (tighter rows) for data-heavy tables. (Mode is a token toggle, §4.)

---

## 4. Design tokens — structure (VALUES RESOLVED → [DESIGN-SYSTEM.md](./DESIGN-SYSTEM.md))

Tailwind v4, CSS-first via `@theme` (D-005). This section defines the token **roles**; the concrete **values are now delivered** — a dark teal/slate system (accent `#8ab0ab`, bg onyx `#03120e`, **Lastik** sans + **JetBrains Mono**) in **[DESIGN-SYSTEM.md](./DESIGN-SYSTEM.md)** + the CSS in [`docs/design-system/`](./design-system/) (D-034). The §15.1 blue seed is **superseded** by this system. Roles below still govern; values fill them 1:1. A palette swap is one file.

**Color roles** (semantic, not literal):
- Surface: `--color-bg` (app), `--color-surface` (panels/cards), `--color-surface-raised` (popovers/modals), `--color-border`.
- Text: `--color-text` (primary), `--color-text-muted`, `--color-text-inverse`.
- Accent: `--color-accent` (primary actions/active nav), `--color-accent-muted`.
- **Status** (load-bearing — used consistently everywhere): `--color-running`, `--color-success`, `--color-warn`, `--color-error`, `--color-idle/neutral`, `--color-info`, plus a dedicated `--color-blocked` (blocked is central to constrained-autonomy, §1.7 — give it its own role rather than reusing `--color-warn`, even if values coincide initially). These map to the entity status enums in DATA-MODEL per the table below.
- Agent-tier accents: `--color-tier-local | -haiku | -sonnet | -opus` (so the fleet view reads tier at a glance).

**Status enum → color-role map** (covers every DATA-MODEL enum; status is never color-only — always paired with icon/label per §9):

| Entity (DATA-MODEL) | Enum value | Color role |
|---------------------|-----------|------------|
| `task` (§4.2) | `backlog` | `--color-neutral` |
| | `ready` | `--color-info` |
| | `in_progress` | `--color-running` |
| | `review` | `--color-info` |
| | `blocked` | `--color-blocked` (load-bearing for gate blocks) |
| | `done` | `--color-success` |
| | `failed` | `--color-error` |
| `session` (§4.3) | `running` | `--color-running` |
| | `done` | `--color-success` |
| | `failed` | `--color-error` |
| | `cancelled` | `--color-neutral` |
| `service` (§4.7) | `running` | `--color-running` |
| | `stopped` | `--color-idle/neutral` |
| | `crashed` | `--color-error` |
| | `unknown` | `--color-neutral` |
| `release` (§4.1) | `planned` | `--color-neutral` |
| | `active` | `--color-running` |
| | `shipped` | `--color-success` |
| `security_finding` severity (§4.9) | `low` | `--color-info` |
| | `medium` | `--color-warn` |
| | `high` | `--color-warn` |
| | `critical` | `--color-error` |

**Type scale**: `--font-display` = **Lastik** (brand, license-gated — D-034) for headings/titles/brand ONLY; `--font-body` = `--font-mono` = **JetBrains Mono** (OFL) for ALL non-heading text (operator directive, task 14.1 — mono body app-wide for this control-plane app). Role-named sizes 2xs 11 → 4xl 48 (base 14). Mono is first-class — transcripts, record ids, paths, SurrealQL, numerics. (Values: DESIGN-SYSTEM §4.)

**Spacing / radius / elevation / motion**: 4px spacing scale, radius xs–pill, dark-UI elevation (borders over shadows), motion 80/140/240/420ms with `--ease-out` and a `prefers-reduced-motion`→0ms path that keeps the end-state. Row-enter (opacity+translateY+blur, bounce:0) is implemented in `tokens/base.css`. (Values: DESIGN-SYSTEM §5.)

> **Values resolved (D-034).** Concrete hex/px/ms live in [DESIGN-SYSTEM.md](./DESIGN-SYSTEM.md) + [`docs/design-system/tokens/`](./design-system/tokens/). Roles here ↔ values there are 1:1; the status-enum→role table above is realized by the DESIGN-SYSTEM §3.5 status hues (incl. `--color-blocked` = rust).

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
| `TaskList` / `TaskCard` | backlog/board of tasks | per-status styling bound to DATA-MODEL's 7 task statuses (backlog/ready/in_progress/review/blocked/done/failed, §4.2); empty; optimistic update |
| `RoadmapView` | releases → phases → features/sprints | release planned/active/shipped · phase todo/in_progress/done · feature planned/in_progress/done/dropped |
| `KnowledgeGraph` | memory + entity nodes & typed edges | empty, loading, node-focus, hover-edge, archived/superseded (dimmed) |
| `MemorySearch` | semantic + keyword recall, ranked | query, ranked results w/ rationale + citation id, empty, archived/superseded (dimmed) |
| `ConfigEditor` | view/edit `.claude/*`, `.mcp.json`, CLAUDE.md | view, dirty, **diff + confirm** (mandatory), validation error |
| `CatalogList` | agents/skills/MCP/hooks discovered | per-scope (project/global), empty |
| `WorkflowBuilder` / `RunView` | define steps + watch a run | draft, running (per-step state), done/failed |
| `ReportChart` / `TimelineChart` | analytics over time + breakdowns | loading, empty, data, anomaly-flag |
| `RoutingRationale` | why this provider/model (inline) | shown on a run/task |
| `FindingsList` / `MaintenancePanel` | maintain-pillar surface: `security_finding` rows + dependency-health + UX-inspection results, grouped by severity | empty, loading, finding rows by severity; actions: acknowledge / dismiss / convert-to-task |
| `ServiceRow` | one service health + actions | running/stopped/crashed/unknown |
| `Markdown` | render docs/plans/CLAUDE.md | — |
| `GateBanner` / `ConfirmDialog` | surface a gate block / require confirm | warn (soft) / block (hard) |
| `ConnectionState` | SSE live indicator — a primitive USED BY `TopBar`/`StatusBar`, not a standalone page region | live / reconnecting / offline |
| `EmptyState`, `ErrorState`, `Skeleton` | the honest-state primitives | — |

Primitives: from bits-ui (button, dialog, table, tabs, select, tooltip, badge, etc.) — styled via the §4 tokens. Keep custom components < 200 lines (carry v1 rule); extract sub-components past that.

> *Historical note:* `KnowledgeGraph` was called `BubbleGraph` in v1. The v1 alias is dropped — no other v2 doc uses it; the canonical name is `KnowledgeGraph`.

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
- List: searchable/filterable `project` cards (ecosystem badges, status, open-task count, last activity). Action: open, register-new. **"register-new" = trigger the scanner / pick a path under `CODE_ROOT`** (job 1) — a single path-pick + scan, **NOT** a multi-step onboarding wizard (consistent with §13 no-onboarding).
- Project tabs:
  - **Overview** — plan macro (purpose/vision/role/DoD), current release, open tasks, recent sessions, health. Includes a **Maintain** panel (the per-project "/security-equivalent view" ROADMAP 3.1 promises — no separate `/security` page) rendering `FindingsList`/`MaintenancePanel`: `security_finding`s + dependency health + UX-inspection results for this project.
  - **Tasks** — `TaskList` board by status; create/edit; per-task routing rationale + linked sessions.
  - **Roadmap** — `RoadmapView`: releases→phases→features→sprints.
  - **Sessions** — history of this project's Claude Code sessions; open one → `TranscriptView` + `SessionControls`. The transcript view includes an **injected-context / wakeup-briefing panel** (ARCHITECTURE §2.6, ROADMAP 2.12–2.16): the session-start briefing's items shown with their retrieval **rationale + citation id + salience band** (analytics-first, §1.4) — so the operator sees *what* was injected and *why*.
  - **Memory** — project-scoped `MemorySearch` + `KnowledgeGraph`.
  - **Release** — release pipeline (dry-run/test/changelog/version/tag/publish) driven as a workflow run; changelog.
  - **Settings** — project config, model routing override, test command, gate config.

**`/agents`** — pool/tier/usage analytics **LENS** (aggregate, tier-centric): pool, live `AgentFleetGrid`, usage analytics (per-tier cost/duration), catalog of available agents.
- "Pool" renders tier **DEFINITIONS** + usage stats from `agent_slot` — a config/stat mirror, **NOT** live allocation. Liveness comes from running `session` rows via `AgentFleetGrid`, **never** `agent_slot.busy` (avoids F-008).
- Contrast with `/claude-code` fleet (below), which is the live session-**CONTROL** surface (session-centric: interject/stop/resume). Both render the same `AgentFleetGrid`, parameterized by scope.

**`/chat`** — multi-provider chat (PRODUCT §6.1: multi-provider chat + carry-forward convenience); session list + `TranscriptView`; provider/model picker; project scope selector. (Open question §14: whether this later merges into `/claude-code`.)

**`/memory`** — global `KnowledgeGraph` explorer + `MemorySearch` (hybrid recall, ranked, with rationale + citation id). Node focus → details + neighbors. Read-only on archived/superseded (shown dimmed).

**`/reports`** — analytics dashboards: routing decisions, cost over time, outcomes, escalations, **daily rollups + anomaly flags** (trend-aware, not raw event lists). Filter by project/time/model.
- **Maintain rollup**: a global, portfolio-wide `FindingsList` rolling up `security_finding`s + dependency health + UX-inspection results across all projects (complements the per-project Maintain panel in each project's Overview; PRODUCT job 4 / ROADMAP 3.1–3.3). Keeps IA tight — no separate `/security` page.
- **Incidents/notifications history** (durable surface): a list/history view of `incident`/`notification` rows — the durable counterpart to the transient right-tray + Home feed. Per-item detail + acknowledge action. Gate-denial and anomaly incidents land here. (Reachable from the right tray's "see all"; see §6 right tray.)

**`/services`** — `ServiceRow`s for Ollama / SurrealDB / engine: status, logs (streamed), start/stop/restart. Loopback/local only (D-025). The **dashboard** appears status-only (self-reported) — it can't start/stop itself.

**`/claude-code` — harness hub** (the control surface):
- Session **fleet**: all running/recent CC sessions across projects, live; open → transcript + interject/stop/resume.
- **Config manager**: per-project + global view/edit of hooks, skills, agents, MCP servers, `settings.json`, permissions, `CLAUDE.md` via `ConfigEditor` — **every write is diff-and-confirm** (D-010); validation before save (e.g. permission-rule syntax). Filesystem-authoritative; show "synced / out-of-sync (edited on disk)" state.
  - **Config round-trip evidence (PRODUCT v0.2 acceptance):** beyond the file-write + "synced" badge, surface that a config change was **actually read by a real CC session** — e.g. a "loaded config @ &lt;time&gt;" indicator on the session/transcript view. This gives the v0.2 bar ("edit read by an actual CC session") a concrete UI affordance, not just a write confirmation.
- **Catalog**: discovered agents/skills/MCP/hooks (project + global), read-only.

**`/workflows`** — list + `WorkflowBuilder` (steps, deps, parallel) + `RunView` (live per-step state, links to each step's session). Run history.

**`/settings`** — general; routing (tiers, escalation/delegation, intent→config); model slots (local + cloud); orchestration mode (event/periodic/manual + interval); memory (embedding, decay knobs); API keys (`.env`-backed, never shown in full); gate config defaults; **feature-flag page-visibility toggles** (PRODUCT §6.3 carry-forward — gives the staged §12 page rollout a home).
- **Write semantics differ by target.** App settings here (`config/*.yaml`, `.env`) follow **validate + save** (no mandatory diff; API-key fields are never shown in full). This is distinct from Claude Code filesystem config (`.claude/*`, `.mcp.json`, `CLAUDE.md`) edited via `ConfigEditor` in `/claude-code`, where **D-010 diff + confirm is mandatory**.

---

## 7. Real-time / live-update UX (the core interaction)

One SSE stream feeds all live regions (ARCHITECTURE `events` bus → one SSE fan-out, §2.11).
- **Transcripts** stream token-by-token in `TranscriptView`; tool calls render as inline cards; a tool call needing confirmation (gate) **pauses** with a `ConfirmDialog` (interject is possible mid-stream via `SessionControls`).
- **Task/session/service status** updates in place (row re-tints, fleet grid animates a new/finished agent) — no full-page reload.
- **Metrics/cost ticker** in the status bar increments live as `agent_event`s arrive.
- **New rows** fade/slide in (subtle motion; respects reduced-motion).
- **Connection loss** (D-019): the `ConnectionState` flips to "reconnecting", live regions freeze at last-known with a subtle dimming + timestamp ("as of …"); on reconnect, re-sync. Never blank, never fake-live.
- **Optimistic mutations under disconnect:** an optimistic UI update (e.g. moving a task, sending an interject) that is **not confirmed by the server within the disconnect window rolls back** to last-known server state — or is shown as "pending — unconfirmed". It is **never rendered as applied** until the server confirms (honest-state rule, §1.3).
- **Fail-closed gate while server down (D-024):** a Claude Code `permissions.deny` block still surfaces in the UI via the **runtime transcript stream** — the denial arrives as a `tool_result` in `TranscriptView` — even when our own gate-telemetry event (the `GateBanner` path) never fires because the server is down. The operator still sees the block happened.
- Live regions use ARIA live semantics for a11y (§9).

**Motion model** (cannibalized: `design-motion-principles` + `motion-dev`, both MIT — see foundry):
- **Frequency gate — decide IF before HOW.** Occasional events may animate; high-frequency live updates (sub-second metric/ticker churn) get an instant transition or none. Never spring-*bounce* a frequently-repeating update — the #1 motion-slop tell, and it tires fast. Use `bounce:0` springs / custom ease-out for enters.
- **Enter ≠ exit.** New rows enter `opacity 0→1` + `translateY ~8px→0` + `blur 4→0` (spring ~0.45s, `bounce:0`); removals use a subtler/faster exit. Wrap streamed/conditional content so enters+exits actually run (an un-animated `{#if}` is a motion gap).
- **GPU-only + interruptible.** Animate only `transform`/`opacity`/`filter`; prefer state-driven CSS transitions over keyframes so a fast stream blends instead of queueing; cap ~10–15 concurrent.
- **Reduced-motion is mandatory and keeps the end-state.** `prefers-reduced-motion` collapses durations to ~instant but still lands on the final visible state — never leave a row stuck at `opacity:0`.
- **Svelte 5 impl (stack note):** drive Motion's framework-agnostic `animate`/`stagger`/`scroll`/`inView` from `use:` actions / `$effect` on raw DOM — there is **no** React `<motion.div>` in Svelte. Keep named spring presets (gentle/snappy/critical) in a `motion-tokens` module so streaming rows, fleet grid, and hovers feel consistent.

---

## 8. State & feedback patterns

- **Loading**: `Skeleton` placeholders shaped like the content (not spinners) for initial loads; inline shimmer for refreshing rows.
- **Empty**: `EmptyState` with a one-line explanation + the primary action ("No tasks yet — create one"). Never an empty void.
- **Error**: `ErrorState` with the real error + a retry; for partial failures, degrade the affected panel only, not the page.
- **Stale/disconnected**: dim + "as of <time>" badge (§7).
- **Optimistic update**: apply locally for snappiness, but if unconfirmed within the disconnect window, **roll back to last-known server state** or mark "pending — unconfirmed" — never leave it shown as applied (§7, honest-state §1.3).
- **Unknown**: literally render "unknown" / "—", never a fabricated value (F-008).
- **Confirmation**: destructive or config-mutating actions (config write, stop agent, delete) require explicit confirm; config writes show a **diff** first (D-010). Gate blocks surface a `GateBanner` explaining what was blocked and why (D-018).
- **Toasts + tray**: transient success/info as toasts; durable items in the right tray.

### 8.1 Chart design (analytics surfaces — `ReportChart` / `TimelineChart`, §6 `/reports`)

Cannibalized (`mckinsey-viz`, MIT — **logic only, NOT** its light/serif/boardroom look, which conflicts with this dark dense tool):
- **Chart by data-question, deterministically.** Map the metric's shape → chart: timeseries→line, delta→bar/bridge, breakdown→stacked, ranking→sorted bar or `ReportTable`, milestones→timeline, positioning→scatter. Make "which chart" a function, not a taste call.
- **Asserted-conclusion titles.** Title states the finding ("Routing cost fell 38% after escalation tuning"), not the topic ("Cost over time") — compute from the data delta.
- **Two-role color.** One accent (the subject) + muted/grey for the rest, mapped onto §4 dark tokens. No rainbow per-series palettes.
- **Data-ink discipline.** Hairline 1px gridlines, direct value labels over axis-reading, a persistent annotation slot for the so-what; no shadows/gradients on marks.
- **Chart a11y** (see §9): `role="img"` + `aria-label` + hidden data-table fallback; series readable without color; CVD-safe.

---

## 9. Accessibility

- Contrast meets WCAG AA (enforced once concrete colors land, §15).
- Full keyboard nav: every action reachable; visible focus rings; command palette as the keyboard backbone.
- Live regions (transcripts, status) use `aria-live="polite"` so updates are announced without stealing focus.
- `prefers-reduced-motion` disables slide/fade for live updates.
- Mono/numeric data aligned; status never conveyed by color alone (pair with icon/label).

**Frozen acceptance criteria** (from the `impeccable` anti-pattern set — enforced at the §15 visual pass + the v1.0 gate, §12):
- Body text contrast ≥ 4.5:1; large/UI text ≥ 3:1 (WCAG AA). No light-gray-for-elegance — muted text must still meet ratio on *its* surface, not just on white.
- No AI-slop tells: no purple/pink gradients, no gradient text, no icon-tile-above-heading, no `01/02/03` section markers, no cream/beige default background (this app is dark-first regardless).
- Density discipline (§1.5 calm density): don't nest cards; flatten with spacing / dividers / type hierarchy. Hold nav ≤ ~7 top items, form groups ≤ ~4 fields, metric rows ≤ ~4 — working-memory caps.
- UX copy: verb+object button labels; no buzzwords; errors quote the real message (§11). Status words == data-model enums.

**A11y acceptance criteria** (cannibalized: `accessibility-agents`, MIT — these replace "enforced later"):
- **Live regions for SSE/streaming.** One always-mounted `aria-live="polite"` region at app root (never conditionally rendered); stream status, toasts, result counts announced via a debounced (~500ms) `announce()` using `textContent`; transcript = `role="log"`; fatal stream errors = `role="alert"`. *Verify: starting a stream + a toast each produce exactly one SR announcement.*
- **Data-viz a11y.** Every chart: `role="img"` + descriptive `aria-label` + a visually-hidden `<table>` fallback; series distinguishable without color; CVD-safe palette ≥3:1 adjacent (§8.1).
- **Contrast + focus CI gate (dark theme).** A CI job runs a WCAG-luminance check over the `@theme` `:root`/`.dark` token pairs; fail build on text <4.5:1 / large <3:1 / UI+focus-ring <3:1. `:focus-visible` = two-color ring ≥2px @3:1 on the dark surface; bare `outline:none` lint-banned.
- **Keyboard + WCAG 2.2 numerics.** Interactive targets ≥24×24px; composite widgets (tab strips, grids, filter toolbars) arrow-key operable via roving tabindex; SPA route change moves focus to the new `h1`/`main`; skip link is first focusable; reflow to single column at 320px (tables/charts exempt).

---

## 10. Responsive

Target = local **desktop** (the single operator's machine). Design to a comfortable min width (~1280) with graceful reflow down to ~1024 (sidebar collapses, right tray overlays). **Mobile/tablet is out of scope** for v2 (matches single-operator, local-first). Don't spend design budget on small screens.

---

## 11. Content & voice

Terse, technical, honest. Labels are nouns/verbs, not marketing. Numbers carry units. Errors quote the real message. Status words match the data-model enums exactly (running/done/failed/blocked…), so UI vocabulary == system vocabulary.

**Microcopy rules** (cannibalized: `ux-writing-skill`, MIT):
- **Buttons** = verb + object, sentence case ("Start run", "Stop agent", "Save config") — never "OK / Submit / Click here".
- **Errors** = `[what failed]. [likely cause]. [recovery]`, blame-free, no raw codes: "Couldn't save config. Connection lost. Reconnect and retry." (pairs with the real message surfaced in §8).
- **Empty states**, three subtypes: first-use ("No projects yet — register one"), user-cleared ("All caught up"), no-results ("No tasks match 'blocked' — clear filters"). Never an empty void.
- **Success** = past tense + specific ("Config saved", "Agent stopped"), proportional to stakes (minimal for routine; full confirm for destructive — §8).
- **Unknown/outage** = name it, reassure, give a status action — never fake-cheerful, never a fabricated number (§1.3, F-008).
- Tone adapts to the operator's state (frustrated → calm/direct; confident → minimal); **voice stays constant** (terse-technical-honest). Run user-facing strings through the 4-standard pass: Purposeful → Concise → Conversational → Clear.

---

## 12. Build/design order (maps to ROADMAP)

Design the screens in release order, not all at once:
- **v0.1**: app shell (sidebar/topbar/statusbar), `/projects` + Overview, `TranscriptView` + a manual-run view, `/claude-code` read-only catalog. (Minimum to "register a project + watch one CC session".)
- **v0.2**: `/agents` fleet + `SessionControls`, `TaskList`/board, `/memory`, `/reports` (rollups **+ anomaly flags**, ROADMAP 2.x), `ConfigEditor` (read-write, diff+confirm) **+ config round-trip "loaded config @ <time>" evidence**, `/workflows`, `/chat` (multi-provider chat, PRODUCT §6.1), `GateBanner` + gate views (D-018/D-024), the **injected-context / wakeup-briefing panel** on the transcript view (or explicitly defer it — see below), `/settings` feature-flag page-visibility toggles.
- **v0.3**: Release tab pipeline, `/services` actions, the **Maintain surface** (`FindingsList`/`MaintenancePanel`: per-project Overview panel + global `/reports` rollup — the "/security-equivalent view", ROADMAP 3.1–3.3), incidents/notifications history view.
- **v1.0**: polish, consolidation, the cannibalized visual pass (§15).

> **Session-injection / wakeup-briefing surface (ROADMAP 2.12–2.16) — decision:** surface it as the injected-context/briefing panel on the session transcript view (items + rationale + citation id + salience, analytics-first), slotted in **v0.2** above. If a build phase chooses to defer it, that must be noted explicitly with a reason — it is not silently dropped.

---

## 13. Out of scope (this doc / this phase)

- Concrete color/type/spacing **values** (deferred — §15).
- Pixel mockups / hi-fi comps (none yet — will sketch/harvest later).
- Component implementation code (no `frontend-design` pass yet).
- Mobile/tablet layouts.
- Marketing/onboarding/auth surfaces (single-operator, none).
- **Background/groundwork tables have no dedicated UI in v2** — `retrieval_outcome` (D-022 groundwork), `work_item` (D-021 background queue), and `process` (pid registry) are intentionally **not** surfaced as their own screens. They feed other views (analytics, service health) but get no dedicated page. This is deliberate, not an oversight.

---

## 14. Open questions

- Right tray: slide-over vs. an optional pinned column on wide screens? (lean slide-over.)
- Compact-density mode: global toggle vs. per-table? (lean global token.)
- Does `/chat` merge into `/claude-code` later, or stay separate? (keep separate for now.)
- Graph viz library/approach for `KnowledgeGraph` at scale — defer to build.

---

## 15. Visual styling — RESOLVED ([DESIGN-SYSTEM.md](./DESIGN-SYSTEM.md))

**Done (D-034).** The concrete look is delivered — an operator-built dark teal/slate system (accent `#8ab0ab`, onyx bg, **Lastik** + **JetBrains Mono**, three-layer tokens), captured in [DESIGN-SYSTEM.md](./DESIGN-SYSTEM.md) with the source CSS in [`docs/design-system/`](./design-system/). It fills the §4 roles 1:1 (incl. `--color-blocked` + tier accents) and implements §7 motion + §9 focus.

The original deferral plan is superseded:
- ~~Harvest v1's `@theme`~~ — moot (v1 was a placeholder; the operator delivered an original system, not on this branch anyway).
- **Remaining build-time steps:** run the **impeccable** AA/contrast gate over the token pairs (esp. the near-hue accent vs running, §9), port the React component primitives to Svelte 5, and **provision the Lastik webfonts WITHOUT committing them** (license D-034 — woff2/woff only, gitignored, single-operator). See DESIGN-SYSTEM §8.

### 15.1 Cannibalized design inputs (harvested 2026-06-06) — SUPERSEDED by DESIGN-SYSTEM.md

> **Historical / provenance.** The blue `ui-ux-pro-max` seed below was the *placeholder* before the operator delivered the actual teal/Lastik system (DESIGN-SYSTEM.md). It is **not** the final palette — kept only to record where the seed came from. **`impeccable` is still the live a11y/contrast gate** (last paragraph). The **JetBrains Mono** choice carried through; the sans went to **Lastik** (not IBM Plex), and the accent went **teal `#8ab0ab`** (not blue `#3B82F6`).

Two design skills were studied via the `cannibalize` foundry; they powered the seed + gate. **Use them, don't reinvent.**

**SEED (superseded) — `ui-ux-pro-max`** (license: repo `src/` is MIT → liftable; its `cli/` is CC-BY-NC-4.0 → **do not** lift, v2 may go commercial). Closest reference rows for this app (product register: dense, dark, keyboard-driven):
- **Developer Tool / IDE** *(primary lens)* — dark + minimalism, blue focus, **monospace + functional typography**, command palette, keyboard shortcuts. Maps to §1.6 / §3 / §4 (mono first-class).
- **Financial + Analytics Dashboard** *(data-dense screens)* — dark bg, red/green status alerts, real-time number animation, drill-down. Maps to §4 status-enum roles + §7 live updates.

Candidate **starting** tokens to reconcile against v1's existing `@theme` (step 1) — a seed, not final values:
- Palette (dark, status-bearing; lifted from rows 6/7/81, already WCAG-adjusted): bg `#020617` / panel `#0F172A` / raised `#1E293B`, border `#334155`, text `#F8FAFC`, muted-text `#94A3B8`, accent/focus `#3B82F6`, running/success `#22C55E`, error `#EF4444`, warn `#D97706`, info `#3B82F6`. Drops onto the §4 color roles + the status-enum→role table 1:1.
- Type: **JetBrains Mono** (`--font-mono`) + **IBM Plex Sans** (`--font-sans`) — the developer-tool pairing; satisfies §4 "mono is first-class."

**GATE — `impeccable`** (Apache-2.0). Run its deterministic anti-pattern detector + LLM critique pass as the QC step before the v1.0 visual sign-off (§12). Its bans are frozen into §9 as acceptance criteria. If installed as a plugin in this repo, invoke the skill; otherwise run the lifted detector from the foundry (`sources/impeccable`, no API key needed).

> These are *candidates to tune against v1's tokens*, per the deferral above — not a license to skip harvesting v1's own `@theme` (step 1). The skills seed and gate the pass; they don't replace it.
