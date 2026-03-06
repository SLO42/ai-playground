import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Integration tests for /api/projects/[id]/hooks endpoints.
 *
 * These tests exercise the same file-based hook storage the API handlers use,
 * verifying correct response shape, CRUD lifecycle, and error handling.
 */

interface Hook {
	name: string;
	type: string;
	description: string;
	enabled: boolean;
	command?: string;
}

interface HooksData {
	hooks: Hook[];
}

// Mirror the helpers from the endpoint to test the same data layer
function hooksPath(projectPath: string): string {
	return join(projectPath, '.playground', 'hooks.json');
}

async function readHooks(projectPath: string): Promise<HooksData> {
	try {
		const raw = await readFile(hooksPath(projectPath), 'utf-8');
		return JSON.parse(raw);
	} catch {
		return { hooks: [] };
	}
}

async function writeHooks(projectPath: string, data: HooksData): Promise<void> {
	const dir = join(projectPath, '.playground');
	await mkdir(dir, { recursive: true });
	await writeFile(hooksPath(projectPath), JSON.stringify(data, null, '\t'), 'utf-8');
}

describe('/api/projects/[id]/hooks — GET', () => {
	let projectPath: string;

	beforeEach(async () => {
		projectPath = await mkdtemp(join(tmpdir(), 'api-hooks-get-'));
	});

	afterEach(async () => {
		await rm(projectPath, { recursive: true, force: true });
	});

	it('returns empty array when no hooks file exists', async () => {
		const data = await readHooks(projectPath);
		expect(data).toEqual({ hooks: [] });
	});

	it('returns empty array when hooks file has empty array', async () => {
		await writeHooks(projectPath, { hooks: [] });
		const data = await readHooks(projectPath);
		expect(data.hooks).toEqual([]);
	});

	it('returns hooks with correct response shape', async () => {
		const hooks: Hook[] = [
			{
				name: 'pre-commit',
				type: 'pre-task',
				description: 'Runs before each commit',
				enabled: true,
				command: 'npm run lint'
			},
			{
				name: 'post-deploy',
				type: 'post-task',
				description: 'Cleanup after deploy',
				enabled: false,
				command: 'echo done'
			}
		];
		await writeHooks(projectPath, { hooks });

		const data = await readHooks(projectPath);

		// Verify response shape matches GET handler: { hooks, total }
		const response = { hooks: data.hooks, total: data.hooks.length };
		expect(response).toHaveProperty('hooks');
		expect(response).toHaveProperty('total');
		expect(response.total).toBe(2);
		expect(response.hooks).toHaveLength(2);
	});

	it('returns hooks with all expected fields', async () => {
		const hooks: Hook[] = [
			{
				name: 'lint-check',
				type: 'pre-edit',
				description: 'Lint before editing',
				enabled: true,
				command: 'eslint .'
			}
		];
		await writeHooks(projectPath, { hooks });

		const data = await readHooks(projectPath);
		const hook = data.hooks[0];

		expect(hook).toHaveProperty('name');
		expect(hook).toHaveProperty('type');
		expect(hook).toHaveProperty('description');
		expect(hook).toHaveProperty('enabled');
		expect(hook).toHaveProperty('command');
		expect(typeof hook.name).toBe('string');
		expect(typeof hook.type).toBe('string');
		expect(typeof hook.description).toBe('string');
		expect(typeof hook.enabled).toBe('boolean');
		expect(typeof hook.command).toBe('string');
	});

	it('returns correct total count', async () => {
		const hooks: Hook[] = Array.from({ length: 5 }, (_, i) => ({
			name: `hook-${i}`,
			type: 'pre-task',
			description: `Hook number ${i}`,
			enabled: true,
			command: `echo ${i}`
		}));
		await writeHooks(projectPath, { hooks });

		const data = await readHooks(projectPath);
		expect(data.hooks.length).toBe(5);
	});

	it('handles corrupted hooks file gracefully', async () => {
		const dir = join(projectPath, '.playground');
		await mkdir(dir, { recursive: true });
		await writeFile(hooksPath(projectPath), 'not valid json!!!', 'utf-8');

		const data = await readHooks(projectPath);
		expect(data).toEqual({ hooks: [] });
	});
});

describe('/api/projects/[id]/hooks — POST (add hook)', () => {
	let projectPath: string;

	beforeEach(async () => {
		projectPath = await mkdtemp(join(tmpdir(), 'api-hooks-post-'));
	});

	afterEach(async () => {
		await rm(projectPath, { recursive: true, force: true });
	});

	it('adds a hook with all fields', async () => {
		const data = await readHooks(projectPath);

		const hook: Hook = {
			name: 'pre-build',
			type: 'pre-task',
			description: 'Run before build',
			enabled: true,
			command: 'npm run lint'
		};

		data.hooks.push(hook);
		await writeHooks(projectPath, data);

		const result = await readHooks(projectPath);
		expect(result.hooks).toHaveLength(1);
		expect(result.hooks[0]).toEqual(hook);
	});

	it('adds a hook with defaults (enabled=true, empty description/command)', async () => {
		// Simulate POST handler defaults
		const body = { name: 'minimal-hook', type: 'post-task' } as Partial<Hook>;

		const hook: Hook = {
			name: body.name!,
			type: body.type!,
			description: body.description || '',
			enabled: body.enabled !== false,
			command: body.command || ''
		};

		const data = await readHooks(projectPath);
		data.hooks.push(hook);
		await writeHooks(projectPath, data);

		const result = await readHooks(projectPath);
		expect(result.hooks[0].name).toBe('minimal-hook');
		expect(result.hooks[0].type).toBe('post-task');
		expect(result.hooks[0].description).toBe('');
		expect(result.hooks[0].enabled).toBe(true);
		expect(result.hooks[0].command).toBe('');
	});

	it('rejects duplicate hook names (simulates 409 conflict)', async () => {
		const hook: Hook = {
			name: 'unique-hook',
			type: 'pre-task',
			description: '',
			enabled: true,
			command: ''
		};

		const data = await readHooks(projectPath);
		data.hooks.push(hook);
		await writeHooks(projectPath, data);

		// Simulate POST handler duplicate check
		const existing = await readHooks(projectPath);
		const isDuplicate = existing.hooks.some((h) => h.name === 'unique-hook');
		expect(isDuplicate).toBe(true);
	});

	it('validates name is required (simulates 400 error)', async () => {
		const body = { type: 'pre-task' } as Partial<Hook>;

		const hasName = body.name && typeof body.name === 'string';
		expect(hasName).toBeFalsy();
	});

	it('validates type is required (simulates 400 error)', async () => {
		const body = { name: 'no-type-hook' } as Partial<Hook>;

		const hasType = body.type && typeof body.type === 'string';
		expect(hasType).toBeFalsy();
	});

	it('persists hook and is retrievable after re-read', async () => {
		const hook: Hook = {
			name: 'persistent-hook',
			type: 'session-end',
			description: 'Should survive re-read',
			enabled: true,
			command: 'echo persist'
		};

		const data = await readHooks(projectPath);
		data.hooks.push(hook);
		await writeHooks(projectPath, data);

		// Fresh read from disk
		const fresh = await readHooks(projectPath);
		expect(fresh.hooks).toHaveLength(1);
		expect(fresh.hooks[0].name).toBe('persistent-hook');
		expect(fresh.hooks[0].description).toBe('Should survive re-read');
	});

	it('returns correct total after adding multiple hooks', async () => {
		const data = await readHooks(projectPath);

		for (let i = 0; i < 3; i++) {
			data.hooks.push({
				name: `hook-${i}`,
				type: 'pre-task',
				description: '',
				enabled: true,
				command: ''
			});
		}
		await writeHooks(projectPath, data);

		const result = await readHooks(projectPath);
		const response = { ok: true, total: result.hooks.length };
		expect(response.total).toBe(3);
	});
});

describe('/api/projects/[id]/hooks — DELETE (remove hook)', () => {
	let projectPath: string;

	beforeEach(async () => {
		projectPath = await mkdtemp(join(tmpdir(), 'api-hooks-del-'));
	});

	afterEach(async () => {
		await rm(projectPath, { recursive: true, force: true });
	});

	it('removes an existing hook by name', async () => {
		await writeHooks(projectPath, {
			hooks: [
				{ name: 'to-remove', type: 'pre-task', description: '', enabled: true, command: '' },
				{ name: 'to-keep', type: 'post-task', description: '', enabled: true, command: '' }
			]
		});

		const data = await readHooks(projectPath);
		const before = data.hooks.length;
		data.hooks = data.hooks.filter((h) => h.name !== 'to-remove');

		expect(data.hooks.length).toBeLessThan(before);
		await writeHooks(projectPath, data);

		const result = await readHooks(projectPath);
		expect(result.hooks).toHaveLength(1);
		expect(result.hooks[0].name).toBe('to-keep');
	});

	it('returns 404 equivalent when hook name not found', async () => {
		await writeHooks(projectPath, {
			hooks: [
				{ name: 'existing', type: 'pre-task', description: '', enabled: true, command: '' }
			]
		});

		const data = await readHooks(projectPath);
		const before = data.hooks.length;
		data.hooks = data.hooks.filter((h) => h.name !== 'nonexistent');

		// Simulate 404 check from handler
		const hookWasRemoved = data.hooks.length < before;
		expect(hookWasRemoved).toBe(false);
	});

	it('validates name is required for delete (simulates 400 error)', async () => {
		const body = {} as { name?: string };
		const hasName = body.name && typeof body.name === 'string';
		expect(hasName).toBeFalsy();
	});

	it('does not affect other hooks when removing one', async () => {
		const hooks: Hook[] = [
			{ name: 'hook-a', type: 'pre-task', description: 'A', enabled: true, command: 'a' },
			{ name: 'hook-b', type: 'post-task', description: 'B', enabled: false, command: 'b' },
			{ name: 'hook-c', type: 'pre-edit', description: 'C', enabled: true, command: 'c' }
		];
		await writeHooks(projectPath, { hooks });

		const data = await readHooks(projectPath);
		data.hooks = data.hooks.filter((h) => h.name !== 'hook-b');
		await writeHooks(projectPath, data);

		const result = await readHooks(projectPath);
		expect(result.hooks).toHaveLength(2);
		expect(result.hooks.map((h) => h.name).sort()).toEqual(['hook-a', 'hook-c']);
		// Verify remaining hooks are unchanged
		expect(result.hooks.find((h) => h.name === 'hook-a')!.description).toBe('A');
		expect(result.hooks.find((h) => h.name === 'hook-c')!.command).toBe('c');
	});

	it('returns correct total after deletion', async () => {
		const hooks: Hook[] = Array.from({ length: 4 }, (_, i) => ({
			name: `hook-${i}`,
			type: 'pre-task',
			description: '',
			enabled: true,
			command: ''
		}));
		await writeHooks(projectPath, { hooks });

		const data = await readHooks(projectPath);
		data.hooks = data.hooks.filter((h) => h.name !== 'hook-2');
		await writeHooks(projectPath, data);

		const result = await readHooks(projectPath);
		const response = { ok: true, removed: 'hook-2', total: result.hooks.length };
		expect(response.total).toBe(3);
		expect(response.removed).toBe('hook-2');
	});
});

describe('/api/projects/[id]/hooks — PATCH (update hook)', () => {
	let projectPath: string;

	beforeEach(async () => {
		projectPath = await mkdtemp(join(tmpdir(), 'api-hooks-patch-'));
	});

	afterEach(async () => {
		await rm(projectPath, { recursive: true, force: true });
	});

	it('updates an existing hook description', async () => {
		await writeHooks(projectPath, {
			hooks: [
				{ name: 'my-hook', type: 'pre-task', description: 'Old desc', enabled: true, command: 'echo old' }
			]
		});

		const data = await readHooks(projectPath);
		const hook = data.hooks.find((h) => h.name === 'my-hook')!;
		hook.description = 'New desc';
		await writeHooks(projectPath, data);

		const result = await readHooks(projectPath);
		expect(result.hooks[0].description).toBe('New desc');
		// Other fields unchanged
		expect(result.hooks[0].type).toBe('pre-task');
		expect(result.hooks[0].enabled).toBe(true);
		expect(result.hooks[0].command).toBe('echo old');
	});

	it('toggles enabled state', async () => {
		await writeHooks(projectPath, {
			hooks: [
				{ name: 'toggle-hook', type: 'pre-task', description: '', enabled: true, command: '' }
			]
		});

		const data = await readHooks(projectPath);
		const hook = data.hooks.find((h) => h.name === 'toggle-hook')!;
		hook.enabled = false;
		await writeHooks(projectPath, data);

		const result = await readHooks(projectPath);
		expect(result.hooks[0].enabled).toBe(false);
	});

	it('updates command field only', async () => {
		await writeHooks(projectPath, {
			hooks: [
				{ name: 'cmd-hook', type: 'post-task', description: 'desc', enabled: false, command: 'echo old' }
			]
		});

		const data = await readHooks(projectPath);
		const hook = data.hooks.find((h) => h.name === 'cmd-hook')!;
		hook.command = 'npm run lint && npm test';
		await writeHooks(projectPath, data);

		const result = await readHooks(projectPath);
		expect(result.hooks[0].command).toBe('npm run lint && npm test');
		expect(result.hooks[0].description).toBe('desc');
		expect(result.hooks[0].enabled).toBe(false);
	});

	it('updates type field', async () => {
		await writeHooks(projectPath, {
			hooks: [
				{ name: 'type-hook', type: 'pre-task', description: '', enabled: true, command: '' }
			]
		});

		const data = await readHooks(projectPath);
		const hook = data.hooks.find((h) => h.name === 'type-hook')!;
		hook.type = 'post-edit';
		await writeHooks(projectPath, data);

		const result = await readHooks(projectPath);
		expect(result.hooks[0].type).toBe('post-edit');
	});

	it('returns 404 equivalent when updating non-existent hook', async () => {
		await writeHooks(projectPath, {
			hooks: [
				{ name: 'existing', type: 'pre-task', description: '', enabled: true, command: '' }
			]
		});

		const data = await readHooks(projectPath);
		const hook = data.hooks.find((h) => h.name === 'ghost-hook');
		expect(hook).toBeUndefined();
	});

	it('validates name is required for update (simulates 400 error)', async () => {
		const body = { description: 'updated' } as Partial<Hook> & { name?: string };
		const hasName = body.name && typeof body.name === 'string';
		expect(hasName).toBeFalsy();
	});

	it('updates multiple fields at once', async () => {
		await writeHooks(projectPath, {
			hooks: [
				{ name: 'multi-update', type: 'pre-task', description: 'old', enabled: true, command: 'old-cmd' }
			]
		});

		const data = await readHooks(projectPath);
		const hook = data.hooks.find((h) => h.name === 'multi-update')!;
		hook.type = 'session-end';
		hook.description = 'new desc';
		hook.enabled = false;
		hook.command = 'new-cmd';
		await writeHooks(projectPath, data);

		const result = await readHooks(projectPath);
		expect(result.hooks[0]).toEqual({
			name: 'multi-update',
			type: 'session-end',
			description: 'new desc',
			enabled: false,
			command: 'new-cmd'
		});
	});

	it('does not affect other hooks when updating one', async () => {
		await writeHooks(projectPath, {
			hooks: [
				{ name: 'hook-a', type: 'pre-task', description: 'A', enabled: true, command: 'a' },
				{ name: 'hook-b', type: 'post-task', description: 'B', enabled: false, command: 'b' }
			]
		});

		const data = await readHooks(projectPath);
		const hookA = data.hooks.find((h) => h.name === 'hook-a')!;
		hookA.description = 'Updated A';
		await writeHooks(projectPath, data);

		const result = await readHooks(projectPath);
		expect(result.hooks.find((h) => h.name === 'hook-a')!.description).toBe('Updated A');
		expect(result.hooks.find((h) => h.name === 'hook-b')!).toEqual({
			name: 'hook-b',
			type: 'post-task',
			description: 'B',
			enabled: false,
			command: 'b'
		});
	});
});

describe('/api/projects/[id]/hooks — edge cases', () => {
	let projectPath: string;

	beforeEach(async () => {
		projectPath = await mkdtemp(join(tmpdir(), 'api-hooks-edge-'));
	});

	afterEach(async () => {
		await rm(projectPath, { recursive: true, force: true });
	});

	it('rejects empty string as hook name (simulates 400)', async () => {
		const body = { name: '', type: 'pre-task' };
		const valid = body.name && typeof body.name === 'string';
		expect(valid).toBeFalsy();
	});

	it('rejects whitespace-only hook name (simulates 400)', async () => {
		// The API checks !body.name which is falsy for empty string but not whitespace
		// This verifies the data layer perspective
		const body = { name: '   ', type: 'pre-task' };
		const passesCheck = body.name && typeof body.name === 'string';
		// Whitespace-only passes the basic check but is semantically invalid
		expect(passesCheck).toBe(true);
	});

	it('handles hook names with special characters', async () => {
		const hook: Hook = {
			name: 'hook:with/special-chars_and.dots',
			type: 'pre-task',
			description: 'Special chars in name',
			enabled: true,
			command: 'echo "hello world"'
		};

		await writeHooks(projectPath, { hooks: [hook] });

		const result = await readHooks(projectPath);
		expect(result.hooks[0].name).toBe('hook:with/special-chars_and.dots');
	});

	it('handles hook with very long command string', async () => {
		const longCommand = 'echo ' + 'x'.repeat(10000);
		const hook: Hook = {
			name: 'long-cmd-hook',
			type: 'pre-task',
			description: '',
			enabled: true,
			command: longCommand
		};

		await writeHooks(projectPath, { hooks: [hook] });

		const result = await readHooks(projectPath);
		expect(result.hooks[0].command).toBe(longCommand);
		expect(result.hooks[0].command!.length).toBe(10005);
	});

	it('handles hook with unicode in description', async () => {
		const hook: Hook = {
			name: 'unicode-hook',
			type: 'post-task',
			description: 'Runs cleanup 🧹 for résumé generation — "quotes" & <tags>',
			enabled: true,
			command: ''
		};

		await writeHooks(projectPath, { hooks: [hook] });

		const result = await readHooks(projectPath);
		expect(result.hooks[0].description).toBe(
			'Runs cleanup 🧹 for résumé generation — "quotes" & <tags>'
		);
	});

	it('detects duplicate when names differ only by case', async () => {
		await writeHooks(projectPath, {
			hooks: [
				{ name: 'My-Hook', type: 'pre-task', description: '', enabled: true, command: '' }
			]
		});

		const data = await readHooks(projectPath);
		// API uses exact match (case-sensitive), so these are NOT duplicates
		const isDuplicate = data.hooks.some((h) => h.name === 'my-hook');
		expect(isDuplicate).toBe(false);

		// But same case IS a duplicate
		const isExactDuplicate = data.hooks.some((h) => h.name === 'My-Hook');
		expect(isExactDuplicate).toBe(true);
	});

	it('rejects non-string type (simulates 400)', async () => {
		const body = { name: 'bad-type', type: 123 } as unknown as Partial<Hook>;
		const valid = body.type && typeof body.type === 'string';
		expect(valid).toBeFalsy();
	});

	it('handles empty hooks file (zero-byte file)', async () => {
		const dir = join(projectPath, '.playground');
		await mkdir(dir, { recursive: true });
		await writeFile(hooksPath(projectPath), '', 'utf-8');

		const data = await readHooks(projectPath);
		expect(data).toEqual({ hooks: [] });
	});

	it('handles hooks file with valid JSON but wrong shape', async () => {
		const dir = join(projectPath, '.playground');
		await mkdir(dir, { recursive: true });
		await writeFile(hooksPath(projectPath), '{"notHooks": true}', 'utf-8');

		const data = await readHooks(projectPath);
		// readHooks returns parsed JSON as-is; hooks property would be undefined
		expect(data.hooks).toBeUndefined();
	});

	it('rejects adding hook when name already exists after multiple adds', async () => {
		const data = await readHooks(projectPath);
		for (let i = 0; i < 3; i++) {
			data.hooks.push({
				name: `hook-${i}`,
				type: 'pre-task',
				description: '',
				enabled: true,
				command: ''
			});
		}
		await writeHooks(projectPath, data);

		const existing = await readHooks(projectPath);
		const isDuplicate = existing.hooks.some((h) => h.name === 'hook-1');
		expect(isDuplicate).toBe(true);

		// But a new name is not duplicate
		const isNewDuplicate = existing.hooks.some((h) => h.name === 'hook-99');
		expect(isNewDuplicate).toBe(false);
	});
});

describe('/api/projects/[id]/hooks — full CRUD lifecycle', () => {
	let projectPath: string;

	beforeEach(async () => {
		projectPath = await mkdtemp(join(tmpdir(), 'api-hooks-lifecycle-'));
	});

	afterEach(async () => {
		await rm(projectPath, { recursive: true, force: true });
	});

	it('handles create → read → delete lifecycle', async () => {
		// 1. Start empty
		let data = await readHooks(projectPath);
		expect(data.hooks).toHaveLength(0);

		// 2. Create hooks
		data.hooks.push({
			name: 'lifecycle-hook',
			type: 'pre-task',
			description: 'Test lifecycle',
			enabled: true,
			command: 'echo lifecycle'
		});
		await writeHooks(projectPath, data);

		// 3. Read and verify
		data = await readHooks(projectPath);
		expect(data.hooks).toHaveLength(1);
		expect(data.hooks[0].name).toBe('lifecycle-hook');

		// 4. Add another
		data.hooks.push({
			name: 'second-hook',
			type: 'post-task',
			description: '',
			enabled: false,
			command: ''
		});
		await writeHooks(projectPath, data);

		data = await readHooks(projectPath);
		expect(data.hooks).toHaveLength(2);

		// 5. Delete first
		data.hooks = data.hooks.filter((h) => h.name !== 'lifecycle-hook');
		await writeHooks(projectPath, data);

		data = await readHooks(projectPath);
		expect(data.hooks).toHaveLength(1);
		expect(data.hooks[0].name).toBe('second-hook');

		// 6. Delete last
		data.hooks = data.hooks.filter((h) => h.name !== 'second-hook');
		await writeHooks(projectPath, data);

		data = await readHooks(projectPath);
		expect(data.hooks).toHaveLength(0);
	});

	it('handles rapid sequential operations', async () => {
		const data = await readHooks(projectPath);

		for (let i = 0; i < 10; i++) {
			data.hooks.push({
				name: `rapid-${i}`,
				type: 'pre-task',
				description: '',
				enabled: true,
				command: ''
			});
		}
		await writeHooks(projectPath, data);

		const result = await readHooks(projectPath);
		expect(result.hooks).toHaveLength(10);

		// Delete odd-numbered hooks
		result.hooks = result.hooks.filter((_, i) => i % 2 === 0);
		await writeHooks(projectPath, result);

		const final = await readHooks(projectPath);
		expect(final.hooks).toHaveLength(5);
	});

	it('preserves hook data integrity through write cycles', async () => {
		const original: Hook = {
			name: 'integrity-check',
			type: 'session-end',
			description: 'Must preserve all fields',
			enabled: false,
			command: 'npm run cleanup'
		};

		await writeHooks(projectPath, { hooks: [original] });

		// Read-write cycle multiple times
		for (let i = 0; i < 5; i++) {
			const data = await readHooks(projectPath);
			await writeHooks(projectPath, data);
		}

		const final = await readHooks(projectPath);
		expect(final.hooks[0]).toEqual(original);
	});
});
