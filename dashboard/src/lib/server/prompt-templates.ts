/**
 * Reusable prompt template sections for agent spawning.
 * Composable blocks that reduce token usage by avoiding inline repetition.
 */

/** Project context block — tells the agent about the project structure */
export function projectContext(projectPath: string, projectName: string): string {
	return `## Project Context
- Project: ${projectName}
- Root: ${projectPath}
- Config: .playground/config.json
- Tasks: .playground/tasks.db (SQLite)
- Analytics: .playground/analytics.db (SQLite)`;
}

/** Coding conventions block */
export function codingConventions(language: string): string {
	const conventions: Record<string, string> = {
		typescript: `## Conventions
- TypeScript strict mode
- Use existing utilities before creating new ones
- Error handling at system boundaries only
- No unnecessary abstractions`,
		python: `## Conventions
- Python 3.10+ with type hints
- Use existing utilities before creating new ones
- Follow PEP 8`,
		csharp: `## Conventions
- C# with .NET conventions
- Use existing patterns from the codebase
- Follow Microsoft naming guidelines`,
	};
	return conventions[language] ?? conventions.typescript;
}

/** Output format block — tells the agent how to structure its response */
export function outputFormat(format: 'code' | 'review' | 'plan'): string {
	const formats: Record<string, string> = {
		code: `## Output
- Write clean, minimal code
- Only modify files directly related to the task
- Commit changes when done`,
		review: `## Output
- List findings by severity (critical > high > medium > low)
- Include file path and line number for each finding
- Suggest specific fixes`,
		plan: `## Output
- Break the task into numbered steps
- Estimate effort for each step (small/medium/large)
- Identify dependencies between steps`,
	};
	return formats[format] ?? formats.code;
}

/** Build a complete agent prompt from composable sections */
export function buildAgentPrompt(options: {
	task: string;
	projectPath: string;
	projectName: string;
	language?: string;
	format?: 'code' | 'review' | 'plan';
	extraContext?: string;
}): string {
	const sections = [
		`# Task\n${options.task}`,
		projectContext(options.projectPath, options.projectName),
		codingConventions(options.language ?? 'typescript'),
		outputFormat(options.format ?? 'code'),
	];
	if (options.extraContext) {
		sections.push(`## Additional Context\n${options.extraContext}`);
	}
	return sections.join('\n\n');
}
