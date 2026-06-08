import { describe, it, expect } from 'vitest';
import {
	IdentifierError,
	assertTableName,
	assertRecordId,
	assertEdgeId
} from './validate';

// TASK 0.b — D-016 record-id/table-name validation guard.
// ALL values bind via $param; ONLY validated table-names and record-ids may be
// interpolated, and only after passing the strict regex at this single chokepoint.

describe('assertTableName (D-016)', () => {
	it('accepts lowercase snake_case table names', () => {
		for (const t of ['memory', 'work_item', 'cc_session', 'agent_slot', 'm1']) {
			expect(assertTableName(t)).toBe(t);
		}
	});

	it('rejects names with uppercase, spaces, or punctuation', () => {
		for (const bad of [
			'Memory',
			'work item',
			'memory;DROP',
			'memory:1',
			'mem-ory',
			'mem.ory',
			'',
			'1memory' // must start with a letter/underscore-class char per regex
		]) {
			expect(() => assertTableName(bad)).toThrow(IdentifierError);
		}
	});

	it('rejects an injection attempt that closes the identifier', () => {
		expect(() => assertTableName('memory WHERE 1=1')).toThrow(IdentifierError);
	});

	it('rejects non-string input', () => {
		// param is typed `unknown`; pass a number to exercise the runtime guard.
		expect(() => assertTableName(123 as unknown)).toThrow(IdentifierError);
	});
});

describe('assertRecordId (D-016)', () => {
	it('accepts table:id form', () => {
		for (const id of ['memory:abc', 'work_item:w1', 'session:cc_123']) {
			expect(assertRecordId(id)).toBe(id);
		}
	});

	it('rejects a bare table name (no id part)', () => {
		expect(() => assertRecordId('memory')).toThrow(IdentifierError);
	});

	it('rejects ids with interpolation/injection characters', () => {
		for (const bad of [
			'memory:abc;REMOVE TABLE memory',
			'memory:a b',
			'memory:a:b',
			'Memory:abc',
			'memory:',
			':abc'
		]) {
			expect(() => assertRecordId(bad)).toThrow(IdentifierError);
		}
	});
});

describe('assertEdgeId (D-016 — RELATE endpoints)', () => {
	it('validates both endpoints of a RELATE', () => {
		const [a, b] = assertEdgeId('entity:1', 'entity:2');
		expect(a).toBe('entity:1');
		expect(b).toBe('entity:2');
	});

	it('throws if either endpoint is malformed', () => {
		expect(() => assertEdgeId('entity:1', 'bad id')).toThrow(IdentifierError);
		expect(() => assertEdgeId('bad', 'entity:2')).toThrow(IdentifierError);
	});
});
