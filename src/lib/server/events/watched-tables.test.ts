// TASK 13.1 — WATCHED_TABLES completeness (ARCHITECTURE §2.11).
//
// The 13.1 finding: hooks.server.ts watched only 14 tables while routes registered
// onDbChange handlers for tables NOT in the list (workflow_run, target_run,
// project_target, memory/entity/references, sync tables, pm_review, workflow) — those
// surfaces could NEVER live-update; the release page even documented live step_state
// updates that could not fire.
//
// Guards here:
//  1. STATIC SCAN — parse every route/component source for the table names passed to
//     `onDbChange(…)` (string literals AND the `[…].map((t) => onDbChange(t, …))`
//     pattern) and assert WATCHED_TABLES is a superset. A future route subscribing to
//     an unwatched table fails the suite. Dynamic call sites the scanner cannot
//     resolve also fail — so a new indirection pattern must extend the scanner, not
//     silently escape the audit.
//  2. SCHEMA — every WATCHED_TABLES entry is DEFINEd in schema.ts, so the boot
//     live-query loop cannot fail on a missing table.
//  3. LIVE (real SurrealDB) — the bootstrap-shaped loop (one watchTable per
//     WATCHED_TABLES entry) opens cleanly on the FULL migrated schema, and a
//     workflow_run row change (the finding's table) actually reaches the bus.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Db } from '../db/client';
import { startTestDb } from '../db/testserver';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { EventBus, type BusEvent } from './bus';
import { watchTable, type DbSourceHandle } from './db-source';
import { WATCHED_TABLES } from './watched-tables';

const SRC_DIR = fileURLToPath(new URL('../../..', import.meta.url)); // → src/
const SCAN_DIRS = [join(SRC_DIR, 'routes'), join(SRC_DIR, 'lib', 'components')];
const SCHEMA_PATH = join(SRC_DIR, 'lib', 'server', 'db', 'schema.ts');

/** Recursively list .svelte/.ts files (skip tests — they aren't UI subscribers). */
function listSourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...listSourceFiles(full));
		else if (/\.(svelte|ts)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) out.push(full);
	}
	return out;
}

interface ScanResult {
	/** Every statically-resolved table name passed to onDbChange. */
	tables: Set<string>;
	/** Call sites whose table arg could not be resolved: `file: arg`. */
	unresolved: string[];
	/** Total onDbChange call sites seen. */
	callSites: number;
}

/** Scan one file's source for onDbChange table names. Handles the literal form
 *  `onDbChange('table', …)` and the layout's `['a','b'].map((t) => …onDbChange(t, …))`. */
function scanFile(file: string, acc: ScanResult): void {
	const src = readFileSync(file, 'utf8');
	const callRe = /\bonDbChange\(\s*('([a-z0-9_]+)'|[A-Za-z_$][\w$]*)/g;
	for (const m of src.matchAll(callRe)) {
		acc.callSites += 1;
		if (m[2]) {
			acc.tables.add(m[2]); // string-literal arg
			continue;
		}
		// Identifier arg — resolve the `[ 'a', 'b' ].map((ident) => …` source array.
		const ident = m[1];
		const mapRe = new RegExp(
			String.raw`\[((?:\s*'[a-z0-9_]+'\s*,?)+)\]\s*\.map\(\s*\(?\s*` + ident + String.raw`\s*\)?\s*=>`
		);
		const arr = src.match(mapRe);
		if (!arr) {
			acc.unresolved.push(`${file}: onDbChange(${ident}, …)`);
			continue;
		}
		for (const lit of arr[1].matchAll(/'([a-z0-9_]+)'/g)) acc.tables.add(lit[1]);
	}
}

function scanRoutes(): ScanResult {
	const acc: ScanResult = { tables: new Set(), unresolved: [], callSites: 0 };
	for (const dir of SCAN_DIRS) for (const file of listSourceFiles(dir)) scanFile(file, acc);
	return acc;
}

describe('WATCHED_TABLES covers every route onDbChange subscription (13.1)', () => {
	const scan = scanRoutes();

	it('scanner actually finds the route subscriptions (self-check)', () => {
		// Guard against regex rot silently matching nothing: the home page subscribes to
		// 'project' (literal form) and the shell layout uses the array-map form for
		// 'notification'; the finding's table 'workflow_run' is subscribed on two routes.
		expect(scan.callSites).toBeGreaterThan(10);
		expect(scan.tables.has('project')).toBe(true);
		expect(scan.tables.has('notification')).toBe(true);
		expect(scan.tables.has('workflow_run')).toBe(true);
	});

	it('every onDbChange call site is statically resolvable', () => {
		// A dynamic subscription the scanner cannot resolve would escape the superset
		// audit — extend scanFile() for the new pattern instead of ignoring it.
		expect(scan.unresolved).toEqual([]);
	});

	it('WATCHED_TABLES is a superset of every subscribed table', () => {
		const watched = new Set<string>(WATCHED_TABLES);
		const missing = [...scan.tables].filter((t) => !watched.has(t)).sort();
		// FAILS without the 13.1 fix: workflow, workflow_run, memory, entity, references,
		// project_target, target_run, sync_incident, board_sync_config, pm_review were
		// all subscribed by routes but absent from the watched list.
		expect(missing).toEqual([]);
	});

	it('WATCHED_TABLES has no duplicates', () => {
		expect(new Set(WATCHED_TABLES).size).toBe(WATCHED_TABLES.length);
	});

	it('every watched table is DEFINEd in schema.ts (boot live query cannot 404)', () => {
		const schemaSrc = readFileSync(SCHEMA_PATH, 'utf8');
		const defined = new Set(
			[...schemaSrc.matchAll(/DEFINE TABLE (?:OVERWRITE )?([a-z_][a-z0-9_]*)/g)].map((m) => m[1])
		);
		const undefinedTables = WATCHED_TABLES.filter((t) => !defined.has(t));
		expect(undefinedTables).toEqual([]);
	});
});

describe('live-query bootstrap handles the full watched set (real SurrealDB)', () => {
	it(
		'opens a live query per watched table and a workflow_run change reaches the bus',
		async () => {
			const tdb = await startTestDb();
			const watchers: DbSourceHandle[] = [];
			let db: Db | undefined;
			try {
				db = await Db.connect({
					url: tdb.wsUrl,
					username: tdb.root.username,
					password: tdb.root.password,
					namespace: tdb.namespace,
					database: tdb.database
				});
				await runMigrations(db, schemaMigrations);

				// Mirror the hooks.server.ts bootstrap loop EXACTLY — but fail loud (no
				// try/catch): every watched table must accept a live query on the real schema.
				const bus = new EventBus();
				for (const table of WATCHED_TABLES) {
					watchers.push(await watchTable(db, bus, table));
				}
				expect(watchers.map((w) => w.table)).toEqual([...WATCHED_TABLES]);

				// The finding's concrete symptom: a workflow_run change must now reach the bus
				// (release/workflows pages re-invalidate off this topic). FAILS without the fix.
				const seen: BusEvent[] = [];
				bus.subscribe((e) => {
					if (e.type === 'db_change' && e.topic === 'workflow_run') seen.push(e);
				});
				const wfRows = await db.query<[{ id: unknown }[]]>(
					`CREATE workflow SET name = '13.1 regression', steps = [] RETURN id;`
				);
				await db.query(`CREATE workflow_run SET workflow = $wf, step_state = { build: 'running' };`, {
					wf: wfRows[0][0].id
				});
				const start = Date.now();
				while (seen.length === 0) {
					if (Date.now() - start > 8000) throw new Error('timeout: workflow_run change never hit the bus');
					await new Promise((r) => setTimeout(r, 50));
				}
				expect(seen[0].topic).toBe('workflow_run');
			} finally {
				for (const w of watchers) await w.stop().catch(() => {});
				await db?.close().catch(() => {});
				await tdb.teardown();
			}
		},
		90_000
	);
});
