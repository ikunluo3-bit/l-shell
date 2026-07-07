'use strict';
// iOS preload — installed via `node --require .../preload/index.js cli.js`.
// Runs before Claude Code's ESM bundle and patches the runtime so a jitless,
// fork-less, Intl-less nodejs-mobile can run the CLI unchanged.
//
// Order matters: Intl and fetch before any user code touches them; child_process
// patched before cli.js imports it. TTY and process.exit are gated by env so
// one-shot CLI invocations (--version, -p) still behave normally.

const path = require('node:path');

// 0) FIRST — replace undici-backed Web globals (fetch/Headers/Response/Request/
//    FormData/WebSocket) with WASM-free equivalents. This MUST precede requiring
//    anything else: on Node 18 merely referencing the real Headers/Response lazy-
//    loads undici's llhttp.wasm, which throws "WebAssembly is not defined" under
//    jitless. just-bash and cli.js both touch these globals.
const fetchShim = require('./shims/fetch.js');
fetchShim.installWebGlobals();
const nodeFetch = fetchShim.nodeFetch;

// 0b) Benign WebAssembly stub — cli.js references WebAssembly directly outside a
//     guard; without this it's a ReferenceError under jitless.
require('./shims/wasm-stub.js').install();

// 0c) nodejs-mobile iOS crashes in uv_set_process_title when Claude Code writes
//     process.title. Keep JS-visible title state but avoid the native setter.
if (process.env.CLAUDE_IOS_TTY === '1' || process.env.CLAUDE_IOS_SESSION === '1' || process.platform === 'ios') {
  require('./shims/process-title.js').install();
}

// 1) Intl polyfill (no-op if the runtime already has a real Intl).
require('./shims/intl.js').install();

// 2) fs safe-copy — reimplement fs.copyFile/copyFileSync/cp/cpSync/promises.*
//    in pure JS. libuv v18's uv__fs_copyfile copies bytes via the BSD sendfile(2)
//    syscall, which iOS forbids: it raises SIGSYS ("Bad system call: 12") and kills
//    the whole app (confirmed: sendfile -> uv__fs_work -> node::fs::CopyFile). Must
//    run before any user code touches fs so lazily-loaded cp modules capture the
//    patched primitives. Harmless on desktop (a functionally identical copy).
try { require('./shims/fs-safe-copy.js').install(); }
catch (e) { if (process.env.CLAUDE_IOS_DEBUG) console.error('[preload] fs-safe-copy failed:', e.message); }

// 3) child_process interception.
const cp = require('./shims/child_process.js');
cp.install();

// 3b) Bypass Claude's hardcoded api.anthropic.com connectivity preflight when a
//     third-party ANTHROPIC_BASE_URL (relay) is configured — otherwise the preflight
//     fails in geo-blocked regions and Claude aborts at launch. No-op for official login.
try { require('./shims/preflight-bypass.js').install(); }
catch (e) { if (process.env.CLAUDE_IOS_DEBUG) console.error('[preload] preflight-bypass failed:', e.message); }

// 4) Command handlers (bash/rg…) — wired lazily so the preload works even before
//    just-bash is bundled. Each returns {code, stdout, stderr}.
try {
  require('./commands/register.js').register(cp.registerCommand);
} catch (e) {
  if (process.env.CLAUDE_IOS_DEBUG) console.error('[preload] command handlers not registered:', e.message);
}

// 5) Fake TTY — install when running interactively (native bridge sets this).
let ttyShim = null;
if (process.env.CLAUDE_IOS_TTY === '1') {
  const cols = parseInt(process.env.CLAUDE_IOS_COLUMNS || '80', 10);
  const rows = parseInt(process.env.CLAUDE_IOS_ROWS || '24', 10);
  ttyShim = require('./shims/tty.js');
  ttyShim.install({ columns: cols, rows: rows });
}

// 5b) Control channel (fd 3) for live resize from the native side.
if (process.env.CLAUDE_IOS_CONTROL === '1' && ttyShim) {
  try { require('./shims/control.js').install(ttyShim); }
  catch (e) { if (process.env.CLAUDE_IOS_DEBUG) console.error('[preload] control channel failed:', e.message); }
}

// 6) process.exit patch — only for long-lived REPL sessions.
if (process.env.CLAUDE_IOS_SESSION === '1') {
  require('./shims/process-exit.js').install(() => {});
}

// Expose the bridge surface for the native side / test harness.
globalThis.__iosBridge = {
  tty: require('./shims/tty.js'),
  childProcess: cp,
  fetch: nodeFetch,
};

if (process.env.CLAUDE_IOS_DEBUG) {
  console.error('[preload] installed: intl(%s) fetch child_process tty(%s) session(%s)',
    globalThis.Intl && globalThis.Intl.__polyfill ? 'poly' : 'native',
    process.env.CLAUDE_IOS_TTY === '1' ? 'on' : 'off',
    process.env.CLAUDE_IOS_SESSION === '1' ? 'on' : 'off');
}
