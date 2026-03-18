<<<<<<< HEAD
import type { PageServerLoad } from './$types.js';
import { PATHS } from '$lib/server/constants.js';
import { scanAllProjects } from '$lib/server/project-scanner.js';
import type { PipelineStatus } from '$lib/server/ci-pipeline.js';

interface PipelineData {
	projectId: string;
	repo: string;
	workflows: PipelineStatus['workflows'];
	recentRuns: PipelineStatus['recentRuns'];
	hasGh: boolean;
}

export const load: PageServerLoad = async ({ params }): Promise<PipelineData> => {
	const empty: PipelineData = {
		projectId: params.id,
		repo: '',
		workflows: [],
		recentRuns: [],
		hasGh: false
	};

	const projects = await scanAllProjects(PATHS.playgroundRegistry, PATHS.root);
	const project = projects.find((p) => p.id === params.id);
	if (!project) return empty;

	try {
		const { getPipelineStatus } = await import('$lib/server/ci-pipeline.js');
		const status = await getPipelineStatus(project.path);

		return {
			projectId: params.id,
			repo: status.repo,
			workflows: status.workflows,
			recentRuns: status.recentRuns,
			hasGh: status.hasGh
		};
	} catch {
		return empty;
	}
=======
import { resolve, basename } from 'path';
import { readdir, readFile, access } from 'fs/promises';
import type { PageServerLoad } from './$types.js';

interface CiConfig {
	type: 'github-actions' | 'gitlab-ci' | 'circleci' | 'jenkins' | 'unknown';
	file: string;
	name: string;
}

interface WorkflowRun {
	name: string;
	status: 'success' | 'failure' | 'in_progress' | 'queued';
	conclusion: string;
	branch: string;
	commit: string;
	date: string;
	url: string;
}

interface PipelinesData {
	projectId: string;
	hasRepo: boolean;
	gitRemote: string | null;
	ciConfigs: CiConfig[];
	recentRuns: WorkflowRun[];
	hasGh: boolean;
	ghError: string | null;
}

async function exists(p: string): Promise<boolean> {
	try {
		await access(p);
		return true;
	} catch {
		return false;
	}
}

async function detectCiConfigs(projectPath: string): Promise<CiConfig[]> {
	const configs: CiConfig[] = [];

	// GitHub Actions
	const ghWorkflowsDir = resolve(projectPath, '.github/workflows');
	try {
		const files = await readdir(ghWorkflowsDir);
		for (const file of files) {
			if (file.endsWith('.yml') || file.endsWith('.yaml')) {
				let name = basename(file, file.endsWith('.yml') ? '.yml' : '.yaml');
				// Try to read the name field from the workflow file
				try {
					const raw = await readFile(resolve(ghWorkflowsDir, file), 'utf-8');
					const nameMatch = raw.match(/^name:\s*['"]?(.+?)['"]?\s*$/m);
					if (nameMatch) name = nameMatch[1];
				} catch {
					// use filename as name
				}
				configs.push({ type: 'github-actions', file: `.github/workflows/${file}`, name });
			}
		}
	} catch {
		// no .github/workflows
	}

	// GitLab CI
	if (await exists(resolve(projectPath, '.gitlab-ci.yml'))) {
		configs.push({ type: 'gitlab-ci', file: '.gitlab-ci.yml', name: 'GitLab CI' });
	}

	// CircleCI
	if (await exists(resolve(projectPath, '.circleci/config.yml'))) {
		configs.push({ type: 'circleci', file: '.circleci/config.yml', name: 'CircleCI' });
	}

	// Jenkinsfile
	if (await exists(resolve(projectPath, 'Jenkinsfile'))) {
		configs.push({ type: 'jenkins', file: 'Jenkinsfile', name: 'Jenkins Pipeline' });
	}

	return configs;
}

async function getGitRemote(projectPath: string): Promise<string | null> {
	try {
		const { execSync } = await import('child_process');
		const remote = execSync('git remote get-url origin', {
			cwd: projectPath,
			encoding: 'utf-8',
			stdio: ['pipe', 'pipe', 'ignore']
		}).trim();
		return remote || null;
	} catch {
		return null;
	}
}

function extractGhRepo(remote: string): string | null {
	// git@github.com:user/repo.git or https://github.com/user/repo.git
	const sshMatch = remote.match(/github\.com[:/](.+?\/.+?)(?:\.git)?$/);
	if (sshMatch) return sshMatch[1];
	const httpsMatch = remote.match(/github\.com\/(.+?\/.+?)(?:\.git)?$/);
	if (httpsMatch) return httpsMatch[1];
	return null;
}

async function fetchGhWorkflowRuns(projectPath: string, ghRepo: string): Promise<{ runs: WorkflowRun[]; error: string | null }> {
	try {
		const { execSync } = await import('child_process');

		// Verify gh is available
		execSync('gh --version', { stdio: 'ignore' });

		const raw = execSync(
			`gh run list --repo ${ghRepo} --limit 10 --json name,status,conclusion,headBranch,headSha,createdAt,url`,
			{
				cwd: projectPath,
				encoding: 'utf-8',
				stdio: ['pipe', 'pipe', 'ignore'],
				timeout: 10000
			}
		);

		const runs = JSON.parse(raw) as Array<{
			name: string;
			status: string;
			conclusion: string;
			headBranch: string;
			headSha: string;
			createdAt: string;
			url: string;
		}>;

		return {
			runs: runs.map((r) => ({
				name: r.name,
				status: r.status === 'completed'
					? (r.conclusion === 'success' ? 'success' : 'failure')
					: r.status === 'in_progress' ? 'in_progress' : 'queued',
				conclusion: r.conclusion || r.status,
				branch: r.headBranch,
				commit: r.headSha?.slice(0, 7) ?? '',
				date: r.createdAt,
				url: r.url
			})),
			error: null
		};
	} catch (e) {
		return { runs: [], error: e instanceof Error ? e.message : 'Failed to fetch workflow runs' };
	}
}

export const load: PageServerLoad = async ({ params, parent }): Promise<PipelinesData> => {
	const { project } = await parent();
	const projectPath = project.path;

	const [ciConfigs, gitRemote] = await Promise.all([
		detectCiConfigs(projectPath),
		getGitRemote(projectPath)
	]);

	const hasRepo = gitRemote !== null;
	const ghRepo = gitRemote ? extractGhRepo(gitRemote) : null;

	let recentRuns: WorkflowRun[] = [];
	let hasGh = false;
	let ghError: string | null = null;

	if (ghRepo) {
		try {
			const { execSync } = await import('child_process');
			execSync('gh --version', { stdio: 'ignore' });
			hasGh = true;
		} catch {
			// gh not installed
		}

		if (hasGh) {
			const result = await fetchGhWorkflowRuns(projectPath, ghRepo);
			recentRuns = result.runs;
			ghError = result.error;
		}
	}

	return {
		projectId: params.id,
		hasRepo,
		gitRemote: gitRemote,
		ciConfigs,
		recentRuns,
		hasGh,
		ghError
	};
>>>>>>> worktree-agent-a73da255
};
