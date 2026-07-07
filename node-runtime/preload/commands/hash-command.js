'use strict';
// ============================================================================
// Hashing coreutils on node:crypto (native OpenSSL — works under jitless, no WASM).
//
// just-bash 3.x ships ONLY md5sum. Claude routinely reaches for sha256sum (lock
// files, integrity checks, "verify this download"), sha1sum, and the BSD/macOS
// `shasum -a N`. These implement the GNU coreutils surface:
//
//   sha256sum / sha1sum / sha512sum / sha384sum / sha224sum / md5sum
//     [FILE...]            hash each file (or stdin if none / '-')
//     -b/--binary          mark with '*' (default text ' ')
//     -c/--check FILE      read "<hex>  <name>" lines and verify
//     --tag                BSD-style output:  SHA256 (file) = hex
//     --quiet              with -c, suppress OK lines
//     --status             with -c, no output, exit code only
//     -                    read stdin
//   shasum [-a 1|224|256|384|512] [FILE...]   BSD alias → default sha1
//
// Output format matches coreutils exactly: "<hex><space><space|*><name>\n"
// (two spaces + space for text mode, two spaces + '*' for binary). Reads through
// real node fs rooted at the shell cwd, with the shared /tmp redirect.
// ============================================================================

const crypto = require('node:crypto');
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

function hashBuf(algo, buf) { return crypto.createHash(algo).update(buf).digest('hex'); }

// Shared engine. `algo` is a node hash name; `label` is the BSD tag (SHA256/MD5…).
function hashMain(algo, label, args, ctx) {
  let binary = false, check = false, quiet = false, status = false, tag = false;
  const files = [];
  const errs = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { for (let j = i + 1; j < args.length; j++) files.push(args[j]); break; }
    if (a === '-b' || a === '--binary') { binary = true; continue; }
    if (a === '-t' || a === '--text') { binary = false; continue; }
    if (a === '-c' || a === '--check') { check = true; continue; }
    if (a === '--quiet') { quiet = true; continue; }
    if (a === '--status') { status = true; continue; }
    if (a === '--tag') { tag = true; continue; }
    if (a === '--help') return ok(`Usage: ${label.toLowerCase()}sum [OPTION]... [FILE]...\nPrint or check ${label} checksums.\n`);
    if (a && a.startsWith('-') && a !== '-') { errs.push(`${label.toLowerCase()}sum: unknown option ${a}`); continue; }
    files.push(a);
  }

  const readInput = (name) => {
    if (name === '-' || name == null) return { buf: stdinBuf(ctx), name: '-' };
    return { buf: nodeFs.readFileSync(realPath(ctx, name)), name };
  };

  // -c / --check mode: verify a checksum file.
  if (check) {
    const src = files.length ? files : ['-'];
    let out = '', err = '';
    let anyFail = false, anyRead = false;
    for (const cf of src) {
      let text;
      try { text = readInput(cf).buf.toString('utf8'); }
      catch (e) { err += `${label.toLowerCase()}sum: ${cf}: No such file or directory\n`; anyFail = true; continue; }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        // formats:  "<hex>  name"  |  "<hex> *name"  |  "LABEL (name) = hex"
        let expHex, name;
        const bsd = line.match(/^\w+\s*\(([^)]+)\)\s*=\s*([0-9a-fA-F]+)\s*$/);
        if (bsd) { name = bsd[1]; expHex = bsd[2].toLowerCase(); }
        else {
          const m = line.match(/^([0-9a-fA-F]+)\s[ *](.+)$/);
          if (!m) continue;
          expHex = m[1].toLowerCase(); name = m[2];
        }
        anyRead = true;
        let got;
        try { got = hashBuf(algo, readInput(name).buf); }
        catch { if (!status) out += `${name}: FAILED open or read\n`; anyFail = true; continue; }
        if (got === expHex) { if (!status && !quiet) out += `${name}: OK\n`; }
        else { if (!status) out += `${name}: FAILED\n`; anyFail = true; }
      }
    }
    if (!anyRead && !anyFail) return ok(out, 1, err + `${label.toLowerCase()}sum: no properly formatted checksum lines found\n`);
    return ok(out, anyFail ? 1 : 0, err);
  }

  // Hash mode.
  const src = files.length ? files : ['-'];
  let out = '', err = '';
  let code = errs.length ? 1 : 0;
  if (errs.length) err += errs.join('\n') + '\n';
  for (const f of src) {
    let buf, name;
    try { ({ buf, name } = readInput(f)); }
    catch (e) {
      const why = (e && e.code === 'EISDIR') ? 'Is a directory' : 'No such file or directory';
      err += `${label.toLowerCase()}sum: ${f}: ${why}\n`; code = 1; continue;
    }
    const hex = hashBuf(algo, buf);
    if (tag) out += `${label} (${name}) = ${hex}\n`;
    else out += `${hex} ${binary ? '*' : ' '}${name}\n`;
  }
  return ok(out, code, err);
}

// shasum [-a N] — BSD tool, default sha1.
function shasumMain(args, ctx) {
  let algo = 'sha1', label = 'SHA1';
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-a' || a === '--algorithm') {
      const n = args[i + 1]; i++;
      const map = { '1': ['sha1', 'SHA1'], '224': ['sha224', 'SHA224'], '256': ['sha256', 'SHA256'], '384': ['sha384', 'SHA384'], '512': ['sha512', 'SHA512'] };
      if (map[n]) { algo = map[n][0]; label = map[n][1]; }
      continue;
    }
    if (/^-a\d+$/.test(a)) { const n = a.slice(2); const map = { '1': ['sha1', 'SHA1'], '224': ['sha224', 'SHA224'], '256': ['sha256', 'SHA256'], '384': ['sha384', 'SHA384'], '512': ['sha512', 'SHA512'] }; if (map[n]) { algo = map[n][0]; label = map[n][1]; } continue; }
    rest.push(a);
  }
  return hashMain(algo, label, rest, ctx);
}

const ALGOS = [
  ['md5sum', 'md5', 'MD5'],
  ['sha1sum', 'sha1', 'SHA1'],
  ['sha224sum', 'sha224', 'SHA224'],
  ['sha256sum', 'sha256', 'SHA256'],
  ['sha384sum', 'sha384', 'SHA384'],
  ['sha512sum', 'sha512', 'SHA512'],
];

function registerHashes(bash, injectedDefineCommand) {
  let defineCommand = injectedDefineCommand;
  if (typeof defineCommand !== 'function') { try { ({ defineCommand } = require('just-bash')); } catch { return; } }
  if (typeof defineCommand !== 'function') return;
  for (const [name, algo, label] of ALGOS) {
    // md5sum already ships in just-bash and works; skip it to avoid shadowing the
    // (identical-behaving) native builtin — but registering ours is harmless too.
    if (name === 'md5sum') continue;
    try { bash.registerCommand(defineCommand(name, async (args, ctx) => hashMain(algo, label, args, ctx))); } catch { /* skip */ }
  }
  try { bash.registerCommand(defineCommand('shasum', async (args, ctx) => shasumMain(args, ctx))); } catch { /* skip */ }
}

module.exports = { registerHashes, hashMain, shasumMain };
