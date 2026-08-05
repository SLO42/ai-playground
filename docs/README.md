# ai-playground v2 — Planning Docs

Working title: **ai-playground v2** (final name TBD — see D-000 in the live ledger, `F:\code\ai-playground\docs\DECISIONS.md`).

A ground-up, **lighter** rebuild of the ai-playground project-lifecycle platform — which is **also a Claude Code harness**. Same product idea (create, develop, maintain, release software projects with AI agents) but simplified: one unified datastore (SurrealDB), **Claude Code as the agent runtime + config control surface + session fleet + workflow runner**, and a configurable (not always-on) orchestrator.

**Two pillars:** (1) project lifecycle platform — decides *what* work to do; (2) Claude Code harness — *how* it gets done and how you control it. See [PRODUCT.md §1a](./PRODUCT.md).

> ## ⚠ This directory is a frozen snapshot, not the current docs
>
> These were the **planning documents** written before the build, and they are kept at
> that moment in time. **The system described here as future work is built.** Read this
> set for original intent and rationale — never as a description of what exists today, and
> never as the current contract.
>
> **The authoritative, current doc set lives in the docs checkout:**
> **`F:\code\ai-playground\docs\`** (branch `v2-main`) — the decisions ledger
> (D-000..D-042), every `*-SPEC.md`, the build queue, and the devlog.
>
> That is also where a `docs/<NAME>-SPEC.md` cited by a source comment in this worktree
> resolves — e.g. `docs/GAME-VERIFY-SPEC.md`, referenced from `src/lib/server/orchestrator/`,
> exists there and not here.
>
> **`fails.md`** is the one file here still appended to — but it is **NOT the full set**.
> It has forked from `F:\code\ai-playground\docs\fails.md` in **both** directions: this copy
> lacks F-048..F-055 and F-058..F-060, that copy lacks F-017..F-047. Scan **both** before
> starting a task; `CLAUDE.md` (worktree root) carries the measured breakdown. Re-unifying
> them is an operator action — mark, never delete.

## Read in this order

| # | Doc | What it answers |
|---|-----|-----------------|
| 1 | [PRODUCT.md](./PRODUCT.md) | What we're building, for whom, and what's explicitly out of scope |
| 2 | [ARCHITECTURE.md](./ARCHITECTURE.md) | How the system is structured — components, data flow, the simplifications |
| 3 | [DATA-MODEL.md](./DATA-MODEL.md) | The SurrealDB schema (document + graph + vector) and migration from v1's ~12 stores |
| 4 | [DEVELOPMENT.md](./DEVELOPMENT.md) | Repo layout, stack versions, build/test/lint, conventions, Windows rules |
| 5 | [ROADMAP.md](./ROADMAP.md) | Phased build plan, releases, milestones, and the open spikes |
| 6 | [DECISIONS.md](./DECISIONS.md) | **Retired redirect** → the live ledger is `F:\code\ai-playground\docs\DECISIONS.md` (D-000..D-042) |
| 7 | [UI-SPEC.md](./UI-SPEC.md) | UI/UX design contract: IA, layout, per-screen specs, components, live-update UX, states (token values now resolved → DESIGN-SYSTEM) |
| 8 | [MEMORY-SPEC.md](./MEMORY-SPEC.md) | Memory & learning engine design (two-tier loop, extraction, recall, lifecycle, SurrealDB gotchas) — folded from the cannibalize research |
| 9 | [AGENTS.md](./AGENTS.md) | Agent & skill authoring conventions (description-as-classifier, agentskills.io SKILL.md, model tiers) |
| 10 | [IMPLEMENTATION-PLAN.md](./IMPLEMENTATION-PLAN.md) | How to build it: de-risking spikes, build waves, foundational spine, test strategy, exit gates |
| 11 | [DESIGN-SYSTEM.md](./DESIGN-SYSTEM.md) | The concrete design system (teal/Lastik tokens, components, font-license) — fills UI-SPEC §4/§15. CSS in [`design-system/`](./design-system/) |

> [CANNIBALIZE-BRIEF.md](./CANNIBALIZE-BRIEF.md) is a research **INPUT**, not part of the read-order — it holds the provenance for D-027..D-033 and the design folds, kept for traceability.

## The four pivotal decisions (locked)

| Topic | v1 (current) | v2 (this plan) |
|-------|--------------|----------------|
| **Storage** | ~12 SQLite DBs + `graph-state.json` + HNSW `memory.db` + many JSON files | **One SurrealDB** (document + graph + vector) |
| **Agent runtime** (OpenClaw replacement) | OpenClaw WSS gateway (port 18789) | **Claude Code** (harness) behind an `AgentRuntime` interface; SDK/CLI split via spike (D-002) |
| **Local model** | Ollama `gpt-oss:20b` (~16GB) | **Keep as-is**, modeled as a swappable "model slot" |
| **Orchestration** | Always-on 60s heartbeat loop | **Configurable**, default **event-driven + on-demand** |

## What "lighter" means here

- One database process instead of a dozen file stores + a vector DB.
- No always-on polling loop by default — idle ≈ near-zero CPU.
- No custom WSS gateway / Ed25519 pairing machinery unless the spike proves we need it.
- Fewer dashboard pages and endpoints; one event stream instead of many pollers.
- Carry forward every lesson in v1's `docs/fails.md` so we don't re-pay old debt.
