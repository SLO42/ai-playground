# Atelier Cognitive Architecture + Concierge — Spec & Roadmap

**Status:** active build (2026-06-30). Operator-directed. This is the canonical design
record; auto-memory mirrors it ([[project_atelier-concierge-vision]],
[[project_atelier-agents-awareness]]) but `docs/` is the source of truth the build agents
and future sessions read.

## 1. Vision (operator, 2026-06-30)

Atelier should be a **living, self-improving platform** with three intertwined pieces:

1. **A real cognitive architecture** as its brain — SurrealDB graph memory + **learned
   retrieval** + **automatic extraction** (concepts, causal chains, skills, corrections) +
   **emergent identity ("soul")**. Modeled on **laqrumcode** (`github.com/42U/laqrumcode`,
   formerly kongcode) — adopted as a *pattern/layer*, not a ported engine (§4).
2. **An always-on "concierge" agent** — the apex / "highest-level view of everything that
   happens", which *lives inside* the brain (reads it for context) and is reachable by PMs
   over the comms bus. PMs **ask** it for agent recs / skills / hires; it **advises**; the
   **operator gates** hires/arming. (Realizes the reserved D-040 "self-hosting" seam.)
3. **The memory explorer (`/memory`) as the cognition viewer** — the brain *thinks* in
   SurrealDB and the explorer *shows it thinking*: extraction, learned retrieval, and
   grounding are all visualized.

The self-improving loop: a PM (on its loop) hits a need → messages `to_kind:'atelier'` →
the concierge recommends an agent (recommender built) / a skill (`cc_skill`) / drafts a new
specialist → HR gauntlet certifies → **operator approves the hire** → it runs in the
project's loop → invocation tracking feeds future recs. Loops are the substrate at three
levels: Atelier-self (maintenance), per-project (dev→verify→review→release), PM-cadence.

## 2. laqrumcode — the adopted pattern (ingested into context-mode 2026-06-30)

Persistent cognitive layer for Claude Code: SurrealDB graph + BGE-M3 embeddings + a learned
reranker, fronted by an always-on daemon.
- **Data model:** `memory` (SCHEMALESS, 1024-dim HNSW COSINE, importance/confidence/access/
  status), `concept` (semantic, `stability`), `causal_chain` (trigger→outcome), `skill`
  (procedural), `correction` (as high-importance memory), `soul`/`identity_chunk`/
  `maturity_stage`; telemetry `retrieval_outcome` (per session·turn·memory; query_embedding,
  utilization, llm_relevance), `turn_score`. Edges: `narrower`/`broader`/`related_to`/
  `about_concept`; `caused_by`/`supports`/`contradicts`/`describes`; `supersedes`.
- **Lifecycle:** daemon runs a per-turn extractor (9 types) → embed → write (dedup). Learned
  retrieval: vector search → **ACAN** learned reranker (replaces a 7-signal heuristic once
  outcome data accrues) → BGE cross-encoder → graph expansion (98.2% R@5). Feedback:
  `record_retrieval_feedback` relabels `retrieval_outcome.llm_relevance` → ACAN training
  label; retrains in a worker, hot-reloads.
- **Soul graduation:** 8 gates (7 volume thresholds + 1 quality ≥0.85) → self-authored soul
  doc loaded every turn.
- **Runtime:** one long-lived daemon owns the pool/models/weights; thin per-session MCP
  clients over a Unix socket.

## 3. Atelier today vs laqrumcode (gap map)

Cited against `ai-playground-v2/src/lib/server/`.

| Capability | Atelier today | laqrumcode |
|---|---|---|
| Vector memory | ✅ `memory`+`memory_vec` HNSW 1024-dim COSINE; `skill`+`skill_vec`; `embedding_cache`; screen-before-embed `memory/store.ts` | ✅ |
| Graph | ⚠️ `entity` + `references` edge only (`memory/bridge.ts`) | ✅ full concept hierarchy + episodic edges |
| Causal chains | ✅ `causal_chain` (`memory/loop.ts`) | ✅ |
| Retrieval telemetry | ✅ `retrieval_outcome` (`memory/outcomes.ts`, `briefing.ts`); R@5 `memory/eval/harness.ts` | ✅ + feeds ACAN |
| Learned reranker (ACAN) + cross-encoder | ❌ heuristic recall only | ✅ |
| Explicit feedback → relabel → retrain | ❌ (rows exist; no relabel tool) | ✅ |
| Auto multi-type extraction | ⚠️ partial (`loop.ts`, `bridge.ts`); no per-turn 9-type | ✅ |
| Concept / correction / soul / identity | ❌ none | ✅ |
| Always-on shared embed/rerank daemon | ❌ inline embed | ✅ |

The file→DB auto-memory bridge (`memory/bridge.ts`) is **Atelier-native, not laqrumcode-
derived** (laqrumcode/ACAN/BGE grep-absent in the repo).

## 4. Adoption decision — ADOPT A LAYER, do NOT port the engine

Atelier already has the SurrealDB brain, 1024-dim HNSW, `retrieval_outcome`, `causal_chain`,
screen-before-embed store, recall, and an eval harness. Porting laqrumcode's daemon would
fork the embedding path and spin up a second ns/db brain — fighting Atelier's single-store +
D-026 quarantine discipline. Instead: give the concierge a laqrumcode-**style** retrieval +
extraction layer over Atelier's existing tables, embedding through the existing path.

### 4.1 The vector DB is SurrealDB; the embedder is the one swappable piece

There is **no separate vector database** — SurrealDB is multi-model (vector HNSW + graph +
document + relational in one store). Atelier's vector indexes live inside it: `memory_vec`
and `skill_vec` (1024-dim HNSW COSINE), `embedding_cache`, and the new `concept` embeddings
use the same path. Adding a bolt-on vector DB (Pinecone/Qdrant/etc.) would split the brain
and break the native joins between vectors, edges, and telemetry — and leave the D-026
quarantine boundary. So: keep everything in the one SurrealDB store.

The **only** component outside SurrealDB is the **embedder** (text → 1024-dim vector), and it
sits behind a swappable `Embedder` interface (`memory/embed.ts`, injected into `memory/
store.ts` / `memory/concepts.ts`; screen-before-embed, D-026). Current config: **Ollama →
`qwen3-embedding:0.6b`, 1024-dim**, via `POST /api/embed` (`OllamaEmbedder`). Two INDEPENDENT
knobs, both deferred optimizations (decide with the R@5 eval harness — do NOT block the
foundation; the seam makes either a cheap swap that never touches the brain):

1. **Serving — Ollama HTTP vs in-process (cpp/native).** Ollama adds an HTTP round-trip per
   embed; an in-process embedder (llama.cpp / candle / a Rust binding — what laqrumcode's
   daemon does) removes that overhead, which matters when the extraction/retrieval loop embeds
   many items per turn. Our model is tiny (0.6B) so Ollama is fine for now.
2. **Model — `qwen3-embedding:0.6b` vs BGE-M3.** laqrumcode's 98.2% R@5 is on **BGE-M3**; we
   run qwen3-embedding 0.6b. Both 1024-dim (index-compatible), but retrieval *quality* may
   differ. BGE-M3 is available via Ollama or cpp if we want laqrumcode-parity recall.

Rule: keep the `Embedder` seam clean so serving and model can change behind it; any dim change
must stay 1024 to match the live HNSW indexes (or migrate the index).

## 5. Stages (each at a cited seam)

- **S0 — Ground-on-memory:** concierge reads via `memory/recall.ts` + `scene/scene.ts`; must
  cite injected items. No new infra.
- **S1 — Explicit feedback** *(cheapest, highest signal)*: a `record_retrieval_feedback`-style
  tool that UPDATEs `retrieval_outcome.llm_relevance` (rows already carry the query embedding,
  `memory/outcomes.ts`).
- **S2 — Learned reranker:** ACAN-like scorer over utilization labels; keep heuristic recall
  as baseline; measure with `memory/eval/harness.ts`. Optional cross-encoder.
- **S3 — Concept graph + extractor:** `concept` table + hierarchy/episodic edges +
  corrections-as-memory + `supersedes`; mine concepts/corrections/decisions on the
  **heartbeat/loop** (`memory/loop.ts`), NOT a new daemon.
- **S4 — Soul/identity:** `soul`/`maturity_stage` graduation loaded into the concierge's turn
  context (serves "Atelier feels ALIVE").
- **Cross-cut — Explorer viz:** new scene classes (concept/causal/skill/correction) + edge
  kinds (extracted-from / retrieved / grounded-on) in `scene/scene.ts` + `MemoryScene.svelte`;
  timeline scrubber replays extraction/retrieval.
- **Then — the Concierge** (§6) sits on top.

**Build order chosen (operator):** S3 + explorer viz (+ S1) first → S2 → S4 → concierge.
Built one stage at a time (sequential, F-052), each scout→build→verify→report.

## 6. The Concierge — comms seam (reserved, D-040)

- Bus = `peer_message` (`db/schema.ts`): `to_kind ASSERT IN [session,role,pm,atelier]`.
  Ingress `api/peer/send` (loopback D-025, sender server-pinned). Delivery: live
  `channel.interject` else pending inbox (`peer/drain.ts`). **Async, fire-and-forget,
  NON-STEERING — "no agent commands another agent."** So the concierge **advises**, the
  PM/operator **acts**.
- `resolveAtelier` (`peer/resolve.ts`) is a **documented placeholder** — resolves to a
  long-lived session under the atelier-self PM (`ATELIER_PROJECT_KEY='__atelier__'`), but
  none is spawned, so `'atelier'` msgs inbox pending; `affordance.ts` says `pm`/`atelier`
  "not yet reachable."
- Session kinds (`schema.ts`): chat/task/review/release/discussion/interview — **no `atelier`
  kind**. Cleanest build seam: spawn a long-lived `atelier_self` session so `resolveAtelier`
  resolves live; the peer route + `coerceAddress('atelier')` need no change.
- Concierge Stage 1 (when reached): alive + reachable + brain-reading (S0) + answers a PM's
  "recommend an agent" over the bus via the existing recommender (`agent-library/recommend.ts`).
- **Concierge future capability — SKILL DISCOVERY (operator, 2026-07-01, "eventually"):** teach
  Atelier the `find-skills` skill (vercel-labs/skills `skills/find-skills/SKILL.md`). Mechanism:
  the `npx skills` CLI (`find`/`add`/`check`/`update`) + the skills.sh leaderboard;
  **verify-before-recommend** (install count ≥1K, source reputation — official
  `vercel-labs`/`anthropics`/`microsoft` trusted). Slots into the concierge's reserved
  "recommend a skill (`cc_skill`)" answer: a PM asks Atelier for a skill → concierge searches the
  OPEN ecosystem, quality-gates, and PROPOSES. Our gates on top: NO silent install (operator/PM
  approves — like hiring, §7), D-026 screen + D-037-class review on any third-party skill code
  before it enters a `.claude` scope, and the catalogued-capability rule (F-045 — a skill id must
  be in a SYNCED catalog scope before any bundle declares it). Advisory only (non-steering bus).

## 7. Standing gates (non-negotiable)

- **Hiring is never silent** — auto-draft + auto-certify OK, but the **operator approves the
  hire** (D-039 / B4).
- **Arming a loop autonomous** needs the readiness gate green (the 9-item Design Checklist) +
  an explicit operator override (loops first-class, shipped 2026-06-30, m0072).
- **Concierge is advisory** (non-steering bus), not a commander.
- **D-026** screen-before-embed/store on all memory/concept/correction content; **F-008**
  honest states / no fabricated graph nodes; **F-015** idempotent additive migrations;
  **F-013** ISO datetimes out of loads.

## 8. Status (this session, branch `v2`, unpushed)

Shipped: living-scene upgrade + camera/inspect/timeline fixes; `/agents/catalog`; agent
invocation-tracking (`session.specialist`, m0070) + propose-only recommender; DB-backed
external login gate (m0071, scrypt); loops first-class (m0072 — manifest + readiness gate);
**S3 cognitive layer (m0073)** — `concept` table + `concept_vec` HNSW 1024-dim + one typed
`concept_edge` relation (hierarchy + episodic kinds); corrections-as-memory (`memory.category`);
heartbeat-loop concept extraction with embedding-cosine dedup (`memory/concepts.ts`, `loop.ts`
`extractConcepts` seam); explorer viz (concept/causal/skill/correction scene classes +
extracted-from/hierarchy/supersedes/retrieved/grounded-on edges); **S1 feedback**
(`recordRetrievalFeedback` → `retrieval_outcome.llm_relevance`). Commits `5ae7cf6`/`fa14d6a`/
`ea6cd3f` on `v2`. NOTE: live concepts populate as the heartbeat loop mines real sessions
(the build's live-verify seeded via the production `storeConcepts` path with a FakeEmbedder —
rows/screen/dedup/edges are real, only the vector source differed; on the running app the
`Embedder` = Ollama `qwen3-embedding:0.6b`). `retrieved`/`grounded-on` edges need windowed
session→memory outcome rows (unit-tested; sparse live until traffic accrues).
**Concierge Stage-1 (D-040, `atelier_self`)** — SHIPPED event-triggered (operator chose
event-triggered over persistent, 2026-07-01). Reachable identity, NOT a 24/7 process: a
`to_kind:'atelier'` send fires `triggerConcierge` (`api/peer/send`), which spawns a short-lived
atelier_self session row (`ensureAtelierSession`), grounds on the brain (S0 — `MemoryService.recall`
global, cites `citationId`), answers the "recommend agent" query via the existing pure
`recommendAgentsForTask` scorer, replies over the bus ADVISORY/non-steering, then tears down.
Deterministic programmatic turn (no LLM spawn — recommend+recall are pure) → $0 idle, bounded,
flake-free. Wired two real placeholder gaps: **m0074** added `session.pm` (the column
`resolveAtelier` filters on didn't exist; the `pm` table can't hold a project-less atelier PM —
its `project` is required), and `loadFleetSnapshot` now SELECTs `pm` + keys `ATELIER_SELF_PM`
('pm:atelier_self') under `ATELIER_PROJECT_KEY` when a live atelier session is up. New
`concierge/{concierge,wire}.ts` + 7 tests. Commit `f8c6732` on `v2`.
**S2 learned reranker** — SHIPPED OFF-by-default (`f7bb9e3`, 2026-07-01). Deterministic
L2-logistic scorer (`memory/rerank.ts`) re-orders the heuristic candidate set before the novelty
gate; cold-start → passthrough. **m0075** added `retrieval_outcome.feat_{cosine,utility,recency}`
+ `reranker_model` weight store (additive/idempotent). Wired OFF because (1) live rows carry zero
`feat_*` yet (columns start populating now), (2) on the controlled corpus the learned order didn't
clear the tuned heuristic (fixture has no real recency/utility spread — overfits). Flips ON once
live labels accrue + eval shows reranked ≥ baseline. Corrected a false spec premise: there is NO
`query_embedding` column on `retrieval_outcome`, so a re-embedding ACAN wasn't buildable from
stored data — the linear model over recall's own features is the honest slice. 15 unit tests prove
the mechanism.
**Concierge Stage-2 — provider-aware LLM turn** — SHIPPED `8679946` (2026-07-01), live-verified on
the REAL local `gpt-oss:20b` (grounded+cited, advisory, 7.1s, one call). Intent split
(`classifyAtelierIntent`): `recommend_agent`→ unchanged deterministic Stage-1; `skill_request`/
`hire_request`→ honest gated stubs (no auto-draft/auto-hire, §7); `open_question`→ bounded LLM turn
(30s/1024-tok cap) grounded on brain (S0 recall + cite) + advisory/non-steering reply.
`resolveConciergeProvider` reads the LIVE pool + the `defaultProvider` toggle (same idiom as boot +
the benchmark judge) → the concierge is itself the always-on-LOCAL-brain candidate, and its sessions
flow through the model-benchmark (provider-tagged agent_event + optional thinking_capture +
judged-eval). D-026 screens prompt+reply; honest states on no-provider/error/empty. No migration
(reuses session/message/peer_message). **The local-vs-cloud brain experiment is now end-to-end
testable** (switch + local concierge turn + benchmark capture/judge).
**S4 — soul/identity graduation** — SHIPPED `37edafe` (2026-07-01). **Cognitive architecture
S0–S4 + explorer viz + Concierge Stage-1/2 now COMPLETE.** `memory/soul.ts` derives an HONEST
self-model — compute-on-read (no migration; pure projection, always-current): dominant concepts
(what it knows), corrections-as-values (what it learned NOT to do), causal-chain count, recall
competence (utilization rate), experience volume. `maturity_stage` ladder nascent→developing→
established, AND-gated across dimensions + an `established` competence quality-gate (≥0.85 over
≥20 outcomes) so "big but incompetent" can't graduate; cold brain → honest `nascent`, zero
fabrication (F-008). Injected (screened, bounded) into the Concierge Stage-2 open-question turn.
Real-surreal test parses the count()/ORDER BY SurrealQL (F-020 lesson). Live brain = `nascent`
today, richens as the heartbeat accrues. Deferred: soul/maturity SCENE surface (`loadSoul` is the
ready read-seam) + a graduation-history table (provenance/timeline).
**Brain view** — SHIPPED `3469791` (2026-07-01). New `/brain` route surfaces the S4 soul
(maturity_stage + summary + experience grid + competence + knows-about chips + learned values +
next-stage gates, honest cold `nascent`/disconnected states) + a **decisions** section (real
`decision` table m0023 §4.1b — `listRecentDecisions`, F-013/F-020-safe; NOT fabricated) + link
cards to the existing `/reports` (spend), `/memory` (search), `/atelier` (advisories) — reused,
not rebuilt. Design-system standard, Svelte 5 runes, live `$effect` re-invalidate.
**Soul in the living scene + F-020 hardening** — SHIPPED `491fc0b` (2026-07-01). A central
`self:atelier` scene node derived from `loadSoul` (maturity-ringed core, `knows`-edges to its
dominant concept nodes, honest-empty on a cold brain) makes S4 identity ALIVE in the graph
(`scene.ts` + `MemoryScene.svelte` + `NodeInspector.svelte`). Added the real-surreal parse test for
`buildProviderUsage` — which prompted a repo sweep that found + fixed **two more live F-020 idiom
bugs**: `briefing.ts loadUnresolved` (was SILENTLY dropping unresolved tasks from the wakeup
briefing, hidden by a best-effort catch) + `resolution.ts resolveRegauntletTarget`. See fails.md
F-020 sweep note + F-054 (CRLF gotcha).
**Concierge Stage-3 — gated skill-discovery** — SHIPPED `7f21f94` (2026-07-01), live-verified vs
real skills.sh. Replaces the Stage-2 skill_request stub with a real search→gate→propose:
read-only HTTP GET `skills.sh/api/search` (structurally no-install surface — `npx skills add` exists
NOWHERE in the code), quality-gate (`recommended` only if trusted-owner OR installs ≥1000; 100–999
`cautious`; <100 omit), D-026-screens every untrusted name/source, advisory/non-steering, honest
fallback when unreachable (no fabricated results). Opt-in `CONCIERGE_SKILL_SEARCH` env (default OFF
— security-sensitive outbound; OFF still returns a real manual-path explainer, better than the old
stub). Standing note in every proposal: installs are operator-gated + D-026/D-037-reviewed + must
be in a SYNCED catalog scope before any bundle declares them (F-045).

**Roadmap COMPLETE for the buildable queue.** Deferred / operator-gated only: graduation-history
table (soul provenance/timeline); flip `CONCIERGE_SKILL_SEARCH` on for live skill search; the first
real local-vs-cloud benchmark RUN (runbook in MODEL-BENCHMARK-SPEC.md — needs a cloud API key +
the decision to flip `defaultProvider`); real skill/hire DRAFTING (still operator-gated, §7). (LLM turn for open-ended PM questions;
skill/hire drafting over the bus, operator-gated), plus the brain "sections"
(decisions/spend/search) which fold into the concierge's dashboard.
