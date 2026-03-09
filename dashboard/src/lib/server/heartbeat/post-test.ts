/**
 * Post-commit test runner — automatically runs the project's test suite
 * after a Claw agent commits changes. Creates fix tasks if tests fail.
 *
 * Phase 1.2: Post-commit test runner for the heartbeat system.
 */
import { execSync } from 'child_process';
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';
import { createTask } from '../task-store.js';
import { recordEvent, type AgentEventType } from './agent-analytics.js';
import { log, loadMonitorSession, saveMonitorSession } from './shared.js';
import type { Task } from '$lib/types/tasks.js';
import type { CommitResult } from './post-task.js';

// ── Types ────────────────────────────────────────────────────────────

export interface TestResult {
	passed: boolean;
	exitCode: number;
	output: string;
	command: string;
}

// ── Constants ────────────────────────────────────────────────────────

const TEST_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 2000;

// ── Test command detection ───────────────────────────────────────────

/**
 * Look up the project's test command. Checks .playground/config.json first,
 * then falls back to common defaults based on project files.
 */
function resolveTestCommand(projectPath: string): string | null {
	// 1. Check .playground/config.json for explicit testCommand
	try {
		const configPath = resolve(projectPath, '.playground/config.json');
		const raw = readFileSync(configPath, 'utf-8');
		const config = JSON.parse(raw);
		if (config.testCommand && typeof config.testCommand === 'string') {
			return config.testCommand;
		}
	} catch { /* no config or no testCommand field */ }

	// 2. Fall back to common defaults by detecting project type
	try {
		const packagePath = resolve(projectPath, 'package.json');
		readFileSync(packagePath, 'utf-8'); // Just check existence
		return 'npm test';
	} catch { /* not a Node.js project */ }

	try {
		const reqPath = resolve(projectPath, 'requirements.txt');
		readFileSync(reqPath, 'utf-8');
		return 'python -m pytest';
	} catch { /* not a Python project */ }

	try {
		// Check for .csproj files (C# / .NET)
		const entries = readdirSync(projectPath, { encoding: 'utf-8' });
		if (entries.some((e) => e.endsWith('.csproj') || e.endsWith('.sln'))) {
			return 'dotnet test';
		}
	} catch { /* skip */ }

	return null;
}

// ── Test runner ──────────────────────────────────────────────────────

/**
 * Run the project's test suite synchronously with a timeout.
 * Returns the result including pass/fail status and truncated output.
 */
function runTests(command: string, projectPath: string): TestResult {
	try {
		const output = execSync(command, {
			cwd: projectPath,
			encoding: 'utf-8',
			timeout: TEST_TIMEOUT_MS,
			stdio: ['pipe', 'pipe', 'pipe'],
			// Cross-platform: use shell mode so npm/python/dotnet resolve correctly
			shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'
		});

		return {
			passed: true,
			exitCode: 0,
			output: truncateOutput(output),
			command
		};
	} catch (err: unknown) {
		const execErr = err as { status?: number; stdout?: string; stderr?: string; message?: string };
		const stdout = typeof execErr.stdout === 'string' ? execErr.stdout : '';
		const stderr = typeof execErr.stderr === 'string' ? execErr.stderr : '';
		const combined = stdout + '\n' + stderr;
		const exitCode = typeof execErr.status === 'number' ? execErr.status : 1;

		return {
			passed: false,
			exitCode,
			output: truncateOutput(combined),
			command
		};
	}
}

/**
 * Truncate output to the last MAX_OUTPUT_CHARS characters.
 */
function truncateOutput(output: string): string {
	const trimmed = output.trim();
	if (trimmed.length <= MAX_OUTPUT_CHARS) return trimmed;
	return '...(truncated)\n' + trimmed.slice(-MAX_OUTPUT_CHARS);
}

// ── Main entry point ─────────────────────────────────────────────────

/**
 * Run post-commit tests for a task. This is fire-and-forget — it does not
 * block the agent close handler.
 *
 * If tests fail, creates a high-priority fix task automatically.
 */
export async function runPostCommitTests(
	task: Task,
	commitResult: CommitResult
): Promise<void> {
	const projectPath = task._sourceProjectPath;
	if (!projectPath) return;

	const command = resolveTestCommand(projectPath);
	if (!command) return; // No test command — skip silently

	const result = runTests(command, projectPath);

	// Log to monitor session
	const ms = await loadMonitorSession();
	if (result.passed) {
		log(ms, `[test] "${task.title}" — tests passed (${command})`);
	} else {
		log(ms, `[test] "${task.title}" — tests FAILED (exit ${result.exitCode}, ${command})`);
	}
	await saveMonitorSession(ms);

	// Record analytics event
	await recordEvent({
		taskId: task.id,
		taskTitle: task.title,
		type: 'test_run',
		projectId: task._sourceProjectId,
		exitCode: result.exitCode
	}).catch(() => {});

	// If tests failed, create a fix task
	if (!result.passed && projectPath) {
		const last50Lines = result.output.split('\n').slice(-50).join('\n');
		const description = [
			`Tests failed after committing changes for task "${task.title}" (${task.id}).`,
			``,
			`**Test command**: \`${result.command}\``,
			`**Exit code**: ${result.exitCode}`,
			`**Commit**: ${commitResult.hash ?? 'unknown'}`,
			``,
			`### Test output (last 50 lines)`,
			'```',
			last50Lines,
			'```'
		].join('\n');

		try {
			await createTask(projectPath, {
				title: `Fix failing tests after: ${task.title}`,
				description,
				priority: 'high',
				tags: ['auto-suggested', 'test-fix'],
				createdBy: `agent:${task.id}`
			});
		} catch { /* best effort — don't crash if task creation fails */ }
	}
}
