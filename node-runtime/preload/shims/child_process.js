'use strict';
// child_process interception for iOS (no fork/exec). Patches every export of
// node:child_process so Claude Code's ~41 call sites run in-process instead of
// spawning. Async spawns return a fake ChildProcess (EventEmitter + stdio streams);
// sync variants return a spawnSync-shaped result object.
//
// Routing is a registry of command handlers. Unknown commands degrade gracefully
// (exit 127, ENOENT) — Claude Code treats most optional tools (gh/tmux/osascript…)
// as best-effort. The load-bearing ones (bash/sh, rg) get real handlers wired in
// via registerCommand() from index.js (backed by just-bash).
//
// Interruption: kill() / options.signal / options.timeout all funnel into ONE
// internal AbortController whose signal is passed to the handler (AbortSignal.any
// is Node 20+, so the combining is manual). cli.js's Bash tool does NOT call
// child.kill() — it tree-kills by pid (process.kill(pid,'SIGKILL') after a
// pgrep/ps walk) — so install() also routes process.kill of live fake pids to
// the fake child. Killed children match Node: 'exit' (null, signal), killed=true.

const { EventEmitter } = require('node:events');
const { Readable, Writable } = require('node:stream');
const fs = require('node:fs');
const nodePath = require('node:path');

const LOG = [];                 // every intercepted spawn, for diagnostics
const registry = new Map();     // name -> async handler({args, input, env, cwd, signal, timeout}) -> {code, stdout, stderr}
const syncRegistry = new Map(); // name -> sync handler(...) -> {code, stdout, stderr[, signal]}
const liveChildren = new Map(); // fake pid -> child, only while running (process.kill routing)

// numeric signal -> name (kill(15) etc.); unknown numbers fall back to SIGTERM.
const SIGNAMES = (() => {
  const m = new Map();
  try { const s = require('node:os').constants.signals; for (const k in s) m.set(s[k], k); } catch {}
  return m;
})();
function signalName(sig, dflt) {
  if (sig === undefined || sig === null) return dflt || 'SIGTERM';
  if (typeof sig === 'number') return SIGNAMES.get(sig) || dflt || 'SIGTERM';
  return String(sig);
}

function baseName(file) {
  if (!file) return '';
  const f = String(file).replace(/\\/g, '/');
  const parts = f.split('/');
  return parts[parts.length - 1];
}

// Split a shell-ish invocation into a command key we can route on.
function commandKey(file, args) {
  const b = baseName(file);
  return b;
}

function registerCommand(name, handler, syncHandler) {
  registry.set(name, handler);
  if (syncHandler) syncRegistry.set(name, syncHandler);
}

// ---- caller-provided fd redirection ---------------------------------------
// Claude Code's Bash tool (non-streaming, the default) spawns the shell with
// `stdio: ['pipe', fd, fd]` — it redirects the child's stdout+stderr to a file
// it opened, then reads that file back. It NEVER consumes child.stdout in this
// mode. Since we run the command in-process (no real child inherits the fd), we
// must deliver the handler's output to that file ourselves, or the file stays
// empty and Claude reports "(Bash completed with no output)" for commands that
// in fact produced output — while exit codes (carried by the 'exit' event) come
// through fine.
//
// The hard part is timing: the caller closes its own copy of the fd immediately
// after spawn (`await S.close()`), long before our async handler produces output,
// so writing to the raw fd in finish() hits EBADF. And on iOS /dev/fd/N is
// unavailable (ENOENT) — devfs fd cloning is not in the app sandbox — so we
// cannot dup the fd either. The robust route is to write by PATH: we track the
// path each fd was opened with (installFdPathTracking patches fs open), capture
// it at spawn time, and append the output to that path in finish(). This
// sidesteps the close race and needs no /dev/fd. /dev/fd dup and a raw-fd write
// remain as best-effort fallbacks for platforms/paths where the path is unknown.
// Streaming spawns (stdio all 'pipe', used when an onStdout callback is present)
// are untouched — Claude reads child.stdout there, which we still populate.
const fdPaths = new Map(); // live fd -> absolute path it was opened with

function installFdPathTracking() {
  const record = (p, fd) => {
    try {
      if (typeof fd !== 'number' || typeof p !== 'string') return;
      fdPaths.set(fd, nodePath.resolve(p));
      if (fdPaths.size > 1024) { const k = fdPaths.keys().next().value; fdPaths.delete(k); }
    } catch {}
  };
  if (typeof fs.openSync === 'function' && !fs.openSync.__lshellFdTrack) {
    const orig = fs.openSync;
    const patched = function (p, ...rest) { const fd = orig.apply(this, arguments); record(p, fd); return fd; };
    patched.__lshellFdTrack = true;
    try { fs.openSync = patched; } catch {}
  }
  const fsp = fs.promises;
  if (fsp && typeof fsp.open === 'function' && !fsp.open.__lshellFdTrack) {
    const orig = fsp.open;
    const patched = async function (p, ...rest) { const h = await orig.apply(this, arguments); try { if (h && typeof h.fd === 'number') record(p, h.fd); } catch {} return h; };
    patched.__lshellFdTrack = true;
    try { fsp.open = patched; } catch {}
  }
  // Also the callback form fs.open(path, [flags], [mode], cb): if Claude's Bash tool
  // opens the redirect file this way, setupFdRedirect would otherwise get no path and the
  // on-device fallbacks (/dev/fd dup, raw fd write) both fail → output silently dropped
  // ('采集为空'). Tracking it here closes that gap.
  if (typeof fs.open === 'function' && !fs.open.__lshellFdTrack) {
    const orig = fs.open;
    const patched = function (p, ...rest) {
      const cb = rest[rest.length - 1];
      if (typeof cb === 'function') {
        rest[rest.length - 1] = function (err, fd) { if (!err) record(p, fd); return cb.apply(this, arguments); };
      }
      return orig.call(this, p, ...rest);
    };
    patched.__lshellFdTrack = true;
    try { fs.open = patched; } catch {}
  }
}

function fdDebug(msg) {
  if (process.env.LSHELL_BASH_DEBUG !== '1') return;
  try { fs.appendFileSync((process.env.HOME || '/tmp') + '/lshell-fd-debug.log', `[${Date.now()}] ${msg}\n`); } catch {}
}
function dupOwnedFd(fd) {
  try { const d = fs.openSync('/dev/fd/' + fd, 'a'); return d; } catch { return null; }
}
function setupFdRedirect(options) {
  const stdio = options && options.stdio;
  if (!Array.isArray(stdio)) return null;
  const oFd = typeof stdio[1] === 'number' ? stdio[1] : null;
  const eFd = typeof stdio[2] === 'number' ? stdio[2] : null;
  if (oFd == null && eFd == null) return null;
  // Snapshot the path (if known) NOW, at spawn time, before the caller closes
  // the fd or reuses the number.
  const oPath = oFd != null ? fdPaths.get(oFd) : null;
  const ePath = eFd != null ? fdPaths.get(eFd) : null;
  // Only /dev/fd-dup fds we have no path for (fallback). Dedupe shared fds.
  const dups = new Map();
  if (oFd != null && !oPath && !dups.has(oFd)) dups.set(oFd, dupOwnedFd(oFd));
  if (eFd != null && !ePath && !dups.has(eFd)) dups.set(eFd, dupOwnedFd(eFd));
  fdDebug(`redirect oFd=${oFd}(${oPath ? 'path' : 'nopath'}) eFd=${eFd}(${ePath ? 'path' : 'nopath'})`);
  const writeOne = (fd, filePath, buf) => {
    if (fd == null || !buf || !buf.length) return;
    if (filePath) {
      try { fs.appendFileSync(filePath, buf); fdDebug(`append fd=${fd} bytes=${buf.length}`); return; }
      catch (e) { fdDebug(`append FAIL fd=${fd} err=${e && e.code}`); }
    }
    const dup = dups.get(fd);
    try { const n = fs.writeSync(dup != null ? dup : fd, buf); fdDebug(`write fd=${fd} via=${dup != null ? 'dup' : 'raw'} bytes=${n}`); }
    catch (e) { fdDebug(`write FAIL fd=${fd} err=${e && e.code}`); }
  };
  return {
    // stdout then stderr; when they share one target this preserves that order.
    write(outBuf, errBuf) { writeOne(oFd, oPath, outBuf); writeOne(eFd, ePath, errBuf); },
    close() { for (const d of dups.values()) if (d != null) { try { fs.closeSync(d); } catch {} } },
  };
}

// Sync variant: spawnSync blocks, so the caller's fd is still open when we run —
// write straight to it (path also works). (Claude never passes an fd to
// spawnSync; this only keeps parity for other callers.)
function writeSyncFds(options, outBuf, errBuf) {
  const stdio = options && options.stdio;
  if (!Array.isArray(stdio)) return;
  const oFd = typeof stdio[1] === 'number' ? stdio[1] : null;
  const eFd = typeof stdio[2] === 'number' ? stdio[2] : null;
  const put = (fd, buf) => {
    if (fd == null || !buf || !buf.length) return;
    const p = fdPaths.get(fd);
    try { if (p) fs.appendFileSync(p, buf); else fs.writeSync(fd, buf); } catch {}
  };
  put(oFd, outBuf); put(eFd, errBuf);
}

// ---- async spawn ----------------------------------------------------------
function makeChild(file, args, options = {}) {
  const child = new EventEmitter();
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const stdinChunks = [];
  const stdin = new Writable({ write(c, e, cb) { stdinChunks.push(Buffer.from(c)); cb(); } });
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = stdin;
  child.pid = nextPid();
  child.killed = false;
  child.exitCode = null;
  child.signalCode = null;
  child.spawnfile = file;
  child.spawnargs = [file, ...(args || [])];
  child.ref = () => child;
  child.unref = () => child;

  const key = commandKey(file, args);
  const handler = registry.get(key);
  const entry = { file, key, args: args || [], cwd: options.cwd || process.cwd(), routed: !!handler, ts: Date.now() };
  LOG.push(entry);
  if (process.env.CLAUDE_IOS_DEBUG) process.stderr.write(`[cp] spawn ${handler ? 'ROUTED' : 'ENOENT'} file=${JSON.stringify(file)} key=${key} args=${JSON.stringify((args || []).slice(0, 5))}\n`);

  // Dup any caller-provided output fds NOW, while they are still open (the
  // caller closes its copy right after spawn). Delivered in finish().
  const redirect = setupFdRedirect(options);

  // ---- interruption plumbing ----
  const killSignal = signalName(options.killSignal, 'SIGTERM');
  const ac = new AbortController();
  const externalSignal = options.signal;
  let finished = false;
  let abortedWith = null; // signal name once kill/timeout/abort landed
  let timeoutTimer = null;
  let graceTimer = null;

  const finish = (code, signal, outBuf, errBuf) => {
    if (finished) return;
    finished = true;
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (graceTimer) clearTimeout(graceTimer);
    if (externalSignal) { try { externalSignal.removeEventListener('abort', onExternalAbort); } catch {} }
    liveChildren.delete(child.pid);
    if (outBuf && outBuf.length) stdout.push(outBuf);
    if (errBuf && errBuf.length) stderr.push(errBuf);
    stdout.push(null);
    stderr.push(null);
    // Deliver to caller-provided file fds (Claude's default Bash tool reads the
    // file, not child.stdout). No-op when stdio uses pipes.
    if (redirect) { try { redirect.write(outBuf, errBuf); } finally { redirect.close(); } }
    // No data consumer → force flowing so 'end' still fires; otherwise a consumer
    // awaiting stdout 'end' (pipeline/for-await) would hang on a paused stream.
    if (stdout.listenerCount('data') === 0) stdout.resume();
    if (stderr.listenerCount('data') === 0) stderr.resume();
    child.exitCode = signal ? null : code;
    child.signalCode = signal || null;
    process.nextTick(() => {
      child.emit('exit', signal ? null : code, signal || null);
      child.emit('close', signal ? null : code, signal || null);
    });
  };

  const doAbort = (sig) => {
    if (finished || abortedWith) return;
    abortedWith = sig;
    child.killed = true;
    try { ac.abort(); } catch {}
    // Cooperative handlers (just-bash stops at the next statement boundary)
    // settle within ms. The grace timer force-exits for handlers that ignore
    // the signal so a kill can never hang the caller. unref: must not hold
    // the loop open on its own.
    graceTimer = setTimeout(() => finish(null, abortedWith), 1000);
    if (graceTimer.unref) graceTimer.unref();
  };

  const onExternalAbort = () => {
    // Node emits an AbortError 'error' for options.signal aborts. Guarded emit:
    // an unhandled 'error' would take down the singleton runtime (real Node
    // would crash too, so no caller can depend on the crash).
    if (child.listenerCount('error') > 0) {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      err.code = 'ABORT_ERR';
      child.emit('error', err);
    }
    doAbort(killSignal);
  };

  child.kill = function (sig) {
    if (sig === 0) return !finished; // signal 0 = existence probe, never kills
    if (finished) return false;
    try { child.emit('__kill', sig); } catch {}
    doAbort(signalName(sig, 'SIGTERM'));
    return true;
  };

  liveChildren.set(child.pid, child);
  if (externalSignal) {
    if (externalSignal.aborted) process.nextTick(onExternalAbort);
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }
  const tmo = Number(options.timeout);
  if (tmo > 0 && Number.isFinite(tmo)) timeoutTimer = setTimeout(() => doAbort(killSignal), tmo);

  // Emit 'spawn' asynchronously like the real thing.
  process.nextTick(() => child.emit('spawn'));

  if (handler) {
    const input = () => Buffer.concat(stdinChunks);
    // stdin may be written after spawn; defer one tick so 'bash -c' scripts that
    // pipe via stdin get their data. Handlers that don't read stdin ignore it.
    setImmediate(async () => {
      if (finished) return;
      if (abortedWith) return finish(null, abortedWith); // killed before start
      try {
        const res = await handler({ file, args: args || [], input: input(), env: options.env || process.env, cwd: entry.cwd, signal: ac.signal, timeout: tmo > 0 ? tmo : undefined });
        // Killed mid-flight: Node reports (null, signal); whatever output the
        // handler still returned is delivered (just-bash discards its buffer
        // on abort, so shells report empty output — handlers may differ).
        if (abortedWith) finish(null, abortedWith, toBuf(res && res.stdout), toBuf(res && res.stderr));
        else finish((res && res.code) || 0, null, toBuf(res && res.stdout), toBuf(res && res.stderr));
      } catch (e) {
        if (abortedWith) finish(null, abortedWith);
        else finish(1, null, null, Buffer.from(String(e && e.stack || e) + '\n'));
      }
    });
  } else {
    // Unknown command: behave like exec of a missing binary.
    process.nextTick(() => {
      if (finished) return;
      const err = new Error(`spawn ${file} ENOENT`);
      err.code = 'ENOENT'; err.errno = -2; err.syscall = `spawn ${file}`; err.path = file;
      // Guarded emit (mirror onExternalAbort): an unhandled 'error' throws synchronously,
      // which would take down the singleton runtime AND skip finish() below — leaking the
      // child (never settles, awaiters hang, liveChildren keeps the pid). Fire-and-forget
      // spawns of unregistered commands are common (fork, gh, pbcopy…), so this must be safe.
      if (child.listenerCount('error') > 0) child.emit('error', err);
      finish(127, null, null, Buffer.from(`${baseName(file)}: command not found\n`));
    });
  }
  return child;
}

// ---- sync spawn -----------------------------------------------------------
// SYNC HONESTY: sync handlers run to completion on the single JS thread — an
// in-flight *Sync call cannot be aborted or timed out from inside the same
// process. signal/timeout are forwarded so cooperative handlers can self-limit;
// a handler that reports {signal} is surfaced with Node's killed-child shape
// (status:null, signal set). Shells are deliberately async-only (just-bash's
// exec returns a Promise), so sync shell invocations fall through to ENOENT.
function makeSyncResult(file, args, options = {}) {
  const key = commandKey(file, args);
  LOG.push({ file, key, args: args || [], sync: true, routed: syncRegistry.has(key), ts: Date.now() });
  const h = syncRegistry.get(key);
  if (h) {
    try {
      const res = h({ file, args: args || [], input: toBuf(options.input), env: options.env || process.env, cwd: options.cwd, signal: options.signal, timeout: options.timeout });
      const killed = res && res.signal;
      const outBuf = toBuf(res.stdout), errBuf = toBuf(res.stderr);
      writeSyncFds(options, outBuf, errBuf);
      const r = spawnSyncShape(file, args, killed ? null : (res.code || 0), outBuf, errBuf, options);
      if (killed) r.signal = signalName(res.signal, 'SIGTERM');
      return r;
    } catch (e) {
      return spawnSyncShape(file, args, 1, Buffer.alloc(0), Buffer.from(String(e) + '\n'), options);
    }
  }
  // Unknown sync command -> ENOENT
  const r = spawnSyncShape(file, args, null, Buffer.alloc(0), Buffer.alloc(0), options);
  r.error = Object.assign(new Error(`spawnSync ${file} ENOENT`), { code: 'ENOENT', errno: -2, syscall: `spawnSync ${file}`, path: file });
  r.status = null;
  return r;
}

function spawnSyncShape(file, args, status, stdout, stderr, options) {
  const enc = options.encoding && options.encoding !== 'buffer';
  return {
    pid: nextPid(),
    output: [null, enc ? stdout.toString(options.encoding) : stdout, enc ? stderr.toString(options.encoding) : stderr],
    stdout: enc ? stdout.toString(options.encoding) : stdout,
    stderr: enc ? stderr.toString(options.encoding) : stderr,
    status,
    signal: null,
    error: undefined,
  };
}

// ---- public API mirroring node:child_process ------------------------------
function spawn(file, args, options) {
  if (!Array.isArray(args)) { options = args; args = []; }
  return makeChild(file, args || [], options || {});
}
function spawnSync(file, args, options) {
  if (!Array.isArray(args)) { options = args; args = []; }
  return makeSyncResult(file, args || [], options || {});
}
function exec(command, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  const child = makeChild(pickShell(options), ['-c', command], options || {});
  collect(child, options, callback);
  return child;
}
function execFile(file, args, options, callback) {
  if (typeof args === 'function') { callback = args; args = []; options = {}; }
  if (typeof options === 'function') { callback = options; options = {}; }
  const child = makeChild(file, args || [], options || {});
  collect(child, options, callback);
  return child;
}
function execSync(command, options) {
  const r = makeSyncResult(pickShell(options), ['-c', command], options || {});
  if (r.signal) { const e = new Error(`Command failed: ${command}`); e.signal = r.signal; e.status = null; e.stdout = r.stdout; e.stderr = r.stderr; throw e; }
  if (r.status && r.status !== 0) { const e = new Error(`Command failed: ${command}`); e.status = r.status; e.stdout = r.stdout; e.stderr = r.stderr; throw e; }
  return r.stdout;
}
function execFileSync(file, args, options) {
  if (!Array.isArray(args)) { options = args; args = []; }
  const r = makeSyncResult(file, args || [], options || {});
  if (r.signal) { const e = new Error(`Command failed: ${file}`); e.signal = r.signal; e.status = null; e.stdout = r.stdout; e.stderr = r.stderr; throw e; }
  if (r.status && r.status !== 0) { const e = new Error(`Command failed: ${file}`); e.status = r.status; e.stdout = r.stdout; e.stderr = r.stderr; throw e; }
  return r.stdout;
}
function fork(modulePath, args, options) {
  // No child Node process possible. Route as a node command handler if present.
  return makeChild('node', [modulePath, ...(args || [])], options || {});
}

function collect(child, options, callback) {
  if (typeof callback !== 'function') return;
  const enc = options && options.encoding;
  const out = []; const err = [];
  child.stdout.on('data', (d) => out.push(Buffer.from(d)));
  child.stderr.on('data', (d) => err.push(Buffer.from(d)));
  let errored = null;
  child.on('error', (e) => { errored = e; });
  child.on('close', (code, signal) => {
    const so = Buffer.concat(out); const se = Buffer.concat(err);
    const stdout = enc && enc !== 'buffer' ? so.toString(enc) : (enc === 'buffer' ? so : so.toString('utf8'));
    const stderr = enc && enc !== 'buffer' ? se.toString(enc) : (enc === 'buffer' ? se : se.toString('utf8'));
    if (errored) return callback(errored, stdout, stderr);
    if (signal) { const e = new Error(`Command failed`); e.killed = true; e.signal = signal; e.code = null; return callback(e, stdout, stderr); }
    if (code && code !== 0) { const e = new Error(`Command failed`); e.code = code; return callback(e, stdout, stderr); }
    callback(null, stdout, stderr);
  });
}

function pickShell(options) {
  return (options && options.shell && typeof options.shell === 'string') ? options.shell
    : (process.env.CLAUDE_CODE_SHELL || process.env.SHELL || 'bash');
}

let _pid = 20000;
function nextPid() { return _pid++; }
function toBuf(x) { if (x == null) return Buffer.alloc(0); if (Buffer.isBuffer(x)) return x; if (x instanceof Uint8Array) return Buffer.from(x); return Buffer.from(String(x), 'utf8'); }

const api = { spawn, spawnSync, exec, execFile, execSync, execFileSync, fork, ChildProcess: EventEmitter };

// Patch the live child_process module cache so every importer (require, node:, destructured) sees the shim.
function install() {
  installFdPathTracking();
  const Module = require('node:module');
  const patch = (id) => {
    try {
      const real = require(id);
      Object.assign(real, api);
    } catch {}
  };
  patch('child_process');
  patch('node:child_process');
  // Also intercept fresh loads via require hook.
  const orig = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'child_process' || request === 'node:child_process') {
      const m = orig.call(this, request, parent, isMain);
      Object.assign(m, api);
      return m;
    }
    return orig.call(this, request, parent, isMain);
  };
  // Route process.kill of live fake pids to the fake child. cli.js's Bash tool
  // interrupts via tree-kill (process.kill(pid,'SIGKILL')), never child.kill().
  // Also prevents fake pids from hitting unrelated real processes on the host.
  if (!process.kill.__iosFakeChildren) {
    const realKill = process.kill.bind(process);
    const patched = function (pid, sig) {
      const c = liveChildren.get(pid);
      if (c) {
        if (sig === 0) return true; // alive probe
        return c.kill(sig === undefined ? 'SIGTERM' : sig);
      }
      // In nodejs-mobile the Node runtime lives inside the app process. Letting
      // cli.js signal the current pid (common on Ctrl-C paths) reaches the real
      // OS process and terminates the whole app. Surface it as a JS signal event
      // instead, which is what callers inside this singleton runtime need.
      if (pid === process.pid) {
        if (sig === 0) return true;
        const name = signalName(sig, 'SIGTERM');
        // Claude Code's shutdown path is `try { process.exit() } catch {
        // process.kill(process.pid, "SIGKILL") }`. Since our process.exit shim
        // throws to unwind the singleton runtime, make that SIGKILL converge on
        // the same sentinel instead of falling through to an "unreachable" error.
        if (name === 'SIGKILL' && typeof process.__iosSessionExit === 'function') {
          return process.__iosSessionExit(process.exitCode || 0);
        }
        if (name !== 'SIGKILL') process.nextTick(() => process.emit(name));
        return true;
      }
      return realKill(pid, sig);
    };
    patched.__iosFakeChildren = true;
    process.kill = patched;
  }
}

module.exports = { install, registerCommand, api, LOG, _registry: registry, _syncRegistry: syncRegistry, _liveChildren: liveChildren };
