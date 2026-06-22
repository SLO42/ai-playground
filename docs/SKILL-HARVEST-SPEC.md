# SKILL-HARVEST-SPEC — agents propose reusable skills to Atelier

**Status**: queued (2026-06-22). Origin: operator — "as long as my agents can … suggest
skills to atelier." Today there is NO loop that turns repeated/successful work into a
reusable, catalog-referenceable skill. This adds one, on the existing rails.

## Grounded facts this builds on

- **Skills are disk-authoritative** (D-010): a skill = `.claude/skills/<name>/SKILL.md`.
  Claude Code reads `.claude/` from disk at spawn.
- **DB is a read-only MIRROR** of disk: `cc-config/sync.ts` `syncScope` reads a `.claude`
  dir → upserts `cc_skill`/`cc_agent`/`cc_mcp_server`; `catalogIds(db)` (sync.ts:577) is the
  union of those names — the D-036 allow-list `composeCapabilities` validates a per-task
  capability set against (fail-closed on unknown id). Proven this session: an id not in a
  SYNCED scope cannot be provisioned (F-045).
- **A session already extracts at end**: `launch.ts` accumulates `transcriptParts`
  (launch.ts:506) and runs an ADD-only memory extraction (§3.2). That end-of-session seam is
  where a skill-proposal hook attaches — no new lifecycle plumbing.
- **G2 (agents propose, operator retires)** + **D-039 (operator hire/authority)**: agents
  may DRAFT skills; only the operator promotes one into the live, referenceable catalog.
- **D-026**: any agent-authored text persisted/rendered is screened (no raw secrets).
- Prior art (researched, file:line in session notes):
  - **hermes-agent**: post-turn background-review fork drafts/updates `SKILL.md` on disk,
    provenance-tagged user-vs-agent-created (`tools/skill_manager_tool.py:816`,
    `agent/background_review.py:45-147`). Disk-authoritative — matches us directly.
  - **kongcode**: daemon extracts a `skills[]` type to SurrealDB with `source` tag
    (`create_skill_tool` vs `causal_graduate`) + auto-graduation
    (`src/tools/create-skill.ts:57-76`, `src/engine/daemon-types.ts:71-75`). Richer/heavier;
    we take the provenance + extraction-schema idea, NOT the auto-promote.

## Design — propose → screen → operator-approve → write → sync → referenceable

A skill is harvested through FOUR gated stages. The agent never reaches the live catalog
on its own (G2).

1. **CAPTURE (proposal draft)** — at session end (the §3.2 seam), an extraction step looks
   at the session's trajectory and asks: did this session establish a reusable procedure
   (a non-trivial technique, a repeated fix, a workflow worth replaying)? If yes, it drafts
   a `skill_proposal` row: `{ name(kebab), description, body(SKILL.md markdown), trigger
   context, source:'session-harvest', sessionId, projectId, evidence[] }`. The body is
   SCREENED (D-026) before persist. NO disk write, NO catalog entry yet — a proposal is DATA.

2. **RECUR / RANK** — a proposal is stronger when its pattern recurred. A
   `skill_proposal` carries an `occurrences` count: a new draft whose (normalized) name +
   trigger matches an open proposal bumps the count instead of duplicating. Surface
   highest-occurrence proposals first. (This is the cheap, honest version of kongcode's
   "graduation" — count recurrence, do NOT auto-promote.)

3. **APPROVE (operator gate, G2)** — a `/skills` (or project-tab) review surface lists open
   proposals with their evidence + occurrence count. Operator actions: **approve** /
   **edit-then-approve** / **reject**. Approval is the ONLY path to stage 4. Reject marks
   the proposal closed (kept for audit, not deleted — G2 mark-don't-delete).

4. **PROMOTE (write + sync)** — on approval, write `<scope>/.claude/skills/<name>/SKILL.md`
   to disk (the harness's own synced scope), then sync that scope so `cc_skill` carries the
   new name. From then it is a real catalog id an intent bundle's
   `capabilities.skills:[<name>]` can reference (validated, no longer fail-closed — closes
   the exact gap F-045 hit). Provenance `source:'session-harvest'` + `approved_by` persisted.

### Components (each = a wave task)

- **SH-1 — proposal model + store** (`src/lib/server/skills/proposal.ts` NEW + additive
  migration, F-015): `skill_proposal` table (status: open/approved/rejected; occurrences;
  evidence shape-constrained + D-026 screened, mirroring the pm-propose evidence discipline).
  `proposeSkill()` dedups by normalized name+trigger → bump occurrences.
- **SH-2 — capture seam** (`launch.ts` §3.2 end-of-session): a best-effort (D-019, never
  fails/blocks the session) injected `SkillHarvester` that drafts a proposal from the
  trajectory. Injected seam = stub in tests (no model spend), exactly like
  `PmProposalGenerator` (pm-propose.ts). Screened text only.
- **SH-3 — promote path** (`src/lib/server/skills/promote.ts` NEW): on approval, write the
  SKILL.md to a confined path under the synced scope's `.claude/skills/` (D-018 confine —
  reuse `routes/claude-code/config-target.ts` resolver), then `syncScope` that scope.
  Atomic: disk write FIRST, then DB sync (disk is truth). Idempotent re-approve = no-op.
- **SH-4 — operator review UI** (`/skills` or the project command-center): list open
  proposals (description + evidence + occurrences), approve/edit/reject actions. Honest
  empty/loading/error states (F-008). Approve calls SH-3; reject closes (mark, not delete).
- **SH-5 — make a synced harvest scope exist**: F-045 proved the platform's own `.claude`
  is NOT a synced scope today, so a freshly-written skill would have nowhere to land in the
  catalog. Register ONE harvest scope (the platform/global `.claude` the harness controls)
  in `cc_scope` + wire `reconcileScopes`/`syncScope` to cover it, so SH-3's write actually
  reaches `cc_skill`. (Without SH-5 the loop dead-ends — this is the load-bearing task.)

## Integrity invariants (red-team targets)

- **No self-promotion** (G2/D-039): an agent/session can ONLY create a `skill_proposal`;
  reaching `cc_skill` REQUIRES a recorded operator approval. A red-team task must try to get
  a proposal into the catalog without an `approved_by` and fail closed.
- **D-026 screening**: a proposal body containing a secret-shaped token is screened before
  persist AND before render; assert on a planted secret.
- **Disk is truth** (D-010): promote writes disk THEN syncs; a DB row never exists without
  the SKILL.md file. A sync over a half-written file fails closed (no phantom catalog id).
- **Confinement** (D-018): the SKILL.md write cannot escape the scope's `.claude/skills/`
  (reuse the confined resolver; path-traversal name → fail closed).
- **No catalog poisoning**: an approved name must be a valid skill id (kebab, no collision
  with an existing catalog id unless explicitly an update); a malformed/duplicate name is
  rejected, not silently overwritten.
- **Additive migration** (F-015): `skill_proposal` + any new cc_scope row are idempotent.
- **Mark-don't-delete** (G2): rejected/superseded proposals are retained for audit.

## Verification (DoD — D-038)

- Unit: dedup/occurrence bump; screened-body persist; promote writes confined SKILL.md +
  syncs catalog; re-approve idempotent; unapproved → never in cc_skill.
- Integration (live): draft a proposal from a fake trajectory → operator-approve → assert the
  name appears in `catalogIds(db)` → a `code-write` bundle declaring it now spawns (no D-036
  fail-close). Reject path keeps the row, no disk write.
- Build + test + lint(0) + svelte-check(0). Live-verify the review UI end-to-end.

## Scope guard

This does NOT auto-promote skills (no kongcode-style auto-graduation) and does NOT let an
agent edit the live catalog — both would violate G2/D-039. Recurrence only RANKS proposals;
the operator is always the gate. Start narrow: harvest from successful code-write sessions;
widen later if useful.
