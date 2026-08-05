# Atelier (build worktree)

This is the **v2 build worktree** (branch `v2`). The app is scaffolded here
alongside `spikes/` (throwaway proofs) and `bin/` (provisioned binaries).

The full project conventions live in the main repo's `CLAUDE.md`
(`F:\code\ai-playground\CLAUDE.md`). This file is the lean, build-worktree-specific
overlay.

## Canonical spec (read before building — do NOT guess)

**The authoritative doc set is the docs checkout, `F:\code\ai-playground\docs\` (branch
`v2-main`)** — decisions, every `*-SPEC.md`, the build queue and the devlog live there and
are kept current. The `docs/` directory in THIS worktree is a frozen 2026-06 snapshot of
the original v2 plan; read it as history, not as the current system.

- `F:\code\ai-playground\docs\DECISIONS.md` — locked decisions **D-000..D-042** are LAW.
  (The local `docs/DECISIONS.md` is a retired redirect — it stopped at D-034.)
- `F:\code\ai-playground\docs\` — the current `*-SPEC.md` set, e.g. `GAME-VERIFY-SPEC.md`,
  which source comments in this tree cite by that name.
- Frozen local snapshot, still useful for original intent: `docs/IMPLEMENTATION-PLAN.md`,
  `docs/DATA-MODEL.md`, `docs/MEMORY-SPEC.md`, `docs/ARCHITECTURE.md`, `docs/UI-SPEC.md`,
  `docs/AGENTS.md`, `docs/DEVELOPMENT.md`.
- `docs/fails.md` — live and append-only in this worktree.

## Stack (verify APIs before use)
- Node 24, ESM only (`"type":"module"`).
- SvelteKit 2 + Svelte 5 **runes** (`$state`/`$derived`/`$effect` — never stores)
  + Tailwind v4 (`@theme`, CSS-first — no `tailwind.config.js`) + Node adapter.
- SurrealDB **2.x** (pinned 2.6.5). HNSW: `DIMENSION 1024 DIST COSINE TYPE F32
  EFC 150 M 12` (NO `M0`). KNN `<|K,EF|>`. Never 3.x syntax.
- Ollama at `http://127.0.0.1:11434` (NO `/v1`). Embeddings 1024-dim.

## Build & verify
```bash
npm install
npm run build && npm test && npm run lint && npm run typecheck
```

## Hard rules
- TDD: test first, then impl. No fake/hardcoded runtime data (F-008) — fixtures
  ok in tests, runtime uses live sources.
- No secrets in code/commits (`.env`, gitignored). Font binaries
  (`*.woff,*.woff2,*.ttf,*.otf`) MUST NOT be committed (D-034) — Lastik is
  `@font-face`-referenced to an uncommitted `static/fonts/` path.
- Validate at boundaries. On Windows: `execFile` arrays + `shell:true` for
  spawn; never `process.kill(pid, 0)` (use `tasklist`).
- Source → `/src`, tests alongside source or `/tests`, docs → `/docs`.

## Workflow: Plan → Implement → Verify
Every task: plan (scope-lock the files), implement only those files, verify with
the task's exact command. Atomic commit per task. See `docs/fails.md` before
starting; append a fail entry if build/test didn't pass first try.
