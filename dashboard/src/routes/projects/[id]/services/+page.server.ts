import { resolve } from 'path';
import { readFile } from 'fs/promises';
import type { PageServerLoad } from './$types.js';
import { PATHS, SERVICES } from '$lib/server/constants.js';
import { scanAllProjects, detectProjectMeta } from '$lib/server/project-scanner.js';

interface ProjectService {
	id: string;
	name: string;
	type: string;
	port: number | null;
	healthUrl: string | null;
	status: 'unknown' | 'running' | 'stopped';
	source: 'detected' | 'config' | 'global';
	command: string | null;
}

interface ServicePageData {
	projectId: string;
	projectName: string;
	projectPath: string;
	services: ProjectService[];
	scripts: Record<string, string>;
	stats: {
		total: number;
		withPort: number;
		detected: number;
		global: number;
	};
}

async function checkHealth(url: string): Promise<boolean> {
	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 2000);
		const res = await fetch(url, { signal: controller.signal });
		clearTimeout(timeout);
		return res.ok;
	} catch {
		return false;
	}
}

export const load: PageServerLoad = async ({ parent, params }): Promise<ServicePageData> => {
	const { project } = await parent();
	const projects = await scanAllProjects(PATHS.playgroundRegistry, PATHS.root);
	const scannedProject = projects.find((p) => p.id === params.id);
	const projectPath = scannedProject?.path ?? project.path;
	const projectName = scannedProject?.name ?? project.name;

	const services: ProjectService[] = [];

	// 1. Detect services from project files
	let meta;
	try {
		meta = await detectProjectMeta(projectPath);
	} catch {
		meta = null;
	}

	if (meta?.services) {
		for (const svc of meta.services) {
			const healthUrl = svc.healthUrl ?? null;
			let status: 'unknown' | 'running' | 'stopped' = 'unknown';
			if (healthUrl) {
				status = (await checkHealth(healthUrl)) ? 'running' : 'stopped';
			}
			services.push({
				id: svc.name.toLowerCase().replace(/[^a-z0-9]/g, '-'),
				name: svc.name,
				type: 'Detected Service',
				port: svc.port ?? null,
				healthUrl,
				status,
				source: 'detected',
				command: svc.command ?? null
			});
		}
	}

	// 2. Read project-local custom services config
	try {
		const configPath = resolve(projectPath, '.playground/custom-services.json');
		const raw = await readFile(configPath, 'utf-8');
		const customServices = JSON.parse(raw) as Array<{
			name: string;
			type?: string;
			port?: number;
			command?: string;
			healthUrl?: string;
		}>;
		for (const cs of customServices) {
			const healthUrl = cs.healthUrl ?? null;
			let status: 'unknown' | 'running' | 'stopped' = 'unknown';
			if (healthUrl) {
				status = (await checkHealth(healthUrl)) ? 'running' : 'stopped';
			}
			services.push({
				id: cs.name.toLowerCase().replace(/[^a-z0-9]/g, '-'),
				name: cs.name,
				type: cs.type ?? 'Custom Service',
				port: cs.port ?? null,
				healthUrl,
				status,
				source: 'config',
				command: cs.command ?? null
			});
		}
	} catch {
		// no custom services config
	}

	// 3. Add global services that are relevant (check health)
	const globalServiceDefs = Object.values(SERVICES);
	for (const svc of globalServiceDefs) {
		// Skip if already added from detection
		const alreadyAdded = services.some((s) => s.port === svc.port && svc.port !== null);
		if (alreadyAdded) continue;

		let status: 'unknown' | 'running' | 'stopped' = 'unknown';
		if (svc.healthUrl) {
			status = (await checkHealth(svc.healthUrl)) ? 'running' : 'stopped';
		}
		services.push({
			id: svc.id,
			name: svc.name,
			type: svc.type,
			port: svc.port,
			healthUrl: svc.healthUrl,
			status,
			source: 'global',
			command: null
		});
	}

	// 4. Add dev/build/test as virtual services from scripts
	let scripts: Record<string, string> = {};
	try {
		const raw = await readFile(resolve(projectPath, 'package.json'), 'utf-8');
		const pkg = JSON.parse(raw);
		scripts = (pkg.scripts as Record<string, string>) ?? {};
	} catch {
		// no package.json
	}

	const detected = services.filter((s) => s.source === 'detected').length;
	const global = services.filter((s) => s.source === 'global').length;
	const withPort = services.filter((s) => s.port !== null).length;

	return {
		projectId: params.id,
		projectName,
		projectPath,
		services,
		scripts,
		stats: {
			total: services.length,
			withPort,
			detected,
			global
		}
	};
};
