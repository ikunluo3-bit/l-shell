'use strict';
// `sshpass` for L Shell — the STANDARD non-interactive password front-end. Claude and
// scripts reach for `sshpass -p PASS ssh user@host cmd` by reflex; without it, password
// SSH is a dead end on a TTY-less tool (real openssh reads the password from /dev/tty,
// which we don't have here). This wraps our in-process ssh/scp/sftp/ssh-copy-id: it
// extracts the password and re-dispatches with SSH_PASSWORD set, so the standard
// invocation "just works" and no bespoke env-var convention needs to be known.
//
//   sshpass [-p PASSWORD | -e | -f FILE | -P PROMPT] ssh|scp|sftp|ssh-copy-id [args...]

const nodeFs = require('node:fs');

function dispatch(name, args, ctx) {
  if (name === 'ssh') return require('./ssh-command.js').sshMain(args, ctx);
  if (name === 'scp') return require('./scp-command.js').scpMain(args, ctx);
  if (name === 'sftp') return require('./sftp-command.js').sftpMain(args, ctx);
  if (name === 'ssh-copy-id') return require('./ssh-copy-id-command.js').sshCopyIdMain(args, ctx);
  return Promise.resolve({ stdout: '', stderr: `sshpass: can only wrap ssh/scp/sftp/ssh-copy-id (got '${name}')\n`, exitCode: 1 });
}

async function sshpassMain(args, ctx) {
  args = Array.isArray(args) ? args : [];
  const ssh = require('./ssh-command.js');
  const env = ssh.envOf(ctx);
  let password = null;
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '-p') { password = args[++i]; continue; }
    if (a.startsWith('-p') && a.length > 2) { password = a.slice(2); continue; } // -pPASS glued form
    if (a === '-e') { password = env.SSHPASS || ''; continue; }
    if (a === '-f') {
      const f = args[++i];
      try { password = nodeFs.readFileSync(ssh.expandUser(f, env, ctx), 'utf8').split(/\r?\n/)[0]; }
      catch { return { stdout: '', stderr: `sshpass: cannot read password file ${f}\n`, exitCode: 1 }; }
      continue;
    }
    if (a === '-P') { i++; continue; }   // prompt string — irrelevant, we inject directly
    if (a === '-d') { i++; continue; }   // fd form — unsupported, skip its value
    if (a === '-v' || a === '-h') { continue; }
    if (a && a.startsWith('-')) { continue; }
    break; // first bare word = the wrapped command
  }
  const rest = args.slice(i);
  if (!rest.length) {
    return { stdout: '', stderr: 'usage: sshpass -p PASSWORD ssh [user@]host [command ...]\n', exitCode: 1 };
  }
  const name = String(rest[0]).replace(/\\/g, '/').split('/').pop();
  const cmdArgs = rest.slice(1);
  const injected = Object.assign({}, env, {
    SSH_PASSWORD: password == null ? '' : password,
    SSHPASS: password == null ? '' : password,
  });
  const newCtx = Object.assign({}, ctx, { env: injected });
  return dispatch(name, cmdArgs, newCtx);
}

function registerSshpass(bash, defineCommand) {
  if (typeof defineCommand !== 'function' || !bash || typeof bash.registerCommand !== 'function') return;
  try { bash.registerCommand(defineCommand('sshpass', (args, ctx) => sshpassMain(args, ctx))); } catch { /* skip */ }
}

module.exports = { registerSshpass, sshpassMain };
