# POST /api/chat/auto

Start a new autonomous chat session or control an existing one.

**Rate Limit**: 15 requests per 60 seconds (per client).

## Starting a New Session

Send a POST with a `userMessage` to start a new auto session. The server returns immediately with a `sessionId` while the session streams in the background.

### Request Body

| Field          | Type   | Required | Default        | Description                              |
|----------------|--------|----------|----------------|------------------------------------------|
| `userMessage`  | string | Yes      | —              | The user prompt to start the session with. Alias: `message`. |
| `model`        | string | No       | `gpt-oss:20b`  | Model identifier (e.g. `gpt-oss:20b`, `claude-sonnet-4-6`). |
| `provider`     | string | No       | `ollama`        | Provider backend (`ollama`, `anthropic`). |
| `systemPrompt` | string | No       | —              | Optional system prompt for the session.  |
| `source`       | string | No       | —              | Freeform source tag (e.g. `dashboard`, `api`). |

### Example Request

```bash
curl -X POST http://localhost:5173/api/chat/auto \
  -H "Content-Type: application/json" \
  -d '{
    "userMessage": "Summarize the project README",
    "model": "gpt-oss:20b",
    "provider": "ollama"
  }'
```

### Response (201 Created)

```json
{
  "sessionId": "auto-1709712000000-a1b2c3",
  "status": "streaming"
}
```

## Control Actions

Pass an `action` field to control an existing session. All control actions require `sessionId`.

### Inject a Message

Send an additional message into a running session.

| Field       | Type   | Required |
|-------------|--------|----------|
| `action`    | string | Yes      | Value: `inject` |
| `sessionId` | string | Yes      |
| `message`   | string | Yes      |

```json
{ "action": "inject", "sessionId": "auto-...", "message": "Also check the tests" }
```

**Response**: `{ "ok": true }` or `{ "ok": false }` if the session was not found.

### Pause a Session

| Field       | Type   | Required |
|-------------|--------|----------|
| `action`    | string | Yes      | Value: `pause` |
| `sessionId` | string | Yes      |

```json
{ "action": "pause", "sessionId": "auto-..." }
```

**Response**: `{ "ok": true }`

### Resume a Session

| Field       | Type   | Required |
|-------------|--------|----------|
| `action`    | string | Yes      | Value: `resume` |
| `sessionId` | string | Yes      |

```json
{ "action": "resume", "sessionId": "auto-..." }
```

**Response**: `{ "ok": true }`

### Get Session Status

| Field       | Type   | Required |
|-------------|--------|----------|
| `action`    | string | Yes      | Value: `status` |
| `sessionId` | string | Yes      |

```json
{ "action": "status", "sessionId": "auto-..." }
```

**Response**:

```json
{ "status": "streaming" }
```

Possible status values depend on the session manager implementation (typically `streaming`, `paused`, `idle`, `error`).

## Error Responses

All errors return a JSON body with an `error` field.

| Status | Condition                          | Body                                          |
|--------|------------------------------------|-----------------------------------------------|
| 400    | Malformed JSON body                | `{ "error": "Invalid JSON" }`                 |
| 400    | Missing `userMessage` on start     | `{ "error": "userMessage is required" }`      |
| 400    | Missing required field on action   | `{ "error": "sessionId required" }` (etc.)    |
| 429    | Rate limit exceeded                | Rate limiter rejection (includes `Retry-After` header) |
