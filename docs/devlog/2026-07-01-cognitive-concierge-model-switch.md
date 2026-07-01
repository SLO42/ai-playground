# 2026-07-01 — Cognitive architecture + Concierge + model-switch/benchmark

**Branch:** `v2` (worktree `F:\code\ai-playground-v2`), code head `de08c8f`. Docs on `v2-main`. All features gate-green (lint 0 · svelte-check 0 ·
targeted vitest · build) and pushed. One builder per worktree (F-052).

## Theme
Built Atelier's cognitive layer end-to-end and turned the Concierge from a reserved
placeholder into a genuinely-consulted apex advisor, plus a full local-vs-cloud model
switch + behavioral benchmark. Autonomous chain, scout→build→verify→commit per feature.

## Shipped (15 features, `v2` `275a824..2af6e45`)

### Cognitive architecture (S0–S4 complete)
| feature | commit | notes |
|---|---|---|
| S2 learned reranker | `f7bb9e3` | OFF-by-default — honest: no live labels yet; flips on when labels accrue + eval clears baseline |
| S4 soul/identity | `37edafe` | compute-on-read self-model + maturity ladder (nascent→developing→established) with competence quality-gate |
| `/brain` view | `3469791` | soul + real `decision` table + section links (reuse, not rebuild) |
| soul self-node in living scene | `491fc0b` | central `self:atelier` node, maturity-ringed, `knows`-edges to concepts |
| soul graduation-history | `2af6e45` | m0078, **subject-keyed** (PM souls extend additively); recorder in orchestrator drain, fail-open, per-subject dedup |
| per-PM souls | `0854109` | project-scoped soul derivation (readers parameterized; causal/outcome via session.project link) + per-PM graduation (`subject="project:<id>"`) + `PmSoulPanel`; scope-isolation tested; no migration |

### Concierge (apex — Stages 1→3 + consultation)
| feature | commit | notes |
|---|---|---|
| Stage-1 (event-triggered) | `f8c6732` | deterministic agent-rec over the peer bus; $0 idle |
| Stage-2 (provider-aware LLM turn) | `8679946` | open-ended questions, grounded+advisory; **live-verified on local `gpt-oss:20b`** |
| Stage-3 (gated skill-discovery) | `7f21f94` | read-only skills.sh search, quality-gated, no-install (structural); opt-in `CONCIERGE_SKILL_SEARCH` OFF |
| affordance honesty fix | `75a715f` | pm/atelier were falsely "unreachable" post-Stage-1 |
| Path A — PM chat consults | `f8e5730` | peer-send (all peers) + when-to-consult guidance |
| Path B — autonomous review consults | `4226787` | fire-and-forget consult on novel specialist-need; durable PM peer-identity mailbox session; deduped, non-steering, fail-open |

### Loops first-class UI (post-arc, directed by the loop-engineering adoption)
| feature | commit | notes |
|---|---|---|
| per-loop detail page + shape-visual | `de08c8f` | `/loops/[identifier]` (encoded key); loop-shape visual (6 primitives goal→trigger→action→check→state→handoff + L1→L2→L3 ladder, honest from readiness — satisfied only when the readiness item is checked); deep review (200-run history + override/timestamps/checklist); wired the 2 unwired controls (phase promote/demote, `enabled` toggle, lightweight no-restart); arming keeps its gate; honest 404; card link-in. Pure shape-core + real-surreal route tests; no migration |

| per-project Loops tab (LP-3) | `4a9a7fb` | scoped LoopList + manifest layer + declared-only section + composed actions on the project route; **closed a real gate-bypass** — the project route's `pmAutonomous` ARM (incl. Overview "Run autonomously to release") skipped the readiness gate; now `armAutonomousLoop`-gated (green-or-override, disarm ungated); live-verified (deep-link + checklist tick 0/9→1/9) |
| concierge advisories surfaced | `6f98bd3` | project PM tab (pending→answered lifecycle) + `/brain` cross-project Advisories; Path-B mailbox pairing (FIFO contract — `reply_to` column noted as TODO for exact pairing); Path-A chat replies were already transcript-visible; live-verified on seeded throwaway DB |

### Local-vs-cloud model experiment (fully wired, unpopulated)
| feature | commit | notes |
|---|---|---|
| model-switch: Ollama runtime + toggle + A/B view | `6e1677b` | opt-in provider branch (F-053); `defaultProvider auto\|local\|cloud`; objective A/B on `/reports` |
| benchmark thinking-capture | `3c35c4f` | m0076, opt-in, screened, Ollama honest-empty |
| benchmark judged LLM-eval | `a5b75d5` | m0077, confidence/reasoning/fact-check/thinking-consistency; on-demand, cloud-judge, batch-capped |
| provider-usage ORDER BY fix | `8905482` | found by consolidated live-verify (F-020 recurrence) |

## Migrations
m0074 session.pm · m0075 reranker feat_* + reranker_model · m0076 thinking_capture ·
m0077 benchmark_verdict · m0078 soul_graduation (subject-keyed).
**Consolidated live-verify: `db:up` 77/77 on the live dev DB, idempotent re-run clean.**

## Decisions made
- Concierge presence = **event-triggered** (not persistent) — local model may later justify persistent.
- Peer scope = **all peers** (full mesh — hire-to-hire conversations).
- Consult origin = **both** agentic chat + autonomous review.
- **PMs get souls too** (not just Atelier) — project-scoped derivation; graduation table subject-keyed for it. (Build in flight.)

## Bugs caught / fails logged
- Consolidated live-verify caught a false-DISCONNECTED `/reports` (`8905482`).
- The F-020 parse-test **sweep found 2 more live bugs** — incl. the wakeup briefing
  (`loadUnresolved`) **silently dropping every unresolved task**, hidden by a best-effort catch.
- fails.md: **F-053** (a runtime provider-branch must be additive/opt-in, not fail-closed) ·
  **F-020 recurrence + escalation** (`stubDb()` never parses SurrealQL → hand-written queries
  need a real-surreal/parse test; a consolidated live-verify is mandatory at feature end-gate) ·
  **F-054** (the Edit tool flips LF→CRLF on this Windows worktree → breaks source-text tests).

## Docs / memory
`docs/COGNITIVE-ARCHITECTURE.md` (canonical spec + running status) ·
`docs/MODEL-BENCHMARK-SPEC.md` (+ the deferred experiment runbook) · `docs/fails.md` ·
memory: local-brain hypothesis, find-skills reference, concierge-shipped. Started this devlog.
New repo `SLO42/obs-stuff-and-things` created (operator request, unrelated).

## End-gate — consolidated live-verify (PASS)
Whole stretch verified live on the real dev DB: **`db:up` applied m0078 → 78/78, idempotent
re-run clean** (F-015). Render-smoke (bounded, killed): `/brain` (soul nascent — 3 concepts / 1
correction / 1 causal / 143 sessions; graduation timeline honest-empty; 2 real decisions), living
scene (324 nodes / 85 edges), project PM-tab `PmSoulPanel` (honest nascent), `/reports` (honest-
empty A/B + judged), `/settings`, `/agents/catalog` (113 agents), `/loops` — all HTTP 200, honest
states, no 500/undefined/fabricated. Clean (no new bugs). Minor gap found + fixed: `?tab=pm` didn't
deep-link (project tab was client `$state` ignoring the search param) → `23db06e` (TABS as-const +
validated deep-link init).

## Parked / next
- **Needs operator:** run the real local-vs-cloud benchmark (needs `ANTHROPIC_API_KEY` + flip
  `defaultProvider→local`; runbook in MODEL-BENCHMARK-SPEC.md) · flip `CONCIERGE_SKILL_SEARCH` on ·
  the ROUNDS CardDrawControl MP client log (host log was clean; drop is client-side).
- **Gated by design:** real skill/hire drafting (§7 — operator approves).
