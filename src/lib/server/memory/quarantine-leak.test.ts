import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';
import { StringRecordId } from 'surrealdb';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject, deleteProject } from '../projects/repo';
import {
	MemoryService,
	FakeEmbedder,
	cacheKey,
	gateCandidate,
	listMemories,
	listProjectMemories,
	listProjectGraph
} from './index';
import { readLearnedValues, readSoulMetrics } from './soul';

// MEMORY-SPEC §3.1b + §5.3 — END-TO-END QUARANTINE LEAK HARNESS (D-026).
//
// The engine ALREADY stamps screen_status (store.ts) and excludes quarantined rows from
// every injection surface (recall.ts active-set filter, loadTier0 in index.ts, the explorer
// projections). This harness PROVES that invariant end-to-end against a REAL throwaway
// SurrealDB — it is the evidence artifact, not a digest. It does NOT rebuild quarantine.
//
// Deliverables (each an assertion below, with a real excluded-row count):
//   (1) a quarantined candidate is WRITTEN for audit but EXCLUDED from the active/persisted set.
//   (2) the RAW secret is NEVER embedded — no §7.1 embedding_cache entry keyed on raw text.
//   (3) a quarantined row is NEVER returned by recall().
//   (4) a quarantined row is NEVER returned by loadTier0() (even promoted to tier=0).
//   (5) a quarantined row is EXCLUDED from the knowledge-only export surfaces (D-026) —
//       the realized export-adjacent reads are the explorer projections (listMemories,
//       listProjectMemories, listProjectGraph) per DATA-MODEL §7b / DECISIONS D-026(b).
//
// PLUS a static grep-and-assert (no DB): enumerate EVERY source line that SELECTs `memory`
// rows and assert each injection/recall/export surface carries `screen_status != "quarantined"`,
// or is an explicitly-documented non-leak exemption (leak detector / by-id curator / write-side
// dedup probe). This is the grep-and-assert the spec demands — not a spot-check.

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', '..', '..', '..', 'src', 'lib', 'server');

// ─────────────────────────────────────────────────────────────────────────────────
// PART A — STATIC grep-and-assert over every `memory`-row reader (no DB).
// ─────────────────────────────────────────────────────────────────────────────────
//
// The enumeration below is the authoritative census of every NON-TEST source file that
// runs `SELECT ... FROM memory`. Each is classified LEAK (an injection/recall/export
// surface that MUST carry the quarantine filter) or EXEMPT (with the reason it cannot
// leak quarantined content into model context or an export). The coverage guard at the
// end GLOBS the whole `src/lib/server` source tree (excluding tests), so a new `FROM
// memory` reader added in ANY file — including a brand-new uncatalogued file — that this
// census does not classify makes the guard FAIL, forcing it to be classified LEAK/EXEMPT.

interface ReaderPath {
	file: string;
	/** A substring unique to the SELECT statement so we can locate + assert on it. */
	marker: string;
	/** LEAK = must carry the quarantine filter. EXEMPT = documented non-leak. */
	kind: 'LEAK' | 'EXEMPT';
	why: string;
}

const READERS: ReaderPath[] = [
	// ── LEAK surfaces — every injection / recall / export read MUST exclude quarantined ──
	{
		file: 'memory/recall.ts',
		marker: 'embedding <|',
		kind: 'LEAK',
		why: 'recall vector KNN — primary injection path (§4)'
	},
	{
		file: 'memory/recall.ts',
		marker: '->references->memory FROM $seeds',
		kind: 'LEAK',
		why: 'recall graph-neighbour expansion (§4.3 step 2) — also injects'
	},
	{
		file: 'memory/index.ts',
		marker: 'WHERE tier = 0',
		kind: 'LEAK',
		why: 'loadTier0 — always-loaded directive injection (§6.8)'
	},
	{
		file: 'memory/explorer.ts',
		// Whitespace-insensitive (see collapseWs): this pins that the ordering keys and the bound
		// are still there, NOT how the SQL string happens to be wrapped or indented. Both ORDER BY
		// fields appear in this query's SELECT projection, which is the F-020 invariant.
		marker: 'ORDER BY importance DESC, created_at DESC LIMIT $limit',
		kind: 'LEAK',
		why: 'listMemories — /memory explorer + knowledge-only export surface (UI-SPEC §43, D-026)'
	},
	{
		file: 'memory/explorer.ts',
		marker: 'WHERE screen_status != "quarantined" AND project = $project',
		kind: 'LEAK',
		why: 'listProjectMemories — project Memory tab + export surface (UI-SPEC §195)'
	},
	{
		file: 'memory/explorer.ts',
		marker: 'SELECT VALUE id FROM memory WHERE project = $project',
		kind: 'LEAK',
		why: 'listProjectGraph entity sub-select — graph export of project memory (D-026)'
	},
	{
		file: 'memory/observability.ts',
		marker: 'SELECT id, content FROM memory WHERE screen_status',
		kind: 'LEAK',
		why: 'loadMemoryContent — the utilization lens (listRetrievalOutcomes) surfaces memory CONTENT to the UI; must exclude quarantined so a quarantined memory with persisted retrieval_outcome rows never surfaces its body (D-026, UI-SPEC §43)'
	},
	{
		file: 'scene/scene.ts',
		marker: 'SELECT id, kind, status, project, importance, created_at FROM memory',
		kind: 'LEAK',
		why: 'MS-2 scene aggregator — the /memory Scene viz surfaces memory NODES to the UI (id + a kind-label only, never raw content); carries the quarantine filter so a quarantined memory never appears as a scene node (MEMORY-SCENE-SPEC §2, D-026)'
	},
	{
		file: 'scene/scene.ts',
		marker: 'WHERE category = "correction" AND screen_status != "quarantined"',
		kind: 'LEAK',
		why: 'S3 scene aggregator — surfaces high-importance CORRECTION memory rows as correction NODES (id + a kind-label only, never raw content); carries the same quarantine filter so a quarantined correction never appears as a scene node (D-026)'
	},
	// ── EXEMPT readers — cannot leak quarantined content into context or an export ──
	{
		file: 'workforce/activation.ts',
		marker: 'string::contains(content, $s)',
		kind: 'EXEMPT',
		why: 'sentinelSweep is the LEAK DETECTOR itself — it MUST scan ALL rows incl. quarantined; filtering would blind it (WORKFORCE-SPEC §4.2)'
	},
	{
		file: 'importer/v1-stores.ts',
		marker: 'WHERE namespace = $ns AND key = $key LIMIT 1',
		kind: 'EXEMPT',
		why: 'findMemoryByKey — write-side import idempotency probe: returns an id only, never injects content nor exports'
	},
	{
		file: 'memory/bridge.ts',
		marker: 'WHERE namespace = $ns AND key = $key LIMIT 1',
		kind: 'EXEMPT',
		why: 'findMemoryByKey — write-side auto-memory bridge idempotency probe: returns an id only'
	},
	{
		file: 'memory/loop.ts',
		marker: 'SELECT tier, source FROM $m',
		kind: 'EXEMPT',
		why: 'consolidate §5.2 guard — by-id curator read of an explicitly-passed member; not a query surface and never injects'
	},
	{
		file: 'memory/soul.ts',
		marker: 'count() AS c FROM memory WHERE category = "correction"',
		kind: 'LEAK',
		why: 'readSoulMetrics correction count — feeds the S4 maturity ladder; a quarantined correction must never move Atelier\'s identity (COGNITIVE-ARCHITECTURE S4, D-026)'
	},
	{
		file: 'memory/soul.ts',
		marker: 'SELECT content, importance, created_at FROM memory',
		kind: 'LEAK',
		why: 'readLearnedValues — surfaces correction memory CONTENT as the soul\'s "learned values" on /brain AND into the concierge S4 consumer; the strongest injection-shaped read in soul.ts (D-026)'
	},
	{
		file: 'memory/eval/harness.ts',
		marker: 'embedding <|${k},COSINE|>',
		kind: 'LEAK',
		why: 'B8 §11 eval harness fetchCandidates — mirrors recall step-1 read-only for the weight/novelty sweep; classified LEAK so the guard enforces the same active-set filter, ensuring a sweep can never surface a quarantined row (measurement-only; never injects to a live model)'
	}
];

// EOL-normalise on read (F-054). This repo is developed on Windows with `core.autocrlf=true`,
// so source files are LF in the git object database but CRLF in the working tree — invisibly,
// since git normalises back on the way in and `git status` stays clean either way. A source-text
// scan that does not normalise therefore passes in one checkout and fails in another AT THE SAME
// SHA, which is exactly how this suite went red for a query that had not changed at all.
function readSource(rel: string): string {
	return readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
}

// Collapse every run of whitespace to a single space, for marker matching ONLY.
//
// The markers below pin the SEMANTIC shape of a query — which columns are projected, which table
// is read, which predicate filters it. They must NOT pin its LAYOUT: a marker carrying the exact
// indentation of a wrapped SQL string breaks forever the first time anyone reformats the query or
// checks it out with different line endings, and the resulting red says "marker not found" when
// nothing is actually wrong. Collapsing whitespace on BOTH sides keeps the assertion sensitive to
// what matters (a genuinely removed `ORDER BY`, a dropped quarantine filter) and blind to what
// does not (indentation, wrapping, CRLF vs LF).
function collapseWs(s: string): string {
	return s.replace(/\s+/g, ' ');
}

// Paren depth at every index of `src` — `(` carries its OUTER depth, `)` its outer depth too,
// so a whole `( … )` group reads as "deeper" only strictly between the brackets. Used below to
// tell a SUBQUERY apart from the statement that contains it. Clamped at 0 so an unbalanced `)`
// inside a string literal degrades to depth-0 rather than going negative.
function parenDepths(src: string): number[] {
	const depths = new Array<number>(src.length);
	let d = 0;
	for (let i = 0; i < src.length; i++) {
		const ch = src[i];
		if (ch === '(') {
			depths[i] = d;
			d++;
		} else if (ch === ')') {
			d = d > 0 ? d - 1 : 0;
			depths[i] = d;
		} else {
			depths[i] = d;
		}
	}
	return depths;
}

// The SurrealQL clauses that TERMINATE an `ORDER BY` / `GROUP BY` field list. A second ordering
// clause terminates the first, which is what makes `GROUP BY … ORDER BY …` legible as two
// clauses instead of one un-parseable blob.
const ORDERING_CLAUSE =
	/\b(?:ORDER|GROUP) BY\s+(.+?)(?=\s+(?:LIMIT|START|FETCH|TIMEOUT|PARALLEL|EXPLAIN|ORDER BY|GROUP BY)\b|$)/g;

// F-020 detector: every field named in an `ORDER BY` / `GROUP BY` must also appear in that same
// statement's `SELECT` projection, or SurrealDB errors at QUERY time — a live-only failure a
// `stubDb()` unit test can never catch, because it does not parse SurrealQL. This has recurred
// 3× in this repo, which is what earns it a static check.
//
// THE INPUT IS TYPESCRIPT, NOT SQL — which is the whole difficulty, and was the bug. The first
// cut split the source on `;` and treated each chunk as one statement. In TypeScript `;` is not
// a SQL delimiter and the surrounding prose freely contains SQL-shaped words, so that produced
// BOTH failure directions on real files:
//   • FALSE POSITIVE — a case-insensitive `FROM` anchor bound to a lowercase TypeScript `from`
//     (`import … from`, `Array.from(…)`, a comment saying "pulled from cache") sitting ahead of
//     the real SQL, truncating the projection to nothing and reporting every ordering key of a
//     PERFECTLY CORRECT query as an offender. A guard that reds on correct SQL is worse than no
//     guard: it teaches people to weaken the query.
//   • FALSE NEGATIVE — one `;`-chunk can hold two clauses or two statements, and a single
//     non-global `.exec` plus a first-`SELECT`-anchored projection made the second invisible.
//     `GROUP BY … ORDER BY …` (the standard analytics-rollup shape) was entirely unchecked.
//
// So the scan anchors on SQL, not on chunks: each `SELECT` keyword starts a statement whose
// extent runs to the first `;`, the next SIBLING `SELECT` (a DEEPER one is a subquery and stays
// part of this statement), or the close of the enclosing paren group. Every keyword match is
// UPPERCASE-only and must sit at the statement's own paren depth, so neither TypeScript prose
// nor a subquery's clauses can be mistaken for the statement's own. (The `SELECT` gate was
// already case-sensitive before this, so requiring uppercase throughout removes no coverage —
// SurrealQL keywords are uppercase in all 11 catalogued readers.)
//
// Returns one entry per violating field. `onStatement` is invoked for every ordered statement
// actually inspected, so a caller can prove the scan is not silently looking at nothing.
function orderKeysNotProjected(
	source: string,
	onStatement: () => void = () => {}
): Array<{ field: string; stmt: string }> {
	const out: Array<{ field: string; stmt: string }> = [];
	// Shadow path — nil/empty source: nothing to inspect, and never a throw.
	if (!source) return out;
	const src = collapseWs(source.replace(/\r\n/g, '\n'));
	const depths = parenDepths(src);
	const heads = [...src.matchAll(/\bSELECT\b/g)].map((m) => m.index);

	for (let h = 0; h < heads.length; h++) {
		const start = heads[h];
		const depth = depths[start];
		// Extent: the first `;` or the point where the enclosing paren group closes…
		let end = src.length;
		for (let j = start + 'SELECT'.length; j < src.length; j++) {
			if (src[j] === ';' || depths[j] < depth) {
				end = j;
				break;
			}
		}
		// …or the next SIBLING/outer `SELECT`, whichever comes first. A deeper `SELECT` is a
		// subquery of THIS statement and must not truncate it.
		for (let k = h + 1; k < heads.length && heads[k] < end; k++) {
			if (depths[heads[k]] <= depth) {
				end = heads[k];
				break;
			}
		}
		const stmt = src.slice(start, end);

		// The FROM that binds THIS statement: uppercase, after the SELECT, at the SELECT's own
		// depth. A lowercase TypeScript `from` and a subquery's `FROM` are both invisible here.
		let fromAt = -1;
		for (const m of stmt.matchAll(/\bFROM\b/g)) {
			if (depths[start + m.index] === depth) {
				fromAt = m.index;
				break;
			}
		}
		// Shadow path — a statement with no FROM of its own (prose containing the word SELECT, a
		// malformed or inlined fragment): there is no projection to check against, so it cannot
		// be judged.
		if (fromAt === -1) continue;
		const projection = stmt.slice(0, fromAt);
		// `SELECT *` and `SELECT VALUE x` project everything / a single value — exempt.
		if (/\bSELECT\s+(\*|VALUE\b)/.test(projection)) continue;
		// An INTERPOLATED projection (`SELECT ${COLS} FROM …`) is UNRESOLVABLE from source text: the
		// column list lives in a variable, so the literal membership test below can only ever answer
		// "absent" and would report every ordering key of a PERFECTLY CORRECT query. Same rule as the
		// ordering-term side further down — skip what cannot be resolved rather than guess FAIL.
		// MEASURED: without this, projects/pm-concierge.ts:346/:358 (whose SENDER_PROJECTION does
		// contain `created_at`) produce 2 fabricated F-020 violations in a whole-tree sweep.
		if (projection.includes('${')) continue;
		let ordered = false;
		// EVERY ordering clause, not just the first — `GROUP BY x ORDER BY y` is two clauses.
		for (const m of stmt.matchAll(ORDERING_CLAUSE)) {
			// A clause belonging to a nested subquery is checked when that subquery is visited.
			if (depths[start + m.index] !== depth) continue;
			ordered = true;
			for (const term of m[1].split(',')) {
				const field = term
					.trim()
					.replace(/\s+(ASC|DESC|COLLATE|NUMERIC)\b.*$/i, '')
					.trim();
				// Only plain column references are checkable; expressions/functions are skipped
				// rather than guessed at — a false FAIL here would push someone to weaken a query.
				if (!/^[a-z_][a-z0-9_]*$/i.test(field)) continue;
				if (!new RegExp(`\\b${field}\\b`).test(projection)) {
					out.push({ field, stmt: stmt.trim().slice(0, 120) });
				}
			}
		}
		if (ordered) onStatement();
	}
	return out;
}

// The accepted quarantine-excluding predicates. `screen_status` is a NON-OPTIONAL string with
// DEFAULT "clean" over the closed domain clean|redacted|quarantined (schema.ts DEFINE FIELD
// OVERWRITE screen_status ON memory; screen.ts `ScreenStatus`), so:
//   • `screen_status != "quarantined"` is the DENY-LIST form — the baseline active-set filter (§5.3).
//   • `screen_status = "clean"` is the ALLOW-LIST form — STRICTLY STRONGER: it excludes quarantined
//     AND redacted rows. Accepting it does NOT weaken the guard (an allow-list over a closed domain
//     can only admit a subset of what the deny-list admits); rejecting it would force a SAFER reader
//     to loosen its filter to satisfy a test, which is the wrong direction.
// Anything else still FAILS — an unfiltered read cannot satisfy either form.
const QUARANTINE_FILTERS = ['screen_status != "quarantined"', 'screen_status = "clean"'];

describe('PART A — static grep-and-assert: every `memory`-row reader is classified + guarded', () => {
	for (const r of READERS) {
		it(`${r.file} :: ${r.kind} — ${r.why}`, () => {
			// Match on the whitespace-collapsed form so the assertion tracks the query's meaning,
			// not its formatting. Both the source and the marker go through the same normaliser,
			// and the statement slicing below runs on that SAME string so the indices stay valid.
			const src = collapseWs(readSource(r.file));
			const marker = collapseWs(r.marker);
			const idx = src.indexOf(marker);
			expect(idx, `marker not found in ${r.file}: ${r.marker}`).toBeGreaterThanOrEqual(0);
			if (r.kind === 'LEAK') {
				// The quarantine filter must appear in the SAME query statement as the marker.
				// Slice the enclosing statement (from the FROM/marker back to the prior `;`,
				// forward to the next `;`) and assert the filter clause is present in it.
				const stmtStart = src.lastIndexOf(';', idx) + 1;
				const stmtEnd = src.indexOf(';', idx);
				const stmt = src.slice(stmtStart, stmtEnd === -1 ? src.length : stmtEnd);
				expect(
					QUARANTINE_FILTERS.some((f) => stmt.includes(f)),
					`LEAK surface ${r.file} (${r.marker}) is MISSING a quarantine-excluding filter in its statement — expected one of: ${QUARANTINE_FILTERS.join(' | ')}`
				).toBe(true);
			}
		});
	}

	it('the accepted filter forms are exactly two, and an UNFILTERED statement still FAILS', () => {
		// Guards the Wave C widening (allow-list form) from becoming a blanket weakening: only the
		// two closed-domain predicates are accepted, and a read carrying neither is still rejected.
		const unfiltered = 'SELECT content FROM memory WHERE project = $p ORDER BY importance DESC';
		expect(QUARANTINE_FILTERS.some((f) => unfiltered.includes(f))).toBe(false);
		// A near-miss that admits quarantined rows is NOT accepted (it is not one of the two forms).
		const nearMiss = 'SELECT content FROM memory WHERE screen_status != "redacted"';
		expect(QUARANTINE_FILTERS.some((f) => nearMiss.includes(f))).toBe(false);
		// Both accepted forms are recognised.
		expect(
			QUARANTINE_FILTERS.some((f) => 'WHERE screen_status != "quarantined" AND x'.includes(f))
		).toBe(true);
		expect(QUARANTINE_FILTERS.some((f) => 'WHERE screen_status = "clean" AND x'.includes(f))).toBe(
			true
		);
	});

	it('marker matching is blind to EOL/indentation but STILL detects a genuinely-missing clause', () => {
		// The trap this closes, from both sides.
		//
		// A source-text scan that pins exact whitespace breaks forever the first time the file is
		// reformatted or checked out with different line endings — and then reports "marker not
		// found" about a query that is perfectly correct, which is precisely what happened here
		// (the marker below failed with CRLF while explorer.ts's query was unchanged and valid).
		//
		// But relaxing it must NOT make it vacuous: this same census caught a REAL bug two waves
		// ago, so the matcher has to keep failing when the clause is actually gone. Both directions
		// are asserted, because only proving one of them is how a guard quietly becomes decoration.
		const marker = collapseWs('ORDER BY importance DESC, created_at DESC LIMIT $limit');

		// ── Insensitive to LAYOUT ──────────────────────────────────────────────────────────
		const lf = 'SELECT importance, created_at FROM memory\n\tORDER BY importance DESC, created_at DESC\n\t  LIMIT $limit;';
		expect(collapseWs(lf).indexOf(marker)).toBeGreaterThanOrEqual(0);
		// The exact CRLF form that produced the original -1.
		expect(collapseWs(lf.replace(/\n/g, '\r\n')).indexOf(marker)).toBeGreaterThanOrEqual(0);
		// Re-indented / re-wrapped differently — still found.
		const reflowed = 'SELECT importance, created_at FROM memory ORDER BY importance DESC,     created_at DESC\n\n        LIMIT $limit;';
		expect(collapseWs(reflowed).indexOf(marker)).toBeGreaterThanOrEqual(0);

		// ── Sensitive to MEANING ───────────────────────────────────────────────────────────
		// ORDER BY removed entirely → must NOT match.
		const noOrder = 'SELECT importance, created_at FROM memory LIMIT $limit;';
		expect(collapseWs(noOrder).indexOf(marker)).toBe(-1);
		// A secondary ordering key dropped → must NOT match (ordering is part of the contract).
		const droppedKey = 'SELECT importance, created_at FROM memory ORDER BY importance DESC LIMIT $limit;';
		expect(collapseWs(droppedKey).indexOf(marker)).toBe(-1);
		// Direction flipped → must NOT match.
		const flipped = 'SELECT importance, created_at FROM memory ORDER BY importance DESC, created_at ASC LIMIT $limit;';
		expect(collapseWs(flipped).indexOf(marker)).toBe(-1);
		// The bound removed → must NOT match (an unbounded read is its own defect).
		const unbounded = 'SELECT importance, created_at FROM memory ORDER BY importance DESC, created_at DESC;';
		expect(collapseWs(unbounded).indexOf(marker)).toBe(-1);
	});

	it('F-020 predicate: catches a missing ordering key, exempts SELECT */VALUE, survives CRLF', () => {
		// Proves the scan below is NOT vacuous, against synthetic queries with known verdicts.
		// A census check that cannot fail is decoration, and this file's whole purpose is to be
		// the evidence artifact — so the detector is itself under test.
		const g = (s: string) => orderKeysNotProjected(s).map((o) => o.field);
		// Detects the real defect, in both ORDER BY and GROUP BY form.
		expect(g('SELECT id, importance FROM memory ORDER BY importance DESC, created_at DESC;')).toEqual(['created_at']);
		expect(g('SELECT count() AS c FROM memory GROUP BY category;')).toEqual(['category']);
		// …and in the COMBINED form, which is the shape the first cut could not see at all.
		expect(g('SELECT count() AS c FROM memory GROUP BY category ORDER BY created_at DESC LIMIT 5;')).toEqual(['category', 'created_at']);
		// Clean queries stay clean — including under CRLF and heavy indentation (the F-054 shape).
		expect(g('SELECT id, importance, created_at FROM memory ORDER BY importance DESC, created_at DESC LIMIT $l;')).toEqual([]);
		expect(g('SELECT id,\r\n\t importance,\r\n\t created_at\r\n FROM memory\r\n ORDER BY importance DESC, created_at DESC\r\n LIMIT $l;')).toEqual([]);
		expect(g('SELECT category, count() AS c FROM memory GROUP BY category;')).toEqual([]);
		// Exemptions: `*` and `VALUE` project everything / a single value.
		expect(g('SELECT * FROM memory ORDER BY created_at DESC;')).toEqual([]);
		expect(g('SELECT VALUE id FROM memory ORDER BY created_at DESC;')).toEqual([]);
		// Expressions/functions are not plain column refs and are deliberately not checked.
		expect(g('SELECT id FROM memory ORDER BY math::abs(score) DESC;')).toEqual([]);
		// Shadow paths — empty input, and source with no SELECT at all.
		expect(g('')).toEqual([]);
		expect(g('const x = 1;')).toEqual([]);
	});

	it('REGRESSION: the F-020 detector does NOT red on CORRECT SQL sitting next to TypeScript `from`', () => {
		// THE FAIL THIS CLOSES. The first cut anchored the projection on a CASE-INSENSITIVE `FROM`
		// searched over raw TypeScript, so the first lowercase `from` in the `;`-chunk — an import,
		// an `Array.from`, a comment — truncated the projection to nothing and every ordering key
		// of a PERFECTLY CORRECT query came back an offender. There are 90 such non-import `from`
		// occurrences across the catalogued readers (scene.ts alone has 30); the guard was one
		// statement reorder away from reporting a fabricated F-020 violation, which is precisely
		// the mystery-red this whole wave exists to end.
		const g = (s: string) => orderKeysNotProjected(s).map((o) => o.field);
		const CORRECT = 'SELECT id, importance, created_at FROM memory ORDER BY importance DESC, created_at DESC LIMIT $l';
		// A comment, an ASI-style import, and a call — each ahead of a correct query, none an offender.
		expect(g('const t = 1 // pulled from cache\nconst r = await db.query(`' + CORRECT + '`)')).toEqual([]);
		expect(g("import { Db } from '../db/client'\nconst r = await db.query(`" + CORRECT + '`)')).toEqual([]);
		expect(g('const ids = Array.from(set)\nconst r = await db.query(`' + CORRECT + '`)')).toEqual([]);
		// A lowercase `from` AFTER the query (a params object) is equally harmless.
		expect(g('await db.query(`' + CORRECT + '`, { l: Array.from(s).length })')).toEqual([]);
		// Still sensitive: the SAME surroundings around a genuinely BROKEN query still red.
		expect(
			g('const ids = Array.from(set)\nconst r = await db.query(`SELECT id, importance FROM memory ORDER BY importance DESC, created_at DESC LIMIT $l`)')
		).toEqual(['created_at']);
	});

	it('REGRESSION: the F-020 detector does NOT red on a query whose PROJECTION is interpolated', () => {
		// THE SECOND TRIGGER of the same false-positive class, and the fail this closes. The
		// projection is sliced out of TYPESCRIPT, so when the column list is a variable — `SELECT
		// ${COLS} FROM …`, the live shape at projects/pm-concierge.ts:346/:358 — the literal
		// `\b{field}\b` membership test can only ever answer "absent", and EVERY ordering key of a
		// PERFECTLY CORRECT query came back an offender. Measured on the real tree before the fix:
		// 260 files, 116 ordered statements, 2 offenders — both of them pm-concierge queries whose
		// SENDER_PROJECTION literally contains `created_at`. Unresolvable is not the same as
		// violating; the ordering-TERM side already skipped what it could not resolve, and the
		// PROJECTION side now does too. (Written with single quotes so `${` stays literal here.)
		const g = (s: string) => orderKeysNotProjected(s).map((o) => o.field);
		// The exact live shape: interpolated projection AND an interpolated LIMIT.
		expect(
			g('const COLS = `id, body, created_at`;\nconst [rows] = await db.query(`SELECT ${COLS} FROM peer_message WHERE to_kind = "pm" ORDER BY created_at ASC LIMIT ${MAX}`);')
		).toEqual([]);
		// Also with GROUP BY, and with the interpolation mid-projection rather than whole.
		expect(g('await db.query(`SELECT id, ${EXTRA} FROM memory GROUP BY category ORDER BY created_at DESC`);')).toEqual([]);
		// An unresolvable statement is NOT counted as inspected — the coverage counter that proves
		// the scan is not blind must never be inflated by a statement it declined to judge.
		let inspected = 0;
		orderKeysNotProjected('await db.query(`SELECT ${COLS} FROM peer_message ORDER BY created_at ASC`);', () => inspected++);
		expect(inspected, 'a skipped, unresolvable statement must not count as inspected').toBe(0);
		// ── The skip is NARROW: everything still resolvable is still judged ──────────────────
		// An interpolated LIMIT with a LITERAL projection is fully resolvable → still red.
		expect(g('await db.query(`SELECT id, importance FROM memory ORDER BY created_at DESC LIMIT ${MAX}`);')).toEqual(['created_at']);
		// A skipped statement does not shield a sibling: the literal, broken one still reds.
		expect(
			g('const a = `SELECT ${COLS} FROM peer_message ORDER BY created_at ASC`, b = `SELECT id FROM memory ORDER BY importance DESC`;')
		).toEqual(['importance']);
	});

	it('REGRESSION: the F-020 detector sees BOTH clauses, and each of two statements in one chunk', () => {
		// Second half of the same root cause — a `;`-chunk of TypeScript is not one SQL statement.
		const g = (s: string) => orderKeysNotProjected(s).map((o) => o.field);
		// (a) GROUP BY + ORDER BY in ONE statement: a single `.exec` saw only the first clause and
		// its capture swallowed the second, so the analytics-rollup shape was never checked at all.
		expect(g('SELECT category, count() AS c FROM memory GROUP BY category ORDER BY created_at DESC LIMIT 5;')).toEqual(['created_at']);
		// The clean counterpart of that same shape stays clean.
		expect(g('SELECT category, created_at, count() AS c FROM memory GROUP BY category ORDER BY created_at DESC LIMIT 5;')).toEqual([]);
		// (b) TWO SELECTs sharing one `;`-chunk: the second statement's violation was masked
		// because the projection slice resolved against the FIRST SELECT.
		expect(
			g('const a = `SELECT id, created_at FROM memory ORDER BY created_at DESC`, b = `SELECT id FROM memory ORDER BY importance DESC`;')
		).toEqual(['importance']);
		// (c) A SUBQUERY is its own statement — it neither truncates its parent nor inherits its
		// parent's projection. Both the parent's ordering key and the subquery's are checked.
		expect(
			g('SELECT out FROM references WHERE in IN (SELECT VALUE id FROM memory WHERE project = $p) ORDER BY out DESC;')
		).toEqual([]);
		expect(
			g('SELECT out FROM references WHERE in IN (SELECT id FROM memory ORDER BY created_at DESC) ORDER BY kind DESC;')
		).toEqual(['kind', 'created_at']); // parent first (source order), then the subquery
	});

	it('F-020: every ORDER BY / GROUP BY field in a catalogued reader appears in its own SELECT', () => {
		// The invariant the brittle literal was standing in for, asserted DIRECTLY against the real
		// source instead of via a whitespace-exact string. F-020 has recurred 3× in this repo and a
		// stubDb unit test cannot catch it (it never parses SurrealQL), so a static check earns its
		// place: a projection missing an ordering key is a live-only failure.
		const offenders: string[] = [];
		let inspected = 0;
		for (const file of new Set(READERS.map((r) => r.file))) {
			for (const o of orderKeysNotProjected(readSource(file), () => inspected++)) {
				offenders.push(`${file}: ORDER/GROUP BY \`${o.field}\` is not in its SELECT — ${o.stmt}`);
			}
		}
		// Non-vacuity on the REAL tree: if a refactor moved these queries out of the catalogued
		// files, this check would silently inspect nothing and pass. Assert it actually looked.
		expect(inspected, 'F-020 scan inspected NO ordered statements — the scan has gone blind').toBeGreaterThan(0);
		expect(offenders, `F-020 violation(s):\n${offenders.join('\n')}`).toEqual([]);
	});

	// Bare `FROM memory` table reads only — NOT `memory_history`, `memory:id`, `memory_entries`,
	// `pm_memory`, nor by-id reads (`FROM $m`). This is the leak-surface regex the guard is built on.
	const FROM_MEMORY = /FROM memory(?![A-Za-z0-9_:])/g;

	// Recursively enumerate every NON-TEST .ts source file under src/lib/server, relative to SRC,
	// using forward slashes so the paths match the READERS `file` keys on every platform.
	function listServerSources(): string[] {
		const out: string[] = [];
		const walk = (absDir: string) => {
			for (const ent of readdirSync(absDir, { withFileTypes: true })) {
				const abs = join(absDir, ent.name);
				if (ent.isDirectory()) {
					walk(abs);
				} else if (ent.isFile() && ent.name.endsWith('.ts') && !ent.name.endsWith('.test.ts')) {
					out.push(relative(SRC, abs).split(sep).join('/'));
				}
			}
		};
		walk(SRC);
		return out;
	}

	it('coverage guard: per catalogued file, the census count matches the real `FROM memory` read count', () => {
		// Catches a SECOND unfiltered read sneaked into an ALREADY-CATALOGUED file: if recall.ts
		// grows a 3rd `FROM memory` the count diverges from the census and this fails, forcing a
		// new classification. (By-id `FROM $m` reads, e.g. loop.ts consolidate, never scan the
		// table, so they do not contribute to the regex count and are skipped here.)
		const censusCounts = new Map<string, number>();
		for (const r of READERS) {
			if (r.marker.includes('tier, source FROM $')) continue;
			censusCounts.set(r.file, (censusCounts.get(r.file) ?? 0) + 1);
		}
		for (const [file, expected] of censusCounts) {
			const matches = readSource(file).match(FROM_MEMORY) ?? [];
			expect(
				matches.length,
				`${file}: census expects ${expected} bare \`FROM memory\` reads but source has ${matches.length} — classify the new reader`
			).toBe(expected);
		}
	});

	// The forward-looking guard's core predicate, factored out so it can be exercised against a
	// synthetic file set (regression test below) as well as the real tree.
	function unclassifiedReaders(files: string[], read: (rel: string) => string): string[] {
		const catalogued = new Set(READERS.map((r) => r.file));
		return files.filter(
			(rel) => (read(rel).match(FROM_MEMORY) ?? []).length > 0 && !catalogued.has(rel)
		);
	}

	it('coverage guard: EVERY file in src/lib/server with a `FROM memory` read is classified in the census', () => {
		// THE forward-looking guard: scan the whole source TREE — not just the catalogued files —
		// so a brand-new, uncatalogued source file that adds an unfiltered `FROM memory` read is
		// detected and FAILS here until it is classified LEAK or EXEMPT. (The earlier census-only
		// loop could never see a new file; this Globs the filesystem.)
		const unclassified = unclassifiedReaders(listServerSources(), readSource);
		expect(
			unclassified,
			`uncatalogued \`FROM memory\` reader(s) found — classify each LEAK or EXEMPT in READERS: ${unclassified.join(', ')}`
		).toEqual([]);
	});

	it('REGRESSION (the FAIL this fix closes): a NEW uncatalogued file with an unfiltered `FROM memory` is FLAGGED', () => {
		// Before the fix the guard only iterated the hardcoded census, so a brand-new leaking file
		// was invisible. Simulate that file and prove the filesystem-driven guard now flags it.
		const SYNTH = 'memory/__synthetic_new_leak.ts';
		const fakeRead = (rel: string): string =>
			rel === SYNTH
				? 'export async function leak(db){ return db.query(`SELECT content FROM memory WHERE 1=1;`); }'
				: readSource(rel);
		// The synthetic file is NOT in READERS → must be flagged.
		expect(unclassifiedReaders([SYNTH], fakeRead)).toEqual([SYNTH]);
		// Sanity: an already-catalogued real file with the same read is NOT flagged (no false positive).
		expect(unclassifiedReaders(['memory/recall.ts'], fakeRead)).toEqual([]);
		// Sanity: a new file WITHOUT a `FROM memory` read is NOT flagged.
		const noRead = (rel: string): string =>
			rel === SYNTH ? 'export const x = 1; // SELECT id FROM memory_history' : readSource(rel);
		expect(unclassifiedReaders([SYNTH], noRead)).toEqual([]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────────
// PART B — END-TO-END leak proof against a REAL throwaway SurrealDB.
// ─────────────────────────────────────────────────────────────────────────────────

let tdb: TestDb;
let db: Db;
let mem: MemoryService;
let projectId: string;

// A high-confidence private-key block — the screen QUARANTINES (cannot redact safely in
// isolation, screen.ts `private-key` quarantineOnHit). Its content is recall-friendly so
// any leak would surface. SENTINEL marks raw key material that must never escape.
const RAW_SECRET =
	'deploy runbook leak-probe: here is the prod signing key\n' +
	'-----BEGIN RSA PRIVATE KEY-----\n' +
	'MIIEowIBAAKCAQEA_LEAKSENTINEL_9c1f_keymaterial_must_never_escape\n' +
	'-----END RSA PRIVATE KEY-----';
const SENTINEL = '_LEAKSENTINEL_9c1f_keymaterial_must_never_escape';
const RECALL_QUERY = 'deploy runbook prod signing key leak-probe';

beforeAll(async () => {
	tdb = await startTestDb();
	db = await Db.connect({
		url: tdb.wsUrl,
		username: tdb.root.username,
		password: tdb.root.password,
		namespace: tdb.namespace,
		database: tdb.database
	});
	await runMigrations(db, schemaMigrations);
	const p = await createProject(db, {
		slug: 'qleak_demo',
		name: 'Quarantine Leak Demo',
		root_path: 'F:/code/qleak-demo'
	});
	projectId = p.id;
	mem = new MemoryService({ db, embedder: new FakeEmbedder() });
}, 60_000);

afterAll(async () => {
	if (projectId) await deleteProject(db, projectId).catch(() => {});
	await db?.close();
	await tdb?.teardown();
});

function rid(id: string): StringRecordId {
	return new StringRecordId(id);
}

async function count(query: string, params: Record<string, unknown> = {}): Promise<number> {
	const [rows] = await db.query<[Array<{ c: number }>]>(query, params);
	return rows[0]?.c ?? 0;
}

describe('PART B — end-to-end quarantine leak proof (real SurrealDB, real counts)', () => {
	let quarantinedId: string;

	it('pre-flight: the screen classifies RAW_SECRET as quarantined (engine truth, not assumption)', () => {
		const gate = gateCandidate(RAW_SECRET);
		expect(gate.capture).toBe(true); // survives DO-NOT-CAPTURE
		expect(gate.screen!.status).toBe('quarantined');
		// The screened body the engine would persist already has the raw key material stripped.
		expect(gate.screen!.text).not.toContain(SENTINEL);
	});

	it('Deliverable (1): the quarantined candidate is WRITTEN for audit but EXCLUDED from the active/persisted set', async () => {
		// Plant a clean decoy on the SAME theme so recall/list have a legitimate row to return —
		// a leak would show up as the quarantined row appearing ALONGSIDE the decoy.
		await mem.store([
			{ content: 'deploy runbook: signing-key rotation policy is documented (control)', project: projectId }
		]);
		const [r] = await mem.store([{ content: RAW_SECRET, project: projectId }]);
		expect(r.persisted).toBe(true); // written
		expect(r.screenStatus).toBe('quarantined');
		quarantinedId = r.id;

		// WRITTEN for audit: the row exists, AND a memory_history "add" audit row exists.
		const total = await count(`SELECT count() AS c FROM $id GROUP ALL;`, { id: rid(quarantinedId) });
		expect(total).toBe(1);
		const audit = await count(
			`SELECT count() AS c FROM memory_history WHERE memory = $id GROUP ALL;`,
			{ id: rid(quarantinedId) }
		);
		expect(audit).toBeGreaterThanOrEqual(1);

		// Its stored body never carries the raw key material (audit row is safe too).
		const [rows] = await db.query<[Array<{ content: string }>]>(`SELECT content FROM $id;`, {
			id: rid(quarantinedId)
		});
		expect(rows[0].content).not.toContain(SENTINEL);

		// EXCLUDED from the active/persisted SET — the shared active-set + screen filter (§5.3)
		// the readers use. Real excluded-row count: total quarantined rows minus what the
		// active-set query returns.
		const activeSetCount = await count(
			`SELECT count() AS c FROM memory
			   WHERE (status = "active" OR status IS NONE)
			     AND screen_status != "quarantined"
			     AND id = $id GROUP ALL;`,
			{ id: rid(quarantinedId) }
		);
		expect(activeSetCount).toBe(0); // excluded: 1 written, 0 in the active set
	});

	it('Deliverable (2): the RAW secret is NEVER embedded — no §7.1 embedding_cache entry keyed on raw text', async () => {
		// The cache key the engine WOULD have used had it embedded the raw candidate. Because
		// screen-before-embed (store.ts) embeds only the REDACTED text, this key must be absent.
		const rawKey = cacheKey(RAW_SECRET, mem.embedder.modelVersion);
		const rawHits = await count(`SELECT count() AS c FROM embedding_cache WHERE hash = $h GROUP ALL;`, {
			h: rawKey
		});
		expect(rawHits).toBe(0);

		// Defence-in-depth: NO embedding_cache row's hash is computed over any text containing
		// the sentinel is impossible to check directly (hashes are opaque), so we assert the
		// stronger structural fact — the engine never called embed() on a body with the sentinel
		// by confirming the redacted body (what WAS embedded) lacks it, and the redacted key
		// (what SHOULD exist) does. The redacted entry existing proves the row was embedded over
		// SAFE text, not skipped.
		const screenedBody = gateCandidate(RAW_SECRET).screen!.text;
		expect(screenedBody).not.toContain(SENTINEL);
		const redactedKey = cacheKey(screenedBody, mem.embedder.modelVersion);
		const redactedHits = await count(
			`SELECT count() AS c FROM embedding_cache WHERE hash = $h GROUP ALL;`,
			{ h: redactedKey }
		);
		expect(redactedHits).toBe(1); // embedded over the SAFE redacted text — the only entry
	});

	it('Deliverable (3): the quarantined row is NEVER returned by recall()', async () => {
		const res = await mem.recall(RECALL_QUERY, { project: projectId, k: 50, limit: 50 });
		// The decoy (control) should be returned so we know recall is actually working.
		const texts = res.items.map((i) => i.fenced.text).join('\n');
		expect(texts).toContain('(control)');
		// The sentinel must NOT appear in ANY returned fenced block, and the quarantined id
		// must not be among the returned ids.
		expect(texts).not.toContain(SENTINEL);
		expect(res.items.map((i) => i.id)).not.toContain(quarantinedId);
	});

	it('Deliverable (4): the quarantined row is NEVER returned by loadTier0() — even promoted to tier=0', async () => {
		// Adversarial: promote the quarantined row to Tier-0 (operator/curator action). The
		// loadTier0 screen filter must STILL exclude it — membership is not exemption (§6.8/§10).
		await db.query(`UPDATE $id SET tier = 0;`, { id: rid(quarantinedId) });
		// Also promote the clean decoy to Tier-0 so loadTier0 returns something legitimately.
		await db.query(`UPDATE memory SET tier = 0 WHERE string::contains(content, "(control)");`);

		const t0 = await mem.loadTier0(projectId);
		expect(t0.length).toBeGreaterThan(0); // the clean decoy loads
		const t0Text = t0.map((i) => i.text).join('\n');
		expect(t0Text).not.toContain(SENTINEL);
		expect(t0Text).toContain('(control)');

		// Real excluded-row count: tier-0 rows in the DB vs tier-0 rows loadTier0 surfaced.
		const tier0InDb = await count(`SELECT count() AS c FROM memory WHERE tier = 0 GROUP ALL;`);
		const tier0Quarantined = await count(
			`SELECT count() AS c FROM memory WHERE tier = 0 AND screen_status = "quarantined" GROUP ALL;`
		);
		expect(tier0Quarantined).toBeGreaterThanOrEqual(1); // we planted ≥1
		expect(t0.length).toBe(tier0InDb - tier0Quarantined); // exactly the quarantined ones excluded
	});

	it('Deliverable (5): the quarantined row is EXCLUDED from the knowledge-only export surfaces (D-026)', async () => {
		// The realized export-adjacent reads (DATA-MODEL §7b / DECISIONS D-026(b)): the explorer
		// projections that surface/share memory. NONE may carry a quarantined row.
		const global = await listMemories(db, 500);
		expect(global.map((m) => m.id)).not.toContain(quarantinedId);
		expect(global.some((m) => m.content.includes(SENTINEL))).toBe(false);

		const projRows = await listProjectMemories(db, projectId, 500);
		expect(projRows.map((m) => m.id)).not.toContain(quarantinedId);
		expect(projRows.some((m) => m.content.includes(SENTINEL))).toBe(false);

		// The project graph export draws entities only from NON-quarantined memory rows — its
		// entity sub-select excludes the quarantined row, so no quarantined-derived node leaks.
		const graph = await listProjectGraph(db, projectId, 500);
		expect(graph.nodes.some((n) => n.label.includes(SENTINEL))).toBe(false);

		// Real excluded-row count for the export surface: total project rows vs exported rows.
		const totalProjRows = await count(
			`SELECT count() AS c FROM memory WHERE project = $p GROUP ALL;`,
			{ p: rid(projectId) }
		);
		const quarantinedProjRows = await count(
			`SELECT count() AS c FROM memory WHERE project = $p AND screen_status = "quarantined" GROUP ALL;`,
			{ p: rid(projectId) }
		);
		expect(quarantinedProjRows).toBeGreaterThanOrEqual(1);
		expect(projRows.length).toBe(totalProjRows - quarantinedProjRows); // exactly the quarantined excluded
	});

	it('Deliverable (6): the quarantined row NEVER reaches the SOUL — even promoted to a high-importance correction', async () => {
		// Adversarial promotion, same shape as (4): make the quarantined row look like exactly the
		// thing soul.ts reads — an ACTIVE, high-importance `category:"correction"` memory. soul.ts
		// filters with the ALLOW-LIST form (`screen_status = "clean"`), which is strictly stronger
		// than the deny-list; this proves that live, not by grep.
		await db.query(`UPDATE $id SET category = "correction", importance = 0.99, status = "active";`, {
			id: rid(quarantinedId)
		});
		// A CLEAN control correction so the read is demonstrably working (not empty-by-accident).
		await mem.store([
			{
				content: 'correction control: always screen before embed (control)',
				project: projectId,
				category: 'correction',
				importance: 0.9
			}
		]);

		const values = await readLearnedValues(db, 50, projectId);
		const text = values.map((v) => v.text).join('\n');
		expect(text).toContain('(control)'); // the read works
		expect(text).not.toContain(SENTINEL); // no raw key material
		expect(text).not.toContain('leak-probe'); // nor the quarantined row's body at all

		// Real excluded-row count: correction rows in the project vs corrections the soul counts.
		const metrics = await readSoulMetrics(db, projectId);
		const totalCorrections = await count(
			`SELECT count() AS c FROM memory
			   WHERE category = "correction" AND status = "active" AND project = $p GROUP ALL;`,
			{ p: rid(projectId) }
		);
		const quarantinedCorrections = await count(
			`SELECT count() AS c FROM memory
			   WHERE category = "correction" AND status = "active" AND project = $p
			     AND screen_status != "clean" GROUP ALL;`,
			{ p: rid(projectId) }
		);
		expect(quarantinedCorrections).toBeGreaterThanOrEqual(1); // we planted ≥1
		expect(metrics.corrections).toBe(totalCorrections - quarantinedCorrections);
		expect(values.length).toBe(metrics.corrections);
	});

	// ── SHADOW PATHS: nil / empty / error inputs on the quarantine-bearing read paths ──

	it('shadow path (empty store): recall + exports return honest empty on a project with no memory', async () => {
		const empty = await createProject(db, {
			slug: 'qleak_empty',
			name: 'Empty',
			root_path: 'F:/code/qleak-empty'
		});
		try {
			const res = await mem.recall('anything', { project: empty.id, limit: 10 });
			expect(res.items).toEqual([]);
			expect(res.contextText).toBe('');
			expect(await listProjectMemories(db, empty.id, 50)).toEqual([]);
			const g = await listProjectGraph(db, empty.id, 50);
			expect(g).toEqual({ nodes: [], edges: [] });
		} finally {
			await deleteProject(db, empty.id).catch(() => {});
		}
	});

	it('shadow path (nil/empty input to the screen): empty content is dropped, never persisted', async () => {
		const before = await count(`SELECT count() AS c FROM memory GROUP ALL;`);
		const [r] = await mem.store([{ content: '   ', project: projectId }]);
		expect(r.persisted).toBe(false); // DO-NOT-CAPTURE empty
		expect(await count(`SELECT count() AS c FROM memory GROUP ALL;`)).toBe(before);
	});
});
