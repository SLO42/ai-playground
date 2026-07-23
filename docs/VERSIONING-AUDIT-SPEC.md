# VERSIONING-AUDIT-SPEC — every capability artifact versions, every version explains itself

**Status**: LOCKED as **D-042** (operator, 2026-07-23). Planning spec — no code yet; queued `versioning-audit`.
**Date**: 2026-07-23
**Author**: Fable-5 planner session
**Operator intent (verbatim)**: *"Tools should version, and agents and skills should version. We should have AUDIT TRAILS so we can see WHERE updates came from, WHY, and WHEN."*
**Reads with**: `docs/SELF-IMPROVEMENT-LOOP-SPEC.md` (append-only adoption, `learning_candidate`/`learning_event`, validation registry) · `docs/BRAIN-OBSERVER-LOOP-SPEC.md` (curation gate, rejection ledger) · `docs/DECISIONS.md` (D-015/D-026/D-028/D-035a/D-036/D-037/D-038/D-039) · `docs/fails.md` (F-008/F-045/F-048/F-054/F-055)

---

## 1. Thesis + scope

One invariant, applied to every mutable capability artifact in Atelier:

> **A capability artifact never changes in place. It changes by APPENDING a new version that records — queryably, in-product, surfaced in the UI — the version number, the SOURCE of the change, the REASON (linked provenance), the WHEN (ISO), and what it SUPERSEDES. Any version can be rolled back to, by appending. History is never deleted.**

This is the substrate that makes autonomous self-improvement safe and reversible. `SELF-IMPROVEMENT-LOOP-SPEC.md` §3.1 already commits to "adoption = new version + supersession marker, never in-place mutate" — but only for artifacts the learning loop touches. This spec generalizes that discipline to **all** capability artifacts, whatever the source of the change (operator hand-edit, disk sync, HR ceremony, learning loop, rollback). Git already gives us file history for `.claude/*`; what's missing is the **in-product** trail the brain, the dashboard, and the effectiveness loop can query without shelling to git — and the join from a running session back to the exact artifact versions it used.

### 1.1 Artifact kinds in scope, and how each versions today

| Kind | Where it lives | Versioning today | Gap |
|---|---|---|---|
| **role** (HR worker identity) | `role` + `role_version` tables (`schema.ts:1058–1097` in the v2 worktree) | **The prior art — already correct.** `role_version` carries `version int`, `prompt_sha` (content hash), `source` enum (`operator/pm_proposal/import`), `lifecycle` (draft→…), `activated_at`/`retired_at`, immutable `dedup_key = role\|version` UNIQUE (`schema.ts:1095`), and a separate append-only `role_event` audit table (`schema.ts:1204–1211`). `role.active_version` is a pointer, not truth (`schema.ts:1068`). Written via `createRoleVersion` (`src/lib/server/workforce/repo.ts`) and re-versioned through the ceremony (`reversionFailedRole`, `src/lib/server/workforce/ceremony.ts:782`) | Not visible in any unified history surface; `source` enum lacks the new provenance vocabulary (§4) |
| **cc_agent** (`.claude/agents/*.md` definitions) | `cc_agent` table, synced from disk (`schema.ts:387–393`) | **None in-product.** Fields are `scope/file_path/name/description/frontmatter/category` — no version, no content hash. Sync overwrites the snapshot. Git is the only history | Whole invariant missing |
| **skill** (`.claude/skills/*.md`) | `cc_skill` table (`schema.ts:395–400`) | Same as cc_agent: snapshot only (`scope/file_path/name/description/plugin`) | Whole invariant missing |
| **tool/capability** (the D-036 catalog: skills + agents + mcp + reserved ids that bundles allow-list) | Catalog read via `catalogIds` (`sync.ts:805`), freshened at spawn by `freshenCatalog` (`sync.ts:892`); bundles in `config/orchestration.yaml:96` | Scope-level `mirrorDigest` exists (`sync.ts:663`) but no per-artifact or per-catalog-revision versioning | No "catalog revision N, changed because X" fact anywhere |
| **workflow** (`.claude/workflows/v2-wave.js` and future wave scripts) | Git-tracked file on `v2-main`; load pre-check `v2-wave.test.mjs` (F-016) | Git only | In-product trail missing (and SELF-IMPROVEMENT consumer #2 will propose edits to it) |
| **rule** (CLAUDE.md hard rules, SKILL.md additions from the error-learning ladder) | Git-tracked docs | Git only; fails.md uses dated `> STALE-PROPOSED:` mark-never-delete lines | Same |
| **rejection** (the brain-observer rejection ledger) | Specced in BRAIN-OBSERVER-LOOP-SPEC; not yet built (`src/lib/server/brain/` does not exist in the v2 worktree as of this writing) | Born append-only by spec | Needs to land ON this substrate rather than growing its own |

### 1.2 The cc_agent-vs-role separation (do not blur it)

`cc_agent` (a synced `.md` definition file) and `role` (the HR identity a session runs as) are **separate tables with no FK**, bridged by slug — a deliberate, audited fact (see memory: `project_atelier-agents-awareness`). Versioning must respect this: **a cc_agent definition version is not a role version.** A role can re-version (new prompt_core via the ceremony) without any disk file changing; an agent `.md` can change on disk without any role being re-certified. The unified model (§2) therefore keys versions by `(artifact_kind, artifact_key)` — `cc_agent|reviewer` and `role|reviewer` are two distinct version chains that happen to share a slug. The UI may *display* them side by side (the bridge is useful to humans); the data model never conflates them.

### 1.3 Design rule: generalize `role_version`, don't reinvent it

`role_version` already embodies every hard-won lesson: integer version, content hash, source enum, supersession via lifecycle + pointer, immutable dedup key (F-048-safe: keyed on `role|version`, never on mutable lifecycle/status), separate event table for the trail. `artifact_version` (§2) is that shape, widened. Roles themselves **stay on `role_version`** — it is live, tested (`ceremony.test.ts`, `activation.test.ts`), and already routed through the workforce gate; migrating it into a new table would create a second writer and violate F-055. The unified surface reads roles by UNION at query time (§6).

---

## 2. The version + audit model

### 2.1 `artifact_version` (append-only)

One table for every kind **except role** (which it unions with at read):

| Field | Type (prose) | Notes |
|---|---|---|
| `artifact_kind` | string enum: `cc_agent \| skill \| capability_catalog \| workflow \| rule \| rejection` | `role` deliberately absent — see §1.3. New kinds are additive enum widenings (the m0080/m0081 precedent: widening an ASSERT enum never touches existing rows) |
| `artifact_key` | string | Stable identity of the chain: for synced artifacts, the deterministic scope-digest record key the sync already computes (`scopeIdOf`/record-id digests, `sync.ts:80–111`); for workflows/rules, a repo-relative path slug. Immutable per chain |
| `artifact_ref` | option record link (`cc_agent`/`cc_skill`/…) | Convenience pointer to the live snapshot row where one exists; the snapshot may be re-synced, the link is best-effort — `artifact_key` is the identity |
| `version` | int, monotonic per `(artifact_kind, artifact_key)` | Assigned by the chokepoint (§4.5), never by the caller |
| `content_hash` | string (sha256) | Of the **EOL-normalized** content (`\r\n`→`\n` before hashing — F-054: the Edit tool flips LF→CRLF on this host; an EOL flip must not mint a version). For the catalog kind: hash of the sorted id-set |
| `content_snapshot` | option string / object | The artifact body (or frontmatter+body) at this version, so diff and rollback don't require git. Screened per D-026 before storage (provenance and content are untrusted text). For very large artifacts, storing the disk path + git ref instead is acceptable in v1 — but then the history UI's diff shells out, so prefer inline |
| `source` | string enum — the provenance vocabulary of §4 | **Stamped server-side by the chokepoint; unforgeable (D-035a-style)** |
| `reason` | object: `{ kind, ref, note? }` | The provenance link: `git_commit` sha · `learning_candidate` id · `validation_run` id · `gauntlet/interview_run` id · `operator_consent` record · `rollback_of` (an `artifact_version` id). `note` is screened free text (D-026). NULL when honestly unknown (F-008) — never a fabricated "manual edit" |
| `supersedes` | option record<artifact_version> | The previous current version at write time. First version → NULL |
| `superseded_by` | option record<artifact_version> | Back-pointer, written by the chokepoint **in the same append transaction** that creates the successor — this is the ONE sanctioned touch to an existing row, it sets a previously-NULL pointer exactly once and never edits content (the same pattern as `role_version.retired_at`) |
| `created_at` | datetime, ISO-coerced in the repo `norm*` (F-013) | |
| `dedup_key` | VALUE `artifact_kind + '\|' + artifact_key + '\|' + version`, UNIQUE index | **Immutable inputs only** — F-048 forbids keying on anything mutable. Mirrors `role_version.dedup_key` exactly (`schema.ts:1095`) |

**`is_current` is derived, never stored as truth.** Current = the row in a chain with `superseded_by = NONE`. A head-pointer field on the snapshot row (like `role.active_version`) is a permitted *cache* for hot paths, but every consumer that matters (UI history, rollback, effectiveness attribution) resolves from the chain. Concurrency note: two racing appends to one chain must serialize on the UNIQUE dedup index — the loser absorbs the conflict as retry-with-next-version, never as a crash (the F-014/F-048 drain-path rule).

### 2.2 The attribution join — which versions did this session actually run with?

This is the missing link that makes effectiveness attributable and regressions traceable. What exists today at spawn:

- `session.role` / `session.role_version` — roles are **already** version-attributed (`schema.ts:1216–1217`).
- `session.granted_skills/granted_agents/granted_mcp/granted_reserved/tool_allow/granted_intent` (m0065, `schema.ts:2347–2352`) — the granted set is known at spawn, but recorded as opaque **names**, not versions.
- `session.agent` (m0069) and `session.specialist` (m0070) — strings, not version refs.

**Add: `session.artifact_versions` — `option<array<record<artifact_version>>>`**, pinned once at spawn by the same launch path that writes the m0065 grants (`sessions/launch.ts`): for each granted name, resolve the *current* `artifact_version` in its chain and record the id. Discipline copied verbatim from the m0065 migration comment (`schema.ts:2326–2341`): when resolution is impossible (artifact has no version chain yet — pre-backfill), the field is **NULL, never a fabricated empty array** (F-008); an empty array means "session genuinely used no versioned artifacts."

Why a pinned array on `session` and not a join table: the set is known at one instant (spawn), never grows, and the dominant query is "given this session/task outcome, which versions were in play" — a single-row read. The effectiveness rollup in SELF-IMPROVEMENT-LOOP-SPEC §4 (`route_outcome` joined per intent/tool/model) gains a `version` dimension for free: *skill X v3 wins 84% where v2 won 61%* becomes a queryable fact, and a regression after a version bump is traceable to the exact change — source, reason, and author included. A separate `artifact_use` join table stays as a v3 option if per-invocation (not per-session) granularity is ever needed.

### 2.3 Data-layer conventions (non-negotiable, from §5 DoD)

Idempotent migration (`OVERWRITE`/`IF NOT EXISTS`, apply-twice + half-applied tested — F-015) · every `ORDER BY`/`GROUP BY` field in the `SELECT` (F-020) · datetimes ISO-coerced in `norm*`, absent → `null` (F-013) · all values `$param`-bound (D-016) · a **real-surreal** test parses every query (F-020, not `stubDb`) · `npm run db:up` clean on the live dev DB.

---

## 3. Relationship to git

Git remains the file-content history and the source of truth for `.claude/*` artifacts (the codebase already states this: "D-010: disk is truth" — comment at `schema.ts:2159`). `artifact_version` does not compete with git; it **mirrors the salient facts at sync time** so the brain, the UI, and the effectiveness loop can reason without shelling out:

- `syncScope` (`sync.ts:179`) today upserts snapshots. Extended (v1): per synced record, compute the EOL-normalized `content_hash`; if it differs from the current chain head (or no chain exists), the sync calls the version-writer chokepoint with `source='sync_from_disk'` and `reason={kind:'git_commit', ref:<sha>}` — the sha from a best-effort `git log -1 --format=%H -- <file>` in the scope's repo. If git is unavailable or the file is untracked, `reason` is NULL — honest, not invented (F-008). Unchanged hash → **no version row** (re-running sync is a no-op; the idempotency the whole sync path already has).
- **No divergence by construction**: `content_hash` is the reconciler. If product and disk ever disagree, the next sync appends the disk truth as a new version — the product never "wins" over disk for disk-backed kinds, matching D-010 and the existing `freshenCatalog` drift semantics (`sync.ts:892`).
- Workflows/rules (files on `v2-main`, not under a synced `.claude` scope) get the same treatment from a lightweight registration pass — v1 may simply run it as part of the same reconcile tick, walking a small allow-listed path set (`.claude/workflows/v2-wave.js`, `CLAUDE.md`, `docs/fails.md`). `[VERIFY: whether reconcileScopes (sync.ts:595) can host this or a sibling function is cleaner]`

The git commit in `reason` answers WHERE/WHY at file granularity (author, message — one `gh`/`git show` away when a human wants depth); the `artifact_version` row answers it at *product* granularity, instantly, joined to sessions and outcomes.

---

## 4. Sources of version bumps — the provenance vocabulary

`source` enum, closed set (additive widening only):

| `source` | Who/what | `reason.kind` it must carry | Gate it rode through |
|---|---|---|---|
| `operator` | Manual/UI edit by the operator | `operator_consent` (the recorded consent/action id) or NULL+note | The action's own gate (D-039) |
| `sync_from_disk` | Git edit landed on disk, picked up by sync | `git_commit` (or NULL if untracked) | The existing sync path — D-036 allow-list re-derives from the SAME reconcile; F-045 checked (§8) |
| `hr_recruiter` | Role re-version via the ceremony/gauntlet | `interview_run` / gauntlet id | The workforce ceremony (`ceremony.ts`, `auto-adjudicate.ts`); operator keeps the D-039 adjudication gate. Lands in `role_version.source` — the existing enum (`operator/pm_proposal/import`, `schema.ts:1087`) is **widened** to include `hr_recruiter` (additive ASSERT widening, the m0080 precedent) `[VERIFY at build: which source value the recruiter path stamps today]` |
| `self_improvement` | A `staged→adopted` learning_candidate (SELF-IMPROVEMENT-LOOP-SPEC §3.3) | `learning_candidate` id + its `validation_run` id — **both mandatory** (§8: no unvalidated auto-version) | The shared curation gate (specced as `brain/curation-gate.ts`; not yet built), then operator adopt (D-039) |
| `brain_observer` | Rare — only via an adopted observer proposal | Same as `self_improvement` (it feeds the same queue) | Same curation gate |
| `rollback` | Operator-initiated revert to a prior version | `rollback_of` (target `artifact_version` id) + `operator_consent` | Operator-gated, §5 |

### 4.5 One chokepoint (F-055)

Every row in `artifact_version` is written by **one function** — `writeArtifactVersion(db, input, ctx)` (home: `src/lib/server/cc-config/versioning.ts` or `db/` — decided at build; what matters is *one*). Properties:

- **Server-side provenance stamping, D-035a-style**: `source` comes from the caller *context* (which code path invoked it — sync, ceremony adapter, curation gate, operator route handler), never from the artifact content or any LLM-authored payload. A skill whose markdown says "source: operator" changes nothing. Exactly like `origin=operator` stamping: the claim is made by the server about the channel, not by the message.
- Assigns `version` (chain head + 1), computes/verifies `content_hash`, screens `reason.note` and `content_snapshot` (D-026), writes the row + the `superseded_by` back-pointer in one transaction, absorbs UNIQUE conflicts as retry (F-048/F-014).
- Refuses `source='self_improvement'`/`'brain_observer'` without a linked passed `validation_run` — fail closed here is correct: this IS a security boundary (D-024 scope), not an additive capability branch.
- The role path is the one sanctioned sibling: `createRoleVersion` (`workforce/repo.ts`) remains the role chokepoint (it already exists, is gated, and is tested); it gains the same server-side source-stamping rule. Two writers, each the single gate for its table — F-055 is satisfied per mutation path, and no new path may write either table directly. An audit item at build: grep for any other writer of `role_version` and route it through `createRoleVersion`.

---

## 5. Rollback

Rollback is an **append, never a delete** — it creates version N+1 whose content equals version K's `content_snapshot`, with `source='rollback'` and `reason={kind:'rollback_of', ref:vK}`. History stays intact; the trail shows the excursion AND the retreat. Always operator-gated (see Questions — recommended default: operator-only in v1).

Per kind, "roll back" means:

- **Disk-backed artifacts (cc_agent, skill, workflow, rule)**: disk is truth (D-010), so the rollback executes as a **disk write** — restore vK's content to the file (surfaced to the operator as the git-side action it is; committing the revert on the relevant branch is part of the ceremony), then the normal sync observes the change and the chokepoint appends the new version with `source='rollback'` (the sync passes rollback intent through; without it the row would mislabel as `sync_from_disk` — the chokepoint correlates on content_hash == vK.content_hash + a pending rollback intent record). The product never silently diverges from disk.
- **Catalog (capability set)**: a rollback is a catalog-revision change and **routes through the existing sync/reconcile path** (D-036/F-045 — §8): re-sync after the disk-side restore; `freshenCatalog` semantics are untouched.
- **Role**: rollback = a **new `role_version`** whose `prompt_core` copies vK's, created via `createRoleVersion` + the activation path (`swapActiveVersion`). Whether re-activation requires re-running the gauntlet: the certification attaches to the version content — vK *was* certified, and `prompt_sha` proves the content is byte-identical, so re-hire at prior version may reuse vK's passing `interview_run` `[VERIFY: activation.ts stale-marking semantics (§3.7 comment, activation.ts:12) — if vK's run was stale-marked, re-certification is required]`. Recommended default: reuse the certification when the run is not stale-marked; otherwise gauntlet again.
- **A version that F-045 would orphan** (rolling the catalog back below a version some bundle id depends on): the chokepoint rejects it with the exact failing bundle ids — never applies-then-breaks-spawns.

---

## 6. UI / observability

A **version history surface per artifact** — one component, reused everywhere the artifact already appears:

- **Timeline**: v1 → vN, each entry: version · source badge (color per provenance vocabulary) · reason (linked: git sha → commit, learning_candidate → its evidence, interview_run → the gauntlet result) · when (ISO, humanized) · who-adopted where applicable. Current version badged; superseded chain walkable.
- **Diff**: between any two versions from `content_snapshot` (or git-backed when snapshot is path-only).
- **Reachable from**: `/agents` (cc_agent chains, and the slug-bridged role chain side-by-side, clearly labeled as two chains — §1.2), `/brain` (the soul/identity view gains "what changed recently" — this is precisely what makes the alive-brain's self-changes *watchable*, per BRAIN-ALIVE-UI-SPEC), and the cc-config catalog view (`/claude-code` `[VERIFY: exact route]`) for skills/capabilities.
- **Honest states (F-008)**: an artifact with no chain yet renders "no in-product history (pre-versioning) — see git", never an invented v1. A NULL reason renders "provenance unknown (untracked at sync time)". Loading/empty/error/stale all explicit.
- **Reactive**: history updates over the existing SSE/event stream (D-005) — a sync or adoption appears live, no polling.
- The roles union: the surface queries `role_version` for `kind='role'` chains and `artifact_version` for the rest, normalized to one view-model in the loader (POJOs only, ISO datetimes — §5 DoD).

---

## 7. Data — tables + migrations

Symbolic ids — the head is `m0081_agent_event_supervision` (`schema.ts:2879`, registered at `:2995`); **renumber at build**.

| Migration (symbolic) | Contents |
|---|---|
| `m0082_artifact_version` | `DEFINE TABLE OVERWRITE artifact_version SCHEMAFULL` + fields per §2.1 · UNIQUE index on `dedup_key` · index by `(artifact_kind, artifact_key)` · index by `created_at` (timeline queries — and the projected field IS in the SELECT, F-020) |
| `m0083_session_artifact_versions` | `DEFINE FIELD OVERWRITE artifact_versions ON session TYPE option<array<record<artifact_version>>>` — NULL=unknown discipline documented in the migration comment, mirroring m0065's (`schema.ts:2326–2341`) |
| `m0084_role_version_source_widen` | Additive ASSERT widening of `role_version.source` to include `hr_recruiter`/`self_improvement`/`rollback` (the m0080/m0081 enum-widening pattern — never touches existing rows) |
| (with the self-improvement build) | `rollback_intent` scratch record if the disk-rollback correlation of §5 needs it — decided at build |

All idempotent (F-015: apply-twice + apply-over-half-applied tested), all normalizers in the owning repo module with `isoOrUndef`, real-surreal tests for every query including the union-at-read (§6) and the "chain head + 1" version assignment under a simulated race.

Backfill: **none required**. Chains start when the invariant lands (v1 sync writes the first version for every synced artifact with `reason=NULL` or the current git sha, `source='sync_from_disk'`). Pre-existing history stays in git; the UI says so honestly.

---

## 8. Safety invariants (each testable)

1. **Append-only** (D-015/D-028): no UPDATE ever touches `content_snapshot`/`content_hash`/`source`/`reason`/`version` on an existing row. The only sanctioned write to an existing row is setting a NULL `superseded_by` exactly once. *Test: attempt an in-place content mutation via every public API surface; assert refused. Assert `superseded_by` set-twice fails.*
2. **Server-stamped, unforgeable source** (D-035a-style): `source` derives from the invoking code path, never from payload or artifact content. *Test: call the chokepoint with a payload claiming `source='operator'` from the sync context; assert the row says `sync_from_disk`.*
3. **No unvalidated auto-version**: every `self_improvement`/`brain_observer` row links a `validation_run` with a passing verdict; the chokepoint rejects otherwise (fail closed — this is a security boundary, D-024 applies). *Test: adoption without a validation link → refused.*
4. **Catalog integrity on any tool/capability change** (D-036/F-045): a version append for the catalog kind, including rollback, routes through the existing sync/reconcile path, and no resulting state leaves a `bundles.<intent>.capabilities` id absent from a synced scope's catalog. *Test: attempt a rollback that would orphan a bundle id; assert rejected with the id named.*
5. **One chokepoint per table** (F-055): `writeArtifactVersion` for `artifact_version`; `createRoleVersion` for `role_version`; no other writer. *Test: repo-wide grep in CI (or a review-gate check) for direct `CREATE artifact_version`/`CREATE role_version` outside the two modules.*
6. **Provenance text screened** (D-026): `reason.note` and `content_snapshot` pass the secrets/PII screen before storage; retrieved provenance renders as data, never as instructions. *Test: a note containing a token pattern is redacted/refused.*
7. **Rollback never deletes**: after any rollback, every prior version row still exists and the chain length grew by one. *Test: property-style — rollback twice, walk the chain, count.*
8. **Honest attribution** (F-008): `session.artifact_versions` is NULL when resolution wasn't possible, never a fabricated empty/partial set presented as complete. *Test: spawn against an un-chained artifact; assert NULL, and assert the effectiveness rollup excludes (not zero-fills) that session.*
9. **EOL-stability** (F-054): hashing normalizes `\r\n`→`\n`; a CRLF-only diff mints no version. *Test: rewrite a skill file with flipped EOLs; sync; assert no new row.*

---

## 9. Proposed DECISION (draft — operator locks; do NOT edit DECISIONS.md yet)

The current head is **D-041** (`docs/DECISIONS.md:555`); this proposes **D-042**:

> **D-042 — Versioned capability artifacts with server-stamped audit trails.**
> Every mutable capability artifact (tool/capability, agent definition, skill, workflow, rule, rejection, role) is an append-only versioned entity. Each version records, in-product and queryably: monotonic version, content hash, SOURCE (server-stamped provenance from a closed vocabulary — operator / sync-from-disk / hr-recruiter / self-improvement / brain-observer / rollback — unforgeable by artifact content, D-035a-style), REASON (a link to the git commit / learning_candidate / validation_run / interview_run / operator consent that caused it), WHEN (ISO), and what it SUPERSEDES. Autonomous (non-operator, non-sync) version bumps require a linked, passed validation gate. All writes route through one chokepoint per version table (F-055). Rollback appends a new version pointing at its target; history is never deleted. Git remains the file-content source of truth for disk-backed artifacts; the in-product trail mirrors it at sync time and reconciles by content hash. This trail is the reversibility guarantee for all autonomous self-improvement.

---

## 10. Phasing + risks

**v1 — the substrate (smallest shippable)**
`m0082` + `writeArtifactVersion` + sync-path integration (cc_agent/skill/catalog chains born with git provenance) + the read-only history timeline on `/agents` and the catalog view. No behavior change to spawns, no rollback yet. DoD: live db:up, real-surreal tests, render-smoke, devlog.

**v2 — attribution**
`m0083` + spawn-time pinning in `sessions/launch.ts` (beside the m0065 grant write) + the version dimension in the effectiveness rollup (lands with SELF-IMPROVEMENT-LOOP `route_outcome`). Now regressions trace to versions.

**v3 — writers + rollback**
Widen `role_version.source` (`m0084`) and stamp the ceremony path · curation-gate adoption writes (`self_improvement`/`brain_observer`) once that gate exists · operator-gated rollback per §5 · workflow/rule registration pass · union-at-read roles in the unified UI.

**Risks**

| Risk | Mitigation |
|---|---|
| **Hash churn / noise** (EOL flips, whitespace, sync jitter minting junk versions) | EOL-normalized hashing (F-054); unchanged-hash = no row; see Q1 on granularity debounce |
| **Git-vs-product drift** (product trail says vN, disk says otherwise) | Disk is truth for disk-backed kinds; content_hash reconciles on every sync; the UI shows sync status honestly rather than pretending |
| **Over-versioning trivial edits** (a typo fix reads as a capability change in effectiveness stats) | Versions are cheap rows, but *attribution* windows can require min-samples-per-version before a rollup treats a version as a distinct arm (SELF-IMPROVEMENT G-series gates) |
| **Attribution join cost** (resolving N granted names → chain heads at every spawn) | Chain-head resolution is one indexed query per name against `(artifact_kind, artifact_key)`; pinned once at spawn; if it ever shows up in spawn latency, cache heads beside the existing catalog mirror the sync already maintains |
| **Two version tables (role_version + artifact_version) drift in discipline** | §8 invariants apply to both; the shared invariant tests run against both tables; the union view keeps them visibly parallel |
| **Snapshot bloat** (storing full content per version) | Artifacts here are small markdown/config; if a kind proves large, that kind stores path+git-ref and the diff view degrades gracefully (stated honestly in the UI) |

---

## QUESTIONS FOR OPERATOR:

1. **Version granularity**: should every content-hash change at sync mint a version (recommended default: **yes** — rows are cheap, the trail stays complete, and effectiveness windows handle noise via min-sample gates), or only "meaningful" changes (requires a judgment mechanism we'd have to build and trust)?
2. **Rollback authority**: operator-only in v1 (recommended default: **yes** — rollback of a validated-regression could later be proposed autonomously through the same learning-candidate queue, but it should earn that after the trail proves itself)?
3. **Workflow/wave scripts in scope**: version `v2-wave.js` and future wave scripts from v1 (recommended default: **v3** — they're operator-edited today and F-016's load pre-check already gates them; include them once the self-improvement loop starts proposing workflow edits, which is when the trail pays for itself)?
4. **Retention**: keep every version forever (recommended default: **yes, forever** — append-only history IS the product guarantee, volumes are trivially small at this scale; revisit only if `content_snapshot` storage ever measurably matters, and then prune snapshots, never rows)?
