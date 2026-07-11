# 2026-07-11 — the hardening chain: waves 5–9, paused by operator mid-wave-9

**Theme:** burn down the operator-released hardening chain from the 2026-07-08 spec campaign. Fable-5 orchestration session; every build/review/red-team on opus via `v2-wave.js`. Five waves driven this stretch (cost-governance-1b → cc-config → projects → adapter-framework → periphery), **operator paused mid-wave-9**. Also shipped two shareable status reports on request.

## Shipped (code on v2, all pushed; docs on v2-main)

| wave | verdict | commits (origin/v2) | headline |
|---|---|---|---|
| cost-governance-1b | ✅ 4/4 GREEN | `bdca0d3..a3bd455` | FIFO single-flight budget gate (≤1 of N at-threshold proceeds); local-$0 concierge exemption; pmReview 402; boot pricing validation; per-project token budget (CG-3); per-project cost attribution (CG-6); cost-labeled consents (CG-4). Red-team found the pmReview 402 handler was DEAD code + a false "still metered" comment — both fixed w/ guards. |
| cc-config-hardening | ✅ 3/3 GREEN | `550ee69..1c145bc` | CCF-1 D-036 stale-catalog spawn hole closed (freshenCatalog digest probe → loader's reconcile → snapshot rebuild pre-validation; deleted harvest skill REFUSED, real-surreal). CCF-2 harvest-scope health honest on /claude-code. CCF-3 hooks posture doc. |
| projects-hardening | ✅ 4/4 GREEN | `cb0fe33..b2feeac` | PJH-1 applyBriefDecision = the ONE per-kind operator-authority dispatcher (spec premise partially stale — codebase won; review/fixture kinds grep-proven never-briefs → typed refusal, no invented gate). PJH-2 F-055 arm-path census. PJH-3 datetime consolidation. PJH-4 under-populated-project render-smoke. |
| adapter-framework-hardening | ✅ 1/1 GREEN | `ef600c1` | ONE UnknownAdapterError across release+sync paths; honest extension-posture comment (no runtime code-load, D-026/D-018). Deferral ledger EMPTY. |
| periphery-hardening | ⏸ PAUSED 2/3 | `67a6245`, `75d4b56` | SCN-1 scan lock + SYN-1/2 dryRun-required both GREEN+pushed. SVC-1+2+3 stopped mid-build — uncommitted worktree state preserved; resume recipe in BUILD-QUEUE row. |

## Migrations
None this stretch (live db:up stayed 80/80 clean throughout — verified inside waves).

## Decisions
No new D-numbers. Executed two previously-recorded delegated notes: D-036 CCF-1 spawn-plan-time reconcile (built + red-teamed); D-004 SVC-1 services tick (mid-build at pause). Deferral-ledger policy applied twice → new queued waves `cost-governance-2`, `cc-config-2`.

## Bugs / fails
- **F-051 recurrence ×3, recovered ×3, zero work lost**: (1) session-process exit orphaned wave-5 launch; (2) session exit again mid-wave-5; (3) StructuredOutput retry-cap crash on the CCF-2 reporter (work already committed). The recipe (journal → git log → push green → resume with resumeFromRunId + RECOVERY CONTEXT verify-don't-redo) is now battle-proven; also used for the operator pause.
- Red-team catches inside waves (fixed in fix-loops, never reached main): false gate-red analytics row on brief re-POST; dead pmReview 402 handler; false "still metered" comment (now guarded by a code-coupled honesty test).

## Docs / trackers
- BUILD-QUEUE: 5 rows flipped done/paused; deferral rows `cost-governance-2` (4 MEDIUM: un-metered concierge turn is the headline) + `cc-config-2` (2 MEDIUM: project-scope drift resync + mutable-snapshot race) queued under the standing red-team-deferral policy.
- New shareable reports (operator request): `docs/STATUS-2026-07-11.md` (scope vs goal) + `docs/ATELIER-TOTAL-STATUS.md` (total picture) — `c489a93`.

## End-gate
PASS for the four completed waves (each independently DoD-reviewed, gates green inside the wave, pushed). Wave 9 intentionally NOT end-gated — operator pause; 2/3 tasks green+pushed, SVC task's uncommitted state preserved for resume.

## Parked / next (at operator's signal)
1. **Resume periphery-hardening**: `resumeFromRunId: wf_81cdf5c8-df5` + full original args, RECOVERY CONTEXT on SVC-1+2+3 (dirty files listed in the BUILD-QUEUE row).
2. Then the released remainder: security-floor-2 → cost-governance-2 → cc-config-2.
3. Operator-gated as ever: `new-mod-test` (the graduation publish), self-hosting (D-040), B2b ledger sign-off, benchmark cloud key.
