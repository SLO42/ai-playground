// SurrealDB server-binary integrity verification.
// SEC-009 / D-006 / F-006: the provisioned binary MUST be SHA-256-verified
// against a pinned hash BEFORE first spawn. On mismatch we fail hard — never
// run an unverified artifact. Download is official-source-over-HTTPS only;
// this module is the gate that runs at provisioning/startup time.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/**
 * Pinned SHA-256 of the SurrealDB 2.6.5 windows-amd64 server binary, recorded
 * alongside the version pin (DECISIONS D-006, spikes/SPIKE-RESULTS.md).
 * Stored lowercase; compared case-insensitively.
 */
export const SURREAL_BINARY_SHA256 =
	'dd9b6fa15edacbde96d490dd5727b49b5cf40df80f29074c7dc17acb974f509f';

/** Thrown when a provisioned binary fails integrity verification. Fail hard. */
export class BinaryIntegrityError extends Error {
	override readonly name = 'BinaryIntegrityError';
	constructor(
		message: string,
		readonly path: string,
		readonly expected: string,
		readonly actual: string | null
	) {
		super(message);
	}
}

/** Stream-hash a file with SHA-256, returning the lowercase hex digest. */
export function sha256OfFile(filePath: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash('sha256');
		const stream = createReadStream(filePath);
		stream.on('error', reject);
		stream.on('data', (chunk) => hash.update(chunk));
		stream.on('end', () => resolve(hash.digest('hex')));
	});
}

/**
 * Verify a binary against an expected SHA-256. Resolves with the (lowercase)
 * actual hash on a match; rejects with {@link BinaryIntegrityError} on any
 * mismatch, unreadable file, or malformed expected hash. Never silently passes.
 *
 * @param filePath absolute path to the binary
 * @param expectedHash pinned SHA-256 (case-insensitive); defaults to the pin
 */
export async function verifyBinary(
	filePath: string,
	expectedHash: string = SURREAL_BINARY_SHA256
): Promise<string> {
	const expected = expectedHash.trim().toLowerCase();
	if (!/^[0-9a-f]{64}$/.test(expected)) {
		throw new BinaryIntegrityError(
			`Malformed expected SHA-256 for "${filePath}": not 64 hex chars`,
			filePath,
			expected,
			null
		);
	}

	let actual: string;
	try {
		actual = await sha256OfFile(filePath);
	} catch (cause) {
		throw new BinaryIntegrityError(
			`Cannot read binary for SHA-256 verification: "${filePath}" (${
				(cause as Error)?.message ?? cause
			})`,
			filePath,
			expected,
			null
		);
	}

	if (actual !== expected) {
		throw new BinaryIntegrityError(
			`SHA-256 mismatch for "${filePath}": expected ${expected}, got ${actual}. ` +
				`Refusing to spawn an unverified SurrealDB binary (SEC-009).`,
			filePath,
			expected,
			actual
		);
	}

	return actual;
}
