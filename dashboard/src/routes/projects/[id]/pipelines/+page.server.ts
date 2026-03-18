/**
 * Pipelines page data loader — uses the shared ci-pipeline module for
 * GitHub Actions integration plus local CI config file detection.
 */
import { resolve, basename } from 'path';
import { readdir, readFile, access } from 'fs/promises';
import type { PageServerLoad } from './$types.js';
import {
	getPipelineStatus,
	getGitHubRepo,
	type WorkflowRun,
	type Workflow
} from '$lib/server/ci-pipeline.js';

interface CiConfig {
	type: 'github-actions' | 'gitlab-ci' | 'circleci' | 'jenkins' | 'unknown';
	file: string;
	name: string;
}

interface PipelinesData {
	projectId: string;
	hasRepo: boolean;
	gitRemote: string | null;
	ciConfigs: CiConfig[];
	recentRuns: WorkflowRun[];
	workflows: Workflow[];
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

function getGitRemote(projectPath: string): string | null {
	try {
		const { execSync } = require('child_process');
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

export const load: PageServerLoad = async ({ params, parent }): Promise<PipelinesData> => {
	const { project } = await parent();
	const projectPath = project.path;

	const ciConfigs = await detectCiConfigs(projectPath);
	const gitRemote = getGitRemote(projectPath);
	const hasRepo = gitRemote !== null;

	// Use the ci-pipeline module for GitHub Actions data
	let recentRuns: WorkflowRun[] = [];
	let workflows: Workflow[] = [];
	let hasGh = false;
	let ghError: string | null = null;

	if (hasRepo) {
		try {
			const status = await getPipelineStatus(projectPath);
			hasGh = status.hasGh;
			recentRuns = status.recentRuns;
			workflows = status.workflows;
		} catch (e) {
			ghError = e instanceof Error ? e.message : 'Failed to fetch pipeline status';
		}
	}

	return {
		projectId: params.id,
		hasRepo,
		gitRemote,
		ciConfigs,
		recentRuns,
		workflows,
		hasGh,
		ghError
	};
};
