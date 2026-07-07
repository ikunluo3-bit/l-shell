'use strict';
// just-bash command registration for the in-process npm subset (L Shell / inpm).
// Usage in the runtime:
//   const { registerNpm } = require('./npm-command');
//   registerNpm(bash, defineCommand);
//
// Subcommands implemented (all in-process; NO child_process / fork / exec / WASM):
//   npm install [pkg[@range]...] [--save-dev|-D] [--save|-P|--production] [--force]
//   npm uninstall|remove|rm|un <pkg...>
//   npm init [-y|--yes]
//   npm ls|list [--depth=N] [--production]
//   npm run [<script>] [-- extra args]   (script body runs via just-bash ctx.exec)
//   npm run-script / npm start / npm test / npm stop / npm restart  (script aliases)
//   npm --version | -v
//
// Hard limits honestly reported (never silently swallowed):
//   - lifecycle scripts (preinstall/install/postinstall/prepare) are NOT run
//     during install (no exec); detected and warned per package.
//   - native addons (node-gyp/prebuild/*.node) cannot be built; warned per package.
//   - `npm run` executes the script BODY through the in-process shell, so it works
//     for scripts composed of shell built-ins the runtime supports (node, echo,
//     git, cat, test, &&, ||, pipes, env vars, ...). A script that shells out to an
//     unavailable external program fails with that program's own honest 127 error.
const path = require('path');
const fs = require('fs');
const { install, uninstall, initPkg, buildTree, renderTree } = require('./inpm');

// npm version we advertise. inpm targets the npm CLI surface at roughly the
// npm 10 line (flat install, `npm ls` tree, save-dev flag spellings). We report a
// real-looking npm version plus an inpm tag so callers/tooling that version-gate on
// `npm --version` see a satisfiable number, while humans see the truth.
const NPM_VERSION = '10.8.2';
const NPM_BANNER = NPM_VERSION + ' (L Shell inpm)';

function readPkgJson(cwd) {
  const p = path.join(cwd, 'package.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// Parse install-time flags into { save, production, force } and strip them out.
// Mirrors npm's common spellings.  Default save target is "prod" (dependencies),
// matching npm's behavior when installing a named package.
function parseInstallFlags(args) {
  const flags = { save: 'prod', production: false, force: false, explicitSave: false };
  const names = [];
  for (const a of args) {
    if (!a.startsWith('-')) { names.push(a); continue; }
    switch (a) {
      case '-D': case '--save-dev': case '--save-development':
        flags.save = 'dev'; flags.explicitSave = true; break;
      case '-P': case '--save-prod': case '--save-production':
        flags.save = 'prod'; flags.explicitSave = true; break;
      case '-O': case '--save-optional':
        flags.save = 'optional'; flags.explicitSave = true; break;
      case '--no-save':
        flags.save = 'none'; flags.explicitSave = true; break;
      case '--save': case '-S':
        flags.explicitSave = true; break; // save to prod (default) but marked explicit
      case '--production': case '--omit=dev':
        flags.production = true; break;
      case '-f': case '--force':
        flags.force = true; break;
      default:
        // ignore unknown flags rather than treating them as package names
        break;
    }
  }
  return { flags, names };
}

async function cmdInstall(args, ctx) {
  const cwd = ctx.cwd || process.cwd();
  const { flags, names } = parseInstallFlags(args);
  let specs = {};
  let saveMode; // undefined -> let install() default (no save)
  if (names.length === 0) {
    // `npm install` with no args -> install deps from package.json, DON'T save.
    const pj = readPkgJson(cwd);
    if (!pj) return { stdout: '', stderr: 'npm error: no package.json and no packages named\n', exitCode: 1 };
    specs = Object.assign({}, pj.dependencies, flags.production ? {} : pj.devDependencies);
    saveMode = 'none';
    if (Object.keys(specs).length === 0) {
      return { stdout: 'up to date (no dependencies in package.json)\n', stderr: '', exitCode: 0 };
    }
  } else {
    for (const a of names) {
      const at = a.lastIndexOf('@');
      // scoped names start with '@'; a leading '@' is NOT a version separator
      if (at > 0) specs[a.slice(0, at)] = a.slice(at + 1);
      else specs[a] = 'latest';
    }
    // Named install saves by default (unless --no-save). Honor chosen save target.
    saveMode = flags.save; // 'prod' | 'dev' | 'optional' | 'none'
    if (saveMode === 'prod') saveMode = 'dep'; // install() uses 'dep'|'dev'|'optional'|'none'
  }
  const out = [];
  const warnings = [];
  try {
    const res = await install(cwd, specs, {
      skipScripts: true,
      force: flags.force,
      reuseExisting: !flags.force,
      save: saveMode,
      log: (m) => out.push(m),
      onWarn: (w) => warnings.push(w),
    });
    const nAdded = (res.added || []).length;
    const nTotal = Object.keys(res.installed).length;
    out.push('');
    out.push('added ' + nAdded + ' package' + (nAdded === 1 ? '' : 's') +
      ', ' + nTotal + ' total in tree (in-process, lifecycle scripts skipped)');
    if (res.savedTo) out.push('saved to package.json "' + res.savedTo + '"');
    let stderr = '';
    if (warnings.length) stderr = warnings.map((w) => 'npm warn ' + w).join('\n') + '\n';
    return { stdout: out.join('\n') + '\n', stderr, exitCode: 0 };
  } catch (e) {
    return { stdout: out.join('\n') + '\n', stderr: 'npm error: ' + e.message + '\n', exitCode: 1 };
  }
}

function cmdUninstall(args, ctx) {
  const cwd = ctx.cwd || process.cwd();
  const names = args.filter((a) => !a.startsWith('-'));
  const noSave = args.includes('--no-save');
  if (names.length === 0) {
    return { stdout: '', stderr: 'npm error: `npm uninstall <pkg>` requires a package name\n', exitCode: 1 };
  }
  const out = [];
  const res = uninstall(cwd, names, { save: !noSave, log: (m) => out.push(m) });
  let stderr = '';
  if (res.missing.length) {
    stderr = res.missing.map((n) => 'npm warn ' + n + ' not installed').join('\n') + '\n';
  }
  const n = res.removed.length;
  out.push('');
  out.push('removed ' + n + ' package' + (n === 1 ? '' : 's'));
  if (res.savedTo) out.push('updated package.json "' + res.savedTo + '"');
  // exit 0 even if some were missing (npm behavior); only hard errors are non-zero
  return { stdout: out.join('\n') + '\n', stderr, exitCode: 0 };
}

function cmdInit(args, ctx) {
  const cwd = ctx.cwd || process.cwd();
  const yes = args.includes('-y') || args.includes('--yes');
  if (!yes) {
    // We have no interactive prompt in this runtime; require -y and say so clearly.
    return {
      stdout: '',
      stderr: 'npm error: interactive `npm init` is not available on-device. ' +
        'Use `npm init -y` to write a default package.json.\n',
      exitCode: 1,
    };
  }
  const res = initPkg(cwd, {});
  const verb = res.created ? 'Wrote to' : 'Updated';
  const body = JSON.stringify(res.pkg, null, 2);
  return { stdout: verb + ' ' + res.path + ':\n\n' + body + '\n\n', stderr: '', exitCode: 0 };
}

function cmdLs(args, ctx) {
  const cwd = ctx.cwd || process.cwd();
  const nm = path.join(cwd, 'node_modules');
  const production = args.includes('--production') || args.includes('--omit=dev');
  let depth;
  for (const a of args) {
    const m = /^--depth[=\s]?(\d+)$/.exec(a);
    if (m) depth = parseInt(m[1], 10);
    if (a === '--all') depth = Infinity;
  }
  if (!fs.existsSync(nm)) {
    const pj = readPkgJson(cwd);
    const head = pj && pj.name ? pj.name + '@' + (pj.version || '') : path.basename(path.resolve(cwd));
    return { stdout: head + '\n(empty)\n', stderr: '', exitCode: 0 };
  }
  const tree = buildTree(cwd, { depth: depth == null ? 0 : depth, production });
  tree.rootPath = cwd;
  const rendered = renderTree(tree);
  // Non-zero exit when the tree has missing/invalid deps, mirroring npm ls.
  const problems = /\[(MISSING|INVALID)/.test(rendered);
  return { stdout: rendered + '\n', stderr: '', exitCode: problems ? 1 : 0 };
}

// `npm run <script>` — runs the script BODY through the in-process shell via
// ctx.exec (the just-bash CommandContext re-entry hook). Verified present:
// CommandContext.exec(command, { cwd }) -> ExecResult. This gives scripts access
// to every registered builtin (node, echo, git, test, pipes, &&, env expansion).
//
// npm semantics reproduced:
//   - `npm run` with no name lists available scripts.
//   - pre<script> / post<script> hooks run around the target (npm lifecycle order).
//   - args after `--` are appended to the script command line.
//   - $npm_package_name / $npm_package_version / $npm_lifecycle_event exported.
//   - `start`/`test`/`stop`/`restart` map to their scripts, with npm's builtin
//     defaults for start/test when unspecified.
const BUILTIN_SCRIPT_DEFAULTS = {
  // npm falls back to `node server.js` for start only if the file exists; we do the
  // same check. test has a canonical "no test specified" default.
  test: 'echo "Error: no test specified" && exit 1',
};

async function cmdRun(args, ctx, opts = {}) {
  const cwd = ctx.cwd || process.cwd();
  const pj = readPkgJson(cwd);
  const scripts = (pj && pj.scripts) || {};

  // Split off trailing `-- extra args`.
  let name = args[0];
  let extra = [];
  const ddash = args.indexOf('--');
  if (ddash >= 0) extra = args.slice(ddash + 1);
  const positional = (ddash >= 0 ? args.slice(0, ddash) : args).filter((a) => !a.startsWith('-'));

  // Aliased entry points (npm start/test/stop/restart) pass their own name.
  if (opts.forceName) name = opts.forceName;
  else name = positional[0];

  if (!name) {
    if (!pj) return { stdout: '', stderr: 'npm error: no package.json in ' + cwd + '\n', exitCode: 1 };
    const keys = Object.keys(scripts);
    if (!keys.length) return { stdout: '(no scripts defined)\n', stderr: '', exitCode: 0 };
    const lines = ['Lifecycle scripts included in ' + (pj.name || 'package') + ':'];
    for (const k of keys) { lines.push('  ' + k); lines.push('    ' + scripts[k]); }
    return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 };
  }

  if (ctx.exec == null || typeof ctx.exec !== 'function') {
    return {
      stdout: '',
      stderr: 'npm error: in-process shell evaluator (ctx.exec) unavailable — ' +
        'cannot run scripts in this context.\n',
      exitCode: 1,
    };
  }

  // Resolve the script body, honoring npm's builtin defaults for start/test.
  let body = scripts[name];
  if (body == null && BUILTIN_SCRIPT_DEFAULTS[name] != null) body = BUILTIN_SCRIPT_DEFAULTS[name];
  if (body == null && name === 'start') {
    // npm's builtin `start` default is `node server.js` when it exists.
    if (fs.existsSync(path.join(cwd, 'server.js'))) body = 'node server.js';
  }
  if (body == null) {
    // npm error surface for a missing script, listing what exists.
    const avail = Object.keys(scripts);
    let msg = 'npm error: missing script: "' + name + '"\n';
    if (avail.length) msg += 'npm error: available scripts:\n' + avail.map((s) => '  ' + s).join('\n') + '\n';
    return { stdout: '', stderr: msg, exitCode: 1 };
  }

  // Env npm exposes to scripts. install()/inpm doesn't set these, so we do here.
  const scriptEnv = {
    npm_package_name: (pj && pj.name) || '',
    npm_package_version: (pj && pj.version) || '',
    npm_lifecycle_event: name,
    npm_execpath: 'inpm',
    npm_config_user_agent: 'npm/' + NPM_VERSION + ' node/v18 (L Shell inpm)',
    // node_modules/.bin on PATH so locally-installed CLIs resolve in scripts.
    PATH: path.join(cwd, 'node_modules', '.bin') + ':' +
      ((ctx.env && (ctx.env.get ? ctx.env.get('PATH') : ctx.env.PATH)) || '/bin:/usr/bin'),
  };

  const outParts = [];
  const errParts = [];

  // Run one script body + appended args through the in-process shell.
  const runOne = async (label, cmdBody) => {
    let full = cmdBody;
    if (extra.length && label === name) {
      // Only the main script gets the `-- extra` args, as in npm.
      full = cmdBody + ' ' + extra.map(shellQuote).join(' ');
    }
    const r = await ctx.exec(full, { cwd, env: scriptEnv, signal: ctx.signal });
    if (r.stdout) outParts.push(r.stdout);
    if (r.stderr) errParts.push(r.stderr);
    return r.exitCode || 0;
  };

  // pre<name>
  const pre = scripts['pre' + name];
  if (pre != null) {
    const c = await runOne('pre' + name, pre);
    if (c !== 0) {
      return { stdout: outParts.join(''), stderr: errParts.join('') +
        'npm error: pre' + name + ' script failed with code ' + c + '\n', exitCode: c };
    }
  }

  // main
  const mainCode = await runOne(name, body);
  if (mainCode !== 0) {
    return { stdout: outParts.join(''), stderr: errParts.join('') +
      'npm error: script "' + name + '" exited with code ' + mainCode + '\n', exitCode: mainCode };
  }

  // post<name>
  const post = scripts['post' + name];
  if (post != null) {
    const c = await runOne('post' + name, post);
    if (c !== 0) {
      return { stdout: outParts.join(''), stderr: errParts.join('') +
        'npm error: post' + name + ' script failed with code ' + c + '\n', exitCode: c };
    }
  }

  return { stdout: outParts.join(''), stderr: errParts.join(''), exitCode: 0 };
}

// Minimal shell quoting for appended `-- args` so they survive re-parsing.
function shellQuote(s) {
  if (/^[A-Za-z0-9_./:=@-]+$/.test(s)) return s;
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function helpText() {
  return [
    NPM_BANNER,
    '',
    'Usage: npm <command>',
    '',
    'Supported commands (in-process, no external exec):',
    '  install [pkg[@ver]...] [-D|--save-dev] [--production] [--force]',
    '  uninstall|remove|rm <pkg...> [--no-save]',
    '  init -y',
    '  ls|list [--depth=N] [--all] [--production]',
    '  run [script] [-- args]   (also: start, test, stop, restart)',
    '  --version | -v',
    '',
    'Not available on-device (no fork/exec/WASM): lifecycle & native-addon builds,',
    'npx, interactive init. These are detected and reported, never silently ignored.',
  ].join('\n') + '\n';
}

function registerNpm(bash, defineCommand) {
  bash.registerCommand(defineCommand('npm', async (args, ctx) => {
    const sub = args[0];
    const rest = args.slice(1);
    switch (sub) {
      case '--version': case '-v':
        return { stdout: NPM_BANNER + '\n', stderr: '', exitCode: 0 };
      case 'install': case 'i': case 'add': case 'in': case 'ins': case 'isntall':
        return cmdInstall(rest, ctx);
      case 'uninstall': case 'remove': case 'rm': case 'un': case 'unlink': case 'r':
        return cmdUninstall(rest, ctx);
      case 'init': case 'create': case 'innit':
        return cmdInit(rest, ctx);
      case 'ls': case 'list': case 'll': case 'la':
        return cmdLs(rest, ctx);
      case 'run': case 'run-script': case 'rum': case 'urn':
        return cmdRun(rest, ctx);
      case 'start':
        return cmdRun(rest, ctx, { forceName: 'start' });
      case 'test': case 't': case 'tst':
        return cmdRun(rest, ctx, { forceName: 'test' });
      case 'stop':
        return cmdRun(rest, ctx, { forceName: 'stop' });
      case 'restart':
        return cmdRun(rest, ctx, { forceName: 'restart' });
      case 'help': case undefined:
        return { stdout: helpText(), stderr: '', exitCode: sub === undefined ? 1 : 0 };
      // Explicitly-unsupported commands get an honest error, not a generic one.
      case 'publish': case 'link': case 'audit': case 'dedupe': case 'ci':
      case 'exec': case 'x': case 'update': case 'up': case 'outdated':
        return {
          stdout: '',
          stderr: 'npm error: "' + sub + '" is not supported by L Shell inpm ' +
            '(needs network write / exec / registry auth not available on-device).\n' +
            'Supported: install, uninstall, init -y, ls, run, --version.\n',
          exitCode: 1,
        };
      default:
        return {
          stdout: '',
          stderr: 'npm error: unknown command "' + String(sub) + '"\n' +
            'Supported: install, uninstall, init -y, ls, run, --version.\n',
          exitCode: 1,
        };
    }
  }));
}

module.exports = {
  registerNpm, cmdInstall, cmdUninstall, cmdInit, cmdLs, cmdRun,
  NPM_VERSION, NPM_BANNER,
};
