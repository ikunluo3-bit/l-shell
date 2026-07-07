'use strict';
// `sftp` for L Shell — batch SFTP client over ssh2's SFTP subsystem (pure JS, no WASM).
// Reads a command script from stdin or `-b file` and runs it, the way real sftp does in
// non-interactive mode. Shares connectClient() (config/known_hosts/auth chain).
//
//   sftp [-P port] [-i key] [-b batchfile] [user@]host
//   echo -e "cd /tmp\nput a.txt\nls" | sftp user@host
//
// Commands: ls[dir] cd lcd pwd lpwd get put mkdir rmdir rm rename/mv chmod exit help

const nodeFs = require('node:fs');
const nodePath = require('node:path');

const { envOf, expandUser, parseArgs, applyConfig, connectClient } = require('./ssh-command.js');

const pfy = (fn) => (...a) => new Promise((res, rej) => fn(...a, (e, r) => (e ? rej(e) : res(r))));
function openSftp(conn) { return new Promise((resolve, reject) => conn.sftp((e, s) => (e ? reject(e) : resolve(s)))); }

function fmtEntry(e) {
  const a = e.attrs || {};
  const dir = (a.mode & 0o170000) === 0o040000 ? 'd' : '-';
  const size = a.size != null ? a.size : 0;
  return `${dir} ${String(size).padStart(10)} ${e.filename}`;
}

async function sftpMain(args, ctx) {
  args = Array.isArray(args) ? args : [];
  const env = envOf(ctx);
  let port = null, keyFile = null, batchFile = null, target = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-P') { port = parseInt(args[++i], 10) || null; continue; }
    if (a === '-i') { keyFile = args[++i]; continue; }
    if (a === '-b') { batchFile = args[++i]; continue; }
    if (a === '-o') { i++; continue; }
    if (a === '-F' || a === '-J' || a === '-l' || a === '-c' || a === '-s') { i++; continue; }
    if (a && a.startsWith('-')) { continue; }
    target = a; break;
  }
  if (!target) return { stdout: '', stderr: 'usage: sftp [-P port] [-i key] [-b batchfile] [user@]host\n', exitCode: 1 };

  // Gather the command script.
  let script = '';
  if (batchFile) { try { script = nodeFs.readFileSync(expandUser(batchFile, env, ctx), 'utf8'); } catch { return { stdout: '', stderr: `sftp: cannot read batch file ${batchFile}\n`, exitCode: 1 }; } }
  else if (ctx && typeof ctx.stdin === 'string') script = ctx.stdin;
  const lines = script.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (!lines.length) return { stdout: '', stderr: 'sftp: no commands (pipe a script via stdin or use -b file). Interactive sftp: run `sftp host` in the terminal.\n', exitCode: 1 };

  const o = parseArgs([target]);
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
  catch (e) { try { conn.end(); } catch {} return { stdout: '', stderr: errBuf.join('') + `sftp: cannot open SFTP: ${e.message}\n`, exitCode: 1 }; }

  const out = [errBuf.join('')];
  let rcwd = '.'; let lcwd = (ctx && ctx.cwd) || env.HOME || '/'; let exitCode = 0;
  try { rcwd = await pfy(sftp.realpath.bind(sftp))('.'); } catch {}
  const rpath = (p) => (p && p.startsWith('/') ? p : rcwd.replace(/\/$/, '') + '/' + (p || ''));
  const lpath = (p) => (p ? (nodePath.isAbsolute(p) ? p : nodePath.resolve(lcwd, p.replace(/^~(?=\/|$)/, env.HOME || '~'))) : lcwd);

  for (const line of lines) {
    const parts = line.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const arg1 = parts[1]; const arg2 = parts[2];
    try {
      if (cmd === 'exit' || cmd === 'quit' || cmd === 'bye') break;
      else if (cmd === 'pwd') out.push(`Remote working directory: ${rcwd}\n`);
      else if (cmd === 'lpwd') out.push(`Local working directory: ${lcwd}\n`);
      else if (cmd === 'cd') { const np = await pfy(sftp.realpath.bind(sftp))(rpath(arg1 || '.')); rcwd = np; }
      else if (cmd === 'lcd') { lcwd = lpath(arg1 || env.HOME); }
      else if (cmd === 'ls' || cmd === 'dir') {
        const list = await pfy(sftp.readdir.bind(sftp))(rpath(arg1 && !arg1.startsWith('-') ? arg1 : '.'));
        out.push(list.map(fmtEntry).join('\n') + '\n');
      }
      else if (cmd === 'get') { const r = rpath(arg1); const l = arg2 ? lpath(arg2) : nodePath.resolve(lcwd, nodePath.basename(arg1)); await pfy(sftp.fastGet.bind(sftp))(r, l); out.push(`Fetching ${r} to ${l}\n`); }
      else if (cmd === 'put') { const l = lpath(arg1); const r = arg2 ? rpath(arg2) : rpath(nodePath.basename(arg1)); await pfy(sftp.fastPut.bind(sftp))(l, r); out.push(`Uploading ${l} to ${r}\n`); }
      else if (cmd === 'mkdir') { await pfy(sftp.mkdir.bind(sftp))(rpath(arg1)); }
      else if (cmd === 'rmdir') { await pfy(sftp.rmdir.bind(sftp))(rpath(arg1)); }
      else if (cmd === 'rm') { await pfy(sftp.unlink.bind(sftp))(rpath(arg1)); }
      else if (cmd === 'rename' || cmd === 'mv') { await pfy(sftp.rename.bind(sftp))(rpath(arg1), rpath(arg2)); }
      else if (cmd === 'chmod') { await pfy(sftp.chmod.bind(sftp))(rpath(arg2), parseInt(arg1, 8)); }
      else if (cmd === 'help' || cmd === '?') { out.push('commands: ls cd lcd pwd lpwd get put mkdir rmdir rm rename chmod exit\n'); }
      else { out.push(`sftp: unknown command: ${cmd}\n`); exitCode = 1; }
    } catch (e) { out.push(`sftp: ${cmd}: ${(e && e.message) || e}\n`); exitCode = 1; }
  }
  try { conn.end(); } catch {}
  return { stdout: out.join(''), stderr: '', exitCode };
}

function registerSftp(bash, defineCommand) {
  if (typeof defineCommand !== 'function' || !bash || typeof bash.registerCommand !== 'function') return;
  try { bash.registerCommand(defineCommand('sftp', (args, ctx) => sftpMain(args, ctx))); } catch { /* skip */ }
}

module.exports = { registerSftp, sftpMain };
