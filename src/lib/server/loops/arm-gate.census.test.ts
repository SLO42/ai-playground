// PJH-2 (PROJECTS-SPEC §7) — the arm-path caller census + the gate premise, asserted.
//
// The autonomous-loop arm flow is DELIBERATELY asymmetric (spec §3): the UI arm routes through the
// readiness gate `armAutonomousLoop` (loops/arm-gate.ts), while programmatic autonomous-to-v1 arming calls
// `setPmAutonomous(…, true)` directly from ONE chokepoint (create/execute.ts `armAutonomousIfRequested`).
// That asymmetry was intentional but UNASSERTED — nothing stopped a future caller from bare-arming a
// project "because the context is trusted". That is exactly F-055 (a gate bypassed via a NEW call path).
//
// This file makes the premise a test-enforced invariant, in two layers:
//   (a) STATIC CENSUS over the whole production `src/` tree (comment- and string-aware, CRLF-normalized —
//       F-054): the `pm.autonomous` field is written by exactly ONE function (setPmAutonomous, pm-repo.ts),
//       and the ONLY call sites that pass a literal `true` (i.e. ARM) live in the two sanctioned files.
//       Any other arm site — or a non-literal 3rd arg that would evade a literal-true grep — FAILS the
//       census and is named by file:line. A disarm (kill switch, `…, false`) is allowed anywhere (§3: DISARM
//       is never gated). The census functions are PURE over source text, so the synthetic-red cases below
//       prove the census actually catches a bare-arm caller (DoD §8: "red on a synthetic bare-arm caller").
//   (b) BEHAVIORAL, real-surreal: the sanctioned gate `armAutonomousLoop` holds when not ready, records the
//       operator's override decision when taken (consent in the run log), and the kill switch is ungated.
//
// Scope: THIS is a test-only assertion suite. The live census is clean today (arm-gate.ts + create/execute.ts
// are the only arm callers, pm-repo.ts the only writer) — no production code changed. If it ever finds a
// second write/arm path, the failure names the offending file:line and the wave must STOP (F-055).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject } from '../projects/repo';
import { createPm, getPm, setPmAutonomous } from '../projects/pm-repo';
import { armAutonomousLoop, pmAutonomousLoopIdentifier } from './arm-gate';
import { getLoopManifest } from './manifest';

// ── The sanctioned arm surface (spec §3 / PJH-2) ─────────────────────────────────────────────
// The ONLY production files permitted to call `setPmAutonomous(…, true)`. Repo-relative, POSIX slashes.
//   • loops/arm-gate.ts        → armAutonomousLoop (the UI readiness gate)
//   • create/execute.ts        → armAutonomousIfRequested (the autonomous-to-v1 chokepoint, spec §3)
const SANCTIONED_ARM_FILES = new Set<string>([
	'lib/server/loops/arm-gate.ts',
	'lib/server/create/execute.ts'
]);
// The ONLY production files permitted to WRITE the `autonomous` field via SurrealQL.
//   • projects/pm-repo.ts → setPmAutonomous, the single RUNTIME writer (the arm/disarm chokepoint).
//   • db/schema.ts        → the migration DDL layer (m0057 DEFINE FIELD + m0058 `?? false` backfill). This
//     is the canonical, once-at-db:up, deterministic place to define/backfill the field's DEFAULT — it never
//     arms a real project (the backfill coalesces NONE→false), so it is NOT the F-055 "new call path" concern
//     (that is about RUNTIME code arming a project). Excluding it here would just force migrations elsewhere.
const SANCTIONED_WRITER_FILES = new Set<string>([
	'lib/server/projects/pm-repo.ts',
	'lib/server/db/schema.ts'
]);

const SRC_ROOT = fileURLToPath(new URL('../../../', import.meta.url)); // …/src

interface SourceFile {
	rel: string; // repo-relative from src/, POSIX slashes (e.g. "lib/server/loops/arm-gate.ts")
	text: string; // CRLF-normalized (F-054)
}

// ── Source loader: every production .ts/.svelte under src/, excluding tests/decls ────────────
function walkSources(dir: string, out: SourceFile[]): void {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === 'node_modules' || entry.name === '.svelte-kit') continue;
			walkSources(full, out);
			continue;
		}
		if (!/\.(ts|svelte)$/.test(entry.name)) continue;
		if (/\.(test|spec)\./.test(entry.name)) continue; // never census test files
		if (entry.name.endsWith('.d.ts')) continue;
		const text = readFileSync(full, 'utf8').replace(/\r\n/g, '\n'); // F-054: normalize EOL before scanning
		out.push({ rel: path.relative(SRC_ROOT, full).split(path.sep).join('/'), text });
	}
}

function loadProductionSources(): SourceFile[] {
	const out: SourceFile[] = [];
	walkSources(SRC_ROOT, out);
	return out;
}

// ── Comment/string-aware skeletonizer (preserves line layout so line numbers stay exact) ─────
// blankStrings=true blanks string CONTENT too (for scanning code — a call token can never live in a string);
// blankStrings=false preserves string content (for scanning embedded SurrealQL, which lives in template
// literals). Comments are always blanked. Newlines/tabs are preserved verbatim in every state.
function skeletonize(src: string, blankStrings: boolean): string {
	const out: string[] = [];
	const n = src.length;
	type State = 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl';
	let state: State = 'code';
	let i = 0;
	const layout = (c: string) => (c === '\n' ? '\n' : c === '\t' ? '\t' : ' ');
	while (i < n) {
		const c = src[i];
		const c2 = i + 1 < n ? src[i + 1] : '';
		if (state === 'code') {
			if (c === '/' && c2 === '/') { out.push('  '); i += 2; state = 'line'; continue; }
			if (c === '/' && c2 === '*') { out.push('  '); i += 2; state = 'block'; continue; }
			if (c === "'") { out.push(c); i++; state = 'sq'; continue; }
			if (c === '"') { out.push(c); i++; state = 'dq'; continue; }
			if (c === '`') { out.push(c); i++; state = 'tpl'; continue; }
			out.push(c); i++; continue;
		}
		if (state === 'line') {
			if (c === '\n') { out.push('\n'); i++; state = 'code'; continue; }
			out.push(layout(c)); i++; continue;
		}
		if (state === 'block') {
			if (c === '*' && c2 === '/') { out.push('  '); i += 2; state = 'code'; continue; }
			out.push(layout(c)); i++; continue;
		}
		// string states (sq/dq/tpl): honor escapes; keep or blank content per blankStrings; keep layout.
		if (c === '\\') {
			out.push(blankStrings ? '  ' : c + (i + 1 < n ? src[i + 1] : ''));
			i += 2;
			continue;
		}
		const closes =
			(state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'tpl' && c === '`');
		if (closes) {
			out.push(c);
			state = 'code';
			i++;
			continue;
		}
		out.push(blankStrings ? layout(c) : c);
		i++;
	}
	return out.join('');
}

function lineOf(text: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++;
	return line;
}

// Extract the substring between the '(' at openIdx and its matching ')'. Strings are already blanked in the
// code skeleton, so a naive paren-depth walk is exact. Returns null if unbalanced.
function balancedArgs(text: string, openIdx: number): string | null {
	let depth = 0;
	for (let i = openIdx; i < text.length; i++) {
		const c = text[i];
		if (c === '(') depth++;
		else if (c === ')') {
			depth--;
			if (depth === 0) return text.slice(openIdx + 1, i);
		}
	}
	return null;
}

// Split an argument list on TOP-LEVEL commas (ignoring commas nested in (), [], {}).
function splitTopLevelArgs(args: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let cur = '';
	for (const c of args) {
		if (c === '(' || c === '[' || c === '{') { depth++; cur += c; }
		else if (c === ')' || c === ']' || c === '}') { depth--; cur += c; }
		else if (c === ',' && depth === 0) { parts.push(cur); cur = ''; }
		else cur += c;
	}
	if (cur.trim().length > 0 || parts.length > 0) parts.push(cur);
	return parts;
}

interface ArmCall {
	line: number;
	lastArg: string; // the trimmed final argument ('true' | 'false' | anything dynamic)
}

// Find every CALL to setPmAutonomous (not the definition) in a code skeleton, with its 3rd/last argument.
function findAutonomousCalls(codeSkeleton: string): ArmCall[] {
	const calls: ArmCall[] = [];
	const re = /\bsetPmAutonomous\s*\(/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(codeSkeleton)) !== null) {
		const idx = m.index;
		// Skip the function DEFINITION (`function setPmAutonomous(`), only census actual call sites.
		if (/function\s+$/.test(codeSkeleton.slice(Math.max(0, idx - 24), idx))) continue;
		const openParen = idx + m[0].length - 1;
		const args = balancedArgs(codeSkeleton, openParen);
		if (args === null) continue;
		const parts = splitTopLevelArgs(args);
		const lastArg = parts.length ? parts[parts.length - 1].trim() : '';
		calls.push({ line: lineOf(codeSkeleton, idx), lastArg });
	}
	return calls;
}

interface Violation {
	path: string;
	line: number;
	detail: string;
}

// CENSUS (a1): every arm call site (`setPmAutonomous(…, true)`) must live in a sanctioned file; a non-literal
// final arg is itself a violation (it could be `true` at runtime and would evade a literal-`true` grep).
function censusArmCallers(
	files: SourceFile[],
	sanctioned: Set<string>
): { violations: Violation[]; armSitePaths: Set<string> } {
	const violations: Violation[] = [];
	const armSitePaths = new Set<string>();
	for (const f of files) {
		const skeleton = skeletonize(f.text, /* blankStrings */ true);
		for (const call of findAutonomousCalls(skeleton)) {
			if (call.lastArg === 'false') continue; // disarm / kill switch — never gated (§3), allowed anywhere
			if (call.lastArg === 'true') {
				armSitePaths.add(f.rel);
				if (!sanctioned.has(f.rel)) {
					violations.push({
						path: f.rel,
						line: call.line,
						detail: 'bare arm: setPmAutonomous(…, true) outside a sanctioned arm function — route through armAutonomousLoop or carry your own recorded-consent check (F-055 / PJH-2)'
					});
				}
			} else {
				violations.push({
					path: f.rel,
					line: call.line,
					detail: `non-literal arm argument '${call.lastArg}' evades the literal-true census — pass a boolean literal or route through armAutonomousLoop`
				});
			}
		}
	}
	return { violations, armSitePaths };
}

// CENSUS (a2): the `autonomous` field may be WRITTEN via SurrealQL only inside the single writer (pm-repo.ts).
// Catches a raw MERGE/SET/UPDATE/CONTENT that would bypass setPmAutonomous entirely (the F-055 shape).
function censusFieldWriters(files: SourceFile[], sanctionedWriters: Set<string>): Violation[] {
	const violations: Violation[] = [];
	const writeRe =
		/MERGE\s*\{[^}]*\bautonomous\b|\bSET\s+autonomous\b|UPDATE\b[^;`]*\bautonomous\s*=|CONTENT\s*\{[^}]*\bautonomous\b/g;
	for (const f of files) {
		if (sanctionedWriters.has(f.rel)) continue; // pm-repo.ts (runtime) + schema.ts (migration DDL/backfill)
		// Preserve string content (SurrealQL lives in template literals) but strip comments.
		const skeleton = skeletonize(f.text, /* blankStrings */ false);
		let m: RegExpExecArray | null;
		writeRe.lastIndex = 0;
		while ((m = writeRe.exec(skeleton)) !== null) {
			violations.push({
				path: f.rel,
				line: lineOf(skeleton, m.index),
				detail: `raw write of the 'autonomous' field ("${m[0].slice(0, 40)}…") outside the single writer setPmAutonomous (pm-repo.ts) — bypasses the arm chokepoint (F-055)`
			});
		}
	}
	return violations;
}

function fmt(v: Violation[]): string {
	return v.map((x) => `  ${x.path}:${x.line} — ${x.detail}`).join('\n');
}

// ── (a) STATIC CENSUS over the real production tree ──────────────────────────────────────────
describe('PJH-2 arm-path census — static assertion over production src/ (F-055)', () => {
	it('the ONLY files that arm (setPmAutonomous(…, true)) are the sanctioned arm callers', () => {
		const files = loadProductionSources();
		expect(files.length).toBeGreaterThan(50); // sanity: the tree actually loaded
		const { violations, armSitePaths } = censusArmCallers(files, SANCTIONED_ARM_FILES);
		expect(violations, `unsanctioned / non-literal arm call sites:\n${fmt(violations)}`).toEqual([]);
		// Every arm site is a subset of the sanctioned set (the security invariant).
		for (const p of armSitePaths) expect(SANCTIONED_ARM_FILES.has(p)).toBe(true);
		// …and the census is NOT vacuously green: both sanctioned arm callers are actually present in the tree.
		for (const s of SANCTIONED_ARM_FILES) {
			expect(armSitePaths.has(s), `expected a live arm call in ${s} — did the arm path move?`).toBe(true);
		}
	});

	it("the 'autonomous' field is written ONLY by setPmAutonomous (single writer, pm-repo.ts)", () => {
		const files = loadProductionSources();
		const violations = censusFieldWriters(files, SANCTIONED_WRITER_FILES);
		expect(violations, `raw autonomous-field writes bypassing the single writer:\n${fmt(violations)}`).toEqual(
			[]
		);
	});
});

// ── (a) CENSUS UNIT PROOFS — the scanner is red on a synthetic bare-arm caller (DoD §8) ──────
describe('PJH-2 census scanner — proven to catch a bypass (synthetic inputs)', () => {
	const src = (rel: string, text: string): SourceFile => ({ rel, text });

	it('RED: a bare setPmAutonomous(…, true) in an unsanctioned file is named by file:line', () => {
		const files = [src('lib/server/evil.ts', 'export async function x(db, id) {\n\tawait setPmAutonomous(db, id, true);\n}\n')];
		const { violations } = censusArmCallers(files, SANCTIONED_ARM_FILES);
		expect(violations.length).toBe(1);
		expect(violations[0].path).toBe('lib/server/evil.ts');
		expect(violations[0].line).toBe(2); // exact line of the bare arm
		expect(violations[0].detail).toMatch(/bare arm/);
	});

	it('GREEN: the same arm inside a sanctioned file passes', () => {
		const files = [src('lib/server/loops/arm-gate.ts', 'await setPmAutonomous(db, id, true);')];
		const { violations, armSitePaths } = censusArmCallers(files, SANCTIONED_ARM_FILES);
		expect(violations).toEqual([]);
		expect(armSitePaths.has('lib/server/loops/arm-gate.ts')).toBe(true);
	});

	it('GREEN: a DISARM (…, false) is a kill switch — allowed in ANY file (never gated, §3)', () => {
		const files = [src('lib/server/routes/whatever.ts', 'await setPmAutonomous(db, id, false);')];
		const { violations } = censusArmCallers(files, SANCTIONED_ARM_FILES);
		expect(violations).toEqual([]);
	});

	it('RED: a non-literal 3rd arg (could be true at runtime) is flagged — it evades a literal-true grep', () => {
		const files = [src('lib/server/evil.ts', 'const flag = true;\nawait setPmAutonomous(db, id, flag);')];
		const { violations } = censusArmCallers(files, SANCTIONED_ARM_FILES);
		expect(violations.length).toBe(1);
		expect(violations[0].line).toBe(2);
		expect(violations[0].detail).toMatch(/non-literal/);
	});

	it('IGNORES a mention inside a // line comment (not a real call)', () => {
		const files = [src('lib/server/x.ts', '// call setPmAutonomous(db, id, true) here one day\nconst y = 1;')];
		const { violations } = censusArmCallers(files, SANCTIONED_ARM_FILES);
		expect(violations).toEqual([]);
	});

	it('IGNORES a mention inside a /* block */ comment', () => {
		const files = [src('lib/server/x.ts', '/*\n * do NOT do setPmAutonomous(db, id, true)\n */\nconst y = 1;')];
		const { violations } = censusArmCallers(files, SANCTIONED_ARM_FILES);
		expect(violations).toEqual([]);
	});

	it('IGNORES a mention inside a string literal (not executable)', () => {
		const files = [src('lib/server/x.ts', 'const msg = "setPmAutonomous(db, id, true)";')];
		const { violations } = censusArmCallers(files, SANCTIONED_ARM_FILES);
		expect(violations).toEqual([]);
	});

	it("IGNORES the function DEFINITION itself (`function setPmAutonomous(`)", () => {
		const files = [
			src('lib/server/projects/pm-repo.ts', 'export async function setPmAutonomous(db, id, autonomous) {\n\treturn autonomous;\n}')
		];
		const { violations, armSitePaths } = censusArmCallers(files, SANCTIONED_ARM_FILES);
		expect(violations).toEqual([]);
		expect(armSitePaths.size).toBe(0); // a definition is not a call site
	});

	it('RED: a raw MERGE write of the autonomous field outside pm-repo.ts is caught by the field-writer census', () => {
		const files = [
			src('lib/server/evil.ts', 'await db.query(`UPDATE $r MERGE { autonomous: true } RETURN AFTER;`);')
		];
		const violations = censusFieldWriters(files, SANCTIONED_WRITER_FILES);
		expect(violations.length).toBe(1);
		expect(violations[0].path).toBe('lib/server/evil.ts');
		expect(violations[0].detail).toMatch(/raw write of the 'autonomous' field/);
	});

	it('GREEN: the single writer (pm-repo.ts) MERGE-ing the field is allowed', () => {
		const files = [
			src('lib/server/projects/pm-repo.ts', 'await db.query(`UPDATE $rid MERGE { autonomous: $autonomous } RETURN AFTER;`);')
		];
		expect(censusFieldWriters(files, SANCTIONED_WRITER_FILES)).toEqual([]);
	});

	it('field-writer census IGNORES a write mentioned only in a comment', () => {
		const files = [src('lib/server/evil.ts', '// UPDATE $r MERGE { autonomous: true } — example, not code\nconst y = 1;')];
		expect(censusFieldWriters(files, SANCTIONED_WRITER_FILES)).toEqual([]);
	});
});

// ── (b) BEHAVIORAL — the sanctioned gate is the only CONSENTED arm path (real SurrealDB) ─────
describe('PJH-2 premise (behavioral): armAutonomousLoop is the gated arm path; disarm is ungated', () => {
	let tdb: TestDb;
	let db: Db;
	let n = 0;

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
	}, 90_000);

	afterAll(async () => {
		await db?.close().catch(() => {});
		await tdb?.teardown();
	});

	async function freshProjectWithPm(): Promise<string> {
		const slug = `pjh2_${++n}_${Date.now()}`;
		const project = await createProject(db, { slug, name: `PJH2 ${n}`, root_path: `F:/code/${slug}` });
		await createPm(db, { project: project.id, name: `PM ${n}`, persona: 'PM' });
		return project.id;
	}

	it('the gate HOLDS: a not-ready loop with no override is NOT armed', async () => {
		const projectId = await freshProjectWithPm();
		const res = await armAutonomousLoop(db, projectId);
		expect(res.ok).toBe(false);
		if (res.ok === false) expect(res.reason).toBe('not-ready');
		expect((await getPm(db, projectId))?.autonomous).toBe(false);
	}, 60_000);

	it('the sanctioned path RECORDS the operator override decision, then arms (consent in the run log)', async () => {
		const projectId = await freshProjectWithPm();
		const res = await armAutonomousLoop(db, projectId, { override: true, overrideReason: 'launch window' });
		expect(res.ok).toBe(true);
		if (res.ok) {
			expect(res.autonomous).toBe(true);
			expect(res.overridden).toBe(true);
		}
		// The override decision (consent) is persisted BEFORE the arm — it is in the manifest run log.
		const row = await getLoopManifest(db, pmAutonomousLoopIdentifier(projectId));
		expect(row?.override).toBe(true);
		expect(row?.overrideReason).toBe('launch window');
		// And the field flipped through the single writer.
		expect((await getPm(db, projectId))?.autonomous).toBe(true);
	}, 60_000);

	it('the kill switch is UNGATED: setPmAutonomous(…, false) always disarms (§3)', async () => {
		const projectId = await freshProjectWithPm();
		await armAutonomousLoop(db, projectId, { override: true });
		expect((await getPm(db, projectId))?.autonomous).toBe(true);
		const disarmed = await setPmAutonomous(db, projectId, false); // disarm needs no gate, no override
		expect(disarmed?.autonomous).toBe(false);
		expect((await getPm(db, projectId))?.autonomous).toBe(false);
	}, 60_000);
});
