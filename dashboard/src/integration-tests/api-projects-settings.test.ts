import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Integration tests for /api/projects/[id]/settings endpoint.
 *
 * These tests exercise the same data-loading, validation, and persistence
 * logic the GET/PUT handlers use, verifying correct JSON shape, defaults,
 * validation rules, and round-trip read/write behavior.
 */

// ── Types ────────────────────────────────────────────────────────────────

interface AgentConfig {
	topology: string;
	maxAgents: number;
	memoryBackend: string;
	consensus: string;
}

interface ProjectSettings {
	name: string;
	description: string;
	branch: string;
	agentConfig: AgentConfig;
	build: Record<string, { command: string; label: string }>;
}

// ── Logic under test (mirrors +server.ts) ────────────────────────────────

function defaultSettings(projectPath: string): ProjectSettings {
	return {
		name: projectPath.split(/[\\/]/).pop() ?? 'unknown',
		description: '',
		branch: 'main',
		agentConfig: {
			topology: 'hierarchical-mesh',
			maxAgents: 15,
			memoryBackend: 'hybrid (HNSW + SQLite)',
			consensus: 'raft'
		},
		build: {
			dev: { command: 'npm run dev', label: 'Development server' },
			build: { command: 'npm run build', label: 'Production build' },
			test: { command: 'npm test', label: 'Test suite' }
		}
	};
}

function settingsPath(projectPath: string): string {
	return join(projectPath, '.playground', 'settings.json');
}

async function readSettings(projectPath: string): Promise<ProjectSettings> {
	try {
		const raw = await readFile(settingsPath(projectPath), 'utf-8');
		return { ...defaultSettings(projectPath), ...JSON.parse(raw) };
	} catch {
		return defaultSettings(projectPath);
	}
}

async function writeSettings(projectPath: string, data: ProjectSettings): Promise<void> {
	const dir = join(projectPath, '.playground');
	await mkdir(dir, { recursive: true });
	await writeFile(settingsPath(projectPath), JSON.stringify(data, null, '\t'), 'utf-8');
}

function validateSettings(
	body: unknown
): { valid: true; data: ProjectSettings } | { valid: false; error: string } {
	if (!body || typeof body !== 'object') {
		return { valid: false, error: 'Request body must be an object' };
	}

	const b = body as Record<string, unknown>;

	if (typeof b.name !== 'string' || b.name.trim().length === 0) {
		return { valid: false, error: 'Project name is required' };
	}
	if (b.name.trim().length > 100) {
		return { valid: false, error: 'Project name must be 100 characters or fewer' };
	}
	if (typeof b.description !== 'string') {
		return { valid: false, error: 'Description must be a string' };
	}
	if (typeof b.branch !== 'string' || b.branch.trim().length === 0) {
		return { valid: false, error: 'Default branch is required' };
	}

	const ac = b.agentConfig;
	if (!ac || typeof ac !== 'object') {
		return { valid: false, error: 'agentConfig is required' };
	}
	const agent = ac as Record<string, unknown>;
	if (typeof agent.maxAgents !== 'number' || agent.maxAgents < 1 || agent.maxAgents > 100) {
		return { valid: false, error: 'Max agents must be between 1 and 100' };
	}

	return {
		valid: true,
		data: {
			name: b.name as string,
			description: (b.description as string) ?? '',
			branch: b.branch as string,
			agentConfig: {
				topology: (agent.topology as string) ?? 'hierarchical-mesh',
				maxAgents: agent.maxAgents as number,
				memoryBackend: (agent.memoryBackend as string) ?? 'hybrid (HNSW + SQLite)',
				consensus: (agent.consensus as string) ?? 'raft'
			},
			build: (b.build as Record<string, { command: string; label: string }>) ?? {}
		}
	};
}

// ── Fixtures ─────────────────────────────────────────────────────────────

function makeValidSettings(overrides: Partial<ProjectSettings> = {}): ProjectSettings {
	return {
		name: 'test-project',
		description: 'A test project for integration tests',
		branch: 'main',
		agentConfig: {
			topology: 'hierarchical-mesh',
			maxAgents: 8,
			memoryBackend: 'hybrid (HNSW + SQLite)',
			consensus: 'raft'
		},
		build: {
			dev: { command: 'npm run dev', label: 'Dev server' },
			build: { command: 'npm run build', label: 'Build' }
		},
		...overrides
	};
}

function makeValidBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		name: 'test-project',
		description: 'A test project',
		branch: 'main',
		agentConfig: {
			topology: 'hierarchical-mesh',
			maxAgents: 8,
			memoryBackend: 'hybrid (HNSW + SQLite)',
			consensus: 'raft'
		},
		build: {},
		...overrides
	};
}

// ── Tests: GET (readSettings + defaults) ─────────────────────────────────

describe('/api/projects/[id]/settings — GET', () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), 'api-settings-get-'));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it('returns default settings when no settings file exists', async () => {
		const result = await readSettings(tmpDir);
		const dirName = tmpDir.split(/[\\/]/).pop()!;

		expect(result.name).toBe(dirName);
		expect(result.description).toBe('');
		expect(result.branch).toBe('main');
		expect(result.agentConfig).toEqual({
			topology: 'hierarchical-mesh',
			maxAgents: 15,
			memoryBackend: 'hybrid (HNSW + SQLite)',
			consensus: 'raft'
		});
		expect(result.build).toHaveProperty('dev');
		expect(result.build).toHaveProperty('build');
		expect(result.build).toHaveProperty('test');
	});

	it('returns persisted settings when file exists', async () => {
		const settings = makeValidSettings({ name: 'my-project', description: 'Persisted' });
		await writeSettings(tmpDir, settings);

		const result = await readSettings(tmpDir);

		expect(result.name).toBe('my-project');
		expect(result.description).toBe('Persisted');
		expect(result.agentConfig.maxAgents).toBe(8);
	});

	it('merges persisted settings with defaults for missing fields', async () => {
		// Write partial settings (missing build, description)
		const dir = join(tmpDir, '.playground');
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, 'settings.json'),
			JSON.stringify({ name: 'partial', branch: 'develop' })
		);

		const result = await readSettings(tmpDir);

		expect(result.name).toBe('partial');
		expect(result.branch).toBe('develop');
		// Defaults should fill in the rest
		expect(result.agentConfig).toEqual({
			topology: 'hierarchical-mesh',
			maxAgents: 15,
			memoryBackend: 'hybrid (HNSW + SQLite)',
			consensus: 'raft'
		});
		expect(result.build).toHaveProperty('dev');
		expect(result.build).toHaveProperty('test');
	});

	it('returns defaults when settings file contains invalid JSON', async () => {
		const dir = join(tmpDir, '.playground');
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, 'settings.json'), '{ broken json !!!');

		const result = await readSettings(tmpDir);
		const dirName = tmpDir.split(/[\\/]/).pop()!;

		expect(result.name).toBe(dirName);
		expect(result.branch).toBe('main');
		expect(result.agentConfig.maxAgents).toBe(15);
	});
});

// ── Tests: PUT validation ────────────────────────────────────────────────

describe('/api/projects/[id]/settings — PUT validation', () => {
	it('rejects null body', () => {
		const result = validateSettings(null);
		expect(result.valid).toBe(false);
		if (!result.valid) expect(result.error).toBe('Request body must be an object');
	});

	it('rejects non-object body', () => {
		const result = validateSettings('string-body');
		expect(result.valid).toBe(false);
		if (!result.valid) expect(result.error).toBe('Request body must be an object');
	});

	it('rejects missing project name', () => {
		const result = validateSettings(makeValidBody({ name: undefined }));
		expect(result.valid).toBe(false);
		if (!result.valid) expect(result.error).toBe('Project name is required');
	});

	it('rejects empty project name', () => {
		const result = validateSettings(makeValidBody({ name: '   ' }));
		expect(result.valid).toBe(false);
		if (!result.valid) expect(result.error).toBe('Project name is required');
	});

	it('rejects project name over 100 characters', () => {
		const longName = 'a'.repeat(101);
		const result = validateSettings(makeValidBody({ name: longName }));
		expect(result.valid).toBe(false);
		if (!result.valid) expect(result.error).toBe('Project name must be 100 characters or fewer');
	});

	it('accepts project name at exactly 100 characters', () => {
		const exactName = 'a'.repeat(100);
		const result = validateSettings(makeValidBody({ name: exactName }));
		expect(result.valid).toBe(true);
		if (result.valid) expect(result.data.name).toBe(exactName);
	});

	it('rejects non-string description', () => {
		const result = validateSettings(makeValidBody({ description: 123 }));
		expect(result.valid).toBe(false);
		if (!result.valid) expect(result.error).toBe('Description must be a string');
	});

	it('rejects missing branch', () => {
		const result = validateSettings(makeValidBody({ branch: '' }));
		expect(result.valid).toBe(false);
		if (!result.valid) expect(result.error).toBe('Default branch is required');
	});

	it('rejects missing agentConfig', () => {
		const result = validateSettings(makeValidBody({ agentConfig: undefined }));
		expect(result.valid).toBe(false);
		if (!result.valid) expect(result.error).toBe('agentConfig is required');
	});

	it('rejects non-object agentConfig', () => {
		const result = validateSettings(makeValidBody({ agentConfig: 'flat' }));
		expect(result.valid).toBe(false);
		if (!result.valid) expect(result.error).toBe('agentConfig is required');
	});

	it('rejects maxAgents below 1', () => {
		const result = validateSettings(
			makeValidBody({ agentConfig: { maxAgents: 0, topology: 'mesh' } })
		);
		expect(result.valid).toBe(false);
		if (!result.valid) expect(result.error).toBe('Max agents must be between 1 and 100');
	});

	it('rejects maxAgents above 100', () => {
		const result = validateSettings(
			makeValidBody({ agentConfig: { maxAgents: 101, topology: 'mesh' } })
		);
		expect(result.valid).toBe(false);
		if (!result.valid) expect(result.error).toBe('Max agents must be between 1 and 100');
	});

	it('rejects non-number maxAgents', () => {
		const result = validateSettings(
			makeValidBody({ agentConfig: { maxAgents: 'ten', topology: 'mesh' } })
		);
		expect(result.valid).toBe(false);
		if (!result.valid) expect(result.error).toBe('Max agents must be between 1 and 100');
	});

	it('accepts maxAgents at boundary values (1 and 100)', () => {
		const result1 = validateSettings(
			makeValidBody({ agentConfig: { maxAgents: 1, topology: 'mesh' } })
		);
		expect(result1.valid).toBe(true);

		const result100 = validateSettings(
			makeValidBody({ agentConfig: { maxAgents: 100, topology: 'mesh' } })
		);
		expect(result100.valid).toBe(true);
	});

	it('accepts a fully valid body and returns correct data shape', () => {
		const body = makeValidBody();
		const result = validateSettings(body);

		expect(result.valid).toBe(true);
		if (!result.valid) return;

		expect(result.data).toEqual({
			name: 'test-project',
			description: 'A test project',
			branch: 'main',
			agentConfig: {
				topology: 'hierarchical-mesh',
				maxAgents: 8,
				memoryBackend: 'hybrid (HNSW + SQLite)',
				consensus: 'raft'
			},
			build: {}
		});
	});

	it('fills in agentConfig defaults for missing optional fields', () => {
		const body = makeValidBody({ agentConfig: { maxAgents: 5 } });
		const result = validateSettings(body);

		expect(result.valid).toBe(true);
		if (!result.valid) return;

		expect(result.data.agentConfig.topology).toBe('hierarchical-mesh');
		expect(result.data.agentConfig.memoryBackend).toBe('hybrid (HNSW + SQLite)');
		expect(result.data.agentConfig.consensus).toBe('raft');
		expect(result.data.agentConfig.maxAgents).toBe(5);
	});
});

// ── Tests: PUT persistence (round-trip) ──────────────────────────────────

describe('/api/projects/[id]/settings — PUT persistence', () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), 'api-settings-put-'));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it('writes settings and reads them back correctly', async () => {
		const settings = makeValidSettings({
			name: 'roundtrip-project',
			description: 'Testing round-trip',
			branch: 'develop',
			agentConfig: {
				topology: 'star',
				maxAgents: 6,
				memoryBackend: 'sqlite',
				consensus: 'pbft'
			}
		});

		await writeSettings(tmpDir, settings);
		const result = await readSettings(tmpDir);

		expect(result.name).toBe('roundtrip-project');
		expect(result.description).toBe('Testing round-trip');
		expect(result.branch).toBe('develop');
		expect(result.agentConfig.topology).toBe('star');
		expect(result.agentConfig.maxAgents).toBe(6);
		expect(result.agentConfig.memoryBackend).toBe('sqlite');
		expect(result.agentConfig.consensus).toBe('pbft');
	});

	it('creates .playground directory if it does not exist', async () => {
		const settings = makeValidSettings();
		await writeSettings(tmpDir, settings);

		const raw = await readFile(settingsPath(tmpDir), 'utf-8');
		const parsed = JSON.parse(raw);
		expect(parsed.name).toBe('test-project');
	});

	it('overwrites existing settings on second PUT', async () => {
		const first = makeValidSettings({ name: 'first-version' });
		await writeSettings(tmpDir, first);

		const second = makeValidSettings({ name: 'second-version', branch: 'release' });
		await writeSettings(tmpDir, second);

		const result = await readSettings(tmpDir);
		expect(result.name).toBe('second-version');
		expect(result.branch).toBe('release');
	});
});

// ── Tests: Autoscale settings logic ──────────────────────────────────────

describe('/api/settings/autoscale — validation and clamping', () => {
	const AUTOSCALE_DEFAULTS = {
		minSlots: 4,
		maxSlots: 14,
		tasksPerSlot: 2,
		idleCooldownMs: 5 * 60 * 1000
	};

	function clampAutoscale(body: Record<string, unknown>) {
		const defaults = AUTOSCALE_DEFAULTS;
		const minSlots =
			typeof body.minSlots === 'number'
				? Math.max(1, Math.min(50, body.minSlots))
				: defaults.minSlots;
		const maxSlots =
			typeof body.maxSlots === 'number'
				? Math.max(1, Math.min(50, body.maxSlots))
				: defaults.maxSlots;

		return {
			minSlots: Math.min(minSlots, maxSlots),
			maxSlots: Math.max(minSlots, maxSlots),
			tasksPerSlot:
				typeof body.tasksPerSlot === 'number'
					? Math.max(1, Math.min(10, body.tasksPerSlot))
					: defaults.tasksPerSlot,
			idleCooldownMs:
				typeof body.idleCooldownMs === 'number'
					? Math.max(30000, Math.min(3600000, body.idleCooldownMs))
					: defaults.idleCooldownMs
		};
	}

	it('returns defaults for empty body', () => {
		const result = clampAutoscale({});
		expect(result).toEqual(AUTOSCALE_DEFAULTS);
	});

	it('clamps minSlots to [1, 50]', () => {
		expect(clampAutoscale({ minSlots: 0, maxSlots: 10 }).minSlots).toBe(1);
		expect(clampAutoscale({ minSlots: 100, maxSlots: 100 }).minSlots).toBe(50);
	});

	it('clamps maxSlots to [1, 50]', () => {
		expect(clampAutoscale({ maxSlots: -5 }).maxSlots).toBe(AUTOSCALE_DEFAULTS.minSlots);
		expect(clampAutoscale({ maxSlots: 200 }).maxSlots).toBe(50);
	});

	it('swaps min/max when minSlots > maxSlots', () => {
		const result = clampAutoscale({ minSlots: 20, maxSlots: 5 });
		expect(result.minSlots).toBe(5);
		expect(result.maxSlots).toBe(20);
	});

	it('clamps tasksPerSlot to [1, 10]', () => {
		expect(clampAutoscale({ tasksPerSlot: 0 }).tasksPerSlot).toBe(1);
		expect(clampAutoscale({ tasksPerSlot: 99 }).tasksPerSlot).toBe(10);
		expect(clampAutoscale({ tasksPerSlot: 5 }).tasksPerSlot).toBe(5);
	});

	it('clamps idleCooldownMs to [30000, 3600000]', () => {
		expect(clampAutoscale({ idleCooldownMs: 1000 }).idleCooldownMs).toBe(30000);
		expect(clampAutoscale({ idleCooldownMs: 9999999 }).idleCooldownMs).toBe(3600000);
		expect(clampAutoscale({ idleCooldownMs: 120000 }).idleCooldownMs).toBe(120000);
	});

	it('ignores non-number fields and uses defaults', () => {
		const result = clampAutoscale({
			minSlots: 'five',
			maxSlots: null,
			tasksPerSlot: true,
			idleCooldownMs: undefined
		});
		expect(result).toEqual(AUTOSCALE_DEFAULTS);
	});
});

// ── Tests: Memory settings validation ────────────────────────────────────

describe('/api/settings/memory — validation and defaults', () => {
	type MemoryBackend = 'hybrid' | 'sqlite' | 'hnsw';

	const VALID_BACKENDS: MemoryBackend[] = ['hybrid', 'sqlite', 'hnsw'];

	const MEMORY_DEFAULTS = {
		backend: 'hybrid' as MemoryBackend,
		enableHNSW: true,
		cacheSize: 100,
		persistPath: '.claude-flow/data',
		learningBridgeEnabled: true,
		memoryGraphEnabled: true
	};

	function validateMemory(body: Record<string, unknown>) {
		const backend = VALID_BACKENDS.includes(body.backend as MemoryBackend)
			? (body.backend as MemoryBackend)
			: MEMORY_DEFAULTS.backend;

		const rawCache = Number(body.cacheSize);
		const cacheSize =
			!isNaN(rawCache) && rawCache >= 10 && rawCache <= 10000
				? rawCache
				: MEMORY_DEFAULTS.cacheSize;

		return {
			backend,
			enableHNSW:
				typeof body.enableHNSW === 'boolean'
					? body.enableHNSW
					: MEMORY_DEFAULTS.enableHNSW,
			cacheSize,
			persistPath:
				typeof body.persistPath === 'string' && body.persistPath
					? body.persistPath
					: MEMORY_DEFAULTS.persistPath,
			learningBridgeEnabled:
				typeof body.learningBridgeEnabled === 'boolean'
					? body.learningBridgeEnabled
					: MEMORY_DEFAULTS.learningBridgeEnabled,
			memoryGraphEnabled:
				typeof body.memoryGraphEnabled === 'boolean'
					? body.memoryGraphEnabled
					: MEMORY_DEFAULTS.memoryGraphEnabled
		};
	}

	it('returns defaults for empty body', () => {
		expect(validateMemory({})).toEqual(MEMORY_DEFAULTS);
	});

	it('accepts valid backends', () => {
		expect(validateMemory({ backend: 'sqlite' }).backend).toBe('sqlite');
		expect(validateMemory({ backend: 'hnsw' }).backend).toBe('hnsw');
		expect(validateMemory({ backend: 'hybrid' }).backend).toBe('hybrid');
	});

	it('falls back to default for invalid backend', () => {
		expect(validateMemory({ backend: 'redis' }).backend).toBe('hybrid');
		expect(validateMemory({ backend: 123 }).backend).toBe('hybrid');
	});

	it('clamps cacheSize to [10, 10000]', () => {
		expect(validateMemory({ cacheSize: 5 }).cacheSize).toBe(MEMORY_DEFAULTS.cacheSize);
		expect(validateMemory({ cacheSize: 50000 }).cacheSize).toBe(MEMORY_DEFAULTS.cacheSize);
		expect(validateMemory({ cacheSize: 500 }).cacheSize).toBe(500);
		expect(validateMemory({ cacheSize: 10 }).cacheSize).toBe(10);
		expect(validateMemory({ cacheSize: 10000 }).cacheSize).toBe(10000);
	});

	it('falls back for non-numeric cacheSize', () => {
		expect(validateMemory({ cacheSize: 'big' }).cacheSize).toBe(MEMORY_DEFAULTS.cacheSize);
		expect(validateMemory({ cacheSize: NaN }).cacheSize).toBe(MEMORY_DEFAULTS.cacheSize);
	});

	it('accepts boolean flags', () => {
		const result = validateMemory({
			enableHNSW: false,
			learningBridgeEnabled: false,
			memoryGraphEnabled: false
		});
		expect(result.enableHNSW).toBe(false);
		expect(result.learningBridgeEnabled).toBe(false);
		expect(result.memoryGraphEnabled).toBe(false);
	});

	it('falls back for non-boolean flags', () => {
		const result = validateMemory({
			enableHNSW: 'yes',
			learningBridgeEnabled: 1,
			memoryGraphEnabled: null
		});
		expect(result.enableHNSW).toBe(MEMORY_DEFAULTS.enableHNSW);
		expect(result.learningBridgeEnabled).toBe(MEMORY_DEFAULTS.learningBridgeEnabled);
		expect(result.memoryGraphEnabled).toBe(MEMORY_DEFAULTS.memoryGraphEnabled);
	});

	it('falls back for empty persistPath', () => {
		expect(validateMemory({ persistPath: '' }).persistPath).toBe(MEMORY_DEFAULTS.persistPath);
		expect(validateMemory({ persistPath: 123 }).persistPath).toBe(MEMORY_DEFAULTS.persistPath);
	});

	it('accepts custom persistPath', () => {
		expect(validateMemory({ persistPath: '/data/memory' }).persistPath).toBe('/data/memory');
	});
});

// ── Tests: General settings validation ───────────────────────────────────

describe('/api/settings/general — validation and defaults', () => {
	const GENERAL_DEFAULTS = {
		requireConfirmation: true,
		autoApproveLowRisk: false,
		showCommandsInInputBar: true,
		defaultTimeout: '30 minutes',
		projectOverride: true
	};

	function validateGeneral(body: Record<string, unknown>) {
		return {
			requireConfirmation:
				typeof body.requireConfirmation === 'boolean'
					? body.requireConfirmation
					: GENERAL_DEFAULTS.requireConfirmation,
			autoApproveLowRisk:
				typeof body.autoApproveLowRisk === 'boolean'
					? body.autoApproveLowRisk
					: GENERAL_DEFAULTS.autoApproveLowRisk,
			showCommandsInInputBar:
				typeof body.showCommandsInInputBar === 'boolean'
					? body.showCommandsInInputBar
					: GENERAL_DEFAULTS.showCommandsInInputBar,
			defaultTimeout:
				typeof body.defaultTimeout === 'string'
					? body.defaultTimeout
					: GENERAL_DEFAULTS.defaultTimeout,
			projectOverride:
				typeof body.projectOverride === 'boolean'
					? body.projectOverride
					: GENERAL_DEFAULTS.projectOverride
		};
	}

	it('returns defaults for empty body', () => {
		expect(validateGeneral({})).toEqual(GENERAL_DEFAULTS);
	});

	it('accepts valid boolean overrides', () => {
		const result = validateGeneral({
			requireConfirmation: false,
			autoApproveLowRisk: true,
			showCommandsInInputBar: false,
			projectOverride: false
		});
		expect(result.requireConfirmation).toBe(false);
		expect(result.autoApproveLowRisk).toBe(true);
		expect(result.showCommandsInInputBar).toBe(false);
		expect(result.projectOverride).toBe(false);
	});

	it('falls back for non-boolean fields', () => {
		const result = validateGeneral({
			requireConfirmation: 'yes',
			autoApproveLowRisk: 1,
			projectOverride: null
		});
		expect(result.requireConfirmation).toBe(GENERAL_DEFAULTS.requireConfirmation);
		expect(result.autoApproveLowRisk).toBe(GENERAL_DEFAULTS.autoApproveLowRisk);
		expect(result.projectOverride).toBe(GENERAL_DEFAULTS.projectOverride);
	});

	it('accepts custom timeout string', () => {
		expect(validateGeneral({ defaultTimeout: '60 minutes' }).defaultTimeout).toBe('60 minutes');
		expect(validateGeneral({ defaultTimeout: 'No timeout' }).defaultTimeout).toBe('No timeout');
	});

	it('falls back for non-string timeout', () => {
		expect(validateGeneral({ defaultTimeout: 60 }).defaultTimeout).toBe(
			GENERAL_DEFAULTS.defaultTimeout
		);
	});
});

// ── Tests: End-to-end realistic scenario ─────────────────────────────────

describe('/api/projects/[id]/settings — end-to-end scenario', () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), 'api-settings-e2e-'));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it('simulates full settings lifecycle: defaults → validate → save → read', async () => {
		// 1. GET defaults (no file)
		const defaults = await readSettings(tmpDir);
		expect(defaults.branch).toBe('main');
		expect(defaults.agentConfig.maxAgents).toBe(15);

		// 2. Validate a PUT body
		const body = makeValidBody({
			name: 'production-app',
			description: 'Our main application',
			branch: 'release/v2',
			agentConfig: {
				topology: 'star',
				maxAgents: 10,
				memoryBackend: 'hnsw',
				consensus: 'pbft'
			},
			build: {
				ci: { command: 'npm run ci', label: 'CI pipeline' }
			}
		});

		const validation = validateSettings(body);
		expect(validation.valid).toBe(true);
		if (!validation.valid) return;

		// 3. Write the validated settings
		await writeSettings(tmpDir, validation.data);

		// 4. Read back and verify
		const saved = await readSettings(tmpDir);
		expect(saved.name).toBe('production-app');
		expect(saved.description).toBe('Our main application');
		expect(saved.branch).toBe('release/v2');
		expect(saved.agentConfig.topology).toBe('star');
		expect(saved.agentConfig.maxAgents).toBe(10);
		expect(saved.build.ci).toEqual({ command: 'npm run ci', label: 'CI pipeline' });
	});

	it('validates then rejects invalid body without affecting stored settings', async () => {
		// Save initial settings
		const initial = makeValidSettings({ name: 'stable' });
		await writeSettings(tmpDir, initial);

		// Attempt to validate an invalid body
		const badBody = makeValidBody({ name: '', agentConfig: { maxAgents: 999 } });
		const result = validateSettings(badBody);
		expect(result.valid).toBe(false);

		// Settings should remain untouched
		const current = await readSettings(tmpDir);
		expect(current.name).toBe('stable');
	});

	it('handles special characters in project name and description', async () => {
		const body = makeValidBody({
			name: 'my-project (v2.0) — beta',
			description: 'Has "quotes", <tags>, & ampersands'
		});

		const result = validateSettings(body);
		expect(result.valid).toBe(true);
		if (!result.valid) return;

		await writeSettings(tmpDir, result.data);
		const saved = await readSettings(tmpDir);

		expect(saved.name).toBe('my-project (v2.0) — beta');
		expect(saved.description).toBe('Has "quotes", <tags>, & ampersands');
	});
});
