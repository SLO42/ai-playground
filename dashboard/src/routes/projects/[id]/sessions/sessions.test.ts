// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs/promises', () => ({
	readdir: vi.fn(),
	readFile: vi.fn()
}));

vi.mock('$lib/server/constants.js', () => ({
	PATHS: {
		sessionsDir: '/mock/sessions',
		chatsDir: '/mock/chats'
	}
}));

import { readdir, readFile } from 'fs/promises';
import { load } from './+page.server.js';

const mockedReaddir = vi.mocked(readdir);
const mockedReadFile = vi.mocked(readFile);

function makeParent(overrides: Record<string, any> = {}) {
	return () =>
		Promise.resolve({
			project: { id: 'test-proj', name: 'Test Project', path: '/tmp/test-proj', ...overrides }
		});
}

function callLoad(overrides: { params?: Record<string, string>; parent?: () => Promise<any> } = {}) {
	return load({
		params: { id: 'test-proj', ...overrides.params },
		parent: overrides.parent ?? makeParent()
	} as any) as ReturnType<typeof load>;
}

const sampleSessionFile = {
	id: 's1',
	startedAt: '2026-01-01T00:00:00Z',
	endedAt: '2026-01-01T01:00:00Z',
	duration: 3600000,
	cwd: '/tmp/test-proj',
	projectId: 'test-proj',
	context: { title: 'Test Session' },
	metrics: { edits: 5, commands: 3, tasks: 2, errors: 0 },
	provider: 'claude-code',
	model: 'claude-opus-4-6'
};

describe('Project Sessions +page.server load', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Default: no sessions directory, no chat index
		mockedReaddir.mockRejectedValue(new Error('ENOENT'));
		mockedReadFile.mockRejectedValue(new Error('ENOENT'));
	});

	it('returns empty sessions when no session files exist', async () => {
		const result = await callLoad();

		expect(result.projectId).toBe('test-proj');
		expect(result.sessions).toEqual([]);
		expect(result.summary.total).toBe(0);
	});

	it('loads agent sessions from session files', async () => {
		mockedReaddir.mockResolvedValue(['s1.json', 'current.json'] as any);
		mockedReadFile.mockImplementation(async (path: any) => {
			if (String(path).includes('s1.json')) {
				return JSON.stringify(sampleSessionFile);
			}
			throw new Error('ENOENT');
		});

		const result = await callLoad();

		expect(result.sessions).toHaveLength(1);
		expect(result.sessions[0].id).toBe('s1');
		expect(result.sessions[0].title).toBe('Test Session');
		expect(result.sessions[0].type).toBe('agent');
		expect(result.sessions[0].status).toBe('completed');
	});

	it('marks sessions with errors as error status', async () => {
		const errorSession = { ...sampleSessionFile, metrics: { ...sampleSessionFile.metrics, errors: 3 } };
		mockedReaddir.mockResolvedValue(['s1.json'] as any);
		mockedReadFile.mockImplementation(async (path: any) => {
			if (String(path).includes('s1.json')) return JSON.stringify(errorSession);
			throw new Error('ENOENT');
		});

		const result = await callLoad();

		expect(result.sessions[0].status).toBe('error');
	});

	it('filters sessions by projectId', async () => {
		const otherSession = { ...sampleSessionFile, id: 's2', projectId: 'other-proj', cwd: '/tmp/other-proj' };
		mockedReaddir.mockResolvedValue(['s1.json', 's2.json'] as any);
		mockedReadFile.mockImplementation(async (path: any) => {
			if (String(path).includes('s1.json')) return JSON.stringify(sampleSessionFile);
			if (String(path).includes('s2.json')) return JSON.stringify(otherSession);
			throw new Error('ENOENT');
		});

		const result = await callLoad();

		expect(result.sessions).toHaveLength(1);
		expect(result.sessions[0].id).toBe('s1');
	});

	it('computes summary stats correctly', async () => {
		const runningSession = {
			...sampleSessionFile,
			id: 's2',
			endedAt: undefined,
			metrics: { edits: 2, commands: 1, tasks: 0, errors: 0 }
		};
		mockedReaddir.mockResolvedValue(['s1.json', 's2.json'] as any);
		mockedReadFile.mockImplementation(async (path: any) => {
			if (String(path).includes('s1.json')) return JSON.stringify(sampleSessionFile);
			if (String(path).includes('s2.json')) return JSON.stringify(runningSession);
			throw new Error('ENOENT');
		});

		const result = await callLoad();

		expect(result.summary.total).toBe(2);
		expect(result.summary.completed).toBe(1);
		expect(result.summary.running).toBe(1);
		expect(result.summary.totalEdits).toBe(7);
	});

	it('handles malformed session files gracefully', async () => {
		mockedReaddir.mockResolvedValue(['bad.json'] as any);
		mockedReadFile.mockImplementation(async (path: any) => {
			if (String(path).includes('bad.json')) return 'not json';
			throw new Error('ENOENT');
		});

		const result = await callLoad();
		expect(result.sessions).toEqual([]);
	});

	it('includes current session if it matches project', async () => {
		mockedReaddir.mockResolvedValue(['current.json'] as any);
		mockedReadFile.mockImplementation(async (path: any) => {
			if (String(path).includes('current.json')) {
				return JSON.stringify({
					...sampleSessionFile,
					id: 'current-1',
					endedAt: undefined
				});
			}
			throw new Error('ENOENT');
		});

		const result = await callLoad();

		expect(result.sessions).toHaveLength(1);
		expect(result.sessions[0].id).toBe('current-1');
		expect(result.sessions[0].status).toBe('running');
	});
});
