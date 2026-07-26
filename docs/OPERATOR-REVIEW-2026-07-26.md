# Operator review — 2026-07-26

**Status:** findings ledger, grounded. Every claim below traces to a `file:line` or a live
read-only DB query performed during the review. Produced by scout agents against v2 HEAD
`0ee313b` with the dev server up, while the operator walked the running dashboard.

**Why this doc exists:** the operator reviewed the live app and raised eleven separate
observations. Rather than scatter them across queue rows, they are recorded here once with
their evidence, and the queue rows point back. Several turned out to be the *same* defect.

---

## 0. The theme

Five of the eleven observations are one defect wearing different costumes: **the UI renders
the weakest field it can reach.** In every case the meaningful value is already in the row or
one join away.

| what the operator saw | actual cause |
|---|---|
| ~30 identical `code-write` chips | label degrades to `intent` when `session.role` is null |
| `agent sonnet 1` in the memory scene | label *is* the raw pool-slot id (F-046 leaking into the UI) |
| `role:probe_fit_1781894354268` | label degrades to a raw record id when the role is deleted |
| `recall —` on every hiring row | the numbers exist one FETCH away, never joined |
| `unknown` tier · `$0.00` cost | tier never stamped at write; cost *coverage* never disclosed |

Consequence: this is one cross-cutting naming/labelling spine plus a few joins — **not** five
card patches. See §7 for the split between what a render helper fixes and what needs the write
path corrected first.

---

## 1. Dead space below the app shell

**Symptom:** a large empty region below the content on any page taller than the viewport.

Three `<legend class="sr-only">` (`agents/+page.svelte:748-749`) are styled `position:absolute`
by a page-local `.sr-only` (`:1428-1438`). `.shell` (`+layout.svelte:216`) and `.content`
(`:228`) are both `position:static`, so those legends resolve against the **initial containing
block**, not the shell — and `overflow:hidden` on a static ancestor cannot clip an abspos
element whose containing block is above it.

Measured live: `innerHeight` 861 · `body.scrollHeight` 861 · `documentElement.scrollHeight`
**1316** — exactly the bottom of the last legend. Forcing them `position:static` → 861;
restoring → 1316.

**Not a regression.** `git blame` → `bb6af37` (2026-06-13). `532b35a` added 233 lines to
`/agents`, pushing the legends lower and *enlarging* the gap without causing it. Shell-wide:
`/settings` shows 97px of the same (`settings/+page.svelte:177,290,442`, local `.sr-only` at
`:884`).

**Fix:** one declaration — `position: relative` on `.content` (`+layout.svelte:228`). Closes the
whole class. Verified safe against the in-flow Statusbar (`Statusbar.svelte:53`) and Sidebar
(`Sidebar.svelte:55`), the four `position:fixed` overlays (CommandPalette / ConfirmDialog /
RightTray / ToastHost — `relative` never captures `fixed`), and the only full-height canvas
(`projects/[id]/graph`, itself `fixed`). No stacking context created (no z-index set).
Secondary: the duplicated page-local `.sr-only` blocks should defer to `base.css:76`.

---

## 2. The `granted to` chip wall

**Symptom:** `TOOL-ALLOW Edit used · 21 calls` followed by ~30 identical `code-write` chips.

Not duplicate data. `usage.ts:376-383` folds grants into a `Set<string>` of session ids and the
`{#each}` keys on `ref.sessionId` (`agents/+page.svelte:1046`) — each chip is a genuinely
distinct session. The defect is the LABEL: `refLabel()` (`agents/+page.svelte:161-165`) prefers
`roleId` → falls back to `intent` → session-id tail, and `session.role` is unset on these rows,
so all 30 collapse to the intent slug `code-write` (`config/orchestration.yaml:113`).

Discriminating fields are already loaded and discarded — `SessionRef` (`usage.ts:69-82`) carries
`sessionId` / `taskId` / `roleId` / `intent`, and **`taskId` is rendered nowhere** despite being
the most useful discriminator. `started_at` is already in the projection (`usage.ts:297-299`)
but dropped in `refById` (`:310-315`), so adding it costs no SELECT change (no F-020 risk).

**Fix:** group by label with a real count (`code-write ×30`), collapsed by default, expandable
to distinct sessions showing `taskId` + `startedAt`, preserving the drill-through link. Applies
to every granted row across all five dimensions (`skill|agent|mcp|reserved|tool-allow`) and the
`used by` chips (`:1092-1100`) — one component pattern, fix once.

---

## 3. Naming: purpose, not tier

**Operator rule (now standing):** a display name must convey PURPOSE, never just tier / model /
slot / id. Recorded to memory as `feedback_names-must-convey-purpose`.

**The node the operator saw** — `agent:sonnet-1` — is a **pool slot id**, not a name.
`scene.ts:496-505` synthesizes one agent node per distinct `session.agent` with
`label: agent` (`:501`) — no fallback chain, the label *is* the raw stored string. That string
comes from `launch.ts:563` (`agent: input.agentId`) ← `boot.ts:325` `agentForTier(pool, tier)`
← `boot.ts:215-220`, returning `pool.slots[0].id` (the `id: opus-1 / tier: opus` entries in
`agent-pool.yaml`); default `DEFAULT_AGENT = 'opus-1'` (`harness/wiring.ts:325`).
`schema.ts:2432-2436` states the tradeoff outright. This is **F-046 leaking into the UI** — the
scene clusters 26 unrelated sessions under one "agent" that is really a tier bucket.

Live: `session.agent` distinct = `null` ×145 · **`sonnet-1` ×26** · `atelier_self` ×3 ·
`opus-1` ×2 · `pm_review_identity` ×1.

### Fallback inventory (worst-first)

| file:line | names | chain | worst case |
|---|---|---|---|
| `scene.ts:501` | scene agent node | *(none)* — raw slot id | `sonnet-1` |
| `scene.ts:208-213` `jobLabel()` | scene session node | `kind → work_type → 'session'` | `session: task` for every session |
| `MemoryScene.svelte:718` / `NodeInspector.svelte:96` | legend + inspector | renders `n.label` verbatim | `session` ×N + untruncated ULID |
| `agents/+page.svelte:818` | hire/cert actor | `role_slug → role` (raw link) | `role:probe_fit_1781894354268` |
| `staffing-proposal.ts:374,397` · `resolution.ts:865` · `panel.ts:375` · `repo.ts:711,834` · `recruiter-hire.ts:171` | role, across workforce | `role.name → raw id` | raw record id |
| `agents/+page.svelte:161-165` | tool-grant attribution | `roleId → intent → id tail(8)` | `a3f9c2b1` |
| `+page.svelte:250-262` · `agents/+page.svelte:853` · `projects/[id]/+page.svelte:2986` · `claude-code/+page.svelte:337` · `workflows/+page.svelte:224` · `RightTray.svelte:301` | fleet/session cards | **no name field at all** — model + `id.slice(0,8)` | `a3f9c2b1` |
| `atelier/timeline.ts:211,264-269,328` · `inbox.ts:161-163` | turn/handoff/inbox actor | `role tail → "session <tail>"` | `session 01k9…` |
| `project-controls-core.ts:86` | restartable session | `roleName → roleSlug → kind → 'agent run'` | `agent run` |
| `client/scene/scene-graph.ts:392` | scene event subject | `label → kind → work_type → ref tail → '—'` | `job fired —` |

Two systemic classes: **raw `role:` record ids** across workforce, and **content-free
`session`/id-tail** everywhere else.

### What naming data exists (live, n=177 sessions)

| field | schema | populated |
|---|---|---|
| `session.agent` | `schema.ts:2444` | 32/177 (18%) — and it is a slot id |
| `session.role` | `schema.ts:1216` | 34/177 (19%) |
| `session.specialist` | `schema.ts:2467` | **0/177 (0%)** |
| `session.granted_intent` | `schema.ts:2352` | 70/177 (40%) |
| `session.task` | `schema.ts:123` | 90/177 (51%) |
| `session.note` | `schema.ts:953` | 82/177 (46%) |
| `task.title` | `schema.ts:89` | **23/23 (100%)** |
| `role.slug/name/purpose` | `schema.ts:1064-1066` | **8/8 (100%)** |
| `cc_agent.description` | `schema.ts:391` | **table EMPTY — 0 rows**; no session FK |

**The joint distribution is the answer.** Of the 32 agent-bearing sessions: 26 have a task,
28 have an intent, **0 have a role, 0 have a specialist**. Sample row:
`sonnet-1 / code-write / "Unblock 1 stalled task(s)"`.

### Root cause — one write path, one omission

`launch.ts:548-574` is the **only** `CREATE session` (all 8 callers funnel through
`launchSession`). It stamps `agent`, `specialist`, `model`, `task` — but **never `role`**, by
design: `schema.ts:2433-2434` and `launch.ts:560` both note "role is stamped LATER by workforce
activation." Live data shows that later stamp **never fires for orchestrator-drained spawns**
(0/32). `specialist` is 0/177 because only the gated manual-launch seam passes it
(`launch.ts:569`) and nothing calls it.

### Fix, split honestly

**(a) Render-time — solves the operator's named case today.** 26/32 agent sessions have
`task.title` (100% populated where present) and 28/32 have `granted_intent`; a composer can
produce `code-write · Unblock 1 stalled task(s) · sonnet-1` right now. One shared helper —
`sessionDisplayName()` / `agentDisplayName()` / `roleDisplayName()` — in a new
`src/lib/shared/naming.ts` (shared: both server projections and `.svelte` call sites need it).
Order: `role.name → role.slug → specialist → task.title → granted_intent → kind`, with the slot
id demoted to a **qualifier suffix, never the identity**; plus `stripRecordId()` turning
`role:probe_fit_178…` into `probe_fit`.
Prerequisite: `scene.ts:286` selects only `id, kind, status, project, task, agent, started_at`
— it must also select `granted_intent` and fetch `task.title` before `jobLabel` (`:208`) and the
agent-node builder (`:496-505`) can compose anything.
Adopters: every row in the inventory table above.

**(b) Write-time — required, or (a) is an 18%-coverage patch.** No migration needed; the fields
exist.
- `launch.ts:548-574` — stamp `role` at CREATE instead of deferring to workforce activation
  (0/32 on the drain path today). **This is the root defect.**
- `launch.ts:569` — `input.specialist` is never supplied by `orchestrator.ts:1195-1203` or
  `boot.ts:325`; wire the routed specialist through.
- `boot.ts:215-220` + `agent-pool.yaml` — a slot should carry a `purpose`/`name` alongside
  `tier`, so `session.agent` stops being a tier bucket (F-046).

**Honest split:** the memory-scene case is ~80% fixable at render time. The broader family is
not — 145/177 sessions carry no agent, 0 carry a specialist, `cc_agent` is empty; for those rows
a render helper can only honestly produce `—`. Do (b) first for anything spawned going forward.

---

## 4. Usage by tier — fable-5 already leaking into `unknown`

**There is no model→tier map at all.** `agent_event.model.tier` is a verbatim caller-supplied
string (`events.ts:63-67`; schema `option<string>` at `schema.ts:189`).
`routing/resolve.ts:262` writes `chosen: input.override` unchanged — if the override carries no
tier, the tier is NONE forever. (The staffing path at `:298` at least conditionally spreads one.)

Live proof: `routing_event` grouped by method → `method:'explicit'` has `chosen.tier = null` for
**claude-fable-5 (n=4)** and **claude-opus-4-8 (n=7)**, while every `method:'classify'` row has a
tier. The 8-run / 68.5k-token `unknown` bucket is exactly this.

**The `$0.00`:** real arithmetic over a dishonest denominator. The opus bucket is 18 rows —
**2 priced** (Σ $0.000570 → `$0.00`), **16 NULL** (they predate the CG-1 pricing chokepoint,
`events.ts` `resolveCostUsd` + `config/pricing.yaml:23-35`). Presented as the cost of
"9 runs / 20.2k tok". F-008 one layer up: a **coverage** lie, not a value lie.

The uncommitted AV-4 WIP (`analytics/estimated.ts` + `EstimatedSpendLeg{spendEstimatedUsd,
estimatedRowCount}` threaded through `rollup.ts:332,401`, `provider-usage.ts`,
`project-usage.ts`, `index.ts`, `reports/+page.server.ts:126-139`) discloses
**estimated-vs-measured**. It does **not** disclose **priced-vs-unpriced**, which is the gap
behind `$0.00`. No `.svelte` renders the new legs yet.

**Derivable today with no new writes**, all already in the `rollup.ts:364-366` projection:
tokens-in vs tokens-out split (computed, then summed away at `+page.svelte:381`), cost per 1k,
completions-vs-spawns ⇒ completion rate (`type` is selected; only spawns counted at `:398`),
estimated share. p50/p95 needs only keeping the duration array instead of `_durSum/_durN`
(`:402-405`). Needs adding to the SELECT (F-020): **`model.model_id`** (highest value — ends the
`unknown` opacity), `at` (trend), `detail.intent`, `session` ⇒ distinct sessions. Elsewhere:
`ProviderUsage` already has `sessions/completions/errors/childSpawns`
(`provider-usage.ts:26-51`, SELECT `:109-111`) for a local-vs-cloud split;
`routing_event.method/complexity/alternatives` (`schema.ts:171-175`) for explicit-vs-classified.

**Model coverage gaps:** `agent-pool.yaml:11-23` has no `fable` tier and pins `opus` to
`claude-opus-4-8` (escalation order `:45`); `pricing.yaml:23-35` has neither `claude-fable-5` nor
`claude-opus-5*`, so their `cost_usd` is NULL by design. The real fix is `resolve.ts:262` —
derive tier from model_id on the explicit path. **No model_id→tier function exists; one must be
written**, config-driven off `agent-pool.yaml`. → superseded by `MODEL-LADDER-SPEC.md`.

---

## 5. Hiring & certification activity

The card reads the **new AV-1 ledger** — `role_event` narrowed by `HIRE_LIFECYCLE_OPS`
(`repo.ts:1196`, ops at `repo.ts:89-98`), rendered at `agents/+page.svelte:798-834`, loaded at
`agents/+page.server.ts:145`. That is the correct source: `scene_event` holds 500 rows with
**zero** hire kinds (495 `job_fired`, 3 `job_done`, 2 `pm_review`).

**Why every row says "Gauntlet scored":** live `role_event` totals are `created` 18,
`interviewed` 36, `fixture_activated` 36. `HIRE_LIFECYCLE_OPS` excludes `created` and
`fixture_activated`, so the feed is *exactly* the 36 `interviewed` rows. Every op AV-1 added
(`gauntlet_started`, `adjudicated`, `reversioned`, `candidate_considered`, `hired`,
`hire_rejected`) has **0 rows** — no gauntlet or hire has run since `532b35a` landed (newest
ledger row 2026-06-19). The label map (`+page.svelte:35-43`) is correct, just unexercised.
Not a filter bug, not hardcoding.

**`recall —` is honest (F-008), not dropped.** `+page.svelte:77-83` needs
`detail.planted_found`/`planted_total`; all 36 rows carry the pre-wave flat `{run, status}`.
But the numbers exist: all 36 `interview_run` rows have `planted_total`, `planted_found`,
`false_positives`, `pass_criteria`, `results`, `ambiguous` (`schema.ts:1100-1136`), and the
ledger row already stores the pointer in `detail.run`. **One FETCH away.**

**Raw ids are 3 of 36**, not junk — dangling-role fallback (`repo.ts:1198` → null, rendered
`ev.role_slug ?? ev.role` at `+page.svelte:819`): `probe_fit_1781894354268`,
`rtprobe_hire_1781892363650`, `ph2_live_1781892016151`. The other 33 belong to 7 real roles
(recruiter, researcher, investigator, qa-lead, security-officer, code-reviewer,
design-reviewer). One live residue role remains: `role:gq3glfee2zcw993suhto` /
`qa-hire-1781734448505`. **Fix is better labels, not hiding rows.**

### The chain, and where it breaks

| stage | table | rows | UI | break |
|---|---|---|---|---|
| draft | `role_version` (`schema.ts:1080`) | 15 | ceremony | `created` excluded from `HIRE_LIFECYCLE_OPS` — the ceremony's first act is invisible |
| fixtures | `gauntlet_fixture`/`gauntlet_key` | 35/35 | ceremony | no link from the feed |
| run | `interview_run` | 36 (8 passed / 19 **error** / 7 failed / 2 adjudicating) | ceremony renders **only `adjudicating`** (`ceremony/+page.server.ts:60-120`) | **34 finished runs hold full evidence with no UI anywhere** |
| scoring | `role_event.interviewed` 36 + `panel_verdict` 12 | | this card | flat detail; panel verdicts unsurfaced |
| adjudication | `adjudicated` | 0 | — | pre-wave gap |
| re-version | `reversioned` 0; `role_version.lifecycle` has 6 `failed` | | ceremony | 6 failures left no ledger row |
| hire | `decision_brief` 2; `hired`/`hire_rejected` 0 | | — | 2 briefs, zero ledger trace |

> **Flagged separately: 19 of 36 interview runs are `error` status.** Not investigated in this
> review; worth its own look.

**Fix needs no new writes:** join `interview_run` on `detail.run` in the loader (gives recall,
FP count, tier, model_id, pass criteria, status for all 36 today — removes every `recall —`);
group the 36 rows by run into ~15 ceremony threads instead of a flat list; link each to
`/agents/ceremony?run=…` and extend that page past `adjudicating`; render dangling roles as
"deleted role (probe)" with a filter; add `created` as a "ceremony opened" tier.
D-042's prior art `role_version` is intact — the *ledger* was the missing piece, and now exists
but is unexercised.

---

## 6. Adjudication queue — already automated; the queue IS the residual

`auto-adjudicate.ts` (349 lines — `classifyAmbiguousItem` / `planAutoAdjudication` /
`autoAdjudicateRun`) is **built and wired**: into the HR campaign (`recruiter.ts:267`) and as a
pre-pass on the operator path (`ceremony/+page.server.ts:764-778`); the loader reuses the same
classifier for per-item recommendations (`:188-195`) — the pre-selected radios in the UI *are*
its recommendations. Clear cases only, escalate-on-doubt, never auto-FP, never auto-confirm a
partial, notes tagged `[auto]`. BUILD-QUEUE rows `hr-recruiter` and `hr-adjudication-queue` are
both `done`.

**What adjudication is:** the deterministic scorer (`scorer.ts:254 scoreFindings`) greedily
assigns plant→finding; everything else queues to `interview_run.ambiguous` (`scorer.ts:216-224`)
as `partial_match` (`:300-311`) or `extra_finding` (`:334`), flipping status to `adjudicating`.
Verdicts (`gauntlet.ts:957`, applied ~`:975`): `confirm_hit` (legal only for a partial with a
plant id; credits full recall, **can flip fail→pass**), `false_positive` (counts against
`fp_tolerance`; **fails a role**), `dismiss` (moves no bar). Batch-or-nothing — hence "Resolve
all & finalize". §3.4 = `WORKFORCE-SPEC.md` adjudication; the snapshot pass bar is
`pass_criteria` (`:80`), a run-time copy of `config/workforce.yaml gauntlet.*` (`:175` —
`pass_recall: 1.0`, `max_false_positives: 0`), evaluated at `scorer.ts:373-397`. Never the live
config.

**Why the 2 remaining items escalate, by design:** deciding a PARTIAL_MATCH requires the plant's
detection criteria in `gauntlet_key`, which invariant **B3** forbids the adjudicator from reading
(`HR-RECRUITER-SPEC.md:26-38` — "`scorer.ts` remains the sole, confidence-blind, out-of-session
key reader… Auto-adjudication is a SEPARATE judgment layer over the AMBIGUOUS queue only"). So
`over-strict-key-draft` is *structurally* undecidable from stored data
(`auto-adjudicate.ts:142-166`). `fx-clean-control` is a clean-control fixture, so it falls
through to escalate (`:71-106,179-200`).

**Verdict on going further:** (a) fully manual is a regression. (b) advisory pre-fill is
**already delivered**. (c) widening auto-resolution requires relaxing B3 — not defensible today
without a locked operator decision amending it. (d) fully autonomous violates B4 + D-039
outright (a `confirm_hit` flips fail→pass; a `false_positive` fails a role) and D-035a (an LLM
verdict cannot self-stamp as an operator resolution).

**Real headroom, no decision change needed:** the `[auto]` resolutions are free-text notes in
`results`, not a versioned artifact trail. Under D-042 they should carry
`source:'hr_recruiter'` (already in the vocabulary) + a REASON link to the causing
`interview_run`. **The gap is audit formalization, not decision authority.**

---

## 7. Staffing & proposals — both correct empties

**Staffing** (`/agents/staffing` `+page.svelte:87` / `+page.server.ts:45-82`; project card
`projects/[id]/+page.svelte:2291-2303` / `+page.server.ts:579-587`) bottoms out in
`recommendStaffing` (`capability-match.ts:421`). Line **431** is the whole story:
`if (needed.length === 0)` → `candidates: [], gaps: []`, where `needed = needs.defect_classes`
(`:427`).

Live: `project` 4 rows, **every one has `capability_needs.defect_classes = []`**;
`review_proposal` 0; `project_staff` 0; `role_event` has zero `staffed`. The vocabulary is
*healthy* — `gauntlet_key WHERE author='operator'` = 28 rows across 16 classes
(`swallowed-error`, `gate-bypass`, `shadow-path`, …).

So: **correct empty**, not a bug and not an arming dependency — no PM/brain/heartbeat arming
would help. It fills when an operator declares `capability_needs.defect_classes` via
`setCapabilityNeeds` (`capability-match.ts:226-242`, enum-closed). `bepinexpack_rounds_port`'s 8
`proposed_defect_classes` are **by design never matchable** (D4 LOCKED,
`capability-match.ts:218-223`) — game-specific, outside the vocabulary. Empty-state honesty
PASSES (`+page.svelte:107-110`, project card `:2300-2302`).

**Proposals** (`projects/[id]/+page.svelte:2100-2116` → `listProposalQueue`
(`pm-panel.ts:1161-1172`) → `listTasksByProject(db, projectId, 'proposed')`): live `proposed`
tasks = **2, both on `project:atelier_self`** (provenance `task_blocked`, 2026-07-26T03:07Z).
`bepinexpack_rounds_port` has 16 tasks / 0 proposed. Genuinely populated where it should be.

> **One real honesty gap:** the whole card is wrapped in `{#if pm}` (`:2096`). Only
> `atelier_self` and `bepinexpack_rounds_port` have `pm` rows, so on `gv_live_demo` /
> `thunderstore` the Proposals card **does not render at all** — which reads as "missing", not
> "empty". F-008 applies.

---

## 8. The agent library is a display — Atelier does not use it

Three different things are called "agents". Keep them apart:

- **A. The library** (`/agents/catalog`) — a read-only disk index. `listLibraryAgents`
  (`agent-library/library.ts:163`) walks `.claude/agents/**/*.md` **recursively** (`:170`) in the
  main git worktree. **Never touches the DB.**
- **B. The `cc_agent` mirror** — a SurrealDB table (`schema.ts:387-393`, index `:412`) written by
  `syncScope` → `replaceChildren(db,'cc_agent',…)` (`cc-config/sync.ts:333`), scanned by
  `scanAgents` (`cc-config/parse.ts:269`). This feeds the D-036 allow-list (`sync.ts:829`).
- **C. `role`/`role_version`** (`schema.ts:1068-1098`) — the HR identity sessions actually run as.
  **No FK to `cc_agent`; bridged only by slug convention** (`agent-library/usage.ts:1-16`).

**It is a display.** Proof chain: no bundle in `config/orchestration.yaml` declares a
`capabilities` block (only the comment at `:132`), so the `agents` dimension is always empty;
`composeCapabilities` validates `agents` fail-closed (`runtime/capabilities.ts:230`) but the
result is then **stripped** — `capabilities` is in `HARNESS_ONLY_SETTINGS_KEYS`
(`claude-code/cli-backend.ts:68-72`, comment `:65` "harness metadata Claude Code does not
consume"); spawn argv (`cli-backend.ts:568-590`) has `--model/--settings/--mcp-config` and **no
`--agents`, no agent-type, no composed system prompt**. `session.specialist` is a provenance
label only (`sessions/launch.ts:90-100,569`) with **no writer anywhere in `src/`**.
`recommendAgentsForTask` is propose-only — advisory text for the concierge
(`concierge/concierge.ts:760-786`) and the catalog page
(`routes/agents/catalog/+page.server.ts:144`).

**Sync gaps:** synced scopes are per-project `<root>/.claude` (`sync.ts:379`), global `~/.claude`
(`sync.ts:37,580`), and the harvest scope (skills only, `sync.ts:534-542`). **The platform's own
`.claude` — where the library lives — is covered by no sync path** (`sync.ts:503-505`, the F-045
dead-end). Worse, `scanAgents` is **flat, non-recursive** (`parse.ts:269-286`) while all 113
library files sit in subdirectories — so even if the scope were registered, `cc_agent` would
mirror **zero** of them. (Live: `cc_agent` is empty, 0 rows; `cc_scope` has 4.)

**Updates:** on-demand only — `/claude-code` page load
(`routes/claude-code/+page.server.ts:159`) and spawn-time `freshenCatalog`
(`orchestrator.ts:1129`). `watch.ts` exists with **no production caller**. Sync is digest-driven
full REPLACE (`sync.ts:172-177`), so edits and deletions propagate — `facd9bf` was scope-level
so it covers agents equally, but only for registered scopes.

**Versioning: none.** `cc_agent` carries only scope/file_path/name/description/frontmatter/
category with a deterministic per-file row id (`sync.ts:111-113`) — a disk edit overwrites in
place with **no hash, no history, no source/reason/when**. Compare `role_version`
(`schema.ts:1080-1098`: `prompt_sha`, `source`, `lifecycle`, `activated_at`). **D-042 is unmet
for agent definitions.**

**Provenance risk:** `F:\code\ai-playground\.claude\agents` holds **113 `.md`, only 2
git-tracked** (`development/atelier-developer.md`, `development/rounds-mod-developer.md`); the
rest are gitignored (`.gitignore:6` `/*`). 65 mention `claude-flow`; frontmatter carries "NEW
v3.0.0-alpha.1 capabilities" → machine-generated by `claude-flow init`. `custom/` holds 11
hand-authored. So **~111 definitions are untracked third-party-generated files a tool re-run
would silently overwrite**, rendered by the library as if they were ours. **No decision covers
this.**

---

## 9. Loops have no topology — a modelling job, not a rendering one

`/loops` list (`loops/+page.svelte:73` `LoopList`, `:86` declared-but-not-running) and detail
(`loops/[identifier]/+page.svelte` — `LoopShape` `:108`, Snapshot `:111`, Declaration `:150`,
`LoopManageControls` `:166`, `LoopReadiness` `:177`, `LoopControls` `:183`, recent runs
`:188,:198`). No diagram anywhere.

`LoopShape.svelte` is the closest: an `<ol class="ls-strip">` of the six primitives with `→`
separators and a `↩` loopback glyph, plus the L1/L2/L3 ladder. Its own header comment
(`:8-11`): *"A bounded CSS/token visual (no viz lib) — a richer canvas is a follow-up."* It is a
checklist rendered as a line, **identical for every loop**.

**The blocker is data.** `m0072_loop_manifest` (`schema.ts:2513-2537`) stores
`project · identifier · kind · label · cadence · phase · enabled · checklist · override trio ·
timestamps` — **no nodes, no edges, no steps**. The only structure is `checklist`, six booleans
keyed by `loop-shape-core.ts:53-59` — a readiness declaration, not a topology. `schema.ts:2495`
says it plainly: *"Today loops are DERIVED only: getLoops() (loops/read.ts) synthesizes the
running loop families"*; the sequence lives in imperative code (`orchestrator.ts`,
`pm-autonomous.ts`, `loops/maintenance.ts`) and is never persisted. Runs are
`LoopRun {at, outcome, detailScreened}` (`read.ts:57-64`) projected from `agent_event`
(`read.ts:194`) — **no per-step transitions**, so nothing can highlight an active node.

**Reuse targets (both exist, no new dependency):** `LifecycleGraph.svelte` (1632 lines) +
`graph/layout.ts` (429) — hand-rolled SVG, causal-depth columns (`layout.ts:49,83-86`), bezier
edges with arrow markers, n8n-style cards via `foreignObject`, per-node popover; **no pan/zoom**,
static `viewBox` (`:391`). `MemoryScene.svelte` (1067) + `NodeInspector.svelte` — `d3-force` with
a full camera (pan / wheel-zoom / drag / fullscreen / click-inspect, `:148-255`). `package.json`
has only `d3-force ^3.0.0` and `motion` — **no flow/graph library**.
`LIFECYCLE-GRAPH-UX-SPEC.md:1,4` already names n8n as its visual reference.

**Docs state:** `LOOP-ENGINEERING.md:86-93` build order — GAME-VERIFY ✅, vocabulary ✅,
manifest ✅ (m0072), Loops UI ✅, readiness gate ✅ (`loops/arm-gate.ts`). **No loop topology or
node-graph is designed anywhere.** Manifest fields at `:89-90` are all scalars.

> **Do not conflate:** `LIFECYCLE-GRAPH-UX-SPEC.md` uses n8n as *styling* for
> `/projects/[id]/graph` (DONE). The queued `n8n-spec` item is about **authoring external n8n
> workflows** as a brain capability (spec-only, P5). **Neither is visualising Atelier's own
> loops.**

**Path:** (1) add `steps[]` + `edges[]` to the manifest — **needs a migration**, additive, the
`checklist` FLEXIBLE-object precedent applies; (2) emit a per-step runtime event so runs carry
transitions (extend `recentRuns`, `read.ts:194`); (3) render by generalising `graph/layout.ts` +
`LifecycleGraph.svelte`, optionally lifting `MemoryScene`'s camera. **Step 1 alone gets a static
diagram; live node highlighting requires step 2.**

---

## 10. Souls & graduation — shipped further than believed

Prior belief that the graduation-history table was deferred is **WRONG**. It shipped as
**`m0078_soul_graduation`** (`schema.ts:2796-2815`), and per-PM souls shipped too
(`COGNITIVE-ARCHITECTURE.md:262-278`).

**What a soul is:** a **compute-on-read projection**, never a persisted persona
(`memory/soul.ts:1-25`). `loadSoul(db, project?)` (`:375`) derives `SoulModel` (`:83-97`):
`maturityStage`, `knowsAbout` (dominant `concept` rows), `values` (correction memories —
"scars"), `competence` (retrieval utilization; honestly `null` below
`MIN_COMPETENCE_SAMPLE=20`, `:126/139`), experience counts, `gates[]`, `summary`. No traits, no
tenure. Only `screen_status="clean"` rows enter (D-026).

| entity | built? | evidence |
|---|---|---|
| Atelier (`self:atelier`) | ✅ | `scene.ts:58` `SELF_NODE_ID`; subject `"atelier"` (`soul-graduation.ts:34`) |
| per-project PM | ✅ | `loadSoul(db, projectId)` at `projects/[id]/+page.server.ts:680`; subject `project:<id>` (`soul-graduation.ts:213`) |
| hired workers / roles | ❌ | spec only — `PER-HIRE-SOUL-SPEC.md:3` "DRAFT (2026-07-07) · queued `per-hire-soul` (**gate:operator**)"; `BUILD-QUEUE.md:135` |

**Ladder:** `nascent → developing → established` (`soul.ts:42`), AND-combined thresholds
(`:109-123`) — developing = concepts≥5, corrections≥1, causalChains≥3, sessions≥10;
established = concepts≥25, corrections≥5, sessions≥50, competence≥0.85.

**Level computes live, but transitions ARE recorded:** `recordGraduationIfChanged`
(`soul-graduation.ts:173`) runs on the orchestrator fast-tier drain
(`orchestrator.ts:1709-1715`, both atelier and per-project), appending one row per boundary
crossing with a metric snapshot — fail-open, dedup-safe per subject, and records downward
regressions honestly (`soul-graduation.ts:18`).

**Where viewable:** `/brain` — soul card (stage chip, summary, experience grid, competence,
knows-about chips, learned values, next-gate evidence) **plus a "Graduation history" timeline**
rendering `from → to` + timestamp + snapshot (`brain/+page.svelte:112-208`), live via SSE on
`soul_graduation` (`:30`). Project page PM tab (`?tab=pm`) — `PmSoulPanel.svelte`, same shape,
project-worded (`projects/[id]/+page.svelte:1789`). Memory scene — `self:atelier` ringed by
stage; `NodeInspector.svelte:130-232` shows maturity/competence/gates (**Atelier only** — no PM
or role node). `/agents` shows a `v{version}` chip + `reversioned` role_event
(`agents/+page.svelte:413,111`) but no soul and **no version history**.

**Gap analysis:**
- **(a) Already works:** Atelier soul + graduation timeline; PM soul + timeline; identity in the
  scene; soul injected into concierge turns (`wire.ts:128`).
- **(b) Exists but invisible:** **`soul_graduation` is EMPTY on the live DB** (queried:
  `[{"result":[],...}]`) — every brain is `nascent`, so the timeline renders its honest empty
  state. The visualisation exists with nothing to plot. Also `role_version`
  lifecycle/`activated_at`/`retired_at` + `role_event` (reversioned/certified) are stored but
  never rendered as a trail — `NAV-IA-MAP.md:26` specs "Artifact version history + audit trail
  inline on /agents" as **specced, not built**.
- **(c) Genuinely missing:** hire souls entirely (SL-1..SL-4, gate:operator) and
  `hire_soul_event` transition history (`PER-HIRE-SOUL-SPEC.md:113-118`, "deferred fork").
  Transition history is **not** the gap for Atelier/PMs — built, unpopulated.

**Cheapest path to the operator's ask:** `role_version` + `role_event` already constitute a
de-facto, server-stamped hire graduation trail (D-042 prior art, `schema.ts:1077-1098`).
Rendering it on `/agents` needs **zero migration** — a reader plus a panel — and delivers "this
hire graduated" before the operator-gated `per-hire-soul` wave.

---

## 10b. Workflows — a naming collision at the root

`/workflows` (`workflows/+page.server.ts:28-74` → `listWorkflows`/`listWorkflowRuns`/
`getWorkflowRunDetail`, `workflows/repo.ts:274,293,319`) renders **one thing**: a persisted DB
entity. `workflow` (`schema.ts:421-427`: `name, project, steps, trigger, created_at`) executed
as `workflow_run` (`:429-437`); each step is a headless Claude Code run linked via
`session.workflow_run` (`runner.ts:135-160`).

**It is NOT the `.claude/workflows/v2-wave.js` build-wave scripts.** Those live in the *docs*
repo and no v2 code reads that directory (grep for `claude/workflows` returns only nav/schema/
test string hits) — they are run by the claude-flow host, invisible to Atelier. Skills/agents are
`cc_skill`/`cc_agent`, a separate surface again. So there is no "several things sharing a page"
problem; there is a **naming collision** — the operator's "workflows" and the page's workflows
are disjoint systems.

Source of truth is the DB only. Writer is `createWorkflow` (`repo.ts:174`), called from exactly
one production site: `release/pipeline.ts:166` (`createReleaseWorkflow`). **No disk scanner
exists**, so the `scanAgents` flat/recursive gap does not apply — the gap is worse: nothing on
disk is ever ingested. Live: **2 `workflow` rows** (`release v0.0-smoke` + a June-8 seed),
**3 `workflow_run` rows**, 2 linked sessions.

| # | need | verdict | evidence |
|---|---|---|---|
| 1 | what it does | **ABSENT** | no `description` field (`schema.ts:421-427`), only `name` |
| 2 | each step | **EXISTS-BUT-UNRENDERED** | `workflow.steps` FLEXIBLE `array<object>` (`schema.ts:673`) — a real validated DAG `{id, prompt, agent, model, cwd, depends_on, parallel}` (`repo.ts:39-52`), cycle-checked by `validateSteps` (`repo.ts:96`); `listWorkflows` projects only `stepCount` (`repo.ts:278-288`) |
| 3 | when called | **SHOWN BUT INERT** | `trigger` (`schema.ts:425`) rendered as a tag, but **no scheduler consumes `event`/`periodic`** (zero grep hits) |
| 4 | why called | **ABSENT** | `runner.ts:102-103` CREATEs with only `{workflow, status, step_state}` |
| 5 | how to use | **EXISTS-BUT-UNRENDERED** | per-step `prompt`/`agent`/`model`/`cwd` in `steps` |
| 6 | how many times | **EXISTS-BUT-UNRENDERED** | rows + index `wfrun_by_workflow` (`schema.ts:437`); no count computed |
| 7 | by whom | **ABSENT** | no actor/project on `workflow_run`; `projectId` is arg-only (`runner.ts:92`) |

**Better position than loops:** real nodes AND real edges are already persisted, so a step graph
is **pure rendering** over `graph/layout.ts:27-83` + `LifecycleGraph.svelte` (no new dep;
`package.json` has only `d3-force` + `motion`). Migration is needed only for the provenance half:
`workflow.description` + `workflow_run.{project, initiated_by, reason, trigger_source}`.

The `export const meta {name, description, phases}` block in `v2-wave.js:1` would supply needs
1/2/5 for a wave script for free — but only if a scanner existed, which it does not.

---

## 10c. Cannibalize — WHEN yes, WHAT half, LEARNED not at all

`/cannibalize` (nav `shell/nav.ts:52`, loader `cannibalize/+page.server.ts:56-71`) is an **ingest
front door**, not a research/verdict tool. The single `ingest` action (`:91-97`) takes an NL
**intent**, one **input** (`url|repo|file|text`), an optional **license**, and an optional
project → CB1 capture (`cannibalize/capture.ts:1-8`, SSRF-safe, byte-bounded) → CB2
`ingestCaptured` (`cannibalize/ingest.ts:1-25`): distill → screen → fence → embed → write
**through the existing memory store** (no parallel datastore). Output = N `memory` rows each
stamped with `provenance` → the `ingest_source` id + a denormalized `license`.

The distiller is still a **plain bounded extraction pass, not a model** —
`ingest.ts:22-25` carries `TODO(§7b): swap the injected DistillFn for the researcher role`.
It chunks text; it does not judge it.

`ingest_source` (migration `m0042`, `schema.ts:1619-1639`): `kind, ref, intent, license, status,
finding_count, created_at, completed_at`.
- **WHEN — YES** (`created_at` DEFAULT `time::now()` `:1634`, `completed_at` `:1636`; plus
  `memory.last_applied_at`/`applied_count`, m0043 `:1657-1664`).
- **WHAT — PARTIAL.** `ref` + `intent` + `license` recorded (`:1626-1630`). **No commit/sha pin,
  no per-artifact list** — "this repo", not "these 4 files at sha X".
- **WHAT WE LEARNED — NO.** **No verdict field of any kind.** `status` is a pipeline enum
  (`capturing/distilling/ingesting/done/failed/quarantined`, `:1631-1632`) — mechanical progress,
  not judgement. No adopt/adopt-ideas/no-adopt, no rationale, no link from a finding to what
  shipped because of it.

**Live: `ingest_source` = 0 rows, `memory` = 0 rows.** The tool has never run against the live
dev DB. Every actual cannibalization happened elsewhere.

**Where the record really lives — (b) scattered hand-written prose:**
`HEADROOM-DIGEST.md:1-10` (source `headroom`, pinned `9362747`, Apache-2.0, verdict "LEARN the
compression approach, not adopt"), `CANNIBALIZE-BRIEF.md` §5, `DECISIONS.md:629` (D-027–D-033
from hermes/mem0/kongcode), `BUILD-QUEUE.md:152`. Distinct sources named across docs+workflows:
**kongcode 185 · hermes 105 · mem0 69 · headroom 48 · gstack 44 · skillopt 20 ·
loop-engineering 8 · find-skills 3**. The real headroom knowledge graph sits in a **separate dev
tool** (`F:\code\cannibalize`, own `schema.surql`), not Atelier's DB. The one machine-readable
slice: `role.provenance` free-text on 5+ launch roles
(`workforce/launch-fixtures.ts:101,230,354,465,582`, contract `ceremony.ts:98`, test-enforced).

> **LICENCE RISK — real, not hypothetical.** `license` is `option<string>`, never required; the
> action reads a possibly-empty form field (`+page.server.ts:96`) and `schema.ts:1629-1630`
> explicitly permits unknown. Attribution in source is inconsistent: gstack is MIT-tagged
> everywhere, but `memory/eval/embedder.ts:84` says "borrowed from the signed feature-hashing
> trick" with no source or licence. **Unrecorded-licence harvests:** kongcode is documented as
> "code-lift needs consent" (`docs/AGENTS.md:5`) yet is the single largest influence (185
> mentions; D-006/D-007/D-008); skillopt, loop-engineering and find-skills have **no licence
> recorded anywhere in v2 code or schema**.

**D-042 fit:** the locked source vocabulary (`DECISIONS.md:571-577`) is
`operator / sync_from_disk / hr_recruiter / self_improvement / brain_observer / rollback` —
**`harvested` is NOT in it**. But the shape fits: `reason` is already "a link to the causing
git-commit / learning_candidate / validation_run / interview_run" (`:575`), and an
`ingest_source` id is exactly that kind of link.

**Cheapest path:** one additive migration extending `ingest_source` (`:1639`) with
`verdict option<string> ASSERT $value IN ["adopt","adopt_ideas","no_adopt","studied"]`,
`rationale`, `pinned_ref` (sha), `decided_at`; make `license` effectively required at the action
boundary for `kind IN ('url','repo')`; ISO-coerce `decided_at` in the normalizer (F-013). Then
widen the D-042 source enum with `harvested` and let `reason` point at an `ingest_source` id —
"what shipped because of it" comes free via `session.artifact_versions`.
**Note `learning_candidate`/`learning_event` do NOT exist** (`grep -rn` over `src/` = 0 hits);
`SELF-IMPROVEMENT-LOOP-SPEC.md` is spec-only, so they are not an available home today.

---

## 10d. Review systems — THE SHARPEST FINDING OF THE REVIEW

The build factory has a full review spine; **Atelier's own runtime has none of it.**

`v2-wave.js` does per-task BUILD → independent D-038 review (structured verdict schema `:105`) →
an artifact gate rejecting hollow passes (`:46-54`) → a bounded fix-loop → an opt-in red-team pass
(`:63`) → a deferred-findings ledger (`:85`). That is the world *we* build Atelier in. When
*Atelier* spawns a session against a managed project, none of it applies.

**The post-work path** — `orchestrator/post-task.ts` `runPostTask` (`:283`): guarded status
transition (`:306`) → `git add`/`git commit` (`:376-377`) → `git rev-parse` (`:380`) → project
`test_command` (`:400`) → optional follow-up `work_item` (`:418`). **The commit happens BEFORE the
test runs, and no agent, human, or heuristic ever looks at the diff.** `boot.ts` sets
`postTask: { enabled: true, followUpOnTestFail: false }` — a failing test records a fact on the
completion event and does **nothing else**: no block, no revert, no follow-up. Then
`mergeBack: { enabled: true }` FF-merges that unreviewed branch into the project branch.

| thing | status | evidence |
|---|---|---|
| `orchestrator/review.ts` — the real code-review trigger (`maybeEnqueueReview:115`, `countChangedFiles:56`, threshold 5 at `:34`) | **BUILT-BUT-UNWIRED** | **zero production callers**; only `orchestrator/index.ts:125-126` re-exports it + `review.test.ts`. Live `work_item` has **never** held a `review` row |
| `analytics/benchmark/judge.ts` | built, operator-triggered, never run | judges *driven sessions* on a benchmark rubric, not code; sole caller `benchmark/index.ts:85`. `benchmark_verdict` = **0 rows** |
| `panel_verdict` (the D-039 panel) | BUILT+WIRED — but reviews **proposals, not work** | `schema.ts:1179`, `artifact_kind ∈ [task, review_proposal, fixture_proposal]` (`:1182`). Live **12 rows, all `task`** (10 approve / 2 pushback) |
| `pm_review` | BUILT+WIRED, state-level only | `schema.ts:814`, counts tasks/findings/risks (`:821-824`). Live **11 rows**. **Reads no diff** |
| gauntlet/scorer | certifies ROLES, not work product | set aside |
| lint/typecheck/diff inspection in the runtime | **ABSENT** | no `npm run lint` / `svelte-check` anywhere on the post-task path |

**So: work is committed with no build, no lint, no typecheck, no review, and no gate.**

**Clean/DRY — nothing exists.** No duplication, dead-code, or similarity detector.
`cannibalize/` is harvesting, not drift detection. `loops/maintenance.ts` is a real cadence
engine but its registry holds exactly two actions — `evalRegressionAction`
(`maintenance-actions.ts:110`) and `rerankerEvalAction` (`:152`), both memory-eval, not code —
and live `loop_manifest` = **0 rows**, so nothing ever fires.

**Learning — spec-only.** `learning_candidate`, `learning_event`, `route_outcome`,
`validation_run`: **zero occurrences anywhere in `src/`**. What exists: `routing_event`
(`schema.ts:165`, **94 rows**) with no outcome half — every routing DECISION recorded, never
whether it was right; `retrieval_outcome` (`schema.ts:474`, writer `memory/outcomes.ts`) —
**0 rows**; `memory.category='correction'` scars (`soul.ts:279,:354`) — **1 row**.
**Nothing captures a session's work outcome.**

| capability | verdict |
|---|---|
| review of code | **BUILT-BUT-UNWIRED** (`review.ts:115`) |
| review of plans | EXISTS-AND-RUNS — proposals only |
| quality gate before commit | **ABSENT** |
| DRY / duplication detection | ABSENT |
| learning from outcomes | SPEC-ONLY |

**Closable by wiring what exists:** call `maybeEnqueueReview` from `post-task.ts` after `:380`
(or from `orchestrator.ts:1085`'s post-task block) — dedup, threshold and queue path are built
and tested; declare a `loop_manifest` maintenance row so the cadence engine ticks.
**Needs new machinery:** a pre-commit build/lint/typecheck gate in `post-task.ts` (reorder test
BEFORE commit and honor failure), duplication detection, and the whole `route_outcome` writer.

---

## 10e. Proposals — the handler exists; it is simply not armed

`proposeTask` (`projects/pm-proposals.ts:187`) is the **single write chokepoint** for
`status='proposed'`, enforcing the §4.1 contract (objective / purpose / acceptance_criteria /
provenance, `:140-149`) and refusing an `observe`-authority PM (`:198`). Callers by
`provenance.kind`: `pm-triggers.ts:420` `periodic`, `:503/:598` `session_failed`|`task_blocked`,
`:647` `finding`, `:658` `release`, `:683` `github_arrival`; `pm-propose.ts:585` `pm_lifecycle`
(the LLM generator — a validated trust boundary); one bypass at `create/execute.ts:1394` for
founding tasks.

**A validation panel is real and has run.** Born `proposed` → `runValidationPanel`
(`pm-panel.ts:415`) → `decidePanel`: pushback → `pm_memory` learning rows; all-approve **and**
`pm.authority==='act'` → the panel itself `setStatus(task,'ready')` (`pm-panel.ts:~613`);
authority `propose` → a `proposal_gate` decision brief (`:636`) answered via
`/api/briefs/+server.ts:52` → `applyBriefDecision` (`:841`). Live: `panel_verdict` 12, one
`proposal_gate` brief approved.

**Why proposals just sit:** the panel fires only from the operator's "Run validation panel"
button (`?/pmPanel` → `+page.server.ts:1778`; the card's ONLY action) or from
`pm-lifecycle.ts:288` inside a tick — and **both live PMs have `autonomous:false`** (schema
default `schema.ts:2097`).

| handler | status |
|---|---|
| **PM** | **BUILT** — `AutonomousPmLoop` (`pm-autonomous.ts`), armed via `loops/arm-gate.ts:39` / `setPmAutonomous` (`pm-repo.ts:616`). `runPmReview` is deterministic and reads tasks/findings/risks but **does not read the proposal queue** — adding it is a read-only input change. Live: 2 `pm` rows for 4 projects, both `authority:'act'`, both disarmed |
| **Brain** | **ABSENT** — no `src/lib/server/brain`; `brain_tick`=0, `brain_proposal`=0. Spec DRAFT, queued, blocked by 3 deps, **v1 explicitly proposal-less** |
| **Council** | **ABSENT** — spec text only (observer v3). Closest real thing is the concierge (`concierge.ts:874`), explicitly non-steering. Live `concierge_turn`=0, `peer_message to_kind:'atelier'`=5 |

**The line, sharply.** D-039 (`DECISIONS.md:535-541`): "nothing it creates is exempt from
review". D-035a (`:557,:565`): agent comms are DATA; only `origin=operator` steers.
**Permitted today:** a PM/brain/council ENRICHING a proposal — analysis, priority, a recommended
verdict, rationale — written as advisory rows. Precedent already shipped
(`pm-panel.ts:636-660` pre-fills a recommendation; `auto-adjudicate.ts` is the
clear-cases-only/escalate-on-doubt template). **Not permitted:** any new actor calling
`setStatus(...,'ready')` — promotion exists in exactly one place and a second promoter is an
F-055 gate bypass.

**Shortest path (no migration, no new decision):** feed `listProposalQueue` into `runPmReview`'s
inputs; on a novel proposal emit the existing atelier consult (`pm-concierge.ts:248`,
deterministic dedup; reply drains to `pm_memory` via `concierge-advisories.ts:141`); surface the
reply as a recommended verdict on the brief. **Prerequisite: arming a PM — real spend, operator
consent required.**

---

## 10f. Sprints, tasks, and the board — the metadata never reaches the model

**Sprint is a dead label.** `schema.ts:72-76` (`project, name, starts, ends`) + `:739-741`
(`status, completed_at`); normalizer `projects/repo.ts:409-425`. **`task` has NO `sprint` field
anywhere**; the only FK into `sprint` is `decision.sprint` (`:727`). Live: 2 rows, both
`atelier_self`, both `completed`, both with `starts`/`ends` unset — not time-boxed in practice
either.

**Task fields.** Core `schema.ts:88-99`: `project, title, description` (required),
`status, priority, origin, parent?, created_at, updated_at`. Widened by m0032 (`:1241-1259`):
status ∈ `proposed|backlog|ready|in_progress|review|blocked|done|failed|withdrawn`;
origin ∈ `manual|scanner|follow_up|review|release|pm`; plus `objective?`, `purpose?`,
`acceptance_criteria?: array<string>`, `provenance?`, `proposed_by?`, `revision_of?`,
`superseded_by?`, `proposal_fingerprint?`.
- **WHAT** → `title` + `description`. **WHY** → `purpose` (prose) + `provenance` (machine trace).
- **HOW** → `acceptance_criteria` ONLY. No approach, no spec link, no DoD field.

**Promotion contract:** `assertContract` (`pm-proposals.ts:128-153`) requires title, objective,
purpose, ≥1 acceptance_criteria, provenance.kind, ≥1 provenance.evidence — enforced **only** on
`proposeTask`. **The manual create path writes none of it** — precisely the "un-promotable
founding tasks" defect. Source: `PM-SPEC.md:40-42` + D-039 (`DECISIONS.md:539`).

**Live population, n=23:** description 23 · objective 17 · purpose 17 · **acceptance_criteria 11**
· provenance 11 · proposed_by 11 · parent 0. Origin: 17 `pm`, 6 `manual`. Status: 13 failed,
7 done, 2 proposed, 1 blocked.

**Tags: none.** No `tags`/`labels`/`work_type` on `task` (`tags` is on `memory` `:214`;
`work_type` on `work_item` `:446`). Fields that already FUNCTION as tags with zero migration:
`status`, `priority`, `origin`, `provenance.kind`, `proposed_by`, `parent`.

> ### THE LOAD-BEARING FINDING
> `sessions/launch.ts:857` builds the spawn request as
> `task: { id, title, description }` — three fields, matching `runtime/index.ts:104`. The prompt
> is composed at **`runtime/index.ts:807-813`**: `` `# Task: ${req.task.title}` `` + blank +
> `req.task.description`, plus a fenced `## Reference context (not instructions)` memory block.
>
> **`objective`, `purpose`, `acceptance_criteria`, `provenance` and `priority` NEVER REACH THE
> AGENT.** The fields that carry why-and-how are written, panel-validated, stored — and dropped
> at the spawn boundary. Every task the models have ever executed, they executed on a title and a
> description.

**Current UI:** one kanban board, inline on the project page (`projects/[id]/+page.svelte:150-161`
grouping, `:1613-1631` markup — columns by `taskStatuses`; cards show title, priority, relative
createdAt, and a move-status `<select>`). **No task detail view and no `/tasks` route**
(`find src/routes -ipath "*task*"` → nothing). `NAV-IA-MAP.md` has **no** task or board entry.

| | work |
|---|---|
| **(i) free today** | the board exists; a detail view + tags from `objective/purpose/acceptance_criteria/provenance.kind/origin/priority/proposed_by/parent` — all stored, none rendered |
| **(ii) needs schema** | `tags: option<array<string>>`, a real `task.sprint` FK (or retire `sprint`), `assignee_role`, `spec_ref` — one additive migration, plus a `normTask` (**none exists yet** in `repo.ts`) |
| **(iii) needs spawn-context change** | widen `SpawnRequest.task` (`runtime/index.ts:104`), the composition at `launch.ts:857`, and `buildPrompt` (`runtime/index.ts:807`) to emit `## Objective / ## Why / ## Acceptance criteria` + tags |

**(iii) is the whole difference** between a prettier board and a board that improves agent
behaviour. D-026 note: these are operator/PM-authored fields, so they belong in the
**instruction** section, NOT the fenced "(not instructions)" block.
Prior art: `PM-SPEC.md` §4.1 already specs the four fields; **no board/kanban spec exists**.

---

## 10g. Roadmap / timeline — past-only; the future half is not modelled

| need | verdict |
|---|---|
| what the project WANTS TO BE | **EXISTS-AND-SHOWN** — `project.plan {purpose, long_term_vision, role}` (`schema.ts:42-45`), written by Create-with-AI (`create/execute.ts:749`, fallback `:1080`), rendered `projects/[id]/+page.svelte:1157-1163`. Live 2 of 4 projects (`gv_live_demo`, `thunderstore` have `plan:null`) |
| what DONE looks like | **EXISTS-AND-SHOWN, prose-only** — `plan.definition_of_done` (`:46`), rendered `+page.svelte:1076,1171` + `ProjectStatus.svelte:84-86` (honest "— not set"). A free-text sentence, **not checkable criteria**. The autonomous-to-v1 target is NOT a data field: `pm.auto_publish_preauthorized` (`schema.ts:2128`) + `pm.autonomous` + the release pipeline. **No `target_version` column anywhere.** `release` = 1 row (`0.1.0`, active, never shipped); `phase`/`feature` tables exist (`:56-71`) with **0 rows and no writer** |
| what we DID along the way | **ABSENT as durable semantic history** |
| a node/timeline VIEW | **EXISTS — but it is a causal graph, not a roadmap** |

**History is exhaust + hand-written docs.** Live: `agent_event` 2023 (hook 1189, completion 506,
spawn 175, error 114, queue 35, consult 4) · `scene_event` 500 rolling (`job_fired` 495) ·
`session` 177 · `work_item` 211 · `task` 23 · `role_event` 90 · `role_version` 15 ·
`workflow_run` 3 · `soul_graduation` 0 · `feature`/`phase`/`causal_chain` ≈ 0/0/1.
**`task` has only `created_at`/`updated_at` (`schema.ts:98-99`) — no `completed_at`, no
transition log**, so a task that shipped and one that was edited are indistinguishable. The real
narrative history is git commits + `docs/devlog/` (5 files, hand-written), which
`devlog/README.md:1-10` explicitly calls "a second source of truth alongside git history".

**The existing graph is the wrong axis.** `projects/[id]/graph/+page.server.ts` →
`buildLifecycleGraph`; node kinds `'continue'|'session'|'pm'|'task'`
(`observability/lifecycle.ts:47`), edges `'spawned'|'reported-to'|'proposed'|'follow-up'|
'messaged'` (`:57`); `layout.ts` places by **causal depth = longest directed path from a root**
(`:93-95`, `GraphColumn.col` `:49-51`), n8n cards in `<foreignObject>`
(`LifecycleGraph.svelte:543`), static `viewBox` (`:391`) — no pan/zoom. It answers "how did this
run cause that", not "where are we going".

**Time axis is past-only.** `sprint.starts/ends` exist but both live rows have neither;
`release.shipped_at` unset. **Nothing anywhere carries a planned date or a future-dated row.**
The data supports a changelog, not a roadmap.

**Nothing is designed:** `NAV-IA-MAP.md` has zero roadmap/timeline/graph entries;
`BUILD-QUEUE.md` has no queued roadmap item; `LIFECYCLE-GRAPH-UX-SPEC.md` covers polish only.
(`docs/ROADMAP.md` is Atelier's own hand-written phase plan, not a product feature.)

**Path:** (i) free — generalise `layout.ts` to rank by **time bucket instead of causal depth**
for a past-only swimlane from `session`/`task`/`agent_event(completion)`, with vision + DoD
hoisted as header nodes (`package.json` has only `d3-force`, `motion`, `js-yaml`, `json5`,
`surrealdb`; `MemoryScene` already proves pan/zoom with `d3-force`). (ii) new writes, no
migration — start writing `feature`/`phase`/`release.shipped_at` from `post-task.ts` and
`release/pipeline.ts`. (iii) migration — `task.completed_at`, structured checkable
`done_criteria[]`, `planned_at`/`target_version`. **The future half does not exist in the data
model at all** — same shape as the loop-topology gap (§9).

---

## 10h. GitHub sync — Projects v2 is already built; nothing has ever run live

Subsystem `src/lib/server/sync/`: `adapter.ts` (typed `SyncAdapter`), `github.ts` (issues),
`github-board.ts` (Projects boards), `gh.ts` (transport), `gh-client.ts`, `board-repo.ts`,
`index.ts`.

| entity | direction | evidence |
|---|---|---|
| issues | **two-way** (push create/update, pull state→status) | `github.ts:4-10,268,296` |
| labels | push-only, auto-upserted (`atelier-task`, `status:<s>`, `priority:<p>`) | `github.ts:45,54`; `gh-client.ts:441-444` |
| **Projects v2 boards** | **one-way push** (task status → Status column) | `github-board.ts:2,57,107,117` |
| PRs | read-only (arrival detection, no mapping) | `gh-client.ts:365-376`; `adapter.ts:73-83` |
| releases | **dry-run plan only — no live call** | `adapters/github-releases/api.ts:1-7` |
| milestones / commits | not synced | absent from `gh-client.ts:119-165` |

**Transport is the `gh` CLI** — one `execFile`/`spawn` array-args chokepoint (`gh.ts:20,77,84`),
not REST, not a library, not direct GraphQL. **Projects v2 is therefore ALREADY REACHABLE**:
`gh project view/field-list/item-add/item-edit` speak the v2 GraphQL API underneath
(`gh-client.ts:464-466,474-549`). **No new transport is needed.** Auth is `gh`'s own keychain or a
pre-existing `GH_TOKEN`/`GITHUB_TOKEN`; the code never reads, stores, or logs a token
(`gh.ts:10-11`; `gh-client.ts:6-7`). Board work needs the `project` scope.
Trigger is **manual only** — operator form actions `sync` (`projects/[id]/sync/+page.server.ts:162`),
`syncBoard` (`:287`), `syncRun` (`targets/+page.server.ts:237`). Deliberate per `SYNC-SPEC.md:31`
(SYN-4).

**Data model:** `task_sync` (m0024, `schema.ts:757-789`) is a real external-id map —
`task, project, provider, repo, external_id, external_url, direction, last_synced` — with **dual
computed VALUE UNIQUE dedup keys** (`:778-785`) built from IMMUTABLE fields, so **no F-048
hazard**. Push re-links a same-titled orphan issue rather than duplicating
(`github.ts:412-425`). **No etag, no remote `updated_at` pin.**

> **Live: `task_sync` 0 · `board_sync_config` 0 · `sync_incident` 0 · `sync_target` 0.
> NOTHING HAS EVER SYNCED LIVE.** `SYNC-SPEC.md` SYN-3 (live round-trip) is still a deferred
> proof. Prove the existing path before extending it.

**Conflict:** push-then-pull last-writer-in-run, NOT a timestamp comparison — push overwrites
remote labels (`github.ts:268`) then pull reads them back (`:296-301`). Pull only proposes a
status and the task state machine gates it (`:86-96`); `proposed`/`withdrawn` are deliberately
unpullable (`:94`). **An operator editing an issue BODY silently loses it — bodies are never
pulled.**

**Gates:** D-037 (`DECISIONS.md:503-511`) makes publish/deploy/sync a pluggable adapter framework,
operator-gated — but sync specifically is **explicitly UNGATED**
(`targets/+page.server.ts:52-53`: *"The GATED families … are `publish`, `deploy`; sync is
idempotent, ungated."*). **D-026 honestly assessed:** issue *bodies* are never ingested (pull
reads only `state` + `status:` labels) — real containment. But arrival **titles** are
attacker-controllable and are handed to the PM trigger engine (`adapter.ts:80-83`;
`sync/+page.server.ts:201-204`) with **no screening in the sync layer** — the comment defers all
gating to the PM engine. Any future body/comment ingestion is a new injection surface needing
explicit fencing.

**Cheapest extensions:** a board→task **pull** leg (`github-board.ts:117` hardcodes
`direction:'push'`); generalize past the hardcoded `Status` field name (`gh-client.ts:497`) for
custom fields. Neither needs a migration or a gate. Milestones↔sprints needs a `sprint_sync`
mapping table (migration) — and sprints are a dead label today (§10f). Non-GitHub: Thunderstore
publish exists behind a confirm-token gate; **no webhook receiver, no n8n, no MCP-based sync**
(the only `n8n` hits are graph *styling*).

### Repo picker under project settings

**There is no `settings/` route** — `routes/projects/[id]/` has no settings dir. The repo field is
a plain free-text input on the project page (`+page.svelte:3361-3367`,
`placeholder="https://github.com/owner/repo"`), persisted by the mutable-columns action
(`+page.server.ts:1038-1068`). Schema `schema.ts:36` — `repo_url TYPE option<string>`.
**No shape validation, no existence check, no reachability probe — a typo is stored silently.**

| want | status | extend at | needs |
|---|---|---|---|
| searchable repo list | **NEW, CHEAP** | a generic `gh api` passthrough already exists (`gh-client.ts:270`); add `gh repo list --json …` (~15 lines) on the interface at `:119-153`; surface at `+page.svelte:3361` | no migration, no gate. Scope needed: `repo`. **The code cannot currently tell you its token's scopes** — `gh auth status` is invoked (`:239`) but only ok/error is kept, scopes discarded; parsing that output is the cheap honesty fix |
| select / link existing | **CHEAP** | replace the free-text input (`+page.svelte:3365`) with a picker bound to the same `repo_url`; action `+page.server.ts:1051` | no migration, no gate; add the missing `owner/name` validation |
| create if missing | **ALREADY EXISTS** | `+page.svelte:3454` (`?/repoCreate`) → `+page.server.ts:1656` → `runRepoCreationGate` (`projects/repo-creation-gate.ts:153`) | **REUSE — a second creation path is an F-055 gate bypass** |

`createRepo` (`gh-client.ts:393-406`) runs `gh repo create <slug> --private` with `--private`
**hardcoded** and public **unrepresentable in the input type** (`:46`). The gate is 7 stages
(`repo-creation-gate.ts:61`): consent → token → auth → private → create → remote → url, with
private-first re-asserted as defense-in-depth (`:206-212`) and F-050 `master`→`main`
normalization (`:439-500`). Consent is the recorded `repo_create_preauthorized`; the PM can never
set it unilaterally (`:10-14`) and instead proposes via a `repo_create` decision brief
(`+page.server.ts:1712`). **The UI already exists too** (`+page.svelte:3383-3533`, honest
no-repo/created/failed states).

Gate summary: **listing** is a pure read — ungated. **Selecting/linking** writes only local
`repo_url` — ungated today. **Creating** is gated by recorded consent + a deterministic confirm
token, already satisfied by the existing action.

---

## 11. Operator asks — status

| ask | section | verdict |
|---|---|---|
| dead space below the shell | §1 | one-line fix, not a regression |
| `granted to` chip wall | §2 | label degradation; group + count |
| names must convey purpose | §3 | render helper ~80% + a write-path root cause |
| usage-by-tier / fable-5 / opus-5 | §4 | no model→tier map exists at all → `MODEL-LADDER-SPEC.md` |
| hiring & cert clarity | §5 | honest but unexercised; the join is one FETCH away |
| adjudication automation | §6 | already automated — the queue IS the residual |
| staffing & proposals empty | §7 | correct empties; one `{#if pm}` honesty gap |
| agent library | §8 | **a display — not wired to spawns at all** |
| loops node graph | §9 | modelling job, not rendering |
| soul / graduation | §10 | shipped further than believed; empty because nascent |
| workflows clarity | §10b | a naming collision; steps exist unrendered |
| cannibalize record | §10c | WHEN yes, WHAT half, LEARNED not at all + a licence risk |
| review of code/plans | §10d | **committed with no review and no gate** |
| elevate proposals | §10e | handler exists, PM simply disarmed |
| sprints → Asana board | §10f | **task why/how never reaches the model** |
| roadmap timeline | §10g | past-only; the future half is unmodelled |
| GitHub sync + repo picker | §10h | Projects v2 already built; nothing has synced live |

**Session fleet filtering/collapse** (`/claude-code`, captured without a scout): the fleet
section should be filterable by project and by failure, and collapsible, to stop the page growing
unbounded. Same card family as the §3 naming inventory (`claude-code/+page.svelte:337`; siblings
at `+page.svelte:250-262`, `agents/+page.svelte:853`, `projects/[id]/+page.svelte:2986`,
`RightTray.svelte:301`). Pairs with §1 — both attack "the page gets too tall".

**Model-ladder decisions locked by the operator (2026-07-26):** hard fail-closed fable gate (no
per-call operator bypass — recorded as bending F-005 for this one tier) · reuse the HR gauntlet
for model trials · local-Claude-Code spec-now/build-later · self-describing config + a live
`/settings` panel · unpriced models ship honest-NULL **plus a research task / call-to-action to
close the pricing gap**. → `MODEL-LADDER-SPEC.md`.

---

## 12. Suggested wave split

1. **`shell-and-labels`** — §1 (one-line layout fix) + §3(a) the shared naming helper and its
   adopters + §2 chip grouping + §11 fleet filter/collapse. All render-layer, no migration.
2. **`stamp-purpose-at-spawn`** — §3(b): stamp `role` at CREATE, wire `specialist`, give pool
   slots a purpose. Root-cause fix; without it §3(a) is an 18%-coverage patch.
3. **`task-context-to-agent`** — §10f(iii): widen `SpawnRequest.task` + `buildPrompt` so
   `objective`/`purpose`/`acceptance_criteria` actually reach the model. **Highest
   behaviour-per-line ratio in this document** — three files, no migration.
4. **`review-and-gate`** — §10d: wire `maybeEnqueueReview` (built, zero callers), reorder the
   pre-commit gate so build/lint/typecheck/test run BEFORE the commit and a failure is honored.
   **Correctness, not visibility — rank it above every cosmetic item here.**
5. **`hiring-trail`** — §5 join + grouping + ceremony page past `adjudicating`; §6 D-042
   stamping of `[auto]` resolutions; §10 render `role_version`/`role_event` as the hire
   graduation trail. No migration.
6. **`model-ladder`** — §4 + `MODEL-LADDER-SPEC.md`. Note Phase 2 is blocked until the stale
   fable-5 hard-retirement in `load.ts:30-48,929-948` (+ `load.test.ts:58`) is flipped.
7. **`board-and-tags`** — §10f(i)+(ii): task detail view, `/tasks` route, tags, a real
   `task.sprint` FK (or retire `sprint`), `normTask`. One additive migration.
8. **`sync-proof-then-extend`** — §10h: prove the existing GitHub round-trip live (SYN-3) BEFORE
   extending; then the board→pull leg + the repo picker (list + link; create already exists).
9. **`provenance-and-licence`** — §10c: `ingest_source` verdict/rationale/pinned_ref, licence
   required at the action boundary, `harvested` in the D-042 source enum. **Includes the
   unrecorded-licence risk on kongcode/skillopt/loop-engineering/find-skills.**
10. **Deferred / needs modelling** — §9 loop topology (migration), §10g roadmap future-half
    (migration), §8 agent-library wiring + versioning + the untracked-definition supply-chain
    risk.

**Operator-gated, do not start without an explicit decision:** arming a PM (§10e — real spend),
per-hire souls (§10), widening auto-adjudication past B3 (§6), any publish/deploy/release.

**Separately flagged, not investigated:** 19 of 36 `interview_run` rows are `error` status (§5).
