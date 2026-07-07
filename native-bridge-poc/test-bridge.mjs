// Inner test: functional proof of the Node -> in-process native-command bridge.
// ALL diagnostics go to stderr (console.error). The real stdout (fd 1) is kept
// PRISTINE on purpose — native command output arrives via onData and is NOT
// echoed to fd 1 — EXCEPT the one intentional demoleak write. The outer runner
// (run-test.mjs) captures fd 1 vs fd 2 separately to prove fd isolation from libuv.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { run } = require('./bridge.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.error('  ✓ ' + m); } else { fail++; console.error('  ✗ ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function collect(name, argv, opts = {}) {
  return new Promise((resolve) => {
    const chunks = [], times = [];
    const h = run(name, argv, {
      onData: (buf) => { chunks.push(buf.toString()); times.push(Date.now()); if (opts.onChunk) opts.onChunk(buf, h); },
      onExit: (code) => resolve({ code, out: chunks.join(''), chunks, times }),
    });
    if (opts.start) opts.start(h);
  });
}

async function main() {
  console.error('=== native-bridge PoC (Node ' + process.version + (process.execArgv.includes('--jitless') ? ' --jitless' : '') + ') ===');

  // 1) STREAMING (not batch): democount 4 -> 4 chunks spread over time.
  {
    const r = await collect('democount', ['4']);
    const span = r.times[r.times.length - 1] - r.times[0];
    ok(r.code === 0, 'democount exit 0');
    ok(r.out === 'tick 1\ntick 2\ntick 3\ntick 4\n', 'democount produced all 4 ticks in order');
    ok(r.chunks.length >= 3, 'arrived as multiple chunks (' + r.chunks.length + '), i.e. STREAMING not batched');
    ok(span >= 150, 'chunks spanned ' + span + 'ms of wall-clock (progressive, not dumped at once)');
  }

  // 2) stdin delivery: democat echoes what we write.
  {
    const r = await collect('democat', [], {
      start: (h) => { h.write('hello\n'); h.write('world\n'); setTimeout(() => h.closeStdin(), 120); },
    });
    ok(r.code === 0, 'democat exit 0 on stdin EOF');
    ok(r.out === 'echo: hello\necho: world\n', 'democat echoed stdin back through the bridge');
  }

  // 3) exit codes + stderr routing: demofail.
  {
    const r = await collect('demofail', []);
    ok(r.code === 3, 'demofail propagated exit code 3');
    ok(r.out.includes('boom on stderr'), 'demofail stderr routed through the bridge');
  }

  // 4) cooperative interrupt: demospin -> cancel -> stops with 130.
  {
    let cancelledAt = 0, lastChunkAt = 0;
    const r = await collect('demospin', [], {
      onChunk: () => { lastChunkAt = Date.now(); },
      start: (h) => { setTimeout(() => { cancelledAt = Date.now(); h.cancel(); }, 260); },
    });
    ok(r.code === 130, 'demospin stopped with cancel code 130');
    ok(r.chunks.length >= 2, 'demospin ran (produced ' + r.chunks.length + ' chunks) before cancel');
    ok(lastChunkAt - cancelledAt < 150, 'no output after cancel (stopped within one tick)');
  }

  // 5) concurrency: two commands at once, outputs must not intermix.
  {
    const [a, b] = await Promise.all([collect('democount', ['3']), collect('democount', ['3'])]);
    ok(a.out === 'tick 1\ntick 2\ntick 3\n' && b.out === 'tick 1\ntick 2\ntick 3\n',
       'two concurrent commands each got their OWN clean stdout (no cross-talk)');
    ok(a.code === 0 && b.code === 0, 'both concurrent commands exited 0');
  }

  // 6) NEGATIVE control: demoleak writes to the REAL fd 1 (printf), proving why a
  //    command MUST be ported to thread_stdout. The outer runner checks fd 1.
  {
    const r = await collect('demoleak', []);
    ok(r.code === 0, 'demoleak exit 0');
    ok(r.out === '', 'demoleak produced NOTHING on the bridge (it bypassed thread_stdout)');
    // its "LEAKED-TO-REAL-FD1" line goes to real fd 1 — asserted by run-test.mjs
  }

  console.error('INNER-RESULT: ' + pass + ' passed, ' + fail + ' failed');
  await sleep(50);
  process.exit(fail ? 1 : 0);
}
main();
