import type { PageServerLoad } from './$types.js';
import { error } from '@sveltejs/kit';
import { getFeatureFlags } from '$lib/server/feature-flags.js';

interface SecurityData {
	summary: { lastScan: string; vulnerabilities: number; critical: number; score: string; status: string };
	vulnerabilities: Array<{ package: string; severity: string; cve: string; current: string; fixed: string }>;
	policies: Array<{ name: string; value: string; pass: boolean }>;
	permissions: Array<{ path: string; perms: string; pass: boolean }>;
	auditLog: Array<{ time: string; message: string; result: 'PASS' }>;
	loadError: string | null;
}

export const load: PageServerLoad = async ({ params, fetch }) => {
	const flags = getFeatureFlags();
	if (!flags.previewNewPages) throw error(404, 'Not found');

	const loadSecurity = async (): Promise<SecurityData> => {
		const res = await fetch(`/api/projects/${encodeURIComponent(params.id)}/security`);
		if (!res.ok) {
			const body = await res.json().catch(() => ({ error: 'Failed to load security data' }));
			throw new Error(body.error ?? `HTTP ${res.status}`);
		}
		const data = await res.json();
		return { ...data, loadError: null };
	};

	return {
		security: loadSecurity().catch((e) => {
			const message = e instanceof Error ? e.message : 'Failed to load security data';
			return {
				summary: { lastScan: 'Error', vulnerabilities: 0, critical: 0, score: 'N/A', status: 'ERROR' },
				vulnerabilities: [],
				policies: [],
				permissions: [],
				auditLog: [],
				loadError: message
			} satisfies SecurityData;
		})
	};
};
