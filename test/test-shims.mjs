// Regression tests for the child_process / rg / tty / intl / process-exit shims.
// Run under: node --jitless test/test-shims.mjs   (works on Node 18 and Node 24)
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗ FAIL:', m)); };

// Seed a temp workspace.
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'shimtest-'));
fs.writeFileSync(path.join(WS, 'a.txt'), 'alpha needle here\nsecond line\n');
fs.mkdirSync(path.join(WS, 'sub'));
fs.writeFileSync(path.join(WS, 'sub', 'b.js'), 'const x = needleFn();\n');
process.chdir(WS);

// Mirror the preload: neutralize undici Web globals FIRST (required on Node 18).
require('../node-runtime/preload/shims/fetch.js').installWebGlobals();

// Install the interceptor + handlers.
const cp = require('../node-runtime/preload/shims/child_process.js');
cp.install();
require('../node-runtime/preload/commands/register.js').register(cp.registerCommand);
const { spawn, exec, execFile, execFileSync, spawnSync } = require('node:child_process');

const runSpawn = (file, args, opts = {}) => new Promise((res) => {
  const c = spawn(file, args, { cwd: WS, ...opts });
  let out = '', err = '', errored = null;
  c.stdout.on('data', (d) => (out += d));
  c.stderr.on('data', (d) => (err += d));
  c.on('error', (e) => (errored = e)); // missing binaries emit 'error' (faithful to real Node)
  c.on('close', (code) => res({ code, out, err, errored }));
});

console.log('WebAssembly:', typeof globalThis.WebAssembly, '| Intl:', typeof globalThis.Intl);

// --- Intl polyfill ---
require('../node-runtime/preload/shims/intl.js').install();
ok(typeof Intl.Segmenter === 'function', 'Intl.Segmenter installed');
ok([...new Intl.Segmenter().segment('héllo')].length === 5, 'Segmenter counts graphemes');
ok(new Intl.NumberFormat().format(1234567) === '1,234,567', 'NumberFormat groups');
ok(typeof new Intl.DateTimeFormat().format(new Date()) === 'string', 'DateTimeFormat.format works');

// --- child_process: rg ---
(async () => {
  let r = await runSpawn('rg', ['--files', WS]);
  ok(r.code === 0 && r.out.includes('a.txt') && r.out.includes('b.js'), 'rg --files enumerates');

  r = await runSpawn('rg', ['needle', WS]);
  ok(r.code === 0 && r.out.includes('a.txt:1:'), 'rg pattern finds matches with line numbers');

  r = await runSpawn('rg', ['-l', 'needle', WS]);
  ok(r.code === 0 && r.out.trim().split('\n').length >= 2, 'rg -l lists matching files');

  r = await runSpawn('rg', ['-i', 'NEEDLE', WS]);
  ok(r.code === 0 && r.out.includes('needle'), 'rg -i case-insensitive');

  r = await runSpawn('rg', ['zzznomatch', WS]);
  ok(r.code === 1, 'rg no-match exits 1');

  // --- child_process: bash ---
  r = await runSpawn('bash', ['-c', 'echo hi; pwd']);
  ok(r.code === 0 && r.out.includes('hi') && r.out.includes(WS), 'bash -c echo+pwd');

  r = await runSpawn('bash', ['-c', `cat ${path.join(WS, 'a.txt')} | grep needle | wc -l`]);
  ok(r.code === 0 && r.out.trim() === '1', 'bash pipeline cat|grep|wc');

  r = await runSpawn('bash', ['-c', `echo written > ${path.join(WS, 'new.txt')} && cat ${path.join(WS, 'new.txt')}`]);
  ok(r.code === 0 && r.out.includes('written') && fs.existsSync(path.join(WS, 'new.txt')), 'bash writes real file (shared namespace)');

  r = await runSpawn('bash', ['-c', 'grep -rn needle ' + WS]);
  ok(r.code === 0 && r.out.includes('a.txt'), 'bash grep -r finds matches');

  // --- exec (callback) ---
  await new Promise((resolve) => {
    exec('echo callback-style', { cwd: WS }, (e, stdout) => {
      ok(!e && stdout.includes('callback-style'), 'exec callback returns stdout');
      resolve();
    });
  });

  // --- unknown command → ENOENT (emits 'error' like real Node) ---
  r = await runSpawn('definitely-not-a-command', []);
  ok(r.errored && r.errored.code === 'ENOENT', 'unknown command emits ENOENT error (faithful to real spawn)');

  // --- spawnSync ---
  const sr = spawnSync('uname', ['-s'], { cwd: WS, encoding: 'utf8' });
  ok(sr.stdout.includes('Darwin'), 'spawnSync uname returns canned platform');

  // --- execFileSync ---
  const efs = execFileSync('which', ['bash'], { cwd: WS, encoding: 'utf8' });
  ok(efs.includes('bash'), 'execFileSync which bash resolves');

  // --- process.exit patch (opt-in) ---
  const { install: installExit, SessionExit } = require('../node-runtime/preload/shims/process-exit.js');
  let exitCode = null;
  installExit((code) => { exitCode = code; });
  try { process.exit(3); ok(false, 'process.exit should throw SessionExit'); }
  catch (e) { ok(e instanceof SessionExit && e.code === 3 && exitCode === 3, 'process.exit patched → SessionExit, runtime survives'); }
  process.exitCode = 7;
  try { process.kill(process.pid, 'SIGKILL'); ok(false, 'self SIGKILL should throw SessionExit when process.exit shim is active'); }
  catch (e) { ok(e instanceof SessionExit && e.code === 7, 'self SIGKILL converges on SessionExit during patched sessions'); }
  process.exit = process.__realExit; // restore for clean teardown

  fs.rmSync(WS, { recursive: true, force: true });
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
