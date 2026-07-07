'use strict';
// Thin JS wrapper over the N-API addon. Shape mirrors what a STREAMING
// child_process-shim handler would use: onData chunks arrive progressively,
// onExit gives the code. write()/cancel() drive stdin/interrupt.
const native = require('./build/native_bridge.node');

function run(name, argv, { onData, onExit } = {}) {
  const handle = native.dispatch(name, argv || [], onData || (() => {}), onExit || (() => {}));
  return {
    write(chunk) { native.writeStdin(handle, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); },
    closeStdin() { native.closeStdin(handle); },
    cancel() { native.cancel(handle); },
  };
}

module.exports = { run };
