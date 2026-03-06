# .playground — Project Memory

This file helps Claw and agents navigate the .playground structure. Updated automatically.

## Directory Layout

```
.playground/
├── MEMORY.md              ← You are here. Navigation guide for agents.
├── registry.json          ← List of all tracked projects [{path, addedAt}]
├── config.json            ← Root project config (name, techStack, tags, stats)
├── notifications.json     ← All notifications (max 200, newest first)
├── notification-settings.json ← Per-category delivery prefs, quiet hours
├── routing-log.json       ← Every model routing decision (provider, model, latency, success)
├── github-sync.json       ← Task↔GitHub issue mappings, last sync time
├── chats/
│   ├── index.json         ← Session metadata [{id, title, model, provider, source, messageCount}]
│   └── {session-id}.json  ← Full chat session (messages array)
├── reports/
│   ├── daily-YYYY-MM-DD.json
│   └── weekly-YYYY-MM-DD.json
└── tasks/
    ├── index.json         ← Lightweight task index (id, title, status, priority, bucket)
    ├── backlog/           ← Active tasks: pending, in_progress
    │   └── {task-id}.json
    ├── completed/         ← Finished tasks
    │   └── {task-id}.json
    └── archived/          ← Cancelled tasks
        └── {task-id}.json
```

## Key Files

| File | Purpose | Who writes |
|------|---------|------------|
| `registry.json` | Tracks all projects | Dashboard import/create |
| `tasks/index.json` | Fast task listing without reading each file | task-store.ts |
| `tasks/{bucket}/{id}.json` | Full task detail | task-store.ts, Claw via chat tools |
| `notifications.json` | All notification history | notifications.ts |
| `routing-log.json` | Model routing telemetry | routing-telemetry.ts |
| `github-sync.json` | Task↔Issue ID mappings | github-sync.ts |
| `chats/index.json` | Chat session metadata | session-manager.ts |

## Task Lifecycle

1. Created → `backlog/{id}.json` + index entry (status: pending)
2. In progress → stays in `backlog/` (status: in_progress)
3. Completed → moved to `completed/{id}.json` (status: completed)
4. Cancelled → moved to `archived/{id}.json` (status: cancelled)

Claw can create tasks via `mk_task` tool and update via `mod_task` tool.
When completing work, Claw should mark the task completed via `mod_task`.

## Per-Project Tasks

Each project can have its own `.playground/tasks/` directory.
The dashboard aggregates tasks across all registered projects.
Root-level `.playground/tasks/` holds cross-cutting tasks.

## Conventions

- Task IDs are 8-char UUIDs (e.g. `a1b2c3d4`)
- Timestamps are ISO 8601 UTC
- `createdBy` tracks who made it: `user`, `claw`, `github`, agent name
- `assignee` can be null, `claw`, a username, or an agent name
- Tasks with `flagDiscussion: true` need human review before proceeding
