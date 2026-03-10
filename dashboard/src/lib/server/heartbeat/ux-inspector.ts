/**
 * UX Inspector — two-mode Playwright-based UX testing on heartbeat.
 *
 * Mode 1 — Discovery (AI): First pass or when new routes are detected.
 *   Claude Sonnet navigates all routes, finds issues, then GENERATES Playwright
 *   regression tests for pages that pass. Findings become tasks.
 *
 * Mode 2 — Regression (deterministic, $0): Runs generated Playwright tests.
 *   Only flags AI review for test failures or new/changed routes.
 *   No API calls needed — pure local test execution.
 *
 * Memory agent: distills learnings to optimize costs and efficiency.
 *
 * Resource controls:
 * - Regression tests run async (non-blocking) with a 120s hard timeout
 * - Minimum 12-hour cooldown between inspections (twice a day)
 * - Project route count capped to prevent combinatorial explosion
 * - Memory agent work is done locally (no AI spawn) when possible
 */
import { readFile, writeFile, mkdir, access } from 'fs/promises';
import { resolve } from 'path';
import { PATHS } from '../constants.js';
import { pushNotification } from '../notifications.js';
import { createTask, getAllTasks, migrateIfNeeded } from '../task-store.js';
import { scanAllProjects } from '../project-scanner.js';
import {
	agentSender, getActiveAgents, getMaxConcurrentAgents,
	log, trimSession, upsertSessionMeta
} from './shared.js';
import { spawnClaude } from './agent-spawn.js';
import { logAgentCompletion, parseStreamJsonLog, captureGitBaseline } from './agent-tracking.js';
import { recordEvent } from './agent-analytics.js';
import { registerPid, unregisterPid } from './pid-registry.js';
import type { ChatSession, ChatSender } from '$lib/types/chat.js';

const UX_SESSION_ID = 'claw-ux-inspector';
const GENERATED_TESTS_DIR = 'e2e/generated';
const REGRESSION_TEST_FILE = 'e2e/generated/ux-regression.test.ts';
const INSPECTION_STATE_FILE = '.playground/ux-inspection-state.json';

// Minimum time between inspections (any mode) — prevents churn
const INSPECTION_COOLDOWN_MS = 12 * 60 * 60_000; // 12 hours (twice a day)

// Max project sub-routes to add — prevents combinatorial explosion
const MAX_PROJECT_ROUTES = 21; // 3 projects × 7 sub-routes

// Routes to inspect — all dashboard pages
const INSPECT_ROUTES = [
	'/',
	'/tasks',
	'/chat',
	'/inbox',
	'/models',
	'/agents',
	'/memory',
	'/reports',
	'/services',
	'/settings',
	'/sessions'
];

// Project sub-routes (appended per project)
const PROJECT_SUB_ROUTES = [
	'',
	'/tasks',
	'/agents',
	'/sessions',
	'/channels',
	'/memory',
	'/settings'
];

// Actions to NEVER perform (safety blocklist)
const BLOCKED_ACTIONS = [
	'delete', 'remove', 'disconnect', 'drop', 'reset',
	'clear all', 'purge', 'destroy', 'unlink'
];

export interface UxFinding {
	route: string;
	severity: 'critical' | 'high' | 'medium' | 'low';
	category: 'broken' | 'layout' | 'data' | 'ux' | 'performance' | 'accessibility';
	title: string;
	description: string;
	screenshot?: string;
}

export interface UxInspectionResult {
	inspectedAt: string;
	routesChecked: number;
	findings: UxFinding[];
	tasksCreated: number;
	learnings: string[];
	durationMs: number;
}

interface RouteSnapshot {
	route: string;
	contentHash: string;  // hash of visible text content — detects context changes
	checkedAt: string;
}

interface InspectionState {
	lastDiscoveryAt: string;
	lastRegressionAt: string;
	discoveredRoutes: string[];
	passedRoutes: string[];
	/** Content hashes from last successful inspection — detects context shifts */
	routeSnapshots: RouteSnapshot[];
	generatedTestsExist: boolean;
	consecutiveRegressionPasses: number;
}

/**
 * Run UX inspection — decides between discovery (AI) and regression (local tests).
 *
 * Flow:
 *   1. If no generated tests exist → discovery mode (AI)
 *   2. If generated tests exist → regression mode (Playwright, $0)
 *   3. If regression fails → re-run discovery on failed routes only (AI)
 *   4. If new routes detected → discovery mode for new routes only (AI)
 */
export async function runUxInspection(monitorSession: ChatSession): Promise<void> {
	const agents = getActiveAgents();
	if (agents.size >= getMaxConcurrentAgents()) {
		log(monitorSession, `[ux] Skipping — max agents (${getMaxConcurrentAgents()}) already running`);
		return;
	}

	if (agents.has('ux-inspector') || agents.has('ux-memory')) {
		log(monitorSession, `[ux] Inspector already running — skipping`);
		return;
	}

	const state = await loadInspectionState();

	// Enforce cooldown — prevent rapid churn
	const lastRun = Math.max(
		state.lastDiscoveryAt ? new Date(state.lastDiscoveryAt).getTime() : 0,
		state.lastRegressionAt ? new Date(state.lastRegressionAt).getTime() : 0
	);
	if (lastRun > 0 && Date.now() - lastRun < INSPECTION_COOLDOWN_MS) {
		log(monitorSession, `[ux] Skipping — cooldown (${Math.round((INSPECTION_COOLDOWN_MS - (Date.now() - lastRun)) / 1000)}s remaining)`);
		return;
	}

	const allRoutes = await collectRoutes();
	const hasGeneratedTests = await fileExists(resolve(PATHS.root, 'dashboard', REGRESSION_TEST_FILE));

	// Determine which routes need AI review:
	// 1. New routes (not in passedRoutes)
	// 2. Routes that previously failed (not in passedRoutes)
	// 3. Routes whose content context changed (detected via regression test content checks)
	const newRoutes = allRoutes.filter(r => !state.passedRoutes.includes(r));

	if (!hasGeneratedTests || state.passedRoutes.length === 0) {
		// First run ever — AI inspects everything
		await runDiscoveryInspection(monitorSession, allRoutes, 'initial', state);
	} else if (newRoutes.length > 0) {
		// New features/routes detected — AI inspects only the new ones
		log(monitorSession, `[ux] ${newRoutes.length} new/uncovered route(s) detected — running incremental discovery`);
		await runDiscoveryInspection(monitorSession, newRoutes, 'incremental', state);
	} else {
		// All routes covered — run regression tests locally ($0)
		// Regression failures will auto-trigger AI re-inspection on failed routes
		await runRegressionTests(monitorSession, state);
	}
}

// ── Async Playwright runner (non-blocking) ──────────────────────────

interface PlaywrightOutput {
	stdout: string;
	stderr: string;
}

function execPlaywright(cmd: string, cwd: string, timeoutMs: number): Promise<PlaywrightOutput> {
	return new Promise((resolve) => {
		import('child_process').then(({ exec }) => {
			const child = exec(cmd, {
				cwd,
				timeout: timeoutMs,
				windowsHide: true,
				maxBuffer: 10 * 1024 * 1024,
				env: { ...process.env, FORCE_COLOR: '0' }
			}, (_err, stdout, stderr) => {
				// Playwright exits non-zero on test failures — still return output
				// Keep stdout and stderr separate so JSON parsing only uses stdout
				resolve({ stdout: stdout || '', stderr: stderr || '' });
			});
			// Hard safety timeout — kill if still running at 2x
			const safety = setTimeout(() => {
				try { child.kill(); } catch { /* already dead */ }
				resolve({ stdout: '', stderr: '' });
			}, timeoutMs * 2);
			child.on('close', () => clearTimeout(safety));
		});
	});
}

// ── Regression Mode ($0, local Playwright tests) ────────────────────

async function runRegressionTests(monitorSession: ChatSession, state: InspectionState): Promise<void> {
	log(monitorSession, `[ux] Running regression tests ($0) — ${state.passedRoutes.length} routes covered`);

	const startTime = Date.now();

	try {
		const { stdout } = await execPlaywright(
			`npx playwright test ${REGRESSION_TEST_FILE} --reporter=json`,
			resolve(PATHS.root, 'dashboard'),
			120_000
		);

		const durationMs = Date.now() - startTime;

		// Parse Playwright JSON output — only from stdout (stderr contains warnings/noise)
		let results: { suites?: Array<{ specs?: Array<{ ok: boolean; title: string }> }> } = {};
		try {
			results = JSON.parse(stdout);
		} catch {
			// Output might have non-JSON prefix — try to extract
			const jsonStart = stdout.indexOf('{');
			if (jsonStart >= 0) {
				try { results = JSON.parse(stdout.slice(jsonStart)); } catch { /* give up */ }
			}
		}

		const specs = results.suites?.flatMap(s => s.specs ?? []) ?? [];
		const passed = specs.filter(s => s.ok).length;
		const failed = specs.filter(s => !s.ok).length;

		log(monitorSession, `[ux] Regression: ${passed} passed, ${failed} failed (${(durationMs / 1000).toFixed(1)}s, $0)`);

		state.lastRegressionAt = new Date().toISOString();

		if (failed === 0) {
			state.consecutiveRegressionPasses++;
			await saveInspectionState(state);
			return;
		}

		// Failures detected — flag for AI review on next heartbeat
		state.consecutiveRegressionPasses = 0;
		await saveInspectionState(state);

		const failedTests = specs.filter(s => !s.ok).map(s => s.title);
		log(monitorSession, `[ux] Regression failures — scheduling AI review: ${failedTests.join(', ')}`);

		await pushNotification({
			severity: 'warning',
			category: 'system',
			title: `UX regression: ${failed} test(s) failed`,
			message: failedTests.slice(0, 3).join('; '),
			source: 'claw',
			link: `/chat?session=${UX_SESSION_ID}`,
			linkLabel: 'View Details',
			desktop: true
		});

		// Extract failed routes and re-run discovery on them
		const failedRoutes = failedTests
			.map(t => t.match(/navigates to (.+)/)?.[1] ?? t.match(/renders (.+)/)?.[1])
			.filter(Boolean) as string[];

		if (failedRoutes.length > 0) {
			await runDiscoveryInspection(monitorSession, failedRoutes, 'regression-failure', state);
		}

	} catch (err) {
		const durationMs = Date.now() - startTime;
		const msg = err instanceof Error ? err.message : 'test run failed';
		log(monitorSession, `[ux] Regression test run error (${(durationMs / 1000).toFixed(1)}s): ${msg.slice(0, 200)}`);
	}
}

// ── Discovery Mode (AI + Playwright) ────────────────────────────────

async function runDiscoveryInspection(
	monitorSession: ChatSession,
	routes: string[],
	mode: 'initial' | 'incremental' | 'regression-failure',
	state: InspectionState
): Promise<void> {
	const sender = agentSender('ux-inspector', 'Claw UX Inspector');
	await ensureUxSession(sender);

	const modeLabel = mode === 'initial' ? 'full discovery' :
		mode === 'incremental' ? `incremental (${routes.length} new routes)` :
		`re-inspect (${routes.length} failed routes)`;

	log(monitorSession, `[ux] Starting ${modeLabel} via Claude Sonnet + Playwright`);

	const logFile = resolve(PATHS.headlessLogsDir, `agent-ux-inspector-${Date.now()}.log`);
	await mkdir(PATHS.headlessLogsDir, { recursive: true }).catch(() => {});

	const prompt = buildDiscoveryPrompt(routes, mode, state);

	try {
		const baseline = await captureGitBaseline();
		const child = await spawnClaude(prompt, logFile, { model: 'claude-sonnet-4-6' });
		const pid = child.pid ?? 0;
		const agents = getActiveAgents();

		agents.set('ux-inspector', {
			taskId: 'ux-inspector',
			pid,
			startedAt: new Date().toISOString(),
			sender,
			logFile,
			lastLogPos: 0,
			reportSessionId: UX_SESSION_ID,
			gitBaseline: baseline
		});

		registerPid(pid, 'agent:ux-inspector', 'agent').catch(() => {});

		await recordEvent({
			taskId: 'ux-inspector',
			taskTitle: `UX Inspection (${mode})`,
			type: 'spawned',
			model: 'claude-sonnet-4-6',
			modelTier: 'sonnet',
			provider: 'claude-code',
			pid
		});

		child.on('close', async (code) => {
			unregisterPid('agent:ux-inspector').catch(() => {});
			agents.delete('ux-inspector');
			const exitMsg = code === 0 ? 'UX inspection complete' : `UX inspector exited with code ${code}`;

			if (code === 0) {
				await processUxResults(logFile, sender, monitorSession, state, routes).catch((err) => {
					const msg = err instanceof Error ? err.message : 'parse failed';
					log(monitorSession, `[ux] Failed to process results: ${msg}`);
				});
			}

			await logAgentCompletion(
				{ id: 'ux-inspector', title: 'UX Inspection' } as any,
				sender, exitMsg, logFile, UX_SESSION_ID, baseline
			).catch(() => {});

			await recordEvent({
				taskId: 'ux-inspector',
				taskTitle: `UX Inspection (${mode})`,
				type: code === 0 ? 'completed' : 'failed',
				model: 'claude-sonnet-4-6',
				modelTier: 'sonnet',
				provider: 'claude-code'
			});

			await pushNotification({
				severity: code === 0 ? 'info' : 'warning',
				category: 'agent',
				title: `UX Inspection finished (${mode})`,
				message: exitMsg,
				source: 'claw',
				link: `/chat?session=${UX_SESSION_ID}`,
				linkLabel: 'View Results',
				desktop: true
			}).catch(() => {});
		});

	} catch (err) {
		const msg = err instanceof Error ? err.message : 'spawn failed';
		log(monitorSession, `[error] Failed to spawn UX inspector: ${msg}`);
		getActiveAgents().delete('ux-inspector');
	}
}

// Frameworks that have a browser-facing UI worth inspecting
const UI_FRAMEWORKS = new Set([
	'sveltekit', 'next.js', 'nuxt', 'remix', 'astro',
	'react', 'vue', 'angular', 'solid', 'svelte',
	'gatsby', 'vite', 'react native', 'expo'
]);

/** Check if a project has a browser-facing UI based on its framework. */
function projectHasUi(config: { framework?: string } | null): boolean {
	if (!config?.framework) return false;
	return UI_FRAMEWORKS.has(config.framework.toLowerCase());
}

/** Collect all routes to inspect, including per-project routes (UI projects only). */
async function collectRoutes(): Promise<string[]> {
	const routes = [...INSPECT_ROUTES];

	try {
		const projects = await scanAllProjects(PATHS.playgroundRegistry, PATHS.root);
		// Cap total project sub-routes to prevent combinatorial explosion
		const maxProjects = Math.min(projects.length, Math.floor(MAX_PROJECT_ROUTES / PROJECT_SUB_ROUTES.length));

		let added = 0;
		for (const project of projects) {
			if (added >= maxProjects) break;

			// Skip projects without a browser-facing UI
			const config = await readProjectConfig(project.path);
			if (!projectHasUi(config)) continue;

			for (const sub of PROJECT_SUB_ROUTES) {
				routes.push(`/projects/${project.id}${sub}`);
			}
			added++;
		}
	} catch { /* registry might not exist */ }

	return routes;
}

/** Read a project's .playground/config.json for framework detection. */
async function readProjectConfig(
	projectPath: string
): Promise<{ framework?: string } | null> {
	try {
		const raw = await readFile(resolve(projectPath, '.playground/config.json'), 'utf-8');
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

function buildDiscoveryPrompt(
	routes: string[],
	mode: 'initial' | 'incremental' | 'regression-failure',
	state: InspectionState
): string {
	const routeList = routes.map(r => `- ${r}`).join('\n');
	const isInitial = mode === 'initial';

	return [
		`You are the Claw UX Inspector — an automated quality assurance agent.`,
		``,
		`## Mode: ${mode === 'initial' ? 'Full Discovery' : mode === 'incremental' ? 'Incremental (new routes only)' : 'Re-inspect (failed regression tests)'}`,
		``,
		`## Tools Available`,
		`You have access to Playwright browser automation via MCP tools.`,
		`The dashboard runs at http://localhost:5173 (dev) or http://localhost:3000 (production).`,
		`Try port 5173 first, fall back to 3000.`,
		``,
		`## Routes to Inspect`,
		routeList,
		``,
		`## Inspection Protocol`,
		`For each route:`,
		`1. Navigate to the page`,
		`2. Wait for content to load (check for loading spinners to disappear)`,
		`3. Take an accessibility snapshot`,
		`4. Check for:`,
		`   - **Broken pages**: 500 errors, blank content, JavaScript errors in console`,
		`   - **Layout issues**: elements clipping into nav/sidebar, overflow, scroll traps`,
		`   - **Data issues**: "No data" when data should exist, stale timestamps, mock/placeholder text`,
		`   - **UX problems**: missing loading states, buttons that don't respond, broken links`,
		`   - **Performance**: pages that take >3s to render, excessive DOM size`,
		`   - **Accessibility**: missing labels, poor contrast references, focus traps`,
		`5. If the page has interactive elements (tabs, filters), try them`,
		``,
		`## SAFETY RULES — CRITICAL`,
		`- You are READ-ONLY. NEVER click: ${BLOCKED_ACTIONS.join(', ')}`,
		`- Do NOT submit forms, create tasks, send messages, or modify any data`,
		`- Do NOT click "Delete", "Remove", "Disconnect", "Reset", or similar destructive buttons`,
		`- You MAY click: tabs, filters, sort buttons, navigation links, expand/collapse`,
		`- You MAY scroll and resize the viewport to test responsive behavior`,
		``,
		`## KEY TASK: Generate Regression Tests`,
		`After inspecting, you MUST write a Playwright test file at \`${REGRESSION_TEST_FILE}\`.`,
		`This file will run on future heartbeats WITHOUT AI — it must be deterministic and self-contained.`,
		``,
		`### Test Generation Rules`,
		`- Test each route that PASSED inspection (pages that work correctly)`,
		`- Tests should verify the page loads, key headings/elements are visible, no console errors`,
		`- For pages with tabs/filters, test that switching tabs works`,
		`- For pages with data, verify data containers exist (not necessarily specific content)`,
		`- Do NOT test routes that have issues — those will be fixed first`,
		`- Include viewport tests: check that no element overflows the sidebar boundary`,
		`- Use \`test.describe\` groups by page section`,
		``,
		`### Example Test Pattern`,
		'```typescript',
		`import { test, expect } from '@playwright/test';`,
		``,
		`test.describe('UX Regression — auto-generated', () => {`,
		`  test('/ renders dashboard without errors', async ({ page }) => {`,
		`    const errors: string[] = [];`,
		`    page.on('pageerror', e => errors.push(e.message));`,
		`    await page.goto('/');`,
		`    await expect(page.getByRole('heading', { name: /dashboard/i })).toBeVisible({ timeout: 5000 });`,
		`    // Verify no content overflows sidebar`,
		`    const main = page.locator('main');`,
		`    const box = await main.boundingBox();`,
		`    if (box) expect(box.x).toBeGreaterThan(50); // not under sidebar`,
		`    expect(errors).toHaveLength(0);`,
		`  });`,
		`});`,
		'```',
		``,
		`## Output Format`,
		`Output TWO sections:`,
		``,
		`### 1. Findings JSON`,
		'```json',
		`{`,
		`  "findings": [{ "route": "/path", "severity": "...", "category": "...", "title": "...", "description": "..." }],`,
		`  "passedRoutes": ["/routes/that/are/fine"],`,
		`  "learnings": ["insight 1", "insight 2"],`,
		`  "summary": { "routesChecked": 0, "issuesFound": 0, "criticalCount": 0, "pagesWorking": 0 }`,
		`}`,
		'```',
		``,
		`### 2. Write the test file`,
		`Write the test file to \`dashboard/${REGRESSION_TEST_FILE}\` using your file tools.`,
		`This is the most important output — it makes future runs free ($0).`,
		``,
		`### Content Context Checks`,
		`For each passed route, include a content context assertion in the test:`,
		`- Count key data elements (e.g., number of cards, table rows, list items)`,
		`- Check if "empty state" vs "has data" — so we detect if a page regresses from showing data to empty`,
		`- This catches context shifts (e.g., a page that showed 5 tasks now shows 0)`,
		``,
		`## Learnings — What to Note`,
		`- Which pages load fastest/slowest?`,
		`- Repeated issues across pages? (one fix resolves many)`,
		`- Routes that never change? (skip in future)`,
		`- Cost optimization insights`,
	].join('\n');
}

/** Process the inspector's output — create tasks, store learnings, update state */
async function processUxResults(
	logFile: string,
	sender: ChatSender,
	monitorSession: ChatSession,
	state: InspectionState,
	inspectedRoutes: string[]
): Promise<void> {
	const parsed = await parseStreamJsonLog(logFile);
	const content = parsed.text;
	if (!content) return;

	// Extract JSON
	const jsonMatch = content.match(/```json\s*\n(\{[\s\S]*?\})\s*\n```/);
	if (!jsonMatch) {
		log(monitorSession, `[ux] No structured findings in output`);
		return;
	}

	let result: {
		findings?: UxFinding[];
		passedRoutes?: string[];
		learnings?: string[];
		summary?: { routesChecked: number; issuesFound: number; criticalCount: number; pagesWorking: number };
	};

	try {
		result = JSON.parse(jsonMatch[1]);
	} catch {
		log(monitorSession, `[ux] Failed to parse findings JSON`);
		return;
	}

	const findings = result.findings ?? [];
	const passedRoutes = result.passedRoutes ?? [];
	const learnings = result.learnings ?? [];
	const summary = result.summary ?? { routesChecked: inspectedRoutes.length, issuesFound: findings.length, criticalCount: 0, pagesWorking: passedRoutes.length };

	// Update inspection state with newly passed routes
	const allPassed = new Set([...state.passedRoutes, ...passedRoutes]);
	// Remove routes that now have issues
	for (const f of findings) {
		allPassed.delete(f.route);
	}
	state.passedRoutes = [...allPassed];
	state.discoveredRoutes = [...new Set([...state.discoveredRoutes, ...inspectedRoutes])];
	state.lastDiscoveryAt = new Date().toISOString();
	state.generatedTestsExist = await fileExists(resolve(PATHS.root, 'dashboard', REGRESSION_TEST_FILE));
	state.consecutiveRegressionPasses = 0;
	await saveInspectionState(state);

	// Create tasks from findings
	let tasksCreated = 0;
	if (findings.length > 0) {
		tasksCreated = await createTasksFromFindings(findings, sender);
	}

	// Store learnings for memory agent
	if (learnings.length > 0) {
		await storeLearnings(learnings, findings, sender, state);
	}

	// Save inspection result
	const inspectionResult: UxInspectionResult = {
		inspectedAt: new Date().toISOString(),
		routesChecked: summary.routesChecked,
		findings,
		tasksCreated,
		learnings,
		durationMs: 0
	};

	const resultsPath = resolve(PATHS.root, '.playground', 'ux-inspection.json');
	await mkdir(resolve(PATHS.root, '.playground'), { recursive: true }).catch(() => {});
	await writeFile(resultsPath, JSON.stringify(inspectionResult, null, '\t'), 'utf-8');

	// Log summary
	const severityCounts = {
		critical: findings.filter(f => f.severity === 'critical').length,
		high: findings.filter(f => f.severity === 'high').length,
		medium: findings.filter(f => f.severity === 'medium').length,
		low: findings.filter(f => f.severity === 'low').length
	};

	const testStatus = state.generatedTestsExist
		? `regression tests generated for ${passedRoutes.length} routes`
		: `no regression tests generated (all routes had issues?)`;

	log(monitorSession,
		`[ux] Discovery complete — ${summary.routesChecked} routes, ${findings.length} issues ` +
		`(${severityCounts.critical} critical, ${severityCounts.high} high) — ` +
		`${tasksCreated} tasks created, ${learnings.length} learnings — ${testStatus}`
	);

	if (severityCounts.critical > 0) {
		await pushNotification({
			severity: 'critical',
			category: 'system',
			title: `UX Inspector found ${severityCounts.critical} critical issue(s)`,
			message: findings.filter(f => f.severity === 'critical').map(f => f.title).join('; '),
			source: 'claw',
			link: `/chat?session=${UX_SESSION_ID}`,
			linkLabel: 'View Findings',
			desktop: true
		});
	}

	// Update UX session with summary
	const uxSession = await loadUxSession();
	log(uxSession, `## Inspection Summary (${state.generatedTestsExist ? 'tests generated' : 'discovery'})`, sender);
	log(uxSession, `- Routes checked: ${summary.routesChecked}`, sender);
	log(uxSession, `- Passed: ${passedRoutes.length} — Issues: ${findings.length}`, sender);
	log(uxSession, `- Tasks created: ${tasksCreated}`, sender);
	log(uxSession, `- Learnings: ${learnings.length}`, sender);
	if (findings.length > 0) {
		log(uxSession, `\n### Findings`, sender);
		for (const f of findings) {
			log(uxSession, `- **[${f.severity}]** ${f.route}: ${f.title}`, sender);
		}
	}
	if (passedRoutes.length > 0) {
		log(uxSession, `\n### Passed (regression tests cover these)`, sender);
		log(uxSession, passedRoutes.map(r => `- \`${r}\``).join('\n'), sender);
	}

	trimSession(uxSession);
	uxSession.status = 'idle';
	uxSession.updatedAt = new Date().toISOString();
	await writeFile(`${PATHS.chatsDir}/${UX_SESSION_ID}.json`, JSON.stringify(uxSession, null, '\t'), 'utf-8');
	await upsertSessionMeta({
		id: UX_SESSION_ID,
		title: 'Claw UX Inspector',
		model: 'claude-sonnet-4-6',
		provider: 'claude-code',
		messageCount: uxSession.messages.length,
		createdAt: uxSession.createdAt,
		updatedAt: uxSession.updatedAt,
		source: 'claw',
		status: 'idle'
	});
}

/** Create tasks from UX findings, deduplicating against existing tasks */
async function createTasksFromFindings(findings: UxFinding[], sender: ChatSender): Promise<number> {
	await migrateIfNeeded(PATHS.root);
	const existing = await getAllTasks(PATHS.root);
	const existingTitles = new Set(existing.map(t => t.title.toLowerCase()));

	let created = 0;

	for (const finding of findings.slice(0, 20)) {
		const title = `[UX] ${finding.title}`;
		if (existingTitles.has(title.toLowerCase())) continue;

		try {
			await createTask(PATHS.root, {
				title,
				description: `**Route**: \`${finding.route}\`\n**Category**: ${finding.category}\n\n${finding.description}`,
				priority: finding.severity,
				tags: ['ux-inspector', finding.category, 'automated'],
				feature: 'ux-quality',
				assignee: finding.severity === 'critical' ? 'claw' : null,
				createdBy: 'claw-ux-inspector'
			});
			created++;
			existingTitles.add(title.toLowerCase());
		} catch { /* task creation failed */ }
	}

	return created;
}

/** Store learnings in a memory file for the documenting/memory agent */
async function storeLearnings(
	learnings: string[],
	findings: UxFinding[],
	_sender: ChatSender,
	inspectionState: InspectionState
): Promise<void> {
	const learningsPath = resolve(PATHS.root, '.playground', 'ux-learnings.json');
	let existing: Array<{ learning: string; timestamp: string; source: string; context?: string }> = [];

	try {
		const raw = await readFile(learningsPath, 'utf-8');
		existing = JSON.parse(raw);
	} catch { /* file doesn't exist yet */ }

	const timestamp = new Date().toISOString();

	// Add new learnings
	for (const learning of learnings) {
		// Deduplicate by checking similarity (simple substring check)
		const isDuplicate = existing.some(e =>
			e.learning.toLowerCase().includes(learning.toLowerCase().slice(0, 50)) ||
			learning.toLowerCase().includes(e.learning.toLowerCase().slice(0, 50))
		);
		if (!isDuplicate) {
			existing.push({
				learning,
				timestamp,
				source: 'ux-inspector'
			});
		}
	}

	// Add meta-learnings from finding patterns
	const categoryCounts = new Map<string, number>();
	for (const f of findings) {
		categoryCounts.set(f.category, (categoryCounts.get(f.category) ?? 0) + 1);
	}

	for (const [category, count] of categoryCounts) {
		if (count >= 3) {
			const pattern = `Recurring ${category} issues (${count} found) — consider creating a shared fix or component pattern`;
			const isDuplicate = existing.some(e => e.learning.includes(`Recurring ${category}`));
			if (!isDuplicate) {
				existing.push({
					learning: pattern,
					timestamp,
					source: 'ux-inspector-meta',
					context: `${count} ${category} issues across ${new Set(findings.filter(f => f.category === category).map(f => f.route)).size} routes`
				});
			}
		}
	}

	// Keep only last 100 learnings
	if (existing.length > 100) {
		existing = existing.slice(-100);
	}

	await writeFile(learningsPath, JSON.stringify(existing, null, '\t'), 'utf-8');

	// Distill learnings into optimizations locally (no AI spawn needed)
	await distillOptimizationsLocally(existing, findings, inspectionState);
}

/**
 * Distill UX learnings into optimizations locally — no AI spawn needed.
 * Analyzes patterns in learnings and findings to produce the same
 * ux-optimizations.json that the memory agent used to write via Sonnet.
 * Accepts the already-loaded inspection state to avoid re-reading from disk.
 */
async function distillOptimizationsLocally(
	_learnings: Array<{ learning: string; timestamp: string; source: string; context?: string }>,
	findings: UxFinding[],
	inspectionState: InspectionState
): Promise<void> {
	const optPath = resolve(PATHS.root, '.playground', 'ux-optimizations.json');

	// Load existing optimizations to merge with
	let existing: {
		stableRoutes?: string[];
		priorityRoutes?: string[];
		recurringPatterns?: Array<{ pattern: string; affectedRoutes: string[]; estimatedImpact: string }>;
		costOptimizations?: Array<{ optimization: string; estimatedSaving: string; tradeoff: string }>;
		consecutiveClean?: Record<string, number>;
	} = {};
	try {
		existing = JSON.parse(await readFile(optPath, 'utf-8'));
	} catch { /* first run */ }

	// Track consecutive clean counts per route
	const cleanCounts: Record<string, number> = existing.consecutiveClean ?? {};
	const failedRoutes = new Set(findings.map(f => f.route));

	for (const route of inspectionState.passedRoutes) {
		if (failedRoutes.has(route)) {
			cleanCounts[route] = 0;
		} else {
			cleanCounts[route] = (cleanCounts[route] ?? 0) + 1;
		}
	}

	// Stable = 3+ consecutive clean inspections
	const stableRoutes = Object.entries(cleanCounts)
		.filter(([, count]) => count >= 3)
		.map(([route]) => route);

	// Priority = routes that had findings this run
	const priorityRoutes = [...failedRoutes];

	// Detect recurring patterns — group findings by category
	const categoryCounts = new Map<string, { count: number; routes: Set<string> }>();
	for (const f of findings) {
		const entry = categoryCounts.get(f.category) ?? { count: 0, routes: new Set() };
		entry.count++;
		entry.routes.add(f.route);
		categoryCounts.set(f.category, entry);
	}

	const recurringPatterns = [...categoryCounts.entries()]
		.filter(([, v]) => v.count >= 2)
		.map(([category, v]) => ({
			pattern: `Recurring ${category} issues (${v.count} found)`,
			affectedRoutes: [...v.routes],
			estimatedImpact: v.count >= 4 ? 'high' : v.count >= 2 ? 'medium' : 'low'
		}));

	// Cost optimizations based on stable route count
	const costOptimizations: Array<{ optimization: string; estimatedSaving: string; tradeoff: string }> = [];
	if (stableRoutes.length >= 3) {
		costOptimizations.push({
			optimization: `Skip ${stableRoutes.length} stable routes in discovery mode`,
			estimatedSaving: `${Math.round(stableRoutes.length / Math.max(inspectionState.passedRoutes.length, 1) * 100)}% fewer AI-inspected routes`,
			tradeoff: 'Regressions on stable routes only caught by Playwright tests'
		});
	}

	const optimizations = {
		lastAnalyzed: new Date().toISOString(),
		stableRoutes,
		priorityRoutes,
		recurringPatterns,
		costOptimizations,
		consecutiveClean: cleanCounts
	};

	await mkdir(resolve(PATHS.root, '.playground'), { recursive: true }).catch(() => {});
	await writeFile(optPath, JSON.stringify(optimizations, null, '\t'), 'utf-8');
}

async function ensureUxSession(sender: ChatSender): Promise<void> {
	const sessionPath = `${PATHS.chatsDir}/${UX_SESSION_ID}.json`;
	const now = new Date().toISOString();

	const session: ChatSession = {
		id: UX_SESSION_ID,
		model: 'claude-sonnet-4-6',
		provider: 'claude-code',
		createdAt: now,
		updatedAt: now,
		messages: [{
			role: 'system',
			content: 'Claw UX Inspector — automated Playwright-based UX testing. Findings create tasks; learnings optimize future runs.'
		}],
		source: 'claw',
		status: 'streaming'
	};

	await writeFile(sessionPath, JSON.stringify(session, null, '\t'), 'utf-8');
	await upsertSessionMeta({
		id: UX_SESSION_ID,
		title: 'Claw UX Inspector',
		model: 'claude-sonnet-4-6',
		provider: 'claude-code',
		messageCount: 1,
		createdAt: now,
		updatedAt: now,
		source: 'claw',
		status: 'streaming'
	});
}

async function loadUxSession(): Promise<ChatSession> {
	try {
		const raw = await readFile(`${PATHS.chatsDir}/${UX_SESSION_ID}.json`, 'utf-8');
		return JSON.parse(raw);
	} catch {
		const now = new Date().toISOString();
		return {
			id: UX_SESSION_ID,
			model: 'claude-sonnet-4-6',
			provider: 'claude-code',
			createdAt: now,
			updatedAt: now,
			messages: [],
			source: 'claw',
			status: 'idle'
		};
	}
}

// ── State Management ────────────────────────────────────────────────

async function loadInspectionState(): Promise<InspectionState> {
	try {
		const raw = await readFile(resolve(PATHS.root, INSPECTION_STATE_FILE), 'utf-8');
		return JSON.parse(raw);
	} catch {
		return {
			lastDiscoveryAt: '',
			lastRegressionAt: '',
			discoveredRoutes: [],
			passedRoutes: [],
			routeSnapshots: [],
			generatedTestsExist: false,
			consecutiveRegressionPasses: 0
		};
	}
}

async function saveInspectionState(state: InspectionState): Promise<void> {
	const dir = resolve(PATHS.root, '.playground');
	await mkdir(dir, { recursive: true }).catch(() => {});
	await writeFile(resolve(PATHS.root, INSPECTION_STATE_FILE), JSON.stringify(state, null, '\t'), 'utf-8');
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Load optimizations from previous memory agent runs.
 * Used by the inspector to skip stable routes and focus on priority ones.
 */
export async function loadOptimizations(): Promise<{
	stableRoutes: string[];
	priorityRoutes: string[];
} | null> {
	try {
		const raw = await readFile(resolve(PATHS.root, '.playground', 'ux-optimizations.json'), 'utf-8');
		const data = JSON.parse(raw);
		return {
			stableRoutes: data.stableRoutes ?? [],
			priorityRoutes: data.priorityRoutes ?? []
		};
	} catch {
		return null;
	}
}
