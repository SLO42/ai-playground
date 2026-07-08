# 2026-07-08 — the "spec everything" campaign: 10/10 specs shipped

**Theme:** close the SPEC-COVERAGE backbone in one autonomous stretch. Fable-5 planning session authored every spec; 6 opus scouts grounded every claim (file:line, no guessing). Coverage moved **15 FULL / 21 PARTIAL / 3 NONE → 27 FULL / 11 PARTIAL / 1 NONE** (remaining NONE = perf, trivial).

## Shipped (all on v2-main, pushed)

| spec | commit | headline find (verified, file:line in spec) |
|---|---|---|
| ORCHESTRATOR-SPEC | `602231c` | Boot re-drain hole CONFIRMED still live — no initial drain + reaper resets tasks→ready BEFORE the bus subscription exists; F-026 deterministic-id is the real dedup (UNIQUE index advisory) |
| PROJECTS-SPEC | `67024cc` | Task CRUD lives in tasks/repo.ts not projects/; founding-task promotability + F-050 main-default both FIXED; applyBriefDecision handles only task-kind briefs (unbuilt seam) |
| CLAUDE-CODE-HARNESS-SPEC | `a407b07` | NEW F-046-class find: ClaudeCodeRuntime.running keyed by SLOT — concurrent same-slot sessions collide on cancel; writeProjectGuardrails production caller not found (verify-first) |
| ADAPTER-FRAMEWORK-SPEC (+RELEASE-SPEC stale-mark) | `c9cae3c` | RELEASE-SPEC was STALE: verify() IS on the contract (TASK 14.7) and Thunderstore's real gated upload is LIVE-capable; custom adapters are code-contributions, never runtime-loadable |
| DB-RUNTIME-SPEC | `05f0231` | **D-026c least-priv DB user never DEFINEd — dev runtime runs as ROOT** (client seam correct, grant artifact missing) |
| COST-GOVERNANCE-SPEC | `f6c66b8` | **cost_usd never populated by any live backend (all $ views null)**; dailySpawnCap meters ONLY the background drain — ceremony/interactive/concierge/benchmark spend uncounted; consent is action-shaped, never cost-labeled |
| CC-CONFIG-SPEC | `275109e` | Catalog reconcile is /claude-code-load-triggered (watcher observes, never writes); a DELETED skill can still pass D-036 validation via the stale snapshot; swallowed harvest-scope failure = silently un-catalogable skills |
| SECURITY-MODEL-SPEC (covers auth) | this commit | Perimeter VERIFIED layered+fail-closed (all 4 exempt paths own-auth; both F-055 fixes in place; no exempt-unprotected endpoint). 4 findings w/ exploit scenarios: spoofable Host-header loopback fallback, 4 stale bind-premise comments, plain-HTTP cookie (accepted risk), unverified runtime grant matrix |
| SCANNER-SPEC + SYNC-SPEC + SERVICES-SPEC | this commit | Scanner: concurrent re-scans can double-insert (no lock). Sync: adapters default dryRun:FALSE (caller-side safety only); live GitHub round-trip still a deferred proof. **Services: tick() has NO production scheduler — auto-restart never runs autonomously** |

## Migrations
None — docs-only session. (Specs queue migrations: DBR-1 DEFINE USER; possibly CCF-2 health field.)

## Decisions
No D-numbers minted. Three operator DECISION points queued inside waves: ORH-3 (handoff replay: wire vs retire — additive note on D-021 first), CCF-1 (catalog freshness contract — note on D-036/D-010 first), SVC-1 (services tick scheduler vs manual-only contract).

## Bugs / fails
No new F-entries (nothing built/failed). New defect-class finds routed to BUILD-QUEUE instead: CCH-1 slot-keyed run registry (F-046 sibling), SEC-1 Host-header fallback (F-055 premise class), SYN-1 dryRun default footgun.

## Docs / trackers
SPEC-COVERAGE tally + ranked list closed out. BUILD-QUEUE: **8 new queued rows, all gate:operator** — orchestrator-hardening · projects-hardening · cc-harness-hardening · adapter-framework-hardening · db-runtime-hardening · cost-governance-1 · cc-config-hardening · security-hardening-1 · periphery-hardening (9 rows). RELEASE-SPEC stale-marked (mark-never-delete).

## End-gate
PASS (docs-only: no code gates to run; every spec grounded by an opus scout report; all commits pushed to origin/v2-main).

## Parked / next
- **Operator-gated:** all 9 hardening waves above (spec-campaign policy: every wave gate:operator). Suggested order when released: security-hardening-1 + db-runtime-hardening (security floor) → orchestrator-hardening (boot re-drain unblocks hands-off recovery) → cc-harness-hardening → cost-governance-1 → the rest.
- **Operator-driven milestone:** `new-mod-test` — fresh Create-with-AI ROUNDS mod → full lifecycle → first real Thunderstore publish (D-037). The floor is specced+hardening-queued; Thunderstore's real upload path is live-capable.
- **Design-gated:** ANALYTICS-SPEC (slot 11, 4.4k loc "first-class" mandate) — the only substantive PARTIAL left; then config/runtime/events/importer/providers/routing/tasks/workflows/hooks/agent-library thin rows.
