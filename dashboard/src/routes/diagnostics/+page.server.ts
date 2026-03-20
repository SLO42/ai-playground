import type { PageServerLoad } from './$types.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { statSync, readdirSync } from 'fs';
import { resolve, join } from 'path';
import { PATHS } from '$lib/server/constants.js';

const execFileAsync = promisify(execFile);

interface Check {
	name: string;
	status: 'pass' | 'fail' | 'warn';
	detail: string;
	fix?: string;
}

export const load: PageServerLoad = async () => {
	const checks: Check[] = [];

	// 1. Node.js version
	checks.push({
		name: 'Node.js',
		status: process.version >= 'v18' ? 'pass' : 'fail',
		detail: process.version,
		fix: 'Install Node.js 18+ from https://nodejs.org'
	});

	// 2. Ollama connectivity
	try {
		const res = await fetch('http://127.0.0.1:11434/api/tags', {
			signal: AbortSignal.timeout(3000)
		});
		const data = await res.json();
		checks.push({
			name: 'Ollama',
			status: 'pass',
			detail: `${data.models?.length ?? 0} models loaded`
		});
	} catch {
		checks.push({
			name: 'Ollama',
			status: 'fail',
			detail: 'Not reachable at localhost:11434',
			fix: 'Install and start Ollama: https://ollama.ai'
		});
	}

	// 3. OpenClaw gateway
	try {
		const res = await fetch('http://127.0.0.1:18789/health', {
			signal: AbortSignal.timeout(3000)
		});
		checks.push({
			name: 'OpenClaw Gateway',
			status: res.ok ? 'pass' : 'warn',
			detail: res.ok ? 'Healthy' : `Status ${res.status}`
		});
	} catch {
		checks.push({
			name: 'OpenClaw Gateway',
			status: 'warn',
			detail: 'Not running',
			fix: 'Run: npm run openclaw:start'
		});
	}

	// 4. Git
	try {
		const { stdout } = await execFileAsync('git', ['--version']);
		checks.push({ name: 'Git', status: 'pass', detail: stdout.trim() });
	} catch {
		checks.push({
			name: 'Git',
			status: 'fail',
			detail: 'Not found',
			fix: 'Install Git: https://git-scm.com'
		});
	}

	// 5. GitHub CLI
	try {
		const { stdout } = await execFileAsync('gh', ['--version']);
		checks.push({
			name: 'GitHub CLI',
			status: 'pass',
			detail: stdout.split('\n')[0].trim()
		});
	} catch {
		checks.push({
			name: 'GitHub CLI',
			status: 'warn',
			detail: 'Not installed',
			fix: 'Install: https://cli.github.com'
		});
	}

	// 6. Claude CLI
	try {
		const { stdout } = await execFileAsync('claude', ['--version']);
		checks.push({ name: 'Claude CLI', status: 'pass', detail: stdout.trim() });
	} catch {
		checks.push({
			name: 'Claude CLI',
			status: 'warn',
			detail: 'Not found',
			fix: 'Install: npm install -g @anthropic-ai/claude-code'
		});
	}

	// 7. Disk space (Windows — uses wmic)
	try {
		const { stdout } = await execFileAsync('wmic', [
			'logicaldisk',
			'where',
			'DeviceID="F:"',
			'get',
			'FreeSpace,Size',
			'/format:csv'
		]);
		const lines = stdout.trim().split('\n').filter((l) => l.includes(','));
		if (lines.length > 0) {
			const parts = lines[lines.length - 1].split(',');
			const free = parseInt(parts[1]) || 0;
			const total = parseInt(parts[2]) || 0;
			const freeGB = (free / 1e9).toFixed(1);
			const totalGB = (total / 1e9).toFixed(1);
			checks.push({
				name: 'Disk Space (F:)',
				status: free > 10e9 ? 'pass' : free > 2e9 ? 'warn' : 'fail',
				detail: `${freeGB} GB free of ${totalGB} GB`,
				fix: free < 2e9 ? 'Free up disk space' : undefined
			});
		}
	} catch {
		// Skip disk check on non-Windows or if wmic fails
	}

	// 8. SQLite databases
	const dbFiles = [
		{ name: 'Tasks', path: '.playground/tasks.db' },
		{ name: 'Analytics', path: '.playground/analytics.db' },
		{ name: 'Routing', path: '.playground/routing-telemetry.db' },
		{ name: 'PID Registry', path: '.playground/pid-registry.db' },
		{ name: 'Notifications', path: '.playground/notifications.db' },
		{ name: 'Incidents', path: '.playground/incidents.db' },
		{ name: 'Spawn Stats', path: '.playground/spawn-stats.db' },
		{ name: 'PM Memory', path: '.playground/pm-memory.db' }
	];

	const databases = dbFiles.map((db) => {
		const fullPath = resolve(PATHS.root, db.path);
		try {
			const stat = statSync(fullPath);
			return { name: db.name, sizeKB: Math.round(stat.size / 1024), exists: true };
		} catch {
			return { name: db.name, sizeKB: 0, exists: false };
		}
	});

	// 9. Build output
	const buildDir = resolve(PATHS.root, 'dashboard/build');
	let buildInfo = { exists: false, sizeMB: 0 };
	try {
		statSync(buildDir);
		// Recursively sum file sizes
		function dirSize(dir: string): number {
			let total = 0;
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const full = join(dir, entry.name);
				if (entry.isDirectory()) {
					total += dirSize(full);
				} else {
					try {
						total += statSync(full).size;
					} catch {
						/* skip unreadable files */
					}
				}
			}
			return total;
		}
		const bytes = dirSize(buildDir);
		buildInfo = { exists: true, sizeMB: parseFloat((bytes / 1e6).toFixed(1)) };
	} catch {
		/* build dir does not exist */
	}

	return { checks, databases, buildInfo };
};
