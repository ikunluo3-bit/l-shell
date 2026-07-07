// Closes the loop: proves the ACTUAL API an AI CLI uses — child_process.spawn()
// with a streaming child.stdout / child.stdin / 'exit' — drives a native command
// through the bridge. This is the streaming ChildProcess contract the real shim
// would adopt (today's shim is one-shot buffer; native commands need streaming).
import { Readable, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { run } = require('./bridge.js');

const NATIVE = new Set(['democount', 'democat', 'demofail', 'demospin', 'demoleak']);

// A minimal streaming ChildProcess backed by the native bridge.
function spawnNative(name, argv) {
  const child = new EventEmitter();
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const handle = run(name, argv, {
    onData: (buf) => stdout.push(buf),          // progressive — real streaming
    onExit: (code) => { stdout.push(null); stderr.push(null); child.emit('exit', code); child.emit('close', code); },
  });
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = new Writable({ write(chunk, enc, cb) { handle.write(chunk); cb(); },
                               final(cb) { handle.closeStdin(); cb(); } });
  child.kill = () => handle.cancel();
  return child;
}

// Install the interceptor over child_process.spawn (mirrors our real shim's hook).
import cp from 'node:child_process';
const realSpawn = cp.spawn;
cp.spawn = function (file, args = [], opts) {
  const name = String(file).split('/').pop();
  if (NATIVE.has(name)) return spawnNative(name, args);
  return realSpawn.call(this, file, args, opts);
};

// ---- exercise it exactly like a CLI would ----
const { spawn } = cp;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };

function drive(name, args, feed) {
  return new Promise((resolve) => {
    const child = spawn(name, args);
    const chunks = [], times = [];
    child.stdout.on('data', (d) => { chunks.push(d.toString()); times.push(Date.now()); });
    child.on('exit', (code) => resolve({ code, out: chunks.join(''), n: chunks.length,
                                         span: times.length ? times[times.length - 1] - times[0] : 0 }));
    if (feed) feed(child);
  });
}

console.log('=== spawn() → native command (Node ' + process.version + ') ===');
const a = await drive('democount', ['4']);
ok(a.code === 0 && a.out === 'tick 1\ntick 2\ntick 3\ntick 4\n', "spawn('democount',['4']).stdout streamed all ticks");
ok(a.n >= 3 && a.span >= 150, 'child.stdout emitted ' + a.n + " progressive 'data' events over " + a.span + 'ms');

const b = await drive('democat', [], (child) => { child.stdin.write('via spawn\n'); setTimeout(() => child.stdin.end(), 80); });
ok(b.out === 'echo: via spawn\n', 'child.stdin write reached the native command, echoed back');

const c = await drive('demofail', []);
ok(c.code === 3, "child 'exit' carried code 3 from the native command");

console.log('\n' + (fail === 0
  ? '✅ spawn() ↔ native bridge END-TO-END: the exact child_process API AI CLIs call now drives real in-process native commands with streaming stdio.'
  : '❌ ' + fail + ' failures'));
process.exit(fail ? 1 : 0);
