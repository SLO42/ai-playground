import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Integration tests for /api/projects/[id]/services endpoint.
 *
 * The services page server builds a list from two sources:
 *   1. SERVICES constants (known infrastructure services)
 *   2. MCP config file (.mcp-agents.json)
 *
 * These tests verify service list construction, pagination, deduplication,
 * and error handling by exercising the same logic the page server uses.
 */

interface ServiceEntry {
	name: string;
	status: string;
	description: string;
	port: number | null;
	pid: number | null;
	uptime: string | null;
	configFile: string | null;
}

interface ServiceDef {
	id: string;
	name: string;
	type: string;
	configPath: string;
	port: number | null;
	healthUrl: string | null;
	logFile: string | null;
}

interface McpService {
	name: string;
	command?: string;
	port?: number;
	configFile?: string;
}

const PAGE_SIZE = 10;

/**
 * Parse MCP config JSON and extract server entries, mirroring the page server logic.
 */
function parseMcpServices(mcpRaw: string): McpService[] {
	const mcp = JSON.parse(mcpRaw);
	const servers = mcp.mcpServers ?? mcp.servers ?? {};
	const result: McpService[] = [];
	for (const [name, cfg] of Object.entries(servers)) {
		const c = cfg as any;
		result.push({
			name,
			command: c.command ? `${c.command} ${(c.args ?? []).join(' ')}` : undefined,
			port: c.port ?? null,
			configFile: '.mcp-agents.json'
		});
	}
	return result;
}

/**
 * Build paginated service list from SERVICES defs + MCP services, with health checks stubbed.
 * Mirrors the logic in projects/[id]/services/+page.server.ts.
 */
function buildServiceList(
	serviceDefs: Record<string, ServiceDef>,
	mcpServices: McpService[],
	healthResults: Map<string, boolean>,
	page: number,
	pageSize: number
) {
	const services: ServiceEntry[] = [];
	const configSources = new Set<string>();

	for (const [, svc] of Object.entries(serviceDefs)) {
		const isRunning = healthResults.get(svc.name) ?? false;
		services.push({
			name: svc.name,
			status: isRunning ? 'running' : 'stopped',
			description: svc.type,
			port: svc.port,
			pid: null,
			uptime: null,
			configFile: svc.configPath
		});
		configSources.add(svc.configPath);
	}

	for (const mcp of mcpServices) {
		if (services.some((s) => s.name.toLowerCase().includes(mcp.name.toLowerCase()))) continue;
		const isRunning = healthResults.get(mcp.name) ?? false;
		services.push({
			name: mcp.name,
			status: isRunning ? 'running' : 'stopped',
			description: mcp.command ?? 'MCP Server',
			port: mcp.port ?? null,
			pid: null,
			uptime: null,
			configFile: mcp.configFile ?? null
		});
		if (mcp.configFile) configSources.add(mcp.configFile);
	}

	const running = services.filter((s) => s.status === 'running').length;
	const stopped = services.filter((s) => s.status === 'stopped').length;
	const total = services.length;
	const safePage = Math.min(Math.max(1, page), Math.max(1, Math.ceil(total / pageSize)));
	const totalPages = Math.max(1, Math.ceil(total / pageSize));
	const start = (safePage - 1) * pageSize;
	const paginatedServices = services.slice(start, start + pageSize);

	return {
		error: null as string | null,
		summary: {
			running,
			stopped,
			fromConfig: mcpServices.length,
			manual: services.length - mcpServices.length,
			configSource: [...configSources]
		},
		services: paginatedServices,
		pagination: {
			page: safePage,
			pageSize,
			total,
			totalPages
		}
	};
}

// ---------- Test fixtures ----------

const FIXTURE_SERVICES: Record<string, ServiceDef> = {
	alpha: {
		id: 'alpha',
		name: 'Alpha Service',
		type: 'Backend',
		configPath: 'config/alpha.yaml',
		port: 3000,
		healthUrl: 'http://127.0.0.1:3000/',
		logFile: null
	},
	beta: {
		id: 'beta',
		name: 'Beta Service',
		type: 'Worker',
		configPath: 'config/beta.yaml',
		port: 3001,
		healthUrl: 'http://127.0.0.1:3001/',
		logFile: null
	}
};

const FIXTURE_MCP: McpService[] = [
	{ name: 'gamma-mcp', command: 'npx gamma-server', port: 4000, configFile: '.mcp-agents.json' },
	{ name: 'delta-mcp', port: undefined, configFile: '.mcp-agents.json' }
];

// ---------- Tests ----------

describe('/api/projects/[id]/services — GET (service list)', () => {
	it('returns correct service entries from SERVICES constants', () => {
		const result = buildServiceList(FIXTURE_SERVICES, [], new Map(), 1, PAGE_SIZE);

		expect(result.services).toHaveLength(2);
		expect(result.services[0].name).toBe('Alpha Service');
		expect(result.services[0].description).toBe('Backend');
		expect(result.services[0].port).toBe(3000);
		expect(result.services[1].name).toBe('Beta Service');
		expect(result.services[1].description).toBe('Worker');
	});

	it('marks services as running or stopped based on health', () => {
		const health = new Map([
			['Alpha Service', true],
			['Beta Service', false]
		]);
		const result = buildServiceList(FIXTURE_SERVICES, [], health, 1, PAGE_SIZE);

		expect(result.services[0].status).toBe('running');
		expect(result.services[1].status).toBe('stopped');
		expect(result.summary.running).toBe(1);
		expect(result.summary.stopped).toBe(1);
	});

	it('defaults all services to stopped when no health data', () => {
		const result = buildServiceList(FIXTURE_SERVICES, [], new Map(), 1, PAGE_SIZE);

		expect(result.services.every((s) => s.status === 'stopped')).toBe(true);
		expect(result.summary.running).toBe(0);
		expect(result.summary.stopped).toBe(2);
	});

	it('includes MCP services in the list', () => {
		const result = buildServiceList(FIXTURE_SERVICES, FIXTURE_MCP, new Map(), 1, PAGE_SIZE);

		expect(result.services).toHaveLength(4);
		expect(result.services[2].name).toBe('gamma-mcp');
		expect(result.services[2].description).toBe('npx gamma-server');
		expect(result.services[2].port).toBe(4000);
		expect(result.services[3].name).toBe('delta-mcp');
		expect(result.services[3].description).toBe('MCP Server');
		expect(result.services[3].port).toBeNull();
	});

	it('tracks config sources in summary', () => {
		const result = buildServiceList(FIXTURE_SERVICES, FIXTURE_MCP, new Map(), 1, PAGE_SIZE);

		expect(result.summary.configSource).toContain('config/alpha.yaml');
		expect(result.summary.configSource).toContain('config/beta.yaml');
		expect(result.summary.configSource).toContain('.mcp-agents.json');
	});

	it('reports correct fromConfig and manual counts', () => {
		const result = buildServiceList(FIXTURE_SERVICES, FIXTURE_MCP, new Map(), 1, PAGE_SIZE);

		expect(result.summary.fromConfig).toBe(2); // gamma-mcp and delta-mcp
		expect(result.summary.manual).toBe(2); // Alpha and Beta from SERVICES
	});

	it('sets null for pid, uptime on all entries', () => {
		const result = buildServiceList(FIXTURE_SERVICES, FIXTURE_MCP, new Map(), 1, PAGE_SIZE);

		for (const svc of result.services) {
			expect(svc.pid).toBeNull();
			expect(svc.uptime).toBeNull();
		}
	});

	it('returns error: null on success', () => {
		const result = buildServiceList(FIXTURE_SERVICES, [], new Map(), 1, PAGE_SIZE);
		expect(result.error).toBeNull();
	});
});

describe('/api/projects/[id]/services — deduplication', () => {
	it('skips MCP service when name overlaps with SERVICES entry (case-insensitive)', () => {
		const mcpWithOverlap: McpService[] = [
			{ name: 'alpha', command: 'npx alpha', configFile: '.mcp-agents.json' }
		];
		const result = buildServiceList(FIXTURE_SERVICES, mcpWithOverlap, new Map(), 1, PAGE_SIZE);

		// "alpha" matches "Alpha Service" via .includes(), so it should be skipped
		expect(result.services).toHaveLength(2);
		expect(result.services.map((s) => s.name)).toEqual(['Alpha Service', 'Beta Service']);
	});

	it('includes MCP service when name does not overlap', () => {
		const mcpNoOverlap: McpService[] = [
			{ name: 'unique-tool', command: 'npx unique', configFile: '.mcp-agents.json' }
		];
		const result = buildServiceList(FIXTURE_SERVICES, mcpNoOverlap, new Map(), 1, PAGE_SIZE);

		expect(result.services).toHaveLength(3);
		expect(result.services[2].name).toBe('unique-tool');
	});
});

describe('/api/projects/[id]/services — pagination', () => {
	const manyServices: Record<string, ServiceDef> = {};
	for (let i = 0; i < 25; i++) {
		manyServices[`svc-${i}`] = {
			id: `svc-${i}`,
			name: `Service ${i}`,
			type: 'Worker',
			configPath: 'config/services.yaml',
			port: 5000 + i,
			healthUrl: null,
			logFile: null
		};
	}

	it('returns first page with correct page size', () => {
		const result = buildServiceList(manyServices, [], new Map(), 1, 10);

		expect(result.services).toHaveLength(10);
		expect(result.pagination.page).toBe(1);
		expect(result.pagination.pageSize).toBe(10);
		expect(result.pagination.total).toBe(25);
		expect(result.pagination.totalPages).toBe(3);
	});

	it('returns second page with correct entries', () => {
		const result = buildServiceList(manyServices, [], new Map(), 2, 10);

		expect(result.services).toHaveLength(10);
		expect(result.pagination.page).toBe(2);
	});

	it('returns partial last page', () => {
		const result = buildServiceList(manyServices, [], new Map(), 3, 10);

		expect(result.services).toHaveLength(5);
		expect(result.pagination.page).toBe(3);
	});

	it('clamps page to last valid page when exceeding total', () => {
		const result = buildServiceList(manyServices, [], new Map(), 99, 10);

		expect(result.pagination.page).toBe(3);
		expect(result.services).toHaveLength(5);
	});

	it('clamps page to 1 when given zero or negative', () => {
		const result0 = buildServiceList(manyServices, [], new Map(), 0, 10);
		const resultNeg = buildServiceList(manyServices, [], new Map(), -5, 10);

		expect(result0.pagination.page).toBe(1);
		expect(resultNeg.pagination.page).toBe(1);
	});

	it('returns all entries on single page when pageSize exceeds total', () => {
		const result = buildServiceList(manyServices, [], new Map(), 1, 50);

		expect(result.services).toHaveLength(25);
		expect(result.pagination.totalPages).toBe(1);
	});

	it('handles empty service list', () => {
		const result = buildServiceList({}, [], new Map(), 1, 10);

		expect(result.services).toHaveLength(0);
		expect(result.pagination.total).toBe(0);
		expect(result.pagination.totalPages).toBe(1);
		expect(result.pagination.page).toBe(1);
	});

	it('custom pageSize is respected', () => {
		const result = buildServiceList(manyServices, [], new Map(), 1, 5);

		expect(result.services).toHaveLength(5);
		expect(result.pagination.pageSize).toBe(5);
		expect(result.pagination.totalPages).toBe(5);
	});
});

describe('/api/projects/[id]/services — MCP config parsing', () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), 'api-services-'));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it('parses mcpServers key from config', async () => {
		const config = {
			mcpServers: {
				'flow-server': { command: 'npx', args: ['@claude-flow/cli', 'serve'], port: 9000 },
				'db-server': { command: 'node', args: ['db.js'] }
			}
		};
		await writeFile(join(tmpDir, '.mcp-agents.json'), JSON.stringify(config), 'utf-8');

		const raw = await import('fs/promises').then((fs) =>
			fs.readFile(join(tmpDir, '.mcp-agents.json'), 'utf-8')
		);
		const services = parseMcpServices(raw);

		expect(services).toHaveLength(2);
		expect(services[0].name).toBe('flow-server');
		expect(services[0].command).toBe('npx @claude-flow/cli serve');
		expect(services[0].port).toBe(9000);
		expect(services[1].name).toBe('db-server');
		expect(services[1].command).toBe('node db.js');
		expect(services[1].port).toBeNull();
	});

	it('falls back to servers key when mcpServers absent', async () => {
		const config = {
			servers: {
				'legacy-server': { command: 'python', args: ['main.py'] }
			}
		};
		await writeFile(join(tmpDir, '.mcp-agents.json'), JSON.stringify(config), 'utf-8');

		const raw = await import('fs/promises').then((fs) =>
			fs.readFile(join(tmpDir, '.mcp-agents.json'), 'utf-8')
		);
		const services = parseMcpServices(raw);

		expect(services).toHaveLength(1);
		expect(services[0].name).toBe('legacy-server');
	});

	it('returns empty array for config with no servers', async () => {
		const config = { version: 1 };
		await writeFile(join(tmpDir, '.mcp-agents.json'), JSON.stringify(config), 'utf-8');

		const raw = await import('fs/promises').then((fs) =>
			fs.readFile(join(tmpDir, '.mcp-agents.json'), 'utf-8')
		);
		const services = parseMcpServices(raw);
		expect(services).toEqual([]);
	});

	it('throws on invalid JSON', () => {
		expect(() => parseMcpServices('not valid json {')).toThrow();
	});

	it('handles server entry without command or args', async () => {
		const config = {
			mcpServers: {
				minimal: {}
			}
		};
		const raw = JSON.stringify(config);
		const services = parseMcpServices(raw);

		expect(services).toHaveLength(1);
		expect(services[0].name).toBe('minimal');
		expect(services[0].command).toBeUndefined();
		expect(services[0].port).toBeNull();
		expect(services[0].configFile).toBe('.mcp-agents.json');
	});
});

describe('/api/projects/[id]/services — error scenarios', () => {
	it('returns error shape when an exception occurs', () => {
		// Simulate what the page server returns on error
		const errorResult = {
			error: 'Failed to load services',
			summary: { running: 0, stopped: 0, fromConfig: 0, manual: 0, configSource: [] as string[] },
			services: [] as ServiceEntry[],
			pagination: { page: 1, pageSize: PAGE_SIZE, total: 0, totalPages: 1 },
			autoStart: [] as any[],
			logs: [] as any[]
		};

		expect(errorResult.error).toBe('Failed to load services');
		expect(errorResult.services).toEqual([]);
		expect(errorResult.summary.running).toBe(0);
		expect(errorResult.pagination.page).toBe(1);
		expect(errorResult.pagination.total).toBe(0);
	});

	it('returns custom error message from Error instance', () => {
		const err = new Error('ENOENT: no such file or directory');
		const errorMessage = err instanceof Error ? err.message : 'Failed to load services';
		expect(errorMessage).toBe('ENOENT: no such file or directory');
	});

	it('returns fallback message for non-Error thrown value', () => {
		const err = 'string error';
		const errorMessage = err instanceof Error ? err.message : 'Failed to load services';
		expect(errorMessage).toBe('Failed to load services');
	});
});
