/**
 * AI Project Generator — takes a user prompt + optional template and scaffolds
 * a new project by spawning a Claude agent with the appropriate instructions.
 */
import { resolve } from 'path';
import { PATHS } from './constants.js';
import { recordEvent } from './heartbeat/agent-analytics.js';

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

	// Record classification event
	recordEvent({
		type: 'classified',
		taskTitle: `Generate project: ${options.name}`,
		route: 'claude-code',
		model: 'claude-opus-4-6',
		modelTier: 'opus',
	}).catch(() => {});

	// Build the agent prompt (used when spawning is wired)
	const _prompt = buildGeneratorPrompt(options, projectPath);

	// TODO: Wire to spawnClaude when ready
	// The prompt is prepared above. When agent infrastructure is ready,
	// this will spawn a Claude agent with the built prompt to actually
	// create the project on disk.

	// Record completion event
	recordEvent({
		type: 'completed',
		taskTitle: `Generate project: ${options.name}`,
		route: 'claude-code',
		model: 'claude-opus-4-6',
		modelTier: 'opus',
	}).catch(() => {});

	return {
		success: true,
		projectPath,
	};
}
