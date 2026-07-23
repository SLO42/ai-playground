# BRAIN-ALIVE-UI-SPEC — Watching the Brain Think (the "alive and watching" experience layer)

**Status**: DRAFT for operator review · 2026-07-23
**Depends on**: `docs/BRAIN-OBSERVER-LOOP-SPEC.md` (FINAL, operator-answered 2026-07-23) — this spec builds the *experience layer* over that loop. It changes **nothing** about the loop's budget, caps, authority split, or safety invariants (BO-1..BO-15).
**Not to be confused with**: `docs/BRAIN-OBSERVABILITY-SPEC.md` (BL-8, 2026-06-16) — that is the older self-learning-brain visibility spec. This is the live "alive" UI for the observer loop.
**Author model**: claude-fable-5 (planning role per CLAUDE.md §2.5).

> Migration-number note: BRAIN-OBSERVER-LOOP-SPEC names its tables m0081–m0084, but the v2 head has since advanced — `m0081_agent_event_supervision` already exists (`src/lib/server/db/schema.ts:2879`). All mNNNN references are **symbolic**; renumber to the actual head at build time. This spec itself adds **zero new tables**.

---

## 1. Thesis — "alive" is a presentation layer, not a hotter brain

The operator wants to *watch the brain think*: nodes appearing, tasks reviewed, council members weighing in, reasoning and confidence firing live. The safe brain we specced is the opposite temperament: a 30-minute budgeted tick that usually journals "nothing notable," senses for $0 on a local model, escalates to cloud at most 4×/day.

**These do not conflict, because "alive" is a property of the *surface*, not the *engine*.** A hospital monitor feels intensely alive showing a resting heartbeat — it does not need the patient to sprint. The resolution, in four commitments:

1. **Stream everything the brain already does, as it does it.** The tick already has 6 internal phases (SENSE → TRIAGE → ESCALATE → COUNCIL → ROUTE → JOURNAL). Today they're invisible until one `brain_tick` row lands. We narrate each phase onto the existing SSE stream in real time. Zero extra brain compute — the events are byproducts of work already happening.
2. **Quiet is shown as RESTING, honestly, not padded into fake activity.** A heartbeat pulse driven by the *real* last tick, a countdown to the *real* next tick, the *real* last verdict. Never a fabricated shimmer (F-008).
3. **When the brain genuinely fires — escalation, council, proposal — the surface goes rich.** The 4/day escalation bursts are the theater; we spend our design budget there.
4. **The operator can summon liveness on demand** — "Think now," focus mode, a temporarily raised cadence — all through existing authed/gated paths, all raising *local* ($0) sensing frequency, never the cloud caps.

What this spec explicitly rejects: making the brain always-on, narrating with extra LLM calls, or raising cloud spend to feel alive. The vibe is free or it is wrong.

---

## 2. The live event model — `brain_activity` on the existing SSE

### 2.1 Stream vs journal (the load-bearing distinction)

- **`brain_tick` (durable journal)** = the *record*. One row per tick, always, source of truth (BO-invariants live here).
- **`brain_activity` (ephemeral SSE event family)** = the *feel*. Fine-grained phase-by-phase narration, in-memory only, lossy by design. Losing stream events loses nothing that matters — the journal reconciles (§8, SI-5).

The app already opens **one** SSE stream once in the browser (`src/routes/+layout.svelte:123` — "Open the one SSE stream once") served by `src/routes/api/events/+server.ts`, carrying kinds like `notification`/`agent_event` (D-005, no polling). `brain_activity` registers as one more event kind on that same stream — no second EventSource, no new endpoint. `[VERIFY: src/routes/api/events/+server.ts — the exact server-side publish API the observer action calls to push an event onto the open streams]`

### 2.2 Emission: the `BrainNarrator`

A tiny helper constructed at the top of the `maint:brain-observer` action fn (BRAIN-OBSERVER-LOOP-SPEC §2.3) and threaded through the phases:

```ts
narrator.emit(phase, payload)   // fire-and-forget; NEVER awaited on the tick's critical path
```

Rules:
- **Never blocks, never fails the tick.** A narrator error is swallowed and counted; the tick proceeds identically with or without listeners (the brain must not know it's being watched).
- **Screened at emit.** Payloads pass the same screening the scene projector applies to `meta` (`src/lib/server/scene/projector.ts:261`). Reuses `memory/screen.ts`. See SI-1.
- **Ring buffer for late joiners.** The server keeps the last N=200 `brain_activity` events in memory; a newly connected client receives the buffer as catch-up, then live events. Process restart empties it — honest, because the journal is the record.

### 2.3 The event vocabulary

Every event: `{ kind: 'brain_activity', tick_id, seq, at, phase, payload }`. `confidence` appears wherever the underlying step produced one — and **only** there (F-008: no invented confidence).

| `phase` | fired when | payload highlights |
|---|---|---|
| `tick-started` | action fn entered, gates passed | `{trigger: 'schedule' \| 'operator-think-now'}` |
| `digest-assembled` | SENSE done ($0 deterministic) | `{counts_by_source, watch_notes_carried, span}` — counts only, no content |
| `triage-reasoning` | local triage turn returned | `{reasoning_summary}` — screened text of the model's stated reasoning (§7, Q4 governs verbosity) |
| `triage-verdict` | verdict parsed | `{verdict, anomaly_class?, confidence?, evidence: RecordRef[]}` |
| `escalation-fired` | code decided anomaly + cap headroom | `{anomaly_class, cap_used: '2/4'}` |
| `council-reader-spawned` | a reader sub-agent starts | `{reader_id, scope_ref: RecordRef, scope_label}` — *what* it reads (a ref), never raw bytes |
| `council-reader-input` | a reader reports progress | `{reader_id, records_read: n}` — counts/refs only |
| `council-reader-finding` | reader returns distilled finding | `{reader_id, claim, confidence, concluded_from: RecordRef[]}` — screened+distilled |
| `council-disagreement` | synthesis detects conflicting claims | `{finding_ids: [a,b], axis}` |
| `proposal-drafted` | `brain_proposal` row inserted (or suppressed) | `{proposal_id \| suppressed: 'at-cap', title, confidence}` |
| `pm-advisory-sent` | non-steering peer message written | `{project, peer_message_id}` |
| `node-created` | any durable row this tick created | `{table, record_id}` — drives the scene layer (§3) |
| `tick-resting` | tick journaled, loop idle | `{verdict, next_at}` — powers the countdown (§4) |
| `sensor-offline` | Ollama unreachable, tick ended honestly | `{last_ok_at?}` |

`triage-reasoning`, `council-reader-input` and reader deltas are the **ephemeral** tier — the feel. `triage-verdict`, findings, proposals are mirrored durably. Persistence split is Question 1.

### 2.4 First-class analytics discipline

Each event carries enough to explain *how and why* (the `writeRoutingEvent` standard, `routing/resolve.ts:464`): verdicts carry evidence refs, findings carry `concluded_from`, suppressions carry the cap that suppressed them. Never a flat "brain did a thing."

---

## 3. The scene 'firing' layer — nodes appearing as the brain thinks

The living-memory scene (`src/lib/components/scene/MemoryScene.svelte` + `NodeInspector.svelte`, fed by `appendSceneEvent` at `src/lib/server/scene/projector.ts:123`) already renders nodes/edges derived live from source tables. The brain joins it as a **first-class inhabitant**:

- **New scene event kinds**: `brain_escalation`, `brain_proposal`, `brain_finding`, `brain_watch`. The projector enforces a kind whitelist (`projector.test.ts:114`) — these must be added. `[VERIFY: whether the whitelist is code-only or also a schema ASSERT on scene_event.kind]`
- **What projects, and what deliberately doesn't**: a nothing-notable tick does **NOT** create a scene node — 48 identical gray dots/day is noise cosplaying as life. Instead it **pulses the existing `self:atelier` node** (the S4 identity node already in the scene) — a single breathing anchor. Nodes are reserved for *genuine* cognition: an escalation node edged to its evidence; finding nodes edged from the escalation with confidence in edge weight/opacity; a proposal node edged to the operator-queue region. The operator watches an anomaly grow a small constellation.
- **Live arrival**: `node-created`/`escalation-fired` SSE events trigger the scene's existing refresh path (D-005 invalidation over the one stream; no polling).
- **F-014 cap honored**: brain nodes go through the same `motionFor` gate (`motion-state.ts:32`, `MAX_ANIMATED_NODES = 60`). The `self:atelier` pulse counts as one animated node.
- **Reduced-motion honesty**: with `prefers-reduced-motion`, pulse + node-arrival drop to static badges + the text-equivalent legend the scene already maintains. "Alive" degrades to "current," never "broken."

---

## 4. The 'resting' state — quiet ≠ dead

The `/brain` route (`src/routes/brain/+page.svelte`) gains a **vitals header**, present on every visit:

| element | source | honesty rule |
|---|---|---|
| **Heartbeat pulse** | animates once per *real* tick (SSE `tick-resting`); between ticks, slow idle breathing keyed to `last_tick_at` | pulse renders **only if** armed AND last verdict wasn't `sensor-offline`/`error`. A dead sensor gets **flatline + amber `sensor offline since {t}`** (F-008) |
| **Next-tick countdown** | `next_at` from `loop_manifest` / `tick-resting` | `—` if not armed; label "dormant (not armed)" |
| **Last verdict chip** | latest `brain_tick` (durable) | verbatim incl. `nothing-notable`, `triage-unparseable`, `proposal-suppressed-at-cap` — displayed, not hidden |
| **Caps at a glance** | escalations 24h + open proposals n/3 | real counts from real rows |
| **Watch notes** | carried watch items from the digest | "watching: …" — the resting brain visibly *has things on its mind* |

Copy does the emotional work honestly: **"Resting — last checked 14:20, all quiet. Next look in 11m."** is alive. A spinner would be a lie. States (all F-008): `resting` · `thinking` · `escalated (council live)` · `dormant (not armed)` · `sensor offline` · `error (see journal)`.

---

## 5. The council theater — the headline

When `escalation-fired` lands, `/brain` (and the focus-mode overlay, §6) opens the **Council view** — where the 4/day budget buys a genuinely rich scene:

1. **Anomaly card** docks top: class, triage confidence bar, evidence refs (each links into `NodeInspector`).
2. **Reader seats light up as they spawn.** Each `council-reader-spawned` adds a card: reader id, its *scope* ("reading: session:xyz notes — 3 records") as provenance chips. What it's reading is named; what it reads is **never shown** — raw bytes stay in the reader's context and die with it (BO-7/D-026). Live working state from `council-reader-input` counts ("2/3 records read") — real progress, not a fake spinner.
3. **Findings land one by one.** Each `council-reader-finding` flips its card: full **claim**, a **confidence bar** (0–1, numeric), and **"concluded from"** chips linking each `RecordRef`. Cards arrive in true completion order — the operator sees which reader was fast, which sure.
4. **Disagreement is a feature.** On `council-disagreement`, conflicting cards snap side-by-side under a "council split" banner, confidence bars juxtaposed, axis stated. Nothing averaged away — the operator sees the brain *weighing*.
5. **Synthesis → outcome.** The final `proposal-drafted`/`pm-advisory-sent` card cites which findings it drew on (rationale + provenance, §7). Suppressed-at-cap *shows the suppression* — the most honest ending.
6. **Replay.** Past escalations re-render from durable records (escalation journal + findings + proposal), minus ephemeral timing. The theater is a *view over records* — full fidelity live, journal fidelity historically. This is what keeps stream-loss harmless.

Layout: reader cards a CSS grid reflowing 1→3 columns; confidence bars use D-034 teal tokens; all animation respects reduced-motion (cards appear without transition; ordering + timestamps carry the sequence).

---

## 6. On-demand liveness — summoning the brain, safely

Three affordances, all **read-only w.r.t. gates** (F-055), all operator-initiated (D-035a):

1. **"Think now."** Button on `/brain` → authed `POST /api/brain/tick` (existing app-auth, m0071 `[VERIFY: schema.ts:2481 m0071_app_auth]`) → immediate dispatch of `maint:brain-observer` **through the MaintenanceLoopEngine path**, so all five engine gates re-check from the DB exactly as a scheduled tick. Budget-checked, cap-checked, journaled `trigger:'operator-think-now'`. Not armed ⇒ button disabled with honest reason — it cannot arm anything. Server-debounced: one manual tick at a time.
2. **Focus mode.** Client-side toggle: expands vitals into a full-viewport live pane (feed + scene + theater docked), raises detail (inline `triage-reasoning`, per-event timestamps). Purely presentational — zero server/brain change.
3. **Temporarily raised cadence.** "Watch closely for 1 hour" → authed endpoint updates `loop_manifest` cadence 30m→5m with a **mandatory server-side auto-revert** (`revert_at` on the row; the engine restores baseline — revert never depends on the browser staying open). Raises **local $0 sensing only**. Cloud escalation cap (4/day) + proposal cap (3) are **untouched and untouchable from this surface** — the UI says so: "raises how often the brain looks (local, free). Does not raise cloud spend."

Deliberately absent: any control that arms/disarms, raises caps/budgets, approves proposals, or steers. Those stay behind their existing gates.

---

## 7. Reasoning & confidence display

One grammar everywhere:
- **Confidence** = bar + numeric (`0.82`), teal ramp (D-034). Rendered **only when the record has one**; absent ⇒ `—` "no confidence reported" (F-008 — never default 0.5, never invent).
- **Reasoning** = collapsed "why?" expander on triage verdicts + proposals: screened reasoning text; collapsed shows first sentence.
- **Provenance** = "concluded from" chips on every claim/finding/proposal, each a real `RecordRef` opening `NodeInspector`. A claim with no provenance **cannot appear** — BO-8 refuses provenance-empty drafts at insert; the UI inherits the guarantee.
- **Proposal rationale** = claim → supporting findings (each reader's confidence) → evidence refs → the triage verdict that started it. Full chain, every link clickable, none fabricated.

Svelte 5 runes in `.svelte`/`.svelte.ts` (F-009); `{@const}` legal (F-011); Playwright `waitUntil:'load'` (F-010, the page holds the SSE open).

---

## 8. Safety invariants (each testable, each named test)

- **SI-1 No raw untrusted content in any stream event.** Every payload passes `memory/screen.ts` at emit; council events carry only distilled `{claim, confidence, concluded_from}` (D-026). *Test: seed a note with a secret marker + injection; drive an escalated tick; assert neither appears in any SSE frame or scene_event row.*
- **SI-2 Observability is read-only w.r.t. gates.** No new handler mutates arm/caps/budgets/origins/proposal-status; think-now + cadence-raise route through existing gated paths (F-055). *Test: enumerate new endpoints; assert none write gate fields; think-now on a disarmed loop is a 4xx with reason, not a tick.*
- **SI-3 Honest states only.** Pulse/countdown/confidence render only from real rows/events (F-008). *Test: render `/brain` on a `sensor-offline` journal; assert flatline + no pulse node in DOM; a finding w/o confidence renders `—`.*
- **SI-4 Motion bounded + accessible.** All brain animation via `motionFor` under the F-014 cap; reduced-motion → static. *Test: extend `motion-state.test.ts` with brain node kinds; axe check on reduced-motion.*
- **SI-5 Journal is source of truth; stream loss loses nothing.** Every durable fact has a durable home; UI reconciles from the server `load` on reconnect; ring buffer is courtesy. *Test: kill SSE mid-escalation, reconnect after; theater replays identical-in-substance from durable rows.*
- **SI-6 Watching never perturbs the brain.** Narrator emit fire-and-forget; a throwing narrator changes no outcome. *Test: inject a throwing narrator; assert the `brain_tick` row is substance-identical to a no-narrator run.*

---

## 9. Build phasing — aligned to the observer loop's v1/v2/v3

| Phase | ships | DONE-WHEN | feels alive when… |
|---|---|---|---|
| **v1 · eye** | `BrainNarrator` + `brain_activity` SSE (tick-started/digest/triage/resting/offline) · vitals header · `self:atelier` scene pulse | a scheduled tick narrates SENSE→TRIAGE→REST on `/brain`, zero polling; disarmed/offline shows honest state | …you open `/brain` and know within 2s the brain is resting, when it last looked, when next |
| **v2 · voice** | proposal/advisory events + proposal cards with rationale-provenance chain · confidence grammar · escalation/proposal scene nodes · "Think now" | Think-Now yields a live narrated tick through the gated path; a proposal appears with its full clickable why-chain | …you watch a proposal *arrive* and walk every link to real records |
| **v3 · depth** | full council theater (seats, live findings, confidence, disagreement, replay) · focus mode · temp cadence raise + auto-revert | a real/seeded escalation renders the multi-reader theater live, replays from journal after restart, cadence reverts unattended | …an escalation fires while you watch and it's the best thing on the screen |

Each phase per D-038 (real-surreal tests, live db:up + render-smoke, devlog, SI tests land with their code).

---

## 10. Risks

1. **Event volume vs the one-stream rule** — 48 ticks/day × ~5 events is trivial; a 5-min focus cadence × verbose narration could chatter the shared SSE. Mitigation: per-tick event budget (~40, excess coalesced); non-`/brain` clients ignore the kind cheaply. No second stream, no polling.
2. **Animation overload / scene pollution** — the temptation is a node per tick (48 fake dots/day eating the F-014 cap). Held off by §3 (nothing-notable pulses; only genuine cognition projects) — this line must survive review pressure.
3. **Stream/journal drift** — durable rows always win on reconcile; stream events older than the freshest journal row for a tick are dropped, not merged. SI-5 covers it.
4. **Cadence-raise slippery slope** — auto-revert is server-side + mandatory; the caps are unreachable from any surface here; any "raise the cap" is a `brain_proposal` to the operator, never a UI toggle.
5. **Narration cost creep** — narration is byproduct-only (screened fields the tick already produced). The brain never spends a token to be watched.

---

## QUESTIONS FOR OPERATOR

1. **Streamed fine-grained reasoning — persisted or ephemeral?** Recommended: **ephemeral ring-buffer only** (journal stays lean; theater replays from durable facts at slightly lower fidelity; persist later only if missed).
2. **Does "Think now" count against the daily cloud-escalation cap?** Recommended: **yes** — a manual tick is a normal tick; the cap protects spend regardless of initiator.
3. **Default for the temporary cadence raise?** Recommended: **5-min ticks for 60 min, server-side auto-revert, one active raise at a time.**
4. **Reasoning verbosity in the stream?** (a) milestones only · (b) milestones + the model's stated reasoning text per phase · (c) token-level streaming. Recommended: **(b)** — free (already produced) and it's the difference between "status page" and "watching it think"; (c) is a focus-mode follow-up.
