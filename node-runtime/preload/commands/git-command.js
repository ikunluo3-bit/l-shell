'use strict';
// `git` for L Shell, backed by isomorphic-git (pure JS, zero WASM — SHA falls
// back to sha.js, inflate/deflate via pako, all interpreter-safe under jitless).
// Registered as a just-bash builtin: bash.registerCommand(defineCommand('git', ...)).
//
// We operate on the REAL node fs rooted at ctx.cwd (the workspace is a real
// container directory), NOT just-bash's virtual fs — so the .git dir and working
// tree are real files the rest of the shell (ls/cat via PassthroughFs pass-through)
// sees consistently, and we avoid isomorphic-git's fs-interface requirements on
// PassthroughFs. Network subcommands (clone/fetch/pull/push) use http/node, which
// rides node:https (already the transport the runtime relies on).

const git = require('isomorphic-git');
const httpNode = require('isomorphic-git/http/node');
const nodeFs = require('node:fs');
const path = require('node:path');
const { resolveTarget, mapTmpAbs } = require('./tmp-map.js');

let diffLib = null;
try { diffLib = require('diff'); } catch { /* diff optional; `git diff` degrades */ }

// Redirect classic temp roots onto the container-writable dir. git-command uses
// RAW node fs (isomorphic-git operates on real files), so unlike PassthroughFs it
// must apply the /tmp → container map itself, or `cd /tmp && git clone` hits
// `ENOENT: mkdir '/tmp/.../.git'` on iOS. Shares tmp-map.js so the prefix set and
// the double-map safety guard match PassthroughFs exactly.
function mapTmp(p) {
  if (!p) return p;
  const target = resolveTarget();
  if (!target) return p;
  const abs = path.isAbsolute(p) ? path.normalize(p) : p;
  return path.isAbsolute(abs) ? mapTmpAbs(abs, target) : p;
}

function abbrev(oid) { return String(oid).slice(0, 7); }
// isomorphic-git exposes its real version via git.version(); require('.../package.json')
// used to be swallowed by bundler resolution and reported "1.x" — call the API instead.
const ISO_VERSION = (() => {
  try { return git.version(); } catch {}
  try { return require('isomorphic-git/package.json').version; } catch {}
  return 'unknown';
})();
const GIT_VERSION = `git version 2.43.0 (L Shell / isomorphic-git ${ISO_VERSION})`;

async function findGitRoot(fs, dir) {
  try { return await git.findRoot({ fs, filepath: dir }); } catch { return null; }
}

async function identity(fs, dir) {
  const name = (await git.getConfig({ fs, dir, path: 'user.name' }).catch(() => null)) || 'L Shell';
  const email = (await git.getConfig({ fs, dir, path: 'user.email' }).catch(() => null)) || 'user@lshell.local';
  return { name, email };
}

// ── auth plumbing for fetch/pull/push ───────────────────────────────────────
// Token resolution order (first hit wins):
//   1. an embedded credential in the remote URL  (https://<token>@host/…  or
//      https://<user>:<token>@host/…)  — isomorphic-git strips & uses it itself,
//      but we ALSO surface it to onAuth so a `x-access-token` username is filled.
//   2. `-c http.extraHeader=...` / `-c <k>=<v>` bearer passed on the CLI (git -c …)
//   3. env: GIT_TOKEN / GITHUB_TOKEN / GH_TOKEN  (username defaults to
//      x-access-token, which GitHub accepts for PATs)
//   4. env: GIT_USERNAME + GIT_PASSWORD  (generic basic-auth pair)
// Returns an onAuth(url) callback for isomorphic-git, or undefined (anonymous).
function makeOnAuth(env, cliTokens) {
  const e = env || {};
  const token =
    (cliTokens && cliTokens.token) ||
    e.GIT_TOKEN || e.GITHUB_TOKEN || e.GH_TOKEN || null;
  const username = (cliTokens && cliTokens.username) || e.GIT_USERNAME || null;
  const password = (cliTokens && cliTokens.password) || e.GIT_PASSWORD || null;
  if (!token && !(username && password)) return undefined;
  return () => {
    if (username && password) return { username, password };
    // PAT: GitHub/GitLab accept the token as the password with any username;
    // x-access-token is the canonical username for GitHub fine-grained/OAuth tokens.
    return { username: username || 'x-access-token', password: token };
  };
}

// Parse a URL that embeds a credential (https://tok@h / https://u:tok@h) into
// { url (cleaned), username, token } so onAuth can reuse it. isomorphic-git also
// understands the embedded form, but pulling it out lets us fill a proper username.
function splitUrlCredential(url) {
  const m = /^(https?:\/\/)([^/@]+)@(.*)$/.exec(url || '');
  if (!m) return { url, username: null, token: null };
  const cred = m[2];
  const ci = cred.indexOf(':');
  const username = ci >= 0 ? decodeURIComponent(cred.slice(0, ci)) : null;
  const token = decodeURIComponent(ci >= 0 ? cred.slice(ci + 1) : cred);
  return { url: m[1] + m[3], username, token };
}

// Parse `git -c k=v` tokens (collected before the subcommand) into a credential.
// Recognizes: `credential.token`/`user.token`=<t>, `credential.username`,
// `credential.password`, and `http.extraHeader=Authorization: Bearer|token <t>`.
// Returns { token, username, password } or null.
function parseCliTokens(cliCfgs) {
  let token = null, username = null, password = null;
  for (const kv of cliCfgs || []) {
    const eq = kv.indexOf('=');
    if (eq < 0) continue;
    const k = kv.slice(0, eq).toLowerCase();
    const v = kv.slice(eq + 1);
    if (k === 'http.extraheader' || k === 'authorization') {
      const m = /bearer\s+(.+)/i.exec(v) || /token\s+(.+)/i.exec(v);
      if (m) token = m[1].trim();
    } else if (k === 'credential.token' || k === 'user.token') {
      token = v.trim();
    } else if (k === 'credential.username') {
      username = v.trim();
    } else if (k === 'credential.password') {
      password = v.trim();
    }
  }
  return (token || username || password) ? { token, username, password } : null;
}

// Merge a URL-embedded credential with CLI -c tokens into one cliTokens object for
// makeOnAuth (CLI wins over URL). Returns { url (credential stripped), tokens|null }.
function resolveAuth(rawUrl, cliTokens) {
  const cred = splitUrlCredential(rawUrl);
  let tokens = cliTokens || null;
  if (!tokens && cred.token) tokens = { token: cred.token, username: cred.username };
  return { url: cred.url, tokens };
}

// Resolve a remote's URL by name (default 'origin'); pass-through if a URL is given.
async function resolveRemoteUrl(fs, dir, remoteOrUrl) {
  if (remoteOrUrl && /^https?:|^git:|^ssh:/.test(remoteOrUrl)) return remoteOrUrl;
  const name = remoteOrUrl || 'origin';
  const remotes = await git.listRemotes({ fs, dir }).catch(() => []);
  const hit = remotes.find((r) => r.remote === name);
  return hit ? hit.url : null;
}

// Flatten a commit's full tree into { filepath -> { oid, mode } } (recurses subtrees).
async function flattenCommitTree(fs, dir, oid) {
  const { commit } = await git.readCommit({ fs, dir, oid });
  const out = {};
  async function walkTree(treeOid, prefix) {
    const { tree } = await git.readTree({ fs, dir, oid: treeOid });
    for (const ent of tree) {
      const fp = prefix ? prefix + '/' + ent.path : ent.path;
      if (ent.type === 'tree') await walkTree(ent.oid, fp);
      else out[fp] = { oid: ent.oid, mode: ent.mode };
    }
  }
  await walkTree(commit.tree, '');
  return out;
}

const handlers = {
  async init(fs, dir, args) {
    const target = args.find((a) => !a.startsWith('-'));
    const d = mapTmp(target ? path.resolve(dir, target) : dir);
    await git.init({ fs, dir: d, defaultBranch: 'main' });
    return { stdout: `Initialized empty Git repository in ${path.join(d, '.git')}/\n`, code: 0 };
  },

  async config(fs, dir, args) {
    const flags = args.filter((a) => a.startsWith('-'));
    const rest = args.filter((a) => !a.startsWith('-'));
    const key = rest[0];
    if (!key) return { stdout: '', code: 0 };
    if (rest.length >= 2) { // set
      await git.setConfig({ fs, dir, path: key, value: rest.slice(1).join(' ') });
      return { stdout: '', code: 0 };
    }
    const v = await git.getConfig({ fs, dir, path: key }).catch(() => undefined);
    if (v == null) return { stdout: '', code: flags.includes('--get') ? 1 : 1 };
    return { stdout: v + '\n', code: 0 };
  },

  async add(fs, dir, args) {
    const files = args.filter((a) => !a.startsWith('-'));
    if (files.includes('.') || args.includes('-A') || args.includes('--all')) {
      const st = await git.statusMatrix({ fs, dir });
      for (const [fp, , w] of st) {
        if (w === 0) await git.remove({ fs, dir, filepath: fp });
        else await git.add({ fs, dir, filepath: fp });
      }
    } else {
      for (const f of files) await git.add({ fs, dir, filepath: f });
    }
    return { stdout: '', code: 0 };
  },

  async rm(fs, dir, args) {
    // `git rm --cached <f>` removes from the index only (keeps the worktree file);
    // plain `git rm` also deletes the worktree file.
    const cached = args.includes('--cached');
    for (const f of args.filter((a) => !a.startsWith('-'))) {
      await git.remove({ fs, dir, filepath: f });
      if (!cached) { try { nodeFs.unlinkSync(path.join(dir, f)); } catch {} }
    }
    return { stdout: '', code: 0 };
  },

  async commit(fs, dir, args) {
    const mi = args.indexOf('-m');
    const message = mi >= 0 ? args[mi + 1] : (args.includes('--amend') ? 'amend' : 'no message');
    const author = await identity(fs, dir);
    const oid = await git.commit({ fs, dir, message, author });
    const branch = (await git.currentBranch({ fs, dir })) || 'HEAD';
    return { stdout: `[${branch} ${abbrev(oid)}] ${message.split('\n')[0]}\n`, code: 0 };
  },

  async status(fs, dir, args) {
    const short = args.includes('-s') || args.includes('--short') || args.includes('--porcelain');
    const branch = (await git.currentBranch({ fs, dir })) || 'HEAD';
    const matrix = await git.statusMatrix({ fs, dir });
    if (short) {
      let out = '';
      for (const [fp, h, w, s] of matrix) {
        if (h === 0 && w === 2 && s === 0) out += `?? ${fp}\n`;
        else if (h === 0 && s === 2) out += `A  ${fp}\n`;
        else if (h === 1 && w === 2 && s === 2) out += `M  ${fp}\n`;
        else if (h === 1 && w === 2 && s === 1) out += ` M ${fp}\n`;
        else if (h === 1 && w === 0) out += `D  ${fp}\n`;
      }
      return { stdout: out, code: 0 };
    }
    const staged = [], notStaged = [], untracked = [];
    for (const [fp, h, w, s] of matrix) {
      if (h === 0 && w === 2 && s === 0) untracked.push(fp);
      else if (h === 0 && w === 2 && s === 2) staged.push(`\tnew file:   ${fp}`);
      else if (h === 1 && w === 2 && s === 2) staged.push(`\tmodified:   ${fp}`);
      else if (h === 1 && w === 2 && s === 1) notStaged.push(`\tmodified:   ${fp}`);
      else if (h === 1 && w === 0 && s === 0) staged.push(`\tdeleted:    ${fp}`);
      else if (h === 1 && w === 0 && s === 1) notStaged.push(`\tdeleted:    ${fp}`);
    }
    let out = `On branch ${branch}\n`;
    if (staged.length) out += `Changes to be committed:\n` + staged.join('\n') + '\n';
    if (notStaged.length) out += `Changes not staged for commit:\n` + notStaged.join('\n') + '\n';
    if (untracked.length) out += `Untracked files:\n` + untracked.map((f) => '\t' + f).join('\n') + '\n';
    if (!staged.length && !notStaged.length && !untracked.length) out += 'nothing to commit, working tree clean\n';
    return { stdout: out, code: 0 };
  },

  async log(fs, dir, args) {
    const oneline = args.includes('--oneline');
    let depth;
    const n = args.find((a) => /^-\d+$/.test(a));
    if (n) depth = parseInt(n.slice(1), 10);
    const ni = args.indexOf('-n');
    if (ni >= 0 && args[ni + 1]) depth = parseInt(args[ni + 1], 10);
    const commits = await git.log({ fs, dir, depth });
    let out = '';
    for (const { oid, commit } of commits) {
      if (oneline) out += `${abbrev(oid)} ${commit.message.split('\n')[0]}\n`;
      else {
        const d = new Date(commit.author.timestamp * 1000).toUTCString();
        out += `commit ${oid}\nAuthor: ${commit.author.name} <${commit.author.email}>\nDate:   ${d}\n\n    ${commit.message.trim()}\n\n`;
      }
    }
    return { stdout: out, code: 0 };
  },

  async branch(fs, dir, args) {
    const del = args.includes('-d') || args.includes('-D');
    const nonFlag = args.filter((a) => !a.startsWith('-'));
    if (del && nonFlag.length) { await git.deleteBranch({ fs, dir, ref: nonFlag[0] }); return { stdout: '', code: 0 }; }
    if (nonFlag.length) { await git.branch({ fs, dir, ref: nonFlag[0] }); return { stdout: '', code: 0 }; }
    const branches = await git.listBranches({ fs, dir });
    const cur = await git.currentBranch({ fs, dir });
    return { stdout: branches.map((b) => (b === cur ? '* ' : '  ') + b).join('\n') + (branches.length ? '\n' : ''), code: 0 };
  },

  async checkout(fs, dir, args) {
    const create = args.includes('-b') || args.includes('-B');
    const ref = args.filter((a) => !a.startsWith('-')).pop();
    if (create) await git.branch({ fs, dir, ref }).catch(() => {});
    await git.checkout({ fs, dir, ref });
    return { stdout: `Switched to ${create ? 'a new ' : ''}branch '${ref}'\n`, code: 0 };
  },

  async diff(fs, dir, args) {
    if (!diffLib) return { stdout: '', stderr: 'git diff unavailable (diff lib missing)\n', code: 0 };
    const matrix = await git.statusMatrix({ fs, dir });
    let out = '';
    for (const [fp, h, w] of matrix) {
      if (h === 1 && w === 2) {
        let headContent = '';
        try {
          const head = await git.resolveRef({ fs, dir, ref: 'HEAD' });
          const b = await git.readBlob({ fs, dir, oid: head, filepath: fp });
          headContent = Buffer.from(b.blob).toString();
        } catch {}
        let wt = '';
        try { wt = nodeFs.readFileSync(path.join(dir, fp), 'utf8'); } catch {}
        const p = diffLib.createTwoFilesPatch(`a/${fp}`, `b/${fp}`, headContent, wt);
        out += `diff --git a/${fp} b/${fp}\n` + p.split('\n').slice(1).join('\n');
      }
    }
    return { stdout: out, code: 0 };
  },

  async 'rev-parse'(fs, dir, args) {
    if (args.includes('--show-toplevel')) return { stdout: dir + '\n', code: 0 };
    if (args.includes('--is-inside-work-tree')) return { stdout: 'true\n', code: 0 };
    if (args.includes('--abbrev-ref') && args.includes('HEAD')) {
      const b = (await git.currentBranch({ fs, dir })) || 'HEAD';
      return { stdout: b + '\n', code: 0 };
    }
    if (args.includes('HEAD') || args[0] === 'HEAD') {
      const oid = await git.resolveRef({ fs, dir, ref: 'HEAD' }).catch(() => null);
      return oid ? { stdout: oid + '\n', code: 0 } : { stdout: '', stderr: 'fatal: bad revision\n', code: 128 };
    }
    return { stdout: dir + '\n', code: 0 };
  },

  async clone(fs, dir, args, env, cliTokens, signal) {
    // Separate positionals from flags; --depth/--branch take a value.
    let depth = 1, ref;
    const positional = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--depth') { depth = parseInt(args[++i], 10) || 1; }
      else if (a === '--branch' || a === '-b') { ref = args[++i]; }
      else if (a.startsWith('-')) { /* ignore other flags */ }
      else positional.push(a);
    }
    let url = positional.find((a) => /^https?:|^git:|^ssh:/.test(a)) || positional[0];
    if (!url) return { stdout: '', stderr: 'fatal: You must specify a repository to clone.\n', code: 128 };
    const target = positional.filter((a) => a !== url)[0] || url.split('/').pop().replace(/\.git$/, '');
    const dest = mapTmp(path.resolve(dir, target));
    // credential from URL / -c / env so private clones authenticate
    const { url: cleanUrl, tokens } = resolveAuth(url, cliTokens);
    url = cleanUrl;
    const onAuth = makeOnAuth(env, tokens);
    process.stderr.write(`Cloning into '${target}'...\n`);
    await git.clone({ fs, http: httpNode, dir: dest, url, ref, singleBranch: true, depth, onAuth, signal });
    return { stdout: '', code: 0 };
  },

  // ── remote (add / remove|rm / -v / get-url / set-url / list) ─────────────────
  async remote(fs, dir, args) {
    const verbose = args.includes('-v') || args.includes('--verbose');
    const sub = args.find((a) => !a.startsWith('-'));
    const positional = args.filter((a) => !a.startsWith('-'));
    if (sub === 'add') {
      const name = positional[1], url = positional[2];
      if (!name || !url) return { stderr: 'usage: git remote add <name> <url>\n', code: 129 };
      await git.addRemote({ fs, dir, remote: name, url, force: true });
      return { stdout: '', code: 0 };
    }
    if (sub === 'remove' || sub === 'rm') {
      const name = positional[1];
      if (!name) return { stderr: 'usage: git remote remove <name>\n', code: 129 };
      await git.deleteRemote({ fs, dir, remote: name });
      return { stdout: '', code: 0 };
    }
    if (sub === 'get-url') {
      const name = positional[1] || 'origin';
      const remotes = await git.listRemotes({ fs, dir });
      const hit = remotes.find((r) => r.remote === name);
      if (!hit) return { stderr: `error: No such remote '${name}'\n`, code: 2 };
      return { stdout: hit.url + '\n', code: 0 };
    }
    if (sub === 'set-url') {
      const name = positional[1], url = positional[2];
      if (!name || !url) return { stderr: 'usage: git remote set-url <name> <url>\n', code: 129 };
      await git.addRemote({ fs, dir, remote: name, url, force: true });
      return { stdout: '', code: 0 };
    }
    // list (default), optionally verbose
    const remotes = await git.listRemotes({ fs, dir });
    if (verbose) {
      let out = '';
      for (const r of remotes) out += `${r.remote}\t${r.url} (fetch)\n${r.remote}\t${r.url} (push)\n`;
      return { stdout: out, code: 0 };
    }
    return { stdout: remotes.map((r) => r.remote).join('\n') + (remotes.length ? '\n' : ''), code: 0 };
  },

  // ── fetch ───────────────────────────────────────────────────────────────────
  async fetch(fs, dir, args, env, cliTokens, signal) {
    const positional = args.filter((a) => !a.startsWith('-'));
    const remoteArg = positional[0] || 'origin';
    const refArg = positional[1];
    let url = await resolveRemoteUrl(fs, dir, remoteArg);
    if (!url) return { stderr: `fatal: '${remoteArg}' does not appear to be a git repository\n`, code: 128 };
    const { url: cleanUrl, tokens } = resolveAuth(url, cliTokens);
    url = cleanUrl;
    const onAuth = makeOnAuth(env, tokens);
    const depthIdx = args.indexOf('--depth');
    const opts = { fs, http: httpNode, dir, url, onAuth, singleBranch: !!refArg, tags: args.includes('--tags'), signal };
    if (refArg) opts.ref = refArg;
    if (depthIdx >= 0) opts.depth = parseInt(args[depthIdx + 1], 10) || 1;
    const res = await git.fetch(opts);
    let out = `From ${url}\n`;
    if (res.defaultBranch) out += ` * [new ref]  ${res.defaultBranch}\n`;
    if (res.fetchHead) out += ` -> FETCH_HEAD ${abbrev(res.fetchHead)}\n`;
    return { stdout: '', stderr: out, code: 0 };
  },

  // ── pull (fetch + merge, then sync worktree) ─────────────────────────────────
  async pull(fs, dir, args, env, cliTokens, signal) {
    const positional = args.filter((a) => !a.startsWith('-'));
    const remoteArg = positional[0] || 'origin';
    const refArg = positional[1];
    let url = await resolveRemoteUrl(fs, dir, remoteArg);
    if (!url) return { stderr: `fatal: '${remoteArg}' does not appear to be a git repository\n`, code: 128 };
    const { url: cleanUrl, tokens } = resolveAuth(url, cliTokens);
    url = cleanUrl;
    const onAuth = makeOnAuth(env, tokens);
    const author = await identity(fs, dir);
    const opts = {
      fs, http: httpNode, dir, url, onAuth, author, singleBranch: true, signal,
      fastForward: !args.includes('--no-ff'),
      fastForwardOnly: args.includes('--ff-only'),
    };
    if (refArg) opts.ref = refArg;
    await git.pull(opts);
    const branch = (await git.currentBranch({ fs, dir })) || 'HEAD';
    await git.checkout({ fs, dir, ref: branch }).catch(() => {});
    return { stdout: '', stderr: `From ${url}\n`, code: 0 };
  },

  // ── push (token via onAuth: URL-embedded / -c / env) ─────────────────────────
  async push(fs, dir, args, env, cliTokens, signal) {
    const positional = args.filter((a) => !a.startsWith('-'));
    const remoteArg = positional[0] || 'origin';
    const refArg = positional[1];
    let url = await resolveRemoteUrl(fs, dir, remoteArg);
    if (!url) return { stderr: `fatal: '${remoteArg}' does not appear to be a git repository\n`, code: 128 };
    const { url: cleanUrl, tokens } = resolveAuth(url, cliTokens);
    url = cleanUrl;
    const onAuth = makeOnAuth(env, tokens);
    if (!onAuth) return { stderr: 'fatal: could not read Username: no credential. Set GITHUB_TOKEN/GIT_TOKEN, use https://<token>@host, or `git -c credential.token=<t> push`.\n', code: 128 };
    const ref = refArg || (await git.currentBranch({ fs, dir })) || 'HEAD';
    let res;
    try {
      res = await git.push({
        fs, http: httpNode, dir, url, ref,
        remoteRef: refArg || ref,
        force: args.includes('-f') || args.includes('--force'),
        onAuth, signal,
      });
    } catch (e) {
      const sc = e && e.data && e.data.statusCode;
      if (sc === 401 || sc === 403) {
        return { stderr: `fatal: Authentication failed for '${url}' (HTTP ${sc}). Check your token/scopes.\n`, code: 128 };
      }
      throw e;
    }
    if (res.ok) return { stdout: '', stderr: `To ${url}\n   ${ref} -> ${ref}\n`, code: 0 };
    return { stderr: `error: failed to push: ${JSON.stringify(res.errors || res)}\n`, code: 1 };
  },

  // ── merge (fast-forward or 3-way; syncs worktree to the merged HEAD) ─────────
  async merge(fs, dir, args) {
    const theirs = args.filter((a) => !a.startsWith('-'))[0];
    if (!theirs) return { stderr: 'fatal: no branch specified\n', code: 128 };
    const author = await identity(fs, dir);
    const res = await git.merge({
      fs, dir, theirs, author,
      fastForward: !args.includes('--no-ff'),
      fastForwardOnly: args.includes('--ff-only'),
      abortOnConflict: true,
    });
    const branch = (await git.currentBranch({ fs, dir })) || 'HEAD';
    await git.checkout({ fs, dir, ref: branch }).catch(() => {});
    if (res.fastForward) return { stdout: `Updating ${abbrev(res.oid)}\nFast-forward\n`, code: 0 };
    if (res.alreadyMerged) return { stdout: 'Already up to date.\n', code: 0 };
    return { stdout: `Merge made by the 'ort' strategy.\n`, code: 0 };
  },

  // ── tag (list / create lightweight or annotated / delete) ────────────────────
  async tag(fs, dir, args) {
    const del = args.includes('-d') || args.includes('--delete');
    const list = args.includes('-l') || args.includes('--list');
    const mi = args.indexOf('-m');
    const message = mi >= 0 ? args[mi + 1] : null;
    const positional = args.filter((a, i) => !a.startsWith('-') && !(mi >= 0 && i === mi + 1));
    if (del) {
      for (const name of positional) await git.deleteTag({ fs, dir, ref: name });
      return { stdout: positional.map((n) => `Deleted tag '${n}'\n`).join(''), code: 0 };
    }
    if (!positional.length || list) {
      const tags = await git.listTags({ fs, dir });
      return { stdout: tags.join('\n') + (tags.length ? '\n' : ''), code: 0 };
    }
    const name = positional[0];
    const objish = positional[1]; // optional commit-ish
    const object = objish ? await git.resolveRef({ fs, dir, ref: objish }).catch(() => objish)
                          : await git.resolveRef({ fs, dir, ref: 'HEAD' });
    if (message || args.includes('-a') || args.includes('--annotate')) {
      const tagger = await identity(fs, dir);
      await git.annotatedTag({
        fs, dir, ref: name, message: message || name, object,
        tagger: { ...tagger, timestamp: Math.floor(Date.now() / 1000), timezoneOffset: new Date().getTimezoneOffset() },
      });
    } else {
      await git.tag({ fs, dir, ref: name, object });
    }
    return { stdout: '', code: 0 };
  },

  // ── reset (--soft / --mixed[default] / --hard, or path-unstage) ──────────────
  async reset(fs, dir, args) {
    const hard = args.includes('--hard');
    const soft = args.includes('--soft');
    const positional = args.filter((a) => !a.startsWith('-'));

    // `git reset [--] <paths>` (unstage) vs `git reset <commit>`.
    // Heuristic: if the first positional resolves as a ref, treat as commit-reset;
    // otherwise it's a path-reset (unstage those files).
    const target = positional[0];
    let commitOid = null;
    if (target) commitOid = await git.resolveRef({ fs, dir, ref: target }).catch(() => null);

    if (target && !commitOid) {
      for (const fp of positional) await git.resetIndex({ fs, dir, filepath: fp });
      return { stdout: '', code: 0 };
    }

    const oid = commitOid || (await git.resolveRef({ fs, dir, ref: 'HEAD' }));
    const branch = await git.currentBranch({ fs, dir });

    // Move the branch (or detached HEAD) ref to the target commit.
    if (branch) await git.writeRef({ fs, dir, ref: `refs/heads/${branch}`, value: oid, force: true });
    else await git.writeRef({ fs, dir, ref: 'HEAD', value: oid, force: true });

    if (soft) return { stdout: '', code: 0 }; // index & worktree untouched

    if (hard) {
      // reset index AND worktree to the target commit
      await git.checkout({ fs, dir, ref: branch || oid, force: true });
      return { stdout: `HEAD is now at ${abbrev(oid)}\n`, code: 0 };
    }
    // --mixed (default): rebuild index from the target tree, keep worktree files
    const files = Object.keys(await flattenCommitTree(fs, dir, oid));
    const tracked = new Set([...(await git.listFiles({ fs, dir }).catch(() => [])), ...files]);
    for (const fp of tracked) {
      await git.resetIndex({ fs, dir, filepath: fp, ref: oid }).catch(async () => {
        await git.resetIndex({ fs, dir, filepath: fp }).catch(() => {});
      });
    }
    return { stdout: '', code: 0 };
  },

  // ── show (commit metadata + patch, blob, or object:path) ─────────────────────
  async show(fs, dir, args) {
    const target = args.filter((a) => !a.startsWith('-'))[0] || 'HEAD';
    // object:path form -> blob content at that path
    const cm = /^(.+):(.+)$/.exec(target);
    if (cm) {
      const oid = await git.resolveRef({ fs, dir, ref: cm[1] }).catch(() => cm[1]);
      const b = await git.readBlob({ fs, dir, oid, filepath: cm[2] });
      return { stdout: Buffer.from(b.blob).toString(), code: 0 };
    }
    const oid = await git.resolveRef({ fs, dir, ref: target }).catch(() => target);
    let obj;
    try { obj = await git.readCommit({ fs, dir, oid }); } catch { obj = null; }
    if (!obj) {
      try {
        const b = await git.readBlob({ fs, dir, oid });
        return { stdout: Buffer.from(b.blob).toString(), code: 0 };
      } catch {
        return { stderr: `fatal: bad object ${target}\n`, code: 128 };
      }
    }
    const c = obj.commit;
    const d = new Date(c.author.timestamp * 1000).toUTCString();
    let out = `commit ${oid}\nAuthor: ${c.author.name} <${c.author.email}>\nDate:   ${d}\n\n    ${c.message.trim()}\n\n`;
    if (diffLib && c.parent && c.parent.length) {
      const parentTree = await flattenCommitTree(fs, dir, c.parent[0]);
      const thisTree = await flattenCommitTree(fs, dir, oid);
      const allPaths = new Set([...Object.keys(parentTree), ...Object.keys(thisTree)]);
      for (const fp of allPaths) {
        const a = parentTree[fp], b = thisTree[fp];
        if (a && b && a.oid === b.oid) continue;
        const aC = a ? Buffer.from((await git.readBlob({ fs, dir, oid: a.oid })).blob).toString() : '';
        const bC = b ? Buffer.from((await git.readBlob({ fs, dir, oid: b.oid })).blob).toString() : '';
        const p = diffLib.createTwoFilesPatch(`a/${fp}`, `b/${fp}`, aC, bC);
        out += `diff --git a/${fp} b/${fp}\n` + p.split('\n').slice(1).join('\n');
      }
    }
    return { stdout: out, code: 0 };
  },

  // ── cat-file (-t type / -s size / -p pretty / -e exists) ─────────────────────
  async 'cat-file'(fs, dir, args) {
    const t = args.includes('-t'), s = args.includes('-s'), e = args.includes('-e');
    const rest = args.filter((a) => !a.startsWith('-'));
    const objish = rest[rest.length - 1];
    const oid = await git.resolveRef({ fs, dir, ref: objish }).catch(() => objish);
    let obj;
    try { obj = await git.readObject({ fs, dir, oid, format: 'parsed' }); }
    catch {
      if (e) return { code: 1 };
      return { stderr: `fatal: Not a valid object name ${objish}\n`, code: 128 };
    }
    if (e) return { code: 0 };
    if (t) return { stdout: obj.type + '\n', code: 0 };
    if (s) {
      const raw = await git.readObject({ fs, dir, oid, format: 'content' }).catch(() => null);
      const size = raw && raw.object ? raw.object.length : 0;
      return { stdout: size + '\n', code: 0 };
    }
    // -p pretty print (default when neither -t/-s/-e)
    if (obj.type === 'blob') return { stdout: Buffer.from(obj.object).toString(), code: 0 };
    if (obj.type === 'commit') {
      const c = obj.object;
      let out = `tree ${c.tree}\n`;
      for (const par of c.parent || []) out += `parent ${par}\n`;
      out += `author ${c.author.name} <${c.author.email}> ${c.author.timestamp} ${c.author.timezoneOffset}\n`;
      out += `committer ${c.committer.name} <${c.committer.email}> ${c.committer.timestamp} ${c.committer.timezoneOffset}\n\n${c.message}`;
      return { stdout: out, code: 0 };
    }
    if (obj.type === 'tree') {
      let out = '';
      for (const ent of obj.object) out += `${ent.mode} ${ent.type} ${ent.oid}\t${ent.path}\n`;
      return { stdout: out, code: 0 };
    }
    if (obj.type === 'tag') {
      const tg = obj.object;
      return { stdout: `object ${tg.object}\ntype ${tg.type}\ntag ${tg.tag}\n\n${tg.message}`, code: 0 };
    }
    return { stdout: '', code: 0 };
  },

  // ── ls-files (list tracked files in the index) ───────────────────────────────
  async 'ls-files'(fs, dir, args) {
    const files = await git.listFiles({ fs, dir });
    return { stdout: files.join('\n') + (files.length ? '\n' : ''), code: 0 };
  },

  // ── mv (rename/move a tracked file) ──────────────────────────────────────────
  async mv(fs, dir, args) {
    const rest = args.filter((a) => !a.startsWith('-'));
    const src = rest[0], dst = rest[1];
    if (!src || !dst) return { stderr: 'usage: git mv <source> <dest>\n', code: 129 };
    const absSrc = path.resolve(dir, src), absDst = path.resolve(dir, dst);
    let finalDst = dst, finalAbsDst = absDst;
    try {
      if (nodeFs.statSync(absDst).isDirectory()) {
        finalDst = path.posix.join(dst, path.basename(src));
        finalAbsDst = path.resolve(dir, finalDst);
      }
    } catch {}
    nodeFs.renameSync(absSrc, finalAbsDst);
    await git.remove({ fs, dir, filepath: src }).catch(() => {});
    await git.add({ fs, dir, filepath: finalDst });
    return { stdout: '', code: 0 };
  },

  // ── restore (--staged unstage / worktree revert to HEAD|index|--source) ──────
  async restore(fs, dir, args) {
    const staged = args.includes('--staged') || args.includes('-S');
    const sourceIdx = args.indexOf('--source');
    const source = sourceIdx >= 0 ? args[sourceIdx + 1] : null;
    const files = args.filter((a, i) => !a.startsWith('-') && !(sourceIdx >= 0 && i === sourceIdx + 1));
    if (!files.length) return { stderr: 'fatal: you must specify path(s) to restore\n', code: 128 };
    for (const fp of files) {
      if (staged) {
        const opts = { fs, dir, filepath: fp };
        if (source) opts.ref = await git.resolveRef({ fs, dir, ref: source }).catch(() => source);
        await git.resetIndex(opts).catch(async () => { await git.resetIndex({ fs, dir, filepath: fp }); });
      } else {
        const ref = source || 'HEAD';
        const oid = await git.resolveRef({ fs, dir, ref }).catch(() => ref);
        try {
          const b = await git.readBlob({ fs, dir, oid, filepath: fp });
          nodeFs.writeFileSync(path.resolve(dir, fp), Buffer.from(b.blob));
        } catch {
          return { stderr: `error: pathspec '${fp}' did not match any file(s)\n`, code: 1 };
        }
      }
    }
    return { stdout: '', code: 0 };
  },
};

async function gitMain(args, ctx) {
  const fs = nodeFs;               // operate on real container files
  const cwd = (ctx && ctx.cwd) || process.cwd();
  // env for auth flows via just-bash's exportedEnv (fallback: ctx.env / process.env)
  const env = (ctx && (ctx.exportedEnv || ctx.env)) || process.env;
  args = Array.isArray(args) ? args.slice() : [];

  if (args.includes('--version') || args[0] === 'version') return { stdout: GIT_VERSION + '\n', stderr: '', exitCode: 0 };
  if (!args.length || args[0] === '--help') return { stdout: '', stderr: 'usage: git <command> [<args>]\n', exitCode: args.length ? 0 : 1 };
  // strip leading global flags like -C <path> and -c <key=val> (config/creds).
  let dirOverride = null;
  const cliCfgs = [];
  while (args[0] && args[0].startsWith('-')) {
    if (args[0] === '-C') { dirOverride = args[1]; args = args.slice(2); continue; }
    if (args[0] === '-c') { if (args[1]) cliCfgs.push(args[1]); args = args.slice(2); continue; }
    args = args.slice(1);
  }
  const cliTokens = parseCliTokens(cliCfgs);
  const [sub, ...rest] = args;
  const h = handlers[sub];
  if (!h) return { stdout: '', stderr: `git: '${sub}' is not a git command (unsupported in L Shell).\n`, exitCode: 1 };

  let dir = mapTmp(dirOverride ? path.resolve(cwd, dirOverride) : cwd);
  if (sub !== 'init' && sub !== 'clone' && sub !== 'config') {
    const root = await findGitRoot(fs, dir);
    if (!root) return { stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git\n', exitCode: 128 };
    dir = root;
  } else if (sub === 'config') {
    const root = await findGitRoot(fs, dir);
    if (root) dir = root; // config on a repo if present
  }
  try {
    const r = await h(fs, dir, rest, env, cliTokens, ctx && ctx.signal);
    return { stdout: r.stdout || '', stderr: r.stderr || '', exitCode: r.code || 0 };
  } catch (e) {
    return { stdout: '', stderr: `fatal: ${String(e && e.message || e).split('\n')[0]}\n`, exitCode: 128 };
  }
}

module.exports = { gitMain, GIT_VERSION };
