# AI Playground User Guide

## Projects

### Importing an Existing Project

The import wizard auto-detects your project's tooling and configuration so you
can start managing it from the dashboard immediately.

1. Navigate to **Projects** in the sidebar, then click **Import Existing**.
   (Direct link: `/projects/import`)

2. **Step 1 — Select Directory**
   Enter the absolute path to your project root in the text field
   (e.g. `C:\Users\you\code\my-app`) and click **Scan**.
   The scanner checks for common config files (`package.json`, `tsconfig.json`,
   `Cargo.toml`, etc.) and detects language, framework, build tool, and git
   remote information.

3. **Step 2 — Review Detected Configuration**
   After scanning you will see:
   - **Config files** — each detected file shown with a green dot (found) or
     grey dot (not found).
   - **Project details** — language, framework, build/dev/test/lint/start
     commands, git remote, and default branch.
   - **Release process** — any detected release tooling (e.g. semantic-release).
   - **Detected services** — services with ports found in the project.

4. **Step 3 — Review & Import**
   The wizard shows what will happen when you import:
   - The project is added to the registry.
   - A `.playground/config.json` is read (if it exists) or auto-generated.
   - The project is scanned for live stats.
   - No existing files are modified (non-destructive).

   You can click **Preview config.json** to inspect the configuration that will
   be used. When ready, click **Import Project**.

5. After import you are redirected to the **Projects** list where the new
   project appears with its detected metadata.

### Creating a New Project

Click **+ Create New Project** from the projects page or import page. This opens
a blank project form where you define the project name and settings manually
instead of auto-detecting from an existing directory.

---

## Hooks & Self-Learning

The Hooks page (`/hooks`) shows every hook registered across all lifecycle
phases. Hooks run automatically before or after events such as task execution,
file edits, and session start/end.

### Viewing Hooks

1. Open **Hooks** from the sidebar.
2. The top metrics show:
   - **Total Hooks** — count across all phases.
   - **Active Families** — distinct hook families (e.g. pre-task, post-edit).
   - **Intelligence** — whether the self-learning system is active.
3. The **Hook Registry** table lists every hook with its family, matcher
   pattern, and command. Click a row to expand and see the full command and
   any environment variables.

### Configuring Hooks

Hooks are defined in your Claude Code settings file
(`.claude/settings.json` or `.claude/settings.local.json`). Each hook entry
specifies:
- **family** — lifecycle phase (`PreToolUse`, `PostToolUse`, `PreTask`, etc.)
- **matcher** — glob or regex pattern the event must match
- **command** — shell command to execute

Example `.claude/settings.json` snippet:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit",
        "hooks": [
          { "type": "command", "command": "echo 'About to edit a file'" }
        ]
      }
    ]
  }
}
```

Changes to the settings file are picked up on the next session or page reload.

### Project-Level Hooks

Within a project, hooks can also be viewed on the project detail page under
**Hooks** (`/projects/<id>/hooks`). These show hooks scoped to that project's
configuration.

---

## Memory & Knowledge

The Memory page (`/memory`) provides a visual overview of the system's
knowledge base, including auto-memory entries and the memory graph.

### Dashboard Overview

At the top of the page you will see:
- **Backend** — the active memory store (e.g. AgentDB, hybrid).
- **HNSW** — whether the HNSW vector index is enabled.
- **Namespaces** — count of distinct memory namespaces.
- **Entries** — total auto-memory entries loaded.

### Memory Graph

The interactive graph visualizes relationships between memory entries. Nodes
represent entries and edges represent semantic connections. Hover or click
nodes to see details. If no entries exist yet, the graph area shows a
placeholder message.

### Auto-Memory Entries

Below the graph, the **Auto-Memory Entries** section lists every stored entry
with:
- **Namespace** — logical grouping (e.g. `patterns`, `sessions`).
- **Key** — unique identifier for the entry.
- **Value** — the stored content.

Click an entry to expand and see its full value.

### Refreshing Memory

Click the **Refresh** button at the top of the page to re-fetch the latest
context and auto-memory entries from the server without a full page reload.

### Project-Level Memory

Each project has its own memory view at `/projects/<id>/memory`, showing
entries scoped to that project's namespace.

---

## Agents

The Agents page (`/agents`) provides a full view of every agent definition, live running agents,
session pool state, routing analytics, and swarm health. The page auto-polls every 10 seconds so
live data stays current without a manual refresh.

### Overview Metrics

Six metric cards at the top show the current state at a glance:

| Metric | What it shows |
|--------|---------------|
| **Definitions** | Total agent template files in `.claude/agents/` |
| **Running Now** | Agents actively executing tasks (live) |
| **Tasks Done** | Completed tasks / failed tasks since last reset |
| **Total Cost** | Cumulative API spend; per-task average shown below |
| **Session Pool** | Warm sessions in the pool and how many models are represented |
| **Warm Rate** | Percentage of task starts that reused a warm session vs. cold start |

### Viewing Running Agents

If agents are currently executing, a **Running Agents** section appears below the metrics.
Each card shows the agent label, PID, and how long it has been running.
Click any card to open the live session chat at `/chat?session=<sessionId>`.

### Managing the Session Pool

The session pool keeps sessions warm between tasks, saving ~44K tokens (~$0.05) per warm resume.

1. Click **Spawn Pool** to create sessions from `config/agent-pool.yaml`. Sessions are
   distributed across available models up to the configured max capacity.
2. Each session card shows: model tier (colour-coded), area, task count, total cost, and
   last-used time.
   - Green dot — session is **idle** (ready for a new task).
   - Pulsing cyan dot — session is **active** (currently executing).
3. Click **Open session** on a card to view its chat history.
4. Click **Remove** to free that slot from the pool.
5. Click **Reset Pool** to destroy all sessions and start fresh (confirmation required).

### Agent Routing Flow

The **Agent Routing Flow** section (visible once tasks have run) shows the path each task takes:

```
Classified → OpenClaw (local)          → Claude Code (API)
               ├─ completed locally        ├─ sonnet
               └─ escalated ──────────────►└─ opus
```

Tasks are first classified by the local Ollama model. If the task exceeds its capability
threshold it is escalated to Claude Sonnet or Opus via the API. The routing breakdown shows
counts and cumulative cost for each path.

### Model Performance

Below the routing flow, the **Model Performance** section breaks down stats per model tier
(local / sonnet / opus): task count, success rate, total and average cost, average duration,
and input/output token ratio.

### 24h Activity Timeline

The **24h Activity** bar chart shows task volume and cost per hour over the last 24 hours.
Hover over any bar to see the task count and cost for that hour bucket.

### Recent Agent Events

The **Recent Agent Events** table lists the last 40 routing events (classified, escalation
check, model selected, spawned, handoff, completed, failed). Click **view** in the Chat
column to open the session chat for any spawned or completed task.

### Swarm Status

The **Swarm Status** section shows whether the swarm coordinator is active, the current
topology, and a capacity gauge (`active / max slots`). Coordination state and process counts
(agentic flows, MCP servers) are shown when the swarm is running.

### Browsing and Managing Agent Definitions

The **Agent Definitions** grid at the bottom lists all agent templates.

1. Use the **search bar** to filter by name, description, or category.
2. Click a **category pill** (e.g., `Core Development`, `SPARC Methodology`) to show only
   agents in that group.
3. Each agent card shows its name, description, filename, and optional type badge.
   - **View** — opens the agent detail page at `/agents/<filename>`.
   - **Delete** — permanently removes the agent file after confirmation.
4. Use the pagination controls to navigate large agent libraries.

### Creating an Agent

1. Click **+ New Agent** (top-right) to navigate to `/agents/create`.
2. Fill in the agent name, type, category, and description.
3. Save — the markdown file is written to `.claude/agents/` and appears in the grid after
   a refresh.

---

## Services

The Services page (`/services`) lists every MCP server, background daemon, and project
process, with start / stop / restart controls and live status updates via a reactive store.

### Status Overview

Four metric cards at the top show:
- **Running** — processes currently active
- **Stopped** — processes that have been shut down
- **Errored** — processes that exited with an error
- **Total Services** — all registered services

### Finding Services

- Type in the **search bar** to filter by service name, type, or ID.
- Click a **status filter** button (**All / Running / Stopped / Errored**) to narrow the list.
- Click **Refresh** (top-right) to manually re-fetch. The timestamp next to the button shows
  when data was last updated.

### Service Actions

Each service row shows its name, type, config path, PID, port, and RAM usage.
Available actions depend on the current status:

| Status | Available actions |
|--------|------------------|
| **Running** | Stop, Restart, Logs, Config |
| **Stopped** | Start, Logs, Config |
| **Errored** | Force Restart, Logs, Config |

- **Stop / Start / Restart** — sends the action to the API; the list refreshes ~2 s later.
- **Logs** — opens the log viewer (available for `openclaw` and `claude-flow` services).
- **Config** — opens the configuration editor for that service.

A toast notification confirms success or reports an error after each action.
If live refresh fails, a yellow warning banner appears and the last known state is shown.

### Adding a Service

1. Click **Add a Service** (from the empty state) or navigate to `/services/new`.
2. Enter the service name, type, and configuration path.
3. Save — the service appears in the list immediately.

---

## Sessions

The Sessions page (`/sessions`) lists all chat sessions — both currently active and
historical — so you can resume conversations or review past work.

### Session List

Each row shows:
- **Session ID** — unique identifier (often prefixed by the task or agent name)
- **Model** — the model that handled the session
- **Status** — `active` (currently running) or `idle` (finished)
- **Started / Last used** — timestamps
- **Task count** — number of tasks completed in this session
- **Cost** — cumulative API spend for this session

### Resuming a Session

Click a session row or its **Open** link to go to `/chat?session=<id>`. The chat UI loads the
full history and — if a warm pool slot is available — resumes without a cold start.

### Session Lifecycle

```
New task dispatched
        ↓
Check pool for matching warm slot
        ├─ Warm slot found  →  resume (saves ~44K tokens)
        └─ No warm slot     →  cold start (full context load)
                  ↓
          Task executes
                  ↓
          Session status → idle
                  ↓
     (Optionally) returned to pool for next task
```

### Project-Level Sessions

Each project has its own sessions view at `/projects/<id>/sessions`, filtered to that
project's tasks and agents.

---

## Autoscale Settings

The autoscale system dynamically adjusts the session pool size based on task
demand. When more tasks arrive than the current pool can handle, new slots are
added automatically; when slots sit idle, they are removed to free resources.

### Configuring Autoscale

Send a `PUT` request to `/api/settings/autoscale` (or use the Settings page)
with a JSON body containing any of the following fields:

| Field | Type | Default | Range | Description |
|-------|------|---------|-------|-------------|
| `minSlots` | number | `4` | 1–50 | Minimum pool slots — the pool never scales below this |
| `maxSlots` | number | `14` | 1–50 | Maximum pool slots — the pool never scales above this |
| `tasksPerSlot` | number | `2` | 1–10 | Pending-task threshold per slot — when exceeded, a new slot is added |
| `idleCooldownMs` | number | `300000` (5 min) | 30 000–3 600 000 | How long a slot must be idle before it is eligible for scale-down |

If `minSlots` is greater than `maxSlots`, the API auto-corrects so that
`minSlots ≤ maxSlots`.

**Example — set a tighter pool with faster cooldown:**

```bash
curl -X PUT http://localhost:5173/api/settings/autoscale \
  -H "Content-Type: application/json" \
  -d '{ "minSlots": 2, "maxSlots": 8, "idleCooldownMs": 60000 }'
```

To read the current settings:

```bash
curl http://localhost:5173/api/settings/autoscale
```

### How Autoscale Affects Services

The autoscale engine runs inside the heartbeat loop. On each tick it evaluates:

1. **Scale up** — if the number of pending tasks exceeds
   `activeSlots × tasksPerSlot`, a new session slot is created (up to
   `maxSlots`). The new slot is immediately available for task dispatch.
2. **Scale down** — if a slot has been idle longer than `idleCooldownMs` and
   the pool is above `minSlots`, that slot is removed and its session is
   terminated.
3. **No-op** — if neither condition is met, the pool size stays the same.

The Services page (`/services`) reflects these changes in real time: you will
see session processes appear and disappear as the pool scales. The Agents page
metrics (**Session Pool** and **Warm Rate**) also update to show the current
pool size.

### Persistence

Autoscale settings are persisted to `.playground/autoscale-settings.json`.
Changes take effect on the next heartbeat tick (typically within a few seconds).
If the file is missing or invalid, defaults are used.

---

## Navigation Reference

| Page | Path | Description |
|------|------|-------------|
| Dashboard | `/` | System overview with metrics |
| Projects | `/projects` | List and manage projects |
| Import Project | `/projects/import` | Import existing project wizard |
| Create Project | `/projects/create` | Create a new project |
| Hooks | `/hooks` | View and manage hooks |
| Memory | `/memory` | Memory graph and entries |
| Agents | `/agents` | Agent definitions, running agents, session pool, routing analytics |
| Create Agent | `/agents/create` | Create a new agent definition |
| Agent Detail | `/agents/<filename>` | View and edit a single agent |
| Models | `/models` | Model configuration and routing stats |
| Sessions | `/sessions` | Active and historical sessions |
| Services | `/services` | MCP servers, daemons, and background processes |
| Add Service | `/services/new` | Register a new service |
| Chat | `/chat` | Interactive chat with any session |
| Settings | `/settings` | App-wide configuration |
| Autoscale | `/api/settings/autoscale` | Session pool autoscale configuration (API) |
