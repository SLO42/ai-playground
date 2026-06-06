# DATA-MODEL — ai-playground v2

One datastore: **SurrealDB 2.x**, run as a **managed local server binary** over `ws://127.0.0.1` (D-006, KongCode's path — no native addon). Document + graph + vector + FTS in a single engine. This doc is the authoritative schema and the migration map from v1's scattered stores.

> **Version target:** SurrealDB **2.x**. All syntax below is 2.x. Known 3.x renames are flagged inline (e.g. `SEARCH ANALYZER` → `FULLTEXT ANALYZER`). Vector index is **HNSW** (MTREE is removed in 2.x).

---

## 1. Connection & server lifecycle

SurrealDB runs as a **managed server binary** (D-006). The services manager provisions the platform binary (version-pinned, cached) and spawns it bound to loopback; the app connects with the JS SDK over `ws://`.

```ts
// server/db/server.ts  — provision + spawn (Windows-safe: shell:true, taskkill on stop)
//   surreal start --bind 127.0.0.1:8000 --user root --pass <local> surrealkv://./.data/playground.db
//   (backend: surrealkv — KongCode runs this in production; rocksdb:// is the alt, D-007)

// server/db/connect.ts  (ESM)
import { Surreal } from "surrealdb";

let _db: Surreal | null = null;

export async function getDb(): Promise<Surreal> {
  if (_db) return _db;
  const db = new Surreal();
  await db.connect("ws://127.0.0.1:8000/rpc");
  await db.signin({ username: "root", password: process.env.SURREAL_PASS! }); // loopback-only
  await db.use({ namespace: "playground", database: "main" });
  await runMigrations(db);
  _db = db;                       // single long-lived client, owned by the SvelteKit server
  return db;
}

export async function closeDb(): Promise<void> {
  if (_db) { await _db.close(); _db = null; }
}
```

Packages — **only the SDK** (no native engine):
```
surrealdb   (JS SDK, 2.x)        // talks to the server over ws://
```
Plus the SurrealDB **server binary** (provisioned/cached, not an npm dep). Tests run a throwaway server (or `mem://` via a test-only embedded path) on a separate port/namespace.

---

## 2. Namespaces & databases

- Namespace `playground`, database `main` for live data.
- Tests: namespace `playground`, database `test`, `mem://` backend, dropped per run.

---

## 3. Conventions

- Record IDs are `table:id` (e.g. `project:swip`, `task:⟨ulid⟩`). Use meaningful ids where natural (project slug), generated ids otherwise.
- All tables `SCHEMAFULL` unless a field set is genuinely open (then `SCHEMALESS` with a comment).
- Timestamps: `datetime`, default `time::now()`.
- Links: `record<table>` for to-one; arrays of `record<table>` or graph edges for to-many/typed relations.
- Money/cost: store token counts + a computed `cost_usd float`.
- Enums: `string` + `ASSERT $value IN [...]`.

---

## 4. Schema

### 4.1 Project & plan

```sql
DEFINE TABLE project SCHEMAFULL;
DEFINE FIELD slug         ON project TYPE string;          -- also the record id where possible
DEFINE FIELD name         ON project TYPE string;
DEFINE FIELD root_path    ON project TYPE string;          -- absolute path under code root
DEFINE FIELD ecosystem    ON project TYPE array<string> DEFAULT [];  -- ["typescript","neoforge",...]
DEFINE FIELD build_tool   ON project TYPE option<string>;  -- npm|gradle|cargo|dotnet|...
DEFINE FIELD test_command ON project TYPE option<string>;
DEFINE FIELD repo_url     ON project TYPE option<string>;
DEFINE FIELD status       ON project TYPE string DEFAULT "active"
  ASSERT $value IN ["active","paused","archived"];
DEFINE FIELD created_at   ON project TYPE datetime DEFAULT time::now();
DEFINE FIELD updated_at   ON project TYPE datetime DEFAULT time::now();

-- Project Plan v3 (carried from v1 shape). Embedded object on the project,
-- or its own table if it grows; start embedded for simplicity.
DEFINE FIELD plan                       ON project TYPE option<object>;
DEFINE FIELD plan.purpose               ON project TYPE option<string>;
DEFINE FIELD plan.long_term_vision      ON project TYPE option<string>;
DEFINE FIELD plan.role                  ON project TYPE option<string>;
DEFINE FIELD plan.definition_of_done    ON project TYPE option<string>;
-- releases / phases / features / sprints are their own tables linked back to project:

DEFINE TABLE release SCHEMAFULL;
DEFINE FIELD project   ON release TYPE record<project>;
DEFINE FIELD version   ON release TYPE string;            -- "v0.1"
DEFINE FIELD title     ON release TYPE option<string>;
DEFINE FIELD status    ON release TYPE string DEFAULT "planned"
  ASSERT $value IN ["planned","active","shipped"];
DEFINE FIELD shipped_at ON release TYPE option<datetime>;

DEFINE TABLE phase SCHEMAFULL;
DEFINE FIELD project ON phase TYPE record<project>;
DEFINE FIELD release ON phase TYPE option<record<release>>;
DEFINE FIELD name    ON phase TYPE string;
DEFINE FIELD order   ON phase TYPE int DEFAULT 0;
DEFINE FIELD status  ON phase TYPE string DEFAULT "todo"
  ASSERT $value IN ["todo","in_progress","done"];

DEFINE TABLE feature SCHEMAFULL;
DEFINE FIELD project  ON feature TYPE record<project>;
DEFINE FIELD release  ON feature TYPE option<record<release>>;
DEFINE FIELD title    ON feature TYPE string;
DEFINE FIELD detail   ON feature TYPE option<string>;
DEFINE FIELD status   ON feature TYPE string DEFAULT "planned"
  ASSERT $value IN ["planned","in_progress","done","dropped"];

DEFINE TABLE sprint SCHEMAFULL;
DEFINE FIELD project ON sprint TYPE record<project>;
DEFINE FIELD name    ON sprint TYPE string;
DEFINE FIELD starts  ON sprint TYPE option<datetime>;
DEFINE FIELD ends    ON sprint TYPE option<datetime>;

DEFINE INDEX project_slug ON project FIELDS slug UNIQUE;
DEFINE INDEX release_by_project ON release FIELDS project;
```

### 4.2 Tasks

```sql
DEFINE TABLE task SCHEMAFULL;
DEFINE FIELD project     ON task TYPE record<project>;
DEFINE FIELD title       ON task TYPE string;
DEFINE FIELD description ON task TYPE string;               -- never mutated in place (D-008)
DEFINE FIELD status      ON task TYPE string DEFAULT "backlog"
  ASSERT $value IN ["backlog","ready","in_progress","review","blocked","done","failed"];
DEFINE FIELD priority    ON task TYPE string DEFAULT "normal"
  ASSERT $value IN ["low","normal","high","critical"];
DEFINE FIELD origin      ON task TYPE string DEFAULT "manual"
  ASSERT $value IN ["manual","scanner","follow_up","review","release"];
DEFINE FIELD parent      ON task TYPE option<record<task>>;  -- follow-ups link to parent
DEFINE FIELD created_at  ON task TYPE datetime DEFAULT time::now();
DEFINE FIELD updated_at  ON task TYPE datetime DEFAULT time::now();

DEFINE INDEX task_by_project ON task FIELDS project;
DEFINE INDEX task_by_status  ON task FIELDS status;
DEFINE INDEX task_by_project_status ON task FIELDS project, status;
```

A SurrealDB **live query** on `task` (status transitions) is the primary orchestrator trigger in `event` mode.

### 4.3 Agents, sessions, runtime events

```sql
-- agent_slot is a CONFIG/STAT MIRROR of config/agent-pool.yaml — NOT a live allocation table.
-- Agents are spawned per-task (no idle pool), so `busy` is a denormalized stat snapshot
-- (last-known activity), kept fresh by the same sync-on-write contract as §4.10 — never the
-- authoritative source for "is this slot free right now". Drop `busy` if it causes confusion.
DEFINE TABLE agent_slot SCHEMAFULL;     -- pool definition mirror (config-driven), runtime stats
DEFINE FIELD name      ON agent_slot TYPE string;
DEFINE FIELD tier      ON agent_slot TYPE string ASSERT $value IN ["local","haiku","sonnet","opus"];
DEFINE FIELD role      ON agent_slot TYPE string;   -- coder|reviewer|tester|planner|...
DEFINE FIELD busy      ON agent_slot TYPE bool DEFAULT false;  -- stat mirror only (see note above)

DEFINE TABLE session SCHEMAFULL;        -- a unit of agent work (chat or task run)
DEFINE FIELD project   ON session TYPE option<record<project>>;
DEFINE FIELD task      ON session TYPE option<record<task>>;
DEFINE FIELD kind      ON session TYPE string ASSERT $value IN ["chat","task","review","release","discussion"];
DEFINE FIELD model           ON session TYPE object;          -- {provider, model_id, tier}
DEFINE FIELD model.provider  ON session TYPE string;          -- join-critical for analytics/routing
DEFINE FIELD model.model_id  ON session TYPE string;
DEFINE FIELD model.tier      ON session TYPE option<string>;
DEFINE FIELD status    ON session TYPE string DEFAULT "running"
  ASSERT $value IN ["running","done","failed","cancelled"];
DEFINE FIELD pid       ON session TYPE option<int>;
DEFINE FIELD runtime   ON session TYPE string DEFAULT "claude-code"
  ASSERT $value IN ["claude-code","ollama","claude-direct"];
DEFINE FIELD cc_session_id ON session TYPE option<string>;  -- Claude Code session id, for resume/interject (D-011)
DEFINE FIELD workflow_run  ON session TYPE option<record<workflow_run>>;  -- set if part of a pipeline
DEFINE FIELD started_at ON session TYPE datetime DEFAULT time::now();
DEFINE FIELD ended_at   ON session TYPE option<datetime>;

DEFINE TABLE message SCHEMAFULL;        -- chat/session messages (replaces chats/*.jsonl)
DEFINE FIELD session ON message TYPE record<session>;
DEFINE FIELD role    ON message TYPE string ASSERT $value IN ["user","assistant","tool","system"];
DEFINE FIELD content ON message TYPE string;
DEFINE FIELD tool_call ON message TYPE option<object>;  -- name/args/result; tool messages NOT dropped (D-008)
DEFINE FIELD at      ON message TYPE datetime DEFAULT time::now();

DEFINE INDEX message_by_session ON message FIELDS session;
DEFINE INDEX session_by_project ON session FIELDS project;
-- `cc_session_id` is option<string>, so a naive UNIQUE would collide on the 2nd
-- session with no Claude Code id (SurrealDB treats NONE as a value). Use the
-- dedup_key VALUE pattern (D-008): fall back to the record id when cc_session_id is NONE.
DEFINE FIELD dedup_key ON session VALUE (cc_session_id OR id);
DEFINE INDEX session_dedup ON session FIELDS dedup_key UNIQUE;   -- idempotent lazy create (§7a)
DEFINE INDEX session_cc ON session FIELDS cc_session_id;         -- NON-unique: bridge join lookup
DEFINE INDEX session_by_status ON session FIELDS status;
DEFINE INDEX session_by_workflow_run ON session FIELDS workflow_run;
```

### 4.4 Analytics (first-class)

```sql
-- Every routing decision, with full rationale.
DEFINE TABLE routing_event SCHEMAFULL;
DEFINE FIELD task        ON routing_event TYPE option<record<task>>;
DEFINE FIELD project     ON routing_event TYPE option<record<project>>;
DEFINE FIELD chosen          ON routing_event TYPE object;     -- {provider, model_id, tier}
DEFINE FIELD chosen.provider ON routing_event TYPE string;     -- join-critical: analytics/routing join on provider
DEFINE FIELD chosen.model_id ON routing_event TYPE string;
DEFINE FIELD chosen.tier     ON routing_event TYPE option<string>;
DEFINE FIELD method      ON routing_event TYPE string;     -- explicit|classify|tier|fallback
DEFINE FIELD reason      ON routing_event TYPE string;     -- human-readable WHY (carried v1 rule)
DEFINE FIELD complexity  ON routing_event TYPE option<float>;
DEFINE FIELD alternatives ON routing_event TYPE option<array<object>>;
DEFINE FIELD at          ON routing_event TYPE datetime DEFAULT time::now();

DEFINE INDEX routing_event_by_project ON routing_event FIELDS project;
DEFINE INDEX routing_event_by_task    ON routing_event FIELDS task;

-- Every agent lifecycle event (spawn/complete/escalate).
DEFINE TABLE agent_event SCHEMAFULL;
DEFINE FIELD session     ON agent_event TYPE option<record<session>>;
DEFINE FIELD project     ON agent_event TYPE option<record<project>>;
DEFINE FIELD type        ON agent_event TYPE string
  ASSERT $value IN ["spawn","completion","escalation","cancel","error"];
DEFINE FIELD model          ON agent_event TYPE option<object>;       -- {provider, model_id, tier}
DEFINE FIELD model.provider ON agent_event TYPE option<string>;       -- join-critical for analytics/routing
DEFINE FIELD model.model_id ON agent_event TYPE option<string>;
DEFINE FIELD model.tier     ON agent_event TYPE option<string>;
DEFINE FIELD tokens_in   ON agent_event TYPE option<int>;
DEFINE FIELD tokens_out  ON agent_event TYPE option<int>;
DEFINE FIELD cost_usd    ON agent_event TYPE option<float>;
DEFINE FIELD duration_ms ON agent_event TYPE option<int>;
DEFINE FIELD detail      ON agent_event TYPE option<object>;  -- escalation from/to + reason, error msg, etc.
DEFINE FIELD at          ON agent_event TYPE datetime DEFAULT time::now();

DEFINE INDEX agent_event_by_project ON agent_event FIELDS project;
DEFINE INDEX agent_event_by_type    ON agent_event FIELDS type;
```

### 4.5 Memory — semantic (vector) + episodic + procedural

```sql
DEFINE TABLE memory SCHEMAFULL;
DEFINE FIELD project   ON memory TYPE option<record<project>>;   -- null = global memory
DEFINE FIELD kind      ON memory TYPE string DEFAULT "semantic"
  ASSERT $value IN ["semantic","episodic","procedural"];
DEFINE FIELD namespace ON memory TYPE string DEFAULT "default";
DEFINE FIELD key       ON memory TYPE option<string>;            -- for dedup on import
DEFINE FIELD content   ON memory TYPE string;
DEFINE FIELD embedding ON memory TYPE array<float>;              -- 1024-dim (BGE-M3 via Ollama, D-014); must equal the memory_vec HNSW DIMENSION
DEFINE FIELD tags      ON memory TYPE option<array<string>>;
DEFINE FIELD source    ON memory TYPE option<string>;           -- claude-auto-memory|agent|scanner
DEFINE FIELD scope     ON memory TYPE string DEFAULT "project"  -- KongCode-style soft scoping
  ASSERT $value IN ["project","global"];
DEFINE FIELD importance ON memory TYPE float DEFAULT 5.0;       -- 0..10, decays with age
DEFINE FIELD confidence ON memory TYPE float DEFAULT 1.0;
DEFINE FIELD access_count ON memory TYPE int DEFAULT 0;         -- bumped on every recall
DEFINE FIELD last_accessed ON memory TYPE option<datetime>;    -- updated on recall (for decay)
DEFINE FIELD embedding_truncated ON memory TYPE bool DEFAULT false;  -- content tail not in vector (input-limit)
-- Append-only soft-archive (D-015): never DELETE knowledge.
DEFINE FIELD status    ON memory TYPE string DEFAULT "active"
  ASSERT $value IN ["active","archived","superseded"];
DEFINE FIELD archived_at    ON memory TYPE option<datetime>;
DEFINE FIELD archive_reason ON memory TYPE option<string>;
DEFINE FIELD superseded_by  ON memory TYPE option<record<memory>>;
DEFINE FIELD created_at ON memory TYPE datetime DEFAULT time::now();
DEFINE FIELD updated_at ON memory TYPE datetime DEFAULT time::now();

-- HNSW vector index. DIMENSION must match the embedding model.
-- Default model = BGE-M3 (1024-dim) via Ollama (D-014). DIST COSINE for normalized text embeddings.
DEFINE INDEX memory_vec ON memory FIELDS embedding
  HNSW DIMENSION 1024 DIST COSINE TYPE F32 EFC 150 M 12 M0 24;

-- Dedup support for the bridge import (dedup_key VALUE pattern, D-008).
-- `key` is optional, so a naive UNIQUE on (namespace, key) would collide on the 2nd
-- keyless row (SurrealDB treats NONE as a value). Instead derive a dedup_key that
-- falls back to the record id when the natural key is NONE, then UNIQUE on that:
DEFINE FIELD dedup_key ON memory VALUE (namespace + '|' + (key OR <string>id));
DEFINE INDEX memory_dedup ON memory FIELDS dedup_key UNIQUE;

-- Project-scoped recall. Consider a composite (project, kind, status) for filtered recall.
DEFINE INDEX memory_by_project ON memory FIELDS project;
```

**Semantic recall (HNSW KNN):**
```sql
-- $q = query embedding (array<float>), K=10 neighbors, EF=40 search effort
SELECT id, content, project, tags, vector::distance::knn() AS dist
FROM memory
WHERE embedding <|10,40|> $q
  AND ( $project = NONE OR project = $project )
  AND ( status = "active" OR status IS NONE )   -- soft-archive filter (D-015)
ORDER BY dist;            -- smaller = closer (cosine distance)
```
The index path returns cosine **distance**; the WMR formula wants cosine **similarity**, so convert with `similarity = 1 - dist`.

For tiny datasets use exact brute force with the similarity function (no index needed):
```sql
SELECT id, content, vector::similarity::cosine(embedding, $q) AS sim
FROM memory
WHERE ( $project = NONE OR project = $project )
  AND ( status = "active" OR status IS NONE )
ORDER BY sim DESC;        -- larger = closer (cosine similarity)
```

**Two query forms (KongCode lesson):** the `<|K,EF|>` operator is what actually drives the **HNSW index** — use it for large tables. KongCode instead queries `SELECT …, vector::similarity::cosine(embedding,$q) AS score … ORDER BY score DESC LIMIT n` per table with `WHERE` filters (status/scope) — readable and filter-friendly but a **scan** unless the planner uses the index. Rule: index-backed ANN via `<|K,EF|>`; the function form only for already-filtered/small candidate sets.

**Hybrid scoring (WMR — adopt KongCode's formula).** Recall is not raw cosine. Final rank blends similarity, historical usefulness, and recency:
```
final = 0.50 * cosine_similarity          -- 0..1
      + 0.35 * clamp(historical_utility)  -- from past retrieval outcomes (see 4.13 `retrieval_outcome`; defaults to 0 until that data exists)
      + 0.15 * recency_decay              -- exp(-days_since_created / 30)  (≈30-day half-life)
```
Importance decays with age too: `effective_importance = max(importance - min(floor(days_old/7), 3), 0)` (−1/week, cap −3). On every recall, bump `access_count` and set `last_accessed` (drives future scoring).

**Per-table budgets + one round-trip.** When memory spans multiple kinds/tables, query each with its own `LIMIT` budget and **batch all statements in a single round-trip**, then merge + dedup by id in-process (KongCode batches ~8). Avoids N sequential queries.

### 4.6 Knowledge graph — native edges

```sql
-- Nodes can be memories or first-class entities.
DEFINE TABLE entity SCHEMAFULL;        -- people, files, concepts, modules
DEFINE FIELD label ON entity TYPE string;
DEFINE FIELD type  ON entity TYPE string;   -- file|concept|module|person|...
DEFINE FIELD project ON entity TYPE option<record<project>>;
-- Entities are knowledge-bearing graph nodes, so they soft-archive like `memory` (D-015)
-- rather than being hard-deleted. (If an entity must be removed, hard-delete it together
-- with its `references` edges to avoid dangling edges.)
DEFINE FIELD status ON entity TYPE string DEFAULT "active"
  ASSERT $value IN ["active","archived","superseded"];

-- Typed edge tables (RELATION). Endpoints constrained.
DEFINE TABLE references TYPE RELATION IN memory|entity OUT memory|entity SCHEMAFULL;
DEFINE FIELD kind   ON references TYPE string
  ASSERT $value IN ["supports","contradicts","derived_from","mentions","relates_to"];
DEFINE FIELD weight ON references TYPE float DEFAULT 1.0;
DEFINE FIELD at     ON references TYPE datetime DEFAULT time::now();
```

**Create / traverse:**
```sql
RELATE memory:a->references->memory:b SET kind = "supports", weight = 0.8;

-- 1-hop neighbors of a memory node, both directions:
SELECT
  ->references->(memory,entity).* AS outgoing,
  <-references<-(memory,entity).* AS incoming
FROM memory:a;

-- 2-hop expansion for richer recall context:
SELECT ->references->memory->references->memory.* AS two_hop FROM memory:a;
```

**Hybrid recall** = vector KNN (4.5) ∪ graph neighbors (4.6) ∪ FTS (4.8), merged + ranked by the memory service into a `ContextBundle`.

### 4.7 Services, processes, incidents, notifications

```sql
DEFINE TABLE service SCHEMAFULL;
DEFINE FIELD name    ON service TYPE string;     -- ollama | surrealdb | engine | dashboard (dashboard = status-only self-report)
DEFINE FIELD status  ON service TYPE string DEFAULT "unknown"
  ASSERT $value IN ["running","stopped","crashed","unknown"];
DEFINE FIELD pid     ON service TYPE option<int>;
DEFINE FIELD checked_at ON service TYPE datetime DEFAULT time::now();

DEFINE TABLE process SCHEMAFULL;     -- pid registry (replaces pid-registry.db), Windows-safe checks
DEFINE FIELD pid      ON process TYPE int;
DEFINE FIELD kind     ON process TYPE string;    -- agent|service
DEFINE FIELD session  ON process TYPE option<record<session>>;
DEFINE FIELD started_at ON process TYPE datetime DEFAULT time::now();

DEFINE INDEX process_by_pid ON process FIELDS pid UNIQUE;

DEFINE TABLE incident SCHEMAFULL;
DEFINE FIELD title  ON incident TYPE string;
DEFINE FIELD detail ON incident TYPE option<string>;
DEFINE FIELD severity ON incident TYPE string DEFAULT "info"
  ASSERT $value IN ["info","warn","error","critical"];
DEFINE FIELD at     ON incident TYPE datetime DEFAULT time::now();

DEFINE TABLE notification SCHEMAFULL;
DEFINE FIELD message ON notification TYPE string;
DEFINE FIELD read    ON notification TYPE bool DEFAULT false;
DEFINE FIELD at      ON notification TYPE datetime DEFAULT time::now();
```

### 4.8 Full-text search (optional, 2.x syntax)

```sql
DEFINE ANALYZER text_an TOKENIZERS blank, class, camel, punct
  FILTERS lowercase, ascii, snowball(english);

-- 2.x: SEARCH ANALYZER.  3.x renames to FULLTEXT ANALYZER (D-009).
DEFINE INDEX memory_fts ON memory FIELDS content
  SEARCH ANALYZER text_an BM25 HIGHLIGHTS;

SELECT id, content, search::score(1) AS score
FROM memory
WHERE content @1@ $terms
ORDER BY score DESC;
```

### 4.9 Security findings

```sql
DEFINE TABLE security_finding SCHEMAFULL;
DEFINE FIELD project  ON security_finding TYPE option<record<project>>;
DEFINE FIELD rule     ON security_finding TYPE string;
DEFINE FIELD severity ON security_finding TYPE string
  ASSERT $value IN ["low","medium","high","critical"];
DEFINE FIELD file     ON security_finding TYPE option<string>;
DEFINE FIELD detail   ON security_finding TYPE option<string>;
-- Append-only soft-archive (D-015): never DELETE findings — same pattern as `memory`.
DEFINE FIELD status   ON security_finding TYPE string DEFAULT "active"
  ASSERT $value IN ["active","archived","superseded"];
DEFINE FIELD archived_at    ON security_finding TYPE option<datetime>;
DEFINE FIELD archive_reason ON security_finding TYPE option<string>;
DEFINE FIELD superseded_by  ON security_finding TYPE option<record<security_finding>>;
DEFINE FIELD at       ON security_finding TYPE datetime DEFAULT time::now();
```

> **Soft-archive read-guard (D-015):** filter live reads with `(status = "active" OR status IS NONE)` across all soft-archived tables (`memory`, `security_finding`). The `status IS NONE` arm covers only KongCode-style imported rows that predate the `status` field — new rows always default to `"active"`. (Earlier D-015 wording used `(active = true OR active IS NONE)`; standardize on the `status` form above — these tables use a `status` enum, not a boolean `active` flag.)

### 4.10 Claude Code harness — config mirror (filesystem is authoritative, D-010)

These tables **mirror** what lives in `.claude/` and `.mcp.json` on disk; they are an index for query + dashboard, not the source of truth. A sync service upserts them; a watcher keeps them fresh.

```sql
-- Where config came from: a project or the global ~/.claude
DEFINE TABLE cc_scope SCHEMAFULL;
DEFINE FIELD kind    ON cc_scope TYPE string ASSERT $value IN ["project","global"];
DEFINE FIELD project ON cc_scope TYPE option<record<project>>;
DEFINE FIELD path    ON cc_scope TYPE string;       -- abs path to the .claude dir (or home)

-- settings.json mirror (one per scope)
DEFINE TABLE cc_settings SCHEMAFULL;
DEFINE FIELD scope        ON cc_settings TYPE record<cc_scope>;
DEFINE FIELD file_path    ON cc_settings TYPE string;
DEFINE FIELD permissions  ON cc_settings TYPE option<object>;   -- allow/deny/ask
DEFINE FIELD env          ON cc_settings TYPE option<object>;
DEFINE FIELD enabled_plugins ON cc_settings TYPE option<object>;
DEFINE FIELD raw          ON cc_settings TYPE object;           -- full parsed json, for round-trip
DEFINE FIELD synced_at    ON cc_settings TYPE datetime DEFAULT time::now();

-- hooks (flattened from settings.json for querying)
DEFINE TABLE cc_hook SCHEMAFULL;
DEFINE FIELD scope   ON cc_hook TYPE record<cc_scope>;
DEFINE FIELD event   ON cc_hook TYPE string;     -- PreToolUse|PostToolUse|SessionStart|...
DEFINE FIELD matcher ON cc_hook TYPE option<string>;
DEFINE FIELD command ON cc_hook TYPE string;
DEFINE FIELD timeout ON cc_hook TYPE option<int>;

-- agents (.claude/agents/*.md)
DEFINE TABLE cc_agent SCHEMAFULL;
DEFINE FIELD scope       ON cc_agent TYPE record<cc_scope>;
DEFINE FIELD file_path   ON cc_agent TYPE string;
DEFINE FIELD name        ON cc_agent TYPE string;
DEFINE FIELD description ON cc_agent TYPE option<string>;
DEFINE FIELD frontmatter ON cc_agent TYPE object;   -- parsed YAML
DEFINE FIELD category    ON cc_agent TYPE option<string>;

-- skills (.claude/skills/*/SKILL.md)
DEFINE TABLE cc_skill SCHEMAFULL;
DEFINE FIELD scope       ON cc_skill TYPE record<cc_scope>;
DEFINE FIELD file_path   ON cc_skill TYPE string;
DEFINE FIELD name        ON cc_skill TYPE string;
DEFINE FIELD description ON cc_skill TYPE option<string>;
DEFINE FIELD plugin      ON cc_skill TYPE option<string>;   -- if from a plugin

-- MCP servers (.mcp.json + settings mcpServers)
DEFINE TABLE cc_mcp_server SCHEMAFULL;
DEFINE FIELD scope    ON cc_mcp_server TYPE record<cc_scope>;
DEFINE FIELD name     ON cc_mcp_server TYPE string;
DEFINE FIELD type     ON cc_mcp_server TYPE string ASSERT $value IN ["stdio","http","sse"];
DEFINE FIELD command  ON cc_mcp_server TYPE option<string>;
DEFINE FIELD args     ON cc_mcp_server TYPE option<array<string>>;
DEFINE FIELD url      ON cc_mcp_server TYPE option<string>;
DEFINE FIELD env      ON cc_mcp_server TYPE option<object>;

DEFINE INDEX cc_scope_by_project ON cc_scope FIELDS project;
DEFINE INDEX cc_agent_by_scope   ON cc_agent FIELDS scope;
DEFINE INDEX cc_skill_by_scope   ON cc_skill FIELDS scope;
```

> **Sync contract:** edits write the **file** first (validated), then re-parse → upsert mirror. The `raw` field on `cc_settings` preserves the full JSON so round-tripping never drops unknown keys. Carry the v1 settings lesson: validate permission-rule syntax (`mcp__server__*`, never `mcp__server__:*`) before writing.

### 4.11 Workflows (headless CC pipelines, D-013)

```sql
DEFINE TABLE workflow SCHEMAFULL;
DEFINE FIELD name    ON workflow TYPE string;
DEFINE FIELD project ON workflow TYPE option<record<project>>;
DEFINE FIELD steps   ON workflow TYPE array<object>;   -- [{id, prompt, agent, model, cwd, depends_on:[ids], parallel}]
-- Step shape is untyped here; the runtime validates {id, prompt, agent, model, cwd, depends_on, parallel} before persist.
DEFINE FIELD trigger ON workflow TYPE string DEFAULT "manual"
  ASSERT $value IN ["manual","event","periodic"];
DEFINE FIELD created_at ON workflow TYPE datetime DEFAULT time::now();

DEFINE TABLE workflow_run SCHEMAFULL;
DEFINE FIELD workflow  ON workflow_run TYPE record<workflow>;
DEFINE FIELD status    ON workflow_run TYPE string DEFAULT "running"
  ASSERT $value IN ["running","done","failed","cancelled"];
DEFINE FIELD step_state ON workflow_run TYPE object DEFAULT {};  -- {stepId: "pending|running|done|failed"}
DEFINE FIELD started_at ON workflow_run TYPE datetime DEFAULT time::now();
DEFINE FIELD ended_at   ON workflow_run TYPE option<datetime>;

DEFINE INDEX wfrun_by_workflow ON workflow_run FIELDS workflow;
```

Each executing step is a `session` (4.3) with `workflow_run` set, so transcripts + analytics flow through the same tables.

### 4.12 Work queue (D-021)

Durable work queue backing the orchestrator (referenced by D-021 / ARCHITECTURE §2.2). Producers enqueue `work_item` rows; workers claim them atomically and run them as sessions.

```sql
DEFINE TABLE work_item SCHEMAFULL;
DEFINE FIELD work_type    ON work_item TYPE string;     -- task_run|scan|review|release|...
DEFINE FIELD session      ON work_item TYPE option<record<session>>;
DEFINE FIELD project      ON work_item TYPE option<record<project>>;
DEFINE FIELD priority     ON work_item TYPE int DEFAULT 5;       -- lower = sooner
DEFINE FIELD status       ON work_item TYPE string DEFAULT "pending"
  ASSERT $value IN ["pending","processing","done","failed"];
DEFINE FIELD payload      ON work_item TYPE object;
DEFINE FIELD attempts     ON work_item TYPE int DEFAULT 0;
DEFINE FIELD claim_token  ON work_item TYPE option<string>;      -- worker lease, set on atomic claim
DEFINE FIELD handoff      ON work_item TYPE option<object>;      -- cross-worker handoff state
DEFINE FIELD created_at   ON work_item TYPE datetime DEFAULT time::now();
DEFINE FIELD completed_at ON work_item TYPE option<datetime>;
-- Dedup the active window so the same unit isn't enqueued twice (dedup_key VALUE pattern, D-008):
-- active rows key on work_type|session|status; terminal rows fall back to the record id.
DEFINE FIELD dedup_key    ON work_item VALUE
  (IF status IN ["pending","processing"]
    THEN work_type + '|' + <string>(session OR '') + '|' + status
    ELSE <string>id END);
DEFINE INDEX work_item_dedup ON work_item FIELDS dedup_key UNIQUE;
DEFINE INDEX work_item_by_status_priority ON work_item FIELDS status, priority;
```

**Atomic claim** (one worker wins the row; the `claim_token IS NONE` guard prevents double-claim):
```sql
UPDATE work_item
  SET claim_token = $t, status = "processing", attempts += 1
  WHERE status = "pending" AND claim_token IS NONE
  ORDER BY priority ASC
  LIMIT 1
  RETURN AFTER;
```

### 4.13 Retrieval outcomes (D-022 groundwork)

Records what recall actually returned and whether it helped — the data source for WMR's `historical_utility` (4.5) and the post-v1.0 learned reranker (D-022). v0.2 only *records* these rows; the learned reranker consumes them later.

```sql
DEFINE TABLE retrieval_outcome SCHEMAFULL;
DEFINE FIELD session      ON retrieval_outcome TYPE option<record<session>>;
DEFINE FIELD query_turn   ON retrieval_outcome TYPE option<record<message>>;  -- the turn that triggered recall
DEFINE FIELD memory       ON retrieval_outcome TYPE option<record<memory>>;
DEFINE FIELD citation_id  ON retrieval_outcome TYPE option<string>;
DEFINE FIELD utilized     ON retrieval_outcome TYPE bool DEFAULT false;        -- fed into the model context
DEFINE FIELD cited        ON retrieval_outcome TYPE bool DEFAULT false;        -- referenced in the response
DEFINE FIELD tool_success ON retrieval_outcome TYPE option<bool>;             -- did the downstream tool/action succeed
DEFINE FIELD score        ON retrieval_outcome TYPE float;                    -- recall score at retrieval time
DEFINE FIELD was_neighbor ON retrieval_outcome TYPE bool DEFAULT false;       -- came in via graph expansion, not direct KNN
DEFINE FIELD created_at   ON retrieval_outcome TYPE datetime DEFAULT time::now();

DEFINE INDEX retrieval_outcome_by_session ON retrieval_outcome FIELDS session;
DEFINE INDEX retrieval_outcome_by_memory  ON retrieval_outcome FIELDS memory;
```

---

## 5. Transactions (kill the v1 race class)

Any multi-write that must be atomic runs in a transaction. Example — completing a task, recording analytics, and creating a follow-up as one unit:

```sql
BEGIN TRANSACTION;
  UPDATE task:⟨id⟩ SET status = "done", updated_at = time::now();
  CREATE agent_event SET session = session:⟨id⟩, project = project:⟨p⟩,
    type = "completion", tokens_in = 1200, tokens_out = 3400,
    cost_usd = 0.051, duration_ms = 18234;
  CREATE task SET project = project:⟨p⟩, title = "Follow-up: add tests",
    description = $followup, origin = "follow_up", parent = task:⟨id⟩;
COMMIT TRANSACTION;
```
If anything fails, `CANCEL TRANSACTION` (or `THROW`) rolls back all of it. No partial writes, no TOCTOU.

> **Caveat (D-006):** atomic rollback is documented; the explicit isolation level for the server (surrealkv) backend transaction isolation is not stated in SurrealDB docs. Verify during the Phase 0 spike if a design depends on a specific isolation guarantee.

---

## 6. Migration map — v1 stores → v2 SurrealDB

| v1 store | v2 destination |
|----------|----------------|
| `tasks.db` / `tasks.json` | `task` table |
| `session-pool.json` | `agent_slot` + `session` |
| `spawn-stats.db` | `agent_event` (type=spawn/completion) |
| `agent-analytics.json` | `agent_event` |
| `routing-log.json` / `routing-telemetry.db` | `routing_event` |
| `chats/*.jsonl` | `session` + `message` |
| `pid-registry.db` | `process` |
| `pm-memory.db` | `memory` (project-scoped) + plan fields on `project` |
| `.swarm/memory.db` (HNSW) | `memory` + `memory_vec` HNSW index |
| `graph-state.json` | `entity` nodes + `references` edges |
| `auto-memory-store.json` | `memory` (source=claude-auto-memory), dedup via `memory_dedup` (dedup_key) |
| `registry.json` | `project` table |
| `incidents.db` | `incident` |
| `notifications.db` | `notification` |
| `analytics.db` | folded into `agent_event` / `routing_event` |
| `security-findings.json` | `security_finding` |
| `project-plan.json` | `project.plan` + `release`/`phase`/`feature`/`sprint` |
| `heartbeat-metrics.json` | `agent_event` (orchestrator cycle rows) — folded in; no separate `engine_metric` table |
| `claw-device-identity.json` | **dropped** unless D-002 spike reintroduces a gateway |
| _(none — new)_ | `work_item` table (new, D-021) |
| _(none — new)_ | `service` table (new — ephemeral in v1) |
| _(none — new)_ | `workflow` / `workflow_run` tables (new, D-013) |
| _(none — new)_ | `retrieval_outcome` table (new, D-022 groundwork) |

A one-time **importer script** (Phase 1) reads each v1 file/DB and writes the mapped records in transactions. Embeddings in `.swarm/memory.db` can be re-used if dimensions match the chosen embedding model; otherwise re-embed `content`.

**Harness mirror tables are NOT migrated** — `cc_settings`/`cc_hook`/`cc_agent`/`cc_skill`/`cc_mcp_server` are populated by the config-sync service reading `.claude/` + `.mcp.json` from disk on boot (filesystem is authoritative, D-010). v1's agent/skill scanners and `/hooks` page are superseded by this sync.

---

## 7. Embedding model note

Default (D-014): **BGE-M3, 1024-dim, served by Ollama** (reuses the local model server; KongCode proves BGE-M3 1024 works well, but runs it via `node-llama-cpp` because it has no Ollama — we do). HNSW `DIMENSION` is **locked to 1024** to match. Alternatives: `node-llama-cpp` + GGUF (self-contained, KongCode's path) or a hosted embedding API. Changing the model later = re-embed all rows + redefine the index. Keep the dimension as a single config constant, never a scattered magic number.

**Embedding input limit / truncation (KongCode lesson):** embedding models cap input (BGE-M3 ≈ 8192 tokens / ~6000 chars). For long `content`, the tail may not be embedded — set `embedding_truncated = true` so recall fidelity is auditable and reranking can compensate. Chunk very long content into multiple `memory` rows rather than silently truncating.

## 7a. Claude Code session-id bridging (KongCode lesson)

`session.cc_session_id` is a **bridge field, not a record link.** Claude Code transcript turns/messages often arrive *before* the `session` row exists (the hook that creates the session fires after the first turn). So:
- Store Claude Code's UUID as a plain string on `session` and on `message`/`agent_event` rows.
- Join via `SELECT * FROM session WHERE cc_session_id = $uuid`, **not** a direct `message->session` edge.
- Missing this makes transcript rows graph-orphans (unretrievable). Create the `session` row lazily/idempotently via the **dedup_key VALUE pattern** (D-008): `dedup_key = (cc_session_id OR id)` with a UNIQUE index on `dedup_key`, plus a NON-unique `session_cc` index on `cc_session_id` for the bridge lookup. This avoids the NONE-collision a naive `UNIQUE` on `cc_session_id` would cause for sessions with no Claude Code id.

---

## 7b. Backup tiers (KongCode lesson)

KongCode's three backup modes reveal a useful schema partition: **knowledge core** (memory, concepts, graph edges, plan, security findings) is ~100× smaller than **transcript volume** (`message`, `routing_event`, `agent_event`, transcripts). Offer:
- **Native/full** — copy the SurrealDB data dir (lossless, includes embeddings + indexes).
- **Knowledge-only (JSONL)** — export knowledge-core tables without embeddings/transcripts; small, portable, good for sharing/seeding a fresh install (re-embed on import).
- **Semantic** — knowledge + embeddings, drop low-utility rows.
Design queries so "knowledge core" is cleanly separable from "transcript volume" (it already is, by table).

## 8. Open data-model items

- **Isolation level** for the server (surrealkv) backend transaction isolation — verify (D-006).
- **Embedding dimension/model** — pick before writing the index (above).
- **`engine_metric`** table — resolved: heartbeat/orchestrator metrics fold into `agent_event` (cycle rows); no separate `engine_metric` table.
- **Versioning/time-travel** — if wanted, evaluate `surrealkv+versioned://` (currently beta) instead of RocksDB (D-007).
