# CANNIBALIZE-BRIEF — research input for v2 docs

> **What this is.** Distilled findings from the `cannibalize` foundry (F:\code\cannibalize) — projects/skills studied for ideas v2 should steal. **This is a research INPUT, not a v2 doc.** Fold the relevant parts into the real docs (map below); keep the provenance.
>
> **Status of each item = candidate, not mandate.** Each carries a source. Treat as "adapt, don't follow blindly." Verify against v2's actual constraints before committing to DECISIONS.md.
>
> **Provenance + licenses** (matters before lifting CODE, not ideas):
> - `hermes-agent` (Nous Research) — **MIT**, commercial-safe, liftable.
> - `mem0` — **Apache-2.0** (prompts/code liftable).
> - `kongcode` — a **friend's** plugin; ideas/findings fine, **lifting code needs his consent**.
> - design skills: `ui-ux-pro-max` MIT (src only; cli is CC-BY-NC), `impeccable` Apache-2.0, motion/a11y/ux-writing/cuellarfr/mckinsey/motion-dev **MIT**, `sveltekit-tailwind` license **UNRESOLVED** (ideas only).
>
> **Query the foundry for more** (137+ findings; this brief is the v2 slice): `F:\code\cannibalize\scripts\find-relevant.ps1 -Query "..." -Semantic -Hydrate`.

## Fold-into map (where each part belongs in v2 docs)
| Part | → target doc |
|------|--------------|
| Recommended decisions (§1) | `DECISIONS.md` (as ADRs) |
| Open questions (§2) | `DECISIONS.md` open items / a v2 MEMORY-SPEC |
| Memory-engine knowledge (§3) | `ARCHITECTURE.md` + a memory/learning spec |
| hermes vs kongcode vs mem0 (§4) | `ARCHITECTURE.md` rationale / `PRODUCT.md` differentiators |
| Agent + skill authoring (§5) | `AGENTS.md` + skill conventions |
| Design/UI (§6) | **already applied** to `UI-SPEC.md` — reference only |

---

## 1. Recommended v2 decisions (ADR candidates)

**D-A — Two-tier learning loop: fast in-use writer + slow periodic consolidator.** *(hermes)*
Fast additive write happens in-use (a forked, tool-restricted review subagent fires on a turn-count cadence, mines the just-finished turn for memory/skill writes, runs async). A SEPARATE periodic consolidator (inactivity-triggered, ~7-day) merges narrow knowledge into class-level umbrellas and GCs stale items. **Decouples WRITE cadence from CONSOLIDATE cadence** — keeps knowledge fresh without micro-knowledge proliferation. This is the architecture to copy wholesale.

**D-B — Extraction is ADD-only; conflict resolution is a separate deterministic/graph pass.** *(mem0 + kongcode)*
Keep extraction cheap (one LLM call, ADD-only — mem0's V3 dropped LLM ADD/UPDATE/DELETE decisioning). Do dedup/supersession/contradiction in a downstream graph pass (supersede edges), NOT by trusting the LLM to mutate in place. Pair with kongcode's lifecycle (graduation, decay) — see §4.

**D-C — Cross-session recall returns RAW windowed messages + bookends, no summary-LLM.** *(hermes)*
FTS5 (or vector) → dedupe by session lineage → return windowed raw messages + first/last bookends. Skip LLM summarization in the recall path: cheaper, no latency, no summarization hallucination; the live agent has reasoning budget and prefers real excerpts. Reserve LLM synthesis for an explicit dialectic tool, not default recall.

**D-D — Design skills feed UI-SPEC (seed + gate).** *(already decided + applied to UI-SPEC.md)*
`ui-ux-pro-max` seeds foundations (dev-tool/dashboard rows, MIT src only); `impeccable` gates via anti-pattern detector + critique; bans frozen as §9 acceptance criteria. Listed for completeness — no further action.

---

## 2. Open questions for v2 (resolve before locking the memory design)

1. **Close the utilization loop hermes leaves OPEN?** hermes self-improvement is pure WRITE-time judgment with NO retrieval/utilization feedback — it never measures whether a saved skill later helped, and prunes purely on inactivity time. kongcode's lesson (and cannibalize's own `mark-applied` outcome signal): retrieval ≠ utilization, and outcome is the best ranker. **Should v2 track whether a recalled skill/memory led to a good outcome and feed that into BOTH ranking AND the curator's keep/prune decision?** (This is where v2 can *beat* hermes, not just match it.)
2. **Periodic consolidation pass vs retrieval-time diversity gates?** (Or both — kongcode hints both: hard novelty gate at query time + a consolidation pass so near-dup families don't accumulate.)
3. **Single SurrealDB store vs hermes' polyglot split?** hermes: skills = SKILL.md files + sidecar `.usage.json` telemetry; sessions = SQLite FTS5; user-model = external Honcho. kongcode + v2's plan = single SurrealDB. Does hermes' split carry advantages worth keeping (git-diffable skills, agentskills.io interop, FTS5 maturity), or does one unified store win?

---

## 3. Memory-engine knowledge (by theme)

### 3a. Learning loop (write-time self-improvement)
- **Forked review agent after every Nth turn** — async daemon thread, tool-whitelisted to memory+skill only, writes straight to stores, never touches the live prompt cache. *(hermes)*
- **Two-cadence nudge** — memory on user-turn count, skills on tool-iteration count; modulo-hydrated so cadence survives per-message agent rebuilds. *(hermes)*
- **Background fork inherits the parent's cached system-prompt prefix verbatim** (same tools[] order, same timestamp) → prefix-cache hits, **~26% measured cost cut**. Bake in from day one — self-improvement is only affordable if review calls cache-hit. *(hermes)*
- **Three review prompts** (memory-only / skill-only / combined), selected by which trigger fired — liftable near-verbatim (MIT). *(hermes)*

### 3b. Extraction policy
- **DO-NOT-CAPTURE guardrail** — never persist environment failures or negative tool claims ("X is broken"); they harden into self-cited refusals for months. Rewrite failures as fixes. **Highest-value cheap win; lift the prompt near-verbatim.** *(hermes)*
- **450-line extraction prompt** with Observation-Date grounding, anti-echo, preserve-specifics rules + 12 worked examples — steal wholesale, adapt examples to the coding-agent domain. *(mem0)*
- **UUID→integer remapping before the LLM** — hand the LLM ordinal handles, not record ids, when linking/merging; translate back host-side (anti-hallucination). *(mem0)*
- **Phased batch add** — one LLM call per turn; batch all embeds/inserts/history/entity-linking, each with per-item fallback. *(mem0)*

### 3c. Cross-session recall + retrieval ranking
- **Recall = FTS5, zero-LLM, windowed messages + bookends** (see D-C). *(hermes)*
- **FTS5 query sanitizer** — preserve quoted phrases, strip operators, quote dotted/hyphenated terms, CJK trigram fallback — liftable near-verbatim (MIT). *(hermes)*
- **Staged retrieval pipeline**: vector search → graph-neighbor + causal expansion → WMR/ACAN score → cross-encoder rerank with salience bands + tail-drop noise filter. Keep WMR weights + band thresholds as documented starting points. *(kongcode)*
- **Hybrid retrieval** — semantic + BM25 + entity-boost with an adaptive normalizing divisor + explain mode. *(mem0)*
- **Retrieval-quality scoring** — record per-injection whether context got USED (not just retrieved): 6 signals, `[#N]` citation parse, implicit-path-hit rescue. Use to prefilter junk AND train the ranker. *(kongcode)* ← this is the utilization loop §2.1 asks about.
- **HARD novelty gate beats soft MMR** when the corpus has redundant near-dup families (measure family-vs-distinct cosine bands to set the cut). *(kongcode)*

### 3d. Consolidation / lifecycle / GC
- **Curator: inactivity-triggered batch consolidation** into class-level umbrellas; archive (never delete) stale; exempt pinned. *(hermes)*
- **Curator never deletes** — archive is max destructive; rewrite refs/edges pointing at an absorbed item to the umbrella (`absorbed_into` forwarding). *(hermes)*
- **3-signal curator classification** — reconcile model's `absorbed_into` declaration + structured summary + tool-call audit; model wins unless it hallucinates. *(hermes)*
- **Append-only soft-delete** — never DELETE; set `active=false + archived_at + archive_reason + superseded_by`; one shared active-set filter used by every reader. *(kongcode)*
- **Skill graduation** — `causal_chain → skill`, gated by a once-only `graduated_at` watermark; skill rows carry success/failure RL counts + name-scoped supersession; inject proven skills as "adapt, don't follow." *(kongcode)*
- **mem0's gap = v2's differentiator**: mem0 is append-only with NO decay/audit/graduation. Keep its cheap ADD-only extraction but ADD the lifecycle layer (confidence/decay, drift audit, supersede-on-contradiction, graduation). *(mem0, antipattern)*

### 3e. Storage & schema (SurrealDB)
- **At most ONE external memory provider, behind an ABC** with full lifecycle hooks; built-in always first; provider failures never block siblings. *(hermes)*
- **SCHEMALESS base + explicit `DEFINE FIELD option<T>`** for any field indexed/filtered/coerced on a `RETURN AFTER` write. *(kongcode)*
- **`option<bool> NONE` + `RETURN AFTER` deadlock** — any boolean/enum read back on write MUST be `option<>` or backfilled in the same migration; add a predeploy normalize pass. *(kongcode, gotcha)*
- **Idempotent migrations** — gate one-time table-scan UPDATEs behind `LET + IF count`; `OVERWRITE` to widen tables/edges; annotate each with a CLOSURE removal condition. *(kongcode)*
- **Computed `dedup_key` (VALUE field)** for "one active per group, many archived" invariants; backfill VALUE fields with a no-op touch-UPDATE at schema apply. *(kongcode)*
- **Optimistic-lock queue claim** — `UPDATE ... WHERE status='pending' RETURN AFTER` over a small candidate set (no row locks in SurrealDB); transactional stale-recovery for orphaned `processing`. *(kongcode)*
- **UUID-vs-Thing bridge** — decide per table whether to key on the harness UUID or the Thing id; if UUID, add an indexed bridge field + typed edges; document at every call site. *(kongcode)*
- **Tiered memory** — small always-loaded Tier-0 directive set (no vector index) + vector-recalled long-term + Fibonacci/backoff resurfacing keyed on `(surfaceable, next_surface_at)`. *(kongcode)*
- **Three logical tables even in one store** — `memory`(searchable) + `memory_history`(audit) + `turns`(raw) + a deterministic session-scope key for last-k context. *(mem0)*
- **mem0's "graph" is faked** in the vector store (entity collection + `linked_memory_ids`, no real graph). kongcode/v2's true SurrealDB edges get real traversal + skill-graduation mem0 can't — **lean into this, don't copy mem0's emulation.** *(mem0, contrast)*

### 3f. Embeddings
- **Two-tier embedding cache** — in-proc LRU (L1) + persistent DB table (L2), keyed by `sha256(text)+model_version`, with timeout + circuit breaker. Soft-prune L2 via `pruned_at`, not DELETE. Copy the shape wholesale. *(kongcode)*
- **Role-tagged embeddings** — tag calls `add` vs `search`; enforce a "store returns normalized similarity in [0,1]" contract at the boundary so the scorer never sees raw distances. *(mem0)*
- **Truncation-visibility flag** — set `embedding_target_truncated=true` at every truncation site; surface in recall-explain; drive a re-chunk pass for long docs. *(kongcode)*
- *(cannibalize already proved this stack: Ollama `qwen3-embedding:0.6b` = 1024-dim, HNSW COSINE in SurrealDB — viable local embedder for v2.)*

### 3g. User modeling
- **Honcho dialectic** — bidirectional peers, 3 orthogonal knobs (WHEN=cadence, HOW-MANY=depth w/ cheap-first escalation, HOW-HARD=level), builds BOTH a user representation AND an agent self-model; inject summary→user→self at turn start. *(hermes)*

### 3h. Subagents / delegation / programmatic tool calling
- **Programmatic Tool Calling (PTC)** — expose a code-execution tool whose generated stub RPCs back to the host tool dispatcher; return only stdout → multi-tool pipelines cost ONE turn and zero intermediate context ("zero-context-cost turns"). *(hermes)*
- **Delegation roles** — leaf vs orchestrator, tool denylists, capped concurrency + spawn depth; clear durable-vs-ephemeral split (delegate for in-turn fan-out, scheduler for outliving the turn). *(hermes)*
- **Daemon offloads LLM work by shelling out to the host agent CLI** (`claude --agent`), not embedding an SDK; queue deferred work in `pending_work`, drain by spawning; gate with PID lock + threshold + daily spend cap. *(kongcode)*

### 3i. Security
- **Memory-context fencing** — fence injected memory with an explicit "reference, not user input" system note; run a streaming scrubber to strip internal markup the model parrots back across stream chunk boundaries. *(hermes)*

---

## 4. hermes vs kongcode vs mem0 — strategic positioning for v2

| Dimension | hermes | kongcode | mem0 | → v2 take |
|-----------|--------|----------|------|-----------|
| **Write timing** | in-use per-turn fork | batch end-of-session (hours lag) | per-turn flat facts | in-use fork (hermes) |
| **Consolidation** | dedicated periodic curator (umbrellas) | graph consolidation / audit-drift | fact dedupe only | curator + graph (both) |
| **Storage** | polyglot (files + sqlite + Honcho) | single SurrealDB | vector + 2 sqlite | single SurrealDB (Q §2.3) |
| **Utilization signal** | **NONE** (prunes on time) | outcome = best ranker | none | **close the loop — v2's edge** |
| **Graph** | n/a | real edges (traversal, graduation) | faked (id arrays) | real edges (lean in) |
| **Extraction** | skill-shaping fork | end-of-session | ADD-only + dedup | ADD-only + kongcode lifecycle |

**Net:** copy hermes' two-tier loop + cost-cached fork + DO-NOT-CAPTURE; keep kongcode's real-graph lifecycle (soft-delete, graduation, retrieval-quality); take mem0's cheap ADD-only extraction prompt. **v2's winning move = the utilization loop all three under-use** (hermes ignores it, mem0 lacks it, kongcode has it — v2 should make it central, fed by the same outcome plumbing cannibalize's `mark-applied` already models).

---

## 5. Agent + skill authoring conventions (→ AGENTS.md / skill conventions)

*(harvested from kongcode + hermes skills; mostly MIT/hermes, kongcode ideas)*
- **Description-as-classifier** — every skill description: `Activate when <intent>. Triggers include "<verbatim user phrases>".` Routing with no code. *(kongcode)*
- **Sibling disambiguation tails** — for a skill family, each description ends `use <sibling> instead when <condition>`. *(kongcode)*
- **Stakes-and-consequence clause** — proactive/maintenance skills name the silent failure that happens if they DON'T fire. *(kongcode)*
- **Timing directive in trigger** — "Use BEFORE <irreversible action>, not after." *(kongcode)*
- **Lazy-loaded skill body** — stub description + one-line loader; serve long bodies from tool/DB at activation. *(kongcode)*
- **Tools whitelist = minimal MCP set the Process needs**; reporting/introspection agents get a read-only subset. *(kongcode)*
- **Numbered loop-until-empty Process** for queue-draining workers; push per-task schema into the work payload, not the prompt. *(kongcode)*
- **Present/Output block** — prescribe the output shape (a field checklist), not just the gather process. *(kongcode)*
- **Per-output-type quality standards** block with anti-hallucination guards ("evidence-grounded", "only-if-it-worked"). *(kongcode)*
- **Identity-stakes coda** + a "X is earned/grounded, not invented" guard in the recency slot. *(kongcode)*
- **Model tier per agent, stated in frontmatter** (structured→haiku, judgment→sonnet/opus). *(kongcode)*
- **agentskills.io standard** — SKILL.md YAML frontmatter + `references/templates/scripts/assets` dirs; namespace v2 metadata under `metadata.<v2>.*` to stay compatible. *(hermes)*
- **Skill telemetry in a sidecar**, not in SKILL.md frontmatter (mutable counters out of authored content). *(hermes)*

---

## 6. Design / UI knowledge — ALREADY APPLIED to UI-SPEC.md

No action — recorded for traceability. Folded in:
- **§7 Motion model** — frequency gate, enter≠exit, GPU-only, reduced-motion, Svelte 5 vanilla-Motion path *(design-motion-principles, motion-dev)*
- **§8.1 Chart design** — chart-by-data-question, asserted titles, two-role color, data-ink *(mckinsey-viz, logic only)*
- **§9 A11y acceptance criteria** — SSE live regions, data-viz a11y, contrast CI gate, WCAG 2.2 keyboard *(accessibility-agents)* + frozen anti-pattern bans *(impeccable)*
- **§11 Microcopy** — button/error/empty/success/unknown rules + 4-standard pass *(ux-writing-skill)*
- **§15.1 seed** — ui-ux-pro-max dev-tool/dashboard palette + JetBrains Mono/IBM Plex Sans candidates
- Stack gotchas available for the build: Svelte 5 runes/SSR, Tailwind v4 `@theme` *(sveltekit-tailwind, findings-only — license unresolved)*

---

*Generated from the cannibalize foundry, 2026-06-06. 37 sources, 154 findings, 14 components, 4 decisions, 3 questions, 176 embedded. To regenerate or go deeper: `F:\code\cannibalize\scripts\find-relevant.ps1 -Query "<topic>" -Semantic -Hydrate`.*
