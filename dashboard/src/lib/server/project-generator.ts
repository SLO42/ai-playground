/**
 * AI Project Generator — takes a user prompt + optional template and scaffolds
 * a new project by spawning a Claude agent with the appropriate instructions.
 */
import { resolve } from 'path';
import { mkdirSync } from 'fs';
import { PATHS } from './constants.js';
import { recordEvent } from './heartbeat/agent-analytics.js';
import { spawnClaude } from './heartbeat/agent-spawn.js';

// ── Interfaces ───────────────────────────────────────────────────────

export interface GenerateProjectOptions {
	prompt: string;
	template?: string;
	tags?: string[];
	name: string;
}

export interface GenerateProjectResult {
	success: boolean;
	projectPath: string;
	error?: string;
}

// ── Validation ───────────────────────────────────────────────────────

const VALID_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

function validateOptions(options: GenerateProjectOptions): string | null {
	if (!options.prompt?.trim()) {
		return 'Prompt must be non-empty';
	}
	if (!options.name?.trim()) {
		return 'Project name is required';
	}
	if (!VALID_NAME_RE.test(options.name)) {
		return 'Project name must start with alphanumeric and contain only alphanumeric characters, hyphens, and underscores';
	}
	return null;
}

// ── Prompt building ──────────────────────────────────────────────────

function buildGeneratorPrompt(options: GenerateProjectOptions, projectPath: string): string {
	const parts = [
		`You are Claw, an autonomous AI agent. Your task is to scaffold a new project.`,
		``,
		`## Project Details`,
		`**Name**: ${options.name}`,
		`**Directory**: ${projectPath}`,
		`**Description**: ${options.prompt}`,
	];

	if (options.template && options.template !== 'blank') {
		parts.push(`**Template**: ${options.template}`);
	}

	if (options.tags && options.tags.length > 0) {
		parts.push(`**Tech Stack / Tags**: ${options.tags.join(', ')}`);
	}

	parts.push(
		``,
		`## Instructions`,
		`1. Create the project directory at the path above`,
		`2. Initialize the project${options.template && options.template !== 'blank' ? ` using the ${options.template} template` : ''}`,
	);

	if (options.tags && options.tags.length > 0) {
		parts.push(`3. Incorporate the following technologies: ${options.tags.join(', ')}`);
	} else {
		parts.push(`3. Set up a sensible default project structure`);
	}

	parts.push(
		`4. Install dependencies`,
		`5. Create a README.md with project name, description, and getting-started instructions`,
		`6. Run an initial build to verify everything compiles`,
		`7. Do NOT commit or push — the caller handles version control`,
	);

	return parts.join('\n');
}

// ── Generator ────────────────────────────────────────────────────────

export async function generateProject(options: GenerateProjectOptions): Promise<GenerateProjectResult> {
	const validationError = validateOptions(options);
	if (validationError) {
		return { success: false, projectPath: '', error: validationError };
	}

	const projectPath = resolve(PATHS.root, '..', options.name);

	const taskTitle = `Generate project: ${options.name}`;
	const model = 'claude-opus-4-6';

	// Record classification event
	recordEvent({
		type: 'classified',
		taskTitle,
		route: 'claude-code',
		model,
		modelTier: 'opus',
	}).catch(() => {});

	// Create the project directory
	try {
		mkdirSync(projectPath, { recursive: true });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		recordEvent({
			type: 'failed',
			taskTitle,
			route: 'claude-code',
			model,
			modelTier: 'opus',
		}).catch(() => {});
		return { success: false, projectPath, error: `Failed to create project directory: ${msg}` };
	}

	// Build the agent prompt
	const prompt = buildGeneratorPrompt(options, projectPath);

	// Spawn the Claude agent (fire-and-forget)
	const logFile = resolve(PATHS.headlessLogsDir, `gen-${options.name}-${Date.now()}.jsonl`);
	try {
		const child = await spawnClaude(prompt, logFile, { model });

		// Record spawned event
		recordEvent({
			type: 'spawned',
			taskTitle,
			route: 'claude-code',
			model,
			modelTier: 'opus',
		}).catch(() => {});

		// Fire-and-forget: listen for exit to record completion/failure
		child.on('close', (code) => {
			recordEvent({
				type: code === 0 ? 'completed' : 'failed',
				taskTitle,
				route: 'claude-code',
				model,
				modelTier: 'opus',
			}).catch(() => {});
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		recordEvent({
			type: 'failed',
			taskTitle,
			route: 'claude-code',
			model,
			modelTier: 'opus',
		}).catch(() => {});
		return { success: false, projectPath, error: `Failed to spawn agent: ${msg}` };
	}

	return {
		success: true,
		projectPath,
	};
}
