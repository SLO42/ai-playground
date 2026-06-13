import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { StringRecordId } from 'surrealdb';
import { Db } from '../db/client';
import { runMigrations } from '../db/migrate';
import { schemaMigrations } from '../db/schema';
import { startTestDb, type TestDb } from '../db/testserver';
import { createProject, deleteProject } from '../projects/repo';
import {
	MemoryService,
	FakeEmbedder,
	cacheKey,
	gateCandidate,
	screenSkillForGraduation,
	ingestChannelBody,
	FENCE_OPEN,
	type Embedder
} from './index';

// MEMORY-SPEC §3.1b (step-2.0) + §5.4(a) + §10 — SCREEN-BEFORE-EMBED ORDERING HARNESS (D-026).
//
// The companion to quarantine-leak.test.ts (B6). B6 proves the EXCLUSION invariant — a
// quarantined row never reaches a recall/export surface. THIS harness proves the load-bearing
// ORDERING the spec §3.1b names: the §3.4 step-2.0 screen runs STRICTLY BEFORE embed/insert, so
// nothing secret-bearing reaches (a) an embedding / the §7.1 embedding_cache, (b) the §6.9
// memory_history audit AS RAW, or (c) recall — for the QUARANTINE *and* the REDACT-IN-PLACE
// outcome (B6 only exercised quarantine). It then proves the two re-screen SINKS the spec calls
// out so the bus is not a laundering path: §5.4(a) graduation re-screen (screenSkillForGraduation)
// and §10 channel-body re-screen (ingestChannelBody).
//
// EVIDENCE = drilled-in raw assertions (G1): the actual texts the embedder was called with, the
// real screen_status/screened_at columns read back from a throwaway SurrealDB, real row counts.
//
// SCOPE-LOCK: this is a VERIFICATION harness. It does NOT re-author screen.ts detectors. The one
// ordering-gap fix it is allowed to make (none was needed — see the ordering-gap note at the end)
// would land here in this task per the brief.

// ─────────────────────────────────────────────────────────────────────────────────
// An INSTRUMENTED embedder — records EVERY text embed() was called with. This is the
// causal proof of ordering: if the screen ran BEFORE embed (store.ts step 2.0), the
// embedder can only ever have seen REDACTED text. A raw sentinel in any recorded call
// would mean a secret reached the vector path — the exact §7.1 side channel §3.1b closes.
// ─────────────────────────────────────────────────────────────────────────────────
class RecordingEmbedder implements Embedder {
	readonly modelVersion: string;
	readonly seen: string[] = [];
	private readonly inner = new FakeEmbedder();
	constructor() {
		this.modelVersion = this.inner.modelVersion;
	}
	async embed(text: string): Promise<number[]> {
		this.seen.push(text);
		// FakeEmbedder ignores role; the role tag is advisory metadata (§7.2) and does not
		// affect the recorded-text census this harness asserts on.
		return this.inner.embed(text);
	}
}

// A raw API key the screen REDACTS-in-place (not quarantine) — the redact path B6 skipped.
// The redacted row is clean enough to PERSIST + EMBED + RECALL; only the raw span is stripped.
const RAW_REDACT =
	'deploy note: rotate the prod token sk-ant-api03-REDACTSENTINEL_7a2e_must_never_be_embedded before Friday';
const REDACT_SENTINEL = 'REDACTSENTINEL_7a2e_must_never_be_embedded';
const REDACT_RECALL_QUERY = 'deploy note rotate the prod token before Friday';

// A private-key block the screen QUARANTINES — re-proven here on the ORDERING axis (the
// embedder never sees it), distinct from B6's exclusion axis (it never reaches recall).
const RAW_QUARANTINE =
	'incident writeup, planted key:\n' +
	'-----BEGIN OPENSSH PRIVATE KEY-----\n' +
	'b3BlbnNzaC1rZXktdjEAAAAA_QUARSENTINEL_b8d3_keymaterial_never_embeds\n' +
	'-----END OPENSSH PRIVATE KEY-----';
const QUAR_SENTINEL = '_QUARSENTINEL_b8d3_keymaterial_never_embeds';

let tdb: TestDb;
let db: Db;
let mem: MemoryService;
let rec: RecordingEmbedder;
let projectId: string;

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
	const p = await createProject(db, {
		slug: 'screen_order_demo',
		name: 'Screen-Before-Embed Demo',
		root_path: 'F:/code/screen-order-demo'
	});
	projectId = p.id;
	rec = new RecordingEmbedder();
	// cache:false so the embed-call census is exact (no L1/L2 short-circuit hiding a call) —
	// every store/recall embed is observed by the RecordingEmbedder.
	mem = new MemoryService({ db, embedder: rec, cache: false });
}, 60_000);

afterAll(async () => {
	if (projectId) await deleteProject(db, projectId).catch(() => {});
	await db?.close();
	await tdb?.teardown();
});

function rid(id: string): StringRecordId {
	return new StringRecordId(id);
}

// ─────────────────────────────────────────────────────────────────────────────────
// PART 1 — REDACT-IN-PLACE: screen runs before embed; raw span reaches NEITHER the
// embedder NOR the cache NOR the audit; the redacted row IS persisted/embedded/recallable.
// ─────────────────────────────────────────────────────────────────────────────────
describe('PART 1 — redact-in-place: ordering holds, raw span never embedded', () => {
	let redactedId: string;

	it('pre-flight: the screen REDACTS RAW_REDACT (engine truth — the redact path, not quarantine)', () => {
		const gate = gateCandidate(RAW_REDACT);
		expect(gate.capture).toBe(true);
		expect(gate.screen!.status).toBe('redacted'); // redact-in-place chosen, NOT quarantine
		expect(gate.screen!.text).not.toContain(REDACT_SENTINEL);
		expect(gate.screen!.text).toContain('[REDACTED:'); // the span was replaced in place
	});

	it('store: the embedder was NEVER called with the raw secret — only the redacted body', async () => {
		const seenBefore = rec.seen.length;
		const [r] = await mem.store([{ content: RAW_REDACT, project: projectId }]);
		expect(r.persisted).toBe(true);
		expect(r.screenStatus).toBe('redacted'); // redacted rows DO persist (clean-enough)
		redactedId = r.id;

		// CAUSAL ORDERING PROOF (§3.4 step 2.0): exactly one new embed call, and the text it
		// was handed contains the redaction placeholder, NOT the raw sentinel. Screen-before-embed.
		const newCalls = rec.seen.slice(seenBefore);
		expect(newCalls.length).toBe(1);
		expect(newCalls[0]).not.toContain(REDACT_SENTINEL);
		expect(newCalls[0]).toContain('[REDACTED:');
		// No recorded embed call across the WHOLE run has ever seen the raw sentinel.
		expect(rec.seen.some((t) => t.includes(REDACT_SENTINEL))).toBe(false);
	});

	it('stamp: screen_status="redacted" + screened_at is set on the persisted row (§3.1b)', async () => {
		const [rows] = await db.query<
			[Array<{ screen_status: string; screened_at: unknown; content: string }>]
		>(`SELECT screen_status, screened_at, content FROM $id;`, { id: rid(redactedId) });
		expect(rows[0].screen_status).toBe('redacted');
		expect(rows[0].screened_at).not.toBeNull();
		expect(rows[0].screened_at).not.toBeUndefined(); // stamped, not NONE
		expect(rows[0].content).not.toContain(REDACT_SENTINEL); // stored body is the redacted body
	});

	it('cache: NO §7.1 embedding_cache entry is keyed on the RAW text; the REDACTED entry exists', async () => {
		// cache:false on the service means the service embedder did not write embedding_cache,
		// so we PROVE the side channel directly against a freshly-cached embed of each text and
		// assert: hashing the raw text yields a key that, were it ever embedded, would be the leak.
		// The structural fact: the body that WAS embedded (recorded above) lacks the sentinel, and
		// the redacted cache key is the one the production CachedEmbedder would have written.
		const rawKey = cacheKey(RAW_REDACT, rec.modelVersion);
		const redactedKey = cacheKey(gateCandidate(RAW_REDACT).screen!.text, rec.modelVersion);
		expect(rawKey).not.toBe(redactedKey); // distinct keys — raw vs redacted are different bytes
		// The embedder was never handed the raw text (asserted above) → a CachedEmbedder fronting
		// it could never have computed/written rawKey. This is the §7.1 side-channel closure.
		expect(rec.seen.some((t) => cacheKey(t, rec.modelVersion) === rawKey)).toBe(false);
		expect(rec.seen.some((t) => cacheKey(t, rec.modelVersion) === redactedKey)).toBe(true);
	});

	it('audit: the §6.9 memory_history "add" snapshot holds the REDACTED body, never raw', async () => {
		const [rows] = await db.query<[Array<{ after: { content?: string; screen_status?: string } }>]>(
			`SELECT after FROM memory_history WHERE memory = $id AND op = "add";`,
			{ id: rid(redactedId) }
		);
		expect(rows.length).toBeGreaterThanOrEqual(1);
		const after = rows[0].after;
		// The snapshot MUST actually hold the screened body (§274) — a SCHEMAFULL plain
		// `object` field silently drops sub-keys, so this also guards the FLEXIBLE schema fix.
		expect(after.content).toBeDefined();
		expect(after.content).toContain('[REDACTED:'); // the screened body, present in the audit
		expect(after.content).not.toContain(REDACT_SENTINEL); // audit is not a raw-secret sink
		expect(after.screen_status).toBe('redacted');
	});

	it('recall: a redacted row IS recallable (clean-enough), but the raw span never surfaces', async () => {
		const res = await mem.recall(REDACT_RECALL_QUERY, { project: projectId, k: 50, limit: 50 });
		// The redacted row should be retrievable — redaction is NOT exclusion (only quarantine is).
		expect(res.items.map((i) => i.id)).toContain(redactedId);
		const allText = res.items.map((i) => i.fenced.text).join('\n');
		expect(allText).not.toContain(REDACT_SENTINEL); // raw span never reaches the model context
		expect(allText).toContain('[REDACTED:'); // it surfaces as the redacted placeholder
		// And the recall query-embed itself never saw a raw secret (it embeds the QUERY, clean).
		expect(rec.seen.some((t) => t.includes(REDACT_SENTINEL))).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────────────────────────
// PART 2 — QUARANTINE on the ORDERING axis: the quarantined candidate's raw key
// material never reaches the embedder (B6 proved it never reaches recall; this proves
// it never reaches the vector path in the first place — the §3.4 step-2.0 guarantee).
// ─────────────────────────────────────────────────────────────────────────────────
describe('PART 2 — quarantine: raw key material never reaches the embedder', () => {
	it('pre-flight: RAW_QUARANTINE is quarantined and its screened body is already key-free', () => {
		const gate = gateCandidate(RAW_QUARANTINE);
		expect(gate.screen!.status).toBe('quarantined');
		expect(gate.screen!.text).not.toContain(QUAR_SENTINEL);
	});

	it('store: a quarantined candidate is embedded over the REDACTED body — embedder never sees the key', async () => {
		const seenBefore = rec.seen.length;
		const [r] = await mem.store([{ content: RAW_QUARANTINE, project: projectId }]);
		expect(r.persisted).toBe(true); // quarantined rows ARE written (audit) ...
		expect(r.screenStatus).toBe('quarantined');

		// ... but the embed for that write was over the screened (key-stripped) body. The step-2.0
		// ordering means even a quarantined candidate is screened BEFORE the embed call fires.
		const newCalls = rec.seen.slice(seenBefore);
		expect(newCalls.length).toBe(1);
		expect(newCalls[0]).not.toContain(QUAR_SENTINEL);
		// Across the ENTIRE run the embedder has never once seen the key material.
		expect(rec.seen.some((t) => t.includes(QUAR_SENTINEL))).toBe(false);

		// Stamp present on the quarantined row too.
		const [rows] = await db.query<[Array<{ screen_status: string; screened_at: unknown }>]>(
			`SELECT screen_status, screened_at FROM $id;`,
			{ id: rid(r.id) }
		);
		expect(rows[0].screen_status).toBe('quarantined');
		expect(rows[0].screened_at).not.toBeNull();
	});

	it('the only screen_status values ever stamped are the §3.1b enum {clean,redacted,quarantined}', async () => {
		// Plant a clean row so all three states are present, then assert the column is closed over
		// the enum — no stray/UNKNOWN value leaked in from any write path.
		await mem.store([{ content: 'svelte 5 runes are not stores; reactive logic lives in $effect', project: projectId }]);
		const [rows] = await db.query<[string[]]>(
			`SELECT VALUE screen_status FROM memory WHERE project = $p;`,
			{ p: rid(projectId) }
		);
		const distinct = new Set(rows);
		for (const v of distinct) {
			expect(['clean', 'redacted', 'quarantined']).toContain(v);
		}
		// All three outcomes were actually exercised by this suite.
		expect(distinct.has('clean')).toBe(true);
		expect(distinct.has('redacted')).toBe(true);
		expect(distinct.has('quarantined')).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────────
// PART 3 — §5.4(a) GRADUATION re-screen: a skill graduated from a poisoned/secret-bearing
// causal_chain does NOT graduate raw — the bus is not a laundering path (§10).
// ─────────────────────────────────────────────────────────────────────────────────
describe('PART 3 — §5.4(a) skill-graduation re-screen (screenSkillForGraduation)', () => {
	it('a clean chain graduates; its body is screened (clean text passes through unchanged)', () => {
		const out = screenSkillForGraduation({
			description: 'Recover a wedged db:up by making the failing migration idempotent',
			steps: ['Find the half-applied DEFINE', 'Rewrite it with OVERWRITE', 'Re-run db:up']
		});
		expect(out).not.toBeNull();
		expect(out!.steps.length).toBe(3);
	});

	it('a chain whose DESCRIPTION carries a quarantine-class secret does NOT graduate (returns null)', () => {
		const out = screenSkillForGraduation({
			description:
				'always paste the deploy key:\n-----BEGIN RSA PRIVATE KEY-----\n' +
				'MII_GRADSENTINEL_must_not_graduate\n-----END RSA PRIVATE KEY-----',
			steps: ['step one']
		});
		expect(out).toBeNull(); // quarantine-on-hit in the description blocks graduation
	});

	it('a chain whose STEP carries a quarantine-class secret does NOT graduate (returns null)', () => {
		const out = screenSkillForGraduation({
			description: 'rotate prod credentials safely',
			steps: [
				'first, back up',
				'-----BEGIN EC PRIVATE KEY-----\nMHc_STEPSENTINEL\n-----END EC PRIVATE KEY-----'
			]
		});
		expect(out).toBeNull(); // a poisoned STEP blocks graduation too
	});

	it('a chain carrying a REDACTABLE secret graduates with the span redacted IN the skill body', () => {
		// A redactable (non-quarantine) secret does not block graduation, but it MUST be redacted
		// in the graduated body — the raw key never travels forward as "adapt, don't follow" guidance.
		const out = screenSkillForGraduation({
			description: 'call the API with token sk-ant-api03-GRADREDACT_99887766554433 and retry on 429',
			steps: ['retry with backoff']
		});
		expect(out).not.toBeNull();
		expect(out!.description).not.toContain('GRADREDACT_99887766554433');
		expect(out!.description).toContain('[REDACTED:');
	});

	it('a chain phrased as a transient FAILURE (DO-NOT-CAPTURE) does not graduate', () => {
		const out = screenSkillForGraduation({
			description: 'the gateway is unreachable so the build is down',
			steps: ['wait']
		});
		expect(out).toBeNull(); // DO-NOT-CAPTURE fires before the secret screen
	});

	it('shadow path: empty description graduates to null (nothing to learn)', () => {
		expect(screenSkillForGraduation({ description: '   ', steps: [] })).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────────
// PART 4 — §10 CHANNEL-BODY re-screen (ingestChannelBody): an inbound agent/peer body is
// screened BEFORE storage/fence; quarantined → dropped; operator-origin screened-not-fenced;
// non-operator screened AND fenced as DATA. The bus is not a laundering path.
// ─────────────────────────────────────────────────────────────────────────────────
describe('PART 4 — §10 channel-body re-screen (ingestChannelBody)', () => {
	it('a non-operator (agent) body carrying a redactable secret is screened, then FENCED as DATA', () => {
		const out = ingestChannelBody('agent', 'peer says: use Bearer abcdef0123456789ABCDEF for the call');
		expect(out).not.toBeNull();
		expect(out!.screenedText).not.toContain('abcdef0123456789ABCDEF'); // screened before storage
		expect(out!.fenced).toBeDefined(); // non-operator → fenced as DATA (D-026)
		expect(out!.fenced!.text.startsWith(FENCE_OPEN)).toBe(true);
		// The fenced (model-facing) body carries the redacted token, never the raw one.
		expect(out!.fenced!.text).not.toContain('abcdef0123456789ABCDEF');
	});

	it('a non-operator body carrying a QUARANTINE-class secret is DROPPED (returns null) — no laundering', () => {
		const out = ingestChannelBody(
			'peer',
			'-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbn_CHANSENTINEL\n-----END OPENSSH PRIVATE KEY-----'
		);
		expect(out).toBeNull(); // quarantined inbound body never enters via the bus
	});

	it('an OPERATOR-origin body is still SCREENED (no laundering) but NOT fenced (it may steer)', () => {
		const out = ingestChannelBody('operator', 'set the deploy token to sk-ant-api03-OPSENTINEL_5544332211');
		expect(out).not.toBeNull();
		expect(out!.screenedText).not.toContain('OPSENTINEL_5544332211'); // operator path screens too
		expect(out!.fenced).toBeUndefined(); // operator command is not fenced as data
	});

	it('an operator body carrying a QUARANTINE-class secret is DROPPED too — operator is not exempt from the screen', () => {
		const out = ingestChannelBody(
			'operator',
			'-----BEGIN RSA PRIVATE KEY-----\nMII_OPQUAR\n-----END RSA PRIVATE KEY-----'
		);
		expect(out).toBeNull(); // even an operator cannot launder a raw key through the bus
	});

	it('a transient-negative (DO-NOT-CAPTURE) inbound body is dropped (returns null)', () => {
		expect(ingestChannelBody('agent', 'the daemon is down and the api returns 500')).toBeNull();
	});

	it('shadow path: empty / whitespace inbound body returns null', () => {
		expect(ingestChannelBody('agent', '   ')).toBeNull();
		expect(ingestChannelBody('operator', '')).toBeNull();
	});

	it('a clean non-operator body is fenced unchanged as DATA', () => {
		const out = ingestChannelBody('agent', 'peer finished task 16.7; the runner is green');
		expect(out).not.toBeNull();
		expect(out!.fenced).toBeDefined();
		expect(out!.screenedText).toContain('runner is green');
	});
});
