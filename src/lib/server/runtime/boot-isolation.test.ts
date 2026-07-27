// BOOT ISOLATION — `src/hooks.server.ts` carries a top-level, EAGER side effect:
//
//     export const startup: Promise<DbInitResult> = bootstrap();
//
// Importing that module therefore RUNS THE WHOLE SERVER BOOT at import time: the D-025
// loopback assertion + per-boot token, `initDbFromEnv` against the DEV database, the live
// table watchers, the boot reaper, and the m0086 boot-ledger write. Under SvelteKit that is
// correct and invisible (the boot happens regardless). Under `vitest` it is a lifecycle
// defect: a test that imports a route module for its `load`/`actions` transitively boots the
// real server, which CLAIMS the process-wide `Db` singleton — and then the test's own
// `initDb(testDb)` throws `Db singleton already initialised — call closeDb() first` at FILE
// level, before a single test runs.
//
// That is exactly what happened. `/projects/[id]/+page.server.ts` and `/settings/+page.server.ts`
// imported the pure accessor `activeOrchestrator` FROM hooks.server, and three suites
// (loops-tab.live, pm-autonomous-action, pm-fit-verdict-action — 22 tests) died at file level,
// deterministically, in isolation. The boot also wrote to the LIVE dev DB from a test run.
//
// The fix was reuse, not a new indirection: a side-effect-free registry
// (`setActiveOrchestrator`/`activeOrchestrator` in `$lib/server/orchestrator`, populated by
// boot.ts) already existed for precisely this reason — its own header says "without importing
// hooks.server.ts (circularity)".
//
// These guards keep it fixed. They are STRUCTURAL (they fail on the pattern, not on the
// symptom), so the singleton crash cannot silently return via a new import.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = fileURLToPath(new URL('../../..', import.meta.url)); // → src/
const HOOKS_PATH = join(SRC_DIR, 'hooks.server.ts');

/** Recursively list .ts/.svelte sources under a dir. */
function listSourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...listSourceFiles(full));
		else if (/\.(ts|svelte)$/.test(entry.name)) out.push(full);
	}
	return out;
}

/** Read a source with EOLs normalized — the Edit tool flips LF→CRLF on Windows (F-054). */
function readSrc(path: string): string {
	return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

/**
 * Every `import … from '<spec>'` (static) plus `import('<spec>')` (dynamic) in a source.
 * Deliberately syntactic: a would-be evader has to change the import syntax itself, which
 * is far more visible in review than adding one more name to an existing import list.
 */
function importSpecifiers(src: string): string[] {
	const out: string[] = [];
	for (const m of src.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) out.push(m[1]);
	for (const m of src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]);
	return out;
}

/** Does this specifier resolve to src/hooks.server(.ts)? */
function isHooksServer(spec: string): boolean {
	return /(^|\/)hooks\.server(\.ts)?$/.test(spec);
}

// The ONLY module allowed to import hooks.server, and why: the SSE endpoint awaits the
// `startup` promise so it can report the honest DB state to a connecting client. It WANTS
// the boot — that is the entire point of the import. Any addition here is a deliberate,
// reviewed decision, not an accident.
const ALLOWED_HOOKS_IMPORTERS = new Set(['routes/api/events/+server.ts']);

function relFromSrc(path: string): string {
	return path.slice(SRC_DIR.length).replace(/\\/g, '/').replace(/^\//, '');
}

describe('boot isolation — hooks.server.ts must not be imported for a pure accessor', () => {
	it('the eager top-level boot this guards is actually still there (the guard has a premise)', () => {
		const src = readSrc(HOOKS_PATH);
		// If bootstrap() ever stops running at module scope, these guards become theatre —
		// fail loudly so the next author re-derives the rule instead of trusting a dead test.
		expect(src).toMatch(/export const startup[^\n]*=\s*bootstrap\(\)/);
	});

	it('hooks.server.ts does NOT export an `activeOrchestrator` accessor (one registry, not two)', () => {
		const src = readSrc(HOOKS_PATH);
		expect(src).not.toMatch(/^export\s+(function\s+activeOrchestrator|\{[^}]*\bactiveOrchestrator\b)/m);
	});

	it('the canonical registry is side-effect-free — importing it boots nothing', async () => {
		// A real import, not a source scan: if `$lib/server/orchestrator` ever grew a boot side
		// effect, this import would connect a DB / start a timer. It resolves to a null handle
		// on a cold process, which is the honest degraded-boot answer (F-008).
		const { activeOrchestrator } = await import('$lib/server/orchestrator');
		expect(activeOrchestrator()).toBeNull();
	});

	it('no route or component imports hooks.server outside the reviewed allow-list', () => {
		const files = [
			...listSourceFiles(join(SRC_DIR, 'routes')),
			...listSourceFiles(join(SRC_DIR, 'lib'))
		];
		const offenders = files
			.filter((f) => !/\.(test|spec)\.ts$/.test(f))
			.filter((f) => importSpecifiers(readSrc(f)).some(isHooksServer))
			.map(relFromSrc)
			.filter((rel) => !ALLOWED_HOOKS_IMPORTERS.has(rel));
		expect(offenders).toEqual([]);
	});

	it('the allow-list is not stale — every entry exists and really does import hooks.server', () => {
		// An allow-list that outlives its entries silently widens the exemption. Shadow path:
		// a renamed/deleted file must fail here, not quietly grant future cover.
		for (const rel of ALLOWED_HOOKS_IMPORTERS) {
			const src = readSrc(join(SRC_DIR, rel));
			expect(importSpecifiers(src).some(isHooksServer), `${rel} no longer imports hooks.server`).toBe(
				true
			);
		}
	});
});
