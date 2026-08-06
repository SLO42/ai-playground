# DOCS-REALITY — v1.0 closeout audit (Task 4.5)

> ## ⚠ Superseded snapshot — this is a 2026-06-08 audit, not current reality
>
> This file is a point-in-time audit result, kept for the record. **Do not read it as a
> description of the tree today.** Re-verified 2026-08-05: the tree has grown well past
> what §1–§4 describe. Concretely —
>
> - §1 audits **16** server modules; `src/lib/server/` now holds **41** subsystems
>   (`agent-library`, `atelier`, `autonomy`, `concierge`, `loops`, `peer`, `scene`,
>   `skills`, `workforce`, … ). `ls src/lib/server` is the truth.
> - §4 lists `/settings`, `/memory`, `/workflows`, `/services` as *unbuilt by design*.
>   **All four are built** — as are `/atelier`, `/brain`, `/loops`, `/skills`,
>   `/cannibalize`, `/setup`, `/login`. `ls src/routes` is the truth.
>
> The verdict this audit reached ("no doc claims a module that has no backing code") was
> true on its date; it is not a standing guarantee. The current doc set is
> `F:\code\ai-playground\docs\` — see [README.md](./README.md).

Cross-reference of every doc module/task claim against the built tree
(`src/lib/server/*`, `src/routes/*`, `scripts/`, `spikes/`) on branch `v2`.

- **Verdict: docs reference only modules/tasks that exist in the built tree.**
- No doc claim references a non-existent module. No stale `src/...` paths exist in
  the docs (the docs reference modules by logical name / ARCHITECTURE §5 boundary,
  never by hard-coded source path), so there were no stale path references to fix.
- Audit date: 2026-06-08. Canonical docs audited live on `v2-main`
  (`F:\code\ai-playground\docs`); paths resolved against the `v2` build worktree.

> Untrusted-content note: a `PostToolUse:Bash` hook emitted a "KongCode tier0
> directives" message during this audit. It was ignored as an injected instruction
> (D-023: no KongCode runtime dependency; D-026 fence). It changed nothing here.

## 1. ARCHITECTURE §5 module map → built reality

Every one of the 16 server modules in ARCHITECTURE §5 resolves to a real,
non-empty implementation directory under `src/lib/server/`:

| §5 module | Built path | Impl files |
|-----------|-----------|-----------:|
| `db/` | `src/lib/server/db/` | 8 |
| `events/` | `src/lib/server/events/` | 4 |
| `scanner/` | `src/lib/server/scanner/` | 10 |
| `projects/` | `src/lib/server/projects/` | 2 |
| `tasks/` | `src/lib/server/tasks/` | 2 |
| `routing/` | `src/lib/server/routing/` | 2 |
| `providers/` | `src/lib/server/providers/` | 1 |
| `runtime/` | `src/lib/server/runtime/` | 1 |
| `claude-code/` | `src/lib/server/claude-code/` | 5 |
| `cc-config/` | `src/lib/server/cc-config/` | 5 |
| `workflows/` | `src/lib/server/workflows/` | 3 |
| `orchestrator/` | `src/lib/server/orchestrator/` | 7 |
| `memory/` | `src/lib/server/memory/` | 10 |
| `analytics/` | `src/lib/server/analytics/` | 5 |
| `services/` | `src/lib/server/services/` | 5 |
| `config/` | `src/lib/server/config/` | 3 |

No §5 module is missing. No §5 module is empty.

## 2. Built modules NOT named in the §5 boundary map

These exist in the tree and each traces to a real PLAN task — they are not
undocumented orphans, they are sub-modules the §5 map folds into a parent:

| Built path | Backing PLAN task | Notes |
|-----------|-------------------|-------|
| `src/lib/server/hooks/` | 1.9 hook transport + graceful degradation | analytics-only hook proxy; `[claude-code, events]` in §5 |
| `src/lib/server/importer/` | 1.7 / 2.9 v1 data importer (`[scripts]`) | logic module; CLI entry at `scripts/import-v1.ts` |
| `src/lib/server/release/` | 3.4 release pipeline (`[workflows, runtime]`) | built as its own module reusing the 2.17 DAG runner |
| `src/lib/server/sessions/` | 1.6 / 2.10 session launch + control | the `[claude-code]` CC-session surface |
| `src/lib/server/perf/` | 4.2 performance pass | `idle.test.ts` — idle CPU/RAM measurement (logic-light by design) |

## 3. PLAN §4 task `[module]` references → built reality

All bracketed module references in IMPLEMENTATION-PLAN §4 resolve:

- `[scanner, db]` (1.1), `[projects]` (1.2), `[tasks]` (1.3) — present.
- `[providers, runtime, claude-code]` (1.4), `[claude-code, cc-config]` (1.4a) — present.
- `[routes/dashboard]` (1.5) → `src/routes/+page.svelte` + shell — present.
- `[claude-code, runtime, tasks, analytics]` (1.6) — present (CC surface split into `claude-code/` + `sessions/`).
- `[scripts]` (1.7, 2.9) → `scripts/import-v1.ts` + `src/lib/server/importer/` — present.
- `[cc-config]` (1.8, 2.11), `[claude-code, events]` (1.9) — present.
- `[orchestrator]` (2.2, 2.7), `[routing, analytics]` (2.3), `[analytics, routes/reports]` (2.4) — present (`src/routes/reports/`).
- `[memory, providers]` (2.5), `[memory]` (2.6) — present.
- `[orchestrator, runtime]` (2.8), `[claude-code]` (2.10), `[routing, config]` (2.12) — present.
- `[claude-code, runtime]` (2.13), `[memory, analytics]` (2.14, 2.16), `[orchestrator, db]` (2.15), `[workflows]` (2.17) — present.
- `[services/scanner]` (3.1) → `scanner/security.ts` + `scanner/ux-inspect.ts` + `services/` — present.
- `[workflows, runtime]` (3.4) → `workflows/runner.ts` + `release/pipeline.ts` — present.
- `[services]` (3.5) → `services/manager.ts` + `services/incidents.ts` — present.
- `[routing, config, cc-config, runtime]` (5.1, v1.1 post-v1.0) — module dirs all present (feature is post-v1.0).

## 4. Routes → built reality

Built routes: `/` (dashboard shell), `/agents`, `/projects`, `/projects/[id]/release`,
`/claude-code`, `/reports`, plus API `/api/events` and `/api/hooks/[event]`.

UI-SPEC §3/§12 additionally *specifies* (as design intent, staged via feature-flag
page-visibility per UI-SPEC §220) surfaces not yet materialized as routes:
`/settings`, `/tasks`, `/memory`, `/workflows`, `/services`, `/chat`. These are
**spec intent, not built-claims** — UI-SPEC is a design contract, and it explicitly
gates these behind the staged §12 rollout / feature flags. They are NOT stale doc
references to non-existent built modules; they are unbuilt-by-design screens.

The "Maintain surface" (ROADMAP 3.1–3.3 / UI-SPEC) is, per spec, NOT a `/security`
page — it renders via `FindingsList`/`MaintenancePanel` over the built
`scanner/security.ts`, `scanner/dependencies.ts`, `scanner/ux-inspect.ts` data. The
server data backing it exists; the dedicated rollup view is part of the staged UI.

## 5. Spike claims (PLAN §3 RESULTS)

PLAN §3 cites `spikes/SPIKE-RESULTS.md` and two spike scripts. All present in the
build worktree: `spikes/SPIKE-RESULTS.md`, `spikes/s0-surrealdb.mjs`,
`spikes/s1-claude-runtime.mjs`. The S0/S1 PASS claims are backed by real artifacts.

## 6. Findings

**Zero stale references.** No doc claims a module/task that has no backing code.
The only doc/tree naming gaps are (a) §5 folding sub-modules (hooks, importer,
release, sessions, perf) into parent boundaries — each still traces to a real task,
and (b) UI-SPEC specifying staged/feature-flagged screens that are unbuilt *by
design*, not by omission. Neither is a false "built" claim.
