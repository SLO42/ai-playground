# CC-CONFIG-SPEC — the filesystem-authoritative Claude Code config mirror + capability catalog

**Status:** DRAFT (2026-07-08) · implements D-010/D-036 (+D-018 confinement) · carries F-045 · queued `cc-config-hardening` (gate:operator)
**One-liner:** disk is the truth (D-010), the `cc_*` tables are a digest-keyed rebuildable mirror, and the catalog is the D-036 allow-list every spawn fail-closes against (F-045). The write path's diff+confirm guard is real, the F-045 dead-end has its fix (the harvest scope), and confinement fail-closes. The open questions are freshness ones: reconcile is page-load-triggered (the watcher observes but never writes), and a swallowed harvest-scope failure can make a promoted skill silently un-referenceable.

Grounding: opus scout pass 2026-07-08 over `src/lib/server/cc-config/` (file:line verified). Code on branch `v2`.

## 0. Scope & boundary

- **In scope:** `cc-config/` (parse.ts, sync.ts, write.ts, watch.ts, index.ts), tables cc_scope/cc_settings/cc_hook/cc_agent/cc_skill/cc_mcp_server, the catalogIds → composeCapabilities consumer seam.
- **Out of scope:** composeCapabilities internals + isolated-config composition (CLAUDE-CODE-HARNESS-SPEC §1.2/§1.6); skill HARVEST content pipeline (SKILL-HARVEST-SPEC — only the harvest SCOPE is here).

## 1. What's already BUILT

### 1.1 Scope model
A scope = one `.claude` dir. `cc_scope` (schema.ts:366): kind `project` (a registered project root's `.claude`) or `global` (`~/.claude` + the harvest scope). `scopeIdOf` deterministic (sync.ts:80). `confineScope` (:121) realpath-confines project scopes under CODE_ROOT — `ScopeConfinementError` fail-closed (D-018); global scopes exempt (:375). `classifyScopes` (:403): a project row is valid ONLY if it links a registered project AND confines under its root — invalid rows cascade-removed on reconcile (:437/:444).

### 1.2 Mirror + digest
`parse.ts` pure parsers (settings/mcp/hooks/agent+skill frontmatter); `digestScope` (:345) content-hashes a scope — drift detection + write confirm tokens. `syncScope` is the ONE mirror writer; `readCatalog` (sync.ts:695) feeds the dashboard; `syncState` (:649) = unsynced/synced/out_of_sync per digest compare. `mirrorDigest` persisted per scope.

### 1.3 The catalog → D-036
`catalogIds` derives the allow-list; `composeCapabilities` (runtime/capabilities.ts:211) fail-closes on ANY uncatalogued id — never drops-and-continues (:14). Reserved engine ids (peer-send, memory-pull) pass through so a correctly-empty catalog doesn't brick engine grants (F-045-safe, :122/:84). **cc_hook rows are catalogued but hooks are NOT part of the capability set** — hooks ride settings.json outside the per-task allow-list (capabilities.ts:91); deliberate, stated here.

### 1.4 Write path (D-010 never-silently-overwrite) — IMPLEMENTED
`planEdit` (write.ts:333): validate → line-level LCS diff vs on-disk bytes → `confirmToken` = sha256 of current bytes (:251/:348). `applyEdit` (:~355): token MANDATORY; disk changed under us ⇒ `StaleConfirmError` WITHOUT writing (:63/:371); then write + re-sync through the SAME `syncScope` (:19/:40 — one writer).

### 1.5 The F-045 class + the harvest scope (SH-5)
An id enters the catalog ONLY via syncing a registered scope. The platform's own `.claude` is neither a project root nor `~/.claude` (sync.ts:479–490 documents the dead-end) — fixed by the **harvest scope**: a global-kind scope at `harvestScopeDir` (:510/:518), `ensureHarvestScope` idempotent (:540), best-effort (a harvest failure never blanks the project catalog :612–620). Promoted skills are written INTO the harvest scope to become referenceable. **Verified: the v2 worktree has NO `.claude` dir** — consistent with `code-write.capabilities` being intentionally empty (F-045).

### 1.6 Refresh triggers
`reconcileScopes(db)` (sync.ts:571): cascade-delete invalid → derive+sync missing project scopes → ensureHarvestScope. **Trigger = the `/claude-code` page load** (routes/claude-code/+page.server.ts:150, scoped `depends('app:claude-code')` — the DEFECT-2 invalidate-storm fix :51–52) and write.ts applyEdit re-sync. `watchScope` (watch.ts:64): debounced digest-gated fs.watch — surfaces drift, **never writes the DB** (:59), never crashes the server (:97).

## 2. Normative invariants

1. **Disk is authoritative (D-010); the mirror is rebuildable**; `syncScope` is the ONLY mirror writer — no second write path, ever.
2. **An id is a valid capability ONLY if it lives in a SYNCED registered scope**; composeCapabilities fail-closes on anything else (F-045). Corollary: never declare a `bundles.<intent>.capabilities` id that isn't in the live catalog — check `SELECT name FROM cc_skill` on the live DB, not disk.
3. **The platform's own artifacts reach the catalog only through the harvest scope** — a promoted skill not written there does not exist as a capability.
4. **Edits go validate → diff → mandatory confirm-token → write → re-sync**; a stale token throws, never clobbers a hand-edit.
5. **Confinement fail-closes** (D-018): an unverifiable/escaping project scope is invalid and cascade-removed; global scopes are the only confinement exemption.
6. **The watcher observes, the loader reconciles**: drift surfacing and mirror writing are separate authorities (until CCF-1 decides otherwise, load-time reconcile IS the freshness contract).
7. **Hooks are settings-carried, not capability-set members** — the capability allow-list governs skills/agents/mcp only.

## 3. Gaps → the hardening wave (`cc-config-hardening`, gate:operator)

| id | gap (verified) | required behavior | shape |
|---|---|---|---|
| **CCF-1** | **Freshness contract undecided.** Mirror reconciles only on /claude-code load; runtime's CapabilityCatalog snapshot is additionally cached per-process (getRuntime, wiring.ts:112 — CLAUDE-CODE-HARNESS-SPEC CCH-5). A skill promoted (or deleted) between page visits is invisible (or still passes) at spawn time. | DECISION for operator, then build: (a) wire `reconcileScopes` + a catalog-snapshot rebuild at spawn-plan time when `syncState` reports out_of_sync (digest check is cheap), or (b) lock "load-time reconcile + boot-time snapshot" as the documented contract and surface `out_of_sync` prominently on /claude-code. Recommend (a) for the deleted-id case — a deleted skill still passing validation is a small security hole (stale allow-list), and D-036 is a security boundary (fail-closed family). | decision → build |
| **CCF-2** | `ensureHarvestScope` failure is swallowed (sync.ts:617) — an unwritable harness dir makes every promoted skill silently un-catalogable. | Keep best-effort (a harvest failure must not blank the catalog) but SURFACE it: a health field on the /claude-code loader (harvest scope: ok/failed+reason) + a warning event. Honest-but-visible (F-008). | build (small) |
| **CCF-3** | Hooks outside the capability set (§1.3/§2.7). | Documented — no build. Re-assert in SECURITY-MODEL-SPEC (hooks are analytics-only, D-019 no-op-on-failure; gates are the enforced layer). | documented |

## 4. Test coverage map

Built + tested: parse, sync (sync.test.ts + feedback.live.test.ts on live DB), write (StaleConfirmError path), watch, composeCapabilities (D-036 fail-closed + F-045 reserved pass-through), harvest scope, readback.live.test.ts (real CLI backend re-sync round-trip). **New tests:** CCF-1 per decision (out_of_sync → spawn-time reconcile, deleted-id refused); CCF-2 harvest-failure surfaced state.

## 5. DoD (D-038)

- [ ] CCF-1 decision recorded (additive note on D-036 or D-010) BEFORE code; chosen path tested incl. the deleted-id-refused case.
- [ ] CCF-2 health state honest on /claude-code (loading/ok/failed reasons).
- [ ] No change to composeCapabilities fail-closed semantics; no migration unless CCF-2 adds a field (then idempotent + apply-twice tested).
- [ ] Gates green token-unset (F-029); devlog row.
