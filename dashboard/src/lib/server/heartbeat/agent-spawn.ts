/**
 * Claude Code agent spawning — binary invocation, prompt building, and path hinting.
 *
 * Agents are only spawned when there is a concrete task to execute.
 * Project-specific context is injected via context-loader.ts when available.
 */
import { openSync, closeSync } from 'fs';
import { mkdir, writeFile, unlink } from 'fs/promises';
import { spawn, type ChildProcess } from 'child_process';
import { resolve } from 'path';
import { randomUUID } from 'crypto';
import { PATHS } from '../constants.js';
import type { Task } from '$lib/types/tasks.js';
import type { AgentContext } from './context-loader.js';

const destroyStreams = (child: ChildProcess) => {
	child.stdin?.destroy();
	child.stdout?.destroy();
	child.stderr?.destroy();
};

export interface SpawnOptions {
	model: string;
}

/**
 * Extract I/O previews from a completed agent run.
 * - promptPreview: first 500 chars of the prompt sent to the agent
 * - responsePreview: last 500 chars of the agent's text output (from parsed log)
 *
 * Usage: call after process exits with the original prompt and
 * the `text` field from `parseStreamJsonLog(logFile)`.
 */
export function extractIOPreviews(prompt: string, parsedText: string): {
	promptPreview: string;
	responsePreview: string;
} {
	return {
		promptPreview: prompt.slice(0, 500),
		responsePreview: parsedText.length > 500
			? parsedText.slice(-500)
			: parsedText
	};
}

/**
 * Extract token usage from a parsed stream-JSON log result.
 * Returns fields ready to spread into a recordEvent call.
 *
 * Usage: call with `parsed.usage` from `parseStreamJsonLog(logFile)`.
 */
export function extractTokenUsage(usage: {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	costUsd?: number;
	model?: string;
} | undefined): {
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
	efficiencyRatio: number;
	model?: string;
} {
	if (!usage) return { inputTokens: 0, outputTokens: 0, costUsd: 0, efficiencyRatio: 0 };
	const input = usage.inputTokens ?? 0;
	const output = usage.outputTokens ?? 0;
	return {
		inputTokens: input,
		outputTokens: output,
		costUsd: usage.costUsd ?? 0,
		efficiencyRatio: input > 0 ? output / input : 0,
		...(usage.model ? { model: usage.model } : {})
	};
}

export async function spawnClaude(prompt: string, logFile: string, opts: SpawnOptions): Promise<ReturnType<typeof spawn>> {
	const { model } = opts;
	await mkdir(PATHS.headlessLogsDir, { recursive: true });

	const promptFile = resolve(PATHS.headlessLogsDir, `prompt-${randomUUID().slice(0, 12)}.txt`);
	await writeFile(promptFile, prompt, 'utf-8');

	let stdinFd: number | undefined;
	let outFd: number | undefined;
	try {
		stdinFd = openSync(promptFile, 'r');
		outFd = openSync(logFile, 'a');

		// Strip Claude Code session env vars so nested instances don't refuse to start
		const env = { ...process.env };
		for (const key of Object.keys(env)) {
			if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) {
				delete env[key];
			}
		}

		const claudeBin = process.platform === 'win32'
			? resolve(process.env.USERPROFILE ?? process.env.HOME ?? '', '.local/bin/claude.exe')
			: 'claude';

		const mcpConfig = resolve(PATHS.root, '.mcp-agents.json');
		// Simple tasks (Sonnet) get fewer turns to prevent token runaway
		const maxTurns = model === 'claude-sonnet-4-6' ? '15' : '25';
		const args = [
			'--dangerously-skip-permissions', '--print', '--verbose',
			'--output-format', 'stream-json',
			'--mcp-config', mcpConfig,
			'--max-turns', maxTurns
		];

		args.push('--model', model);

		// On Windows, use shell: true so paths with spaces (e.g. C:\Program Files\nodejs)
		// are handled correctly by the shell rather than breaking spawn().
		const child = spawn(claudeBin, args, {
			detached: false,
			stdio: [stdinFd, outFd, outFd],
			cwd: PATHS.root,
			shell: process.platform === 'win32',
			windowsHide: true,
			env
		});

		// Close parent's copy of the file descriptors — child inherited them via spawn.
		// Without this, FDs leak in the parent process for the lifetime of the child.
		closeSync(stdinFd);
		closeSync(outFd);
		stdinFd = undefined;
		outFd = undefined;

		child.unref();

		child.on('close', () => {
			destroyStreams(child);
			unlink(promptFile).catch(() => {});
		});

		child.on('error', () => {
			destroyStreams(child);
		});

		return child;
	} catch (err) {
		if (stdinFd !== undefined) { try { closeSync(stdinFd); } catch { /* already closed */ } }
		if (outFd !== undefined) { try { closeSync(outFd); } catch { /* already closed */ } }
		throw err;
	}
}

export function buildTaskPrompt(task: Task, projectContext?: AgentContext): string {
	const relevantPaths = guessRelevantPaths(task);

	const parts = [
		`You are Claw, an autonomous AI agent working on a task.`,
		``,
		`## Task: ${task.title}`,
		`**ID**: ${task.id}`,
		`**Priority**: ${task.priority}`,
		`**Description**: ${task.description || 'No description provided.'}`,
		`**Tags**: ${task.tags.length > 0 ? task.tags.join(', ') : 'none'}`,
		``,
		`## CRITICAL: Token Budget — You WILL be terminated if you exceed 200K input tokens`,
		`Every file you read costs ~$0.003/1K tokens. Your hard budget is 200K input tokens ($0.60).`,
		``,
		`### Rules (violations waste money):`,
		`1. **Read ONLY files you will edit**. Max 3 files. Period.`,
		`2. Use Grep to locate the exact file+line FIRST, then Read only that file.`,
		`3. **NEVER** read: CLAUDE.md, package.json, README, .md files, config/, types/ (unless editing them).`,
		`4. **NEVER** list directories, glob for files, or "explore the codebase."`,
		`5. **NEVER** read imports, dependencies, or related files "for context."`,
		`6. Go straight to the suggested files below. If none listed, Grep for the relevant code, then edit.`,
		`7. One file task = read it, edit it, build, done. Do NOT touch anything else.`,
	];

	// Inject project-specific context if available (replaces generic structure section)
	if (projectContext && projectContext.systemPrompt) {
		parts.push(``, `## Project Context (auto-detected)`);
		parts.push(projectContext.systemPrompt);
	} else {
		// Fallback: generic ai-playground structure for tasks without project context
		parts.push(
			``,
			`## Project Structure`,
			`- Dashboard: \`dashboard/\` (SvelteKit + Svelte 5 with runes)`,
			`- Server code: \`dashboard/src/lib/server/\``,
			`- Routes: \`dashboard/src/routes/\``,
			`- Types: \`dashboard/src/lib/types/\``,
			`- Config: \`config/\``,
			`- Task files: \`.playground/tasks/\``
		);
	}

	parts.push(
		``,
		`## Instructions`,
		`1. Read the relevant source files (see suggested paths below)`,
		`2. Implement the task as described — keep changes minimal and focused`,
	);

	// Use project-specific build command if available, otherwise fallback
	if (projectContext?.systemPrompt.includes('Build:')) {
		parts.push(`3. Run the build command listed in Project Context above to verify your changes compile`);
	} else {
		parts.push(`3. Run \`npm run build\` in the dashboard/ directory to verify your changes compile`);
	}

	parts.push(
		`4. Do NOT commit or push — the heartbeat auto-commits your changes after you exit`,
		`5. Do NOT update documentation files unless the task specifically asks for it`,
		``,
		`## Claude Flow (MCP Tools)`,
		`You have access to claude-flow MCP tools. Use them:`,
		`- **memory_search** — Search BEFORE starting. Check for project context, patterns, and prior solutions.`,
		`- **task_update** — Update task status when starting (in_progress) and finishing (completed).`,
		`- Do NOT use memory_store — the heartbeat maintains a compact project map automatically.`,
		``,
		`## IMPORTANT: Create Improvement Tasks`,
		`While working, if you notice bugs, missing features, code smells, or anything that could be improved`,
		`(even if unrelated to your current task), write them to the suggestion inbox:`,
		``,
		`\`\`\`bash`,
		`# Append suggestions to .playground/task-suggestions.json`,
		`# The heartbeat will pick these up and create real tasks automatically.`,
		`node -e "`,
		`const fs = require('fs');`,
		`const path = '.playground/task-suggestions.json';`,
		`const file = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path,'utf-8')) : {suggestions:[]};`,
		`file.suggestions.push(`,
		`  { title: 'Short actionable title', description: 'What and why', priority: 'medium', tags: ['area'], source: 'agent:${task.id}' }`,
		`);`,
		`fs.writeFileSync(path, JSON.stringify(file, null, '\\t'));`,
		`"`,
		`\`\`\``,
		``,
		`Do this for EVERY issue you notice — even small ones. Examples:`,
		`- A missing error boundary on a page you're reading`,
		`- A TODO comment that should be a tracked task`,
		`- A type that could be more specific`,
		`- A function over 50 lines that should be split`,
		`- Hardcoded values that should be config`,
	);

	// Merge suggested files from both path guessing and project context
	const allPaths = [...relevantPaths];
	if (projectContext?.projectFiles) {
		for (const f of projectContext.projectFiles) {
			if (!allPaths.includes(f)) allPaths.push(f);
		}
	}

	if (allPaths.length > 0) {
		parts.push(``, `## Suggested Starting Files`);
		for (const p of allPaths) {
			parts.push(`- \`${p}\``);
		}
	}

	return parts.join('\n');
}

export function buildTaskPromptWithDiscussion(task: Task, discussionContext: string, projectContext?: AgentContext): string {
	const base = buildTaskPrompt(task, projectContext);
	return [
		base,
		``,
		`## User Direction`,
		`This task was discussed with the user before being handed off to you. Their input:`,
		``,
		discussionContext,
		``,
		`Follow the user's direction. You have full project context via CLAUDE.md and the codebase — implement accordingly.`
	].join('\n');
}

/**
 * Model tiering: pick the right model based on task complexity.
 *
 * Tier 1 (Sonnet) — simple single-file fixes, styling, removals      ~$0.10-0.20/task
 * Tier 2 (Opus)   — features, reworks, multi-file, tests, APIs       ~$0.40-1.50/task
 *
 * Returns explicit model ID (never undefined) so the spawn call always knows what's running.
 */
export function pickModelForTask(task: Task): string {
	const text = `${task.title} ${task.description ?? ''} ${task.tags.join(' ')}`.toLowerCase();

	// ── Tier 2: Complex work → Opus 4.6 (always upgrade for these) ──
	const complexPatterns = [
		/\bcentralize\b/, /\bconsolidate\b/, /\brefactor\b/, /\brework\b/,
		/\barchitect/, /\bunit test/, /\bend.to.end test/, /\be2e\b/,
		/\bmulti.?file\b/, /\bwire\b.*\bapi\b/, /\bimplement\b.*\bapi\b/,
		/\bcreate\b.*\bpage\b/, /\bpagination\b/, /\bsearch\b.*\bpalette\b/,
		/\bopenapi\b/, /\bci\b.*\bpipeline\b/, /\brelease\b.*\bautomation\b/,
		/\bnew feature\b/, /\badd\b.*\bpage\b/, /\bintegrat/, /\bmigrat/,
		/\bsecurity\b.*\baudit/, /\baccessibility\b.*\baudit/,
		/\bdocument\b.*\bapi/, /\bstream/, /\breal.?time/,
		/\bproject.manager\b/, /\broadmap\b.*\bplanning\b/,
	];

	if (complexPatterns.some(p => p.test(text))) return 'claude-opus-4-6';

	// ── Tier 1: Simple single-file work → Sonnet 4.6 ──
	const simplePatterns = [
		/\bremove\b.*\bunused\b/, /\bdelete\b.*\bfile/, /\bfix\b.*\bbug\b/,
		/\bfix\b.*\breactivity\b/, /\bfix\b.*\blayout\b/, /\bfix\b.*\btypo\b/,
		/\badd meta\b/, /\badd\b.*\bempty.?state\b/, /\bfix\b.*\bstyle\b/,
		/\bresponsive\b.*\bstyl/, /\bdisplay\b.*\bversion\b/, /\bfix\b.*\bclass\b/,
		/\bfix\b.*\binterpolation\b/, /\bloading\b.*\bstate\b/, /\berror\b.*\bstate\b/,
		/\bbrowse button\b/, /\bfix\b.*\boverlap\b/, /\bfix\b.*\bflex\b/,
		/\badd\b.*\bfeedback\b/, /\bfix\b.*\bleak\b/, /\bfix\b.*\breconnect\b/,
		/\bfix\b.*\bduplicate\b/, /\bkeyboard\b.*\bshortcut/,
	];

	if (simplePatterns.some(p => p.test(text))) return 'claude-sonnet-4-6';

	// Heuristic: short description + few tags → likely simple
	const descLen = (task.description ?? '').length;
	if (descLen < 100 && task.tags.length <= 2) return 'claude-sonnet-4-6';

	// Default: anything unclassified gets Opus to be safe
	return 'claude-opus-4-6';
}

export function guessRelevantPaths(task: Task): string[] {
	const text = `${task.title} ${task.description ?? ''} ${task.tags.join(' ')}`.toLowerCase();
	const paths: string[] = [];

	const hints: [string[], string[]][] = [
		[['inbox'], ['dashboard/src/routes/inbox/']],
		[['chat', 'message'], ['dashboard/src/routes/chat/', 'dashboard/src/lib/server/providers/']],
		[['model', 'routing', 'ollama'], ['dashboard/src/routes/models/', 'dashboard/src/lib/server/ollama-client.ts']],
		[['notification', 'notify', 'alert'], ['dashboard/src/lib/server/notifications.ts', 'dashboard/src/routes/notifications/']],
		[['task', 'backlog'], ['dashboard/src/lib/server/task-store.ts', 'dashboard/src/routes/tasks/']],
		[['project', 'import'], ['dashboard/src/routes/projects/', 'dashboard/src/lib/server/project-scanner.ts']],
		[['setting', 'config', 'preference'], ['dashboard/src/routes/settings/']],
		[['report', 'analytics'], ['dashboard/src/routes/reports/', 'dashboard/src/lib/server/reports.ts']],
		[['service', 'health'], ['dashboard/src/routes/services/', 'dashboard/src/lib/server/constants.ts']],
		[['agent', 'spawn'], ['dashboard/src/routes/agents/', 'dashboard/src/lib/server/heartbeat/']],
		[['session', 'live'], ['dashboard/src/lib/server/session-manager.ts']],
		[['memory'], ['dashboard/src/routes/memory/']],
		[['security', 'scan'], ['dashboard/src/routes/security/']],
		[['app', 'mcp'], ['dashboard/src/routes/apps/']],
		[['about', 'version'], ['dashboard/src/routes/about/']],
		[['sidebar', 'layout', 'navigation'], ['dashboard/src/lib/components/Sidebar.svelte', 'dashboard/src/routes/+layout.svelte']],
		[['tailwind', 'css', 'style'], ['dashboard/tailwind.config.ts']],
		[['github', 'sync', 'issue'], ['dashboard/src/lib/server/github-sync.ts']],
	];

	for (const [keywords, files] of hints) {
		if (keywords.some(k => text.includes(k))) {
			for (const f of files) {
				if (!paths.includes(f)) paths.push(f);
			}
		}
	}

	return paths.slice(0, 6);
}
