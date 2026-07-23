// CG2-4 VERIFY — the publish/deploy confirm on /projects/[id]/release carries an HONEST
// external-cost line (COST-GOVERNANCE-SPEC cost-governance-2 deferral).
//
// The gated publish/deploy confirm triggers a REAL external action but Atelier does not — and
// cannot — meter the cost the target's adapter/host incurs (a Thunderstore upload is free; a
// deploy host bills separately). F-008 forbids a fabricated number, so the honest surface is an
// em-dash with a documented exclusion. This is a static guard over +page.svelte (mirrors
// cg2-budget-override-ui.test.ts / repo-create-ui.test.ts) so a refactor cannot silently re-drop
// the line or dress the em-dash as a real figure. CRLF-normalized (F-054) so the Edit tool's
// LF→CRLF flip on Windows cannot break the source-text matches.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(HERE, '+page.svelte'), 'utf8').replace(/\r\n/g, '\n');

describe('CG2-4 external-cost line on the publish confirm — honest & present (static guard)', () => {
	it('the confirm renders an external-cost line labelled per the target kind', () => {
		expect(src).toMatch(/class="ext-cost"/);
		expect(src).toMatch(/external \{targetResult\.kind\} cost/);
	});

	it('the value is an honest em-dash — never a fabricated number (F-008)', () => {
		// The est-value is a literal em-dash, not a bound/computed figure.
		expect(src).toMatch(/<span class="est-value mono">—<\/span>/);
	});

	it('the note documents the exclusion (not metered by Atelier — the adapter/host bills it)', () => {
		expect(src).toMatch(/not metered by Atelier/);
		expect(src).toMatch(/\{targetResult\.kind\} adapter\/host bills it separately/);
	});

	it('the line lives INSIDE the gated confirm form (only shown when confirming a real action)', () => {
		// The ext-cost line must sit between the confirm-note and the confirm button, i.e. within
		// the confirm-form guarded by targetDryOk && targetResult.confirmToken.
		const confirmBlock = src.slice(src.indexOf('confirm-note'), src.indexOf('Confirm ${targetResult.kind}'));
		expect(confirmBlock).toMatch(/class="ext-cost"/);
	});

	it('the em-dash value is styled muted (honestly excluded, not a real figure)', () => {
		// The .est-value token in THIS file resolves to a muted colour (not --color-text).
		expect(src).toMatch(/\.est-value \{[^}]*--color-text-muted/);
	});
});
