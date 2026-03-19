# v1.0 Testing Guide

> Manual validation checklist for every feature before tagging v1.0.
> Work through each section with the dashboard running. Mark pass/fail.

---

## Prerequisites

Before testing, ensure these services are controllable:

```bash
# Start dashboard only (heartbeat OFF for safe testing)
cd dashboard && npm run dev

# In a separate terminal, start Ollama (if testing chat)
ollama serve

# Optional: start OpenClaw gateway (if testing gateway routing)
npm run openclaw:start
```

**First thing to do**: Go to Settings → Heartbeat → disable Agent Spawning and Task Scanning. Leave Health Checks on. This prevents Claw from auto-spawning agents while you test.

---

## 1. Global Pages (21 routes)

Open each page, verify it loads real data (not blank/placeholder), and has no console errors.

| # | Route | What to Check | Expected State | Pass? |
|---|-------|--------------|----------------|-------|
| 1.1 | `/` (Home) | Metric cards load (tasks, agents, sessions), recent activity list, service status pills | Cards show numbers (even if 0), no loading spinners stuck | |
| 1.2 | `/chat` | Chat input renders, provider selector works, can type a message | If Ollama running: get a response. If not: graceful error | |
| 1.3 | `/inbox` | Notification list loads, filter buttons work | May be empty — should say "No notifications" not error | |
| 1.4 | `/tasks` | Task list loads, pagination works, search filters | Create a task → appears in list. Edit → persists on refresh | |
| 1.5 | `/models` | Model cards show (Ollama models if running, config models always) | VRAM gauge renders, model details expand | |
| 1.6 | `/agents` | Agent pool table, analytics summary, project associations | Pool stats load. If no agents running: show empty state | |
| 1.7 | `/channels` | Channel cards (dashboard, twitch), status indicators | At least dashboard channel shows. Status dots render | |
| 1.8 | `/apps` | MCP server list, tool catalog | Lists configured MCP servers from .mcp.json | |
| 1.9 | `/memory` | Memory entries, namespace distribution, BubbleGraph | Graph renders (or "No graph data" empty state). Entries list | |
| 1.10 | `/security` | Audit status, findings table, policy display | Shows scan results or "No findings" | |
| 1.11 | `/hooks` | Hook registry table, worker stats, learning config | Shows configured hooks or empty state | |
| 1.12 | `/reports` | Report list, generation controls | Can generate a new report. Shows in list after | |
| 1.13 | `/sessions` | Session list with previews | Shows chat sessions from .playground/chats/ | |
| 1.14 | `/services` | Service cards with health status, start/stop buttons | Ollama: green if running. Gateway: shows status. Daemon: shows status | |
| 1.15 | `/settings` | Settings tabs load, all sections render | Each tab has content, not blank | |
| 1.16 | `/about` | Platform info, tech stack, version | Static content renders | |
| 1.17 | `/notifications` | Redirects to `/inbox` | 302 redirect works | |
| 1.18 | `/projects` | Project cards load from registry | If no projects: "No projects" + create button. If projects: cards with name/path/tech | |
| 1.19 | Error page | Navigate to `/nonexistent` | 404 page with "Page Not Found", back button | |
| 1.20 | Loading states | Reload any data-heavy page | Skeleton shimmer animations show briefly before data loads | |
| 1.21 | `/memory` graph toggle | Settings → Memory → disable graph | Graph section shows "disabled" banner instead of graph | |

---

## 2. Project Sub-Routes (13 routes)

**Setup**: You need at least one project in the registry. If none exist, create one:
1. Go to `/projects` → "Create Project"
2. Pick any template (e.g., "Node.js")
3. Give it a name and path

Then navigate to that project and test each sub-route:

| # | Route | What to Check | Expected State | Pass? |
|---|-------|--------------|----------------|-------|
| 2.1 | `/projects/[id]` | Project overview with health, metrics, tech stack | Name, path, detected tech all render | |
| 2.2 | `/projects/[id]/about` | Tech stack detection, dependencies, timeline, scripts | Shows detected language/framework, package.json scripts | |
| 2.3 | `/projects/[id]/tasks` | Project-scoped task list | Only tasks for this project. Can create new task | |
| 2.4 | `/projects/[id]/agents` | Project-scoped agent pool | Agent slots for this project. May be empty | |
| 2.5 | `/projects/[id]/releases` | Release list + create flow | Shows git tags/GitHub releases. "Create Release" button | |
| 2.6 | `/projects/[id]/memory` | Project-scoped memory entries + graph | Filtered to project. Graph renders or empty state | |
| 2.7 | `/projects/[id]/services` | Project-scoped services | Detected services (dev server, build, test) | |
| 2.8 | `/projects/[id]/security` | Project-scoped audit findings | Findings or "No findings" empty state | |
| 2.9 | `/projects/[id]/hooks` | Project-scoped hooks | Hooks for this project or empty state | |
| 2.10 | `/projects/[id]/channels` | Channels interacting with project | Channel list or empty state | |
| 2.11 | `/projects/[id]/models` | Model routing for this project | Routing strategy, model chain, usage stats | |
| 2.12 | `/projects/[id]/pipelines` | CI/CD pipeline status | Detected CI configs. GitHub Actions runs if repo linked | |
| 2.13 | `/projects/[id]/sessions` | Project-scoped session history | Sessions filtered to project | |
| 2.14 | `/projects/[id]/settings` | All fields save and load | Change name → save → refresh → name persists. Test: build cmd, test cmd, topology, maxAgents, environments | |

---

## 3. Settings Persistence (all 9 endpoints + project settings)

For each settings section: change a value → save → hard refresh (Ctrl+Shift+R) → verify it persisted.

| # | Setting | How to Test | Expected | Pass? |
|---|---------|------------|----------|-------|
| 3.1 | General | Change a general preference → save → refresh | Value persists | |
| 3.2 | Model Routing | Change routing strategy or thresholds → save → refresh | Strategy persists | |
| 3.3 | Agent Defaults | Change topology or maxAgents → save → refresh | Values persist | |
| 3.4 | Memory | Toggle graph, change sync interval → save → refresh | Settings persist | |
| 3.5 | Notifications | Toggle desktop, set quiet hours → save → refresh | Settings persist | |
| 3.6 | Autoscale | Change min/max slots → save → refresh | Values persist | |
| 3.7 | API Keys | View key status (should not show actual values) | Keys show as masked, status indicators | |
| 3.8 | Heartbeat | Toggle individual phases, change intervals → save → refresh | Phase toggles and intervals persist | |
| 3.9 | Shutdown | Click shutdown (if safe) | Graceful shutdown signal sent | |
| 3.10 | Project settings | In a project: change build cmd, test cmd, branch → save → refresh | All fields persist | |
| 3.11 | Project environments | Add environment (dev, prod) with variables → save → refresh | Environments persist. Variable values masked | |

---

## 4. Heartbeat Controls

| # | Test | Steps | Expected | Pass? |
|---|------|-------|----------|-------|
| 4.1 | Master toggle | Settings → Heartbeat → disable "Enabled" → save | Heartbeat stops. No more health check or scan activity | |
| 4.2 | Phase toggles | Enable heartbeat, disable "Agent Spawning" only | Health checks run, task scanning runs, but no agents spawn | |
| 4.3 | Interval config | Set health check interval to 10s, task scan to 120s | Health checks fire more frequently than task scans | |
| 4.4 | Persistence | Change heartbeat config → restart dashboard | Config survives restart (check `.playground/heartbeat-config.json`) | |

---

## 5. Chat System (3 providers)

| # | Provider | Steps | Expected | Pass? |
|---|----------|-------|----------|-------|
| 5.1 | Ollama | Start Ollama → `/chat` → select Ollama provider → send message | Streaming response from local model | |
| 5.2 | Claude | `/chat` → select Claude provider → send message | Streaming response (requires ANTHROPIC_API_KEY in .env) | |
| 5.3 | OpenClaw | Start gateway → `/chat` → select OpenClaw → send message | Response routed through gateway | |
| 5.4 | Fallback | Stop Ollama → send message with Ollama selected | Should fallback to next provider or show error | |
| 5.5 | Tool confirmation | Send a message that triggers a tool call | Tool shows as "pending confirmation" → approve → executes | |
| 5.6 | Session persistence | Send messages → close tab → reopen `/chat` | Previous session appears in session list | |

---

## 6. Project Creation (Templates)

Create a project from each template category and verify the generated files make sense:

| # | Template | Params to Test | Verify | Pass? |
|---|----------|---------------|--------|-------|
| 6.1 | Node.js | Default params | `package.json`, `index.js`, `.gitignore` created | |
| 6.2 | Python | Default params | `pyproject.toml` or `setup.py`, `main.py` | |
| 6.3 | SvelteKit | Default params | `svelte.config.js`, `package.json`, `src/` structure | |
| 6.4 | BepInEx mod | modName="TestMod", gameId="ROUNDS", includeThunderstore=true | `Plugin.cs`, `.csproj`, `manifest.json` generated | |
| 6.5 | Fabric mod | modId="testmod", minecraftVersion="1.21.1", language="java" | `build.gradle`, `fabric.mod.json`, `ModMain.java` | |
| 6.6 | Forge mod | modId="testmod", language="kotlin", includeCI=true | `build.gradle`, `mods.toml`, `.github/workflows/` | |
| 6.7 | Paper plugin | pluginName="TestPlugin", buildTool="gradle" | `build.gradle.kts`, `plugin.yml`, `Main.java` | |
| 6.8 | BG3 mod | modName="TestMod", includeScriptExtender=true | `info.json`, `meta.lsx`, `ScriptExtender/Config.json` | |
| 6.9 | Rust | projectType="binary", includeCI=true | `Cargo.toml`, `src/main.rs`, `.github/workflows/` | |
| 6.10 | Go | moduleName="github.com/test/mod", includeCI=true | `go.mod`, `main.go`, `Makefile` | |
| 6.11 | Template params UI | Select BepInEx → change gameId dropdown | Dropdown renders options. Selection affects generated files | |

---

## 7. Release Pipeline

Test on a real project that has git tags / GitHub releases.

| # | Test | Steps | Expected | Pass? |
|---|------|-------|----------|-------|
| 7.1 | Release page loads | `/projects/[id]/releases` | Lists existing releases (git tags) | |
| 7.2 | Create release (dry-run) | Click "Create Release" → pick version → dry-run | Shows changelog preview, version bump, no actual tag created | |
| 7.3 | Publisher detection | Check a BepInEx project's release page | Should auto-detect Thunderstore as a publish target | |
| 7.4 | Publisher dry-run | If publisher detected: click "Publish" with dry-run | Validates config, shows what would be published, no actual upload | |

---

## 8. Notifications

| # | Test | Steps | Expected | Pass? |
|---|------|-------|----------|-------|
| 8.1 | In-app notifications | Trigger an event (create task, start service) | Notification appears in inbox | |
| 8.2 | Desktop notifications | Settings → Notifications → enable Desktop → save | Browser prompts for permission. New notifications show OS-level popup | |
| 8.3 | Desktop when focused | With desktop enabled, trigger event while tab is focused | NO desktop popup (only in-app). Desktop only fires when tab unfocused | |

---

## 9. GitHub Sync

Requires a project with a linked GitHub repo.

| # | Test | Steps | Expected | Pass? |
|---|------|-------|----------|-------|
| 9.1 | Push tasks | Create a task → trigger sync | Task appears as GitHub issue | |
| 9.2 | Pull issues | Create an issue on GitHub → trigger sync | Issue appears as task in project | |
| 9.3 | Bidirectional | Update task status → sync → check GitHub issue | Status reflected on both sides | |

---

## 10. Keyboard Shortcuts

| # | Shortcut | Steps | Expected | Pass? |
|---|----------|-------|----------|-------|
| 10.1 | `Cmd/Ctrl+K` | Press shortcut on any page | Command palette opens | |
| 10.2 | Command palette search | Type "agents" in palette | Navigation items filter. Select → navigates | |
| 10.3 | `Cmd/Ctrl+/` | Press shortcut | Sidebar toggles collapsed/expanded | |
| 10.4 | `G then H` | Press G, then H within 1 second | Navigates to home (`/`) | |
| 10.5 | `G then P` | Press G, then P | Navigates to `/projects` | |
| 10.6 | `Escape` | Open palette → press Escape | Palette closes | |

---

## 11. Responsive Layout

Test at these breakpoints by resizing the browser window:

| # | Breakpoint | What to Check | Expected | Pass? |
|---|-----------|--------------|----------|-------|
| 11.1 | Desktop (1440px+) | Full sidebar, 4-column metric grids | Normal layout, everything visible | |
| 11.2 | Laptop (1024px) | Sidebar still visible but narrower | Layout adapts, no overflow | |
| 11.3 | Tablet (<1024px) | Sidebar collapses to hamburger | Hamburger icon appears. Click → sidebar slides out. Backdrop overlay | |
| 11.4 | Mobile (375px) | Full mobile layout | Cards stack 1-wide. Tables scroll horizontally. Command palette full-width | |
| 11.5 | MetricCards | Resize to see grid breakpoints | 4-col → 2-col → 1-col as width decreases | |

---

## 12. Error Handling

| # | Test | Steps | Expected | Pass? |
|---|------|-------|----------|-------|
| 12.1 | 404 page | Go to `/nonexistent` | Custom 404 with "Page Not Found" and navigation buttons | |
| 12.2 | Route error | Corrupt a data file temporarily | Route-scoped error page with "Try Again" button | |
| 12.3 | API error | Call an endpoint with bad data | 400/500 JSON response, not a crash | |
| 12.4 | Missing .playground/ | Delete `.playground/tasks.json` → load `/tasks` | Graceful empty state, not crash | |

---

## 13. Build System Detection

Import an existing project and verify detection:

| # | Project Type | How to Test | Expected Detection | Pass? |
|---|-------------|------------|-------------------|-------|
| 13.1 | npm project | Import a Node.js project | Detects npm, shows `npm test` as test cmd | |
| 13.2 | Gradle project | Import a Java/Kotlin project | Detects Gradle, shows `./gradlew test` | |
| 13.3 | Cargo project | Import a Rust project | Detects Cargo, shows `cargo test` | |
| 13.4 | dotnet project | Import a C# project | Detects MSBuild, shows `dotnet test` | |
| 13.5 | Go project | Import a Go project | Detects Go, shows `go test ./...` | |
| 13.6 | Monorepo | Import an npm workspace project | Detects workspace, shows package list | |

---

## 14. Incidents & Coverage

| # | Test | Steps | Expected | Pass? |
|---|------|-------|----------|-------|
| 14.1 | Incident creation | Trigger a test failure (break a test) → let post-test run | Incident created in `.playground/incidents.json` | |
| 14.2 | Incident API | `GET /api/incidents` | Returns incident list (may be empty) | |
| 14.3 | Coverage storage | Run tests with coverage → let post-test run | Coverage report stored in `.playground/coverage-trends.json` | |
| 14.4 | Coverage API | `GET /api/projects/[id]/coverage` | Returns coverage trend data | |

---

## 15. Performance Baseline

| # | Metric | How to Measure | Target | Pass? |
|---|--------|---------------|--------|-------|
| 15.1 | Build time | `time npm run build` | < 30s | |
| 15.2 | Dev server start | `time npm run dev` (until "ready") | < 5s | |
| 15.3 | Page load (home) | DevTools → Network → hard refresh | < 2s total, < 500ms TTFB | |
| 15.4 | Idle memory | Task Manager with dashboard open, heartbeat off | < 200MB RSS | |
| 15.5 | Idle CPU | Same as above, observe for 30s | < 5% sustained | |
| 15.6 | Test suite | `time npm test` | All pass, < 5min total | |

---

## Sign-Off

| Area | Tests Passed | Tests Failed | Notes |
|------|-------------|-------------|-------|
| Global Pages | /21 | | |
| Project Sub-Routes | /14 | | |
| Settings Persistence | /11 | | |
| Heartbeat Controls | /4 | | |
| Chat System | /6 | | |
| Templates | /11 | | |
| Release Pipeline | /4 | | |
| Notifications | /3 | | |
| GitHub Sync | /3 | | |
| Keyboard Shortcuts | /6 | | |
| Responsive Layout | /5 | | |
| Error Handling | /4 | | |
| Build Detection | /6 | | |
| Incidents & Coverage | /4 | | |
| Performance | /6 | | |
| **Total** | **/108** | | |

**v1.0 ready when**: All tests pass or failures have documented workarounds.
