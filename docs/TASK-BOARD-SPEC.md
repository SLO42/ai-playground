# TASK-BOARD-SPEC — tasks as a first-class work surface: prompt-context first, then board + tags

> Drafted 2026-07-26 (planning agent, fresh-context; every `file:line` below verified by a direct
> read of `F:\code\ai-playground-v2` @ branch `v2` this session — briefing claims were re-checked,
> two corrections in §0). Operator intent: task tags/metadata exist *"to remind our models exactly
> why and how to handle each task"* — this is a PROMPT-CONTEXT feature first, a UI feature second,
> and the phases are ordered accordingly. Status: **SPEC — DRAFT, ready to build** (one operator
> confirm gated inside: sprint retirement, §8.2). Migration head at drafting time was `m0085`
> (`m0085_thinking_ledger` `schema.ts:3051`).
>
> **MIGRATION NUMBER — BUILT AS `m0087`, 2026-08-05 (this supersedes the allocation below).**
> P2 shipped `m0087_task_tags` (`schema.ts`, live db:up **87/87** on playground/v2). It took
> `m0087`, NOT the `m0088` allocated below, because CLAUDE.md's rule is to allocate from the LIVE
> head and the live head was still `m0086` — neither `m0087` nor `m0088` existed in code, so
> `m0088` would have left a permanent hole reserved for a spec that had not been built.
> **`MODEL-LADDER-SPEC` must therefore RE-ALLOCATE from the live head when it is built — its paper
> claim on `m0087` is void.**
>
> ~~**MIGRATION NUMBERS — ALLOCATED 2026-07-26 (do not renumber ad hoc).** `m0086` was CONSUMED by
> the shipped `m0086_boot_skip_ledger` (analytics-visibility AV-4, live db:up 86/86) while these
> specs were being written in parallel. Allocation now: **`m0087` → `MODEL-LADDER-SPEC`**,
> **`m0088` → this spec**.~~ The lesson worth keeping is unchanged and was proved twice: specs
> authored concurrently with builds race for migration ids, so a BUILD must allocate from the live
> head rather than honour a number a spec happened to reserve.

---

## 0. Corrections to the briefing (found during grounding — read these first)

1. **"`objective`/`purpose`/`acceptance_criteria`/`provenance` never reach the agent" is
   OVERSTATED for pm-origin tasks.** `composeDescription` (`projects/pm-proposals.ts:160-171`)
   folds all four §4.1 fields — including `provenance.kind` **and evidence ids** — into the
   immutable run-seed `description` of every PM-proposed task at propose time. Since
   `buildPrompt` emits the description (`runtime/index.ts:808`), a pm-origin task's why/how
   *does* reach the agent today, as a frozen prose blob. What is genuinely true:
   - **Every non-pm origin** (`manual|scanner|follow_up|review|release`) gets nothing beyond
     title+description — and the manual create path even defaults description to the title
     (`routes/projects/[id]/+page.server.ts:998`). 6 of the 23 live tasks are `manual`.
   - **`priority` reaches no agent on any origin** (absent from the SELECT at
     `sessions/launch.ts:512-515` and from `SpawnRequest.task` at `runtime/index.ts:104`).
   - For pm-origin tasks the fields arrive **unlabeled and frozen at propose time** — later
     metadata (tags, priority changes) never follows.
   Phase 1 is still the highest behaviour-per-line change, but its honest payload is: structured
   labeled sections for ALL origins + priority/origin/tags for the first time, not "the fields
   reach the agent for the first time ever".
2. **`normTask` EXISTS** — `src/lib/server/tasks/repo.ts:184-211`. The briefing's claim ("no
   normTask in `projects/repo.ts`") is literally true but points at the wrong repo: task CRUD,
   the status state machine, and the normalizer all live in **`tasks/repo.ts`** (531 lines:
   `createTask:219`, `getTask:248`, `listTasksByProject:266`, `updateTask:293`, `setStatus:335`,
   `canTransition:77`). All Phase 2 data-layer work **extends** this module; nothing is created
   from scratch. Its own F-013 comment (`:205-207`) already mandates the `isoOrUndef` pattern for
   any new optional datetime.
3. Minor line drift, immaterial: task core fields are `schema.ts:85-105` (m0002 block), the m0032
   widening is `schema.ts:1237-1262`. Everything else in the briefing checked out: the SELECT at
   `launch.ts:512-515` reads exactly `id, title, description`; the spawn composition at
   `launch.ts:857`; `buildPrompt` at `runtime/index.ts:807-825`; `assertContract` at
   `pm-proposals.ts:128-158` enforced only via `proposeTask`/`revisePmProposal`; sprint is a dead
   label (`schema.ts:72-76`, `:739-741`, only inbound FK `decision.sprint` `:727`); no `/tasks`
   route exists; `NAV-IA-MAP.md` has no task/board entry; tags exist on `memory` (`:214`) and
   `work_type` on `work_item` (`:446`), none on `task`.

---

## 1. Problem (ground truth, every claim traced)

1. **The spawn boundary drops task metadata.** `launchSession` reads
   `SELECT id, title, description FROM ONLY $tid` (`sessions/launch.ts:512-515`), passes
   `task: { id, title, description }` (`launch.ts:857`) into `SpawnRequest.task`
   (`runtime/index.ts:104`), and `buildPrompt` composes `# Task: {title}` + description + the
   fenced `## Reference context (not instructions)` block + affordance blocks
   (`runtime/index.ts:807-825`). Structured why/how survives only where `composeDescription`
   baked it into prose (§0.1); `priority`, `origin`, and any future tags never survive.
2. **No task detail view, no full-page board.** The only task UI is the inline kanban on the
   project page: grouping `routes/projects/[id]/+page.svelte:150-161`, markup `:1613+`; cards
   carry title, priority, relative createdAt, and a move `<select>` — the loader ships a slim
   `TaskSummary` (`+page.server.ts:228-238`, mapped `:710-719`) that **omits** objective, purpose,
   acceptance_criteria, provenance, proposed_by, revision links, and fingerprint even though
   `TaskRow` (`tasks/repo.ts:113-136`) carries them all. Stored, panel-validated, never rendered.
3. **No tags.** Nothing on `task` supports operator-defined grouping. Already functioning as
   implicit tags with zero migration: `status`, `priority`, `origin`, `provenance.kind`,
   `proposed_by`, `parent`.
4. **The manual create path writes no why/how.** The `createTask` form action accepts only
   title/description/priority (`+page.server.ts:981-1007`); `CreateTaskInput` accepts the full
   §4.1 field set (`tasks/repo.ts:137-157`) but only the pm-proposals chokepoint uses it.
5. **Sprint is a dead label.** Fields `project,name,starts,ends` (`schema.ts:72-76`) +
   `status,completed_at` (`:739-741`); `task` has no sprint FK; the only inbound FK is
   `decision.sprint` (`:727`). Live: 2 rows, both completed, `starts`/`ends` unset (source:
   `OPERATOR-REVIEW-2026-07-26.md` §10f — not independently re-queried this session). The project
   page still imports the full sprint CRUD surface (`+page.svelte:27-28,44,266`).
6. **Execution is already gated on promotion** — the fact the D-026 argument in §3.2 stands on:
   the orchestrator's task trigger fires only for statuses in `#spawnReady`, default `['ready']`
   (`orchestrator/orchestrator.ts:175,342,497-502`); `proposed` can transition only to
   `ready|withdrawn` (`tasks/repo.ts:63-76`), and the automated route into `ready` is exactly one
   function — `decidePanel` (`projects/pm-panel.ts:524`, all-approve branch calls
   `setStatus(db, task.id, 'ready')` at `:616`).

---

## 2. What this spec ships (one sentence each)

| # | Deliverable | Phase |
|---|---|---|
| 1 | `buildPrompt` emits labeled `## Objective / ## Why this task / ## Acceptance criteria / ## Task metadata` instruction sections for every task that carries the fields — three files, no migration. | **P1** |
| 2 | `task.tags: option<array<string>>` (m0087 — BUILT 2026-08-05), boundary-validated, editable, in the prompt's metadata line and the board's filters. | P2 |
| 3 | A full-page board at `/projects/[id]/tasks` with per-task detail (`?task=` panel), filters, and every stored field rendered — nav-reachable, no new nav entry. | P3 |
| 4 | The manual create path grows optional why/how fields + an honest context-completeness chip; sprint is explicitly retired (operator confirm). | P4 |

Non-goals: a second promoter (F-055 — `decidePanel` stays the only automated `proposed→ready`
writer); mutating `description` (D-008); a roadmap/timeline view (OPERATOR-REVIEW §10g, separate
spec); GitHub board sync (§10h, separate); cross-project global board (deferred, §9).

---

## 3. Phase 1 — task context reaches the executing model (ships first)

Three files: `src/lib/server/sessions/launch.ts`, `src/lib/server/runtime/index.ts`, plus tests.
No migration, no UI. Highest behaviour-per-line in the document.

### 3.1 The changes

1. **Widen the SELECT** (`launch.ts:512-515`):
   `SELECT id, title, description, objective, purpose, acceptance_criteria, provenance, priority,
   origin FROM ONLY $tid;` (all fields exist since m0032/m0002; `tags` joins in Phase 2). The
   `promptTask` branch (workflow steps, D-013) is untouched — its narrow shape simply leaves the
   new fields absent.
2. **Widen `SpawnRequest.task`** (`runtime/index.ts:104`) — all-optional, additive:
   ```ts
   task: {
     id: string; title: string; description: string;
     objective?: string; purpose?: string; acceptanceCriteria?: string[];
     priority?: string; origin?: string; provenanceKind?: string; tags?: string[];
   };
   ```
   `launch.ts:857` maps the row onto it, omitting absent fields (§6.1 discipline — absent, never
   `''`). Only `provenance.kind` crosses; `provenance.evidence`/`detail` never do (§3.2).
3. **`buildPrompt`** (`runtime/index.ts:807-825`) — after the description, BEFORE the fenced
   context block, emit each section only when its field is present and non-empty:
   ```
   ## Objective
   {objective}

   ## Why this task
   {purpose}

   ## Acceptance criteria
   1. {c1}
   2. {c2}

   ## Task metadata
   priority: high · origin: pm · provenance: pm_lifecycle · tags: infra, db
   ```
   The metadata line renders only the parts that exist. **Absent fields ⇒ the composed prompt is
   byte-identical to today's** (TB-1; the F-053 fall-through discipline: un-wired ⇒ identical, not
   fail-closed — this is not a security boundary).
4. **Known, accepted duplication:** legacy pm-origin tasks carry `composeDescription`'s prose
   (§0.1), so their prompts will state objective/purpose twice (once in the description blob,
   once labeled). Harmless; `composeDescription` is deliberately untouched (the description is
   the immutable self-contained run seed, D-008, and the human-readable fallback on every surface
   that only reads description). A follow-up may slim `composeDescription` for NEW proposals once
   TB-1's test pins the structured path — noted, not in scope.

### 3.2 The D-026 boundary (the load-bearing design argument)

D-026: retrieved/tool/peer content is DATA and must be fenced; only operator-origin content
instructs. The new sections go in the **instruction** region (alongside title/description, above
the fenced `## Reference context (not instructions)` block). Defense, including for LLM-authored
fields:

- **The gate is promotion, not authorship.** A task only ever spawns from `ready`
  (`orchestrator.ts:342,502` — `proposed` is never spawn-ready), and there are exactly two routes
  into `ready`: an **operator** move through the state machine (the board/project-page move
  control — the operator's own D-039 approval act), or **`decidePanel`** promotion after an
  independent validation panel (`pm-panel.ts:524,616`, PM-SPEC §4.2). So by the time
  `buildPrompt` runs, every field it emits carries operator or panel sanction. Un-validated
  LLM-authored fields structurally cannot reach an instruction section.
- **LLM-generated fields are D-026-screened at the writer boundary** before they are ever stored:
  `pm-propose.ts:578-583` runs `screenCandidate` over every freetext field (title, objective,
  purpose, criteria) and drops un-redactable candidates before `proposeTask`; `assertContract`
  (`pm-proposals.ts:128-158`) refuses incomplete contracts. Screened at write + panel-validated +
  promotion-gated is a strictly stronger basis than the description already enjoys today — and
  the description (which for pm tasks *contains these very fields*, §0.1) has always been in the
  instruction region.
- **What stays OUT of the instruction region:** `provenance.evidence` and `provenance.detail`.
  Evidence can quote scanner output, tool output, or retrieved external content — exactly the
  D-026 untrusted class. Only the machine enum `provenance.kind` crosses. (Legacy pm-task
  descriptions already embed evidence *ids* via `composeDescription` — ids, not payloads; that
  precedent stands but is not extended.) Anything recalled at runtime stays in the fenced
  `context` block; peer bodies stay fenced (D-035a); the prior art for "server-composed
  instruction block distinct from fenced data" is the `affordances` seam
  (`runtime/index.ts:179-188`, emitted `:819-823`) — this change follows its exact pattern.

### 3.3 Verification (Phase 1 DoD)

- New unit tests beside the runtime tests: (a) a `SpawnRequest` with all fields ⇒ composed prompt
  contains `## Objective`, `## Why this task`, each criterion, and the metadata line — **this is
  success criterion (a)**; (b) a request with none of the new fields ⇒ prompt byte-identical to
  the pre-change composition (TB-1, pinned string); (c) `provenance.evidence` present on the row ⇒
  the string never appears in the prompt (TB-2).
- A launch-path test (real-surreal, F-020) asserting the widened SELECT round-trips a row where
  the fields are SET (F-013 lesson: never test only the NONE case).
- Command: `npx vitest run src/lib/server/runtime src/lib/server/sessions` then the full green
  bar (`npm run build && npm test && npm run lint && npx svelte-check --threshold error`).

---

## 4. Phase 2 — tags (one additive migration + repo widening)

### 4.1 Migration `m0087_task_tags` (BUILT 2026-08-05 — took `m0087` from the live head, see §0)

```sql
DEFINE FIELD OVERWRITE tags ON task TYPE option<array<string>>;
```

- Idempotent by construction (OVERWRITE, F-015); apply-twice + half-applied covered by the
  generic `schemaMigrations` sweep in `migrate.test.ts` + targeted tests in
  `src/lib/server/tasks/tags.test.ts` (the half-applied case wedges a bare non-OVERWRITE `tags`
  field of the WRONG type, since `task` itself already exists from m0002).
- **`array<string>` on SCHEMAFULL is deliberate, decided once** (the m0086 precedent): the
  silent-nested-key-loss trap is specific to `array<object>`; a string array has no nested keys to
  lose, so SCHEMAFULL is both exact and enforcing (a non-string entry is REFUSED by the DB). A
  richer tag would need FLEXIBLE + a second migration and is explicitly not wanted (§10.3).
- **No index initially** — deliberate: live population is n=23 (§1.5 source), every board read is
  already project-scoped through `task_by_project`, and filtering happens client-side (§5.4).
  Revisit only if a measured need appears; a guessed index is a guessed claim.
- Mirrors the existing precedent `memory.tags` (`schema.ts:214`) — same type, same optionality.

### 4.2 Repo widening (`tasks/repo.ts` — extend, never fork; §0.2)

- `TaskRow.tags?: string[]`; `CreateTaskInput.tags?: string[]`; `UpdateTaskInput.tags?: string[]`
  (tags are mutable metadata — unlike `description`, D-008, which stays absent from
  `UpdateTaskInput` `:160-163`).
- `normTask` (`:184-211`): plain string pass-through; absent stays absent (honest, §6.1). No
  datetime added ⇒ no new `isoOrUndef` obligation (the `:205-207` comment rule stays satisfied).
- Boundary validation at the D-016 chokepoint in `createTask`/`updateTask`: trim, drop empties,
  lowercase-normalize, ≤8 tags, ≤32 chars each, reject anything else with a named error. All
  values `$param`-bound as today.
- Tag AUTHORSHIP this phase is operator-UI only (create form + detail editor, §5). PM-proposed
  tags would have to enter through the `proposeTask` chokepoint and its `screenCandidate` screen —
  explicitly out of scope, noted for a PM-SPEC follow-up.

**AS BUILT — two departures from the text above, both deliberate (2026-08-05):**

1. **The authoring path shipped WITH P2, on the existing inline board**, not deferred to P3's
   detail panel. §4.2 as written would have left the field unreachable: every one of the live
   tasks predates m0087, so with no editor none of them could ever be tagged and the feature
   would be shipped-but-unusable (a D-038 "purposeful/reachable" failure). What landed on
   `projects/[id]`: a **Tags** input on the create form, tag CHIPS on each card (rendered only
   when the row really carries tags — no placeholder), and a per-card `Edit tags` disclosure
   posting to a new `retagTask` action. `retagTask` writes ONE column through the existing
   `updateTask`; it adds no status-write path (TB-4) and cannot touch `description` (TB-5).
   Still deferred to P3: filtering by tag, and tags on the full-page board.
2. **`normalizeTags` also collapses INTERIOR whitespace** (`\s+` → one space), which §4.2's
   "trim, drop empties, lowercase" did not name. Reason: a tag is rendered into the ONE-LINE
   `## Task metadata` fragment, where a `##` mid-line is inert — but a NEWLINE inside a tag would
   move whatever follows it to the start of a line, which is where markdown block constructs
   become real. Collapsing closes that at the write boundary; `escapeBriefText` still covers it
   independently at the prompt layer (defence in depth — a legacy row never passed through the
   repo). Both legs are tested.
   De-duplication (first-occurrence order preserved) was likewise added: after lower-casing,
   `Infra`/`infra` are the same reminder, and duplicates do not consume the ≤8 budget.
- Phase-1 hook completes: `launch.ts` SELECT adds `tags`; the prompt metadata line renders them —
  success criterion (c)'s "part of the agent's context" leg.

### 4.3 Verification

- Real-surreal tests (F-020, in `tasks/repo.test.ts`): create-with-tags round-trip asserting the
  SET case; update-tags; validation rejections; tag filter query if any server-side filter lands.
- `npm run db:up` clean on the LIVE dev DB (idempotent, run twice) — the §5 data-layer DoD boxes.
- Command: `npx vitest run src/lib/server/tasks` + `npm run db:up` + green bar.

---

## 5. Phase 3 — the full-page board + per-task detail

### 5.1 IA placement (no orphan routes)

- Route: **`/projects/[id]/tasks`** — the board is inherently per-project (`task.project` is a
  required FK, `schema.ts:86`). Reached from the project page's tasks tab via a prominent
  "Open board ↗" link (project page is itself one click from nav item **Portfolio › Projects**),
  satisfying NAV-IA-MAP's reachability DoD (≤2 clicks from nav, plain-language label).
- **No new nav entry** — NAV-IA-MAP's own rule: "Default: extend an existing page + its nav
  item." `nav.ts` stays at 3 groups / 14 items. A cross-project `/tasks` under Portfolio is the
  flagged future candidate if multi-project triage becomes real (§9).
- `docs/NAV-IA-MAP.md` gains the row in the SAME wave (its update-with-the-wave rule):
  `| Task board + detail (TASK-BOARD-SPEC §5) | /projects/[id]/tasks | Projects › project › Open board | No — extends Projects | specced |`

### 5.2 Loader (`+page.server.ts`)

- `listTasksByProject` (`tasks/repo.ts:266`) already returns full normalized `TaskRow`s — the
  loader ships them whole (POJOs: `normTask` `str()`s every link and both datetimes, which carry
  non-NONE defaults; no devalue-500 exposure) plus per-task `moves` computed via `canTransition`
  exactly as `TaskSummary` does today (`+page.server.ts:715-716`). No new query shape ⇒ no new
  F-020 surface; one render-smoke test still required (§5.6).
- Detail = the SAME loaded rows; **`?task=<id>` opens a right-hand detail panel** (deep-linkable,
  no second loader, honest 404-state inside the panel when the id isn't in the list). A separate
  `/tasks/[taskId]` route is rejected for now: n≈23, one loader, one live surface.

### 5.3 Board page (`+page.svelte` — Svelte 5 runes, D-034 tokens)

- Columns by `TASK_STATUSES` with the `$derived.by` grouping pattern lifted from
  `+page.svelte:150-161`; honest empty columns ("—"), honest zero-state. `{@const}` only as an
  immediate child of `{#each}`/`{#if}` (F-011); runes only in `.svelte`/`.svelte.ts` (F-009);
  teal/Lastik tokens, no ad-hoc styling.
- Cards: title, priority, tags (chips), origin badge, relative createdAt (absent ⇒ '—', F-013),
  a **context-completeness chip** — `why/how n/3` counting objective, purpose,
  acceptance_criteria actually present (F-008: counts real fields, never fabricated).
- Live behaviour: same mechanism the inline board uses today (form actions + `use:enhance`
  invalidation). If the events/SSE stream already republishes `task` changes to this page's
  layout, subscribe; wiring a NEW push channel is out of scope — noted as a TODO, not silently
  faked.

### 5.4 Filters

Client-side `$derived` over the loaded rows: free-text (title), tag chips (AND), priority,
origin, status. Success criterion (c)'s "usable for filtering" leg. No server round-trip at this
population; the loader seam is where a server-side filter lands later if needed.

### 5.5 Detail panel + actions

- Renders EVERY stored field: description (read-only — D-008, never editable, labeled as the
  immutable run seed), objective, purpose, acceptance_criteria (checklist-rendered, display
  only), provenance (kind + evidence + detail — fine to DISPLAY to the operator; the D-026 rule
  constrains prompts, not operator-facing UI), proposed_by, revision_of/superseded_by (links),
  proposal_fingerprint (mono, truncated), created/updated, tags (editable), priority (editable),
  status (move buttons from `nextStatuses`).
- Actions reuse the existing repo functions only: `updateTask` (title/priority/tags),
  `setStatus` (every move passes the state machine — never a raw status write), `createTask`
  (the create form, §6.1). **No promote button and no new promotion path**: a `proposed` task's
  panel shows its verdict/brief state and links to the PM surface. The operator CAN still move
  `proposed→ready` via the standard move control — that path exists on the inline board today
  (`moves` from `canTransition`; `proposed: ['ready','withdrawn']`) and IS the operator's D-039
  approval act; the board preserves it without widening it (TB-4).

### 5.6 Verification

- Component/unit: grouping, filters, completeness chip, `{@const}` legality via `svelte-check` 0.
- Render-smoke (live-verify skill): board renders against the LIVE dev DB with real rows; empty
  and error states honest; detail panel opens via `?task=`; Playwright uses
  `waitUntil: 'load'` (F-010 — SSE streams hang `networkidle`).
- Command: `npm run build && npx vitest run src/routes/projects && npx svelte-check --threshold
  error` + the §5 live render check. NAV-IA-MAP row flips `specced → live` only on that render.

---

## 6. Phase 4 — manual-create completeness + sprint resolution

### 6.1 Manual creates: close the gap without a bureaucratic gate

The board's create form (and the project-page quick-add) gains a collapsible **"why & how"**
section: objective, purpose, acceptance criteria (one per line — same parsing as `pmRevise`,
`+page.server.ts:1919-1927`), tags. Wired straight through `CreateTaskInput`, which already
accepts them (`tasks/repo.ts:137-157`) — zero new repo surface.

**Decision — soft, not hard (success criterion (e): consciously accepted, with the reason):**
manual creates are NOT `assertContract`-enforced. Grounds:

- D-039's contract exists to make **agent-authored** work reviewable before it earns execution
  ("auto-created PM tasks born `proposed`… operator keeps approval"). A manual task is
  operator-authored: the operator IS the approval authority the gate protects. Forcing the §4.1
  ceremony on quick capture inverts the gate's purpose and kills the title-only capture flow the
  current form deliberately supports (`description || title` default, `+page.server.ts:998`).
- The cost of an incomplete manual task is now HONEST and visible instead of silent: the
  completeness chip (§5.3) shows `why/how 0/3`, the detail panel shows the empty fields, and the
  prompt degrades to exactly today's title+description behaviour (TB-1) — no fabricated context.
- Enforcement stays in exactly one place (`assertContract` via `proposeTask`/`revisePmProposal`) —
  a second enforcement site is the same F-055 smell as a second promoter.

Post-create backfill: the detail panel allows adding/editing objective/purpose/criteria on
**non-proposed** tasks only (backlog/ready/blocked). On `proposed` tasks these fields are
PM-owned and change ONLY through `revisePmProposal` (successor row, contract re-enforced,
verdicts closed 'revised' — `+page.server.ts:1896-1943`); an edit affordance there would bypass
the revise loop (F-055). Create-with-AI founding tasks (the known un-promotable defect) can pass
§4.1 fields through this same widened path — flagged as a follow-up for the create pipeline, not
built here.

### 6.2 Sprint: retire it (operator confirm required)

**Recommendation: retire.** Evidence: no `task.sprint` FK exists anywhere; the only inbound FK is
`decision.sprint` (`schema.ts:727`); both live rows are completed with `starts`/`ends` unset —
never time-boxed in practice; and this spec's tags + board filters cover the grouping need
sprints never actually served. The rejected alternative — make sprints real with a `task.sprint`
FK + time-boxing — would be building a planning-cadence feature with zero demonstrated usage; the
genuine future-axis need is the roadmap/timeline gap (OPERATOR-REVIEW §10g), a separate spec.

Retirement mechanics (deliberately non-destructive):
1. Remove the sprint create/complete UI from the project page (`+page.svelte:27-28,44,266` and
   the associated markup/actions) — the only operator-visible surface.
2. `sprint` table and `decision.sprint` stay — no destructive migration, existing rows and the FK
   remain readable (mark-never-delete spirit).
3. `projects/repo.ts` sprint CRUD (`:716-753`) stays as dead code with a dated
   `// RETIRED (TASK-BOARD-SPEC §6.2)` header comment; removal is a later cleanup TODO.
4. `docs/DECISIONS.md` gets the retirement recorded **by the operator** (only the operator locks
   decisions); until that confirm, this phase ships items 1–3 behind the confirm and the spec
   status stays "sprint: proposed-retired".

### 6.3 Verification

Command: `npx vitest run src/routes/projects src/lib/server/tasks` + green bar + a live render of
the project page proving the sprint panel is gone and the create form's why&how round-trips onto
a real row (SET-case assertion, F-013).

---

## 7. Migrations (one, additive)

| id | DDL | notes |
|---|---|---|
| `m0087_task_tags` (BUILT 2026-08-05; see §0) | `DEFINE FIELD OVERWRITE tags ON task TYPE option<array<string>>;` | Idempotent (F-015); apply-twice + half-applied via the generic sweep + targeted tests in `tasks/tags.test.ts`; **no index** (deliberate, §4.1); `npm run db:up` live-verified twice — **87/87**, second run applied nothing. |

No other schema change in this spec. Phases 1, 3, 4 are migration-free.

---

## 8. Invariants (TB-N — each testable; red-team these)

| ID | Invariant | Pinned by |
|---|---|---|
| TB-1 | A task with none of the new fields composes a prompt **byte-identical** to the pre-change output; `promptTask`/workflow spawns unchanged. | runtime test with pinned expected string |
| TB-2 | Only `title`, `description`, `objective`, `purpose`, `acceptance_criteria`, `priority`, `origin`, `provenance.kind`, `tags` may enter the prompt's instruction region. `provenance.evidence`/`detail`, recalled context, and peer bodies stay fenced (D-026/D-035a). | prompt test asserting an evidence string never appears unfenced |
| TB-3 | Instruction-region task fields are always promotion-sanctioned: nothing spawns from `proposed` (`#spawnReady={'ready'}`), and `proposed→ready` happens only via `decidePanel` or an operator move. | orchestrator trigger test + state-machine test (`canTransition`) |
| TB-4 | `decidePanel` (`pm-panel.ts:524`) remains the ONLY automated promoter; the board adds no promote action and no new status-write path — every move goes through `setStatus` (F-055). | grep-gate: no `status` write outside `tasks/repo.ts`; UI review |
| TB-5 | `description` is never mutated by any board/detail surface (D-008); §4.1 fields on a `proposed` task change only via `revisePmProposal`. | `UpdateTaskInput` shape test + action tests |
| TB-6 | Every new/changed query has a real-surreal test asserting the SET case; every optional field renders '—'/absent, never a fabricated value (F-013/F-020/F-008). | tasks/repo + loader tests, live db:up |
| TB-7 | m0087 is idempotent: apply-twice and half-applied both converge (F-015). | migrate sweep + targeted test |
| TB-8 | Tag values are boundary-validated (≤8 × ≤32 chars, trimmed, lowercased) and `$param`-bound (D-016); tags are operator-authored only until a screened PM path exists. | createTask/updateTask validation tests |
| TB-9 | The board route is reachable from a nav parent in ≤2 clicks and `NAV-IA-MAP.md` is updated in the same wave — no orphan route. | NAV-IA-MAP row + live render check |
| TB-10 | The completeness chip counts only fields that actually exist on the row — never inferred, never backfilled (F-008). | component test |

---

## 9. Phased build (each independently shippable)

| Phase | Scope lock (files) | Ships alone? | Verification command |
|---|---|---|---|
| **P1 prompt-context** | `sessions/launch.ts`, `runtime/index.ts`, their tests | Yes — no migration, no UI; success criterion (a) lands here | `npx vitest run src/lib/server/runtime src/lib/server/sessions` + green bar |
| **P2 tags** ✅ BUILT | `db/schema.ts` (m0087), `tasks/repo.ts` + `tasks/tags.test.ts`, `launch.ts` (SELECT + mapping), `runtime/task-brief.test.ts`, `projects/[id]/+page.{server.ts,svelte}` + `task-tags-action.test.ts` | Yes — shipped with an operator authoring path (§4.2 note), so tags are usable before P3 | `npx vitest run src/lib/server/tasks` + `npm run db:up` ×2 + green bar |
| **P3 board+detail** | `routes/projects/[id]/tasks/` (new `+page.server.ts`, `+page.svelte`), one link in the project page tasks tab, `docs/NAV-IA-MAP.md` | Yes — reads P2 fields when present, renders honest '—' otherwise | build + `svelte-check` 0 + live render (F-010 `waitUntil:'load'`) |
| **P4 create+sprint** | board/project-page create forms + actions, sprint UI removal, `projects/repo.ts` comment | Yes — gated internally on the operator's sprint confirm | `npx vitest run src/routes/projects` + green bar + live render |

Order is binding: P1 first (operator's stated purpose), P2 next (completes the prompt payload),
P3/P4 after. Deferred beyond this spec: cross-project `/tasks` triage board; PM-proposed tags
through a screened path; SSE push channel for the board if the existing invalidation proves
insufficient; slimming `composeDescription` for new proposals; Create-with-AI founding-task §4.1
wiring; the roadmap/timeline axis (§10g).

---

## 10. ASSUMED (unanswered)

1. **Sprint retirement is the operator's call** (§6.2) — this spec recommends retire and stages
   the work behind that confirm; if the operator instead wants sprints real, the `task.sprint`
   FK + time-boxing becomes a new small spec (it is NOT hidden inside this one).
2. **Live population figures** (n=23; field counts; 2 sprint rows) are taken from
   `OPERATOR-REVIEW-2026-07-26.md` §10f (same-day audit), not re-queried this session — a build
   wave touching the live DB re-checks them for free during `db:up` live-verify.
3. **Tag vocabulary is free-form** (validated shape, no curated enum). Assumed intentional — the
   operator's purpose is reminding models, not taxonomy; a curated vocabulary can layer on later
   without migration (same column).
4. **The events/SSE bus** may or may not already republish `task` changes to a subscribable
   layout stream; P3 subscribes if the seam exists and otherwise keeps the enhance/invalidate
   behaviour of the inline board — it does not wire a new channel (honest TODO, §5.3).
