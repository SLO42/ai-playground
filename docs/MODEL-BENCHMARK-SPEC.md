# Model Benchmark Spec — local (free) vs cloud, as Atelier's brain/worker

**Purpose (operator, 2026-07-01):** measure whether a LOCAL model (Ollama, free) is
good enough to be Atelier's always-on brain/worker vs a CLOUD model (opus-4-8 /
sonnet). The switch is not useful without a *measured* answer
([[project_local-model-brain-hypothesis]]). This spec is the measurement contract.

Sequenced AFTER the model-switch runtime seam (make the existing `local` routing-tier
floor actually execute; today `cli-backend.ts:539` is hardcoded to the `claude` .exe,
no branch on `plan.model.provider` — that gap is the switch). Benchmark layers on top.

## Metric taxonomy (three classes by data source)

### A. Objective — already lands per session, query existing rows (no new capture)
Source: `agent_event` (`analytics/events.ts` — `model:{provider,model_id,tier}`,
`tokens_in`, `tokens_out`, `cost_usd`, `duration_ms`, `session`, `project`,
`parent_event_id`), `routing_event`, `peer_message`.
- **Tool usages** — count + breakdown by tool per session. (CONFIRM at build: whether
  a per-tool event/kind is emitted, or tool calls must be derived from the transcript.)
- **Agent spawns** — count of child sessions the model spawns (`parent_event_id` /
  session parent chains).
- **Inter-hire communication** — volume of `peer_message` rows to/from the session
  (session ↔ PM/dev/other hires). Bus already records every message.
- **Time between actions** — deltas between consecutive `agent_event` timestamps for
  the session (cadence; local latency vs cloud).
- **Cost / tokens / latency** — `cost_usd` (local = $0), `tokens_in/out`, `duration_ms`.
- **A/B rollup** — `GROUP BY model.provider` (or tier) over `agent_event`. Report view
  under `src/routes/reports`; aggregation `analytics/rollup.ts`/`fleet.ts`.

### B. Judged — LLM-judge over the session transcript (reuse `memory/eval/harness.ts` idiom)
A judge model scores each session on a rubric; store structured verdicts (honest,
F-008 — no fabricated scores; cold/empty is a valid state).
- **Confidence** — does the model express calibrated confidence? over/under-confident
  vs outcome.
- **Reasoning quality** — coherence, depth, whether steps follow.
- **Fact-checking** — did it verify claims (Read/Grep/tool before asserting) or
  assert blind? (part objective — tool-before-claim — part judged.)
- **Thinking consistency** — does its stated intent stay consistent across the session,
  or drift/contradict?

### C. Capture gap — SHIPPED `3c35c4f` (m0076), premise corrected
- **Thinking context** — what the model says WHILE thinking. CORRECTION (scout, Step 2):
  thinking IS already persisted today — the Claude CLI `stream-json` emits `thinking`
  content blocks → mapped to a first-class `RuntimeEvent{type:'thinking'}`
  (`cli-backend.ts mapCliEvent`) → screened (D-026) + written to `message` as
  `kind='thinking'` by `launch.ts eventToMessage` (unconditional, serves transcript
  replay). The real gap was an OPT-IN, PROVIDER-TAGGED corpus decoupled from the
  always-on transcript (the privacy+volume concern). Built as **m0076 thinking_capture**
  (session, seq, provider, model_id, content, captured_at), opt-in `captureThinking` flag
  in `orchestration.yaml` (default OFF), reusing the ALREADY-screened `message.content`
  (never re-raw). Ollama `gpt-oss:20b` emits NO thinking → honest zero rows (F-008), not
  fabricated. Step 3 judged-eval consumes either `thinking_capture` (provider-grouped) or
  the always-on `message kind='thinking'` rows.

## Build sequence (foundation → measurement)
1. **Switch seam** (foundation) — SHIPPED `6e1677b` (2026-07-01), live-verified vs real
   Ollama `gpt-oss:20b`. `OllamaBackend` (`claude-code/ollama-backend.ts`) wraps
   `OllamaProvider.stream()` → `RuntimeEvent`; OPT-IN branch in `ClaudeCodeRuntime.spawn`
   (engages only when a local backend is wired, else falls through to the default backend
   byte-identical — no-regression; F-053). Global `defaultProvider: auto|local|cloud`
   toggle in `orchestration.yaml`, `/settings` Routing panel validate→diff→confirm +
   restart-needed banner (F-029); `bootRoute` maps it to a pool-derived override. Objective
   A/B view `buildProviderUsage` (GROUP BY provider) on `/reports`. Honest Stage-1
   capability boundary: OllamaBackend `supportsInterject/supportsResume=false`, single chat
   turn, NO tool-gate/interject parity (the delta the benchmark measures). Enum NOT widened
   — no speculative `sonnet-5` id; `cloud` reads the pool's sonnet/first-non-ollama tier
   live. ("sonnet 5" reconcile = separate `agent-pool.yaml`+`MODEL_IDS` change if wanted.)
2. **Objective benchmark view** (class A) — `GROUP BY provider` report; derive
   tool/spawn/comm/cadence per session from existing rows.
3. **Thinking capture** (class C) — SHIPPED `3c35c4f` (m0076 thinking_capture, opt-in,
   screened, Ollama honest-empty). Premise corrected: thinking was already screened+stored
   in `message kind='thinking'`; the gap was the opt-in provider-tagged corpus.
4. **Judged eval** (class B) — SHIPPED `a5b75d5` (2026-07-01). LLM-judge (`analytics/benchmark/`)
   scores confidence / reasoning / fact-check / thinking-consistency; **m0077 benchmark_verdict**
   store. On-demand only (a `/reports` form action, NOT the heartbeat), one cloud call per session,
   batch hard-capped 20; judge = cloud model read live from the pool (never the local model under
   test); cold corpus → no model call; every empty dimension → honest `insufficient_data` (score
   null), even if the model hallucinates a number (overridden locally). **Fact-check = HYBRID**:
   objective `toolBeforeClaimRatio` (from `message` seq order) + the judge weighs it. **Confidence
   = calibrated** against `session.status` terminal outcome. DELETE-then-CREATE persist (avoids the
   F-048 dedup class); `isoOrNull` on load (F-013). 20 unit tests; full gather→judge→store→compare
   exercised vs real throwaway surreal (stub judge).

**FEATURE COMPLETE + LIVE-VERIFIED** (switch + all 3 measurement classes). Consolidated
live-verify PASS (2026-07-01): `db:up` on the LIVE dev DB applied m0076/m0077 (m0074/m0075 were
already live) → **77/77, idempotent re-run clean** (F-015); render-smoke of `/reports` (objective
provider A/B + judged honest-empty), `/settings` (model toggle), `/agents/catalog`, `/loops`,
`/memory` — all honest, no 500/undefined/fabricated (F-008). The live pass CAUGHT A REAL DEFECT
the whole suite missed: `provider-usage.ts` `ORDER BY at` without `at` in SELECT → parse error →
false-DISCONNECTED `/reports` (F-020 recurrence, fixed `8905482`). Root gap = `stubDb()` unit
tests never parse SurrealQL (see F-020 recurrence note — escalated: hand-written queries need a
live/parse-level test; a consolidated live-verify is mandatory at feature end-gate). The switch
(Step 1) live-verified vs real Ollama `gpt-oss:20b`; the judged-eval real cloud smoke additionally
needs a cloud API key (not assumed) — deferred until a benchmark run is actually wanted.

## ▶ RUNNING THE EXPERIMENT (deferred — operator, do later)
The harness is COMPLETE + live-verified but UNPOPULATED. To get the first real local-vs-cloud
brain numbers, run this (needs a cloud API key for the judged half — not assumed):
1. **Local model up** — Ollama at `127.0.0.1:11434` with `gpt-oss:20b` pulled (probe `/api/tags`).
2. **Flip to local** — `/settings` Routing panel → `defaultProvider: local` (or `orchestration.yaml`);
   RESTART the dev server (boot-read config — the restart-needed banner tells you; F-029).
3. **Accrue local sessions** — drive real work (concierge open-question turns via a `to_kind:'atelier'`
   peer message; any orchestrated sessions). Optionally set `captureThinking: true` for the thinking corpus.
   Rows land in `agent_event` tagged `provider=ollama`.
4. **Cloud baseline** — flip `defaultProvider: cloud`, restart, drive equivalent work → `provider=claude` rows.
5. **Judge** — set `ANTHROPIC_API_KEY` in `.env`; `/reports` → "Run judge" action (batch ≤20) over both
   providers' sessions. Cold corpus / no key → honest no-op (no fabrication).
6. **Read** — `/reports`: objective A/B (`buildProviderUsage` — tokens/cost[$0 local]/latency/spawns) +
   judged quality (confidence/reasoning/fact-check/thinking-consistency per provider). Decision output:
   is local good enough for the always-on brain? If yes → graduate the concierge to persistent-local.
Honest caveat: OllamaBackend has NO tool-gate/interject parity (Stage-1 single-chat turn) — the objective
"tool usages / agent spawns / comms" metrics will read low/zero for local on complex tasks BY DESIGN;
that capability delta IS a finding, not a bug.

## Follow-up hardening (deferred, tracked)
- Add a live-DB or parse-level test for `buildProviderUsage` (+ audit other hand-written SurrealQL
  with ORDER BY/GROUP BY for the same F-020 idiom gap). The `stubDb()` pattern gives false green.
- Run the real cloud judged-eval smoke once a cloud key is available → get the FIRST actual
  local-vs-cloud quality numbers (the whole point). Until then the harness is proven, unpopulated.

## Gotchas (from the seam scout)
- Ollama can't speak the Claude CLI protocol (isolated-config / gate-hook /
  interject-resume) — the `OllamaRuntime` has NO tool-gate/interject parity. That
  capability delta is itself part of what the benchmark reveals, and the main risk.
- `OllamaProvider` rejects any `/v1` suffix (D-003); host normalization parity (F-021).
- Local `gpt-oss:20b`: far smaller context window + weaker tool-use than opus — the
  benchmark exists precisely to quantify whether that matters for brain/worker tasks.
- Boot-read config staleness (F-029) — surface true running state, never assume a
  file toggle took effect live.
