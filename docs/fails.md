
## F-014: live-verify hang + dev-server orphan storm
- **Date**: 2026-06-08
- **What**: A gap-closure build agent (v1.6/10.1) ran ~2h with no commit; it had built all files but spun forever on the mandatory live agent-browser verify, leaking 17 orphaned dev-server node processes.
- **Why**: agent-browser on Windows is flaky (os error 10060 read-timeouts; SurrealDB SDK hangs ~90s on a dead socket). The per-feature live-verify had NO time bound and NO server reuse/cleanup, so agents retry-spun and each re-booted (then leaked) a dev server.
- **Fix**: Hard commit gate = build+test+lint(0)+svelte-check(0). agent-browser smoke is REQUIRED-BUT-BOUNDED (~5 min, no spin) → on env timeout, record liveVerified:false + reason and proceed; consolidated live pass at the end-gate. Reuse ONE dev server; mandatory teardown of every spawned process.
- **Prevention**: In any workflow that live-verifies via a browser/dev-server: bound the browser step in wall-clock, never spin-retry a flaky tool, reuse a single server, and kill every process you spawn before returning.

## F-015: non-idempotent migration wedged db:up; tests green on fresh DB, broken on live DB
- **Date**: 2026-06-09
- **What**: v1.7/11.4 shipped migration m0025 with a bare `DEFINE TABLE pm_review SCHEMAFULL`. It half-applied on the live dev DB (table created, field defs/index never landed, migration not recorded), so `npm run db:up` failed permanently with "The table 'pm_review' already exists", and pm_review rows missing `created_at` rendered the literal string "undefined" in the PM tab. All 14 unit tests passed.
- **Why**: (1) The migration wasn't idempotent, and the runner records a migration only on success — any partial apply wedges every future `db:up`. (2) Tests ran migrations against a FRESH throwaway DB where m0025 applies cleanly, so the half-applied live-DB state was unreachable by the suite. (3) The normalizer did `str(row.created_at)` — stringifying `undefined` into fake-looking UI text instead of coercing absent datetimes to null/'—'.
- **Fix**: Made m0025 idempotent (IF NOT EXISTS/OVERWRITE pattern), unwedged the live DB + backfilled created_at, hardened normPmReview (absent datetime → null → '—'), added idempotency tests incl. the half-applied recovery path, swept other migrations for the same pattern.
- **Prevention**: Every SurrealDB migration statement must be idempotent (IF NOT EXISTS / OVERWRITE) — assume it can die mid-apply and will re-run. Migration tests must cover: apply twice, and apply over a simulated half-applied state. Never `str()` a possibly-absent datetime in a normalizer — absent → null, UI renders '—' (extends F-013). Run `npm run db:up` against the LIVE dev DB as part of verify, not only fresh test DBs.
