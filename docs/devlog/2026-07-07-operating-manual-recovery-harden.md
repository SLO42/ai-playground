# 2026-07-07 — Operating manual + recovery-repo-harden wave

## Theme

Two arcs. First, made the platform legible to a weaker model: rewrote `CLAUDE.md`
as a full Atelier v2 operating manual (verified against the live `v2` worktree) and
added three high-leverage skills distilled from the failure log. Second, hardened
the go-live cracks the ROUNDS drive surfaced (recovery + repo-creation) so the
graduation test (`new-mod-test`) can run hands-off — shipped as a clean 4/4 wave.

## Shipped

### Docs / operating manual (`v2-main`)

| item | commit | notes |
|---|---|---|
| CLAUDE.md rewrite | `9dbd006` | v1→v2 rewrite: geography (app at repo ROOT, migrations in `db/schema.ts` head m0080, OpenClaw dropped per D-012), conventions in-force + 4 added, named traps (each a logged F-NNN, mistake→rule), D-038 DoD made checkable per deliverable type, exact escalation rules, D-NNN quick-ref. Force-added past the v2-main `/*` ignore (clean rewrite, no secrets). |
| 3 Atelier skills | `04fd5a2` | `atelier-data-layer` (F-013/015/020/048 — idempotent migrations, ORDER BY in SELECT, datetime→ISO norms, dedup-at-transition), `atelier-live-verify` (D-038 end-gate; stub-green≠live-green; token/EOL/worktree-race preconditions), `atelier-wave` (v2-wave load-time syntax traps F-016/056, sentinel stop markers F-019, StructuredOutput-crash recovery F-051). |

### recovery-repo-harden wave — `wf_281f0943-f6b`, 4/4 green, pushed origin/v2 (`v2`)

| task | commit | notes |
|---|---|---|
| RRH-1 BL-GUX-FIX | (no-op) | 3 graph-UI DoD failures already fixed in `3073230`; reviewer independently re-verified live-green (148 tests, drove `/projects/atelier_self/graph`, 0 console errors). Honest "no change needed." |
| RRH-2 BL-RC-FIX / F-050 | `8d1ff08` | Scaffolder births `main` (`git symbolic-ref HEAD refs/heads/main`, version-agnostic); repo-creation gate `resolvePushBranch` resolves the actual branch + normalizes master→main before push, never assumes `main`. +6 F-050 tests. redTeam PASS. Preserves FORBIDDEN_GIT local-only rule + D-037 gate. |
| RRH-3 BL-R3 / F-048 | `4e8698b` (+`f6b5cea`, `588bc15` fix-loop) | Deterministic-id active-window dedup so `{pending,processing}` dedup against each other — **reverted the secondary-UNIQUE approach per F-026** + a real 4-concurrent→1-row enforcement test; success-side terminal writer for the post-task-disabled default. redTeam PASS. |
| RRH-4 BL-R4 | `9d1019b` | Operator-authority `reopenFailedTaskToReady` (`failed→ready`, login-gated). **RH-1 invariant held**: the auto/reaper path still lands `failed` (no infinite re-drain), proven by non-regression + no-auth-refusal tests. redTeam PASS. |

## Migrations

None. RRH-3 deliberately **reverted** its migration for the deterministic-id
approach (F-026-safe); RRH-4 needed none.

## Decisions made

- **Sequencing: harden the floor, then graduate.** Wave A (recovery+repo) before
  `new-mod-test`, because go-live proved a `failed` task dead-ends and repo backing
  breaks on branch naming — running a hands-off create→develop→publish over that is
  the exact escalation the manual says to avoid.
- **Deferred ledger = 4 LOW → advisory only** (G3: LOW never auto-fixed, no
  hardening wave chains). Notable latent: RRH-2 birth-on-main lacks a guard if it
  ever runs over a pre-existing *populated* root (normal path is a fresh scaffold).

## Bugs caught / fails logged

None new. Every task's hard gate passed first-try; the RRH-3 fix-loops were
review-driven comment corrections, not gate failures.

## Docs / memory

- CLAUDE.md, 3 skills, this devlog, BUILD-QUEUE row (running→done).
- Memory: v2-build progress pointer updated.

## End-gate — PASS

Wave A: 4/4 D-038 reviews PASS, redTeam PASS on RRH-2/3/4, pushed origin/v2
(tip `9d1019b`), `git rev-list origin/v2..HEAD` = 0 (F-041 push-verified), tree clean.

## Parked / next

**Needs operator:**
- **`new-mod-test`** (gate:operator) — the graduation test: bring up DB (`:8000`) +
  dev (`:5173`, `CLAUDE_CODE_OAUTH_TOKEN` unset) → "Create with AI" a new ROUNDS mod
  → PM proposes → develop → 1.0.0. **Publish stays a separate D-037 confirm.** The
  floor is now solid for it (failed tasks re-drivable, repos birth `main`,
  concurrent same-task clobber closed).

**Gated by design / advisory:**
- 4 LOW deferred from Wave A (RRH-2 symbolic-ref exit-code, birth-on-main
  populated-root guard, gate case-4 non-main default; RRH-4 concurrent-reopen test).
- BL-GUX-2 (lifecycle-graph causality emission), BL-1/BL-2/BL-7C (need specs),
  self-hosting D-040.
