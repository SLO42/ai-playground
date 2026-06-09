// TASK 12.1 — the adapter CONTRACT-TEST harness (D-037). Any PublisherAdapter / DeployTarget
// implementation runs against this to PROVE it honors the framework contract WITHOUT a real
// external call. 12.2 (deepen Thunderstore) + 12.3 (more targets) import this and assert
// `runPublisherContract` / `runDeployContract` returns no violations.
//
// The contract checks the invariants the framework + the surfaces rely on:
//   • probe() NEVER throws and returns a boolean `available` + an honest reason when false.
//   • dry-run NEVER mutates externally — it returns dryRun:true and a non-empty plan.
//   • the SecretResolver is CONFINED — reading an undeclared secret throws (D-026).
//   • declared secrets() are well-formed (env-var name + label + purpose).
//   • a result envelope is honest — ok:false carries a reason in the summary/warnings.
//
// It uses a no-op env + a confined resolver built from the adapter's own declarations, so the
// harness performs NO real publish/deploy and needs no credentials.

import { makeSecretResolver } from './secrets';
import type {
	ActionAdapter,
	AdapterRunResult,
	DeployTarget,
	PublisherAdapter,
	SecretResolver
} from './types';
import { SecretConfinementError } from './types';

/** A single contract check + its outcome. */
export interface ContractCheck {
	name: string;
	ok: boolean;
	detail?: string;
}

export interface ContractReport {
	adapterId: string;
	kind: string;
	checks: ContractCheck[];
	/** True iff every check passed. */
	ok: boolean;
	/** The failing checks (empty when ok). */
	violations: ContractCheck[];
}

/** Options for a contract run — the cwd the harness probes against (a fixture dir). */
export interface ContractRunOptions {
	/** Working dir the adapter probes/packages against (a test fixture project). */
	cwd: string;
	/** Project id the run options carry (a syntactically valid record id). Default a stub. */
	projectId?: string;
	/** Env the resolver reads from (default: empty — proves dry-run needs no creds). */
	env?: Record<string, string | undefined>;
}

function finalize(adapterId: string, kind: string, checks: ContractCheck[]): ContractReport {
	const violations = checks.filter((c) => !c.ok);
	return { adapterId, kind, checks, ok: violations.length === 0, violations };
}

/** Shared base checks every adapter (any family) must satisfy. */
async function baseChecks(adapter: ActionAdapter, env: Record<string, string | undefined>): Promise<{ checks: ContractCheck[]; resolver: SecretResolver }> {
	const checks: ContractCheck[] = [];

	// id / label / kind are non-empty.
	checks.push({ name: 'identity', ok: !!adapter.id && !!adapter.label && !!adapter.kind, detail: `${adapter.id}/${adapter.kind}` });

	// secrets() is well-formed.
	const reqs = adapter.secrets();
	const secretsOk = Array.isArray(reqs) && reqs.every((r) => !!r.envVar && !!r.label && !!r.purpose);
	checks.push({ name: 'secrets-well-formed', ok: secretsOk, detail: `${reqs.length} declared` });

	const resolver = makeSecretResolver(env, reqs);

	// Confinement: reading an UNDECLARED secret throws SecretConfinementError (D-026).
	let confined = false;
	try {
		resolver.has('__UNDECLARED_SECRET__');
	} catch (err) {
		confined = err instanceof SecretConfinementError;
	}
	checks.push({ name: 'secret-confinement', ok: confined, detail: 'undeclared secret read must throw (D-026)' });

	// Declared secrets are readable through the resolver without throwing.
	let declaredReadable = true;
	for (const r of reqs) {
		try {
			resolver.has(r.envVar);
			resolver.get(r.envVar);
		} catch {
			declaredReadable = false;
		}
	}
	checks.push({ name: 'declared-secrets-readable', ok: declaredReadable });

	return { checks, resolver };
}

/** Assert a dry-run result envelope is honest (dryRun:true, a plan, no fabricated success). */
function checkDryRunResult(name: string, r: AdapterRunResult): ContractCheck[] {
	return [
		{ name: `${name}:dryRun-flag`, ok: r.dryRun === true, detail: 'dry-run must set dryRun:true' },
		{ name: `${name}:has-plan`, ok: Array.isArray(r.steps) && r.steps.length > 0, detail: 'dry-run must return a non-empty plan' },
		{ name: `${name}:honest-summary`, ok: typeof r.summary === 'string' && r.summary.length > 0 },
		// When ok:false the result must carry a reason somewhere (summary or warnings) — F-008.
		{
			name: `${name}:honest-failure`,
			ok: r.ok || r.summary.length > 0 || r.warnings.length > 0,
			detail: 'a failed result must explain why'
		}
	];
}

/** Run the full PUBLISHER contract. Returns a report; no real publish occurs. */
export async function runPublisherContract(
	adapter: PublisherAdapter,
	opts: ContractRunOptions
): Promise<ContractReport> {
	const env = opts.env ?? {};
	const projectId = opts.projectId ?? 'project:contract_fixture';
	const { checks, resolver } = await baseChecks(adapter, env);

	// probe() never throws + returns a boolean.
	try {
		const p = await adapter.probe({ cwd: opts.cwd, secrets: resolver });
		checks.push({ name: 'probe-no-throw', ok: typeof p.available === 'boolean' });
		checks.push({
			name: 'probe-honest-reason',
			ok: p.available || (typeof p.reason === 'string' && p.reason.length > 0),
			detail: 'an unavailable probe must give a reason'
		});
	} catch (err) {
		checks.push({ name: 'probe-no-throw', ok: false, detail: (err as Error).message });
	}

	const runOpts = { projectId, cwd: opts.cwd, dryRun: true as const, secrets: resolver };

	// validate() returns a typed verdict.
	try {
		const v = await adapter.validate(runOpts);
		checks.push({ name: 'validate-typed', ok: typeof v.ok === 'boolean' && Array.isArray(v.blockers) });
		checks.push({ name: 'validate-honest', ok: v.ok || v.blockers.length > 0, detail: 'invalid must list blockers' });
	} catch (err) {
		checks.push({ name: 'validate-typed', ok: false, detail: (err as Error).message });
	}

	// package() + publish() dry-runs are honest + non-mutating.
	try {
		const pkg = await adapter.package(runOpts);
		checks.push(...checkDryRunResult('package', pkg));
	} catch (err) {
		checks.push({ name: 'package:dryRun-flag', ok: false, detail: (err as Error).message });
	}
	try {
		const pub = await adapter.publish(runOpts);
		checks.push(...checkDryRunResult('publish', pub));
	} catch (err) {
		checks.push({ name: 'publish:dryRun-flag', ok: false, detail: (err as Error).message });
	}

	return finalize(adapter.id, adapter.kind, checks);
}

/** Run the full DEPLOY contract. Returns a report; no real deploy occurs. */
export async function runDeployContract(
	adapter: DeployTarget,
	opts: ContractRunOptions
): Promise<ContractReport> {
	const env = opts.env ?? {};
	const projectId = opts.projectId ?? 'project:contract_fixture';
	const { checks, resolver } = await baseChecks(adapter, env);

	try {
		const p = await adapter.probe({ cwd: opts.cwd, secrets: resolver });
		checks.push({ name: 'probe-no-throw', ok: typeof p.available === 'boolean' });
		checks.push({
			name: 'probe-honest-reason',
			ok: p.available || (typeof p.reason === 'string' && p.reason.length > 0)
		});
	} catch (err) {
		checks.push({ name: 'probe-no-throw', ok: false, detail: (err as Error).message });
	}

	const runOpts = { projectId, cwd: opts.cwd, dryRun: true as const, secrets: resolver };

	try {
		const d = await adapter.deploy(runOpts);
		checks.push(...checkDryRunResult('deploy', d));
	} catch (err) {
		checks.push({ name: 'deploy:dryRun-flag', ok: false, detail: (err as Error).message });
	}

	try {
		const s = await adapter.status({ cwd: opts.cwd, secrets: resolver });
		checks.push({
			name: 'status-typed',
			ok: ['deployed', 'deploying', 'failed', 'unknown'].includes(s.state),
			detail: `state=${s.state}`
		});
	} catch (err) {
		checks.push({ name: 'status-typed', ok: false, detail: (err as Error).message });
	}

	return finalize(adapter.id, adapter.kind, checks);
}
