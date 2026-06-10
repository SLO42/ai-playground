// TASK 12.2 — a minimal, dependency-free ZIP writer (STORE method, no compression).
//
// Thunderstore accepts a standard zip. We have NO zip dependency installed and DON'T want to add
// one for a deterministic, store-only archive (the SWIP/ROUNDS payloads are already-compressed
// dll bytes, so STORE costs little). This writes a spec-correct ZIP (PKWARE APPNOTE):
//   • one Local File Header + data per entry,
//   • a Central Directory with one record per entry,
//   • an End Of Central Directory record.
// CRC-32 (IEEE) is computed per entry. Method 0 = STORE (size == compressed size). Output is
// DETERMINISTIC (fixed DOS timestamp) so packaging the same inputs yields byte-identical zips —
// which makes the package tests assert exact contents.
//
// This is intentionally small + auditable rather than a general-purpose zip lib: it covers exactly
// what a Thunderstore package needs (small set of root files + a payload dir), nothing more.

/** One file to place in the zip. `path` uses forward slashes (zip convention). */
export interface ZipEntry {
	path: string;
	data: Uint8Array;
}

/** A precomputed CRC-32 (IEEE 802.3) table. */
const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

/** CRC-32 of a byte buffer (IEEE). */
export function crc32(buf: Uint8Array): number {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

/** A tiny growable little-endian byte writer. */
class ByteWriter {
	#parts: Uint8Array[] = [];
	#len = 0;
	get length(): number {
		return this.#len;
	}
	push(buf: Uint8Array): void {
		this.#parts.push(buf);
		this.#len += buf.length;
	}
	u16(n: number): void {
		const b = new Uint8Array(2);
		new DataView(b.buffer).setUint16(0, n & 0xffff, true);
		this.push(b);
	}
	u32(n: number): void {
		const b = new Uint8Array(4);
		new DataView(b.buffer).setUint32(0, n >>> 0, true);
		this.push(b);
	}
	concat(): Uint8Array {
		const out = new Uint8Array(this.#len);
		let off = 0;
		for (const p of this.#parts) {
			out.set(p, off);
			off += p.length;
		}
		return out;
	}
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

// A fixed, valid DOS date/time (2021-01-01 00:00:00) so output is deterministic.
const DOS_TIME = 0;
const DOS_DATE = ((2021 - 1980) << 9) | (1 << 5) | 1;

/**
 * Build a valid ZIP archive (STORE, no compression) from the given entries, in the order given.
 * Deterministic for fixed inputs. The bit-3 "use UTF-8 names" flag (0x0800) is set so non-ASCII
 * paths are interpreted correctly.
 */
export function buildZip(entries: ZipEntry[]): Uint8Array {
	const out = new ByteWriter();
	const central: Array<{ entry: ZipEntry; crc: number; offset: number; nameBytes: Uint8Array }> = [];

	for (const entry of entries) {
		const nameBytes = utf8(entry.path);
		const crc = crc32(entry.data);
		const offset = out.length;

		// ── Local file header ──
		out.u32(0x04034b50); // signature
		out.u16(20); // version needed (2.0)
		out.u16(0x0800); // general purpose bit flag: UTF-8 names
		out.u16(0); // compression method 0 = STORE
		out.u16(DOS_TIME);
		out.u16(DOS_DATE);
		out.u32(crc);
		out.u32(entry.data.length); // compressed size (== uncompressed for STORE)
		out.u32(entry.data.length); // uncompressed size
		out.u16(nameBytes.length); // file name length
		out.u16(0); // extra field length
		out.push(nameBytes);
		out.push(entry.data);

		central.push({ entry, crc, offset, nameBytes });
	}

	// ── Central directory ──
	const cdStart = out.length;
	for (const c of central) {
		out.u32(0x02014b50); // central file header signature
		out.u16(20); // version made by
		out.u16(20); // version needed
		out.u16(0x0800); // UTF-8 names
		out.u16(0); // method STORE
		out.u16(DOS_TIME);
		out.u16(DOS_DATE);
		out.u32(c.crc);
		out.u32(c.entry.data.length); // compressed size
		out.u32(c.entry.data.length); // uncompressed size
		out.u16(c.nameBytes.length); // file name length
		out.u16(0); // extra length
		out.u16(0); // comment length
		out.u16(0); // disk number start
		out.u16(0); // internal attrs
		out.u32(0); // external attrs
		out.u32(c.offset); // local header offset
		out.push(c.nameBytes);
	}
	const cdSize = out.length - cdStart;

	// ── End of central directory ──
	out.u32(0x06054b50); // EOCD signature
	out.u16(0); // disk number
	out.u16(0); // cd start disk
	out.u16(central.length); // entries on this disk
	out.u16(central.length); // total entries
	out.u32(cdSize);
	out.u32(cdStart);
	out.u16(0); // comment length

	return out.concat();
}

/** A parsed central-directory listing (path + uncompressed size) — used to PROVE zip contents. */
export interface ZipListing {
	path: string;
	size: number;
}

/**
 * List a STORE-method zip's entries by reading its central directory. Minimal reader used by the
 * tests + the surface to PROVE the produced archive's contents (path + size). Returns [] when the
 * EOCD is not found (an honest "could not read" rather than a throw).
 */
export function listZip(bytes: Uint8Array): ZipListing[] {
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	// Find the EOCD signature scanning backwards (no zip comment, so it is near the end).
	let eocd = -1;
	for (let i = bytes.length - 22; i >= 0; i--) {
		if (dv.getUint32(i, true) === 0x06054b50) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) return [];
	const total = dv.getUint16(eocd + 10, true);
	let off = dv.getUint32(eocd + 16, true); // central dir offset
	const listing: ZipListing[] = [];
	for (let n = 0; n < total; n++) {
		if (dv.getUint32(off, true) !== 0x02014b50) break;
		const size = dv.getUint32(off + 24, true); // uncompressed size
		const nameLen = dv.getUint16(off + 28, true);
		const extraLen = dv.getUint16(off + 30, true);
		const commentLen = dv.getUint16(off + 32, true);
		const nameBytes = bytes.subarray(off + 46, off + 46 + nameLen);
		listing.push({ path: new TextDecoder().decode(nameBytes), size });
		off += 46 + nameLen + extraLen + commentLen;
	}
	return listing;
}
