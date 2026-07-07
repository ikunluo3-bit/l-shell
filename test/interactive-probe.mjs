// Probe interactive (Ink TUI) mode the way iOS will drive it: node's stdio are
// plain pipes (no pty), and the tty shim (CLAUDE_IOS_TTY=1) makes Node believe it's
// a TTY. We capture stdout bytes and check that Ink emitted ANSI control sequences —
// i.e. the SwiftTerm<->Node byte bridge design works end to end.
//
// Usage: NODE=<path> node test/interactive-probe.mjs
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';

const NODE = process.env.NODE || 'node';
const ROOT = process.env.LSHELL_ROOT || new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const child = spawn(NODE, [
  '--jitless',
  '--require', `${ROOT}/test/ios-sim-preload.js`,
  `${ROOT}/node-runtime/vendor/claude-code/cli.js`,
], {
  cwd: `${ROOT}/scratch-home/workspace`,
  env: {
    ...process.env,
    HOME: `${ROOT}/scratch-home`,
    CLAUDE_CONFIG_DIR: `${ROOT}/scratch-home/.claude`,
    DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
    USE_BUILTIN_RIPGREP: '0',
    CLAUDE_IOS_TTY: '1', CLAUDE_IOS_COLUMNS: '80', CLAUDE_IOS_ROWS: '24',
    ANTHROPIC_API_KEY: 'sk-ant-fake-probe',
    TERM: 'xterm-256color', FORCE_COLOR: '3',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let out = Buffer.alloc(0);
let err = '';
child.stdout.on('data', (d) => { out = Buffer.concat([out, d]); });
child.stderr.on('data', (d) => { err += d; });

// Keep stdin open (Ink needs a live stdin); optionally send a keystroke later.
const stdin = new PassThrough();
stdin.pipe(child.stdin);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await sleep(2500);
  const frame1 = out.length;
  // Send a printable char + Enter to see if the UI reacts.
  try { stdin.write('h'); } catch {}
  await sleep(800);
  const grew = out.length > frame1;

  child.kill('SIGKILL');
  const s = out.toString('utf8');
  const hasAnsi = /\x1b\[/.test(s);
  const cleared = /\x1b\[2J|\x1b\[[0-9]*[HJ]/.test(s);
  console.log('--- interactive probe results ---');
  console.log('stdout bytes captured :', out.length);
  console.log('emitted ANSI escapes  :', hasAnsi);
  console.log('cursor/screen control :', cleared);
  console.log('reacted to keystroke  :', grew);
  console.log('stderr (first 300)    :', err.slice(0, 300).replace(/\n/g, ' ⏎ ') || '(none)');
  // Strip ANSI for a human-readable peek at the rendered text.
  const plain = s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b[()][A-B0]/g, '');
  const visible = plain.replace(/[^\x20-\x7e\n]/g, '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 12);
  console.log('--- rendered text (first lines) ---');
  console.log(visible.join('\n') || '(no printable text)');
  const okTTY = hasAnsi && out.length > 0;
  console.log('\nTTY BRIDGE:', okTTY ? 'PASS (Ink rendered into the pipe)' : 'INCONCLUSIVE');
  process.exit(0);
})();
