'use strict';
// `python3` / `python` for L Shell, backed by an embedded CPython 3.13 interpreter
// running behind the native N-API bridge (process._linkedBinding('lshell_py')).
//
// Architecture (see MEMORY: iOS runtime roadmap + the native bridge PoC):
//   just-bash builtin  ──(args,ctx)──▶  pythonMain
//        │  parses CPython CLI (-c / -m / FILE / - / -V / flags), builds sys.argv
//        ▼
//   binding.dispatch('python', argv, onData, onExit)  ──▶  native pthread that
//        holds the GIL, runs the code, and streams stdout(fd1)/stderr(fd2) back
//        through two pipes to onData(chunk, streamId) callbacks. The interpreter is
//        init-once (never finalized); each command gets a fresh __main__ dict.
//   We collect the streamed bytes into stdout/stderr strings and resolve with
//   { stdout, stderr, exitCode } — the shape just-bash consumes.
//
// The dispatch call returns immediately; the interpreter runs on a NATIVE thread,
// so a long/inf-loop Python program blocks that thread, NOT Node's event loop. We
// arm a watchdog (default 120s) and call binding.cancel(handle) on timeout, which
// asynchronously interrupts the interpreter (PyErr_SetInterrupt-style) and closes
// stdin to wake a blocked read.
//
// IMPORTANT for maintainers: the binding is loaded LAZILY (first python invocation)
// via _linkedBinding, which triggers the native py_init the first time. This keeps
// app launch cheap and lets a device without the module fall back to an honest
// "not available" message instead of throwing at load.

const DEFAULT_TIMEOUT_MS = 120000;
const BINDING_NAME = 'lshell_py';

// stream ids the native reader tags chunks with (see bridge: two pipes).
const STREAM_STDOUT = 1;
const STREAM_STDERR = 2;

// ── lazy binding acquisition ────────────────────────────────────────────────
// Cache the resolved binding (or the failure) so we probe the native module once.
let _binding;            // the binding object, once resolved
let _bindingResolved = false;
let _bindingError = null;

function getBinding() {
  if (_bindingResolved) return _binding;
  _bindingResolved = true;
  try {
    // _linkedBinding resolves a module statically linked into the app + registered
    // via NAPI_MODULE (the only way to load native code under iOS's no-dlopen rule).
    // The FIRST call triggers the native py_init (init-once interpreter bootstrap).
    // eslint-disable-next-line no-underscore-dangle
    const b = process._linkedBinding(BINDING_NAME);
    if (b && typeof b.dispatch === 'function') {
      _binding = b;
      // bridge-c exports an EXPLICIT py_init(home, path) — the binding does NOT
      // auto-init on first access. Bootstrap the interpreter here, once, pointing
      // PyConfig.home + module_search_paths at the bundled PYTHONHOME (env set by
      // NodeRunner.swift). Without this, dispatch() would run before Py_Initialize.
      try {
        if (typeof b.py_isReady === 'function' && !b.py_isReady() && typeof b.py_init === 'function') {
          const home = process.env.LSHELL_PYTHON_HOME || '';
          const searchPath = [process.env.LSHELL_PY_STDLIB, process.env.LSHELL_PY_DYNLOAD].filter(Boolean).join(':');
          b.py_init(home, searchPath);
        }
      } catch (e) {
        _bindingError = e;
        _binding = null;
      }
    } else {
      _bindingError = new Error('lshell_py binding missing dispatch()');
      _binding = null;
    }
  } catch (e) {
    // No such linked binding (dev host / simulator without the module built in).
    _bindingError = e;
    _binding = null;
  }
  return _binding;
}

// ── env / ctx helpers ───────────────────────────────────────────────────────
function ctxEnv(ctx) {
  if (!ctx) return {};
  if (ctx.exportedEnv) return ctx.exportedEnv;
  if (ctx.env instanceof Map) return Object.fromEntries(ctx.env);
  if (ctx.env && typeof ctx.env === 'object') return ctx.env;
  return {};
}

function resolveTimeoutMs(ctx, env) {
  // precedence: LSHELL_PY_TIMEOUT_MS env  >  ctx.limits.pyTimeoutMs  >  default.
  const fromEnv = env && env.LSHELL_PY_TIMEOUT_MS;
  if (fromEnv != null && fromEnv !== '') {
    const n = Number(fromEnv);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const lim = (ctx && ctx.limits) || {};
  if (lim.pyTimeoutMs != null) {
    const n = Number(lim.pyTimeoutMs);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_TIMEOUT_MS;
}

function isatty(ctx) {
  // The Bash tool never allocates a TTY; ctx.isTTY is undefined. Treat as false.
  return !!(ctx && ctx.isTTY);
}

// ── CPython CLI parsing ─────────────────────────────────────────────────────
// We emulate the subset of `python` option handling that matters on-device.
// Reference: `python --help`. Flags fall into three groups:
//   (A) MODE selectors, terminate option parsing for the interpreter:
//         -c CMD      run CMD as a program;   remaining args -> sys.argv[1:]
//         -m MOD      run library module MOD; remaining args -> sys.argv[1:]
//         FILE        run script FILE;         remaining args -> sys.argv[1:]
//         -           run stdin as a program
//       (with none of the above -> interactive REPL, which we refuse honestly)
//   (B) INFO flags handled entirely in JS (never reach the interpreter):
//         -V/--version, -VV, -h/--help, --help-*
//   (C) INTERPRETER flags forwarded to the native side (affect PyConfig):
//         -u -B -O -OO -I -E -S -s -q -d -v -x -b -bb -W arg -X arg
//       plus their bundled short forms (e.g. -uB). Unknown single flags are
//       forwarded verbatim; the native init decides what it honors.
//
// Returns one of:
//   { mode:'code',   code, argv0:'-c',   scriptArgs, flags }
//   { mode:'module', module, argv0,      scriptArgs, flags }   // argv0 filled native-side
//   { mode:'file',   file, argv0:file,   scriptArgs, flags }
//   { mode:'stdin',  argv0:'-',          scriptArgs, flags }
//   { mode:'repl',   flags }
//   { info:'version' | 'version2' | 'help', text }
//   { error: 'message', exitCode }

// Flags that take a SEPARATE argument value.
const VALUE_FLAGS = new Set(['-W', '-X']);
// Single-letter interpreter flags we recognize as bundleable (e.g. -uB, -IB).
// -O and -OO are handled specially (O may repeat). Everything here is a boolean.
const BOOL_LETTERS = new Set(['u', 'B', 'I', 'E', 'S', 's', 'q', 'd', 'v', 'x', 'b', 'O']);

function parseArgs(argv) {
  const flags = [];        // interpreter flags forwarded to native (group C)
  let i = 0;

  const pushLetter = (ch) => {
    // normalize each bundled letter back to its own `-x` token for the native side.
    flags.push('-' + ch);
  };

  for (; i < argv.length; i++) {
    const a = argv[i];

    if (a === '--') { i++; break; }      // end of options; next token is FILE (or none)
    if (a === '-') {                     // read program from stdin
      return { mode: 'stdin', argv0: '-', scriptArgs: argv.slice(i + 1), flags };
    }
    if (a.length === 0 || a[0] !== '-') { // first non-option token = script FILE
      return { mode: 'file', file: a, argv0: a, scriptArgs: argv.slice(i + 1), flags };
    }

    // ── long options ──
    if (a.startsWith('--')) {
      if (a === '--version') return { info: 'version' };
      if (a === '--help' || a === '--help-env' || a === '--help-xoptions' ||
          a === '--help-all') return { info: 'help' };
      if (a === '--check-hash-based-pyc' || a.startsWith('--check-hash-based-pyc=')) {
        flags.push(a); continue;
      }
      // Unknown long option: forward verbatim; native init tolerates/ignores.
      flags.push(a);
      continue;
    }

    // ── short-option cluster (a[0] === '-', a.length >= 2) ──
    // Walk the letters; a value-flag or mode-flag may terminate the cluster.
    let j = 1;
    while (j < a.length) {
      const ch = a[j];

      if (ch === 'c') {
        // -c CODE : the rest of THIS token (if any) is the code, else next token.
        const inline = a.slice(j + 1);
        let code;
        if (inline.length) { code = inline; }
        else { code = argv[i + 1]; i++; }
        if (code == null) return { error: "Argument expected for the -c option\n", exitCode: 2 };
        return { mode: 'code', code, argv0: '-c', scriptArgs: argv.slice(i + 1), flags };
      }

      if (ch === 'm') {
        const inline = a.slice(j + 1);
        let mod;
        if (inline.length) { mod = inline; }
        else { mod = argv[i + 1]; i++; }
        if (mod == null) return { error: "Argument expected for the -m option\n", exitCode: 2 };
        return { mode: 'module', module: mod, argv0: mod, scriptArgs: argv.slice(i + 1), flags };
      }

      if (ch === 'V') {
        // -V / -VV (bundled: -VV within one token). Any V => version.
        if (a.slice(j).replace(/[^V]/g, '').length >= 2) return { info: 'version2' };
        return { info: 'version' };
      }

      if (ch === 'h' || ch === '?') return { info: 'help' };

      if (ch === 'W' || ch === 'X') {
        // value flag: rest of token is the value, else next token.
        const inline = a.slice(j + 1);
        let val;
        if (inline.length) { val = inline; }
        else { val = argv[i + 1]; i++; }
        if (val == null) return { error: `Argument expected for the -${ch} option\n`, exitCode: 2 };
        flags.push('-' + ch, val);
        j = a.length;              // consumed rest of token
        continue;
      }

      if (BOOL_LETTERS.has(ch)) { pushLetter(ch); j++; continue; }

      // Unknown short flag letter: forward as its own token, keep scanning.
      pushLetter(ch);
      j++;
    }
    continue;
  }

  // Reached here only via `--` with a following FILE, or `--` with nothing after.
  if (i < argv.length) {
    const file = argv[i];
    return { mode: 'file', file, argv0: file, scriptArgs: argv.slice(i + 1), flags };
  }
  return { mode: 'repl', flags };
}

// ── sys.argv construction ───────────────────────────────────────────────────
// CPython sets sys.argv per mode:
//   -c CMD   : sys.argv = ['-c', ...scriptArgs]
//   -m MOD   : sys.argv = [<full path to module>, ...scriptArgs]  (native fills [0])
//   FILE     : sys.argv = [FILE, ...scriptArgs]
//   -        : sys.argv = ['-', ...scriptArgs]
// We pass argv0 + scriptArgs; the native side is responsible for the -m argv[0]
// rewrite (it knows the resolved module file). For -m we send the module name as a
// marker in the request, not as argv[0].
function buildSysArgv(parsed) {
  const args = parsed.scriptArgs || [];
  switch (parsed.mode) {
    case 'code':   return ['-c', ...args];
    case 'stdin':  return ['-', ...args];
    case 'file':   return [parsed.file, ...args];
    case 'module': return [parsed.argv0, ...args]; // native replaces [0] w/ module path
    default:       return [];
  }
}

// ── version / help text (JS-side, no interpreter needed) ────────────────────
const PY_VERSION = '3.13.14';
function versionLine() { return `Python ${PY_VERSION}\n`; }
function versionLine2() {
  return `Python ${PY_VERSION} (L Shell, CPython for iOS) [Clang]\n`;
}
function helpText() {
  return (
`usage: python3 [option] ... [-c cmd | -m mod | file | -] [arg] ...
Options (subset supported on this device):
  -c cmd   program passed in as string
  -m mod   run library module as a script
  -        program read from stdin
  -B       don't write .pyc files
  -E       ignore PYTHON* environment variables
  -I       isolated mode (implies -E and -s)
  -O / -OO optimize generated bytecode
  -q       don't print version/copyright on interactive startup
  -s       don't add user site directory to sys.path
  -S       don't imply 'import site' on initialization
  -u       force stdout/stderr to be unbuffered
  -v       verbose (trace import statements)
  -W arg   warning control
  -X opt   implementation-specific option
  -V, --version   print the Python version number and exit
  -h, --help      print this help message and exit
Interactive REPL is not available (no TTY on this device).
`);
}

// ── the native call: dispatch + collect streamed output + watchdog ──────────
// Resolves to { stdout, stderr, exitCode }. Never rejects; native/JS failures map
// to a non-zero exit with an explanatory stderr.
function runViaBridge(binding, request, ctx, timeoutMs) {
  return new Promise((resolve) => {
    const outChunks = [];
    const errChunks = [];
    let settled = false;
    let watchdog = null;
    let onAbort = null;
    const signal = ctx && ctx.signal;

    // The bridge dispatch signature is dispatch(argvArray, envObj, onData, onExit).
    // argvArray[0] = the Python source to run (PyRun_StringFlags); onData(buffer,
    // streamId) tags stdout(1)/stderr(2); onExit(code) fires once after all data.
    const argv = buildBridgeArgv(request, ctx);

    const finish = (exitCode, extraStderr) => {
      if (settled) return;
      settled = true;
      if (watchdog) { clearTimeout(watchdog); watchdog = null; }
      if (onAbort && signal) { try { signal.removeEventListener('abort', onAbort); } catch {} }
      let stderr = errChunks.join('');
      if (extraStderr) stderr += extraStderr;
      resolve({ stdout: outChunks.join(''), stderr, exitCode });
    };

    let handle;
    const onData = (chunk, streamId) => {
      const s = typeof chunk === 'string' ? chunk : bufToStr(chunk);
      if (streamId === STREAM_STDERR) errChunks.push(s);
      else outChunks.push(s);
    };
    const onExit = (code) => {
      finish(typeof code === 'number' ? code : 0);
    };

    try {
      handle = binding.dispatch(argv, request.env || {}, onData, onExit);
    } catch (e) {
      finish(1, `python3: interpreter dispatch failed: ${e && e.message}\n`);
      return;
    }

    // Feed stdin: for `-` and `-c`/`-m`/FILE alike, any piped ctx.stdin goes to the
    // program's sys.stdin. We write it all then close so a reading program sees EOF.
    const stdinStr = (ctx && typeof ctx.stdin === 'string') ? ctx.stdin : '';
    try {
      if (stdinStr && typeof binding.writeStdin === 'function') {
        binding.writeStdin(handle, Buffer.from(stdinStr, 'utf8'));
      }
      if (typeof binding.closeStdin === 'function') binding.closeStdin(handle);
    } catch { /* stdin plumbing best-effort */ }

    // Watchdog: native code runs off the event loop, so a runaway program cannot be
    // stopped by JS timers alone — we must ask the bridge to cancel (interrupt the
    // interpreter + close pipes). onExit then fires with the interrupt code.
    watchdog = setTimeout(() => {
      try { if (typeof binding.cancel === 'function') binding.cancel(handle); } catch {}
      // Give the native side a beat to deliver a real exit; if it doesn't, force one.
      setTimeout(() => finish(124,
        `python3: killed (timed out after ${timeoutMs} ms)\n`), 250);
    }, timeoutMs);
    if (watchdog.unref) watchdog.unref();

    // Cooperative abort from the Bash tool (Ctrl-C / tool interrupt / outer timeout).
    if (signal) {
      onAbort = () => {
        try { if (typeof binding.cancel === 'function') binding.cancel(handle); } catch {}
        setTimeout(() => finish(130, `python3: interrupted\n`), 250);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function bufToStr(b) {
  try { return Buffer.isBuffer(b) ? b.toString('utf8') : String(b); }
  catch { return ''; }
}

// The C bridge is a "dumb executor": it runs argvArray[0] as Python source via
// PyRun_StringFlags and seeds sys.argv from argvArray[..]. So the JS side must
// RESOLVE every mode to raw source here (read files, wrap -m in runpy, take stdin
// as the program). A one-line preamble fixes sys.argv (which the bridge would
// otherwise seed as [source, ...]) to the CPython-correct value, and sets
// __file__ for FILE mode. dispatch(argvArray, envObj, onData, onExit).
function pyStr(s) {
  return "'" + String(s == null ? '' : s)
    .replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r/g, '\\r').replace(/\n/g, '\\n') + "'";
}
function pyList(arr) { return '[' + (arr || []).map(pyStr).join(', ') + ']'; }

function resolveSource(request, ctx) {
  const nodeFs = safeRequire('node:fs') || safeRequire('fs');
  switch (request.mode) {
    case 'code':   return request.code || '';
    case 'stdin':  return (ctx && typeof ctx.stdin === 'string') ? ctx.stdin : '';
    case 'module': return `import runpy as _lrp\n_lrp.run_module(${pyStr(request.module || '')}, run_name='__main__', alter_sys=True)\n`;
    case 'file':
      try { return nodeFs ? nodeFs.readFileSync(request.file, 'utf8') : ''; }
      catch { return `raise SystemExit("python3: can't open file " + ${pyStr(request.file)})\n`; }
    default:       return '';
  }
}

// Where pip installs and where the interpreter must look. The embedded CPython
// uses IsolatedConfig (ignores PYTHONPATH / user-site), so we prepend site-packages
// to sys.path in the eval preamble — the same dir pip3 writes to (sitePackagesDir).
function pySiteDir() {
  try { return require('./pip-command.js').sitePackagesDir(process.env); } catch { return null; }
}

function buildBridgeArgv(request, ctx) {
  const sysArgv = request.sysArgv || [];
  const src = resolveSource(request, ctx);
  const site = pySiteDir();
  const parts = ['import sys as _l', `_l.argv = ${pyList(sysArgv)}`];
  if (site) parts.push(`_s = ${pyStr(site)}`, '(_s in _l.path) or _l.path.insert(0, _s)');
  if (request.mode === 'file' && request.file) parts.push(`__file__ = ${pyStr(request.file)}`);
  parts.push('del _l' + (site ? ', _s' : ''));
  // Single-line preamble → user tracebacks are off by at most one line.
  return [parts.join('; ') + '\n' + src];
}

// ── the just-bash command handler ───────────────────────────────────────────
async function pythonMain(args, ctx = {}) {
  args = Array.isArray(args) ? args : [];
  const env = ctxEnv(ctx);

  const parsed = parseArgs(args);

  // Info flags: answer entirely in JS.
  if (parsed.info === 'version')  return { stdout: versionLine(),  stderr: '', exitCode: 0 };
  if (parsed.info === 'version2') return { stdout: versionLine2(), stderr: '', exitCode: 0 };
  if (parsed.info === 'help')     return { stdout: helpText(),     stderr: '', exitCode: 0 };

  // Parse errors (missing -c/-m argument).
  if (parsed.error) return { stdout: '', stderr: parsed.error, exitCode: parsed.exitCode || 2 };

  // Interactive REPL: there is no TTY under the Bash tool. Refuse honestly instead
  // of hanging on a stdin read that never yields a prompt.
  if (parsed.mode === 'repl') {
    if (isatty(ctx)) {
      // Should not happen on-device, but if a TTY ever exists, still refuse (the
      // native side has no line-editing REPL wired). Keep the message honest.
      return {
        stdout: '',
        stderr: 'python3: interactive REPL is not supported on this device. ' +
          'Use `python3 -c "..."`, `python3 file.py`, or pipe a program: `... | python3 -`.\n',
        exitCode: 1,
      };
    }
    return {
      stdout: '',
      stderr: 'python3: no interactive REPL without a terminal. ' +
        'Run code with `python3 -c "..."`, a script `python3 file.py`, a module ' +
        '`python3 -m mod`, or pipe a program: `echo "print(1)" | python3 -`.\n',
      exitCode: 1,
    };
  }

  // Acquire the native interpreter binding (lazy; triggers py_init first time).
  const binding = getBinding();
  if (!binding) {
    return {
      stdout: '',
      stderr: 'python3: the embedded Python interpreter is not available in this ' +
        'build. (No lshell_py native module linked.)\n',
      exitCode: 127,
    };
  }

  // For FILE mode, surface a clean "file not found" without spinning up the
  // interpreter for an obvious miss. We resolve relative to ctx.cwd.
  if (parsed.mode === 'file') {
    const nodeFs = safeRequire('node:fs') || safeRequire('fs');
    const nodePath = safeRequire('node:path') || safeRequire('path');
    if (nodeFs && nodePath) {
      const cwd = (ctx && ctx.cwd) || process.cwd();
      const abs = nodePath.isAbsolute(parsed.file) ? parsed.file : nodePath.resolve(cwd, parsed.file);
      if (!nodeFs.existsSync(abs)) {
        return {
          stdout: '',
          stderr: `python3: can't open file '${parsed.file}': [Errno 2] No such file or directory\n`,
          exitCode: 2,
        };
      }
      parsed.file = abs; // hand the interpreter an absolute path
      parsed.argv0 = abs;
    }
  }

  const request = {
    mode: parsed.mode,
    code: parsed.code,
    module: parsed.module,
    file: parsed.file,
    flags: parsed.flags,
    env: filteredPythonEnv(env, parsed.flags),
    sysArgv: buildSysArgv(parsed),
  };

  const timeoutMs = resolveTimeoutMs(ctx, env);
  return runViaBridge(binding, request, ctx, timeoutMs);
}

// Only forward PYTHON* env unless -E or -I isolate the environment.
function filteredPythonEnv(env, flags) {
  const isolated = flags.includes('-E') || flags.includes('-I');
  if (isolated) return {};
  const out = {};
  for (const k in env) {
    if (k === 'PATH' || k === 'HOME' || k === 'TMPDIR' || k.startsWith('PYTHON')) {
      out[k] = String(env[k]);
    }
  }
  return out;
}

function safeRequire(name) { try { return require(name); } catch { return null; } }

// ── registration ────────────────────────────────────────────────────────────
// Registers python3 AND python (alias). Also serves `-m pip` style delegation is
// left to the native module (pip is a stdlib-adjacent module bundled separately).
function registerPython(bash, defineCommand) {
  if (typeof defineCommand !== 'function') {
    try { ({ defineCommand } = require('just-bash')); } catch { return; }
  }
  if (typeof defineCommand !== 'function') return;
  const handler = (args, ctx) => pythonMain(args, ctx);
  for (const name of ['python3', 'python']) {
    try { bash.registerCommand(defineCommand(name, handler)); } catch { /* build lacks defineCommand → skip */ }
  }
}

module.exports = {
  registerPython,
  pythonMain,
  // exported for unit tests:
  parseArgs,
  buildSysArgv,
  buildBridgeArgv,
  resolveSource,
  _setBindingForTest(b) { _binding = b; _bindingResolved = true; _bindingError = null; },
};
