// Regression for the interactive L Shell program lifecycle.
// A program launched via `claude` may call process.exit after its TUI unmounts,
// or it may simply release raw mode and leave listeners behind. The outer shell
// must regain stdin, prune program listeners, and prompt in both cases.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗ FAIL:', m)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CLEAR_SCREEN = '\x1b[2J\x1b[3J\x1b[H';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shellreturn-'));
const expectedPwd = fs.realpathSync(tmp);
const fakeCli = path.join(tmp, 'fake-cli.mjs');
fs.writeFileSync(fakeCli, `
const mode = process.argv[2] || 'exit';
process.on('SIGINT', () => {});
process.stdin.on('data', () => {});
if (mode === 'raw-return') {
  process.stdout.write('FAKE_RAW_BOOT\\n');
  process.stdin.setRawMode(true);
  setTimeout(() => {
    process.stdout.write('FAKE_RAW_DONE\\n');
    process.stdin.setRawMode(false);
  }, 25);
} else if (mode === 'raw-then-exit') {
  process.stdout.write('FAKE_RAW_EXIT_BOOT\\n');
  process.stdin.setRawMode(true);
  setTimeout(() => {
    process.stdout.write('FAKE_RAW_EXIT_RELEASE\\n');
    process.stdin.setRawMode(false);
  }, 25);
  setTimeout(() => {
    process.stdout.write('FAKE_RAW_EXIT_DONE\\n');
    process.exit(0);
  }, 80);
} else if (mode === 'graceful-exit') {
  process.stdout.write('FAKE_GRACE_BOOT\\n');
  process.stdin.setRawMode(true);
  setTimeout(() => {
    process.stdin.setRawMode(false);
  }, 25);
  setTimeout(() => {
    process.stdout.write('Resume this session with:\\nclaude --resume fake-session\\n');
  }, 60);
  setTimeout(() => {
    process.stdout.write('FAKE_GRACE_EXIT\\n');
    process.exit(0);
  }, 250);
} else {
  process.stdout.write('FAKE_EXIT_BOOT args=' + process.argv.slice(2).join(' ') + '\\n');
  process.exit(0);
}
`);

function spawnShell(extraEnv = {}) {
  return spawn(process.execPath, ['--jitless', path.join(ROOT, 'node-runtime', 'bootstrap.js')], {
  cwd: tmp,
  env: {
    ...process.env,
    CLAUDE_IOS_SESSION: '1',
    CLAUDE_IOS_TTY: '1',
    CLAUDE_IOS_COLUMNS: '80',
    CLAUDE_IOS_ROWS: '24',
    CLAUDE_IOS_CLI_PATH: fakeCli,
    CLAUDE_IOS_TTY_RELEASE_GRACE_MS: '80',
    CLAUDE_IOS_TTY_SHUTDOWN_GRACE_MS: '600',
    ...extraEnv,
  },
  stdio: ['pipe', 'pipe', 'pipe'],
  });
}

const child = spawnShell();

let out = '', err = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { err += d; });

async function until(fn, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(25);
  }
  return false;
}

(async () => {
  ok(await until(() => /L Shell/.test(out) && /\$ /.test(out)), 'outer shell boots to a prompt');
  child.stdin.write('claude\n');
  ok(await until(() => /FAKE_EXIT_BOOT/.test(out)), 'claude command launches the configured CLI');
  child.stdin.write('pwd\n');
  ok(await until(() => out.includes(expectedPwd)), 'outer shell accepts commands after the CLI exits');
  ok(out.includes(CLEAR_SCREEN), 'outer shell clears stale TUI content after process.exit');
  child.stdin.write('claude raw-return\n');
  ok(await until(() => /FAKE_RAW_BOOT/.test(out)), 'raw-mode CLI starts without process.exit');
  ok(await until(() => /FAKE_RAW_DONE/.test(out)), 'raw-mode CLI releases the TTY');
  ok(await until(() => (out.match(/\$ /g) || []).length >= 4), 'outer shell prompts after raw-mode TTY release');
  child.stdin.write('pwd\n');
  ok(await until(() => out.split(expectedPwd).length - 1 >= 2),
    'outer shell accepts commands after raw-mode TTY release');
  ok((out.split(CLEAR_SCREEN).length - 1) >= 2, 'outer shell clears stale TUI content after raw-mode release');
  const promptCountAfterRawReturn = (out.match(/\$ /g) || []).length;
  child.stdin.write('claude raw-then-exit\n');
  ok(await until(() => /FAKE_RAW_EXIT_RELEASE/.test(out)), 'raw-mode CLI may release TTY before process.exit');
  ok(await until(() => /FAKE_RAW_EXIT_DONE/.test(out)), 'raw-mode CLI process.exit still runs after raw release');
  ok(await until(() => (out.match(/\$ /g) || []).length > promptCountAfterRawReturn),
    'outer shell prompts after delayed process.exit path');
  const promptCountBeforeGrace = (out.match(/\$ /g) || []).length;
  child.stdin.write('claude graceful-exit\n');
  ok(await until(() => /FAKE_GRACE_BOOT/.test(out)), 'graceful-exit CLI starts');
  ok(await until(() => /Resume this session with:/.test(out)), 'graceful-exit prints shutdown resume hint');
  await sleep(150);
  ok((out.match(/\$ /g) || []).length === promptCountBeforeGrace,
    'shutdown-like raw release does not reclaim shell before process.exit');
  ok(await until(() => /FAKE_GRACE_EXIT/.test(out)), 'graceful-exit reaches process.exit after raw release');
  ok(await until(() => (out.match(/\$ /g) || []).length > promptCountBeforeGrace),
    'outer shell prompts after graceful shutdown process.exit');
  const prompts = (out.match(/\$ /g) || []).length;
  ok(prompts >= 6, `outer shell printed prompts after all CLI exits (prompts=${prompts})`);
  ok(!/MaxListenersExceededWarning|uncaught|unhandled rejection/i.test(err), 'no listener leak warning or uncaught error during shell return');

  child.kill('SIGKILL');
  await new Promise((resolve) => child.on('close', resolve));

  const auto = spawnShell({ LSHELL_START_COMMAND: 'claude --permission-mode bypassPermissions' });
  let autoOut = '', autoErr = '';
  auto.stdout.on('data', (d) => { autoOut += d; });
  auto.stderr.on('data', (d) => { autoErr += d; });
  const autoUntil = async (fn, ms = 5000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (fn()) return true;
      await sleep(25);
    }
    return false;
  };
  ok(await autoUntil(() => autoOut.includes('$ claude --permission-mode bypassPermissions')),
    'startup command is printed as if typed at the prompt');
  ok(await autoUntil(() => /FAKE_EXIT_BOOT args=--permission-mode bypassPermissions/.test(autoOut)),
    'startup command launches Claude with bypassPermissions args');
  ok(!/MaxListenersExceededWarning|uncaught|unhandled rejection/i.test(autoErr),
    'startup command path has no listener leak warning or uncaught error');
  auto.kill('SIGKILL');
  await new Promise((resolve) => auto.on('close', resolve));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log('  ✗ FAIL: harness error:', e && e.stack || e);
  console.log('--- stdout ---\n' + out + '\n--- stderr ---\n' + err);
  try { child.kill('SIGKILL'); } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  console.log(`\nRESULT: ${pass} passed, ${fail + 1} failed`);
  process.exit(1);
});
