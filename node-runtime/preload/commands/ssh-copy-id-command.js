'use strict';
// `ssh-copy-id` for L Shell — installs a local public key into the remote account's
// ~/.ssh/authorized_keys so subsequent logins are key-based (passwordless). The first
// run authenticates by password (via sshpass/SSH_PASSWORD), then never again.
//
//   ssh-copy-id [-i pubkeyfile] [-p port] [user@]host
//
// Uses the shared connectClient() so it honors ~/.ssh/config, known_hosts, and the
// same auth chain as ssh. The remote install is idempotent (won't duplicate the key)
// and fixes ~/.ssh perms, matching the real ssh-copy-id.

const nodeFs = require('node:fs');
const nodePath = require('node:path');

const { envOf, expandUser, sshDir, parseArgs, applyConfig, connectClient } = require('./ssh-command.js');

function findPubKey(pubFile, env, ctx) {
  if (pubFile) {
    let p = expandUser(pubFile, env, ctx);
    if (!p.endsWith('.pub') && nodeFs.existsSync(p + '.pub')) p += '.pub';
    return nodeFs.existsSync(p) ? p : null;
  }
  for (const n of ['id_ed25519.pub', 'id_ecdsa.pub', 'id_rsa.pub']) {
    const p = nodePath.join(sshDir(env), n);
    if (nodeFs.existsSync(p)) return p;
  }
  return null;
}

function execRemote(conn, cmd) {
  return new Promise((resolve) => {
    conn.exec(cmd, (e, stream) => {
      if (e) return resolve({ code: 255, out: '', err: e.message });
      const out = []; const err = [];
      stream.on('data', (d) => out.push(d.toString('utf8')));
      if (stream.stderr) stream.stderr.on('data', (d) => err.push(d.toString('utf8')));
      stream.on('close', (code) => resolve({ code: typeof code === 'number' ? code : 0, out: out.join(''), err: err.join('') }));
    });
  });
}

async function sshCopyIdMain(args, ctx) {
  args = Array.isArray(args) ? args : [];
  const env = envOf(ctx);
  let pubFile = null, port = null, target = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-i') { pubFile = args[++i]; continue; }
    if (a === '-p') { port = parseInt(args[++i], 10) || null; continue; }
    if (a === '-o') { i++; continue; }
    if (a === '-f' || a === '-n') { continue; }
    if (a && a.startsWith('-')) { continue; }
    target = a; break;
  }
  if (!target) return { stdout: '', stderr: 'usage: ssh-copy-id [-i pubkey] [-p port] [user@]host\n', exitCode: 1 };

  const pkPath = findPubKey(pubFile, env, ctx);
  if (!pkPath) return { stdout: '', stderr: 'ssh-copy-id: no public key found. Generate one first:  ssh-keygen -t ed25519\n', exitCode: 1 };
  const pub = nodeFs.readFileSync(pkPath, 'utf8').trim();
  if (!/^(ssh-|ecdsa-)/.test(pub)) return { stdout: '', stderr: `ssh-copy-id: ${pkPath} does not look like a public key\n`, exitCode: 1 };

  const o = parseArgs([target]);
  if (port) o.port = port;
  applyConfig(o, env, ctx); // honor ~/.ssh/config host aliases, like ssh does
  const errBuf = [];
  const io = { warn: (s) => errBuf.push(s), password: null };
  let conn;
  try { conn = await connectClient(o, env, ctx, io); }
  catch (e) { return { stdout: '', stderr: errBuf.join('') + String((e && e.message) || e), exitCode: 255 }; }

  // Single-quote the key for the remote shell; a pubkey never contains a single quote.
  const q = pub.replace(/'/g, `'\\''`);
  const script =
    `umask 077 && mkdir -p ~/.ssh && ` +
    `touch ~/.ssh/authorized_keys && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys && ` +
    `if grep -qxF '${q}' ~/.ssh/authorized_keys; then echo LSHELL_COPYID_DUP; else echo '${q}' >> ~/.ssh/authorized_keys && echo LSHELL_COPYID_OK; fi`;
  const r = await execRemote(conn, script);
  try { conn.end(); } catch {}

  if (r.code !== 0 && !/LSHELL_COPYID/.test(r.out)) {
    return { stdout: '', stderr: errBuf.join('') + `ssh-copy-id: remote install failed: ${r.err || r.out || 'exit ' + r.code}\n`, exitCode: r.code || 1 };
  }
  const already = /LSHELL_COPYID_DUP/.test(r.out);
  return {
    stdout: errBuf.join('') +
      (already
        ? `ssh-copy-id: key already present in ${o.user}@${o.host}:~/.ssh/authorized_keys (nothing to do)\n`
        : `Number of key(s) added: 1\n\nNow try logging into the machine, with:   ssh ${o.user ? o.user + '@' : ''}${o.host}\nand check to make sure only the key(s) you wanted were added.\n`),
    stderr: '', exitCode: 0,
  };
}

function registerSshCopyId(bash, defineCommand) {
  if (typeof defineCommand !== 'function' || !bash || typeof bash.registerCommand !== 'function') return;
  try { bash.registerCommand(defineCommand('ssh-copy-id', (args, ctx) => sshCopyIdMain(args, ctx))); } catch { /* skip */ }
}

module.exports = { registerSshCopyId, sshCopyIdMain };
