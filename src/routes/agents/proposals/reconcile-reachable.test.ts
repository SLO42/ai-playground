/* ============================================================================
   ai-playground v2 — /agents/proposals RECONCILE REACHABILITY + ACTION GATE
   (LC-C DoD fix for LC-4)

   THE DEFECT THIS EXISTS TO CATCH. LC-4 delivered the ②b reconcile path — the
   FREE way to consume the verdict of a gauntlet run the operator already paid
   for, instead of paying a second time. The MECHANISM
   (`reconcileProposalFromRun`) is covered end-to-end against a real SurrealDB in
   workforce/resolution.test.ts. The ROUTE LAYER on top of it — the `?/reconcile`
   form action and the control that reaches it — shipped with NO test of any
   kind, and could not be observed live either (the dev DB has no open
   proposals, so the block has never rendered for anyone). Nothing anywhere
   asserted that the markup posts to an action that EXISTS, posts the field name
   the handler READS, or that a named refusal reaches the operator instead of
   being swallowed.

   That is this repo's own named defect class — see
   ../staffing-reachable.test.ts:13: "A delivered sub-route with no reachable
   link from its parent is the exact defect this gate exists to catch." The same
   rule applies one level down: a delivered ACTION with no control wired to it,
   or a control wired to an action name that does not exist, is a dead end.

   Two gates, deliberately separate:
     ① STATIC (no DB) — markup ↔ action-key wiring is bidirectional; the
       reconcile control carries the field the handler reads; and neither the
       button NOR the handler takes a credential dependency (the free path must
       stay usable with no runtime configured — that is the whole point of it).
       Every negative assertion is paired with a POSITIVE CONTROL on the
       re-gauntlet twin, so a scanner that silently stops matching fails loudly
       instead of passing vacuously.
     ② REAL DB — the actual `actions.reconcile` handler, driven with the real
       FormData shape the page posts, over a real throwaway SurrealDB: every
       named refusal (`not_waiting` / `no_run`) surfaces at 400 with its reason,
       the success path returns the payload the template renders, and a re-post
       is absorbed (interrupt contract) rather than writing twice.
   ============================================================================ */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Db, initDb, closeDb } from '$lib/server/db/client';
import { runMigrations } from '$lib/server/db/migrate';
import { schemaMigrations } from '$lib/server/db/schema';
import { startTestDb, type TestDb } from '$lib/server/db/testserver';
import {
	authorChallenger,
	createInterviewRun,
	createReviewProposal,
	createRole,
	createRoleVersion,
	finalizeInterviewRun,
	getReviewProposal
} from '$lib/server/workforce';
import { actions } from './+page.server';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = join(HERE, '+page.svelte');
const SERVER = join(HERE, '+page.server.ts');

// ── ① STATIC WIRING GATE (no DB, no server) ─────────────────────────────────

/** Every `action="?/name"` literal in the page source. */
function postedActions(src: string): string[] {
	return [...src.matchAll(/action=["']\?\/([A-Za-z0-9_]+)["']/g)].map((m) => m[1]);
}

/** The `<form action="?/name" …> … </form>` block for one action (markup slice). */
function formBlock(src: string, action: string): string {
	const start = src.indexOf(`action="?/${action}"`);
	expect(start, `no form posts to ?/${action} — the control is missing`).toBeGreaterThan(-1);
	const end = src.indexOf('</form>', start);
	expect(end, `the ?/${action} form is never closed`).toBeGreaterThan(start);
	return src.slice(start, end);
}

/** The handler body for one action key in +page.server.ts (source slice, key→next key). */
function handlerBlock(src: string, action: string, nextAction: string): string {
	const start = src.indexOf(`${action}: async`);
	expect(start, `+page.server.ts exports no '${action}' handler`).toBeGreaterThan(-1);
	const end = src.indexOf(`${nextAction}: async`, start + action.length);
	expect(end, `could not bound the '${action}' handler at '${nextAction}'`).toBeGreaterThan(start);
	return src.slice(start, end);
}

describe('LC-4 — the ②b reconcile control is WIRED and REACHABLE (static)', () => {
	const page = readFileSync(PAGE, 'utf8');
	const server = readFileSync(SERVER, 'utf8');
	const posted = postedActions(page);
	const declared = Object.keys(actions);

	it('found the form actions to gate (sanity — the scanner still matches)', () => {
		expect(posted.length).toBeGreaterThan(5);
		expect(declared.length).toBeGreaterThan(5);
	});

	it('the page posts to ?/reconcile (the LC-4 control exists at all)', () => {
		expect(
			posted,
			'the reconcile action ships with no control that reaches it — an operator can never use the free path'
		).toContain('reconcile');
	});

	it('every posted action EXISTS on the server (no dead form target)', () => {
		for (const a of posted) {
			expect(declared, `the page posts to ?/${a} but +page.server.ts declares no such action`).toContain(a);
		}
	});

	it('every declared action is REACHABLE from the markup (no dead-end action)', () => {
		for (const a of declared) {
			expect(posted, `action '${a}' is declared but no control on the page posts to it`).toContain(a);
		}
	});

	it('the reconcile form posts the `proposal` field the handler reads', () => {
		const block = formBlock(page, 'reconcile');
		expect(block).toMatch(/name="proposal"/);
		expect(block).toMatch(/type="submit"/);
		// The handler reads exactly this key — a rename on either side is the silent break.
		expect(handlerBlock(server, 'reconcile', 'swap')).toMatch(/form\.get\('proposal'\)/);
	});

	it('the reconcile control is NOT gated on runtimeAvailable — it spends nothing', () => {
		// POSITIVE CONTROL first: the paid twin IS gated, so a scanner that stopped
		// finding `runtimeAvailable` cannot make the assertion below pass vacuously.
		expect(formBlock(page, 'regauntlet')).toMatch(/runtimeAvailable/);
		expect(
			formBlock(page, 'reconcile'),
			'the free reconcile path must stay usable with no credential configured — gating it on runtimeAvailable strands the very run the operator already paid for (the LC-4 defect)'
		).not.toMatch(/runtimeAvailable/);
	});

	it('the reconcile HANDLER takes no credential dependency and no confirm tick', () => {
		const paid = handlerBlock(server, 'regauntlet', 'reconcile');
		const free = handlerBlock(server, 'reconcile', 'swap');
		// POSITIVE CONTROLS on the paid twin (spend ⇒ runtime + operator confirm).
		expect(paid).toMatch(/getRuntime/);
		expect(paid).toMatch(/operatorConfirmed/);
		// The free path: neither. A confirm on a free, reversible step trains the tick
		// to mean nothing where it IS load-bearing (D-039 swap).
		expect(free, 'reconcile must not acquire a runtime — it runs nothing').not.toMatch(/getRuntime/);
		expect(free, 'reconcile spends nothing and moves no role — it has no confirm gate').not.toMatch(
			/operatorConfirmed/
		);
	});
});

// ── ② REAL-DB ACTION GATE ───────────────────────────────────────────────────

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
	await db.close();
	// The action reads tryGetDb() (the runtime singleton) — point it at the test DB so
	// the REAL handler code runs unchanged.
	db = await initDb({
		url: tdb.wsUrl,
		username: tdb.root.username,
		password: tdb.root.password,
		namespace: tdb.namespace,
		database: tdb.database
	});
}, 90_000);

afterAll(async () => {
	await closeDb().catch(() => {});
	await tdb?.teardown();
});

/** The FormData body the +page.svelte reconcile form posts. */
function fd(fields: Record<string, string>): FormData {
	const f = new FormData();
	for (const [k, v] of Object.entries(fields)) f.set(k, v);
	return f;
}

/** Invoke the REAL reconcile action; normalize SvelteKit's fail()/success return. */
async function reconcile(fields: Record<string, string>): Promise<{ status: number; data: unknown }> {
	const request = { formData: async () => fd(fields) } as unknown as Request;
	const res = (await actions.reconcile({ request } as Parameters<typeof actions.reconcile>[0])) as
		| { status?: number; data?: unknown }
		| Record<string, unknown>;
	if (res && typeof res === 'object' && 'status' in res && 'data' in res) {
		return { status: (res as { status: number }).status, data: (res as { data: unknown }).data };
	}
	return { status: 200, data: res };
}

const payload = (r: { data: unknown }) =>
	((r.data as { proposals?: Record<string, unknown> })?.proposals ?? {}) as Record<string, unknown>;

/** A fresh role + incumbent version + open prompt_revision proposal (status 'proposed'). */
async function freshProposal(): Promise<{ proposal: string; role: string; incumbent: string }> {
	const i = ++n;
	const role = await createRole(db, {
		slug: `reconcile-route-${i}-${Date.now()}`,
		name: `Reconcile Route ${i}`,
		purpose: 'reconcile route gate'
	});
	const incumbent = await createRoleVersion(db, {
		role: role.id,
		prompt_core: `You are reviewer #${i}.\nHunt platform bugs.`,
		default_tier: 'sonnet',
		source: 'operator'
	});
	const proposal = await createReviewProposal(db, {
		role: role.id,
		kind: 'prompt_revision',
		incumbent: incumbent.id,
		trigger: { signal: 'confidence_miscalibration', evidence: [], reason: 'route gate' }
	});
	return { proposal: proposal.id, role: role.id, incumbent: incumbent.id };
}

/** Drive a fresh proposal to 'interviewing' with an authored challenger and NO run. */
async function parkedOnNoRun(): Promise<{ proposal: string; challenger: string }> {
	const { proposal } = await freshProposal();
	const authored = await authorChallenger(db, {
		proposal,
		promptCore: `You are reviewer.\nHunt platform bugs.\nQuote verbatim evidence.`,
		operatorConfirmed: true
	});
	expect(authored.proposal.status).toBe('interviewing');
	return { proposal, challenger: authored.challenger.id };
}

describe('LC-4 — the ?/reconcile action refuses BY NAME and succeeds without spend (real DB)', () => {
	it('a missing proposal id is refused 400 by name — never a silent no-op', async () => {
		const res = await reconcile({});
		expect(res.status).toBe(400);
		expect(String(payload(res).error)).toMatch(/missing proposal id/i);
	}, 60_000);

	it('an unknown proposal id maps the WorkforceInputError to 400 (not an opaque 500)', async () => {
		const res = await reconcile({ proposal: 'review_proposal:does_not_exist' });
		expect(res.status).toBe(400);
		expect(String(payload(res).error)).toMatch(/not found/i);
	}, 60_000);

	it("not_waiting: a proposal that is not parked on a run is declined WITH its reason", async () => {
		const { proposal } = await freshProposal(); // status 'proposed'
		const res = await reconcile({ proposal });
		expect(res.status).toBe(400);
		// The NAMED reason reaches the surface — not swallowed into `res.outcome` alone.
		expect(String(payload(res).error)).toMatch(/not 'interviewing'/);
		// And it is a STATE refusal, never a confirm-gate refusal: this action has no tick.
		expect(String(payload(res).error)).not.toMatch(/confirm/i);
	}, 60_000);

	it('no_run: a challenger with nothing paid for yet is declined by name, writing nothing', async () => {
		const { proposal } = await parkedOnNoRun();
		const res = await reconcile({ proposal }); // NO operatorConfirmed — none is required
		expect(res.status).toBe(400);
		expect(String(payload(res).error)).toMatch(/no interview_run|nothing has been paid for/i);
		// Nothing written: the proposal is still parked where it was.
		expect((await getReviewProposal(db, proposal))?.status).toBe('interviewing');
	}, 60_000);

	it('the SUCCESS path returns the payload the template renders, and re-posting is absorbed', async () => {
		const { proposal, challenger } = await parkedOnNoRun();
		// A terminal, SCORED run for the challenger — built directly (no LLM gauntlet): this
		// gate is about the ROUTE, the scoring engine has its own real-DB coverage.
		const run = await createInterviewRun(db, {
			role_version: challenger,
			tier: 'sonnet',
			provider: 'claude',
			model_id: 'claude-test-reconcile',
			fixture_set_sha: `sha-reconcile-${n}`,
			planted_total: 2,
			pass_criteria: { pass_recall: 1, max_false_positives: 0 }
		});
		await finalizeInterviewRun(db, run.id, {
			status: 'passed',
			planted_total: 2,
			planted_found: 2,
			false_positives: 0,
			results: [{ fixture: 'fx', kind: 'planted_defect', found: ['p1', 'p2'], missed: [] }]
		});

		const res = await reconcile({ proposal });
		expect(res.status).toBe(200);
		const p = payload(res);
		expect(p.ok).toBe(true);
		// Exactly the keys +page.svelte reads on `f.reconciled`.
		expect(p.reconciled).toBe(true);
		expect(p.run).toBe(run.id);
		expect(p).toHaveProperty('comparable');
		expect(p).toHaveProperty('incomparableReason');
		expect((await getReviewProposal(db, proposal))?.status).toBe('compared');

		// INTERRUPT CONTRACT: a re-post (double submit / retried run) is declined by name,
		// not applied a second time.
		const again = await reconcile({ proposal });
		expect(again.status).toBe(400);
		expect(String(payload(again).error)).toMatch(/not 'interviewing'/);
		expect((await getReviewProposal(db, proposal))?.status).toBe('compared');
	}, 90_000);
});
