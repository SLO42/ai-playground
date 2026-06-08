import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
	SURREAL_BINARY_SHA256,
	sha256OfFile,
	verifyBinary,
	BinaryIntegrityError
} from './binary';

// SEC-009 / D-006 / F-006: the provisioned SurrealDB server binary MUST be
// SHA-256-verified against the pinned hash before first spawn. A mismatch
// (tampered binary, wrong artifact) MUST fail hard — never run an unverified one.

let dir: string;
let goodPath: string; // a file whose hash we pin to (stands in for the real binary)
let tamperedPath: string; // same name pattern, wrong bytes -> wrong hash
let goodHash: string;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'binverify-'));
	goodPath = join(dir, 'surreal-good.exe');
	tamperedPath = join(dir, 'surreal-tampered.exe');

	const goodBytes = Buffer.from('PINNED-SURREAL-BINARY-CONTENT-v2.6.5');
	writeFileSync(goodPath, goodBytes);
	goodHash = createHash('sha256').update(goodBytes).digest('hex');

	// One byte different -> a different SHA-256 (simulates tamper / wrong artifact).
	writeFileSync(tamperedPath, Buffer.from('PINNED-SURREAL-BINARY-CONTENT-v2.6.6'));
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe('SURREAL_BINARY_SHA256 pin', () => {
	it('is the canonical 64-char lowercase hex of the pinned 2.6.5 server', () => {
		expect(SURREAL_BINARY_SHA256).toMatch(/^[0-9a-f]{64}$/);
		// The hash recorded alongside the version pin (DECISIONS D-006 / SPIKE-RESULTS),
		// stored lowercase in code.
		expect(SURREAL_BINARY_SHA256).toBe(
			'dd9b6fa15edacbde96d490dd5727b49b5cf40df80f29074c7dc17acb974f509f'
		);
	});
});

describe('sha256OfFile', () => {
	it('computes the SHA-256 hex digest of a file', async () => {
		await expect(sha256OfFile(goodPath)).resolves.toBe(goodHash);
	});
});

describe('verifyBinary (fail hard on mismatch — SEC-009)', () => {
	it('accepts a binary whose hash matches the expected pin', async () => {
		await expect(verifyBinary(goodPath, goodHash)).resolves.toBe(goodHash);
	});

	it('REJECTS a tampered/mismatched binary by throwing BinaryIntegrityError', async () => {
		await expect(verifyBinary(tamperedPath, goodHash)).rejects.toBeInstanceOf(
			BinaryIntegrityError
		);
	});

	it('rejects a missing binary path (never silently passes)', async () => {
		await expect(
			verifyBinary(join(dir, 'does-not-exist.exe'), goodHash)
		).rejects.toBeInstanceOf(BinaryIntegrityError);
	});

	it('is case-insensitive on the expected hash but reports lowercase', async () => {
		await expect(verifyBinary(goodPath, goodHash.toUpperCase())).resolves.toBe(goodHash);
	});

	it('error message names the file and both hashes for forensics', async () => {
		await expect(verifyBinary(tamperedPath, goodHash)).rejects.toThrow(/expected/i);
		await expect(verifyBinary(tamperedPath, goodHash)).rejects.toThrow(/sha-?256/i);
	});
});
