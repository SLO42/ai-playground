import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createRole, createGauntletFixture, createGauntletKey } from '../workforce/repo';
import { newSentinelUlid } from '../workforce/activation';
import {
	generateCreationProposal,
	validateProposal,
	computeConfirmToken,
	assertProposalFresh,
	briefHintsFromTemplate,
	ProposalContractError,
	SecretEchoError,
	StaleProposalError,
	ProposalPathError,
	SycophancyError,
	type CreateBrief,
	type CreationProposal,
	type ProposalGenerator
} from './plan';
import { getTemplate, type ProjectTemplate } from './templates';

// Fake credential literals ASSEMBLED AT RUNTIME — the source text never contains a contiguous
// provider-token pattern, so GitHub secret-scanning push-protection won't flag these test fixtures;
// the runtime value is full-format so the screen()/prefix detectors under test still fire.
const GLPAT = 'gl' + 'pat-' + 'AbCdEf0123456789XyZw';
const GLPAT2 = 'gl' + 'pat-' + 'AbCdEfGhIjKlMnOpQrSt';
const GHP = 'gh' + 'p_' + 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789';
const GHP2 = 'gh' + 'p_' + 'AbCdEf0123456789XyZwAbCdEf0123456789';

// CA-1 (CREATE-SPEC §2.1-2.3, §3) — the generative PLAN half. Run against a REAL throwaway
// SurrealDB (the only DB touch is listDefectClassVocabulary, exercised live), with a STUBBED
// generator for the agent leg (no creds/network/spend — mirrors launchSession's scripted backend).

let tdb: TestDb;
let db: Db;

/** Seed ONE operator-confirmed defect class into the vocabulary, returning its name. */
async function seedDefectClass(cls: string): Promise<void> {
	const role = await createRole(db, { slug: `ca1-${cls}`, name: `Role ${cls}`, purpose: 'CA-1 vocab seed' });
	const fixture = await createGauntletFixture(db, {
		role: role.id,
		slug: `ca1-fx-${cls}`,
		kind: 'planted_defect',
		work: { 'a.ts': 'l1\nl2\nx();\n' },
		sentinel: newSentinelUlid()
	});
	await createGauntletKey(db, {
		fixture: fixture.id,
		author: 'operator',
		plants: [{ id: 'p1', class: cls, detection: { file: 'a.ts', lines: [3, 3] } }]
	});
}

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
	await seedDefectClass('null-deref');
}, 90_000);

afterAll(async () => {
	await db?.close().catch(() => {});
	await tdb?.teardown();
});

const BRIEF: CreateBrief = {
	name: 'rounds-mod',
	description: 'A ROUNDS mod that adds a survival difficulty curve.',
	hints: { ecosystem: 'node', targetPlatform: 'desktop' }
};

/** A well-formed raw proposal (the agent's structured output) for the happy path. */
function goodRaw(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		dirLayout: ['src/', 'src/index.ts', 'tests/'],
		stack: ['TypeScript', 'Node'],
		planMacro: {
			purpose: 'Add a survival difficulty curve to ROUNDS.',
			vision: 'A mod players reach for when the base game feels flat.',
			role: 'Solo maintainer with periodic playtests.',
			definition_of_done: 'Mod loads, curve is configurable, no crash across 10 rounds.'
		},
		foundingTasks: [
			{ objective: 'Scaffold the mod loader', purpose: 'Nothing ships until the mod loads in-game.' },
			{ objective: 'Implement the difficulty curve', purpose: 'The curve is the whole point of the mod.' },
			{ objective: 'Add a config surface', purpose: 'Players tune the curve without code edits.' }
		],
		targetDrafts: [{ kind: 'publish', adapterId: 'thunderstore', config: { tokenEnv: 'THUNDERSTORE_TOKEN' } }],
		capabilityNeeds: { languages: ['typescript'], frameworks: [], defect_classes: ['null-deref'] },
		clarifiers: [
			{
				question: 'Single package or split core/UI?',
				position: 'A single package will hold unless you expect independent release cadences.',
				falsifier: 'Evidence of separate UI release timelines would justify a split.'
			}
		],
		...over
	};
}

const stubGen = (raw: unknown): ProposalGenerator => async () => raw;

describe('generateCreationProposal — happy path', () => {
	it('validates the agent output and mints a stable confirmToken (no disk/DB write)', async () => {
		const env = await generateCreationProposal(db, BRIEF, stubGen(goodRaw()));
		expect(env.brief).toEqual(BRIEF);
		expect(env.proposal.foundingTasks.length).toBe(3);
		expect(env.proposal.capabilityNeeds.defect_classes).toEqual(['null-deref']);
		expect(env.confirmToken).toMatch(/^[0-9a-f]{64}$/);
		// token is deterministic over {brief, proposal}.
		expect(computeConfirmToken(env.brief, env.proposal)).toBe(env.confirmToken);
	});
});

describe('shadow paths — the agent leg returns bad/edge output', () => {
	it('nil agent output → ProposalContractError (named)', async () => {
		await expect(generateCreationProposal(db, BRIEF, stubGen(null))).rejects.toBeInstanceOf(
			ProposalContractError
		);
	});
	it('empty object → ProposalContractError on the first missing field', async () => {
		await expect(generateCreationProposal(db, BRIEF, stubGen({}))).rejects.toBeInstanceOf(
			ProposalContractError
		);
	});
	it('upstream agent error propagates UNSWALLOWED (never silence-as-success)', async () => {
		const boom: ProposalGenerator = async () => {
			throw new Error('runtime timeout');
		};
		await expect(generateCreationProposal(db, BRIEF, boom)).rejects.toThrow('runtime timeout');
	});
	it('nil brief field → ProposalContractError before the agent runs', async () => {
		const bad = { ...BRIEF, name: '' };
		await expect(generateCreationProposal(db, bad, stubGen(goodRaw()))).rejects.toBeInstanceOf(
			ProposalContractError
		);
	});
});

describe('founding-task count (fork 4: 3-7 milestone-level)', () => {
	it('rejects fewer than 3', async () => {
		const raw = goodRaw({ foundingTasks: [{ objective: 'x', purpose: 'y' }] });
		await expect(validateProposal(db, raw)).rejects.toBeInstanceOf(ProposalContractError);
	});
	it('rejects more than 7', async () => {
		const tasks = Array.from({ length: 8 }, (_, i) => ({ objective: `o${i}`, purpose: `p${i}` }));
		await expect(validateProposal(db, goodRaw({ foundingTasks: tasks }))).rejects.toBeInstanceOf(
			ProposalContractError
		);
	});
	it('rejects a task missing its purpose (D-039 — never born purposeless)', async () => {
		const raw = goodRaw({
			foundingTasks: [
				{ objective: 'a', purpose: 'p' },
				{ objective: 'b', purpose: 'p' },
				{ objective: 'c' } // no purpose
			]
		});
		await expect(validateProposal(db, raw)).rejects.toBeInstanceOf(ProposalContractError);
	});
});

describe('clarifier count (G4: 0-4, must-not-interrogate)', () => {
	it('allows zero (a brief that does not fork)', async () => {
		const p = await validateProposal(db, goodRaw({ clarifiers: [] }));
		expect(p.clarifiers).toEqual([]);
	});
	it('rejects more than 4', async () => {
		const five = Array.from({ length: 5 }, (_, i) => ({
			question: `q${i}`,
			position: `pos${i}`,
			falsifier: `f${i}`
		}));
		await expect(validateProposal(db, goodRaw({ clarifiers: five }))).rejects.toBeInstanceOf(
			ProposalContractError
		);
	});
	it('rejects a clarifier missing its falsifier (§3 — every position has one)', async () => {
		const raw = goodRaw({ clarifiers: [{ question: 'q', position: 'p' }] });
		await expect(validateProposal(db, raw)).rejects.toBeInstanceOf(ProposalContractError);
	});
});

describe('anti-sycophancy enforcement (§3, redTeam)', () => {
	it('rejects a banned phrase anywhere in agent-authored text', async () => {
		const raw = goodRaw({
			planMacro: {
				purpose: 'That could work as a purpose.',
				vision: 'v',
				role: 'r',
				definition_of_done: 'd'
			}
		});
		await expect(validateProposal(db, raw)).rejects.toBeInstanceOf(SycophancyError);
	});
	it('rejects a hedge inside a clarifier position', async () => {
		const raw = goodRaw({
			clarifiers: [
				{
					question: 'q',
					position: 'There are many ways to think about this.',
					falsifier: 'f'
				}
			]
		});
		await expect(validateProposal(db, raw)).rejects.toBeInstanceOf(SycophancyError);
	});
	// Regression (review gap 1): the §3 rail must cover EVERY agent-authored string, including the
	// stack[] and dirLayout[] arrays — a banned hedge there previously reached the operator unflagged.
	it('rejects a banned phrase inside a stack[] entry (regression: was uncovered)', async () => {
		const raw = goodRaw({ stack: ['That could work', 'Node'] });
		await expect(validateProposal(db, raw)).rejects.toBeInstanceOf(SycophancyError);
	});
	it('rejects a banned phrase inside a dirLayout[] entry (regression: was uncovered)', async () => {
		const raw = goodRaw({ dirLayout: ['src/', 'You might want to consider this dir'] });
		await expect(validateProposal(db, raw)).rejects.toBeInstanceOf(SycophancyError);
	});
});

describe('D-026 no-secret-echo in target configs (redTeam)', () => {
	it('rejects a literal secret value in a target config', async () => {
		const raw = goodRaw({
			targetDrafts: [
				{ kind: 'deploy', adapterId: 'vercel', config: { token: GHP } }
			]
		});
		await expect(validateProposal(db, raw)).rejects.toBeInstanceOf(SecretEchoError);
	});
	it('accepts an env NAME reference in a target config', async () => {
		const p = await validateProposal(
			db,
			goodRaw({ targetDrafts: [{ kind: 'deploy', adapterId: 'vercel', config: { tokenEnv: 'VERCEL_TOKEN' } }] })
		);
		expect(p.targetDrafts[0].config).toEqual({ tokenEnv: 'VERCEL_TOKEN' });
	});
});

// A stray/invalid targetDraft must NOT nuke an entire real-spend proposal — targetDrafts are the
// lowest-stakes, OPTIONAL, operator-confirmed field. Drop invalid entries, keep valid ones. (The
// live trigger: the agent emitted kind:'agent' and the whole ~2-min proposal hard-failed.)
describe('targetDrafts resilience — drop invalid entries, keep valid (do not waste a generation)', () => {
	it('drops an invalid-kind entry (e.g. "agent") instead of throwing, keeping the valid one', async () => {
		const p = await validateProposal(
			db,
			goodRaw({
				targetDrafts: [
					{ kind: 'agent', adapterId: 'whatever', config: {} },
					{ kind: 'publish', adapterId: 'thunderstore', config: { tokenEnv: 'THUNDERSTORE_TOKEN' } }
				]
			})
		);
		expect(p.targetDrafts).toHaveLength(1);
		expect(p.targetDrafts[0]).toEqual({ kind: 'publish', adapterId: 'thunderstore', config: { tokenEnv: 'THUNDERSTORE_TOKEN' } });
	});
	it('drops a non-object / id-less entry rather than failing the proposal', async () => {
		const p = await validateProposal(
			db,
			goodRaw({ targetDrafts: ['nonsense', { kind: 'deploy', config: {} }, { kind: 'sync', adapterId: 'gh', config: {} }] })
		);
		expect(p.targetDrafts).toEqual([{ kind: 'sync', adapterId: 'gh', config: {} }]);
	});
	it('an all-invalid targetDrafts becomes an empty array (still a valid proposal, F-008)', async () => {
		const p = await validateProposal(db, goodRaw({ targetDrafts: [{ kind: 'agent', adapterId: 'x', config: {} }] }));
		expect(p.targetDrafts).toEqual([]);
	});
});

// CA-H1 — close the CA-1 red-team DEFERRED secret-echo gaps. The isolation screen() misses a literal
// value when it is the WHOLE config value (no inline `key=value`) — these enforce the ENV-NAME-POSITIVE
// rule at the proposal trust boundary instead. redTeam:true.
describe('CA-H1 — ENV-NAME-POSITIVE secret-echo at the trust boundary (redTeam)', () => {
	it('rejects a bare password assigned to a secret-like key (screen() missed it in isolation)', async () => {
		const raw = goodRaw({
			targetDrafts: [{ kind: 'deploy', adapterId: 'vercel', config: { password: 's3cr3tP@ssw0rd' } }]
		});
		await expect(validateProposal(db, raw)).rejects.toBeInstanceOf(SecretEchoError);
	});
	it('rejects a no-prefix DB password under a secret-like key (was clean in isolation)', async () => {
		const raw = goodRaw({
			targetDrafts: [{ kind: 'deploy', adapterId: 'fly', config: { dbPassword: 'hunter2hunter2' } }]
		});
		await expect(validateProposal(db, raw)).rejects.toBeInstanceOf(SecretEchoError);
	});
	it('rejects a glpat- GitLab token even under an innocuous key (prefix gate)', async () => {
		const raw = goodRaw({
			targetDrafts: [{ kind: 'deploy', adapterId: 'gitlab', config: { note: GLPAT2 } }]
		});
		await expect(validateProposal(db, raw)).rejects.toBeInstanceOf(SecretEchoError);
	});
	it('rejects a high-entropy literal token assigned to a secret-like key', async () => {
		const raw = goodRaw({
			targetDrafts: [{ kind: 'deploy', adapterId: 'x', config: { apiKey: 'aZ9bY8cX7dW6eV5fU4gT3hS2' } }]
		});
		await expect(validateProposal(db, raw)).rejects.toBeInstanceOf(SecretEchoError);
	});
	it('rejects a literal secret echoed in a stack[] entry (was unscreened)', async () => {
		const raw = goodRaw({ stack: ['Node', GLPAT2] });
		await expect(validateProposal(db, raw)).rejects.toBeInstanceOf(SecretEchoError);
	});
	it('rejects a literal secret echoed in a dirLayout[] entry (was unscreened)', async () => {
		const raw = goodRaw({ dirLayout: ['src/', 'config/' + GHP] });
		await expect(validateProposal(db, raw)).rejects.toBeInstanceOf(SecretEchoError);
	});
	it('ACCEPTS a ${ENV_NAME} placeholder under a secret-like key', async () => {
		const p = await validateProposal(
			db,
			goodRaw({ targetDrafts: [{ kind: 'deploy', adapterId: 'vercel', config: { password: '${DB_PASSWORD}' } }] })
		);
		expect(p.targetDrafts[0].config).toEqual({ password: '${DB_PASSWORD}' });
	});
	it('ACCEPTS a $ENV_NAME and a process.env.X reference under a secret-like key', async () => {
		const p = await validateProposal(
			db,
			goodRaw({
				targetDrafts: [
					{ kind: 'deploy', adapterId: 'fly', config: { dbPassword: '$DATABASE_PASSWORD', apiKey: 'process.env.API_KEY' } }
				]
			})
		);
		expect(p.targetDrafts[0].config).toEqual({ dbPassword: '$DATABASE_PASSWORD', apiKey: 'process.env.API_KEY' });
	});
	it('ACCEPTS an empty value under a secret-like key (echoes no secret)', async () => {
		const p = await validateProposal(
			db,
			goodRaw({ targetDrafts: [{ kind: 'deploy', adapterId: 'fly', config: { apiKey: '' } }] })
		);
		expect(p.targetDrafts[0].config).toEqual({ apiKey: '' });
	});
	// CA-H1 review GAP-1 (root-cause closure): a BARE token is no longer read as an env-name reference.
	it('REJECTS a bare UPPER_SNAKE token under a secret-like key (must be an explicit ${ENV} reference)', async () => {
		const raw = goodRaw({
			targetDrafts: [{ kind: 'deploy', adapterId: 'fly', config: { dbPassword: 'DATABASE_PASSWORD' } }]
		});
		await expect(validateProposal(db, raw)).rejects.toBeInstanceOf(SecretEchoError);
	});
	it('REJECTS a SHORT high-entropy literal under a secret-like key (the GAP the prior fix missed)', async () => {
		// 12 + 16 + 15-char literals that previously classified as bare env names and passed both gates.
		for (const lit of ['X7K9QZ2MPLW4', 'A1B2C3D4E5F6G7H8', 'ZXCVBNMASDFGHJK']) {
			const raw = goodRaw({ targetDrafts: [{ kind: 'deploy', adapterId: 'x', config: { apiKey: lit } }] });
			await expect(validateProposal(db, raw)).rejects.toBeInstanceOf(SecretEchoError);
		}
	});
	// CA-H1 review GAP-2: agent-authored FREE-TEXT fields (macro / charter / tasks / clarifiers) are
	// now secret-screened too — a credential echoed there no longer reaches the operator/disk.
	it('REJECTS a literal credential echoed in the plan macro (Gap-2 free-text)', async () => {
		const raw = goodRaw({
			planMacro: {
				purpose: GLPAT,
				vision: 'A mod players reach for.',
				role: 'Solo maintainer.',
				definition_of_done: 'Loads + configurable.'
			}
		});
		await expect(validateProposal(db, raw)).rejects.toBeInstanceOf(SecretEchoError);
	});
	it('REJECTS a literal credential echoed in the PM charter draft (Gap-2 free-text)', async () => {
		const raw = goodRaw({ pmCharterDraft: GHP2 });
		await expect(validateProposal(db, raw)).rejects.toBeInstanceOf(SecretEchoError);
	});
	it('REJECTS a literal credential echoed in a founding task (Gap-2 free-text)', async () => {
		const raw = goodRaw({
			foundingTasks: [
				{ objective: GLPAT, purpose: 'Publishing needs auth.' },
				{ objective: 'Scaffold the loader', purpose: 'Nothing ships until it loads.' },
				{ objective: 'Add config', purpose: 'Players tune it.' }
			]
		});
		await expect(validateProposal(db, raw)).rejects.toBeInstanceOf(SecretEchoError);
	});
	it('does NOT trip on legitimate non-secret descriptive config (F-008 no over-redaction)', async () => {
		const p = await validateProposal(
			db,
			goodRaw({
				targetDrafts: [
					{ kind: 'deploy', adapterId: 'aws', config: { region: 'us-east-1', stage: 'production', tokenEnv: 'AWS_TOKEN' } }
				]
			})
		);
		expect(p.targetDrafts[0].config).toEqual({ region: 'us-east-1', stage: 'production', tokenEnv: 'AWS_TOKEN' });
	});
	// CA-H1 review GAP-1/GAP-2: the KEY-POSITIVE gate matched the secret word as a SUBSTRING, so
	// descriptive compound keys (authMethod/authProvider/authStrategy/tokenExpiry/passwordPolicy/
	// credentialType — head noun is NOT secret) were over-rejected, forcing legitimate non-secret
	// values to be env-name references and DESTROYING legit config (contradicts F-008). The head-noun
	// matcher must ACCEPT a plain descriptive value under these keys.
	it('ACCEPTS descriptive values under *-secret-substring keys (head noun not secret — F-008)', async () => {
		const config = {
			authMethod: 'oauth',
			authProvider: 'github',
			authStrategy: 'pkce',
			tokenExpiry: '3600',
			passwordPolicy: 'min-12-chars',
			credentialType: 'service-account'
		};
		const p = await validateProposal(db, goodRaw({ targetDrafts: [{ kind: 'deploy', adapterId: 'vercel', config }] }));
		expect(p.targetDrafts[0].config).toEqual(config);
	});
	it('still REJECTS a literal under a genuine secret HEAD key (dbPassword/clientSecret/accessToken/apiKey)', async () => {
		for (const config of [
			{ dbPassword: 's3cr3tP@ssw0rd' },
			{ clientSecret: 'literal-not-an-env-name' },
			{ accessToken: 'abc123literal' },
			{ apiKey: 'plainvalue' },
			{ access_key: 'plainvalue' },
			{ private_key: 'plainvalue' },
			{ dbPass: 'plainvalue' }
		]) {
			await expect(
				validateProposal(db, goodRaw({ targetDrafts: [{ kind: 'deploy', adapterId: 'x', config }] }))
			).rejects.toBeInstanceOf(SecretEchoError);
		}
	});
	it('does NOT flag a non-credential *Key head (sortKey/partitionKey — modifier-gated)', async () => {
		const config = { sortKey: 'created_at', partitionKey: 'tenant_id' };
		const p = await validateProposal(db, goodRaw({ targetDrafts: [{ kind: 'deploy', adapterId: 'dynamo', config }] }));
		expect(p.targetDrafts[0].config).toEqual(config);
	});
	// CA-H1 re-review GAP-1 (HIGH): a high-entropy ALL-CAPS literal with no underscore is byte-for-byte
	// a valid bare env-name token, so isEnvNameReference USED to accept it — passing Gate-2 under a
	// secret-like key AND short-circuiting the Gate-3 prefix/entropy backstop. Both directions covered.
	it('rejects a high-entropy ALL-CAPS literal under a secret-like key (env-ref must be env-NAME shaped)', async () => {
		for (const config of [
			{ apiKey: 'DGHJKLMNPQRSTUVWXYZ23456' }, // entropy 4.58, no underscore
			{ password: 'C0FFEE4DEADBEEF8BADF00D' } // hex secret, no underscore
		]) {
			await expect(
				validateProposal(db, goodRaw({ targetDrafts: [{ kind: 'deploy', adapterId: 'x', config }] }))
			).rejects.toBeInstanceOf(SecretEchoError);
		}
	});
	it('rejects a high-entropy ALL-CAPS literal even under an INNOCUOUS key (Gate-3 runs unconditionally)', async () => {
		const raw = goodRaw({
			targetDrafts: [{ kind: 'deploy', adapterId: 'x', config: { note: 'DGHJKLMNPQRSTUVWXYZ23456' } }]
		});
		await expect(validateProposal(db, raw)).rejects.toBeInstanceOf(SecretEchoError);
	});
	it('rejects a long underscore-free ALL-CAPS blob as a bare env name (must carry an underscore)', async () => {
		const raw = goodRaw({
			targetDrafts: [{ kind: 'deploy', adapterId: 'x', config: { token: 'ABCDEFGHIJKLMNOPQRSTUVWX' } }]
		});
		await expect(validateProposal(db, raw)).rejects.toBeInstanceOf(SecretEchoError);
	});
	// CA-H1 root-cause closure: a BARE token (even an obvious env name like GITHUB_TOKEN) is no longer
	// accepted under a secret-like key — a reference must be EXPLICIT (${GITHUB_TOKEN}). This is what
	// removes the short-high-entropy hole entirely (no bare-token shape can be misread as a reference).
	it('REJECTS a bare env-name-shaped token under a secret-like key (must be explicit ${ENV})', async () => {
		for (const config of [{ token: 'GITHUB_TOKEN' }, { apiKey: 'OPENAI' }, { password: 'PGPASSWORD' }]) {
			await expect(
				validateProposal(db, goodRaw({ targetDrafts: [{ kind: 'deploy', adapterId: 'x', config }] }))
			).rejects.toBeInstanceOf(SecretEchoError);
		}
	});

	// LIVE-BUG FIX (the create-with-email regression): a BENIGN, redactable span (an email, a home
	// path) in agent-authored PROSE is redactable PII, NOT a literal secret echo. Gate 1 in 'freetext'
	// mode lets it PASS the plan boundary (the value is kept; the scaffold-write screen redacts it at
	// the disk boundary). Previously this hard-rejected the whole proposal with a misleading
	// 'literal secret' error — the live bug.
	it('ACCEPTS a benign email in a free-text macro field (redactable PII is not a secret echo — Gate 1 freetext)', async () => {
		const p = await validateProposal(
			db,
			goodRaw({
				planMacro: {
					purpose: 'A ROUNDS support tool. Contact jane.doe@rounds.example for triage.',
					vision: 'A mod players reach for when the base game feels flat.',
					role: 'Solo maintainer with periodic playtests.',
					definition_of_done: 'Mod loads, curve is configurable, no crash across 10 rounds.'
				}
			})
		);
		// The value is KEPT verbatim at the plan boundary (no mutation); the disk-write gate redacts it.
		expect(p.planMacro.purpose).toContain('jane.doe@rounds.example');
	});
	it('ACCEPTS a benign email in a founding task purpose (free-text)', async () => {
		const p = await validateProposal(
			db,
			goodRaw({
				foundingTasks: [
					{ objective: 'Wire the support inbox', purpose: 'Route triage to ops@rounds.example.' },
					{ objective: 'Implement the curve', purpose: 'The curve is the whole point.' },
					{ objective: 'Add config', purpose: 'Players tune it.' }
				]
			})
		);
		expect(p.foundingTasks[0].purpose).toContain('ops@rounds.example');
	});
	// But an UN-REDACTABLE quarantined block (a private-key PEM) in free text still HARD-rejects at the
	// plan boundary (Gate 1 'freetext' rejects 'quarantined') — it cannot be safely written.
	it('REJECTS an un-redactable private-key block in a free-text macro field (quarantined — Gate 1 freetext)', async () => {
		const KEY =
			'-----BEGIN ' +
			'RSA PRIVATE KEY-----\nMIIBdeadbeefdeadbeefdeadbeef\n-----END ' +
			'RSA PRIVATE KEY-----';
		const raw = goodRaw({
			planMacro: {
				purpose: `Bootstrap with:\n${KEY}`,
				vision: 'A mod players reach for when the base game feels flat.',
				role: 'Solo maintainer.',
				definition_of_done: 'Loads + configurable.'
			}
		});
		await expect(validateProposal(db, raw)).rejects.toBeInstanceOf(SecretEchoError);
	});
});

// CA-H1 — D-018 path-confinement at the PLAN trust boundary: an absolute or `..`-traversal dirLayout
// entry is rejected BEFORE it can reach scaffold (ProposalPathError). redTeam:true.
describe('CA-H1 — D-018 dirLayout path-escape rejected at the trust boundary (redTeam)', () => {
	it('rejects a `../../` traversal dirLayout entry', async () => {
		const raw = goodRaw({ dirLayout: ['src/', '../../etc/passwd'] });
		await expect(validateProposal(db, raw)).rejects.toBeInstanceOf(ProposalPathError);
	});
	it('rejects a mid-path `..` segment', async () => {
		const raw = goodRaw({ dirLayout: ['src/', 'a/../../b'] });
		await expect(validateProposal(db, raw)).rejects.toBeInstanceOf(ProposalPathError);
	});
	it('rejects a POSIX-absolute dirLayout entry', async () => {
		const raw = goodRaw({ dirLayout: ['src/', '/etc/cron.d/evil'] });
		await expect(validateProposal(db, raw)).rejects.toBeInstanceOf(ProposalPathError);
	});
	it('rejects a Windows drive-absolute dirLayout entry', async () => {
		const raw = goodRaw({ dirLayout: ['src/', 'C:\\Windows\\System32\\evil'] });
		await expect(validateProposal(db, raw)).rejects.toBeInstanceOf(ProposalPathError);
	});
	it('rejects a UNC dirLayout entry', async () => {
		const raw = goodRaw({ dirLayout: ['src/', '\\\\host\\share\\evil'] });
		await expect(validateProposal(db, raw)).rejects.toBeInstanceOf(ProposalPathError);
	});
	it('ACCEPTS a clean relative layout (happy path unchanged)', async () => {
		const p = await validateProposal(db, goodRaw({ dirLayout: ['src/', 'src/index.ts', './tests/', 'docs/a.md'] }));
		expect(p.dirLayout).toEqual(['src/', 'src/index.ts', './tests/', 'docs/a.md']);
	});
});

describe('defect_class partition (§3 D4, vs the live vocabulary) — confirmed vs proposed', () => {
	it('a class in the operator-confirmed vocabulary lands in defect_classes (confirmed/matchable)', async () => {
		const p = await validateProposal(db, goodRaw());
		expect(p.capabilityNeeds.defect_classes).toEqual(['null-deref']);
		expect(p.capabilityNeeds.proposed_defect_classes).toEqual([]);
	});
	it('a class NOT in the vocabulary is CAPTURED in proposed_defect_classes (no hard-fail)', async () => {
		const raw = goodRaw({
			capabilityNeeds: { languages: [], frameworks: [], defect_classes: ['never-confirmed-class'] }
		});
		// The proposal no longer hard-fails on an unknown class (new-domain chicken-and-egg fix).
		const p = await validateProposal(db, raw);
		expect(p.capabilityNeeds.defect_classes).toEqual([]); // NOT promoted to confirmed
		expect(p.capabilityNeeds.proposed_defect_classes).toEqual(['never-confirmed-class']);
	});
	it('a mixed list is PARTITIONED: known → defect_classes, unknown → proposed_defect_classes', async () => {
		const raw = goodRaw({
			capabilityNeeds: {
				languages: [],
				frameworks: [],
				defect_classes: ['null-deref', 'bepinex-patch-conflict', 'another-novel-class']
			}
		});
		const p = await validateProposal(db, raw);
		expect(p.capabilityNeeds.defect_classes).toEqual(['null-deref']);
		expect(p.capabilityNeeds.proposed_defect_classes).toEqual([
			'another-novel-class',
			'bepinex-patch-conflict'
		]);
		// D4: no overlap — a class is confirmed XOR proposed, never both.
		const overlap = p.capabilityNeeds.defect_classes.filter((c) =>
			p.capabilityNeeds.proposed_defect_classes.includes(c)
		);
		expect(overlap).toEqual([]);
	});
	it('empty defect_classes is honest (F-008) — both partitions empty', async () => {
		const p = await validateProposal(
			db,
			goodRaw({ capabilityNeeds: { languages: ['ts'], frameworks: [], defect_classes: [] } })
		);
		expect(p.capabilityNeeds.defect_classes).toEqual([]);
		expect(p.capabilityNeeds.proposed_defect_classes).toEqual([]);
	});
});

describe('confirmToken staleness (D-010 shape, ephemeral)', () => {
	it('a matching brief+proposal passes assertProposalFresh', async () => {
		const env = await generateCreationProposal(db, BRIEF, stubGen(goodRaw()));
		expect(() => assertProposalFresh(env.brief, env.proposal, env.confirmToken)).not.toThrow();
	});
	it('a changed brief → StaleProposalError', async () => {
		const env = await generateCreationProposal(db, BRIEF, stubGen(goodRaw()));
		const changed: CreateBrief = { ...env.brief, description: env.brief.description + ' (edited)' };
		expect(() => assertProposalFresh(changed, env.proposal, env.confirmToken)).toThrow(StaleProposalError);
	});
	it('a changed proposal → StaleProposalError', async () => {
		const env = await generateCreationProposal(db, BRIEF, stubGen(goodRaw()));
		const tampered: CreationProposal = {
			...env.proposal,
			stack: [...env.proposal.stack, 'sneaky-extra']
		};
		expect(() => assertProposalFresh(env.brief, tampered, env.confirmToken)).toThrow(StaleProposalError);
	});
});

describe('briefHintsFromTemplate — pure CT-4 pre-fill hints', () => {
	function tpl(id: string): ProjectTemplate {
		const t = getTemplate(id);
		if (!t) throw new Error(`missing template ${id}`);
		return t;
	}

	it('TypeScript template → ecosystem node; SvelteKit tags → web', () => {
		const h = briefHintsFromTemplate(tpl('sveltekit'));
		expect(h.ecosystem).toBe('node');
		expect(h.targetPlatform).toBe('web');
	});

	it('Go CLI template → ecosystem go; cli tag → cli', () => {
		const h = briefHintsFromTemplate(tpl('go'));
		expect(h.ecosystem).toBe('go');
		expect(h.targetPlatform).toBe('cli');
	});

	it('bepinex (C#, unity/mod/game tags) → ecosystem dotnet; specific tag wins over generic game', () => {
		const h = briefHintsFromTemplate(tpl('bepinex'));
		expect(h.ecosystem).toBe('dotnet');
		expect(h.targetPlatform).toBe('unity');
	});

	it('fabric (minecraft) → minecraft platform; java → jvm', () => {
		const h = briefHintsFromTemplate(tpl('fabric'));
		expect(h.ecosystem).toBe('jvm');
		expect(h.targetPlatform).toBe('minecraft');
	});

	it('honest absence: blank template (no language, no tags) → empty hints, no fabricated guess', () => {
		const h = briefHintsFromTemplate(tpl('blank'));
		expect(h.ecosystem).toBeUndefined();
		expect(h.targetPlatform).toBeUndefined();
		expect(Object.keys(h)).toHaveLength(0);
	});

	it('shadow paths: nil language / nil tags do not throw, yield no keys', () => {
		const fake = { id: 'x', name: 'X', description: '', language: '', icon: '', tags: [], params: [], generate: () => ({}) } as unknown as ProjectTemplate;
		expect(() => briefHintsFromTemplate(fake)).not.toThrow();
		expect(briefHintsFromTemplate(fake)).toEqual({});
	});
});
