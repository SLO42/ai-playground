/**
 * Project Manager — bootstraps per-project PM agent with SQLite-backed memory.
 * Creates initial plan, opens discussion for user refinement, and maintains
 * roadmap state as the project evolves.
 *
 * Memory: SQLite at .playground/pm-memory.db (via pm-memory-db.ts)
 * Plan: JSON at .playground/project-plan.json
 */
import { readFile, writeFile, mkdir } from 'fs/promises';
import { resolve } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { detectProjectMeta } from './project-scanner.js';
import { readJsonFile } from './file-reader.js';
import * as pmDb from './pm-memory-db.js';
import type { ProjectPlan, PMBootstrapContext, Milestone } from '$lib/types/project-plan.js';
import type { DetectedProjectMeta } from '$lib/types/projects.js';

const execFileAsync = promisify(execFile);

// ── Plan CRUD (JSON) ─────────────────────────────────────────────────

function planPath(projectPath: string): string {
	return resolve(projectPath, '.playground/project-plan.json');
}

export async function loadPlan(projectPath: string): Promise<ProjectPlan | null> {
	return readJsonFile<ProjectPlan>(planPath(projectPath));
}

export async function savePlan(projectPath: string, plan: ProjectPlan): Promise<void> {
	await mkdir(resolve(projectPath, '.playground'), { recursive: true });
	await writeFile(planPath(projectPath), JSON.stringify(plan, null, '\t'), 'utf-8');
}

export function createEmptyPlan(updatedBy: string): ProjectPlan {
	return {
		version: 1,
		vision: '',
		definitionOfDone: [],
		roadmap: [],
		decisions: [],
		lastUpdated: new Date().toISOString(),
		updatedBy
	};
}

// ── Bootstrap context gathering ──────────────────────────────────────

async function getRecentCommits(projectPath: string, count = 10): Promise<string[]> {
	try {
		const { stdout } = await execFileAsync(
			'git', ['log', `--max-count=${count}`, '--pretty=format:%s'],
			{ cwd: projectPath, timeout: 5000, windowsHide: true, encoding: 'utf-8' }
		);
		return stdout.trim().split('\n').filter(Boolean);
	} catch {
		return [];
	}
}

async function getReadmeExcerpt(projectPath: string): Promise<string | undefined> {
	try {
		const content = await readFile(resolve(projectPath, 'README.md'), 'utf-8');
		return content.slice(0, 500);
	} catch {
		return undefined;
	}
}

export async function gatherBootstrapContext(
	projectPath: string,
	meta: DetectedProjectMeta,
	existingTaskTitles: string[] = []
): Promise<PMBootstrapContext> {
	const [commits, readme] = await Promise.all([
		getRecentCommits(projectPath),
		getReadmeExcerpt(projectPath)
	]);

	let projectName = resolve(projectPath).split(/[\\/]/).pop() ?? 'unknown';
	try {
		const raw = await readFile(resolve(projectPath, '.playground/config.json'), 'utf-8');
		const config = JSON.parse(raw);
		if (config.name) projectName = config.name;
	} catch { /* use directory name */ }

	return {
		projectName,
		language: meta.language,
		framework: meta.framework,
		techStack: [meta.language, meta.framework, meta.buildTool].filter(Boolean) as string[],
		hasTests: !!meta.testCommand,
		hasCi: meta.workflows.length > 0,
		hasDocs: meta.maintenance.hasDocsDir,
		gitRemote: meta.gitRemote,
		branches: meta.branches,
		recentCommitMessages: commits,
		existingTasks: existingTaskTitles,
		readmeExcerpt: readme
	};
}

// ── Bootstrap PM ─────────────────────────────────────────────────────

export async function bootstrapProjectManager(projectPath: string): Promise<{
	plan: ProjectPlan;
	context: PMBootstrapContext;
}> {
	const meta = await detectProjectMeta(projectPath);
	const context = await gatherBootstrapContext(projectPath, meta);

	// Create initial plan
	const plan = createEmptyPlan('project-manager');
	plan.vision = buildInitialVision(context);
	plan.definitionOfDone = buildInitialDoD(context);
	plan.roadmap = buildInitialRoadmap(context);
	await savePlan(projectPath, plan);

	// Store initial observations in SQLite memory
	const observations: { type: 'observation' | 'risk'; content: string; source: string; confidence: number }[] = [
		{
			type: 'observation',
			content: `Project "${context.projectName}" detected as ${context.language ?? 'unknown'}/${context.framework ?? 'unknown'} project.`,
			source: 'bootstrap-scan',
			confidence: 0.9
		}
	];

	if (context.gitRemote) {
		observations.push({
			type: 'observation',
			content: `Git remote: ${context.gitRemote}. ${context.branches.length} branch(es): ${context.branches.slice(0, 5).join(', ')}`,
			source: 'bootstrap-scan',
			confidence: 1.0
		});
	}

	if (!context.hasTests) {
		observations.push({
			type: 'risk',
			content: 'No test command detected. Testing infrastructure should be a priority.',
			source: 'bootstrap-scan',
			confidence: 0.8
		});
	}

	if (!context.hasCi) {
		observations.push({
			type: 'risk',
			content: 'No CI/CD workflows detected. Automated quality checks should be set up.',
			source: 'bootstrap-scan',
			confidence: 0.8
		});
	}

	if (context.recentCommitMessages.length > 0) {
		const themes = context.recentCommitMessages.slice(0, 5).join('; ');
		observations.push({
			type: 'observation',
			content: `Recent development focus: ${themes}`,
			source: 'bootstrap-scan',
			confidence: 0.7
		});
	}

	if (context.readmeExcerpt) {
		observations.push({
			type: 'observation',
			content: `README excerpt: ${context.readmeExcerpt.slice(0, 200)}`,
			source: 'bootstrap-scan',
			confidence: 0.85
		});
	}

	pmDb.addEntries(projectPath, observations);
	pmDb.recordReview(projectPath);

	return { plan, context };
}

// ── Initial plan generation ──────────────────────────────────────────

function buildInitialVision(ctx: PMBootstrapContext): string {
	if (ctx.readmeExcerpt) {
		const firstSentence = ctx.readmeExcerpt.split(/[.!?]\s/)[0];
		if (firstSentence && firstSentence.length > 10) {
			return firstSentence.trim();
		}
	}
	const parts = [ctx.projectName];
	if (ctx.framework) parts.push(`(${ctx.framework})`);
	return `${parts.join(' ')} — vision to be defined in discussion with user`;
}

function buildInitialDoD(ctx: PMBootstrapContext): string[] {
	const dod: string[] = [];
	if (!ctx.hasTests) dod.push('Test suite established with passing tests');
	if (!ctx.hasCi) dod.push('CI/CD pipeline configured and green');
	if (!ctx.hasDocs) dod.push('Documentation covering setup and usage');
	dod.push('All planned milestones completed');
	dod.push('No critical or high-priority open issues');
	return dod;
}

function buildInitialRoadmap(ctx: PMBootstrapContext): Milestone[] {
	const milestones: Milestone[] = [];

	const infraGoals: string[] = [];
	if (!ctx.hasTests) infraGoals.push('Set up testing framework and initial test suite');
	if (!ctx.hasCi) infraGoals.push('Configure CI/CD pipeline');
	if (!ctx.hasDocs) infraGoals.push('Create basic documentation');

	if (infraGoals.length > 0) {
		milestones.push({
			id: 'ms-infrastructure',
			name: 'Project Infrastructure',
			status: 'planned',
			goals: infraGoals,
			acceptanceCriteria: infraGoals.map(g => `${g} — verified working`),
			tasks: [],
			dependencies: []
		});
	}

	milestones.push({
		id: 'ms-core',
		name: 'Core Development',
		status: ctx.recentCommitMessages.length > 0 ? 'active' : 'planned',
		goals: ['Core features implemented and functional'],
		acceptanceCriteria: ['To be defined in PM discussion'],
		tasks: [],
		dependencies: infraGoals.length > 0 ? ['ms-infrastructure'] : []
	});

	milestones.push({
		id: 'ms-release',
		name: 'Release Ready',
		status: 'planned',
		goals: ['Production-ready release'],
		acceptanceCriteria: ['All tests passing', 'Documentation complete', 'No known critical bugs'],
		tasks: [],
		dependencies: ['ms-core']
	});

	return milestones;
}

// ── Discussion prompt ────────────────────────────────────────────────

export function buildPMDiscussionPrompt(ctx: PMBootstrapContext, plan: ProjectPlan): string {
	const lines: string[] = [
		`I'm your Project Manager for **${ctx.projectName}**. I've scanned the project and here's what I understand so far:`,
		``
	];

	lines.push(`**Project Profile**:`);
	if (ctx.language || ctx.framework) {
		lines.push(`- Stack: ${ctx.techStack.join(', ')}`);
	}
	lines.push(`- Tests: ${ctx.hasTests ? 'yes' : 'not detected'}`);
	lines.push(`- CI/CD: ${ctx.hasCi ? 'yes' : 'not detected'}`);
	lines.push(`- Docs: ${ctx.hasDocs ? 'yes' : 'not detected'}`);
	if (ctx.branches.length > 1) {
		lines.push(`- Active branches: ${ctx.branches.slice(0, 5).join(', ')}`);
	}
	if (ctx.recentCommitMessages.length > 0) {
		lines.push(`- Recent work: ${ctx.recentCommitMessages.slice(0, 3).join('; ')}`);
	}

	lines.push(``);
	lines.push(`**Working Vision**: ${plan.vision}`);

	if (plan.roadmap.length > 0) {
		lines.push(``);
		lines.push(`**Initial Roadmap** (${plan.roadmap.length} milestones):`);
		for (const ms of plan.roadmap) {
			const icon = ms.status === 'active' ? '🔵' : '⬜';
			lines.push(`${icon} **${ms.name}**: ${ms.goals[0]}`);
		}
	}

	if (plan.definitionOfDone.length > 0) {
		lines.push(``);
		lines.push(`**Definition of Done**:`);
		for (const d of plan.definitionOfDone) {
			lines.push(`- [ ] ${d}`);
		}
	}

	lines.push(``);
	lines.push(`**I'd like your input on**:`);
	lines.push(`1. Is this vision accurate? What's the real goal for this project?`);
	lines.push(`2. What milestones matter most to you right now?`);
	lines.push(`3. Any key architectural decisions already made that I should know about?`);
	lines.push(`4. What does "done" look like for you?`);

	if (ctx.existingTasks.length > 0) {
		lines.push(``);
		lines.push(`I see ${ctx.existingTasks.length} existing task(s). I'll link those to milestones once we align on the roadmap.`);
	}

	lines.push(``);
	lines.push(`Reply here and I'll refine the roadmap based on your input. My memory for this project is stored in a dedicated database — view it anytime in the dashboard under Project Manager.`);

	return lines.join('\n');
}

// ── GitHub Project Board Sync ────────────────────────────────────────

export async function syncToGitHubBoard(
	projectPath: string,
	plan: ProjectPlan,
	gitRemote?: string
): Promise<{ synced: boolean; error?: string }> {
	if (!gitRemote) return { synced: false, error: 'No git remote configured' };

	const match = gitRemote.match(/github\.com[:/]([^/]+\/[^/.]+)/);
	if (!match) return { synced: false, error: 'Not a GitHub remote' };
	const repo = match[1];

	try {
		await execFileAsync('gh', ['--version'], { timeout: 3000, windowsHide: true, encoding: 'utf-8' });
	} catch {
		return { synced: false, error: 'gh CLI not available' };
	}

	try {
		for (const milestone of plan.roadmap) {
			const title = `[PM] ${milestone.name}`;
			const body = [
				`## Milestone: ${milestone.name}`,
				`**Status**: ${milestone.status}`,
				milestone.targetDate ? `**Target**: ${milestone.targetDate}` : '',
				``,
				`### Goals`,
				...milestone.goals.map(g => `- ${g}`),
				``,
				`### Acceptance Criteria`,
				...milestone.acceptanceCriteria.map(c => `- [ ] ${c}`),
				``,
				`_Managed by Project Manager agent — do not edit directly_`
			].filter(Boolean).join('\n');

			const { stdout: existing } = await execFileAsync(
				'gh', ['issue', 'list', '--repo', repo, '--search', `"${title}" in:title`, '--json', 'number,title', '--limit', '1'],
				{ cwd: projectPath, timeout: 10000, windowsHide: true, encoding: 'utf-8' }
			);

			const issues = JSON.parse(existing || '[]');
			if (issues.length > 0) {
				await execFileAsync(
					'gh', ['issue', 'edit', String(issues[0].number), '--repo', repo, '--body', body],
					{ cwd: projectPath, timeout: 10000, windowsHide: true, encoding: 'utf-8' }
				);
			} else {
				const labels = ['project-manager', `milestone:${milestone.status}`];
				await execFileAsync(
					'gh', ['issue', 'create', '--repo', repo, '--title', title, '--body', body, '--label', labels.join(',')],
					{ cwd: projectPath, timeout: 10000, windowsHide: true, encoding: 'utf-8' }
				);
			}
		}
		return { synced: true };
	} catch (err) {
		const msg = err instanceof Error ? err.message : 'sync failed';
		return { synced: false, error: msg };
	}
}

// ── Heartbeat review ─────────────────────────────────────────────────

export async function reviewProjectPlan(projectPath: string): Promise<{
	reviewed: boolean;
	observations: string[];
}> {
	const plan = await loadPlan(projectPath);
	if (!plan) return { reviewed: false, observations: [] };

	const observations: string[] = [];
	let planChanged = false;

	const { getAllTasks } = await import('./task-store.js');
	const tasks = await getAllTasks(projectPath).catch(() => []);

	for (const milestone of plan.roadmap) {
		if (milestone.status === 'completed') continue;

		const linkedTasks = tasks.filter(t => milestone.tasks.includes(t.id));
		const completedCount = linkedTasks.filter(t => t.status === 'completed').length;
		const totalLinked = linkedTasks.length;

		if (totalLinked > 0 && completedCount === totalLinked) {
			milestone.status = 'completed';
			milestone.completedAt = new Date().toISOString();
			planChanged = true;
			observations.push(`Milestone "${milestone.name}" completed — all ${totalLinked} linked tasks done`);

			for (const ms of plan.roadmap) {
				if (ms.status === 'planned' && ms.dependencies.includes(milestone.id)) {
					const allDepsDone = ms.dependencies.every(
						depId => plan.roadmap.find(m => m.id === depId)?.status === 'completed'
					);
					if (allDepsDone) {
						ms.status = 'active';
						planChanged = true;
						observations.push(`Milestone "${ms.name}" activated — all dependencies met`);
					}
				}
			}
		} else if (totalLinked > 0) {
			observations.push(`Milestone "${milestone.name}": ${completedCount}/${totalLinked} tasks complete`);
		}
	}

	if (planChanged) {
		plan.lastUpdated = new Date().toISOString();
		plan.updatedBy = 'heartbeat-review';
		await savePlan(projectPath, plan);
	}

	// Record review in SQLite memory
	pmDb.recordReview(projectPath);
	if (observations.length > 0) {
		pmDb.addEntries(
			projectPath,
			observations.map(obs => ({
				type: 'observation' as const,
				content: obs,
				source: 'heartbeat-review',
				confidence: 0.9
			}))
		);
	}

	// Auto-archive old low-confidence entries (older than 30 days)
	pmDb.archiveOlderThan(projectPath, 30);

	return { reviewed: true, observations };
}
