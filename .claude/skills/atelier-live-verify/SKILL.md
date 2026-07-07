---
name: atelier-live-verify
description: Use at the end-gate of any Atelier feature or change — before calling it done, before committing a wave, before reporting a task complete. Runs the D-038 Definition-of-Done as a checkable sequence and catches the "green on stub/fresh ≠ green live" class (F-013/F-015/F-020). Also the Windows/token/EOL gotchas that make gates lie.
---

# Atelier Live-Verify — the Definition-of-Done end-gate

"Build green" is **not** done (D-038). The four static checks are necessary but they run against
stubs and fresh throwaway DBs — they cannot see the failures that only exist on the live DB or a
rendered page. This skill is the consolidated end-gate that does.

## Preconditions (or the gates lie)
- Run in the **v2 worktree** `F:\code\ai-playground-v2`.
- **`CLAUDE_CODE_OAUTH_TOKEN` unset** — a stale token wedges the spawn path (F-029). In bash:
  `unset CLAUDE_CODE_OAUTH_TOKEN` (or run in a shell that never set it).
- **One builder per worktree (F-052).** No other agent building / `svelte-kit sync` / dev-serving
  the same worktree. Two racers corrupt `.svelte-kit` → non-deterministic ENOENT + dead dev server.
  If you see a `.svelte-kit` ENOENT but svelte-check/eslint/tests are green, suspect the race —
  re-run a SOLO build before treating it as a real defect.
- **EOL check (F-054).** The Edit tool can flip LF→CRLF here. If any test regex-scans source text,
  run `git diff --stat` — whole-file churn means an EOL flip; normalize `\r\n`→`\n` before trusting
  that test.

## Layer 1 — static gate (zero tolerance)
```bash
npm run build      # vite build
npm test           # vitest run
npm run lint       # eslint .   → 0
npx svelte-check --threshold error   → 0
```
All four must be clean. Do NOT proceed on "just warnings".

## Layer 2 — live gate (the layer that catches the real bugs)
This is the ONLY layer that parses production SurrealQL against real SurrealDB and renders real
pages. **Mandatory whenever the change touches data or a page.**
```bash
npm run db:up      # provision + migrate the LIVE dev DB (not a fresh test DB)
```
- `db:up` must run **clean** — no `table already exists` (F-015 idempotency), no
  `Missing order idiom` (F-020), no migration-not-recorded.
- **Render-smoke every NEW/changed server `load`**: hit each page (`npm run dev`, or
  `npm run verify:browser`) and confirm it renders — honest loading/empty/error states, no devalue
  500 from a raw datetime (F-013), no literal `"undefined"`/fabricated values (F-008).
- If a query is involved, confirm the **real-surreal test** you added (not `stubDb`) is in the run.

## Layer 3 — Definition of Done (D-038): all six, checkable
- [ ] **Complete** — no stubs/TODOs standing in for the feature.
- [ ] **Fully tested** — real SurrealDB where a query exists; happy path asserts rows returned.
- [ ] **Design-system standard** — teal/Lastik tokens (D-034), not ad-hoc CSS.
- [ ] **Functional & live-verified** — Layer 2 passed on the live DB + real render.
- [ ] **Has purpose** — it does a real job for a real user/flow.
- [ ] **Honest** — no fake states, no green-on-stub masking a live break.

## Layer 4 — record it
- **Devlog** (`docs/devlog/YYYY-MM-DD[-slug].md`, operator directive): `Theme` · `Shipped`
  (per-feature table **with commit hashes**) · `Migrations` (+ live `db:up` counts) · `Decisions`
  · `Bugs/fails logged (F-NNN)` · `Docs/memory` · `End-gate — PASS` · `Parked/next` (split "needs
  operator" vs "gated by design"). Commit + push it. This is the persisted autonomy digest.
- **fails.md** — if any gate failed on the first try, append an `F-NNN` entry
  (`@.claude/skills/error-learning/SKILL.md`). Root-cause first (Iron Law), don't just re-patch.

## The one lesson this skill exists to enforce
`stubDb()`/fresh-DB tests give **false confidence** — F-013, F-015, and F-020 all shipped green
through build+vitest+svelte-check and broke only live. The consolidated `db:up`-live + render-smoke
is not optional polish; it is the gate that would have caught every one of them. Never report a
data/page change done without it.
