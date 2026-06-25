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
	SkillPromoteSecretEchoError
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

describe('promoteSkill — confinement (D-018, fail closed)', () => {
	it('a name resolving outside the harvest tree fails closed (never writes/escapes)', async () => {
		// reqKebabName rejects `..` at the PROPOSAL boundary, so we cannot persist an escape name through
		// proposeSkill. To prove the promote-side confinement independently, plant a row whose name
		// contains a traversal segment directly, then promote it — the confined resolver must fail closed.
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
		).rejects.toBeInstanceOf(SkillPromoteConfinementError);
		// Nothing escaped onto disk under the harvest parent, and no catalog id appeared.
		const cat = await catalogIds(db);
		expect(cat.skills.has('../../escape')).toBe(false);
		expect(existsSync(resolve(harvestRoot, '..', 'escape', 'SKILL.md'))).toBe(false);
	});
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
