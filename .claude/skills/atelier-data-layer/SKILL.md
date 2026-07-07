---
name: atelier-data-layer
description: Use when adding or changing anything in the SurrealDB layer of Atelier (ai-playground v2) — a migration in schema.ts, a query in a repo/aggregator/server load, a table normalizer, or a dedup key. Prevents the most recurrent failure family in this repo (F-013/F-015/F-020/F-048).
---

# Atelier Data Layer — SurrealDB safely

The single most recurrent failure family in this repo lives in the data layer. Every rule here
is a logged, real failure. Follow the checklist; do not improvise SurrealQL.

## Where things are (v2, `F:\code\ai-playground-v2`)

- **Migrations**: `const mNNNN_name: Migration = {...}` **inside `src/lib/server/db/schema.ts`** →
  collected into the exported `schemaMigrations` array. **No migrations directory, no per-file
  migrations.** Head is `m0080_maintenance_loops`. Next id = `m0081_<snake_name>`.
- **Runner + idempotency helpers**: `src/lib/server/db/migrate.ts` — `runMigrations`, `isApplied`,
  `defineFlagField`, `guardedScan`, `backfillValueField`. Reuse these; don't hand-roll idempotency.
- **Client**: `src/lib/server/db/client.ts` — `Db` (hard-bounded connect).
- **Normalizers (`norm*`)**: **per repo**, e.g. `src/lib/server/projects/repo.ts`
  (`normProject/normSprint/…`, `isoOrUndef`). Each repo owns its own. Not in `schema.ts`.
- **Apply**: `npm run db:up` (→ `scripts/db-up.ts`). Idempotent, safe to re-run, runs against the
  LIVE dev DB.

## The five rules (each = a fail)

### 1. Every migration statement is idempotent — assume it can die mid-apply (F-015)
The runner records a migration **only on success**. A bare `DEFINE TABLE x SCHEMAFULL` that
half-applies wedges `db:up` **forever** (`table already exists`). So:
- Use `DEFINE TABLE ... IF NOT EXISTS` / `OVERWRITE`; same for `DEFINE FIELD` / `DEFINE INDEX`.
- Prefer the helpers: `defineFlagField`, `backfillValueField`, `guardedScan`.
- **Test apply-twice AND apply-over-a-half-applied state** — not just a fresh DB.

### 2. Every `ORDER BY` / `GROUP BY` field must be in the `SELECT` (F-020, 3× recurrence)
SurrealDB 2.x throws `Parse error: Missing order idiom` at runtime otherwise. Self-check before
committing any hand-written query: **every field in `ORDER BY`/`GROUP BY` appears in the `SELECT`
list.** This has shipped to production three times — twice silently swallowed by a best-effort
`catch` (see rule 5).

### 3. Never return a raw SDK datetime from a server `load` (F-013)
The SurrealDB 2.x SDK returns datetimes as a non-POJO Date-like; SvelteKit's devalue serializer
500s on it (`Cannot stringify arbitrary non-POJOs`). In the table's `norm*`:
- Coerce every datetime to an ISO string (`isoOrUndef`), or `null` when absent. **Never
  `str(undefined)`** — that renders the literal `"undefined"` in the UI.
- A unit test where the field is `NONE` will NOT catch this. Assert on a row where it's SET.

### 4. A `dedup_key` VALUE keyed on a mutable field collides at the TRANSITION (F-048)
If `dedup_key = (work_type + '|' + session + '|' + status)` and `status` flips pending→processing,
the key is **recomputed** and can collide with an already-processing twin at the UPDATE, not just
at insert. Guard **both** the insert and the transition — absorb the UNIQUE violation as a
no-op/retry. A drain-path DB fault must NEVER crash the server (F-014).

### 5. A best-effort `catch` must not hide a developer error (F-020 sweep)
A `try/catch` that returns `[]` on error turns a parse bug (rule 2) into a **silent permanent
degradation** — the wakeup briefing dropped every unresolved task this way. So:
- Log/surface parse-class errors distinctly; don't swallow them like an empty result.
- Every best-effort loader needs a test that asserts the happy path **RETURNS rows**, not just
  "doesn't throw".

## Also (standing decisions)
- **`$param` binding for all values (D-016)**; only validated table/record ids are interpolated.
- **Append-only / ADD-only (D-015/D-028)** for knowledge tables; dedup/supersession/contradiction
  happen in a downstream deterministic pass, never an in-place LLM mutation.
- **`memory.embedding` needs a real 1024-dim vector** (`array::repeat(0.0, 1024)`), never `[]`
  (HNSW rejects off-dimension) when hand-seeding (F-020).
- **SET every column a `VALUE`/`dedup_key` formula references** when hand-seeding SCHEMAFULL rows —
  don't rely on a DEFAULT landing first (F-020). Prefer the store/CONTENT path over bare `SET`.

## Verification (mandatory — stub-green ≠ live-green)
`stubDb()` unit tests never parse SurrealQL. Any hand-written `ORDER BY`/`GROUP BY`/`VALUE` idiom
needs **either a real-surreal test** (`*.live.test.ts` / `*.proof.test.ts`) **or** a parse-level
assertion. Then the end-gate:

```bash
npm test            # incl. the real-surreal test you added
npm run db:up       # LIVE dev DB — the only layer that parses production SurrealQL
# + render-smoke every server load that reads the changed table
```

See `@.claude/skills/atelier-live-verify/SKILL.md` for the full end-gate. If a gate fails
first-try, append an `F-NNN` entry per `@.claude/skills/error-learning/SKILL.md`.
