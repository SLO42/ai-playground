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
external login gate (m0071, scrypt); loops first-class (m0072 — manifest + readiness gate).
Building: **S3 concept graph + extraction + explorer viz (+ S1 feedback)** — the cognitive
architecture foundation. Pending: S2 reranker, S4 soul, the concierge, plus the brain
"sections" (decisions/spend/search) which fold into the concierge's dashboard.
