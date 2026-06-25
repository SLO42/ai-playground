// RC-4 VERIFY — the operator-facing repo-creation surface on /projects/[id].
//
// Two layers (mirrors autonomous-control.test.ts's split):
//   • DATA — _projectRepoBriefCard, the load's projection of the OPEN PM-proposed repo_create brief
//     into the operator card, exercised against a REAL throwaway SurrealDB (the gh seam + git runner
//     are STUBBED — NO real network, NO real repo). Round-trips the actual load path:
//     proposeRepoCreate → getOpenBriefForArtifact → _projectRepoBriefCard. Shadow paths: a brief with a
//     missing/garbled target payload yields null name/owner (the card still renders the ask), never a
//     throw; the authenticated-user owner sentinel maps to null owner.
//   • SOURCE — a static guard over +page.svelte so a refactor cannot silently drop a safety affordance:
//     the create is ALWAYS private (copy + the gated action), the four honest states render, the
//     PM-brief approve carries operatorConfirmed:true (the B4 wall), and the create is two-step gated.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Db } from '$lib/server/db/client';
import { runMigrations } from '$lib/server/db/migrate';
import { schemaMigrations } from '$lib/server/db/schema';
import { startTestDb, type TestDb } from '$lib/server/db/testserver';
import { createProject } from '$lib/server/projects/repo';
import { createPm } from '$lib/server/projects/pm-repo';
import { proposeRepoCreate } from '$lib/server/projects/repo-create-proposal';
import { getOpenBriefForArtifact, type DecisionBriefRow } from '$lib/server/projects/briefs';
import { _projectRepoBriefCard } from './+page.server';

// ── DATA LAYER (real SurrealDB) ─────────────────────────────────────────────────────────
let tdb: TestDb;
let db: Db;
let seq = 0;

beforeAll(async () => {
	tdb = await startTestDb();
	db = await Db.connect({
		url: tdb.wsUrl,
		username: tdb.root.username,
		password: tdb.root.password,
		namespace: tdb.namespace,
		database: tdb.database
	});
	await runMigrations(db, schemaMigrations);
}, 90_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

async function freshProject() {
	return createProject(db, { slug: `rcui${++seq}`, name: 'Repo Host', root_path: 'F:/code/whatever' });
}

describe('RC-4 load projection — the open repo_create brief → operator card', () => {
	it('an open PM-proposed brief projects to a card carrying the recommended PRIVATE target', async () => {
		const p = await freshProject();
		await createPm(db, { project: p.id, name: 'Vesper' }); // default authority 'act'
		await proposeRepoCreate(db, { project: p.id, name: 'repo-host', owner: 'me', rationale: 'needs a remote' });

		const brief = await getOpenBriefForArtifact(db, p.id);
		expect(brief?.artifact_kind).toBe('repo_create');

		const card = _projectRepoBriefCard(brief!);
		expect(card.id).toBe(brief!.id);
		expect(card.name).toBe('repo-host'); // recovered from challenge.cost_if_wrong = "repo:repo-host"
		expect(card.owner).toBe('me'); // recovered from challenge.context_we_might_be_missing = "owner=me"
		expect(card.ask).toMatch(/private GitHub repo/i);
		expect(card.evidence.length).toBeGreaterThan(0); // real rows (project + PM) — F-008, never fabricated
	});

	it('a proposal WITHOUT an explicit owner projects to a null owner (the authenticated-user sentinel)', async () => {
		const p = await freshProject();
		await createPm(db, { project: p.id, name: 'Vesper' });
		await proposeRepoCreate(db, { project: p.id, name: 'solo-repo' });

		const brief = await getOpenBriefForArtifact(db, p.id);
		const card = _projectRepoBriefCard(brief!);
		expect(card.name).toBe('solo-repo');
		expect(card.owner).toBeNull(); // "(authenticated user)" sentinel → null, not a fabricated owner
	});
});

describe('RC-4 projection shadow paths — a garbled payload never throws (F-008)', () => {
	// A brief whose stowed payload is absent/malformed must still render its ask honestly with
	// null name/owner — never a thrown loader, never a guessed repo name.
	function briefWith(challenge: Partial<DecisionBriefRow['challenge']>): DecisionBriefRow {
		return {
			id: 'decision_brief:x',
			project: 'project:p',
			artifact: 'project:p',
			artifact_kind: 'repo_create',
			classification: 'confirm',
			ask: 'Create a private GitHub repo?',
			issue: 'the PM recommends a private repo',
			completeness: null,
			effort: { apply: '—', wrongness: '—' },
			evidence: ['project:p'],
			falsifier: '—',
			options: [],
			challenge: challenge as DecisionBriefRow['challenge'],
			status: 'open',
			defer_until: null,
			decided_at: null,
			created_at: null
		};
	}

	it('an absent challenge payload → null name/owner, ask preserved (nil-input shadow path)', () => {
		const card = _projectRepoBriefCard(briefWith({}));
		expect(card.name).toBeNull();
		expect(card.owner).toBeNull();
		expect(card.ask).toBe('Create a private GitHub repo?');
	});

	it('a malformed cost_if_wrong (no "repo:" prefix) → null name, never a guess', () => {
		const card = _projectRepoBriefCard(briefWith({ cost_if_wrong: 'not-a-repo-target' }));
		expect(card.name).toBeNull();
	});

	it('an empty owner= value → null owner (empty-input shadow path)', () => {
		const card = _projectRepoBriefCard(
			briefWith({ cost_if_wrong: 'repo:r', context_we_might_be_missing: 'owner=' })
		);
		expect(card.name).toBe('r');
		expect(card.owner).toBeNull();
	});
});

// ── SOURCE LAYER (static guard over +page.svelte) ────────────────────────────────────────
const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(HERE, '+page.svelte'), 'utf8');

describe('RC-4 repo-creation surface — wiring & integrity (static source guard)', () => {
	it('drives the EXISTING RC-3 action, never a new authority (?/repoCreate + POST /api/briefs)', () => {
		expect(src).toMatch(/action="\?\/repoCreate"/);
		// The PM-brief approve/reject routes through the operator-gated decide endpoint, not a new path.
		expect(src).toMatch(/fetch\('\/api\/briefs'/);
	});

	it('the copy makes explicit the create is ALWAYS PRIVATE (private-first, RC-1)', () => {
		expect(src).toMatch(/always creates a PRIVATE repository/i);
		expect(src).toMatch(/Create repo \(private\)/i);
	});

	it('renders the four honest states — created (real repo_url) / no-repo / creating / named failure', () => {
		// created: the live repo_url link (never fabricated).
		expect(src).toMatch(/\{#if project\.repo_url\}/);
		expect(src).toMatch(/href=\{project\.repo_url\}/);
		// creating: the busy label on the gated submit.
		expect(src).toMatch(/repoBusy \? 'Creating…'/);
		// created via the action result: shows the gate's repoUrl.
		expect(src).toMatch(/repoFeedback\.created/);
		expect(src).toMatch(/repoFeedback\.repoUrl/);
		// named failure: the gate's honest summary + failedAt stage (never dressed as success).
		expect(src).toMatch(/repoFeedback\.summary/);
		expect(src).toMatch(/repoFeedback\.failedAt/);
	});

	it('the create is TWO-STEP gated (arm → confirm), not a one-click outward act', () => {
		expect(src).toMatch(/repoConfirming/);
		// Step 1 arms (type="button"); step 2 is the real submit.
		expect(src).toMatch(/onclick=\{\(\) => \(repoConfirming = true\)\}/);
		expect(src).toMatch(/Confirm — create private repo/);
	});

	it('the PM-brief APPROVE carries operatorConfirmed:true (the B4 integrity wall)', () => {
		expect(src).toMatch(/operatorConfirmed: true/);
		// reject does NOT carry the confirm (it never drives the gate).
		expect(src).toMatch(/decideRepoBrief\(repoBrief!\.id, 'reject'\)/);
	});

	it('a11y — labelled inputs + alert-roled honest failures + focus-visible repo link', () => {
		expect(src).toMatch(/<span class="field-label">Repository name<\/span>/);
		expect(src).toMatch(/role="alert"/);
		// The repo link gets a visible focus ring (no outline:none).
		expect(src).toMatch(/\.repo-url:focus-visible/);
	});

	it('never renders a token — only the server-derived confirm copy (D-026)', () => {
		expect(src).toMatch(/confirm token is derived\s+server-side/i);
		expect(src).not.toMatch(/GH_TOKEN/);
	});
});
