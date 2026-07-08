# DB-RUNTIME-SPEC — provision · verify · connect · migrate (the SurrealDB runtime floor)

**Status:** DRAFT (2026-07-08) · implements D-001/D-006/D-007/D-016/D-025/D-026c · carries F-006/F-014/F-015/F-042 · queued `db-runtime-hardening` (gate:operator)
**One-liner:** the DB floor is solid — SHA-256-gated binary spawn, loopback-asserted bind, 5s-bounded connect with honest degraded boot, transactional ledger-recorded idempotent migrations, and the single D-016 identifier chokepoint. One promise is unkept: **the D-026c least-privilege runtime user is a client-side seam only — no `DEFINE USER` exists, so dev (and today, everything) runs as root.** This spec states the floor's invariants and scopes that fix.

Grounding: opus scout pass 2026-07-08 over `src/lib/server/db/` + `scripts/db-up.ts` (file:line verified). Code on branch `v2`.

## 0. Scope & boundary

- **In scope:** `db/binary.ts`, `provision.ts`, `client.ts`, `migrate.ts`, `validate.ts`, `testserver.ts`, `runtime-init.ts`, the `schema.ts` migration STRUCTURE (not table contents — DATA-MODEL owns those), `scripts/db-up.ts`.
- **Out of scope:** individual table schemas (DATA-MODEL), queue semantics (ORCHESTRATOR-SPEC), normalizers (per-subsystem specs).

## 1. What's already BUILT (the substrate)

### 1.1 Binary integrity + spawn (F-006/SEC-009, D-006)
- **Pinned:** SurrealDB **2.6.5 windows-amd64**, COMMITTED under `bin/` (`SURREAL_BINARY_PATH` provision.ts:24). There is NO runtime download — the runtime path only VERIFIES what's committed.
- `verifyBinary` (binary.ts:50): streamed SHA-256 vs the pinned hash (:16), rejects `BinaryIntegrityError` on mismatch/unreadable/malformed (:56/:68). `SurrealServer.start()` runs the **integrity gate FIRST — no process spawns on a bad binary** (provision.ts:114–115).
- Spawn: arg-array `spawn(binaryPath, args)` (:135), `surrealkv://${dataDir}` (:132, D-007), `--bind host:port` with port 0 = OS-assigned loopback (:117–120). Constructor **asserts loopback bind or throws** "refusing to expose a routable listener" (:83–84, D-025). `stop()` = taskkill tree (F-001, :193).

### 1.2 Client (F-014/F-042, D-016/D-026c)
- `Db.connect()` (client.ts:102): open+signin+USE all raced against `connectTimeoutMs` (default `DEFAULT_CONNECT_TIMEOUT_MS = 5000` :38) — the SDK can hang ~90s on a black-holed socket and connect sits on the boot path (:28–33). Timeout rejects honestly into the degraded-boot path (`runtime-init.initDbFromEnv`) which serves disconnected states, never hangs.
- **F-042 auth expiry:** `isAuthExpiredError` (:58) + single-flight re-signin (:76–81) — N concurrent queries hitting token expiry await ONE re-signin; creds never logged.
- **D-016 boundary:** all values `$param`-bound in the Db query helper; identifiers pass `validate.ts` — `TABLE_RE` (:14), `RECORD_ID_RE` (:17), `assertTableName` (:35) / `assertRecordId` (:51) fail LOUD with a "use $param" message, `assertRecordIdOfTable` (:~62) additionally pins the id's table so a cross-type id can't pass shape-checking.
- Least-priv intent: client signs in as whatever user is configured; header (:3–5) says runtime = scoped least-priv, root = provisioning/migrations only. **See §4 DBR-1 — the user is never DEFINEd.**

### 1.3 Migration runner (F-015)
- `Migration = {id, up}`; `runMigrations` (migrate.ts:49): idempotent `_migration` ledger (`DEFINE TABLE OVERWRITE` :33), skip-applied (:55), each remaining migration in its OWN transaction recording the ledger row on COMMIT (:62–63). **Half-applied ⇒ unrecorded ⇒ re-applied on re-run**; with the `IF NOT EXISTS`/`OVERWRITE` DDL discipline this is apply-twice + apply-over-half-applied safe.
- Idempotency toolkit: `defineFlagField` (:91, option<T>-or-DEFAULT discipline — no bare typed field stranding NONE rows), `guardedScan` (:118, `LET $c + IF $c>0` no-op-on-rerun), `backfillValueField` (:135, touch-UPDATE for fresh VALUE fields — the F-048 family).
- DDL runs ONLY under the root/provisioning connection (:16–17).
- Head: `m0080_maintenance_loops`, 80 migrations, all inline in `schema.ts` (2974 ln) — the SINGLE-FILE convention is deliberate (CLAUDE.md §0); no per-migration files.

### 1.4 `db:up` (scripts/db-up.ts) — idempotent, safe to re-run
① `SURREAL_WS` parse + **loopback fail-closed** (:72–75) → ② `alreadyListening()` 1.5s probe — reuse a live server, never double-spawn (:49/:84), else start one (:86–93) → ③ connect as ROOT (:37) → ④ `runMigrations(root, schemaMigrations)` (:105) + assert-loop `isApplied` over ALL migrations, prints `N/N` (:114/:124) → ⑤ prints the runtime `.env` block (:127–132).

### 1.5 Test server (`testserver.ts`) — the real-surreal answer to F-020
`startTestDb()` (:31): provisioned binary on `127.0.0.1:0` (no parallel-file collisions), mkdtemp data dir, fresh per-run namespace; `teardown()` (:44) drops namespace + stops + removes dir. `fixtureVector(seed, 1024)` (:71) for HNSW. This is why "a stubDb test does not validate SurrealQL" has no excuse — a live DB is one call away.

## 2. Normative invariants

1. **Never spawn an unverified binary** — the SHA-256 gate precedes spawn, fail-hard; the pinned hash lives beside the version pin (F-006/SEC-009).
2. **Every listener binds loopback**, asserted at construction AND at db:up (D-025); a routable bind refuses to boot.
3. **Boot-path connect is hard-bounded (5s)**; failure lands in the degraded-boot path serving honest disconnected states — never a hang, never a fabricated "connected" (F-014/F-008).
4. **DDL/migrations run as root only; runtime traffic runs as the least-priv user** (D-026c — see DBR-1 to make this real).
5. **Migrations are idempotent, transactional, ledger-recorded**; re-run and half-applied are both safe; every DEFINE is `IF NOT EXISTS`/`OVERWRITE`; new flag/VALUE fields use the toolkit (F-015/F-048).
6. **All values `$param`-bound; only regex-validated identifiers interpolate**, exclusively through the `validate.ts` chokepoint; table-pinned ids where the table is known (D-016).
7. **db:up never double-spawns** (probe-first) and always ends with the N/N assert.
8. **Tests touching SurrealQL run on the real test server** — stubDb never validates a query (F-020).
9. **Auth re-signin is single-flight** and credential-silent (F-042).
10. **The single-file migration convention stands** (schema.ts inline `mNNNN_` + `schemaMigrations`); no migrations directory, no per-migration files.

## 3. Config / env surface

`SURREAL_WS` (loopback-asserted) · `SURREAL_USER`/`SURREAL_PASS` (db-up prints the runtime block; dev currently root — DBR-1) · `bin/` committed binary + pinned SHA (binary.ts:15–16) · data dir (surrealkv).

## 4. Gaps → the hardening wave (`db-runtime-hardening`, gate:operator)

| id | gap (verified) | required behavior | shape |
|---|---|---|---|
| **DBR-1** | **Least-priv runtime user never DEFINEd.** client.ts honors any configured user, db-up.ts:131 prints `SURREAL_USER=root # dev: root; production: a scoped least-priv user` — but no migration/script anywhere runs `DEFINE USER` with scoped roles (scout: not found). A hostile/buggy runtime query today runs with ROOT authority — D-026c is aspirational. | Provisioning defines a scoped runtime user (DEFINE USER … ROLES, db-level not root-level, IF NOT EXISTS-idempotent; password from env/generated, never committed). db-up prints the runtime .env block pointing at it; docs + dev default flip to the scoped user; migrations keep root. F-042 re-signin verified against the scoped user's token duration. Real-surreal test: scoped user can CRUD product tables, CANNOT run DDL/DEFINE. | build (red-team — security boundary; small migration/provision step) |
| **DBR-2** | Binary download is out-of-band — provision only verifies what's committed; a clean machine can't auto-provision. | Documented constraint (deliberate): committed-binary + verify keeps the boot path network-free (F-014 discipline). RULE: any future download path MUST reuse `verifyBinary`'s pinned-SHA gate + official-source-HTTPS-only (D-006). No build now. | documented |
| **DBR-3** | `schema.ts` is 2974 ln / 80 inline migrations — authoring friction, merge-conflict risk. | Documented: the single-file convention is load-bearing (CLAUDE.md geography; tooling + tests assume it). Revisit only if two writers collide in practice. | documented |

## 5. Test coverage map

migrate.test.ts (646 ln, incl. apply-twice + half-applied), client.test.ts (305), provision/binary/validate/schema (279)/runtime-init/classify tests — all real-surreal where a query exists. **New tests required:** DBR-1 scoped-user privilege test (CRUD-yes/DDL-no) + db-up idempotent re-run with the user already defined.

## 6. DoD (D-038)

- [ ] DBR-1 lands: DEFINE USER idempotent (apply-twice + half-applied covered), privilege test green, F-042 path exercised as the scoped user, red-team pass (no privilege escalation via the runtime user; password never logged/committed).
- [ ] `npm run db:up` clean on the LIVE dev DB (81/81 after the new migration, if shipped as a migration).
- [ ] Gates green token-unset (F-029); devlog row.
