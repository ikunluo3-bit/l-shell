'use strict';
// `scp` for L Shell — file copy over SSH, backed by ssh2's SFTP subsystem
// (fastGet/fastPut; pure JS, no WASM). Handles local↔remote in either direction plus
// recursive directory trees. Shares connectClient() so it honors ~/.ssh/config,
// known_hosts, and the same auth chain (password via sshpass/SSH_PASSWORD, or -i key).
//
//   scp [-P port] [-i key] [-r] SRC... DEST
//   a remote path is  [user@]host:path ; everything else is local.

const nodeFs = require('node:fs');
const nodePath = require('node:path');

const { envOf, expandUser, parseArgs, applyConfig, connectClient } = require('./ssh-command.js');

const isRemote = (s) => { const c = s.indexOf(':'); return c > 0 && !/[/\\]/.test(s.slice(0, c)); };
function splitRemote(spec) { const c = spec.indexOf(':'); return { host: spec.slice(0, c), path: spec.slice(c + 1) || '.' }; }

function openSftp(conn) {
  return new Promise((resolve, reject) => conn.sftp((e, sftp) => (e ? reject(e) : resolve(sftp))));
}
const pfy = (fn) => (...a) => new Promise((res, rej) => fn(...a, (e, r) => (e ? rej(e) : res(r))));

async function putPath(sftp, local, remote) {
  const st = nodeFs.statSync(local);
  if (st.isDirectory()) {
    try { await pfy(sftp.mkdir.bind(sftp))(remote); } catch { /* exists */ }
    for (const name of nodeFs.readdirSync(local)) await putPath(sftp, nodePath.join(local, name), remote + '/' + name);
  } else {
    await pfy(sftp.fastPut.bind(sftp))(local, remote);
  }
}
async function getPath(sftp, remote, local) {
  const st = await pfy(sftp.stat.bind(sftp))(remote);
  if (st.isDirectory && st.isDirectory()) {
    nodeFs.mkdirSync(local, { recursive: true });
    const list = await pfy(sftp.readdir.bind(sftp))(remote);
    for (const it of list) await getPath(sftp, remote + '/' + it.filename, nodePath.join(local, it.filename));
  } else {
    await pfy(sftp.fastGet.bind(sftp))(remote, local);
  }
}

async function remoteIsDir(sftp, p) {
  try { const st = await pfy(sftp.stat.bind(sftp))(p); return !!(st.isDirectory && st.isDirectory()); } catch { return false; }
}

async function scpMain(args, ctx) {
  args = Array.isArray(args) ? args : [];
  const env = envOf(ctx);
  let port = null, keyFile = null, recursive = false;
  const paths = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-P') { port = parseInt(args[++i], 10) || null; continue; }
    if (a === '-i') { keyFile = args[++i]; continue; }
    if (a === '-r') { recursive = true; continue; }
    if (a === '-o') { i++; continue; }
    if (a === '-l' || a === '-c' || a === '-F' || a === '-J' || a === '-S') { i++; continue; }
    if (a === '-p' || a === '-q' || a === '-C' || a === '-v' || a === '-B' || a === '-4' || a === '-6' || a === '-A') { continue; }
    if (a && a.startsWith('-')) { continue; }
    paths.push(a);
  }
  if (paths.length < 2) return { stdout: '', stderr: 'usage: scp [-P port] [-i key] [-r] SRC... [user@]host:DEST  (or remote→local)\n', exitCode: 1 };

  const dest = paths.pop();
  const srcs = paths;
  const destRemote = isRemote(dest);
  const anySrcRemote = srcs.some(isRemote);
  if (destRemote && anySrcRemote) return { stdout: '', stderr: 'scp: remote→remote copy is not supported here\n', exitCode: 1 };
  if (!destRemote && !anySrcRemote) return { stdout: '', stderr: 'scp: at least one side must be remote ([user@]host:path)\n', exitCode: 1 };

  // Build the remote endpoint spec from whichever side is remote.
  const remoteSpec = destRemote ? splitRemote(dest) : splitRemote(srcs.find(isRemote));
  const o = parseArgs([remoteSpec.host]);
  if (port) o.port = port;
  if (keyFile) o.keyFile = keyFile;
  applyConfig(o, env, ctx); // honor ~/.ssh/config host aliases, like ssh does

  const errBuf = [];
  const io = { warn: (s) => errBuf.push(s), password: null };
  let conn;
  try { conn = await connectClient(o, env, ctx, io); }
  catch (e) { return { stdout: '', stderr: errBuf.join('') + String((e && e.message) || e), exitCode: 255 }; }

  let sftp;
  try { sftp = await openSftp(conn); }
  catch (e) { try { conn.end(); } catch {} return { stdout: '', stderr: errBuf.join('') + `scp: cannot open SFTP: ${e.message}\n`, exitCode: 1 }; }

  const done = []; let failed = null;
  try {
    if (destRemote) {
      // local → remote
      let remoteBase = remoteSpec.path;
      const destIsDir = srcs.length > 1 || remoteBase.endsWith('/') || await remoteIsDir(sftp, remoteBase);
      for (const src of srcs) {
        const local = expandUser(src, env, ctx);
        if (!nodeFs.existsSync(local)) { failed = `scp: ${src}: No such file or directory`; break; }
        if (nodeFs.statSync(local).isDirectory() && !recursive) { failed = `scp: ${src}: is a directory (use -r)`; break; }
        const target = destIsDir ? (remoteBase.replace(/\/$/, '') + '/' + nodePath.basename(local)) : remoteBase;
        await putPath(sftp, local, target);
        done.push(`${src} -> ${o.host}:${target}`);
      }
    } else {
      // remote → local
      const localDest = expandUser(dest, env, ctx);
      const destIsDir = srcs.length > 1 || (nodeFs.existsSync(localDest) && nodeFs.statSync(localDest).isDirectory()) || dest.endsWith('/');
      for (const src of srcs) {
        if (!isRemote(src)) { failed = `scp: ${src}: local→local not supported`; break; }
        const r = splitRemote(src);
        const isDir = await remoteIsDir(sftp, r.path);
        if (isDir && !recursive) { failed = `scp: ${src}: is a directory (use -r)`; break; }
        const target = destIsDir ? nodePath.join(localDest, nodePath.basename(r.path)) : localDest;
        if (destIsDir) nodeFs.mkdirSync(localDest, { recursive: true });
        await getPath(sftp, r.path, target);
        done.push(`${o.host}:${r.path} -> ${target}`);
      }
    }
  } catch (e) { failed = `scp: ${(e && e.message) || e}`; }
  try { conn.end(); } catch {}

  if (failed) return { stdout: '', stderr: errBuf.join('') + failed + '\n', exitCode: 1 };
  return { stdout: errBuf.join('') + (done.length ? done.join('\n') + '\n' : ''), stderr: '', exitCode: 0 };
}

function registerScp(bash, defineCommand) {
  if (typeof defineCommand !== 'function' || !bash || typeof bash.registerCommand !== 'function') return;
  try { bash.registerCommand(defineCommand('scp', (args, ctx) => scpMain(args, ctx))); } catch { /* skip */ }
}

module.exports = { registerScp, scpMain };
