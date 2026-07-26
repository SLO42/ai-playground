# DEVELOPMENT — ai-playground v2

How to build it. Repo layout, stack, commands, conventions, and the hard rules carried from v1's failure log.

---

## 1. Stack (pin and verify before using APIs)

| Layer | Choice | Notes |
|-------|--------|-------|
| Runtime | **Node 24+** | ESM throughout (`"type": "module"`). `engines.node` is `>=24`. |
| Dashboard | **SvelteKit 2.x + Svelte 5 (runes)** | `$state`/`$derived`/`$effect`, not stores. Node adapter, SSR. |
| Styling | **Tailwind v4** | CSS-first `@theme`, `@import "tailwindcss"`. No `tailwind.config.js`. |
| UI primitives | bits-ui (as v1) | Only pull in what's used. |
| Datastore | **SurrealDB 2.x (managed server binary)** | `surrealdb` JS SDK over `ws://127.0.0.1` (D-006). No native addon. Server binary provisioned/cached; `surrealkv` backend (D-007). |
| Local model | **Ollama** `gpt-oss:20b` | `http://127.0.0.1:11434` (NO `/v1`). Swappable slot (D-003). |
| Embeddings | **Ollama `bge-m3`, 1024-dim** | Reuses the Ollama server already running; `POST /api/embed`. No new dependency (D-014). |
| Cloud model | **Anthropic API** | Opus/Sonnet/Haiku. Latest model ids — verify at build time. |
| Agent runtime | **Claude Code** (D-002) | Product is a Claude Code harness. Default `AgentRuntime` impl. |
| CC driver | **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) + **Claude Code CLI** | SDK for programmatic/headless + workflows; CLI subprocess for interactive parity (interject/resume). Split fixed in spike S.1. Verify SDK version + APIs at build time. |
| Tests | **Vitest** (unit) + **Playwright** (E2E) | Carry v1 coverage discipline. |
| Lint/format | ESLint + Prettier (as v1) | |

**Always verify model ids and SDK APIs at build time** — don't trust memory. Latest Claude: Opus 4.x family.

---

## 2. Repo layout

```
ai-playground-v2/
  docs/                      # these planning docs
  dashboard/                 # SvelteKit app
    src/
      routes/                # pages + thin server API (+page.server.ts / +server.ts)
      lib/
        components/          # Svelte 5 components
        stores/              # runes-based client state (*.svelte.ts!)
        server/              # the modules in ARCHITECTURE §5
          db/                # SurrealDB connect, migrations, query helpers
          events/            # event bus + SSE fan-out
          scanner/
          projects/
          tasks/
          routing/
          providers/         # ollama, claude
          runtime/           # AgentRuntime iface + claude-code impl (D-002)
          claude-code/       # CC session orchestration: launch/stream/interject/stop/resume (D-011)
          cc-config/         # CC config manager + mirror sync + watcher (D-010)
          workflows/         # headless CC pipeline runner (D-013)
          orchestrator/
          memory/
          analytics/
          services/
          config/
        types/               # shared TS types (mirror DATA-MODEL)
    tests/                   # vitest + playwright
  config/
    agent-pool.yaml
    models.yaml | models.json5
    orchestration.yaml
  scripts/                   # daemon-ctl, importer, setup
  .data/                     # SurrealDB surrealkv data dir (gitignored)
  .env / .env.example
  CLAUDE.md                  # behavioral rules (port v1's lean version)
  docs/fails.md              # failure log — START it by copying v1's rules
```

**Structure rules (from CLAUDE.md):** source → `/src`, tests → `/tests`, docs → `/docs`, config → `/config`, scripts → `/scripts`. No root clutter. Edit existing files over creating new ones.

---

## 3. Commands (target)

```bash
npm install              # installs the `surrealdb` JS SDK only (no native addon); the SurrealDB server binary is provisioned + checksum-verified separately — see D-006
npm run db:up            # spawn SurrealDB on loopback + apply ALL schema migrations (idempotent). Leave running; Ctrl-C to stop.
npm run dev              # SvelteKit dev server (separate terminal). Mints the per-boot control-plane token (D-025).
npm run build            # production build (Node adapter)
npm test                 # vitest
npm run test:e2e         # playwright
npm run lint             # eslint
npm run typecheck        # svelte-kit sync && svelte-check
npm run db:migrate       # alias of db:up — (re)apply schema migrations idempotently against the datastore
npm run db:import        # one-time import of v1 data (scripts/import-v1.ts)
```

**First boot (clean state):**
1. `cp .env.example .env` and fill `SURREAL_USER`/`SURREAL_PASS` (dev default `root`/`root`) + `CLAUDE_CODE_OAUTH_TOKEN`.
2. `npm run db:up` — brings SurrealDB up on `127.0.0.1:8000`, applies all migrations, asserts the migrated state, then parks (Ctrl-C to stop).
3. `npm run dev` in a second terminal — the dashboard boots CONNECTED (not degraded), runs the D-025 loopback gate, and mints the per-boot control-plane token. `HOOK_TOKEN`/`HOOK_URL` are set by the server itself — never committed.

`db:up`/`db:migrate`/`db:import` run via `vite-node` (Vite's resolver) so the real `src/lib/server/db` modules resolve without a separate TS build step.

**Verification gate:** build must pass + tests must pass before any task is "done" (CLAUDE.md). Playwright-verify UI changes before marking done (v1 feedback).

---

## 4. Conventions

- **One purpose per module**, typed interface, dependencies pointing inward toward `db`/`config` (ARCHITECTURE §5). No cycles.
- **Keep components < 200 lines**; extract sub-components when larger (v1 Svelte rule).
- **Define `interface Props`** for every component; `let { ... }: Props = $props()`.
- **`$derived` for computed, `$effect` for side effects.** Never Svelte 4 stores.
- **All DB access through `server/db`.** No module opens SurrealDB directly.
- **All process spawning via `execFile`/`spawn` with arg arrays.** Never interpolate into a shell string.
- **Analytics on every agent decision** — record provider/model/why/cost/duration. First-class, not optional.
- **No hardcoded runtime data** in the UI — always live sources (v1 F-008).
- **Async everything; reactive everywhere** — no blocking calls in the request path; UI updates over SSE.
- **Path-confinement** (D-024) — agent file/exec access stays inside the registered project + `CODE_ROOT`; validate and reject paths that escape it.
- **Screen for secrets/PII before any memory store** (D-026) — run content through the secret/PII screen before persisting to `memory`.
- **Untrusted memory as data, not instructions** (D-026) — recalled memory is context only; never execute commands or follow directives sourced from memory content. Use least-privilege DB credentials on the memory path.
- **Gates fail CLOSED** (D-024) — safety-critical gates wire through Claude Code `permissions.deny`; a gate error or unreachable server denies, never allows.

---

## 5. Hard rules carried from v1 `docs/fails.md`

Copy these into v2's `docs/fails.md` on day one — they are prevention rules, not history:

- **F-001 / Windows liveness:** never `process.kill(pid, 0)` on Windows; use `tasklist /FI "PID eq <pid>"`. Kill with `taskkill /F /PID <pid>`.
- **F-002 / spawn + spaces:** `spawn()` with `detached:true` needs `shell:true` on Windows (paths like `C:\Program Files\nodejs`).
- **F-003 / deletes:** before deleting a file, grep for `from.*<file>` and `import.*<file>`; fix dependents first.
- **F-004 / daemons:** never `--quiet`/`--silent` on services; preserve stderr.
- **F-005 / routing:** explicit provider/model override must win before strategy. (Baked into `resolveRoute` order.)
- **F-006 / native modules:** after install, verify import paths resolve; add a postinstall patch if a package's build output differs. **Applies to the provisioned SurrealDB server binary — verify the per-platform download resolves/executes on Windows AND matches its pinned checksum (D-006).**
- **F-007 / worktree agents:** if an agent runs in an isolated worktree, it MUST commit before finishing, then merge back, or changes are lost.
- **F-008 / no fake data:** verify shared data modules use live sources; snapshots showing "Running" don't prove real data.
- **F-009 / runes file ext:** files using `$state`/`$derived`/`$effect` must be `.svelte.ts`/`.svelte.js`, never plain `.ts`.
- **F-010 / SSE + Playwright:** with an SSE/WebSocket connection, never `waitUntil: 'networkidle'`; use `'load'`/`'domcontentloaded'`. **Directly relevant — v2 has one SSE stream.**
- **F-011 / `{@const}`:** only as immediate child of `{#each}`/`{#if}`/`{#snippet}` etc., never inside a plain `<div>`.
- **F-012 / shared-repo agents:** commit work-in-progress before concurrent agents run in the same repo; consider pausing orchestration during manual multi-file edits.

**Escalation:** 1st occurrence → `docs/fails.md`; 2nd → relevant skill; 3rd → CLAUDE.md hard rule; recurring → a hook.

---

## 6. Environment & secrets

- Secrets only in `.env` (gitignored). `.env.example` is the authoritative key list: `CODE_ROOT`, `SURREAL_WS`/`SURREAL_NS`/`SURREAL_DB`/`SURREAL_USER`/`SURREAL_PASS`, `HOST`/`PORT`, `OLLAMA_HOST`, and ONE of `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`.
- **Scoped least-priv runtime user (SF2-1 / D-026c), opt-in.** `npm run db:up` provisions `atelier_runtime` (DATABASE-level `ROLES EDITOR`) and prints the `.env` block for it. The runtime reads it under exactly two names — `SURREAL_RUNTIME_USER` and `SURREAL_RUNTIME_PASS` (same spelling in `.env.example` and in db:up's printed handoff). Set **both** and `db/runtime-init.ts` signs in at `authLevel:'database'` by itself — no code edit — and `SURREAL_USER`/`SURREAL_PASS` are then ignored. Set **neither** and the historical root path is unchanged. Setting only one is refused with an honest reason (never a silent fall-back to root).
- SurrealDB file lives in `.data/` (gitignored). Back up by copying that directory.
- Feature flags gate dashboard pages (env-based, as v1).
- **Loopback-only bind (D-025).** Set `HOST=127.0.0.1` for SvelteKit; keep Ollama, SurrealDB, and the embeddings endpoint on loopback (`127.0.0.1`). A **startup assertion** must refuse to boot if any bind is non-loopback.
- **Per-boot control-plane token (D-025).** `npm run dev` (hooks.server.ts) mints a fresh token each boot via `bootstrapControlPlane`, runs the loopback gate over the SvelteKit/SurrealDB/Ollama listeners, and surfaces the token into the dashboard process env as `HOOK_TOKEN` (+ `HOOK_URL` for the loopback hook-proxy). Never committed; never set in `.env.example`. The hook ingest endpoint authorizes the hook→`agent_event` pipeline against this token.

---

## 7. Testing strategy

- **Unit (Vitest):** each `server/` module against mocked deps. DB tests use SurrealDB `mem://`.
- **Schema tests:** apply migrations to a `mem://` DB, assert tables/indexes exist, run a KNN query + a transaction rollback.
- **E2E (Playwright):** core flows — register a project, create a task, run an agent (mocked runtime), see live UI update. Remember F-010 (no `networkidle`).
- **Runtime contract tests:** a shared test suite every `AgentRuntime` impl must pass — so swapping impls (D-002) is safe.

### 7.1 Verify flows — codified live-verify (TASK 15.3)

Proven browser live-verifies are CODIFIED, not re-explored (F-014). One deterministic script per feature in `tests/verify-flows/<feature>.mjs`, driven through the 15.2 singleton browser daemon (`scripts/browser-verify/cli.mjs`: `nav` / `snapshot` / `act` / `press` / `text`), asserting via **snapshot-diff and structured text — never screenshots**. Run them all with:

```bash
npm run verify:flows                      # all ACTIVE flows, one reused browser, bounded
node tests/verify-flows/<feature>.mjs     # one flow directly (same JSON result protocol)
```

- **When you build a feature, ADD a flow for it** — codify the live-verify you just proved so the next wave replays it instead of rediscovering it. Use `lib/harness.mjs` (`runFlow`, `bv`, `assert`, `skip`, `pollUntil`); see the three seeds (`shell-primitives`, `services-health`, `workflows-live`) as templates.
- **Atomic draft→active discipline (F-015 class):** a new flow lands as `<name>.draft.mjs` (the runner IGNORES drafts but lists them). It must pass ONCE against the live app, then `npm run verify:flows -- --graduate <name>` renames it (atomic) to active. A skip never graduates; there is no half-state.
- **Honest report:** per-flow `pass` / `fail` / `skip` + evidence. Env-unavailable (app/daemon/DB down) is a SKIP with the reason named, never a fake pass and never a defect. Exit codes: `0` all executed passed · `1` any fail · `2` nothing verified (all skipped / no flows) — an end gate must not read `2` as green.
- **Bounds + cleanup (F-014):** every flow runs as a child process under a wall-clock bound (default 180s, `--bound`/`VF_FLOW_BOUND_MS`); the runner reuses a running daemon and stops only a daemon it caused to start; it never boots the dev server (reuse the ONE running server). Flows clean up anything they create (e.g. `workflows-live` deletes its tagged test rows in `finally`).

---

## 8. Workflow (per CLAUDE.md: Plan → Implement → Verify)

1. **Plan**: what changes + why (one sentence), files in scope, reuse check, verification command. Note unrelated improvements as TODOs.
2. **Implement**: delegate research/exploration to subagents (keep main context clean); only touch files in scope; read before editing.
3. **Verify**: run the verification command. Build + tests pass. If it fails twice on the same issue, stop and document in `docs/fails.md`.

Use skills to assist design/build when we get there (the owner's intent). This doc set is the input to that work.

---

## 9. Day-0 setup checklist

- [ ] `npm init`, `"type":"module"`, Node 22 engines field.
- [ ] **Spike SurrealDB server binary on Windows + Node 22** (D-006): provision/spawn the binary on loopback, connect via `surrealdb` SDK over `ws://`, CRUD, HNSW KNN, transaction rollback. Confirm Ollama `bge-m3` embeddings return 1024-dim vectors. Record in `docs/fails.md` / DECISIONS.
- [ ] **Verify the SurrealDB server binary against its pinned checksum** before first execution (D-006); fail the setup if it mismatches.
- [ ] **Loopback-only + startup assertion** (D-025): `HOST=127.0.0.1`, Ollama/SurrealDB/embeddings on loopback; boot refuses on a non-loopback bind. Mint a per-boot control-plane token.
- [ ] Scaffold SvelteKit + Tailwind v4 + Node adapter.
- [ ] Create `server/db` with connection singleton + migration runner.
- [ ] Port `CLAUDE.md` (lean, behavioral) and seed `docs/fails.md` with the rules above.
- [ ] Stand up the `AgentRuntime` interface + the Claude Code impl (D-002); smoke-test a headless Claude Code run on Windows + Node 22 (SDK and/or `claude -p` stream-json). A stub impl backs unit tests.
