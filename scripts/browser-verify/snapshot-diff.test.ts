// Unit: pure snapshot diff — the act() action-proof engine (TASK 15.2 B3).
// Four paths per the shadow-path contract: happy, nil input, empty input,
// and the honest "nothing changed" failure signal.

import { describe, it, expect } from 'vitest';
import { diffSnapshots, nodeLine } from './snapshot.mjs';

const n = (tag: string, role: string, name: string) => ({ ref: null, tag, role, name });

describe('diffSnapshots', () => {
	it('happy: reports added and removed lines with counts', () => {
		const before = [n('button', 'button', 'Notifications'), n('h1', 'heading', 'Atelier')];
		const after = [
			n('button', 'button', 'Notifications'),
			n('h1', 'heading', 'Atelier'),
			n('dialog', 'dialog', 'Notifications panel'),
			n('button', 'button', 'Close')
		];
		const diff = diffSnapshots(before, after);
		expect(diff.changed).toBe(2);
		expect(diff.added).toEqual(['dialog[dialog] "Notifications panel"', 'button[button] "Close"']);
		expect(diff.removed).toEqual([]);
	});

	it('identical captures diff as ZERO changes — the honest "clicked and nothing changed" signal', () => {
		const nodes = [n('a', 'link', 'Projects'), n('a', 'link', 'Agents')];
		expect(diffSnapshots(nodes, [...nodes])).toEqual({ added: [], removed: [], changed: 0 });
	});

	it('refs are addressing, not content: same nodes with different refs diff as zero', () => {
		const before = [{ ref: 'g1:e1', tag: 'button', role: 'button', name: 'Save' }];
		const after = [{ ref: 'g2:e9', tag: 'button', role: 'button', name: 'Save' }];
		expect(diffSnapshots(before, after).changed).toBe(0);
	});

	it('multiset semantics: one of two duplicates disappearing is ONE removal', () => {
		const dup = n('li', 'generic', 'item');
		const diff = diffSnapshots([dup, dup], [dup]);
		expect(diff.removed).toEqual(['li[generic] "item"']);
		expect(diff.added).toEqual([]);
		expect(diff.changed).toBe(1);
	});

	it('empty arrays are legal (blank page) — everything after is "added"', () => {
		const diff = diffSnapshots([], [n('h1', 'heading', 'Hello')]);
		expect(diff).toEqual({ added: ['h1[heading] "Hello"'], removed: [], changed: 1 });
		expect(diffSnapshots([], [])).toEqual({ added: [], removed: [], changed: 0 });
	});

	it('nil input throws a NAMED error (shadow path: nil — capture both sides first)', () => {
		expect(() => diffSnapshots(null as never, [])).toThrowError(/diff-input-nil/);
		expect(() => diffSnapshots([], undefined as never)).toThrowError(/diff-input-nil/);
	});
});

describe('nodeLine', () => {
	it('formats the stable identity line', () => {
		expect(nodeLine(n('button', 'button', 'Stop'))).toBe('button[button] "Stop"');
	});
});
