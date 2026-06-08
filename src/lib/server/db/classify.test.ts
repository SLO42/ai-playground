import { describe, it, expect } from 'vitest';
import { classifyDbError, isDisconnectError } from './classify';

// TASK 6.11 VERIFY: the honest connected/disconnected split.
//   - genuine connection-loss (dead cached handle, killed server) → 'disconnected'
//   - true query/parse/validation failures (DB up) → 'query-error'

describe('classifyDbError', () => {
	it('classifies SDK "must be connected" guard as disconnected', () => {
		expect(classifyDbError(new Error('There was a problem with the underlying database: You must be connected to a SurrealDB instance to use this functionality')))
			.toBe('disconnected');
	});

	it('classifies Windows connect-timeout (os error 10060) as disconnected', () => {
		expect(classifyDbError(new Error('connect: An attempt failed because the connected party did not properly respond (os error 10060)')))
			.toBe('disconnected');
	});

	it('classifies a closed/dropped socket as disconnected', () => {
		expect(classifyDbError(new Error('WebSocket connection closed'))).toBe('disconnected');
		expect(classifyDbError(new Error('socket hang up'))).toBe('disconnected');
		expect(classifyDbError(new Error('connection lost'))).toBe('disconnected');
	});

	it('classifies the node ECONN* family as disconnected', () => {
		expect(classifyDbError(new Error('connect ECONNREFUSED 127.0.0.1:8000'))).toBe('disconnected');
		expect(classifyDbError(new Error('read ECONNRESET'))).toBe('disconnected');
	});

	it('classifies a true query/parse error as query-error (DB is up)', () => {
		expect(classifyDbError(new Error('Parse error: Unexpected token `SELET`'))).toBe('query-error');
		expect(classifyDbError(new Error('Found NONE for field `name`, with record `project:x`')))
			.toBe('query-error');
	});

	it('classifies a validation/boundary failure as query-error', () => {
		expect(classifyDbError(new Error('invalid record id'))).toBe('query-error');
		expect(classifyDbError(new Error('table name failed validation'))).toBe('query-error');
	});

	it('handles non-Error throwables without crashing', () => {
		expect(classifyDbError('You must be connected to a SurrealDB instance')).toBe('disconnected');
		expect(classifyDbError({ message: 'read ECONNRESET' })).toBe('disconnected');
		expect(classifyDbError(undefined)).toBe('query-error');
		expect(classifyDbError(null)).toBe('query-error');
	});

	it('isDisconnectError mirrors the classifier', () => {
		expect(isDisconnectError(new Error('connection refused'))).toBe(true);
		expect(isDisconnectError(new Error('Parse error'))).toBe(false);
	});
});
