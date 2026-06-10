# MEMORY-SPEC — ai-playground v2

The **memory & learning engine** design. This sits *beneath* [ARCHITECTURE.md](./ARCHITECTURE.md) §2.6 (memory service) and on top of [DATA-MODEL.md](./DATA-MODEL.md) (the schema). It specifies *how* the memory service learns, extracts, recalls, consolidates, and stays safe — the behavioural design that the schema and the architecture diagram only gesture at.

---

## 1. Purpose & scope

This document folds the memory-engine research from [CANNIBALIZE-BRIEF.md](./CANNIBALIZE-BRIEF.md) §3 (themes 3a–3i) and §4 (positioning) into an engineering spec dense enough to **build from**. It complements — does **not** restate — the two docs above:

- **ARCHITECTURE §2.6** gives the recall pipeline shape, the WMR formula, session injection, and the graph-edge idea. This doc expands each into write-time, retrieval-time, and lifecycle behaviour.
- **DATA-MODEL §4.5/§4.6/§4.13/§7** gives the `memory`, `entity`, `references`, `retrieval_outcome` tables, the HNSW index, and the embedding note. This doc references those tables by name; it never re-declares schema. Where a behaviour needs a *new* column or table, it is flagged as a **schema delta** for DATA-MODEL to absorb, not defined here.

### Provenance & license discipline (read before lifting anything)

Every item below is a **CANDIDATE with provenance, not a mandate.** Treat each as "adapt, don't follow blindly," and **verify against v2's actual constraints** (single SurrealDB store, Ollama embeddings, Claude Code runtime, single-operator threat model) before it becomes a locked decision. Source attribution is inline: *(hermes)* / *(mem0)* / *(kongcode)* / *(cannibalize)*.

License rules — these matter because several items say "lift the code/prompt near-verbatim":

| Source | License | Code-lift permitted? |
|--------|---------|----------------------|
| **hermes-agent** (Nous Research) | MIT | **Yes** — liftable, commercial-safe. |
| **mem0** | Apache-2.0 | **Yes** — prompts/code liftable (attribution + NOTICE). |
| **kongcode** | a friend's plugin | **IDEAS only.** CODE-LIFT NEEDS HIS CONSENT — flagged inline at every "lift" site. |
| **sveltekit-tailwind** | unresolved | ideas-only, not relevant here. |

Wherever the text says "lift X near-verbatim," the license + lift permission is appended in-line. **kongcode lifts are blocked pending consent** and are written as "reimplement from the described design" unless consent is obtained.

### Decisions this spec is bound to

This spec does **not** silently override locked decisions. Where an item touches a decision, it points to the decision id and reflects its current status; the three formerly-open memory questions (D-030/D-031/D-032) are now **RESOLVED** and locked below. Canonical decision ids (authored into `DECISIONS.md` by another agent — referenced, not defined, here):

- **D-027** two-tier learning loop (fast in-use writer fork + slow periodic consolidator) 🔒
- **D-028** ADD-only extraction + separate deterministic/graph conflict pass 🔒
- **D-029** raw-windowed cross-session recall, no summary-LLM in the recall path 🔒
- **D-030** 🔒 **RESOLVED** — utilization loop feeds **RANKING only**, not pruning. `retrieval_outcome` (cited / preceded tool success) is a recall-ranker input; the curator prunes on time/inactivity only (archive-not-delete, D-015). Still v2's edge over hermes (zero utilization signal), applied conservatively. *Outcome-pruning revisited post-v1.0.*
- **D-031** 🔒 **RESOLVED** — **BOTH**: query-time hard novelty gate (cosine-band cut) **and** periodic consolidation (merges near-dup families into umbrellas via `absorbed_into` forwarding).
- **D-032** 🔒 **RESOLVED** — **single SurrealDB store stands** (reaffirms D-001). No SQLite-FTS5 split (SurrealDB native FTS, D-009), no external Honcho.
- **D-014** embeddings (Ollama, 1024-dim; `qwen3-embedding:0.6b` validated candidate).
- **D-015** append-only soft-archive · **D-008** dedup (UNIQUE / computed VALUE key) · **D-021** `work_item` queue · **D-022** self-improvement loop · **D-026** untrusted-memory / secret-screen.

---

## 2. Learning loop — write-time self-improvement (§3a, D-027 🔒)

The write side of memory is a **two-tier loop** (D-027), the architecture to copy wholesale *(hermes, MIT — liftable)*:

- **Fast tier (in-use writer fork)** — fires *during* a session, mines the just-finished turn, writes additively to the stores.
- **Slow tier (periodic consolidator)** — inactivity-triggered, merges narrow knowledge into umbrellas and GCs stale items (see §5).

The two cadences are **decoupled on purpose**: fresh knowledge without micro-knowledge proliferation.

### 2.1 The forked review agent

Every Nth turn, spawn a **forked review subagent** *(hermes, MIT — liftable)*:

- **Async** — runs off the critical path; the live agent never blocks on it. In v2 this is **not** an in-process daemon thread (hermes' shape); it is a **`work_item`** drained by the orchestrator's background queue (**D-021**), so it inherits crash-safe claim tokens, daily caps, and stale-GC for free. *(verify against v2 constraints: hermes runs the fork as a thread inside one process; v2's long-lived owner is the SvelteKit server + Claude Code runtime, so the queue path is the better fit — see ARCHITECTURE §2.2.)*
- **Tool-whitelisted to memory + skill writes only.** The fork can call the memory-write and skill-write tools and nothing else (no file edits, no exec, no git). This is the runtime complement to D-018 gates, scoped to the writer.
- **Never touches the live prompt cache.** The fork reads the finished turn as data; it does not mutate the live agent's context or its in-flight system prompt.

This is the cheap, gated, cached version of the **D-022** self-improvement vision — note explicitly that D-022's "extract → outcome-label → learned rerank → skill synthesis" pipeline is *the same loop*, and this fork is its write-time front half. D-004 (event-driven, no busy loop) holds: the fork is **gated + cached**, not a polling worker.

### 2.2 Two-cadence nudge

Two independent counters decide *when* the fork fires *(hermes, MIT — liftable)*:

- **Memory** review fires on a **user-turn count** (e.g. every N user messages).
- **Skill** review fires on a **tool-iteration count** (e.g. every M tool calls) — skills are about *doing*, so tool activity is the right clock.

Both counters are **modulo-hydrated**: the cadence is computed from a persisted counter (`turn_index % N == 0`) rather than an in-memory tick, so it **survives per-message agent rebuilds** (Claude Code sessions are reconstructed per message; an in-memory counter would reset). The counters are **MONOTONIC per session** — incremented on every user turn / tool iteration and **never reset** mid-session — so the `% N` modulo cadence test is meaningful (a reset would make the modulo fire erratically or never). Store the counters on the `session` row (schema delta candidate: `user_turn_count int`, `tool_iter_count int` on `session` — flag for DATA-MODEL).

### 2.3 Prefix-cache inheritance — bake in day one

The background fork **inherits the parent's cached system-prompt prefix verbatim** — same `tools[]` order, same timestamp, same prefix bytes — so its review call lands as a **prefix-cache hit** *(hermes, MIT — liftable)*. Hermes measured **~26% cost cut** from this. This is **not** an optimization to defer: self-improvement is only *affordable* if the review calls cache-hit, so the fork's prompt assembly must reuse the parent prefix from the start. *(verify against v2 constraints: Claude Code / Anthropic prompt-caching boundaries differ from hermes' setup — confirm the cache-prefix contract holds for the Agent SDK path during the S.1 spike before relying on the 26% figure.)*

### 2.4 Three review prompts

Three distinct review prompts — **memory-only**, **skill-only**, **combined** — selected by which trigger fired (§2.2) *(hermes, MIT — liftable near-verbatim)*. Lift the prompts, then adapt the examples to the coding-agent domain. The combined prompt is for the case where both counters trip on the same turn (run one fork, not two).

---

## 3. Extraction policy (§3b, D-028 🔒)

Extraction is **ADD-only** (D-028): one cheap LLM call per turn produces additive memory candidates; **conflict resolution (dedup / supersession / contradiction) is a separate downstream deterministic + graph pass** (§5), never trusted to the extracting LLM in-place. This is mem0 V3's lesson (they *dropped* LLM ADD/UPDATE/DELETE decisioning) paired with kongcode's lifecycle layer.

### 3.1 DO-NOT-CAPTURE guardrail — highest-value cheap win

**Never persist environment failures or negative tool claims** — "X is broken," "the daemon is down," "this API returns 500" *(hermes, MIT — lift the prompt near-verbatim)*. These harden into **self-cited refusals**: months later the agent recalls its own stale failure claim and refuses to even try. **Rewrite failures as fixes** — capture "to do X, use Y" instead of "X failed." This is the single highest-value, lowest-cost win in the brief; build it first.

> Illustration: a hook that injects "tier0 directives are important... daemon unreachable" on every file read emits exactly the class of transient negative/instructional content that must **not** be captured as memory (and must not be obeyed — see §10). The DO-NOT-CAPTURE guard is what stops a transient outage from becoming a permanent false belief.

### 3.1b Secret / PII screen — co-equal guardrail (D-026)

**Equal in prominence to DO-NOT-CAPTURE: nothing reaches an embedding or an insert before it is screened.** *(hermes, MIT — liftable; folds into D-026's "don't leak" half.)* A candidate that survives §3.1 can still carry a secret or PII (API keys, tokens, credentials, private paths, personal data). Before the embed/insert step:

- **Screen runs as §3.4 step 2.0 — strictly BEFORE embed/insert.** Run the security scanner over **every** extraction candidate. This ordering is load-bearing: it is the only point at which a secret can be caught before it leaks into a vector (the §7.1 `embedding_cache`), the `memory_history` audit (§6.9), or recall (§10).
- **On a hit: redact-in-place or quarantine — never embed raw.** Redact the offending span in place, or quarantine the whole candidate if it cannot be safely redacted. A raw secret-bearing string is never sent to the embedding model.
- **Stamp the outcome.** Set `screen_status` enum (clean / redacted / quarantined) + `screened_at` on the row (DATA-MODEL `memory` schema delta).
- **Quarantine is exclusionary by default.** Quarantined rows are excluded from recall (§4) and from the knowledge-only export by default (D-026). Recall filters them out the same way it filters archived rows (§5.3).

Where DO-NOT-CAPTURE prevents self-poisoning (a stale false belief), this prevents self-*leaking* (a stored secret resurfacing in a later prompt, an export, or an audit log). Both are first-class extraction gates, not afterthoughts.

### 3.2 The extraction prompt

Adopt **mem0's extraction prompt** (a large multi-section prompt — verify the exact size against the mem0 source) *(mem0, Apache-2.0 — liftable, attribute)*: Observation-Date grounding (anchor facts to *when observed*), anti-echo (don't restate the user's words as a "memory"), preserve-specifics (keep exact identifiers/versions/paths), and **12 worked examples**. Lift it wholesale, then **adapt the 12 examples to the coding-agent domain** (file paths, build commands, decision records, framework versions) rather than mem0's personal-assistant examples.

### 3.3 UUID → integer remapping before the LLM

When the extraction/linking call must reference existing records (to link or merge), **never hand the LLM record ids.** Map them to **integer ordinals** before the call, let the LLM reason over ordinals, and **translate back host-side** *(mem0, Apache-2.0 — liftable)*. Anti-hallucination: models fabricate plausible-looking UUIDs/Thing-ids; they do not fabricate "item 3." This pairs with the UUID-vs-Thing bridge concern in §6.

### 3.4 Phased batch add

One **LLM call per turn**; everything else is batched *(mem0, Apache-2.0 — liftable)*:

1. Single extraction call → candidate set.
2. **Step 2.0 — screen BEFORE embed (§3.1b).** Run the secret/PII security scanner over **each extraction candidate** *before* any embedding or insert. On a hit, redact-in-place or quarantine the candidate (**never embed raw**); set `screen_status` (clean/redacted/quarantined) + `screened_at` on the row. Because this runs before the embed step, no secret-derived text ever reaches the §7.1 cache. Quarantined candidates are excluded from recall (§4) and from the knowledge-only export by default (D-026).
3. **Batch** all embeds for the screened candidates (one embedding round-trip — see §7 cache), inserts, `memory_history` audit rows, and entity-linking edges.
4. **Per-item fallback**: if the batch insert fails on one item, retry that item alone; one bad candidate never drops the rest.

Maps cleanly onto DATA-MODEL §4.5 (`memory`) + §4.6 (`entity`/`references`). The audit row is a schema-delta toward mem0's three-table split — see §6.

---

## 4. Cross-session recall + retrieval ranking (§3c)

### 4.1 Raw-windowed recall, no summary-LLM (D-029 🔒)

The recall path returns **raw windowed messages + first/last bookends**, with **zero LLM in the loop** (D-029) *(hermes, MIT — liftable)*:

1. SurrealDB FTS (`@@` / `SEARCH ANALYZER ... BM25`, D-009) + vector search over past turns.
2. Dedupe by **session lineage** (don't return five near-identical excerpts from one session).
3. Return **windowed raw messages + first/last bookends** of the matched session.

**No LLM summarization in recall.** Rationale: cheaper, no added latency, no summarization hallucination, and the live agent has its own reasoning budget — it prefers real excerpts over a lossy summary. Reserve LLM synthesis for an **explicit dialectic tool** (§8), never default recall. This complements ARCHITECTURE §2.6's pipeline: §2.6 ranks `memory` rows; this is the **session-transcript recall** path over `message`/`session` (DATA-MODEL §4.3).

> **Workforce exclusion (additive, WORKFORCE-SPEC §4.2):** sessions with `kind='interview'` (role-gauntlet runs) are excluded from BOTH the D-027 fast-writer/transcript-mining AND this D-029 recall path — the recall query filters them. Gauntlet fixture content must never become recallable memory (answer-key leak channel).

### 4.2 FTS5 / FTS query sanitizer

Before any full-text query, **sanitize** *(hermes, MIT — liftable near-verbatim)*: preserve quoted phrases, strip query operators the user didn't mean, **quote dotted/hyphenated terms** (`foo.bar`, `multi-word` would otherwise be parsed as operators), and a **CJK trigram fallback** for languages without whitespace tokenization. Lift hermes' SQLite-FTS5 sanitizer and **port it to SurrealDB's FTS** (DATA-MODEL §4.8 `@@`/`@1@` + `search::score`) — the *logic* lifts cleanly; the operator set differs, so re-target it. *(verify against v2 constraints: SurrealDB's analyzer/operator grammar ≠ SQLite FTS5; the sanitizer's intent transfers, the exact token list does not.)*

### 4.3 Staged retrieval pipeline (the `memory`-row path)

This is the detailed expansion of ARCHITECTURE §2.6's six-step recall *(kongcode — IDEAS liftable; CODE-LIFT NEEDS CONSENT, reimplement from this description)*:

1. **Vector search** — HNSW KNN per table with budgets (DATA-MODEL §4.5). Note both KNN operator forms (DATA-MODEL §4.5): `<|K,EF|>` (index-backed approximate ANN over the HNSW index) vs `<|K,COSINE|>` (exact brute-force, no index) — pick per query by budget/recall need.
2. **Graph-neighbor + causal expansion** — 1–2 hop BFS along typed `references` edges (DATA-MODEL §4.6); include causal chains where they exist.
3. **WMR / ACAN score** — `0.50·cosine + 0.35·historical_utility + 0.15·recency_decay` (DATA-MODEL §4.5). **Keep the WMR weights and the salience-band thresholds as documented starting points**, not tuned constants — they are kongcode's defaults, to be re-validated on v2's corpus.
4. **Cross-encoder rerank** — with **salience bands** (load-bearing / supporting / background) and a **tail-drop noise filter** that discards the long low-similarity tail before it reaches the prompt budget.

`historical_utility` is sourced from `retrieval_outcome` (DATA-MODEL §4.13), defaulting to 0 until that data exists — which ties directly to §4.5 below.

### 4.4 Hybrid retrieval normalization

Alongside the staged pipeline, support **hybrid retrieval** *(mem0, Apache-2.0 — liftable)*: semantic + BM25 + entity-boost, fused with an **adaptive normalizing divisor** (so one signal's raw scale doesn't dominate), plus an **explain mode** that surfaces *why* each result ranked where it did. The explain mode feeds the dashboard `/memory` recall-explain view (ARCHITECTURE §2.9) and the truncation-visibility surfacing in §7.3.

### 4.5 Retrieval-quality / utilization scoring — D-030 🔒 RESOLVED (ranking-only)

**This is the utilization loop. D-030 is RESOLVED: the outcome signal feeds RANKING only, NOT pruning.** *(kongcode — IDEAS liftable; CODE-LIFT NEEDS CONSENT, reimplement from this description.)*

Per injected item, record whether the context was **USED, not merely retrieved**:

- **6 signals** (e.g. cited in response, fed into a downstream tool call, preceded a successful action, dwell/position, semantic overlap with the response, implicit-path hit).
- **`[#N]` citation parse** — read the model's response for explicit `[#N]` citation markers tying back to injected items.
- **Implicit-path-hit rescue** — credit an item that clearly shaped the answer even when not formally cited.

Use the result to **train the ranker** (feed `historical_utility`) — the outcome signal is a **recall-ranker input only**. The plumbing already exists in DATA-MODEL §4.13 (`retrieval_outcome`: `utilized` / `cited` / `tool_success` / `was_neighbor`); v0.2 *records* these rows, and the **learned reranker that consumes them is D-022 / D-030 work.** The curator's keep/prune decision (§5) does **NOT** read this signal — pruning stays **time/inactivity-based** (archive-not-delete, D-015).

> **D-030 — resolved: ranking-only.** §11's comparison shows all three sources under-use this: hermes ignores it (prunes on time), mem0 lacks it, kongcode has it. v2 feeds the utilization signal into **ranking** but deliberately **not** into the curator's keep/prune decision (§5). Rationale: low citation ≠ low worth; ranking is reversible per-query, pruning is destructive. This is still v2's edge over hermes (which has zero utilization signal), applied conservatively. **Outcome-pruning is revisited post-v1.0.**

### 4.6 Hard novelty gate vs soft MMR — ties D-031 🔒 RESOLVED (both)

For corpora with **redundant near-dup families**, a **HARD novelty gate at query time beats soft MMR** *(kongcode — IDEAS liftable; CODE-LIFT NEEDS CONSENT)*. Measure the family-vs-distinct cosine bands on the real corpus to set the cut threshold (a **tunable starting point**, not a locked constant). **This is one half of D-031.** **D-031 is RESOLVED: BOTH** — the query-time hard novelty gate here (cosine-band cut, stops near-dups surfacing) **and** the periodic consolidation pass (§5) that merges near-dup families into umbrellas. This spec describes both mechanisms because both ship.

---

## 5. Consolidation / lifecycle / GC (§3d)

The **slow tier** of D-027: the periodic consolidator + the per-row lifecycle. This is where kongcode's real-graph lifecycle is v2's differentiator over mem0 (see §11).

### 5.1 The curator (slow consolidator)

*(hermes, MIT — liftable)*

- **Inactivity-triggered batch consolidation** — fires after a quiet period (~7-day cadence in hermes), merges narrow knowledge into **class-level umbrellas**. Decoupled from the write cadence (§2) by design. This is the periodic-consolidation half of **D-031 (resolved: both)** — it merges near-dup families into umbrellas (via `absorbed_into` forwarding, §5.1; D-027 curator / D-021 queue), complementing the §4.6 query-time novelty gate.
- **Archive, never delete** — archive is the **maximum destructive** action. Stale items are archived, **pinned items are exempt**.
- **`absorbed_into` forwarding** — when an item is absorbed into an umbrella, **rewrite refs/edges** that point at it to point at the umbrella. No dangling edges; the graph stays traversable.

### 5.2 3-signal curator classification

The curator decides keep/merge/archive by reconciling **three signals** *(hermes, MIT — liftable)*:

1. The model's declared **`absorbed_into`** target.
2. A **structured summary** the model produced.
3. A **tool-call audit** (what actually happened).

**The model wins unless it is hallucinating** — i.e. its declaration is accepted unless the audit/summary contradict it. This is the deterministic guard over an LLM judgment (the D-028 principle applied to consolidation).

**Security-relevant exception — the deterministic guard WINS over the model.** For **findings, pinned, and Tier-0** memories, the model's `absorbed_into` declaration does **not** win: the deterministic guard overrides it and refuses to bury such a memory into an umbrella. Rationale: a steered/poisoned model (§10) could otherwise "consolidate away" a security finding by declaring it absorbed. Consolidation of these classes is allow-listed deterministically (or blocked), never delegated to the model's judgment.

### 5.3 Append-only soft-delete (ties D-015 🔒)

*(kongcode — IDEAS; this one is already locked as D-015 and lives in DATA-MODEL §4.5/§4.9, so it's not a fresh code-lift)*

Never `DELETE` knowledge. Set `status = "archived"` + `archived_at` + `archive_reason` + `superseded_by` (DATA-MODEL uses the `status`-enum form; the brief's `active=false` boolean wording is superseded — see DATA-MODEL §4.9 read-guard note). **One shared active-set filter** — `(status = "active" OR status IS NONE)` — used by **every reader**, so no path accidentally reads archived rows.

### 5.4 Skill graduation

*(kongcode — IDEAS liftable; CODE-LIFT NEEDS CONSENT, reimplement from this description)*

Promote a proven **`causal_chain` → skill**, gated by a **once-only `graduated_at` watermark** (a chain graduates exactly once). Skill rows carry **success/failure RL counts** and **name-scoped supersession** (a newer skill supersedes the older one of the same name). Inject graduated skills as **"adapt, don't follow"** guidance, never as rigid scripts. This needs new structure beyond DATA-MODEL today — **schema delta**: a `skill` table (or `kind="procedural"` memory with `graduated_at`, `success_count`, `failure_count`, name-scoped `superseded_by`). Flag for DATA-MODEL. Ties D-022 (skill synthesis) and the §4.5 utilization signal (success/failure counts come from outcomes).

**Learned-skill content is UNTRUSTED — it carries no more trust than recalled memory (D-026).** A skill graduated from a **poisoned `causal_chain`** would carry injected instructions *forward* as graduated guidance — and "adapt, don't follow" is a *usage* posture, not a *trust* grant. So:

- **(a) Screen at synthesis time.** A skill's `description` / `steps` pass the §3.1b secret/PII screen and the §10 fencing-eligibility check **when the skill is synthesized**, exactly as an extraction candidate does. A chain that fails screening does not graduate raw.
- **(b) Fence at injection identically to recalled memory.** When a graduated skill is injected, its `description` / `steps` are wrapped in the §10 "reference, not instructions" fence — the *same* fence as recalled memory. A skill is data the agent may consult, never a command it must obey.

Note: the §5.2 "model wins unless hallucinating" rule is a **hallucination guard**, not an **anti-steering guard** — it stops the model fabricating, but does not stop injected content from steering it. Screening (a) + fencing (b) are the anti-steering controls for learned skills.

### 5.5 mem0's gap = v2's differentiator

*(mem0, antipattern)* mem0 is **append-only with NO decay, NO audit, NO graduation.** v2's move: **keep mem0's cheap ADD-only extraction (§3) but ADD the lifecycle layer** — confidence/decay (DATA-MODEL §4.5 importance decay + recency half-life), drift audit, supersede-on-contradiction (the §3 downstream graph pass), and graduation (§5.4). This is the explicit "best of both" in §11.

---

## 6. Storage & schema gotchas — SurrealDB (§3e)

These **complement DATA-MODEL** (they are engineering gotchas the schema must respect); they do **not** restate the tables.

**Least-privilege DB user (D-026c).** The memory engine connects as a **scoped least-privilege SurrealDB user** — **no DDL, no cross-namespace access**. Migrations and `DEFINE` statements run **only** under the separate provisioning/root user, never the runtime engine user. This contains a poisoned-memory-driven query from escalating into schema mutation or cross-namespace reads.

### 6.1 At most one external memory provider, behind an ABC

*(hermes, MIT — liftable)* **D-032 resolved: single SurrealDB store stands — no external provider is adopted** (no SQLite-FTS5 split, no external Honcho). The ABC below is kept as a **defensive seam, not an active path**: if v2 *ever* added an external memory provider, there would be **at most ONE**, behind an abstract base class with full lifecycle hooks, with **built-in (SurrealDB) always tried first** and **a provider failure never blocking its siblings** — degrading to built-in, exactly like the hook graceful-degradation in ARCHITECTURE §2.10d. For v2 the single store is the decision; the ABC just keeps the door from being welded shut.

### 6.2 SCHEMALESS base + explicit `option<T>` for read-back fields

*(kongcode — IDEAS; the pattern is already partly in DATA-MODEL)* Any field that is **indexed, filtered, or coerced on a `RETURN AFTER` write** must EITHER be an explicit `DEFINE FIELD ... TYPE option<T>` (if the field is legitimately absent for some rows) OR carry a concrete **non-`NONE` `DEFAULT`** — **never a bare typed field that can land in `NONE`**. DATA-MODEL is `SCHEMAFULL` by convention (§3), which is stricter than kongcode's SCHEMALESS-base; the gotcha still applies to every such field that is read back on write.

### 6.3 The `option<bool> NONE` + `RETURN AFTER` missed-match / claim-starvation (important)

*(kongcode, GOTCHA — IDEAS)* **Any boolean/enum field read back on a write MUST be `option<>` or backfilled in the same migration**, plus a **predeploy normalize pass**. SurrealDB treats `NONE` as a distinct value, so a freshly-created row whose boolean defaulted to `NONE` will **never match** a `RETURN AFTER ... WHERE bool = true` claim — the row is silently skipped forever (**claim starvation**, not a lock deadlock: `NONE` simply never equals `true`). DATA-MODEL already dodges one instance of this with the `dedup_key VALUE` pattern (§4.3, §7a) — the general rule must hold for **every** new boolean/enum the memory engine adds (e.g. the §5.4 graduation flags, the §4.5 outcome booleans). Flag at schema-apply time.

### 6.4 Idempotent migrations

*(kongcode — IDEAS)* One-time table-scan `UPDATE`s must be **gated behind `LET <count> + IF count > 0`** so re-running the migration is a no-op. Use **`OVERWRITE`** to widen tables/edges. **Annotate each one-time migration with its CLOSURE removal condition** (when it is safe to delete the migration code). This governs how the §3 audit rows, §5.4 skill fields, and §4.5 outcome columns are rolled out.

### 6.5 Computed `dedup_key` VALUE field

*(kongcode — IDEAS; already in DATA-MODEL §4.5/§4.12/§7a, ties D-008)* For "one active per group, many archived" invariants, compute a **`dedup_key` VALUE field** and put the UNIQUE index on *that*, not the natural key (which collides on `NONE`). **Backfill VALUE fields with a no-op touch-`UPDATE`** at schema apply (a `VALUE` field is only recomputed on write). DATA-MODEL already does this for `session`, `memory`, `work_item`; the memory engine reuses the same pattern for any new "one-active-per-group" table.

### 6.6 Optimistic-lock queue claim

*(kongcode — IDEAS; already in DATA-MODEL §4.12, ties D-021)* SurrealDB exposes **no pessimistic row locks / no `SELECT ... FOR UPDATE`** — claim via `UPDATE ... SET claim_token WHERE status='pending' AND claim_token IS NONE ... RETURN AFTER` over a small candidate set. The atomicity of this claim relies on **optimistic snapshot-isolation conflict-detection at commit** plus the `claim_token IS NONE` guard (two workers racing the same row: one commit wins, the other sees a conflict and retries). **Verify in spike S0** (IMPLEMENTATION-PLAN §3 — supersedes the earlier "S.1" assignment; claim-token atomicity is a storage concern, so it's proven in the SurrealDB spike, not the runtime spike) — this depends on the surrealkv isolation level that DATA-MODEL §5/§8 flags as unverified; do **not** treat the single-winner guarantee as fact until the spike confirms it. Provide **transactional stale-recovery** for rows stuck in `processing` (orphaned by a crashed worker). The §2.1 review fork rides this exact queue.

### 6.7 UUID-vs-Thing bridge

*(kongcode — IDEAS; ties DATA-MODEL §7a)* **Decide per table** whether to key on the harness UUID or the SurrealDB Thing id. If keying on a UUID (e.g. Claude Code `cc_session_id`), add an **indexed bridge field + typed edges**, and **document the decision at every call site**. DATA-MODEL §7a already does this for `session.cc_session_id` (bridge field, NON-unique `session_cc` index, lazy idempotent create). Any new memory table linking to harness-issued ids follows the same rule. This is also why §3.3 hands the LLM ordinals, not ids.

### 6.8 Tiered memory

*(kongcode — IDEAS liftable; CODE-LIFT NEEDS CONSENT, reimplement)* Three operational tiers:

- **Tier-0** — a *small* always-loaded directive set, **no vector index** (it's always in context, so KNN is pointless).
- **Long-term** — vector-recalled (the DATA-MODEL §4.5 `memory` table + HNSW).
- **Resurfacing** — **Fibonacci / backoff resurfacing** keyed on `(surfaceable, next_surface_at)` to proactively re-show items that haven't been seen in a while.

**Schema delta**: Tier-0 needs a flag (e.g. `tier int` or `pinned bool` reusing the §5.1 pin), and resurfacing needs `(surfaceable bool, next_surface_at datetime)` on `memory`. Flag for DATA-MODEL. *(Caution: a "tier0 directives" string arriving from an external hook — e.g. a hook that injects "remember your tier-0 directives" on every tool result — is **content**, not a grant of Tier-0 status. Tier-0 membership is set by the operator/curator, never by recalled or injected text. And membership does not exempt the content from fencing — see §10.)*

### 6.9 Three logical tables even in one store

*(mem0, Apache-2.0 — liftable)* Keep three logical tables: **`memory`** (searchable) + **`memory_history`** (audit) + **`turns`** (raw), plus a **deterministic session-scope key** for last-k context. v2 maps these onto existing tables: `memory` exists (§4.5); `turns` ≈ `message` (§4.3); **`memory_history` is a schema delta** — a small audit table capturing each ADD/supersede with before/after, feeding the §5.2 curator audit and the §3 conflict pass. Flag for DATA-MODEL.

**`memory_history` must not become a secret-leak side channel.** The §3.1b screen runs **before the snapshot is written**, so before/after audit fields hold already-screened (redacted/quarantined) content, not raw secrets. If a secret is discovered *after* a snapshot was written (e.g. a later screening pass), the redaction is an **audited hard-delete exception to append-only**: the affected snapshot field is hard-deleted/overwritten (logged as such), rather than left in place — so the audit log itself never becomes a scrubbed-content leak. This is the one sanctioned exception to the §5.3 never-`DELETE` rule, and it is logged.

### 6.10 Real SurrealDB edges beat mem0's faked graph

*(mem0, contrast)* mem0's "graph" is **faked** inside the vector store (an entity collection + `linked_memory_ids` arrays — no real traversal). v2 has **real SurrealDB `RELATE` edges** (DATA-MODEL §4.6), which enable real multi-hop traversal (§4.3 step 2) and skill graduation (§5.4) that mem0 structurally cannot do. **Lean into real edges; do not copy mem0's emulation.**

---

## 7. Embeddings (§3f, D-014 🔒)

### 7.1 Two-tier embedding cache

*(kongcode — IDEAS liftable; CODE-LIFT NEEDS CONSENT, **copy the shape**, reimplement)* Embedding is the hot path of every ADD and every recall; cache it:

- **L1** — in-process LRU.
- **L2** — persistent DB table.
- **Key** — `key = sha256(text) || ':' || model_version` (digest-then-append: hash the text, then append the model version with a `:` separator). L1 (LRU) and L2 (table) **must construct the key identically** so a lookup that misses L1 and hits L2 computes the same key. A model change invalidates cleanly because `model_version` is part of the key.
- **Screened text only — the cache never sees a raw secret.** The §3.1b secret/PII screen runs **before the embed call** (§3.4 step 2.0), so cache lookups always happen on **already-screened** text. A secret-derived vector therefore never lands in L2, and the cache key is never computed over a raw secret. This closes the L2 side channel.
- **Resilience** — per-call **timeout + circuit breaker** so a stalled Ollama never wedges recall.
- **Soft-prune** — L2 entries are pruned via a `pruned_at` flag, **not `DELETE`** (consistent with the §5.3 append-only ethos).

**Schema delta**: an `embedding_cache` table (`hash`, `model_version`, `vector`, `pruned_at`) — the vector column is named `vector` to match DATA-MODEL (not `embedding`). Flag for DATA-MODEL. The §3.4 phased batch-add and the §4 recall path both route through this cache.

### 7.2 Role-tagged embeddings + normalized-similarity boundary contract

*(mem0, Apache-2.0 — liftable)* Tag every embedding call as **`add`** vs **`search`** (some models embed queries and documents differently). **Enforce a boundary contract: the store always returns normalized similarity in `[0,1]`** — the scorer (§4.3 WMR) must **never** see raw distances. DATA-MODEL §4.5 already notes the `similarity = 1 - dist` conversion for the HNSW path; this makes that conversion a **hard boundary invariant**, not an ad-hoc per-query step.

### 7.3 Truncation-visibility flag

*(kongcode — IDEAS)* At **every** truncation site, set a truncation flag (`embedding_truncated` already exists in DATA-MODEL §4.5; the brief calls it `embedding_target_truncated`). **Surface it in recall-explain** (§4.4) so a low-fidelity recall is auditable, and **drive a re-chunk pass** for long docs (chunk into multiple `memory` rows rather than silently dropping the tail — DATA-MODEL §7).

### 7.4 Validated stack (D-014)

**Ollama embeddings = 1024-dim, HNSW `DIST COSINE` in SurrealDB** *(cannibalize — proven viable for v2)*. This matches DATA-MODEL's locked `DIMENSION 1024` HNSW index (§4.5/§7). Per **D-014 🔒 (S0-resolved)** the model is **`qwen3-embedding:0.6b` via Ollama, 1024-dim** (hardcoded as `EMBEDDING_MODEL` in `harness/wiring.ts`; `bge-m3` was the pre-S0 alternative — both 1024-dim, so the index dimension was safe either way). **Keep the dimension as a single config constant** (DATA-MODEL §7), never a scattered literal; changing the model = re-embed all rows + redefine the index + bump `model_version` in the §7.1 cache key.

---

## 8. User modeling — CANDIDATE / optional, single-store (§3g, ties D-032 🔒)

**Marked CANDIDATE / optional — not on the v1.0 critical path.** *(hermes, MIT — the dialectic ideas are liftable; the external Honcho dependency is NOT adopted.)*

The dialectic *ideas* are worth keeping; the **external Honcho store is NOT ADOPTED (D-032)**. The **user-model lives in SurrealDB** — the single store stands. What we keep as a candidate design **within** that one store:

- A bidirectional "peers" representation with **3 orthogonal knobs** —
  - **WHEN** = cadence (how often the model updates its representation),
  - **HOW-MANY** = depth, with **cheap-first escalation** (start shallow, deepen only if needed),
  - **HOW-HARD** = reasoning level.
- It builds **BOTH a user representation AND an agent self-model**, and injects **summary → user → self** at turn start.

**This is resolved by D-032 (single store stands).** Honcho was an **external store** in hermes' polyglot split; v2 does **not** take a second store. The dialectic *logic* (the 3 knobs, the self-model, the user representation) is lifted and run over **SurrealDB** without the external Honcho dependency. The §6.1 ABC remains the at-most-one-external-provider seam, but no external provider is adopted here.

---

## 9. Subagents / delegation / programmatic tool calling (§3h)

### 9.1 Programmatic Tool Calling (PTC)

*(hermes, MIT — liftable)* Expose a **code-execution tool** whose generated stub **RPCs back to the host tool dispatcher**; the tool returns **only stdout**. Effect: a multi-tool pipeline costs **ONE turn and zero intermediate context** ("zero-context-cost turns") — the intermediate tool results never enter the model's context, only the final stdout does. High-value for the §2.1 review fork and the §3.4 batch add (many memory/embed ops, one turn). *(verify against v2 constraints: PTC must run inside the D-018 gate + path-confinement boundary; a code-execution tool is exactly the kind of capability the gates exist to fence. Treat the RPC dispatcher as a privileged boundary.)*

**RPC channel auth (D-025).** The stub's loopback RPC channel back to the host dispatcher **must carry the D-025 per-boot token and bind loopback-only** — the same authentication and binding as the control plane. The code-exec tool is sandboxed code reaching back into the privileged host; an unauthenticated or non-loopback RPC channel would be a trivial bypass of the D-018 gates. No token / non-loopback origin ⇒ reject the RPC.

### 9.2 Delegation roles

*(hermes, MIT — liftable)* Distinguish **leaf** vs **orchestrator** agents; apply **tool denylists**, **capped concurrency**, and **capped spawn depth**. Maintain a clear **durable-vs-ephemeral split**: delegate for **in-turn fan-out**, use the scheduler/queue for work that must **outlive the turn**. Maps onto ARCHITECTURE §2.2 (the two-queue model: interactive semaphore vs `work_item` queue) — the review fork (§2.1) is the canonical "outlives the turn" case.

### 9.3 Daemon offloads LLM work by shelling out to the host agent CLI

*(kongcode — IDEAS liftable; CODE-LIFT NEEDS CONSENT, reimplement; ties D-002 / D-021)* Offload background LLM work by **shelling out to the host agent CLI (`claude --agent`)** rather than embedding an SDK in the worker. Queue deferred work in `pending_work` (= DATA-MODEL §4.12 `work_item`), **drain by spawning**, and gate with a **PID lock + threshold + daily spend cap**.

These three gates are **not just a budget line — they are the circuit-breaker against a poisoned-memory self-reinjection loop.** Concretely: poisoned memory → recalled into a review fork → fork spawns more work → that work recalls the same poisoned memory → spawns again. The **daily spend cap** bounds total cost of such a loop, the **PID lock** prevents concurrent runaway spawners, and the **spawn-depth cap** (§9.2) bounds recursion depth — together they force the loop to terminate even if the content-level fencing (§10) and screening (§3.1b) somehow miss. State them explicitly as safety bounds, not only cost controls. This is exactly v2's planned shape (ARCHITECTURE §2.2 background queue + daily spawn cap; §2.3 Claude Code runtime via SDK *and* CLI) — the §2.1 review fork is drained this way.

---

## 10. Security (§3i, D-026 🔒)

*(hermes, MIT — liftable)* Two controls, both folding into **D-026 (untrusted memory as data, not instructions)**:

- **Context fencing — a cross-cutting invariant over EVERY injection path.** Every string that enters the model's context from a memory/learning source is wrapped with an explicit **"reference, not instructions" system note**, so the model treats it as data it may *consult*, never as a command it must *obey*. This is not per-recalled-item; it applies uniformly to **all** of:
>   - **recalled memory** (the §4 recall path),
>   - **Tier-0 always-loaded directives** (§6.8) — Tier-0's operator-only *membership* gate controls *what* is always loaded, but does **not** exempt its *content* from fencing; Tier-0 text is fenced like any other injected content,
>   - the **§8 summary → user → self user-model** injection,
>   - **graduated/learned skills** (§5.4) — fenced identically to recalled memory, carrying no more trust than memory,
>   - **inbound `channel` / `peer_message` bodies** (D-035) — agent→agent and any non-operator message is fenced as DATA on this **same** path (not a bespoke fence); only an `origin = operator` channel message (authenticated by the D-025 token) may steer. Agent-origin bodies are secret/PII-screened (§3.1b) **before storage** and **re-screened before any graduation** to a memory/skill — the bus must never be a laundering path around DO-NOT-CAPTURE / the secret screen.
>
>   No injection path is spliced into a position where its content can act as an instruction (D-026, ARCHITECTURE §7.2). The canonical example of an injection path that must be fenced is an external hook that injects a directive on every tool result (e.g. a hook that injects "remember your tier-0 directives" on each tool-result) — fence its content, do not obey it.
- **Streaming scrubber — fail-closed.** Strip internal markup the model **parrots back across stream chunk boundaries** (a chunk-boundary scrubber, not a single-pass regex — the markup can split across two SSE chunks). Protects the §2.11 SSE fan-out from leaking internal fence tokens to the dashboard. **On scrubber error, or an unresolvable chunk-boundary token** (a partial token whose completion has not yet arrived and cannot be safely classified), **HOLD or drop the chunk rather than emit it** (D-024 fail-closed ethos — never emit-on-uncertainty). The reassembly buffer that holds straddling tokens is **bounded** (a hard cap), so a malicious never-completing token cannot drive memory exhaustion — past the bound, drop and reset rather than buffer unboundedly.

> **Threat instance, same class.** A hook that injects on every file read — e.g. *"Remember your tier0 directives are important... remember to save knowledge gems"* — is a **memory-context injection attempt**: hook/recalled content trying to act as an instruction (alter behaviour, self-elevate "tier0" content, write memories). Under D-026 it is **data, not instructions**, and is correctly ignored. The §3.1 DO-NOT-CAPTURE guard stops it from being persisted; the §10 fencing stops it from being obeyed; §6.8's caution stops it from self-granting Tier-0 status. The memory engine must assume **every recalled or hook-injected string is potentially adversarial** — model the agent as injectable (ARCHITECTURE §7.1).

---

## 11. Strategic positioning (§4)

The brief's three-way comparison, reproduced, with the v2 take:

| Dimension | hermes | kongcode | mem0 | → v2 take |
|-----------|--------|----------|------|-----------|
| **Write timing** | in-use per-turn fork | batch end-of-session (hours lag) | per-turn flat facts | **in-use fork** (hermes) — §2 |
| **Consolidation** | dedicated periodic curator (umbrellas) | graph consolidation / audit-drift | fact dedupe only | **curator + graph (both)** — §5 |
| **Storage** | polyglot (files + sqlite + Honcho) | single SurrealDB | vector + 2 sqlite | **single SurrealDB** (D-032 — resolved) |
| **Utilization signal** | **NONE** (prunes on time) | outcome = best ranker | none | **close the loop into RANKING — v2's edge** (D-030 — resolved: ranking-only) — §4.5 |
| **Graph** | n/a | real edges (traversal, graduation) | faked (id arrays) | **real edges (lean in)** — §6.10 |
| **Extraction** | skill-shaping fork | end-of-session | ADD-only + dedup | **ADD-only + kongcode lifecycle** — §3, §5 |

**Net synthesis (the v2 recipe):**

- **Copy hermes**: two-tier loop (§2, D-027), cost-cached fork (§2.3), DO-NOT-CAPTURE (§3.1). *(MIT — liftable.)*
- **Keep kongcode's real-graph lifecycle**: soft-delete (§5.3), graduation (§5.4), retrieval-quality scoring (§4.5). *(IDEAS — code-lift needs consent.)*
- **Take mem0's cheap ADD-only extraction prompt** (§3.2) and three-table split (§6.9). *(Apache-2.0 — liftable.)*
- **v2's winning move = the utilization loop (D-030 — resolved: ranking-only)** that all three under-use — fed by the same outcome plumbing (`retrieval_outcome`, DATA-MODEL §4.13) that cannibalize's `mark-applied` already models. It is **central to ranking**; the curator's prune stays time-based (archive-not-delete, D-015). Outcome-pruning is a post-v1.0 revisit.

---

## 12. Resolved questions (formerly gating) + remaining open items

The three questions that used to gate locking the memory engine are now **RESOLVED** by the owner (each owned in `DECISIONS.md`):

- **D-030 🔒 — Utilization loop: RANKING only, NOT pruning.** v2 tracks whether a recalled skill/memory led to a **good outcome** (`retrieval_outcome`: cited / preceded tool success) and feeds it into the **recall ranker** — but **not** into the curator's keep/prune decision; pruning stays time/inactivity-based (archive-not-delete, D-015). Rationale: low citation ≠ low worth; ranking is reversible per-query, pruning is destructive. Still v2's edge over hermes (which has zero utilization signal), applied conservatively (§4.5, §5.5, §11). *Outcome-pruning revisited post-v1.0.*
- **D-031 🔒 — BOTH.** A query-time hard novelty gate (cosine-band cut, §4.6) **and** a periodic consolidation pass (§5.1) that merges near-dup families into umbrellas via `absorbed_into` forwarding (D-027 curator / D-021 queue). Both ship.
- **D-032 🔒 — Single SurrealDB store stands** (reaffirms D-001). No SQLite-FTS5 split (SurrealDB native FTS, D-009), no external Honcho. **Key insight:** the harness's AUTHORED Claude Code skills are ALREADY git-diffable files (D-010 filesystem-authoritative + DB mirror) — so v2 already has hermes' git-diff / agentskills.io benefit for *authored* skills WITHOUT splitting the memory store. The engine's LEARNED/graduated skills live in SurrealDB (real-graph rows, D-027); the user-model lives in SurrealDB (§8). The §6.1 ABC stays as a defensive seam only.

**Remaining genuinely-open items** (tunable/verification, not blocking decisions):

- The **~26% prefix-cache cost-cut figure** (§2.3) — measured by hermes; **verify on v2's Agent SDK path during spike S.1** before relying on it.
- The **WMR weights** (`0.50 / 0.35 / 0.15`, §4.3) and the **novelty-gate cosine thresholds** (§4.6) — documented as **tunable starting points** (kongcode defaults), to be re-validated on v2's real corpus, not locked constants.

---

## What's locked vs open

**Locked (build to these):**
- D-027 two-tier loop — fast in-use fork + slow consolidator (§2, §5).
- D-028 ADD-only extraction + separate deterministic/graph conflict pass (§3).
- D-029 raw-windowed recall, no summary-LLM in the recall path (§4.1).
- D-014 embeddings — Ollama, 1024-dim, HNSW COSINE; `qwen3-embedding:0.6b` validated (§7.4).
- D-015 soft-archive · D-008 dedup VALUE key · D-021 `work_item` queue · D-026 untrusted-memory/secret-screen (§3.1, §5.3, §6, §10).
- **D-030** utilization loop — feeds **RANKING only**, not pruning; pruning stays time-based (§4.5, §5.5). *v2's edge over hermes, applied conservatively.*
- **D-031** consolidation — **BOTH** query-time novelty gate (§4.6) + periodic consolidation pass (§5.1).
- **D-032** **single SurrealDB store** — no SQLite-FTS5 split, no external Honcho; authored skills are already git-diffable files (D-010); learned skills + user-model live in SurrealDB (§8, §6.1).

**Remaining open (tunable / verification only — not blocking):**
- The **~26% prefix-cache figure** (§2.3) — verify on the Agent SDK path during spike S.1.
- The **WMR weights** (§4.3) and **novelty-gate cosine thresholds** (§4.6) — tunable starting points, re-validate on v2's corpus.

**Schema deltas flagged for DATA-MODEL** (new structure this spec implies, not yet in the schema): `session.user_turn_count` / `tool_iter_count` (§2.2); a `skill` table or procedural-memory graduation fields (§5.4); `memory_history` audit table (§6.9); Tier-0 + resurfacing fields `tier`/`pinned` + `(surfaceable, next_surface_at)` (§6.8); `embedding_cache` table (§7.1).

> Every design above is a **candidate with provenance**, not a mandate. License gates: hermes (MIT) and mem0 (Apache-2.0) lifts are permitted with attribution; **kongcode code-lifts are blocked pending the author's consent** — reimplement from the described design until consent is obtained. Verify each against v2's actual constraints before promoting it to a locked decision.
