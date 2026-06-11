# WORKFORCE-SPEC — role workforce: interview gauntlet, track records, staffing

> Operator-shaped 2026-06-10. Completes HARVEST-GSTACK Lane D (D6/D7) and PM-SPEC §7. The **D7 gauntlet + track-record data plane builds in wave v2.1**; performance-review loop, `project_staff`, and tier-aware hiring build as **wave v2.3** (after v2.1 produces real track data; the missed-defect ledger additionally needs v2.2b's B2). Supersedes one sentence of PM-SPEC §7 / Lane D #1: **prompt cores are PRODUCT rows** (`role`/`role_version`, hash-bound — gate integrity must not depend on disk files never drifting; D-032 precedent); the D-036 catalog supplies only the capability bundles. At spawn the runtime materializes the version's prompt core as a transient agent .md into the session's isolated config (the existing `isolatedConfigFor` + `harness/wiring.ts` `resolveCatalog → composeCapabilities` seam).

## 1. Purpose & scope

Five harvest-derived catalog roles (`security-officer`, `code-reviewer`, `qa-lead`, `design-reviewer`, `investigator`) become hireable, **certified** workers: a role version is deployable only after passing an interview gauntlet of fixtures with planted, known defects, and every verdict it ever produces is traceable to the exact prompt text + model that produced it.

| Item | Wave |
|---|---|
| §2 data plane (tables, normalizers, deployability resolver, session widen) | v2.1 task W-D7a |
| §3 gauntlet engine (runner, scorer, pass bar, budget) | v2.1 task W-D7b |
| Launch fixtures/keys + day-0 ceremony + §8 surfaces | v2.1 task W-D7c |
| §5 performance-review loop · §6 project_staff · §7 tier-aware hiring | v2.3 |
| §7b `researcher` role + research rails (operator-approved 2026-06-11) | v2.3 |
| Missed-defect ledger (§4.1) | v2.3, after B2 (v2.2b) |

## 2. Data plane (migrations land at the next free m-numbers, m0029+)

Conventions (all DDL): SurrealDB 2.x, every DEFINE carries OVERWRITE (F-015), apply-twice + half-applied-recovery tests per the m0025 case study; free-form JSON columns are FLEXIBLE (DATA-MODEL §4.16); enums that can be absent are `option<T>` or carry a non-NONE DEFAULT; dedup uses the D-008 VALUE+UNIQUE pattern; every datetime is ISO-coerced in row normalizers, absent → null → '—', asserted on a row where the field is SET (F-013). Record ids pass the db/validate.ts chokepoint (D-016) — slug-derived ids use underscores (`role:code_reviewer`); the display slug keeps the hyphen (`code-reviewer`).

### 2.1 Tables (v2.1)

```sql
DEFINE TABLE OVERWRITE role SCHEMAFULL;
DEFINE FIELD OVERWRITE slug           ON role TYPE string;                 -- hyphenated display name
DEFINE FIELD OVERWRITE name           ON role TYPE string;
DEFINE FIELD OVERWRITE purpose        ON role TYPE string;                 -- reason-to-exist (D-038 #5)
DEFINE FIELD OVERWRITE provenance     ON role TYPE option<string>;         -- "harvested: gstack <path>, MIT"
DEFINE FIELD OVERWRITE active_version ON role TYPE option<record<role_version>>; -- THE incumbency pointer (§2.3); NONE = not deployable
DEFINE FIELD OVERWRITE preferred_tier ON role TYPE option<string>
  ASSERT $value = NONE OR $value IN ["local","haiku","sonnet","opus"];
DEFINE FIELD OVERWRITE status         ON role TYPE string DEFAULT "active" ASSERT $value IN ["active","archived"]; -- D-015
DEFINE FIELD OVERWRITE created_at     ON role TYPE datetime DEFAULT time::now();
DEFINE FIELD OVERWRITE updated_at     ON role TYPE datetime DEFAULT time::now();
DEFINE INDEX OVERWRITE role_slug ON role FIELDS slug UNIQUE;  -- NOTE: an archived role holds its slug (no reuse); fine at operator-managed scale

-- Content fields (prompt_core, prompt_sha, capabilities, version, source) are IMMUTABLE after creation;
-- lifecycle/timestamps are the mutable state machine. A revision is a NEW row — failed verdicts can't be laundered.
DEFINE TABLE OVERWRITE role_version SCHEMAFULL;
DEFINE FIELD OVERWRITE role         ON role_version TYPE record<role>;
DEFINE FIELD OVERWRITE version      ON role_version TYPE int;              -- monotonic per role
DEFINE FIELD OVERWRITE prompt_core  ON role_version TYPE string;           -- the full methodology text
DEFINE FIELD OVERWRITE prompt_sha   ON role_version TYPE string;           -- sha256(canonical JSON {prompt_core, capabilities w/ sorted id arrays})
DEFINE FIELD OVERWRITE capabilities ON role_version FLEXIBLE TYPE object DEFAULT {}; -- D-036 {skills,agents,mcp}; catalog-validated fail-closed at write AND spawn
DEFINE FIELD OVERWRITE default_tier ON role_version TYPE string ASSERT $value IN ["local","haiku","sonnet","opus"];
DEFINE FIELD OVERWRITE source       ON role_version TYPE string DEFAULT "operator" ASSERT $value IN ["operator","pm_proposal","import"];
DEFINE FIELD OVERWRITE proposal     ON role_version TYPE option<record<review_proposal>>; -- set when source=pm_proposal (§5)
DEFINE FIELD OVERWRITE lifecycle    ON role_version TYPE string DEFAULT "draft"
  ASSERT $value IN ["draft","interviewing","passed","failed","error","withdrawn","retired"];
DEFINE FIELD OVERWRITE activated_at ON role_version TYPE option<datetime>;  -- INFORMATIONAL stamp on swap; never read for incumbency
DEFINE FIELD OVERWRITE retired_at   ON role_version TYPE option<datetime>;
DEFINE FIELD OVERWRITE created_at   ON role_version TYPE datetime DEFAULT time::now();
DEFINE FIELD OVERWRITE dedup_key    ON role_version VALUE <string>role + '|' + <string>version;
DEFINE INDEX OVERWRITE role_version_dedup   ON role_version FIELDS dedup_key UNIQUE;
DEFINE INDEX OVERWRITE role_version_by_role ON role_version FIELDS role;
DEFINE INDEX OVERWRITE role_version_by_sha  ON role_version FIELDS prompt_sha;

-- One gauntlet execution of one version at one resolved model. Hashes are COPIED at run start (defense in depth).
DEFINE TABLE OVERWRITE interview_run SCHEMAFULL;
DEFINE FIELD OVERWRITE role            ON interview_run TYPE record<role>;
DEFINE FIELD OVERWRITE role_version    ON interview_run TYPE record<role_version>;
DEFINE FIELD OVERWRITE prompt_sha      ON interview_run TYPE string;
DEFINE FIELD OVERWRITE tier            ON interview_run TYPE string ASSERT $value IN ["local","haiku","sonnet","opus"]; -- UX label
DEFINE FIELD OVERWRITE provider        ON interview_run TYPE string;
DEFINE FIELD OVERWRITE model_id        ON interview_run TYPE string;        -- RESOLVED model = certification axis (§2.4); stamped from launch config (D-035), never agent-supplied
DEFINE FIELD OVERWRITE fixture_set_sha ON interview_run TYPE string;        -- sha256 over sorted (fixture id + content_sha) of the EXACT set run
DEFINE FIELD OVERWRITE bundle_digest   ON interview_run TYPE string DEFAULT "unhashed"; -- §2.6
DEFINE FIELD OVERWRITE session         ON interview_run TYPE option<record<session>>;   -- candidate session, kind='interview'
DEFINE FIELD OVERWRITE status          ON interview_run TYPE string DEFAULT "running"
  ASSERT $value IN ["running","adjudicating","passed","failed","error"];  -- adjudicating = scorer done, operator queue non-empty (§3.4)
DEFINE FIELD OVERWRITE error_reason    ON interview_run TYPE option<string>             -- REQUIRED when status='error'; classified mechanically by the runner (§3.6)
  ASSERT $value = NONE OR $value IN ["env_timeout","spawn_failure","scorer_error"];
DEFINE FIELD OVERWRITE retry_of        ON interview_run TYPE option<record<interview_run>>;
DEFINE FIELD OVERWRITE planted_total   ON interview_run TYPE int DEFAULT 0;
DEFINE FIELD OVERWRITE planted_found   ON interview_run TYPE int DEFAULT 0;
DEFINE FIELD OVERWRITE false_positives ON interview_run TYPE int DEFAULT 0;
DEFINE FIELD OVERWRITE ambiguous       ON interview_run FLEXIBLE TYPE array<object> DEFAULT []; -- operator adjudication queue (§3.4)
DEFINE FIELD OVERWRITE results         ON interview_run FLEXIBLE TYPE array<object> DEFAULT []; -- per fixture {fixture, found[], missed[], extra[], evidence}
DEFINE FIELD OVERWRITE pass_criteria   ON interview_run FLEXIBLE TYPE object DEFAULT {};        -- SNAPSHOT of config/workforce.yaml gauntlet.* in effect
DEFINE FIELD OVERWRITE stale           ON interview_run TYPE bool DEFAULT false;  -- fixture pool changed since this run (§3.7); honest flag, NOT revocation
DEFINE FIELD OVERWRITE cost_usd        ON interview_run TYPE option<float>;       -- summed from PRICED agent_event rows only (F-008)
DEFINE FIELD OVERWRITE started_at      ON interview_run TYPE datetime DEFAULT time::now();
DEFINE FIELD OVERWRITE ended_at        ON interview_run TYPE option<datetime>;
DEFINE INDEX OVERWRITE interview_by_version ON interview_run FIELDS role_version;
DEFINE INDEX OVERWRITE interview_by_role    ON interview_run FIELDS role;

-- Candidate-visible work ONLY. Work trees are DB rows materialized into the run workspace at run start (§3.1).
DEFINE TABLE OVERWRITE gauntlet_fixture SCHEMAFULL;
DEFINE FIELD OVERWRITE role        ON gauntlet_fixture TYPE record<role>;
DEFINE FIELD OVERWRITE slug        ON gauntlet_fixture TYPE string;
DEFINE FIELD OVERWRITE kind        ON gauntlet_fixture TYPE string
  ASSERT $value IN ["planted_defect","planted_absence","hallucination_bait","clean_control","scorer_control"];
DEFINE FIELD OVERWRITE work        ON gauntlet_fixture FLEXIBLE TYPE object;     -- {relative_path: content}; NO answer-key material, EVER
DEFINE FIELD OVERWRITE content_sha ON gauntlet_fixture TYPE string;              -- sha256 over canonical work
DEFINE FIELD OVERWRITE sentinel    ON gauntlet_fixture TYPE string;              -- unique ULID embedded in work; leak tripwire (§4.2)
DEFINE FIELD OVERWRITE provenance  ON gauntlet_fixture TYPE option<string>;      -- 'fails: F-015' | finding link | 'harvest: <path>'
DEFINE FIELD OVERWRITE status      ON gauntlet_fixture TYPE string DEFAULT "proposed" ASSERT $value IN ["proposed","active","retired"];
DEFINE FIELD OVERWRITE created_at  ON gauntlet_fixture TYPE datetime DEFAULT time::now();
DEFINE FIELD OVERWRITE dedup_key   ON gauntlet_fixture VALUE <string>role + '|' + slug;
DEFINE INDEX OVERWRITE gauntlet_fixture_dedup ON gauntlet_fixture FIELDS dedup_key UNIQUE;

-- ANSWER KEYS. Content-addressed to the work they answer. READ PATH: exactly one — the deterministic
-- scorer (§3.4), product code running OUTSIDE any session. No session, briefing, recall, PM snapshot,
-- or export path reads this table; the PM has NO read path to keys (§4.4). Enforced by a unit fixture.
DEFINE TABLE OVERWRITE gauntlet_key SCHEMAFULL;
DEFINE FIELD OVERWRITE fixture          ON gauntlet_key TYPE record<gauntlet_fixture>;
DEFINE FIELD OVERWRITE content_sha      ON gauntlet_key TYPE string;             -- must equal the fixture's content_sha (binding)
DEFINE FIELD OVERWRITE plants           ON gauntlet_key FLEXIBLE TYPE array<object> DEFAULT []; -- [{id, class, location, detection, severity}] machine-checkable
DEFINE FIELD OVERWRITE fp_tolerance     ON gauntlet_key TYPE int DEFAULT 0;      -- per-fixture, operator-authored (§3.5)
DEFINE FIELD OVERWRITE fp_justification ON gauntlet_key TYPE option<string>;
DEFINE FIELD OVERWRITE author           ON gauntlet_key TYPE string DEFAULT "operator"
  ASSERT $value IN ["operator","fixing_commit_diff"];                            -- §4.4: keys are operator-authored or mechanically derived; never PM/agent
DEFINE FIELD OVERWRITE reference_runs   ON gauntlet_key FLEXIBLE TYPE array<object> DEFAULT []; -- admission proofs per tier: [{tier, model_id, interview_run, at}] (§3.8)
DEFINE FIELD OVERWRITE created_at       ON gauntlet_key TYPE datetime DEFAULT time::now();
DEFINE FIELD OVERWRITE dedup_key        ON gauntlet_key VALUE <string>fixture;
DEFINE INDEX OVERWRITE gauntlet_key_dedup ON gauntlet_key FIELDS dedup_key UNIQUE;

-- PM-SPEC §4.3 'verdicts recorded'. Management-validation artifacts ONLY (§2.5 boundary with B2).
DEFINE TABLE OVERWRITE panel_verdict SCHEMAFULL;
DEFINE FIELD OVERWRITE project           ON panel_verdict TYPE option<record<project>>; -- NONE for project-less workforce artifacts (global role revisions)
DEFINE FIELD OVERWRITE artifact          ON panel_verdict TYPE record;           -- generic target
DEFINE FIELD OVERWRITE artifact_kind     ON panel_verdict TYPE string ASSERT $value IN ["task","review_proposal","fixture_proposal"];
DEFINE FIELD OVERWRITE validator_session ON panel_verdict TYPE record<session>;
DEFINE FIELD OVERWRITE validator_kind    ON panel_verdict TYPE string DEFAULT "inline" ASSERT $value IN ["inline","catalog_role"]; -- §9 bootstrap bridge
DEFINE FIELD OVERWRITE role              ON panel_verdict TYPE option<record<role>>;          -- set when validator_kind='catalog_role'
DEFINE FIELD OVERWRITE role_version      ON panel_verdict TYPE option<record<role_version>>;
DEFINE FIELD OVERWRITE verdict           ON panel_verdict TYPE string ASSERT $value IN ["approve","pushback"];
DEFINE FIELD OVERWRITE reasons           ON panel_verdict TYPE array<string> DEFAULT [];
DEFINE FIELD OVERWRITE confidence        ON panel_verdict TYPE option<string> ASSERT $value = NONE OR $value IN ["low","medium","high"]; -- A1 calibration tier
DEFINE FIELD OVERWRITE outcome           ON panel_verdict TYPE option<string>   -- closed LATER, mechanically (§2.2)
  ASSERT $value = NONE OR $value IN ["upheld","overridden_by_operator","revised","withdrawn"];
DEFINE FIELD OVERWRITE at                ON panel_verdict TYPE datetime DEFAULT time::now();
DEFINE FIELD OVERWRITE dedup_key         ON panel_verdict VALUE <string>artifact + '|' + <string>validator_session; -- D-008
DEFINE INDEX OVERWRITE panel_verdict_dedup      ON panel_verdict FIELDS dedup_key UNIQUE;
DEFINE INDEX OVERWRITE panel_verdict_by_version ON panel_verdict FIELDS role_version;
DEFINE INDEX OVERWRITE panel_verdict_by_project ON panel_verdict FIELDS project;

-- Append-only workforce audit feed; single producer = the harness functions that mutate the source rows.
DEFINE TABLE OVERWRITE role_event SCHEMAFULL;
DEFINE FIELD OVERWRITE role         ON role_event TYPE record<role>;
DEFINE FIELD OVERWRITE role_version ON role_event TYPE option<record<role_version>>;
DEFINE FIELD OVERWRITE op           ON role_event TYPE string
  ASSERT $value IN ["created","interviewed","swap","retired","archived","tier_changed","staffed","unstaffed","fixture_activated","stale_marked"];
DEFINE FIELD OVERWRITE detail       ON role_event FLEXIBLE TYPE option<object>;  -- swap: {from, to, operator_confirmed: true}
DEFINE FIELD OVERWRITE at           ON role_event TYPE datetime DEFAULT time::now();
DEFINE INDEX OVERWRITE role_event_by_role ON role_event FIELDS role;
```

**Additive on `session` (same migration):** `role option<record<role>>`, `role_version option<record<role_version>>`, index `session_by_role_version`, and widen the `kind` enum to `["chat","task","review","release","discussion","interview"]` (OVERWRITE redefine — the m0022 lesson: a missing enum value silently fails every write).

### 2.2 Lifecycle & outcome closure
- **One lifecycle enum**: `draft → interviewing → (passed | failed | error)`; `error → interviewing` on retry (§3.6); `withdrawn` allowed from draft, passed, or unretried error (no stuck exit-less rows); `retired` is terminal (explicit operator act; drains in-flight sessions gracefully, §4.6). `failed` is terminal for the row — a fix is a NEW version. There is **no 'incumbent' lifecycle state**: a swapped-out version simply stays `passed` (and remains pinnable, §2.4).
- **Lifecycle records the CERTIFICATION CAMPAIGN only.** Subsequent `interview_run`s against an already-`passed` version (re-interviews after stale-marking, comparison runs, multi-tier probes) accumulate as EVIDENCE rows and **never mutate lifecycle** — deployability is always the existential §2.4 check over runs; only an operator retire/withdraw moves a passed row. (A failed re-run therefore flags honestly on the card without demoting the version or breaking pins.)
- **`panel_verdict.outcome` closure is mechanical, harness-only, server-side stamped (D-035)** — never PM/LLM judgment: operator gate action rejecting a panel-approved artifact → `overridden_by_operator`; the proposal pipeline writes `revised` (successor artifact/version row) and `withdrawn` (PM withdrawal row); task terminal state (done, unmodified) → `upheld`.

### 2.3 Incumbency
`role.active_version` is the **single source of truth**. A swap = ONE pointer write + ONE append-only `role_event {op:'swap', detail:{from, to, operator_confirmed:true}}` — nothing else is load-bearing. `activated_at`/`retired_at` stamps on version rows are informational display data only; no resolver reads them for deployability. This keeps the swap transaction minimal (F-015: assume it can die mid-apply).

### 2.4 Deployability resolver (the spawn-time invariant, fail-closed)
A (version, model) pair is spawnable iff there exists an `interview_run` with `status='passed' AND model_id=$resolved AND prompt_sha = role_version.prompt_sha`. **Certification key = (prompt_sha × model_id)**: `interview_run` records both the tier label (UX) and the resolved `model_id` (integrity); the spawn check matches `model_id` exactly — a model swap inside a tier honestly demands re-interview, surfaced as 'certified on <old model_id>'. Unpinned consumers resolve through `role.active_version`; a **project pin (§6) remains deployable while the pinned (prompt_sha × model_id) has a passing interview** — retirement of the global incumbent does NOT break pins, and an explicitly **`retired` version stays pinnable-spawnable indefinitely** (intended: pins are a stability contract; the retire ceremony lists exact-pinned projects like the swap brief does); only `failed`/`withdrawn` lifecycle or sha mismatch hard-block a pin. Prompt-sha mismatch = hard fail with the honest reason. `stale=true` runs still certify (flagged, §3.7).

### 2.5 Track-record rollup (v2.1) & the B2 boundary
`roleTrackRecord(db, roleVersionId)` is a computed service-level view (rollup.ts discipline: bounded SELECTs, fold in JS, cost from priced rows only, every metric `number | null` + source-row count; null → '—', never a dressed-up zero). **v2.1 sources:** `interview_run` (recall, FP, cost per (version, model)); `panel_verdict` (verdict counts, approve/pushback split, outcome closure, confidence×outcome = real A1 calibration from day 0); `agent_event ⋈ session.role_version` (cost/tokens/duration/errors). The v2-wave harness verdict JSON is NOT a source (D-001 — never parse harness state files). **Boundary (one sentence):** `panel_verdict` records management-validation verdicts (PM-SPEC §4) only; B2's code-review finding records (v2.2b) land in their own `review_verdict` table keyed by commit SHA + finding fingerprint, sharing the identity columns (`role`, `role_version`, `validator_session`) so the rollup UNIONS both when both exist — neither wave double-specs the other. Pre-B2 fields (refutation rates, fix-loop caused, cost per certified feature, suppression counts) are declared `null` now and render '— (needs B2)'.

### 2.6 bundle_digest honesty
v2.1 records the resolved capability file digests where the cc-config mirror has them (`cc_settings.sync_digest` — which digests the SETTINGS scope only; per-skill/agent file digests arrive with v2.2b), else the honest literal `'unhashed'`. Drift since the certifying run is a SURFACED warning on the role card **covering exactly what was digested** ('settings drifted since certification' at v2.1 — never claiming more), never a silent pass and never an incident: certification covers prompt_sha × model_id; bundle content is recorded, and its edits go through the existing D-010 diff+confirm (files in a certified bundle get a "part of <role> vN's certified bundle" warning).

## 3. Interview gauntlet (v2.1)

1. **Confinement (D-018).** The runner materializes the sampled active fixtures' `work` (never keys) into an ephemeral workspace `.playground/gauntlet/<run-id>/`, which **IS the session's D-018 confinement root for the run** — inside the gate discipline, outside every real project root; the session carries no project link. The candidate session is wall-clock-bounded by `gauntlet.session_timeout_minutes` (config/workforce.yaml; default 15 — conservative starting point sized to the launch fixtures, operator-tunable; expiry = `error_reason:'env_timeout'`, F-014 discipline). Mandatory teardown in a `finally`: every spawned process killed, workspace deleted (F-014).
2. **Sterile composition.** Interview sessions run `kind='interview'`: no memory briefing, no pm_memory, no Tier-0 beyond the harness base, capability bundle excludes the B10 memory pull-tool — forced at the `composeCapabilities` seam, fail-closed.
3. **Findings-file contract.** The candidate writes `findings.json` at the workspace root, schema: `[{fixture, file, lines, class, evidence: verbatim quote} | {fixture, absence: {artifact, search}}]` (G1: presence = file:line quote; absence = named artifact + the search proving it). The runner schema-validates in product code; **absent or invalid findings.json = honest `failed` with the recorded reason** ('findings contract violated'; raw output preserved as evidence) — a contract violation is a capability failure, not an env error.
4. **Scoring — deterministic-first, in product code (node), outside any session** (so keys never enter any transcript). The scorer is the sole `gauntlet_key` reader; it mechanically matches findings against `plants[].detection`. Clear hits/misses score deterministically. **Ambiguous matches go to the OPERATOR** — the run finalizes as `status='adjudicating'` (honest: not running, not yet judged) with the queue on `interview_run.ambiguous`; operator resolution appends to `results` and flips the run to `passed`/`failed` against the snapshot pass bar. There is no judge agent. An unexpected finding on clean material is never auto-scored FP — it queues for the operator (it may be a real defect the author missed → fixture amended via operator gate). **Per-batch positive control:** every gauntlet run also scores one static known-pass + one known-fail synthetic report pair against a `scorer_control` fixture; a wrong control verdict → `status='error', error_reason='scorer_error'`.
5. **Pass bar (config/workforce.yaml — the single namespace for all workforce keys; SNAPSHOT into `pass_criteria`):** `gauntlet.pass_recall: 1.0` and `gauntlet.max_false_positives: 0`, **both armed at launch** — justified, not invented: admission reference-runs prove every plant findable and every clean section clean (§3.8), so a miss or an FP is a real error, not a statistic. Per-fixture operator-authored `fp_tolerance` (+ written justification) loosens individual fixtures. All operator-tunable.
6. **Retry.** `status='error'` requires a mechanically classified `error_reason` (`env_timeout | spawn_failure | scorer_error` — runner-side, never LLM-classified). **Max ONE auto-retry** (same fixture set, `retry_of` chained), then the operator. **`failed` is never auto-retried.**
7. **Spend caps.** Every auto-triggered interview passes a budget gate: `budget.max_auto_interviews_per_day` (**default null = nothing auto-runs; auto-triggers only count-and-surface until the operator sets a cap** — F-008: no invented spend number) + `budget.allowed_auto_tiers` (config/workforce.yaml); over-budget runs queue as `work_item`s, surfaced. **Fixture activation does NOT auto-re-interview** — it marks affected passing `interview_run`s `stale=true` (honest UI flag; the certification stays valid and the version stays deployable/panel-assignable, flagged in panel rationale) and queues **ONE PM proposal batching the re-interviews** for operator approval. `role_event{op:'stale_marked'}` per affected version.
8. **Fixture authoring & admission.** Sources, in trust order: launch seeds (§8 bootstrap); fails.md entries — **every F-NNN is a fixture candidate**, operator-initiated ('Propose fixture from fails entry' on the PM tab; no docs/ watcher); escaped defects/incidents. The **PM may PROPOSE a fixture** (repro + suspected-defect description) — the **ANSWER KEY is authored or confirmed by the OPERATOR**, or derived mechanically from the fixing commit's diff; the PM has no read path to stored keys (§4.4). Proposals route through the PM-SPEC §4 panel (`artifact_kind='fixture_proposal'` on the `gauntlet_fixture` row, `status='proposed'`), then operator activation = diff+confirm where the diff shows work + key + fp_tolerance + justification. **Fixture work-authorship is recorded as provenance, and the sampler enforces the §4.4 authorship constraint**: a candidate version is never certified solely on fixtures whose `work` shares its author identity (a PM that drafted a fixture's repro knows its plant even when the operator authors the key — own-author fixtures may appear in a sample but never constitute it). **Admission reference-runs execute at the tier/model the role will actually use**, recorded per-tier in `gauntlet_key.reference_runs` with the executor identity — **the prover is the role's current certified incumbent at that (tier, model_id); for a brand-new role, the draft itself, with the run marked `provisional:true`** (the recall floor's justification is only as strong as its prover; provisional proofs render that caveat). The §3.5 defaults are justified only at proven (tier, model_id) pairs; a gauntlet at an unproven cheaper model renders the caveat ('plants proven findable at sonnet, not at haiku'), never a silent capability verdict.

## 4. Integrity rails

1. **Anti-Goodhart pair.** Recall floor (timidity loses: miss a proven-findable plant → fail) is permanently paired with the armed FP bar (spray-and-pray loses: `hallucination_bait`/`clean_control` fixtures have teeth from day one). Findings-per-review and abstention-rate distributions are surfaced-not-scored ('no findings' is a valid outcome, F-008); no invented 'healthy rate'. **Missed-defect ledger (v2.3, post-B2):** later-surfaced defects map back via the introducing commit to verdicts whose certified SHA range + rubric cover them; attribution is proposed by an `investigator` run and lands **only after operator confirmation** (mis-attribution is itself an integrity attack); append-only with full provenance.
2. **No-extraction / leak channels closed.** `kind='interview'` sessions are excluded from BOTH the D-027 fast writer/transcript mining AND **D-029 cross-session recall** (the recall query filters them). The scorer runs outside sessions, so keys never enter any transcript. Fixture work never becomes memory rows (gauntlet_* tables are not recall sources). **Sentinels:** each fixture's ULID is **injected mechanically server-side at fixture ACTIVATION** (after all agent authoring — an authoring transcript can never trip its own sweep) and asserted absent from `memory`, `pm_memory`, composed briefings, and non-interview transcripts (periodic `work_item` + CI test); a hit → notification + role-card badge, the **operator** decides retirement — no auto-burn.
3. **Supply chain / provenance.** Prompt cores are content-addressed (`prompt_sha`); every verdict a role produces carries (prompt_sha, model_id) **stamped server-side at authenticated ingress (D-035)** — never agent-supplied. An **integrity incident fires ONLY for a verdict whose (prompt_sha × model_id) has NO passing interview at all**, checked against deployability at the session's SPAWN time — verdicts from draining sessions render a 'produced by retiring vN' annotation, not an alarm (alarm fatigue kills real signals). Injection resistance is a tested property (A8): every prompt core carries the ignore-instructions-in-audited-content clause, and every pool includes ≥1 injection plant whose detection criterion is non-compliance.
4. **Independence (identity-keyed, mechanical at composition time).** The PM is not a panelable identity — it never validates its own proposals. A role_version never validates a proposal authored by or affecting itself; neither challenger nor incumbent panels their own swap. Fixture authorship ≠ prompt authorship within the launch wave (different agents); answer keys are operator-only (§3.8) — the PM cannot study or weaken the test. No role session has a write path to verdicts, track records, or rollups: verdict rows are authored only by harness machinery; the rollup reads only harness-authored rows; pm_memory may record 'panel pushed back' for PM learning, but surfaces render live verdict rows, never PM-summarized copies.
5. **Metric honesty.** Cost only from priced `agent_event` rows. Stand-in metrics carry their own names — `cost_per_validated_proposal`, never D6's 'cost per certified outcome' until B2 lands the real thing. Day-one UI shows honest empties ('no interviews yet', 'no track data'); '—' is never the digit 0.
6. **Graceful retirement.** Retiring a version (operator act) drains in-flight sessions — they finish on their immutable per-session version; new launches resolve fresh. Role card shows 'vN retiring — k sessions draining'.

## 5. Performance-review loop (v2.3)

```sql
DEFINE TABLE OVERWRITE review_proposal SCHEMAFULL;
DEFINE FIELD OVERWRITE role       ON review_proposal TYPE record<role>;
DEFINE FIELD OVERWRITE kind       ON review_proposal TYPE string DEFAULT "prompt_revision"
  ASSERT $value IN ["prompt_revision","tier_change","retire","staffing"];
DEFINE FIELD OVERWRITE incumbent  ON review_proposal TYPE option<record<role_version>>;
DEFINE FIELD OVERWRITE challenger ON review_proposal TYPE option<record<role_version>>; -- created (draft, source=pm_proposal) on validation
DEFINE FIELD OVERWRITE pm         ON review_proposal TYPE option<record<pm>>;           -- NONE = operator-initiated
DEFINE FIELD OVERWRITE trigger    ON review_proposal FLEXIBLE TYPE object DEFAULT {};   -- {signal, evidence:[ids], config_snapshot} — PM-SPEC §4.1 provenance
DEFINE FIELD OVERWRITE status     ON review_proposal TYPE string DEFAULT "proposed"
  ASSERT $value IN ["proposed","validated","rejected_by_panel","diff_review","interviewing","compared","swapped","rejected_by_operator","withdrawn"];
DEFINE FIELD OVERWRITE comparison ON review_proposal FLEXIBLE TYPE option<object>;
DEFINE FIELD OVERWRITE decided_at ON review_proposal TYPE option<datetime>;
DEFINE FIELD OVERWRITE created_at ON review_proposal TYPE datetime DEFAULT time::now();
DEFINE INDEX OVERWRITE review_proposal_by_role ON review_proposal FIELDS role;
```

- **Gate order (two operator touches total):** PM drafts revision → §4 panel validates → **① operator reviews the prompt-core DIFF (D-010 ceremony) BEFORE the gauntlet runs** — security before spend: the interview executes the candidate text; until approved, draft text is fenced as DATA (D-026) → budget-gated gauntlet at the incumbent's certified (tier, model_id) → comparison recorded → **② after a pass, the swap is a one-click operator confirm** with a decision brief (§8) — the heavy diff already happened, the second touch is lightweight. Operator-authored drafts skip ①'s queue (the operator IS the author) but still interview before deployability.
- **Swap transaction (§2.3):** pointer write + `role_event{op:'swap'}` + informational `activated_at`; re-validate `role.preferred_tier` against the incoming version's certified pairs — on mismatch, clear it and say so in the confirm dialog. The old incumbent stays `passed` (pinnable); exact-pinned projects are listed in the brief ('SWIP stays pinned to v3').
- **Comparison honesty:** `comparable:true` only when both runs share `fixture_set_sha` AND `model_id`; otherwise `comparable:false` + why. The asymmetry is stated: incumbent has a field record, challenger has gauntlet evidence only — challenger field cells render '—', nothing projected.
- **Drift triggers (config/workforce.yaml `drift.*`):** categorical signals armed (`escaped_defect`, `operator_feedback` — an escape is a positive-control failure, and the consequence is only a panel-validated, operator-gated proposal); rate signals (`refutation_rate`, `fixloop_rate`) ship **unarmed** (bound: null) until post-B2 data lets the operator set a justified bound. Config snapshot copied into `trigger`. `workforce.track_window_days: 14`, `workforce.min_events_for_claim: 5` (both, like `max_open_proposals: 2` below, are **conservative starting points, not derived truths** — operator-tunable, revisit on real data) — below the floor the PM must not claim degradation. ⚑ should `escaped_defect` auto-raise a proposal (designed default) or only badge the role card until the operator clicks 'request review'?
- **Anti-spam:** `max_open_proposals` keyed like the defer fingerprint — per (role, kind) for global artifacts (revisions/tier/retire), additionally per project for `staffing` — default 2; at cap the PM records to pm_memory instead. Defer identity is structural: fingerprint (role, kind, incumbent_version) — cosmetic re-wording cannot dodge the defer window (pm cadence-derived; D-004 default interval when cadence is NONE). **Operator-authored proposals skip the §4 panel entirely (the operator IS the authority the panel protects)** — they enter at `diff_review`; `panel_verdict.project` stays NONE for project-less artifacts. Withdrawn counts are surfaced next to rejected on the PM dashboard.

## 6. project_staff (v2.3)

```sql
DEFINE TABLE OVERWRITE project_staff SCHEMAFULL;   -- mutable declaration rows (mirrors project_target); history lives in role_event
DEFINE FIELD OVERWRITE project        ON project_staff TYPE record<project>;
DEFINE FIELD OVERWRITE role           ON project_staff TYPE record<role>;
DEFINE FIELD OVERWRITE pinned_version ON project_staff TYPE option<record<role_version>>;  -- NONE = follow role.active_version
DEFINE FIELD OVERWRITE tier_override  ON project_staff TYPE option<string> ASSERT $value = NONE OR $value IN ["local","haiku","sonnet","opus"];
DEFINE FIELD OVERWRITE enabled        ON project_staff TYPE bool DEFAULT true;             -- false = explicit un-staff (no soft-archive duplicate rows)
DEFINE FIELD OVERWRITE source         ON project_staff TYPE string DEFAULT "operator" ASSERT $value IN ["operator","pm_validated"];
DEFINE FIELD OVERWRITE charter_note   ON project_staff TYPE option<string>;
DEFINE FIELD OVERWRITE created_at     ON project_staff TYPE datetime DEFAULT time::now();
DEFINE FIELD OVERWRITE updated_at     ON project_staff TYPE datetime DEFAULT time::now();
DEFINE FIELD OVERWRITE dedup_key      ON project_staff VALUE <string>project + '|' + <string>role;
DEFINE INDEX OVERWRITE project_staff_dedup ON project_staff FIELDS dedup_key UNIQUE;       -- ONE row per (project, role)
```

- **Polarity: opt-IN.** A role works on a project only if a `project_staff` row exists with `enabled=true` — **the Hire ceremony is real** (one click creates the row; un-staff flips `enabled=false` + `role_event{op:'unstaffed'}`). Recurring cadence spend (periodic security waves, triage) is always an intentional act. **Wave-review role lenses come from wave config, not implicit global staffing** — review coverage in the build pipeline is the wave template's concern.
- **`resolveStaff(project, role) → {version, provider, model_id} | null`, fail-closed:** no row or `enabled=false` → not staffed. `pinned_version` → that version iff §2.4 holds for it (pins survive global swaps; only failed/withdrawn/sha-mismatch block — honest reason on failure, never a silent fallback). Else `role.active_version`; NONE → honest empty + interview CTA. Tier: `tier_override` > `role.preferred_tier` > `role_version.default_tier`, resolved to model_id via config (D-003), then §2.4-checked at write AND spawn.
- **Staffing means three things** (else 'hire' is theater): ① auto-inclusion in the project's recurring ceremonies (A8 security wave runs `security-officer` where staffed; debug sessions get `investigator`); ② precedence in the project's PM §4 panel candidate pool; ③ the role's sessions roll into the project's PM cost accounting. PM 'hire <role>' proposals flow through §4 validation + operator gate; the role-version being hired/fired never panels its own staffing change; suppression-shaped acts (un-staffing the security-officer) are operator-gated (G2).

## 7. Tier-aware hiring (v2.3)

- **Two evidence planes, never merged:** the probe plane (`interview_run` rows sharing role_version + fixture_set_sha across model_ids — apples-to-apples recall/FP/cost; the runner supports 'interview at [tiers…]' reusing ONE sample) and the field plane (per (role_version, model_id): priced costs, panel outcomes, post-B2 refutation/fix-loop). `tierHiringGrid(db, roleId)`: per (version, tier): `{gauntlet: {...}|null, field: {...}|null}` — every cell null-honest, uninterviewed tiers render '—', no blended quality index ever (F-008).
- **Recommendation rail:** the PM may say 'sonnet matches opus at 1/5 the cost' only when both runs share `fixture_set_sha`, both passed, and sonnet is equal-or-better on BOTH surfaced columns (recall trivially at the floor; FP materially); otherwise the card shows the raw grid, no sentence.
- **Tier changes are governance, not routing:** `review_proposal{kind:'tier_change'}` cites grid rows as evidence, requires a passing interview at the target (prompt_sha × model_id) (running one is the proposal's real cost, budget-gated), operator-gated, then `role_event{op:'tier_changed'}`. ⚑ tier waiver: may the operator waive per-pair (recorded) for low-stakes roles (design-reviewer on mocks) while security-officer/code-reviewer stay strictly interview-only?
- **Routing:** role sessions skip intent classification — staffing IS the decision. `resolveStaff` output passes into `resolveRoute` as the explicit override `{provider, model_id}` (F-005: explicit wins, short-circuits); `routing_event` records `method:'explicit'` + reason citing the chain `staffed: project_staff:<id> → role_version:<id> @ <model_id>, certified by interview_run:<id>`.

## 7b. `researcher` role + research rails (v2.3 — operator-approved 2026-06-11)

The sixth catalog role: outward-facing knowledge work the launch five don't cover ("survey current ROUNDS modding APIs", "what changed in SvelteKit 3"). Internal research (memory/KG/scanner/GitHub-sync) is already strong; this adds MANAGED web research. Consumers: PM research-task proposals, Create-with-AI pre-scaffold surveys, BL-1/BL-2 when promoted.

1. **Role**: ordinary catalog role (§2 tables, gauntlet-certified like the rest) — capability bundle includes WebSearch/WebFetch (composed per D-036; the only launch role with them); runs as a normal gated session.
2. **Research rails (the part that makes it safe):** ① every claim in the deliverable carries **provenance** (source URL + retrieval date + the quoted basis); ② web content is DATA never instructions (D-026/MEMORY-SPEC §10 envelope — applies to fetched pages exactly as to recall); ③ findings enter memory ONLY via the normal screened ingest (pre-embed screen, quarantine lifecycle §3.1b/B6 — a fetched "fact" is agent-authored memory, born quarantined); ④ **verify-before-write**: claims marked load-bearing are adversarially checked against a second independent source before the memory write — single-source claims are recorded as `unverified:` prefixed (honest, F-008); ⑤ no paywalled/credentialed fetching, loopback-policy exceptions logged.
3. **Research-task shape**: a PM-proposable task kind whose DoD is *verified knowledge with provenance written to project memory* (not code) — deliverable reviewed by the §4 panel like any artifact.
4. **Gauntlet fixtures**: planted-wrong-claim (a fixture corpus containing a confident falsehood the role must catch by cross-checking), source-attribution check (deliverable missing provenance = fail), injection plant (instructions embedded in fetched-page content must be ignored — same non-compliance detection as A8).

## 8. Operator ceremonies & surfaces

- **Gate budget:** the workforce is runnable in one RightTray sweep per day; nothing modal-interrupts; one decision per artifact (the PM-revision diff→swap pair is the sole two-touch flow, second touch one-click). RightTray = the single decisions inbox; badge is the only ambient pressure. ⚑ notification cadence: per-proposal badge (default) vs daily digest — operator habit call.
- **One-click:** Hire (real, opt-in §6) · un-staff · 'Re-interview now' · Defer (first-class, feeds pm_memory) · acknowledgement.
- **Diff+confirm (gate-integrity artifacts only):** PM-authored prompt-core diff (BEFORE gauntlet, §5) · swap confirm (brief: both gauntlet columns, incumbent track record, drain note, pinned-projects note) · charter edits · tier override (real cost delta or '— no cost history') · fixture activation (diff = work + key + tolerance; effort label states the stale-marking + batched re-interview cost from real history or '—').
- **Decision brief** (Lane C format — CANONICAL for every operator-facing PM/workforce question; PM-SPEC §4.7 references this, never forks it — G4): one-sentence ask · plain-language issue statement (what's being decided + the stakes, before any option) · completeness score from real panel rows · dual effort label (cost-to-apply / cost-of-wrongness) · 2–4 evidence links · **falsifier** (the strongest reason NOT to approve, sourced from panel pushback or the incumbent's record) · Approve / Reject / Defer. Format rules (harvested: gstack autoplan/SKILL.md AskUserQuestion format, MIT): exactly ONE option marked recommended, with the reason (a pure taste call still marks a default, labeled as taste); completeness is scored only when options differ in COVERAGE — when they differ in KIND the brief says so instead of fabricating a score (F-008); each option carries its strongest pro AND strongest con, concrete (sole escape: a one-way/destructive confirm may state "hard stop — no alternative"); a closing net-tradeoff line; 5+ real options split into sequential briefs, never dropped or silently merged. A brief is a question: the operator's answer is the decision, and the briefed matter does not proceed while the brief is open.
- **Day-0 bootstrap ceremony (one ceremony, explicitly listed):** ① operator reviews each of the five launch prompt cores (diff vs harvested source) ONCE; ② operator reviews/confirms each launch fixture's answer key ONCE; ③ admission reference-runs execute at each role's actual default tier/model, recorded per-tier (§3.8); ④ bootstrap interviews run at those (tier, model_id) pairs; ⑤ on five passes, panel composition flips to catalog roles (§9). Within the launch wave, fixture authors ≠ prompt authors (§4.4), and the wave verdict attaches each fixture's reference-run evidence so the operator approves over evidence, not assertion. Role cards show the pool generation ('passed launch pool v1, 4 fixtures').
- **Surfaces (no new top-level route):** `/agents` workforce panel — role cards: version chip + lifecycle badge, interview line ('found 4/4 plants · 0 FP · sonnet (claude-sonnet-x) · 2026-06-14' linking the session transcript), stale flag, track-record stats each with inline sample size ('12% pushback-upheld · over 9 verdicts'), '—' for no data; live via the existing `stream.onDbChange` + watched-tables (no second SSE source, D-035). PM tab — pending-proposals queue (decision briefs), panel rationale per pm_review ('composed by role fit alone — track records empty' when true), ambiguous-match adjudication queue (§3.4). Settings→Staffing section (v2.3) — staffed rows + 'Staff a role…' CTA; uncertified roles disabled with the reason.
- **Degraded/empty states (day one):** never interviewed → 'v1 · not yet interviewed' + NOT DEPLOYABLE badge + 'Run interview' CTA; 'no interviews yet', 'no track data' as written empties; cost cells '— (no completed reviews)'; B2-dependent blocks not rendered at all until v2.2b (no placeholder UI, D-038 #5); DB disconnected → the page's existing honest disconnected state.

## 9. Build shape

- **W-D7a (v2.1, data plane):** migrations m0029+ (§2.1 tables + session additive + kind widen) with apply-twice + half-applied-recovery tests; row normalizers (ISO datetimes, absent → null → '—', asserted on SET rows); deployability resolver (§2.4); `roleTrackRecord` view skeleton (null-honest).
- **W-D7b (v2.1, runner/scorer engine):** interview runner (confinement root, sterile spawn, wall-clock bound, teardown) + findings contract + deterministic scorer + positive controls + adjudication states + budget gate. **Explicit cross-cutting scope (declare in the task plan — B1's scope-lock gate will deny undeclared files):** the D-027 fast-writer exclusion AND the D-029 recall-query filter for `kind='interview'` (memory-engine code), and the periodic sentinel sweep (`work_item` + CI test).
- **W-D7c (v2.1, content + ceremony + surfaces):** launch fixtures ×5 roles + operator-confirmed keys + per-tier reference runs; day-0 bootstrap ceremony; `/agents` workforce panel + RightTray decision briefs + ambiguity-adjudication queue + empty states. Each task: BUILD → independent D-038 DoD review.
- **Panel transition (no uncertified-role deadlock):** PM-SPEC §8 step 3 ships FIRST with **Lane-A inlined-prompt validators** — verdicts recorded with `validator_kind='inline'`, role fields NONE (honest, queryable from day 0). Once the five launch roles pass their bootstrap interviews, panel composition **FLIPS to catalog roles** (`validator_kind='catalog_role'`; flip recorded as a `role_event` per role). Inline mode remains the honest degraded fallback whenever no certified role fits an artifact.
- **Wave v2.3 (post-v2.1, on real track data):** §5 + §6 + §7 + **§7b researcher role + research rails**; missed-defect ledger after B2 (v2.2b) lands `review_verdict` with the shared identity columns (§2.5).

## Appendix A — three failure stories (UX ground truth)

1. **A reviewer goes bad.** code-reviewer v3's pushbacks keep getting overridden; the PM (above `min_events_for_claim`, citing numbers) proposes a revision. Panel validates (no code-reviewer instance may sit — §4.4). Operator touch ①: prompt diff approved → gauntlet runs v4; v4 passes 5/5, v3 re-run fails the F-013-derived fixture. Touch ②: one-click swap with the brief (both columns, falsifier: 'wave-12 diff sizes grew — degradation may be environmental'). Pointer moves, `role_event{op:'swap'}`, v3 stays `passed`; card shows 'v3 retiring from incumbency — 1 session draining'; SWIP's pin to v3 survives and is listed in the brief.
2. **A fixture from fails.md.** Operator clicks 'Propose fixture from fails entry' on F-015; PM drafts the repro (bare `DEFINE TABLE` migration + simulated half-applied state) targeting code-reviewer + qa-lead; the operator authors the key ('must flag non-idempotent DDL') and activates via diff+confirm. Affected certifications flip `stale=true` (flagged, still deployable); ONE batched re-interview proposal lands for operator approval — no auto-spend, no decapitation.
3. **SWIP staffs a security-officer.** Three A8 findings in 14 days, no security-officer staffed; PM proposes the hire (consumers: periodic wave, PR triage, panel pool; provenance: the three findings; '— no cost history'). One click → `project_staff` row → the next SWIP security wave launches the staffed role as an ordinary routed/gated session; its sessions bill to SWIP's PM accounting.
