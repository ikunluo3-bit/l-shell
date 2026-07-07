'use strict';
// iOS entry point. The native side calls nodejs-mobile's node_start() with argv:
//   ["node", "<bundle>/node-runtime/bootstrap.js", <claude args...>]
// (jitless is baked into the nodejs-mobile build; HOME/ANTHROPIC_*/HTTPS_PROXY and
// the CLAUDE_IOS_* switches are set via setenv() before node_start.)
//
// This installs every shim (WASM-free fetch, child_process interception, fake TTY,
// Intl polyfill, process.exit guard), rewrites argv so Claude Code parses its own
// flags, then runs the bundled cli.js. Two modes:
//   one-shot (default): import cli.js once and pass through (--version, -p ...).
//   session loop (CLAUDE_IOS_SESSION=1): the ONE Node instance can never restart,
//     so when cli.js "exits" (SessionExit from the patched process.exit) we prune
//     its listeners and re-import cli.js with a cache-busting query so a fresh
//     session boots on the same runtime (accepted per-session ESM memory cost).

const path = require('node:path');
const { pathToFileURL } = require('node:url');

const DEFAULT_PATH = '/bin:/usr/bin:/usr/local/bin';
if (!process.env.PATH) {
  process.env.PATH = DEFAULT_PATH;
} else if (!process.env.PATH.split(':').includes('/bin')) {
  process.env.PATH += ':/bin';
}

// 1) Install the shims BEFORE anything touches undici-backed globals.
require('./preload/index.js');

// 2) Resolve the bundled Claude Code entry. CLAUDE_IOS_CLI_PATH is a test-only
//    override so the session loop can be driven with a tiny fake CLI.
const cliPath = process.env.CLAUDE_IOS_CLI_PATH ||
  path.join(__dirname, 'vendor', 'claude-code', 'cli.js');

// 3) Present argv as if `node cli.js <args>` was invoked directly, so Claude Code's
//    own CLI parser sees the right argv[1] and flags. Native passes claude args from
//    argv[2] onward.
const claudeArgs = process.argv.slice(2);
process.argv = [process.argv[0], cliPath, ...claudeArgs];

// No claude args = the interactive TERMINAL (the app): boot the shell, which runs
// commands and launches `claude`/other programs itself. With args (--version, -p …)
// run cli.js directly (tests / one-shot). The shell owns program lifecycles, so in
// interactive mode a program's SessionExit is caught by the shell, not bootstrap.
const INTERACTIVE = claudeArgs.length === 0;

// 4) Session-end plumbing. process.exit is patched (when CLAUDE_IOS_SESSION=1) to
//    throw SessionExit instead of killing the runtime.
const { SessionExit } = require('./preload/shims/process-exit.js');
const { isWasmUnavailable } = require('./preload/shims/wasm-stub.js');

const SESSION_MODE = process.env.CLAUDE_IOS_SESSION === '1';

function notifyNative(code) {
  try {
    if (globalThis.__iosNative && typeof globalThis.__iosNative.onSessionEnd === 'function') {
      globalThis.__iosNative.onSessionEnd(code);
      return true;
    }
  } catch {}
  return false;
}

function onSessionExit(code) {
  if (SESSION_MODE) return endSession(code);
  // one-shot: report once; the process exits naturally (exit is not patched here).
  if (!notifyNative(code)) {
    process.stderr.write(`\n[claude-ios] session ended (code ${code}). Restart to begin a new session.\n`);
  }
}

// SessionExit can surface via uncaughtException, unhandledRejection AND the
// import().catch below (depending on where cli.js called process.exit) — all three
// funnel into onSessionExit/endSession, which is guarded once-per-session.
process.on('uncaughtException', (err) => {
  if (err && err.__sessionExit) return INTERACTIVE ? undefined : onSessionExit(err.code);
  if (isWasmUnavailable(err)) return; // optional WASM feature, expected to fail jitless
  process.stderr.write('\n[claude-ios] uncaught: ' + (err && err.stack || err) + '\n');
});
process.on('unhandledRejection', (err) => {
  if (err && err.__sessionExit) return INTERACTIVE ? undefined : onSessionExit(err.code);
  if (isWasmUnavailable(err)) return; // optional WASM feature, expected to fail jitless
  process.stderr.write('\n[claude-ios] unhandled rejection: ' + (err && err.stack || err) + '\n');
});

// --- session loop (CLAUDE_IOS_SESSION=1) -----------------------------------------
// Listener hygiene: every session cli.js registers process/stream listeners; the
// runtime never restarts, so without cleanup they accumulate across sessions
// (MaxListenersExceededWarning + ghost handlers reacting to the next session's
// input). Snapshot what exists before the first session (i.e. OUR handlers above)
// and prune everything added on top once a session ends.
const PROC_EVENTS = ['SIGINT', 'SIGTERM', 'SIGWINCH', 'exit', 'beforeExit', 'warning',
  'uncaughtException', 'unhandledRejection'];
const STREAM_EVENTS = ['data', 'readable', 'resize', 'error', 'close', 'drain', 'keypress'];

let sessionN = 0;
let sessionActive = false;
let snapshot = null;

function stdStreams() { return [process.stdin, process.stdout, process.stderr]; }

function takeSnapshot() {
  const snap = { proc: new Map(), streams: [] };
  for (const ev of PROC_EVENTS) snap.proc.set(ev, process.listeners(ev));
  for (const st of stdStreams()) {
    const m = new Map();
    if (st) for (const ev of STREAM_EVENTS) m.set(ev, st.listeners(ev));
    snap.streams.push(m);
  }
  return snap;
}

function pruneToSnapshot() {
  for (const ev of PROC_EVENTS) {
    const keep = new Set(snapshot.proc.get(ev));
    for (const fn of process.listeners(ev)) {
      if (!keep.has(fn)) process.removeListener(ev, fn);
    }
  }
  stdStreams().forEach((st, i) => {
    if (!st) return;
    for (const ev of STREAM_EVENTS) {
      const keep = new Set(snapshot.streams[i].get(ev) || []);
      for (const fn of st.listeners(ev)) {
        if (!keep.has(fn)) st.removeListener(ev, fn);
      }
    }
  });
}

function runSession() {
  sessionN++;
  sessionActive = true;
  process.exitCode = 0;
  // The query string busts the ESM module cache so cli.js re-initializes fresh.
  import(pathToFileURL(cliPath).href + '?session=' + sessionN).catch((err) => {
    if (err instanceof SessionExit || (err && err.__sessionExit)) return endSession(err.code);
    process.stderr.write('\n[claude-ios] failed to start Claude Code: ' + (err && err.stack || err) + '\n');
    endSession(1);
  });
}

function endSession(code) {
  if (!sessionActive) return; // converging exit paths must not double-fire
  sessionActive = false;
  notifyNative(code);
  pruneToSnapshot();
  process.stderr.write(`\r\n[claude-ios] session ended (code ${code}). Press Enter to start a new session.\r\n`);
  try { process.stdin.resume(); } catch {} // cli.js may have paused stdin
  process.stdin.once('data', () => runSession());
}

// 5) Entry.
if (INTERACTIVE) {
  require('./shell.js');            // the terminal (the product)
} else if (SESSION_MODE) {
  snapshot = takeSnapshot();
  runSession();
} else {
  import(cliPath).catch((err) => {  // one-shot cli.js (--version, -p …)
    if (err instanceof SessionExit || (err && err.__sessionExit)) return onSessionExit(err.code);
    process.stderr.write('\n[claude-ios] failed to start Claude Code: ' + (err && err.stack || err) + '\n');
  });
}
