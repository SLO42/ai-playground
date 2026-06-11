// Unit — op-validate boundary validators for the 15.3 press/text daemon ops.
// Shadow paths per the prime directives: nil, empty, and hostile input each
// rejected with a NAMED error; the happy path returns the input verbatim.

import { describe, it, expect } from 'vitest';
import { validatePressKey, validateTextSelector } from './op-validate.mjs';

describe('validatePressKey', () => {
	it('accepts Playwright keys and chords verbatim', () => {
		for (const k of ['Escape', 'Enter', 'Control+KeyK', 'Shift+Tab', 'ArrowDown', 'F1']) {
			expect(validatePressKey(k)).toBe(k);
		}
	});

	it('rejects nil / empty / non-string with press-key-invalid', () => {
		for (const bad of [undefined, null, '', 42, {}]) {
			expect(() => validatePressKey(bad)).toThrowError(
				expect.objectContaining({ name: 'press-key-invalid' })
			);
		}
	});

	it('rejects spaces, punctuation, over-long chords (nothing hostile reaches page.keyboard)', () => {
		for (const bad of ['Control + K', 'Enter;rm', 'a'.repeat(41), 'A+B+C+D+E', '+Enter', 'Ctrl+']) {
			expect(() => validatePressKey(bad)).toThrowError(
				expect.objectContaining({ name: 'press-key-invalid' })
			);
		}
	});
});

describe('validateTextSelector', () => {
	it('accepts ordinary CSS selectors verbatim', () => {
		for (const s of ['.svc-row', 'tbody tr', '[data-testid="toast"]', 'main h1, main h2']) {
			expect(validateTextSelector(s)).toBe(s);
		}
	});

	it('rejects nil / empty / whitespace-only / non-string with text-selector-invalid', () => {
		for (const bad of [undefined, null, '', '   ', 9, []]) {
			expect(() => validateTextSelector(bad)).toThrowError(
				expect.objectContaining({ name: 'text-selector-invalid' })
			);
		}
	});

	it('rejects control characters and over-long selectors', () => {
		for (const bad of ['a\tb', 'a\nb', '\u0000x', 'x'.repeat(251)]) {
			expect(() => validateTextSelector(bad)).toThrowError(
				expect.objectContaining({ name: 'text-selector-invalid' })
			);
		}
	});
});
