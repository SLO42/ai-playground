// TASK 14.4e VERIFY — extraction write-path de-escape (audit-confirmed F-008).
//
// The live /memory surface rendered a stored row with literal escaped backslashes
// ("F:\\code\\ai-playground-v2") duplicating a clean row. Root cause: the local
// extraction model DOUBLE-ENCODED the JSON string contents of its reply, so after the
// one real JSON.parse the candidate content still carried `\\` pairs — and storeMemory
// faithfully persisted the artifact. These tests pin the write-path fix: parseExtraction
// collapses the doubled-backslash artifact (and ONLY that artifact — legitimate single
// backslashes and prose escapes are never touched).

import { describe, expect, it } from 'vitest';
import { parseExtraction, unescapeDoubleEncoded } from './wiring';

describe('unescapeDoubleEncoded — the doubled-backslash artifact, and nothing else', () => {
	it('collapses \\\\ pairs when EVERY backslash is paired (the double-encoded signature)', () => {
		const overEscaped = 'Project root is F:\\\\code\\\\ai-playground-v2'; // literal \\ pairs
		expect(unescapeDoubleEncoded(overEscaped)).toBe('Project root is F:\\code\\ai-playground-v2');
	});

	it('leaves a CLEAN Windows path untouched (lone backslashes are real content)', () => {
		const clean = 'Project root is F:\\code\\ai-playground-v2';
		expect(unescapeDoubleEncoded(clean)).toBe(clean);
	});

	it('leaves prose with a lone backslash escape untouched', () => {
		const prose = 'split lines on \\n before parsing';
		expect(unescapeDoubleEncoded(prose)).toBe(prose);
	});

	it('leaves MIXED pairs-and-singles untouched (cannot prove double-encoding)', () => {
		const mixed = 'UNC \\\\server\\share'; // \\server is a pair, \share is a single
		expect(unescapeDoubleEncoded(mixed)).toBe(mixed);
	});

	it('is a no-op on backslash-free text', () => {
		expect(unescapeDoubleEncoded('nothing to do here')).toBe('nothing to do here');
	});
});

describe('parseExtraction — candidates come out de-escaped (the write-path fix)', () => {
	it('a double-encoded model reply yields the CLEAN fact, not the \\\\ artifact', () => {
		// Reconstruct the exact failure: the model intended `clean`, but escaped the JSON
		// string contents one extra time before the reply was serialized.
		const clean = 'Project root is F:\\code\\ai-playground-v2';
		const doubleEncoded = JSON.stringify([
			{ content: clean.replace(/\\/g, '\\\\'), kind: 'semantic' }
		]);
		const out = parseExtraction(doubleEncoded);
		expect(out).toHaveLength(1);
		expect(out[0].content).toBe(clean);
		expect(out[0].content).not.toContain('\\\\');
	});

	it('a correctly-encoded reply with a Windows path round-trips unchanged', () => {
		const clean = 'Build output lands in F:\\code\\x\\build';
		const reply = JSON.stringify([{ content: clean, kind: 'procedural' }]);
		const out = parseExtraction(reply);
		expect(out).toHaveLength(1);
		expect(out[0].content).toBe(clean);
		expect(out[0].kind).toBe('procedural');
	});

	it('still tolerates a non-JSON / empty reply (best-effort contract intact)', () => {
		expect(parseExtraction('no json here')).toEqual([]);
		expect(parseExtraction('[]')).toEqual([]);
	});
});
