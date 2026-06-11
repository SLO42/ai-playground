#!/usr/bin/env node
// verify-flow: services-health (TASK 15.3 B9 seed — codifies the proven 10.5
// live-verify from the wave verdict: the /services Ollama row reports PROBE
// TRUTH, F-008).
//
// The flow probes Ollama ITSELF (independent truth source) and asserts the
// page's "probe: healthy/unreachable" claim AGREES. Both up and down are
// valid worlds — what is verified is honesty, not uptime. Assertions read the
// structured a11y snapshot + the daemon's read-only `text` op — never
// screenshots. Read-only on purpose: the start/stop/restart controls operate
// a REAL service and stay out of an automated verify.

import { runFlow, urlUp, ollamaHost } from './lib/harness.mjs';

await runFlow('services-health', async ({ base, bv, step, assert, skip }) => {
	// 1. Independent truth: is Ollama actually answering right now? LIKE-FOR-LIKE
	//    with the page's own probe (OllamaServiceAdapter): same raw OLLAMA_HOST
	//    string, same GET /api/version, fetch-throw counts as down — so the flow
	//    compares the page's claim against the exact probe it promises.
	const host = ollamaHost();
	const ollamaUp = await urlUp(`${host}/api/version`);
	step(`independent probe: ${host} is ${ollamaUp ? 'UP' : 'DOWN'}`);

	// 2. The page.
	await bv(['nav', `${base}/services`]);
	const snap = await bv(['snapshot']);
	assert(
		snap.nodes.some((n) => n.role === 'heading' && n.name === 'Services'),
		'/services heading not rendered'
	);

	// Honest-disconnected shell (D-019) = the DB is down: an ENV skip, not a
	// feature defect — the page is honestly saying it cannot know.
	if (snap.nodes.some((n) => n.role === 'alert' && n.name.toLowerCase().includes('disconnected'))) {
		skip('db-disconnected: /services reports the datastore down (env — run npm run db:up)');
	}
	assert(
		snap.nodes.some((n) => n.name === 'managed services'),
		'managed services list not rendered'
	);
	step('/services live with the managed services list');

	// 3. The Ollama row's probe claim.
	const rows = await bv(['text', '.svc-row']);
	assert(rows.count > 0, 'no service rows rendered');
	const ollamaRow = rows.texts.find((t) => t.toLowerCase().includes('ollama'));
	assert(ollamaRow, `no ollama service row. rows=${JSON.stringify(rows.texts)}`);
	const claim = /probe: (healthy|unreachable)/.exec(ollamaRow);
	assert(claim, `ollama row carries no probe claim (expected "probe: healthy|unreachable"): ${JSON.stringify(ollamaRow)}`);
	step(`page claim: ${JSON.stringify(ollamaRow)}`);

	// 4. TRUTH: the page's claim must agree with the independent probe (F-008).
	const expected = ollamaUp ? 'healthy' : 'unreachable';
	assert(
		claim[1] === expected,
		`probe DISHONESTY: ollama is ${ollamaUp ? 'up' : 'down'} but the page claims "probe: ${claim[1]}"`
	);
	step(`probe truth holds: independent=${expected}, page=${claim[1]}`);
});
