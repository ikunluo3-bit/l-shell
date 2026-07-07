'use strict';
// process.exit patch. nodejs-mobile runs ONE Node instance per process and cannot
// restart it after exit, so when Claude Code (or a tool) calls process.exit we must
// NOT actually terminate — we tear the session down and let the native side start a
// fresh session against the same live Node instance.
//
// Opt-in: only active when installed, because CLI one-shots (--version, -p) should
// exit normally. The native bridge installs this for interactive REPL sessions.

let installed = false;
let onExit = null; // (code) => void, provided by the bridge
let emittingExit = false; // re-entrancy guard for the synthetic 'exit' emit

class SessionExit extends Error {
  constructor(code) { super(`__session_exit_${code}`); this.name = 'SessionExit'; this.code = code; this.__sessionExit = true; }
}

function throwSessionExit(code = process.exitCode || 0) {
  throw new SessionExit(code);
}

function install(handler) {
  onExit = typeof handler === 'function' ? handler : null;
  process.__iosSessionExit = throwSessionExit;
  if (installed) return;
  installed = true;
  const realExit = process.exit.bind(process);
  process.__realExit = realExit;
  process.exit = function patchedExit(code = process.exitCode || 0) {
    process.exitCode = code;
    try { if (onExit) onExit(code); } catch {}
    // Run the program's real exit-time teardown BEFORE unwinding. Claude Code registers
    // cleanup on 'exit' and via signal-exit (releasing config/session locks, tearing
    // down its persistent shell, etc.). Because nodejs-mobile never truly exits, those
    // handlers otherwise NEVER fire — and a resource they hold (e.g. a lock) blocks the
    // NEXT session's startup: the "second `claude` hangs with no output" bug. Emitting
    // 'exit' here lets that cleanup run. Guarded against re-entrancy (a listener that
    // calls process.exit) so it can't recurse or wedge the flag across sessions.
    if (!emittingExit) {
      emittingExit = true;
      try { process.emit('exit', code); }
      catch {}
      finally { emittingExit = false; }
    }
    // Throw to unwind Claude Code's stack instead of killing the runtime.
    // The bridge's session runner catches SessionExit and reports it to native.
    throwSessionExit(code);
  };
  // reallyExit is what process.exit calls internally; guard it too.
  const realReally = process.reallyExit ? process.reallyExit.bind(process) : null;
  if (realReally) process.reallyExit = function () { /* swallowed; use __realExit to truly quit */ };
}

module.exports = { install, SessionExit };
