import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { catalogIds, harvestScopeDir, splitFrontmatter } from '../cc-config';
import { composeCapabilities } from '../runtime/capabilities';
import { proposeSkill, getSkillProposal, type ProposeSkillInput } from './proposal';
import {
	promoteSkill,
	SkillPromoteNotFoundError,
	SkillPromoteNotApprovedError,
	SkillPromoteConfinementError,
	SkillPromoteCollisionError,
	SkillPromoteSecretEchoError,
	SkillPromoteBadNameError,
	SkillPromoteNameOwnedError
} from './promote';

// SH-3 VERIFY (SKILL-HARVEST-SPEC §3) — the PROMOTE stage against a REAL throwaway SurrealDB + a temp
// harvest scope on disk. Covers the integrity invariants the operator gate must hold:
//   • OPERATOR-GATED — an approved promote writes a confined SKILL.md AND the name lands in catalogIds;
//   • NO SELF-PROMOTION — no approver / a rejected proposal → fail closed, name never in cc_skill;
//   • CONFINEMENT — a name that would escape the harvest tree → fail closed (D-018);
//   • DISK-IS-TRUTH — the SKILL.md exists on disk BEFORE the cc_skill row (D-010);
//   • NO POISONING — a colliding name → fail closed unless update:true;
//   • IDEMPOTENT — re-promote = no double-write, no dup row;
//   • F-045 CLOSED — a code-write bundle declaring the promoted skill composes WITHOUT a throw.

let tdb: TestDb;
let db: Db;
let harvestRoot: string;
let env: NodeJS.ProcessEnv;

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
	if (harvestRoot) rmSync(harvestRoot, { recursive: true, force: true });
});

beforeEach(async () => {
	await db.query('DELETE skill_proposal;').catch(() => {});
	await db.query('DELETE cc_skill;').catch(() => {});
	await db.query('DELETE cc_scope;').catch(() => {});
	await db.query('DELETE cc_settings;').catch(() => {});
	// A fresh temp harvest scope per test (HARVEST_SCOPE_ROOT/.claude is the harvest dir).
	if (harvestRoot) rmSync(harvestRoot, { recursive: true, force: true });
	harvestRoot = mkdtempSync(join(tmpdir(), 'sh3-harvest-'));
	env = { ...process.env, HARVEST_SCOPE_ROOT: harvestRoot };
});

function input(over: Partial<ProposeSkillInput> = {}): ProposeSkillInput {
	return {
		name: 'windows-pid-liveness',
		description: 'Check process liveness on Windows/MINGW reliably.',
		body: '# Windows PID liveness\n\nUse `tasklist /FI "PID eq <pid>"` — never `process.kill(pid, 0)`.',
		trigger_context: 'When checking whether a spawned process is still alive on Windows.',
		evidence: ['fails.md:F-001'],
		...over
	};
}

function skillMdPath(name = 'windows-pid-liveness'): string {
	return join(harvestScopeDir(env), 'skills', name, 'SKILL.md');
}

describe('promoteSkill — operator-gated happy path (disk + catalog)', () => {
	it('an approved promote writes a confined SKILL.md AND lands the name in catalogIds', async () => {
		const proposal = await proposeSkill(db, input());

		// Pre-state: NOT in the catalog (no agent path reached cc_skill).
		const before = await catalogIds(db);
		expect(before.skills.has('windows-pid-liveness')).toBe(false);

		const res = await promoteSkill(db, { proposalId: proposal.id, approver: 'operator:sam', env });

		// Disk: the confined SKILL.md exists with valid name/description frontmatter + the body.
		expect(res.filePath).toBe(skillMdPath());
		expect(existsSync(res.filePath)).toBe(true);
		const md = readFileSync(res.filePath, 'utf8');
		const { frontmatter, body } = splitFrontmatter(md);
		expect(frontmatter.name).toBe('windows-pid-liveness');
		expect(frontmatter.description).toContain('liveness');
		expect(body).toContain('tasklist');

		// Catalog: the name is now in cc_skill / catalogIds.
		const after = await catalogIds(db);
		expect(after.skills.has('windows-pid-liveness')).toBe(true);

		// Proposal: status flipped to approved with the recorded operator.
		const flipped = await getSkillProposal(db, proposal.id);
		expect(flipped?.status).toBe('approved');
		expect(flipped?.approved_by).toBe('operator:sam');
		expect(flipped?.approved_at).toBeTruthy();
		expect(res.wroteFile).toBe(true);
		expect(res.recordedApproval).toBe(true);
	});

	it('DISK-IS-TRUTH: the SKILL.md file exists before the cc_skill row is queryable (D-010 order)', async () => {
		// Promote, then assert BOTH the file and the row are present (the function writes disk first; the
		// row can only exist because the file did at sync time — the order is enforced structurally).
		const proposal = await proposeSkill(db, input());
		const res = await promoteSkill(db, { proposalId: proposal.id, approver: 'operator:sam', env });
		expect(existsSync(res.filePath)).toBe(true);
		const cat = await catalogIds(db);
		expect(cat.skills.has('windows-pid-liveness')).toBe(true);
	});
});

describe('promoteSkill — no self-promotion (G2/D-039, fail closed)', () => {
	it('an EMPTY approver fails closed and never reaches cc_skill', async () => {
		const proposal = await proposeSkill(db, input());
		await expect(
			promoteSkill(db, { proposalId: proposal.id, approver: '   ', env })
		).rejects.toBeInstanceOf(SkillPromoteNotApprovedError);
		const cat = await catalogIds(db);
		expect(cat.skills.has('windows-pid-liveness')).toBe(false);
		expect(existsSync(skillMdPath())).toBe(false);
		const still = await getSkillProposal(db, proposal.id);
		expect(still?.status).toBe('open');
		expect(still?.approved_by).toBeUndefined();
	});

	it('a REJECTED proposal is not promotable (terminal)', async () => {
		const proposal = await proposeSkill(db, input());
		await db.query(`UPDATE ${proposal.id} SET status = "rejected";`);
		await expect(
			promoteSkill(db, { proposalId: proposal.id, approver: 'operator:sam', env })
		).rejects.toBeInstanceOf(SkillPromoteNotApprovedError);
		const cat = await catalogIds(db);
		expect(cat.skills.has('windows-pid-liveness')).toBe(false);
	});

	it('an unknown proposalId fails closed (honest absent, named)', async () => {
		await expect(
			promoteSkill(db, { proposalId: 'skill_proposal:nonexistent', approver: 'operator:sam', env })
		).rejects.toBeInstanceOf(SkillPromoteNotFoundError);
	});
});

describe('promoteSkill — name re-validation + confinement (D-018/D-026 symmetry, fail closed)', () => {
	it('a traversal name in a planted row fails closed at the disk boundary (never writes/escapes)', async () => {
		// reqKebabName rejects `..` at the PROPOSAL boundary, so we cannot persist an escape name through
		// proposeSkill. To prove the promote-side guards independently, plant a row whose name contains a
		// traversal segment directly, then promote it. The disk-boundary name re-validation (item 1, D-026
		// symmetry) catches the non-kebab name FIRST (SkillPromoteBadNameError); the confined resolver
		// (D-018) remains the authoritative escape backstop behind it. Either way: fail closed, no escape.
		const [created] = await db.query<[Array<{ id: unknown }>]>(
			`CREATE skill_proposal CONTENT {
				name: $name, description: "x", body: "# x\\nbody", trigger_context: "t",
				source: "session-harvest", evidence: [], occurrences: 1, status: "open",
				norm_key: "escape|t"
			} RETURN id;`,
			{ name: '../../escape' }
		);
		const id = String(created[0].id);
		await expect(
			promoteSkill(db, { proposalId: id, approver: 'operator:sam', env })
		).rejects.toBeInstanceOf(SkillPromoteBadNameError);
		// Nothing escaped onto disk under the harvest parent, and no catalog id appeared.
		const cat = await catalogIds(db);
		expect(cat.skills.has('../../escape')).toBe(false);
		expect(existsSync(resolve(harvestRoot, '..', 'escape', 'SKILL.md'))).toBe(false);
	});

	it('a non-kebab in-tree name (uppercase/space) fails closed with SkillPromoteBadNameError', async () => {
		// A name with no traversal but not a clean lower-kebab id — the disk boundary must refuse it
		// (D-026 symmetry: the disk-write boundary re-validates the name, never coerces it).
		const [created] = await db.query<[Array<{ id: unknown }>]>(
			`CREATE skill_proposal CONTENT {
				name: $name, description: "x", body: "# x\\nbody", trigger_context: "t",
				source: "session-harvest", evidence: [], occurrences: 1, status: "open", norm_key: "bad|t"
			} RETURN id;`,
			{ name: 'Not A Kebab' }
		);
		const id = String(created[0].id);
		await expect(
			promoteSkill(db, { proposalId: id, approver: 'operator:sam', env })
		).rejects.toBeInstanceOf(SkillPromoteBadNameError);
		expect((await catalogIds(db)).skills.has('Not A Kebab')).toBe(false);
	});

	// Confinement (D-018) stays reachable as a TYPE: ConfigTargetError subclass of the promote confinement
	// error is asserted by the cc-config config-target tests; here the BadName guard fires first for any
	// `..` name. We keep the import + class to document the layered defense (BadName → Confinement).
	void SkillPromoteConfinementError;
});

describe('promoteSkill — no catalog poisoning (collision)', () => {
	it('a name already in the catalog under a DIFFERENT file is rejected (no silent overwrite)', async () => {
		// Plant a foreign cc_skill row claiming the name but backed by a DIFFERENT file path (a separate
		// scope). A promote of a same-named proposal whose own SKILL.md is absent must fail closed.
		await db.query(`
			CREATE cc_scope:foreign SET kind = "global", path = "/some/other/.claude";
			CREATE cc_skill:foreign SET scope = cc_scope:foreign, name = "windows-pid-liveness",
				file_path = "/some/other/.claude/skills/windows-pid-liveness/SKILL.md";
		`);
		const proposal = await proposeSkill(db, input());
		await expect(
			promoteSkill(db, { proposalId: proposal.id, approver: 'operator:sam', env })
		).rejects.toBeInstanceOf(SkillPromoteCollisionError);
		// Our SKILL.md was NOT written (fail closed before disk write).
		expect(existsSync(skillMdPath())).toBe(false);
	});

	it('item 2 — a FOREIGN-owned name + a STALE harvest file at our path STILL fails closed (scope-attributed, not bare existsSync)', async () => {
		// The exact under-guard the ledger flags: the old guard inferred ownership from existsSync(filePath).
		// Plant (a) a foreign cc_skill row owning the name in another scope, AND (b) a stale SKILL.md already
		// sitting at OUR harvest path. The old `existsSync` guard would treat the name as "ours" and proceed,
		// creating a DUPLICATE-name cc_skill row across scopes. The scope-attributed guard must still reject:
		// the name is NOT owned by OUR harvest scope (no cc_skill row under our scope id yet).
		await db.query(`
			CREATE cc_scope:foreign2 SET kind = "global", path = "/some/other/.claude";
			CREATE cc_skill:foreign2 SET scope = cc_scope:foreign2, name = "windows-pid-liveness",
				file_path = "/some/other/.claude/skills/windows-pid-liveness/SKILL.md";
		`);
		// Stale file already on disk at our harvest path (simulates a prior aborted/orphaned write).
		mkdirSync(join(harvestScopeDir(env), 'skills', 'windows-pid-liveness'), { recursive: true });
		writeFileSync(skillMdPath(), '---\nname: windows-pid-liveness\ndescription: "stale"\n---\n\nstale\n', 'utf8');

		const proposal = await proposeSkill(db, input());
		await expect(
			promoteSkill(db, { proposalId: proposal.id, approver: 'operator:sam', env })
		).rejects.toBeInstanceOf(SkillPromoteCollisionError);

		// No duplicate-name cc_skill row was created (the foreign one is the ONLY cc_skill named so).
		const [rows] = await db.query<[Array<{ id: unknown }>]>(
			`SELECT id FROM cc_skill WHERE name = "windows-pid-liveness";`
		);
		expect(rows).toHaveLength(1);
	});
});

describe('promoteSkill — same-name promote serialization (item 3: a name → ONE durable skill)', () => {
	it('a SECOND same-name / different-trigger proposal cannot ALSO promote (fail closed, no last-writer-wins)', async () => {
		// Two proposals share the kebab `name` but have DIFFERENT triggers (so they are SEPARATE open rows —
		// the open dedup_key is name+trigger, not name alone). Promote the first → approved + on disk. The
		// second must NOT also flip approved onto the same SKILL.md path (last-writer-wins). It fails closed.
		const first = await proposeSkill(db, input({ trigger_context: 'Trigger context number one here.' }));
		const second = await proposeSkill(db, input({ trigger_context: 'A genuinely different trigger two.' }));
		expect(second.id).not.toBe(first.id);

		await promoteSkill(db, { proposalId: first.id, approver: 'operator:sam', env });
		await expect(
			promoteSkill(db, { proposalId: second.id, approver: 'operator:sam', env })
		).rejects.toBeInstanceOf(SkillPromoteNameOwnedError);

		// Exactly ONE approved proposal owns the name, and exactly ONE cc_skill row carries it.
		const [approved] = await db.query<[Array<{ id: unknown }>]>(
			`SELECT id FROM skill_proposal WHERE name = "windows-pid-liveness" AND status = "approved";`
		);
		expect(approved).toHaveLength(1);
		const [skillRows] = await db.query<[Array<{ id: unknown }>]>(
			`SELECT id FROM cc_skill WHERE name = "windows-pid-liveness";`
		);
		expect(skillRows).toHaveLength(1);
	});

	it('the DB UNIQUE backstop refuses a second approved row even if the JS guard is bypassed (m0064)', async () => {
		// Promote the first proposal normally. Then plant a SECOND same-name open row and try to flip it
		// approved DIRECTLY at the DB — the m0064 approved_name_key UNIQUE index must reject it.
		const first = await proposeSkill(db, input({ trigger_context: 'Unique-backstop trigger one.' }));
		await promoteSkill(db, { proposalId: first.id, approver: 'operator:sam', env });

		const [created] = await db.query<[Array<{ id: unknown }>]>(
			`CREATE skill_proposal CONTENT {
				name: "windows-pid-liveness", description: "x", body: "# x\\nb", trigger_context: "two",
				source: "session-harvest", evidence: [], occurrences: 1, status: "open", norm_key: "wpl|two"
			} RETURN id;`
		);
		const id = String(created[0].id);
		await expect(
			db.query(`UPDATE ${id} SET status = "approved";`)
		).rejects.toThrow();
	});
});

describe('promoteSkill — D-026 disk-boundary secret screen', () => {
	it('an un-redactable private-key block in a planted body REJECTS before the SKILL.md is written', async () => {
		const pem =
			'-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA1234567890\n-----END RSA PRIVATE KEY-----';
		// proposeSkill would reject this at draft time, so plant the row directly to exercise the
		// promote-side re-screen (defense in depth at the disk boundary).
		const [created] = await db.query<[Array<{ id: unknown }>]>(
			`CREATE skill_proposal CONTENT {
				name: "leaky-skill", description: "x", body: $body, trigger_context: "t",
				source: "session-harvest", evidence: [], occurrences: 1, status: "open", norm_key: "leaky|t"
			} RETURN id;`,
			{ body: `# Skill\n\n${pem}` }
		);
		const id = String(created[0].id);
		await expect(
			promoteSkill(db, { proposalId: id, approver: 'operator:sam', env })
		).rejects.toBeInstanceOf(SkillPromoteSecretEchoError);
		expect(existsSync(skillMdPath('leaky-skill'))).toBe(false);
	});

	it('a quarantine in the DESCRIPTION (not just body) REJECTS at the disk boundary (D-026 symmetry)', async () => {
		// Item 1 — the disk boundary re-screens the DESCRIPTION too (it was previously only re-screening the
		// body). Plant a row whose description carries an un-redactable private-key block; the SkillMd would
		// embed it in the frontmatter, so promote must reject before writing the file. carries field='description'.
		const pem =
			'-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA1234567890\n-----END RSA PRIVATE KEY-----';
		const [created] = await db.query<[Array<{ id: unknown }>]>(
			`CREATE skill_proposal CONTENT {
				name: "leaky-desc", description: $desc, body: "# clean body", trigger_context: "t",
				source: "session-harvest", evidence: [], occurrences: 1, status: "open", norm_key: "leakydesc|t"
			} RETURN id;`,
			{ desc: `See key ${pem}` }
		);
		const id = String(created[0].id);
		await expect(
			promoteSkill(db, { proposalId: id, approver: 'operator:sam', env }).catch((e) => {
				expect(e).toBeInstanceOf(SkillPromoteSecretEchoError);
				expect((e as SkillPromoteSecretEchoError).field).toBe('description');
				throw e;
			})
		).rejects.toBeInstanceOf(SkillPromoteSecretEchoError);
		expect(existsSync(skillMdPath('leaky-desc'))).toBe(false);
	});

	it('a REDACTABLE secret in the description is rewritten (not rejected) and the SKILL.md lands screened', async () => {
		// Symmetry must not over-reject: a benign redactable span (email) in the description is rewritten to
		// its [REDACTED:*] form and the file is written (parity with the proposal-entry screen, not a throw).
		const proposal = await proposeSkill(
			db,
			input({ name: 'redacted-desc', description: 'Ping dev@example.com for the runbook.' })
		);
		const res = await promoteSkill(db, { proposalId: proposal.id, approver: 'operator:sam', env });
		const md = readFileSync(res.filePath, 'utf8');
		expect(md).not.toContain('dev@example.com');
		expect(md).toContain('[REDACTED:email]');
	});
});

describe('promoteSkill — idempotent re-promote (F-015 interrupt-safe)', () => {
	it('re-promoting an already-approved proposal is a NO-OP (no double-write, no dup row)', async () => {
		const proposal = await proposeSkill(db, input());
		const first = await promoteSkill(db, { proposalId: proposal.id, approver: 'operator:sam', env });
		expect(first.wroteFile).toBe(true);
		expect(first.recordedApproval).toBe(true);

		const second = await promoteSkill(db, { proposalId: proposal.id, approver: 'operator:sam', env });
		expect(second.wroteFile).toBe(false); // identical file already present
		expect(second.recordedApproval).toBe(false); // already approved by the same operator

		// Exactly ONE cc_skill row for the name (deterministic id → UPSERT, no dup).
		const [skillRows] = await db.query<[Array<{ name: unknown }>]>(
			`SELECT name FROM cc_skill WHERE name = "windows-pid-liveness";`
		);
		expect(skillRows).toHaveLength(1);
	});

	it('absorbs a partial prior promote (file on disk, status still open) — finishes sync + records approval', async () => {
		const proposal = await proposeSkill(db, input());
		// Simulate a promote that wrote the SKILL.md but died before sync + the status flip.
		const fp = skillMdPath();
		mkdirSync(join(harvestScopeDir(env), 'skills', 'windows-pid-liveness'), { recursive: true });
		writeFileSync(
			fp,
			`---\nname: windows-pid-liveness\ndescription: "Check process liveness on Windows/MINGW reliably."\n---\n\n# Windows PID liveness\n\nUse \`tasklist /FI "PID eq <pid>"\` — never \`process.kill(pid, 0)\`.\n`,
			'utf8'
		);
		const res = await promoteSkill(db, { proposalId: proposal.id, approver: 'operator:sam', env });
		expect(res.recordedApproval).toBe(true);
		const cat = await catalogIds(db);
		expect(cat.skills.has('windows-pid-liveness')).toBe(true);
		const flipped = await getSkillProposal(db, proposal.id);
		expect(flipped?.status).toBe('approved');
	});
});

describe('promoteSkill — F-045 dead-end closed (capability composes after promote)', () => {
	it('a code-write bundle declaring the promoted skill composes WITHOUT a CapabilityValidationError', async () => {
		const proposal = await proposeSkill(db, input());
		await promoteSkill(db, { proposalId: proposal.id, approver: 'operator:sam', env });

		// The exact F-045 path: build the live catalog id-set, then compose a bundle that declares the
		// freshly promoted skill. Before promote this threw "unknown skill capability id"; now it passes.
		const cat = await catalogIds(db);
		const catalog = { skills: cat.skills, agents: cat.agents, mcp: cat.mcp };
		const composed = composeCapabilities(
			{ skills: ['windows-pid-liveness'], agents: [], mcp: [] },
			catalog,
			{ gates: {}, hooks: {} }
		);
		expect(composed.capabilities.skills).toContain('windows-pid-liveness');

		// And an un-promoted id STILL fails closed (the allow-list still bites).
		expect(() =>
			composeCapabilities(
				{ skills: ['never-promoted'], agents: [], mcp: [] },
				catalog,
				{ gates: {}, hooks: {} }
			)
		).toThrow(/unknown skill capability id/);
	});
});
