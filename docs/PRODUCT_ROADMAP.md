# Product Roadmap

> Updated: 2026-03-09

ai-playground is a project lifecycle platform — create, develop, maintain, and release software projects of any kind. Claw is the automation engine underneath.

---

## Current State

| Phase | Coverage | What Works | Key Gaps |
|-------|----------|------------|----------|
| **Create** | 70% | 6 templates, import with 55+ pattern detection, git init, GitHub repo | Service auto-start not wired, settings PUT missing, Node.js-biased templates |
| **Develop** | 85% | Task > Agent > Code > Commit, round-robin scheduling, session pooling, OpenClaw routing, GitHub sync | No task dependencies, no post-commit tests, no review agent, follow-ups = documenter only |
| **Maintain** | 40% | Health scanning, memory graph, UX inspector (2x/day), analytics, notifications | No dependency updates, no incident mgmt, no debt tracking, security = detection only |
| **Release** | 5% | Detects release tools (semantic-release, changesets, GitHub Actions) | No versioning, no changelog, no release creation, no deployment |

---

## Phase 1: Close the Development Loop

High value, builds on existing architecture.

### 1.1 Task Dependencies
- Add `blockedBy: string[]` to Task type
- Heartbeat skips tasks whose blockers aren't completed
- UI: dependency picker on task create/edit
- Files: `types/tasks.ts`, `task-store.ts`, `heartbeat/index.ts`, project task pages

### 1.2 Post-Commit Test Runner
- After agent commits, run project's test command from config
- Capture exit code + output
- On failure: auto-create fix task with test output
- Files: new `heartbeat/post-test.ts`, modify `post-task.ts`

### 1.3 Post-Commit Review Agent
- Spawn review agent for multi-file commits (3+ files)
- Review diff for bugs, security, code quality
- Create fix tasks for findings
- Files: expand `post-task.ts` follow-up types

### 1.4 Wire Project Settings Save
- Add PUT endpoint for `/api/projects/[id]/settings`
- Connect existing save button
- Files: `routes/api/projects/[id]/settings/+server.ts`

---

## Phase 2: Release Management

Biggest product gap.

### 2.1 Release Service Module
- New `lib/server/release-manager.ts`
- Changelog generation from git log (conventional commits)
- Semver bumping (major/minor/patch from commit types)
- GitHub release creation via `gh release create`

### 2.2 Release Page
- New route: `/projects/[id]/releases`
- List past releases (git tags + GitHub releases)
- "Create Release" flow: pick version > preview changelog > confirm

### 2.3 Release Agent
- Claw agent for release preparation
- Runs tests, generates changelog, bumps version, creates PR
- Triggered manually or on schedule

---

## Phase 3: Strengthen Maintenance

### 3.1 Dependency Health
- Periodic `npm audit` / `pip audit` / `cargo audit` per project
- Surface outdated packages with severity
- Auto-create update tasks for critical vulnerabilities

### 3.2 Auto-Restart on Service Failure
- Health check detects service down > auto-restart (configurable)
- Max restart attempts before alerting
- Service dependency ordering

### 3.3 Test Coverage Tracking
- Parse coverage reports after test runs
- Track trends over time
- Alert on coverage drops

---

## Phase 4: Expand Project Creation

### 4.1 More Templates
- Go, Rust, Java/Kotlin, Ruby, PHP, and more
- Template parameter system ("include ESLint?", "include Docker?")
- The template system is already extensible — each template is a function returning `Record<string, string>`

### 4.2 Cross-Platform Path Handling
- Replace hardcoded `F:\code` with configurable workspace paths
- Use `path.join()` consistently
- Support multiple workspaces

### 4.3 Wire Service Auto-Start
- On project creation, actually start selected services
- Health check after start

---

## Phase 5: Scale & Polish

### 5.1 Monorepo/Workspace Awareness
- Detect yarn/pnpm/npm workspaces
- Inter-package dependency graph
- Coordinated task scheduling across packages

### 5.2 Environment Management
- Define environments per project (dev/staging/prod)
- Environment-specific config and secrets
- Deployment tracking

### 5.3 CI/CD Pipeline Visibility
- Read GitHub Actions workflow status
- Show pipeline runs in project dashboard
- Trigger workflows from UI

---

## Execution Order

| # | Item | Impact | Effort | Depends On |
|---|------|--------|--------|------------|
| 1 | Task dependencies (1.1) | High | Small | — |
| 2 | Wire settings save (1.4) | Medium | Tiny | — |
| 3 | Post-commit test runner (1.2) | High | Medium | — |
| 4 | Post-commit review agent (1.3) | Medium | Medium | — |
| 5 | Release service module (2.1) | High | Large | — |
| 6 | Release page UI (2.2) | High | Medium | 2.1 |
| 7 | Auto-restart services (3.2) | Medium | Small | — |
| 8 | Dependency health (3.1) | Medium | Medium | — |
| 9 | More templates (4.1) | Medium | Medium | — |
| 10 | Cross-platform paths (4.2) | Medium | Small | — |
| 11 | Release agent (2.3) | Medium | Medium | 2.1 |
| 12 | Monorepo support (5.1) | Low | Large | — |

Items 1-4 can be worked in parallel. Items 5-6 are the big lift. Items 7-12 are independent.
