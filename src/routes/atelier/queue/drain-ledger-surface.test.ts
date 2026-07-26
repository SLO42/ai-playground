/* ============================================================================
   COMPLETION-LEDGER Wave A — the DRAIN LEDGER SURFACE on /atelier/queue.

   Recording a fault is only half a fix: "adding a row that nothing renders" is
   exactly the failure mode this wave exists to close. This suite locks the OTHER
   half — that the ledger is actually REACHABLE, actually RENDERED, honest when
   empty, and readable (contrast + never colour-only).

   Three groups:
     (1) LOADER — the real `load` returns the ledger as devalue-safe POJOs, with
         honest empties on the disconnected path (F-008 / F-013 devalue-500 class).
     (2) MARKUP — the panel exists, has an honest empty state, is keyboard-operable,
         and the live subscription covers agent_event (without it a new fault stays
         invisible until the next navigation).
     (3) TOKENS — every tone badge sits on --color-surface-overlay and therefore
         draws its TEXT from the *-on-overlay ramp, measured ≥ BODY AA. This is the
         AV-1 defect class this repo already paid for once (a 3.50:1 badge).
   ============================================================================ */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as devalue from 'devalue';
import { Db, initDb, closeDb } from '$lib/server/db/client';
import { runMigrations } from '$lib/server/db/migrate';
import { schemaMigrations } from '$lib/server/db/schema';
import { startTestDb, type TestDb } from '$lib/server/db/testserver';
import { recordDrainFault, recordQueueHold, __resetParkThrottle } from '$lib/server/orchestrator/drain-events';
import {
	AA_BODY,
	AA_LARGE,
	contrastRatio,
	loadColorTokens,
	resolveToHex
} from '$lib/styles/tokens/contrast-gate';
import { load, type QueueData } from './+page.server';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(HERE, '+page.svelte'), 'utf8');
/** Comments carry token names in prose; strip them so they can't satisfy a regex. */
const css = src.replace(/\/\*[\s\S]*?\*\//g, '');
/** Same for the markup: an HTML comment explaining a defect must not satisfy an assertion
 *  that the defect's wording is GONE (it quotes the old wording verbatim). */
const markup = src.replace(/<!--[\s\S]*?-->/g, '');
/** The /atelier index — the nav parent this page must stay linked from (no orphan routes). */
const atelierIndex = readFileSync(join(HERE, '..', '+page.svelte'), 'utf8');

// ── (1) LOADER ───────────────────────────────────────────────────────────────────────────

let tdb: TestDb | undefined;
let db: Db | undefined;
let available = false;
/** True ONLY when THIS suite created the process-wide runtime singleton (see the sibling
 *  workspace-render-smoke guard): under full-suite concurrency another route test may already
 *  hold it, in which case we skip honestly and must NOT closeDb() a singleton we do not own. */
let ownsSingleton = false;

beforeAll(async () => {
	try {
		tdb = await startTestDb();
		db = await Db.connect({
			url: tdb.wsUrl,
			username: tdb.root.username,
			password: tdb.root.password,
			namespace: tdb.namespace,
			database: tdb.database
		});
		await runMigrations(db, schemaMigrations);
		await db.close();
		db = await initDb({
			url: tdb.wsUrl,
			username: tdb.root.username,
			password: tdb.root.password,
			namespace: tdb.namespace,
			database: tdb.database
		});
		ownsSingleton = true;
		available = true;
	} catch {
		available = false; // honest skip — never a faked artifact
	}
}, 120_000);

afterAll(async () => {
	if (ownsSingleton) await closeDb().catch(() => {});
	await tdb?.teardown();
});

/** Invoke the REAL load with the minimal event shape it reads. */
function runLoad(search = ''): Promise<QueueData> {
	return load({
		url: new URL(`http://127.0.0.1/atelier/queue${search}`),
		depends: () => {}
	} as never) as Promise<QueueData>;
}

describe('/atelier/queue load — the drain ledger reaches the page', () => {
	it('an EMPTY ledger loads honestly: [] + zero counts, never a fabricated row', async () => {
		if (!available) return;
		await db!.query(`DELETE agent_event;`);
		__resetParkThrottle();
		const data = await runLoad();
		expect(data.connected).toBe(true);
		expect(data.ledger).toEqual([]);
		expect(data.ledgerCounts.faults).toBe(0);
		expect(data.ledgerCounts.parks).toBe(0);
	});

	it('a recorded fault + hold reach the page payload with their how/why intact', async () => {
		if (!available) return;
		await db!.query(`DELETE agent_event;`);
		__resetParkThrottle();
		await recordDrainFault(db!, {
			stage: 'post_task',
			error: new Error('git commit failed: nothing to commit'),
			taskId: 'task:surface1',
			absorbed: true
		});
		await recordQueueHold(db!, { phase: 'parked', reason: 'concurrency', pendingDepth: 4 });

		const data = await runLoad();
		expect(data.ledger).toHaveLength(2);
		expect(data.ledgerCounts.faults).toBe(1);
		expect(data.ledgerCounts.parks).toBe(1);

		const fault = data.ledger.find((r) => r.entry === 'fault')!;
		expect(fault.stageLabel).toBe('committing and testing after the run');
		expect(fault.message).toContain('nothing to commit');
		const hold = data.ledger.find((r) => r.entry === 'hold')!;
		expect(hold.message).toContain('all agent slots are busy');
		expect(hold.pendingDepth).toBe(4);
	});

	it('the payload is devalue-safe POJOs — no raw SDK datetime leaks a 500 (F-013)', async () => {
		if (!available) return;
		await db!.query(`DELETE agent_event;`);
		__resetParkThrottle();
		await recordDrainFault(db!, { stage: 'claim', error: new Error('x'), absorbed: true });
		const data = await runLoad();
		// devalue.stringify is the SvelteKit load serializer — it THROWS on a Datetime/RecordId leak.
		expect(() => devalue.stringify(data)).not.toThrow();
		expect(JSON.stringify(data.ledger)).not.toContain('undefined');
	});

	it('a bad ?before= cursor still yields an honest page (the ledger reads do not throw on it)', async () => {
		if (!available) return;
		const data = await runLoad('?before=2024-99-99T00:00:00.000Z');
		expect(data.connected).toBe(true);
		expect(Array.isArray(data.ledger)).toBe(true);
	});
});

// ── (2) MARKUP ───────────────────────────────────────────────────────────────────────────

describe('the ledger panel is rendered, honest and reachable', () => {
	it('is REACHABLE — /atelier links to /atelier/queue (no orphan route)', () => {
		expect(atelierIndex).toContain('/atelier/queue');
	});

	it('renders a ledger list bound to the loaded rows', () => {
		expect(/aria-label="drain ledger"/.test(src)).toBe(true);
		expect(/\{#each shownLedger as row \(row\.id\)\}/.test(src)).toBe(true);
	});

	it('has an HONEST empty state that says what WOULD appear, not a blank card (F-008)', () => {
		expect(/\{#if ledger\.length === 0\}/.test(src)).toBe(true);
		expect(src).toContain('Nothing recorded.');
		// It must promise the real content, so an operator can trust the silence.
		expect(/named here with the step, the task, and the real reason/.test(src)).toBe(true);
	});

	it('distinguishes an empty LEDGER from an empty FILTER (never the same misleading message)', () => {
		expect(/\{:else if shownLedger\.length === 0\}/.test(src)).toBe(true);
	});

	it('subscribes to agent_event — without it a new fault stays invisible until a navigation', () => {
		expect(/stream\.onDbChange\('agent_event'/.test(src)).toBe(true);
		expect(/stream\.onDbChange\('work_item'/.test(src)).toBe(true);
	});

	it('the filter controls are real buttons with aria-pressed + a visible focus ring (a11y)', () => {
		expect(/aria-pressed=\{ledgerFilter === value\}/.test(src)).toBe(true);
		expect(/\.filter:focus-visible\s*\{[^}]*outline\s*:/.test(css)).toBe(true);
		// Never `outline: none` anywhere on this page.
		expect(/outline\s*:\s*none/.test(css)).toBe(false);
	});

	it('renders the plain-language step/reason label, not just the machine code', () => {
		expect(/row\.stageLabel/.test(src)).toBe(true);
		expect(/row\.reasonLabel/.test(src)).toBe(true);
	});

	it('colour is never the ONLY signal — every toned row also carries a text badge', () => {
		expect(/<span class="ledger-badge" data-tone=\{toneOf\(row\)\}>\{badgeOf\(row\)\}<\/span>/.test(src)).toBe(
			true
		);
	});
});

// ── (3) TOKENS / CONTRAST ────────────────────────────────────────────────────────────────

/** The `prop:` token inside the rule for an exact (possibly attribute-) selector. */
function tokenOfRule(
	selector: string,
	prop: 'color' | 'border-color' | 'border-left-color' | 'background'
): string | null {
	const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const block = new RegExp(`${esc}\\s*\\{([^}]*)\\}`).exec(css);
	if (!block) return null;
	const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*var\\(\\s*(--[\\w-]+)\\s*\\)`).exec(block[1]);
	return m ? m[1] : null;
}

describe('ledger tone badges use the BODY-AA on-overlay text tokens (the AV-1 defect class)', () => {
	it('the badge really does sit on --color-surface-overlay (the surface the AA pairing assumes)', () => {
		expect(tokenOfRule('.ledger-row', 'background')).toBe('--color-surface-overlay');
	});

	it("the 'bad' tone is --color-error-on-overlay, NOT the base-surface --color-error", () => {
		expect(tokenOfRule(".ledger-badge[data-tone='bad']", 'color')).toBe('--color-error-on-overlay');
	});

	it("the 'warn' tone is --color-warn-on-overlay (locks the token FAMILY, not just the value)", () => {
		expect(tokenOfRule(".ledger-badge[data-tone='warn']", 'color')).toBe('--color-warn-on-overlay');
	});

	it("the 'neutral' tone is --color-neutral-on-overlay", () => {
		expect(tokenOfRule(".ledger-badge[data-tone='neutral']", 'color')).toBe(
			'--color-neutral-on-overlay'
		);
	});

	it('all three tone TEXT tokens measure ≥ BODY AA (4.5:1) on the overlay, as shipped', () => {
		const decls = loadColorTokens();
		const bg = resolveToHex('--color-surface-overlay', decls);
		for (const tok of [
			'--color-error-on-overlay',
			'--color-warn-on-overlay',
			'--color-neutral-on-overlay'
		]) {
			const ratio = contrastRatio(resolveToHex(tok, decls), bg);
			expect(ratio, `${tok} on overlay = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_BODY);
		}
	});

	it('the OLD token (--color-error) genuinely fails BODY AA there — proves this guard is real', () => {
		const decls = loadColorTokens();
		const ratio = contrastRatio(
			resolveToHex('--color-error', decls),
			resolveToHex('--color-surface-overlay', decls)
		);
		expect(ratio, `--color-error on overlay = ${ratio.toFixed(2)}:1`).toBeLessThan(AA_BODY);
	});

	it('the row BORDERS use the same on-overlay ramp and clear the 3:1 UI-component bar', () => {
		expect(tokenOfRule(".ledger-row[data-tone='bad']", 'border-left-color')).toBe(
			'--color-error-on-overlay'
		);
		expect(tokenOfRule(".ledger-row[data-tone='warn']", 'border-left-color')).toBe(
			'--color-warn-on-overlay'
		);
		expect(tokenOfRule(".ledger-row[data-tone='neutral']", 'border-left-color')).toBe(
			'--color-neutral-on-overlay'
		);
		const decls = loadColorTokens();
		const bg = resolveToHex('--color-surface-overlay', decls);
		for (const tok of ['--color-error-on-overlay', '--color-warn-on-overlay']) {
			const ratio = contrastRatio(resolveToHex(tok, decls), bg);
			expect(ratio, `${tok} border on overlay = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
				AA_LARGE
			);
		}
	});

	it('no headline stat CONTRADICTS the list under it (the live-observed "0 held / 20 shown" lie)', () => {
		// The parks stat counts ONLY parks, so its label must say "hit a limit", never the broader
		// "work was held" (which would read as 0 while `deduped` holds are listed below it).
		expect(markup).not.toContain('times work was held');
		expect(markup).toContain('times the queue hit a limit');
		// …and the full hold total is surfaced alongside it, so nothing is silently unaccounted for.
		expect(/\{ledgerCounts\.holds\}/.test(markup)).toBe(true);
	});

	it('the headline stat flags use the BASE-surface tokens (they sit on --color-surface-card)', () => {
		// The opposite direction of the same rule: on the CARD surface, the base semantic token is
		// the correct family. Locking both stops a future edit from swapping the families over.
		expect(tokenOfRule('.stat', 'background')).toBe('--color-surface-card');
		expect(tokenOfRule(".stat[data-flag='bad']", 'border-color')).toBe('--color-error');
		expect(tokenOfRule(".stat[data-flag='warn']", 'border-color')).toBe('--color-warn');
	});
});
