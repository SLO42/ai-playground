/**
 * Project Manager — bootstraps per-project PM agent with SQLite-backed memory.
 *
 * Memory: SQLite at .playground/pm-memory.db (via pm-memory-db.ts)
 * Plan: JSON at .playground/project-plan.json
 *
 * Plan v3 structure:
 *   macro.purpose      — what this project IS
 *   macro.longTermVision — where it's going
 *   macro.role          — who the user is
 *   macro.releases[]    — versioned ship points (v0.1, v1.0, v2.0)
 *   macro.phases[]      — phases within releases
 *   macro.featureMap[]  — key features mapped to releases
 *   macro.definitionOfDone — when the whole project is "done"
 *   sprints[]           — time-boxed execution chunks linked to phases
 */
import { readFile, writeFile, mkdir } from 'fs/promises';
import { resolve } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { detectProjectMeta } from './project-scanner.js';
import { readJsonFile } from './file-reader.js';
import * as pmDb from './pm-memory-db.js';
import { recordEvent } from './heartbeat/agent-analytics.js';
import type { ProjectPlan, PMBootstrapContext, Phase, Release, MacroPlan, Sprint } from '$lib/types/project-plan.js';
import type { DetectedProjectMeta } from '$lib/types/projects.js';

const execFileAsync = promisify(execFile);

// ── Plan CRUD ────────────────────────────────────────────────────────

function planPath(projectPath: string): string {
	return resolve(projectPath, '.playground/project-plan.json');
}

export async function loadPlan(projectPath: string): Promise<ProjectPlan | null> {
	const raw = await readJsonFile<Record<string, unknown>>(planPath(projectPath));
	if (!raw) return null;

	// Migrate v1/v2 → v3
	if (!raw.version || (raw.version as number) < 3) {
		const oldRoadmap = (raw as any).roadmap ?? [];
		const oldSprints = (raw as any).sprints ?? [];
		const oldVision = (raw as any).vision ?? '';
		const oldDoD = (raw as any).definitionOfDone ?? [];

		// Convert old milestones → phases under a single "v0.1" release
		const phases: Phase[] = oldRoadmap.map((ms: any) => ({
			id: ms.id,
			name: ms.name,
			status: ms.status ?? 'planned',
			releaseId: 'rel-initial',
			goals: ms.goals ?? [],
			acceptanceCriteria: ms.acceptanceCriteria ?? [],
			tasks: ms.tasks ?? [],
			dependencies: ms.dependencies ?? [],
			sprints: ms.sprints ?? [],
			targetDate: ms.targetDate,
			completedAt: ms.completedAt
		}));

		// Migrate sprints: milestoneId → phaseId
		const sprints: Sprint[] = oldSprints.map((s: any) => ({
			...s,
			phaseId: s.milestoneId ?? s.phaseId ?? ''
		}));

		const plan: ProjectPlan = {
			version: 3,
			macro: {
				purpose: oldVision,
				longTermVision: '',
				role: { title: 'Project Lead', responsibilities: ['Define scope', 'Guide development'] },
				keyHighlights: [],
				featureMap: [],
				releases: [{
					id: 'rel-initial',
					version: 'v0.1',
					name: 'Initial Release',
					status: phases.some(p => p.status === 'active') ? 'active' : 'planned',
					featureComplete: [],
					phases: phases.map(p => p.id),
					targetDate: undefined
				}],
				phases,
				definitionOfDone: oldDoD
			},
			sprints,
			activeSprint: (raw as any).activeSprint ?? null,
			decisions: (raw as any).decisions ?? [],
			lastUpdated: new Date().toISOString(),
			updatedBy: 'migration-v3'
		};

		await savePlan(projectPath, plan);
		return plan;
	}

	return raw as unknown as ProjectPlan;
}

export async function savePlan(projectPath: string, plan: ProjectPlan): Promise<void> {
	await mkdir(resolve(projectPath, '.playground'), { recursive: true });
	await writeFile(planPath(projectPath), JSON.stringify(plan, null, '\t'), 'utf-8');
}

function createEmptyMacro(): MacroPlan {
	return {
		purpose: '',
		longTermVision: '',
		role: { title: '', responsibilities: [] },
		keyHighlights: [],
		featureMap: [],
		releases: [],
		phases: [],
		definitionOfDone: []
	};
}

export function createEmptyPlan(updatedBy: string): ProjectPlan {
	return {
		version: 3,
		macro: createEmptyMacro(),
		sprints: [],
		activeSprint: null,
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

	const plan = createEmptyPlan('project-manager');
	plan.macro = buildInitialMacro(context);
	await savePlan(projectPath, plan);

	// Initial observations in SQLite
	const observations: { type: 'observation' | 'risk'; content: string; source: string; confidence: number }[] = [
		{
			type: 'observation',
			content: `Project "${context.projectName}" — ${context.language ?? 'unknown'}/${context.framework ?? 'unknown'}. Stack: ${context.techStack.join(', ') || 'not detected'}.`,
			source: 'bootstrap-scan',
			confidence: 0.9
		}
	];

	if (context.gitRemote) {
		observations.push({
			type: 'observation',
			content: `Git remote: ${context.gitRemote}. ${context.branches.length} branch(es).`,
			source: 'bootstrap-scan',
			confidence: 1.0
		});
	}
	if (!context.hasTests) {
		observations.push({ type: 'risk', content: 'No test command detected.', source: 'bootstrap-scan', confidence: 0.8 });
	}
	if (!context.hasCi) {
		observations.push({ type: 'risk', content: 'No CI/CD workflows detected.', source: 'bootstrap-scan', confidence: 0.8 });
	}
	if (context.recentCommitMessages.length > 0) {
		observations.push({
			type: 'observation',
			content: `Recent work: ${context.recentCommitMessages.slice(0, 5).join('; ')}`,
			source: 'bootstrap-scan',
			confidence: 0.7
		});
	}
	if (context.readmeExcerpt) {
		observations.push({
			type: 'observation',
			content: `README: ${context.readmeExcerpt.slice(0, 200)}`,
			source: 'bootstrap-scan',
			confidence: 0.85
		});
	}

	pmDb.addEntries(projectPath, observations);
	pmDb.recordReview(projectPath);

	recordEvent({ type: 'pm_spawned', projectId: projectPath }).catch(() => {});

	return { plan, context };
}

// ── Initial macro generation ─────────────────────────────────────────

function buildInitialMacro(ctx: PMBootstrapContext): MacroPlan {
	// Purpose from README or placeholder
	let purpose = `${ctx.projectName} — purpose to be defined in PM discussion`;
	if (ctx.readmeExcerpt) {
		const firstSentence = ctx.readmeExcerpt.split(/[.!?]\s/)[0];
		if (firstSentence && firstSentence.length > 10) purpose = firstSentence.trim();
	}

	// Build initial phases based on detected gaps
	const phases: Phase[] = [];
	const infraGoals: string[] = [];
	if (!ctx.hasTests) infraGoals.push('Set up testing framework');
	if (!ctx.hasCi) infraGoals.push('Configure CI/CD pipeline');
	if (!ctx.hasDocs) infraGoals.push('Create documentation');

	if (infraGoals.length > 0) {
		phases.push({
			id: 'phase-infra',
			name: 'Infrastructure',
			status: 'planned',
			releaseId: 'rel-v01',
			goals: infraGoals,
			acceptanceCriteria: infraGoals.map(g => `${g} — verified`),
			tasks: [],
			dependencies: [],
			sprints: []
		});
	}

	phases.push({
		id: 'phase-core',
		name: 'Core Development',
		status: ctx.recentCommitMessages.length > 0 ? 'active' : 'planned',
		releaseId: 'rel-v01',
		goals: ['Core features implemented'],
		acceptanceCriteria: ['To be defined in PM discussion'],
		tasks: [],
		dependencies: infraGoals.length > 0 ? ['phase-infra'] : [],
		sprints: []
	});

	phases.push({
		id: 'phase-polish',
		name: 'Polish & Ship',
		status: 'planned',
		releaseId: 'rel-v01',
		goals: ['Release-ready quality'],
		acceptanceCriteria: ['All tests passing', 'No critical bugs'],
		tasks: [],
		dependencies: ['phase-core'],
		sprints: []
	});

	const releases: Release[] = [{
		id: 'rel-v01',
		version: 'v0.1',
		name: 'First Release',
		status: phases.some(p => p.status === 'active') ? 'active' : 'planned',
		featureComplete: ['To be defined in PM discussion'],
		phases: phases.map(p => p.id)
	}];

	const dod: string[] = [];
	if (!ctx.hasTests) dod.push('Test suite with passing tests');
	if (!ctx.hasCi) dod.push('CI/CD pipeline green');
	if (!ctx.hasDocs) dod.push('Documentation complete');
	dod.push('All planned releases shipped');
	dod.push('No critical open issues');

	return {
		purpose,
		longTermVision: 'To be defined — discuss the long-term direction in the PM discussion',
		role: {
			title: 'Project Lead',
			responsibilities: [
				'Define project vision and priorities',
				'Review and approve key decisions',
				'Guide development direction'
			]
		},
		keyHighlights: [],
		featureMap: [],
		releases,
		phases,
		definitionOfDone: dod
	};
}

// ── Discussion prompt ────────────────────────────────────────────────

export function buildPMDiscussionPrompt(ctx: PMBootstrapContext, plan: ProjectPlan): string {
	const m = plan.macro;
	const lines: string[] = [
		`I'm your Project Manager for **${ctx.projectName}**. I've scanned the project and built an initial strategic plan. Let's refine it together.`,
		``
	];

	// Identity
	lines.push(`## Project Identity`);
	lines.push(`**Purpose**: ${m.purpose}`);
	lines.push(`**Your Role**: ${m.role.title}`);
	if (ctx.techStack.length > 0) lines.push(`**Stack**: ${ctx.techStack.join(', ')}`);
	lines.push(`**Tests**: ${ctx.hasTests ? 'yes' : 'not detected'} | **CI/CD**: ${ctx.hasCi ? 'yes' : 'not detected'} | **Docs**: ${ctx.hasDocs ? 'yes' : 'not detected'}`);
	if (ctx.recentCommitMessages.length > 0) {
		lines.push(`**Recent work**: ${ctx.recentCommitMessages.slice(0, 3).join('; ')}`);
	}

	// Releases
	lines.push(``);
	lines.push(`## Release Roadmap`);
	for (const rel of m.releases) {
		const icon = rel.status === 'active' ? '🔵' : rel.status === 'completed' ? '✅' : '⬜';
		lines.push(`${icon} **${rel.version}** — ${rel.name}`);
		const relPhases = m.phases.filter(p => p.releaseId === rel.id);
		for (const phase of relPhases) {
			const pIcon = phase.status === 'active' ? '  🔵' : '  ⬜';
			lines.push(`${pIcon} ${phase.name}: ${phase.goals[0] ?? 'TBD'}`);
		}
		if (rel.featureComplete.length > 0 && rel.featureComplete[0] !== 'To be defined in PM discussion') {
			lines.push(`  Feature complete: ${rel.featureComplete.join(', ')}`);
		}
	}

	// DoD
	if (m.definitionOfDone.length > 0) {
		lines.push(``);
		lines.push(`## Definition of Done`);
		for (const d of m.definitionOfDone) lines.push(`- [ ] ${d}`);
	}

	// Sprints
	if (plan.sprints.length > 0) {
		const active = plan.sprints.find(s => s.id === plan.activeSprint);
		lines.push(``);
		lines.push(`## Sprints (${plan.sprints.length})`);
		if (active) lines.push(`Active: **${active.name}** — ${active.goal}`);
	}

	// Questions
	lines.push(``);
	lines.push(`## Let's define this project together`);
	lines.push(`1. **Purpose**: Is "${m.purpose}" accurate? What problem does this project solve?`);
	lines.push(`2. **Your role**: Are you the sole dev, team lead, or contributor? What are your responsibilities?`);
	lines.push(`3. **Releases**: What releases do you envision? (v0.1 MVP, v1.0 stable, v2.0 expansion?)`);
	lines.push(`4. **Key features**: What are the standout capabilities? What makes this project unique?`);
	lines.push(`5. **Feature complete**: For each release, what does "feature complete" mean?`);
	lines.push(`6. **Long-term**: Where does this project go after the first release?`);
	lines.push(`7. **Done**: When is the entire project "done"? Or is it ongoing?`);

	if (ctx.existingTasks.length > 0) {
		lines.push(``);
		lines.push(`I see ${ctx.existingTasks.length} existing task(s) — I'll map them to phases and sprints once we align.`);
	}

	lines.push(``);
	lines.push(`Reply and I'll build out the full macro roadmap. View the plan and my memory anytime in the dashboard.`);

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
		// Sync releases as milestone-level issues
		for (const release of plan.macro.releases) {
			const relPhases = plan.macro.phases.filter(p => p.releaseId === release.id);
			const title = `[PM] Release ${release.version}: ${release.name}`;
			const body = [
				`## Release: ${release.version} — ${release.name}`,
				`**Status**: ${release.status}`,
				release.targetDate ? `**Target**: ${release.targetDate}` : '',
				``,
				`### Feature Complete`,
				...release.featureComplete.map(f => `- [ ] ${f}`),
				``,
				`### Phases`,
				...relPhases.map(p => `- [${p.status === 'completed' ? 'x' : ' '}] **${p.name}**: ${p.goals[0] ?? 'TBD'}`),
				``,
				`_Managed by Project Manager agent_`
			].filter(Boolean).join('\n');

			const { stdout: existing } = await execFileAsync(
				'gh', ['issue', 'list', '--repo', repo, '--search', `"${title}" in:title`, '--json', 'number,title', '--limit', '1'],
				{ cwd: projectPath, timeout: 10000, windowsHide: true, encoding: 'utf-8' }
			);

			const issues = JSON.parse(existing || '[]');
			if (issues.length > 0) {
				await execFileAsync('gh', ['issue', 'edit', String(issues[0].number), '--repo', repo, '--body', body],
					{ cwd: projectPath, timeout: 10000, windowsHide: true, encoding: 'utf-8' });
			} else {
				await execFileAsync('gh', ['issue', 'create', '--repo', repo, '--title', title, '--body', body, '--label', 'project-manager'],
					{ cwd: projectPath, timeout: 10000, windowsHide: true, encoding: 'utf-8' });
			}
		}
		recordEvent({ type: 'pm_sync_completed', projectId: projectPath, count: plan.macro.releases.length }).catch(() => {});
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

	// Sprint progress
	for (const sprint of plan.sprints) {
		if (sprint.status === 'completed') continue;
		const sprintTasks = tasks.filter(t => sprint.tasks.includes(t.id));
		const done = sprintTasks.filter(t => t.status === 'completed').length;
		const total = sprintTasks.length;

		if (total > 0 && done === total) {
			sprint.status = 'completed';
			sprint.completedAt = new Date().toISOString();
			planChanged = true;
			observations.push(`Sprint "${sprint.name}" completed — all ${total} tasks done`);
			if (plan.activeSprint === sprint.id) {
				plan.activeSprint = null;
				observations.push(`Active sprint cleared`);
			}
		} else if (total > 0 && sprint.status === 'active') {
			observations.push(`Sprint "${sprint.name}": ${done}/${total} tasks complete`);
		}
	}

	// Phase progress (includes sprint tasks)
	for (const phase of plan.macro.phases) {
		if (phase.status === 'completed') continue;

		const directTasks = tasks.filter(t => phase.tasks.includes(t.id));
		const sprintTaskIds = new Set<string>();
		for (const sprintId of phase.sprints) {
			const sprint = plan.sprints.find(s => s.id === sprintId);
			if (sprint) sprint.tasks.forEach(id => sprintTaskIds.add(id));
		}
		const sprintTasks = tasks.filter(t => sprintTaskIds.has(t.id));
		const allLinked = [...directTasks, ...sprintTasks];
		const completed = allLinked.filter(t => t.status === 'completed').length;
		const total = allLinked.length;

		if (total > 0 && completed === total) {
			phase.status = 'completed';
			phase.completedAt = new Date().toISOString();
			planChanged = true;
			observations.push(`Phase "${phase.name}" completed — all ${total} tasks done`);

			// Auto-activate dependent phases
			for (const p of plan.macro.phases) {
				if (p.status === 'planned' && p.dependencies.includes(phase.id)) {
					if (p.dependencies.every(depId => plan.macro.phases.find(pp => pp.id === depId)?.status === 'completed')) {
						p.status = 'active';
						planChanged = true;
						observations.push(`Phase "${p.name}" activated`);
					}
				}
			}
		} else if (total > 0) {
			observations.push(`Phase "${phase.name}": ${completed}/${total} tasks complete`);
		}
	}

	// Release progress (all phases done → release done)
	for (const release of plan.macro.releases) {
		if (release.status === 'completed') continue;
		const relPhases = plan.macro.phases.filter(p => release.phases.includes(p.id));
		if (relPhases.length > 0 && relPhases.every(p => p.status === 'completed')) {
			release.status = 'completed';
			release.shippedAt = new Date().toISOString();
			planChanged = true;
			observations.push(`Release ${release.version} "${release.name}" completed — all phases done`);
		}
	}

	if (planChanged) {
		plan.lastUpdated = new Date().toISOString();
		plan.updatedBy = 'heartbeat-review';
		await savePlan(projectPath, plan);
	}

	pmDb.recordReview(projectPath);
	if (observations.length > 0) {
		pmDb.addEntries(projectPath, observations.map(obs => ({
			type: 'observation' as const, content: obs, source: 'heartbeat-review', confidence: 0.9
		})));
	}

	pmDb.archiveOlderThan(projectPath, 30);

	recordEvent({ type: 'pm_reviewed', projectId: projectPath, count: observations.length }).catch(() => {});

	return { reviewed: true, observations };
}
