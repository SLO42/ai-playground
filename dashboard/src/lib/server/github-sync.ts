import { readFile, writeFile, mkdir } from 'fs/promises';
import { resolve, basename } from 'path';
import { PATHS } from './constants.js';
import { pushNotification } from './notifications.js';
import { getAllTasks, replaceAllTasks, migrateIfNeeded } from './task-store.js';
import type { Task, TaskStatus, TaskPriority } from '$lib/types/tasks.js';

// ── Types ──────────────────────────────────────────────────────────────

export interface GitHubIssue {
	number: number;
	title: string;
	body: string;
	state: 'open' | 'closed';
	labels: Array<{ name: string }>;
	assignees: Array<{ login: string }>;
	created_at: string;
	updated_at: string;
	html_url: string;
}

export interface SyncMapping {
	taskId: string;
	issueNumber: number;
	projectId: string;
	repo: string;
	lastSynced: string;
	direction: 'push' | 'pull' | 'both';
}

export interface SyncState {
	mappings: SyncMapping[];
	lastFullSync: string | null;
	repo: string;
}

export interface SyncResult {
	created: number;
	updated: number;
	pulled: number;
	skipped: number;
	errors: string[];
}

// ── Storage ────────────────────────────────────────────────────────────

function syncFilePath(projectPath?: string): string {
	const base = projectPath ?? PATHS.root;
	return resolve(base, '.playground/github-sync.json');
}

async function loadSyncState(projectPath?: string): Promise<SyncState> {
	try {
		const raw = await readFile(syncFilePath(projectPath), 'utf-8');
		return JSON.parse(raw);
	} catch {
		return { mappings: [], lastFullSync: null, repo: '' };
	}
}

async function saveSyncState(state: SyncState, projectPath?: string): Promise<void> {
	const base = projectPath ?? PATHS.root;
	await mkdir(resolve(base, '.playground'), { recursive: true });
	await writeFile(syncFilePath(projectPath), JSON.stringify(state, null, '\t'), 'utf-8');
}

// ── Task file helpers ──────────────────────────────────────────────────

async function loadTasks(projectPath: string): Promise<Task[]> {
	const fullPath = projectPath === '.' ? PATHS.root : resolve(PATHS.root, projectPath);
	await migrateIfNeeded(fullPath);
	return getAllTasks(fullPath);
}

async function saveTasks(projectPath: string, tasks: Task[]): Promise<void> {
	const fullPath = projectPath === '.' ? PATHS.root : resolve(PATHS.root, projectPath);
	await replaceAllTasks(fullPath, tasks);
}

// ── GitHub CLI helpers ─────────────────────────────────────────────────

async function gh(args: string, stdin?: string, cwd?: string): Promise<string> {
	const { spawn } = await import('child_process');

	return new Promise((resolve, reject) => {
		const proc = spawn('gh', splitArgs(args), {
			cwd: cwd ?? PATHS.root,
			stdio: ['pipe', 'pipe', 'pipe']
		});

		let stdout = '';
		let stderr = '';
		proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
		proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

		if (stdin) {
			proc.stdin.write(stdin);
			proc.stdin.end();
		} else {
			proc.stdin.end();
		}

		const timer = setTimeout(() => { proc.kill(); reject(new Error('gh timed out')); }, 30000);

		proc.on('close', (code: number) => {
			clearTimeout(timer);
			if (code === 0) {
				resolve(stdout.trim());
			} else {
				reject(new Error(`gh ${splitArgs(args)[0]} failed: ${stderr.trim() || `exit code ${code}`}`));
			}
		});

		proc.on('error', (err: Error) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

// Split a command string into args, respecting quotes
function splitArgs(cmd: string): string[] {
	const args: string[] = [];
	let current = '';
	let inQuote = '';
	for (const ch of cmd) {
		if (ch === '"' || ch === "'") {
			if (inQuote === ch) { inQuote = ''; }
			else if (!inQuote) { inQuote = ch; }
			else { current += ch; }
		} else if (ch === ' ' && !inQuote) {
			if (current) { args.push(current); current = ''; }
		} else {
			current += ch;
		}
	}
	if (current) args.push(current);
	return args;
}

async function getRepoName(cwd?: string): Promise<string> {
	const result = await gh('repo view --json nameWithOwner --jq .nameWithOwner', undefined, cwd);
	return result;
}

async function listIssues(repo: string, since?: string | null, cwd?: string): Promise<GitHubIssue[]> {
	// When we have a last-sync timestamp, use GitHub search to only fetch issues updated since then
	const sinceFilter = since ? ` --search "updated:>=${since.slice(0, 10)}"` : '';
	const result = await gh(
		`issue list --repo ${repo} --state all --limit 100 --json number,title,body,state,labels,assignees,createdAt,updatedAt,url${sinceFilter}`,
		undefined,
		cwd
	);
	if (!result) return [];
	const issues = JSON.parse(result);
	// Normalize field names (gh CLI uses camelCase)
	return issues.map((i: any) => ({
		number: i.number,
		title: i.title,
		body: i.body ?? '',
		state: i.state === 'OPEN' ? 'open' : 'closed',
		labels: i.labels ?? [],
		assignees: i.assignees ?? [],
		created_at: i.createdAt,
		updated_at: i.updatedAt,
		html_url: i.url
	}));
}

async function createIssue(repo: string, task: Task, projectId: string, source?: string): Promise<number> {
	// Resolve "." to the repo name
	const projectName = projectId === '.' ? repo.split('/').pop() ?? repo : projectId;
	const labels = [
		'dashboard-task',
		`priority:${task.priority}`,
		...task.tags.map((t) => `tag:${t}`)
	].filter(Boolean);

	const body = [
		task.description || '_No description_',
		'',
		'---',
		`**Task ID**: \`${task.id}\``,
		`**Project**: \`${projectName}\``,
		`**Priority**: ${task.priority}`,
		`**Status**: ${task.status}`,
		`**Created by**: ${task.createdBy}`,
		task.assignee ? `**Assignee**: ${task.assignee}` : '',
		'',
		source
			? `_Created-By: ${source} via ai-playground dashboard_`
			: '_Synced from ai-playground dashboard_'
	].filter((l) => l !== undefined).join('\n');

	// Sanitize task title to prevent shell injection via quote/backtick/dollar chars
	const safeTitle = task.title.replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`');

	// Ensure labels exist (--force updates if exists, creates if not)
	for (const label of labels) {
		await gh(`label create "${label}" --repo ${repo} --color 0E8A16 --force`).catch(() => {});
	}

	const labelFlags = labels.map((l) => `-l "${l}"`).join(' ');

	// Use --body-file - (stdin) to avoid shell escaping issues with body content
	const url = await gh(
		`issue create --repo ${repo} -t "${safeTitle}" --body-file - ${labelFlags}`,
		body
	);

	// Parse issue number from URL: https://github.com/owner/repo/issues/123
	const match = url.match(/\/issues\/(\d+)/);
	if (!match) throw new Error(`Could not parse issue number from: ${url}`);
	const issueNumber = parseInt(match[1], 10);

	// Credit the source with a comment if it's an agent
	if (source && source !== 'dashboard' && source !== 'user') {
		await gh(
			`issue comment ${issueNumber} --repo ${repo} --body-file -`,
			`> Created-By: **${source}** via ai-playground dashboard\n>\n> This issue was synced automatically by the \`${source}\` agent.`
		).catch(() => {});
	}

	return issueNumber;
}

async function updateIssue(repo: string, issueNumber: number, task: Task): Promise<void> {
	const state = (task.status === 'completed' || task.status === 'cancelled') ? 'closed' : 'open';

	// Update state
	if (state === 'closed') {
		await gh(`issue close ${issueNumber} --repo ${repo}`);
	} else {
		await gh(`issue reopen ${issueNumber} --repo ${repo}`).catch(() => {});
	}

	// Update labels
	const labels = [
		'dashboard-task',
		`priority:${task.priority}`,
		`status:${task.status}`
	];
	const labelFlags = labels.map((l) => `--add-label "${l}"`).join(' ');

	// Create labels if needed
	for (const label of labels) {
		try {
			await gh(`label create "${label}" --repo ${repo} --color 0E8A16 --force 2>/dev/null`);
		} catch { /* ignore */ }
	}

	await gh(`issue edit ${issueNumber} --repo ${repo} ${labelFlags}`).catch(() => {});
}

// ── Status/Priority mapping ────────────────────────────────────────────

function issueStateToTaskStatus(issue: GitHubIssue): TaskStatus {
	if (issue.state === 'closed') return 'completed';
	// Check labels for more specific status
	const labels = issue.labels.map((l) => l.name);
	if (labels.includes('status:in_progress')) return 'in_progress';
	if (labels.includes('status:cancelled')) return 'cancelled';
	return 'pending';
}

function issuePriority(issue: GitHubIssue): TaskPriority {
	const labels = issue.labels.map((l) => l.name);
	if (labels.includes('priority:critical')) return 'critical';
	if (labels.includes('priority:high')) return 'high';
	if (labels.includes('priority:low')) return 'low';
	return 'medium';
}

function issueToTask(issue: GitHubIssue): Task {
	return {
		id: `gh-${issue.number}`,
		title: issue.title,
		description: issue.body?.split('\n---')[0]?.trim() ?? '',
		status: issueStateToTaskStatus(issue),
		priority: issuePriority(issue),
		flagDiscussion: false,
		assignee: issue.assignees[0]?.login ?? null,
		tags: issue.labels
			.map((l) => l.name)
			.filter((l) => l.startsWith('tag:'))
			.map((l) => l.replace('tag:', '')),
		feature: issue.labels
			.map((l) => l.name)
			.find((l) => l.startsWith('feature:'))
			?.replace('feature:', '') ?? null,
		createdBy: 'github',
		createdAt: issue.created_at,
		updatedAt: issue.updated_at,
		completedAt: issue.state === 'closed' ? issue.updated_at : null
	};
}

// ── Public API ─────────────────────────────────────────────────────────

export async function syncTasks(opts?: {
	projectId?: string;
	projectPath?: string;
	direction?: 'push' | 'pull' | 'both';
	dryRun?: boolean;
	source?: string;
}): Promise<SyncResult> {
	const direction = opts?.direction ?? 'both';
	const projectId = opts?.projectId ?? '.';
	const projectPath = opts?.projectPath;
	const cwd = projectPath ?? PATHS.root;
	const result: SyncResult = { created: 0, updated: 0, pulled: 0, skipped: 0, errors: [] };

	try {
		const repo = await getRepoName(cwd);
		const state = await loadSyncState(projectPath);
		state.repo = repo;

		// Clean broken mappings (null/invalid issueNumber from past failures)
		state.mappings = state.mappings.filter((m) => m.issueNumber != null && m.issueNumber > 0);

		const tasks = projectPath ? await getAllTasks(projectPath) : await loadTasks(projectId);

		// Only fetch issues updated since last sync (or all if first sync)
		const allIssues = await listIssues(repo, state.lastFullSync, cwd);
		// Only pull issues that have the dashboard-task label
		const issues = allIssues.filter((i) =>
			i.labels.some((l) => l.name === 'dashboard-task')
		);

		// Build lookup maps
		const mappingByTask = new Map(state.mappings.map((m) => [m.taskId, m]));
		const mappingByIssue = new Map(state.mappings.map((m) => [m.issueNumber, m]));
		const issueByNumber = new Map(issues.map((i) => [i.number, i]));
		// Title lookup for duplicate detection (check fetched issues)
		const issueByTitle = new Map(allIssues.map((i) => [i.title.toLowerCase().trim(), i]));
		const taskByTitle = new Map(tasks.map((t) => [t.title.toLowerCase().trim(), t]));

		const lastSyncTime = state.lastFullSync ? new Date(state.lastFullSync).getTime() : 0;

		// ── PUSH: Dashboard tasks → GitHub issues ──────────────────────
		if (direction === 'push' || direction === 'both') {
			for (const task of tasks) {
				try {
					const existing = mappingByTask.get(task.id);

					if (existing) {
						// Skip if task hasn't changed since last sync of this mapping
						const taskUpdated = new Date(task.updatedAt).getTime();
						const mappingSynced = new Date(existing.lastSynced).getTime();
						if (taskUpdated <= mappingSynced) continue;

						// Update existing issue (task changed since last sync)
						if (!opts?.dryRun) {
							await updateIssue(repo, existing.issueNumber, task);
						}
						existing.lastSynced = new Date().toISOString();
						result.updated++;
					} else {
						// Check for duplicate: issue with same title already exists
						const dup = issueByTitle.get(task.title.toLowerCase().trim());
						if (dup) {
							// Link to the existing issue instead of creating a new one
							state.mappings.push({
								taskId: task.id,
								issueNumber: dup.number,
								projectId,
								repo,
								lastSynced: new Date().toISOString(),
								direction: 'both'
							});
							// Don't count as created — just linked
							continue;
						}

						// Create new issue on GitHub
						if (!opts?.dryRun) {
							const issueNumber = await createIssue(repo, task, projectId, opts?.source);
							state.mappings.push({
								taskId: task.id,
								issueNumber,
								projectId,
								repo,
								lastSynced: new Date().toISOString(),
								direction: 'both'
							});
						}
						result.created++;
					}
				} catch (err: any) {
					result.errors.push(`Push task ${task.id}: ${err.message}`);
				}
			}
		}

		// ── PULL: GitHub issues → Dashboard tasks ──────────────────────
		if (direction === 'pull' || direction === 'both') {
			for (const issue of issues) {
				try {
					const existing = mappingByIssue.get(issue.number);

					if (existing) {
						// Skip if issue hasn't changed since last sync of this mapping
						const issueUpdated = new Date(issue.updated_at).getTime();
						const mappingSynced = new Date(existing.lastSynced).getTime();
						if (issueUpdated <= mappingSynced) continue;

						// Update existing task from issue (issue changed since last sync)
						const taskIdx = tasks.findIndex((t) => t.id === existing.taskId);
						if (taskIdx >= 0) {
							tasks[taskIdx].status = issueStateToTaskStatus(issue);
							tasks[taskIdx].priority = issuePriority(issue);
							tasks[taskIdx].updatedAt = issue.updated_at;
							if (issue.state === 'closed') {
								tasks[taskIdx].completedAt = issue.updated_at;
							}
							existing.lastSynced = new Date().toISOString();
							result.updated++;
						}
					} else {
						// Check for duplicate: task with same title already exists
						const dupTask = taskByTitle.get(issue.title.toLowerCase().trim());
						if (dupTask) {
							// Link existing task to this issue instead of importing
							state.mappings.push({
								taskId: dupTask.id,
								issueNumber: issue.number,
								projectId,
								repo,
								lastSynced: new Date().toISOString(),
								direction: 'both'
							});
							continue;
						}

						// New issue not tracked locally — import it
						const newTask = issueToTask(issue);
						if (opts?.source) newTask.createdBy = opts.source;
						tasks.push(newTask);
						taskByTitle.set(newTask.title.toLowerCase().trim(), newTask);
						state.mappings.push({
							taskId: newTask.id,
							issueNumber: issue.number,
							projectId,
							repo,
							lastSynced: new Date().toISOString(),
							direction: 'both'
						});
						result.pulled++;
					}
				} catch (err: any) {
					result.errors.push(`Pull issue #${issue.number}: ${err.message}`);
				}
			}
		}

		// Save
		if (!opts?.dryRun) {
			state.lastFullSync = new Date().toISOString();
			await saveSyncState(state, projectPath);
			if (projectPath) {
				await replaceAllTasks(projectPath, tasks);
			} else {
				await saveTasks(projectId, tasks);
			}
		}

		// Notify on sync results
		const total = result.created + result.updated + result.pulled;
		if (total > 0 || result.errors.length > 0) {
			const parts: string[] = [];
			if (result.created > 0) parts.push(`${result.created} issue(s) created`);
			if (result.updated > 0) parts.push(`${result.updated} updated`);
			if (result.pulled > 0) parts.push(`${result.pulled} pulled`);
			if (result.errors.length > 0) parts.push(`${result.errors.length} error(s)`);

			await pushNotification({
				severity: result.errors.length > 0 ? 'warning' : 'success',
				category: 'task',
				title: 'GitHub sync completed',
				message: parts.join(' | ') + ` — repo: ${repo}`,
				source: opts?.source ?? 'claw',
				link: '/tasks',
				linkLabel: 'View Tasks',
				desktop: result.errors.length > 0
			});
		}

		return result;
	} catch (err: any) {
		result.errors.push(`Sync failed: ${err.message}`);

		await pushNotification({
			severity: 'warning',
			category: 'task',
			title: 'GitHub sync failed',
			message: err.message,
			source: opts?.source ?? 'claw',
			link: '/tasks',
			linkLabel: 'View Tasks',
			desktop: true
		}).catch(() => {});

		return result;
	}
}

export async function getSyncStatus(projectPath?: string): Promise<{
	repo: string;
	lastSync: string | null;
	mappings: number;
	state: SyncState;
}> {
	const state = await loadSyncState(projectPath);
	let repo = state.repo;
	if (!repo) {
		try {
			repo = await getRepoName(projectPath);
		} catch {
			repo = 'unknown';
		}
	}
	return {
		repo,
		lastSync: state.lastFullSync,
		mappings: state.mappings.length,
		state
	};
}
