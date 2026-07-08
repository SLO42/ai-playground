# SECURITY-MODEL-SPEC — the consolidated perimeter (D-018 · D-024 · D-025 · D-026 · D-035a · D-036 + F-055)

**Status:** DRAFT (2026-07-08) · consolidates the locked security decisions into ONE testable model · covers the `auth` subsystem (no separate AUTH-SPEC) · queued `security-hardening-1` (gate:operator)
**One-liner:** the perimeter is layered and verified: loopback is THE boundary (D-025), the LAN login gate is casual-gating on top, machine callbacks carry their own constant-time boot-token auth (the F-055 invariant holds on all 4 exempt paths), origin-stamping makes steering unforgeable (D-035a), and untrusted content is screened + fenced fail-closed (D-026). Four findings survive, each with an exploit scenario: the spoofable Host-header loopback fallback, four stale "loopback-only" premise comments, the accepted plain-HTTP cookie risk, and the unverified runtime-DB grant matrix (DBR-1's other half).

Grounding: opus security scout pass 2026-07-08 (file:line verified; per the D-026 review rule every gap below carries a concrete exploit scenario). Code on branch `v2`.

## 0. The layered model (outermost first)

| layer | boundary | fails | cite |
|---|---|---|---|
| L0 | **Loopback bind** — every listener asserted 127.0.0.1 at boot; wildcard (0.0.0.0/::) is NOT loopback and refuses to boot | CLOSED (LoopbackBindError) | config/loopback.ts:56–83, bootstrapControlPlane :100–113 |
| L1 | **LAN login gate (m0071)** — casual gating over plain HTTP; loopback bypasses it | closed for external (401/303) | hooks.server.ts:441–476, auth/gate.ts |
| L2 | **Boot token (D-025)** — per-boot randomBytes(32), never persisted, env-distributed; constant-time compare; Host+Origin loopback checks | CLOSED (no server token ⇒ deny) | loopback.ts:88–90, hooks/ingest.ts:70–86 |
| L3 | **Origin stamping (D-035a)** — operator IFF control-endpoint AND valid token; immutable; only operator steers | CLOSED (→ agent, fenced) | channel.ts:207–210 |
| L4 | **Tool gates (D-018/D-024)** — permissions.deny primary (server-down-safe) + gate layer both paths | CLOSED (throw ⇒ DENY) | CLAUDE-CODE-HARNESS-SPEC §1.6 |
| L5 | **Capability allow-list (D-036/F-045)** — unknown id refuses the spawn | CLOSED | capabilities.ts:179 |
| L6 | **Content screen + fence (D-026)** — screened before embed/insert; fenced on every injection path; sentinels stripped at ingress | CLOSED (error ⇒ quarantined) | memory/screen.ts:224–269, memory/fence.ts:87–94 |
| L7 | **DB discipline (D-016/D-026c)** — $param values; validated identifiers only; least-priv runtime user (grant artifact pending, DBR-1) | LOUD (IdentifierError) | db/validate.ts, client.ts:4–5 |

## 1. The auth subsystem (the `auth` coverage row)

- **Handle gate** (hooks.server.ts:441–476): loopback → implicit authed (:448/:453); exempt paths first (:450); external non-exempt → DB credential read (error ⇒ fail-closed), cookie verify, `decideGate` — browser-GET redirects (303 /setup or /login), API/non-GET gets a plain 401 so SSE is never wrapped (F-010).
- **Credential** (auth/credential.ts): single row `app_auth:singleton`; scrypt-hashed password (salt 16B, hash 64B), random 32B HMAC signSecret; plaintext never stored/logged; `verifyPassword` constant-time.
- **Cookie** (gate.ts:30–36): httpOnly, SameSite=lax, `secure:false` (documented tradeoff — LAN login over plain HTTP), 30d; token = base64url(issuedAt).HMAC-SHA256; verify constant-time, length-guarded; `safeNext` (:43–48) kills open redirects.
- **Exempt paths** (gate.ts:117–126) — the F-055 invariant VERIFIED per path: `/api/hooks/*` ✓, `/api/gates/pretooluse` ✓ (fails CLOSED — the one safety path), `/api/memory/pull` ✓, `/api/peer/send` ✓ — all four enforce `authorizeHookRequest` themselves. `/api/sessions/[id]/control` deliberately NOT exempt (the 0003dc1 fix), asserted by gate.test.ts:108–117.
- **Full API classification (9 routes):** 4 exempt+own-auth (above); 5 login-gated with no own token — control, briefs, events (the ONE SSE), file-snapshot, notifications. No exempt-UNPROTECTED endpoint exists.
- **F-055 history both fixes verified in place:** control-endpoint exemption removed (0003dc1, header rationale at control/+server.ts:10–16); UI arm routes through `armAutonomousLoop` (4a9a7fb; loops + project routes + tests).

## 2. Normative invariants (the model's contract)

1. **Loopback is THE security boundary**; the login gate is casual-gating over plain HTTP and never a TLS substitute (credential.ts:10–14). Preconditions: single trusted operator, no untrusted-LAN exposure.
2. **A routable/wildcard bind fails to boot** — asserted for every listener (sveltekit, surrealdb, ollama), no exceptions.
3. **Boot token discipline:** per-boot random, never persisted, never in a command string (env only), compared constant-time everywhere, never handed to the agent runtime.
4. **The F-055 exempt-path invariant:** every `isExemptPath` machine callback enforces `authorizeHookRequest` itself; any handler that stamps operator origin or skips credentials stays behind the login gate. New exemptions require a per-path own-auth test.
5. **Origin is server-stamped, immutable, content-independent; only `origin=operator` steers**; a peer/agent push can never present the token (peer/send wires viaControlEndpoint:false).
6. **All untrusted content is screened BEFORE storage/embedding and fenced on EVERY injection path** (recall/tier0/user-model/learned-skill/channel/peer); embedded sentinels stripped at ingress; screen and streaming scrubber fail CLOSED (error ⇒ quarantine/hold).
7. **Analytics hooks never carry a safety decision** (D-019 best-effort `{}`); the gate hook path is the only fail-closed hook.
8. **DB: $param for every value; only regex-validated identifiers interpolate (one chokepoint); root for provision/migrate only; the runtime user is least-priv with a TESTED grant matrix** (pending DBR-1).
9. **When a gate's environmental premise changes (loopback→LAN, single→multi-user), every path that relied on the old premise is audited** — the F-055 lesson, now a standing rule.
10. **Every security finding requires a concrete exploit scenario; VERIFIED/UNVERIFIED by code tracing; sub-threshold findings land in an appendix, never silently dropped** (D-026 additive note — governs the recurring security-review wave too).

## 3. Findings → the hardening wave (`security-hardening-1`, gate:operator)

| id | finding (+ exploit scenario) | required behavior | shape |
|---|---|---|---|
| **SEC-1** | **Host-header loopback fallback is spoofable** (hooks.server.ts:436–439). Scenario: an adapter change leaves `getClientAddress()` unpopulated → a LAN attacker sends `Host: 127.0.0.1` → treated as loopback → full login-free control-plane access. Latent today (getClientAddress reliable under Node/Vite). | `getClientAddress()` is authoritative; when it is unavailable AND the server is LAN-bound, the fallback DENIES (fail-closed) instead of weakening to Host-header trust. Loopback-bound servers may keep the lenient fallback (unreachable from LAN by L0). Regression test simulating a missing client address. | build (small; red-team) |
| **SEC-2** | **Stale "loopback-only enforced at server bind" comments** on 4 login-gated endpoints (events:11, notifications:9, briefs, file-snapshot:8). Scenario: a dev trusts the comment, adds a state-changing branch assuming no LAN reachability — but m0071 made these LAN-exposable behind the casual cookie. | Correct the 4 comments: protection = login gate + SameSite, NOT bind. The F-055 premise-drift class, caught at comment level. | build (mechanical, haiku-tier) |
| **SEC-3** | **`secure:false` cookie + plain HTTP** (gate.ts:34). Scenario: on a LAN bind, cookie + password travel cleartext; a same-segment sniffer replays the cookie for operator-browser access. | ACCEPTED RISK, stated: the documented casual-gating tradeoff under invariant §2.1's preconditions. Revisit trigger: multi-user, untrusted LAN, or TLS termination arriving. No build. | documented |
| **SEC-4** | **Runtime DB user grant scope unverified** — the client seam is correct (client.ts:4–5) but no DEFINE USER/grant artifact exists (adapters-db scout: not found; dev prints SURREAL_USER=root). Scenario: a SurrealQL-injection or buggy loop query runs with root authority — full DDL/write reach. | Owned by `db-runtime-hardening` DBR-1; this spec adds the acceptance bar: an explicit TESTED grant matrix (runtime user: product-table CRUD yes, DDL/DEFINE/USER no; test both directions). | cross-ref (DBR-1) |

## 4. Test coverage & the standing audit

Auth: gate.test.ts (incl. the not-exempt control assertion), credential constant-time paths. Fence/screen: covered per MEMORY-SPEC suites (stripEmbeddedSentinels ingress regression from wave-v2.2b-b B10). **New tests:** SEC-1 missing-client-address deny; SEC-2 none (comments); DBR-1 grant matrix. The **recurring security-review wave** (D-026 additive note, prompt at docs/prompts/security-review-wave.md) re-audits this perimeter on cadence — this spec is its baseline document; findings append here.

## 5. DoD (D-038)

- [ ] SEC-1 lands with the simulated-missing-address regression + red-team pass (spoofed Host on LAN-bound config denied; loopback-bound behavior unchanged).
- [ ] SEC-2 comments corrected (4 files, comment-only diff — check EOL churn F-054).
- [ ] SEC-3 accepted-risk paragraph referenced from ARCHITECTURE §security posture.
- [ ] No migration; gates green token-unset (F-029); devlog row.
