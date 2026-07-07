'use strict';
// SSH client suite for L Shell, backed by ssh2 (pure-JS SSH2 protocol; ciphers/kex/
// signatures via node:crypto native OpenSSL — no native addon, no WASM, verified
// jitless-safe). TCP is node:net (works on device; curl rides it too).
//
// This file is the CORE: it owns argument parsing, ~/.ssh/config resolution,
// known_hosts (TOFU) verification, the authentication chain, and ProxyJump. The
// resulting `connectClient()` is reused by:
//   - sshMain here           (`ssh host cmd`  → one-shot exec, captured output)
//   - sshpass-command.js     (`sshpass -p X ssh …` → password-injected one-shot)
//   - scp-command.js / sftp  (file transfer over the same connection)
//   - shell.js launchSsh     (`ssh host` → live interactive remote terminal)
//
// Auth model (matches real OpenSSH, so Claude/users/scripts use STANDARD commands —
// no bespoke env-var convention required):
//   • public key   -i keyfile  (+ SSH_KEY_PASSPHRASE),  or ~/.ssh/id_{ed25519,ecdsa,rsa}
//   • password     via `sshpass -p PASS ssh …`  (sets SSH_PASSWORD),  SSH_PASSWORD/SSHPASS,
//                  or an interactive TTY prompt (io.password) in the live terminal
//   • keyboard-interactive (2FA/OTP) answered with the same password / TTY prompt
//   stdin is delivered to the REMOTE command (standard `echo x | ssh host cat`),
//   never consumed as a password — password comes only from the channels above.
// On failure the error lists user@host:port and EVERY method tried, with copy-paste
// fixes — so a wrong username / missing password is obvious, not a blank "auth failed".

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const nodeCrypto = require('node:crypto');

let ssh2 = null;
try { ssh2 = require('ssh2'); } catch { /* not bundled → honest error in sshMain */ }
const Client = ssh2 && ssh2.Client;

// jitless iOS has NO WebAssembly and no optional native addon. Restrict to ciphers/
// MACs ssh2 implements purely via node:crypto (native OpenSSL): AES-CTR + HMAC-SHA2.
// chacha20-poly1305 (poly1305 WASM) and aes-gcm (sshcrypto.node) are excluded. kex
// (curve25519 / ecdh via node:crypto) and host-key sigs (ed25519/rsa via node:crypto)
// are already pure-native and left at ssh2 defaults.
const ALGORITHMS = {
  cipher: ['aes256-ctr', 'aes192-ctr', 'aes128-ctr'],
  hmac: ['hmac-sha2-256', 'hmac-sha2-512', 'hmac-sha1'],
};

const baseName = (p) => String(p || '').replace(/\\/g, '/').split('/').pop();

// ---------------------------------------------------------------- env / paths ----
function envOf(ctx) {
  const out = Object.assign({}, process.env);
  if (ctx && ctx.exportedEnv) Object.assign(out, ctx.exportedEnv);
  if (ctx && ctx.env) {
    if (ctx.env instanceof Map) for (const [k, v] of ctx.env) out[k] = v;
    else Object.assign(out, ctx.env);
  }
  return out;
}

function expandUser(p, env, ctx) {
  if (!p) return p;
  if (p === '~') return env.HOME || '';
  if (p.startsWith('~/')) return nodePath.join(env.HOME || '', p.slice(2));
  if (nodePath.isAbsolute(p)) return p;
  return nodePath.resolve((ctx && ctx.cwd) || env.HOME || '/', p);
}

function sshDir(env) { return nodePath.join(env.HOME || '', '.ssh'); }
function ensureSshDir(env) {
  const d = sshDir(env);
  try { nodeFs.mkdirSync(d, { recursive: true, mode: 0o700 }); } catch {}
  return d;
}

// ---------------------------------------------------------------- arg parsing ----
// ssh [-p port] [-i key] [-l user] [-F configfile] [-J jump] [-o K=V]
//     [-L spec] [-R spec] [-D spec] [-N] [-t|-T|-q|-v|-4|-6|-C] [user@]host [cmd...]
function parseArgs(args) {
  const o = {
    port: null, host: null, user: null, keyFile: null, configFile: null,
    proxyJump: null, opts: {}, command: [],
    localFwd: [], remoteFwd: [], dynamicFwd: [], noExec: false,
    forceTty: false, identityFiles: [], identitiesOnly: false,
  };
  const takesValue = new Set(['-p', '-i', '-l', '-F', '-J', '-o', '-L', '-R', '-D', '-b', '-c', '-m', '-w']);
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '-N') { o.noExec = true; continue; }
    if (a === '-t') { o.forceTty = true; continue; }
    if (a === '-T' || a === '-q' || a === '-v' || a === '-vv' || a === '-vvv' ||
        a === '-4' || a === '-6' || a === '-C' || a === '-A' || a === '-a' ||
        a === '-x' || a === '-X' || a === '-g' || a === '-n' || a === '-f') { continue; }
    if (a === '-p') { o.port = parseInt(args[++i], 10) || o.port; continue; }
    if (a === '-i') { o.keyFile = args[++i]; continue; }
    if (a === '-l') { o.user = args[++i]; continue; }
    if (a === '-F') { o.configFile = args[++i]; continue; }
    if (a === '-J') { o.proxyJump = args[++i]; continue; }
    if (a === '-L') { o.localFwd.push(args[++i]); continue; }
    if (a === '-R') { o.remoteFwd.push(args[++i]); continue; }
    if (a === '-D') { o.dynamicFwd.push(args[++i]); continue; }
    if (a === '-o') {
      const kv = args[++i] || ''; const eq = kv.indexOf('=');
      if (eq > 0) o.opts[kv.slice(0, eq).toLowerCase()] = kv.slice(eq + 1);
      else { const sp = kv.indexOf(' '); if (sp > 0) o.opts[kv.slice(0, sp).toLowerCase()] = kv.slice(sp + 1); }
      continue;
    }
    if (a && a.startsWith('-')) { if (takesValue.has(a)) i++; continue; } // unknown flag, lenient
    // first bare word = [user@]host, the rest = remote command
    o.host = a;
    o.command = args.slice(i + 1);
    break;
  }
  if (o.host && o.host.includes('@')) {
    const at = o.host.indexOf('@');
    if (!o.user) o.user = o.host.slice(0, at);
    o.host = o.host.slice(at + 1);
  }
  if (o.host && o.host.includes(':') && !o.host.includes('::')) {
    const c = o.host.lastIndexOf(':');
    const p = parseInt(o.host.slice(c + 1), 10);
    if (p) { if (!o.port) o.port = p; o.host = o.host.slice(0, c); }
  }
  return o;
}

// ---------------------------------------------------------------- ssh config ----
// Minimal ~/.ssh/config: Host blocks with HostName/User/Port/IdentityFile/ProxyJump/
// StrictHostKeyChecking/IdentitiesOnly/ServerAliveInterval. First match wins per key
// (OpenSSH semantics); command-line values already set take precedence over config.
function loadSshConfig(env, ctx, configFile) {
  const file = configFile ? expandUser(configFile, env, ctx) : nodePath.join(sshDir(env), 'config');
  let text;
  try { text = nodeFs.readFileSync(file, 'utf8'); } catch { return []; }
  const blocks = [];
  let cur = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(\S+)[\s=]+(.+)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'host') { cur = { patterns: val.split(/\s+/), settings: {} }; blocks.push(cur); continue; }
    if (!cur) continue;
    if (key === 'identityfile') { (cur.settings.identityfile = cur.settings.identityfile || []).push(val); }
    else cur.settings[key] = val;
  }
  return blocks;
}

function matchHostPattern(pattern, host) {
  // glob: * and ?, with optional ! negation
  let neg = false, p = pattern;
  if (p.startsWith('!')) { neg = true; p = p.slice(1); }
  const re = new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
  return { match: re.test(host), neg };
}

function applyConfig(o, env, ctx) {
  const blocks = loadSshConfig(env, ctx, o.configFile);
  if (!blocks.length) return;
  const merged = {};
  for (const b of blocks) {
    let matched = false, negated = false;
    for (const pat of b.patterns) {
      const r = matchHostPattern(pat, o.host);
      if (r.neg && r.match) { negated = true; break; }
      if (r.match) matched = true;
    }
    if (negated || !matched) continue;
    for (const k in b.settings) if (!(k in merged)) merged[k] = b.settings[k]; // first match wins
  }
  // apply, command line wins over config
  if (merged.hostname) o.realHost = merged.hostname;
  if (!o.user && merged.user) o.user = merged.user;
  if (!o.port && merged.port) o.port = parseInt(merged.port, 10) || null;
  if (!o.keyFile && merged.identityfile) o.identityFiles = merged.identityfile.slice();
  if (!o.proxyJump && merged.proxyjump && merged.proxyjump.toLowerCase() !== 'none') o.proxyJump = merged.proxyjump;
  if (merged.identitiesonly && /yes/i.test(merged.identitiesonly)) o.identitiesOnly = true;
  if (merged.stricthostkeychecking && !('stricthostkeychecking' in o.opts)) o.opts.stricthostkeychecking = merged.stricthostkeychecking.toLowerCase();
  if (merged.serveraliveinterval) o.serverAliveInterval = parseInt(merged.serveraliveinterval, 10) || 0;
  if (merged.connecttimeout) o.connectTimeout = parseInt(merged.connecttimeout, 10) || 0;
}

// ---------------------------------------------------------------- known_hosts ----
// TOFU: store `host[:port] SHA256:<b64>` lines in ~/.ssh/known_hosts (our own format,
// fingerprints match `ssh-keygen -l` output). First contact records; a mismatch on a
// later connect is a hard failure with the classic warning.
function knownHostsPath(env) { return nodePath.join(sshDir(env), 'known_hosts'); }
function hostId(o) { const p = o.port || 22; return p === 22 ? o.host : `${o.host}:${p}`; }
function fingerprintOf(keyBuf) {
  return 'SHA256:' + nodeCrypto.createHash('sha256').update(keyBuf).digest('base64').replace(/=+$/, '');
}
function readKnownHosts(env) {
  const map = new Map();
  try {
    for (const line of nodeFs.readFileSync(knownHostsPath(env), 'utf8').split(/\r?\n/)) {
      const t = line.trim(); if (!t || t.startsWith('#')) continue;
      const sp = t.indexOf(' '); if (sp < 0) continue;
      map.set(t.slice(0, sp), t.slice(sp + 1).trim());
    }
  } catch {}
  return map;
}
function appendKnownHost(env, id, fp) {
  ensureSshDir(env);
  try { nodeFs.appendFileSync(knownHostsPath(env), `${id} ${fp}\n`, { mode: 0o600 }); } catch {}
}
function makeHostVerifier(o, env, io) {
  return (key, cb) => {
    const fp = fingerprintOf(key);
    const id = hostId(o);
    const known = readKnownHosts(env);
    const prev = known.get(id);
    const strict = (o.opts.stricthostkeychecking || '').toLowerCase();
    const accept = (v) => (typeof cb === 'function' ? cb(v) : v);
    if (prev) {
      if (prev === fp) return accept(true);
      io.warn(`@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n` +
        `@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @\n` +
        `@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n` +
        `Host key for ${id} changed.\n  known: ${prev}\n    now: ${fp}\n` +
        `If this is expected, remove the stale line from ${knownHostsPath(env)}.\n`);
      return accept(false);
    }
    if (strict === 'yes') {
      io.warn(`Host key verification failed: ${id} (${fp}) is not in known_hosts and StrictHostKeyChecking=yes.\n`);
      return accept(false);
    }
    appendKnownHost(env, id, fp);
    io.warn(`Warning: Permanently added '${id}' (${fp}) to the list of known hosts.\n`);
    return accept(true);
  };
}

// ---------------------------------------------------------------- auth chain ----
// authHandler drives the method sequence AND records exactly what was tried, so the
// failure message can name the cause. Order: none (probe) → each public key →
// password → keyboard-interactive. methodsLeft (from the server) prunes unsupported.
function collectKeys(o, env, ctx) {
  const keys = [];
  const add = (file) => {
    const abs = expandUser(file, env, ctx);
    try { keys.push({ file: abs, raw: nodeFs.readFileSync(abs) }); } catch {}
  };
  if (o.keyFile) add(o.keyFile);
  else if (o.identityFiles && o.identityFiles.length) o.identityFiles.forEach(add);
  if (!o.keyFile && !o.identitiesOnly) {
    for (const n of ['id_ed25519', 'id_ecdsa', 'id_rsa']) {
      const p = nodePath.join(sshDir(env), n);
      try { if (nodeFs.existsSync(p)) add(p); } catch {}
    }
  }
  return keys;
}

function makeAuthHandler(o, env, ctx, io, tried) {
  const username = o.user;
  const keys = collectKeys(o, env, ctx);
  const passphrase = env.SSH_KEY_PASSPHRASE || undefined;
  // Distinguish an intentionally empty password ('') from "unset": some accounts have a
  // blank password, and sshpass injects SSH_PASSWORD='' for `sshpass -p ''`. Auth
  // branches gate on `password != null`, so '' is a valid password, null means none.
  let password = (env.SSH_PASSWORD != null) ? env.SSH_PASSWORD
               : (env.SSHPASS != null) ? env.SSHPASS : null;

  const queue = [{ type: 'none' }];
  for (const k of keys) queue.push({ type: 'publickey', key: k });
  queue.push({ type: 'password' });
  queue.push({ type: 'keyboard-interactive' });
  let idx = -1;

  const answerKbd = (name, instr, lang, prompts, finish) => {
    const answers = [];
    const next = (i) => {
      if (i >= prompts.length) return finish(answers);
      if (password != null) { answers.push(password); return next(i + 1); }
      if (io && io.password) return io.password(prompts[i].prompt).then((a) => { answers.push(a || ''); next(i + 1); });
      answers.push(''); next(i + 1);
    };
    next(0);
  };

  return function authHandler(methodsLeft, partialSuccess, cb) {
    const supports = (t) => !methodsLeft || methodsLeft.includes(t);
    const step = () => {
      idx++;
      if (idx >= queue.length) return cb(false);
      const m = queue[idx];
      if (m.type === 'none') { return cb({ type: 'none', username }); }
      if (m.type === 'publickey') {
        if (!supports('publickey')) return step();
        let parsed;
        try { parsed = ssh2.utils.parseKey(m.key.raw, passphrase); } catch (e) { parsed = e; }
        if (Array.isArray(parsed)) parsed = parsed[0];
        if (!parsed || parsed instanceof Error) {
          tried.push(`publickey(${baseName(m.key.file)}: ${(parsed && parsed.message) || 'parse failed'})`);
          return step();
        }
        tried.push(`publickey(${baseName(m.key.file)})`);
        return cb({ type: 'publickey', username, key: parsed });
      }
      if (m.type === 'password') {
        if (!supports('password')) return step();
        if (password != null) { tried.push('password'); return cb({ type: 'password', username, password }); }
        if (io && io.password) {
          return io.password(`${username}@${o.host}'s password: `).then((pw) => {
            if (pw == null || pw === '') { tried.push('password(empty)'); return step(); }
            password = pw; tried.push('password'); cb({ type: 'password', username, password });
          });
        }
        return step();
      }
      if (m.type === 'keyboard-interactive') {
        if (!supports('keyboard-interactive')) return step();
        if (password == null && !(io && io.password)) return step();
        tried.push('keyboard-interactive');
        return cb({ type: 'keyboard-interactive', username, prompt: answerKbd });
      }
      return step();
    };
    step();
  };
}

function decorateError(e, o, tried) {
  const msg = String((e && e.message) || e);
  const who = `${o.user}@${o.host}:${o.port || 22}`;
  const realTried = tried.filter((t) => t !== 'none');
  if (/authentication methods failed/i.test(msg) || /All configured/i.test(msg) || /Authentication failure/i.test(msg)) {
    return new Error(
      `ssh: ${who}: permission denied (authentication failed).\n` +
      `  username: ${o.user}\n` +
      `  methods tried: ${realTried.length ? realTried.join(', ') : '(none — no key found and no password supplied)'}\n` +
      `  how to authenticate:\n` +
      `    password:  sshpass -p 'PASSWORD' ssh ${o.user}@${o.host} ...   (or  SSH_PASSWORD='PASSWORD' ssh ...)\n` +
      `    key:       ssh -i ~/.ssh/id_ed25519 ${o.user}@${o.host} ...    (deploy it once with  ssh-copy-id)\n` +
      `  if the username is wrong, that alone causes this — verify the account exists on ${o.host}.\n`);
  }
  let hint = '';
  if (/ECONNREFUSED/.test(msg)) hint = ' (nothing listening on that port — is sshd running?)';
  else if (/ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/.test(msg)) hint = ' (host unreachable — same Wi-Fi/LAN? correct IP?)';
  else if (/ENOTFOUND|EAI_AGAIN/.test(msg)) hint = ' (cannot resolve hostname)';
  return new Error(`ssh: connect to ${o.host} port ${o.port || 22}: ${msg}${hint}\n`);
}

// ---------------------------------------------------------------- connect ----
// Resolves once the connection is READY. Handles ProxyJump by recursively connecting
// to the jump host, opening a forwarded channel to the target, and using it as `sock`.
// io = { warn(str), password(promptStr)->Promise<string|null> | null }.
function connectClient(o, env, ctx, io) {
  if (!Client) return Promise.reject(new Error('ssh: the ssh2 module is not available in this build.\n'));
  o.port = o.port || 22;
  o.user = o.user || env.USER || env.LOGNAME || 'root';

  const doConnect = (extra, onClose) => new Promise((resolve, reject) => {
    const conn = new Client();
    const tried = [];
    const cfg = Object.assign({
      host: o.realHost || o.host,
      port: o.port,
      username: o.user,
      readyTimeout: (o.connectTimeout ? o.connectTimeout * 1000 : 0) || 25000,
      keepaliveInterval: (o.serverAliveInterval || 0) * 1000,
      tryKeyboard: true,
      hostVerifier: makeHostVerifier(o, env, io),
      authHandler: makeAuthHandler(o, env, ctx, io, tried),
      algorithms: ALGORITHMS,
    }, extra);
    conn.on('ready', () => resolve(conn));
    conn.on('error', (e) => { if (onClose) { try { onClose(); } catch {} } reject(decorateError(e, o, tried)); });
    try { conn.connect(cfg); }
    catch (e) { if (onClose) { try { onClose(); } catch {} } reject(decorateError(e, o, tried)); }
  });

  if (o.proxyJump) {
    const j = parseArgs([o.proxyJump]);
    applyConfig(j, env, ctx);
    j.port = j.port || 22; j.user = j.user || o.user;
    return connectClient(j, env, ctx, io).then((jconn) => new Promise((resolve, reject) => {
      jconn.forwardOut('127.0.0.1', 0, o.realHost || o.host, o.port, (err, stream) => {
        if (err) { try { jconn.end(); } catch {} return reject(new Error(`ssh: ProxyJump via ${j.host}: ${err.message}\n`)); }
        doConnect({ sock: stream }, () => { try { jconn.end(); } catch {} }).then((conn) => {
          // Success path too: tearing down the target must also drop the jump link,
          // else jconn (socket + ssh2 Client + keepalive timer) leaks for the life of
          // the single long-lived node process.
          conn.once('close', () => { try { jconn.end(); } catch {} });
          resolve(conn);
        }, reject);
      });
    }));
  }
  return doConnect({}, null);
}

// ---------------------------------------------------------------- one-shot exec ----
function runRemote(conn, o, ctx) {
  return new Promise((resolve) => {
    const out = []; const err = [];
    let settled = false;
    const finish = (code, extra) => {
      if (settled) return; settled = true;
      try { conn.end(); } catch {}
      resolve({ stdout: out.join(''), stderr: err.join('') + (extra || ''), exitCode: code });
    };
    const watchdog = setTimeout(() => finish(255, 'ssh: session timed out\n'), 600000);
    const done = (code, extra) => { clearTimeout(watchdog); finish(code, extra); };
    const stdin = (ctx && typeof ctx.stdin === 'string') ? ctx.stdin : '';
    const remoteCmd = o.command.join(' ');
    const cb = (e, stream) => {
      if (e) return done(255, `ssh: ${e.message}\n`);
      stream.on('data', (d) => out.push(d.toString('utf8')));
      if (stream.stderr) stream.stderr.on('data', (d) => err.push(d.toString('utf8')));
      let exitCode = 0;
      stream.on('exit', (code) => { if (typeof code === 'number') exitCode = code; });
      stream.on('close', (code) => done(typeof code === 'number' ? code : exitCode));
      if (stdin) stream.end(stdin); else stream.end();
    };
    if (remoteCmd) conn.exec(remoteCmd, o.forceTty ? { pty: true } : {}, cb);
    else conn.shell({ pty: false }, cb);
  });
}

async function sshMain(args, ctx) {
  args = Array.isArray(args) ? args : [];
  if (!Client) return { stdout: '', stderr: 'ssh: the ssh2 module is not available in this build.\n', exitCode: 127 };
  const o = parseArgs(args);
  if (!o.host) {
    return { stdout: '', stderr: 'usage: ssh [-p port] [-i keyfile] [-l user] [-J jump] [-o k=v] [user@]host [command ...]\n', exitCode: 2 };
  }
  const env = envOf(ctx);
  applyConfig(o, env, ctx);
  const errBuf = [];
  const io = { warn: (s) => errBuf.push(s), password: null }; // one-shot: no TTY to prompt on
  let conn;
  try { conn = await connectClient(o, env, ctx, io); }
  catch (e) { return { stdout: '', stderr: errBuf.join('') + String((e && e.message) || e), exitCode: 255 }; }
  const r = await runRemote(conn, o, ctx);
  return { stdout: r.stdout, stderr: errBuf.join('') + r.stderr, exitCode: r.exitCode };
}

function registerSsh(bash, defineCommand) {
  if (typeof defineCommand !== 'function' || !bash || typeof bash.registerCommand !== 'function') return;
  try { bash.registerCommand(defineCommand('ssh', (args, ctx) => sshMain(args, ctx))); } catch { /* skip */ }
}

module.exports = {
  registerSsh, sshMain, parseArgs, connectClient, runRemote, applyConfig,
  envOf, expandUser, ensureSshDir, sshDir, ALGORITHMS,
};
