// TASK 2.6 — memory bridge + knowledge graph (IMPLEMENTATION-PLAN §2.6; DATA-MODEL §4.6,
// §6 migration map row `auto-memory-store.json`/`graph-state.json`; MEMORY-SPEC §6.10).
//
// Imports Claude auto-memory `.md` files into the single SurrealDB store and builds the
// REAL graph (D-032, MEMORY-SPEC §6.10: real `references` edges, not mem0's faked id
// arrays). Three outputs per import:
//
//   1. memory row     — the file's content, written through the 2.5 store pipeline
//                       (screen-BEFORE-embed §3.4 step 2.0, ADD-only §3, soft-archive
//                       §5.3). A DO-NOT-CAPTURE drop (§3.1, e.g. a "daemon is down" note)
//                       persists NO memory row but still yields an entity node.
//   2. entity node    — a first-class graph node (type="auto-memory") for the file, so the
//                       graph is navigable by topic even when a memory row was dropped.
//   3. references edges — entity →derived_from→ memory (its own content) and, for every
//                       `[label](other.md)` cross-link in the body, entity →relates_to→
//                       the linked file's entity. This is the MEMORY.md index → sub-file
//                       link structure turned into traversable edges.
//
// IDEMPOTENCY (re-run = no-op on row/edge count): every node + edge lands on a
// DETERMINISTIC record id derived from (namespace|path) — sha256-truncated, the §1.7
// importer's dedup_key principle (D-008). Re-importing UPSERT-MERGEs the same ids and
// re-RELATEs the same edge ids, never inserting twins.
//
// Boundary discipline (D-016): every record/edge id passes assertRecordId at the
// chokepoint; all values bind via $param; absent optionals are OMITTED, never NULL
// (option<T> rejects NULL — §6.1). Reuses storeMemory (screen+embed) and the FakeEmbedder
// seam so the logic verifies against a throwaway DB with NO live model (F-008).

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StringRecordId } from 'surrealdb';
import type { Db } from '../db/client';
import { assertRecordId } from '../db/validate';
import {
	storeMemory,
	MemoryCandidateFieldError,
	MemoryCandidateShapeError,
	type StoreOptions
} from './store';

// ── Parse: frontmatter + body + cross-links ────────────────────────────────────────

/** A raw auto-memory file: its basename(+rel path) and full text. */
export interface AutoMemoryFile {
	/** File name relative to the memory dir, e.g. `feedback_pr-strategy.md`. */
	path: string;
	raw: string;
}

/** A parsed auto-memory file ready to import. */
export interface ParsedAutoMemory {
	path: string;
	/** Human name (frontmatter `name`, else the basename without extension). */
	name: string;
	/** Frontmatter `type` mapped to a tag (feedback|project|reference|index|…). */
	kind: string;
	/** The markdown body (frontmatter stripped). */
	body: string;
	/** The recall-friendly content stored in the memory row (name + body). */
	content: string;
	/** `[label](other.md)` cross-links found in the body (relative .md targets only). */
	links: string[];
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Parse a tiny subset of YAML frontmatter — flat `key: value` scalars only (sufficient). */
function parseFrontmatter(block: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of block.split(/\r?\n/)) {
		const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
		if (!m) continue;
		let v = m[2].trim();
		// Strip surrounding quotes if present.
		if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
			v = v.slice(1, -1);
		}
		out[m[1].toLowerCase()] = v;
	}
	return out;
}

/** The basename of a path, sans `.md`. */
function baseName(path: string): string {
	const file = path.split(/[\\/]/).pop() ?? path;
	return file.replace(/\.md$/i, '');
}

/**
 * Extract `[label](target.md)` cross-links from a markdown body. Only RELATIVE `.md`
 * targets are kept — http(s):// links and `#anchors` are external/intra-doc, not graph
 * edges. Targets are returned verbatim (caller resolves them to entity ids by path).
 */
export function parseMemoryLinks(body: string): string[] {
	const out = new Set<string>();
	const re = /\[[^\]]*\]\(([^)]+)\)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(body)) !== null) {
		const target = m[1].trim();
		if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) continue; // http(s):// etc.
		if (target.startsWith('#')) continue; // intra-doc anchor
		if (!/\.md(#.*)?$/i.test(target)) continue; // only .md targets are graph nodes
		// Drop any anchor suffix; normalize to the bare file name.
		out.add(target.replace(/#.*$/, '').split(/[\\/]/).pop() as string);
	}
	return [...out];
}

/** Parse one auto-memory `.md` file: frontmatter, body, and cross-links. */
export function parseAutoMemoryFile(path: string, raw: string): ParsedAutoMemory {
	let body = raw;
	let fm: Record<string, string> = {};
	const fmMatch = FRONTMATTER_RE.exec(raw);
	if (fmMatch) {
		fm = parseFrontmatter(fmMatch[1]);
		body = raw.slice(fmMatch[0].length);
	}
	const name = fm.name?.trim() || baseName(path);
	const kind = (fm.type?.trim() || 'note').toLowerCase();
	body = body.trim();
	// Store the human name alongside the body so recall over the memory row is meaningful.
	const content = `${name}\n\n${body}`.trim();
	return { path, name, kind, body, content, links: parseMemoryLinks(body) };
}

// ── Deterministic ids (the dedup keys — D-008) ──────────────────────────────────────

function digest(input: string): string {
	return createHash('sha256').update(input).digest('hex').slice(0, 32);
}

/** Deterministic `entity:am_<digest(namespace|path)>` id for a file's graph node. */
export function entityIdForFile(namespace: string, path: string): string {
	return `entity:am_${digest(`${namespace}|${baseName(path)}`)}`;
}

/** Deterministic `references:<digest>` edge id so re-RELATE is a no-op, not a twin. */
function edgeId(from: string, to: string, kind: string): string {
	return `references:e_${digest(`${from}|${to}|${kind}`)}`;
}

// ── Import ──────────────────────────────────────────────────────────────────────────

export interface ImportAutoMemoryOptions {
	/** Project the imported rows scope to (table:id). Omitted ⇒ global memory. */
	project?: string;
	/** Memory namespace (DATA-MODEL §4.5) — also namespaces the deterministic ids. */
	namespace?: string;
}

export interface ImportAutoMemoryResult {
	/** Memory rows persisted (DO-NOT-CAPTURE drops are excluded). */
	imported: number;
	/**
	 * Files that persisted NO memory row: either DO-NOT-CAPTURE-screened (§3.1) OR rejected at
	 * the D-026 candidate boundary (a {@link MemoryCandidateFieldError}/{@link
	 * MemoryCandidateShapeError} — e.g. an empty-after-trim content). Both are ISOLATED per-file
	 * (counted here, skipped; the entity node still exists) — one malformed .md NEVER aborts the
	 * rest of the import.
	 */
	dropped: number;
	/** Entity nodes upserted (one per file, even when its memory row was dropped). */
	entities: number;
	/** `relates_to` cross-link edges created (entity → entity). */
	edges: number;
	/** Map of file path → its entity id (for traversal entry points). */
	entityByPath: Record<string, string>;
}

function omitUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
	const out: Partial<T> = {};
	for (const [k, v] of Object.entries(obj)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
	return out;
}

function link(id: string): StringRecordId {
	return new StringRecordId(assertRecordId(id));
}

/**
 * Import a set of auto-memory `.md` files. For each file: parse → store its memory row
 * through the 2.5 screen+embed pipeline (a DO-NOT-CAPTURE drop persists no row) → upsert
 * its `entity` node on a deterministic id → RELATE entity→derived_from→memory. Then, in a
 * second pass (all entities now exist), RELATE entity→relates_to→entity for every
 * `[label](other.md)` cross-link. Idempotent: deterministic node + edge ids make a re-run
 * a no-op on counts.
 */
export async function importAutoMemory(
	opts: StoreOptions,
	files: AutoMemoryFile[],
	options: ImportAutoMemoryOptions = {}
): Promise<ImportAutoMemoryResult> {
	const namespace = options.namespace ?? 'claude-auto-memory';
	const projectLink = options.project ? link(options.project) : undefined;

	const result: ImportAutoMemoryResult = {
		imported: 0,
		dropped: 0,
		entities: 0,
		edges: 0,
		entityByPath: {}
	};

	const parsed = files.map((f) => parseAutoMemoryFile(f.path, f.raw));

	// Pass 1 — memory rows + entity nodes + derived_from edges.
	for (const p of parsed) {
		const entityId = entityIdForFile(namespace, p.path);
		result.entityByPath[p.path] = entityId;

		// Upsert the entity node (idempotent on its deterministic id, D-008). MERGE keeps any
		// later-edited fields; the importer owns label/type/project/status.
		const entityContent = omitUndefined({
			label: p.name,
			type: 'auto-memory',
			project: projectLink,
			status: 'active'
		});
		await opts.db.query(`UPSERT ${assertRecordId(entityId)} MERGE $content RETURN NONE;`, {
			content: entityContent
		});
		result.entities++;

		// Idempotency: a re-import is NOT a new observation (ADD-only, §3 — we never write a
		// twin). The memory row's dedup key is (namespace|key); if a row already exists for
		// this file, reuse it (and re-assert its idempotent derived_from edge) rather than
		// re-CREATEing — which would hit the memory_dedup UNIQUE index. The 2.5 storeMemory
		// is CREATE-only by design, so the bridge owns this pre-existence check.
		const memKey = `am:${baseName(p.path)}`;
		const existingId = await findMemoryByKey(opts.db, namespace, memKey);
		if (existingId) {
			result.imported++;
			await relateUnique(opts.db, entityId, existingId, 'derived_from');
			continue;
		}

		// Store the memory row through the 2.5 pipeline (screen BEFORE embed). A transient
		// negative note ("daemon is down") is DROPPED here and persists no row, but the
		// entity node above still exists so the topic remains in the graph.
		// PER-FILE ISOLATION (D-038 / wave-v2.2b-e widened throwing surface): storeMemory now
		// validates the candidate against the FULL `memory` schema contract and THROWS a named
		// MemoryCandidateFieldError/MemoryCandidateShapeError on a malformed file (e.g. an
		// empty-after-trim content). That ONE file is junk to import, not a fatal import error:
		// catch it, count it as a NAMED drop (the entity node already exists, so the topic stays
		// in the graph), and continue — one bad .md NEVER aborts the rest of the batch. Any OTHER
		// error (DB/embedder failure) is a real fault and re-thrown — never swallowed (F-008).
		let stored: { persisted: boolean; id: string };
		try {
			stored = await storeMemory(opts, {
				content: p.content,
				kind: 'semantic',
				namespace,
				key: memKey,
				tags: [p.kind, 'auto-memory'],
				source: 'claude-auto-memory',
				project: options.project
			});
		} catch (err) {
			if (err instanceof MemoryCandidateFieldError || err instanceof MemoryCandidateShapeError) {
				result.dropped++;
				continue;
			}
			throw err;
		}

		if (stored.persisted) {
			result.imported++;
			// entity →derived_from→ its own memory row (deterministic edge id = idempotent).
			await relateUnique(opts.db, entityId, stored.id, 'derived_from');
		} else {
			result.dropped++;
		}
	}

	// Pass 2 — cross-link edges (all entity nodes now exist, so no dangling targets).
	for (const p of parsed) {
		const fromEntity = result.entityByPath[p.path];
		for (const target of p.links) {
			const toEntity = entityIdForFile(namespace, target);
			// Only link to a file we actually imported (skip links to files outside this batch).
			if (!Object.values(result.entityByPath).includes(toEntity)) continue;
			if (toEntity === fromEntity) continue; // no self-edge
			const created = await relateUnique(opts.db, fromEntity, toEntity, 'relates_to');
			if (created) result.edges++;
		}
	}

	return result;
}

/**
 * Find an existing active memory row by its (namespace, key) — the bridge's idempotency
 * probe. Returns the row id or null. Matches the `memory_dedup` UNIQUE invariant
 * (dedup_key = namespace|key) without re-CREATEing a colliding row.
 */
async function findMemoryByKey(db: Db, namespace: string, key: string): Promise<string | null> {
	const [rows] = await db.query<[Array<{ id: unknown }>]>(
		`SELECT id FROM memory WHERE namespace = $ns AND key = $key LIMIT 1;`,
		{ ns: namespace, key }
	);
	return rows.length ? String(rows[0].id) : null;
}

/**
 * RELATE on a DETERMINISTIC edge id so a re-run is a no-op rather than a duplicate edge.
 * Returns true if the edge was newly created, false if it already existed. The id is the
 * digest of (from|to|kind), so the same triple always targets the same `references` row.
 */
async function relateUnique(db: Db, from: string, to: string, kind: string): Promise<boolean> {
	const f = assertRecordId(from);
	const t = assertRecordId(to);
	// The edge id is interpolated below, so it MUST pass the D-016 chokepoint like every
	// other interpolated record id (TASK 13.5 finding 3) — derived-or-not, no exceptions.
	const eid = assertRecordId(edgeId(from, to, kind));
	// Existence check on the deterministic edge id (idempotency without relying on a UNIQUE
	// over an edge RELATION, which SurrealDB does not support directly).
	const [existing] = await db.query<[Array<{ id: unknown }>]>(`SELECT id FROM ${eid};`);
	if (existing.length) return false;
	// RELATE with an explicit edge id. `in`/`out` are set by RELATE from the endpoints.
	await db.query(`RELATE ${f}->${eid}->${t} SET kind = $kind;`, { kind });
	return true;
}

// ── Traversal — the §2.6 verify primitive ───────────────────────────────────────────

/** A graph node returned by traversal. */
export interface GraphNode {
	id: string;
	label: string;
	type: string;
}

export interface TraverseOptions {
	/** Hop depth (1 = direct neighbours, 2 = neighbours-of-neighbours). Default 1. */
	depth?: number;
}

/**
 * Knowledge-graph traversal: from a start entity, follow outbound `relates_to`
 * `references` edges up to `depth` hops and return the linked ENTITY nodes (deduped,
 * excluding the start node). This is the §2.6 verify primitive — "a graph traversal
 * returns linked entities from imported memory". Only ACTIVE entities are returned
 * (soft-archive read-guard, D-015). Pure read; no LLM (D-029 ethos).
 */
export async function traverse(db: Db, startEntity: string, options: TraverseOptions = {}): Promise<GraphNode[]> {
	const start = assertRecordId(startEntity);
	const depth = Math.max(1, options.depth ?? 1);

	const seen = new Set<string>([start]);
	const out = new Map<string, GraphNode>();
	let frontier: string[] = [start];

	for (let hop = 0; hop < depth && frontier.length; hop++) {
		const seeds = frontier.map((id) => link(id));
		// One-hop outbound relates_to neighbours of the whole frontier, in one round-trip.
		const [rows] = await db.query<[Array<{ id: unknown; label: string; type: string }>]>(
			// The graph subquery returns one neighbour array PER seed (nested), so flatten it
			// before the IN-membership test — an un-flattened array-of-arrays never matches a
			// scalar record id (SurrealDB 2.6.5: `IN [[…]]` ≠ `IN […]`). Verified in dbg.
			`SELECT id, label, type FROM entity
			  WHERE (status = "active" OR status IS NONE)
			    AND id IN array::flatten(
			      (SELECT VALUE ->(references WHERE kind = "relates_to")->entity FROM $seeds)
			    );`,
			{ seeds }
		);
		const next: string[] = [];
		for (const r of rows) {
			const id = String(r.id);
			if (seen.has(id)) continue;
			seen.add(id);
			out.set(id, { id, label: r.label, type: r.type });
			next.push(id);
		}
		frontier = next;
	}

	return [...out.values()];
}

// ── Filesystem edge (the runnable importer binds here) ───────────────────────────────

/**
 * Read every `.md` file from an auto-memory directory and import them. The dir edge is
 * thin: it only reads files and delegates to {@link importAutoMemory}, so the core logic
 * stays filesystem-free and test-driven with in-memory fixtures (no fake RUNTIME data —
 * fixtures are inputs, F-008). Returns the import result.
 */
export async function importAutoMemoryFromDir(
	opts: StoreOptions,
	dir: string,
	options: ImportAutoMemoryOptions = {}
): Promise<ImportAutoMemoryResult> {
	const names = readdirSync(dir).filter((n) => /\.md$/i.test(n));
	const files: AutoMemoryFile[] = names.map((name) => ({
		path: name,
		raw: readFileSync(join(dir, name), 'utf8')
	}));
	return importAutoMemory(opts, files, options);
}
