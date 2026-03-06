// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs/promises before importing
vi.mock('fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('fs/promises')>();
	return {
		...actual,
		readFile: vi.fn(),
		writeFile: vi.fn(),
		readdir: vi.fn(),
		mkdir: vi.fn()
	};
});

vi.mock('$lib/server/project-scanner.js', () => ({
	scanAllProjects: vi.fn()
}));

vi.mock('$lib/server/constants.js', () => ({
	PATHS: {
		playgroundRegistry: '/mock/registry',
		root: '/mock/root',
		agentsDir: '/mock/agents'
	}
}));

import { GET, POST, DELETE } from './+server.js';
import { readFile, writeFile, readdir, mkdir } from 'fs/promises';
import { scanAllProjects } from '$lib/server/project-scanner.js';

const mockReadFile = vi.mocked(readFile);
const mockWriteFile = vi.mocked(writeFile);
const mockReaddir = vi.mocked(readdir);
const mockMkdir = vi.mocked(mkdir);
const mockScanAllProjects = vi.mocked(scanAllProjects);

const TEST_PROJECT = { id: 'proj-1', name: 'Test', path: '/mock/projects/test' };

function makeEvent(id: string, body?: unknown) {
	return {
		params: { id },
		request: body
			? new Request('http://localhost/api/projects/' + id + '/agents', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(body)
				})
			: undefined
	} as any;
}

function makeDeleteEvent(id: string, body: unknown) {
	return {
		params: { id },
		request: new Request('http://localhost/api/projects/' + id + '/agents', {
			method: 'DELETE',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		})
	} as any;
}

function setupAgentsDir(agents: Array<{ name: string; content: string }>) {
	mockReaddir.mockResolvedValue(
		agents.map((a) => ({
			name: a.name,
			isDirectory: () => false,
			isFile: () => true
		})) as any
	);
	mockReadFile.mockImplementation(async (path: string) => {
		// Association file
		if (path.toString().includes('agents.json')) {
			throw new Error('ENOENT');
		}
		// Agent .md files
		const agent = agents.find((a) => path.toString().includes(a.name));
		if (agent) return agent.content;
		throw new Error('ENOENT');
	});
}

const AGENT_MD_CODER = `---
name: coder
type: development
description: Writes code
---
# Coder Agent`;

const AGENT_MD_TESTER = `---
name: tester
type: testing
description: Runs tests
---
# Tester Agent`;

const AGENT_MD_REVIEWER = `---
name: reviewer
type: review
description: Reviews code
---
# Reviewer Agent`;

describe('/api/projects/[id]/agents', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockScanAllProjects.mockResolvedValue([TEST_PROJECT] as any);
		mockMkdir.mockResolvedValue(undefined as any);
		mockWriteFile.mockResolvedValue(undefined);
	});

	describe('GET', () => {
		it('returns 404 for unknown project', async () => {
			mockScanAllProjects.mockResolvedValue([]);
			const res = await GET(makeEvent('unknown'));
			expect(res.status).toBe(404);
			const data = await res.json();
			expect(data.error).toBe('Project not found');
		});

		it('returns empty associations when no agents.json exists', async () => {
			setupAgentsDir([
				{ name: 'coder.md', content: AGENT_MD_CODER },
				{ name: 'tester.md', content: AGENT_MD_TESTER }
			]);

			const res = await GET(makeEvent('proj-1'));
			expect(res.status).toBe(200);
			const data = await res.json();

			expect(data.associated).toEqual([]);
			expect(data.available).toHaveLength(2);
			expect(data.total).toBe(2);
		});

		it('splits agents into associated and available', async () => {
			mockReadFile.mockImplementation(async (path: string) => {
				if (path.toString().includes('agents.json')) {
					return JSON.stringify({ agents: ['coder.md'] });
				}
				if (path.toString().includes('coder.md')) return AGENT_MD_CODER;
				if (path.toString().includes('tester.md')) return AGENT_MD_TESTER;
				throw new Error('ENOENT');
			});
			mockReaddir.mockResolvedValue([
				{ name: 'coder.md', isDirectory: () => false },
				{ name: 'tester.md', isDirectory: () => false }
			] as any);

			const res = await GET(makeEvent('proj-1'));
			const data = await res.json();

			expect(data.associated).toHaveLength(1);
			expect(data.associated[0].name).toBe('coder');
			expect(data.associated[0].type).toBe('development');

			expect(data.available).toHaveLength(1);
			expect(data.available[0].name).toBe('tester');

			expect(data.total).toBe(2);
		});

		it('parses agent frontmatter correctly', async () => {
			setupAgentsDir([{ name: 'coder.md', content: AGENT_MD_CODER }]);

			const res = await GET(makeEvent('proj-1'));
			const data = await res.json();

			expect(data.available[0]).toEqual({
				name: 'coder',
				type: 'development',
				description: 'Writes code',
				filename: 'coder.md'
			});
		});

		it('skips files without frontmatter', async () => {
			mockReaddir.mockResolvedValue([
				{ name: 'readme.md', isDirectory: () => false },
				{ name: 'coder.md', isDirectory: () => false }
			] as any);
			mockReadFile.mockImplementation(async (path: string) => {
				if (path.toString().includes('agents.json')) throw new Error('ENOENT');
				if (path.toString().includes('readme.md')) return '# Just a readme, no frontmatter';
				if (path.toString().includes('coder.md')) return AGENT_MD_CODER;
				throw new Error('ENOENT');
			});

			const res = await GET(makeEvent('proj-1'));
			const data = await res.json();
			expect(data.available).toHaveLength(1);
			expect(data.available[0].name).toBe('coder');
		});

		it('scans subdirectories for agents', async () => {
			mockReaddir.mockImplementation(async (dir: any) => {
				if (dir.toString().includes('specialized')) {
					return [{ name: 'reviewer.md', isDirectory: () => false }] as any;
				}
				return [
					{ name: 'coder.md', isDirectory: () => false },
					{ name: 'specialized', isDirectory: () => true }
				] as any;
			});
			mockReadFile.mockImplementation(async (path: string) => {
				if (path.toString().includes('agents.json')) throw new Error('ENOENT');
				if (path.toString().includes('coder.md')) return AGENT_MD_CODER;
				if (path.toString().includes('reviewer.md')) return AGENT_MD_REVIEWER;
				throw new Error('ENOENT');
			});

			const res = await GET(makeEvent('proj-1'));
			const data = await res.json();
			expect(data.available).toHaveLength(2);

			const filenames = data.available.map((a: any) => a.filename);
			expect(filenames).toContain('coder.md');
			expect(filenames).toContain('specialized/reviewer.md');
		});

		it('handles empty agents directory', async () => {
			mockReaddir.mockResolvedValue([] as any);
			mockReadFile.mockImplementation(async (path: string) => {
				if (path.toString().includes('agents.json')) throw new Error('ENOENT');
				throw new Error('ENOENT');
			});

			const res = await GET(makeEvent('proj-1'));
			const data = await res.json();
			expect(data.associated).toEqual([]);
			expect(data.available).toEqual([]);
			expect(data.total).toBe(0);
		});
	});

	describe('POST', () => {
		it('returns 404 for unknown project', async () => {
			mockScanAllProjects.mockResolvedValue([]);
			const res = await POST(makeEvent('unknown', { agents: ['coder.md'] }));
			expect(res.status).toBe(404);
		});

		it('returns 400 when agents array is missing', async () => {
			const res = await POST(makeEvent('proj-1', {}));
			expect(res.status).toBe(400);
			const data = await res.json();
			expect(data.error).toBe('agents array required');
		});

		it('returns 400 when agents is empty array', async () => {
			const res = await POST(makeEvent('proj-1', { agents: [] }));
			expect(res.status).toBe(400);
		});

		it('returns 400 when agents is not an array', async () => {
			const res = await POST(makeEvent('proj-1', { agents: 'coder.md' }));
			expect(res.status).toBe(400);
		});

		it('adds agents to project association', async () => {
			mockReadFile.mockImplementation(async (path: string) => {
				if (path.toString().includes('agents.json')) throw new Error('ENOENT');
				throw new Error('ENOENT');
			});

			const res = await POST(makeEvent('proj-1', { agents: ['coder.md', 'tester.md'] }));
			const data = await res.json();

			expect(data.ok).toBe(true);
			expect(data.added).toEqual(['coder.md', 'tester.md']);
			expect(data.total).toBe(2);

			expect(mockWriteFile).toHaveBeenCalledOnce();
			const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
			expect(written.agents).toEqual(['coder.md', 'tester.md']);
		});

		it('does not duplicate already-associated agents', async () => {
			mockReadFile.mockImplementation(async (path: string) => {
				if (path.toString().includes('agents.json')) {
					return JSON.stringify({ agents: ['coder.md'] });
				}
				throw new Error('ENOENT');
			});

			const res = await POST(makeEvent('proj-1', { agents: ['coder.md', 'tester.md'] }));
			const data = await res.json();

			expect(data.added).toEqual(['tester.md']);
			expect(data.total).toBe(2);
		});

		it('creates .playground directory if needed', async () => {
			mockReadFile.mockRejectedValue(new Error('ENOENT'));

			await POST(makeEvent('proj-1', { agents: ['coder.md'] }));

			expect(mockMkdir).toHaveBeenCalledWith(
				expect.stringContaining('.playground'),
				{ recursive: true }
			);
		});

		it('skips non-string entries in agents array', async () => {
			mockReadFile.mockRejectedValue(new Error('ENOENT'));

			const res = await POST(makeEvent('proj-1', { agents: [123, 'coder.md', null] }));
			const data = await res.json();

			expect(data.added).toEqual(['coder.md']);
			expect(data.total).toBe(1);
		});
	});

	describe('DELETE', () => {
		it('returns 404 for unknown project', async () => {
			mockScanAllProjects.mockResolvedValue([]);
			const res = await DELETE(makeDeleteEvent('unknown', { agents: ['coder.md'] }));
			expect(res.status).toBe(404);
		});

		it('returns 400 when agents array is missing', async () => {
			const res = await DELETE(makeDeleteEvent('proj-1', {}));
			expect(res.status).toBe(400);
		});

		it('returns 400 when agents is empty array', async () => {
			const res = await DELETE(makeDeleteEvent('proj-1', { agents: [] }));
			expect(res.status).toBe(400);
		});

		it('removes agents from project association', async () => {
			mockReadFile.mockImplementation(async (path: string) => {
				if (path.toString().includes('agents.json')) {
					return JSON.stringify({ agents: ['coder.md', 'tester.md', 'reviewer.md'] });
				}
				throw new Error('ENOENT');
			});

			const res = await DELETE(makeDeleteEvent('proj-1', { agents: ['coder.md', 'tester.md'] }));
			const data = await res.json();

			expect(data.ok).toBe(true);
			expect(data.removed).toEqual(['coder.md', 'tester.md']);
			expect(data.total).toBe(1);

			const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
			expect(written.agents).toEqual(['reviewer.md']);
		});

		it('handles removing agents that are not associated (no-op)', async () => {
			mockReadFile.mockImplementation(async (path: string) => {
				if (path.toString().includes('agents.json')) {
					return JSON.stringify({ agents: ['coder.md'] });
				}
				throw new Error('ENOENT');
			});

			const res = await DELETE(makeDeleteEvent('proj-1', { agents: ['nonexistent.md'] }));
			const data = await res.json();

			expect(data.ok).toBe(true);
			expect(data.total).toBe(1); // coder.md still there
		});

		it('handles removing all agents', async () => {
			mockReadFile.mockImplementation(async (path: string) => {
				if (path.toString().includes('agents.json')) {
					return JSON.stringify({ agents: ['coder.md', 'tester.md'] });
				}
				throw new Error('ENOENT');
			});

			const res = await DELETE(makeDeleteEvent('proj-1', { agents: ['coder.md', 'tester.md'] }));
			const data = await res.json();

			expect(data.ok).toBe(true);
			expect(data.total).toBe(0);

			const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
			expect(written.agents).toEqual([]);
		});
	});
});
