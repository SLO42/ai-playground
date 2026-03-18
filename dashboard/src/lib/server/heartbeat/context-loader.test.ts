// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs/promises before importing the module
vi.mock('fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('fs/promises')>();
	return {
		...actual,
		readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
		writeFile: vi.fn().mockResolvedValue(undefined),
		mkdir: vi.fn().mockResolvedValue(undefined)
	};
});

import { buildContextForTask } from './context-loader.js';
import type { DetectedProjectMeta } from '$lib/types/projects.js';
import type { Task } from '$lib/types/tasks.js';

function makeMeta(overrides: Partial<DetectedProjectMeta> = {}): DetectedProjectMeta {
	return {
		language: undefined,
		framework: undefined,
		buildTool: undefined,
		buildCommand: undefined,
		devCommand: undefined,
		testCommand: undefined,
		lintCommand: undefined,
		startCommand: undefined,
		releaseCommand: undefined,
		gitRemote: undefined,
		defaultBranch: undefined,
		releaseProcess: [],
		services: [],
		workflows: [],
		agents: [],
		branches: [],
		dependencies: [],
		maintenance: {
			hasReadme: false,
			hasChangelog: false,
			hasDocsDir: false,
			hasClaude: false,
			hasClaudeFlow: false,
			hasLicense: false,
			branchCount: 0,
			activeBranches: []
		},
		...overrides
	};
}

function makeTask(overrides: Partial<Task> = {}): Task {
	const now = new Date().toISOString();
	return {
		id: 'test-task-1',
		title: 'Test task',
		description: 'A test task',
		status: 'pending',
		priority: 'medium',
		flagDiscussion: false,
		assignee: null,
		tags: [],
		feature: null,
		createdBy: 'test',
		createdAt: now,
		updatedAt: now,
		completedAt: null,
		...overrides
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe('buildContextForTask', () => {
	it('returns TypeScript context for a typescript project', async () => {
		const meta = makeMeta({ language: 'typescript' });
		const result = await buildContextForTask(makeTask(), '/tmp/proj', meta);

		expect(result.systemPrompt).toContain('TypeScript/JavaScript');
		expect(result.systemPrompt).toContain('strict typing');
		expect(result.projectFiles).toContain('tsconfig.json');
	});

	it('returns TypeScript context for a javascript project', async () => {
		const meta = makeMeta({ language: 'javascript' });
		const result = await buildContextForTask(makeTask(), '/tmp/proj', meta);

		expect(result.systemPrompt).toContain('TypeScript/JavaScript');
		expect(result.projectFiles).toContain('tsconfig.json');
	});

	it('includes SvelteKit framework notes when framework is sveltekit', async () => {
		const meta = makeMeta({ language: 'typescript', framework: 'sveltekit' });
		const result = await buildContextForTask(makeTask(), '/tmp/proj', meta);

		expect(result.systemPrompt).toContain('SvelteKit');
		expect(result.systemPrompt).toContain('Svelte 5 runes');
		expect(result.systemPrompt).toContain('$state()');
		expect(result.systemPrompt).toContain('$props()');
		expect(result.projectFiles).toContain('svelte.config.js');
	});

	it('includes Next.js framework notes when framework is nextjs', async () => {
		const meta = makeMeta({ language: 'typescript', framework: 'nextjs' });
		const result = await buildContextForTask(makeTask(), '/tmp/proj', meta);

		expect(result.systemPrompt).toContain('Next.js');
		expect(result.systemPrompt).toContain('App Router');
		expect(result.projectFiles).toContain('next.config.js');
	});

	it('includes React framework notes', async () => {
		const meta = makeMeta({ language: 'typescript', framework: 'react' });
		const result = await buildContextForTask(makeTask(), '/tmp/proj', meta);

		expect(result.systemPrompt).toContain('React');
		expect(result.systemPrompt).toContain('functional components');
	});

	it('includes Express framework notes', async () => {
		const meta = makeMeta({ language: 'typescript', framework: 'express' });
		const result = await buildContextForTask(makeTask(), '/tmp/proj', meta);

		expect(result.systemPrompt).toContain('Express.js');
		expect(result.systemPrompt).toContain('middleware');
	});

	it('returns C# context for a csharp project', async () => {
		const meta = makeMeta({ language: 'csharp' });
		const result = await buildContextForTask(makeTask(), '/tmp/proj', meta);

		expect(result.systemPrompt).toContain('C#');
		expect(result.systemPrompt).toContain('nullable reference types');
		expect(result.systemPrompt).toContain('dotnet build');
		expect(result.projectFiles).toContain('*.csproj');
	});

	it('returns BepInEx notes for unity framework', async () => {
		const meta = makeMeta({ language: 'csharp', framework: 'bepinex' });
		const result = await buildContextForTask(makeTask(), '/tmp/proj', meta);

		expect(result.systemPrompt).toContain('BepInEx');
		expect(result.systemPrompt).toContain('BaseUnityPlugin');
		expect(result.systemPrompt).toContain('HarmonyLib');
	});

	it('returns Java context with Gradle build tool', async () => {
		const meta = makeMeta({ language: 'java', buildTool: 'gradle' });
		const result = await buildContextForTask(makeTask(), '/tmp/proj', meta);

		expect(result.systemPrompt).toContain('Java');
		expect(result.systemPrompt).toContain('Gradle');
		expect(result.systemPrompt).toContain('gradle build');
		expect(result.projectFiles).toContain('build.gradle');
	});

	it('returns Java context with Maven build tool', async () => {
		const meta = makeMeta({ language: 'java', buildTool: 'maven' });
		const result = await buildContextForTask(makeTask(), '/tmp/proj', meta);

		expect(result.systemPrompt).toContain('Maven');
		expect(result.systemPrompt).toContain('mvn package');
		expect(result.projectFiles).toContain('pom.xml');
	});

	it('returns Kotlin context', async () => {
		const meta = makeMeta({ language: 'kotlin', buildTool: 'gradle' });
		const result = await buildContextForTask(makeTask(), '/tmp/proj', meta);

		expect(result.systemPrompt).toContain('Kotlin');
		expect(result.systemPrompt).toContain('data classes');
		expect(result.systemPrompt).toContain('coroutines');
	});

	it('returns Minecraft mod framework notes for fabric', async () => {
		const meta = makeMeta({ language: 'java', framework: 'fabric', buildTool: 'gradle' });
		const result = await buildContextForTask(makeTask(), '/tmp/proj', meta);

		expect(result.systemPrompt).toContain('Minecraft fabric mod');
		expect(result.systemPrompt).toContain('mod loader conventions');
	});

	it('returns Python context', async () => {
		const meta = makeMeta({ language: 'python' });
		const result = await buildContextForTask(makeTask(), '/tmp/proj', meta);

		expect(result.systemPrompt).toContain('Python');
		expect(result.systemPrompt).toContain('type hints');
		expect(result.systemPrompt).toContain('PEP 8');
		expect(result.systemPrompt).toContain('pytest');
		expect(result.projectFiles).toContain('pyproject.toml');
	});

	it('returns Django framework notes', async () => {
		const meta = makeMeta({ language: 'python', framework: 'django' });
		const result = await buildContextForTask(makeTask(), '/tmp/proj', meta);

		expect(result.systemPrompt).toContain('Django');
	});

	it('returns FastAPI framework notes', async () => {
		const meta = makeMeta({ language: 'python', framework: 'fastapi' });
		const result = await buildContextForTask(makeTask(), '/tmp/proj', meta);

		expect(result.systemPrompt).toContain('fastapi');
	});

	it('uses poetry install when build tool is poetry', async () => {
		const meta = makeMeta({ language: 'python', buildTool: 'poetry' });
		const result = await buildContextForTask(makeTask(), '/tmp/proj', meta);

		expect(result.systemPrompt).toContain('poetry install');
	});

	it('uses uv sync when build tool is uv', async () => {
		const meta = makeMeta({ language: 'python', buildTool: 'uv' });
		const result = await buildContextForTask(makeTask(), '/tmp/proj', meta);

		expect(result.systemPrompt).toContain('uv sync');
	});

	it('returns Rust context', async () => {
		const meta = makeMeta({ language: 'rust' });
		const result = await buildContextForTask(makeTask(), '/tmp/proj', meta);

		expect(result.systemPrompt).toContain('Rust');
		expect(result.systemPrompt).toContain('ownership/borrowing');
		expect(result.systemPrompt).toContain('cargo build');
		expect(result.systemPrompt).toContain('cargo clippy');
		expect(result.projectFiles).toContain('Cargo.toml');
	});

	it('returns Go context', async () => {
		const meta = makeMeta({ language: 'go' });
		const result = await buildContextForTask(makeTask(), '/tmp/proj', meta);

		expect(result.systemPrompt).toContain('Go');
		expect(result.systemPrompt).toContain('error wrapping');
		expect(result.systemPrompt).toContain('go build');
		expect(result.systemPrompt).toContain('golangci-lint');
		expect(result.projectFiles).toContain('go.mod');
	});

	it('falls back to generic context for unknown languages', async () => {
		const meta = makeMeta({ language: 'haskell' });
		const result = await buildContextForTask(makeTask(), '/tmp/proj', meta);

		expect(result.systemPrompt).toContain('Language: haskell');
		expect(result.projectFiles).toEqual([]);
	});

	it('falls back to generic context when language is undefined', async () => {
		const meta = makeMeta({});
		const result = await buildContextForTask(makeTask(), '/tmp/proj', meta);

		expect(result.systemPrompt).toContain('Unknown language');
	});

	it('includes custom build/test/lint commands when set', async () => {
		const meta = makeMeta({
			language: 'typescript',
			buildCommand: 'pnpm build',
			testCommand: 'pnpm test',
			lintCommand: 'pnpm lint'
		});
		const result = await buildContextForTask(makeTask(), '/tmp/proj', meta);

		expect(result.systemPrompt).toContain('pnpm build');
		expect(result.systemPrompt).toContain('pnpm test');
		expect(result.systemPrompt).toContain('pnpm lint');
	});

	it('includes dependencies section when present', async () => {
		const meta = makeMeta({
			language: 'typescript',
			dependencies: [
				{ name: 'svelte', version: '5.0.0', type: 'runtime' },
				{ name: 'vitest', version: '1.0.0', type: 'dev' }
			]
		});
		const result = await buildContextForTask(makeTask(), '/tmp/proj', meta);

		expect(result.systemPrompt).toContain('Key Dependencies');
		expect(result.systemPrompt).toContain('svelte (5.0.0)');
		expect(result.systemPrompt).toContain('vitest (1.0.0)');
	});

	it('limits dependencies to 8 entries', async () => {
		const deps = Array.from({ length: 12 }, (_, i) => ({
			name: `dep-${i}`,
			version: '1.0.0',
			type: 'runtime' as const
		}));
		const meta = makeMeta({ language: 'typescript', dependencies: deps });
		const result = await buildContextForTask(makeTask(), '/tmp/proj', meta);

		// Should have dep-0 through dep-7 but not dep-8+
		expect(result.systemPrompt).toContain('dep-7');
		expect(result.systemPrompt).not.toContain('dep-8');
	});

	it('returns AgentContext with all required fields', async () => {
		const meta = makeMeta({ language: 'typescript' });
		const result = await buildContextForTask(makeTask(), '/tmp/proj', meta);

		expect(result).toHaveProperty('systemPrompt');
		expect(result).toHaveProperty('projectFiles');
		expect(result).toHaveProperty('memoryEntries');
		expect(typeof result.systemPrompt).toBe('string');
		expect(Array.isArray(result.projectFiles)).toBe(true);
		expect(Array.isArray(result.memoryEntries)).toBe(true);
	});
});
