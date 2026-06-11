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

import { backfillValueField, guardedScan, type Migration } from './migrate';

// ── §4.1 Project & plan ──────────────────────────────────────────────────────
const m0001_project_plan: Migration = {
	id: '0001_project_plan',
	up: `
		DEFINE TABLE OVERWRITE project SCHEMAFULL;
		DEFINE FIELD OVERWRITE slug         ON project TYPE string;
		DEFINE FIELD OVERWRITE name         ON project TYPE string;
		DEFINE FIELD OVERWRITE root_path    ON project TYPE string;
		DEFINE FIELD OVERWRITE ecosystem    ON project TYPE array<string> DEFAULT [];
		DEFINE FIELD OVERWRITE build_tool   ON project TYPE option<string>;
		DEFINE FIELD OVERWRITE test_command ON project TYPE option<string>;
		DEFINE FIELD OVERWRITE repo_url     ON project TYPE option<string>;
		DEFINE FIELD OVERWRITE status       ON project TYPE string DEFAULT "active"
			ASSERT $value IN ["active","paused","archived"];
		DEFINE FIELD OVERWRITE created_at   ON project TYPE datetime DEFAULT time::now();
		DEFINE FIELD OVERWRITE updated_at   ON project TYPE datetime DEFAULT time::now();

		DEFINE FIELD OVERWRITE plan                    ON project TYPE option<object>;
		DEFINE FIELD OVERWRITE plan.purpose            ON project TYPE option<string>;
		DEFINE FIELD OVERWRITE plan.long_term_vision   ON project TYPE option<string>;
		DEFINE FIELD OVERWRITE plan.role               ON project TYPE option<string>;
		DEFINE FIELD OVERWRITE plan.definition_of_done ON project TYPE option<string>;

		DEFINE TABLE OVERWRITE release SCHEMAFULL;
		DEFINE FIELD OVERWRITE project    ON release TYPE record<project>;
		DEFINE FIELD OVERWRITE version    ON release TYPE string;
		DEFINE FIELD OVERWRITE title      ON release TYPE option<string>;
		DEFINE FIELD OVERWRITE status     ON release TYPE string DEFAULT "planned"
			ASSERT $value IN ["planned","active","shipped"];
		DEFINE FIELD OVERWRITE shipped_at ON release TYPE option<datetime>;

		DEFINE TABLE OVERWRITE phase SCHEMAFULL;
		DEFINE FIELD OVERWRITE project ON phase TYPE record<project>;
		DEFINE FIELD OVERWRITE release ON phase TYPE option<record<release>>;
		DEFINE FIELD OVERWRITE name    ON phase TYPE string;
		DEFINE FIELD OVERWRITE order   ON phase TYPE int DEFAULT 0;
		DEFINE FIELD OVERWRITE status  ON phase TYPE string DEFAULT "todo"
			ASSERT $value IN ["todo","in_progress","done"];

		DEFINE TABLE OVERWRITE feature SCHEMAFULL;
		DEFINE FIELD OVERWRITE project ON feature TYPE record<project>;
		DEFINE FIELD OVERWRITE release ON feature TYPE option<record<release>>;
		DEFINE FIELD OVERWRITE title   ON feature TYPE string;
		DEFINE FIELD OVERWRITE detail  ON feature TYPE option<string>;
		DEFINE FIELD OVERWRITE status  ON feature TYPE string DEFAULT "planned"
			ASSERT $value IN ["planned","in_progress","done","dropped"];

		DEFINE TABLE OVERWRITE sprint SCHEMAFULL;
		DEFINE FIELD OVERWRITE project ON sprint TYPE record<project>;
		DEFINE FIELD OVERWRITE name    ON sprint TYPE string;
		DEFINE FIELD OVERWRITE starts  ON sprint TYPE option<datetime>;
		DEFINE FIELD OVERWRITE ends    ON sprint TYPE option<datetime>;

		DEFINE INDEX OVERWRITE project_slug      ON project FIELDS slug UNIQUE;
		DEFINE INDEX OVERWRITE release_by_project ON release FIELDS project;
	`
};

// ── §4.2 Tasks ───────────────────────────────────────────────────────────────
const m0002_task: Migration = {
	id: '0002_task',
	up: `
		DEFINE TABLE OVERWRITE task SCHEMAFULL;
		DEFINE FIELD OVERWRITE project     ON task TYPE record<project>;
		DEFINE FIELD OVERWRITE title       ON task TYPE string;
		DEFINE FIELD OVERWRITE description  ON task TYPE string;
		DEFINE FIELD OVERWRITE status      ON task TYPE string DEFAULT "backlog"
			ASSERT $value IN ["backlog","ready","in_progress","review","blocked","done","failed"];
		DEFINE FIELD OVERWRITE priority    ON task TYPE string DEFAULT "normal"
			ASSERT $value IN ["low","normal","high","critical"];
		DEFINE FIELD OVERWRITE origin      ON task TYPE string DEFAULT "manual"
			ASSERT $value IN ["manual","scanner","follow_up","review","release"];
		DEFINE FIELD OVERWRITE parent      ON task TYPE option<record<task>>;
		DEFINE FIELD OVERWRITE created_at  ON task TYPE datetime DEFAULT time::now();
		DEFINE FIELD OVERWRITE updated_at  ON task TYPE datetime DEFAULT time::now();

		DEFINE INDEX OVERWRITE task_by_project        ON task FIELDS project;
		DEFINE INDEX OVERWRITE task_by_status         ON task FIELDS status;
		DEFINE INDEX OVERWRITE task_by_project_status ON task FIELDS project, status;
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
		DEFINE TABLE OVERWRITE agent_slot SCHEMAFULL;
		DEFINE FIELD OVERWRITE name ON agent_slot TYPE string;
		DEFINE FIELD OVERWRITE tier ON agent_slot TYPE string ASSERT $value IN ["local","haiku","sonnet","opus"];
		DEFINE FIELD OVERWRITE role ON agent_slot TYPE string;
		DEFINE FIELD OVERWRITE busy ON agent_slot TYPE bool DEFAULT false;

		DEFINE TABLE OVERWRITE session SCHEMAFULL;
		DEFINE FIELD OVERWRITE project        ON session TYPE option<record<project>>;
		DEFINE FIELD OVERWRITE task           ON session TYPE option<record<task>>;
		DEFINE FIELD OVERWRITE kind           ON session TYPE string
			ASSERT $value IN ["chat","task","review","release","discussion"];
		DEFINE FIELD OVERWRITE model          ON session TYPE object;
		DEFINE FIELD OVERWRITE model.provider ON session TYPE string;
		DEFINE FIELD OVERWRITE model.model_id ON session TYPE string;
		DEFINE FIELD OVERWRITE model.tier     ON session TYPE option<string>;
		DEFINE FIELD OVERWRITE status         ON session TYPE string DEFAULT "running"
			ASSERT $value IN ["running","done","failed","cancelled"];
		DEFINE FIELD OVERWRITE pid            ON session TYPE option<int>;
		DEFINE FIELD OVERWRITE runtime        ON session TYPE string DEFAULT "claude-code"
			ASSERT $value IN ["claude-code","ollama","claude-direct"];
		DEFINE FIELD OVERWRITE cc_session_id  ON session TYPE option<string>;
		DEFINE FIELD OVERWRITE workflow_run   ON session TYPE option<record<workflow_run>>;
		DEFINE FIELD OVERWRITE started_at     ON session TYPE datetime DEFAULT time::now();
		DEFINE FIELD OVERWRITE ended_at       ON session TYPE option<datetime>;
		DEFINE FIELD OVERWRITE user_turn_count ON session TYPE int DEFAULT 0;
		DEFINE FIELD OVERWRITE tool_iter_count ON session TYPE int DEFAULT 0;

		DEFINE TABLE OVERWRITE message SCHEMAFULL;
		DEFINE FIELD OVERWRITE session   ON message TYPE record<session>;
		DEFINE FIELD OVERWRITE role      ON message TYPE string ASSERT $value IN ["user","assistant","tool","system"];
		DEFINE FIELD OVERWRITE content   ON message TYPE string;
		DEFINE FIELD OVERWRITE tool_call ON message TYPE option<object>;
		DEFINE FIELD OVERWRITE at        ON message TYPE datetime DEFAULT time::now();

		DEFINE INDEX OVERWRITE message_by_session ON message FIELDS session;
		DEFINE INDEX OVERWRITE session_by_project ON session FIELDS project;
		-- dedup_key VALUE pattern (D-008): fall back to id when cc_session_id is NONE.
		DEFINE FIELD OVERWRITE dedup_key ON session VALUE (cc_session_id OR id);
		DEFINE INDEX OVERWRITE session_dedup           ON session FIELDS dedup_key UNIQUE;
		DEFINE INDEX OVERWRITE session_cc              ON session FIELDS cc_session_id;
		DEFINE INDEX OVERWRITE session_by_status       ON session FIELDS status;
		DEFINE INDEX OVERWRITE session_by_workflow_run ON session FIELDS workflow_run;
		${backfillValueField('session', 'dedup_key')}
	`
};

// ── §4.4 Analytics ───────────────────────────────────────────────────────────
const m0004_analytics: Migration = {
	id: '0004_analytics',
	up: `
		DEFINE TABLE OVERWRITE routing_event SCHEMAFULL;
		DEFINE FIELD OVERWRITE task          ON routing_event TYPE option<record<task>>;
		DEFINE FIELD OVERWRITE project       ON routing_event TYPE option<record<project>>;
		DEFINE FIELD OVERWRITE chosen        ON routing_event TYPE object;
		DEFINE FIELD OVERWRITE chosen.provider ON routing_event TYPE string;
		DEFINE FIELD OVERWRITE chosen.model_id ON routing_event TYPE string;
		DEFINE FIELD OVERWRITE chosen.tier   ON routing_event TYPE option<string>;
		DEFINE FIELD OVERWRITE method        ON routing_event TYPE string;
		DEFINE FIELD OVERWRITE reason        ON routing_event TYPE string;
		DEFINE FIELD OVERWRITE complexity    ON routing_event TYPE option<float>;
		DEFINE FIELD OVERWRITE alternatives  ON routing_event TYPE option<array<object>>;
		DEFINE FIELD OVERWRITE at            ON routing_event TYPE datetime DEFAULT time::now();

		DEFINE INDEX OVERWRITE routing_event_by_project ON routing_event FIELDS project;
		DEFINE INDEX OVERWRITE routing_event_by_task    ON routing_event FIELDS task;

		DEFINE TABLE OVERWRITE agent_event SCHEMAFULL;
		DEFINE FIELD OVERWRITE session        ON agent_event TYPE option<record<session>>;
		DEFINE FIELD OVERWRITE project        ON agent_event TYPE option<record<project>>;
		DEFINE FIELD OVERWRITE type           ON agent_event TYPE string
			ASSERT $value IN ["spawn","completion","escalation","cancel","error"];
		DEFINE FIELD OVERWRITE model          ON agent_event TYPE option<object>;
		DEFINE FIELD OVERWRITE model.provider ON agent_event TYPE option<string>;
		DEFINE FIELD OVERWRITE model.model_id ON agent_event TYPE option<string>;
		DEFINE FIELD OVERWRITE model.tier     ON agent_event TYPE option<string>;
		DEFINE FIELD OVERWRITE tokens_in      ON agent_event TYPE option<int>;
		DEFINE FIELD OVERWRITE tokens_out     ON agent_event TYPE option<int>;
		DEFINE FIELD OVERWRITE cost_usd       ON agent_event TYPE option<float>;
		DEFINE FIELD OVERWRITE duration_ms    ON agent_event TYPE option<int>;
		DEFINE FIELD OVERWRITE detail         ON agent_event TYPE option<object>;
		DEFINE FIELD OVERWRITE at             ON agent_event TYPE datetime DEFAULT time::now();

		DEFINE INDEX OVERWRITE agent_event_by_project ON agent_event FIELDS project;
		DEFINE INDEX OVERWRITE agent_event_by_type    ON agent_event FIELDS type;
	`
};

// ── §4.5 Memory (semantic/episodic/procedural) + §4.5a audit log ─────────────
const m0005_memory: Migration = {
	id: '0005_memory',
	up: `
		DEFINE TABLE OVERWRITE memory SCHEMAFULL;
		DEFINE FIELD OVERWRITE project   ON memory TYPE option<record<project>>;
		DEFINE FIELD OVERWRITE kind      ON memory TYPE string DEFAULT "semantic"
			ASSERT $value IN ["semantic","episodic","procedural"];
		DEFINE FIELD OVERWRITE namespace ON memory TYPE string DEFAULT "default";
		DEFINE FIELD OVERWRITE key       ON memory TYPE option<string>;
		DEFINE FIELD OVERWRITE content   ON memory TYPE string;
		DEFINE FIELD OVERWRITE embedding ON memory TYPE array<float>;
		DEFINE FIELD OVERWRITE tags      ON memory TYPE option<array<string>>;
		DEFINE FIELD OVERWRITE source    ON memory TYPE option<string>;
		DEFINE FIELD OVERWRITE scope     ON memory TYPE string DEFAULT "project"
			ASSERT $value IN ["project","global"];
		DEFINE FIELD OVERWRITE importance   ON memory TYPE float DEFAULT 5.0;
		DEFINE FIELD OVERWRITE confidence   ON memory TYPE float DEFAULT 1.0;
		DEFINE FIELD OVERWRITE access_count ON memory TYPE int DEFAULT 0;
		DEFINE FIELD OVERWRITE last_accessed ON memory TYPE option<datetime>;
		DEFINE FIELD OVERWRITE embedding_truncated ON memory TYPE bool DEFAULT false;
		-- Tiered memory (tier 0 = always-loaded directive, no KNN; 1 = long-term).
		DEFINE FIELD OVERWRITE tier ON memory TYPE int DEFAULT 1;
		-- Fibonacci/backoff resurfacing.
		DEFINE FIELD OVERWRITE surfaceable     ON memory TYPE bool DEFAULT false;
		DEFINE FIELD OVERWRITE next_surface_at ON memory TYPE option<datetime>;
		DEFINE FIELD OVERWRITE fib_index       ON memory TYPE int DEFAULT 0;
		DEFINE FIELD OVERWRITE surface_count   ON memory TYPE int DEFAULT 0;
		DEFINE FIELD OVERWRITE last_surfaced   ON memory TYPE option<datetime>;
		-- Append-only soft-archive (D-015).
		DEFINE FIELD OVERWRITE status ON memory TYPE string DEFAULT "active"
			ASSERT $value IN ["active","archived","superseded"];
		DEFINE FIELD OVERWRITE archived_at    ON memory TYPE option<datetime>;
		DEFINE FIELD OVERWRITE archive_reason ON memory TYPE option<string>;
		DEFINE FIELD OVERWRITE superseded_by  ON memory TYPE option<record<memory>>;
		-- Consolidation umbrella forwarding (D-031).
		DEFINE FIELD OVERWRITE absorbed_into  ON memory TYPE option<record<memory>>;
		-- D-026 secret/PII screen.
		DEFINE FIELD OVERWRITE screen_status ON memory TYPE string DEFAULT "clean"
			ASSERT $value IN ["clean","redacted","quarantined"];
		DEFINE FIELD OVERWRITE screened_at ON memory TYPE option<datetime>;
		DEFINE FIELD OVERWRITE created_at ON memory TYPE datetime DEFAULT time::now();
		DEFINE FIELD OVERWRITE updated_at ON memory TYPE datetime DEFAULT time::now();

		-- HNSW vector index. 1024-dim (D-014). 2.x syntax — NO M0.
		DEFINE INDEX OVERWRITE memory_vec ON memory FIELDS embedding
			HNSW DIMENSION 1024 DIST COSINE TYPE F32 EFC 150 M 12;

		-- dedup_key VALUE pattern (D-008): namespace + key, fall back to id.
		DEFINE FIELD OVERWRITE dedup_key ON memory VALUE (namespace + '|' + (key OR <string>id));
		DEFINE INDEX OVERWRITE memory_dedup ON memory FIELDS dedup_key UNIQUE;

		DEFINE INDEX OVERWRITE memory_by_project ON memory FIELDS project;
		DEFINE INDEX OVERWRITE memory_resurface  ON memory FIELDS surfaceable, next_surface_at;

		${backfillValueField('memory', 'dedup_key')}

		-- §4.5a Memory audit log (mem0 three-table split). Append-only.
		DEFINE TABLE OVERWRITE memory_history SCHEMAFULL;
		DEFINE FIELD OVERWRITE memory ON memory_history TYPE option<record<memory>>;
		DEFINE FIELD OVERWRITE op     ON memory_history TYPE string
			ASSERT $value IN ["add","supersede","archive"];
		DEFINE FIELD OVERWRITE before ON memory_history TYPE option<object>;
		DEFINE FIELD OVERWRITE after  ON memory_history TYPE option<object>;
		DEFINE FIELD OVERWRITE at     ON memory_history TYPE datetime DEFAULT time::now();

		DEFINE INDEX OVERWRITE memory_history_by_memory ON memory_history FIELDS memory;
	`
};

// ── §4.8 Full-text search (defines analyzer + memory_fts on the memory table) ─
// Kept separate from §4.5 so the analyzer is defined once and the FTS index is
// clearly the 2.x form (SEARCH ANALYZER; 3.x renames to FULLTEXT ANALYZER, D-009).
const m0006_memory_fts: Migration = {
	id: '0006_memory_fts',
	up: `
		DEFINE ANALYZER OVERWRITE text_an TOKENIZERS blank, class, camel, punct
			FILTERS lowercase, ascii, snowball(english);

		DEFINE INDEX OVERWRITE memory_fts ON memory FIELDS content
			SEARCH ANALYZER text_an BM25 HIGHLIGHTS;
	`
};

// ── §4.6 Knowledge graph — entities + typed edges ────────────────────────────
const m0007_graph: Migration = {
	id: '0007_graph',
	up: `
		DEFINE TABLE OVERWRITE entity SCHEMAFULL;
		DEFINE FIELD OVERWRITE label   ON entity TYPE string;
		DEFINE FIELD OVERWRITE type    ON entity TYPE string;
		DEFINE FIELD OVERWRITE project ON entity TYPE option<record<project>>;
		DEFINE FIELD OVERWRITE status  ON entity TYPE string DEFAULT "active"
			ASSERT $value IN ["active","archived","superseded"];

		DEFINE TABLE OVERWRITE references TYPE RELATION IN memory|entity OUT memory|entity SCHEMAFULL;
		DEFINE FIELD OVERWRITE kind   ON references TYPE string
			ASSERT $value IN ["supports","contradicts","derived_from","mentions","relates_to"];
		DEFINE FIELD OVERWRITE weight ON references TYPE float DEFAULT 1.0;
		DEFINE FIELD OVERWRITE at     ON references TYPE datetime DEFAULT time::now();
	`
};

// ── §4.7 Services, processes, incidents, notifications ───────────────────────
const m0008_services: Migration = {
	id: '0008_services',
	up: `
		DEFINE TABLE OVERWRITE service SCHEMAFULL;
		DEFINE FIELD OVERWRITE name       ON service TYPE string;
		DEFINE FIELD OVERWRITE status     ON service TYPE string DEFAULT "unknown"
			ASSERT $value IN ["running","stopped","crashed","unknown"];
		DEFINE FIELD OVERWRITE pid        ON service TYPE option<int>;
		DEFINE FIELD OVERWRITE checked_at ON service TYPE datetime DEFAULT time::now();

		DEFINE TABLE OVERWRITE process SCHEMAFULL;
		DEFINE FIELD OVERWRITE pid        ON process TYPE int;
		DEFINE FIELD OVERWRITE kind       ON process TYPE string;
		DEFINE FIELD OVERWRITE session    ON process TYPE option<record<session>>;
		DEFINE FIELD OVERWRITE started_at ON process TYPE datetime DEFAULT time::now();

		DEFINE INDEX OVERWRITE process_by_pid ON process FIELDS pid UNIQUE;

		DEFINE TABLE OVERWRITE incident SCHEMAFULL;
		DEFINE FIELD OVERWRITE title    ON incident TYPE string;
		DEFINE FIELD OVERWRITE detail   ON incident TYPE option<string>;
		DEFINE FIELD OVERWRITE severity ON incident TYPE string DEFAULT "info"
			ASSERT $value IN ["info","warn","error","critical"];
		DEFINE FIELD OVERWRITE at       ON incident TYPE datetime DEFAULT time::now();

		DEFINE TABLE OVERWRITE notification SCHEMAFULL;
		DEFINE FIELD OVERWRITE message ON notification TYPE string;
		DEFINE FIELD OVERWRITE read    ON notification TYPE bool DEFAULT false;
		DEFINE FIELD OVERWRITE at      ON notification TYPE datetime DEFAULT time::now();
	`
};

// ── §4.9 Security findings ───────────────────────────────────────────────────
const m0009_security: Migration = {
	id: '0009_security',
	up: `
		DEFINE TABLE OVERWRITE security_finding SCHEMAFULL;
		DEFINE FIELD OVERWRITE project  ON security_finding TYPE option<record<project>>;
		DEFINE FIELD OVERWRITE rule     ON security_finding TYPE string;
		DEFINE FIELD OVERWRITE severity ON security_finding TYPE string
			ASSERT $value IN ["low","medium","high","critical"];
		DEFINE FIELD OVERWRITE file     ON security_finding TYPE option<string>;
		DEFINE FIELD OVERWRITE detail   ON security_finding TYPE option<string>;
		DEFINE FIELD OVERWRITE status   ON security_finding TYPE string DEFAULT "active"
			ASSERT $value IN ["active","archived","superseded"];
		DEFINE FIELD OVERWRITE archived_at    ON security_finding TYPE option<datetime>;
		DEFINE FIELD OVERWRITE archive_reason ON security_finding TYPE option<string>;
		DEFINE FIELD OVERWRITE superseded_by  ON security_finding TYPE option<record<security_finding>>;
		DEFINE FIELD OVERWRITE at       ON security_finding TYPE datetime DEFAULT time::now();
	`
};

// ── §4.10 Claude Code harness — config mirror ────────────────────────────────
const m0010_cc_mirror: Migration = {
	id: '0010_cc_mirror',
	up: `
		DEFINE TABLE OVERWRITE cc_scope SCHEMAFULL;
		DEFINE FIELD OVERWRITE kind    ON cc_scope TYPE string ASSERT $value IN ["project","global"];
		DEFINE FIELD OVERWRITE project ON cc_scope TYPE option<record<project>>;
		DEFINE FIELD OVERWRITE path    ON cc_scope TYPE string;

		DEFINE TABLE OVERWRITE cc_settings SCHEMAFULL;
		DEFINE FIELD OVERWRITE scope           ON cc_settings TYPE record<cc_scope>;
		DEFINE FIELD OVERWRITE file_path       ON cc_settings TYPE string;
		DEFINE FIELD OVERWRITE permissions     ON cc_settings TYPE option<object>;
		DEFINE FIELD OVERWRITE env             ON cc_settings TYPE option<object>;
		DEFINE FIELD OVERWRITE enabled_plugins ON cc_settings TYPE option<object>;
		DEFINE FIELD OVERWRITE raw             ON cc_settings TYPE object;
		DEFINE FIELD OVERWRITE synced_at       ON cc_settings TYPE datetime DEFAULT time::now();

		DEFINE TABLE OVERWRITE cc_hook SCHEMAFULL;
		DEFINE FIELD OVERWRITE scope   ON cc_hook TYPE record<cc_scope>;
		DEFINE FIELD OVERWRITE event   ON cc_hook TYPE string;
		DEFINE FIELD OVERWRITE matcher ON cc_hook TYPE option<string>;
		DEFINE FIELD OVERWRITE command ON cc_hook TYPE string;
		DEFINE FIELD OVERWRITE timeout ON cc_hook TYPE option<int>;

		DEFINE TABLE OVERWRITE cc_agent SCHEMAFULL;
		DEFINE FIELD OVERWRITE scope       ON cc_agent TYPE record<cc_scope>;
		DEFINE FIELD OVERWRITE file_path   ON cc_agent TYPE string;
		DEFINE FIELD OVERWRITE name        ON cc_agent TYPE string;
		DEFINE FIELD OVERWRITE description ON cc_agent TYPE option<string>;
		DEFINE FIELD OVERWRITE frontmatter ON cc_agent TYPE object;
		DEFINE FIELD OVERWRITE category    ON cc_agent TYPE option<string>;

		DEFINE TABLE OVERWRITE cc_skill SCHEMAFULL;
		DEFINE FIELD OVERWRITE scope       ON cc_skill TYPE record<cc_scope>;
		DEFINE FIELD OVERWRITE file_path   ON cc_skill TYPE string;
		DEFINE FIELD OVERWRITE name        ON cc_skill TYPE string;
		DEFINE FIELD OVERWRITE description ON cc_skill TYPE option<string>;
		DEFINE FIELD OVERWRITE plugin      ON cc_skill TYPE option<string>;

		DEFINE TABLE OVERWRITE cc_mcp_server SCHEMAFULL;
		DEFINE FIELD OVERWRITE scope   ON cc_mcp_server TYPE record<cc_scope>;
		DEFINE FIELD OVERWRITE name    ON cc_mcp_server TYPE string;
		DEFINE FIELD OVERWRITE type    ON cc_mcp_server TYPE string ASSERT $value IN ["stdio","http","sse"];
		DEFINE FIELD OVERWRITE command ON cc_mcp_server TYPE option<string>;
		DEFINE FIELD OVERWRITE args    ON cc_mcp_server TYPE option<array<string>>;
		DEFINE FIELD OVERWRITE url     ON cc_mcp_server TYPE option<string>;
		DEFINE FIELD OVERWRITE env     ON cc_mcp_server TYPE option<object>;

		DEFINE INDEX OVERWRITE cc_scope_by_project ON cc_scope FIELDS project;
		DEFINE INDEX OVERWRITE cc_agent_by_scope   ON cc_agent FIELDS scope;
		DEFINE INDEX OVERWRITE cc_skill_by_scope   ON cc_skill FIELDS scope;
	`
};

// ── §4.11 Workflows ──────────────────────────────────────────────────────────
const m0011_workflows: Migration = {
	id: '0011_workflows',
	up: `
		DEFINE TABLE OVERWRITE workflow SCHEMAFULL;
		DEFINE FIELD OVERWRITE name       ON workflow TYPE string;
		DEFINE FIELD OVERWRITE project    ON workflow TYPE option<record<project>>;
		DEFINE FIELD OVERWRITE steps      ON workflow TYPE array<object>;
		DEFINE FIELD OVERWRITE trigger    ON workflow TYPE string DEFAULT "manual"
			ASSERT $value IN ["manual","event","periodic"];
		DEFINE FIELD OVERWRITE created_at ON workflow TYPE datetime DEFAULT time::now();

		DEFINE TABLE OVERWRITE workflow_run SCHEMAFULL;
		DEFINE FIELD OVERWRITE workflow   ON workflow_run TYPE record<workflow>;
		DEFINE FIELD OVERWRITE status     ON workflow_run TYPE string DEFAULT "running"
			ASSERT $value IN ["running","done","failed","cancelled"];
		DEFINE FIELD OVERWRITE step_state ON workflow_run TYPE object DEFAULT {};
		DEFINE FIELD OVERWRITE started_at ON workflow_run TYPE datetime DEFAULT time::now();
		DEFINE FIELD OVERWRITE ended_at   ON workflow_run TYPE option<datetime>;

		DEFINE INDEX OVERWRITE wfrun_by_workflow ON workflow_run FIELDS workflow;
	`
};

// ── §4.12 Work queue ─────────────────────────────────────────────────────────
const m0012_work_item: Migration = {
	id: '0012_work_item',
	up: `
		DEFINE TABLE OVERWRITE work_item SCHEMAFULL;
		DEFINE FIELD OVERWRITE work_type    ON work_item TYPE string;
		DEFINE FIELD OVERWRITE session      ON work_item TYPE option<record<session>>;
		DEFINE FIELD OVERWRITE project      ON work_item TYPE option<record<project>>;
		DEFINE FIELD OVERWRITE priority     ON work_item TYPE int DEFAULT 5;
		DEFINE FIELD OVERWRITE status       ON work_item TYPE string DEFAULT "pending"
			ASSERT $value IN ["pending","processing","done","failed"];
		DEFINE FIELD OVERWRITE payload      ON work_item TYPE object;
		DEFINE FIELD OVERWRITE attempts     ON work_item TYPE int DEFAULT 0;
		DEFINE FIELD OVERWRITE claim_token  ON work_item TYPE option<string>;
		DEFINE FIELD OVERWRITE handoff      ON work_item TYPE option<object>;
		DEFINE FIELD OVERWRITE created_at   ON work_item TYPE datetime DEFAULT time::now();
		DEFINE FIELD OVERWRITE completed_at ON work_item TYPE option<datetime>;
		-- Dedup the active window (dedup_key VALUE pattern, D-008).
		DEFINE FIELD OVERWRITE dedup_key    ON work_item VALUE
			(IF status IN ["pending","processing"]
				THEN work_type + '|' + <string>(session OR '') + '|' + status
				ELSE <string>id END);
		DEFINE INDEX OVERWRITE work_item_dedup ON work_item FIELDS dedup_key UNIQUE;
		DEFINE INDEX OVERWRITE work_item_by_status_priority ON work_item FIELDS status, priority;

		${backfillValueField('work_item', 'dedup_key')}
	`
};

// ── §4.13 Retrieval outcomes ─────────────────────────────────────────────────
const m0013_retrieval_outcome: Migration = {
	id: '0013_retrieval_outcome',
	up: `
		DEFINE TABLE OVERWRITE retrieval_outcome SCHEMAFULL;
		DEFINE FIELD OVERWRITE session      ON retrieval_outcome TYPE option<record<session>>;
		DEFINE FIELD OVERWRITE query_turn   ON retrieval_outcome TYPE option<record<message>>;
		DEFINE FIELD OVERWRITE memory       ON retrieval_outcome TYPE option<record<memory>>;
		DEFINE FIELD OVERWRITE citation_id  ON retrieval_outcome TYPE option<string>;
		DEFINE FIELD OVERWRITE utilized     ON retrieval_outcome TYPE bool DEFAULT false;
		DEFINE FIELD OVERWRITE cited        ON retrieval_outcome TYPE bool DEFAULT false;
		DEFINE FIELD OVERWRITE tool_success ON retrieval_outcome TYPE option<bool>;
		DEFINE FIELD OVERWRITE score        ON retrieval_outcome TYPE float;
		DEFINE FIELD OVERWRITE was_neighbor ON retrieval_outcome TYPE bool DEFAULT false;
		DEFINE FIELD OVERWRITE created_at   ON retrieval_outcome TYPE datetime DEFAULT time::now();

		DEFINE INDEX OVERWRITE retrieval_outcome_by_session ON retrieval_outcome FIELDS session;
		DEFINE INDEX OVERWRITE retrieval_outcome_by_memory  ON retrieval_outcome FIELDS memory;
	`
};

// ── §4.14 Learned skills + causal chains ─────────────────────────────────────
const m0014_skill_causal: Migration = {
	id: '0014_skill_causal',
	up: `
		DEFINE TABLE OVERWRITE causal_chain SCHEMAFULL;
		DEFINE FIELD OVERWRITE session      ON causal_chain TYPE option<record<session>>;
		DEFINE FIELD OVERWRITE trigger      ON causal_chain TYPE string;
		DEFINE FIELD OVERWRITE outcome      ON causal_chain TYPE string;
		DEFINE FIELD OVERWRITE kind         ON causal_chain TYPE string
			ASSERT $value IN ["debug","refactor","feature","fix"];
		DEFINE FIELD OVERWRITE success      ON causal_chain TYPE bool;
		DEFINE FIELD OVERWRITE confidence   ON causal_chain TYPE float;
		DEFINE FIELD OVERWRITE graduated_at ON causal_chain TYPE option<datetime>;
		DEFINE FIELD OVERWRITE created_at   ON causal_chain TYPE datetime DEFAULT time::now();

		DEFINE TABLE OVERWRITE skill SCHEMAFULL;
		DEFINE FIELD OVERWRITE name           ON skill TYPE string;
		DEFINE FIELD OVERWRITE description    ON skill TYPE string;
		DEFINE FIELD OVERWRITE embedding      ON skill TYPE array<float>;
		DEFINE FIELD OVERWRITE preconditions  ON skill TYPE option<string>;
		DEFINE FIELD OVERWRITE steps          ON skill TYPE array<string>;
		DEFINE FIELD OVERWRITE postconditions ON skill TYPE option<string>;
		DEFINE FIELD OVERWRITE success_count  ON skill TYPE int DEFAULT 0;
		DEFINE FIELD OVERWRITE failure_count  ON skill TYPE int DEFAULT 0;
		DEFINE FIELD OVERWRITE graduated_at   ON skill TYPE option<datetime>;
		DEFINE FIELD OVERWRITE source_causal_chain ON skill TYPE option<record<causal_chain>>;
		DEFINE FIELD OVERWRITE status         ON skill TYPE string DEFAULT "active"
			ASSERT $value IN ["active","archived","superseded"];
		DEFINE FIELD OVERWRITE archived_at    ON skill TYPE option<datetime>;
		DEFINE FIELD OVERWRITE archive_reason ON skill TYPE option<string>;
		DEFINE FIELD OVERWRITE superseded_by  ON skill TYPE option<record<skill>>;
		DEFINE FIELD OVERWRITE created_at     ON skill TYPE datetime DEFAULT time::now();
		DEFINE FIELD OVERWRITE last_used      ON skill TYPE option<datetime>;

		-- HNSW over skill embeddings. Same 1024-dim/COSINE as memory_vec (D-014). No M0.
		DEFINE INDEX OVERWRITE skill_vec ON skill FIELDS embedding
			HNSW DIMENSION 1024 DIST COSINE TYPE F32 EFC 150 M 12;
		DEFINE INDEX OVERWRITE skill_by_status        ON skill FIELDS status;
		DEFINE INDEX OVERWRITE causal_chain_by_session ON causal_chain FIELDS session;
	`
};

// ── §4.15 Embedding cache (L2) ───────────────────────────────────────────────
const m0015_embedding_cache: Migration = {
	id: '0015_embedding_cache',
	up: `
		DEFINE TABLE OVERWRITE embedding_cache SCHEMAFULL;
		DEFINE FIELD OVERWRITE hash          ON embedding_cache TYPE string;
		DEFINE FIELD OVERWRITE vector        ON embedding_cache TYPE array<float>;
		DEFINE FIELD OVERWRITE model_version ON embedding_cache TYPE string;
		DEFINE FIELD OVERWRITE created_at    ON embedding_cache TYPE datetime DEFAULT time::now();
		DEFINE FIELD OVERWRITE pruned_at     ON embedding_cache TYPE option<datetime>;

		DEFINE INDEX OVERWRITE embedding_cache_hash ON embedding_cache FIELDS hash UNIQUE;
	`
};

// ── §4.10 fix — FLEXIBLE object fields + cc_settings.sync_digest (TASK 1.8) ───
//
// A SCHEMAFULL `TYPE object` field WITHOUT `FLEXIBLE` discards all nested keys on
// write — it stores `{}` (SurrealDB 2.x). The §4.10 mirror's arbitrary-shape JSON
// columns (settings permissions/env/enabled_plugins, the verbatim `raw`, agent
// `frontmatter`, mcp `env`) therefore lost their contents, breaking the D-010
// round-trip contract ("raw preserves full JSON"). OVERWRITE them as FLEXIBLE so
// nested keys round-trip. Additive + idempotent (OVERWRITE re-applies cleanly).
//
// Also add `cc_settings.sync_digest` — the per-scope content digest stamped at
// sync time. Drift detection (synced / out-of-sync, UI-SPEC §214) compares the
// live disk digest against this stored value; a dedicated typed field is cleaner
// than smuggling the digest inside `raw`.
const m0016_cc_flexible: Migration = {
	id: '0016_cc_flexible',
	up: `
		DEFINE FIELD OVERWRITE permissions     ON cc_settings FLEXIBLE TYPE option<object>;
		DEFINE FIELD OVERWRITE env             ON cc_settings FLEXIBLE TYPE option<object>;
		DEFINE FIELD OVERWRITE enabled_plugins ON cc_settings FLEXIBLE TYPE option<object>;
		DEFINE FIELD OVERWRITE raw             ON cc_settings FLEXIBLE TYPE object;
		DEFINE FIELD OVERWRITE sync_digest     ON cc_settings TYPE option<string>;

		DEFINE FIELD OVERWRITE frontmatter ON cc_agent FLEXIBLE TYPE object;

		DEFINE FIELD OVERWRITE env ON cc_mcp_server FLEXIBLE TYPE option<object>;
	`
};

// ── §4.3/§4.4 fix — FLEXIBLE transcript/analytics object fields (TASK 1.6b) ──────
//
// Same SCHEMAFULL `TYPE object` defect class the 0016 cc_* fix addressed: a
// free-form `option<object>` WITHOUT `FLEXIBLE` stores `{}` (all nested keys are
// stripped on write — SurrealDB 2.x). The transcript + analytics rows persisted by
// the session launch path (1.6b) carry arbitrary-shape JSON in two columns:
//   • message.tool_call  — { name, args, needs_confirm } / { name, ok, phase }
//   • agent_event.detail — e.g. { error } / { ok, summary }
// OVERWRITE them as FLEXIBLE so the persisted transcript round-trips intact (without
// this the tool-call name/args and error detail are silently lost). The model/chosen
// objects already declare their sub-fields, so they round-trip and are left as-is.
// Additive + idempotent (OVERWRITE re-applies cleanly).
const m0017_transcript_flexible: Migration = {
	id: '0017_transcript_flexible',
	up: `
		DEFINE FIELD OVERWRITE tool_call ON message     FLEXIBLE TYPE option<object>;
		DEFINE FIELD OVERWRITE detail    ON agent_event FLEXIBLE TYPE option<object>;
	`
};

// ── §4.12 fix — FLEXIBLE work_item object fields (TASK 2.2) ──────────────────────
//
// Same SCHEMAFULL `TYPE object` defect class as 0016/0017: a free-form object WITHOUT
// `FLEXIBLE` stores `{}` — all nested keys stripped on write (SurrealDB 2.x). The
// orchestrator's work_item rows carry arbitrary-shape JSON in two columns:
//   • payload — e.g. { taskId, projectId } the worker needs to run the item
//   • handoff — cross-worker handoff state (D-021 crash recovery)
// Without FLEXIBLE the claim queue would claim rows whose payload silently round-trips
// to {} — the worker would have no taskId to spawn. OVERWRITE both as FLEXIBLE.
// Additive + idempotent (OVERWRITE re-applies cleanly).
const m0018_work_item_flexible: Migration = {
	id: '0018_work_item_flexible',
	up: `
		DEFINE FIELD OVERWRITE payload ON work_item FLEXIBLE TYPE object;
		DEFINE FIELD OVERWRITE handoff ON work_item FLEXIBLE TYPE option<object>;
	`
};

// ── §4.12 fix — dedup_scope so multiple session-less items of one work_type coexist ──
//
// The original dedup_key (work_type|session|status) over-collapses work_types that have
// NO session: e.g. two task_run items (no session at enqueue) both compute
// `task_run||processing` once claimed → a UNIQUE violation that prevents more than ONE
// such item being processed at a time (breaking the orchestrator's interactive cap of
// N>1). The active-window dedup intent (D-008) for these is per-UNIT (per task), not
// global-per-work_type. Add an explicit `dedup_scope` (DEFAULT '' so session-keyed
// items are unchanged) and fold it into the key: work_type|session|dedup_scope|status.
// The orchestrator sets dedup_scope = the task id for task_run, so different tasks get
// distinct keys (coexist) while a re-enqueue of the SAME pending task still dedups.
const m0019_work_item_dedup_scope: Migration = {
	id: '0019_work_item_dedup_scope',
	up: `
		DEFINE FIELD OVERWRITE dedup_scope ON work_item TYPE string DEFAULT "";
		-- Coalesce dedup_scope with '' INSIDE the VALUE: a computed VALUE field evaluates
		-- before the column DEFAULT is applied, so an enqueue that omits dedup_scope would
		-- otherwise feed NONE into the '+' and throw ("Cannot perform addition … NONE").
		-- <string>(dedup_scope OR '') is null-safe regardless of DEFAULT timing.
		DEFINE FIELD OVERWRITE dedup_key ON work_item VALUE
			(IF status IN ["pending","processing"]
				THEN work_type + '|' + <string>(session OR '') + '|' + <string>(dedup_scope OR '') + '|' + status
				ELSE <string>id END);
	`
};

// ── §4.12 (TASK 2.15) — claimed_at anchor for the daily-cap rolling window (D-021) ──
//
// The daily spawn cap counts items DRAINED (claimed → spawned) per rolling day; that
// window must anchor on WHEN the item was claimed, not when it was produced (a backlog
// produced earlier but drained today still counts). claimNext stamps `claimed_at` on the
// atomic claim; gcStale also reaps stuck `processing` rows by their claim age. option<…>
// (NONE until first claimed) — never read back on a RETURN AFTER `WHERE = value` claim,
// so the §4.16 NONE-missed-match rule does not bite (we filter `claimed_at != NONE`).
// Additive + idempotent.
const m0020_work_item_claimed_at: Migration = {
	id: '0020_work_item_claimed_at',
	up: `
		DEFINE FIELD OVERWRITE claimed_at ON work_item TYPE option<datetime>;
	`
};

// ── §4.11 fix — FLEXIBLE workflow object fields (TASK 2.17, D-013) ───────────────
//
// SAME SurrealDB 2.x engine-truth as m0016/m0017/m0018: on a SCHEMAFULL table a
// `TYPE object` / `TYPE array<object>` field WITHOUT `FLEXIBLE` discards ALL nested
// keys on write — the value round-trips to `{}` (or `[{}]`). The workflow runner
// persists:
//   • workflow.steps      — array of free-form step objects {id, prompt, agent, model,
//                           cwd, depends_on, parallel}; without FLEXIBLE every step
//                           stores as `{}`, so a read-back step has no model/prompt and
//                           the runner cannot launch it (the exact failure this fixes).
//   • workflow_run.step_state — a {stepId: status} map with arbitrary stepId keys; without
//                           FLEXIBLE it stores `{}` and the tracked per-step state is lost.
// OVERWRITE both as FLEXIBLE so the runner's pipeline definition + per-step tracking
// round-trip intact. Forward-only + idempotent (OVERWRITE) — never edits m0011.
const m0021_workflow_flexible: Migration = {
	id: '0021_workflow_flexible',
	up: `
		DEFINE FIELD OVERWRITE steps      ON workflow     FLEXIBLE TYPE array<object>;
		DEFINE FIELD OVERWRITE step_state ON workflow_run FLEXIBLE TYPE object DEFAULT {};
	`
};

// TASK 8.4 — admit `hook` lifecycle-capture rows into agent_event. The hook ingest
// (api/hooks/[event] → ingest.ts) writes `type:'hook'` analytics rows for every driven
// session's SessionStart/UserPromptSubmit/PostToolUse/Stop. The original assertion (m0004)
// did not list 'hook', so EVERY hook write failed the SCHEMAFULL type assertion and was
// silently swallowed (best-effort ingest, D-019) — the hook→agent_event path could never land
// a row. OVERWRITE the assertion to include 'hook' (additive; the existing values are kept).
const m0022_agent_event_hook: Migration = {
	id: '0022_agent_event_hook',
	up: `
		DEFINE FIELD OVERWRITE type ON agent_event TYPE string
			ASSERT $value IN ["spawn","completion","escalation","cancel","error","hook"];
	`
};

// ── §4.1b Project Manager — typed PM memory + architectural decisions ─────────
// TASK 9.1 — the strategic layer above task execution (GAP-ANALYSIS §1.1; the
// operator-flagged #1 v1→v2 parity gap). Rebuilt LEAN on the SurrealDB spine —
// NO per-feature SQLite (lighter-advocate principle): the v1 pm-memory-db.ts is a
// dedicated SQLite file; here PM memory is a first-class SurrealDB table sharing
// the same FTS analyzer (text_an, defined in 0006) and the same boundary/option<T>
// discipline as the rest of §4. Two tables:
//   • pm_memory  — the accumulated-learning store. `kind` ∈ the v1 taxonomy
//     (observation/learning/risk/pattern/decision); confidence/importance carry
//     the v1 fields; FTS over `content` so the PM can search its own memory.
//   • decision   — the architectural-decisions surface (title/context/rationale/
//     status), linked to the project (and optionally a sprint).
const m0023_pm: Migration = {
	id: '0023_pm',
	up: `
		DEFINE TABLE OVERWRITE pm_memory SCHEMAFULL;
		DEFINE FIELD OVERWRITE project    ON pm_memory TYPE record<project>;
		DEFINE FIELD OVERWRITE kind       ON pm_memory TYPE string DEFAULT "observation"
			ASSERT $value IN ["observation","learning","risk","pattern","decision"];
		DEFINE FIELD OVERWRITE content    ON pm_memory TYPE string;
		DEFINE FIELD OVERWRITE source     ON pm_memory TYPE string DEFAULT "pm";
		DEFINE FIELD OVERWRITE confidence ON pm_memory TYPE float DEFAULT 0.8;
		DEFINE FIELD OVERWRITE importance ON pm_memory TYPE float DEFAULT 5.0;
		DEFINE FIELD OVERWRITE status     ON pm_memory TYPE string DEFAULT "active"
			ASSERT $value IN ["active","archived"];
		DEFINE FIELD OVERWRITE related_to ON pm_memory TYPE option<string>;
		DEFINE FIELD OVERWRITE created_at ON pm_memory TYPE datetime DEFAULT time::now();

		DEFINE INDEX OVERWRITE pm_memory_by_project ON pm_memory FIELDS project;
		DEFINE INDEX OVERWRITE pm_memory_by_kind    ON pm_memory FIELDS kind;
		-- Reuse the shared analyzer (text_an, defined in 0006) so the PM can FTS its memory.
		DEFINE INDEX OVERWRITE pm_memory_fts ON pm_memory FIELDS content SEARCH ANALYZER text_an BM25 HIGHLIGHTS;

		DEFINE TABLE OVERWRITE decision SCHEMAFULL;
		DEFINE FIELD OVERWRITE project   ON decision TYPE record<project>;
		DEFINE FIELD OVERWRITE sprint    ON decision TYPE option<record<sprint>>;
		DEFINE FIELD OVERWRITE title     ON decision TYPE string;
		DEFINE FIELD OVERWRITE context   ON decision TYPE option<string>;
		DEFINE FIELD OVERWRITE rationale ON decision TYPE option<string>;
		DEFINE FIELD OVERWRITE status    ON decision TYPE string DEFAULT "accepted"
			ASSERT $value IN ["proposed","accepted","superseded","rejected"];
		DEFINE FIELD OVERWRITE created_at ON decision TYPE datetime DEFAULT time::now();

		DEFINE INDEX OVERWRITE decision_by_project ON decision FIELDS project;

		-- Sprint lifecycle: a concrete non-NONE DEFAULT (§6.2) so a status read-back on a
		-- RETURN AFTER write never lands in NONE; backfill pre-existing sprint rows.
		DEFINE FIELD OVERWRITE status      ON sprint TYPE string DEFAULT "active"
			ASSERT $value IN ["active","completed"];
		DEFINE FIELD OVERWRITE completed_at ON sprint TYPE option<datetime>;
		${guardedScan('sprint', 'status IS NONE', 'status = "active"')}
	`
};

// ── §4.x — task↔external sync mappings (TASK 9.4 / D-037, the reference SyncAdapter) ──
// One `task_sync` row maps an Atelier `task` to its external counterpart (a GitHub issue
// today; any SyncAdapter `provider` tomorrow). It is the IDEMPOTENCY ledger: a re-sync
// finds the existing mapping by (provider, repo, external_id) — or by (provider, task) —
// and UPDATES instead of re-creating, so the same task never spawns two issues.
//
// dedup_key is a computed VALUE field (D-008 NONE-collision-dodging pattern, mirrors
// session/memory/work_item) — `provider|repo|external_id` — with a UNIQUE index so two
// concurrent syncs of the same issue collide on insert rather than duplicating. The
// task link is also UNIQUE-per-provider-repo via task_dedup so one task maps to at most
// one issue in a given repo (the "create-or-update" invariant).
const m0024_task_sync: Migration = {
	id: '0024_task_sync',
	up: `
		DEFINE TABLE OVERWRITE task_sync SCHEMAFULL;
		DEFINE FIELD OVERWRITE task        ON task_sync TYPE record<task>;
		DEFINE FIELD OVERWRITE project     ON task_sync TYPE record<project>;
		DEFINE FIELD OVERWRITE provider    ON task_sync TYPE string DEFAULT "github"
			ASSERT $value IN ["github"];
		DEFINE FIELD OVERWRITE repo        ON task_sync TYPE string;
		-- The external counterpart id (GitHub issue number, as a string for provider-agnosticism).
		DEFINE FIELD OVERWRITE external_id ON task_sync TYPE string;
		DEFINE FIELD OVERWRITE external_url ON task_sync TYPE option<string>;
		-- The last direction this mapping was synced in, for the surface.
		DEFINE FIELD OVERWRITE direction   ON task_sync TYPE string DEFAULT "both"
			ASSERT $value IN ["push","pull","both"];
		DEFINE FIELD OVERWRITE last_synced ON task_sync TYPE datetime DEFAULT time::now();
		DEFINE FIELD OVERWRITE created_at  ON task_sync TYPE datetime DEFAULT time::now();

		-- Dedup by the external counterpart: a concrete non-NONE VALUE (§6.2) + UNIQUE index,
		-- so two callers that both miss the SELECT collide on CREATE rather than duplicating
		-- (D-008 — the dedup TOCTOU class transactions alone do NOT solve).
		DEFINE FIELD OVERWRITE dedup_key   ON task_sync VALUE
			provider + '|' + repo + '|' + external_id;
		-- Dedup by the Atelier task within a repo: one task ↔ one issue per repo.
		DEFINE FIELD OVERWRITE task_dedup  ON task_sync VALUE
			provider + '|' + repo + '|' + <string>task;

		DEFINE INDEX OVERWRITE task_sync_dedup   ON task_sync FIELDS dedup_key  UNIQUE;
		DEFINE INDEX OVERWRITE task_sync_task    ON task_sync FIELDS task_dedup UNIQUE;
		DEFINE INDEX OVERWRITE task_sync_by_task    ON task_sync FIELDS task;
		DEFINE INDEX OVERWRITE task_sync_by_project ON task_sync FIELDS project;
		${backfillValueField('task_sync', 'dedup_key')}
		${backfillValueField('task_sync', 'task_dedup')}
	`
};

// ── §4.x — PM periodic review + GitHub project-board sync (TASK 11.4 / wave v1.7) ──
//
// Three tables land the deferred 9.1/9.4 review machinery + board sync:
//   • pm_review        — one row per PM review pass (manual or periodic, D-004). It is the
//     summary surfaced in the PM tab: the trigger, a human summary, and honest counts of
//     the signals examined + typed memories the pass wrote. Append-only history.
//   • board_sync_config — the per-project, opt-in column mapping for the GitHub project-BOARD
//     sync adapter (D-037 extension): task-status → board-column. One row per project (the
//     project link is UNIQUE). `enabled` gates the push; the JSON `mapping` is the
//     SCHEMAFULL-FLEXIBLE status→column map.
//   • sync_incident    — a recorded sync FAILURE (never silent, F-008): which adapter/project
//     failed, when, and why. The board adapter writes one per failed run so the surface can
//     show an honest last-error instead of swallowing it.
const m0025_pm_review_board: Migration = {
	id: '0025_pm_review_board',
	// IDEMPOTENT (D-006): every DEFINE carries OVERWRITE so re-running is clean over a
	// FRESH db AND over a HALF-APPLIED state (F: m0025 once half-applied — table existed
	// with fields:{} but was never recorded — wedging `db:up` with "table already exists").
	// OVERWRITE redefines-if-exists / defines-if-not, so the recorded ledger gate + this
	// DDL together recover the half-applied table on the next run.
	up: `
		DEFINE TABLE OVERWRITE pm_review SCHEMAFULL;
		DEFINE FIELD OVERWRITE project     ON pm_review TYPE record<project>;
		-- What kicked the review off (D-004 honors mode): manual | periodic | event.
		DEFINE FIELD OVERWRITE trigger     ON pm_review TYPE string DEFAULT "manual"
			ASSERT $value IN ["manual","periodic","event"];
		DEFINE FIELD OVERWRITE summary     ON pm_review TYPE string;
		-- Honest counts of what the pass examined + wrote (every number a real action, F-008).
		DEFINE FIELD OVERWRITE tasks_examined    ON pm_review TYPE int DEFAULT 0;
		DEFINE FIELD OVERWRITE findings_examined ON pm_review TYPE int DEFAULT 0;
		DEFINE FIELD OVERWRITE risks_open        ON pm_review TYPE int DEFAULT 0;
		DEFINE FIELD OVERWRITE memories_written  ON pm_review TYPE int DEFAULT 0;
		DEFINE FIELD OVERWRITE created_at  ON pm_review TYPE datetime DEFAULT time::now();
		DEFINE INDEX OVERWRITE pm_review_by_project ON pm_review FIELDS project;
		-- Half-applied recovery (two honest cases, F-008 — no fabricated data):
		--  (a) UNSALVAGEABLE rows: the wedge left the table SCHEMAFULL-with-fields:{}, which DROPS
		--      every undefined column on write — so any row written then kept ONLY its id (no
		--      project, no summary). Such a row can never satisfy the now-required project/summary
		--      and is pure corruption: DELETE it rather than invent a fake project/summary.
		--  (b) RECOVERABLE rows (the addPmReview shape: project + summary + counts all set, but
		--      created_at relied on the DEFAULT the bare table dropped): backfill the DEFAULT-bearing
		--      columns. A DEFAULT only fires on CREATE, never on a later UPDATE (MEMORY-SPEC §6.5),
		--      and touching the row re-validates its SCHEMAFULL fields — so coalesce EVERY
		--      DEFAULT-bearing column in the SAME UPDATE (else "Found NONE for field, expected int").
		LET $corrupt = (SELECT count() AS n FROM pm_review WHERE (project IS NONE) OR (summary IS NONE) GROUP ALL)[0].n ?? 0;
		IF $corrupt > 0 { DELETE pm_review WHERE (project IS NONE) OR (summary IS NONE); };
		${guardedScan(
			'pm_review',
			'created_at IS NONE',
			[
				'created_at = time::now()',
				'trigger = (trigger ?? "manual")',
				'tasks_examined = (tasks_examined ?? 0)',
				'findings_examined = (findings_examined ?? 0)',
				'risks_open = (risks_open ?? 0)',
				'memories_written = (memories_written ?? 0)'
			].join(', ')
		)}

		DEFINE TABLE OVERWRITE board_sync_config SCHEMAFULL;
		DEFINE FIELD OVERWRITE project   ON board_sync_config TYPE record<project>;
		DEFINE FIELD OVERWRITE enabled   ON board_sync_config TYPE bool DEFAULT false;
		-- The GitHub Projects (v2) board number for the repo owner. Optional until configured.
		DEFINE FIELD OVERWRITE board_number ON board_sync_config TYPE option<int>;
		-- status → board-column map (SCHEMAFULL-FLEXIBLE object so the map round-trips intact).
		DEFINE FIELD OVERWRITE mapping   ON board_sync_config FLEXIBLE TYPE object DEFAULT {};
		DEFINE FIELD OVERWRITE last_synced ON board_sync_config TYPE option<datetime>;
		-- The last run's honest status: never-run (NONE) | ok | error.
		DEFINE FIELD OVERWRITE last_status ON board_sync_config TYPE option<string>
			ASSERT $value = NONE OR $value IN ["ok","error"];
		DEFINE FIELD OVERWRITE last_error  ON board_sync_config TYPE option<string>;
		DEFINE FIELD OVERWRITE created_at  ON board_sync_config TYPE datetime DEFAULT time::now();
		-- One config per project (the opt-in is per-project) — UNIQUE so an upsert is a no-dup.
		DEFINE INDEX OVERWRITE board_sync_config_project ON board_sync_config FIELDS project UNIQUE;

		DEFINE TABLE OVERWRITE sync_incident SCHEMAFULL;
		DEFINE FIELD OVERWRITE project   ON sync_incident TYPE record<project>;
		DEFINE FIELD OVERWRITE adapter   ON sync_incident TYPE string;
		DEFINE FIELD OVERWRITE message   ON sync_incident TYPE string;
		DEFINE FIELD OVERWRITE at        ON sync_incident TYPE datetime DEFAULT time::now();
		DEFINE INDEX OVERWRITE sync_incident_by_project ON sync_incident FIELDS project;
	`
};

// ── §4.x — per-project deploy/publish/sync TARGETS (TASK 12.1 / D-037 adapter framework) ──
//
// A `project_target` row is the per-project declaration the D-037 registry resolves: a project
// names the adapter it ships through ({adapterId, config}) for one of the THREE families
// (publish | deploy | sync). This is the EXTENSIBILITY point — a novel per-project process
// plugs in by declaring a target with its adapter id + config, WITHOUT a core change.
//
// Credential confinement (D-026): a target's `config` may reference secrets by NAME only (an
// env-var name), NEVER a value — the adapter framework resolves the value from .env at call
// time and never persists it. This migration does NOT store a secret column; if a config blob
// carried a raw value it would be a caller bug the adapters layer guards against on write.
//
// One target per (project, kind, adapter_id) — UNIQUE so a re-declare upserts rather than
// duplicating (the dedup_key VALUE pattern, D-008; mirrors task_sync/session/memory). `enabled`
// gates whether the pipeline drives it; `is_default` marks the one a kind defaults to.
// IDEMPOTENT (D-006/F-015): every DEFINE carries OVERWRITE so re-running is clean over a fresh
// DB AND a half-applied state.
const m0026_project_target: Migration = {
	id: '0026_project_target',
	up: `
		DEFINE TABLE OVERWRITE project_target SCHEMAFULL;
		DEFINE FIELD OVERWRITE project    ON project_target TYPE record<project>;
		-- The adapter family this target belongs to (the three D-037 families).
		DEFINE FIELD OVERWRITE kind       ON project_target TYPE string
			ASSERT $value IN ["publish","deploy","sync"];
		-- The registered adapter id the registry resolves (e.g. "npm","thunderstore","github").
		DEFINE FIELD OVERWRITE adapter_id ON project_target TYPE string;
		-- Human label for the surface (operator-set; defaults to the adapter id on write).
		DEFINE FIELD OVERWRITE label      ON project_target TYPE string;
		-- Adapter-specific config (SCHEMAFULL-FLEXIBLE so the blob round-trips intact). May
		-- reference secrets by NAME only (D-026) — never a raw value.
		DEFINE FIELD OVERWRITE config     ON project_target FLEXIBLE TYPE object DEFAULT {};
		-- Gate: the pipeline drives a target only when enabled.
		DEFINE FIELD OVERWRITE enabled    ON project_target TYPE bool DEFAULT true;
		-- The default target for its kind (one per project+kind; the pipeline picks it).
		DEFINE FIELD OVERWRITE is_default ON project_target TYPE bool DEFAULT false;
		DEFINE FIELD OVERWRITE created_at ON project_target TYPE datetime DEFAULT time::now();
		DEFINE FIELD OVERWRITE updated_at ON project_target TYPE datetime DEFAULT time::now();

		-- Dedup: one declaration per (project, kind, adapter_id). Concrete non-NONE VALUE (§6.2)
		-- + UNIQUE so a concurrent double-declare collides rather than duplicating (D-008).
		DEFINE FIELD OVERWRITE dedup_key  ON project_target VALUE
			<string>project + '|' + kind + '|' + adapter_id;
		DEFINE INDEX OVERWRITE project_target_dedup ON project_target FIELDS dedup_key UNIQUE;
		DEFINE INDEX OVERWRITE project_target_by_project ON project_target FIELDS project;
		DEFINE INDEX OVERWRITE project_target_by_kind    ON project_target FIELDS project, kind;
		${backfillValueField('project_target', 'dedup_key')}

		-- A recorded deploy/publish RUN through the framework (never silent — F-008). One row per
		-- gated action attempt: which target/adapter, dry-run or real, ok/failed, an honest summary.
		DEFINE TABLE OVERWRITE target_run SCHEMAFULL;
		DEFINE FIELD OVERWRITE project    ON target_run TYPE record<project>;
		DEFINE FIELD OVERWRITE target     ON target_run TYPE option<record<project_target>>;
		DEFINE FIELD OVERWRITE kind       ON target_run TYPE string
			ASSERT $value IN ["publish","deploy","sync"];
		DEFINE FIELD OVERWRITE adapter_id ON target_run TYPE string;
		DEFINE FIELD OVERWRITE dry_run    ON target_run TYPE bool DEFAULT true;
		DEFINE FIELD OVERWRITE ok         ON target_run TYPE bool DEFAULT false;
		DEFINE FIELD OVERWRITE target_ref ON target_run TYPE option<string>;
		DEFINE FIELD OVERWRITE summary    ON target_run TYPE string;
		DEFINE FIELD OVERWRITE steps      ON target_run TYPE array<string> DEFAULT [];
		DEFINE FIELD OVERWRITE at         ON target_run TYPE datetime DEFAULT time::now();
		DEFINE INDEX OVERWRITE target_run_by_project ON target_run FIELDS project;
	`
};

// ── TASK 13.2 — honest terminal note on session / workflow_run ──────────────────
//
// A run that ends 'failed' on a crash path must say WHY (F-008 honest): launchSession /
// runWorkflow stamp the throw message on their guaranteed terminal write, and the boot
// reaper stamps 'reaped: server restarted mid-run' on rows wedged 'running' by a hard
// server death. option<string> — absent (NONE) on every clean run (§6.1).
// IDEMPOTENT (D-006/F-015): OVERWRITE only — clean over a fresh DB AND a half-applied state.
const m0027_run_note: Migration = {
	id: '0027_run_note',
	up: `
		DEFINE FIELD OVERWRITE note ON session      TYPE option<string>;
		DEFINE FIELD OVERWRITE note ON workflow_run TYPE option<string>;
	`
};

// ── TASK 14.4a/b — honest "last seen" on probe-corrected service rows ────────────
//
// The /services probe reconciliation (10.5) can find a persisted `service` row still
// claiming 'running' for a process that is actually gone (a stale self-report — the
// F-008 audit's "services up 1/1 while ollama dead" finding). When the read path
// corrects the row to the probed truth, the moment the service was LAST observed
// running must survive the correction: the surface renders pid "—" plus an honest
// "last seen <ago>" instead of presenting a dead pid as current. option<datetime> —
// absent (NONE) until a service has ever been observed running (§6.1).
// IDEMPOTENT (D-006/F-015): OVERWRITE only — clean over fresh AND half-applied state.
const m0028_service_last_seen: Migration = {
	id: '0028_service_last_seen',
	up: `
		DEFINE FIELD OVERWRITE last_seen_at ON service TYPE option<datetime>;
	`
};

// ── TASK 16.1 — PM IDENTITY (PM-SPEC §1): the PM is hired, not implicit ──────────
//
// One `pm` row per project (UNIQUE project link) carries the hired manager's
// identity: name, the operator-written `charter` (priorities / tone / escalation
// rules — injected as fenced context into every PM session/review, D-026), an
// optional `persona`, the periodic-trigger `cadence` (cron expr) + `cadence_offset`
// (per-project stagger so PMs don't fire simultaneously — PM-SPEC §3), and the
// `authority` ladder (observe | propose | act; default "act" per PM-SPEC §4).
//
// IDEMPOTENT (D-006/F-015): every DEFINE carries OVERWRITE — clean over a fresh DB
// AND a half-applied state; assume the migration can die mid-apply and re-run.
const m0029_pm_identity: Migration = {
	id: '0029_pm_identity',
	up: `
		DEFINE TABLE OVERWRITE pm SCHEMAFULL;
		DEFINE FIELD OVERWRITE project        ON pm TYPE record<project>;
		DEFINE FIELD OVERWRITE name           ON pm TYPE string;
		-- Operator-written directives (PM-SPEC §1/§2). Absent until written (§6.1).
		DEFINE FIELD OVERWRITE charter        ON pm TYPE option<string>;
		DEFINE FIELD OVERWRITE persona        ON pm TYPE option<string>;
		-- Periodic trigger: cron expr + per-project stagger (PM-SPEC §3; consumed by the
		-- trigger-engine task — stored now so hiring captures the full identity row).
		DEFINE FIELD OVERWRITE cadence        ON pm TYPE option<string>;
		DEFINE FIELD OVERWRITE cadence_offset ON pm TYPE option<duration>;
		-- "Act with Purpose" (PM-SPEC §4): default act — a concrete non-NONE DEFAULT (§6.2).
		DEFINE FIELD OVERWRITE authority      ON pm TYPE string DEFAULT "act"
			ASSERT $value IN ["observe","propose","act"];
		DEFINE FIELD OVERWRITE created_at     ON pm TYPE datetime DEFAULT time::now();
		-- ONE PM per project: UNIQUE so a concurrent double-hire collides rather than
		-- duplicating (D-008 — the dedup TOCTOU class transactions alone do not solve).
		DEFINE INDEX OVERWRITE pm_by_project ON pm FIELDS project UNIQUE;
		-- Half-applied recovery (the m0025 case study, F-015 — no fabricated data):
		--  (a) UNSALVAGEABLE rows: a bare fields:{} table drops every undefined column on
		--      write, leaving id-only rows that can never satisfy the required project/name.
		--      Pure corruption — DELETE rather than invent a fake project/name.
		--  (b) RECOVERABLE rows (project + name set, but the DEFAULT-bearing columns relied
		--      on DEFAULTs the bare table dropped): backfill authority + created_at in the
		--      SAME UPDATE (touching a row re-validates every SCHEMAFULL field — §6.5).
		LET $corrupt = (SELECT count() AS n FROM pm WHERE (project IS NONE) OR (name IS NONE) GROUP ALL)[0].n ?? 0;
		IF $corrupt > 0 { DELETE pm WHERE (project IS NONE) OR (name IS NONE); };
		${guardedScan(
			'pm',
			'(created_at IS NONE) OR (authority IS NONE)',
			'created_at = (created_at ?? time::now()), authority = (authority ?? "act")'
		)}
	`
};

// ── §4.x — PM review trigger provenance (TASK 16.2 / PM-SPEC §3) ────────────────
//
// The trigger engine (projects/pm-triggers.ts) fires runPmReview variants scoped to
// trigger evidence; each pass records WHAT woke the PM — the trigger kind (periodic /
// session_failed / task_blocked / github_arrival / finding / release), the REAL
// evidence row ids (F-008), and the pm.authority in force at fire time — on the
// pm_review row itself. FLEXIBLE option<object> (DATA-MODEL §4.16 free-form JSON):
// absent on every pre-16.2 row and on manual button passes (honest absence, never a
// fabricated provenance).
//
// IDEMPOTENT (D-006/F-015): single OVERWRITE DEFINE — clean over a fresh DB, a
// half-applied state, and a re-run. Adding an option<> field needs no row backfill
// (absent IS the honest value for prior rows).
const m0030_pm_review_provenance: Migration = {
	id: '0030_pm_review_provenance',
	up: `
		DEFINE FIELD OVERWRITE provenance ON pm_review FLEXIBLE TYPE option<object>;
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
	m0015_embedding_cache,
	m0016_cc_flexible,
	m0017_transcript_flexible,
	m0018_work_item_flexible,
	m0019_work_item_dedup_scope,
	m0020_work_item_claimed_at,
	m0021_workflow_flexible,
	m0022_agent_event_hook,
	m0023_pm,
	m0024_task_sync,
	m0025_pm_review_board,
	m0026_project_target,
	m0027_run_note,
	m0028_service_last_seen,
	m0029_pm_identity,
	m0030_pm_review_provenance
];
