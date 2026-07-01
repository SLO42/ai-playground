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

### C. Capture gap — NEW, screened before store (D-026)
- **Thinking context** — what the model says WHILE thinking, and how it affects
  progress/work. Almost certainly NOT persisted today (Claude CLI emits thinking
  blocks; `agent_event` has no thinking field per the seam scout). To judge B's
  "thinking consistency" + this, thinking text must be recorded per session, SCREENED
  (D-026 quarantine) before store, opt-in (privacy + volume). Confirm exact capture
  point in `claude-code/cli-backend.ts` stream handling at build.

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
3. **Thinking capture** (class C) — screened, opt-in recording of thinking text.
4. **Judged eval** (class B) — LLM-judge rubric over transcript+thinking, structured
   verdicts, surfaced in the comparison report.

## Gotchas (from the seam scout)
- Ollama can't speak the Claude CLI protocol (isolated-config / gate-hook /
  interject-resume) — the `OllamaRuntime` has NO tool-gate/interject parity. That
  capability delta is itself part of what the benchmark reveals, and the main risk.
- `OllamaProvider` rejects any `/v1` suffix (D-003); host normalization parity (F-021).
- Local `gpt-oss:20b`: far smaller context window + weaker tool-use than opus — the
  benchmark exists precisely to quantify whether that matters for brain/worker tasks.
- Boot-read config staleness (F-029) — surface true running state, never assume a
  file toggle took effect live.
