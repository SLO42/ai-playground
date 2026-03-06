import { resolve } from 'path';
import { readFile, writeFile, mkdir, readdir, stat } from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';
import { PATHS, SERVICES } from './constants.js';
import { scanAllProjects } from './project-scanner.js';
import { pushNotification, type NotifCategory, type NotifSeverity } from './notifications.js';
import { getAllTasks, createTask, updateTask, migrateIfNeeded } from './task-store.js';
import type { Task, TaskPriority } from '$lib/types/tasks.js';
import type { ToolDef, ToolCall } from './providers/types.js';
import crypto from 'crypto';

const execAsync = promisify(exec);

// ── Tool Definitions ───────────────────────────────────────────────────

export const TOOL_DEFINITIONS: ToolDef[] = [
	// ── Projects ───────────────────────────────────────────────────────
	{
		name: 'ls_projects',
		description: 'List all registered projects in the playground',
		parameters: { type: 'object', properties: {} }
	},

	// ── Tasks ──────────────────────────────────────────────────────────
	{
		name: 'exec_task',
		description: 'List tasks for a project, optionally filtered by status',
		parameters: {
			type: 'object',
			properties: {
				projectId: { type: 'string', description: 'The project ID (slug)' },
				status: {
					type: 'string',
					description: 'Filter by status',
					enum: ['pending', 'in_progress', 'completed', 'cancelled']
				}
			},
			required: ['projectId']
		}
	},
	{
		name: 'mk_task',
		description: 'Create a new task in a project',
		parameters: {
			type: 'object',
			properties: {
				projectId: { type: 'string', description: 'The project ID (slug)' },
				title: { type: 'string', description: 'Task title' },
				description: { type: 'string', description: 'Task description' },
				priority: {
					type: 'string',
					description: 'Task priority',
					enum: ['critical', 'high', 'medium', 'low']
				},
				assignee: { type: 'string', description: 'Who to assign the task to' }
			},
			required: ['projectId', 'title']
		}
	},
	{
		name: 'mod_task',
		description: 'Update an existing task (status, priority, title, assignee)',
		parameters: {
			type: 'object',
			properties: {
				projectId: { type: 'string', description: 'The project ID (slug)' },
				taskId: { type: 'string', description: 'The task ID' },
				status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] },
				priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
				title: { type: 'string' },
				assignee: { type: 'string' }
			},
			required: ['projectId', 'taskId']
		}
	},

	// ── Memory ─────────────────────────────────────────────────────────
	{
		name: 'scan_memory',
		description: 'Search Claude Flow memory for stored knowledge and patterns',
		parameters: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'Search query' },
				namespace: { type: 'string', description: 'Optional memory namespace' }
			},
			required: ['query']
		}
	},

	// ── Sessions ───────────────────────────────────────────────────────
	{
		name: 'trace_sessions',
		description: 'List recent Claude Flow sessions with metadata',
		parameters: {
			type: 'object',
			properties: {
				limit: { type: 'number', description: 'Max results (default 10)' }
			}
		}
	},

	// ── Services ───────────────────────────────────────────────────────
	{
		name: 'probe_service',
		description: 'Check health/status of one or all services (ollama, openclaw, claude-flow, penpot-mcp)',
		parameters: {
			type: 'object',
			properties: {
				serviceId: {
					type: 'string',
					description: 'Service ID to check. Omit to check all.',
					enum: ['ollama', 'openclaw', 'claude-flow', 'penpot-mcp']
				}
			}
		}
	},
	{
		name: 'spawn_service',
		description: 'Start a service (ollama, openclaw, claude-flow)',
		parameters: {
			type: 'object',
			properties: {
				serviceId: {
					type: 'string',
					description: 'Service to start',
					enum: ['ollama', 'openclaw', 'claude-flow']
				}
			},
			required: ['serviceId']
		}
	},
	{
		name: 'kill_service',
		description: 'Stop a running service',
		parameters: {
			type: 'object',
			properties: {
				serviceId: {
					type: 'string',
					description: 'Service to stop',
					enum: ['ollama', 'openclaw', 'claude-flow']
				}
			},
			required: ['serviceId']
		}
	},

	// ── Notifications ──────────────────────────────────────────────────
	{
		name: 'push_notify',
		description: 'Push a notification to the dashboard and desktop. Use for alerts, status updates, task completions, service changes, etc.',
		parameters: {
			type: 'object',
			properties: {
				title: { type: 'string', description: 'Notification title' },
				message: { type: 'string', description: 'Notification body text' },
				severity: {
					type: 'string',
					description: 'Notification severity',
					enum: ['critical', 'warning', 'info', 'success']
				},
				category: {
					type: 'string',
					description: 'Notification category',
					enum: ['task', 'service', 'agent', 'chat', 'memory', 'model', 'system']
				},
				link: { type: 'string', description: 'Optional dashboard link (e.g. /tasks, /services)' }
			},
			required: ['title', 'message']
		}
	}
];

// ── Helpers ────────────────────────────────────────────────────────────

async function readJson<T>(p: string): Promise<T | null> {
	try {
		return JSON.parse(await readFile(p, 'utf-8')) as T;
	} catch {
		return null;
	}
}

async function getProjectPath(projectId: string): Promise<string | null> {
	const projects = await scanAllProjects(PATHS.playgroundRegistry, PATHS.root);
	const project = projects.find((p) => p.id === projectId);
	return project?.path ?? null;
}

async function readTasks(projectPath: string): Promise<Task[]> {
	await migrateIfNeeded(projectPath);
	return getAllTasks(projectPath);
}

async function checkHealth(url: string, timeoutMs = 2000): Promise<boolean> {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
		return res.ok || res.status < 500;
	} catch {
		return false;
	}
}

async function probeService(id: string) {
	const def = SERVICES[id as keyof typeof SERVICES];
	if (!def) return { id, error: 'Unknown service' };

	const online = def.healthUrl ? await checkHealth(def.healthUrl) : false;

	// Try to get PID + RAM on Windows
	let pid: number | null = null;
	let ram: string | null = null;
	if (def.port) {
		try {
			const { stdout } = await execAsync(
				`netstat -ano | findstr :${def.port} | findstr LISTENING`,
				{ timeout: 3000, windowsHide: true }
			);
			const parts = stdout.trim().split(/\s+/);
			pid = parseInt(parts[parts.length - 1], 10) || null;
		} catch { /* not listening */ }
	}

	if (pid) {
		try {
			const { stdout } = await execAsync(
				`tasklist /FI "PID eq ${pid}" /FO CSV /NH`,
				{ timeout: 3000, windowsHide: true }
			);
			const fields = stdout.trim().split('","');
			if (fields.length >= 5) {
				ram = fields[4]?.replace(/"/g, '').trim() ?? null;
			}
		} catch { /* tasklist failed */ }
	}

	return {
		id,
		name: def.name,
		type: def.type,
		port: def.port,
		status: online ? 'running' : pid ? 'errored' : 'stopped',
		pid,
		ram
	};
}

// ── Execute Handler ────────────────────────────────────────────────────

export async function executeTool(call: ToolCall): Promise<string> {
	try {
		const args = call.arguments;

		switch (call.name) {
			// ── ls_projects ────────────────────────────────────────────
			case 'ls_projects': {
				const projects = await scanAllProjects(PATHS.playgroundRegistry, PATHS.root);
				const summary = projects.map((p) => ({
					id: p.id,
					name: p.name,
					status: p.status,
					health: p.health,
					techStack: p.techStack,
					agents: p.agents,
					sessions: p.sessions
				}));
				return JSON.stringify({ projects: summary }, null, 2);
			}

			// ── exec_task (list) ───────────────────────────────────────
			case 'exec_task': {
				const projectId = args.projectId as string;
				const projectPath = await getProjectPath(projectId);
				if (!projectPath) return JSON.stringify({ error: `Project '${projectId}' not found` });

				let tasks = await readTasks(projectPath);
				if (args.status) {
					tasks = tasks.filter((t) => t.status === args.status);
				}

				const statusLabel = args.status ? ` (${args.status})` : '';
				await pushNotification({
					severity: 'info',
					category: 'task',
					title: `Claw scanned tasks`,
					message: `Found ${tasks.length} task${tasks.length !== 1 ? 's' : ''}${statusLabel} in ${projectId}`,
					source: 'claw',
					link: `/projects/${projectId}/tasks`,
					linkLabel: 'View Tasks'
				});

				return JSON.stringify({
					projectId,
					count: tasks.length,
					tasks: tasks.map((t) => ({
						id: t.id,
						title: t.title,
						status: t.status,
						priority: t.priority,
						assignee: t.assignee,
						createdAt: t.createdAt
					}))
				}, null, 2);
			}

			// ── mk_task ────────────────────────────────────────────────
			case 'mk_task': {
				const projectId = args.projectId as string;
				const projectPath = await getProjectPath(projectId);
				if (!projectPath) return JSON.stringify({ error: `Project '${projectId}' not found` });

				const validPriorities: TaskPriority[] = ['critical', 'high', 'medium', 'low'];
				const priority = validPriorities.includes(args.priority as TaskPriority)
					? (args.priority as TaskPriority)
					: 'medium';

				const now = new Date().toISOString();
				const task = await createTask(projectPath, {
					title: String(args.title).trim(),
					description: typeof args.description === 'string' ? args.description.trim() : '',
					priority,
					assignee: (args.assignee as string) ?? null,
					createdBy: 'claw'
				});

				await pushNotification({
					severity: priority === 'critical' ? 'warning' : 'info',
					category: 'task',
					title: `Task created: ${task.title}`,
					message: `Priority: ${priority} | Project: ${projectId}`,
					source: 'claw',
					link: `/projects/${projectId}/tasks`,
					linkLabel: 'View Tasks',
					desktop: priority === 'critical' || priority === 'high'
				});

				return JSON.stringify({ created: { id: task.id, title: task.title, priority: task.priority } });
			}

			// ── mod_task ───────────────────────────────────────────────
			case 'mod_task': {
				const projectId = args.projectId as string;
				const taskId = args.taskId as string;
				const projectPath = await getProjectPath(projectId);
				if (!projectPath) return JSON.stringify({ error: `Project '${projectId}' not found` });

				const updates: Record<string, unknown> = {};
				if (args.status) updates.status = args.status;
				if (args.priority) updates.priority = args.priority;
				if (args.title) updates.title = String(args.title).trim();
				if (args.assignee !== undefined) updates.assignee = (args.assignee as string) || null;

				const task = await updateTask(projectPath, taskId, updates as any);
				if (!task) return JSON.stringify({ error: `Task '${taskId}' not found` });

				const isCompletion = task.status === 'completed';
				await pushNotification({
					severity: isCompletion ? 'success' : 'info',
					category: 'task',
					title: isCompletion ? `Task completed: ${task.title}` : `Task updated: ${task.title}`,
					message: `Status: ${task.status} | Priority: ${task.priority} | Project: ${projectId}`,
					source: 'claw',
					link: `/projects/${projectId}/tasks`,
					linkLabel: 'View Tasks',
					desktop: isCompletion
				});

				return JSON.stringify({
					updated: { id: task.id, title: task.title, status: task.status, priority: task.priority }
				});
			}

			// ── scan_memory ────────────────────────────────────────────
			case 'scan_memory': {
				const query = args.query as string;
				const namespace = args.namespace as string | undefined;
				const store = await readJson<Record<string, unknown>[]>(PATHS.autoMemoryStore);
				if (!store || !Array.isArray(store)) {
					return JSON.stringify({ results: [], note: 'Memory store is empty or unavailable' });
				}
				const queryLower = query.toLowerCase();
				const results = store
					.filter((entry) => {
						const text = JSON.stringify(entry).toLowerCase();
						if (!text.includes(queryLower)) return false;
						if (namespace) {
							const ns = (entry as Record<string, unknown>).namespace;
							if (ns && ns !== namespace) return false;
						}
						return true;
					})
					.slice(0, 10);

				await pushNotification({
					severity: 'info',
					category: 'memory',
					title: 'Claw searched memory',
					message: `Query: "${query}"${namespace ? ` in ${namespace}` : ''} — ${results.length} result${results.length !== 1 ? 's' : ''}`,
					source: 'claw',
					link: '/memory',
					linkLabel: 'View Memory'
				});

				return JSON.stringify({ query, results });
			}

			// ── trace_sessions ─────────────────────────────────────────
			case 'trace_sessions': {
				const limit = Math.min(50, Math.max(1, Number(args.limit) || 10));
				try {
					const entries = await readdir(PATHS.sessionsDir);
					const sessionFiles = entries.filter((f) => f.endsWith('.jsonl'));

					const sessions = await Promise.all(
						sessionFiles.map(async (f) => {
							const s = await stat(resolve(PATHS.sessionsDir, f)).catch(() => null);
							return {
								name: f.replace('.jsonl', ''),
								size: s ? `${Math.round(s.size / 1024)}KB` : '?',
								modified: s?.mtime?.toISOString() ?? 'unknown'
							};
						})
					);
					sessions.sort((a, b) => b.modified.localeCompare(a.modified));
					return JSON.stringify({ sessions: sessions.slice(0, limit) }, null, 2);
				} catch {
					return JSON.stringify({ sessions: [], note: 'Sessions directory not available' });
				}
			}

			// ── probe_service ──────────────────────────────────────────
			case 'probe_service': {
				const serviceId = args.serviceId as string | undefined;
				if (serviceId) {
					const result = await probeService(serviceId);
					const status = (result as Record<string, unknown>).status ?? 'unknown';
					await pushNotification({
						severity: status === 'running' ? 'success' : 'warning',
						category: 'service',
						title: `Service probe: ${serviceId}`,
						message: `Status: ${status}`,
						source: 'claw',
						link: '/services',
						linkLabel: 'View Services'
					});
					return JSON.stringify(result, null, 2);
				}
				// Probe all
				const ids = Object.keys(SERVICES);
				const results = await Promise.all(ids.map(probeService));
				const running = (results as Array<Record<string, unknown>>).filter((r) => r.status === 'running').length;
				await pushNotification({
					severity: 'info',
					category: 'service',
					title: 'Claw probed all services',
					message: `${running}/${ids.length} running`,
					source: 'claw',
					link: '/services',
					linkLabel: 'View Services'
				});
				return JSON.stringify({ services: results }, null, 2);
			}

			// ── spawn_service ──────────────────────────────────────────
			case 'spawn_service': {
				const serviceId = args.serviceId as string;
				if (!(serviceId in SERVICES)) {
					return JSON.stringify({ error: `Unknown service: ${serviceId}` });
				}
				// Call the existing service API
				try {
					const res = await fetch(`http://localhost:5173/api/services/${serviceId}`, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ action: 'start' })
					});
					const result = await res.json();
					await pushNotification({
						severity: 'success',
						category: 'service',
						title: `Service started: ${serviceId}`,
						message: `Claw started the ${serviceId} service`,
						source: 'claw',
						link: '/services',
						linkLabel: 'View Services',
						desktop: true
					});
					return JSON.stringify(result);
				} catch {
					// Fallback: start directly
					const fallbackResult = await startServiceDirectly(serviceId);
					await pushNotification({
						severity: 'info',
						category: 'service',
						title: `Service started: ${serviceId}`,
						message: `Claw started ${serviceId} (direct fallback)`,
						source: 'claw',
						link: '/services',
						linkLabel: 'View Services'
					});
					return fallbackResult;
				}
			}

			// ── kill_service ───────────────────────────────────────────
			case 'kill_service': {
				const serviceId = args.serviceId as string;
				if (!(serviceId in SERVICES)) {
					return JSON.stringify({ error: `Unknown service: ${serviceId}` });
				}
				try {
					const res = await fetch(`http://localhost:5173/api/services/${serviceId}`, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ action: 'stop' })
					});
					const result = await res.json();
					await pushNotification({
						severity: 'warning',
						category: 'service',
						title: `Service stopped: ${serviceId}`,
						message: `Claw stopped the ${serviceId} service`,
						source: 'claw',
						link: '/services',
						linkLabel: 'View Services',
						desktop: true
					});
					return JSON.stringify(result);
				} catch {
					const fallbackResult = await stopServiceDirectly(serviceId);
					await pushNotification({
						severity: 'warning',
						category: 'service',
						title: `Service stopped: ${serviceId}`,
						message: `Claw stopped ${serviceId} (direct fallback)`,
						source: 'claw',
						link: '/services',
						linkLabel: 'View Services'
					});
					return fallbackResult;
				}
			}

			// ── push_notify ────────────────────────────────────────────
			case 'push_notify': {
				const validSeverities: NotifSeverity[] = ['critical', 'warning', 'info', 'success'];
				const validCategories: NotifCategory[] = ['task', 'service', 'agent', 'chat', 'memory', 'model', 'system'];

				const severity = validSeverities.includes(args.severity as NotifSeverity)
					? (args.severity as NotifSeverity)
					: 'info';
				const category = validCategories.includes(args.category as NotifCategory)
					? (args.category as NotifCategory)
					: 'system';

				const notif = await pushNotification({
					severity,
					category,
					title: String(args.title),
					message: String(args.message),
					source: 'claw',
					link: (args.link as string) ?? undefined,
					linkLabel: args.link ? 'View' : undefined
				});

				return JSON.stringify({ pushed: { id: notif.id, title: notif.title, severity: notif.severity } });
			}

			default:
				return JSON.stringify({ error: `Unknown tool: ${call.name}` });
		}
	} catch (err) {
		return JSON.stringify({ error: `Tool execution failed: ${(err as Error).message}` });
	}
}

// ── Direct service management (fallback when dashboard API unavailable) ──

async function startServiceDirectly(id: string): Promise<string> {
	try {
		switch (id) {
			case 'ollama': {
				await execAsync('start /B ollama serve', { windowsHide: true });
				return JSON.stringify({ success: true, message: 'Ollama server starting...' });
			}
			case 'openclaw': {
				await execAsync(
					`start /B npx openclaw gateway run --port 18789 --allow-unconfigured`,
					{ cwd: PATHS.root, windowsHide: true }
				);
				return JSON.stringify({ success: true, message: 'OpenClaw gateway starting on :18789...' });
			}
			case 'claude-flow': {
				await execAsync('npx @claude-flow/cli@latest daemon start', {
					cwd: PATHS.root,
					timeout: 15000,
					windowsHide: true
				});
				return JSON.stringify({ success: true, message: 'Claude Flow daemon starting...' });
			}
			default:
				return JSON.stringify({ success: false, message: `No start command for ${id}` });
		}
	} catch (e) {
		return JSON.stringify({ success: false, message: (e as Error).message });
	}
}

async function stopServiceDirectly(id: string): Promise<string> {
	const def = SERVICES[id as keyof typeof SERVICES];
	if (!def?.port) return JSON.stringify({ success: false, message: `No port for ${id}` });

	try {
		if (id === 'claude-flow') {
			await execAsync('npx @claude-flow/cli@latest daemon stop', {
				cwd: PATHS.root,
				timeout: 15000,
				windowsHide: true
			});
			return JSON.stringify({ success: true, message: 'Claude Flow daemon stopped' });
		}

		const { stdout } = await execAsync(
			`netstat -ano | findstr :${def.port} | findstr LISTENING`,
			{ timeout: 3000, windowsHide: true }
		);
		const parts = stdout.trim().split(/\s+/);
		const pid = parseInt(parts[parts.length - 1], 10);
		if (!isNaN(pid) && pid > 0) {
			await execAsync(`taskkill /PID ${pid} /F`, { timeout: 5000, windowsHide: true });
			return JSON.stringify({ success: true, message: `${def.name} stopped (PID ${pid})` });
		}
		return JSON.stringify({ success: false, message: `No process on port ${def.port}` });
	} catch (e) {
		return JSON.stringify({ success: false, message: (e as Error).message });
	}
}
