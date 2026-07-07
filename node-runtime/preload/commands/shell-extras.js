'use strict';
// ============================================================================
// PATCH: register.js — supplement genuinely-missing coreutils in registerProbes.
//
// Cross-checked against just-bash 3.0.2's 83 built-ins (commands Map). These are
// commands just-bash does NOT bundle, that Claude/scripts reach for and that
// otherwise fall through to a nonexistent binary (device → 127) or a Mac binary
// parsed as a shell script (simulator → "unexpected EOF"/exit 2):
//
//   sw_vers   realpath   mktemp
//
// NOT re-implemented (just-bash already ships correct impls, VERIFIED on Node18):
//   date (+fmt, -u), seq (-w, step), sleep, true, false, readlink -f, stat,
//   hostname, whoami, env, printenv.
//   → We DO override hostname/whoami below so their output matches the device
//     persona (iPhone/mobile) instead of just-bash's generic localhost/user.
//     registerCommand replaces an existing built-in — VERIFIED.
//
// Drop-in: paste the body of registerMissing() into registerProbes() in
// register.js (after the existing tty reg), OR add registerMissing as a new
// function and call it from makeBash() right after registerProbes(bash).
// It uses the SAME mechanism: bash.registerCommand(defineCommand(name, fn)).
// ============================================================================

function registerMissing(bash, injectedDefineCommand) {
  let defineCommand = injectedDefineCommand;
  if (typeof defineCommand !== 'function') {
    try { ({ defineCommand } = require('just-bash')); } catch { return; }
  }
  if (typeof defineCommand !== 'function') return;

  const ok = (stdout = '', exitCode = 0, stderr = '') => ({ stdout, stderr, exitCode });
  const reg = (name, fn) => {
    try { bash.registerCommand(defineCommand(name, async (args, ctx) => fn(args, ctx))); } catch { /* name unknown to build → skip */ }
  };

  // just-bash threads the shell environment into ctx.exportedEnv (the exported
  // vars incl. PWD/HOME/TMPDIR); ctx.env holds only inline `VAR=x cmd` overrides.
  // ctx.cwd is the interpreter default and does NOT track `cd`, so use PWD.
  // VERIFIED on Node18: constructor env → ctx.exportedEnv, `cd` updates PWD there.
  const envOf = (ctx) => Object.assign({}, (ctx && ctx.exportedEnv) || {}, (ctx && ctx.env) || {});
  const cwdOf = (ctx) => {
    const e = envOf(ctx);
    return e.PWD || (ctx && ctx.cwd) || (bash && bash.state && bash.state.cwd) || process.cwd();
  };

  // iOS product identity. Values chosen to be plausible & self-consistent with
  // the uname persona (Darwin/arm64) already served by registerProbes.
  const IOS = { productName: 'iPhone OS', productVersion: '17.5.1', buildVersion: '21F90' };

  // --- sw_vers -------------------------------------------------------------
  // macOS/iOS build-info tool. Flags select a single field; no flag = all three.
  reg('sw_vers', (args) => {
    const want = (f) => args.includes(f);
    if (want('-productName')) return ok(IOS.productName + '\n');
    if (want('-productVersion')) return ok(IOS.productVersion + '\n');
    if (want('-buildVersion')) return ok(IOS.buildVersion + '\n');
    return ok(
      `ProductName:\t\t${IOS.productName}\n` +
      `ProductVersion:\t\t${IOS.productVersion}\n` +
      `BuildVersion:\t\t${IOS.buildVersion}\n`
    );
  });

  // --- realpath ------------------------------------------------------------
  // Canonicalize each operand. just-bash already resolves symlinks via its fs
  // (readlink -f works), so we mirror that: use the interpreter's own cwd/fs to
  // produce an absolute, normalized, symlink-resolved path. Falls back to pure
  // path normalization when the target doesn't exist (matching `realpath -m`
  // leniency, and avoiding a hard failure that a strict impl would give).
  //   Supported: -m/--canonicalize-missing (no fs check), -e/--canonicalize-existing
  //   (error if missing), -q/--quiet, -s/--strip/--no-symlinks, plain operands.
  reg('realpath', async (args, ctx) => {
    const path = require('node:path');
    const fsp = require('node:fs/promises');
    const cwd = cwdOf(ctx);
    let requireExisting = false, quiet = false, noSymlinks = false;
    const operands = [];
    for (const a of args) {
      if (a === '--') continue;
      if (a === '-e' || a === '--canonicalize-existing') { requireExisting = true; continue; }
      if (a === '-m' || a === '--canonicalize-missing') { continue; } // lenient path is already the default
      if (a === '-q' || a === '--quiet') { quiet = true; continue; }
      if (a === '-s' || a === '--strip' || a === '--no-symlinks') { noSymlinks = true; continue; }
      if (a && a.startsWith('-') && a !== '-') continue; // ignore unknown flags, GNU-lenient
      operands.push(a);
    }
    if (operands.length === 0) return ok('', 1, 'realpath: missing operand\n');
    const out = [];
    let err = '';
    let code = 0;
    for (const op of operands) {
      const abs = path.resolve(cwd, op);
      let resolved = path.normalize(abs);
      if (!noSymlinks) {
        try { resolved = await fsp.realpath(abs); }
        catch (e) {
          if (requireExisting) {
            code = 1;
            if (!quiet) err += `realpath: ${op}: No such file or directory\n`;
            continue; // GNU: skip this operand, error → stderr
          }
          // default & -m: fall back to lexical normalization
          resolved = path.normalize(abs);
        }
      }
      out.push(resolved);
    }
    return ok(out.length ? out.join('\n') + '\n' : '', code, err);
  });

  // --- mktemp --------------------------------------------------------------
  // Create a UNIQUE file (or dir with -d) in a CONTAINER-WRITABLE location and
  // print its path. Bare /tmp is read-only in the iOS sandbox; the writable
  // scratch dir is $TMPDIR (the app-container tmp) → $HOME → cwd. We never write
  // to /tmp. Template semantics: trailing run of X's is replaced with random
  // chars; -p DIR overrides base; -u prints a name without creating; -t treats
  // the arg as a name template placed under the tmp base; -d makes a directory.
  reg('mktemp', async (args, ctx) => {
    const path = require('node:path');
    const fsp = require('node:fs/promises');
    const env = envOf(ctx);
    const cwd = cwdOf(ctx);

    // Pick a writable base: $TMPDIR (container tmp) > $HOME > cwd. Never /tmp.
    const pickBase = () => {
      const t = env.TMPDIR || env.TMP || env.TEMP;
      if (t) return String(t).replace(/\/+$/, '') || '/';
      if (env.HOME) return String(env.HOME).replace(/\/+$/, '') || '/';
      return cwd;
    };

    let makeDir = false, dryRun = false, useTmpBase = false, baseDir = null;
    let template = null;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-d' || a === '--directory') { makeDir = true; continue; }
      if (a === '-u' || a === '--dry-run') { dryRun = true; continue; }
      if (a === '-q' || a === '--quiet') { continue; }
      if (a === '-t') { useTmpBase = true; continue; }
      if (a === '-p' || a === '--tmpdir') {
        // -p may take next arg; --tmpdir[=DIR] may attach or default to base
        if (a === '-p') { baseDir = args[i + 1]; i++; }
        useTmpBase = true;
        continue;
      }
      if (a && a.startsWith('--tmpdir=')) { baseDir = a.slice('--tmpdir='.length); useTmpBase = true; continue; }
      if (a && a.startsWith('-')) continue; // ignore unknown flags
      if (template == null) template = a;
    }

    // Resolve the directory + name template.
    const DEFAULT_TMPL = 'tmp.XXXXXXXXXX';
    let dir, namePart;
    if (template == null) {
      dir = baseDir || pickBase();
      namePart = DEFAULT_TMPL;
    } else if (template.includes('/') && !useTmpBase && !baseDir) {
      // absolute/relative template → honor its dir, but redirect a bare /tmp
      // template to the writable base (sandbox: /tmp not writable).
      const td = path.dirname(template);
      namePart = path.basename(template);
      dir = (td === '/tmp' || td.startsWith('/tmp/')) ? pickBase() : path.resolve(cwd, td);
    } else {
      // -t or plain name template → place under tmp base
      dir = baseDir || pickBase();
      namePart = path.basename(template);
    }
    if (!/X{3,}$/.test(namePart)) {
      // GNU requires >=3 trailing X. Be lenient: append a random suffix if absent.
      namePart = namePart.replace(/X+$/, '') || namePart;
      namePart = namePart + '.XXXXXXXXXX';
    }

    const CH = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const rand = (n) => { let s = ''; for (let i = 0; i < n; i++) s += CH[Math.floor(Math.random() * CH.length)]; return s; };
    const fill = (tmpl) => tmpl.replace(/X+$/, (m) => rand(m.length));

    // Ensure the base dir exists (TMPDIR may point at a not-yet-created
    // container tmp; HOME/cwd always exist). Without this, open() ENOENTs.
    if (!dryRun) { try { await fsp.mkdir(dir, { recursive: true }); } catch {} }

    for (let attempt = 0; attempt < 100; attempt++) {
      const full = path.join(dir, fill(namePart));
      if (dryRun) return ok(full + '\n');
      try {
        if (makeDir) {
          await fsp.mkdir(full, { mode: 0o700 });
        } else {
          // wx = fail if exists → guarantees uniqueness
          const fh = await fsp.open(full, 'wx', 0o600);
          await fh.close();
        }
        return ok(full + '\n');
      } catch (e) {
        if (e && e.code === 'EEXIST') continue; // collision → retry
        return ok('', 1, `mktemp: failed to create ${makeDir ? 'directory' : 'file'} via template '${path.join(dir, namePart)}': ${e && e.message || e}\n`);
      }
    }
    return ok('', 1, 'mktemp: could not create unique file after 100 attempts\n');
  });

  // --- persona-correct hostname / whoami -----------------------------------
  // just-bash returns generic localhost/user. Override to match the iOS persona
  // already established by registerProbes (id → mobile, uname -n → iPhone).
  reg('whoami', () => ok('mobile\n'));
  reg('hostname', (args) => {
    if (args.includes('-s')) return ok('iPhone\n');
    return ok('iPhone\n');
  });
}

module.exports = { registerMissing };
