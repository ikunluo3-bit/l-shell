'use strict';
// Enhanced `cat` for just-bash on iOS L Shell.
//
// just-bash's built-in `cat` only understands -n / --number (verified on device
// and on Node 18). GNU coreutils cat that Claude expects also has:
//   -b/--number-nonblank, -A/--show-all, -E/--show-ends, -T/--show-tabs,
//   -s/--squeeze-blank, -v/--show-nonprinting, -e (=-vE), -t (=-vT), -u (no-op).
// A bare `cat -A game.js` currently dies with `cat: invalid option -- 'A'`.
//
// This wrapper is registered as a real just-bash builtin (same mechanism as
// registerNode/registerProbes), so it intercepts `cat` inside any `bash -c`
// script and resolves via PATH. It parses the full GNU flag set itself and reads
// files through the async ctx.fs / ctx.stdin — no external process, pure JS,
// jitless-safe. Anything it cannot improve on falls back to faithful GNU output.
//
// ctx contract (verified): { args, ctx:{ fs, cwd, stdin, ... } }
//   ctx.fs.readFile(path, 'utf8') -> Promise<string>; throws Error whose
//     .message begins ENOENT/EISDIR/... ; ctx.fs.stat(path) -> {isFile,
//     isDirectory (boolean), size, ...}; ctx.fs.exists(path) -> Promise<bool>.
//   ctx.stdin is a STRING (piped input, or '').
// return { stdout, stderr, exitCode }.

function registerCat(bash, defineCommand) {
  if (typeof defineCommand !== 'function' || !bash || typeof bash.registerCommand !== 'function') return;
  try {
    bash.registerCommand(defineCommand('cat', (args, ctx) => catHandler(args, ctx)));
  } catch { /* build without defineCommand support -> leave stock cat */ }
}

// POSIX-y absolute path resolution against cwd (no Node 'path' needed, but it's
// available under jitless anyway; keep it dependency-light + deterministic).
function resolve(cwd, p) {
  if (!p) return cwd || '/';
  let base = p.startsWith('/') ? '' : (cwd || '/');
  let full = base + '/' + p;
  const parts = full.split('/');
  const out = [];
  for (const seg of parts) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (out.length) out.pop(); continue; }
    out.push(seg);
  }
  return '/' + out.join('/');
}

// GNU cat -v transform for a single line's bytes (no trailing newline handling
// here). We operate on the string's char codes; under this text-oriented runtime
// files are UTF-8 strings, which is the realistic case for Claude's use.
function showNonprinting(s, tabToCaret /* -T handled separately unless -v needs ^I */) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 9 /* \t */) { out += '\t'; continue; }        // tab left to -T stage
    if (c === 10 /* \n */) { out += '\n'; continue; }       // newline never reaches here (split)
    if (c >= 32 && c < 127) { out += s[i]; continue; }      // printable ASCII
    if (c === 127) { out += '^?'; continue; }               // DEL
    if (c < 32) { out += '^' + String.fromCharCode(c + 64); continue; } // C0 control -> ^X
    // >=128: GNU prints M- notation on the low 7 bits of the byte. For multibyte
    // UTF-8 read as a JS string this is approximate; emit M-^X / M-<char>.
    if (c < 256) {
      const m = c - 128;
      if (m < 32) out += 'M-^' + String.fromCharCode(m + 64);
      else if (m === 127) out += 'M-^?';
      else out += 'M-' + String.fromCharCode(m);
    } else {
      // Non-Latin1 codepoint: pass through verbatim (best-effort, avoids garbling
      // real UTF-8 text the user is inspecting).
      out += s[i];
    }
  }
  return out;
}

async function catHandler(args, ctx) {
  const fs = ctx && ctx.fs;
  const cwd = (ctx && ctx.cwd) || '/';

  // ---- option parse (GNU-compatible) ----
  let number = false;        // -n
  let numberNonblank = false;// -b (overrides -n)
  let showEnds = false;      // -E  ($ at line end)
  let showTabs = false;      // -T  (tab -> ^I)
  let showNonprint = false;  // -v
  let squeeze = false;       // -s  (squeeze repeated blank lines)
  const files = [];
  let noMoreOpts = false;
  let badOpt = null;

  const longMap = {
    'number': () => { number = true; },
    'number-nonblank': () => { numberNonblank = true; },
    'show-ends': () => { showEnds = true; },
    'show-tabs': () => { showTabs = true; },
    'show-nonprinting': () => { showNonprint = true; },
    'squeeze-blank': () => { squeeze = true; },
    'show-all': () => { showNonprint = true; showTabs = true; showEnds = true; }, // -A
  };

  const applyShort = (ch) => {
    switch (ch) {
      case 'n': number = true; return true;
      case 'b': numberNonblank = true; return true;
      case 'E': showEnds = true; return true;
      case 'T': showTabs = true; return true;
      case 'v': showNonprint = true; return true;
      case 's': squeeze = true; return true;
      case 'A': showNonprint = true; showTabs = true; showEnds = true; return true; // -A = -vET
      case 'e': showNonprint = true; showEnds = true; return true;                  // -e = -vE
      case 't': showNonprint = true; showTabs = true; return true;                  // -t = -vT
      case 'u': return true; // unbuffered: no-op
      default: return false;
    }
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (noMoreOpts) { files.push(a); continue; }
    if (a === '--') { noMoreOpts = true; continue; }
    if (a === '-') { files.push('-'); continue; } // stdin
    if (a === '--help' || a === '--version') {
      // Let these be trivially handled: print nothing fancy, exit 0-ish is wrong.
      // GNU prints usage; keep it minimal + honest.
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (longMap[name]) { longMap[name](); continue; }
      badOpt = `cat: unrecognized option '${a}'\n`;
      break;
    }
    if (a.startsWith('-') && a.length > 1) {
      let ok = true;
      for (const ch of a.slice(1)) {
        if (!applyShort(ch)) { badOpt = `cat: invalid option -- '${ch}'\n`; ok = false; break; }
      }
      if (!ok) break;
      continue;
    }
    files.push(a);
  }

  if (badOpt) {
    return { stdout: '', stderr: badOpt + "Try 'cat --help' for more information.\n", exitCode: 1 };
  }

  if (numberNonblank) number = false; // -b beats -n (GNU)

  // Fast path: no transforming flag active -> behave like plain cat but still
  // support the flags stock cat lacks. If ONLY -n and no other transform, stock
  // cat already handles it; but we own `cat` now, so just do everything here.
  const transforming = number || numberNonblank || showEnds || showTabs || showNonprint || squeeze;

  if (files.length === 0) files.push('-');

  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  let lineNo = 0;
  // -s state must persist ACROSS files (GNU squeezes across concatenation).
  let prevBlank = false;

  // Render one file's raw content applying the flags, appending to stdout.
  const render = (content) => {
    if (!transforming) { stdout += content; return; }

    // Split into lines while preserving the final-newline semantics. GNU cat
    // treats the stream as lines terminated by \n; a trailing partial line (no
    // final \n) still gets numbered / $ / transforms but no added newline.
    const hasTrailingNL = content.endsWith('\n');
    const body = hasTrailingNL ? content.slice(0, -1) : content;
    // Empty file -> nothing.
    if (content.length === 0) return;
    const lines = body.split('\n');

    for (let li = 0; li < lines.length; li++) {
      let line = lines[li];
      const isLast = li === lines.length - 1;
      const isBlank = line.length === 0;

      // -s: squeeze consecutive blank lines to one.
      if (squeeze && isBlank) {
        if (prevBlank) {
          // skip this blank entirely
          continue;
        }
        prevBlank = true;
      } else if (!isBlank) {
        prevBlank = false;
      } else {
        // blank but squeeze off
        prevBlank = false;
      }

      // -v (nonprinting) first, then -T can turn tabs into ^I.
      if (showNonprint) line = showNonprinting(line);
      if (showTabs) line = line.replace(/\t/g, '^I');

      // numbering
      let prefix = '';
      if (numberNonblank) {
        if (!isBlank) { lineNo++; prefix = String(lineNo).padStart(6, ' ') + '\t'; }
      } else if (number) {
        lineNo++; prefix = String(lineNo).padStart(6, ' ') + '\t';
      }

      // -E: $ before the newline
      const end = showEnds ? '$' : '';

      // The last "line" only gets a trailing \n if the original had one.
      const nl = (isLast && !hasTrailingNL) ? '' : '\n';
      stdout += prefix + line + end + nl;
    }
  };

  for (const f of files) {
    if (f === '-') {
      const s = (ctx && typeof ctx.stdin === 'string') ? ctx.stdin : '';
      render(s);
      continue;
    }
    const abs = resolve(cwd, f);
    try {
      // Distinguish directory up front for a clean GNU-style message.
      let st = null;
      try { st = await fs.stat(abs); } catch { /* fall through to readFile error */ }
      if (st && st.isDirectory) {
        stderr += `cat: ${f}: Is a directory\n`;
        exitCode = 1;
        continue;
      }
      const content = await fs.readFile(abs, 'utf8');
      render(typeof content === 'string' ? content : String(content));
    } catch (e) {
      const msg = (e && e.message) || String(e);
      if (/ENOENT/.test(msg)) stderr += `cat: ${f}: No such file or directory\n`;
      else if (/EISDIR/.test(msg)) stderr += `cat: ${f}: Is a directory\n`;
      else if (/EACCES|EPERM/.test(msg)) stderr += `cat: ${f}: Permission denied\n`;
      else stderr += `cat: ${f}: ${msg}\n`;
      exitCode = 1;
    }
  }

  return { stdout, stderr, exitCode };
}

module.exports = { registerCat, catHandler, _resolve: resolve, _showNonprinting: showNonprinting };
