# Phase 0 — Spike Results (S0 + S1)

Run 2026-06-07 on the operator's Windows box (Node v24.15, Win 11). Throwaway proofs per IMPLEMENTATION-PLAN §3. **Both spikes gate the build.**

Env: SurrealDB **2.6.5** (pinned 2.x server binary, sha256 `DD9B6FA15EDACBDE96D490DD5727B49B5CF40DF80F29074C7DC17ACB974F509F`, surrealkv backend, loopback) · `surrealdb` JS SDK **2.0.3** · Ollama **qwen3-embedding:0.6b** (1024-dim) + gpt-oss:20b · `@anthropic-ai/claude-agent-sdk` **0.1.77** · `claude` CLI 2.1.168.

---

## S0 — SurrealDB  ✅ **8/8 PASS**

| Check | Result |
|-------|--------|
| ws:// connect + signin + `use` (SDK 2.0.3 ↔ server 2.6.5) | ✅ |
| Ollama `qwen3-embedding:0.6b` embeddings **= 1024-dim** | ✅ |
| HNSW index `DIMENSION 1024 DIST COSINE TYPE F32 EFC 150 M 12` (**no M0**) | ✅ defines cleanly |
| insert rows + `<\|2,40\|>` KNN returns correct semantic nearest-neighbour | ✅ |
| transaction `BEGIN … CANCEL` **rolls back** (count unchanged) | ✅ |
| optimistic claim-token: **exactly 1 winner of 8 concurrent racers** | ✅ |

**Resolves / confirms:**
- **D-014 → `qwen3-embedding:0.6b`** (already pulled, 1024-dim, 639 MB) is the embedding model. bge-m3 not needed.
- **D-006** server-binary path works on Windows (no native addon).
- The **surrealkv isolation + claim-token atomicity** that DATA-MODEL §5/§8 + MEMORY-SPEC §6.6 flagged *unverified* → **proven race-safe** (single-winner). D-021 queue is safe.
- The audit's HNSW `M0`-is-invalid fix is correct — index defines without `M0`.

**Finding (version):** the official Windows install script grabs **latest = SurrealDB 3.x** (3.1.3). We target **2.x** (D-009; SDK is 2.x). → **pin the 2.x server binary** (provisioned 2.6.5 into `bin/`, gitignored). 3.x is a future migration (FTS `SEARCH ANALYZER`→`FULLTEXT ANALYZER` already flagged in DATA-MODEL).

---

## S1 — Claude Code runtime  ⚠️ **runtime PROVEN + 1 critical finding**

| Check | Result |
|-------|--------|
| 2 **concurrent** runs both complete, no hang (the v1 bug) | ✅ **25s, no hang** |
| **Agent SDK** `query()` runs headless + streams, clean output (`SDKOK`) | ✅ |
| CLI `-p … --output-format stream-json` streams `system/assistant/result` | ✅ (streamed) |
| CLI yields a `session_id` | ✅ |
| CLI `--resume <id>` continues the session | ✅ mechanically |
| CLI output is deterministic / follows the prompt | ❌ **polluted** (see finding) |

**🔑 THE FINDING — config isolation:** the spawned **`claude` CLI inherited the operator's GLOBAL Claude Code config** (caveman plugin, kongcode hooks, claude-peers, the routing `UserPromptSubmit` hook). Result: agents replied in caveman style ("Caveman mode", "Need context"), and injected hook turns blew `--max-turns 1`. The **Agent SDK run was clean** (`SDKOK`) — it did not inherit the interactive plugins the same way.

**Implications for D-002 (SDK/CLI split):**
1. **SDK is the primary runtime** for headless/programmatic agent work + workflows — clean, deterministic, no inherited personal config. (Confirms the MEMORY-SPEC/plan lean.)
2. If the **CLI** is used (interactive parity: interject/resume), v2 **must spawn it with an isolated config** — a dedicated `CLAUDE_CONFIG_DIR` / `--settings` with **no inherited operator plugins/hooks** — so driven agents are deterministic and the harness's OWN hooks (D-019) are the only ones active. This is now a build requirement, not optional.
3. Concurrency is safe — the v1 hang does not reproduce.

**Build-time TODO (carry into v0.1 1.4):** the Claude Code `AgentRuntime` impl provisions a clean per-run config (isolated settings dir, explicit model, explicit allowed-tools, the harness's gate/hook set only) for every spawned session — SDK and CLI alike.

---

## Verdict

**Phase 0 spikes PASS.** SurrealDB (S0) is fully de-risked; the runtime (S1) works and is concurrency-safe, with one actionable finding (config isolation) that sharpens D-002 toward the SDK + mandates isolated spawn config. **No fallback triggered.** Cleared to proceed to the foundational scaffold + v0.1.
