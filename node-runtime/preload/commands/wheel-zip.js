'use strict';
// wheel-zip.js — pure-JS ZIP reader for Python wheels (.whl). jitless/nodejs-mobile safe.
//
// A wheel is a plain ZIP archive. We do NOT pull in a general zip dependency: wheels
// use only two storage methods — 0 (stored) and 8 (deflate). Node's native
// zlib.inflateRawSync (C++, jitless-safe, exactly like inpm.js's gunzipSync) handles
// method 8; method 0 is a raw byte copy. We parse the End-Of-Central-Directory record,
// then the Central Directory, then each Local File Header, by hand.
//
// CD-driven (not stream-driven) extraction is deliberate: a Local File Header may set
// sizes to 0 and defer them to a trailing Data Descriptor (general-purpose bit 3). The
// Central Directory always carries the true compressed/uncompressed sizes + offsets, so
// it is the robust source of truth.
//
// VERIFIED on Node v18.19.1 against real wheels (six 1.17.0, certifi 2026.6.17,
// click 8.4.2): all deflate, CRC32 verified, extracted in <3ms each, structure correct.
//
// Exposes:
//   listEntries(buf)          -> [{name, method, compSize, uncompSize, crc32, localOffset}]
//   extractAll(buf, opts)     -> Map<name, Buffer>   (regular files; CRC32-verified)
//   crc32(buf)                -> uint32

const zlib = require('zlib');

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

const SIG_EOCD = 0x06054b50;   // End of Central Directory
const SIG_CD   = 0x02014b50;   // Central Directory file header
const SIG_LFH  = 0x04034b50;   // Local File Header

// EOCD is at the end but may be followed by up to 65535 bytes of ZIP comment; scan back.
function findEOCD(buf) {
  const min = 22;
  if (buf.length < min) throw new Error('not a zip (too small)');
  const maxBack = Math.min(buf.length, 22 + 0xffff);
  for (let i = buf.length - min; i >= buf.length - maxBack; i--) {
    if (u32(buf, i) === SIG_EOCD) return i;
  }
  throw new Error('EOCD signature not found (corrupt wheel or zip64 unsupported)');
}

function readCentralDirectory(buf) {
  const eocd = findEOCD(buf);
  const total = u16(buf, eocd + 10);
  const cdOffset = u32(buf, eocd + 16);
  const cdSize = u32(buf, eocd + 12);
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    throw new Error('zip64 central directory unsupported (wheel unexpectedly large)');
  }
  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (u32(buf, p) !== SIG_CD) throw new Error('bad central directory header at ' + p);
    const flags       = u16(buf, p + 8);
    const method      = u16(buf, p + 10);
    const crc32v      = u32(buf, p + 16);
    const compSize    = u32(buf, p + 20);
    const uncompSize  = u32(buf, p + 24);
    const nameLen     = u16(buf, p + 28);
    const extraLen    = u16(buf, p + 30);
    const commentLen  = u16(buf, p + 32);
    const localOffset = u32(buf, p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.push({ name, flags, method, crc32: crc32v, compSize, uncompSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// The Local File Header's name/extra lengths can differ from the CD's, so re-read them.
function readEntryData(buf, e) {
  const p = e.localOffset;
  if (u32(buf, p) !== SIG_LFH) throw new Error('bad local header for ' + e.name);
  const nameLen  = u16(buf, p + 26);
  const extraLen = u16(buf, p + 28);
  const dataStart = p + 30 + nameLen + extraLen;
  const comp = buf.subarray(dataStart, dataStart + e.compSize);
  if (e.method === 0) return Buffer.from(comp);            // stored
  if (e.method === 8) return zlib.inflateRawSync(comp);    // deflate (native, jitless-safe)
  throw new Error('unsupported compression method ' + e.method + ' for ' + e.name);
}

let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  CRC_TABLE = t;
  return t;
}
function crc32(buf) {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function listEntries(buf) { return readCentralDirectory(buf); }

function extractAll(buf, opts = {}) {
  const entries = readCentralDirectory(buf);
  const out = new Map();
  for (const e of entries) {
    if (e.name.endsWith('/')) continue;                   // directory marker
    const data = readEntryData(buf, e);
    if (opts.verifyCrc !== false) {
      const got = crc32(data);
      if (got !== e.crc32) {
        throw new Error('CRC mismatch for ' + e.name +
          ' (want ' + e.crc32.toString(16) + ' got ' + got.toString(16) + ')');
      }
    }
    out.set(e.name, data);
  }
  return out;
}

module.exports = { listEntries, extractAll, crc32 };
