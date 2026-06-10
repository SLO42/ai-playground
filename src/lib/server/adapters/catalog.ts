// TASK 12.4 — the UNIFIED adapter catalog across ALL THREE D-037 families (publish · deploy ·
// sync). This is the piece that FINISHES the framework: the 12.1 `AdapterRegistry` only knows the
// gated-action families (publish + deploy); the sync family lives in its own `SyncRegistry`
// (sync/index.ts, the 9.4 reference + 11.4 board adapter). This module composes BOTH registries
// into ONE honest catalog the surface renders — so GitHub task↔issue sync (9.4) and the project
// board sync (11.4) appear as first-class registry adapters beside npm/Thunderstore/github-releases,
// with the SAME id/kind/probe/secret-presence surface (the D-037 retrofit, part (a) of 12.4).
//
// It also answers the D-037 SCALE story (part (b)): a project may declare a CUSTOM adapter id the
// core does not ship. `installedIds()` lets the surface mark a declared target whose adapter is NOT
// registered as an HONEST "adapter not installed" (fail-closed, F-008) — a novel process plugs in
// by declaring {adapterId, config}; the framework shows the truth until that adapter is installed.
//
// Honesty (F-008 / D-026): every probe is best-effort and NEVER throws (a throw degrades to
// available:false + the reason); secrets are PRESENCE-ONLY (never a value). Sync adapters declare
// no env secrets (they authenticate via the operator's `gh auth` / GH_TOKEN keychain — D-026), so
// their secret list is empty; their availability comes from the adapter's own probe.

import type { Db } from '../db/client';
import { getSyncRegistry, getBoardConfig, GitHubBoardSyncAdapter, type SyncAdapter } from '../sync';
import { describeAdapterSecrets, resolverForAdapter, type EnvLike } from './secrets';
import { getAdapterRegistry } from './index';
import type { AdapterKind, AdapterProbe, SecretPresence, ActionAdapter } from './types';

/** All three D-037 families — the unified catalog spans them. */
export const ADAPTER_KINDS: readonly AdapterKind[] = ['publish', 'deploy', 'sync'] as const;

/** One adapter in the unified catalog — its identity, honest probe, and secret presence. */
export interface CatalogEntry {
	id: string;
	label: string;
	kind: AdapterKind;
	/** True iff this id is a registered built-in (false for a project's custom/unknown id). */
	installed: boolean;
	/** Honest availability + (when known) the resolved external target (F-008). */
	probe: AdapterProbe;
	/** The named secrets the adapter needs — PRESENCE ONLY, never a value (D-026). Empty for sync. */
	secrets: SecretPresence[];
}

/** Probe + secret-presence for one PUBLISH/DEPLOY adapter (honest — never throws). */
async function describeActionAdapter(
	env: EnvLike,
	adapter: ActionAdapter,
	cwd: string
): Promise<CatalogEntry> {
	const secrets = describeAdapterSecrets(env, adapter);
	const resolver = resolverForAdapter(env, adapter);
	let probe: AdapterProbe;
	try {
		probe = await adapter.probe({ cwd, secrets: resolver });
	} catch (err) {
		probe = { available: false, reason: (err as Error).message };
	}
	return { id: adapter.id, label: adapter.label, kind: adapter.kind, installed: true, probe, secrets };
}

/**
 * Probe one SYNC adapter (honest — never throws). Sync adapters declare no env secrets (gh-auth
 * keychain, D-026) so `secrets` is empty. The board adapter needs the per-project opt-in config +
 * the resolved repo to probe meaningfully; the issue adapter resolves its own repo from `cwd`.
 */
async function describeSyncAdapter(
	adapter: SyncAdapter,
	cwd: string,
	db: Db | null,
	projectId: string | null
): Promise<CatalogEntry> {
	let probe: AdapterProbe;
	try {
		if (adapter.id === 'github-board') {
			// The board adapter's probe needs the resolved repo + the project's board config. Resolve
			// the repo via the issue adapter (its target), and read the opt-in config when we have a db.
			const issue = getSyncRegistry().has('github') ? getSyncRegistry().get('github') : null;
			const repoProbe = issue ? await issue.probe({ cwd }) : { available: false };
			const config = db && projectId ? await getBoardConfig(db, projectId) : null;
			const boardAdapter =
				adapter instanceof GitHubBoardSyncAdapter ? adapter : new GitHubBoardSyncAdapter();
			probe = await boardAdapter.probe({
				cwd,
				...(repoProbe.target ? { repo: repoProbe.target } : {}),
				config
			});
		} else {
			probe = await adapter.probe({ cwd });
		}
	} catch (err) {
		probe = { available: false, reason: (err as Error).message };
	}
	return { id: adapter.id, label: adapter.label, kind: 'sync', installed: true, probe, secrets: [] };
}

/**
 * Build the UNIFIED catalog of every registered adapter across all three families, each with its
 * honest probe + secret presence. This is the catalog the targets surface renders (the operator
 * chooses a built-in OR declares a custom id). `db`/`projectId` enable the board adapter's
 * config-aware probe; omit them (null) for a config-free catalog (e.g. a registry self-test).
 */
export async function buildAdapterCatalog(opts: {
	env: EnvLike;
	cwd: string;
	db?: Db | null;
	projectId?: string | null;
}): Promise<CatalogEntry[]> {
	const reg = getAdapterRegistry();
	const actionAdapters: ActionAdapter[] = [...reg.listPublishers(), ...reg.listDeployers()];
	const syncAdapters = getSyncRegistry().list();
	const [actions, syncs] = await Promise.all([
		Promise.all(actionAdapters.map((a) => describeActionAdapter(opts.env, a, opts.cwd))),
		Promise.all(
			syncAdapters.map((a) =>
				describeSyncAdapter(a, opts.cwd, opts.db ?? null, opts.projectId ?? null)
			)
		)
	]);
	return [...actions, ...syncs];
}

/**
 * The set of installed adapter ids per kind — the surface uses this to mark a declared target
 * whose adapter is NOT registered as an honest "adapter not installed" (the D-037 custom-target
 * scale story; F-008 fail-closed). Reads both registries; cheap, side-effect-free.
 */
export function installedIds(): Record<AdapterKind, Set<string>> {
	const reg = getAdapterRegistry();
	const sync = getSyncRegistry();
	return {
		publish: new Set(reg.listPublishers().map((a) => a.id)),
		deploy: new Set(reg.listDeployers().map((a) => a.id)),
		sync: new Set(sync.list().map((a) => a.id))
	};
}

/** True iff an adapter id is registered (installed) for a kind across the two registries. */
export function isInstalled(kind: AdapterKind, id: string): boolean {
	if (kind === 'sync') return getSyncRegistry().has(id);
	return getAdapterRegistry().has(kind, id);
}
