'use strict';
// The terminal's default program: an interactive shell. This is the PRODUCT — a
// real terminal. You land at a prompt; `ls/cat/grep/…` run through just-bash;
// `claude` (and later other AI CLIs) launch as programs you run inside it.
//
// Cooked line editing/echo comes from our userspace line discipline (preload/pty.js),
// since iOS gives no kernel tty. Each command runs through a just-bash instance on
// the current cwd; `cd`/`export` are handled here so state persists across commands.

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { LineDiscipline } = require('./preload/pty.js');
const { makeBash } = require('./preload/commands/register.js');
const { install: installExitHandler } = require('./preload/shims/process-exit.js');

let cwd = process.cwd();
const shellEnv = { ...process.env };
const claudeEntry = () => process.env.CLAUDE_IOS_CLI_PATH ||
  path.join(__dirname, 'vendor', 'claude-code', 'cli.js');

const out = (s) => process.stdout.write(typeof s === 'string' ? s : String(s));
const crlf = (s) => s.replace(/\r?\n/g, '\r\n');
const promptStr = () => `\x1b[1;36m${path.basename(cwd) || '/'}\x1b[0m $ `;
const prompt = () => out(promptStr());
const shellTerminalReset = () =>
  '\x1b[0m' +        // reset colors/styles left by the foreground TUI
  '\x1b[?25h' +      // show cursor
  '\x1b[?2004l' +    // bracketed paste off
  '\x1b[?1004l' +    // focus tracking off
  '\x1b[?2031l' +    // extended keyboard/reporting mode off
  '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l' + // mouse modes off
  '\x1b[?1049l' +    // leave alternate screen if the TUI entered it
  '\x1b[r' +         // reset scroll region
  '\x1b[2J\x1b[3J\x1b[H'; // clear visible screen + scrollback, home cursor

// ---- line discipline: SwiftTerm keystrokes -> cooked line -> onLine ----
const ld = new LineDiscipline({
  toTerminal: (b) => process.stdout.write(b),
  toProgram: (b) => enqueue(b.toString('utf8')),
  onSignal: (sig) => {
    if (sig === 'SIGINT') { out('^C\r\n'); if (!busy) prompt(); }
  },
  onEof: () => { out('^D\r\n'); },  // root terminal: ^D on empty line is a no-op
});
const feedLd = (chunk) => ld.inputFromTerminal(chunk);

// ---- serialize commands (a line typed while one runs waits its turn) ----
let busy = false;
const queue = [];
function enqueue(line) { queue.push(line); if (!busy) drain(); }
async function drain() {
  let promptAlreadyShown = false;
  while (queue.length) {
    busy = true;
    const result = await onLine(queue.shift());
    promptAlreadyShown = !!(result && result.prompted);
  }
  busy = false;
  if (!promptAlreadyShown) prompt();
}

async function onLine(rawLine) {
  const line = rawLine.replace(/\n$/, '');
  const cmd = line.trim();
  if (!cmd) return;
  const [name, ...rest] = cmd.split(/\s+/);
  try {
    switch (name) {
      case 'exit': case 'logout':
        out(crlf('(this is the root terminal — nothing to exit to; use the app switcher to leave)\n'));
        return;
      case 'clear': out('\x1b[2J\x1b[3J\x1b[H'); return;
      case 'pwd': out(crlf(cwd + '\n')); return;
      case 'cd': doCd(rest[0]); return;
      case 'export': doExport(rest); return;
      case 'icucheck': doIcuCheck(); return;
      case 'help':
        out(crlf('terminal — run any command (ls, cat, grep, sed, awk, jq, curl…).\n' +
                 'builtins: cd, pwd, export, clear, exit, icucheck.  apps: `claude` launches Claude Code.\n'));
        return;
      case 'claude': return await launchEntry(claudeEntry(), rest);
      case 'ssh': {
        // `ssh user@host` with NO remote command → a live interactive remote terminal
        // (real PTY: vim/top/tmux work, resize propagates). `ssh host cmd`, `-N`, and
        // forwarding fall through to the one-shot ssh builtin (captured output).
        const so = require('./preload/commands/ssh-command.js').parseArgs(rest);
        if (so.host && so.command.length === 0 && !so.noExec) return await launchSsh(rest);
        const bash = makeBash(cwd, shellEnv);
        const r = await bash.exec(cmd);
        if (r.stdout) out(crlf(r.stdout));
        if (r.stderr) out(crlf(r.stderr));
        return;
      }
      case 'node': {
        // A real, existing .js/.mjs FILE runs interactively (games that read stdin),
        // reusing the same TTY harness as claude. Everything else — node -e/-p/-,
        // --version, piped stdin, a missing file — falls through to just-bash's
        // in-process `node` builtin (non-interactive, captured output).
        const file = rest[0];
        if (file && !file.startsWith('-')) {
          const abs = path.resolve(cwd, file.replace(/^~(?=\/|$)/, shellEnv.HOME || '~'));
          if (require('node:fs').existsSync(abs)) return await launchEntry(abs, rest.slice(1));
        }
        const bash = makeBash(cwd, shellEnv);
        const r = await bash.exec(cmd);
        if (r.stdout) out(crlf(r.stdout));
        if (r.stderr) out(crlf(r.stderr));
        return;
      }
      default: {
        const bash = makeBash(cwd, shellEnv);
        const r = await bash.exec(cmd);
        if (r.stdout) out(crlf(r.stdout));
        if (r.stderr) out(crlf(r.stderr));
        return;
      }
    }
  } catch (e) {
    out(crlf(`${name}: ${(e && e.message) || e}\n`));
  }
}

function doCd(target) {
  const dest = !target || target === '~' ? (shellEnv.HOME || cwd)
             : path.resolve(cwd, target.replace(/^~(?=\/|$)/, shellEnv.HOME || '~'));
  try { process.chdir(dest); cwd = process.cwd(); shellEnv.PWD = cwd; }
  catch { out(crlf(`cd: no such file or directory: ${target}\n`)); }
}

function doExport(args) {
  for (const a of args) {
    const eq = a.indexOf('=');
    if (eq > 0) { shellEnv[a.slice(0, eq)] = a.slice(eq + 1); }
  }
}

function doIcuCheck() {
  const lines = [];
  lines.push(`node=${process.versions.node || 'unknown'}`);
  lines.push(`v8=${process.versions.v8 || 'unknown'}`);
  lines.push(`icu=${process.versions.icu || 'missing'}`);
  const intlKind = !globalThis.Intl ? 'missing'
                : globalThis.Intl.__polyfill ? 'polyfill'
                : 'native';
  lines.push(`Intl=${intlKind}`);

  const probes = [
    ['unicode-property-L', '\\p{L}', 'u', '\u4e2d', true],
    ['unicode-property-Emoji', '\\p{Extended_Pictographic}', 'u', '\u{1f600}', true],
    ['unicode-property-Mark', '\\p{M}', 'u', '\u0301', true],
  ];
  for (const [label, source, flags, sample, expected] of probes) {
    try {
      const re = new RegExp(source, flags);
      const ok = re.test(sample) === expected;
      lines.push(`${label}=${ok ? 'ok' : 'fail'}`);
    } catch (e) {
      lines.push(`${label}=error:${(e && e.message) || e}`);
    }
  }
  out(crlf(lines.join('\n') + '\n'));
}

// Launch an AI-CLI program (Claude Code today). cli.js is a long-lived Ink app:
// import() resolves as soon as it finishes setup while the app keeps running, so we
// can't just await it. Most exits call process.exit, which the process-exit shim
// turns into SessionExit. Claude's first-run/login TUI can also unmount after
// double Ctrl-C without process.exit; when Ink releases raw mode, the foreground
// program has given the terminal back, so treat that as a second completion signal.
const isEnd = (e) => e && (e.__sessionExit || e.name === 'SessionExit');
const TTY_RELEASE_GRACE_MS = Math.max(0, parseInt(process.env.CLAUDE_IOS_TTY_RELEASE_GRACE_MS || '900', 10) || 0);
const TTY_SHUTDOWN_GRACE_MS = Math.max(TTY_RELEASE_GRACE_MS, parseInt(process.env.CLAUDE_IOS_TTY_SHUTDOWN_GRACE_MS || '8000', 10) || 0);
const SHUTDOWN_OUTPUT_RE = /Resume this session with:|Graceful shutdown|shutdown failed/i;
function launchEntry(entry, args) {
  process.stdin.removeListener('data', feedLd);   // hand stdin to the program (Ink raw mode)
  const savedArgv = process.argv;
  const snapshot = takeProgramSnapshot();
  process.argv = [process.argv[0], entry, ...args];
  for (const k in shellEnv) { try { process.env[k] = shellEnv[k]; } catch {} }
  return new Promise((resolve) => {
    let done = false;
    let sawRawMode = false;
    let releaseTimer = null;
    let releaseTimerIsShutdown = false;
    let outputCapture = null;
    const cancelReleaseTimer = () => {
      if (releaseTimer) clearTimeout(releaseTimer);
      releaseTimer = null;
      releaseTimerIsShutdown = false;
    };
    const armReleaseTimer = (ms, isShutdown) => {
      cancelReleaseTimer();
      releaseTimerIsShutdown = !!isShutdown;
      releaseTimer = setTimeout(() => finish(0), ms);
      if (releaseTimer && typeof releaseTimer.unref === 'function') releaseTimer.unref();
    };
    const maybeExtendShutdownTimer = () => {
      if (done || !releaseTimer || releaseTimerIsShutdown || !outputCapture) return;
      if (!SHUTDOWN_OUTPUT_RE.test(outputCapture.text())) return;
      armReleaseTimer(TTY_SHUTDOWN_GRACE_MS, true);
    };
    outputCapture = captureProgramOutput(maybeExtendShutdownTimer);
    out('\r\n');
    const finish = (code) => {
      if (done) return; done = true;
      cancelReleaseTimer();
      installExitHandler(() => {});
      process.removeListener('__setRawMode', onRawMode);
      process.removeListener('unhandledRejection', onEnd);
      process.removeListener('uncaughtException', onEnd);
      pruneToProgramSnapshot(snapshot);
      outputCapture.restore();
      process.argv = savedArgv;
      try { if (process.stdin.setRawMode) process.stdin.setRawMode(false); } catch {}
      try { process.stdin.resume(); } catch {}
      process.stdin.on('data', feedLd);          // reattach the shell's line discipline
      out(shellTerminalReset() + promptStr());
      resolve({ code, prompted: true });
    };
    const onEnd = (e) => { if (isEnd(e)) finish(e.code || 0); };
    const onRawMode = (raw) => {
      if (done) return;
      if (raw) {
        sawRawMode = true;
        cancelReleaseTimer();
        return;
      }
      if (!sawRawMode) return;
      const isShutdown = SHUTDOWN_OUTPUT_RE.test(outputCapture.text());
      armReleaseTimer(isShutdown ? TTY_SHUTDOWN_GRACE_MS : TTY_RELEASE_GRACE_MS, isShutdown);
    };
    installExitHandler((code) => finish(code || 0));
    process.on('__setRawMode', onRawMode);
    process.on('unhandledRejection', onEnd);
    process.on('uncaughtException', onEnd);
    import(pathToFileURL(entry).href + '?t=' + Date.now()).catch((e) => {
      if (isEnd(e)) return finish(e.code || 0);
      out(crlf('[' + path.basename(entry) + ': ' + ((e && e.message) || e) + ']\n'));
      finish(1);
    });
  });
}

// ---- interactive remote terminal (`ssh user@host`) ----------------------------
// Reuses the same stdin hand-off as launchEntry: detach the line discipline, put the
// terminal in raw mode so keystrokes stream straight to the remote PTY, pump the
// channel both ways, and forward SwiftTerm resizes as SIGWINCH-equivalent setWindow.
// Password/2FA prompts happen on the live TTY via readPassword (echo off).
// Set while a password prompt owns stdin, so a connection failure mid-prompt can cancel
// it and restore the terminal (otherwise stdin stays in raw mode with feedLd detached —
// the terminal looks frozen). Cleared the instant the prompt settles.
let activePasswordAbort = null;

function readPassword(promptStr) {
  return new Promise((resolve) => {
    out(promptStr || 'password: ');
    process.stdin.removeListener('data', feedLd);
    let buf = '';
    let done = false;
    const cleanup = (val) => {
      if (done) return; done = true;
      activePasswordAbort = null;
      process.stdin.removeListener('data', onData);
      try { if (process.stdin.setRawMode) process.stdin.setRawMode(false); } catch {}
      process.stdin.on('data', feedLd);
      resolve(val);
    };
    const onData = (d) => {
      const s = d.toString('utf8');
      for (const ch of s) {
        if (ch === '\r' || ch === '\n') { out('\r\n'); return cleanup(buf); }
        if (ch === '\x03') { out('^C\r\n'); return cleanup(null); }   // Ctrl-C
        if (ch === '\x7f' || ch === '\b') { buf = buf.slice(0, -1); continue; }
        buf += ch;
      }
    };
    // Cancellation path (connection error/timeout while prompting): restore stdin, resolve null.
    activePasswordAbort = () => { out('\r\n'); cleanup(null); };
    try { if (process.stdin.setRawMode) process.stdin.setRawMode(true); } catch {}
    try { process.stdin.resume(); } catch {}
    process.stdin.on('data', onData);
  });
}

function launchSsh(rest) {
  const sshmod = require('./preload/commands/ssh-command.js');
  const ctx = { cwd, env: shellEnv };
  const o = sshmod.parseArgs(rest);
  try { sshmod.applyConfig(o, shellEnv, ctx); } catch {}
  const io = { warn: (s) => out(crlf(s)), password: (p) => readPassword(p) };
  out(crlf(`Connecting to ${o.user ? o.user + '@' : ''}${o.host}${o.port && o.port !== 22 ? ':' + o.port : ''}...\n`));
  return sshmod.connectClient(o, shellEnv, ctx, io).then((conn) => new Promise((resolve) => {
    const rows = process.stdout.rows || ld.rows || 24;
    const cols = process.stdout.columns || ld.cols || 80;
    conn.shell({ term: shellEnv.TERM || 'xterm-256color', rows, cols }, (err, channel) => {
      if (err) { out(crlf(`ssh: ${err.message}\n`)); try { conn.end(); } catch {} return resolve({ prompted: false }); }
      enterRemoteShell(conn, channel, resolve);
    });
  })).catch((e) => {
    if (activePasswordAbort) { try { activePasswordAbort(); } catch {} } // unstick a pending prompt
    out(crlf(String((e && e.message) || e)));
    return { prompted: false };
  });
}

function enterRemoteShell(conn, channel, resolve) {
  let done = false;
  const onStdin = (d) => { try { channel.write(d); } catch {} };
  const onResize = () => { try { channel.setWindow(process.stdout.rows || 24, process.stdout.columns || 80, 0, 0); } catch {} };
  const cleanup = () => {
    if (done) return; done = true;
    process.stdin.removeListener('data', onStdin);
    process.stdout.removeListener('resize', onResize);
    try { if (process.stdin.setRawMode) process.stdin.setRawMode(false); } catch {}
    try { conn.end(); } catch {}
    process.stdin.on('data', feedLd);
    try { process.stdin.resume(); } catch {}
    out(shellTerminalReset() + promptStr());
    resolve({ prompted: true });
  };
  process.stdin.removeListener('data', feedLd);
  try { if (process.stdin.setRawMode) process.stdin.setRawMode(true); } catch {}
  try { process.stdin.resume(); } catch {}
  process.stdin.on('data', onStdin);
  process.stdout.on('resize', onResize);
  // Write the remote PTY's raw bytes straight to stdout — NOT through out()/String(),
  // whose per-chunk utf8 decode mojibakes multibyte chars (CJK, emoji, vim/less
  // box-drawing) split across TCP packets. Byte-exact passthrough.
  channel.on('data', (d) => process.stdout.write(d));
  if (channel.stderr) channel.stderr.on('data', (d) => process.stdout.write(d));
  channel.on('close', cleanup);
  conn.on('close', cleanup);
  conn.on('error', (e) => { out(crlf(`\nssh: ${(e && e.message) || e}\n`)); cleanup(); });
}

function captureProgramOutput(onRecord) {
  const originals = [];
  let recent = '';
  const record = (chunk, encoding) => {
    let s = '';
    if (Buffer.isBuffer(chunk)) s = chunk.toString('utf8');
    else if (chunk instanceof Uint8Array) s = Buffer.from(chunk).toString('utf8');
    else s = String(chunk);
    recent = (recent + s).slice(-8192);
    if (typeof onRecord === 'function') onRecord(recent);
  };
  const wrap = (stream) => {
    if (!stream || typeof stream.write !== 'function') return;
    const original = stream.write;
    function wrappedWrite(chunk, encoding, cb) {
      try { record(chunk, encoding); } catch {}
      return original.apply(this, arguments);
    }
    originals.push([stream, original]);
    stream.write = wrappedWrite;
  };
  wrap(process.stdout);
  wrap(process.stderr);
  return {
    text: () => recent,
    restore() {
      for (const [stream, original] of originals) {
        try { stream.write = original; } catch {}
      }
    },
  };
}

const PROC_EVENTS = ['SIGINT', 'SIGTERM', 'SIGWINCH', 'exit', 'beforeExit', 'warning',
  'uncaughtException', 'unhandledRejection'];
const STREAM_EVENTS = ['data', 'readable', 'resize', 'error', 'close', 'drain', 'keypress'];

function stdStreams() { return [process.stdin, process.stdout, process.stderr]; }

function takeProgramSnapshot() {
  const snap = { proc: new Map(), streams: [] };
  for (const ev of PROC_EVENTS) snap.proc.set(ev, process.listeners(ev));
  for (const st of stdStreams()) {
    const m = new Map();
    if (st) for (const ev of STREAM_EVENTS) m.set(ev, st.listeners(ev));
    snap.streams.push(m);
  }
  return snap;
}

function pruneToProgramSnapshot(snapshot) {
  for (const ev of PROC_EVENTS) {
    const keep = new Set(snapshot.proc.get(ev) || []);
    for (const fn of process.listeners(ev)) {
      if (!keep.has(fn)) process.removeListener(ev, fn);
    }
  }
  stdStreams().forEach((st, i) => {
    if (!st) return;
    for (const ev of STREAM_EVENTS) {
      const keep = new Set(snapshot.streams[i].get(ev) || []);
      for (const fn of st.listeners(ev)) {
        if (!keep.has(fn)) st.removeListener(ev, fn);
      }
    }
  });
}

// ---- boot ----
function main() {
  out(crlf(
    '\x1b[1mL Shell\x1b[0m — on-device terminal.\n' +
    'Type commands (ls, cat, grep, curl…). `claude` launches Claude Code. `help` for more.\n' +
    'Official Claude users can run `claude` and sign in. API/relay users should save endpoint, key, and models in the container first.\n\n'));
  process.stdin.on('data', feedLd);
  try { process.stdin.resume(); } catch {}
  // Out-of-band launch: the app writes `enqueue <base64>` to the control fd (even while
  // a foreground program owns stdin). It lands in the same serialized queue as typed
  // lines, so a re-launched program only starts AFTER the current one's launchProgram
  // promise resolves — no stdin-timing race with a program that is still shutting down.
  process.on('lshell:enqueue', (cmd) => {
    const line = String(cmd || '').trim();
    if (line) enqueue(line + '\n');
  });
  // Defense: a foreground program (claude, or a `node` game) can call process.exit()
  // from a bare libuv stdin callback, throwing SessionExit AFTER launchEntry's finish()
  // has already removed its per-launch handler. Swallow SessionExit at the top level so
  // the runtime survives; other uncaught errors fall to bootstrap.js's handler.
  const swallowSessionExit = (e) => { if (e && (e.__sessionExit || e.name === 'SessionExit')) return; };
  process.on('uncaughtException', swallowSessionExit);
  process.on('unhandledRejection', swallowSessionExit);
  const startupCommand = String(process.env.LSHELL_START_COMMAND || '').trim();
  if (startupCommand) {
    out(promptStr() + startupCommand + '\r\n');
    enqueue(startupCommand + '\n');
  } else {
    prompt();
  }
}
main();
