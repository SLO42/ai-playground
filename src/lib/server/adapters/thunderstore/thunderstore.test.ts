import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ThunderstorePublisherAdapter, THUNDERSTORE_SECRET } from './adapter';
import { runPublisherContract } from '../contract';
import { resolverForAdapter } from '../secrets';
import {
	validateManifest,
	validateIcon,
	validateReadme,
	readPngSize,
	isValidVersion,
	isValidDependency,
	ICON_SIZE
} from './spec';
import { buildZip, listZip, crc32 } from './zip';
import { buildUploadPlan, planToSteps, REDACTED_SECRET, DEFAULT_API_BASE } from './api';

// TASK 12.2 VERIFY — the deepened Thunderstore publisher. Comprehensive unit + integration tests
// against a REALISTIC fixture mod (tests/fixtures/thunderstore-mod). No real external call occurs.

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, '../../../../../tests/fixtures/thunderstore-mod');

const adapter = () => new ThunderstorePublisherAdapter();
const resolver = (env: Record<string, string | undefined> = {}) => resolverForAdapter(env, adapter());

// A copy of the fixture in a temp dir for mutation tests.
let work: string;
beforeAll(async () => {
	work = await mkdtemp(join(tmpdir(), 'atelier-ts-mod-'));
	await cp(FIXTURE, work, { recursive: true });
});
afterAll(async () => {
	await rm(work, { recursive: true, force: true }).catch(() => {});
});

// ── spec.ts: manifest validation ──────────────────────────────────────────────
describe('spec — version + dependency formats', () => {
	it('accepts a 3-part semver', () => {
		expect(isValidVersion('1.4.0')).toBe(true);
		expect(isValidVersion('0.0.1')).toBe(true);
		expect(isValidVersion('10.20.30')).toBe(true);
	});
	it('rejects non-3-part / malformed versions', () => {
		expect(isValidVersion('1.4')).toBe(false);
		expect(isValidVersion('v1.4.0')).toBe(false);
		expect(isValidVersion('1.4.0.1')).toBe(false);
		expect(isValidVersion('1.04.0')).toBe(false);
		expect(isValidVersion('latest')).toBe(false);
	});
	it('validates Team-Package-Version dependency strings', () => {
		expect(isValidDependency('BepInEx-BepInExPack-5.4.2100')).toBe(true);
		expect(isValidDependency('Owner-Mod-1.0.0')).toBe(true);
		expect(isValidDependency('BepInEx-BepInExPack')).toBe(false);
		expect(isValidDependency('BepInEx-BepInExPack-latest')).toBe(false);
	});
});

describe('spec — validateManifest', () => {
	const good = {
		name: 'SwipRounds',
		version_number: '1.4.0',
		website_url: 'https://example.com',
		description: 'a mod',
		dependencies: ['BepInEx-BepInExPack-5.4.2100']
	};
	it('passes a well-formed manifest', () => {
		const v = validateManifest(good);
		expect(v.ok, JSON.stringify(v.blockers)).toBe(true);
	});
	it('allows an empty website_url + empty dependencies', () => {
		const v = validateManifest({ ...good, website_url: '', dependencies: [] });
		expect(v.ok).toBe(true);
	});
	it('blocks a non-object manifest', () => {
		expect(validateManifest(null).ok).toBe(false);
		expect(validateManifest([1, 2]).ok).toBe(false);
		expect(validateManifest('x').blockers[0]).toMatch(/JSON object/);
	});
	it('blocks a bad name (charset + length)', () => {
		expect(validateManifest({ ...good, name: 'Swip Rounds!' }).blockers.join()).toMatch(/letters, digits/);
		expect(validateManifest({ ...good, name: 'x'.repeat(129) }).blockers.join()).toMatch(/exceeds 128/);
		expect(validateManifest({ ...good, name: '' }).blockers.join()).toMatch(/name is required/);
	});
	it('blocks a non-semver version_number with a SPECIFIC message', () => {
		const v = validateManifest({ ...good, version_number: '1.4' });
		expect(v.ok).toBe(false);
		expect(v.blockers.join()).toMatch(/not a 3-numbered Major\.Minor\.Patch/);
	});
	it('blocks a too-long description (>250)', () => {
		const v = validateManifest({ ...good, description: 'x'.repeat(251) });
		expect(v.blockers.join()).toMatch(/exceeds 250/);
	});
	it('requires the website_url FIELD to exist (empty allowed)', () => {
		const { website_url, ...noUrl } = good;
		void website_url;
		expect(validateManifest(noUrl).blockers.join()).toMatch(/website_url is required/);
	});
	it('blocks a malformed website_url', () => {
		expect(validateManifest({ ...good, website_url: 'not-a-url' }).blockers.join()).toMatch(/http\(s\) URL/);
	});
	it('requires dependencies + validates each entry, naming the index', () => {
		const { dependencies, ...noDeps } = good;
		void dependencies;
		expect(validateManifest(noDeps).blockers.join()).toMatch(/dependencies is required/);
		const bad = validateManifest({ ...good, dependencies: ['ok-Mod-1.0.0', 'garbage'] });
		expect(bad.blockers.join()).toMatch(/dependencies\[1\]/);
	});
});

// ── spec.ts: icon + readme ─────────────────────────────────────────────────────
describe('spec — readPngSize + validateIcon', () => {
	it('reads a 256×256 PNG and validates it', async () => {
		const { readFile } = await import('node:fs/promises');
		const bytes = new Uint8Array(await readFile(join(FIXTURE, 'icon.png')));
		const size = readPngSize(bytes);
		expect(size).toEqual({ width: ICON_SIZE, height: ICON_SIZE });
		expect(validateIcon(bytes).ok).toBe(true);
	});
	it('rejects non-PNG bytes honestly', () => {
		const v = validateIcon(new Uint8Array([1, 2, 3, 4, 5]));
		expect(v.ok).toBe(false);
		expect(v.blockers.join()).toMatch(/missing|not a valid PNG/);
	});
	it('rejects a wrong-size PNG with the exact dimensions', () => {
		// A 64×64 PNG header (signature + IHDR with width/height).
		const png = makePngHeader(64, 64);
		const v = validateIcon(png);
		expect(v.ok).toBe(false);
		expect(v.blockers.join()).toMatch(/256×256.*found 64×64/);
	});
	it('rejects a missing icon honestly', () => {
		expect(validateIcon(null).blockers.join()).toMatch(/icon\.png is missing/);
	});
});

describe('spec — validateReadme', () => {
	it('passes non-empty text, warns on empty, blocks missing', () => {
		expect(validateReadme('# Mod').ok).toBe(true);
		expect(validateReadme('   ').warnings.join()).toMatch(/empty/);
		expect(validateReadme(null).blockers.join()).toMatch(/README\.md is missing/);
	});
});

// ── zip.ts: a real, valid archive ──────────────────────────────────────────────
describe('zip — buildZip / listZip / crc32', () => {
	it('computes a known CRC-32', () => {
		// CRC32("123456789") = 0xCBF43926.
		expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
	});
	it('builds a zip whose central directory lists the exact entries + sizes', () => {
		const a = new TextEncoder().encode('hello');
		const b = new TextEncoder().encode('world!!');
		const zip = buildZip([
			{ path: 'manifest.json', data: a },
			{ path: 'plugins/Mod.dll', data: b }
		]);
		// Starts with a local file header signature.
		expect(zip[0]).toBe(0x50);
		expect(zip[1]).toBe(0x4b);
		const listing = listZip(zip);
		expect(listing).toEqual([
			{ path: 'manifest.json', size: 5 },
			{ path: 'plugins/Mod.dll', size: 7 }
		]);
	});
	it('is deterministic — same inputs yield byte-identical output', () => {
		const e = [{ path: 'a.txt', data: new Uint8Array([1, 2, 3]) }];
		expect(buildZip(e)).toEqual(buildZip(e));
	});
});

// ── api.ts: the real upload request shape ──────────────────────────────────────
describe('api — buildUploadPlan', () => {
	const manifest = {
		name: 'SwipRounds',
		version_number: '1.4.0',
		website_url: '',
		description: 'mod',
		dependencies: []
	};
	it('produces the exact 4-step Thunderstore upload flow with the secret REDACTED', () => {
		const plan = buildUploadPlan({
			manifest,
			config: { namespace: 'OperatorTeam', communities: ['rounds'] },
			zipFilename: 'SwipRounds-1.4.0.zip',
			zipSize: 1234,
			tokenPresent: false
		});
		expect(plan.requests.map((r) => r.step)).toEqual([
			'initiate-upload',
			'upload-parts',
			'finish-upload',
			'submit'
		]);
		expect(plan.apiBase).toBe(DEFAULT_API_BASE);
		// initiate carries the filename + size.
		expect(plan.requests[0].body).toEqual({ filename: 'SwipRounds-1.4.0.zip', file_size_bytes: 1234 });
		// submit carries the namespace + communities.
		expect(plan.requests[3].body).toMatchObject({ author_name: 'OperatorTeam', communities: ['rounds'] });
		// The Bearer header is the REDACTED placeholder — never a real value (D-026).
		expect(plan.requests[0].headers.Authorization).toBe(`Bearer ${REDACTED_SECRET}`);
		const rendered = JSON.stringify(plan);
		expect(rendered).not.toMatch(/secret|password|tok_/i);
	});
	it('honors a config.apiBase override (staging)', () => {
		const plan = buildUploadPlan({
			manifest,
			config: { apiBase: 'https://stage.example.com/' },
			zipFilename: 'x.zip',
			zipSize: 1,
			tokenPresent: true
		});
		expect(plan.requests[0].url).toBe('https://stage.example.com/api/experimental/usermedia/initiate-upload/');
	});
	it('planToSteps renders human lines without the secret', () => {
		const plan = buildUploadPlan({ manifest, config: {}, zipFilename: 'x.zip', zipSize: 1, tokenPresent: false });
		const steps = planToSteps(plan);
		expect(steps.length).toBe(4);
		expect(steps.join('\n')).not.toContain('Bearer ' + 'REAL');
	});
});

// ── adapter: probe / validate / package / publish against the fixture ───────────
describe('ThunderstorePublisherAdapter — contract harness', () => {
	it('passes the full publisher contract against the fixture mod', async () => {
		const report = await runPublisherContract(adapter(), { cwd: FIXTURE });
		expect(report.violations, JSON.stringify(report.violations)).toHaveLength(0);
		expect(report.ok).toBe(true);
	});
});

describe('ThunderstorePublisherAdapter — probe', () => {
	it('is available + names the target, honest about the missing token', async () => {
		const p = await adapter().probe({ cwd: FIXTURE, secrets: resolver() });
		expect(p.available).toBe(true);
		expect(p.target).toBe('thunderstore:SwipRounds');
		expect(p.reason).toMatch(new RegExp(THUNDERSTORE_SECRET));
	});
	it('is honestly unavailable with no manifest', async () => {
		const empty = await mkdtemp(join(tmpdir(), 'atelier-empty-'));
		const p = await adapter().probe({ cwd: empty, secrets: resolver() });
		expect(p.available).toBe(false);
		expect(p.reason).toMatch(/manifest\.json/);
		await rm(empty, { recursive: true, force: true });
	});
	it('is honestly unavailable when manifest.json is malformed JSON', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'atelier-badjson-'));
		await writeFile(join(dir, 'manifest.json'), '{ not json', 'utf8');
		const p = await adapter().probe({ cwd: dir, secrets: resolver() });
		expect(p.available).toBe(false);
		expect(p.reason).toMatch(/not valid JSON/);
		await rm(dir, { recursive: true, force: true });
	});
});

describe('ThunderstorePublisherAdapter — validate (preflight)', () => {
	it('passes the valid fixture (warns about the unset token + namespace)', async () => {
		const v = await adapter().validate({ projectId: 'project:x', cwd: FIXTURE, secrets: resolver() });
		expect(v.ok, JSON.stringify(v.blockers)).toBe(true);
		expect(v.warnings.join()).toMatch(new RegExp(THUNDERSTORE_SECRET));
		expect(v.warnings.join()).toMatch(/namespace/);
	});
	it('blocks a mod with a bad version + wrong-size icon, listing every blocker', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'atelier-bad-'));
		await writeFile(
			join(dir, 'manifest.json'),
			JSON.stringify({ name: 'Bad', version_number: '1.4', website_url: '', description: 'd', dependencies: [] }),
			'utf8'
		);
		await writeFile(join(dir, 'README.md'), '# Bad', 'utf8');
		await writeFile(join(dir, 'icon.png'), makePngHeader(64, 64));
		const v = await adapter().validate({ projectId: 'project:x', cwd: dir, secrets: resolver() });
		expect(v.ok).toBe(false);
		expect(v.blockers.join()).toMatch(/Major\.Minor\.Patch/);
		expect(v.blockers.join()).toMatch(/256×256.*found 64×64/);
		await rm(dir, { recursive: true, force: true });
	});
	it('blocks honestly when README.md + icon.png are missing', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'atelier-nofiles-'));
		await writeFile(
			join(dir, 'manifest.json'),
			JSON.stringify({ name: 'NoFiles', version_number: '1.0.0', website_url: '', description: 'd', dependencies: [] }),
			'utf8'
		);
		const v = await adapter().validate({ projectId: 'project:x', cwd: dir, secrets: resolver() });
		expect(v.ok).toBe(false);
		expect(v.blockers.join()).toMatch(/icon\.png is missing/);
		expect(v.blockers.join()).toMatch(/README\.md is missing/);
		await rm(dir, { recursive: true, force: true });
	});
});

describe('ThunderstorePublisherAdapter — package (real zip)', () => {
	it('assembles a real zip and lists its exact contents incl. the dll payload', async () => {
		const pkg = await adapter().package({ projectId: 'project:x', cwd: FIXTURE, dryRun: true, secrets: resolver() });
		expect(pkg.ok).toBe(true);
		expect(pkg.dryRun).toBe(true);
		expect(pkg.artifact).toEqual({ name: 'SwipRounds', version: '1.4.0' });
		const stepsText = pkg.steps.join('\n');
		// The three required root files + the payload dll appear in the contents listing.
		expect(stepsText).toMatch(/manifest\.json/);
		expect(stepsText).toMatch(/README\.md/);
		expect(stepsText).toMatch(/icon\.png/);
		expect(stepsText).toMatch(/plugins\/SwipRounds\.dll/);
		expect(pkg.summary).toMatch(/Assembled SwipRounds-1\.4\.0\.zip/);
	});
	it('reports honestly (ok:false) when the package is invalid — no fabricated success', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'atelier-invalid-'));
		await writeFile(join(dir, 'manifest.json'), JSON.stringify({ name: 'X' }), 'utf8');
		const pkg = await adapter().package({ projectId: 'project:x', cwd: dir, dryRun: true, secrets: resolver() });
		expect(pkg.ok).toBe(false);
		expect(pkg.summary).toMatch(/Package not assembled/);
		await rm(dir, { recursive: true, force: true });
	});
});

describe('ThunderstorePublisherAdapter — publish (dry-run + honest deferral)', () => {
	it('dry-run produces the exact upload request shape (secret redacted)', async () => {
		const res = await adapter().publish({
			projectId: 'project:x',
			cwd: work,
			dryRun: true,
			config: { namespace: 'OperatorTeam', communities: ['rounds'] },
			secrets: resolver()
		});
		expect(res.dryRun).toBe(true);
		expect(res.ok).toBe(true);
		const text = res.steps.join('\n');
		expect(text).toMatch(/initiate-upload/);
		expect(text).toMatch(/submission\/submit/);
		// The redacted-Bearer note appears in the step listing (the secret value never does).
		expect(text).toMatch(/Bearer token redacted/);
		// The summary names the auth secret + its presence (D-026 — presence only).
		expect(res.summary).toMatch(new RegExp(`Auth via ${THUNDERSTORE_SECRET}`));
		// No real secret value can leak.
		expect(JSON.stringify(res)).not.toMatch(/Bearer tok_/);
	});
	it('a real (non-dry-run) publish is HONEST-deferred — no external call, ok:false', async () => {
		const res = await adapter().publish({
			projectId: 'project:x',
			cwd: work,
			dryRun: false,
			config: { namespace: 'OperatorTeam' },
			secrets: resolver({ THUNDERSTORE_TOKEN: 'tok_live_value' })
		});
		expect(res.dryRun).toBe(false);
		expect(res.ok).toBe(false);
		expect(res.warnings.join(' ')).toMatch(/not performed in this track/);
		// The live secret value must NEVER appear in the result.
		expect(JSON.stringify(res)).not.toContain('tok_live_value');
	});
	it('warns when config.namespace is missing (required to submit)', async () => {
		const res = await adapter().publish({ projectId: 'project:x', cwd: work, dryRun: true, secrets: resolver() });
		expect(res.warnings.join()).toMatch(/namespace/);
	});
});

// A minimal valid PNG header (signature + IHDR) of the given size for size-validation tests.
function makePngHeader(w: number, h: number): Uint8Array {
	const buf = new Uint8Array(24);
	buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
	const dv = new DataView(buf.buffer);
	dv.setUint32(8, 13, false); // IHDR length
	buf.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
	dv.setUint32(16, w, false);
	dv.setUint32(20, h, false);
	return buf;
}
