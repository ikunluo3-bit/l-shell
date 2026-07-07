'use strict';
// In-process `node` executor for the L Shell iOS runtime (jitless nodejs-mobile).
//
// iOS has no fork/exec and jitless V8 has no WebAssembly, so there is no real `node`
// binary to run. But the HOST *is* Node — so user JS can run IN-PROCESS. This module
// is the non-interactive runner Claude's Bash tool reaches when a script does
// `node file.js` / `node -e '…'` (the token runs inside just-bash, which dispatches to
// the `node` builtin registered in register.js).
//
// PRIMARY PATH: `vm.compileFunction` (CJS bindings) invoked through a one-line
// `vm.runInContext(…, {timeout})` trampoline — that {timeout} is what arms V8's
// interrupt and preempts a synchronous infinite loop (verified jitless). An async
// drain phase, bounded by an overall wall-clock deadline, lets timers/promises settle.
// ESM files run best-effort via dynamic import() (no sync-loop guard — documented).
//
// The just-bash command contract (verified live): the handler is called as
// `handler(args, ctx)` where `args` is the argv array after `node` and `ctx` carries
// `{ fs, cwd, env:Map, exportedEnv, stdin:string, signal, limits, … }`. It must return
// `{ stdout, stderr, exitCode }`.

const vm = require('node:vm');
const path = require('node:path');
const fsp = require('node:fs/promises');
const { format: utilFormat, inspect: utilInspect } = require('node:util');
const { createRequire } = require('node:module');

const MAX_OUTPUT = 1 * 1024 * 1024;   // 1 MB cap per stream
const CODE_TIMEOUT = 124;             // coreutils `timeout` convention
const CODE_ABORT = 130;               // 128 + SIGINT

// Strip host-internal frames from a user error's stack so the trace reads like a
// normal `node` crash rather than exposing our vm trampoline.
function sanitizeStack(e) {
  const raw = e && e.stack ? String(e.stack) : String(e);
  return raw.split('\n').filter((ln) => !(
    /evalmachine\.<anonymous>/.test(ln) ||
    /node:vm(:|$)/.test(ln) ||
    /node:internal\/vm/.test(ln) ||
    /runScriptInThisContext/.test(ln) ||
    /node-runner\.js/.test(ln) ||
    /node:internal\/modules/.test(ln)
  )).join('\n');
}

class SandboxExit extends Error {
  constructor(code) { super('__sandbox_exit_' + code); this.name = 'SandboxExit'; this.code = code | 0; this.__sandboxExit = true; }
}

function bufToStr(x) {
  if (x == null) return '';
  if (typeof x === 'string') return x;
  if (Buffer.isBuffer(x)) return x.toString('utf8');
  if (x instanceof Uint8Array) return Buffer.from(x).toString('utf8');
  return String(x);
}

// A capped sink mimicking a writable stdout/stderr.
function makeSink() {
  let buf = '';
  let truncated = false;
  return {
    write(chunk) {
      if (truncated) return true;
      const s = bufToStr(chunk);
      if (buf.length + s.length > MAX_OUTPUT) {
        buf += s.slice(0, Math.max(0, MAX_OUTPUT - buf.length)) + '\n[output truncated at 1MB]\n';
        truncated = true;
      } else {
        buf += s;
      }
      return true;
    },
    get value() { return buf; },
  };
}

// require() for the sandbox: node builtins resolve normally (child_process is already
// globally patched to the interception shim via Module._load), user modules resolve
// relative to the script dir. Lazy so a syntax error never surfaces a createRequire frame.
function makeSandboxRequire(base) {
  let baseRequire = null;
  const get = () => (baseRequire || (baseRequire = createRequire(base)));
  const req = (id) => get()(id);
  req.resolve = (id) => get().resolve(id);
  req.cache = {};
  return req;
}

/**
 * Run JS source in-process and capture its output.
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
async function runNode(code, opts = {}) {
  const {
    scriptPath, argv = [], cwd = process.cwd(), env = process.env,
    signal, syncTimeout = 5000, totalDeadline = 10000,
  } = opts;

  const stdout = makeSink();
  const stderr = makeSink();
  const filename = scriptPath || '[eval]';
  const absCwd = path.isAbsolute(cwd) ? cwd : path.resolve(process.cwd(), cwd || '.');
  const dirname = scriptPath ? path.dirname(scriptPath) : absCwd;

  // pending async accounting
  let pendingTimers = 0;
  const liveTimers = new Set();
  let asyncError = null;
  const start = Date.now();
  const budgetLeft = () => Math.max(0, totalDeadline - (Date.now() - start));
  const wrapCb = (fn, args) => () => {
    try { fn(...args); } catch (e) { asyncError = asyncError || e; }
  };
  const sSetTimeout = (fn, ms, ...a) => {
    if (typeof fn !== 'function') return 0;
    pendingTimers++;
    const id = setTimeout(() => { liveTimers.delete(id); pendingTimers--; wrapCb(fn, a)(); },
      Math.min(Math.max(0, Number(ms) || 0), totalDeadline));
    liveTimers.add(id); return id;
  };
  const sClearTimeout = (id) => { if (liveTimers.has(id)) { clearTimeout(id); liveTimers.delete(id); pendingTimers--; } };
  const sSetInterval = (fn, ms, ...a) => {
    if (typeof fn !== 'function') return 0;
    pendingTimers++;
    const id = setInterval(() => wrapCb(fn, a)(), Math.min(Math.max(1, Number(ms) || 1), totalDeadline));
    liveTimers.add(id); return id;
  };
  const sClearInterval = (id) => { if (liveTimers.has(id)) { clearInterval(id); liveTimers.delete(id); pendingTimers--; } };

  const proc = {
    argv: ['node', filename, ...argv.map(String)],
    argv0: 'node',
    env: Object.assign({}, env),
    platform: process.platform, arch: process.arch,
    version: process.version, versions: process.versions, pid: process.pid,
    cwd: () => absCwd, chdir() {},
    exitCode: 0,
    exit(code) { throw new SandboxExit(code == null ? proc.exitCode : code); },
    nextTick: (fn, ...a) => queueMicrotask(() => wrapCb(fn, a)()),
    hrtime: process.hrtime, memoryUsage: process.memoryUsage, umask: () => 0,
    stdout: { write: (c) => stdout.write(c), isTTY: false, columns: 80, rows: 24 },
    stderr: { write: (c) => stderr.write(c), isTTY: false, columns: 80, rows: 24 },
    stdin: { isTTY: false, on() {}, once() {}, read() { return null; }, resume() {}, pause() {}, setEncoding() {} },
    on() { return proc; }, once() { return proc; }, off() { return proc; },
    emit() { return false; }, removeListener() { return proc; }, addListener() { return proc; },
  };

  const mkLog = (sink) => (...a) => sink.write(utilFormat(...a) + '\n');
  const sandboxConsole = {
    log: mkLog(stdout), info: mkLog(stdout), debug: mkLog(stdout),
    error: mkLog(stderr), warn: mkLog(stderr), trace: mkLog(stderr),
    dir: (o, opt) => stdout.write(utilInspect(o, opt) + '\n'),
    assert: (c, ...a) => { if (!c) stderr.write('Assertion failed' + (a.length ? ': ' + utilFormat(...a) : '') + '\n'); },
    table: (d) => stdout.write(utilFormat(d) + '\n'),
    group: mkLog(stdout), groupCollapsed: mkLog(stdout), groupEnd() {},
    count() {}, countReset() {}, time() {}, timeEnd() {}, timeLog() {}, clear() {},
  };

  const requireBase = scriptPath || path.join(absCwd, '__node_eval__.js');
  const sandboxRequire = makeSandboxRequire(requireBase);
  const moduleObj = { exports: {}, id: filename, filename, loaded: false, paths: [], require: sandboxRequire };

  const globals = {
    console: sandboxConsole, process: proc, Buffer,
    setTimeout: sSetTimeout, clearTimeout: sClearTimeout,
    setInterval: sSetInterval, clearInterval: sClearInterval,
    setImmediate: (fn, ...a) => sSetTimeout(fn, 0, ...a), clearImmediate: sClearTimeout,
    queueMicrotask: (fn) => queueMicrotask(wrapCb(fn, [])),
    TextEncoder, TextDecoder, URL, URLSearchParams,
    structuredClone: typeof structuredClone === 'function' ? structuredClone : undefined,
    atob: typeof atob === 'function' ? atob : undefined,
    btoa: typeof btoa === 'function' ? btoa : undefined,
    fetch: typeof fetch === 'function' ? fetch : undefined,
    Math, JSON, Date, Promise, Symbol, Reflect, Proxy, RegExp, Error,
    AbortController, AbortSignal, Event, EventTarget,
  };

  const context = vm.createContext(globals);
  vm.runInContext('globalThis.global = globalThis;', context);

  let aborted = false;
  const onAbort = () => { aborted = true; };
  if (signal) { if (signal.aborted) aborted = true; else signal.addEventListener('abort', onAbort, { once: true }); }

  let exitCode = 0;
  try {
    const wrapped = vm.compileFunction(
      code, ['exports', 'require', 'module', '__filename', '__dirname'],
      { filename, parsingContext: context },
    );
    // vm.compileFunction has no per-call timeout; arm V8's interrupt via a one-line
    // trampoline that DOES accept {timeout} — this preempts sync infinite loops.
    context.__wrapped__ = wrapped;
    context.__args__ = [moduleObj.exports, sandboxRequire, moduleObj, filename, dirname];
    vm.runInContext('__wrapped__.apply(undefined, __args__)', context, { timeout: syncTimeout });
    delete context.__wrapped__; delete context.__args__;

    while (pendingTimers > 0 && !asyncError && !aborted && budgetLeft() > 0) {
      await new Promise((r) => setTimeout(r, 5));
    }
    if (asyncError) throw asyncError;
    if (aborted) { exitCode = CODE_ABORT; stderr.write('\nnode: aborted\n'); }
    else if (pendingTimers > 0) { exitCode = CODE_TIMEOUT; stderr.write('\nnode: timeout after ' + totalDeadline + 'ms (async work still pending)\n'); }
    else exitCode = proc.exitCode | 0;
  } catch (e) {
    if (e && e.__sandboxExit) exitCode = e.code | 0;
    else if (e && /timed out/i.test(String(e.message))) { exitCode = CODE_TIMEOUT; stderr.write('node: script timed out after ' + syncTimeout + 'ms\n'); }
    else { exitCode = 1; stderr.write(sanitizeStack(e) + '\n'); }
  } finally {
    for (const id of liveTimers) { clearTimeout(id); clearInterval(id); }
    liveTimers.clear();
    if (signal) { try { signal.removeEventListener('abort', onAbort); } catch {} }
  }

  return { code: exitCode, stdout: stdout.value, stderr: stderr.value };
}

function looksLikeEsm(src, scriptPath) {
  if (scriptPath && scriptPath.endsWith('.mjs')) return true;
  if (scriptPath && scriptPath.endsWith('.cjs')) return false;
  return /^\s*import\s.+\sfrom\s|^\s*import\s*['"]|^\s*export\s(default|const|function|class|\{|let|var|async)/m.test(src);
}

// Best-effort ESM: dynamic import() shares the host realm, so we temporarily redirect
// host console + process std writes to our sinks (restored in finally). NO sync-loop
// guard (import ignores timeout) — a sync infinite loop in ESM top-level hangs. v1 limit.
async function runEsmBestEffort(scriptPath, { argv = [], totalDeadline = 10000 } = {}) {
  const stdout = makeSink();
  const stderr = makeSink();
  const realConsole = global.console;
  const realArgv = process.argv;
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  const mkLog = (sink) => (...a) => sink.write(utilFormat(...a) + '\n');
  global.console = Object.assign(Object.create(realConsole), {
    log: mkLog(stdout), info: mkLog(stdout), debug: mkLog(stdout), error: mkLog(stderr), warn: mkLog(stderr),
  });
  process.stdout.write = (c) => { stdout.write(c); return true; };
  process.stderr.write = (c) => { stderr.write(c); return true; };
  process.argv = ['node', scriptPath, ...argv.map(String)];
  let code = 0;
  try {
    const { pathToFileURL } = require('node:url');
    const url = pathToFileURL(scriptPath).href + '?t=' + Date.now();
    const timer = new Promise((_, rej) => setTimeout(() => rej(new Error('esm timeout')), totalDeadline));
    await Promise.race([import(url), timer]);
  } catch (e) {
    if (/esm timeout/.test(String(e && e.message))) { code = CODE_TIMEOUT; stderr.write('node: ESM timed out after ' + totalDeadline + 'ms\n'); }
    else { code = 1; stderr.write(sanitizeStack(e) + '\n'); }
  } finally {
    global.console = realConsole;
    process.stdout.write = realOut;
    process.stderr.write = realErr;
    process.argv = realArgv;
  }
  return { code, stdout: stdout.value, stderr: stderr.value };
}

// just-bash command handler: `node [flags] [file] [args]`. Signature (args, ctx).
// Returns { stdout, stderr, exitCode } — the shape just-bash consumes.
async function nodeCommandHandler(args, ctx = {}) {
  args = Array.isArray(args) ? args : [];
  const cwd = ctx.cwd || process.cwd();
  const env = ctx.exportedEnv || (ctx.env instanceof Map ? Object.fromEntries(ctx.env) : ctx.env) || {};
  const signal = ctx.signal;
  const limits = ctx.limits || {};
  // Cap the synchronous budget at 5s: a sync infinite loop freezes the single event
  // loop until vm's {timeout} preempts it, so bound that freeze regardless of the
  // (larger) command-level limit just-bash passes.
  const syncTimeout = Math.min(Number(limits.maxJsTimeoutMs) || 5000, 5000);

  const wrap = (r) => ({ stdout: r.stdout, stderr: r.stderr, exitCode: r.code });

  // Fast paths that don't run code.
  if (args[0] === '--version' || args[0] === '-v') {
    return { stdout: process.version + '\n', stderr: '', exitCode: 0 };
  }

  let code = null, scriptPath = null;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (code == null && scriptPath == null && (a === '-e' || a === '--eval' || a === '-p' || a === '--print')) {
      code = args[++i] || '';
      if (a === '-p' || a === '--print') code = 'console.log((' + code + '))';
      continue;
    }
    if (code == null && scriptPath == null && a === '--') continue;
    if (code == null && scriptPath == null && a === '-') { scriptPath = null; break; } // read stdin
    if (code == null && scriptPath == null && a.startsWith('-')) continue; // ignore other flags
    if (code == null && scriptPath == null) { scriptPath = path.isAbsolute(a) ? a : path.resolve(cwd, a); continue; }
    rest.push(a);
  }

  if (code != null) return wrap(await runNode(code, { argv: rest, cwd, env, signal, syncTimeout }));

  if (scriptPath != null) {
    let src;
    try { src = await fsp.readFile(scriptPath, 'utf8'); }
    catch { return { stdout: '', stderr: `node: cannot find module '${scriptPath}'\n`, exitCode: 1 }; }
    if (looksLikeEsm(src, scriptPath)) return wrap(await runEsmBestEffort(scriptPath, { argv: rest }));
    return wrap(await runNode(src, { scriptPath, argv: rest, cwd, env, signal, syncTimeout }));
  }

  // Bare `node` (or `node -`): run piped stdin as the script if present, else no-op.
  const stdin = typeof ctx.stdin === 'string' ? ctx.stdin : '';
  if (stdin.trim()) return wrap(await runNode(stdin, { argv: rest, cwd, env, signal, syncTimeout }));
  return { stdout: '', stderr: '', exitCode: 0 };
}

module.exports = { runNode, runEsmBestEffort, nodeCommandHandler, looksLikeEsm, SandboxExit, CODE_TIMEOUT, CODE_ABORT };
