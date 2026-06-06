# ai-playground v2 — Planning Docs

Working title: **ai-playground v2** (final name TBD — see [DECISIONS.md](./DECISIONS.md) D-000).

A ground-up, **lighter** rebuild of the ai-playground project-lifecycle platform — which is **also a Claude Code harness**. Same product idea (create, develop, maintain, release software projects with AI agents) but simplified: one unified datastore (SurrealDB), **Claude Code as the agent runtime + config control surface + session fleet + workflow runner**, and a configurable (not always-on) orchestrator.

**Two pillars:** (1) project lifecycle platform — decides *what* work to do; (2) Claude Code harness — *how* it gets done and how you control it. See [PRODUCT.md §1a](./PRODUCT.md).

These are **planning documents only**. No code yet. The build happens later, phase by phase, assisted by skills.

## Read in this order

| # | Doc | What it answers |
|---|-----|-----------------|
| 1 | [PRODUCT.md](./PRODUCT.md) | What we're building, for whom, and what's explicitly out of scope |
| 2 | [ARCHITECTURE.md](./ARCHITECTURE.md) | How the system is structured — components, data flow, the simplifications |
| 3 | [DATA-MODEL.md](./DATA-MODEL.md) | The SurrealDB schema (document + graph + vector) and migration from v1's ~12 stores |
| 4 | [DEVELOPMENT.md](./DEVELOPMENT.md) | Repo layout, stack versions, build/test/lint, conventions, Windows rules |
| 5 | [ROADMAP.md](./ROADMAP.md) | Phased build plan, releases, milestones, and the open spikes |
| 6 | [DECISIONS.md](./DECISIONS.md) | ADR-style log: locked decisions + tracked OPEN decisions |

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
