'use strict';
// ============================================================================
// xxd — hex dump + reverse, pure JS on node Buffers.
//
// just-bash ships `od` but not `xxd`, and its `od` mishandles GNU-style
// `-A x -t x1` addressing here. xxd is the tool Claude actually reaches for to
// inspect binary files / build hex patches. Implements the common surface:
//
//   xxd [FILE]              canonical hex+ASCII dump (16 bytes/line)
//   xxd -                   read stdin
//   -c N / --cols N         bytes per line (default 16)
//   -g N / --groupsize N    byte grouping (default 2)
//   -l N / --len N          dump at most N bytes
//   -s OFFSET               start at byte OFFSET (supports 0x.., +N)
//   -u                      uppercase hex
//   -p / --plain            plain postscript-style continuous hex (no addr/ascii)
//   -i / --include          C `unsigned char[]` array + length
//   -r                      reverse: hex dump → binary (canonical or -p)
//   -o OFFSET               add OFFSET to displayed addresses
//
// Reads/writes through real node fs rooted at the shell cwd (shared /tmp map).
// ============================================================================

const nodeFs = require('node:fs');
const nodePath = require('node:path');

let mapTmpAbs, resolveTarget;
try { ({ mapTmpAbs, resolveTarget } = require('./tmp-map.js')); }
catch { mapTmpAbs = (abs) => abs; resolveTarget = () => null; }

function ok(stdout = '', exitCode = 0, stderr = '') { return { stdout, stderr, exitCode }; }
function envOf(ctx) { return Object.assign({}, (ctx && ctx.exportedEnv) || {}, (ctx && ctx.env) || {}); }
function cwdOf(ctx) { const e = envOf(ctx); return e.PWD || (ctx && ctx.cwd) || process.cwd(); }
function realPath(ctx, operand) {
  const abs = nodePath.resolve(cwdOf(ctx), operand);
  const target = resolveTarget();
  return target ? mapTmpAbs(nodePath.normalize(abs), target) : nodePath.normalize(abs);
}
function stdinBuf(ctx) {
  if (ctx && ctx.stdin != null) return Buffer.isBuffer(ctx.stdin) ? ctx.stdin : Buffer.from(String(ctx.stdin));
  return Buffer.alloc(0);
}
function parseNum(s) {
  if (s == null) return NaN;
  s = String(s).trim();
  let sign = 1;
  if (s[0] === '+') s = s.slice(1);
  if (/^0x/i.test(s)) return sign * parseInt(s, 16);
  return sign * parseInt(s, 10);
}

function toHex(byte, upper) {
  const h = byte.toString(16).padStart(2, '0');
  return upper ? h.toUpperCase() : h;
}

function xxdMain(args, ctx) {
  let cols = null, group = null, len = null, seek = 0, addOff = 0;
  let upper = false, plain = false, include = false, reverse = false, ebcdic = false;
  let inFile = null, outFile = null;
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { for (let j = i + 1; j < args.length; j++) positional.push(args[j]); break; }
    if (a === '-c' || a === '--cols') { cols = parseNum(args[++i]); continue; }
    if (a === '-g' || a === '--groupsize') { group = parseNum(args[++i]); continue; }
    if (a === '-l' || a === '--len') { len = parseNum(args[++i]); continue; }
    if (a === '-s' || a === '--seek') { seek = parseNum(args[++i]); continue; }
    if (a === '-o') { addOff = parseNum(args[++i]); continue; }
    if (a === '-u') { upper = true; continue; }
    if (a === '-p' || a === '--plain' || a === '-ps') { plain = true; continue; }
    if (a === '-i' || a === '--include') { include = true; continue; }
    if (a === '-r' || a === '--revert') { reverse = true; continue; }
    if (a === '-E') { ebcdic = true; continue; }
    if (a === '--help' || a === '-h') return ok('Usage: xxd [options] [infile [outfile]]\n  -c cols  -g group  -l len  -s seek  -u  -p  -i  -r  -o off\n');
    if (a && a.startsWith('-') && a !== '-') { /* ignore unknown */ continue; }
    positional.push(a);
  }
  inFile = positional[0] != null ? positional[0] : '-';
  outFile = positional[1] != null ? positional[1] : null;

  // ---- reverse: hex text -> binary --------------------------------------
  if (reverse) {
    let text;
    try { text = (inFile === '-' ? stdinBuf(ctx) : nodeFs.readFileSync(realPath(ctx, inFile))).toString('utf8'); }
    catch (e) { return ok('', 1, `xxd: ${inFile}: No such file or directory\n`); }
    let bytes;
    if (plain) {
      const hex = text.replace(/[^0-9a-fA-F]/g, '');
      bytes = Buffer.from(hex.length % 2 ? hex.slice(0, -1) : hex, 'hex');
    } else {
      // canonical: "<addr>: <hex bytes>  <ascii>" — take the hex column between ':' and the double-space gutter
      const out = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        const colon = line.indexOf(':');
        let rest = colon >= 0 ? line.slice(colon + 1) : line;
        // strip trailing ASCII gutter (two+ spaces then printable chars) — cut at the first run of 2+ spaces AFTER hex
        const gutter = rest.search(/ {2,}\S/);
        if (gutter >= 0) rest = rest.slice(0, gutter);
        const hex = rest.replace(/[^0-9a-fA-F]/g, '');
        out.push(Buffer.from(hex.length % 2 ? hex.slice(0, -1) : hex, 'hex'));
      }
      bytes = Buffer.concat(out);
    }
    if (outFile) { try { nodeFs.mkdirSync(nodePath.dirname(realPath(ctx, outFile)), { recursive: true }); } catch {} nodeFs.writeFileSync(realPath(ctx, outFile), bytes); return ok(''); }
    return ok(bytes.toString('binary'));
  }

  // ---- forward: read input ----------------------------------------------
  let buf;
  try { buf = inFile === '-' ? stdinBuf(ctx) : nodeFs.readFileSync(realPath(ctx, inFile)); }
  catch (e) { return ok('', 1, `xxd: ${inFile}: No such file or directory\n`); }

  if (seek && seek > 0) buf = buf.subarray(Math.min(seek, buf.length));
  if (len != null && len >= 0) buf = buf.subarray(0, len);

  // ---- -i : C include ---------------------------------------------------
  if (include) {
    const varName = (inFile && inFile !== '-') ? inFile.replace(/[^a-zA-Z0-9]/g, '_') : '__stdin';
    const perLine = cols || 12;
    let s = `unsigned char ${varName}[] = {\n`;
    const lines = [];
    for (let i = 0; i < buf.length; i += perLine) {
      const chunk = [];
      for (let j = i; j < Math.min(i + perLine, buf.length); j++) chunk.push('0x' + toHex(buf[j], upper));
      lines.push('  ' + chunk.join(', '));
    }
    s += lines.join(',\n') + (buf.length ? '\n' : '');
    s += `};\nunsigned int ${varName}_len = ${buf.length};\n`;
    return ok(s);
  }

  // ---- -p : plain continuous hex ----------------------------------------
  if (plain) {
    const perLine = cols || 30;
    let s = '';
    let hexStr = '';
    for (let i = 0; i < buf.length; i++) hexStr += toHex(buf[i], upper);
    // wrap every perLine bytes (2 hex chars each)
    for (let i = 0; i < hexStr.length; i += perLine * 2) s += hexStr.slice(i, i + perLine * 2) + '\n';
    if (!buf.length) s = '';
    return ok(s);
  }

  // ---- canonical dump ---------------------------------------------------
  const perLine = cols || 16;
  const g = group != null ? group : 2;
  // Fixed hex-column width so the ASCII gutter aligns even on the short last
  // line. Width = 2 chars/byte * perLine + one space per completed group.
  // With g<=0 (no grouping) real xxd still separates octets; we emit a single
  // trailing space to match the "one blob + space" shape.
  const groups = g > 0 ? Math.ceil(perLine / g) : 1;
  const hexColWidth = perLine * 2 + groups;
  let out = '';
  for (let i = 0; i < buf.length; i += perLine) {
    const slice = buf.subarray(i, Math.min(i + perLine, buf.length));
    const addr = (i + addOff).toString(16).padStart(8, '0');
    let hexCol = '';
    for (let j = 0; j < perLine; j++) {
      hexCol += (j < slice.length) ? toHex(slice[j], upper) : '  ';
      if (g > 0 && ((j + 1) % g === 0)) hexCol += ' ';
    }
    if (g <= 0) hexCol += ' ';
    hexCol = hexCol.padEnd(hexColWidth, ' ');
    let ascii = '';
    for (let j = 0; j < slice.length; j++) {
      const c = slice[j];
      ascii += (c >= 0x20 && c <= 0x7e) ? String.fromCharCode(c) : '.';
    }
    out += `${addr}: ${hexCol} ${ascii}\n`;
  }
  return ok(out);
}

function registerXxd(bash, injectedDefineCommand) {
  let defineCommand = injectedDefineCommand;
  if (typeof defineCommand !== 'function') { try { ({ defineCommand } = require('just-bash')); } catch { return; } }
  if (typeof defineCommand !== 'function') return;
  try { bash.registerCommand(defineCommand('xxd', async (args, ctx) => xxdMain(args, ctx))); } catch { /* skip */ }
}

module.exports = { registerXxd, xxdMain };
