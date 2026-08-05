# COUNCIL-SPEC — the validation panel becomes a council: qualified stances, evidence slices, one deliberation round, honest aggregation

> Drafted 2026-08-05 (planning agent, fresh-context, on `claude-fable-5` per the 2026-07-07 model-roles
> policy). Every `file:line` below verified by direct read-only reads of `F:\code\ai-playground-v2`
> @ branch `v2` (HEAD `6878d14`) this session — briefing claims were re-checked, corrections in §0.
> **Both worktrees carry unpushed, partially UNVERIFIED tips (OPERATOR PAUSE #6)** — a build wave
> re-verifies every line number before touching code. Status: **SPEC — DRAFT, modelling wave only.**
> This is wave 1 of 2: the operator's council VISUALIZER is a follow-on UI wave (§9 hands it a clean
> seam); building the UI first would mean rebuilding it, because this spec changes the panel's shape.
>
> **MIGRATION NUMBER — deliberately NOT allocated.** Live head verified `m0086` in BOTH worktrees
> (`v2` schema.ts:3089; `v2-lane-c` identical). `m0087`/`m0088` are claimed on paper by
> MODEL-LADDER-SPEC / TASK-BOARD-SPEC, and a wave running right now may consume further numbers.
> **The build wave allocates from the LIVE head at build time — never from a number a spec happens
> to quote.** (This exact collision already happened once — m0086 was consumed while two specs were
> being written — and is now a CLAUDE.md hard rule.)

---

## 0. Corrections to the briefing (found during grounding — read these first)

1. **`cli-backend.ts` is at `src/lib/server/claude-code/cli-backend.ts`, NOT `runtime/`.** The
   substance of the toolpolicy claim HOLDS: `grep -c toolPolicy` over the backend file = 0 (the
   only hits under `claude-code/` are its test files and `channel.ts:128,553`, which CARRY the
   field harness-side without enforcing it), and the spawn argv has no `--allowedTools`. The
   authoritative write-up is the `toolpolicy-enforcement` BUILD-QUEUE row (`BUILD-QUEUE.md:354`,
   gate:operator), which cites the correct path. §11's out-of-scope argument rests on it.
2. **Minor line drift, immaterial:** `foldVerdictReasons` spans `pm-panel.ts:218-238` (not
   218-241); `falsifierOf` (the legacy string-prefix read-back) is `:522-527`; `listProposalQueue`
   is `:1159-1179`. Everything else in the briefing checked out against the code cited below,
   including the honesty trap in §1.2 and the shared-identity design note at `pm-panel.ts:464-469`.
3. **Verified as claimed, worth restating because it is the load-bearing fact:** the model ALREADY
   produces the qualified stance (`ValidatorVerdict` `pm-panel.ts:100-112`: `falsifier`,
   `evidence[]`, `scope_findings`) and `foldVerdictReasons` then FLATTENS it into prefixed prose in
   `reasons: string[]` — generated, then discarded as structure.

---

## 1. Problem (ground truth, every claim traced)

1. **The structured stance dies at the write boundary.** Each validator emits
   `verdict/confidence/classification/reasons/falsifier/evidence[]/scope_findings` under a
   machine-parsed contract (`pm-panel.ts:100-112`, prompt contract `:278-294`).
   `foldVerdictReasons` (`:218-238`) folds falsifier/evidence/scope into `reasons[]` as prefixed
   prose (`evidence(presence): …`, `falsifier: …`), and the ONLY read-back is string-prefix parsing
   (`falsifierOf`, `:522-527`). "For but with a catch" and "against only because of X" exist at
   generation time and are unrecoverable as data.
2. **Seat ordinal + panel size are never persisted — the single-verdict honesty trap.** The seat
   ordinal lives only inside a synthetic prompt-task id (`panel:<taskid>:seat<n>`, `:459`);
   `PanelVerdictRow` (`workforce/repo.ts:190-208`) carries no seat, no panel size, no model. The
   panel legitimately runs with `validators: 1` (`panelSize = opts.validators ?? 2`, `:421`), so a
   SINGLE verdict renders identically to a full panel — any consensus banner built over today's
   rows would let one agent read as agreement. "2 of 2 seats reported" is uninferable.
3. **The model behind a verdict is invisible.** `session.model` (`schema.ts:126-129`,
   `{provider, model_id, tier}`) is reachable by join from `validator_session` but never selected.
   Precedent for denormalizing it onto the verdict-shaped row exists: `interview_run.provider`/
   `.model_id` (`schema.ts:1109-1110`, "stamped from launch config (D-035), never agent-supplied")
   and `benchmark_verdict.provider/model_id/judge_model` (`:2759-2770`).
4. **Every seat sees the SAME evidence.** `assemblePanelContext` (`:305-374`) hands every seat one
   identical packet: artifact, charter, plan macro, open-task corpus capped at 50 (`:352`),
   tunables. Research finding 7 (§3.1): identical evidence makes deliberation "collapse into
   herding"; partitioned evidence provably reduces inter-agent error correlation. Today's seats are
   independent in session identity only — not in information.
5. **One round, no revision semantics.** A verdict row is written once; `outcome`
   (`schema.ts:1194-1195`) closes it mechanically, but there is no way to express "this seat,
   having read the other seats' arguments, holds / revises" — which is exactly the signal the
   operator's "debate between them" ask needs, and (per §3.1.3) the signal that separates a
   dissenter worth hearing from noise.
6. **The proposal↔participant link is the ONLY link that exists.** `panel_verdict.artifact` +
   `.validator_session` is it. `peer_message` has `reply_to` threading (m0079, `schema.ts:2832`)
   but no artifact column; `decision_brief.options` (`:1287`) is assembler-authored, not
   per-agent. The council's data model must grow from `panel_verdict`, not from the message bus.
7. **The UI has nothing to visualize** — a collapsed `<details>` accordion
   (`routes/projects/[id]/+page.svelte:2154-2190`), stance/confidence/classification crammed into
   one mono meta line, `.verdicts { flex-direction: column }` (`:4433`). This spec does not fix
   the UI; it makes the UI buildable without a rebuild.

---

## 2. The design, stated once and defended (research-grounded; citations are load-bearing)

### 2.1 The shape

- **Round 1 — N independent seats over PARTITIONED evidence (N = 3-5, default 3).** Every seat
  sees the same PUBLIC CORE (the artifact under review, the charter, the plan macro — no seat ever
  judges an artifact it hasn't seen); the auxiliary corpus (the open-task duplication list, and
  later any retrieval context) is split into DISJOINT PRIVATE SLICES, one per seat, with the slice
  manifest persisted on the verdict row. Seats run exactly as today: independent sessions, no
  shared transcript, runner-written verdicts (D-035).
- **Round 2 — exactly ONE anonymized, simultaneous, non-zero-sum exchange, fired only on
  divergence, with the tally hidden.** Each round-2 seat receives its own round-1 stance plus the
  peers' QUALIFIED STANCES (claims, caveats, falsifiers, evidence claims) anonymized — no seat
  numbers, no model ids, no vote count — as FENCED DATA (D-026), and writes a NEW verdict row that
  supersedes its round-1 row. All round-2 seats run in parallel against the same frozen packet;
  no seat sees another seat's round-2 output. Never a third round.
- **Aggregation — mechanical, over round-final rows: stable-dissent blocks, abstain escalates.**
  A pushback that HELD across rounds blocks auto-advance and returns to the PM (the existing
  branch); an abstain, an unresolved blocking caveat, or a unanimity reached only by round-2
  verdict flips goes to the operator through the EXISTING decision-brief machinery. Confidence is
  never a weight — it is a routing signal only.

### 2.2 Why each element (the operator proposed independent → debate → independent; research says: directionally right, but the middle round must change purpose)

1. **This is Nominal Group Technique, not Delphi and not debate.** Delphi's defining middle step
   is anonymized, curated, *statistical* feedback — RAND built it as an ALTERNATIVE to
   face-to-face exchange (Dalkey & Helmer, Management Science 9:458-467, 1963). We do not
   aggregate-and-feed-back statistics; we exchange arguments once. Both Delphi and NGT beat
   freely-interacting groups head-to-head (Van de Ven & Delbecq, AMJ 17:605-621, 1974). Anthropic's
   own *Building effective agents* calls this shape parallelization/voting — not debate.
2. **A competitive debate round is measured NET-NEGATIVE on exactly this task class.** On error
   detection ("does this artifact contain a mistake" — which is what a validation panel does),
   competitive multi-agent debate loses up to **−15pp vs a single agent at matched token budget**;
   only a non-zero-sum "collaborative" protocol beat single-agent, by ~4pp (Chen et al.,
   arXiv 2510.20963; corroborated by Smit et al., *Should we be going MAD?*, ICML 2024,
   arXiv 2311.17371, and Wang et al., arXiv 2402.18272). Hence round 2's framing is
   collaborative and non-adversarial: seats share the goal of the correct verdict, update only on
   argument content, and "restating your position unchanged" is an explicitly legitimate outcome.
3. **The failure mode of exchange targets the dissenter the panel exists to hear.** Flip
   probability is HIGHEST when no peer agrees; correct→incorrect flips EXCEED incorrect→correct;
   an explicit anti-sycophancy payoff did NOT fix it (Wynn et al., arXiv 2509.05396). Voting
   discards a correct answer already in the pool in up to 32.3pp of cases; modal-answer adoption
   reaches 85.5% (arXiv 2605.00914). In ~1 of 4 divergent cases the MINORITY is correct
   (arXiv 2606.29270). Consequences baked in: the tally is hidden in round 2 (the tally IS the
   conformity trigger — a deliberate deviation from both textbook Delphi and mainstream MAD;
   Delphi evidence shows opinion movement tracks low confidence and minority position rather than
   argument quality, and adding rationales to numeric feedback "had little impact", Bolger et al.,
   TFSC 2011); divergence ESCALATES rather than majority-votes; and a lone dissenter's round-2
   flip to unanimity does not unlock auto-advance (§6.3).
4. **Rounds: exactly 2, never 3+.** The canonical MAD config is 3 agents × 2 rounds (Du et al.,
   arXiv 2305.14325); Delphi converges at 2-3 rounds and beyond that attrition drives FALSE
   consensus (Rowe & Wright, IJF 15(4), 1999); judge-side bias (position, verbosity, bandwagon)
   amplifies sharply after round 1 (arXiv 2505.19477). Round 2 also provides the repeat
   measurement that makes per-seat STABILITY computable for free (§6.2).
5. **Anonymization is a BIAS lever, not an accuracy lever — and the spec claims only the former.**
   Blinding identity collapses the Identity Bias Coefficient 0.608 → 0.024 (Choi et al., ACL 2026,
   arXiv 2510.07517), and self-preference is causally tied to self-recognition (Panickssery et
   al., arXiv 2404.13076) — so round-2 packets carry no model badges and no seat ids. The same
   paper's appendix shows anonymization does NOT reliably improve accuracy; this spec makes no
   accuracy claim for it. The persisted audit trail always carries the true session + model —
   anonymity is between seats at deliberation time, never toward the operator (CO-10).
6. **More seats does not work — evidence slicing replaces "more seats" as the independence
   mechanism.** Nine frontier judges across seven families collapse to a Kish effective sample
   size of ≈2.0-2.5; panel accuracy runs 8-22pp short of the Condorcet bound; the best single
   judge matches or beats the full panel; judges 6-9 add +0.22 effective votes; same-family vs
   cross-family correlation differs by only 0.047 (Kohli et al., arXiv 2605.29800). (Not
   contradicted by PoLL, Verga et al., arXiv 2404.18796 — PoLL beats the *average* judge at >7×
   lower cost; Kohli compares to the *best*.) So seats are capped at 5, and the marginal dollar
   goes to the thing that DOES convert: with identical evidence, deliberation herds; partitioning
   into shared-public + disjoint-private subsets provably reduces inter-agent error correlation,
   and removing the asymmetry "eliminates most deliberation gains" (InfoDelphi, arXiv 2607.01661).
   A second, independent argument for asymmetry: debate DOES demonstrably help when participants
   hold assigned stances and information the judge lacks (Khan et al., ICML 2024) — information
   asymmetry is the common ingredient of both results.
7. **Confidence is never a weight.** Verbalized confidence is systematically overconfident (Xiong
   et al., ICLR 2024, arXiv 2306.13063; Tian et al., arXiv 2508.06225); confidence-weighted
   schemes (Dawid-Skene, accuracy-weighted, inverse-φ) recover ≤11% of the independence gap and
   Dawid-Skene UNDERPERFORMED plain majority (Kohli); a shipping vendor measured an LLM severity
   filter as "nearly random" (Greptile, 2024). Confidence is used for ROUTING/ABSTENTION only —
   where it has a provable guarantee: selective evaluation with escalation guarantees agreement to
   a specified level (Jung et al., ICLR 2025, arXiv 2407.18370). Hence the abstain band → operator.
8. **Unanimity is far less diagnostic than it feels when errors are correlated** (Kohli) — which
   is precisely why slicing matters: unanimity across DISJOINT evidence is a strictly stronger
   signal than unanimity over one shared packet, and it is the only unanimity this design lets
   skip round 2.

---

## 3. What this spec ships (one sentence each)

| # | Deliverable | Phase |
|---|---|---|
| 1 | The qualified stance becomes DATA: `falsifier`, `evidence[]`, `caveats[]` as real fields on `panel_verdict` (dual-written beside the legacy prose; legacy prefix read kept), plus `seat`, `panel_size`, `round`, server-stamped `model` — one additive migration. | **P1** |
| 2 | Evidence slicing: `assemblePanelContext` partitions the auxiliary corpus into per-seat disjoint slices over a shared public core, persists the slice manifest, and the evidence rule becomes slice-scoped; seats widen to 1-5 (default 3). | P2 |
| 3 | The deliberation round: divergence-triggered, anonymized, simultaneous, tally-hidden round 2 writing append-only revision rows (`revises` + `revision_reason`; old row closed `'revised'` via the existing function), never a round 3. | P3 |
| 4 | Aggregation + the UI seam: `decidePanel` operates on round-final rows with stable-dissent blocks, the abstain band, and the flip-to-unanimity brief; a `councilView` read model hands the UI wave everything it renders. | P4 |

Non-goals in §11. The visualizer itself ships in the NEXT wave against §9's contract.

---

## 4. Phase 1 — the qualified stance + honest panel accounting

### 4.1 Migration (ONE, additive; id allocated from the live head at build time — §0 header rule)

```sql
-- panel_verdict: the council fields (all additive; legacy rows read back NONE → honest null)
-- verdict widened with its FULL value set (the m0022 lesson: a missing enum value
-- silently fails every write). 'abstain' is schema-legal from P1; the prompt contract
-- offers it only in P4 (§6.4) — additive, un-wired until then (F-053 discipline).
DEFINE FIELD OVERWRITE verdict     ON panel_verdict TYPE string ASSERT $value IN ["approve","pushback","abstain"];
DEFINE FIELD OVERWRITE seat        ON panel_verdict TYPE option<int>;      -- 1-based ordinal
DEFINE FIELD OVERWRITE panel_size  ON panel_verdict TYPE option<int>;      -- seats INTENDED this campaign
DEFINE FIELD OVERWRITE round       ON panel_verdict TYPE option<int>;      -- 1 | 2; legacy rows NONE
DEFINE FIELD OVERWRITE model       ON panel_verdict FLEXIBLE TYPE option<object>;  -- {provider, model_id, tier?} server-stamped
DEFINE FIELD OVERWRITE slice       ON panel_verdict FLEXIBLE TYPE option<object>;  -- §5.3 manifest
DEFINE FIELD OVERWRITE falsifier   ON panel_verdict TYPE option<string>;
DEFINE FIELD OVERWRITE evidence    ON panel_verdict FLEXIBLE TYPE option<array<object>>;  -- §4.2 shape
DEFINE FIELD OVERWRITE caveats     ON panel_verdict FLEXIBLE TYPE option<array<object>>;  -- §4.2 shape
DEFINE FIELD OVERWRITE revises          ON panel_verdict TYPE option<record<panel_verdict>>;  -- round-2 → its round-1 row
DEFINE FIELD OVERWRITE revision_reason  ON panel_verdict TYPE option<string>;               -- REQUIRED by the writer when revises is set
```

- Idempotent by construction (OVERWRITE, F-015); apply-twice + half-applied via the generic
  `schemaMigrations` sweep + a targeted real-surreal test beside the panel tests.
- **No new index** — deliberate: `listPanelVerdictsForArtifact` population is tiny and
  project-scoped reads already ride `panel_verdict_by_project`; a guessed index is a guessed claim.
- **`dedup_key` untouched** (`artifact|validator_session`, `schema.ts:1197`) — immutable inputs
  only (F-048). Round-2 rows collide-proof by construction: each round-2 seat is a NEW session, so
  the pair is fresh. `round` never enters the key.
- `model` is stamped by the RUNNER from the resolved route / launched session's model at write
  time (the `interview_run` precedent: "stamped from launch config (D-035), never
  agent-supplied") — never parsed from LLM output.

### 4.2 The caveat + evidence shapes (read, never regex'd)

```ts
interface VerdictCaveat {
  claim: string;                          // the catch, one sentence
  blocking: boolean;                      // true = must be resolved before this stance is clean
  about: 'claim' | 'inference' | 'scope'; // Argdown: rebut (attacks the artifact's claim)
                                          // vs undercut (attacks the reasoning) vs scope finding
}
// evidence[] persists the EXISTING VerdictEvidence shape (pm-panel.ts:90-98) plus:
//   verified: boolean   — the G1 grounding state, today only encodable as "(unverified)" prose
//   slice?: string      — which slice the claim was grounded in (P2; absent before)
```

- **"For but with a catch"** = `verdict:'approve'` + `caveats:[{blocking:false|true, …}]`.
  **"Against but only because of X"** = `verdict:'pushback'` + a single `blocking:true` caveat
  that IS the reason. The stance itself stays binary-plus-abstain — GitHub's lesson: a qualified
  approval is stance + caveats in a SEPARATE COUNTABLE channel, never a fourth stance value.
- **`about:'inference'` is the undercut**: "approve, but your justification is wrong" must not
  share a row with a rebuttal — the UI wave renders them as distinct channels (§9).
- `scope_findings` fold into `caveats` with `about:'scope'` (one structure, not two).

### 4.3 Writer + reader changes (scope-locked to `pm-panel.ts`, `workforce/repo.ts` + tests)

- `buildValidatorPrompt` output contract adds `caveats` (shape above); `parseValidatorVerdict`
  validates it (bad shape = the existing loud `ValidatorContractError` path, never a silent drop).
- `addPanelVerdict` (call site `pm-panel.ts:503-513`) gains `seat`, `panel_size`, `round: 1`,
  `model`, `falsifier`, `evidence`, `caveats` — and **keeps writing `foldVerdictReasons` prose
  unchanged** (dual-write): `reasons[]` remains the human-readable fallback every existing surface
  renders, and brief assembly keeps working mid-migration.
- **Back-compat read (required — old rows exist):** readers prefer the structured fields; when
  `falsifier`/`evidence`/`caveats` are absent (legacy row), fall back to the existing
  `falsifier: ` prefix parse (`falsifierOf`, `:522-527`) and render evidence lines as prose. A NEW
  row missing structured fields is a contract violation, not a fallback case (CO-2).
- `PanelVerdictRow` (`workforce/repo.ts:190-208`) widens with all new fields, optional; `norm`
  discipline per the data-layer skill (no new datetimes ⇒ no new `isoOrUndef` obligation; `at`
  stays as-is).

### 4.4 Verification (P1 DoD)

- Real-surreal tests (F-020): write-with-all-fields round-trip asserting the SET case (F-013
  lesson — never only the NONE case); legacy-row read-back (structured fields NONE → prefix-parse
  fallback returns the same falsifier the prose carries); apply-twice + half-applied migration.
- `npm run db:up` clean on the LIVE dev DB, twice — **only when the operator pause lifts and the
  datastore is up; this spec's drafting session deliberately did not boot it.**
- Command: `npx vitest run src/lib/server/projects src/lib/server/workforce` + the full green bar.

---

## 5. Phase 2 — evidence slicing (independence you can buy)

### 5.1 What partitions and what never does

- **Public core, every seat, always (CO-12):** the artifact under review (§4.1 fields verbatim,
  `pm-panel.ts:314-323`), the operator charter (`:326-331` — the operator's voice is never
  partitioned away from any seat), the plan macro (`:334-346`), the panel tunables (`:362-371`).
- **Private slice, per seat:** the open-task duplication corpus (`:348-360`). Today every seat
  sees the same first-50 slice (`:352`) and tasks beyond 50 are seen by NOBODY. Partitioned
  round-robin across N seats at ≤50 each, 3 seats cover up to 150 tasks — slicing buys coverage
  as well as decorrelation. Future partitionable sources (retrieval context, scanner output) slot
  into the same manifest; out of scope now.

### 5.2 The evidence rule becomes slice-scoped (prompt + aggregation change)

A seat can no longer claim GLOBAL absence ("no duplicate exists") — only slice absence ("no
duplicate in my slice: tasks 1-25 of 74; search: title scan of the fenced list"). The prompt's
G1 evidence rule (`:264-266`) is updated accordingly; global absence is derived by the AGGREGATOR
as the union of slice absences, and only when the union covers the corpus. An uncovered remainder
is stated honestly in the read model ("74 tasks, 60 covered by seats") — never silently implied
covered (F-008).

### 5.3 The manifest (persisted per row, server-composed)

```ts
interface SliceManifest {
  shared: string[];                                  // citationIds of the public core items
  private: { kind: 'task_corpus'; partition: string; // "2/3"
             ids: string[]; corpus_total: number } | null;  // null = unpartitioned (N=1, or legacy)
}
```

Composed by `assemblePanelContext` (which becomes per-seat), stamped by the runner onto the
verdict row. The UI wave renders "what this seat saw" from it; the stability analysis knows WHY
seats might legitimately differ.

### 5.4 Panel size

`PanelRunOpts.validators` widens `1 | 2` → `1..5`, default **3** (Du et al.'s canonical 3;
Kohli's ESS ≈2-2.5 says 3 well-sliced seats is the efficient point; 5 is the hard cap — seats
6-9 add +0.22 effective votes). Callers passing nothing get 3 once this phase lands; the
single-seat degraded mode stays legal and stays HONEST via `panel_size` (§1.2 fixed by P1).
Default confirmed by the operator before this phase ships (§14.1).

### 5.5 Verification

Unit: partitioner covers the corpus exactly once across seats, no overlap, remainder stated;
per-seat context contains the full public core. Real-surreal: a two-seat run against seeded tasks
persists two disjoint manifests whose union is the corpus. Command as §4.4.

---

## 6. Phase 3 — the deliberation round (append-only, anonymized, simultaneous)

### 6.1 Trigger — divergence only (spend discipline + §2.2.8)

Round 2 fires iff round 1 is DIVERGENT: mixed approve/pushback, OR any blocking caveat attached
to an approve (a "clean" unanimity must be caveat-clean), OR (once P4 lands) any abstain.
Unanimous-clean round 1 over disjoint slices skips round 2 — recorded as a named analytics event
(`panel_round2_skipped`, reason `unanimous_clean`), never silently. Never a third round (CO-11).

### 6.2 Mechanics

- Each round-2 seat is a NEW session (fresh `validator_session` ⇒ fresh `dedup_key`), same seat
  ordinal, same spawn identity (`validationPanelist` — §7), same model route, same private slice
  as its round-1 self plus the SAME public core.
- Packet: the seat's OWN round-1 verdict row (self-attributed — you know which is yours) + every
  peer's qualified stance (verdict withheld? NO — the stance including verdict, but caveats/
  falsifier/evidence claims are the substance) **anonymized and order-shuffled: no seat ordinals,
  no models, no session ids, and NO TALLY LINE** — the packet never states "2 approve, 1
  pushback"; the seat reads arguments, not a scoreboard (§2.2.3). All of it rides as FENCED
  context items (D-026: agent-generated = data, not instructions).
- Prompt framing (non-zero-sum, per §2.2.2): shared goal is the correct verdict; update ONLY on
  argument content; holding your position unchanged is a fully legitimate outcome; if you revise,
  `revision_reason` must name the specific peer argument that moved you.
- All round-2 seats spawn in PARALLEL against the same frozen packet (simultaneity kills
  position/ordering effects, §2.2.4); no round-2 output feeds another round-2 seat.
- Persistence (append-only, D-015/D-028): a NEW row `{round: 2, revises: <round-1 row>,
  revision_reason, …}` via `addPanelVerdict`; the round-1 row is closed
  `outcome:'revised'` via the EXISTING `closePanelVerdictOutcome` (F-055 — the enum value
  already exists, `schema.ts:1194-1195`; no new close path, no mutation of stance fields ever).
  The UI mirror is GitHub's *dismissed-with-reason*, not strikethrough.

### 6.3 Stability — the first-class derived signal

Per seat, derived at read time (never stored — it is a pure function of rows): `held` (round-2
verdict = round-1), `flipped` (differs), `single_round` (no round 2 ran). A dissenter who HOLDS
under the peers' best arguments is signal; one who flips is noise — the disagreement-
deconvolution idea (Gordon et al., CHI 2021: separate stable positions from measurement noise
before aggregating). Round 2 provides the repeat measurement for free. Two hard rules downstream:

- A **stable pushback** blocks auto-advance, full stop — round-final pushback routes to the
  existing return-to-PM branch, exactly as any pushback does today.
- **Unanimity reached only by verdict flips does NOT unlock the act-authority auto-advance.**
  A formerly-lone dissenter flipping to approve is the single least trustworthy transition in the
  literature (Wynn: flip probability highest when alone; correct→incorrect exceeds
  incorrect→correct). Flip-made unanimity goes to a decision brief (classification `'taste'`,
  the existing enum) carrying the flip + its `revision_reason` — the operator sees THAT consensus
  was deliberation-made and WHY. This only ADDS an operator stop relative to today (CO-3).

### 6.4 `decidePanel` becomes round-final

`decidePanel` (`:530+`) filters to round-final rows (a row is round-final iff no row `revises`
it — equivalently `outcome != 'revised'` among open-campaign rows, which the existing
`outcome == null` filter at `:517` already almost gives; the build makes it explicit). Its
closure table is otherwise UNCHANGED in P3: all-approve → existing act/propose branches; any
pushback → return-to-PM; operator_challenge → brief. P4 adds: abstain → brief; blocking-caveat
approve → brief; flip-made unanimity → brief (§6.3). The abstain option enters the PROMPT
contract only here in P4, with its required discipline: an abstain carries a falsifier-style
statement of what evidence would have decided it — an abstain without a named evidence gap is a
contract violation.

### 6.5 Verification

Real-surreal: divergent round-1 fixture → round-2 rows written with `revises` set + old rows
`'revised'` + `dedup_key` no-collision; unanimous-clean fixture → no round 2, skip event
recorded. Unit: packet builder emits no tally, no seat ids, no models (assert the strings never
appear); parallel spawn; stability derivation over all three states. Command as §4.4.

---

## 7. Seat identity — personas are a DISPLAY layer, and the badge never lies

The conflict, named: all seats deliberately share ONE spawn identity
(`spawnIdentity('validationPanelist')`, `pm-panel.ts:464-469`; `sessions/spawn-identity.ts:72-76`)
because per-seat identities were the F-046 leak — a session-unique key standing in as an agent
identity, rendering N unrelated one-session clusters in the living scene. A persona view that
reintroduced per-seat spawn identities would re-break the lifecycle graph.

**Resolution: personas are NOT per-seat identities, and this spec does not create any.** The seats
ARE the same agent, run N times over different evidence — and after P1/P2 that difference is
finally DATA: `seat`, `slice`, `model`, `round`. The persona the operator sees is a composition
over those fields, built with the EXISTING shared naming composer (`src/lib/shared/naming.ts` —
identity · subject · qualifier, `isPlaceholder` honest-unknown), never a second naming path:

- identity = the spawn identity's purpose (`validation-panelist`) — WHAT it is;
- subject = the artifact + the seat's slice descriptor ("seat 2 of 3 · saw tasks 26-50");
- qualifier = the demoted model (`claude-opus-4-8`) — the badge the operator asked for, in the
  slot naming.ts assigns models: **a qualifier, never the identity** (its header: a display name
  degrading to a MODEL TIER is a defect of the F-008 severity class).

No fabricated persona names ("Skeptical Sam") — an invented character conveys nothing real and is
the exact defect class the naming rule exists to kill. If future catalog-role validators sit
(`validator_kind:'catalog_role'`), the ROLE is the honest persona — that flip is out of scope
(§11) but the composition above already prefers role.name when present, for free.

---

## 8. Cost (stated honestly — every seat is a real LLM session)

- Today: 2 sessions per panel run. After P2 (default 3 seats): 3 sessions. After P3, a DIVERGENT
  artifact runs ≤6 (3 + ≤3); a clean one stays at 3. Worst case ≈3× today's panel spend per
  artifact; typical case (clean panels skip round 2) ≈1.5×.
- The research allocation argument (§2.2.6-7): the marginal dollar goes to evidence slicing —
  which costs ~0 extra tokens (same corpus, split) — NOT to more seats (ESS ≈2-2.5) and NOT to
  more rounds (bias amplifies, false consensus). This design spends where the evidence says
  spending converts.
- Seats ride the existing budget plumbing (`SpawnBudgets` through `launchSession`,
  `pm-panel.ts:473`) and the armed daily/per-project token budgets. **Any live panel run is real
  spend and requires recorded operator consent** (CLAUDE.md §6) — nothing in this spec arms a
  trigger; the panel runs when it runs today (PM flow / operator action), just wider.

---

## 9. UI job vs modelling job — the handoff contract (so the next wave never reopens this one)

**Modelling (THIS spec):** every field in §4-§6; the slice manifests; the round/revision chain;
the stability derivation; and ONE read model — `councilView(db, artifactId)` (beside
`listProposalQueue`, `pm-panel.ts:1159-1179`, which stays untouched for existing callers):

```ts
interface CouncilView {
  panel: { panel_size: number | null;      // null = legacy campaign — UI renders "size unknown"
           seats_reported: number; round_two: 'ran' | 'skipped_unanimous' | 'none';
           corpus_coverage: { total: number; covered: number } | null;
           headline: 'approve' | 'pushback' | 'abstain' | 'escalated' | null };
  seats: Array<{ seat: number | null; display: DescribeResult;  // naming.ts composition, §7
                 model: { provider: string; model_id: string; tier?: string } | null;
                 slice: SliceManifest | null;
                 stability: 'held' | 'flipped' | 'single_round';
                 rounds: PanelVerdictRow[] }>;                   // round-1 first; POJOs, ISO dates
}
```

- `headline` is Polis-style **worst-stable-seat**, never a mean: the panel's approval is its
  least-approving stable seat (group-informed consensus). Any aggregate ALWAYS travels with
  `{seats_reported, panel_size}` — the §1.2 honesty fix is structural (CO-13).
- POJOs only, datetimes ISO in the repo layer (F-013); honest nulls for every legacy absence.

**UI (the NEXT wave — none of this is built here):** the visualizer page/panel; persona cards per
§7's composition; for/against columns with the caveat channel rendered separately from the stance
(GitHub convention); rebut vs undercut as distinct visual channels (`about` field); Value-
Suppressing Uncertainty Palettes — desaturate by confidence so a panel of hedging seats LOOKS
like mush, which is the honest rendering (Correll/Moritz/Heer, CHI 2018); the disagreement axis
promoted to a named node between seats (IBIS issue/position/argument); superseded round-1 rows as
*dismissed-with-reason*; the consensus banner derived ONLY from `panel.{seats_reported,
panel_size, headline}`. The existing accordion (`+page.svelte:2154-2190`) keeps rendering
`reasons[]` prose unchanged until that wave replaces it.

---

## 10. Invariants (CO-N — each testable; red-team these)

| ID | Invariant | Pinned by |
|---|---|---|
| CO-1 | Confidence is NEVER a weight in any aggregation; it may only route (abstain band, brief escalation). No confidence-weighted vote exists anywhere. | grep-gate on the aggregator + unit tests over mixed-confidence fixtures |
| CO-2 | A stance is never inferred from prose (F-008): structured fields are authoritative; the `falsifier: ` prefix parse runs ONLY for rows predating the migration; a post-migration row missing structured fields fails loud (ValidatorContractError class), never regex-fallback. | reader test: legacy row → fallback; new row missing fields → throw |
| CO-3 | The operator's D-039 approval point survives intact: `decidePanel` remains the ONLY automated promoter; every council outcome maps to an EXISTING closure branch; the new rules (abstain, blocking caveat, flip-made unanimity, stable dissent) only ADD operator stops, never remove one; nothing presents the swap ceremony without the operator. | closure-table test enumerating every outcome × authority combination |
| CO-4 | Untrusted content stays DATA (D-026): peer stances in round-2 packets ride fenced context items; only `origin=operator` steers (D-035a); verdict rows are written by the RUNNER only (D-035) — `seat`/`panel_size`/`round`/`model`/`slice` are server-stamped, never parsed from LLM output. | packet-builder test + grep-gate: no LLM-derived value reaches those fields |
| CO-5 | Every gated state change routes through the EXISTING gate (F-055): promotion via `setStatus` inside `decidePanel`; row closure via `closePanelVerdictOutcome`; operator asks via `createDecisionBrief`; no second promoter, closer, or brief writer. | grep-gate + closure tests |
| CO-6 | The migration is idempotent (F-015; OVERWRITE-only, additive), and the `verdict` enum is widened with its FULL value set (m0022). Apply-twice + half-applied both converge. | migrate sweep + targeted test |
| CO-7 | Every new/changed query has a real-surreal test asserting the SET case (F-020/F-013); every read-model datetime is ISO; every legacy absence renders honest null/'—', never a fabricated value. | repo + councilView tests, live db:up |
| CO-8 | Rounds are append-only (D-015/D-028): a round-2 row never mutates a round-1 row's stance fields; the only write to a prior row is the existing `outcome:'revised'` close; supersession = new row + `revises` + non-empty `revision_reason`. | write-path test: round-1 row byte-identical post-round-2 except `outcome` |
| CO-9 | `dedup_key` stays on immutable inputs (F-048), unchanged; round-2 rows never collide (new session per seat). | real-surreal double-write test |
| CO-10 | Anonymization is between seats at deliberation time ONLY; the persisted trail always carries true session + model; the spec and UI claim bias reduction, never accuracy, for it. | packet test (no ids/models/tally in packet) + row test (ids/models present) |
| CO-11 | Seats 1-5 hard-bounded; rounds ≤2 hard-capped; round 2 fires only on divergence and a skip is recorded as a named event, never silent. | runner tests over unanimous + divergent fixtures |
| CO-12 | Slicing never hides the artifact: the proposed task, charter, and plan macro are in EVERY seat's public core; only auxiliary corpus partitions; slice-scoped absence-claims aggregate to global absence ONLY when the union covers the corpus, else the gap is stated. | partitioner + aggregator tests |
| CO-13 | A single seat can never render as consensus: `panel_size` + `seats_reported` are persisted/derived and travel with EVERY aggregate the read model emits; a legacy campaign reports `panel_size: null`, rendered as unknown — never assumed complete. | councilView tests incl. `validators:1` and legacy fixtures |
| CO-14 | Display composition goes through `src/lib/shared/naming.ts` (identity · subject · qualifier, `isPlaceholder`): the model is always a qualifier, never the identity; no fabricated persona names; no per-seat spawn identities (F-046 stays fixed — `validationPanelist` remains the one identity). | naming composition test + grep-gate on spawnIdentity call sites |
| CO-15 | Spend honesty: any live panel run is real spend behind recorded operator consent; round 2 is bounded by the divergence trigger; the run's session costs meter through the existing `agent_event` plumbing untouched. | budget plumbing test + consent check in the wave brief |

---

## 11. Explicitly OUT of scope (with the reason each is out)

1. **The researching council (web-tool seats).** BLOCKED on `toolpolicy-enforcement`
   (BUILD-QUEUE.md:354, gate:operator): `toolPolicy` is declared at spawn
   (`pm-panel.ts:474` `{allow:['Read']}`), persisted onto the session as "the effective grant"
   (`sessions/launch.ts:431`), and NEVER enforced — zero references in
   `claude-code/cli-backend.ts` (§0.1 path correction) and no `--allowedTools` in the argv.
   Granting `WebSearch`/`WebFetch` on top of an unenforced allow-list yields an UNBOUNDED seat,
   not a researching one; and fetched web content would need the D-026 screen/fence treatment
   (`screen.ts`/`fence.ts`), which today covers DB rows only. Enforcement lands first, by its own
   operator-gated queue item; the council does not smuggle it in.
2. **The brain's reader council.** That is observer-loop v3 territory (BRAIN-OBSERVER-LOOP-SPEC /
   BRAIN-ALIVE-UI-SPEC's "COUNCIL THEATER"), operator-gated on its own track. Same word, different
   subsystem — this spec deliberately does not touch the brain, and the UI wave must not conflate
   the two surfaces.
3. **The visualizer itself.** This spec ends at §9's read model. Building the UI in the same wave
   as the model re-creates the exact rebuild risk this two-wave split exists to avoid.
4. **The catalog-role validator flip** (`validator_kind:'catalog_role'` composition once the
   launch five pass their gauntlets — `pm-panel.ts:6-10`). Orthogonal to rounds/slices; the §7
   composition already benefits from it when it lands.
5. **Partitioning retrieval/scanner context.** The manifest shape (§5.3) accommodates it; wiring
   it is a follow-up once the task-corpus partition proves out.

---

## 12. Honest uncertainty (do not smooth these over — a confident wrong answer here costs real money in a design we would then unbuild)

1. **Several load-bearing citations are 2026 preprints, not peer-reviewed:** Kohli
   (arXiv 2605.29800 — the ESS/more-seats result the seat cap rests on), InfoDelphi
   (arXiv 2607.01661 — the slicing result P2 rests on), the oracle-gap and minority-correct
   numbers (2605.00914, 2606.29270), Wynn (2509.05396), Tian (2508.06225). The peer-reviewed
   anchors (Du 2023 as published convention, Smit ICML 2024, Khan ICML 2024, Xiong ICLR 2024,
   Jung ICLR 2025, Choi ACL 2026, Van de Ven & Delbecq 1974, Rowe & Wright 1999, Bolger 2011,
   Gordon CHI 2021, Correll CHI 2018) support the DIRECTION but not every magnitude.
2. **Order effects in debate are genuinely contested; attribution effects are well-established.**
   The design leans on the established side (anonymization, simultaneity) and treats
   ordering-related magnitudes as soft.
3. **One contrary result on confidence:** arXiv 2311.08152 finds confidence useful in a review
   setting. CO-1 still stands — routing-only is robust to confidence being somewhat informative;
   it is NOT robust to overconfidence being weighted, which is the asymmetry that decides it.
4. **Debate demonstrably WORKS under assigned stances + a less-informed judge + information
   asymmetry (Khan et al., ICML 2024).** This cuts both ways: it is a second argument for
   evidence slicing (§2.2.6), and it is a caution that the anti-debate results (§2.2.2) are
   protocol-dependent, not a law of nature.
5. **A 2026 survey of 141 MAD studies finds the field's conventions settled "by convention rather
   than systematic comparison."** Including, in honesty, some conventions this spec adopts
   (2 rounds, 3 agents).
6. **Design consequence — a built-in kill-criterion, not a shrug:** P1/P2 are safe under all of
   the above (structured data + slicing cost ~nothing and fix live honesty defects). P3 (round 2)
   is the element the contested evidence bears on. It ships with its own measurement: the
   stability/flip distribution and per-round outcome deltas land in the existing analytics
   stream, and if lived data shows round 2 producing flips-to-majority without operator-visible
   argument quality (the Wynn signature), the divergence trigger is narrowed or round 2 is
   retired — P1/P2/P4 stand without it. The phases are severable by design.

---

## 13. Phased build (each independently shippable; order binding)

| Phase | Scope lock (files) | Ships alone? | Verification command |
|---|---|---|---|
| **P1 qualified stance + accounting** | `db/schema.ts` (one migration, id from live head), `projects/pm-panel.ts`, `workforce/repo.ts`, their tests | Yes — fixes §1.1-1.3 with zero closure-behavior change | `npx vitest run src/lib/server/projects src/lib/server/workforce` + `npm run db:up` ×2 + green bar |
| **P2 evidence slicing** | `projects/pm-panel.ts` (assemblePanelContext per-seat + prompt evidence rule + PanelRunOpts 1..5), tests | Yes — still single-round; manifests persisted via P1 fields | same command + partitioner tests |
| **P3 round 2** | `projects/pm-panel.ts` (trigger, packet builder, parallel round-2 spawn, revises/close wiring, decidePanel round-final filter), tests | Yes — divergent panels deliberate; closure branches unchanged | same + §6.5 real-surreal set |
| **P4 aggregation + councilView** | `projects/pm-panel.ts` (abstain in contract, brief routings, worst-stable-seat), the `councilView` read model + tests | Yes — the UI wave's entire input lands here | same + councilView POJO/ISO/legacy tests |

Deferred beyond this spec: everything in §11; PM-memory learning from caveats (pushback reasons
already feed `pm_memory` — caveat-aware learning is a PM-SPEC follow-up); retrieval-context
slices; catalog-role personas.

## 14. ASSUMED (unanswered — stated, not silent)

1. **Default seat count 3** (§5.4) is this spec's recommendation from the evidence, not an
   operator decision yet — confirm before P2 ships; the knob is `opts.validators` either way.
2. **No live-DB re-query this session** (OPERATOR PAUSE #6 — servers deliberately left down; the
   pause forbids touching :8000). Live `panel_verdict` population, and whether any legacy row
   carries an `artifact_kind` other than `'task'`, are re-checked for free during the build
   wave's `db:up` live-verify.
3. **Both worktree tips are partially unverified** (pause note) — every `file:line` here was read
   from `v2` @ `6878d14` and re-verifies at build time; drift is expected, substance is pinned.
4. **`resolvePmRoute` is assumed to remain the seats' model authority** (`pm-panel.ts:447-450`);
   if the MODEL-LADDER duty machinery lands first, panel seats pick up tier documentation for
   free and nothing here changes.
