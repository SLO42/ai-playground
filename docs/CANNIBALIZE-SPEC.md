# CANNIBALIZE-SPEC — runtime content-ingest → the brain (BL-6)

> **DRAFT (2026-06-15, operator-requested "spec + queue + continue").** Productizes the
> dev `cannibalize` foundry (`F:\code\cannibalize`) into a first-class atelier capability:
> a UI front door that takes natural-language intent + links/content, runs capture→distill→
> screen+fence→embed→ingest into the global memory (the brain), and closes the utilization
> loop. Reference design: `F:\code\cannibalize` (capture/embed/ingest/find-relevant/
> mark-applied) + `docs/CANNIBALIZE-BRIEF.md`. Defaults are baked (§9) so build isn't
> blocked; the flagged items are tunable, not gates.

## 1. Purpose & scope

Let the atelier **grow its ecosystem** by absorbing external content (repos, URLs, docs,
pasted text) into the brain, where every project recalls it and the atelier improves itself
(PEER-MESSAGE-SPEC §11: the atelier is "the layer that ingests content into its ecosystem").
The dev foundry proved the stack (Ollama `qwen3-embedding:0.6b` 1024-dim, HNSW COSINE in
SurrealDB, `mark-applied` outcome signal); this makes it a runtime product feature, operator-
driven now and atelier-autonomous later (D-040).

## 2. Locked invariants (non-negotiable)

1. **Untrusted-by-default.** External content is UNTRUSTED. Every captured chunk passes
   `screen()` (D-026 secret/PII) THEN `fence()` (MEMORY-SPEC §10 DATA envelope) before it
   reaches the brain. An ingested doc/repo can NEVER act as instructions — same fence as
   recalled memory. Ingested knowledge is recalled as DATA, never steers a session.
2. **Provenance always.** Every ingested finding records its SOURCE (url/repo/path/commit),
   `ingested_at`, and a **license/consent** field (the foundry/AGENTS.md discipline: ideas
   are adoptable; lifting *code* needs consent — kongcode rule). No anonymous knowledge.
3. **Capability-gated.** Ingest is an atelier/operator capability (D-036, fail-closed) —
   not something any project session can trigger.
4. **The brain is MEMORY-SPEC.** Ingest WRITES through the existing memory store/embed/
   screen/fence pipeline — it does not create a parallel datastore. Recall is unchanged.
5. **Bounded (F-014/D-024).** Fetch size/time bounded, loopback/SSRF-safe fetch, no spin.

## 3. Architecture — reuse

| Need | Reuse |
|---|---|
| Store / embed / recall | the memory engine (MEMORY-SPEC: store, index, recall, the qwen3 embedder) |
| Screen + fence | `memory/screen.ts` + `memory/fence.ts` (already the untrusted-data boundary) |
| Fetch URLs | the WebFetch path (bounded, redirect-safe) |
| Clone/read a repo | git read under `CODE_ROOT` confinement (D-018) |
| Distill/extract | an LLM extraction pass (candidate: the §7b `researcher` role, or a dedicated extractor) — the foundry's distill step |
| Outcome/utilization | the memory outcome plumbing (the `mark-applied` signal CANNIBALIZE-BRIEF §1 calls v2's winning move) |

## 4. Pipeline (mirrors the foundry)

`capture` (fetch URL / read repo / take pasted text — bounded, SSRF-safe) → `distill`
(LLM extraction → discrete findings/patterns, each with a candidate provenance) → `screen`
(D-026) → `fence` (§10 DATA) → `embed` (qwen3, 1024-dim) → `ingest` (memory rows + provenance
+ license) → **`utilization loop`** (when a recalled ingested finding later contributes to a
good outcome, mark it applied → feeds BOTH recall ranking AND the curator's keep/prune — the
loop hermes/mem0/kongcode under-use). Each stage emits honest progress to the UI.

## 5. UI front door

A page/panel (label TBD — "Ingest" / "Grow" / "Cannibalize"): a **natural-language intent**
box + **inputs** (one or more URLs, a repo path/URL, file upload, or pasted text) → "Ingest"
→ live progress through the stages (capture→distill→screen→embed→ingest) → results: the
findings ingested, each with provenance + license + a link to recall. Later: utilization
stats per source ("this source's findings have helped N times"). Honest states throughout
(F-008). Reachable from the sidebar (KNOWLEDGE & SYSTEM cluster, near Memory) or as a Memory
sub-action — TBD §9.

## 6. Data model (proposed)

Extend the memory write path with provenance, plus a source-tracking table:
```
DEFINE TABLE ingest_source SCHEMAFULL;          -- one row per ingest run / source
  kind        string ASSERT IN [url,repo,file,text]
  ref         string                              -- the url / repo / path (NOT secret)
  intent      string                              -- the operator's NL intent (screened)
  license     option<string>                      -- declared/derived; consent for code-lifting
  status      string ASSERT IN [capturing,distilling,ingesting,done,failed,quarantined]
  finding_count int DEFAULT 0
  created_at / completed_at datetime
-- each ingested finding = a memory row (existing pipeline) carrying:
--   provenance = ingest_source id, applied_count int (utilization), last_applied_at
```

## 7. Security

Untrusted ingest: `screen` (secrets/PII redact/quarantine) + `fence` (DATA, un-escapable,
`stripEmbeddedSentinels`) before the brain; a quarantined chunk is NOT ingested (honest).
SSRF-safe fetch (no internal/metadata endpoints; size+time bound). License/consent recorded;
a code-lift without consent is flagged, not silently absorbed. Provenance on every row so a
bad source can be traced + purged. Capability-gated; autonomous ingest (D-040) stays
operator-gated until self-hosting composes.

## 8. Driven by

v1: **operator via the UI**. Later (D-040): the **atelier autonomously** ingests as it
discovers relevant content (e.g. Create-with-AI pre-scaffold surveys, the researcher role's
findings) — still screened/fenced/provenanced, capability-gated.

## 9. Open decisions (baked default — tunable, NOT a build gate)

- **D1 v1 sources:** URL + pasted text + repo · or URL + text only? — *default: URL + text + repo (repo read-only under CODE_ROOT).*
- **D2 distiller:** the §7b `researcher` role · a dedicated extractor · a plain extraction prompt? — *default: a plain bounded extraction pass now; swap to the researcher role when §7b lands.*
- **D3 utilization wiring:** reuse the memory outcome plumbing · new signal? — *default: reuse/extend the memory outcome path; `applied_count` on the finding.*
- **D4 storage:** extend memory rows + `ingest_source` table · separate store? — *default: memory rows + `ingest_source` (NO parallel datastore — invariant §2.4).*
- **D5 front-door placement:** sidebar item · Memory sub-action? — *default: a sidebar item in KNOWLEDGE & SYSTEM (it's a first-class atelier capability).*
- **D6 autonomous ingest:** v1 operator-only · atelier-auto? — *default: operator-only v1; atelier-auto deferred to D-040.*

## 10. Build decomposition (once chained)

1. `ingest_source` table + idempotent additive migration; provenance + `applied_count` on the memory write path.
2. The capture layer: bounded SSRF-safe URL fetch · repo read (CODE_ROOT-confined) · text/file intake.
3. The distill→screen→fence→embed→ingest pipeline (reuse memory store/screen/fence/embed), per-finding provenance + license.
4. The UI front door (NL intent + inputs + live stage progress + results), Svelte 5 + tokens + a11y, honest states; sidebar entry.
5. The utilization loop: `mark-applied` on recall outcome → ranking + curator keep/prune.
6. Red-team: an ingested doc must never steer; fence un-escapable; SSRF blocked; secrets screened; provenance un-forgeable; bounds hold.
