# HEADROOM — cannibalize digest (BL-H1, 2026-06-26)

> **What this is.** The v2-facing slice of the cannibalize-foundry digest of
> **headroom** (github.com/chopratejas/headroom, pinned commit `9362747`,
> **Apache-2.0** — liftable). Research INPUT, not a v2 doc — fold the relevant parts
> per the map below, keep the provenance. Mandate: **LEARN the compression approach,
> not adopt.** Full knowledge graph lives in the foundry (`F:\code\cannibalize`,
> source `headroom` = `studied`; 13 findings + 1 playbook + 1 decision + 4 questions).
> D-026 pre-screen of the clone: **clean** — every secrets-heuristic flag was a
> placeholder (`.env.example` = `CHANGEME`), a token-*reader* (`copilot_linux_secret.py`),
> or AWS's public example key `AKIAIOSFODNN7EXAMPLE` / dotenv README samples.

## Fold-into map
| Part | → target |
|------|----------|
| Mechanism + integration modes (§1–2) | `ARCHITECTURE.md` (a context-compression note) |
| BL-H2 spike decision (§4) | `DECISIONS.md` candidate (adopt/no-adopt after the spike) |
| D-002 / D-026 / containment rails (§3) | the BL-H2 spike's rails (already in BUILD-QUEUE BL-H2) |
| Open questions (§5) | what the BL-H2 measurement must answer |

---

## 1. Mechanism (the real answer, not the marketing)
Headroom compresses the **prompt you send** — specifically **content blocks inside the
latest user message only**. It does NOT drop/summarize whole messages (that machinery
was retired, Phase B PR-B1). **Lossy on the wire, lossless end-to-end.**

- **Live-zone-only** (`crates/headroom-core/src/transforms/live_zone.rs`): the mutable
  region is bounded below by a **cache floor** (`frozen_message_count`, derived from
  `cache_control` markers) and above by the latest user message; the latest assistant
  message is never touched. Everything below the floor stays byte-identical so the
  **provider prompt cache still hits** — the load-bearing design idea.
- **ContentRouter → specialized compressors** per block type: **SmartCrusher** (JSON
  arrays — statistical row-drop), **LogCompressor** (build/test output, keep
  errors/summaries/stack traces, 10–50×), **SearchCompressor** (grep), **DiffCompressor**
  (git diffs), **CodeCompressor** (AST), **Kompress** (prose, a HuggingFace ML model).
  **Crucial caveat:** in the Rust live-zone path **SourceCode/PlainText/Html blocks are
  NO-OP** — only structured tool outputs actually get crushed.
- **SmartCrusher** (`smart_crusher/analyzer.rs`): per-field stats → classify array
  (time_series/logs/search_results/generic) → **sample** (drop redundant/middle rows,
  always preserve "anchors": query-matching rows, rare errors, distinct IDs/UUIDs,
  head/tail). Lossy, capped by a per-mode `max_lossy_ratio`.
- **CCR — reversibility** (`crates/headroom-core/src/ccr/mod.rs`): on any drop the
  **original payload is stashed locally**, keyed by a BLAKE3 24-hex hash, with a
  `<<ccr:HASH>>` marker injected; the model calls a `headroom_retrieve` tool to pull the
  original back. Backends: in-memory / **SQLite (prod default, ON DISK)** / Redis.
  **Default TTL 30 min** — after expiry, lossless silently degrades to lossy.
- **Safety gates**: tokenizer-validation (if `compressed.tokens >= original.tokens` →
  fall back; never expand); **tag_protector** (swaps custom workflow XML like
  `<system-reminder>`/`<thinking>` for placeholders before ML compression, restores
  after); byte-fidelity invariant (bytes outside the rewritten block round-trip
  byte-equal, CI SHA-256 pinned); tool-pair atomicity (a `tool_use` + its `tool_result`
  compress together or not at all, else provider 400s).
- **Output-token reduction** (separate, proxy-side): verbosity steering (terse note at
  the END of the system prompt, cache-preserving) + effort routing (dials thinking down
  on routine post-tool turns). Savings are **counterfactual/ESTIMATED** unless you run a
  10% holdout (`HEADROOM_OUTPUT_HOLDOUT=0.1`).

## 2. Integration modes
- **Library** — `compress(messages)` Python/TS inline (SDK wrappers: `withHeadroom`,
  Vercel middleware, LiteLLM, LangChain). Most control, code change required.
- **Proxy** — `headroom proxy --port 8787`; point `ANTHROPIC_BASE_URL` at it, zero code
  change. Full live-zone dispatcher for Anthropic `/v1/messages` (OpenAI/Gemini/Bedrock
  walkers are Phase C). **This is the BL-H2 spike vehicle.**
- **MCP** — `headroom_compress` / `headroom_retrieve` / `headroom_stats` tools.
- ❌ **`headroom wrap`** — installs a global `~/.rtk` shim and EDITS AGENTS.md/CLAUDE.md.
  Not a containment fit. **Avoid.**

## 3. v2 fit (D-002 / D-026 / containment)
- **D-002 (isolated config / determinism):** the proxy is network-level, **orthogonal**
  to the isolated `CLAUDE_CONFIG_DIR`/`--settings` — doesn't touch the config. BUT
  compression output is **non-deterministic** (varies with CCR/TTL/verbosity-learn
  state) and the output-shaper mutates the system prompt + thinking effort →
  reproducibility risk. Run **proxy-only, shaping disabled or pinned; never `wrap`,
  never `learn`.**
- **D-026 (caches + rewrites tool outputs):** CCR writes **raw, unredacted original tool
  outputs to on-disk SQLite/Redis** with **NO secret detection** in the path (their
  security keyword set feeds relevance only, and they dropped `token`). SECURITY.md's
  "no credential storage" covers API keys/headers, NOT tool-output bodies. Must sit
  **behind v2's screen/fence**: loopback bind, ephemeral secret-safe store path, short
  TTL, secrets pre-screened before the proxy.
- **Containment:** third-party Rust proxy carrying our API key + full traffic → vendor +
  pin commit, loopback-only, no telemetry egress, own scratch dir, **kill after session.**

## 4. Adopt recommendation seed (→ BL-H2 decision)
**Lean: a full-but-CONTAINED proxy spike** over ONE driven code-write session, measured
with a holdout — the mechanism is sound and measurement is the only honest read on our
mix. If the measured cut is modest (**likely, since source-code is no-op**), fall back to
**idea-only**: a v2-native, secret-fenced, deterministic live-zone crusher for *tool
outputs* (the part that actually wins). **Adopt the compression ONLY — never
`headroom learn` / cross-agent memory** (v2 already has error-learning + skill-harvest +
the memory spec).

## 5. Open questions the BL-H2 measurement must answer
1. Does proxying break the isolated-config/determinism (D-002)?
2. Real token cut on OUR code-write traffic vs headroom's tool-output-dominated
   benchmarks? (Headlines: code-search 92%, SRE-debug 92%, GitHub-triage 73%,
   **codebase-exploration 47%** — all tool-output-heavy; accuracy benches are
   single-shot QA/math/tool-call, NOT multi-turn agentic coding.)
3. CCR secret-safety — can we guarantee no raw secret hits its on-disk cache (D-026)?
4. Containment blast-radius of a third-party proxy over our LLM traffic.

---

*Generated from the cannibalize foundry, 2026-06-26. Deeper:
`F:\code\cannibalize\scripts\find-relevant.ps1 -Keywords compression,headroom -Hydrate`.*
