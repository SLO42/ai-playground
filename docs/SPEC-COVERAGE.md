# SPEC-COVERAGE — the "spec everything" campaign tracker

**Goal (operator, 2026-07-07):** every Atelier subsystem has a dedicated spec. This is the
burn-down. Backend subsystems = `F:\code\ai-playground-v2\src\lib\server\<dir>`; specs = `docs/*.md`.
Coverage honesty: "mentioned in ARCHITECTURE/DATA-MODEL" = **PARTIAL**, not FULL.

**Tally (2026-07-08): 16 FULL · 20 PARTIAL · 3 NONE.** New specs written this session are FULL.

## Coverage

| subsystem | governing spec(s) | coverage |
|---|---|---|
| memory | MEMORY-SPEC, MEMORY-UTILIZATION-SPEC, MEMORY-CURATOR-SPEC, COGNITIVE-ARCHITECTURE | FULL |
| workforce | WORKFORCE-SPEC, HR-RECRUITER-SPEC, PER-HIRE-SOUL-SPEC | FULL |
| create | CREATE-SPEC | FULL |
| concierge | CONCIERGE-BROKER-SPEC, COGNITIVE-ARCHITECTURE | FULL |
| cannibalize | CANNIBALIZE-SPEC | FULL |
| skills | SKILL-HARVEST-SPEC | FULL |
| peer | CONVERSATION-LAYER-SPEC, PEER-MESSAGE-SPEC | FULL |
| scene | MEMORY-SCENE-SPEC | FULL |
| atelier | GLOBAL-TRANSCRIPT-SPEC | FULL |
| observability | USAGE-OBSERVABILITY-SPEC | FULL |
| loops | LOOP-ENGINEERING, MAINTAIN-SPEC | FULL |
| release | RELEASE-SPEC | FULL |
| agent | MEMORY-SPEC §4/§8/§10 | FULL |
| home | UI-SPEC §6 | FULL |
| notifications | UI-SPEC | FULL |
| orchestrator | ORCHESTRATOR-SPEC (2026-07-08); ARCHITECTURE §2.2 | FULL |
| **projects** | ARCHITECTURE/DATA-MODEL; PM specs adjacent | **PARTIAL** |
| **claude-code** | ARCHITECTURE (runtime); F-046 lives here | **PARTIAL** |
| **adapters** | D-037; per-adapter specs but not the framework contract | **PARTIAL** |
| **db** | DATA-MODEL (schema only); client/binary-verify/runner code-only | **PARTIAL** |
| sessions | D-011; WORKSPACE-ISOLATION peripheral | PARTIAL |
| analytics | ARCHITECTURE §2.4; "analytics first-class" mandate, no ANALYTICS-SPEC | PARTIAL |
| scanner | ARCHITECTURE §2.7; no dedicated spec | PARTIAL |
| sync | D-037; no dedicated spec | PARTIAL |
| cc-config | D-010; F-045 class | PARTIAL |
| config | ARCHITECTURE §5/§6, D-025 | PARTIAL |
| runtime | MODEL-BENCHMARK-SPEC, ARCHITECTURE | PARTIAL |
| events | ARCHITECTURE §2.11 | PARTIAL |
| importer | IMPLEMENTATION-PLAN §1.7 | PARTIAL |
| providers | ARCHITECTURE, MODEL-BENCHMARK-SPEC | PARTIAL |
| routing | ARCHITECTURE §2.5, D-020 | PARTIAL |
| tasks | ARCHITECTURE/DATA-MODEL | PARTIAL |
| workflows | D-013, DATA-MODEL §4.11 | PARTIAL |
| hooks | D-019, ARCHITECTURE | PARTIAL |
| agent-library | AGENTS.md (listing, not design) | PARTIAL |
| harness | ARCHITECTURE (implicit) | PARTIAL |
| **auth** | none dedicated (F-055 gate class) | **NONE** |
| **services** | none | **NONE** |
| perf | none (trivial) | NONE |

## Next specs to write (ranked by undocumented design complexity)

1. ~~ORCHESTRATOR / WORK-QUEUE-SPEC~~ — **DONE 2026-07-08** (`ORCHESTRATOR-SPEC.md`; hardening wave queued `orchestrator-hardening`).
2. **PROJECTS data-plane spec** — biggest subsystem (18.2k loc), only DATA-MODEL tables + adjacent PM specs.
3. **CLAUDE-CODE-HARNESS-SPEC** — spawn / `agent_slot` / session-keyed isolated config (F-046); trickiest concurrency+security.
4. **ADAPTER-FRAMEWORK-SPEC** — the D-037 contract (how an adapter registers, fail-closed) — NOTE: partly covered in RELEASE-SPEC §1; may just need extraction.
5. **DB-RUNTIME-SPEC** — binary SHA-256 verify (F-006), bounded connect (F-014), migration runner idempotency (F-015) — the most-recurrent-fails area.
6. **cc-config / capability-catalog spec** — F-045 fail-closed catalog class.
7. **scanner**, 8. **sync**, 9. **services** (NONE), 10. **auth** (NONE, security-critical — pairs with the held SECURITY-MODEL spec).
- Honorable mention: **ANALYTICS-SPEC** — 4.4k loc + "analytics is first-class" mandate, unspecced.

## Also held (from the docs-gap audit, not subsystem-scoped)
- **COST-GOVERNANCE-SPEC** (P1) · **SECURITY-MODEL-SPEC** (P1, consolidates D-018/024/025/026/036 + F-055).
- P2/P3: self-hosting D-040, BL-GUX-2 causality, BL-1 image-gen, BL-2 marketing, BL-2b scalar.

## Specs written 2026-07-07 (this session)
PER-HIRE-SOUL, GAME-VERIFY-IN-LOOP, MEMORY-CURATOR, CONCIERGE-BROKER, RELEASE, MAINTAIN (+ decision D-041). All on v2-main, pushed.
