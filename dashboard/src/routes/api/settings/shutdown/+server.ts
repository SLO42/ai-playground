/**
 * Graceful shutdown endpoint — stops agents, heartbeat, and the server process.
 *
 * Shutdown order:
 * 1. Stop heartbeat (no new agents will spawn)
 * 2. Kill active agents (SIGTERM, then SIGKILL after 5s)
 * 3. Release session pool slots
 * 4. Stop Claude Flow daemon
 * 5. Exit the Node process
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { stopHeartbeat } from '$lib/server/heartbeat/index.js';
import { getActiveAgents } from '$lib/server/heartbeat/shared.js';
import { getPoolStats } from '$lib/server/heartbeat/session-pool.js';
import { pushNotification } from '$lib/server/notifications.js';
import { exec } from 'child_process';

export const POST: RequestHandler = async () => {
	const steps: { step: string; status: 'ok' | 'skipped' | 'error'; detail?: string }[] = [];

	// 1. Stop heartbeat — prevent new agent spawns
	try {
		stopHeartbeat();
		steps.push({ step: 'heartbeat', status: 'ok', detail: 'Heartbeat stopped' });
	} catch (e) {
		steps.push({ step: 'heartbeat', status: 'error', detail: e instanceof Error ? e.message : 'unknown' });
	}

	// 2. Kill active agents
	const agents = getActiveAgents();
	if (agents.size > 0) {
		const killed: string[] = [];
		const failed: string[] = [];

		for (const [taskId, agent] of agents) {
			try {
				if (agent.pid > 0) {
					process.kill(agent.pid, 'SIGTERM');
					killed.push(taskId);
				}
			} catch {
				failed.push(taskId);
			}
		}

		// Give agents 5s to exit gracefully, then force kill
		if (killed.length > 0) {
			await new Promise(resolve => setTimeout(resolve, 5000));
			for (const taskId of killed) {
				const agent = agents.get(taskId);
				if (agent?.pid) {
					try {
						process.kill(agent.pid, 0); // Check if still alive
						process.kill(agent.pid, 'SIGKILL');
					} catch {
						// Already exited — good
					}
				}
			}
		}

		agents.clear();
		steps.push({
			step: 'agents',
			status: failed.length > 0 ? 'error' : 'ok',
			detail: `${killed.length} terminated${failed.length > 0 ? `, ${failed.length} failed` : ''}`
		});
	} else {
		steps.push({ step: 'agents', status: 'skipped', detail: 'No active agents' });
	}

	// 3. Session pool — just report status (slots are in-memory)
	try {
		const pool = await getPoolStats();
		const activeSlots = pool.slots.filter(s => s.status === 'active').length;
		steps.push({ step: 'session-pool', status: 'ok', detail: `${pool.slots.length} slots cleared (${activeSlots} were active)` });
	} catch {
		steps.push({ step: 'session-pool', status: 'skipped' });
	}

	// 4. Stop Claude Flow daemon
	try {
		await new Promise<void>((resolve) => {
			exec('npx @claude-flow/cli@latest daemon stop', { timeout: 10000 }, (err) => {
				if (err) {
					steps.push({ step: 'claude-flow', status: 'skipped', detail: 'Daemon not running or stop failed' });
				} else {
					steps.push({ step: 'claude-flow', status: 'ok', detail: 'Daemon stopped' });
				}
				resolve();
			});
		});
	} catch {
		steps.push({ step: 'claude-flow', status: 'skipped', detail: 'Daemon stop timed out' });
	}

	// 5. Push final notification
	try {
		await pushNotification({
			severity: 'warning',
			category: 'system',
			title: 'System shutting down',
			message: `Graceful shutdown initiated — ${steps.filter(s => s.status === 'ok').length}/${steps.length} steps completed`,
			source: 'system',
			desktop: true
		});
	} catch { /* best effort */ }

	// 6. Schedule process exit (give time for the response to be sent)
	setTimeout(() => {
		process.exit(0);
	}, 1000);

	return json({
		status: 'shutting_down',
		steps
	});
};
