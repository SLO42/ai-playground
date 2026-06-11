#!/usr/bin/env node
// verify-flow: shell-primitives (TASK 15.3 B9 seed — codifies the proven 10.1
// live-verify from the wave verdict: Ctrl+K command palette opens, navigates,
// and an action fires a toast).
//
// Proof discipline: every action carries the daemon's snapshot-diff proof
// (added/removed semantic nodes) — never screenshots. The keyboard backbone
// (UI-SPEC §271) is driven via the daemon's `press` op; the palette has no
// pointer-only open path by design.
//
// Run directly: node tests/verify-flows/shell-primitives.mjs
// Or via the runner: npm run verify:flows

import { runFlow, pollUntil, awaitLive } from './lib/harness.mjs';

await runFlow('shell-primitives', async ({ base, bv, step, assert }) => {
	// 1. Home, at rest — palette closed. Gate on hydration + live SSE before
	//    any keyboard press (the Ctrl+K listener attaches at hydration).
	const nav = await bv(['nav', `${base}/`]);
	await awaitLive(bv);
	step(`nav / → title ${JSON.stringify(nav.title)} (hydrated, connection live)`);

	// 2. Ctrl+K opens the palette (snapshot-diff proof: the dialog node appears).
	const open1 = await bv(['press', 'Control+KeyK']);
	assert(open1.changed > 0, `Ctrl+K changed nothing: ${open1.summary}`);
	assert(
		open1.added.some((l) => l.includes('"Command palette"')),
		`Ctrl+K did not add the Command palette dialog. added=${JSON.stringify(open1.added.slice(0, 10))}`
	);
	step(`Ctrl+K → ${open1.summary} (dialog "Command palette" in added)`);

	// 3. Pick "Go to Workflows" — Enter-equivalent click on the ranked option.
	const snap1 = await bv(['snapshot']);
	const goWorkflows = snap1.nodes.find(
		(n) => n.role === 'option' && n.name.includes('Go to Workflows')
	);
	assert(goWorkflows, 'palette option "Go to Workflows" not present in snapshot');
	const act1 = await bv(['act', goWorkflows.ref]);
	assert(act1.changed > 0, `clicking "Go to Workflows" changed nothing: ${act1.summary}`);
	assert(
		act1.removed.some((l) => l.includes('"Command palette"')),
		'palette did not close after running the command'
	);
	const at1 = await bv(['status']);
	assert(String(at1.url).endsWith('/workflows'), `expected /workflows, at ${at1.url}`);
	step(`palette navigate → ${at1.url} (${act1.summary})`);

	// 4. Ctrl+K again → run the "Start manual run" ACTION → toast fires.
	const open2 = await bv(['press', 'Control+KeyK']);
	assert(
		open2.added.some((l) => l.includes('"Command palette"')),
		'second Ctrl+K did not reopen the palette'
	);
	const snap2 = await bv(['snapshot']);
	const startRun = snap2.nodes.find(
		(n) => n.role === 'option' && n.name.includes('Start manual run')
	);
	assert(startRun, 'palette option "Start manual run" not present in snapshot');
	const act2 = await bv(['act', startRun.ref]);
	// The toast's labelled close control is the toast's semantic fingerprint in
	// the a11y snapshot — its appearance in the act diff IS the toast proof.
	assert(
		act2.added.some((l) => l.includes('"Dismiss notification"')),
		`toast did not appear after "Start manual run". added=${JSON.stringify(act2.added.slice(0, 10))}`
	);
	step(`"Start manual run" → toast appeared (${act2.summary})`);

	// Toast content truth (read-only text op — info toasts auto-dismiss at 4.5s,
	// so read it immediately after the act proof).
	const toastText = await bv(['text', '[data-testid="toast"]']);
	assert(
		toastText.texts.some((t) => t.includes('Start manual run')),
		`toast text missing "Start manual run": ${JSON.stringify(toastText.texts)}`
	);
	step(`toast text: ${JSON.stringify(toastText.texts)}`);

	// 5. Toast dismisses (manual close if still up, else the 4.5s auto-dismiss)
	//    — the page returns to rest either way, bounded, no spin.
	const snap3 = await bv(['snapshot']);
	const dismiss = snap3.nodes.find(
		(n) => n.role === 'button' && n.name.includes('Dismiss notification')
	);
	if (dismiss) {
		const act3 = await bv(['act', dismiss.ref]);
		assert(
			act3.removed.some((l) => l.includes('"Dismiss notification"')),
			'manual toast dismiss removed nothing'
		);
		step(`toast manually dismissed (${act3.summary})`);
	} else {
		step('toast already auto-dismissed before manual close — auto-dismiss path observed');
	}
	await pollUntil(
		async () => (await bv(['text', '[data-testid="toast"]'])).count === 0,
		{ boundMs: 8_000, label: 'toast stack empty' }
	);
	step('toast stack empty — page back at rest');
});
