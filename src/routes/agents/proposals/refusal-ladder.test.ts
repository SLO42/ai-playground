/* ============================================================================
   ai-playground v2 — /agents/proposals REFUSAL LADDER + BOUNDARY VALIDATION
   (LC-C2 — the red-team's blockers ③ and ④ on the LC cluster)

   TWO DEFECTS THIS EXISTS TO CATCH, both of the same family: the file DOCUMENTED
   a property it did not have.

   ③ THE LADDER OVERCLAIMED. `refusalStatus` calls itself "one ladder, shared by
     every action's catch" — it was wired into 4 of the 9 catch sites. The rest
     still listed `WorkforceInputError` and fell everything else to 500, so a
     named, caller-facing refusal (a D-016 IdentifierError, a comparison
     collision, a TierGateError) surfaced from those actions as "the server
     broke". A doc comment asserting coverage it does not have is the same
     dishonesty class as a fabricated notice, one layer down.

   ④ A CLIENT'S TYPO WAS A SERVER FAULT. `proposal='not-a-record-id'` returned
     500 (MEASURED live on :5174). `regauntlet` resolves its target and
     `tierInterview` reads its incumbent BEFORE their try blocks, so the D-016
     IdentifierError thrown deep in the repo had no catch to land in at all.
     A malformed client-supplied id is a 400.

   The gate is BEHAVIOURAL, not a comment audit: every action is driven with the
   real FormData shape the page posts, against a real throwaway SurrealDB, and
   asserted to REFUSE at 400 rather than throw or 500. The one source-scan below
   is the anti-regression latch for ③ and it normalises EOLs first (F-054).
   ============================================================================ */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Db, initDb, closeDb } from '$lib/server/db/client';
import { runMigrations } from '$lib/server/db/migrate';
import { schemaMigrations } from '$lib/server/db/schema';
import { startTestDb, type TestDb } from '$lib/server/db/testserver';
import { createReviewProposal, createRole, createRoleVersion } from '$lib/server/workforce';
import { actions } from './+page.server';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '+page.server.ts');

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
	// The actions read tryGetDb() (the runtime singleton) — point it at the test DB so the
	// REAL handler code runs unchanged.
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

type ActionKey = keyof typeof actions;

function fd(fields: Record<string, string>): FormData {
	const f = new FormData();
	for (const [k, v] of Object.entries(fields)) f.set(k, v);
	return f;
}

/** Invoke a REAL action; normalize SvelteKit's fail()/success return. A THROW is left to
 *  propagate on purpose — an unhandled throw is a 500 to the operator and is the defect. */
async function call(
	key: ActionKey,
	fields: Record<string, string>
): Promise<{ status: number; data: unknown }> {
	const request = { formData: async () => fd(fields) } as unknown as Request;
	const handler = actions[key] as (e: { request: Request }) => Promise<unknown>;
	const res = (await handler({ request })) as { status?: number; data?: unknown };
	if (res && typeof res === 'object' && 'status' in res && 'data' in res) {
		return { status: res.status as number, data: res.data };
	}
	return { status: 200, data: res };
}

const errorOf = (r: { data: unknown }) =>
	String(
		((r.data as { proposals?: Record<string, unknown> })?.proposals ?? {}).error ?? '(no error)'
	);

/**
 * Every action, with the id field it reads and the OTHER fields it needs to get past its own
 * cheap guards. The malformed id must be refused before any of them matter.
 */
const ID_FIELD: Record<ActionKey, { field: string; table: string; extra: Record<string, string> }> =
	{
		previewDiff: { field: 'proposal', table: 'review_proposal', extra: { promptCore: 'x' } },
		author: {
			field: 'proposal',
			table: 'review_proposal',
			extra: { promptCore: 'x', operatorConfirmed: 'on' }
		},
		regauntlet: { field: 'proposal', table: 'review_proposal', extra: { operatorConfirmed: 'on' } },
		reconcile: { field: 'proposal', table: 'review_proposal', extra: {} },
		swap: {
			field: 'proposal',
			table: 'review_proposal',
			extra: { modelId: 'claude-x', operatorConfirmed: 'on' }
		},
		reject: { field: 'proposal', table: 'review_proposal', extra: { reason: 'no' } },
		proposeTier: { field: 'roleVersion', table: 'role_version', extra: { targetTier: 'haiku' } },
		tierInterview: {
			field: 'proposal',
			table: 'review_proposal',
			extra: { operatorConfirmed: 'on' }
		},
		tierSwap: { field: 'proposal', table: 'review_proposal', extra: { operatorConfirmed: 'on' } }
	};

describe('④ a malformed record id is a CLIENT error (400), on EVERY action', () => {
	it('the action set under test is the whole action set (sanity — no action escapes the gate)', () => {
		expect(Object.keys(ID_FIELD).sort()).toEqual(Object.keys(actions).sort());
	});

	for (const key of Object.keys(ID_FIELD) as ActionKey[]) {
		const { field, extra } = ID_FIELD[key];
		// The two that MEASURED 500 live (regauntlet, tierInterview) resolve their target BEFORE
		// their try block — the id had to be validated at the boundary, not inside a catch.
		it(`?/${key}: '${field}=not-a-record-id' → 400 naming the D-016 refusal, never a throw or a 500`, async () => {
			const res = await call(key, { ...extra, [field]: 'not-a-record-id' });
			expect(res.status, `a rejected identifier is caller input, not a server fault`).toBe(400);
			expect(errorOf(res)).toMatch(/record id/i);
			expect(errorOf(res)).toMatch(/D-016/);
		}, 60_000);
	}

	it('an id of the WRONG TABLE is refused by name (a role id is not a proposal id)', async () => {
		const res = await call('reconcile', { proposal: 'role:some_role' });
		expect(res.status).toBe(400);
		expect(errorOf(res)).toMatch(/review_proposal/);
	}, 60_000);

	it('an INJECTION payload never reaches SurrealQL and writes nothing', async () => {
		const before = await db.query(`SELECT id FROM review_proposal;`);
		const res = await call('reject', { proposal: "review_proposal:x'; DELETE review_proposal; --" });
		expect(res.status).toBe(400);
		expect(errorOf(res)).toMatch(/record id/i);
		expect(JSON.stringify(await db.query(`SELECT id FROM review_proposal;`))).toBe(
			JSON.stringify(before)
		);
	}, 60_000);

	// POSITIVE CONTROLS — the boundary check must not become a blanket refusal that swallows the
	// handlers' own, more informative reasons. A WELL-FORMED id gets through it every time.
	it('a well-formed id passes the boundary and reaches the handler’s own named refusal', async () => {
		const unknown = 'review_proposal:definitely_not_here';
		const missingModel = await call('swap', { proposal: unknown, operatorConfirmed: 'on' });
		expect(missingModel.status).toBe(400);
		expect(errorOf(missingModel)).toMatch(/missing model_id/);
		expect(errorOf(missingModel)).not.toMatch(/D-016/);

		const notFound = await call('reconcile', { proposal: unknown });
		expect(notFound.status).toBe(400);
		expect(errorOf(notFound)).toMatch(/not found/i);
		expect(errorOf(notFound)).not.toMatch(/D-016/);
	}, 60_000);

	it('a REAL proposal still flows into its handler (the gate is not refusing everything)', async () => {
		const i = ++n;
		const role = await createRole(db, {
			slug: `ladder-${i}-${Date.now()}`,
			name: `Ladder ${i}`,
			purpose: 'refusal ladder gate'
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
			trigger: { signal: 'confidence_miscalibration', evidence: [], reason: 'ladder gate' }
		});
		// 'proposed' is not 'interviewing' — the handler's OWN state refusal, reached and named.
		const res = await call('reconcile', { proposal: proposal.id });
		expect(res.status).toBe(400);
		expect(errorOf(res)).toMatch(/not 'interviewing'/);
	}, 60_000);
});

describe('③ the shared refusal ladder covers every catch that classifies an error', () => {
	// Source scan, EOL-normalised (F-054: the editor flips LF→CRLF here and a regex that assumes
	// one of them passes vacuously). This is the anti-regression latch: the behavioural gate above
	// proves the ladder is applied TODAY; this one fails the moment a new catch re-invents it.
	const src = readFileSync(SERVER, 'utf8').replace(/\r\n/g, '\n');
	const actionsBody = src.slice(src.indexOf('export const actions'));

	it('found the catches to gate (sanity — the scanner still matches)', () => {
		expect(actionsBody.length).toBeGreaterThan(1000);
		expect([...actionsBody.matchAll(/\} catch \(err\) \{/g)].length).toBeGreaterThanOrEqual(9);
	});

	it('every catch in an action either uses refusalStatus or is a NAMED, documented exemption', () => {
		const offenders: string[] = [];
		for (const m of actionsBody.matchAll(/\} catch \(err\) \{/g)) {
			const block = actionsBody.slice(m.index!, m.index! + 400);
			const usesLadder = block.includes('refusalStatus(err)');
			// The only sanctioned exemption: an unreadable workforce.yaml is a server fault by
			// construction — no class in the ladder can occur there and the message names the file.
			const exempt = block.includes('workforce config unreadable');
			if (!usesLadder && !exempt) offenders.push(block.split('\n').slice(0, 3).join(' '));
		}
		expect(
			offenders,
			'a catch that classifies errors bespoke is how a whole error class fell through to 500 — route it through refusalStatus'
		).toEqual([]);
	});

	it('no action catch maps an error class by hand (the ladder owns the class→status map)', () => {
		// `instanceof` inside an action catch means a second, local ladder is growing back.
		const inCatch = [...actionsBody.matchAll(/\} catch \(err\) \{[\s\S]{0,400}?\n\t\t\}/g)]
			.map((m) => m[0])
			.filter((b) => /err instanceof/.test(b));
		expect(inCatch).toEqual([]);
	});
});
