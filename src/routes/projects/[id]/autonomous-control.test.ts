// PMA SOURCE GATE — the Overview "Run autonomously to release" control's safety contract, checked over
// the +page.svelte source so a refactor cannot silently drop a safety affordance:
//   1. ARM goes through the real-spend + UNSUPERVISED confirm (confirm.confirm) carrying the cost reality
//      AND the active spawn cap (capLabel) — never a bare submit.
//   2. The active hard spawn cap is surfaced (the loader's spendCaps / capLabel).
//   3. DISARM is a prominent, always-available STOP (a direct submit — stopping is always safe).
//   4. The pre-authorize-auto-publish opt-in exists, is a clearly-labelled role="switch", and the hidden
//      default is OFF (the toggle flips to 'true' from a falsey current value — never auto-publishes).
//   5. Honest live states are rendered from the real loop state (loopStateLabel / loopState.state).
// Static-source so it runs with no DB/browser — it guards the wiring, not the runtime (the action +
// repo round-trips are covered by pm-autonomous-action.test.ts / pm-repo.test.ts).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(HERE, '+page.svelte'), 'utf8');

describe('Overview "Run autonomously to release" control — safety wiring', () => {
	it('ARM is gated behind the real-spend + unsupervised confirm (not a bare submit)', () => {
		// The arm button calls armAutonomous(), which awaits confirm.confirm before submitting.
		expect(src).toMatch(/onclick=\{\(\)\s+=>\s+void armAutonomous\(\)\}/);
		expect(src).toMatch(/async function armAutonomous\(\)/);
		const fn = /async function armAutonomous\([\s\S]*?\n {2}\}/.exec(src)?.[0] ?? '';
		expect(fn).toMatch(/confirm\.confirm\(/);
		// The confirm message carries the cost reality AND the active cap.
		expect(fn).toMatch(/unsupervised model spend/i);
		expect(fn).toMatch(/capLabel/);
		expect(fn).toMatch(/armForm\?\.requestSubmit\(\)/);
	});

	it('the active hard spawn cap is surfaced (spendCaps → capLabel includes the re-tick cap)', () => {
		expect(src).toMatch(/data\.spendCaps/);
		expect(src).toMatch(/const capLabel = \$derived/);
		expect(src).toMatch(/re-ticks\/day per project/);
		// When a daily cap is wired the copy names it too (honest: only when present).
		expect(src).toMatch(/session-spawns\/day ceiling/);
	});

	it('DISARM is a prominent STOP, always available while armed, and submits directly', () => {
		// The armed branch renders a submit-type STOP button (no confirm — stopping is safe).
		const armedBranch = /\{#if pmArmed\}[\s\S]*?autonomous-stop[\s\S]*?\{:else\}/.exec(src)?.[0] ?? '';
		expect(armedBranch).toMatch(/type="submit"/);
		expect(armedBranch).toMatch(/Stop autonomous drive/);
		expect(armedBranch).toMatch(/aria-label="Stop autonomous drive \(disarm\)"/);
	});

	it('the pre-authorize-auto-publish opt-in is a labelled switch defaulting OFF (never auto-publishes)', () => {
		expect(src).toMatch(/action="\?\/pmAutoPublish"/);
		// A real ARIA switch with a labelled state.
		expect(src).toMatch(/role="switch"/);
		expect(src).toMatch(/aria-checked=\{pmAutoPublish\}/);
		expect(src).toMatch(/Pre-authorize auto-publish/);
		// Default OFF: pmAutoPublish falls back to the row value OR false; the copy states it never
		// auto-publishes silently.
		expect(src).toMatch(/auto_publish_preauthorized \?\? false/);
		expect(src).toMatch(/never auto-publishes silently/);
	});

	it('honest live loop states are rendered from the real loop state (F-008 — no fake done)', () => {
		expect(src).toMatch(/loopStateLabel/);
		expect(src).toMatch(/data-state=\{loopState\.state\}/);
		// The awaiting-release-confirm state surfaces the operator's release gate link.
		expect(src).toMatch(/awaiting-release-confirm/);
		expect(src).toMatch(/Review and confirm the release/);
	});
});
