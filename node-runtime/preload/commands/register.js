'use strict';
// Command handlers for the child_process interceptor.
//
// Verified behavior (jitless, /usr/bin absent — faithful iOS): just-bash resolves
// its ~60 built-in coreutils (grep/find/sed/awk/cat/ls/sort/jq/tar/pipes/…) via
// registry fallback with NO /usr/bin needed, operating on real files through
// PassthroughFs. rg is served as a DIRECT spawn (Claude invokes it directly), since
// just-bash's built-in rg dispatch is stubbed. Each `bash -c` is a fresh instance,
// matching one-shot shell semantics (no env/cwd carryover between tool calls).
//
// Interruption: the interceptor's AbortSignal is threaded into just-bash exec(),
// which stops at the next statement boundary (loops with sleep/commands abort in
// ms; a pure-arithmetic tight loop is ended by just-bash's maxCommandCount cap).

// Dev-only: dump every script the Bash tool sends + just-bash's result to a log under
// HOME, so we can see the EXACT failing script (snapshot gen, per-command wrappers).
// Gated on LSHELL_BASH_DEBUG=1; inert otherwise.
function debugLogShell(args, cwd, script, r) {
  if (process.env.LSHELL_BASH_DEBUG !== '1') return;
  try {
    const fs = require('node:fs');
    const p = (process.env.HOME || '/tmp') + '/lshell-bash-debug.log';
    fs.appendFileSync(p,
      `\n===== t=${Date.now()} exit=${r && r.exitCode} cwd=${cwd}\n` +
      `--ARGS-- ${JSON.stringify(args)}\n` +
      `--SCRIPT(${(script || '').length}b)--\n${script}\n` +
      `--STDOUT-- ${JSON.stringify((r && r.stdout || '').slice(0, 400))}\n` +
      `--STDERR-- ${JSON.stringify((r && r.stderr || '').slice(0, 800))}\n`);
  } catch {}
}

// Language runtimes / package managers that CANNOT run in this runtime. just-bash
// bundles python3 (Emscripten CPython) and node/js-exec (QuickJS) but both are
// WASM/worker-based — dead under jitless nodejs-mobile with no WebAssembly. And there
// is no fork/exec, so no external binary runs either. Without an explicit handler,
// just-bash falls through to the filesystem: on the iOS SIMULATOR it then finds the
// Mac's real /usr/bin/python3 and tries to parse that binary as a shell script,
// producing a baffling `line NNN: unexpected EOF` exit 2. Register a clean, honest
// error instead so the caller (Claude's Bash tool) understands the limitation.
// NB: `node` is NOT here — it is implemented in-process (registerNode below), and
// `npm` is implemented in-process too (registerNpmCmd; install/uninstall/init/ls/run).
// `npx` stays unavailable: it would need to exec an arbitrary installed binary.
const UNAVAILABLE_RUNTIMES = {
  npx: 'Node.js', bun: 'a JS runtime', deno: 'a JS runtime',
  ruby: 'Ruby', perl: 'Perl', php: 'PHP', go: 'Go', rustc: 'Rust', cargo: 'Rust',
  java: 'Java', gcc: 'a C compiler', cc: 'a C compiler', make: 'make',
};

function registerUnavailableRuntimes(bash) {
  let defineCommand;
  try { ({ defineCommand } = require('just-bash')); } catch { return; }
  if (typeof defineCommand !== 'function') return;
  for (const name of Object.keys(UNAVAILABLE_RUNTIMES)) {
    const lang = UNAVAILABLE_RUNTIMES[name];
    try {
      bash.registerCommand(defineCommand(name, async () => ({
        stdout: '',
        stderr: `${name}: not available on this device. This on-device shell has no ${lang} ` +
          `interpreter (jitless runtime, no WebAssembly) and cannot execute external programs. ` +
          `Files can be created and edited here, but not run.\n`,
        exitCode: 127,
      })));
    } catch { /* name unknown to this just-bash build → ignore */ }
  }
}

// Register the in-process `node` executor as a real just-bash builtin. This makes
// `node file.js`, `node -e`, `node -p`, piped stdin, `node --version`, and
// `command -v node` all resolve+run inside Claude's Bash tool (node runs via a vm
// sandbox; see node-runner.js). Requires PassthroughFs's sync-stub methods so
// registerCommand's PATH stub is written (see passthrough-fs.js).
function registerNode(bash) {
  let defineCommand;
  try { ({ defineCommand } = require('just-bash')); } catch { return; }
  if (typeof defineCommand !== 'function') return;
  let nodeCommandHandler;
  try { ({ nodeCommandHandler } = require('./node-runner.js')); } catch { return; }
  try {
    bash.registerCommand(defineCommand('node', (args, ctx) => nodeCommandHandler(args, ctx)));
  } catch { /* build without defineCommand support → skip */ }
}

// Environment-probe coreutils that just-bash does NOT bundle (uname/id/arch/…).
// Registered as REAL just-bash builtins (same mechanism as registerNode): this
// both adds them to the interpreter's command registry AND writes /bin/<name>
// PATH stubs, so `uname` inside a `bash -c` script resolves — instead of falling
// through to a nonexistent binary (device → 127) or a Mach-O parsed as a script
// (simulator → exit 2). The shim-registry unameH/whichH (register(), below) serve
// DIRECT spawn('uname') and stay as-is; the two paths are orthogonal.
function registerProbes(bash) {
  let defineCommand;
  try { ({ defineCommand } = require('just-bash')); } catch { return; }
  if (typeof defineCommand !== 'function') return;
  const ok = (stdout = '', exitCode = 0, stderr = '') => ({ stdout, stderr, exitCode });
  const reg = (name, fn) => {
    try { bash.registerCommand(defineCommand(name, async (args, ctx) => fn(args, ctx))); } catch { /* name unknown to build → skip */ }
  };
  reg('uname', (args) => {
    const letters = new Set();
    for (const a of args) if (a && a.startsWith('-') && !a.startsWith('--')) for (const ch of a.slice(1)) letters.add(ch);
    const has = (c) => letters.has(c);
    const s = 'Darwin', n = 'iPhone', r = '24.0.0', v = 'Darwin Kernel Version 24.0.0', m = 'arm64';
    if (has('a')) return ok(`${s} ${n} ${r} ${v} ${m}\n`);
    const parts = [];
    if (has('s')) parts.push(s);
    if (has('n')) parts.push(n);
    if (has('r')) parts.push(r);
    if (has('v')) parts.push(v);
    if (has('m') || has('p')) parts.push(m);
    return ok((parts.length ? parts.join(' ') : s) + '\n');
  });
  reg('arch', () => ok('arm64\n'));
  reg('id', (args) => {
    const uid = 501, gid = 501, user = 'mobile';
    if (args.includes('-un') || (args.includes('-u') && args.includes('-n'))) return ok(user + '\n');
    if (args.includes('-gn') || (args.includes('-g') && args.includes('-n'))) return ok(user + '\n');
    if (args.includes('-u')) return ok(uid + '\n');
    if (args.includes('-g')) return ok(gid + '\n');
    return ok(`uid=${uid}(${user}) gid=${gid}(${user}) groups=${gid}(${user})\n`);
  });
  reg('nproc', () => ok('2\n'));
  reg('groups', () => ok('mobile\n'));
  reg('logname', () => ok('mobile\n'));
  reg('tty', () => ok('not a tty\n', 1));
}

// `git` backed by isomorphic-git (pure JS, no WASM). See git-command.js.
function registerGit(bash) {
  let defineCommand;
  try { ({ defineCommand } = require('just-bash')); } catch { return; }
  if (typeof defineCommand !== 'function') return;
  let gitMain;
  try { ({ gitMain } = require('./git-command.js')); } catch { return; }
  try { bash.registerCommand(defineCommand('git', (args, ctx) => gitMain(args, ctx))); } catch { /* skip */ }
}

// `npm` subset backed by an in-process installer (registry fetch via node:https,
// gunzip via node:zlib native, tar via tar-stream pure JS). No exec/WASM. See
// npm-command.js / inpm.js. Supports install/ls/run/--version; lifecycle scripts
// and native addons are detected and reported (cannot execute).
function registerNpmCmd(bash) {
  let defineCommand;
  try { ({ defineCommand } = require('just-bash')); } catch { return; }
  if (typeof defineCommand !== 'function') return;
  try { require('./npm-command.js').registerNpm(bash, defineCommand); } catch { /* skip */ }
}

// `python3`/`python` backed by an embedded CPython 3.13 via the lshell_py N-API
// bridge (process._linkedBinding). No-op on hosts where the bridge isn't linked
// in (dev/sim without the native module) — python-command.js reports honestly.
function registerPython(bash) {
  let defineCommand;
  try { ({ defineCommand } = require('just-bash')); } catch { return; }
  if (typeof defineCommand !== 'function') return;
  try { require('./python-command.js').registerPython(bash, defineCommand); } catch { /* skip */ }
}

// `pip3` / `pip` — pure-JS front-end that installs pure-Python wheels from PyPI into
// a writable site-packages the embedded CPython picks up (via python-command.js's
// sys.path preamble). pipMain reads ctx.env as a plain object; we merge process.env
// (carries LSHELL_PY_SITE set by NodeRunner) so pip and python3 resolve the SAME dir.
function registerPip(bash) {
  let defineCommand;
  try { ({ defineCommand } = require('just-bash')); } catch { return; }
  if (typeof defineCommand !== 'function') return;
  let pipMain;
  try { ({ pipMain } = require('./pip-command.js')); } catch { return; }
  const ctxEnvObj = (ctx) => {
    const out = Object.assign({}, process.env);
    if (ctx && ctx.exportedEnv) Object.assign(out, ctx.exportedEnv);
    if (ctx && ctx.env) {
      if (ctx.env instanceof Map) for (const [k, v] of ctx.env) out[k] = v;
      else Object.assign(out, ctx.env);
    }
    return out;
  };
  for (const name of ['pip3', 'pip']) {
    try { bash.registerCommand(defineCommand(name, (args, ctx) => pipMain(args, { env: ctxEnvObj(ctx) }))); } catch { /* skip */ }
  }
}

// Extra coreutils just-bash lacks (sw_vers/realpath/mktemp + persona whoami/
// hostname), an enhanced `cat` with the full GNU flag set (-A/-b/-E/-T/-v/-s),
// and gap-fills for df/yes + shadowed stat(-f BSD, full -c GNU)/seq(-f)/xargs
// (glued -n1/-I{} forms). Registered LAST so the enhanced impls win over stock.
function registerShellExtras(bash) {
  let defineCommand;
  try { ({ defineCommand } = require('just-bash')); } catch { return; }
  if (typeof defineCommand !== 'function') return;
  try { require('./shell-extras.js').registerMissing(bash, defineCommand); } catch { /* skip */ }
  try { require('./coreutils.js').registerCat(bash, defineCommand); } catch { /* skip */ }
  try { require('./coreutils-gaps.js').registerCoreutilsGaps(bash, defineCommand); } catch { /* skip */ }
}

// Network + crypto tools Claude uses constantly that are missing or BROKEN in
// just-bash under this runtime:
//   curl/wget  — just-bash SHIPS curl but it fails internally here (its network
//                path is fetch/undici→llhttp.wasm, dead under jitless; even a bare
//                `curl` errors "line NNNN: unexpected EOF", exit 2). We override it
//                with a node:http(s) impl that honors HTTPS_PROXY. See curl-command.js.
//   sha*sum/shasum — just-bash ships ONLY md5sum; add the sha family via node:crypto.
//   xxd        — not shipped; hex dump/reverse via node Buffers.
// Registered LAST so our curl wins over the broken stock builtin.
function registerNetTools(bash) {
  let defineCommand;
  try { ({ defineCommand } = require('just-bash')); } catch { return; }
  if (typeof defineCommand !== 'function') return;
  try { require('./curl-command.js').registerCurl(bash, defineCommand); } catch { /* skip */ }
  try { require('./hash-command.js').registerHashes(bash, defineCommand); } catch { /* skip */ }
  try { require('./xxd-command.js').registerXxd(bash, defineCommand); } catch { /* skip */ }
  registerSshSuite(bash, defineCommand);
}

// Full SSH client suite (all pure-JS ssh2 + node:crypto, jitless-safe): the ssh client
// itself, the standard password front-end (sshpass), key tooling (ssh-keygen /
// ssh-copy-id), and file transfer (scp / sftp). Registered together so a device build
// exposes the same command surface a real terminal has — no bespoke conventions.
function registerSshSuite(bash, defineCommand) {
  try { require('./ssh-command.js').registerSsh(bash, defineCommand); } catch { /* skip */ }
  try { require('./sshpass-command.js').registerSshpass(bash, defineCommand); } catch { /* skip */ }
  try { require('./ssh-keygen-command.js').registerSshKeygen(bash, defineCommand); } catch { /* skip */ }
  try { require('./ssh-copy-id-command.js').registerSshCopyId(bash, defineCommand); } catch { /* skip */ }
  try { require('./scp-command.js').registerScp(bash, defineCommand); } catch { /* skip */ }
  try { require('./sftp-command.js').registerSftp(bash, defineCommand); } catch { /* skip */ }
}

function makeBash(cwd, env) {
  const { Bash } = require('just-bash');
  const { PassthroughFs } = require('./passthrough-fs.js');
  const bash = new Bash({
    fs: new PassthroughFs({ cwd }),
    cwd,
    env: envStrings(env || process.env),
  });
  registerUnavailableRuntimes(bash);
  registerNode(bash);
  registerProbes(bash);
  registerGit(bash);
  registerNpmCmd(bash);
  registerPython(bash);
  registerPip(bash);
  registerShellExtras(bash);
  registerNetTools(bash);
  return bash;
}

// just-bash wants Record<string,string>; spawn callers pass env objects that may
// hold undefined (cli.js does `SHELL: cond ? x : undefined`). Drop those, stringify
// the rest. options.env replaces the environment wholesale, per Node semantics.
function envStrings(env) {
  const out = {};
  for (const k in env) {
    const v = env[k];
    if (v !== undefined && v !== null) out[k] = String(v);
  }
  // just-bash serves its builtins from a virtual /bin; a caller PATH without it
  // would 127 every command. Keep builtins resolvable no matter the PATH given.
  // Force /bin to the FRONT so just-bash's builtin stubs (node, timeout, …) win over
  // any real interpreter dir the simulator exposes from the Mac. Deterministic on both
  // sim and device.
  if (!out.PATH) out.PATH = '/bin:/usr/bin:/usr/local/bin';
  else out.PATH = '/bin:' + out.PATH.split(':').filter((d) => d && d !== '/bin').join(':');
  // Point the temp env vars at the container-writable dir. On iOS the literal /tmp
  // is read-only; without this, tools that build scratch paths from $TMPDIR (mktemp,
  // many build steps, git's own temp) would target an unwritable root. resolveTarget
  // prefers an already-set container TMPDIR, else os.tmpdir(). We never leave these
  // pointing at a classic /tmp root. (Code that HARDCODES /tmp still works via the
  // PassthroughFs / git-command redirect.)
  try {
    const { resolveTarget } = require('./tmp-map.js');
    const target = resolveTarget(out.TMPDIR);
    if (target) { out.TMPDIR = target; out.TMP = target; out.TEMP = target; }
  } catch { /* tmp-map optional; env stays as-is */ }
  return out;
}

function register(registerCommand) {
  const { rg } = require('./ripgrep.js');
  const baseName = (file) => String(file || '').replace(/\\/g, '/').split('/').pop();

  // bash / sh / zsh / dash [-l] -c "<script>" → just-bash.
  // Claude Code invokes the shell as `zsh -c -l <script>` — the login flag sits
  // BETWEEN -c and the script, so the script is not args[indexOf('-c')+1]; it's the
  // final argument. Extract it robustly.
  const extractScript = (args) => {
    const ci = args.indexOf('-c');
    if (ci < 0) return args.find((a) => a && !a.startsWith('-')) || '';
    const last = args[args.length - 1];
    if (last && !(last.startsWith('-') && last.length <= 2)) return last; // long string = the script
    for (let i = ci + 1; i < args.length; i++) if (args[i] && !args[i].startsWith('-')) return args[i];
    return '';
  };
  const shellHandler = async ({ args, env, cwd, signal }) => {
    const wd = cwd || process.cwd();
    const script = extractScript(args);
    if (!script) return { code: 0, stdout: '', stderr: '' };
    const bash = makeBash(wd, env); // fresh instance: per-invocation env+cwd, no stale carryover
    // Abort → just-bash returns exitCode 124 at the next statement boundary;
    // the interceptor rewrites an aborted child to (null, signal) per Node.
    const r = await bash.exec(script, { signal });
    debugLogShell(args, wd, script, r);
    return { code: r.exitCode || 0, stdout: r.stdout || '', stderr: r.stderr || '' };
  };
  for (const sh of ['bash', 'sh', 'zsh', 'dash']) registerCommand(sh, shellHandler);

  // rg → JS ripgrep shim (both async and sync callers).
  const rgHandler = ({ args, cwd }) => rg(args, { cwd: cwd || process.cwd() });
  registerCommand('rg', async (ctx) => rgHandler(ctx), (ctx) => rgHandler(ctx));

  // git → isomorphic-git (direct spawn('git') path; scripts go via registerGit).
  registerCommand('git', async ({ args, cwd }) => {
    const { gitMain } = require('./git-command.js');
    const r = await gitMain(args || [], { cwd: cwd || process.cwd() });
    return { code: r.exitCode || 0, stdout: r.stdout || '', stderr: r.stderr || '' };
  });

  // Environment probes.
  const ok = (stdout = '', code = 0, stderr = '') => ({ code, stdout, stderr });
  const unameH = ({ args }) => {
    if (args.includes('-a')) return ok('Darwin iPhone 24.0.0 Darwin Kernel arm64\n');
    if (args.includes('-s')) return ok('Darwin\n');
    if (args.includes('-m')) return ok('arm64\n');
    return ok('Darwin\n');
  };
  const whichH = ({ args }) => {
    const target = args[args.length - 1];
    if (['bash', 'sh', 'zsh', 'rg'].includes(target)) return ok(`/usr/bin/${target}\n`);
    return ok('', 1);
  };
  const both = (name, h) => registerCommand(name, async (ctx) => h(ctx), (ctx) => h(ctx));
  both('uname', unameH);
  both('which', whichH);
  both('command', whichH);

  // /usr/bin/env VAR=x bash -c ... is a common wrapper around shells. iOS has no
  // exec, so env must unwrap and re-dispatch to the in-process handlers.
  const envH = async ({ args, env, cwd, signal }) => {
    const parsed = parseEnvInvocation(args, env || process.env);
    if (!parsed.command) {
      const stdout = Object.keys(parsed.env).sort().map((k) => `${k}=${parsed.env[k]}\n`).join('');
      return ok(stdout);
    }
    return dispatchKnown(parsed.command, parsed.args, parsed.env, cwd, signal);
  };
  const envSyncH = ({ args, env, cwd }) => {
    const parsed = parseEnvInvocation(args, env || process.env);
    if (!parsed.command) {
      const stdout = Object.keys(parsed.env).sort().map((k) => `${k}=${parsed.env[k]}\n`).join('');
      return ok(stdout);
    }
    return dispatchKnownSync(parsed.command, parsed.args, parsed.env, cwd);
  };
  registerCommand('env', envH, envSyncH);

  function dispatchKnown(command, args, env, cwd, signal) {
    const name = baseName(command);
    if (['bash', 'sh', 'zsh', 'dash'].includes(name)) return shellHandler({ args, env, cwd, signal });
    if (name === 'rg') return Promise.resolve(rgHandler({ args, cwd }));
    if (name === 'uname') return Promise.resolve(unameH({ args }));
    if (name === 'which' || name === 'command') return Promise.resolve(whichH({ args }));
    if (name === 'env') return envH({ args, env, cwd, signal });
    return Promise.resolve(ok('', 127, `${name || command}: command not found\n`));
  }

  function dispatchKnownSync(command, args, env, cwd) {
    const name = baseName(command);
    if (name === 'rg') return rgHandler({ args, cwd });
    if (name === 'uname') return unameH({ args });
    if (name === 'which' || name === 'command') return whichH({ args });
    if (name === 'env') return envSyncH({ args, env, cwd });
    return ok('', 127, `${name || command}: command not found\n`);
  }

  // tree-kill support: cli.js's Bash tool interrupt/timeout enumerates the pid
  // tree via `pgrep -P` (darwin) / `ps --ppid` (default branch — covers 'ios'),
  // then process.kill()s each pid (routed to fake children by the interceptor).
  // Fake children have no subtree → faithful "no match" exit 1. Without these,
  // the ENOENT 'error' emit would crash tree-kill (it attaches no error listener).
  const noMatch = () => ok('', 1);
  both('pgrep', noMatch);
  both('ps', noMatch);
}

function parseEnvInvocation(args, parentEnv) {
  let env = envStrings(parentEnv || process.env);
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === '-i' || a === '--ignore-environment') { env = {}; i++; continue; }
    if (a === '-u' || a === '--unset') { delete env[String(args[i + 1] || '')]; i += 2; continue; }
    if (a && a.startsWith('--unset=')) { delete env[a.slice(8)]; i++; continue; }
    if (a === '-S' || a === '--split-string') {
      const split = splitEnvString(args[i + 1] || '');
      args = args.slice(0, i).concat(split, args.slice(i + 2));
      continue;
    }
    const eq = typeof a === 'string' ? a.indexOf('=') : -1;
    if (eq > 0) { env[a.slice(0, eq)] = a.slice(eq + 1); i++; continue; }
    if (a && a.startsWith('-')) { i++; continue; }
    break;
  }
  return { env, command: args[i] || '', args: args.slice(i + 1) };
}

function splitEnvString(s) {
  const out = [];
  let cur = '';
  let quote = '';
  let esc = false;
  for (const ch of String(s)) {
    if (esc) { cur += ch; esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (quote) {
      if (ch === quote) quote = '';
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (/\s/.test(ch)) { if (cur) { out.push(cur); cur = ''; } continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

module.exports = { register, makeBash };
