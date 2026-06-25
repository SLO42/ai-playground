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
-- Two-cadence learning-fork nudge (D-027, MEMORY-SPEC §2.2). Persisted counters so the
-- modulo cadence (turn_index % N) survives Claude Code's per-message agent rebuilds —
-- an in-memory tick would reset. Memory review fires on user_turn_count; skill review on tool_iter_count.
DEFINE FIELD user_turn_count ON session TYPE int DEFAULT 0;   -- memory-review fork clock (every N user turns)
DEFINE FIELD tool_iter_count ON session TYPE int DEFAULT 0;   -- skill-review fork clock (every M tool calls)

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
DEFINE FIELD embedding ON memory TYPE array<float>;              -- 1024-dim — D-014 🟡: `bge-m3` (default) or `qwen3-embedding:0.6b` (cannibalize-validated); both 1024-dim so the index is unaffected. Must equal the memory_vec HNSW DIMENSION
DEFINE FIELD tags      ON memory TYPE option<array<string>>;
DEFINE FIELD source    ON memory TYPE option<string>;           -- claude-auto-memory|agent|scanner
DEFINE FIELD scope     ON memory TYPE string DEFAULT "project"  -- KongCode-style soft scoping
  ASSERT $value IN ["project","global"];
DEFINE FIELD importance ON memory TYPE float DEFAULT 5.0;       -- 0..10, decays with age
DEFINE FIELD confidence ON memory TYPE float DEFAULT 1.0;
DEFINE FIELD access_count ON memory TYPE int DEFAULT 0;         -- bumped on every recall
DEFINE FIELD last_accessed ON memory TYPE option<datetime>;    -- updated on recall (for decay)
DEFINE FIELD embedding_truncated ON memory TYPE bool DEFAULT false;  -- content tail not in vector (input-limit)
-- Tiered memory (kongcode, MEMORY-SPEC §6.8). Three operational tiers:
--   tier 0 = always-loaded directive, in context every turn → NO vector recall needed (KNN is pointless).
--   tier 1 (default) = long-term, vector-recalled via memory_vec HNSW.
-- Tier-0 membership is set by the operator/curator only — NEVER self-granted by recalled or injected
-- text (D-026; the "tier0 directives" hook string is content, not a grant).
DEFINE FIELD tier      ON memory TYPE int DEFAULT 1;            -- 0 = always-loaded directive (no KNN); 1 = long-term
-- Fibonacci / backoff resurfacing (kongcode, MEMORY-SPEC §6.8): proactively re-show items not seen in a while.
DEFINE FIELD surfaceable     ON memory TYPE bool DEFAULT false;     -- opted into the resurfacing schedule
DEFINE FIELD next_surface_at ON memory TYPE option<datetime>;      -- when this item is next eligible to resurface
DEFINE FIELD fib_index       ON memory TYPE int DEFAULT 0;         -- position in the Fibonacci backoff sequence
DEFINE FIELD surface_count   ON memory TYPE int DEFAULT 0;         -- times proactively resurfaced
DEFINE FIELD last_surfaced   ON memory TYPE option<datetime>;
-- Append-only soft-archive (D-015): never DELETE knowledge.
DEFINE FIELD status    ON memory TYPE string DEFAULT "active"
  ASSERT $value IN ["active","archived","superseded"];
DEFINE FIELD archived_at    ON memory TYPE option<datetime>;
DEFINE FIELD archive_reason ON memory TYPE option<string>;
DEFINE FIELD superseded_by  ON memory TYPE option<record<memory>>;
-- Consolidation umbrella forwarding (D-031, MEMORY-SPEC §5.1): when a near-dup member is merged into a
-- class-level umbrella, set absorbed_into → the umbrella and rewrite its `references` edges to the umbrella.
-- Readers FOLLOW this exactly like superseded_by (chase to the live umbrella row); no dangling edges.
DEFINE FIELD absorbed_into  ON memory TYPE option<record<memory>>;
-- D-026 secret/PII screen: set by the pre-store scanner (runs BEFORE embed, so the
-- HNSW index + embedding_cache never see raw secrets). Quarantined rows are excluded
-- from recall (active-set filter) and from the knowledge-only export.
DEFINE FIELD screen_status ON memory TYPE string DEFAULT "clean"
  ASSERT $value IN ["clean","redacted","quarantined"];
DEFINE FIELD screened_at ON memory TYPE option<datetime>;
DEFINE FIELD created_at ON memory TYPE datetime DEFAULT time::now();
DEFINE FIELD updated_at ON memory TYPE datetime DEFAULT time::now();

-- HNSW vector index. DIMENSION must match the embedding model.
-- 1024-dim — D-014 🟡: `bge-m3` (default) or `qwen3-embedding:0.6b` (cannibalize-validated); both 1024-dim so the index is unaffected.
-- DIST COSINE for normalized text embeddings.
DEFINE INDEX memory_vec ON memory FIELDS embedding
  HNSW DIMENSION 1024 DIST COSINE TYPE F32 EFC 150 M 12;

-- Dedup support for the bridge import (dedup_key VALUE pattern, D-008).
-- `key` is optional, so a naive UNIQUE on (namespace, key) would collide on the 2nd
-- keyless row (SurrealDB treats NONE as a value). Instead derive a dedup_key that
-- falls back to the record id when the natural key is NONE, then UNIQUE on that:
DEFINE FIELD dedup_key ON memory VALUE (namespace + '|' + (key OR <string>id));
DEFINE INDEX memory_dedup ON memory FIELDS dedup_key UNIQUE;

-- Project-scoped recall. Consider a composite (project, kind, status) for filtered recall.
DEFINE INDEX memory_by_project ON memory FIELDS project;
-- Hot path for the Fibonacci resurfacing sweep (MEMORY-SPEC §6.8): "what is due to resurface now?"
-- → SELECT … WHERE surfaceable = true AND next_surface_at <= time::now().
DEFINE INDEX memory_resurface ON memory FIELDS surfaceable, next_surface_at;
```

**Semantic recall (HNSW KNN):**
```sql
-- $q = query embedding (array<float>), K=10 neighbors, EF=40 search effort
SELECT id, content, project, tags, vector::distance::knn() AS dist
FROM memory
WHERE embedding <|10,40|> $q
  AND ( $project = NONE OR project = $project )
  AND ( status = "active" OR status IS NONE )   -- soft-archive filter (D-015)
  AND screen_status != "quarantined"            -- D-026 secret/PII screen
ORDER BY dist;            -- smaller = closer (cosine distance)
```
The index path returns cosine **distance**; the WMR formula wants cosine **similarity**, so convert with `similarity = 1 - dist`.

For tiny datasets use exact brute force with the similarity function (no index needed):
```sql
SELECT id, content, vector::similarity::cosine(embedding, $q) AS sim
FROM memory
WHERE ( $project = NONE OR project = $project )
  AND ( status = "active" OR status IS NONE )
  AND screen_status != "quarantined"            -- D-026 secret/PII screen
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

**Diversity control (D-031) — two mechanisms, no extra schema:**
- **Novelty gate (query time).** A **hard cosine-band cut on the candidate set** after KNN/rerank: drop members of a near-dup family so the agent's context isn't filled with five restatements of one fact (beats soft MMR on redundant corpora — MEMORY-SPEC §4.6). This is a runtime filter on candidates, **not** a stored field.
- **Consolidation (periodic).** The slow curator (D-027, MEMORY-SPEC §5.1) merges near-dup families into a class-level umbrella, sets each member's `absorbed_into` → the umbrella, and **rewrites that member's `references` edges (§4.6) to the umbrella** so the graph stays traversable. Runs as a `work_item` job (D-021).
- **Reader rule:** when a recalled row has `absorbed_into` (or `superseded_by`) set, **follow the pointer** to the live umbrella/replacement row — exactly the same chase as supersession. The gate fixes *what surfaces now*; consolidation fixes *what accumulates* (D-031 belt-and-suspenders).

### 4.5a Memory audit log (mem0 three-logical-tables)

mem0 keeps three logical tables even in one store (MEMORY-SPEC §6.9): `memory` (searchable, §4.5) + raw turns (≈ `message`, §4.3) + an **append-only audit log**. The audit table records every mutation — ADD on extraction, supersede on the deterministic conflict pass (D-028), archive on consolidation (D-031) — feeding the curator's tool-call audit (MEMORY-SPEC §5.2) and the conflict pass. **Append-only: never updated or deleted.**

> **D-026 secret screen:** screen the content BEFORE the snapshot is written, so the audit log isn't a scrubbed-content leak (the `before`/`after` snapshots must not carry secrets the live row had redacted). If a row is redacted *after* a snapshot was already written, treat that as an audited hard-delete exception to append-only for the affected snapshot field only.

```sql
DEFINE TABLE memory_history SCHEMAFULL;
DEFINE FIELD memory ON memory_history TYPE option<record<memory>>;  -- the row mutated (option<>: batch/extraction audit rows may be staged before the memory row is created)
DEFINE FIELD op     ON memory_history TYPE string
  ASSERT $value IN ["add","supersede","archive"];
DEFINE FIELD before ON memory_history TYPE option<object>;          -- prior snapshot (NONE for add)
DEFINE FIELD after  ON memory_history TYPE option<object>;          -- new snapshot (NONE for pure archive if desired)
DEFINE FIELD at     ON memory_history TYPE datetime DEFAULT time::now();

DEFINE INDEX memory_history_by_memory ON memory_history FIELDS memory;
```

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

> **D-030 (utilization loop feeds RANKING only, NOT pruning):** these rows are a **ranker input** (a WMR/ACAN feature — `utilized`/`cited`/`tool_success`/`was_neighbor` feed `historical_utility`). They do **NOT** drive the curator's keep/prune decision. **Pruning stays time/inactivity-based** (D-027 consolidator, archive-not-delete per D-015): outcome improves *what surfaces*, never *what survives* (low citation ≠ low worth; ranking is reversible per-query, pruning is soft-destructive). Revisit outcome-driven pruning post-v1.0.

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

### 4.14 Learned skills + causal chains (D-027 graduation, D-022 north-star)

The memory engine **synthesizes proven task sequences into reusable skills** (MEMORY-SPEC §5.4). These are the **learned/graduated** skills — distinct from the **authored** Claude Code skills mirrored in `cc_skill` (§4.10), which stay as files on disk (D-010/D-032). Per **D-032**, learned skills (and the user-model) live **in SurrealDB**, not files and not an external store: real-graph rows give traversal + RL counts that files/mem0 cannot do.

A `causal_chain` is the graduation *source*: a recorded trigger→outcome sequence (D-022 "extract → link → label → synthesize"). When a chain proves out, the curator graduates it into a `skill` **exactly once**, gated by a `graduated_at` watermark on the chain (idempotent — prevents duplicate skill synthesis).

```sql
-- A proven (or failed) action sequence; the synthesis source for skills.
DEFINE TABLE causal_chain SCHEMAFULL;
DEFINE FIELD session      ON causal_chain TYPE option<record<session>>;
DEFINE FIELD trigger      ON causal_chain TYPE string;        -- what kicked it off
DEFINE FIELD outcome      ON causal_chain TYPE string;        -- what resulted
DEFINE FIELD kind         ON causal_chain TYPE string
  ASSERT $value IN ["debug","refactor","feature","fix"];
DEFINE FIELD success      ON causal_chain TYPE bool;
DEFINE FIELD confidence   ON causal_chain TYPE float;
-- Once-only graduation watermark (D-022/D-027): a chain graduates into a skill exactly once.
-- Set when synthesized; prevents the curator re-synthesizing a duplicate skill from the same chain.
DEFINE FIELD graduated_at ON causal_chain TYPE option<datetime>;
DEFINE FIELD created_at    ON causal_chain TYPE datetime DEFAULT time::now();

-- Learned/graduated skill (D-027 graduation). In-store (D-032), NOT a file (cf. cc_skill §4.10).
DEFINE TABLE skill SCHEMAFULL;
DEFINE FIELD name          ON skill TYPE string;
DEFINE FIELD description   ON skill TYPE string;
DEFINE FIELD embedding     ON skill TYPE array<float>;        -- 1024-dim — D-014 🟡: `bge-m3` (default) or `qwen3-embedding:0.6b` (cannibalize-validated); both 1024-dim so the index is unaffected. Must equal the skill_vec HNSW DIMENSION
DEFINE FIELD preconditions ON skill TYPE option<string>;
DEFINE FIELD steps         ON skill TYPE array<string>;
DEFINE FIELD postconditions ON skill TYPE option<string>;
-- RL counts (MEMORY-SPEC §5.4) — sourced from retrieval/outcome signals (§4.13), inject as "adapt, don't follow".
DEFINE FIELD success_count ON skill TYPE int DEFAULT 0;
DEFINE FIELD failure_count ON skill TYPE int DEFAULT 0;
-- Once-only graduation watermark — gates re-graduation of this skill.
DEFINE FIELD graduated_at  ON skill TYPE option<datetime>;
DEFINE FIELD source_causal_chain ON skill TYPE option<record<causal_chain>>;  -- the chain it graduated from
-- Append-only soft-archive (D-015): knowledge-bearing, never DELETE. name-scoped supersession
-- (a newer skill of the SAME name supersedes the older one — set superseded_by on the old row).
DEFINE FIELD status        ON skill TYPE string DEFAULT "active"
  ASSERT $value IN ["active","archived","superseded"];
DEFINE FIELD archived_at    ON skill TYPE option<datetime>;
DEFINE FIELD archive_reason ON skill TYPE option<string>;
DEFINE FIELD superseded_by  ON skill TYPE option<record<skill>>;
DEFINE FIELD created_at     ON skill TYPE datetime DEFAULT time::now();
DEFINE FIELD last_used      ON skill TYPE option<datetime>;

-- HNSW over skill embeddings so a task can recall relevant graduated skills. Same 1024-dim / COSINE as memory_vec (D-014).
DEFINE INDEX skill_vec ON skill FIELDS embedding
  HNSW DIMENSION 1024 DIST COSINE TYPE F32 EFC 150 M 12;
DEFINE INDEX skill_by_status ON skill FIELDS status;          -- hot path: live-skill recall filter
DEFINE INDEX causal_chain_by_session ON causal_chain FIELDS session;
```

> **Watermark note:** both `graduated_at` watermarks are `option<datetime>` (NONE = not yet graduated) — read back on the synthesis write, so they follow the §4.16 `option<bool>`/enum `RETURN AFTER` rule. **Name-scoped supersession** is a write-time convention (the synthesizer finds the prior active skill of the same `name` and sets its `superseded_by`), not an index constraint — there is no UNIQUE on `name` (soft-archive keeps many same-name rows; the live one is `status = "active"`).

### 4.15 Embedding cache (L2 — kongcode two-tier cache)

Embedding is the hot path of every ADD and every recall (MEMORY-SPEC §7.1), so it is cached two-tier: **L1 = in-process LRU** (not a table), **L2 = this persistent table**. Keyed on content hash + model version so a model swap invalidates cleanly. *(kongcode — IDEAS only; reimplement the shape, do not lift code.)* The D-026 secret screen runs BEFORE embedding, so `embedding_cache` never stores a secret-derived vector.

```sql
DEFINE TABLE embedding_cache SCHEMAFULL;
DEFINE FIELD hash          ON embedding_cache TYPE string;     -- sha256(text) + model_version (clean invalidation on model change)
DEFINE FIELD vector        ON embedding_cache TYPE array<float>;
DEFINE FIELD model_version ON embedding_cache TYPE string;
DEFINE FIELD created_at    ON embedding_cache TYPE datetime DEFAULT time::now();
DEFINE FIELD pruned_at     ON embedding_cache TYPE option<datetime>;  -- soft-prune (consistent with D-015 ethos), NOT DELETE

DEFINE INDEX embedding_cache_hash ON embedding_cache FIELDS hash UNIQUE;
```

### 4.16 SurrealDB schema gotchas (memory engine) — see MEMORY-SPEC §6

Engineering gotchas the new tables above must respect (kongcode lessons, MEMORY-SPEC §6 — full detail there):

- **`option<bool>`/enum + `RETURN AFTER` missed-match / claim-starvation.** SurrealDB treats `NONE` as a distinct value that never matches `= true` (or any concrete enum value), so any boolean/enum field **read back on a `RETURN AFTER` write** (e.g. `causal_chain.success`, the `graduated_at` watermarks, `memory.surfaceable`) that can land in `NONE` is silently invisible to a `WHERE field = …` claim — the row is never matched and the work starves. This is NOT a lock deadlock; it is a silent missed match. Such a field **MUST EITHER be `option<T>`** (if it's legitimately absent on some rows) **OR carry a concrete non-NONE `DEFAULT`** (e.g. `surfaceable bool DEFAULT false`) so it can never default to `NONE` — never a bare typed field with no default that can land in `NONE`. Pre-existing rows must be backfilled in the same migration. This is the same class the `dedup_key VALUE` pattern (§4.3/§7a) already dodges; the general rule holds for every new boolean/enum.
- **Idempotent migrations.** One-time table-scan `UPDATE`s must be gated behind `LET <count> = (SELECT …); IF count > 0 { … }` so re-running the migration is a no-op; use `OVERWRITE` to widen tables/indexes; annotate each one-time migration with its removal condition.
- **Backfill `VALUE` fields.** A computed `VALUE` field (e.g. `dedup_key`) is only recomputed on write, so at schema-apply time **backfill it with a no-op touch-`UPDATE`** over existing rows; otherwise pre-existing rows carry a stale/empty key.

---

### 4.17 Skill harvest — skill_proposal (SH-1/SH-3, G2 agents-propose/operator-promotes)

A session that established a reusable procedure may DRAFT a `skill_proposal` — **DATA**, never a disk
write and never a `cc_skill` row (G2; D-010 disk-is-truth for the catalog; F-045: an un-catalogued id
fail-closes at spawn). A proposal is born `status='open'` and can ONLY reach the live catalog through a
recorded operator approval (SH-3 `promoteSkill`, which writes `<harvest>/skills/<name>/SKILL.md` then
syncs it into `cc_skill`). No self-promotion: `proposeSkill` cannot set `approved_by`. Mirrors `schema.ts`
m0060 + m0061 (dedup hardening) + m0064 (one-approved-per-name). Store: `src/lib/server/skills/`
(`proposal.ts`, `promote.ts`).

```sql
DEFINE TABLE skill_proposal SCHEMAFULL;
DEFINE FIELD name            ON skill_proposal TYPE string;             -- kebab skill id (the .claude/skills/<name>/ dir)
DEFINE FIELD description     ON skill_proposal TYPE string;
DEFINE FIELD body            ON skill_proposal TYPE string;             -- the SKILL.md markdown body
DEFINE FIELD trigger_context ON skill_proposal TYPE string;            -- when the skill applies
DEFINE FIELD source          ON skill_proposal TYPE string DEFAULT "session-harvest";
DEFINE FIELD session         ON skill_proposal TYPE option<record<session>>;   -- OMITTED when absent (§6.1)
DEFINE FIELD project         ON skill_proposal TYPE option<record<project>>;   -- OMITTED when absent
DEFINE FIELD evidence        ON skill_proposal TYPE array<string> DEFAULT [];  -- D-026-screened refs (bounded ≤32; UNIONed on recurrence-bump)
DEFINE FIELD occurrences     ON skill_proposal TYPE int DEFAULT 1;     -- bumped on a normalized (name+trigger) recurrence (RECUR/RANK)
DEFINE FIELD status          ON skill_proposal TYPE string DEFAULT "open"
    ASSERT $value IN ["open","approved","rejected"];                   -- never born "approved" (no self-promotion)
DEFINE FIELD approved_by     ON skill_proposal TYPE option<string>;    -- set ONLY by promote/reject (operator id); OMITTED otherwise
DEFINE FIELD approved_at     ON skill_proposal TYPE option<datetime>;  -- F-013: ISO string in the normalizer; absent → null → '—'
DEFINE FIELD norm_key        ON skill_proposal TYPE option<string>;    -- canonical normalized (name+trigger) key, set by the writer
DEFINE FIELD created_at      ON skill_proposal TYPE datetime DEFAULT time::now();
DEFINE FIELD updated_at      ON skill_proposal TYPE datetime DEFAULT time::now();

-- dedup_key VALUE (D-008): the normalized key WHILE open (one OPEN proposal per name+trigger), else the
-- record id — so closed (approved/rejected) same-key rows coexist for audit (G2 mark-don't-delete). The
-- UNIQUE index SERIALIZES concurrent same-key drafts at the DB (proposeSkill's read-or-bump-else-create
-- runs as one server-side tx; the loser collides and retries → BUMP). F-020: a VALUE field computes
-- against the row as-SET, BEFORE the status DEFAULT lands → a fresh CREATE has status=NONE; treat NONE as open.
DEFINE FIELD dedup_key ON skill_proposal VALUE
    (IF norm_key != NONE AND (status = "open" OR status = NONE) THEN norm_key ELSE <string>id END);
DEFINE INDEX skill_proposal_dedup ON skill_proposal FIELDS dedup_key UNIQUE;

-- approved_name_key VALUE (m0064, D-008): the name WHILE approved, else the record id — so AT MOST ONE
-- approved proposal can hold a given name. Open/rejected same-name rows coexist (each falls to its own id).
-- This is the DB backstop for same-name promote serialization (a name → ONE durable skill, never
-- last-writer-wins across two approved rows); promote.ts also guards it in JS and names the collision.
DEFINE FIELD approved_name_key ON skill_proposal VALUE
    (IF status = "approved" THEN name ELSE <string>id END);
DEFINE INDEX skill_proposal_approved_name ON skill_proposal FIELDS approved_name_key UNIQUE;

DEFINE INDEX skill_proposal_by_status ON skill_proposal FIELDS status;
DEFINE INDEX skill_proposal_by_name   ON skill_proposal FIELDS name;
```

**Promote integrity (SH-3 `promoteSkill`).** Operator-gated (requires a non-empty `approver`; agents have
no path to `approved_by`). At the disk-write boundary it is **D-026-symmetric** — it re-screens BOTH
`body` AND `description` (a quarantine → reject; a redactable span → `[REDACTED:*]`) and re-validates
`name` is a clean lower-kebab id (a non-kebab/traversal name fails closed, never coerced). Collision
ownership is **catalog-SCOPE-attributed** (a `cc_skill` row under OUR harvest scope), NOT bare disk
presence — a foreign-owned catalog name + a stale harvest file fails closed (no duplicate-name row). Disk
is written first (D-010), atomically (stage→rename, sweeping any stale `${name}.tmp-*` orphan), THEN
synced into `cc_skill`. Idempotent + interrupt-safe (F-015): a re-promote is a no-op; a partial prior
promote (file on disk, status still open) is absorbed.

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
| _(none — new)_ | `skill` table — learned/graduated skills (new, D-027/D-022); distinct from authored `cc_skill` files |
| _(none — new)_ | `causal_chain` table — graduation source (new, D-027/D-022) |
| _(none — new)_ | `memory_history` table — audit log (new, D-028; mem0 three-table split) |
| _(none — new)_ | `embedding_cache` table — L2 embed cache (new; kongcode shape, ideas-only) |
| _(none — new)_ | `session.user_turn_count` / `tool_iter_count` fields (new, D-027 two-cadence nudge) |
| _(none — new)_ | `memory` Tier-0 + resurfacing fields (`tier`, `surfaceable`, `next_surface_at`, `fib_index`, `surface_count`, `last_surfaced`) + `absorbed_into` (new, D-027/D-031) |

A one-time **importer script** (Phase 1) reads each v1 file/DB and writes the mapped records in transactions. Embeddings in `.swarm/memory.db` can be re-used if dimensions match the chosen embedding model; otherwise re-embed `content`.

**Harness mirror tables are NOT migrated** — `cc_settings`/`cc_hook`/`cc_agent`/`cc_skill`/`cc_mcp_server` are populated by the config-sync service reading `.claude/` + `.mcp.json` from disk on boot (filesystem is authoritative, D-010). v1's agent/skill scanners and `/hooks` page are superseded by this sync.

---

## 7. Embedding model note

1024-dim — D-014 🟡: `bge-m3` (default) or `qwen3-embedding:0.6b` (cannibalize-validated); both 1024-dim so the index is unaffected. Served by Ollama (reuses the local model server; KongCode proves BGE-M3 1024 works well, but runs it via `node-llama-cpp` because it has no Ollama — we do). HNSW `DIMENSION` is **locked to 1024** to match either model. Alternatives: `node-llama-cpp` + GGUF (self-contained, KongCode's path) or a hosted embedding API. Changing to a *different-dimension* model later = re-embed all rows + redefine the index. Keep the dimension as a single config constant, never a scattered magic number.

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
- **Knowledge-only (JSONL)** — export knowledge-core tables without embeddings/transcripts; small, portable, good for sharing/seeding a fresh install (re-embed on import). Emits ONLY `screen_status = "clean"` rows — hard-exclude `quarantined`/`redacted`-residue (D-026) so the shareable artifact never carries secrets.
- **Semantic** — knowledge + embeddings, drop low-utility rows.
Design queries so "knowledge core" is cleanly separable from "transcript volume" (it already is, by table).

## 8. Open data-model items

- **Isolation level** for the server (surrealkv) backend transaction isolation — verify (D-006).
- **Embedding dimension/model** — pick before writing the index (above).
- **`engine_metric`** table — resolved: heartbeat/orchestrator metrics fold into `agent_event` (cycle rows); no separate `engine_metric` table.
- **Memory-engine schema deltas** (MEMORY-SPEC — "Schema deltas flagged for DATA-MODEL") — **resolved**: folded into the schema above — `session.user_turn_count`/`tool_iter_count` (§4.3), `memory` Tier-0 + Fibonacci-resurfacing fields + `absorbed_into` (§4.5), `memory_history` audit (§4.5a), `skill` + `causal_chain` (§4.14), `embedding_cache` (§4.15). Honors D-030 (utilization → ranking only), D-031 (novelty gate + consolidation), D-032 (learned skills + user-model in-store).
- **User-model storage** — resolved by D-032: lives in SurrealDB (Honcho dropped). Exact `user_model` table shape is deferred to the user-modeling epic (MEMORY-SPEC §8, post-v1.0 candidate) — not declared here yet.
- **Versioning/time-travel** — if wanted, evaluate `surrealkv+versioned://` (currently beta) instead of RocksDB (D-007).
