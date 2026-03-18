/**
 * Project-specific context loader for spawned agents.
 *
 * Builds tailored system prompts and file lists based on the project's
 * detected language, framework, and build tools. Agents receive only
 * what they need for their task — no generic platform boilerplate.
 */
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import type { Task } from '$lib/types/tasks.js';
import type { DetectedProjectMeta } from '$lib/types/projects.js';

// ── Types ────────────────────────────────────────────────────────────

export interface AgentContext {
	/** Task-specific system prompt with project knowledge baked in. */
	systemPrompt: string;
	/** Key project files the agent should read first. */
	projectFiles: string[];
	/** Relevant memory entries (keys/summaries). */
	memoryEntries: string[];
}

// ── Language-specific context builders ───────────────────────────────

interface ContextParts {
	languageNotes: string;
	frameworkNotes: string;
	buildInstructions: string;
	keyConfigFiles: string[];
}

function buildTypeScriptContext(meta: DetectedProjectMeta, projectPath: string): ContextParts {
	const keyConfigFiles = ['tsconfig.json'];
	const frameworkNotes: string[] = [];

	if (meta.framework === 'sveltekit') {
		frameworkNotes.push(
			'This is a SvelteKit project using Svelte 5 runes.',
			'Use $state(), $derived(), $effect(), $props() — NOT Svelte 4 stores or reactive declarations.',
			'Props: define `interface Props` and destructure from `$props()`.',
			'Events: use callback props, not createEventDispatcher().',
			'Slots: use {@render children()} with Snippet type, not <slot />.'
		);
		keyConfigFiles.push('svelte.config.js', 'svelte.config.ts');
	} else if (meta.framework === 'nextjs') {
		frameworkNotes.push(
			'This is a Next.js project.',
			'Use App Router conventions (app/ directory) if present, otherwise Pages Router (pages/).',
			'Server components are the default — add "use client" only when needed.'
		);
		keyConfigFiles.push('next.config.js', 'next.config.ts', 'next.config.mjs');
	} else if (meta.framework === 'react') {
		frameworkNotes.push(
			'This is a React project.',
			'Use functional components with hooks. Prefer composition over inheritance.'
		);
	} else if (meta.framework === 'express') {
		frameworkNotes.push(
			'This is an Express.js server project.',
			'Follow middleware patterns. Validate request inputs at route boundaries.'
		);
	}

	const buildCmd = meta.buildCommand ?? 'npm run build';
	const testCmd = meta.testCommand ?? 'npm test';
	const lintCmd = meta.lintCommand;

	const buildLines = [`Build: \`${buildCmd}\``];
	if (testCmd) buildLines.push(`Test: \`${testCmd}\``);
	if (lintCmd) buildLines.push(`Lint: \`${lintCmd}\``);

	return {
		languageNotes: 'TypeScript/JavaScript project. Use strict typing. Prefer `const` over `let`.',
		frameworkNotes: frameworkNotes.join('\n'),
		buildInstructions: buildLines.join('\n'),
		keyConfigFiles
	};
}

function buildCSharpContext(meta: DetectedProjectMeta, projectPath: string): ContextParts {
	const keyConfigFiles: string[] = [];
	const frameworkNotes: string[] = [];

	// Look for .csproj files in the project
	keyConfigFiles.push('*.csproj', '*.sln');

	if (meta.framework === 'bepinex' || meta.framework === 'unity') {
		frameworkNotes.push(
			'This is a BepInEx/Unity mod project.',
			'Follow BepInEx plugin conventions: [BepInPlugin] attribute, BaseUnityPlugin inheritance.',
			'Use HarmonyLib for patching. Prefer Prefix/Postfix over Transpiler patches.',
			'Log via Logger (BepInEx), not Console.WriteLine.',
			'Target the correct game assembly references.'
		);
	} else {
		frameworkNotes.push(
			'This is a C#/.NET project.',
			'Follow .NET conventions: PascalCase for public members, async/await patterns.'
		);
	}

	const buildCmd = meta.buildCommand ?? 'dotnet build -c Release';
	const testCmd = meta.testCommand ?? 'dotnet test';

	return {
		languageNotes: 'C# project. Use nullable reference types. Follow .NET naming conventions.',
		frameworkNotes: frameworkNotes.join('\n'),
		buildInstructions: `Build: \`${buildCmd}\`\nTest: \`${testCmd}\``,
		keyConfigFiles
	};
}

function buildJavaKotlinContext(meta: DetectedProjectMeta, projectPath: string): ContextParts {
	const keyConfigFiles: string[] = [];
	const frameworkNotes: string[] = [];
	const isGradle = meta.buildTool === 'gradle';
	const isMaven = meta.buildTool === 'maven';

	if (isGradle) {
		keyConfigFiles.push('build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts');
		frameworkNotes.push('This project uses Gradle for builds.');
	} else if (isMaven) {
		keyConfigFiles.push('pom.xml');
		frameworkNotes.push('This project uses Maven for builds.');
	}

	if (meta.framework === 'fabric' || meta.framework === 'forge' || meta.framework === 'neoforge') {
		frameworkNotes.push(
			`This is a Minecraft ${meta.framework} mod project.`,
			'Follow mod loader conventions for registration and event handling.',
			'Use the mod loader\'s config system, not raw file I/O.'
		);
	} else if (meta.framework === 'spring') {
		frameworkNotes.push(
			'This is a Spring Boot project.',
			'Use @Service, @Repository, @Controller annotations. Prefer constructor injection.'
		);
	}

	const buildCmd = meta.buildCommand ?? (isGradle ? 'gradle build' : isMaven ? 'mvn package' : 'gradle build');
	const testCmd = meta.testCommand ?? (isGradle ? 'gradle test' : isMaven ? 'mvn test' : 'gradle test');

	return {
		languageNotes: meta.language === 'kotlin'
			? 'Kotlin project. Use data classes, null safety, and coroutines where appropriate.'
			: 'Java project. Use modern Java patterns (records, sealed classes, pattern matching if Java 17+).',
		frameworkNotes: frameworkNotes.join('\n'),
		buildInstructions: `Build: \`${buildCmd}\`\nTest: \`${testCmd}\``,
		keyConfigFiles
	};
}

function buildPythonContext(meta: DetectedProjectMeta, projectPath: string): ContextParts {
	const keyConfigFiles = ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt'];
	const frameworkNotes: string[] = [];

	if (meta.framework === 'django') {
		frameworkNotes.push('This is a Django project. Follow Django conventions for models, views, and URLs.');
	} else if (meta.framework === 'flask' || meta.framework === 'fastapi') {
		frameworkNotes.push(`This is a ${meta.framework} project. Use type hints for request/response models.`);
	}

	const buildTool = meta.buildTool;
	let installCmd = 'pip install -e .';
	if (buildTool === 'poetry') installCmd = 'poetry install';
	else if (buildTool === 'uv') installCmd = 'uv sync';

	const testCmd = meta.testCommand ?? 'pytest';
	const lintCmd = meta.lintCommand ?? 'ruff check .';

	return {
		languageNotes: 'Python project. Use type hints. Follow PEP 8 style.',
		frameworkNotes: frameworkNotes.join('\n'),
		buildInstructions: `Install: \`${installCmd}\`\nTest: \`${testCmd}\`\nLint: \`${lintCmd}\``,
		keyConfigFiles
	};
}

function buildRustContext(meta: DetectedProjectMeta, projectPath: string): ContextParts {
	return {
		languageNotes: 'Rust project. Follow ownership/borrowing patterns. Use Result<> for error handling.',
		frameworkNotes: meta.framework ? `Framework: ${meta.framework}` : '',
		buildInstructions: `Build: \`cargo build\`\nTest: \`cargo test\`\nLint: \`cargo clippy\``,
		keyConfigFiles: ['Cargo.toml', 'Cargo.lock']
	};
}

function buildGoContext(meta: DetectedProjectMeta, projectPath: string): ContextParts {
	return {
		languageNotes: 'Go project. Follow effective Go patterns. Use error wrapping with fmt.Errorf.',
		frameworkNotes: meta.framework ? `Framework: ${meta.framework}` : '',
		buildInstructions: `Build: \`go build ./...\`\nTest: \`go test ./...\`\nLint: \`golangci-lint run\``,
		keyConfigFiles: ['go.mod', 'go.sum']
	};
}

function buildGenericContext(meta: DetectedProjectMeta, projectPath: string): ContextParts {
	const buildLines: string[] = [];
	if (meta.buildCommand) buildLines.push(`Build: \`${meta.buildCommand}\``);
	if (meta.testCommand) buildLines.push(`Test: \`${meta.testCommand}\``);
	if (meta.lintCommand) buildLines.push(`Lint: \`${meta.lintCommand}\``);

	return {
		languageNotes: meta.language ? `Language: ${meta.language}` : 'Unknown language.',
		frameworkNotes: meta.framework ? `Framework: ${meta.framework}` : '',
		buildInstructions: buildLines.length > 0 ? buildLines.join('\n') : 'No build commands detected — check project docs.',
		keyConfigFiles: []
	};
}

// ── Context builder dispatch ─────────────────────────────────────────

const CONTEXT_BUILDERS: Record<string, (meta: DetectedProjectMeta, path: string) => ContextParts> = {
	typescript: buildTypeScriptContext,
	javascript: buildTypeScriptContext,
	csharp: buildCSharpContext,
	java: buildJavaKotlinContext,
	kotlin: buildJavaKotlinContext,
	python: buildPythonContext,
	rust: buildRustContext,
	go: buildGoContext,
};

/**
 * Load relevant memory entries for a project from its .playground/ directory.
 * Returns short summary strings, not full content.
 */
async function loadProjectMemory(projectPath: string): Promise<string[]> {
	const entries: string[] = [];
	try {
		const memoryPath = resolve(projectPath, '.playground', 'memory.json');
		const raw = await readFile(memoryPath, 'utf-8');
		const data = JSON.parse(raw) as { entries?: Array<{ key: string; value: string }> };
		if (data.entries) {
			for (const entry of data.entries.slice(0, 10)) {
				entries.push(`${entry.key}: ${entry.value.slice(0, 200)}`);
			}
		}
	} catch {
		// No memory file — that's fine
	}

	// Also check for CLAUDE.md in the project
	try {
		const claudeMd = await readFile(resolve(projectPath, 'CLAUDE.md'), 'utf-8');
		if (claudeMd.length > 0) {
			entries.push(`[CLAUDE.md] Project has a CLAUDE.md with ${claudeMd.length} chars of instructions`);
		}
	} catch {
		// No CLAUDE.md
	}

	return entries;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Build project-specific context for a task based on detected project metadata.
 *
 * The returned context includes:
 * - A system prompt tailored to the project's language/framework
 * - Key config files the agent should look at
 * - Relevant memory entries from the project
 */
export async function buildContextForTask(
	task: Task,
	projectPath: string,
	projectMeta: DetectedProjectMeta
): Promise<AgentContext> {
	const lang = (projectMeta.language ?? '').toLowerCase();
	const builder = CONTEXT_BUILDERS[lang] ?? buildGenericContext;
	const parts = builder(projectMeta, projectPath);

	const memoryEntries = await loadProjectMemory(projectPath);

	const promptSections: string[] = [];

	// Language and framework context
	if (parts.languageNotes) {
		promptSections.push(`## Language\n${parts.languageNotes}`);
	}
	if (parts.frameworkNotes) {
		promptSections.push(`## Framework\n${parts.frameworkNotes}`);
	}

	// Build/test/lint commands
	if (parts.buildInstructions) {
		promptSections.push(`## Commands\n${parts.buildInstructions}`);
	}

	// Project memory
	if (memoryEntries.length > 0) {
		const memorySection = memoryEntries.map(e => `- ${e}`).join('\n');
		promptSections.push(`## Project Context\n${memorySection}`);
	}

	// Key dependencies (if detected)
	if (projectMeta.dependencies.length > 0) {
		const deps = projectMeta.dependencies.slice(0, 8).map(d => `- ${d.name}${d.version ? ` (${d.version})` : ''}`).join('\n');
		promptSections.push(`## Key Dependencies\n${deps}`);
	}

	const systemPrompt = promptSections.join('\n\n');

	// Filter config files to only those that exist
	const projectFiles: string[] = [];
	for (const pattern of parts.keyConfigFiles) {
		// For glob patterns like *.csproj, just include the pattern hint
		if (pattern.includes('*')) {
			projectFiles.push(pattern);
		} else {
			projectFiles.push(pattern);
		}
	}

	return {
		systemPrompt,
		projectFiles,
		memoryEntries
	};
}
