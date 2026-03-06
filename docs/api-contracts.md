# API Contracts

Request/response schemas for the dashboard API endpoints covering agents, projects, hooks, services, and sessions.

All endpoints return `Content-Type: application/json`. Error responses follow the shape `{ "error": "message" }` unless otherwise noted.

---

## Agents

### `GET /api/agents`

List all available agent definitions with optional filtering and pagination.

**Query Parameters**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `file` | string | — | Return a specific agent file's raw content (takes priority) |
| `name` | string | — | Return a specific agent by name |
| `category` | string | — | Filter by category path or agent type |
| `search` | string | — | Case-insensitive search across name, description, category |
| `page` | number | 1 | Page number (only applies when `perPage > 0`) |
| `perPage` | number | 0 | Items per page (0 = return all, max 100) |

**Response — list all** `200`
```json
{
  "agents": [
    {
      "name": "coder",
      "description": "Writes clean code",
      "type": "coder",
      "category": "core",
      "file": "core/coder.md"
    }
  ],
  "categories": {
    "core": [ "..." ],
    "specialized": [ "..." ]
  },
  "total": 60,
  "page": 1,
  "perPage": 60,
  "totalPages": 1
}
```

When `perPage` is 0, `page` is 1, `perPage` equals `total`, and `totalPages` is 1.

**Response — by file** `200`
```json
{
  "filename": "core/coder.md",
  "content": "---\nname: coder\n..."
}
```

**Response — by name** `200`
```json
{
  "name": "coder",
  "content": "---\nname: coder\n...",
  "description": "...",
  "type": "coder",
  "category": "core",
  "file": "core/coder.md"
}
```

**Errors**
| Status | Body |
|--------|------|
| 404 | `{ "error": "Agent file not found" }` |
| 404 | `{ "error": "Agent not found" }` |

---

### `PUT /api/agents`

Update an existing agent definition file.

**Request Body**
```json
{
  "filename": "string (required — relative path)",
  "content": "string (required — full markdown content)"
}
```

**Response** `200`
```json
{ "ok": true, "filename": "core/coder.md" }
```

**Errors**
| Status | Body |
|--------|------|
| 400 | `{ "error": "filename and content required" }` |
| 404 | `{ "error": "Agent file not found" }` |

---

### `POST /api/agents`

Create a new agent definition file. Fails if the file already exists.

**Request Body**
```json
{
  "filename": "string (required — relative path)",
  "content": "string (required — full markdown with frontmatter)"
}
```

**Response** `200`
```json
{ "ok": true, "filename": "custom/my-agent.md" }
```

**Errors**
| Status | Body |
|--------|------|
| 400 | `{ "error": "filename and content required" }` |
| 409 | `{ "error": "Agent file already exists" }` |

---

### `DELETE /api/agents`

Delete an agent definition file.

**Query Parameters**
| Param | Type | Description |
|-------|------|-------------|
| `file` | string (required) | Relative path of the agent file to delete |

**Response** `200`
```json
{ "ok": true, "filename": "custom/my-agent.md" }
```

**Errors**
| Status | Body |
|--------|------|
| 400 | `{ "error": "file parameter required" }` |
| 404 | `{ "error": "Agent file not found" }` |

---

### `GET /api/agents/catalog`

List all agent definitions from the agents directory. Returns a flat array sorted by category then name. Results are cached for 5 minutes.

**Response** `200`
```json
[
  {
    "name": "coder",
    "category": "core",
    "description": "Writes clean code",
    "filename": "core/coder.md"
  }
]
```

Returns `[]` with status `500` on filesystem errors.

---

## Projects

### `GET /api/projects`

List all registered projects with favorite status.

**Response** `200`
```json
{
  "projects": [
    {
      "id": "string",
      "name": "string",
      "path": "string",
      "favorite": false
    }
  ],
  "favorites": ["project-id-1"]
}
```

---

### `POST /api/projects`

Create a new project from a template, or import an existing directory.

**Request Body — create**
```json
{
  "name": "string (required)",
  "path": "string (required — absolute directory path)",
  "template": "blank | sveltekit | nextjs | python | fullstack | agent (default: blank)",
  "description": "string (optional)",
  "initGit": "boolean (optional, default: false)",
  "createGithub": "boolean (optional, default: false — requires initGit)",
  "primaryModel": "string (optional, default: 'GPT-OSS 20B (local)')",
  "escalation": "string (optional, default: 'Claude Sonnet 4.6')",
  "memoryNamespace": "string (optional, default: name)",
  "isolateMemory": "boolean (optional)",
  "sharePatterns": "boolean (optional)",
  "maxAgents": "number (optional, default: 8)",
  "topology": "string (optional, default: 'hierarchical-mesh')",
  "services": "string[] (optional)"
}
```

**Response** `201`
```json
{
  "project": { "id": "...", "name": "...", "path": "..." },
  "gitInitialized": true,
  "githubCreated": false
}
```

**Request Body — import** (legacy flow: name omitted)
```json
{
  "path": "string (required — existing directory)"
}
```

**Response** `201`
```json
{
  "project": { "id": "...", "name": "...", "path": "..." }
}
```

**Errors**
| Status | Body |
|--------|------|
| 400 | `{ "error": "name is required" }` |
| 400 | `{ "error": "path is required" }` |
| 400 | `{ "error": "Directory does not exist" }` (import) |

---

### `PATCH /api/projects`

Toggle a project's favorite status.

**Request Body**
```json
{
  "id": "string (required)",
  "favorite": "boolean (required)"
}
```

**Response** `200`
```json
{
  "ok": true,
  "favorites": ["project-id-1", "project-id-2"]
}
```

**Error** `400`
```json
{ "error": "id and favorite (boolean) are required" }
```

---

### `GET /api/projects/:id`

Get a single project by ID.

**Response** `200`
```json
{
  "project": { "id": "...", "name": "...", "path": "..." }
}
```

**Error** `404`
```json
{ "error": "Project not found" }
```

---

### `DELETE /api/projects/:id`

Remove a project from the registry (does not delete files on disk).

**Response** `200`
```json
{ "success": true }
```

**Error** `404`
```json
{ "error": "Project not found" }
```

---

## Project Agents

### `GET /api/projects/:id/agents`

List agents associated with a project, available agents, and capacity info.

**Query Parameters**
| Param | Type | Default | Max | Description |
|-------|------|---------|-----|-------------|
| `page` | number | 1 | — | Page of associated agents |
| `pageSize` | number | 10 | 50 | Items per page |

**Response** `200`
```json
{
  "agents": [
    {
      "name": "coder",
      "type": "coder",
      "description": "Writes clean code",
      "filename": "core/coder.md"
    }
  ],
  "availableAgents": [
    {
      "name": "researcher",
      "type": "researcher",
      "description": "...",
      "filename": "core/researcher.md"
    }
  ],
  "summary": {
    "associated": 5,
    "available": 55,
    "total": 60,
    "types": 3
  },
  "capacity": {
    "current": 5,
    "max": 15
  },
  "pagination": {
    "page": 1,
    "pageSize": 10,
    "totalItems": 5,
    "totalPages": 1
  }
}
```

**Error** `404`
```json
{ "error": "Project not found" }
```

---

### `POST /api/projects/:id/agents`

Associate agent(s) with a project. Duplicates are silently ignored.

**Request Body**
```json
{
  "agents": ["core/coder.md", "specialized/security-auditor.md"]
}
```

**Response** `200`
```json
{
  "ok": true,
  "added": ["core/coder.md"],
  "total": 3
}
```

**Errors**
| Status | Body |
|--------|------|
| 400 | `{ "error": "agents array required" }` |
| 404 | `{ "error": "Project not found" }` |

---

### `DELETE /api/projects/:id/agents`

Remove agent(s) from a project.

**Request Body**
```json
{
  "agents": ["core/coder.md"]
}
```

**Response** `200`
```json
{
  "ok": true,
  "removed": ["core/coder.md"],
  "total": 2
}
```

**Errors**
| Status | Body |
|--------|------|
| 400 | `{ "error": "agents array required" }` |
| 404 | `{ "error": "Project not found" }` |

---

## Project Hooks

### `GET /api/hooks`

Returns global hook settings from the dashboard settings file.

**Response** `200`
```json
{
  "hooks": {},
  "daemon": null,
  "learning": null
}
```

---

### `GET /api/projects/:id/hooks`

List hooks for a project.

**Response** `200`
```json
{
  "hooks": [
    {
      "name": "pre-commit",
      "type": "pre-task",
      "description": "Run linter before tasks",
      "enabled": true,
      "command": "npm run lint"
    }
  ],
  "total": 1
}
```

**Error** `404`
```json
{ "error": "Project not found" }
```

---

### `POST /api/projects/:id/hooks`

Create a new hook for a project.

**Request Body**
```json
{
  "name": "string (required)",
  "type": "string (required)",
  "description": "string (optional, default: '')",
  "enabled": "boolean (optional, default: true)",
  "command": "string (optional, default: '')"
}
```

**Response** `200`
```json
{
  "ok": true,
  "hook": {
    "name": "pre-commit",
    "type": "pre-task",
    "description": "Run linter before tasks",
    "enabled": true,
    "command": "npm run lint"
  },
  "total": 2
}
```

**Errors**
| Status | Body |
|--------|------|
| 400 | `{ "error": "name is required" }` |
| 400 | `{ "error": "type is required" }` |
| 404 | `{ "error": "Project not found" }` |
| 409 | `{ "error": "Hook \"x\" already exists" }` |

---

### `DELETE /api/projects/:id/hooks`

Remove a hook by name.

**Request Body**
```json
{
  "name": "string (required)"
}
```

**Response** `200`
```json
{
  "ok": true,
  "removed": "pre-commit",
  "total": 0
}
```

**Errors**
| Status | Body |
|--------|------|
| 400 | `{ "error": "name is required" }` |
| 404 | `{ "error": "Project not found" }` |
| 404 | `{ "error": "Hook \"x\" not found" }` |

---

## Services

### `GET /api/services`

List all services (built-in + custom). Built-in services are detected via health checks and port scanning. Custom services are read from the custom services JSON file.

**Response** `200`
```json
{
  "services": [
    {
      "id": "string",
      "name": "string",
      "type": "string",
      "configPath": "string | null",
      "pid": "number | null",
      "port": "number | null",
      "secondaryPort": "number | null",
      "status": "running | stopped | errored",
      "uptime": "string | null (e.g. '2h 30m')",
      "ram": "string | null (e.g. '128 MB')",
      "cpu": "string | null",
      "errorMessage": "string | null"
    }
  ],
  "timestamp": "2026-03-05T12:00:00.000Z"
}
```

---

### `POST /api/services`

Register one or more custom services. Duplicate IDs (derived from name) are silently skipped.

**Request Body**
```json
{
  "services": [
    {
      "name": "string (required)",
      "type": "string (optional, default: 'Background Service')",
      "command": "string (optional)",
      "port": "number | null (optional)",
      "workingDir": "string (optional, default: './')"
    }
  ],
  "configDir": "string (optional, default: '.openclaw/services/')",
  "autoStart": "boolean (optional, default: false)",
  "healthMonitoring": "boolean (optional, default: false)"
}
```

**Response** `201`
```json
{
  "created": ["my-service"],
  "total": 3
}
```

**Error** `400`
```json
{ "error": "No services provided" }
```

---

### `POST /api/services/:id`

Perform an action on a service (start/stop/restart).

**Request Body**
```json
{
  "action": "start | stop | restart"
}
```

**Response** `200`
```json
{
  "success": true,
  "message": "Ollama server starting..."
}
```

**Errors**
| Status | Body |
|--------|------|
| 400 | `{ "message": "Invalid action. Allowed: start, stop, restart" }` |
| 404 | `{ "message": "Unknown service: x" }` |
| 500 | `{ "success": false, "message": "..." }` |

---

### `GET /api/services/:id/config`

Read a service's configuration file.

**Response** `200`
```json
{
  "content": "string (file contents)",
  "language": "yaml | json | toml | text",
  "path": "config/openclaw/gateway.yaml",
  "serviceName": "OpenClaw Gateway"
}
```

**Errors**
| Status | Body |
|--------|------|
| 403 | `Config path not in allowed directories` |
| 404 | `Service not found` or `No config file for this service` |

---

### `PUT /api/services/:id/config`

Update a service's configuration file.

**Request Body**
```json
{
  "content": "string (required — full file content)"
}
```

**Response** `200`
```json
{
  "success": true,
  "message": "Config saved: config/openclaw/gateway.yaml"
}
```

**Errors**
| Status | Body |
|--------|------|
| 400 | `Missing or invalid "content" field` |
| 403 | `Config path not in allowed directories` |
| 404 | `Service not found` or `No config file for this service` |

---

### `GET /api/services/:id/logs`

Read recent log lines for a service.

**Query Parameters**
| Param | Type | Default | Max | Description |
|-------|------|---------|-----|-------------|
| `lines` | number | 100 | 500 | Number of tail lines to return |

**Response** `200`
```json
{
  "lines": ["log line 1", "log line 2"],
  "serviceName": "Claude Flow Daemon"
}
```

**Errors**
| Status | Body |
|--------|------|
| 404 | `Service not found` or `No logs configured for this service` |

---

## Sessions

### `GET /api/session`

Get the current active session.

**Response** `200`
```json
{
  "id": "string | null",
  "status": "string"
}
```

If no active session exists, returns `{ "id": null, "status": "none" }`.

---

### `GET /api/projects/:id/sessions`

List sessions (agent + chat) for a project with resource usage stats.

**Query Parameters**
| Param | Type | Default | Max | Description |
|-------|------|---------|-----|-------------|
| `page` | number | 1 | — | Page number |
| `perPage` | number | 10 | 50 | Items per page |

**Response** `200`
```json
{
  "summary": {
    "active": 1,
    "paused": 0,
    "completed": 5,
    "totalTurns": 142
  },
  "sessions": [
    {
      "name": "Fix auth bug",
      "id": "a1b2c3d4",
      "type": "agent | chat",
      "status": "active | completed | paused",
      "agents": 0,
      "turns": 12,
      "duration": "1h 05m"
    }
  ],
  "pagination": {
    "page": 1,
    "perPage": 10,
    "totalSessions": 6,
    "totalPages": 1
  },
  "timeline": [
    {
      "time": "14:30",
      "label": "Fix auth bug",
      "color": "green | blue"
    }
  ],
  "resources": {
    "apiTokens": { "value": 50000, "cost": "$0.15 estimated" },
    "localTokens": { "value": 200000, "cost": "$0.00 (Ollama)" },
    "memoryNodes": { "value": 42, "label": "HNSW indexed" }
  }
}
```

Sessions are sorted with active sessions first. Timeline is capped at 8 entries.

**Error** `404` — throws SvelteKit error if project not found.

---

### `GET /api/sessions/:id/events`

Stream conversation events for a session (JSONL-backed).

**Path Parameters**
| Param | Format | Description |
|-------|--------|-------------|
| `id` | `session-\d+` or `current` | Session identifier |

**Query Parameters**
| Param | Type | Default | Max | Description |
|-------|------|---------|-----|-------------|
| `after` | number | 0 | — | Sequence cursor; only returns events with `s > after` |
| `limit` | number | 100 | 500 | Max events to return |

**Response** `200`
```json
{
  "events": [
    {
      "s": 1,
      "ts": "2026-03-05T12:00:00.000Z",
      "t": "prompt | tool | stop",
      "d": "string (optional — data/content)",
      "len": 42,
      "n": "string (optional — tool name)",
      "f": "string (optional — file path)",
      "ok": true
    }
  ],
  "nextCursor": 5,
  "total": 100
}
```

**Errors**
| Status | Body |
|--------|------|
| 400 | `Invalid session ID format` |

If the session file does not exist, returns `{ "events": [], "nextCursor": 0, "total": 0 }`.

---

## Project Tasks

### `GET /api/projects/:id/tasks`

List tasks for a project.

**Query Parameters**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `status` | string | — | Comma-separated status filter (e.g. `open,in_progress`) |
| `full` | string | — | Set to `true` to return full task objects instead of index entries |

**Response** `200`
```json
{
  "tasks": [
    {
      "id": "string",
      "title": "string",
      "status": "open | in_progress | done | cancelled",
      "priority": "critical | high | medium | low"
    }
  ]
}
```

**Error** `404` — throws SvelteKit error if project not found.

---

### `POST /api/projects/:id/tasks`

Create a new task in a project.

**Request Body**
```json
{
  "title": "string (required)",
  "description": "string (optional)",
  "priority": "critical | high | medium | low (default: medium)",
  "assignee": "string (optional)",
  "tags": "string[] (optional)",
  "createdBy": "string (optional, default: 'user')"
}
```

**Response** `201`
```json
{
  "task": {
    "id": "string",
    "title": "string",
    "status": "open",
    "priority": "medium",
    "tags": [],
    "createdBy": "user"
  }
}
```

**Error** `400` — throws SvelteKit error if title is missing.

---

## Security

### `POST /api/security/scan`

Run a security scan against the project. Tries the Claude Flow CLI (`security scan`) first; if the CLI is unavailable, falls back to a local file-based scan that checks `.env` secrets, `.gitignore` rules, gateway bind address, network policy, and audit log directory.

Sensitive values (API keys, tokens, passwords) are automatically redacted from the response.

**Request Body**

None — no body required.

**Response** `200`

When the CLI scan succeeds:
```json
{
  "success": true,
  "output": "Security Scan Results\n========================================\n..."
}
```

When the local fallback scan runs:
```json
{
  "success": true,
  "output": "Security Scan Results\n========================================\n\n[CRITICAL] .env not in .gitignore\n  Secrets file may be committed to version control\n\n========================================\nSummary: 1 critical issue(s) found"
}
```

The `output` field is a human-readable string. Each finding is formatted as:
```
[SEVERITY] Issue title
  Detail description
```

Severity levels: `CRITICAL`, `HIGH`, `MEDIUM`, `LOW`, `INFO`.

**Side effect**: The fallback scan persists findings to a JSON file on disk for the security page to read.

**Error** `500`
```json
{
  "success": false,
  "error": "Security scan failed: <error message>"
}
```
