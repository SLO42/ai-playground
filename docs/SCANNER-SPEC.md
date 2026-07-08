# SCANNER-SPEC — ecosystem detection · security/dependency/UX findings (one table, rule-prefixed)

**Status:** DRAFT (2026-07-08) · implements D-015/D-016/D-018/D-026 · queued in `periphery-hardening` (gate:operator)
**One-liner:** three finding families (security `hardcoded-secret.*`+sinks, `dependency.*`, `ux.*`) share ONE `security_finding` table with scoped soft-archive re-scans, pure injected-source detectors, path-confined walks, and redact-at-extraction. Fully built + tested. Two honest limits: scans piggyback on page loads/PM cycles (no scheduler — deliberate, see MAINTAIN-SPEC), and concurrent re-scans of one project can double-insert (no dedup guard, ordering-only).

Grounding: opus scout pass 2026-07-08 over `src/lib/server/scanner/` (file:line verified).

## 1. Substrate
- **Pure detectors / injected sources:** `detect.ts` (`detectEcosystem`:360, `buildCommandFor`:129, `testCommandFor`:169), `security.ts` (`scanSecurity` — bounded walk, SKIP dirs/exts, maxFileBytes, NUL binary guard, regex rules for secrets+sinks), `dependencies.ts` (`scanDependencies`:91 over an injected `AdvisorySource` — never network), `ux-inspect.ts`/`ux-source.ts` (static src/routes analysis, no browser).
- **Repos:** `registry.ts` (`scanProject` idempotent UPSERT keyed `project:<slug>`; `confineToRoot` fail-closed D-018), `findings-repo.ts` (`writeFindings`:57, `archiveActiveFindings`:87, `listFindings`:108, `scanProjectSecurity`:154), `dep-repo.ts` (`scanProjectDependencies`:71 under `dependency.*`), `ux-repo.ts` (`inspectProjectUx` detached/non-blocking, opt-in D-004, `ux.*`), `maintain-cycle.ts` (`uxInspectionAllowed` mode gate — gate at the caller, engine trigger-agnostic).
- **Triggers:** project/create/reports page loads, create/execute.ts, pm-hire, pm-review — no standalone scan loop.
- **Tests:** all 10 modules covered, real-surreal where DB touched.

## 2. Normative invariants
1. Findings live in ONE `security_finding` table categorized by rule PREFIX; a new family = new prefix + its OWN scoped soft-archive — schema unchanged.
2. Detectors REDACT at extraction (D-026): `detail` never carries a secret value; the repo layer stores what it's given — never widen it.
3. Every scan entry path-confines under CODE_ROOT first (symlink+`..` resolved), fail-closed (D-018).
4. Re-scan = scoped soft-archive-then-insert (D-015), never DELETE, never a sibling family's rows; live reads guard `(status="active" OR status IS NONE)`.
5. Detectors are pure with injected sources (AdvisorySource, UxInspectionSource) — no network in a detector, ever.
6. UX inspection is opt-in + detached, never awaited on a live path; datetimes ISO-coerced in normFinding (F-013).

## 3. Gaps → items (in `periphery-hardening`)
| id | gap | required behavior | shape |
|---|---|---|---|
| **SCN-1** | No dedup guard on `security_finding` — two overlapping scans of one project double-insert the active set (archive-then-insert ordering only). | Per-(project,family) scan serialization: a cheap in-process lock (the withMergeLock pattern) around archive+insert — NOT a schema dedup key (findings are point-in-time rows, D-008 keys don't fit). Real test: two concurrent scans → one active set. | build (small) |
| **SCN-2** | No scheduled scan loop — piggybacked on loads/PM paths. | Deliberate (D-004 event-driven; MAINTAIN-SPEC owns maintenance loops). Cross-ref only; a future maintain loop calls the existing `scanProject*` entries. | documented |
| **SCN-3** | AdvisorySource is offline/injected — dependency health only as fresh as the source. | Honest by design; a live feed would be a new injected source behind the same seam (D-037 pattern), operator-gated for network. | parked |
