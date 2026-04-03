/**
 * Post-commit test runner — automatically runs the project's test suite
 * after a Claw agent commits changes. Creates fix tasks if tests fail.
 *
 * Phase 1.2: Post-commit test runner for the heartbeat system.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile, readdir, access } from 'fs/promises';
import { resolve } from 'path';

const execFileAsync = promisify(execFile);
import { createTask } from '../task-store-sql.js';
import { createIncident } from '../incidents.js';
import { collectCoverage } from '../coverage-tracker.js';
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
async function resolveTestCommand(projectPath: string): Promise<string | null> {
	// 1. Check .playground/config.json for explicit testCommand
	try {
		const configPath = resolve(projectPath, '.playground/config.json');
		const raw = await readFile(configPath, 'utf-8');
		const config = JSON.parse(raw);
		if (config.testCommand && typeof config.testCommand === 'string') {
			return config.testCommand;
		}
	} catch { /* no config or no testCommand field */ }

	// 2. Fall back to common defaults by detecting project type
	try {
		await access(resolve(projectPath, 'package.json'));
		return 'npm test';
	} catch { /* not a Node.js project */ }

	try {
		await access(resolve(projectPath, 'Cargo.toml'));
		return 'cargo test';
	} catch { /* not a Rust project */ }

	try {
		await access(resolve(projectPath, 'go.mod'));
		return 'go test ./...';
	} catch { /* not a Go project */ }

	try {
		await access(resolve(projectPath, 'build.gradle.kts'));
		return './gradlew test';
	} catch { /* skip */ }

	try {
		await access(resolve(projectPath, 'build.gradle'));
		return './gradlew test';
	} catch { /* skip */ }

	try {
		await access(resolve(projectPath, 'pom.xml'));
		return 'mvn test';
	} catch { /* not a Maven project */ }

	try {
		await access(resolve(projectPath, 'pyproject.toml'));
		return 'pytest';
	} catch { /* skip */ }

	try {
		await access(resolve(projectPath, 'setup.py'));
		return 'pytest';
	} catch { /* skip */ }

	try {
		await access(resolve(projectPath, 'requirements.txt'));
		return 'python -m pytest';
	} catch { /* not a Python project */ }

	try {
		// Check for .csproj files (C# / .NET)
		const entries = await readdir(projectPath, { encoding: 'utf-8' });
		if (entries.some((e) => e.endsWith('.csproj') || e.endsWith('.sln'))) {
			return 'dotnet test';
		}
	} catch { /* skip */ }

	try {
		await access(resolve(projectPath, 'Makefile'));
		return 'make test';
	} catch { /* skip */ }

	return null;
}

// ── Test runner ──────────────────────────────────────────────────────

/**
 * Run the project's test suite synchronously with a timeout.
 * Returns the result including pass/fail status and truncated output.
 */
async function runTests(command: string, projectPath: string): Promise<TestResult> {
	// Split command for execFile (avoids shell injection, still uses shell for resolution)
	const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
	const shellArgs = process.platform === 'win32' ? ['/c', command] : ['-c', command];

	try {
		const { stdout } = await execFileAsync(shell, shellArgs, {
			cwd: projectPath,
			encoding: 'utf-8',
			timeout: TEST_TIMEOUT_MS
		});

		return {
			passed: true,
			exitCode: 0,
			output: truncateOutput(stdout),
			command
		};
	} catch (err: unknown) {
		const execErr = err as { code?: number; stdout?: string; stderr?: string; message?: string };
		const stdout = typeof execErr.stdout === 'string' ? execErr.stdout : '';
		const stderr = typeof execErr.stderr === 'string' ? execErr.stderr : '';
		const combined = stdout + '\n' + stderr;
		const exitCode = typeof execErr.code === 'number' ? execErr.code : 1;

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

	const command = await resolveTestCommand(projectPath);
	if (!command) return; // No test command — skip silently

	const result = await runTests(command, projectPath);

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

	// If tests failed, create a fix task and an incident
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

		let relatedTaskId: string | undefined;
		try {
			const fixTask = await createTask(projectPath, {
				title: `Fix failing tests after: ${task.title}`,
				description,
				priority: 'high',
				tags: ['auto-suggested', 'test-fix'],
				createdBy: `agent:${task.id}`
			});
			relatedTaskId = fixTask?.id;
		} catch { /* best effort — don't crash if task creation fails */ }

		// Create an incident for the test failure
		await createIncident({
			projectId: task._sourceProjectId ?? 'unknown',
			type: 'test_regression',
			title: `Tests failed: ${task.title}`,
			description,
			severity: 'high',
			status: 'open',
			relatedTaskId,
			context: {
				taskId: task.id,
				command: result.command,
				exitCode: result.exitCode,
				commitHash: commitResult.hash ?? 'unknown',
				output: last50Lines
			}
		}).catch(() => {});
	}

	// If tests passed, collect coverage data
	if (result.passed && projectPath && task._sourceProjectId) {
		await collectCoverage(task._sourceProjectId, projectPath).catch(() => {});
	}
}
