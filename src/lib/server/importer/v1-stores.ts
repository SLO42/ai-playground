// TASK 2.9 — v1 importer (finish) (IMPLEMENTATION-PLAN §2.9; DATA-MODEL §6 migration
// map). The §1.7 importer (v1.ts) covered `registry.json`→project and the task store→
// task. This module migrates the REMAINING knowledge-core stores:
//
//   • `.swarm/memory.db` (claude-flow's SQLite HNSW store, `memory_entries`) → `memory`.
//     CRITICAL (the §2.9 verify): the v1 vectors are 384-dim (the on-disk store has 25
//     such rows). v2's HNSW index is LOCKED to 1024 (D-014). A 384-dim vector CANNOT be
//     inserted — so we NEVER trust the stored embedding: every row is RE-EMBEDDED from its
//     `content` to 1024 via the screen+embed pipeline before insert. (Even a row whose
//     stored dim already equalled 1024 is re-embedded, because the v2 model differs from
//     v1's `local` model — a wrong-model 1024-vector is worse than a fresh one.)
//   • `graph-state.json` (claude-flow's node/edge graph) → `entity` nodes + `references`
//     edges. v1 edge `type`s (e.g. "temporal") are mapped onto the v2 references.kind
//     ASSERT vocab, defaulting unknown types to "relates_to".
//
// IDEMPOTENCY (the §2.9 verify — re-run = no duplicate rows): every memory row carries a
// DETERMINISTIC (namespace|key) dedup key and is pre-checked before insert (storeMemory is
// CREATE-only, so the dedup probe lives here, exactly as bridge.ts does it). Every entity
// node and references edge lands on a DETERMINISTIC record id (sha256-truncated, the D-008
// dedup_key principle), so a re-import UPSERT-MERGEs / re-checks the same ids — never a twin.
//
// Boundary discipline (D-016): every record/edge id passes assertRecordId at the chokepoint;
// every value binds via $param; absent optionals are OMITTED, never NULL (option<T> rejects
// NULL — §6.1). The embedder is injected (FakeEmbedder seam) so the re-embed logic verifies
// against a throwaway DB with NO live model (F-008). The sqlite read uses Node 24's built-in
// `node:sqlite` (DatabaseSync) — no native better-sqlite3 ABI dependency.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import { EMBEDDING_DIM } from '../memory/embed';
import { storeMemory, type MemoryKind, type StoreOptions } from '../memory/store';

// ── v1 swarm memory shapes (`memory_entries` row, claude-flow SQLite) ────────────────

/** One `memory_entries` row from `.swarm/memory.db` (everything beyond id/content optional). */
export interface SwarmMemoryRow {
	id?: string;
	key: string;
	namespace?: string;
	content: string;
	/** v1 kind: semantic|episodic|procedural|working|pattern. */
	type?: string;
	/** JSON-stringified number[] (claude-flow stores the vector as TEXT). May be null. */
	embedding?: string | null;
	embedding_dimensions?: number | null;
	/** JSON-stringified string[]. May be null. */
	tags?: string | null;
}

// ── v1 graph-state shapes (`graph-state.json`, claude-flow) ──────────────────────────

export interface V1GraphNode {
	id: string;
	category?: string;
	confidence?: number;
	accessCount?: number;
	createdAt?: number;
}

export interface V1GraphEdge {
	sourceId: string;
	targetId: string;
	/** v1 edge type, e.g. "temporal" — mapped onto the references.kind vocab. */
	type?: string;
	weight?: number;
}

export interface V1GraphState {
	version?: number;
	nodes: Record<string, V1GraphNode>;
	edges: V1GraphEdge[];
}

// ── Enum mapping ─────────────────────────────────────────────────────────────────────

const V2_MEMORY_KINDS = new Set<MemoryKind>(['semantic', 'episodic', 'procedural']);

/**
 * Map a v1 swarm `type` onto the v2 `memory.kind` ASSERT vocab (semantic|episodic|
 * procedural). v1's extra kinds: `working` → procedural (it's a process scratch), `pattern`
 * → semantic. Unknown/absent → semantic. The ORIGINAL kind is preserved as a `v1-kind:<x>`
 * tag by the caller so nothing is silently lost.
 */
export function mapSwarmKind(v1: string | undefined): MemoryKind {
	const t = (v1 ?? '').toLowerCase();
	if (V2_MEMORY_KINDS.has(t as MemoryKind)) return t as MemoryKind;
	if (t === 'working') return 'procedural';
	if (t === 'pattern') return 'semantic';
	return 'semantic';
}

const V2_EDGE_KINDS = new Set(['supports', 'contradicts', 'derived_from', 'mentions', 'relates_to']);

/**
 * Map a v1 graph edge `type` onto the v2 `references.kind` ASSERT vocab. claude-flow's
 * "temporal" (and any other unrecognized type) collapses to "relates_to" — the neutral edge.
 */
export function mapEdgeKind(v1: string | undefined): string {
	const t = (v1 ?? '').toLowerCase();
	return V2_EDGE_KINDS.has(t) ? t : 'relates_to';
}

// ── Embedding parse ────────────────────────────────────────────────────────────────

/** Parse a JSON-string embedding into a number[]; null/garbage → null (never throws). */
export function parseSwarmEmbedding(raw: string | null | undefined): number[] | null {
	if (raw == null) return null;
	try {
		const v = JSON.parse(raw);
		return Array.isArray(v) && v.every((x) => typeof x === 'number') ? (v as number[]) : null;
	} catch {
		return null;
	}
}

function parseTags(raw: string | null | undefined): string[] {
	if (raw == null) return [];
	try {
		const v = JSON.parse(raw);
		return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
	} catch {
		return [];
	}
}

// ── Deterministic ids (the dedup keys — D-008) ───────────────────────────────────────

function digest(input: string): string {
	return createHash('sha256').update(input).digest('hex').slice(0, 32);
}

/** The (namespace|key) dedup VALUE for a swarm memory row — the memory_dedup invariant. */
export function swarmMemoryDedupKey(namespace: string, key: string): string {
	return `${namespace}|swarm:${key}`;
}

/** Deterministic `entity:gn_<digest(v1NodeId)>` id for a graph node. */
export function graphEntityId(v1NodeId: string): string {
	return `entity:gn_${digest(v1NodeId)}`;
}

/** Deterministic `references:<digest(from|to|kind)>` edge id so re-RELATE is a no-op. */
function graphEdgeId(from: string, to: string, kind: string): string {
	return `references:e_${digest(`${from}|${to}|${kind}`)}`;
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────

function omitUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
	const out: Partial<T> = {};
	for (const [k, v] of Object.entries(obj)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
	return out;
}

/** Find an existing memory row by (namespace, key) — the idempotency probe (mirrors bridge.ts). */
async function findMemoryByKey(db: Db, namespace: string, key: string): Promise<string | null> {
	const [rows] = await db.query<[Array<{ id: unknown }>]>(
		`SELECT id FROM memory WHERE namespace = $ns AND key = $key LIMIT 1;`,
		{ ns: namespace, key }
	);
	return rows.length ? String(rows[0].id) : null;
}

// ── .swarm/memory.db → memory (RE-EMBED) ──────────────────────────────────────────────

export interface ImportSwarmResult {
	/** Memory rows newly persisted this run. */
	imported: number;
	/** Rows already present (skipped — the idempotent path). */
	skipped: number;
	/** Rows whose embedding was recomputed to 1024 (the §2.9 verify counter). */
	reEmbedded: number;
	/** Candidates dropped by the §3.1 DO-NOT-CAPTURE screen (no memory row). */
	dropped: number;
}

/**
 * Import claude-flow `memory_entries` rows into the v2 `memory` table. Each row is
 * RE-EMBEDDED from its content to 1024 (the v1 vector is 384-dim and the model differs —
 * the stored vector is never trusted), screened (storeMemory's §3.4 step 2.0), and inserted
 * with a stable (namespace|key) dedup key so a re-run is a no-op. The v1 kind is mapped onto
 * the v2 vocab with the original preserved as a `v1-kind:<x>` tag. Returns the run counts.
 */
export async function importSwarmMemory(
	opts: StoreOptions,
	rows: SwarmMemoryRow[]
): Promise<ImportSwarmResult> {
	const result: ImportSwarmResult = { imported: 0, skipped: 0, reEmbedded: 0, dropped: 0 };

	for (const row of rows) {
		const namespace = row.namespace?.trim() || 'default';
		const memKey = `swarm:${row.key}`;

		// Idempotency probe — storeMemory is CREATE-only, so we pre-check the dedup key here.
		const existing = await findMemoryByKey(opts.db, namespace, memKey);
		if (existing) {
			result.skipped++;
			continue;
		}

		// The §2.9 verify: the v1 vector is 384-dim (and from a different model). It is NEVER
		// inserted — storeMemory re-embeds the SCREENED content to 1024 (D-014) via the injected
		// embedder. parseSwarmEmbedding only AUDITS the dim; needsReEmbed is true whenever the
		// stored vector is absent or ≠1024 (here: always, by construction — see needsReEmbed).
		const v1Vector = parseSwarmEmbedding(row.embedding);
		if (needsReEmbed(v1Vector)) result.reEmbedded++;

		const v1Kind = (row.type ?? '').toLowerCase();
		const tags = parseTags(row.tags);
		if (v1Kind && !V2_MEMORY_KINDS.has(v1Kind as MemoryKind)) tags.push(`v1-kind:${v1Kind}`);
		tags.push('swarm-memory');

		// storeMemory re-embeds (screen-before-embed §3.4) the SCREENED content to 1024 via the
		// injected embedder. We pass key/namespace so the dedup probe above matches a re-run.
		const res = await storeMemory(opts, {
			content: row.content,
			kind: mapSwarmKind(row.type),
			namespace,
			key: memKey,
			tags,
			source: 'swarm-memory'
		});

		if (res.persisted) result.imported++;
		else result.dropped++;
	}

	return result;
}

/**
 * Whether a v1 stored vector must be re-embedded before it could ever match the v2 HNSW index.
 * True when the vector is absent (v1 never embedded) OR its dim ≠ the locked 1024 (D-014) —
 * which is EVERY real `.swarm/memory.db` row (all 384-dim). The actual re-embed is done by
 * storeMemory; this is the explicit, testable §2.9 verify predicate.
 */
export function needsReEmbed(v1Vector: number[] | null): boolean {
	return v1Vector === null || v1Vector.length !== EMBEDDING_DIM;
}

/**
 * Filesystem edge: read `memory_entries` from a `.swarm/memory.db` SQLite file via Node 24's
 * built-in `node:sqlite` (no native better-sqlite3 dependency) and import them. Read-only.
 */
export async function importSwarmMemoryFromDb(
	opts: StoreOptions,
	dbPath: string
): Promise<ImportSwarmResult> {
	const sq = new DatabaseSync(dbPath, { readOnly: true });
	try {
		const rows = sq
			.prepare(
				`SELECT id, key, namespace, content, type, embedding, embedding_dimensions, tags
				   FROM memory_entries
				  WHERE status != 'deleted' OR status IS NULL;`
			)
			.all() as unknown as SwarmMemoryRow[];
		return await importSwarmMemory(opts, rows);
	} finally {
		sq.close();
	}
}

// ── graph-state.json → entity + references ─────────────────────────────────────────────

export interface ImportGraphResult {
	/** Entity nodes upserted (one per v1 node). */
	entities: number;
	/** references edges newly created this run. */
	edges: number;
	/** Edges skipped because an endpoint node was not in the graph (dangling). */
	skippedEdges: number;
	/** Map v1 node id → its v2 entity id (traversal entry points). */
	entityByNode: Record<string, string>;
}

/**
 * Import a claude-flow `graph-state.json` into `entity` nodes + `references` edges. Each node
 * lands on a deterministic `entity:gn_<digest>` id (UPSERT…MERGE — idempotent). Each edge
 * lands on a deterministic `references:<digest>` id (existence-checked RELATE — idempotent),
 * with its v1 type mapped onto the references.kind vocab. Edges whose endpoint is missing from
 * the node set are skipped (no dangling edges). Pure writes; no LLM (D-029 ethos).
 */
export async function importGraphState(db: Db, graph: V1GraphState): Promise<ImportGraphResult> {
	const result: ImportGraphResult = { entities: 0, edges: 0, skippedEdges: 0, entityByNode: {} };

	// Pass 1 — entity nodes.
	for (const node of Object.values(graph.nodes ?? {})) {
		const entityId = graphEntityId(node.id);
		result.entityByNode[node.id] = entityId;
		const content = omitUndefined({
			label: node.id,
			type: 'graph-node',
			status: 'active'
		});
		await db.query(`UPSERT ${assertRecordId(entityId)} MERGE $content RETURN NONE;`, { content });
		result.entities++;
	}

	// Pass 2 — references edges (all nodes now exist; skip edges with a missing endpoint).
	for (const edge of graph.edges ?? []) {
		const fromEntity = result.entityByNode[edge.sourceId];
		const toEntity = result.entityByNode[edge.targetId];
		if (!fromEntity || !toEntity) {
			result.skippedEdges++;
			continue;
		}
		if (fromEntity === toEntity) {
			result.skippedEdges++;
			continue;
		}
		const kind = mapEdgeKind(edge.type);
		const created = await relateUnique(db, fromEntity, toEntity, kind, edge.weight);
		if (created) result.edges++;
	}

	return result;
}

/**
 * RELATE on a DETERMINISTIC edge id so a re-run is a no-op rather than a duplicate edge.
 * Returns true if newly created. Mirrors bridge.ts relateUnique (SurrealDB has no UNIQUE over
 * a RELATION, so the deterministic id + existence check IS the idempotency guarantee).
 */
async function relateUnique(
	db: Db,
	from: string,
	to: string,
	kind: string,
	weight?: number
): Promise<boolean> {
	const f = assertRecordId(from);
	const t = assertRecordId(to);
	const eid = graphEdgeId(from, to, kind);
	const [existing] = await db.query<[Array<{ id: unknown }>]>(`SELECT id FROM ${eid};`);
	if (existing.length) return false;
	// weight is optional<float> with a DEFAULT — OMIT when absent (option<T> rejects NULL §6.1).
	const set = weight === undefined ? '' : ' SET weight = $weight';
	await db.query(`RELATE ${f}->${eid}->${t} SET kind = $kind${set ? ', weight = $weight' : ''};`, {
		kind,
		weight
	});
	return true;
}

/**
 * Filesystem edge: read a `graph-state.json` from disk and import it. Thin — parses JSON and
 * delegates so the core stays test-driven with in-memory fixtures (F-008: fixtures are inputs).
 */
export async function importGraphStateFromFile(db: Db, path: string): Promise<ImportGraphResult> {
	const graph = JSON.parse(readFileSync(path, 'utf8')) as V1GraphState;
	return importGraphState(db, graph);
}
