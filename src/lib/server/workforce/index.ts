// TASK 16.3 — W-D7a workforce data plane (WORKFORCE-SPEC §2). Public surface of
// the module: lifecycle state machine, repo (rows/normalizers/harness mutations),
// deployability resolver (§2.4), track-record rollup skeleton (§2.5).
//
// NOTE (§4.4): readGauntletKeyForScoring is deliberately re-exported — it is the
// table's SINGLE legitimate read path and only W-D7b's deterministic scorer may
// import it. No session/briefing/recall/PM code path may touch gauntlet_key.

export * from './lifecycle';
export * from './repo';
export * from './deployability';
export * from './track-record';
// TASK 16.6 (W-D7b) — the gauntlet engine: findings contract (§3.3), deterministic
// scorer (§3.4 — the sanctioned gauntlet_key consumer), runner/budget/adjudication
// (§3.1/§3.6/§3.7), fixture activation + sentinel sweep (§3.7/§4.2).
export * from './findings';
export * from './scorer';
export * from './gauntlet';
export * from './activation';
// TASK 16.7 (W-D7c) — launch content (5 role definitions + draft prompt cores + fixture
// WORK sets, HONEST: proposed/no-keys/draft) and the day-0 bootstrap ceremony MECHANISM
// (§8 — prompt-core review, key diff+confirm, admission reference-run + bootstrap-
// interview triggers, all operator-gated + INERT; re-exports the §3.4 adjudication
// write-path from gauntlet.ts — not forked).
export * from './launch-fixtures';
export * from './ceremony';
// TASK 16.7b (W-D7c surfaces) — the read-only workforce panel aggregator feeding the
// /agents workforce surface (§8 'Surfaces' + 'Degraded/empty states'). Read-only:
// reuses repo/deployability/track-record, no row writes, no gauntlet_key read.
export * from './panel';
