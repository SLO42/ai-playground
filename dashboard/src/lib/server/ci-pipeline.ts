/**
 * CI/CD Pipeline Visibility — GitHub Actions workflow listing, run status, and triggering.
 *
 * Uses the `gh` CLI to interact with GitHub Actions. All functions return
 * safe defaults on failure (never throw).
 */
import { execSync } from 'child_process';

// ── Types ──────────────────────────────────────────────────────────────

export interface WorkflowRun {
	id: number;
	name: string;
	status: 'queued' | 'in_progress' | 'completed';
	conclusion: 'success' | 'failure' | 'cancelled' | 'skipped' | 'timed_out' | null;
	branch: string;
	commit: string;
	commitMessage: string;
	startedAt: string;
	completedAt: string | null;
	duration: number | null; // seconds
	url: string;
	actor: string;
}

export interface Workflow {
	id: number;
	name: string;
	path: string; // e.g., .github/workflows/ci.yml
	state: 'active' | 'disabled_manually' | 'disabled_inactivity';
	lastRun: WorkflowRun | null;
}

export interface PipelineStatus {
	repo: string;
	workflows: Workflow[];
	recentRuns: WorkflowRun[];
	hasGh: boolean;
}

// ── Constants ──────────────────────────────────────────────────────────

const EXEC_OPTS = { encoding: 'utf-8' as const, timeout: 15_000, windowsHide: true, shell: true };

// ── Helpers ────────────────────────────────────────────────────────────

function ghCli(args: string, cwd: string): string {
	return execSync(`gh ${args}`, { ...EXEC_OPTS, cwd }).trim();
}

function isGhAvailable(cwd: string): boolean {
	try {
		execSync('gh --version', { ...EXEC_OPTS, cwd, timeout: 5_000 });
		return true;
	} catch {
		return false;
	}
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Parse `git remote get-url origin` to extract `owner/repo`.
 * Returns null if the project is not a git repo or has no origin remote.
 */
export function getGitHubRepo(projectPath: string): string | null {
	try {
		const url = execSync('git remote get-url origin', { ...EXEC_OPTS, cwd: projectPath }).trim();
		if (!url) return null;

		// SSH: git@github.com:owner/repo.git
		const sshMatch = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
		if (sshMatch) return sshMatch[1];

		// HTTPS: https://github.com/owner/repo.git
		const httpsMatch = url.match(/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
		if (httpsMatch) return httpsMatch[1];

		return null;
	} catch {
		return null;
	}
}

/**
 * List all workflows defined in the repository.
 */
export async function listWorkflows(projectPath: string): Promise<Workflow[]> {
	try {
		if (!isGhAvailable(projectPath)) return [];

		const raw = ghCli(
			'workflow list --json id,name,path,state --limit 50',
			projectPath
		);

		if (!raw) return [];

		const items = JSON.parse(raw) as Array<{
			id: number;
			name: string;
			path: string;
			state: string;
		}>;

		// Fetch recent runs to attach lastRun to each workflow
		const runs = await listWorkflowRuns(projectPath, { limit: 50 });
		const runsByWorkflow = new Map<string, WorkflowRun>();

		for (const run of runs) {
			if (!runsByWorkflow.has(run.name)) {
				runsByWorkflow.set(run.name, run);
			}
		}

		return items.map((w) => ({
			id: w.id,
			name: w.name,
			path: w.path,
			state: (w.state || 'active') as Workflow['state'],
			lastRun: runsByWorkflow.get(w.name) ?? null
		}));
	} catch {
		return [];
	}
}

/**
 * List recent workflow runs, optionally filtered by workflow name.
 */
export async function listWorkflowRuns(
	projectPath: string,
	options?: { limit?: number; workflow?: string }
): Promise<WorkflowRun[]> {
	try {
		if (!isGhAvailable(projectPath)) return [];

		const limit = options?.limit ?? 20;
		const workflowFilter = options?.workflow ? ` --workflow "${options.workflow}"` : '';

		const raw = ghCli(
			`run list --json databaseId,displayTitle,status,conclusion,headBranch,headSha,event,createdAt,updatedAt,url,actor${workflowFilter} --limit ${limit}`,
			projectPath
		);

		if (!raw) return [];

		const items = JSON.parse(raw) as Array<{
			databaseId: number;
			displayTitle: string;
			status: string;
			conclusion: string;
			headBranch: string;
			headSha: string;
			event: string;
			createdAt: string;
			updatedAt: string;
			url: string;
			actor: { login: string };
		}>;

		return items.map((r) => {
			const startedAt = r.createdAt;
			const completedAt = r.status === 'completed' ? r.updatedAt : null;
			let duration: number | null = null;

			if (startedAt && completedAt) {
				duration = Math.round(
					(new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 1000
				);
			}

			return {
				id: r.databaseId,
				name: r.displayTitle,
				status: normalizeStatus(r.status),
				conclusion: normalizeConclusion(r.conclusion),
				branch: r.headBranch ?? '',
				commit: (r.headSha ?? '').slice(0, 8),
				commitMessage: r.displayTitle,
				startedAt,
				completedAt,
				duration,
				url: r.url ?? '',
				actor: r.actor?.login ?? ''
			};
		});
	} catch {
		return [];
	}
}

/**
 * Trigger a workflow run via `gh workflow run`.
 * Returns true on success, false on failure.
 */
export async function triggerWorkflow(
	projectPath: string,
	workflowId: string,
	branch?: string
): Promise<boolean> {
	try {
		if (!isGhAvailable(projectPath)) return false;

		const branchFlag = branch ? ` --ref "${branch}"` : '';
		ghCli(`workflow run "${workflowId}"${branchFlag}`, projectPath);
		return true;
	} catch {
		return false;
	}
}

/**
 * Get a combined pipeline status for the project.
 */
export async function getPipelineStatus(projectPath: string): Promise<PipelineStatus> {
	const repo = getGitHubRepo(projectPath);
	const hasGh = isGhAvailable(projectPath);

	if (!repo || !hasGh) {
		return { repo: repo ?? '', workflows: [], recentRuns: [], hasGh };
	}

	const [workflows, recentRuns] = await Promise.all([
		listWorkflows(projectPath),
		listWorkflowRuns(projectPath, { limit: 20 })
	]);

	return { repo, workflows, recentRuns, hasGh };
}

// ── Internal helpers ───────────────────────────────────────────────────

function normalizeStatus(status: string): WorkflowRun['status'] {
	switch (status) {
		case 'queued':
		case 'waiting':
		case 'pending':
			return 'queued';
		case 'in_progress':
		case 'action_required':
			return 'in_progress';
		case 'completed':
			return 'completed';
		default:
			return 'queued';
	}
}

function normalizeConclusion(conclusion: string): WorkflowRun['conclusion'] {
	switch (conclusion) {
		case 'success':
			return 'success';
		case 'failure':
			return 'failure';
		case 'cancelled':
			return 'cancelled';
		case 'skipped':
			return 'skipped';
		case 'timed_out':
			return 'timed_out';
		default:
			return null;
	}
}
