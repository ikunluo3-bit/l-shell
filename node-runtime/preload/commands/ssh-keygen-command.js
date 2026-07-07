'use strict';
// `ssh-keygen` for L Shell, backed by ssh2's pure-JS key utilities (generateKeyPairSync
// / parseKey — RSA/ECDSA/ED25519 via node:crypto native OpenSSL, no WASM). Output is
// standard OpenSSH key format, byte-compatible with real ssh-keygen / GitHub / any
// server. Covers the subset that matters on-device:
//
//   ssh-keygen [-t ed25519|rsa|ecdsa] [-b bits] [-f file] [-N passphrase] [-C comment]
//   ssh-keygen -l -f keyfile          print SHA256 fingerprint
//   ssh-keygen -y -f privkey          derive the public key from a private key
//
// Private keys are written 0600, public keys 0644 — matching openssh, so a server won't
// reject them for loose permissions.

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const nodeCrypto = require('node:crypto');

let utils = null;
try { ({ utils } = require('ssh2')); } catch { /* honest error below */ }

const { envOf, expandUser, sshDir, ensureSshDir } = require('./ssh-command.js');

function parseKeyText(text, passphrase) {
  let k;
  try { k = utils.parseKey(text, passphrase || undefined); } catch (e) { return e; }
  if (Array.isArray(k)) k = k[0];
  return k;
}

// SHA256 fingerprint over the SSH wire-format public key — identical to `ssh-keygen -l`.
function keyInfo(key) {
  const pub = key.getPublicSSH();
  const fp = 'SHA256:' + nodeCrypto.createHash('sha256').update(pub).digest('base64').replace(/=+$/, '');
  const bitsByType = { 'ssh-ed25519': 256, 'ecdsa-sha2-nistp256': 256, 'ecdsa-sha2-nistp384': 384, 'ecdsa-sha2-nistp521': 521 };
  let bits = bitsByType[key.type] || 0;
  if (!bits && /rsa/.test(key.type)) { try { bits = nodeCrypto.createPublicKey(key.getPublicPEM()).asymmetricKeyDetails.modulusLength || 0; } catch {} }
  const label = { 'ssh-ed25519': 'ED25519', 'ssh-rsa': 'RSA' }[key.type] || (key.type || '').toUpperCase();
  return { fp, bits, label };
}
function pubLine(key, comment) {
  return `${key.type} ${key.getPublicSSH().toString('base64')}${comment ? ' ' + comment : ''}`;
}

async function sshKeygenMain(args, ctx) {
  args = Array.isArray(args) ? args : [];
  if (!utils) return { stdout: '', stderr: 'ssh-keygen: ssh2 key utilities not available in this build.\n', exitCode: 127 };
  const env = envOf(ctx);
  let type = 'ed25519', file = null, passphrase = '', oldPassphrase = '', comment = null, bits = null, mode = 'generate';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-t') { type = (args[++i] || 'ed25519').toLowerCase(); continue; }
    if (a === '-b') { bits = parseInt(args[++i], 10) || null; continue; }
    if (a === '-f') { file = args[++i]; continue; }
    if (a === '-N') { passphrase = args[++i] || ''; continue; }
    if (a === '-P') { oldPassphrase = args[++i] || ''; continue; }
    if (a === '-C') { comment = args[++i]; continue; }
    if (a === '-l') { mode = 'fingerprint'; continue; }
    if (a === '-y') { mode = 'pubout'; continue; }
    if (a === '-q') { continue; }
    if (a === '-E') { i++; continue; }
    if (a === '-a') { i++; continue; }
    if (a && a.startsWith('-')) { continue; }
  }

  if (mode === 'fingerprint') {
    if (!file) return { stdout: '', stderr: 'ssh-keygen: -l requires -f <keyfile>\n', exitCode: 1 };
    const p = expandUser(file, env, ctx);
    let text; try { text = nodeFs.readFileSync(p, 'utf8'); } catch { return { stdout: '', stderr: `ssh-keygen: ${file}: No such file\n`, exitCode: 1 }; }
    const key = parseKeyText(text.trim(), oldPassphrase);
    if (!key || key instanceof Error) return { stdout: '', stderr: `ssh-keygen: ${file}: ${(key && key.message) || 'not a valid key'}\n`, exitCode: 1 };
    const info = keyInfo(key);
    const cmt = text.trim().split(/\s+/)[2] || (key.comment || 'no comment');
    return { stdout: `${info.bits} ${info.fp} ${cmt} (${info.label})\n`, stderr: '', exitCode: 0 };
  }

  if (mode === 'pubout') {
    if (!file) return { stdout: '', stderr: 'ssh-keygen: -y requires -f <privatekey>\n', exitCode: 1 };
    const p = expandUser(file, env, ctx);
    let text; try { text = nodeFs.readFileSync(p, 'utf8'); } catch { return { stdout: '', stderr: `ssh-keygen: ${file}: No such file\n`, exitCode: 1 }; }
    const key = parseKeyText(text, oldPassphrase);
    if (!key || key instanceof Error) return { stdout: '', stderr: `ssh-keygen: ${file}: ${(key && key.message) || 'cannot parse (wrong passphrase?)'}\n`, exitCode: 1 };
    return { stdout: pubLine(key, key.comment) + '\n', stderr: '', exitCode: 0 };
  }

  // generate
  if (!file) file = nodePath.join(sshDir(env), type === 'rsa' ? 'id_rsa' : type === 'ecdsa' ? 'id_ecdsa' : 'id_ed25519');
  file = expandUser(file, env, ctx);
  if (comment == null) comment = `${env.USER || env.LOGNAME || 'mobile'}@lshell`;
  const opts = { comment };
  if (passphrase) { opts.passphrase = passphrase; opts.cipher = 'aes256-ctr'; }
  if (type === 'rsa') opts.bits = bits || 3072;
  if (type === 'ecdsa') opts.bits = bits || 256;
  if (!['rsa', 'ecdsa', 'ed25519'].includes(type)) {
    return { stdout: '', stderr: `ssh-keygen: unknown key type '${type}' (use ed25519, rsa, or ecdsa)\n`, exitCode: 1 };
  }
  let pair;
  try { pair = utils.generateKeyPairSync(type, opts); }
  catch (e) { return { stdout: '', stderr: `ssh-keygen: key generation failed: ${(e && e.message) || e}\n`, exitCode: 1 }; }

  try {
    ensureSshDir(env);
    nodeFs.mkdirSync(nodePath.dirname(file), { recursive: true });
    if (nodeFs.existsSync(file)) return { stdout: '', stderr: `ssh-keygen: ${file} already exists (remove it first, or use -f to pick another path)\n`, exitCode: 1 };
    nodeFs.writeFileSync(file, pair.private.endsWith('\n') ? pair.private : pair.private + '\n', { mode: 0o600 });
    nodeFs.writeFileSync(file + '.pub', pair.public.trim() + '\n', { mode: 0o644 });
  } catch (e) { return { stdout: '', stderr: `ssh-keygen: cannot write key: ${(e && e.message) || e}\n`, exitCode: 1 }; }

  const key = parseKeyText(pair.public.trim());
  const info = (key && !(key instanceof Error)) ? keyInfo(key) : { bits: 0, fp: '?', label: type.toUpperCase() };
  return {
    stdout:
      `Generating public/private ${type} key pair.\n` +
      `Your identification has been saved in ${file}\n` +
      `Your public key has been saved in ${file}.pub\n` +
      `The key fingerprint is:\n${info.fp} ${comment}\n`,
    stderr: '', exitCode: 0,
  };
}

function registerSshKeygen(bash, defineCommand) {
  if (typeof defineCommand !== 'function' || !bash || typeof bash.registerCommand !== 'function') return;
  try { bash.registerCommand(defineCommand('ssh-keygen', (args, ctx) => sshKeygenMain(args, ctx))); } catch { /* skip */ }
}

module.exports = { registerSshKeygen, sshKeygenMain };
