'use strict';
// TEST-ONLY: makes a full-icu Mac Node behave like the legacy no-ICU iOS
// nodejs-mobile build, so we can validate the fallback shims without a device.
//
// The old stock iOS framework was configured --with-intl=none --v8-options=--jitless,
// meaning:
//   - no `Intl` object at all           -> delete globalThis.Intl
//   - no WebAssembly (jitless)          -> already gone when run with `node --jitless`
//   - process.platform === 'ios'        -> spoof it (Claude Code branches on this)
//   - child_process spawn/fork throw     -> the real preload shims handle this
//
// Run:  node --jitless --require test/ios-sim-preload.js node-runtime/preload/index.js ...
// or point --require at BOTH this and the real preload.

// 1) Strip Intl to reproduce --with-intl=none.
try { delete globalThis.Intl; } catch {}

// 2) Spoof platform to 'ios' (nodejs-mobile reports this; keychain path is darwin-gated).
try { Object.defineProperty(process, 'platform', { value: 'ios', configurable: true }); } catch {}

// 3) Sanity assertions so the harness fails loudly if the sim isn't faithful.
if (typeof globalThis.WebAssembly !== 'undefined') {
  console.error('[ios-sim] WARNING: WebAssembly is defined — you forgot --jitless');
}
if (typeof globalThis.Intl !== 'undefined') {
  console.error('[ios-sim] WARNING: Intl still present — strip failed');
}

// 4) Load the real, ship-to-device preload.
require('../node-runtime/preload/index.js');

// 5) On exit, optionally dump every intercepted spawn (diagnostics).
if (process.env.CLAUDE_IOS_DUMPLOG === '1') {
  process.on('exit', () => {
    try {
      const log = globalThis.__iosBridge.childProcess.LOG;
      console.error('\n[ios-sim] intercepted spawns (' + log.length + '):');
      for (const e of log) {
        console.error(`  ${e.sync ? 'SYNC ' : 'async'} ${e.routed ? '[routed]' : '[ENOENT]'} ${e.key}  ${JSON.stringify((e.args || []).slice(0, 4))}`);
      }
    } catch (e) { console.error('[ios-sim] dump failed:', e.message); }
  });
}
