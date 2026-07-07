'use strict';
// Out-of-band control channel on a dedicated fd — separate from stdin/stdout so it
// never interferes with Ink's raw-mode input. Default fd 3; CLAUDE_IOS_CONTROL_FD
// overrides (decimal, must be > 2). The native side dup2's a pipe onto that fd and
// writes newline-delimited commands; we parse them here. Currently:
//   resize <cols> <rows>\n   → update the fake TTY size + emit 'resize' (SIGWINCH)
//   signal <name>\n          → forward as a process signal-ish event (whitelisted)
//
// Gated by CLAUDE_IOS_CONTROL=1 so it's inert in tests/CLI use.

const net = require('node:net');

// Only signals the TUI legitimately reacts to. Anything else on the control pipe
// (typo'd or hostile writer emitting e.g. 'exit'/'newListener') is ignored.
const ALLOWED_SIGNALS = new Set(['SIGINT', 'SIGTERM', 'SIGWINCH', 'SIGUSR1', 'SIGUSR2']);

function controlFd() {
  const raw = process.env.CLAUDE_IOS_CONTROL_FD;
  if (raw !== undefined && raw !== '') {
    const fd = parseInt(raw, 10);
    if (Number.isFinite(fd) && fd > 2) return fd;
    if (process.env.CLAUDE_IOS_DEBUG) console.error('[control] invalid CLAUDE_IOS_CONTROL_FD:', raw, '(falling back to 3)');
  }
  return 3;
}

function install(tty) {
  const CONTROL_FD = controlFd();
  let stream;
  try {
    stream = new net.Socket({ fd: CONTROL_FD, readable: true, writable: false });
  } catch (e) {
    if (process.env.CLAUDE_IOS_DEBUG) console.error('[control] cannot open fd', CONTROL_FD, e.message);
    return;
  }
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) handle(line, tty);
    }
  });
  stream.on('error', (e) => { if (process.env.CLAUDE_IOS_DEBUG) console.error('[control] fd error:', e.message); });
}

function handle(line, tty) {
  const parts = line.split(/\s+/);
  const cmd = parts[0];
  if (cmd === 'resize') {
    const cols = parseInt(parts[1], 10);
    const rows = parseInt(parts[2], 10);
    if (cols > 0 && rows > 0) tty.setSize(cols, rows);
  } else if (cmd === 'signal') {
    const name = parts[1];
    if (ALLOWED_SIGNALS.has(name)) {
      try { process.emit(name); } catch {}
    } else if (process.env.CLAUDE_IOS_DEBUG) {
      console.error('[control] ignoring non-whitelisted signal:', name || '(none)');
    }
  } else if (cmd === 'enqueue') {
    // Hand a shell command line to shell.js's serialized queue, base64-encoded so it
    // survives spaces/args. Runs the moment the shell is idle, or right after the
    // foreground program (e.g. claude) finishes — the shell's single drain loop does
    // the sequencing, so re-launching claude can't race its predecessor's teardown.
    let text = '';
    try { text = Buffer.from(parts[1] || '', 'base64').toString('utf8'); } catch {}
    try { process.emit('lshell:enqueue', text); } catch {}
  }
}

module.exports = { install, handle, controlFd, ALLOWED_SIGNALS };
