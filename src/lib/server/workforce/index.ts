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
