'use strict';
// ============================================================================
// coreutils-gaps.js — supplement genuinely-missing / partially-broken coreutils
// in just-bash 3.0.2 on iOS L Shell. VERIFIED against the live 83-builtin set.
//
// Findings that drove this file (Node18, InMemoryFs + PassthroughFs):
//   • df      — NOT a builtin (127 / Mach-O parse). Implemented here.
//   • yes     — NOT a builtin. Implemented BOUNDED (no job control → never loop
//               forever; respects a caller line-count and ctx.signal).
//   • stat    — builtin exists but: `-c "%Y"` (and most %-specifiers) print the
//               literal token; `-f` (BSD) → "invalid option 'f'"; `--format=`
//               long form unrecognized. We SHADOW it with a full GNU `-c/--format`
//               + BSD `-f` implementation. Falls back to the same fields the stock
//               one had (size/mode/mtime) plus a mobile persona (uid/gid 501).
//   • seq     — builtin good EXCEPT `-f FORMAT`. We SHADOW seq to add `-f`
//               (printf-style %e/%f/%g) while preserving -w/-s/step/descending.
//   • xargs   — builtin accepts SPACED `-n 1` / `-I {}` but rejects GLUED `-n1`
//               / `-I{}` ("invalid option 'n'/'I'") and lacks `-L`/`-p`. Because a
//               registered `xargs` FULLY shadows the builtin (verified) and there
//               is no handle to the original, we re-implement xargs on top of
//               ctx.exec — covering glued forms, -I{}, -n, -L, -0, -d, -r, -t,
//               -p(skip), -E/-e eof. This is the ONLY correct place: xargs needs
//               command-dispatch semantics (spawning a command per batch), which a
//               pure arg-normalizer cannot provide without the builtin cooperating.
//   • tree    — builtin already handles -L/-d/-a/-f correctly. Left AS-IS (not
//               re-registered) to avoid regressing a working impl.
//
// Wiring: called from registerShellExtras() in register.js AFTER registerMissing
// + registerCat, using the SAME mechanism (bash.registerCommand(defineCommand)).
// Registering LAST means our stat/seq/xargs win over the stock builtins.
// ============================================================================

function registerCoreutilsGaps(bash, injectedDefineCommand) {
  let defineCommand = injectedDefineCommand;
  if (typeof defineCommand !== 'function') {
    try { ({ defineCommand } = require('just-bash')); } catch { return; }
  }
  if (typeof defineCommand !== 'function' || !bash || typeof bash.registerCommand !== 'function') return;

  const ok = (stdout = '', exitCode = 0, stderr = '') => ({ stdout, stderr, exitCode });
  const reg = (name, fn) => {
    try { bash.registerCommand(defineCommand(name, async (args, ctx) => fn(args, ctx))); } catch { /* name unknown to build → skip */ }
  };

  const envOf = (ctx) => Object.assign({}, (ctx && ctx.exportedEnv) || {}, (ctx && ctx.env) || {});
  const cwdOf = (ctx) => {
    const e = envOf(ctx);
    return e.PWD || (ctx && ctx.cwd) || '/';
  };
  // ctx.fs.stat returns {isFile,isDirectory,isSymbolicLink,mode,size,mtime} where
  // the type flags MAY be booleans (Passthrough/InMemory Fs) OR functions (raw
  // node stat). Normalize to booleans.
  const asBool = (v) => (typeof v === 'function' ? !!v() : !!v);

  // ---- iOS persona (matches registerProbes: id → 501/mobile) ---------------
  const UID = 501, GID = 501, USER = 'mobile', GROUP = 'mobile';

  // ==========================================================================
  //  df — report free space of the (single) container filesystem.
  // ==========================================================================
  // iOS is a single app-container volume; we report ONE row. Prefer real numbers
  // from node:fs.statfsSync (present on Node18; may be absent on nodejs-mobile →
  // fall back to a plausible fixed estimate). Supports -h/-H (human), -k, -m,
  // -P (POSIX), -i (inodes best-effort), and a path operand (ignored → same fs).
  reg('df', (args, ctx) => {
    let human = false, si = false, blockSize = 1024, posix = false, inodes = false;
    let base = 1024; // for human (-h) → 1024; -H → 1000
    const operands = [];
    for (const a of args) {
      if (a === '--') continue;
      if (a === '-h' || a === '--human-readable') { human = true; base = 1024; continue; }
      if (a === '-H' || a === '--si') { human = true; si = true; base = 1000; continue; }
      if (a === '-k') { blockSize = 1024; continue; }
      if (a === '-m') { blockSize = 1024 * 1024; continue; }
      if (a === '-P' || a === '--portability') { posix = true; continue; }
      if (a === '-i' || a === '--inodes') { inodes = true; continue; }
      if (a === '-a' || a === '--all' || a === '-T' || a === '--total') continue; // accept, no extra rows
      if (a && a.startsWith('--block-size=')) { blockSize = parseInt(a.slice(13), 10) || 1024; continue; }
      if (a && a.startsWith('-')) continue; // ignore unknown flags
      operands.push(a);
    }

    // Gather statfs numbers (bytes), with a safe fallback.
    let bsize = 4096, blocks = 0, bavail = 0, bfree = 0, files = 0, ffree = 0;
    let gotReal = false;
    try {
      const nfs = require('node:fs');
      if (typeof nfs.statfsSync === 'function') {
        const env = envOf(ctx);
        const target = operands[0] || cwdOf(ctx) || env.HOME || '/';
        const s = nfs.statfsSync(target && target !== '' ? target : '/');
        bsize = s.bsize || 4096; blocks = s.blocks || 0; bavail = s.bavail || 0;
        bfree = (s.bfree != null ? s.bfree : s.bavail) || 0;
        files = s.files || 0; ffree = s.ffree || 0;
        gotReal = true;
      }
    } catch { /* nodejs-mobile without statfs → estimate below */ }
    if (!gotReal) {
      // Estimate: 64 GiB volume, ~half free. Honest-ish placeholder for a phone.
      bsize = 4096;
      blocks = Math.floor((64 * 1024 * 1024 * 1024) / bsize);
      bavail = Math.floor(blocks * 0.5);
      bfree = bavail;
      files = 500000000; ffree = 480000000;
    }

    const totalB = blocks * bsize;
    const availB = bavail * bsize;
    const usedB = (blocks - bfree) * bsize;
    const usePct = blocks > 0 ? Math.ceil((blocks - bfree) / blocks * 100) : 0;

    const fsName = '/dev/disk0s1';   // plausible iOS data volume node
    const mount = '/';

    const humanize = (bytes) => {
      const units = ['', 'K', 'M', 'G', 'T', 'P'];
      let n = bytes, i = 0;
      while (n >= base && i < units.length - 1) { n /= base; i++; }
      // GNU df: <10 → one decimal, else integer; unit suffix (Ki uses same letters)
      const num = (i === 0) ? String(Math.round(n)) : (n < 9.95 ? n.toFixed(1) : String(Math.round(n)));
      return num + units[i] + (si && i > 0 ? '' : '');
    };
    const inBlocks = (bytes) => String(Math.ceil(bytes / blockSize));

    if (inodes) {
      const iused = files - ffree;
      const ipct = files > 0 ? Math.ceil(iused / files * 100) : 0;
      const header = 'Filesystem      Inodes  IUsed   IFree IUse% Mounted on\n';
      const row = fsName.padEnd(15) + ' ' +
        String(files).padStart(7) + ' ' + String(iused).padStart(6) + ' ' +
        String(ffree).padStart(7) + ' ' + (ipct + '%').padStart(4) + ' ' + mount + '\n';
      return ok(header + row);
    }

    if (human) {
      const header = 'Filesystem      Size  Used Avail Use% Mounted on\n';
      const row = fsName.padEnd(15) + ' ' +
        humanize(totalB).padStart(4) + ' ' + humanize(usedB).padStart(4) + ' ' +
        humanize(availB).padStart(4) + ' ' + (usePct + '%').padStart(4) + ' ' + mount + '\n';
      return ok(header + row);
    }

    const bsLabel = posix ? '1024-blocks' : (blockSize === 1024 ? '1K-blocks' : (blockSize / 1024) + 'K-blocks');
    const header = 'Filesystem     ' + bsLabel.padStart(11) + '   Used  Available Use% Mounted on\n';
    const row = fsName.padEnd(15) + ' ' +
      inBlocks(totalB).padStart(10) + ' ' + inBlocks(usedB).padStart(7) + ' ' +
      inBlocks(availB).padStart(10) + ' ' + (usePct + '%').padStart(4) + ' ' + mount + '\n';
    return ok(header + row);
  });

  // ==========================================================================
  //  yes — repeatedly print a string. BOUNDED so it can NEVER hang the shell.
  // ==========================================================================
  // No job control here: an unbounded `yes` would spin until maxOutputSize and
  // block the single process. We cap iterations HARD and also poll ctx.signal so
  // an interrupt stops it early. Default string is "y". Cap chosen well under
  // just-bash's maxOutputSize but large enough for realistic `yes | cmd` uses.
  reg('yes', async (args, ctx) => {
    const word = (args.length ? args.join(' ') : 'y') + '\n';
    const MAX_LINES = 10000;
    let out = '';
    for (let i = 0; i < MAX_LINES; i++) {
      if (ctx && ctx.signal && ctx.signal.aborted) break;
      out += word;
    }
    return ok(out);
  });

  // ==========================================================================
  //  stat — full GNU `-c/--format` AND BSD `-f` format support.
  // ==========================================================================
  const buildFields = (abs, st) => {
    const isDir = asBool(st.isDirectory);
    const isLnk = asBool(st.isSymbolicLink);
    const isFile = asBool(st.isFile);
    const mode = (typeof st.mode === 'number') ? st.mode : (isDir ? 0o40755 : 0o100644);
    const permBits = mode & 0o7777;          // rwx bits
    const size = (typeof st.size === 'number') ? st.size : 0;
    const mtimeDate = st.mtime instanceof Date ? st.mtime : new Date(st.mtime || Date.now());
    const mtimeS = Math.floor(mtimeDate.getTime() / 1000);
    const name = abs;
    const bn = name.split('/').filter(Boolean).pop() || '/';
    // Type letter/word.
    const typeWord = isDir ? 'directory' : isLnk ? 'symbolic link' : isFile ? 'regular file' : 'regular empty file';
    // Symbolic rwx string (GNU %A, BSD %Sp).
    const rwx = symbolicMode(mode, isDir, isLnk);
    // st_mode full octal incl. type bits (GNU %f is hex of st_mode).
    const fullMode = (isDir ? 0o40000 : isLnk ? 0o120000 : 0o100000) | permBits;
    const blocks = Math.ceil(size / 512);
    return {
      name, bn, abs, size, permBits, fullMode, mtimeS, mtimeDate, rwx, typeWord,
      isDir, isLnk, isFile, blocks,
      uid: UID, gid: GID, user: USER, group: GROUP, nlink: 1,
      ino: hashIno(abs), dev: 16777220, blksize: 4096,
    };
  };

  // GNU -c / --format specifiers.
  const applyGnu = (fmt, f) => fmt.replace(/%(.)/g, (m, c) => {
    switch (c) {
      case 'n': return f.name;
      case 'N': return "'" + f.name + "'" + (f.isLnk ? " -> ?" : '');
      case 's': return String(f.size);
      case 'b': return String(f.blocks);
      case 'B': return '512';
      case 'f': return f.fullMode.toString(16);       // raw mode in hex
      case 'a': return (f.permBits & 0o7777).toString(8); // access rights octal
      case 'A': return f.rwx;                          // access rights human
      case 'F': return f.typeWord;
      case 'h': return String(f.nlink);
      case 'i': return String(f.ino);
      case 'u': return String(f.uid);
      case 'U': return f.user;
      case 'g': return String(f.gid);
      case 'G': return f.group;
      case 'd': return String(f.dev);
      case 'o': return String(f.blksize);
      case 't': return '0'; case 'T': return '0';      // device major/minor
      case 'X': return String(f.mtimeS);               // atime epoch (≈ mtime here)
      case 'Y': return String(f.mtimeS);               // mtime epoch
      case 'Z': return String(f.mtimeS);               // ctime epoch
      case 'x': return f.mtimeDate.toString();
      case 'y': return f.mtimeDate.toISOString().replace('T', ' ').replace('Z', ' +0000');
      case 'z': return f.mtimeDate.toString();
      case 'w': return '-';                            // birth time (unknown)
      case 'W': return '0';
      case '%': return '%';
      default: return m;                               // unknown → literal
    }
  });

  // BSD -f specifiers (macOS stat). Format grammar: %[flags][size]<sub><datum>
  // where <sub> ∈ {S(string),M/H/L(byte selectors)} is OPTIONAL and precedes the
  // datum letter. So %Sp = sub 'S' + datum 'p' (symbolic perms), %p alone = octal
  // mode. We capture the optional sub-letter and dispatch on sub+datum.
  const applyBsd = (fmt, f) => fmt.replace(/%([-+#0 ]*\d*)?([SMHL])?([a-zA-Z%])/g, (m, _flags, sub, c) => {
    // BSD %p → full st_mode in octal (type bits + perms), e.g. regular 0644 → 100644.
    const octMode = () => f.fullMode.toString(8);
    // sub 'S' → string/symbolic rendering of the datum.
    if (sub === 'S') {
      switch (c) {
        case 'p': return f.rwx;                 // %Sp → symbolic perms (e.g. -rw-r--r--)
        case 'm': return f.mtimeDate.toString(); // %Sm → human time
        case 'a': return f.mtimeDate.toString();
        case 'c': return f.mtimeDate.toString();
        case 'B': return f.mtimeDate.toString();
        case 'u': return f.user;                // %Su → owner name
        case 'g': return f.group;               // %Sg → group name
        case 'T': return f.isDir ? '/' : (f.isLnk ? '@' : '');
        case 'Y': return f.isLnk ? ' -> ?' : '';
        default: return m;
      }
    }
    // sub 'M'/'H'/'L' select a byte of the datum; for our purposes emit the datum.
    switch (c) {
      case 'N': return f.bn;                    // %N → basename (BSD default name)
      case 'n': return f.bn;
      case 'R': return f.abs;                   // %R → absolute path
      case 'z': return String(f.size);          // size in bytes
      case 'b': return String(f.blocks);        // blocks
      case 'm': return String(f.mtimeS);        // mtime epoch
      case 'a': return String(f.mtimeS);        // atime epoch (≈)
      case 'c': return String(f.mtimeS);        // ctime epoch (≈)
      case 'B': return String(f.mtimeS);        // birth (≈)
      case 'p': return octMode();               // %p → mode octal (e.g. 0100644)
      case 'u': return String(f.uid);
      case 'g': return String(f.gid);
      case 'i': return String(f.ino);
      case 'd': return String(f.dev);
      case 'l': return String(f.nlink);
      case 'k': return String(f.blksize);
      case 'r': return String(f.dev);
      case 'f': return f.fullMode.toString(16); // raw mode hex
      case 'T': return f.isDir ? '/' : (f.isLnk ? '@' : '');  // file type suffix
      case 'Y': return f.isLnk ? ' -> ?' : '';
      case '%': return '%';
      default: return m;
    }
  });

  reg('stat', async (args, ctx) => {
    const fs = ctx && ctx.fs;
    const cwd = cwdOf(ctx);
    let mode = null;        // 'gnu' | 'bsd' | null(default)
    let fmt = null;
    let deref = false;      // -L
    let terse = false;      // -t / -s (BSD terse)
    const files = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') { for (let j = i + 1; j < args.length; j++) files.push(args[j]); break; }
      if (a === '-c' || a === '--format') { mode = 'gnu'; fmt = args[++i]; continue; }
      if (a && a.startsWith('--format=')) { mode = 'gnu'; fmt = a.slice(9); continue; }
      if (a && a.startsWith('-c')) { mode = 'gnu'; fmt = a.slice(2); continue; }   // -c%s glued
      if (a === '--printf') { mode = 'gnu'; fmt = unescapePrintf(args[++i]); continue; }
      if (a && a.startsWith('--printf=')) { mode = 'gnu'; fmt = unescapePrintf(a.slice(9)); continue; }
      if (a === '-f') { mode = 'bsd'; fmt = args[++i]; continue; }
      if (a && a.startsWith('-f')) { mode = 'bsd'; fmt = a.slice(2); continue; }   // -f%z glued
      if (a === '-L' || a === '--dereference') { deref = true; continue; }
      if (a === '-t' || a === '--terse') { terse = true; continue; }
      if (a === '-s') { terse = true; continue; } // BSD shell-parsable ≈ terse-ish
      if (a === '-n') continue;                    // BSD "no newline per file" - ignore, we manage newlines
      if (a && a.startsWith('-') && a !== '-') continue; // ignore other flags
      files.push(a);
    }
    if (files.length === 0) return ok('', 1, "stat: missing operand\nTry 'stat --help' for more information.\n");

    let out = '', err = '', code = 0;
    for (const file of files) {
      const abs = resolvePath(cwd, file);
      let st;
      try {
        st = (deref && fs.stat) ? await fs.stat(abs) : (fs.lstat ? await fs.lstat(abs) : await fs.stat(abs));
      } catch (e) {
        const msg = (e && e.message) || String(e);
        err += `stat: cannot stat '${file}': ` + (/ENOENT/.test(msg) ? 'No such file or directory' : msg) + '\n';
        code = 1;
        continue;
      }
      const f = buildFields(abs, st);
      if (mode === 'bsd') out += applyBsd(fmt || '%N', f) + '\n';
      else if (mode === 'gnu') out += applyGnu(fmt || '', f) + '\n';
      else if (terse) out += terseLine(f) + '\n';
      else out += defaultStat(f) + '\n';
    }
    return ok(out, code, err);
  });

  // ==========================================================================
  //  seq — add -f FORMAT (printf-style) on top of the good stock behavior.
  // ==========================================================================
  // Stock seq already handles n / a b / a step b / -w / -s / descending. Only
  // -f is missing. We re-implement fully but faithfully to keep one code path.
  reg('seq', (args) => {
    let sep = '\n', fmt = null, equalWidth = false;
    const nums = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-s' || a === '--separator') { sep = args[++i]; if (sep == null) sep = '\n'; continue; }
      if (a && a.startsWith('--separator=')) { sep = a.slice(12); continue; }
      if (a && a.startsWith('-s') && a.length > 2) { sep = a.slice(2); continue; }
      if (a === '-f' || a === '--format') { fmt = args[++i]; continue; }
      if (a && a.startsWith('--format=')) { fmt = a.slice(9); continue; }
      if (a && a.startsWith('-f') && a.length > 2) { fmt = a.slice(2); continue; }
      if (a === '-w' || a === '--equal-width') { equalWidth = true; continue; }
      if (a === '--') { for (let j = i + 1; j < args.length; j++) nums.push(args[j]); break; }
      // A bare '-' or negative number is an operand, not a flag.
      if (a && a.startsWith('-') && a.length > 1 && !/^-\.?\d/.test(a) && !/^-\d/.test(a)) {
        // unknown flag → ignore GNU-lenient
        continue;
      }
      nums.push(a);
    }
    let first = 1, incr = 1, last;
    if (nums.length === 1) { last = Number(nums[0]); }
    else if (nums.length === 2) { first = Number(nums[0]); last = Number(nums[1]); }
    else if (nums.length >= 3) { first = Number(nums[0]); incr = Number(nums[1]); last = Number(nums[2]); }
    else return ok('', 1, 'seq: missing operand\n');
    if (!isFinite(first) || !isFinite(incr) || !isFinite(last) || incr === 0) {
      return ok('', 1, `seq: invalid argument\n`);
    }
    // Determine decimals for -w padding / default formatting.
    const decimalsOf = (x) => { const s = String(x); const i = s.indexOf('.'); return i < 0 ? 0 : s.length - i - 1; };
    const dec = Math.max(decimalsOf(first), decimalsOf(incr), decimalsOf(last));

    const values = [];
    // Guard against runaway ranges (respect just-bash's spirit of bounded loops).
    const MAX = 1000000;
    if (incr > 0) { for (let v = first; v <= last + 1e-9 && values.length < MAX; v += incr) values.push(round(v, dec)); }
    else { for (let v = first; v >= last - 1e-9 && values.length < MAX; v += incr) values.push(round(v, dec)); }

    let strs;
    if (fmt) {
      strs = values.map((v) => sprintfNum(fmt, v));
    } else if (dec > 0) {
      strs = values.map((v) => v.toFixed(dec));
    } else {
      strs = values.map((v) => String(v));
    }
    if (equalWidth && !fmt) {
      const w = strs.reduce((m, s) => Math.max(m, s.replace('-', '').length), 0);
      strs = strs.map((s) => {
        const neg = s.startsWith('-');
        const body = neg ? s.slice(1) : s;
        return (neg ? '-' : '') + body.padStart(w - (neg ? 0 : 0), '0');
      });
      // simpler correct pad: pad the full numeric token to width incl sign handling
      const width = Math.max(...values.map((v) => (v < 0 ? 1 : 0) + Math.floor(Math.abs(v)).toString().length + (dec > 0 ? dec + 1 : 0)));
      strs = values.map((v) => {
        let s = dec > 0 ? Math.abs(v).toFixed(dec) : Math.abs(Math.trunc(v)).toString();
        s = s.padStart(dec > 0 ? width - (v < 0 ? 1 : 0) : width - (v < 0 ? 1 : 0), '0');
        return (v < 0 ? '-' : '') + s;
      });
    }
    if (strs.length === 0) return ok('');
    return ok(strs.join(sep) + '\n');
  });

  // ==========================================================================
  //  xargs — glued short options (-n1/-I{}), -I replace, -L, -0, -d, -r, -t,
  //           -p(skip), -E/-e eof, plus command dispatch via ctx.exec.
  // ==========================================================================
  reg('xargs', async (args, ctx) => {
    // ---- parse (accept glued AND spaced) ----
    let replaceStr = null;     // -I R  (implies one-arg-per-line, -L1)
    let maxArgs = null;        // -n N
    let maxLines = null;       // -L N
    let nullDelim = false;     // -0 / -d '\0'
    let delim = null;          // -d C
    let noRunIfEmpty = false;  // -r
    let runIfEmpty = true;     // default: GNU runs once even if empty (BSD too), but modern GNU does NOT run if empty
    let trace = false;         // -t
    let eofStr = null;         // -E S / -e[S]
    const cmd = [];
    let sawCmd = false;

    const takeVal = (a, i, prefixLen) => {
      // returns [value, newIndex]; supports -Xval glued or -X val spaced
      if (a.length > prefixLen) return [a.slice(prefixLen), i];
      return [args[i + 1], i + 1];
    };

    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (sawCmd) { cmd.push(a); continue; }
      if (a === '--') { sawCmd = true; continue; }
      if (a === '-0' || a === '--null') { nullDelim = true; continue; }
      if (a === '-r' || a === '--no-run-if-empty') { noRunIfEmpty = true; continue; }
      if (a === '-t' || a === '--verbose') { trace = true; continue; }
      if (a === '-p' || a === '--interactive') { continue; } // no TTY → skip prompt, just run
      if (a === '-x' || a === '--exit') { continue; }        // accept, no size limits enforced
      if (a === '-I' || a === '--replace' || (a.startsWith('-I') && a.length > 2)) {
        let v; [v, i] = (a === '-I') ? takeVal(a, i, 2) : [a.slice(2), i];
        if (a === '--replace') { v = (a.length > 9 && a[9] === '=') ? a.slice(10) : args[++i]; }
        replaceStr = (v == null || v === '') ? '{}' : v;
        maxLines = maxLines == null ? 1 : maxLines;
        continue;
      }
      if (a.startsWith('--replace=')) { replaceStr = a.slice(10) || '{}'; maxLines = maxLines == null ? 1 : maxLines; continue; }
      if (a === '-n' || (a.startsWith('-n') && a.length > 2)) {
        let v; [v, i] = takeVal(a, i, 2); maxArgs = parseInt(v, 10) || 1; continue;
      }
      if (a.startsWith('--max-args')) { maxArgs = parseInt(a.includes('=') ? a.split('=')[1] : args[++i], 10) || 1; continue; }
      if (a === '-L' || (a.startsWith('-L') && a.length > 2)) {
        let v; [v, i] = takeVal(a, i, 2); maxLines = parseInt(v, 10) || 1; continue;
      }
      if (a.startsWith('--max-lines')) { maxLines = parseInt(a.includes('=') ? a.split('=')[1] : args[++i], 10) || 1; continue; }
      if (a === '-d' || (a.startsWith('-d') && a.length > 2)) {
        let v; [v, i] = takeVal(a, i, 2);
        delim = (v === '\\0' || v === '\\x00') ? '\0' : unescapeDelim(v);
        if (delim === '\0') nullDelim = true;
        continue;
      }
      if (a.startsWith('--delimiter')) { let v = a.includes('=') ? a.split('=')[1] : args[++i]; delim = (v === '\\0') ? '\0' : unescapeDelim(v); if (delim === '\0') nullDelim = true; continue; }
      if (a === '-E' || (a.startsWith('-E') && a.length > 2)) { let v; [v, i] = takeVal(a, i, 2); eofStr = v; continue; }
      if (a.startsWith('-e')) { eofStr = a.length > 2 ? a.slice(2) : null; continue; }
      if (a === '-s' || (a.startsWith('-s') && a.length > 2)) { takeVal(a, i, 2); if (a === '-s') i++; continue; } // -s size: accept, ignore
      if (a.startsWith('-')) { continue; } // unknown flag → ignore, GNU-lenient
      // first non-flag token → command starts here
      sawCmd = true; cmd.push(a);
    }

    // Default command is `echo` (GNU: /bin/echo).
    const baseCmd = cmd.length ? cmd : ['echo'];

    // ---- read + tokenize stdin ----
    const input = (ctx && typeof ctx.stdin === 'string') ? ctx.stdin : '';
    let tokens;
    if (nullDelim || delim === '\0') {
      tokens = input.split('\0').filter((t) => t.length > 0);
    } else if (delim != null) {
      tokens = input.split(delim).filter((t) => t.length > 0);
    } else {
      // default: split on whitespace/newlines (GNU splits on blanks+newlines)
      tokens = input.split(/[ \t\n]+/).filter((t) => t.length > 0);
    }
    // EOF string terminates input (GNU -E / -e).
    if (eofStr != null) {
      const idx = tokens.indexOf(eofStr);
      if (idx >= 0) tokens = tokens.slice(0, idx);
    }

    // ---- shell-quote a single arg for safe re-exec via ctx.exec ----
    const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

    let out = '', errAcc = '', exitCode = 0;

    const runOne = async (argv) => {
      if (ctx && ctx.signal && ctx.signal.aborted) { exitCode = 124; return false; }
      const line = argv.map(q).join(' ');
      if (trace) errAcc += argv.join(' ') + '\n';
      let r;
      try { r = await ctx.exec(line, { signal: ctx && ctx.signal }); }
      catch (e) { errAcc += 'xargs: ' + ((e && e.message) || e) + '\n'; exitCode = 1; return true; }
      out += (r && r.stdout) || '';
      if (r && r.stderr) errAcc += r.stderr;
      if (r && r.exitCode) { if (r.exitCode === 255) { exitCode = 124; return false; } exitCode = 123; }
      return true;
    };

    // ---- dispatch ----
    if (tokens.length === 0) {
      // Modern GNU: with no input, run NOTHING (unless BSD-style forced). -r is
      // then a no-op. We choose the GNU-modern behavior: do not run.
      return ok(out, exitCode, errAcc);
    }

    if (replaceStr != null) {
      // -I: one invocation PER INPUT LINE (whole line substituted). GNU -I reads
      // by line, not by whitespace token. Re-tokenize by lines for -I fidelity.
      let lines;
      if (nullDelim || delim === '\0') lines = input.split('\0').filter((l) => l.length > 0);
      else if (delim != null) lines = input.split(delim).filter((l) => l.length > 0);
      else lines = input.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
      if (eofStr != null) { const idx = lines.indexOf(eofStr); if (idx >= 0) lines = lines.slice(0, idx); }
      for (const lineVal of lines) {
        const argv = baseCmd.map((tok) => tok.split(replaceStr).join(lineVal));
        if (!(await runOne(argv))) break;
      }
    } else {
      // Batch tokens by -n (max args) and/or -L (max lines). We treat the token
      // stream; -L here approximates line batching using tokens-per-line=all.
      let batches;
      if (maxArgs != null) {
        batches = [];
        for (let i = 0; i < tokens.length; i += maxArgs) batches.push(tokens.slice(i, i + maxArgs));
      } else if (maxLines != null) {
        // -L N: N input lines per command. Re-split by line for correctness.
        const lines = (nullDelim ? input.split('\0') : input.split('\n')).map((l) => l.trim()).filter((l) => l.length);
        batches = [];
        for (let i = 0; i < lines.length; i += maxLines) {
          const chunk = lines.slice(i, i + maxLines).join(' ').split(/[ \t]+/).filter(Boolean);
          batches.push(chunk);
        }
      } else {
        batches = [tokens]; // all at once
      }
      for (const b of batches) {
        if (!(await runOne(baseCmd.concat(b)))) break;
      }
    }

    return ok(out, exitCode, errAcc);
  });

  // ---- shared helpers ------------------------------------------------------
  function resolvePath(cwd, p) {
    if (!p) return cwd || '/';
    let base = p.startsWith('/') ? '' : (cwd || '/');
    const parts = (base + '/' + p).split('/');
    const outp = [];
    for (const seg of parts) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') { if (outp.length) outp.pop(); continue; }
      outp.push(seg);
    }
    return '/' + outp.join('/');
  }
  function symbolicMode(mode, isDir, isLnk) {
    const t = isLnk ? 'l' : isDir ? 'd' : '-';
    const rwx = (bits) => (bits & 4 ? 'r' : '-') + (bits & 2 ? 'w' : '-') + (bits & 1 ? 'x' : '-');
    return t + rwx((mode >> 6) & 7) + rwx((mode >> 3) & 7) + rwx(mode & 7);
  }
  function hashIno(s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h % 90000000 + 10000000; // 8-digit-ish stable inode
  }
  function defaultStat(f) {
    // GNU-ish default multi-line output (mirrors stock builtin's shape).
    return `  File: ${f.name}\n` +
      `  Size: ${f.size}\t\tBlocks: ${f.blocks}\t\tIO Block: ${f.blksize} ${f.typeWord}\n` +
      `Device: ${f.dev}\tInode: ${f.ino}\tLinks: ${f.nlink}\n` +
      `Access: (${(f.permBits).toString(8).padStart(4, '0')}/${f.rwx})  Uid: (${f.uid}/${f.user})   Gid: (${f.gid}/${f.group})\n` +
      `Access: ${f.mtimeDate.toISOString()}\n` +
      `Modify: ${f.mtimeDate.toISOString()}\n` +
      `Change: ${f.mtimeDate.toISOString()}`;
  }
  function terseLine(f) {
    // GNU `stat -t`: name size blocks fullmode(hex) uid gid dev ino nlink 0 0 atime mtime ctime birth blksize
    return [f.name, f.size, f.blocks, f.fullMode.toString(16), f.uid, f.gid,
      f.dev.toString(16), f.ino, f.nlink, 0, 0, f.mtimeS, f.mtimeS, f.mtimeS, 0, f.blksize].join(' ');
  }
  function round(v, dec) { const p = Math.pow(10, dec); return Math.round((v + (v >= 0 ? 1e-9 : -1e-9)) * p) / p; }
  function sprintfNum(fmt, v) {
    // Support a single %[flags][width][.prec](e|E|f|F|g|G) conversion (seq -f).
    return fmt.replace(/%([-+ 0#]*)(\d+)?(?:\.(\d+))?([eEfFgG%])/g, (m, flags, width, prec, conv) => {
      if (conv === '%') return '%';
      let s;
      const p = prec == null ? 6 : parseInt(prec, 10);
      if (conv === 'f' || conv === 'F') s = v.toFixed(p);
      else if (conv === 'e' || conv === 'E') { s = v.toExponential(p); if (conv === 'E') s = s.toUpperCase(); }
      else { // g/G
        s = String(Number(v.toPrecision(prec == null ? 6 : p)));
        if (conv === 'G') s = s.toUpperCase();
      }
      if (flags.includes('+') && v >= 0) s = '+' + s;
      else if (flags.includes(' ') && v >= 0) s = ' ' + s;
      if (width) {
        const w = parseInt(width, 10);
        if (flags.includes('-')) s = s.padEnd(w);
        else if (flags.includes('0') && !flags.includes('-')) {
          const neg = s.startsWith('-') || s.startsWith('+') || s.startsWith(' ');
          if (neg) s = s[0] + s.slice(1).padStart(w - 1, '0');
          else s = s.padStart(w, '0');
        } else s = s.padStart(w);
      }
      return s;
    });
  }
  function unescapePrintf(s) {
    if (s == null) return s;
    return String(s).replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r').replace(/\\\\/g, '\\');
  }
  function unescapeDelim(v) {
    if (v == null) return v;
    if (v === '\\n') return '\n';
    if (v === '\\t') return '\t';
    if (v === '\\r') return '\r';
    if (v === '\\0') return '\0';
    return v;
  }
}

module.exports = { registerCoreutilsGaps };
