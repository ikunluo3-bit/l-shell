// Regression tests for interruption / env / signal-shape fixes in the
// child_process shim (kill(), options.signal, options.timeout, per-invocation
// env, tree-kill-by-pid routing).
// Run under: node --jitless test/test-interrupt-fixes.mjs   (Node 18 and Node 24)
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗ FAIL:', m)); };

// Watchdog: interruption bugs manifest as hangs — fail loudly instead.
const watchdog = setTimeout(() => { console.log('  ✗ FAIL: watchdog — suite hung'); console.log(`\nRESULT: ${pass} passed, ${fail + 1} failed`); process.exit(1); }, 30000);
watchdog.unref?.();

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'intrtest-'));
process.chdir(WS);

// Mirror the preload: neutralize undici Web globals FIRST (required on Node 18).
require('../node-runtime/preload/shims/fetch.js').installWebGlobals();

const cp = require('../node-runtime/preload/shims/child_process.js');
cp.install();
require('../node-runtime/preload/commands/register.js').register(cp.registerCommand);
const { spawn, exec, execSync, spawnSync } = require('node:child_process');

const spawnAndWait = (file, args, opts = {}) => {
  const c = spawn(file, args, { cwd: WS, ...opts });
  let out = '', err = '', errored = null;
  c.stdout.on('data', (d) => (out += d));
  c.stderr.on('data', (d) => (err += d));
  c.on('error', (e) => (errored = e));
  const done = new Promise((res) => c.on('exit', (code, signal) => res({ code, signal, out: () => out, err: () => err, errored: () => errored })));
  return { child: c, done };
};

(async () => {
  // (a) kill() interrupts an infinite loop; exit (null, signal) per Node.
  {
    const t0 = Date.now();
    const { child, done } = spawnAndWait('bash', ['-c', 'while true; do sleep 0.05; done']);
    setTimeout(() => {
      const sent = child.kill();
      ok(sent === true, 'kill() on a running child returns true');
    }, 200);
    const r = await done;
    const dt = Date.now() - t0;
    ok(dt < 1500, `kill() interrupts infinite loop (exit after ${dt}ms < 1500ms)`);
    ok(r.code === null && r.signal === 'SIGTERM', `killed child exits (null, 'SIGTERM'), got (${r.code}, ${r.signal})`);
    ok(child.killed === true && child.exitCode === null && child.signalCode === 'SIGTERM', 'killed/exitCode/signalCode fields match Node');
    ok(child.kill() === false, 'kill() after exit returns false');
  }

  // (a2) kill('SIGKILL') reports the requested signal. NOTE: just-bash discards
  // its buffered output when aborted, so a killed shell reports empty stdout
  // (unlike a real pipe, where already-flushed data survives). Documented.
  {
    const { child, done } = spawnAndWait('bash', ['-c', 'while true; do echo tick; sleep 0.05; done']);
    setTimeout(() => child.kill('SIGKILL'), 250);
    const r = await done;
    ok(r.signal === 'SIGKILL', `kill('SIGKILL') surfaces SIGKILL, got ${r.signal}`);
    ok(r.out() === '', 'killed shell reports empty stdout (just-bash drops its buffer on abort)');
  }

  // (b) exec with options.timeout aborts an infinite loop; callback error shape.
  await new Promise((resolve) => {
    const t0 = Date.now();
    exec('while true; do sleep 0.05; done', { cwd: WS, timeout: 300 }, (e, stdout, stderr) => {
      const dt = Date.now() - t0;
      ok(dt < 1500, `exec timeout=300 fires callback after ${dt}ms < 1500ms`);
      ok(e && e.killed === true && e.signal === 'SIGTERM' && e.code === null, `timeout error has killed=true signal=SIGTERM code=null, got killed=${e && e.killed} signal=${e && e.signal} code=${e && e.code}`);
      resolve();
    });
  });

  // (c) per-invocation env reaches the script (Node semantics: env replaces).
  {
    const { done } = spawnAndWait('bash', ['-c', 'echo $MYVAR'], { env: { ...process.env, MYVAR: 'hello_env' } });
    const r = await done;
    ok(r.code === 0 && r.out().trim() === 'hello_env', `options.env is threaded into the shell (got ${JSON.stringify(r.out().trim())})`);
  }
  {
    // env with undefined values (cli.js does `SHELL: cond ? x : undefined`) must not
    // leak "undefined"; and a caller PATH without /bin must not break builtins.
    const { done } = spawnAndWait('bash', ['-c', 'echo [$UNSETV]'], { env: { PATH: '/usr/bin', UNSETV: undefined } });
    const r = await done;
    ok(r.code === 0 && r.out().trim() === '[]', 'undefined env values dropped; builtins survive a /bin-less PATH');
  }

  // (d) AbortSignal in options aborts; AbortError emitted; exit (null, signal).
  {
    const t0 = Date.now();
    const ac = new AbortController();
    const { child, done } = spawnAndWait('bash', ['-c', 'while true; do sleep 0.05; done'], { signal: ac.signal });
    setTimeout(() => ac.abort(), 150);
    const r = await done;
    const dt = Date.now() - t0;
    ok(dt < 1500, `options.signal abort interrupts after ${dt}ms < 1500ms`);
    ok(r.errored() && r.errored().name === 'AbortError', `abort emits AbortError 'error' (got ${r.errored() && r.errored().name})`);
    ok(r.code === null && r.signal === 'SIGTERM' && child.killed === true, 'aborted child exits (null, SIGTERM)');
  }
  {
    // pre-aborted signal: child never runs the script.
    const ac = new AbortController();
    ac.abort();
    const marker = path.join(WS, 'should-not-exist.txt');
    const { done } = spawnAndWait('bash', ['-c', `echo nope > ${marker}`], { signal: ac.signal });
    const r = await done;
    ok(r.signal === 'SIGTERM' && !fs.existsSync(marker), 'pre-aborted signal kills before the script runs');
  }

  // (tree-kill path) cli.js Bash tool kills via process.kill(pid, 'SIGKILL')
  // after a pgrep/ps walk — the shim must route fake pids and serve pgrep/ps.
  {
    const t0 = Date.now();
    const { child, done } = spawnAndWait('bash', ['-c', 'while true; do sleep 0.05; done']);
    setTimeout(() => {
      const sent = process.kill(child.pid, 'SIGKILL');
      ok(sent === true, 'process.kill(fakePid, SIGKILL) routes to the fake child');
    }, 150);
    const r = await done;
    ok(Date.now() - t0 < 1500 && r.signal === 'SIGKILL', 'tree-kill-style process.kill interrupts the loop');
    ok(!cp._liveChildren.has(child.pid), 'exited child is removed from the live-pid routing map');
  }
  {
    const p = spawnAndWait('pgrep', ['-P', '12345']);
    const r1 = await p.done;
    ok(r1.code === 1 && !r1.errored(), 'pgrep -P → no-match exit 1, no ENOENT error (tree-kill safe)');
    const r2 = await spawnAndWait('ps', ['-o', 'pid', '--no-headers', '--ppid', '12345']).done;
    ok(r2.code === 1 && !r2.errored(), 'ps --ppid → no-match exit 1, no ENOENT error');
  }
  {
    let sawSigint = false;
    process.once('SIGINT', () => { sawSigint = true; });
    ok(process.kill(process.pid, 'SIGINT') === true, 'process.kill(self, SIGINT) is intercepted');
    await new Promise((resolve) => setImmediate(resolve));
    ok(sawSigint === true, 'process.kill(self, SIGINT) emits JS SIGINT instead of killing the runtime');
  }

  // (e) regression: normal commands unaffected.
  {
    const r = await spawnAndWait('bash', ['-c', 'echo alpha; echo beta 1>&2; exit 3']).done;
    ok(r.code === 3 && r.signal === null && r.out().includes('alpha') && r.err().includes('beta'), 'normal command: stdout/stderr/exit code intact');
    const r2 = await spawnAndWait('bash', ['-c', 'printf x; printf y']).done;
    ok(r2.code === 0 && r2.out() === 'xy', 'normal command exits 0 with exact stdout');
    fs.writeFileSync(path.join(WS, 'path-proof.txt'), 'ok');
    const emptyPath = await spawnAndWait('bash', ['-c', 'ls path-proof.txt'], { env: { PATH: '' } }).done;
    ok(emptyPath.code === 0 && emptyPath.out().includes('path-proof.txt'), 'empty PATH still resolves just-bash /bin builtins');
    const missingPath = await spawnAndWait('bash', ['-c', 'cat path-proof.txt'], { env: { HOME: WS } }).done;
    ok(missingPath.code === 0 && missingPath.out().trim() === 'ok', 'missing PATH still resolves just-bash /bin builtins');
    const noBinPath = await spawnAndWait('bash', ['-c', 'pwd'], { env: { PATH: '/usr/local/bin' } }).done;
    ok(noBinPath.code === 0 && noBinPath.out().trim(), 'PATH without /bin is augmented for just-bash builtins');
    await new Promise((resolve) => {
      exec('echo still-works', { cwd: WS, timeout: 5000 }, (e, stdout) => {
        ok(!e && stdout.includes('still-works'), 'exec with generous timeout completes normally (timer cleared)');
        resolve();
      });
    });
    // Sync shells are async-only (just-bash exec is a Promise) → documented
    // ENOENT fallthrough: no throw, empty output, spawnSync gets error+status null.
    const es = execSync('echo sync-ok', { cwd: WS, encoding: 'utf8' });
    ok(String(es) === '', 'execSync shell → documented ENOENT fallthrough (empty, no throw)');
    const ss = spawnSync('bash', ['-c', 'echo hi'], { encoding: 'utf8' });
    ok(ss.error && ss.error.code === 'ENOENT' && ss.status === null, 'spawnSync shell reports ENOENT (sync shells intentionally unrouted)');
    const efs = require('node:child_process').execFileSync('which', ['bash'], { encoding: 'utf8' });
    ok(efs.includes('bash'), 'execFileSync routed sync handler still works');
    const sr = spawnSync('uname', ['-s'], { encoding: 'utf8' });
    ok(sr.stdout.includes('Darwin') && sr.signal === null, 'spawnSync handler path intact (signal null when not killed)');
    const cwdCheck = await spawnAndWait('bash', ['-c', 'pwd'], { cwd: WS }).done;
    ok(cwdCheck.out().trim() === fs.realpathSync(WS) || cwdCheck.out().trim() === WS, 'cwd is per-invocation');
    const r3 = await spawnAndWait('definitely-not-a-command', []).done;
    ok(r3.errored() && r3.errored().code === 'ENOENT' && r3.code === 127, 'unknown command ENOENT behavior unchanged');
  }
  {
    const r = await spawnAndWait('/usr/bin/env', ['bash', '-c', 'echo env-ok']).done;
    ok(r.code === 0 && r.out().trim() === 'env-ok' && !r.errored(), '/usr/bin/env bash -c routes to the shell handler');
    const r2 = await spawnAndWait('/usr/bin/env', ['FOO=bar', 'zsh', '-c', '-l', 'echo $FOO']).done;
    ok(r2.code === 0 && r2.out().trim() === 'bar', 'env VAR=value zsh -c -l routes with merged env');
    const r3 = await spawnAndWait('/usr/bin/env', ['-S', 'bash -c "echo split-ok"']).done;
    ok(r3.code === 0 && r3.out().trim() === 'split-ok', 'env -S split-string routes to the shell handler');
  }

  // env does not leak across invocations (fresh Bash per call).
  {
    await spawnAndWait('bash', ['-c', 'export LEAKY=1']).done;
    const r = await spawnAndWait('bash', ['-c', 'echo [$LEAKY]']).done;
    ok(r.out().trim() === '[]', 'exported vars do not leak into the next invocation');
  }

  fs.rmSync(WS, { recursive: true, force: true });
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log('  ✗ FAIL: suite crashed:', e && e.stack || e);
  console.log(`\nRESULT: ${pass} passed, ${fail + 1} failed`);
  process.exit(1);
});
