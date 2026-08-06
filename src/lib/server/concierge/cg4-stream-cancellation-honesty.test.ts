// CG-4 VERIFY — the concierge stream comments must not claim the opposite of the code.
//
// Regression guard for the deferral-sweep DS-2 finding. Two comments in wire.ts asserted the drain was
// "deliberately not cancellable" — a true statement about the old code, and the reason the leak stood:
// a wedged provider left a suspended async generator, a promise that never settled and a retained chunk
// buffer for the process lifetime. The fix makes the turn cancellable (an AbortController aborted in the
// finally), which turns those comments into the exact false-behaviour-comment class CLAUDE.md §2 and the
// sibling guard cg2b-concierge-metering-honesty exist to eliminate. A stale comment asserting the
// opposite of the code is its own defect, so it gets its own guard.
//
// COUPLED to the code, not a bare string ban: the guard derives whether the turn actually cancels and
// only then forbids the "not cancellable" claim. If the cancellation were ever removed, the claim
// becomes legitimate again — and the guard then REQUIRES it to be stated, so the honest reality is
// documented either way. Static source-text scan, CRLF-normalized (F-054) so the Edit tool's LF→CRLF
// flip on Windows cannot break the matches.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p: string): string => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

const wireSrc = read(join(HERE, 'wire.ts'));

/** The providerToLlmFn slice — where the turn's drain and its comments live. */
function providerToLlmFnSlice(): string {
	const start = wireSrc.indexOf('function providerToLlmFn(');
	const end = wireSrc.indexOf('function buildConciergeLlm(');
	expect(start).toBeGreaterThan(-1);
	expect(end).toBeGreaterThan(start);
	return wireSrc.slice(start, end);
}

/** Does the turn actually cancel its stream — i.e. own an AbortController and abort it? */
function turnCancelsItsStream(slice: string): boolean {
	return /new AbortController\(\)/.test(slice) && /ctrl\.abort\(\)/.test(slice);
}

describe('CG-4 — the concierge stream comments match the code (static guard)', () => {
	it('the turn owns an AbortController and aborts it (the cancellation itself is intact)', () => {
		const slice = providerToLlmFnSlice();
		expect(slice).toMatch(/new AbortController\(\)/);
		expect(slice).toMatch(/ctrl\.abort\(\)/);
		// The signal must reach the drain, not just exist: the read is raced against cancellation…
		expect(slice).toMatch(/Promise\.race\(\[pending, cancelled\]\)/);
		// …and the generator is explicitly finalized rather than abandoned mid-flight.
		expect(slice).toMatch(/iter\.return\?\.\(/);
	});

	it('does NOT claim the stream is uncancellable while the code cancels it', () => {
		const slice = providerToLlmFnSlice();
		if (!turnCancelsItsStream(slice)) return; // if cancellation is ever removed, see the next test
		expect(wireSrc).not.toMatch(/deliberately not cancellable/i);
		expect(wireSrc).not.toMatch(/is not cancellable/i);
		expect(wireSrc).not.toMatch(/cannot be cancelled/i);
	});

	it('if cancellation were removed, the un-cancellable reality would have to be stated', () => {
		const slice = providerToLlmFnSlice();
		if (turnCancelsItsStream(slice)) return;
		expect(wireSrc).toMatch(/not cancellable/i);
	});

	it('the fetch seam that carries cancellation to the socket is wired for BOTH adapters', () => {
		// Provider.stream takes no AbortSignal, so the injected fetchImpl is the only route to the
		// socket. If either adapter stops being built with it, a wedged HTTP turn is uncancellable again.
		const buildSlice = wireSrc.slice(wireSrc.indexOf('function buildConciergeLlm('));
		expect(buildSlice).toMatch(/new OllamaProvider\(\{[\s\S]*?fetchImpl: fetchWithSignal\(signal\)/);
		expect(buildSlice).toMatch(/new ClaudeProvider\(\{[\s\S]*?fetchImpl: fetchWithSignal\(signal\)/);
	});

	it('the local (uncapped) provider is not declared as enforcing the output cap', () => {
		// CG-4-2: OllamaOptions has no max-output field, so claiming an enforced cap there would put the
		// "UPPER bound" wording back on a number that is not a ceiling.
		const buildSlice = wireSrc.slice(wireSrc.indexOf('function buildConciergeLlm('));
		const ollamaBranch = buildSlice.slice(
			buildSlice.indexOf("choice.provider === 'ollama'"),
			buildSlice.indexOf('} else {')
		);
		expect(ollamaBranch).toMatch(/enforced: false/);
		expect(ollamaBranch).not.toMatch(/enforced: true/);
	});
});
