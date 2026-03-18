/**
 * Environment management — CRUD operations for project environments.
 * Data stored at: <projectPath>/.playground/environments.json
 */
import { readFile, writeFile, mkdir } from 'fs/promises';
import { resolve, dirname } from 'path';
import type { ProjectEnvironment } from '$lib/types/projects.js';

function environmentsPath(projectPath: string): string {
	return resolve(projectPath, '.playground', 'environments.json');
}

/** Load all environments for a project. Returns empty array if none exist. */
export async function loadEnvironments(projectPath: string): Promise<ProjectEnvironment[]> {
	try {
		const raw = await readFile(environmentsPath(projectPath), 'utf-8');
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed as ProjectEnvironment[];
	} catch {
		return [];
	}
}

/** Save environments array to disk. Creates .playground/ if needed. */
export async function saveEnvironments(projectPath: string, envs: ProjectEnvironment[]): Promise<void> {
	const filePath = environmentsPath(projectPath);
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(filePath, JSON.stringify(envs, null, '\t'), 'utf-8');
}

/** Get a single environment by name. Returns null if not found. */
export function getEnvironment(projectPath: string, name: string): Promise<ProjectEnvironment | null> {
	return loadEnvironments(projectPath).then(
		(envs) => envs.find((e) => e.name === name) ?? null
	);
}

/** Validate an environment object from user input. */
export function validateEnvironment(
	body: unknown
): { valid: true; data: ProjectEnvironment } | { valid: false; error: string } {
	if (!body || typeof body !== 'object') {
		return { valid: false, error: 'Request body must be an object' };
	}

	const b = body as Record<string, unknown>;

	if (typeof b.name !== 'string' || b.name.trim().length === 0) {
		return { valid: false, error: 'Environment name is required' };
	}

	const name = b.name.trim().toLowerCase();
	if (!/^[a-z0-9][a-z0-9_-]{0,48}[a-z0-9]?$/.test(name)) {
		return { valid: false, error: 'Environment name must be alphanumeric with hyphens/underscores, 1-50 chars' };
	}

	const status = b.status;
	if (status !== 'active' && status !== 'inactive' && status !== 'deploying') {
		return { valid: false, error: 'Status must be active, inactive, or deploying' };
	}

	// Validate variables — must be Record<string, string>
	let variables: Record<string, string> = {};
	if (b.variables !== undefined) {
		if (typeof b.variables !== 'object' || b.variables === null || Array.isArray(b.variables)) {
			return { valid: false, error: 'Variables must be an object' };
		}
		const vars = b.variables as Record<string, unknown>;
		for (const [key, val] of Object.entries(vars)) {
			if (typeof val !== 'string') {
				return { valid: false, error: `Variable "${key}" must be a string` };
			}
		}
		variables = vars as Record<string, string>;
	}

	return {
		valid: true,
		data: {
			name,
			branch: typeof b.branch === 'string' ? b.branch.trim() : undefined,
			url: typeof b.url === 'string' ? b.url.trim() : undefined,
			variables,
			lastDeployedAt: typeof b.lastDeployedAt === 'string' ? b.lastDeployedAt : undefined,
			lastDeployedVersion: typeof b.lastDeployedVersion === 'string' ? b.lastDeployedVersion : undefined,
			status
		}
	};
}
