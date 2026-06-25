// RC-2 (REPO-CREATION-SPEC) — the GATED OUTWARD repo-creation driver. The deliberate, sanctioned
// exception to the post-task LOCAL-ONLY git rule: this is the ONE place a project's GitHub repo is
// created and its existing local scaffold commits are pushed to a brand-new private remote — and it
// happens ONLY behind a D-037-class gate. This module MIRRORS release-gate.ts's shape (recorded
// operator CONSENT + a deterministic confirm-TOKEN + a gated outward call; ANY red → an honest
// `created:false` with a named `failedAt`, never a partial fabrication).
//
// The sequence (each stage RED → HALT honestly; no later stage runs, no outward call is made):
//
//   (a) CONSENT  — the operator's RECORDED repo_create_preauthorized (read by the caller; re-asserted
//                  here as a hard precondition so this module can NEVER create a repo without it). A
//                  PM never sets this unilaterally (B4/D-039) — operator-create sets it directly, a
//                  PM-proposed create routes through the §4.1 panel + operator 'act'.
//   (b) TOKEN    — a deterministic confirm token validates. Derived the SAME way release-gate does —
//                  confirmTokenFor({ projectId, kind:'repo-create', adapterId:'github', config }) —
//                  so a forged/missing/foreign token FAILS CLOSED (a publish token, or a token for a
//                  different name/owner, hashes differently → no match → no create).
//   (c) AUTH     — `gh` is installed AND authenticated (RC-1 isAuthenticated). Not authed → halt
//                  honestly (NO outward create attempted).
//   (d) PRIVATE  — private-first is RE-ASSERTED at the gate (defense-in-depth — RC-1's createRepo
//                  hardcodes `--private` and public is unrepresentable in its input type, but the gate
//                  also refuses any input that smells like a public request).
//   (e) CREATE   — createRepo (RC-1) — PRIVATE. Honest named outcomes: created / already-exists /
//                  permission-denied / unauthed / error.
//   (f) REMOTE   — back the existing LOCAL scaffold commits: `git remote add origin <url>` + `git
//                  push -u origin <branch>` via a DEDICATED OUTWARD git runner (execFile array-args,
//                  D-008) that is SEPARATE from post-task's assertLocalGit. This is the SANCTIONED
//                  outward seam; it does NOT route through assertLocalGit (which refuses remote/push)
//                  and does NOT weaken it (the post-task loop stays local-only — grep-confirmed).
//   (g) URL      — on real success write the resolved remote URL to project.repo_url (normalized;
//                  F-013 — coerced/omit-absent in the repo.ts normalizer).
//
// IDEMPOTENT (interrupt contract / F-008): a re-run absorbs prior partial work instead of erroring —
//   • repo ALREADY EXISTS (createRepo → already-exists) → honest no-op success path (still ensure the
//     remote is set + repo_url recorded; never a crash, never a re-create);
//   • the `origin` remote is ALREADY set → honest no-op (we do NOT re-add and do NOT re-push-error;
//     `git remote add` on an existing remote exits non-zero — we detect & absorb it).
//
// D-026: the GH_TOKEN VALUE is NEVER read, logged, persisted, or placed in a result — gh authenticates
// itself; we only surface gh's own (self-redacted) stderr text. F-008: created:true ONLY on a real
// create OR an idempotent already-exists with the remote backed; never a fabricated success.

import type { Db } from '../db/client';
import { getProject, updateProject } from './repo';
import {
	GitHubCliClient,
	assertBranchName,
	type CreateRepoInput,
	type CreateRepoOutcome,
	type GitHubClient
} from '../sync/gh-client';
import { confirmTokenFor } from '../adapters/driver';
import { execFileRunner, type CommandRunner } from '../orchestrator/post-task';

/** The adapter id the repo-create confirm token binds to (a stable, non-AdapterKind label). */
export const REPO_CREATE_ADAPTER_ID = 'github';

/** The named stages the gate runs, each an honest pass/fail with a one-line reason (F-008). */
export type RepoCreateStage = 'consent' | 'token' | 'auth' | 'private' | 'create' | 'remote' | 'url';

/** One objective stage row — its honest ok + a human reason (never a vibe, never a token value). */
export interface RepoCreateCheck {
	name: RepoCreateStage;
	ok: boolean;
	detail: string;
}

/** The gate's verdict. `created` is true ONLY when a real create (or idempotent already-exists) landed AND the remote was backed. */
export interface RepoCreateGateResult {
	/** True iff the repo now exists private-first AND its remote/url are backed. False on ANY red. */
	created: boolean;
	/** The ordered stages the gate ran (it stops at the first red — later stages are not attempted). */
	checks: RepoCreateCheck[];
	/** The first failing stage when not created (null on success). */
	failedAt: RepoCreateStage | null;
	/** A single honest summary line (F-008). */
	summary: string;
	/** The resolved remote URL written to project.repo_url on success (null on any red). */
	repoUrl: string | null;
	/** The createRepo outcome kind when a create was attempted (null when halted before create). */
	createOutcome: CreateRepoOutcome['kind'] | null;
}

/**
 * Compute the confirm token a real repo-create must supply. Derived the SAME deterministic way the
 * release path derives its token (driver.confirmTokenFor) — NOT hand-rolled — over the project, the
 * 'repo-create' kind, this gate's stable adapter id, and the create's config (the resolved name +
 * owner). A token for a different project/name/owner hashes differently → cannot confirm here.
 */
export function repoCreateConfirmToken(input: {
	projectId: string;
	name: string;
	owner?: string;
}): string {
	return confirmTokenFor({
		projectId: input.projectId,
		kind: 'repo-create',
		adapterId: REPO_CREATE_ADAPTER_ID,
		// owner is OMITTED from the config when absent so the token is stable for the default-owner case
		// (an undefined value and an absent key canonicalize identically — but be explicit for clarity).
		config: input.owner !== undefined ? { name: input.name, owner: input.owner } : { name: input.name }
	});
}

export interface RepoCreateGateInput {
	db: Db;
	projectId: string;
	/**
	 * The operator's RECORDED consent (pm.repo_create_preauthorized). The caller reads it and passes it;
	 * the gate RE-ASSERTS it as a hard precondition — a false/absent value can NEVER create (integrity).
	 */
	consent: boolean;
	/** The confirm token the caller supplies — MUST match {@link repoCreateConfirmToken} or fail closed. */
	confirmToken: string;
	/** The bare repo name to create (validated at the RC-1 boundary). */
	name: string;
	/** Optional org/user login to create under; defaults to the authenticated user when omitted. */
	owner?: string;
	/** The branch to push (defaults to 'main' — the scaffold's initial branch). */
	branch?: string;
	/**
	 * Defense-in-depth: the gate refuses any caller that even ASKS for a public repo. RC-1 already makes
	 * public unrepresentable (no field flips it); this re-assertion catches a future/forged caller. When
	 * true the gate halts at the 'private' stage (never reaches create). Default/absent = private (safe).
	 */
	requestedPublic?: boolean;
	/** The GitHub client seam — tests inject a stub (NO real network). Defaults to the real gh CLI. */
	client?: GitHubClient;
	/** The OUTWARD git runner seam (remote add + push) — tests inject a stub. Defaults to execFileRunner. */
	gitRunner?: CommandRunner;
}

function check(name: RepoCreateStage, ok: boolean, detail: string): RepoCreateCheck {
	return { name, ok, detail };
}

/** A short single-line tail of command output for an honest-but-bounded detail (never the whole log). */
function tail(text: string, max = 240): string {
	const oneLine = text.replace(/\s+/g, ' ').trim();
	if (!oneLine) return '';
	return oneLine.length > max ? `…${oneLine.slice(oneLine.length - max)}` : oneLine;
}

/**
 * Run the GATED repo-creation driver. Returns an HONEST verdict — `created` is true ONLY when a real
 * repo now exists private-first (a fresh create OR an idempotent already-exists) AND its remote/url
 * are backed. Never throws for an EXPECTED red (no consent / bad token / not authed / permission
 * denied) — those are honest `created:false` results with a named `failedAt`. An UNEXPECTED internal
 * fault (a client throw) is surfaced as a red 'create' check rather than crashing the caller.
 */
export async function runRepoCreationGate(input: RepoCreateGateInput): Promise<RepoCreateGateResult> {
	const checks: RepoCreateCheck[] = [];
	const halt = (failedAt: RepoCreateStage, summary: string): RepoCreateGateResult => ({
		created: false,
		checks,
		failedAt,
		summary,
		repoUrl: null,
		createOutcome: null
	});

	// (a) CONSENT — the hard precondition. A false/absent consent can NEVER create (re-asserted here so
	// this module is safe even if a future caller forgets the check). No auth probe, no create, no push.
	if (input.consent !== true) {
		checks.push(check('consent', false, 'no recorded repo-create consent (repo_create_preauthorized is false/absent)'));
		return halt('consent', 'repo creation is not pre-authorized for this project — halting at the operator gate (no repo created)');
	}
	checks.push(check('consent', true, 'repo_create_preauthorized is recorded for this project'));

	// (b) TOKEN — the deterministic confirm token must match the one derived for THIS (project, name,
	// owner). A missing/forged/foreign token fails CLOSED — no create. We compute the expected token and
	// compare (constant work over short hex; equality is sufficient — both are deterministic sha256 hex).
	const expected = repoCreateConfirmToken({ projectId: input.projectId, name: input.name, owner: input.owner });
	if (typeof input.confirmToken !== 'string' || input.confirmToken !== expected) {
		checks.push(check('token', false, 'confirm token missing or does not match the repo-create token for this project/name/owner'));
		return halt('token', 'the repo-create confirm token is missing or invalid — halting (fail closed, no repo created)');
	}
	checks.push(check('token', true, 'confirm token valid for this project/name/owner'));

	// The project must exist + expose its root (the git cwd for the remote/push) — a missing project or
	// an empty root is a hard, named stop (we will not run git in the wrong cwd).
	const project = await getProject(input.db, input.projectId).catch(() => null);
	if (!project) {
		checks.push(check('auth', false, 'project not found'));
		return halt('auth', 'the project row could not be read — halting (no repo created)');
	}
	const cwd = (project.root_path ?? '').trim();
	if (!cwd) {
		checks.push(check('auth', false, 'project root_path is missing/empty — refusing to run git in the dashboard cwd'));
		return halt('auth', 'the project root_path is missing — halting (cannot back the repo safely, no repo created)');
	}

	const client = input.client ?? new GitHubCliClient();

	// (c) AUTH — gh installed AND authenticated. createRepo prechecks this too, but checking here lets us
	// halt with a dedicated 'auth' stage BEFORE the private-first/create stages (clearer failedAt).
	const auth = await client.isAuthenticated(cwd).catch(() => ({ ok: false, reason: 'auth probe failed' }));
	if (!auth.ok) {
		checks.push(check('auth', false, auth.reason ?? 'GitHub CLI is not authenticated'));
		return halt('auth', `GitHub is not authenticated (${auth.reason ?? 'gh auth status failed'}) — halting (no repo created)`);
	}
	checks.push(check('auth', true, 'gh is installed and authenticated'));

	// (d) PRIVATE — re-assert private-first at the gate (defense-in-depth). RC-1 makes public
	// unrepresentable; this refuses any caller that explicitly asks for public.
	if (input.requestedPublic === true) {
		checks.push(check('private', false, 'a public repo was requested — refused (private-first is non-negotiable)'));
		return halt('private', 'public repos are never created here (private-first) — halting (no repo created)');
	}
	checks.push(check('private', true, 'private-first asserted (--private is hardcoded in the create path)'));

	// (e) CREATE — RC-1 createRepo (PRIVATE). A client without createRepo is a hard, named stop (the
	// gated driver requires a creating client). Honest named outcomes; an unexpected throw → red 'create'.
	if (typeof client.createRepo !== 'function') {
		checks.push(check('create', false, 'the GitHub client cannot create repos (no createRepo)'));
		return halt('create', 'the configured GitHub client does not support repo creation — halting (no repo created)');
	}
	const createInput: CreateRepoInput = input.owner !== undefined ? { name: input.name, owner: input.owner } : { name: input.name };
	let outcome: CreateRepoOutcome;
	try {
		outcome = await client.createRepo(createInput, cwd);
	} catch (err) {
		checks.push(check('create', false, `createRepo threw: ${(err as Error).message}`));
		return halt('create', `creating the repo threw (${(err as Error).message}) — halting (no repo created)`);
	}

	// Map the createRepo outcome → either a halt (named) OR a resolved remote URL to back.
	let resolvedUrl: string | null = null;
	const alreadyExisted = outcome.kind === 'already-exists';
	if (outcome.kind === 'created') {
		// gh itself returned the URL of the repo IT JUST created — trustworthy, points at the right
		// remote by construction. No stale-origin risk here (the recorded repo_url is irrelevant).
		resolvedUrl = outcome.url;
		checks.push(check('create', true, `repo created (private): ${outcome.url}`));
	} else if (outcome.kind === 'already-exists') {
		// IDEMPOTENT: a prior run (or an operator) already created it — NOT a failure. We still back the
		// remote + record repo_url below. BUT we MUST NOT trust a recorded `project.repo_url` blindly: a
		// scanner-seeded STALE origin (registry.ts) could point at an UNRELATED existing remote, and
		// pushing this project's commits there would be the worst-case outward action (RC-2 finding #1).
		// So we DERIVE the canonical URL from the resolved owner/slug and trust a recorded repo_url ONLY
		// when it matches that exact slug. We also RESOLVE the owner (finding #3) so an owner-less input
		// never synthesizes a malformed `https://github.com/<name>` (no owner) URL.
		let owner = input.owner;
		if (owner === undefined && typeof client.resolveOwner === 'function') {
			owner = (await client.resolveOwner(cwd).catch(() => null)) ?? undefined;
		}
		if (owner === undefined) {
			// Cannot build a well-formed owner/name URL and cannot verify any recorded URL — fail closed
			// rather than synthesize a malformed (owner-less) URL or trust an unverifiable recorded one.
			checks.push(
				check(
					'create',
					false,
					'repo already exists but the owner could not be resolved (gh) — refusing to derive or trust a remote URL (no push)'
				)
			);
			return halt(
				'create',
				'the repo already exists but its owner could not be resolved — halting (cannot back a well-formed remote safely, no push)'
			);
		}
		const canonical = `https://github.com/${owner}/${input.name}`;
		const recorded = (project.repo_url ?? '').trim();
		if (recorded && !sameRepoTarget(recorded, owner, input.name)) {
			// STALE-ORIGIN GUARD (the load-bearing one): the recorded repo_url points somewhere OTHER than
			// the repo we just confirmed exists. Pushing there would send commits to the wrong remote AND
			// falsely report created:true. Fail closed with a named reason — NEVER push to a mismatched remote.
			checks.push(
				check(
					'create',
					false,
					`recorded repo_url (${tail(recorded, 120)}) does not match the repo being created (${owner}/${input.name}) — refusing to push to a mismatched remote`
				)
			);
			return halt(
				'create',
				`the recorded repo URL points at a different remote than ${owner}/${input.name} — halting (stale-origin guard, no push)`
			);
		}
		resolvedUrl = canonical;
		checks.push(check('create', true, `repo already exists (idempotent no-op): ${resolvedUrl}`));
	} else if (outcome.kind === 'unauthed') {
		checks.push(check('create', false, `gh not authenticated: ${outcome.reason}`));
		return halt('create', `GitHub is not authenticated (${outcome.reason}) — halting (no repo created)`);
	} else if (outcome.kind === 'permission-denied') {
		checks.push(check('create', false, `permission denied: ${outcome.reason}`));
		return halt('create', `not permitted to create the repo (${outcome.reason}) — halting (no repo created)`);
	} else {
		checks.push(check('create', false, `repo create failed: ${tail(outcome.reason)}`));
		return halt('create', `the repo could not be created: ${tail(outcome.reason)} — halting (no repo created)`);
	}

	if (!resolvedUrl) {
		// Should be unreachable (created/already-exists both set a url) — fail closed honestly rather than push to ''.
		checks.push(check('create', false, 'no remote URL resolved from the create outcome'));
		return halt('create', 'the create succeeded but no remote URL was resolved — halting (no push)');
	}

	// (f) REMOTE — back the existing local scaffold commits via the DEDICATED OUTWARD runner. This is the
	// sanctioned remote/push seam; it NEVER routes through assertLocalGit. Idempotent: an already-set
	// `origin` is absorbed (git remote add exits non-zero on a dup — we detect and proceed to push).
	const gitRunner = input.gitRunner ?? execFileRunner;
	const branch = (input.branch ?? '').trim() || 'main';
	// (f-pre) BRANCH — validate the push branch (RC-2 finding #2). `branch` is the one push arg that was
	// previously unvalidated; a `-`-prefixed value could be misparsed by git as a flag (D-008 class). A
	// malformed branch is a named red at 'remote' BEFORE any outward git runs (backRemote ALSO `--`-guards
	// it as defense-in-depth, but rejecting here gives the honest reason + never lets it reach git).
	try {
		assertBranchName(branch);
	} catch (err) {
		checks.push(check('remote', false, `invalid push branch: ${(err as Error).message}`));
		return halt('remote', `the push branch is invalid (${(err as Error).message}) — halting (no push)`);
	}
	const remoteResult = await backRemote(gitRunner, cwd, resolvedUrl, branch, alreadyExisted);
	if (!remoteResult.ok) {
		checks.push(check('remote', false, remoteResult.detail));
		return halt('remote', `backing the repo with the local commits failed: ${remoteResult.detail} — halting (repo exists but unbacked)`);
	}
	checks.push(check('remote', true, remoteResult.detail));

	// (g) URL — record the resolved remote URL to project.repo_url (normalized in repo.ts; F-013). This is
	// the ONLY place repo_url is written by this gate, and ONLY on real success. Idempotent: a re-run
	// writes the same value. A write failure is a named red (the repo IS backed, but the row didn't update).
	try {
		await updateProject(input.db, input.projectId, { repo_url: resolvedUrl });
	} catch (err) {
		checks.push(check('url', false, `recording repo_url failed: ${(err as Error).message}`));
		return halt('url', `the repo is created + pushed but recording its URL failed (${(err as Error).message}) — re-run to reconcile`);
	}
	checks.push(check('url', true, `project.repo_url set to ${resolvedUrl}`));

	return {
		created: true,
		checks,
		failedAt: null,
		summary: alreadyExisted
			? `repo already existed — backed local commits + recorded ${resolvedUrl} (idempotent)`
			: `repo created PRIVATE — backed local commits + recorded ${resolvedUrl}`,
		repoUrl: resolvedUrl,
		createOutcome: outcome.kind
	};
}

/**
 * The DEDICATED OUTWARD git seam: `git remote add origin <url>` then `git push -u origin <branch>`.
 * SEPARATE from post-task's assertLocalGit (which refuses remote/push) — this is the sanctioned
 * exception, gated by the caller. Array-args, no shell (D-008): the url + branch are inert argv.
 *
 * IDEMPOTENT (interrupt contract): `git remote add` of an already-set `origin` exits non-zero
 * ("remote origin already exists") — we ABSORB that and proceed to push (the push is the durable,
 * re-runnable step). A genuine push failure (no upstream, rejected) is a NAMED red, never silent.
 */
async function backRemote(
	run: CommandRunner,
	cwd: string,
	url: string,
	branch: string,
	repoAlreadyExisted: boolean
): Promise<{ ok: boolean; detail: string }> {
	// remote add — absorb an existing-origin non-zero exit (idempotent re-run), surface other failures.
	let addNote = 'origin added';
	try {
		const add = await run('git', ['remote', 'add', 'origin', url], { cwd });
		if (add.code !== 0) {
			const text = (add.stderr || add.stdout).trim();
			if (/already exists/i.test(text)) {
				addNote = 'origin already set (idempotent no-op)';
			} else {
				return { ok: false, detail: `git remote add origin failed (exit ${add.code}): ${tail(text) || 'no output'}` };
			}
		}
	} catch (err) {
		return { ok: false, detail: `git remote add could not run: ${(err as Error).message}` };
	}

	// push -u origin -- <branch> — the durable, re-runnable step. The `--` separator means git can NEVER
	// read <branch> as a flag even if it somehow began with `-` (RC-2 finding #2; the gate already
	// validated it via assertBranchName — this is belt-and-suspenders, D-008 class). A re-push of an
	// up-to-date branch exits 0 ("Everything up-to-date"); a genuine rejection is a named red.
	try {
		const push = await run('git', ['push', '-u', 'origin', '--', branch], { cwd });
		if (push.code !== 0) {
			const text = (push.stderr || push.stdout).trim();
			return { ok: false, detail: `git push -u origin ${branch} failed (exit ${push.code}): ${tail(text) || 'no output'}` };
		}
	} catch (err) {
		return { ok: false, detail: `git push could not run: ${(err as Error).message}` };
	}

	const existedNote = repoAlreadyExisted ? ' (repo pre-existed)' : '';
	return { ok: true, detail: `${addNote}; pushed ${branch} to origin${existedNote}` };
}

/**
 * RC-2 finding #1 — does a recorded `project.repo_url` actually point at the `owner/name` repo being
 * created? Used by the stale-origin guard: we only trust (and push to) a recorded URL when it resolves
 * to the SAME owner/name; a mismatch means the recorded remote is stale/unrelated and we must NOT push
 * there. We parse the owner/name out of the common GitHub remote forms (https, git+ssh, scp-style
 * `git@github.com:owner/name`), strip a trailing `.git`, and compare case-insensitively (GitHub
 * owners/names are case-insensitive). Anything unparseable → NOT a match (fail closed).
 */
export function sameRepoTarget(recorded: string, owner: string, name: string): boolean {
	const parsed = parseRepoTarget(recorded);
	if (!parsed) return false;
	return parsed.owner.toLowerCase() === owner.toLowerCase() && parsed.name.toLowerCase() === name.toLowerCase();
}

/** Extract `{owner,name}` from a GitHub remote URL/slug, or null if it isn't a recognizable GitHub remote. */
function parseRepoTarget(url: string): { owner: string; name: string } | null {
	const trimmed = url.trim();
	if (!trimmed) return null;
	// https://github.com/owner/name(.git)?  |  ssh://git@github.com/owner/name(.git)?
	const httpish = trimmed.match(/^(?:https?|ssh|git):\/\/[^/]*github\.com\/([^/]+)\/([^/?#]+?)(?:\.git)?\/?(?:[?#].*)?$/i);
	if (httpish) return { owner: httpish[1], name: httpish[2] };
	// scp-style: git@github.com:owner/name(.git)?
	const scp = trimmed.match(/^[^@]+@github\.com:([^/]+)\/([^/?#]+?)(?:\.git)?\/?$/i);
	if (scp) return { owner: scp[1], name: scp[2] };
	return null;
}
