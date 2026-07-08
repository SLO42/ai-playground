# MAINTAIN-SPEC — the project-facing maintain phase (loop-driven)

**Status:** DRAFT (2026-07-07) · gates D-004 / D-018 / D-039 · queued `maintain-phase` (gate:operator)
**One-liner:** the scanners (security / dependency-health / UX) are BUILT and already scan a managed project's OWN repo, surfacing findings — but they only run when the operator clicks, and no finding ever becomes proposed work. This spec makes maintain **loop-driven and self-proposing**, completing the maintain phase of create→develop→**maintain**→release.

## 1. What's already BUILT

- **Findings model** — `security_finding` table (`schema.ts:346-357`): `project`, `rule` (family-by-prefix: `dependency.vulnerable`/`dependency.outdated`/`ux.*`/secret rules), `severity`, `file`, `detail`, `status DEFAULT 'active'`, soft-archive fields (`archived_at`/`archive_reason`/`superseded_by`, D-015 append-only). Repo: `scanner/findings-repo.ts` (`listFindings`, `normFinding`).
- **Three detectors over a path-confined project dir** (`confineToRoot`, symlink/`..` fail-closed, D-018): `scanner/security.ts scanSecurity()`, `scanner/dep-repo.ts scanProjectDependencies()` (npm audit/outdated style), `scanner/ux-inspect.ts` + `ux-source.ts` + `maintain-cycle.ts` (static UX inspection). Entry: `scanner/registry.ts scanProject()`.
- **These already scan a managed project's OWN repo** (not Atelier) and surface on the project Overview→Maintain panel + roll up to `/reports`.
- **MaintenanceLoopEngine** — `loops/maintenance.ts` + `maintenance-actions.ts`: the cadence/gate engine (D-004 mode gate, readiness arm-gate, sequential per F-052, fail-absorbed per F-048).

## 2. The gaps (the actual delta)

1. **Scans are MANUAL only.** Triggered via the project route action (`routes/projects/[id]/+page.server.ts:1979`, gated by `uxInspectionAllowed`). **No loop drives them** on cadence.
2. **The engine fires GLOBAL rows only.** `MaintenanceLoopEngine` runs manifest rows where `projectId === null` (`maintenance.ts:93,218`); the registry ships exactly two GLOBAL actions (`maint:eval-regression`, `maint:reranker-eval`). The manifest *supports* `projectId` (`manifest.ts:42`) but nothing registers or fires a **project-scoped** maintenance row.
3. **Findings don't propose work.** A vuln/outdated-dep/UX finding persists + renders but never feeds `proposeTask` (D-039) — so maintenance never becomes actionable dev work; a human must notice and act.

## 3. Design — loop-driven, self-proposing maintain

### 3.1 A project-scoped maintenance action
Register `MAINT_PROJECT_SCAN = 'maint:project-scan'` in `defaultMaintenanceRegistry` (`maintenance-actions.ts`). It calls `scanProject()` (the existing confined entry) over `project.root_path` for the target project — security + dep-health + UX — and persists findings via the existing repo. **Reuses the built detectors verbatim**; the action is the loop wrapper, not new scan logic.

### 3.2 Teach the engine project-scoped firing
The engine currently hard-filters to global (`projectId === null`, `maintenance.ts:93,218`). Extend it to also fire **project-scoped** manifest rows (`projectId != null`) — resolve the project, pass it to the action's ctx. Preserve all gates (D-004 mode, readiness arm, sequential F-052, fail-absorb F-048). A per-project maintenance loop row is armed via `/loops` like any other.

### 3.3 Findings → proposed work (D-039)
On a scan producing NEW active findings above a threshold (e.g. severity ≥ MEDIUM, or a newly-vulnerable dep), the action calls `proposeTask` (§4.1) — a `proposed` maintenance task ("fix `dependency.vulnerable` in X", "resolve `ux.*` in Y") that the PM validation panel + operator gate handle (D-039). **Never auto-fix** — maintain PROPOSES, the operator/PM disposes. Dedup so a standing finding doesn't re-propose every cadence (one open proposal per finding-family per project).

## 4. Cadence & gating
- Per-project maintenance loop rows (kind `'maintenance'`, `projectId` set), seeded CREATE-IF-ABSENT with checklist EMPTY (honestly inert until the operator arms it), phase `L1` = propose-only.
- Gates preserved: D-004 mode ≠ manual; readiness arm-gate (`arm-gate.ts`); sequential (never two scans churning, F-052); run-log failure absorbed (F-048).
- Cadence a config default (e.g. nightly), operator-tunable.

## 5. Safety invariants
- **Path confinement (D-018):** scans stay under `confineToRoot(project.root_path)`; symlink/`..` escapes fail closed (already enforced by the detectors).
- **Append-only findings (D-015):** findings soft-archive (`archived_at`/`superseded_by`), never hard-delete; a resolved finding is superseded, auditable.
- **Screen (D-026):** finding `detail`/`file` content screened before render/propose (a scanned repo can contain secrets).
- **Propose-not-fix (D-039):** a finding becomes a `proposed` task; remediation goes through the panel + operator gate. Maintain never edits a project's code on its own.
- **Honest (F-008):** empty/clean scan renders as clean, not a fabricated all-good; a scan that couldn't run (missing dir, tool absent) surfaces the real reason.

## 6. Build tasks
- **MT-1** `MAINT_PROJECT_SCAN` action wrapping `scanProject()` over `project.root_path`; persists findings via the existing repo. Unit + real-surreal test.
- **MT-2** Teach `MaintenanceLoopEngine` to fire project-scoped (`projectId != null`) rows; preserve every gate. Test: a project row fires its action on cadence; a global row still fires; gates hold.
- **MT-3** Findings → `proposeTask` (D-039) on new MEDIUM+ findings; dedup one-open-proposal-per-finding-family-per-project. Test the propose path + dedup.
- **MT-4** Per-project maintenance loop seed + `/loops` surface (arm/disarm, honest inert state) + the project Maintain panel showing loop status + recent scans + proposed remediations.

**Verify:** real-surreal tests (scan seeds findings; new MEDIUM+ finding proposes exactly one task; standing finding doesn't re-propose; project-scoped row fires under the engine); `npm run db:up` if a field/seed ships; redTeam MT-3 (prove no auto-fix, propose-only, dedup holds, confined scan can't escape the project dir).

## 7. Open forks
1. **Propose granularity**: one proposal per finding vs one digest proposal per scan. Recommend per-finding-family (actionable) with dedup.
2. **Which detectors in v1**: all three (security/dep/UX) vs start with dependency-health (highest signal, lowest noise). Recommend all three — they're built — but only propose on security + dep initially, UX as advisory-only until it proves low-noise.
3. **Auto-scan default cadence**: nightly vs weekly. Recommend nightly for security/dep, weekly for UX.
