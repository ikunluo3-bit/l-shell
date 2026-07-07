// Tests for the session-loop bootstrap (CLAUDE_IOS_SESSION=1), the control-fd env
// override + signal whitelist (control.js), and unhandled-rejection logging.
// Run under: node --jitless test/test-session-fixes.mjs   (Node 18 and Node 24)
//
// The end-to-end part spawns THIS node (--jitless) on bootstrap.js with
// CLAUDE_IOS_CLI_PATH pointed at a fake mini-CLI: it bumps a boot counter file,
// prints listener/column probes, leaks a SIGINT listener, fires an unhandled
// rejection, then exits on the first stdin line — so we can drive several
// sessions through the loop and observe cache-busting + listener hygiene.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const NODE = process.execPath;

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗ FAIL:', m)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// =============== control.js: fd validation + signal whitelist (unit) ===============
{
  const control = require('../node-runtime/preload/shims/control.js');
  const setFd = (v) => {
    if (v === undefined) delete process.env.CLAUDE_IOS_CONTROL_FD;
    else process.env.CLAUDE_IOS_CONTROL_FD = v;
  };

  setFd(undefined); ok(control.controlFd() === 3, 'controlFd defaults to 3 when env unset');
  setFd('7'); ok(control.controlFd() === 7, 'controlFd honors CLAUDE_IOS_CONTROL_FD=7');
  setFd('2'); ok(control.controlFd() === 3, 'controlFd rejects fd <= 2 (stdio), falls back to 3');
  setFd('abc'); ok(control.controlFd() === 3, 'controlFd rejects non-numeric value');
  setFd(''); ok(control.controlFd() === 3, 'controlFd treats empty value as unset');
  setFd(undefined);

  const fakeTty = { calls: [], setSize(c, r) { this.calls.push([c, r]); } };
  control.handle('resize 100 40', fakeTty);
  ok(fakeTty.calls.length === 1 && fakeTty.calls[0][0] === 100 && fakeTty.calls[0][1] === 40,
    'handle("resize 100 40") calls tty.setSize(100, 40)');

  let usr1 = 0;
  const onUsr1 = () => usr1++;
  process.on('SIGUSR1', onUsr1);
  control.handle('signal SIGUSR1', fakeTty);
  ok(usr1 === 1, 'whitelisted signal SIGUSR1 is forwarded via process.emit');

  let evil = 0;
  const onEvil = () => evil++;
  process.on('SIGEVIL', onEvil); // plain event name; would fire if not whitelisted
  control.handle('signal SIGEVIL', fakeTty);
  ok(evil === 0, 'non-whitelisted signal name is ignored');
  control.handle('signal', fakeTty); // bare "signal" must not default-fire anything
  control.handle('signal exit', fakeTty); // hostile writer probing dangerous events
  ok(usr1 === 1 && evil === 0, 'bare/hostile signal lines are ignored without throwing');
  process.removeListener('SIGUSR1', onUsr1);
  process.removeListener('SIGEVIL', onEvil);
}

// =============== session loop + control fd + rejection logging (e2e) ===============
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sessfix-'));
const counterFile = path.join(tmp, 'boots.txt');
const fakeCli = path.join(tmp, 'fake-cli.mjs');
fs.writeFileSync(fakeCli, `
import fs from 'node:fs';
const cf = process.env.FAKE_COUNTER_FILE;
const n = (fs.existsSync(cf) ? parseInt(fs.readFileSync(cf, 'utf8'), 10) : 0) + 1;
fs.writeFileSync(cf, String(n));
// Probe BEFORE adding our own listener: with listener hygiene this stays constant.
process.stdout.write('FAKE_BOOT ' + n + ' sigint=' + process.listenerCount('SIGINT') + ' cols=' + process.stdout.columns + '\\n');
process.on('SIGINT', () => {}); // deliberately leaked each boot
process.on('SIGUSR2', () => process.stdout.write('FAKE_SIGUSR2 boot' + n + '\\n'));
process.stdout.on('resize', () => process.stdout.write('FAKE_RESIZE ' + process.stdout.columns + 'x' + process.stdout.rows + '\\n'));
Promise.reject(new Error('fake-cli-unhandled-' + n)); // bootstrap must log, not swallow
process.stdin.resume();
process.stdin.on('data', (d) => { if (String(d).includes('\\n')) process.exit(0); });
`);

const child = spawn(NODE, ['--jitless', path.join(ROOT, 'node-runtime', 'bootstrap.js'), '--session-loop-test'], {
  cwd: tmp,
  env: {
    ...process.env,
    CLAUDE_IOS_SESSION: '1',
    CLAUDE_IOS_TTY: '1',
    CLAUDE_IOS_COLUMNS: '80',
    CLAUDE_IOS_ROWS: '24',
    CLAUDE_IOS_CONTROL: '1',
    CLAUDE_IOS_CONTROL_FD: '5', // NOT the default 3 — proves the env override
    CLAUDE_IOS_CLI_PATH: fakeCli,
    FAKE_COUNTER_FILE: counterFile,
  },
  // fd 5 carries the control channel (3 and 4 deliberately dead).
  stdio: ['pipe', 'pipe', 'pipe', 'ignore', 'ignore', 'pipe'],
});
const controlPipe = child.stdio[5];

let out = '', err = '';
child.stdout.on('data', (d) => (out += d));
child.stderr.on('data', (d) => (err += d));

async function until(fn, ms = 15000) {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return true;
    if (Date.now() - t0 > ms) return false;
    await sleep(50);
  }
}
const endedCount = () => (err.match(/session ended \(code 0\)\. Press Enter to start a new session\./g) || []).length;
const bootLine = (n) => {
  const m = out.match(new RegExp('FAKE_BOOT ' + n + ' sigint=(\\d+) cols=(\\d+)'));
  return m && { sigint: parseInt(m[1], 10), cols: parseInt(m[2], 10) };
};

(async () => {
  // --- session 1 boots ---
  ok(await until(() => bootLine(1)), 'session 1: fake CLI booted');
  const b1 = bootLine(1) || { sigint: -1, cols: -1 };
  ok(b1.cols === 80, `session 1: tty shim reports initial 80 cols (got ${b1.cols})`);

  // --- control channel on overridden fd 5: resize reaches the tty shim ---
  controlPipe.write('resize 123 45\n');
  ok(await until(() => /FAKE_RESIZE 123x45/.test(out)), 'control fd 5: resize 123x45 reached process.stdout (columns/rows updated + resize emitted)');

  // --- control channel: whitelisted signal forwarded, junk ignored ---
  controlPipe.write('signal SIGUSR2\n');
  ok(await until(() => /FAKE_SIGUSR2 boot1/.test(out)), 'control fd 5: whitelisted SIGUSR2 forwarded to the session');
  controlPipe.write('signal SIGKILL\nsignal exit\n'); // must be ignored; child must survive (proven by the loop below)

  // --- unhandled rejection is logged, not swallowed ---
  ok(await until(() => /\[claude-ios\] unhandled rejection: .*fake-cli-unhandled-1/.test(err)),
    'unhandled rejection from session 1 logged to stderr');

  // --- end session 1 → prompt → Enter → session 2 (cache-busted re-import) ---
  child.stdin.write('go\n');
  ok(await until(() => endedCount() >= 1), 'session 1: SessionExit surfaced as "session ended (code 0)" prompt');
  child.stdin.write('\n'); // press Enter
  ok(await until(() => bootLine(2)), 'session 2: fake CLI booted AGAIN on the same Node instance');
  ok(fs.readFileSync(counterFile, 'utf8') === '2', 'counter file = 2 (ESM cache-bust re-ran cli top-level)');
  const b2 = bootLine(2) || { sigint: -1 };
  ok(b2.sigint === b1.sigint, `listener hygiene: SIGINT count at boot 2 equals boot 1 (${b2.sigint} vs ${b1.sigint}), session 1 leak pruned`);

  // --- one more full cycle to prove the loop is stable ---
  child.stdin.write('go\n');
  ok(await until(() => endedCount() >= 2), 'session 2: ended cleanly');
  child.stdin.write('\n');
  ok(await until(() => bootLine(3)), 'session 3: fake CLI booted');
  const b3 = bootLine(3) || { sigint: -1 };
  ok(b3.sigint === b1.sigint, `listener hygiene: SIGINT count still flat at boot 3 (${b3.sigint})`);
  ok(fs.readFileSync(counterFile, 'utf8') === '3', 'counter file = 3 after third boot');
  ok(/fake-cli-unhandled-2/.test(err), 'bootstrap rejection handler survived listener pruning (session 2 rejection logged)');
  ok(!/MaxListenersExceededWarning/.test(err), 'no MaxListenersExceededWarning across sessions');

  child.kill('SIGKILL'); // the loop never exits by design (iOS runtime semantics)
  await new Promise((r) => child.on('close', r));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log('  ✗ FAIL: harness error:', e && e.stack || e);
  console.log('--- child stdout ---\n' + out + '\n--- child stderr ---\n' + err);
  try { child.kill('SIGKILL'); } catch {}
  console.log(`\nRESULT: ${pass} passed, ${fail + 1} failed`);
  process.exit(1);
});
