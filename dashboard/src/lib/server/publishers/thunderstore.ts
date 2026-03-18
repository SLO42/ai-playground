/**
 * Thunderstore publisher.
 *
 * Packages BepInEx mods into the Thunderstore zip format and uploads
 * via the experimental submission API.
 *
 * Expected project layout:
 *   manifest.json   — Thunderstore manifest (name, version_number, dependencies, etc.)
 *   icon.png        — 256x256 mod icon
 *   README.md       — Mod description
 *   <dll files>     — Compiled plugin assemblies
 */
import { readFile, stat } from 'fs/promises';
import { basename, resolve } from 'path';
import { existsSync } from 'fs';
import type { ReleasePublisher, PublisherConfig, ReleaseInfo, PublishResult, PublisherValidation } from './types.js';

const SUBMIT_URL = 'https://thunderstore.io/api/experimental/submission/submit/';

export interface ThunderstorePublisherConfig extends PublisherConfig {
	/** Thunderstore API token. Falls back to env THUNDERSTORE_TOKEN. */
	authToken?: string;
	/** Community slug (e.g., 'lethal-company', 'valheim') */
	community?: string;
	/** Categories to tag the upload with */
	categories?: string[];
}

interface ThunderstoreManifest {
	name: string;
	version_number: string;
	website_url: string;
	description: string;
	dependencies: string[];
}

async function readManifest(projectPath: string): Promise<ThunderstoreManifest | null> {
	try {
		const raw = await readFile(resolve(projectPath, 'manifest.json'), 'utf-8');
		return JSON.parse(raw) as ThunderstoreManifest;
	} catch {
		return null;
	}
}

/**
 * Build a Thunderstore-compatible zip as a Buffer.
 *
 * Thunderstore zips require at minimum: manifest.json, icon.png, README.md.
 * We also include any artifacts (typically .dll files).
 *
 * Uses a minimal zip builder to avoid heavy dependencies. For production
 * usage you may want to swap in `archiver` or `jszip`.
 */
async function buildPackageZip(
	projectPath: string,
	artifacts: string[]
): Promise<{ buffer: Buffer; files: string[] }> {
	// Lazy-import JSZip-style approach using Node's built-in zlib
	// We'll build a simple zip using the undici/fetch approach
	const { createWriteStream } = await import('fs');
	const { pipeline } = await import('stream/promises');
	const { Readable } = await import('stream');

	// Collect required files
	const requiredFiles = ['manifest.json', 'icon.png', 'README.md'];
	const filesToPack: Array<{ name: string; data: Buffer }> = [];

	for (const name of requiredFiles) {
		const filePath = resolve(projectPath, name);
		if (existsSync(filePath)) {
			filesToPack.push({ name, data: await readFile(filePath) });
		}
	}

	// Add artifacts (dlls, etc.)
	for (const artifactPath of artifacts) {
		if (existsSync(artifactPath)) {
			filesToPack.push({
				name: basename(artifactPath),
				data: await readFile(artifactPath)
			});
		}
	}

	// Build a minimal zip using Node's zlib
	// For a real implementation, consider using 'archiver' package
	const zipBuffer = await buildMinimalZip(filesToPack);

	return {
		buffer: zipBuffer,
		files: filesToPack.map((f) => f.name)
	};
}

/**
 * Build a minimal ZIP file from in-memory entries.
 * Uses STORE method (no compression) for simplicity and reliability.
 */
async function buildMinimalZip(entries: Array<{ name: string; data: Buffer }>): Promise<Buffer> {
	const parts: Buffer[] = [];
	const centralDir: Buffer[] = [];
	let offset = 0;

	for (const entry of entries) {
		const nameBuffer = Buffer.from(entry.name, 'utf-8');
		const crc = crc32(entry.data);

		// Local file header
		const localHeader = Buffer.alloc(30 + nameBuffer.length);
		localHeader.writeUInt32LE(0x04034b50, 0);  // signature
		localHeader.writeUInt16LE(20, 4);           // version needed
		localHeader.writeUInt16LE(0, 6);            // flags
		localHeader.writeUInt16LE(0, 8);            // compression: STORE
		localHeader.writeUInt16LE(0, 10);           // mod time
		localHeader.writeUInt16LE(0, 12);           // mod date
		localHeader.writeUInt32LE(crc, 14);         // crc-32
		localHeader.writeUInt32LE(entry.data.length, 18); // compressed size
		localHeader.writeUInt32LE(entry.data.length, 22); // uncompressed size
		localHeader.writeUInt16LE(nameBuffer.length, 26); // file name length
		localHeader.writeUInt16LE(0, 28);           // extra field length
		nameBuffer.copy(localHeader, 30);

		parts.push(localHeader, entry.data);

		// Central directory entry
		const cdEntry = Buffer.alloc(46 + nameBuffer.length);
		cdEntry.writeUInt32LE(0x02014b50, 0);   // signature
		cdEntry.writeUInt16LE(20, 4);            // version made by
		cdEntry.writeUInt16LE(20, 6);            // version needed
		cdEntry.writeUInt16LE(0, 8);             // flags
		cdEntry.writeUInt16LE(0, 10);            // compression
		cdEntry.writeUInt16LE(0, 12);            // mod time
		cdEntry.writeUInt16LE(0, 14);            // mod date
		cdEntry.writeUInt32LE(crc, 16);          // crc-32
		cdEntry.writeUInt32LE(entry.data.length, 20); // compressed size
		cdEntry.writeUInt32LE(entry.data.length, 24); // uncompressed size
		cdEntry.writeUInt16LE(nameBuffer.length, 28); // file name length
		cdEntry.writeUInt16LE(0, 30);            // extra field length
		cdEntry.writeUInt16LE(0, 32);            // comment length
		cdEntry.writeUInt16LE(0, 34);            // disk number start
		cdEntry.writeUInt16LE(0, 36);            // internal attrs
		cdEntry.writeUInt32LE(0, 38);            // external attrs
		cdEntry.writeUInt32LE(offset, 42);       // local header offset
		nameBuffer.copy(cdEntry, 46);

		centralDir.push(cdEntry);
		offset += localHeader.length + entry.data.length;
	}

	const cdOffset = offset;
	const cdBuffers = Buffer.concat(centralDir);
	const cdSize = cdBuffers.length;

	// End of central directory
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);          // signature
	eocd.writeUInt16LE(0, 4);                    // disk number
	eocd.writeUInt16LE(0, 6);                    // disk with central dir
	eocd.writeUInt16LE(entries.length, 8);       // entries on this disk
	eocd.writeUInt16LE(entries.length, 10);      // total entries
	eocd.writeUInt32LE(cdSize, 12);              // central dir size
	eocd.writeUInt32LE(cdOffset, 16);            // central dir offset
	eocd.writeUInt16LE(0, 20);                   // comment length

	return Buffer.concat([...parts, cdBuffers, eocd]);
}

/** Simple CRC-32 implementation for zip file integrity. */
function crc32(buf: Buffer): number {
	let crc = 0xffffffff;
	for (let i = 0; i < buf.length; i++) {
		crc ^= buf[i];
		for (let j = 0; j < 8; j++) {
			crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

export const thunderstorePublisher: ReleasePublisher = {
	id: 'thunderstore',
	name: 'Thunderstore',
	platforms: ['thunderstore'],

	validate(config: PublisherConfig): PublisherValidation {
		const tsConfig = config as ThunderstorePublisherConfig;
		const errors: string[] = [];

		const token = tsConfig.authToken ?? process.env.THUNDERSTORE_TOKEN;
		if (!token) {
			errors.push('Missing auth token: set authToken in config or THUNDERSTORE_TOKEN env var');
		}

		if (!tsConfig.community) {
			errors.push('Missing community slug (e.g., "lethal-company")');
		}

		return { valid: errors.length === 0, errors };
	},

	async publish(release: ReleaseInfo, config: PublisherConfig, dryRun = false): Promise<PublishResult> {
		const tsConfig = config as ThunderstorePublisherConfig;

		// Read manifest for metadata
		const manifest = await readManifest(release.projectPath);
		if (!manifest) {
			return {
				success: false,
				error: 'No manifest.json found in project root',
				platform: 'thunderstore'
			};
		}

		// Validate required files
		const requiredFiles = ['icon.png', 'README.md', 'manifest.json'];
		const missing = requiredFiles.filter((f) => !existsSync(resolve(release.projectPath, f)));
		if (missing.length > 0) {
			return {
				success: false,
				error: `Missing required files: ${missing.join(', ')}`,
				platform: 'thunderstore'
			};
		}

		// Build package zip
		const pkg = await buildPackageZip(release.projectPath, release.artifacts);

		if (dryRun) {
			return {
				success: true,
				platform: 'thunderstore',
				dryRun: true,
				url: `(dry-run) would upload ${manifest.name} v${release.version} with files: ${pkg.files.join(', ')}`
			};
		}

		// Upload to Thunderstore
		const token = tsConfig.authToken ?? process.env.THUNDERSTORE_TOKEN;
		if (!token) {
			return { success: false, error: 'No auth token available', platform: 'thunderstore' };
		}

		try {
			const namespace = tsConfig.namespace ?? manifest.name.split('-')[0] ?? 'Unknown';
			const formData = new FormData();

			formData.append('metadata', JSON.stringify({
				upload_uuid: crypto.randomUUID(),
				author_name: namespace,
				categories: tsConfig.categories ?? [],
				communities: [tsConfig.community],
				has_nsfw_content: false
			}));

			formData.append('file', new Blob([pkg.buffer], { type: 'application/zip' }), `${manifest.name}.zip`);

			const response = await fetch(SUBMIT_URL, {
				method: 'POST',
				headers: { Authorization: `Bearer ${token}` },
				body: formData
			});

			if (!response.ok) {
				const body = await response.text();
				return {
					success: false,
					error: `Thunderstore API error ${response.status}: ${body}`,
					platform: 'thunderstore'
				};
			}

			const result = await response.json() as { package_version?: { download_url?: string } };
			return {
				success: true,
				url: result.package_version?.download_url ?? undefined,
				platform: 'thunderstore'
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { success: false, error: msg, platform: 'thunderstore' };
		}
	}
};
