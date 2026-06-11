#!/usr/bin/env node
// verify-flow: workflows-live (TASK 15.3 B9 seed — codifies the proven 6.6/13.1
// live-verify from the wave verdicts: a workflow_run row change reaches the
// /workflows run history IN PLACE via the one SSE stream — no reload, no poll
// from the page).
//
// Mechanism: the flow writes a clearly-tagged test workflow_run to the SAME
// SurrealDB the dev server watches (live query → bus → SSE → invalidate),
// keeping the browser parked on /workflows the whole time. Proof of the
// in-place add is a PURE snapshot diff (diffSnapshots from the 15.2 daemon's
// own module) between before/after a11y snapshots with NO navigation between;
// the status flip running→done is asserted from the row's text. Teardown
// deletes the test rows (finally) — the dev DB is left as found.

import { Surreal, StringRecordId } from 'surrealdb';
import { runFlow, dbEnv, namedError, awaitLive } from './lib/harness.mjs';
import { diffSnapshots } from '../../scripts/browser-verify/snapshot.mjs';

/** Bounded SurrealDB connect — a dead socket must not wedge the flow (F-014). */
async function connectDb(env, boundMs = 5_000) {
	const db = new Surreal();
	const timer = new Promise((_, reject) =>
		setTimeout(() => reject(namedError('db-unreachable', `SurrealDB ${env.ws} did not answer within ${boundMs}ms`)), boundMs)
	);
	await Promise.race([
		(async () => {
			await db.connect(env.ws);
			await db.signin({ username: env.user, password: env.pass });
			await db.use({ namespace: env.ns, database: env.db });
		})(),
		timer
	]);
	return db;
}

await runFlow('workflows-live', async ({ base, bv, step, assert, skip, pollUntil }) => {
	// 1. Same DB the dev server watches (process.env > .env > dev defaults).
	const env = dbEnv();
	let db;
	try {
		db = await connectDb(env);
	} catch (err) {
		skip(`db-unreachable: ${err.message} (env — run npm run db:up)`);
	}
	step(`connected to ${env.ws} ns=${env.ns} db=${env.db}`);

	const tag = `vf_${process.pid}_${Date.now()}`;
	const wfId = new StringRecordId(`workflow:${tag}`);
	const runId = new StringRecordId(`workflow_run:${tag}`);

	try {
		// 2. Park on /workflows; gate on hydration + live SSE (the in-place
		//    update PROOF depends on the stream being attached), then baseline.
		await bv(['nav', `${base}/workflows`]);
		await awaitLive(bv);
		const before = await bv(['snapshot']);
		if (before.nodes.some((n) => n.name.toLowerCase().includes('database is not connected'))) {
			skip('db-disconnected: /workflows reports the datastore down (env)');
		}
		step(`parked on /workflows (${before.count} semantic nodes at rest)`);

		// 3. A real workflow_run lands in the watched table (status: running).
		await db.query('CREATE $wid CONTENT { name: $name, steps: [], trigger: "manual" };', {
			wid: wfId,
			name: `VF seed ${tag}`
		});
		await db.query('CREATE $rid CONTENT { workflow: $wid, status: "running", step_state: {} };', {
			rid: runId,
			wid: wfId
		});
		step(`created workflow_run:${tag} (status running) directly in the watched DB`);

		// 4. The run row APPEARS IN PLACE (SSE → invalidate) — proof is the pure
		//    snapshot diff (a new "detail" run-row link) + the row's own text;
		//    the page is never reloaded or re-navigated.
		await pollUntil(
			async () => {
				const rows = await bv(['text', 'tbody tr']);
				return rows.texts.some((t) => t.includes(tag) && t.includes('running'));
			},
			{ boundMs: 15_000, label: `run row ${tag} (running) appears via SSE` }
		);
		const after = await bv(['snapshot']);
		const diff = diffSnapshots(before.nodes, after.nodes);
		assert(
			diff.added.some((l) => l.includes('"detail"')),
			`snapshot diff shows no new run-row detail link. added=${JSON.stringify(diff.added.slice(0, 10))}`
		);
		step(`run row appeared in place: +${diff.added.length}/-${diff.removed.length} nodes, detail link added`);

		// 5. Flip the run to done — the SAME row must update IN PLACE.
		await db.query('UPDATE $rid SET status = "done", ended_at = time::now();', { rid: runId });
		// NOTE: 'tbody tr' matches BOTH the definitions table row (whose name also
		// carries the tag) and the run-history row — predicate on .some() per
		// condition, never .find() (the definitions row would shadow the run row).
		await pollUntil(
			async () => {
				const rows = await bv(['text', 'tbody tr']);
				const doneRow = rows.texts.some((t) => t.includes(tag) && t.includes('done'));
				const staleRunning = rows.texts.some((t) => t.includes(tag) && t.includes('running'));
				return doneRow && !staleRunning;
			},
			{ boundMs: 15_000, label: `run row ${tag} flips running→done via SSE` }
		);
		step('run row updated in place: running → done, no reload');
	} finally {
		// Teardown — the dev DB is left as found (interrupt contract: deletes are
		// idempotent; a re-run after a mid-flow death cannot trip over old rows
		// because every run uses a fresh pid+timestamp tag).
		try {
			await db.query('DELETE $rid; DELETE $wid;', { rid: runId, wid: wfId });
		} finally {
			await db.close();
		}
	}
});
