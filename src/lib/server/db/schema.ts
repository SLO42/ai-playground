// TASK 0.c — canonical schema migrations for ALL DATA-MODEL.md §4 tables.
//
// This is the authoritative translation of DATA-MODEL.md §4 into ordered,
// idempotent `Migration` objects consumed by runMigrations() (migrate.ts). Each
// migration is a verbatim transcription of the DATA-MODEL SurrealQL, with the
// MEMORY-SPEC §6 gotchas honored:
//   - HNSW indexes use 2.x syntax: DIMENSION 1024 DIST COSINE TYPE F32 EFC 150
//     M 12 — NEVER "M0" (invalid in 2.x).
//   - dedup_key VALUE fields (session/memory/work_item) + their UNIQUE indexes
//     follow the D-008 NONE-collision-dodging pattern; backfillValueField()
//     touches pre-existing rows (no-op on a fresh DB, but correct on import).
//   - boolean/enum fields that can be read back on a RETURN AFTER write carry a
//     concrete non-NONE DEFAULT (§6.2) — see memory.surfaceable, work_item.status,
//     etc., all declared with DEFAULTs straight from DATA-MODEL.
//
// Migrations are deliberately split by DATA-MODEL subsection for reviewability;
// SurrealDB DDL is additive and order-independent across tables, but record-link
// FIELD types reference other tables, so referenced tables are defined first.
//
// DDL runs under the ROOT/provisioning connection only (D-026c) — never the
// least-priv runtime user (migrate.runMigrations takes a root Db).

import { backfillValueField, type Migration } from './migrate';

// ── §4.1 Project & plan ──────────────────────────────────────────────────────
const m0001_project_plan: Migration = {
	id: '0001_project_plan',
	up: `
		DEFINE TABLE project SCHEMAFULL;
		DEFINE FIELD slug         ON project TYPE string;
		DEFINE FIELD name         ON project TYPE string;
		DEFINE FIELD root_path    ON project TYPE string;
		DEFINE FIELD ecosystem    ON project TYPE array<string> DEFAULT [];
		DEFINE FIELD build_tool   ON project TYPE option<string>;
		DEFINE FIELD test_command ON project TYPE option<string>;
		DEFINE FIELD repo_url     ON project TYPE option<string>;
		DEFINE FIELD status       ON project TYPE string DEFAULT "active"
			ASSERT $value IN ["active","paused","archived"];
		DEFINE FIELD created_at   ON project TYPE datetime DEFAULT time::now();
		DEFINE FIELD updated_at   ON project TYPE datetime DEFAULT time::now();

		DEFINE FIELD plan                    ON project TYPE option<object>;
		DEFINE FIELD plan.purpose            ON project TYPE option<string>;
		DEFINE FIELD plan.long_term_vision   ON project TYPE option<string>;
		DEFINE FIELD plan.role               ON project TYPE option<string>;
		DEFINE FIELD plan.definition_of_done ON project TYPE option<string>;

		DEFINE TABLE release SCHEMAFULL;
		DEFINE FIELD project    ON release TYPE record<project>;
		DEFINE FIELD version    ON release TYPE string;
		DEFINE FIELD title      ON release TYPE option<string>;
		DEFINE FIELD status     ON release TYPE string DEFAULT "planned"
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
		DEFINE FIELD project ON feature TYPE record<project>;
		DEFINE FIELD release ON feature TYPE option<record<release>>;
		DEFINE FIELD title   ON feature TYPE string;
		DEFINE FIELD detail  ON feature TYPE option<string>;
		DEFINE FIELD status  ON feature TYPE string DEFAULT "planned"
			ASSERT $value IN ["planned","in_progress","done","dropped"];

		DEFINE TABLE sprint SCHEMAFULL;
		DEFINE FIELD project ON sprint TYPE record<project>;
		DEFINE FIELD name    ON sprint TYPE string;
		DEFINE FIELD starts  ON sprint TYPE option<datetime>;
		DEFINE FIELD ends    ON sprint TYPE option<datetime>;

		DEFINE INDEX project_slug      ON project FIELDS slug UNIQUE;
		DEFINE INDEX release_by_project ON release FIELDS project;
	`
};

// ── §4.2 Tasks ───────────────────────────────────────────────────────────────
const m0002_task: Migration = {
	id: '0002_task',
	up: `
		DEFINE TABLE task SCHEMAFULL;
		DEFINE FIELD project     ON task TYPE record<project>;
		DEFINE FIELD title       ON task TYPE string;
		DEFINE FIELD description  ON task TYPE string;
		DEFINE FIELD status      ON task TYPE string DEFAULT "backlog"
			ASSERT $value IN ["backlog","ready","in_progress","review","blocked","done","failed"];
		DEFINE FIELD priority    ON task TYPE string DEFAULT "normal"
			ASSERT $value IN ["low","normal","high","critical"];
		DEFINE FIELD origin      ON task TYPE string DEFAULT "manual"
			ASSERT $value IN ["manual","scanner","follow_up","review","release"];
		DEFINE FIELD parent      ON task TYPE option<record<task>>;
		DEFINE FIELD created_at  ON task TYPE datetime DEFAULT time::now();
		DEFINE FIELD updated_at  ON task TYPE datetime DEFAULT time::now();

		DEFINE INDEX task_by_project        ON task FIELDS project;
		DEFINE INDEX task_by_status         ON task FIELDS status;
		DEFINE INDEX task_by_project_status ON task FIELDS project, status;
	`
};

// ── §4.3 Agents, sessions, runtime events ────────────────────────────────────
// workflow_run is referenced by session.workflow_run but defined in §4.11; define
// session's link as option<record<workflow_run>> — SurrealDB resolves record link
// targets lazily, so forward references are fine. We still order workflow before
// session is queried; the FIELD DDL itself does not require the target to exist.
const m0003_session_message: Migration = {
	id: '0003_session_message',
	up: `
		DEFINE TABLE agent_slot SCHEMAFULL;
		DEFINE FIELD name ON agent_slot TYPE string;
		DEFINE FIELD tier ON agent_slot TYPE string ASSERT $value IN ["local","haiku","sonnet","opus"];
		DEFINE FIELD role ON agent_slot TYPE string;
		DEFINE FIELD busy ON agent_slot TYPE bool DEFAULT false;

		DEFINE TABLE session SCHEMAFULL;
		DEFINE FIELD project        ON session TYPE option<record<project>>;
		DEFINE FIELD task           ON session TYPE option<record<task>>;
		DEFINE FIELD kind           ON session TYPE string
			ASSERT $value IN ["chat","task","review","release","discussion"];
		DEFINE FIELD model          ON session TYPE object;
		DEFINE FIELD model.provider ON session TYPE string;
		DEFINE FIELD model.model_id ON session TYPE string;
		DEFINE FIELD model.tier     ON session TYPE option<string>;
		DEFINE FIELD status         ON session TYPE string DEFAULT "running"
			ASSERT $value IN ["running","done","failed","cancelled"];
		DEFINE FIELD pid            ON session TYPE option<int>;
		DEFINE FIELD runtime        ON session TYPE string DEFAULT "claude-code"
			ASSERT $value IN ["claude-code","ollama","claude-direct"];
		DEFINE FIELD cc_session_id  ON session TYPE option<string>;
		DEFINE FIELD workflow_run   ON session TYPE option<record<workflow_run>>;
		DEFINE FIELD started_at     ON session TYPE datetime DEFAULT time::now();
		DEFINE FIELD ended_at       ON session TYPE option<datetime>;
		DEFINE FIELD user_turn_count ON session TYPE int DEFAULT 0;
		DEFINE FIELD tool_iter_count ON session TYPE int DEFAULT 0;

		DEFINE TABLE message SCHEMAFULL;
		DEFINE FIELD session   ON message TYPE record<session>;
		DEFINE FIELD role      ON message TYPE string ASSERT $value IN ["user","assistant","tool","system"];
		DEFINE FIELD content   ON message TYPE string;
		DEFINE FIELD tool_call ON message TYPE option<object>;
		DEFINE FIELD at        ON message TYPE datetime DEFAULT time::now();

		DEFINE INDEX message_by_session ON message FIELDS session;
		DEFINE INDEX session_by_project ON session FIELDS project;
		-- dedup_key VALUE pattern (D-008): fall back to id when cc_session_id is NONE.
		DEFINE FIELD dedup_key ON session VALUE (cc_session_id OR id);
		DEFINE INDEX session_dedup           ON session FIELDS dedup_key UNIQUE;
		DEFINE INDEX session_cc              ON session FIELDS cc_session_id;
		DEFINE INDEX session_by_status       ON session FIELDS status;
		DEFINE INDEX session_by_workflow_run ON session FIELDS workflow_run;
		${backfillValueField('session', 'dedup_key')}
	`
};

// ── §4.4 Analytics ───────────────────────────────────────────────────────────
const m0004_analytics: Migration = {
	id: '0004_analytics',
	up: `
		DEFINE TABLE routing_event SCHEMAFULL;
		DEFINE FIELD task          ON routing_event TYPE option<record<task>>;
		DEFINE FIELD project       ON routing_event TYPE option<record<project>>;
		DEFINE FIELD chosen        ON routing_event TYPE object;
		DEFINE FIELD chosen.provider ON routing_event TYPE string;
		DEFINE FIELD chosen.model_id ON routing_event TYPE string;
		DEFINE FIELD chosen.tier   ON routing_event TYPE option<string>;
		DEFINE FIELD method        ON routing_event TYPE string;
		DEFINE FIELD reason        ON routing_event TYPE string;
		DEFINE FIELD complexity    ON routing_event TYPE option<float>;
		DEFINE FIELD alternatives  ON routing_event TYPE option<array<object>>;
		DEFINE FIELD at            ON routing_event TYPE datetime DEFAULT time::now();

		DEFINE INDEX routing_event_by_project ON routing_event FIELDS project;
		DEFINE INDEX routing_event_by_task    ON routing_event FIELDS task;

		DEFINE TABLE agent_event SCHEMAFULL;
		DEFINE FIELD session        ON agent_event TYPE option<record<session>>;
		DEFINE FIELD project        ON agent_event TYPE option<record<project>>;
		DEFINE FIELD type           ON agent_event TYPE string
			ASSERT $value IN ["spawn","completion","escalation","cancel","error"];
		DEFINE FIELD model          ON agent_event TYPE option<object>;
		DEFINE FIELD model.provider ON agent_event TYPE option<string>;
		DEFINE FIELD model.model_id ON agent_event TYPE option<string>;
		DEFINE FIELD model.tier     ON agent_event TYPE option<string>;
		DEFINE FIELD tokens_in      ON agent_event TYPE option<int>;
		DEFINE FIELD tokens_out     ON agent_event TYPE option<int>;
		DEFINE FIELD cost_usd       ON agent_event TYPE option<float>;
		DEFINE FIELD duration_ms    ON agent_event TYPE option<int>;
		DEFINE FIELD detail         ON agent_event TYPE option<object>;
		DEFINE FIELD at             ON agent_event TYPE datetime DEFAULT time::now();

		DEFINE INDEX agent_event_by_project ON agent_event FIELDS project;
		DEFINE INDEX agent_event_by_type    ON agent_event FIELDS type;
	`
};

// ── §4.5 Memory (semantic/episodic/procedural) + §4.5a audit log ─────────────
const m0005_memory: Migration = {
	id: '0005_memory',
	up: `
		DEFINE TABLE memory SCHEMAFULL;
		DEFINE FIELD project   ON memory TYPE option<record<project>>;
		DEFINE FIELD kind      ON memory TYPE string DEFAULT "semantic"
			ASSERT $value IN ["semantic","episodic","procedural"];
		DEFINE FIELD namespace ON memory TYPE string DEFAULT "default";
		DEFINE FIELD key       ON memory TYPE option<string>;
		DEFINE FIELD content   ON memory TYPE string;
		DEFINE FIELD embedding ON memory TYPE array<float>;
		DEFINE FIELD tags      ON memory TYPE option<array<string>>;
		DEFINE FIELD source    ON memory TYPE option<string>;
		DEFINE FIELD scope     ON memory TYPE string DEFAULT "project"
			ASSERT $value IN ["project","global"];
		DEFINE FIELD importance   ON memory TYPE float DEFAULT 5.0;
		DEFINE FIELD confidence   ON memory TYPE float DEFAULT 1.0;
		DEFINE FIELD access_count ON memory TYPE int DEFAULT 0;
		DEFINE FIELD last_accessed ON memory TYPE option<datetime>;
		DEFINE FIELD embedding_truncated ON memory TYPE bool DEFAULT false;
		-- Tiered memory (tier 0 = always-loaded directive, no KNN; 1 = long-term).
		DEFINE FIELD tier ON memory TYPE int DEFAULT 1;
		-- Fibonacci/backoff resurfacing.
		DEFINE FIELD surfaceable     ON memory TYPE bool DEFAULT false;
		DEFINE FIELD next_surface_at ON memory TYPE option<datetime>;
		DEFINE FIELD fib_index       ON memory TYPE int DEFAULT 0;
		DEFINE FIELD surface_count   ON memory TYPE int DEFAULT 0;
		DEFINE FIELD last_surfaced   ON memory TYPE option<datetime>;
		-- Append-only soft-archive (D-015).
		DEFINE FIELD status ON memory TYPE string DEFAULT "active"
			ASSERT $value IN ["active","archived","superseded"];
		DEFINE FIELD archived_at    ON memory TYPE option<datetime>;
		DEFINE FIELD archive_reason ON memory TYPE option<string>;
		DEFINE FIELD superseded_by  ON memory TYPE option<record<memory>>;
		-- Consolidation umbrella forwarding (D-031).
		DEFINE FIELD absorbed_into  ON memory TYPE option<record<memory>>;
		-- D-026 secret/PII screen.
		DEFINE FIELD screen_status ON memory TYPE string DEFAULT "clean"
			ASSERT $value IN ["clean","redacted","quarantined"];
		DEFINE FIELD screened_at ON memory TYPE option<datetime>;
		DEFINE FIELD created_at ON memory TYPE datetime DEFAULT time::now();
		DEFINE FIELD updated_at ON memory TYPE datetime DEFAULT time::now();

		-- HNSW vector index. 1024-dim (D-014). 2.x syntax — NO M0.
		DEFINE INDEX memory_vec ON memory FIELDS embedding
			HNSW DIMENSION 1024 DIST COSINE TYPE F32 EFC 150 M 12;

		-- dedup_key VALUE pattern (D-008): namespace + key, fall back to id.
		DEFINE FIELD dedup_key ON memory VALUE (namespace + '|' + (key OR <string>id));
		DEFINE INDEX memory_dedup ON memory FIELDS dedup_key UNIQUE;

		DEFINE INDEX memory_by_project ON memory FIELDS project;
		DEFINE INDEX memory_resurface  ON memory FIELDS surfaceable, next_surface_at;

		${backfillValueField('memory', 'dedup_key')}

		-- §4.5a Memory audit log (mem0 three-table split). Append-only.
		DEFINE TABLE memory_history SCHEMAFULL;
		DEFINE FIELD memory ON memory_history TYPE option<record<memory>>;
		DEFINE FIELD op     ON memory_history TYPE string
			ASSERT $value IN ["add","supersede","archive"];
		DEFINE FIELD before ON memory_history TYPE option<object>;
		DEFINE FIELD after  ON memory_history TYPE option<object>;
		DEFINE FIELD at     ON memory_history TYPE datetime DEFAULT time::now();

		DEFINE INDEX memory_history_by_memory ON memory_history FIELDS memory;
	`
};

// ── §4.8 Full-text search (defines analyzer + memory_fts on the memory table) ─
// Kept separate from §4.5 so the analyzer is defined once and the FTS index is
// clearly the 2.x form (SEARCH ANALYZER; 3.x renames to FULLTEXT ANALYZER, D-009).
const m0006_memory_fts: Migration = {
	id: '0006_memory_fts',
	up: `
		DEFINE ANALYZER text_an TOKENIZERS blank, class, camel, punct
			FILTERS lowercase, ascii, snowball(english);

		DEFINE INDEX memory_fts ON memory FIELDS content
			SEARCH ANALYZER text_an BM25 HIGHLIGHTS;
	`
};

// ── §4.6 Knowledge graph — entities + typed edges ────────────────────────────
const m0007_graph: Migration = {
	id: '0007_graph',
	up: `
		DEFINE TABLE entity SCHEMAFULL;
		DEFINE FIELD label   ON entity TYPE string;
		DEFINE FIELD type    ON entity TYPE string;
		DEFINE FIELD project ON entity TYPE option<record<project>>;
		DEFINE FIELD status  ON entity TYPE string DEFAULT "active"
			ASSERT $value IN ["active","archived","superseded"];

		DEFINE TABLE references TYPE RELATION IN memory|entity OUT memory|entity SCHEMAFULL;
		DEFINE FIELD kind   ON references TYPE string
			ASSERT $value IN ["supports","contradicts","derived_from","mentions","relates_to"];
		DEFINE FIELD weight ON references TYPE float DEFAULT 1.0;
		DEFINE FIELD at     ON references TYPE datetime DEFAULT time::now();
	`
};

// ── §4.7 Services, processes, incidents, notifications ───────────────────────
const m0008_services: Migration = {
	id: '0008_services',
	up: `
		DEFINE TABLE service SCHEMAFULL;
		DEFINE FIELD name       ON service TYPE string;
		DEFINE FIELD status     ON service TYPE string DEFAULT "unknown"
			ASSERT $value IN ["running","stopped","crashed","unknown"];
		DEFINE FIELD pid        ON service TYPE option<int>;
		DEFINE FIELD checked_at ON service TYPE datetime DEFAULT time::now();

		DEFINE TABLE process SCHEMAFULL;
		DEFINE FIELD pid        ON process TYPE int;
		DEFINE FIELD kind       ON process TYPE string;
		DEFINE FIELD session    ON process TYPE option<record<session>>;
		DEFINE FIELD started_at ON process TYPE datetime DEFAULT time::now();

		DEFINE INDEX process_by_pid ON process FIELDS pid UNIQUE;

		DEFINE TABLE incident SCHEMAFULL;
		DEFINE FIELD title    ON incident TYPE string;
		DEFINE FIELD detail   ON incident TYPE option<string>;
		DEFINE FIELD severity ON incident TYPE string DEFAULT "info"
			ASSERT $value IN ["info","warn","error","critical"];
		DEFINE FIELD at       ON incident TYPE datetime DEFAULT time::now();

		DEFINE TABLE notification SCHEMAFULL;
		DEFINE FIELD message ON notification TYPE string;
		DEFINE FIELD read    ON notification TYPE bool DEFAULT false;
		DEFINE FIELD at      ON notification TYPE datetime DEFAULT time::now();
	`
};

// ── §4.9 Security findings ───────────────────────────────────────────────────
const m0009_security: Migration = {
	id: '0009_security',
	up: `
		DEFINE TABLE security_finding SCHEMAFULL;
		DEFINE FIELD project  ON security_finding TYPE option<record<project>>;
		DEFINE FIELD rule     ON security_finding TYPE string;
		DEFINE FIELD severity ON security_finding TYPE string
			ASSERT $value IN ["low","medium","high","critical"];
		DEFINE FIELD file     ON security_finding TYPE option<string>;
		DEFINE FIELD detail   ON security_finding TYPE option<string>;
		DEFINE FIELD status   ON security_finding TYPE string DEFAULT "active"
			ASSERT $value IN ["active","archived","superseded"];
		DEFINE FIELD archived_at    ON security_finding TYPE option<datetime>;
		DEFINE FIELD archive_reason ON security_finding TYPE option<string>;
		DEFINE FIELD superseded_by  ON security_finding TYPE option<record<security_finding>>;
		DEFINE FIELD at       ON security_finding TYPE datetime DEFAULT time::now();
	`
};

// ── §4.10 Claude Code harness — config mirror ────────────────────────────────
const m0010_cc_mirror: Migration = {
	id: '0010_cc_mirror',
	up: `
		DEFINE TABLE cc_scope SCHEMAFULL;
		DEFINE FIELD kind    ON cc_scope TYPE string ASSERT $value IN ["project","global"];
		DEFINE FIELD project ON cc_scope TYPE option<record<project>>;
		DEFINE FIELD path    ON cc_scope TYPE string;

		DEFINE TABLE cc_settings SCHEMAFULL;
		DEFINE FIELD scope           ON cc_settings TYPE record<cc_scope>;
		DEFINE FIELD file_path       ON cc_settings TYPE string;
		DEFINE FIELD permissions     ON cc_settings TYPE option<object>;
		DEFINE FIELD env             ON cc_settings TYPE option<object>;
		DEFINE FIELD enabled_plugins ON cc_settings TYPE option<object>;
		DEFINE FIELD raw             ON cc_settings TYPE object;
		DEFINE FIELD synced_at       ON cc_settings TYPE datetime DEFAULT time::now();

		DEFINE TABLE cc_hook SCHEMAFULL;
		DEFINE FIELD scope   ON cc_hook TYPE record<cc_scope>;
		DEFINE FIELD event   ON cc_hook TYPE string;
		DEFINE FIELD matcher ON cc_hook TYPE option<string>;
		DEFINE FIELD command ON cc_hook TYPE string;
		DEFINE FIELD timeout ON cc_hook TYPE option<int>;

		DEFINE TABLE cc_agent SCHEMAFULL;
		DEFINE FIELD scope       ON cc_agent TYPE record<cc_scope>;
		DEFINE FIELD file_path   ON cc_agent TYPE string;
		DEFINE FIELD name        ON cc_agent TYPE string;
		DEFINE FIELD description ON cc_agent TYPE option<string>;
		DEFINE FIELD frontmatter ON cc_agent TYPE object;
		DEFINE FIELD category    ON cc_agent TYPE option<string>;

		DEFINE TABLE cc_skill SCHEMAFULL;
		DEFINE FIELD scope       ON cc_skill TYPE record<cc_scope>;
		DEFINE FIELD file_path   ON cc_skill TYPE string;
		DEFINE FIELD name        ON cc_skill TYPE string;
		DEFINE FIELD description ON cc_skill TYPE option<string>;
		DEFINE FIELD plugin      ON cc_skill TYPE option<string>;

		DEFINE TABLE cc_mcp_server SCHEMAFULL;
		DEFINE FIELD scope   ON cc_mcp_server TYPE record<cc_scope>;
		DEFINE FIELD name    ON cc_mcp_server TYPE string;
		DEFINE FIELD type    ON cc_mcp_server TYPE string ASSERT $value IN ["stdio","http","sse"];
		DEFINE FIELD command ON cc_mcp_server TYPE option<string>;
		DEFINE FIELD args    ON cc_mcp_server TYPE option<array<string>>;
		DEFINE FIELD url     ON cc_mcp_server TYPE option<string>;
		DEFINE FIELD env     ON cc_mcp_server TYPE option<object>;

		DEFINE INDEX cc_scope_by_project ON cc_scope FIELDS project;
		DEFINE INDEX cc_agent_by_scope   ON cc_agent FIELDS scope;
		DEFINE INDEX cc_skill_by_scope   ON cc_skill FIELDS scope;
	`
};

// ── §4.11 Workflows ──────────────────────────────────────────────────────────
const m0011_workflows: Migration = {
	id: '0011_workflows',
	up: `
		DEFINE TABLE workflow SCHEMAFULL;
		DEFINE FIELD name       ON workflow TYPE string;
		DEFINE FIELD project    ON workflow TYPE option<record<project>>;
		DEFINE FIELD steps      ON workflow TYPE array<object>;
		DEFINE FIELD trigger    ON workflow TYPE string DEFAULT "manual"
			ASSERT $value IN ["manual","event","periodic"];
		DEFINE FIELD created_at ON workflow TYPE datetime DEFAULT time::now();

		DEFINE TABLE workflow_run SCHEMAFULL;
		DEFINE FIELD workflow   ON workflow_run TYPE record<workflow>;
		DEFINE FIELD status     ON workflow_run TYPE string DEFAULT "running"
			ASSERT $value IN ["running","done","failed","cancelled"];
		DEFINE FIELD step_state ON workflow_run TYPE object DEFAULT {};
		DEFINE FIELD started_at ON workflow_run TYPE datetime DEFAULT time::now();
		DEFINE FIELD ended_at   ON workflow_run TYPE option<datetime>;

		DEFINE INDEX wfrun_by_workflow ON workflow_run FIELDS workflow;
	`
};

// ── §4.12 Work queue ─────────────────────────────────────────────────────────
const m0012_work_item: Migration = {
	id: '0012_work_item',
	up: `
		DEFINE TABLE work_item SCHEMAFULL;
		DEFINE FIELD work_type    ON work_item TYPE string;
		DEFINE FIELD session      ON work_item TYPE option<record<session>>;
		DEFINE FIELD project      ON work_item TYPE option<record<project>>;
		DEFINE FIELD priority     ON work_item TYPE int DEFAULT 5;
		DEFINE FIELD status       ON work_item TYPE string DEFAULT "pending"
			ASSERT $value IN ["pending","processing","done","failed"];
		DEFINE FIELD payload      ON work_item TYPE object;
		DEFINE FIELD attempts     ON work_item TYPE int DEFAULT 0;
		DEFINE FIELD claim_token  ON work_item TYPE option<string>;
		DEFINE FIELD handoff      ON work_item TYPE option<object>;
		DEFINE FIELD created_at   ON work_item TYPE datetime DEFAULT time::now();
		DEFINE FIELD completed_at ON work_item TYPE option<datetime>;
		-- Dedup the active window (dedup_key VALUE pattern, D-008).
		DEFINE FIELD dedup_key    ON work_item VALUE
			(IF status IN ["pending","processing"]
				THEN work_type + '|' + <string>(session OR '') + '|' + status
				ELSE <string>id END);
		DEFINE INDEX work_item_dedup ON work_item FIELDS dedup_key UNIQUE;
		DEFINE INDEX work_item_by_status_priority ON work_item FIELDS status, priority;

		${backfillValueField('work_item', 'dedup_key')}
	`
};

// ── §4.13 Retrieval outcomes ─────────────────────────────────────────────────
const m0013_retrieval_outcome: Migration = {
	id: '0013_retrieval_outcome',
	up: `
		DEFINE TABLE retrieval_outcome SCHEMAFULL;
		DEFINE FIELD session      ON retrieval_outcome TYPE option<record<session>>;
		DEFINE FIELD query_turn   ON retrieval_outcome TYPE option<record<message>>;
		DEFINE FIELD memory       ON retrieval_outcome TYPE option<record<memory>>;
		DEFINE FIELD citation_id  ON retrieval_outcome TYPE option<string>;
		DEFINE FIELD utilized     ON retrieval_outcome TYPE bool DEFAULT false;
		DEFINE FIELD cited        ON retrieval_outcome TYPE bool DEFAULT false;
		DEFINE FIELD tool_success ON retrieval_outcome TYPE option<bool>;
		DEFINE FIELD score        ON retrieval_outcome TYPE float;
		DEFINE FIELD was_neighbor ON retrieval_outcome TYPE bool DEFAULT false;
		DEFINE FIELD created_at   ON retrieval_outcome TYPE datetime DEFAULT time::now();

		DEFINE INDEX retrieval_outcome_by_session ON retrieval_outcome FIELDS session;
		DEFINE INDEX retrieval_outcome_by_memory  ON retrieval_outcome FIELDS memory;
	`
};

// ── §4.14 Learned skills + causal chains ─────────────────────────────────────
const m0014_skill_causal: Migration = {
	id: '0014_skill_causal',
	up: `
		DEFINE TABLE causal_chain SCHEMAFULL;
		DEFINE FIELD session      ON causal_chain TYPE option<record<session>>;
		DEFINE FIELD trigger      ON causal_chain TYPE string;
		DEFINE FIELD outcome      ON causal_chain TYPE string;
		DEFINE FIELD kind         ON causal_chain TYPE string
			ASSERT $value IN ["debug","refactor","feature","fix"];
		DEFINE FIELD success      ON causal_chain TYPE bool;
		DEFINE FIELD confidence   ON causal_chain TYPE float;
		DEFINE FIELD graduated_at ON causal_chain TYPE option<datetime>;
		DEFINE FIELD created_at   ON causal_chain TYPE datetime DEFAULT time::now();

		DEFINE TABLE skill SCHEMAFULL;
		DEFINE FIELD name           ON skill TYPE string;
		DEFINE FIELD description    ON skill TYPE string;
		DEFINE FIELD embedding      ON skill TYPE array<float>;
		DEFINE FIELD preconditions  ON skill TYPE option<string>;
		DEFINE FIELD steps          ON skill TYPE array<string>;
		DEFINE FIELD postconditions ON skill TYPE option<string>;
		DEFINE FIELD success_count  ON skill TYPE int DEFAULT 0;
		DEFINE FIELD failure_count  ON skill TYPE int DEFAULT 0;
		DEFINE FIELD graduated_at   ON skill TYPE option<datetime>;
		DEFINE FIELD source_causal_chain ON skill TYPE option<record<causal_chain>>;
		DEFINE FIELD status         ON skill TYPE string DEFAULT "active"
			ASSERT $value IN ["active","archived","superseded"];
		DEFINE FIELD archived_at    ON skill TYPE option<datetime>;
		DEFINE FIELD archive_reason ON skill TYPE option<string>;
		DEFINE FIELD superseded_by  ON skill TYPE option<record<skill>>;
		DEFINE FIELD created_at     ON skill TYPE datetime DEFAULT time::now();
		DEFINE FIELD last_used      ON skill TYPE option<datetime>;

		-- HNSW over skill embeddings. Same 1024-dim/COSINE as memory_vec (D-014). No M0.
		DEFINE INDEX skill_vec ON skill FIELDS embedding
			HNSW DIMENSION 1024 DIST COSINE TYPE F32 EFC 150 M 12;
		DEFINE INDEX skill_by_status        ON skill FIELDS status;
		DEFINE INDEX causal_chain_by_session ON causal_chain FIELDS session;
	`
};

// ── §4.15 Embedding cache (L2) ───────────────────────────────────────────────
const m0015_embedding_cache: Migration = {
	id: '0015_embedding_cache',
	up: `
		DEFINE TABLE embedding_cache SCHEMAFULL;
		DEFINE FIELD hash          ON embedding_cache TYPE string;
		DEFINE FIELD vector        ON embedding_cache TYPE array<float>;
		DEFINE FIELD model_version ON embedding_cache TYPE string;
		DEFINE FIELD created_at    ON embedding_cache TYPE datetime DEFAULT time::now();
		DEFINE FIELD pruned_at     ON embedding_cache TYPE option<datetime>;

		DEFINE INDEX embedding_cache_hash ON embedding_cache FIELDS hash UNIQUE;
	`
};

/**
 * The full, ordered DATA-MODEL §4 schema. Pass to runMigrations(root, …).
 * Order: referenced tables (project, session, memory, workflow, causal_chain)
 * precede their referrers where a hard dependency exists; otherwise grouped by
 * DATA-MODEL subsection for reviewability.
 */
export const schemaMigrations: Migration[] = [
	m0001_project_plan,
	m0002_task,
	m0003_session_message,
	m0004_analytics,
	m0005_memory,
	m0006_memory_fts,
	m0007_graph,
	m0008_services,
	m0009_security,
	m0010_cc_mirror,
	m0011_workflows,
	m0012_work_item,
	m0013_retrieval_outcome,
	m0014_skill_causal,
	m0015_embedding_cache
];
