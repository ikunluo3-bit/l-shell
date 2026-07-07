'use strict';
// pip-command.js — `pip3` / `pip` for L Shell. A thin JS front-end that installs
// PURE-PYTHON wheels from PyPI into a writable site-packages the embedded CPython 3.13
// (python-command.js / lshell_py.c) picks up via PYTHONPATH. Registered as a just-bash
// builtin exactly like git/npm/python3 (register.js). Returns {stdout, stderr, exitCode}.
//
// WHY A CUSTOM FRONT-END (not upstream pip): upstream pip drives the build/install via
// child_process (spawns the compiler, isolated build envs, `python setup.py`, etc.).
// iOS has no fork/exec — pip cannot run. So we reimplement the SUBSET that works without
// exec: fetch metadata, pick a pure wheel, download, unzip in pure JS, drop it on sys.path.
//
// HARD WALL (honest): anything needing a C/Rust extension is BLOCKED. We detect this by
// the wheel tag — a pure wheel is tagged `*-none-any.whl` (Root-Is-Purelib). A package
// that ships ONLY platform wheels (cpXX-cpXX-<plat>.whl) has a compiled extension we
// cannot build (no compiler, no exec) and cannot load a foreign-platform .so for. We do
// NOT fall back to building from an sdist. We report exactly which package in the
// dependency closure caused the block.
//
// Mechanism VERIFIED end-to-end on Node v18.19.1 (see design-notes.md):
//   PyPI JSON -> pick pure wheel -> node:https download -> wheel-zip.js unzip (+CRC32)
//   -> write to <site> -> host python3 `import six/click` succeeds.
//
// Runtime deps: python-command.js (for `sitePackagesDir()` + PYTHONPATH wiring) and
// wheel-zip.js (pure-JS unzip). node:https + node:zlib only — no WASM, no exec.

const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { extractAll } = require('./wheel-zip.js');

const PYPI = 'https://pypi.org/pypi';
const UA = 'lshell-pip/0.1';
const PIP_VERSION = '24.0';        // the pip CLI version we emulate (surface only)
const PY_TAG = 'cp313';            // embedded interpreter is CPython 3.13
const ABI_TAG = 'cp313';

// ---------------------------------------------------------------------------
// site-packages location. MUST be a writable dir the interpreter has on sys.path.
// The embedded CPython uses IsolatedConfig (no implicit PYTHONPATH / user site), so
// python-command.js is responsible for prepending this dir to sys.path at eval time
// (see integration.md CHANGE for python-command.js). We derive the same path here so
// pip writes exactly where python3 reads.
//
// Convention (mirrors shell-extras.js writable-base pick: $TMPDIR/$HOME, never /tmp):
//   <base>/.lshell/python/site-packages
// base = LSHELL_PY_SITE (explicit override) > HOME > TMPDIR.
function sitePackagesDir(env) {
  env = env || process.env;
  if (env.LSHELL_PY_SITE) return env.LSHELL_PY_SITE;
  const base = env.HOME || env.TMPDIR || '/tmp';
  return path.join(base, '.lshell', 'python', 'site-packages');
}

// ---------------------------------------------------------------------------
// networking (identical shape to inpm.js fetchBuf: node:https + one-redirect follow).
function fetchBuf(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'user-agent': UA, accept: '*/*' } }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        r.resume();
        return resolve(fetchBuf(r.headers.location));
      }
      if (r.statusCode !== 200) { r.resume(); return reject(new Error('HTTP ' + r.statusCode + ' ' + url)); }
      const d = [];
      r.on('data', (c) => d.push(c));
      r.on('end', () => resolve(Buffer.concat(d)));
    });
    req.on('error', reject);
    // Bound a stalled connection so `pip install` can't hang the shell indefinitely.
    req.setTimeout(30000, () => req.destroy(new Error('pip: request timed out: ' + url)));
  });
}

async function fetchJson(url) {
  return JSON.parse((await fetchBuf(url)).toString('utf8'));
}

// project metadata (JSON API). name is normalized per PEP 503 for the URL.
function normalize(name) {
  return String(name).toLowerCase().replace(/[-_.]+/g, '-');
}
async function fetchMeta(name) {
  return fetchJson(PYPI + '/' + encodeURIComponent(name) + '/json');
}

// ---------------------------------------------------------------------------
// PURITY: a pure wheel is tagged `<py>-<abi>-none-any` (platform = any). We accept any
// `*-none-any.whl`. Returns the best pure wheel file object, or null if none exists
// (=> package has a compiled extension => BLOCKED).
function pickPureWheel(fileList) {
  const wheels = (fileList || []).filter((f) => f.packagetype === 'bdist_wheel');
  const pure = wheels.filter((f) => /-none-any\.whl$/i.test(f.filename));
  if (!pure.length) return null;
  // Prefer a cp313/py3 tag over py2-only, but any -none-any is importable.
  const rank = (f) => {
    const n = f.filename;
    if (n.includes(PY_TAG)) return 0;            // cp313-none-any (rare)
    if (/-py3-none-any\.whl$/i.test(n)) return 1;
    if (/-py2\.py3-none-any\.whl$/i.test(n)) return 2;
    if (/-py3\.\d+-none-any\.whl$/i.test(n)) return 3;
    return 4;
  };
  pure.sort((a, b) => rank(a) - rank(b));
  return pure[0];
}

// Why a package is blocked, for the honest error message.
function blockReason(fileList) {
  const wheels = (fileList || []).filter((f) => f.packagetype === 'bdist_wheel');
  if (!wheels.length) return 'ships no wheels (source-only; would need a compiler to build)';
  return 'ships only platform-specific wheels (compiled C/Rust extension; cannot build or load on iOS)';
}

// ---------------------------------------------------------------------------
// DEPENDENCY MARKERS. Requires-Dist lines carry PEP 508 markers we must evaluate for the
// iOS/CPython-3.13 target so we do not pull in deps that do not apply (e.g. Windows-only
// colorama, or `extra == "..."` optional groups we did not request).
//
// We evaluate the SMALL, common marker grammar: a boolean combination (and/or) of
// comparisons `<var> <op> <string>` where var is one of the environment markers below.
// Anything we cannot parse we treat as "applies" (conservative: better to try+see than
// silently drop a real dep). `extra` defaults to unset so optional groups are excluded.
const MARKER_ENV = {
  os_name: 'posix',
  sys_platform: 'ios',            // faithful; also matches nothing win32-gated
  platform_system: 'iOS',
  platform_machine: 'arm64',
  platform_python_implementation: 'CPython',
  python_version: '3.13',
  python_full_version: '3.13.14',
  implementation_name: 'cpython',
};

function evalMarker(marker, extras) {
  if (!marker) return true;
  // Tokenize into comparisons and boolean ops. Good enough for real-world Requires-Dist.
  // Split on 'and'/'or' at top level (no parens nesting in practice for stdlib pkgs;
  // if parens appear we fall back to "applies").
  if (/[()]/.test(marker)) {
    // has grouping — attempt a very small recursive handling, else be conservative.
    try { return evalGrouped(marker, extras); } catch { return true; }
  }
  const orParts = marker.split(/\bor\b/);
  return orParts.some((orp) =>
    orp.split(/\band\b/).every((cmp) => evalComparison(cmp.trim(), extras)));
}

function evalGrouped(marker, extras) {
  // minimal: strip one layer of matched parens around whole clauses
  let m = marker.trim();
  // repeatedly evaluate innermost parenthesized group
  const re = /\(([^()]*)\)/;
  let g;
  while ((g = re.exec(m))) {
    const val = evalMarker(g[1], extras) ? 'python_version >= "0"' : 'python_version < "0"';
    m = m.slice(0, g.index) + val + m.slice(g.index + g[0].length);
  }
  return evalMarker(m, extras);
}

function evalComparison(cmp, extras) {
  const m = cmp.match(/^(\S+)\s*(==|!=|>=|<=|>|<|~=|in|not in)\s*(.+)$/);
  if (!m) return true;                       // unparseable -> applies
  let [, lhs, op, rhs] = m;
  rhs = rhs.trim().replace(/^['"]|['"]$/g, '');
  if (lhs === 'extra') {
    const has = extras.has(rhs);
    return op === '==' ? has : op === '!=' ? !has : has;
  }
  const lv = MARKER_ENV[lhs];
  if (lv == null) return true;               // unknown var -> applies
  switch (op) {
    case '==': return lv === rhs;
    case '!=': return lv !== rhs;
    case 'in': return rhs.includes(lv);
    case 'not in': return !rhs.includes(lv);
    // version-ish comparisons: compare numerically component-wise when both look like versions
    case '>': case '<': case '>=': case '<=': case '~=':
      return cmpVersion(lv, rhs, op);
    default: return true;
  }
}

function cmpVersion(a, b, op) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  let c = 0;
  for (let i = 0; i < n; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) { c = d < 0 ? -1 : 1; break; } }
  switch (op) {
    case '>': return c > 0;
    case '<': return c < 0;
    case '>=': return c >= 0;
    case '<=': return c <= 0;
    case '~=': return c >= 0;   // compatible-release, approximated
    default: return true;
  }
}

// Parse a Requires-Dist line -> {name, marker} or null. We only need the dep NAME and
// its environment marker; version constraints are ignored (we always take latest pure).
function parseRequiresDist(line) {
  // "pkg (>=1,<2) ; extra == 'foo' and python_version >= '3.8'"
  let s = String(line).trim();
  let marker = '';
  const semi = s.indexOf(';');
  if (semi >= 0) { marker = s.slice(semi + 1).trim(); s = s.slice(0, semi).trim(); }
  // strip version spec: name may be followed by extras [x] and/or (spec)
  const name = s.split(/[\s<>=!~();[]/)[0];
  if (!name) return null;
  return { name, marker };
}

// ---------------------------------------------------------------------------
// RESOLVE: walk the runtime dependency closure of the requested specs, classifying each
// package pure/blocked. Returns { order:[{name,ver,wheel,meta}], blocked:[{name,path}] }.
// Uses info.requires_dist from the PyPI JSON (already-parsed Requires-Dist).
async function resolveClosure(rootNames, opts = {}) {
  const seen = new Map();          // normalized name -> record
  const order = [];                // install order (deps before dependents not required
                                   // for site-packages, but we keep discovery order)
  const blocked = [];
  const metaCache = new Map();

  async function meta(name) {
    const k = normalize(name);
    if (metaCache.has(k)) return metaCache.get(k);
    const m = await fetchMeta(name);
    metaCache.set(k, m);
    return m;
  }

  async function visit(name, extras, trail) {
    const key = normalize(name);
    if (seen.has(key)) return;
    let m;
    try { m = await meta(name); }
    catch (e) {
      seen.set(key, { name, error: e.message });
      blocked.push({ name, notFound: true, reason: 'not found on PyPI (' + e.message + ')', path: trail.concat(name) });
      return;
    }
    const wheel = pickPureWheel(m.urls);
    const ver = m.info && m.info.version;
    const rec = { name: m.info.name || name, key, ver, wheel, pure: !!wheel };
    seen.set(key, rec);
    if (!wheel) {
      blocked.push({ name: rec.name, reason: blockReason(m.urls), path: trail.concat(rec.name) });
      return;                       // do not descend into a blocked package's deps
    }
    order.push(rec);
    if (opts.noDeps) return;          // --no-deps: do not descend into dependencies
    // recurse runtime deps whose markers apply for our target (extras from THIS pkg's
    // requested extras only).
    const rd = (m.info && m.info.requires_dist) || [];
    for (const line of rd) {
      const p = parseRequiresDist(line);
      if (!p) continue;
      if (!evalMarker(p.marker, extras)) continue;    // marker excludes it on iOS
      await visit(p.name, new Set(), trail.concat(rec.name));
    }
  }

  for (const spec of rootNames) {
    const { name, extras } = splitExtras(spec);
    await visit(name, extras, []);
  }
  return { order, blocked, seen };
}

// "flask[async]" -> {name:'flask', extras:Set{'async'}}
function splitExtras(spec) {
  const m = String(spec).match(/^([^\[]+)(?:\[([^\]]*)\])?/);
  const name = (m && m[1] || spec).trim();
  const extras = new Set(((m && m[2]) || '').split(',').map((s) => s.trim()).filter(Boolean));
  return { name, extras };
}

// ---------------------------------------------------------------------------
// DOWNLOAD + UNPACK one wheel into <site>. Verifies sha256 (from PyPI digests) over the
// wheel bytes, then CRC32 per file (in wheel-zip). Records into <site>/<pkg>-<ver>.dist-info
// which is already inside the wheel, so `pip list`/`show`/uninstall can read it.
async function installWheel(rec, site, log) {
  const url = rec.wheel.url;
  const buf = await fetchBuf(url);
  const want = rec.wheel.digests && rec.wheel.digests.sha256;
  if (want) {
    const got = crypto.createHash('sha256').update(buf).digest('hex');
    if (got !== want) throw new Error('sha256 mismatch for ' + rec.name + '@' + rec.ver);
  }
  const files = extractAll(buf);           // Map<name, Buffer>, CRC32-verified
  fs.mkdirSync(site, { recursive: true });
  let n = 0;
  for (const [name, data] of files) {
    // wheel paths are already relative install paths (pkg/... and *.dist-info/...).
    // *.data/ scripts/headers are ignored (no console-script shims without exec anyway).
    if (/(^|\/)[^/]+\.data\//.test(name)) continue;
    const out = path.join(site, name);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, data);
    n++;
  }
  log('  + ' + rec.name + '@' + rec.ver + ' (' + n + ' files)');
  return n;
}

// installed-distribution scan: read *.dist-info/METADATA under <site>.
function listInstalled(site) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(site); } catch { return out; }
  for (const d of entries) {
    if (!d.endsWith('.dist-info')) continue;
    const meta = path.join(site, d, 'METADATA');
    let name = null, ver = null;
    try {
      const txt = fs.readFileSync(meta, 'utf8');
      for (const line of txt.split('\n')) {
        if (!name && /^Name:\s*/i.test(line)) name = line.replace(/^Name:\s*/i, '').trim();
        if (!ver && /^Version:\s*/i.test(line)) ver = line.replace(/^Version:\s*/i, '').trim();
        if (name && ver) break;
      }
    } catch { /* fall through: derive from dir name */ }
    if (!name) { const m = d.match(/^(.+)-([^-]+)\.dist-info$/); if (m) { name = m[1]; ver = m[2]; } }
    if (name) out.push({ name, version: ver || '?', distInfo: d });
  }
  out.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  return out;
}

function showPackage(site, name) {
  const key = normalize(name);
  for (const info of listInstalled(site)) {
    if (normalize(info.name) === key) {
      const meta = path.join(site, info.distInfo, 'METADATA');
      let fields = {};
      try {
        const txt = fs.readFileSync(meta, 'utf8');
        for (const line of txt.split('\n')) {
          const m = line.match(/^([A-Za-z-]+):\s*(.*)$/);
          if (m && !(m[1] in fields)) fields[m[1]] = m[2];
          if (line.trim() === '') break;   // stop at body
        }
      } catch { /* ignore */ }
      return { info, fields };
    }
  }
  return null;
}

// uninstall: remove the package's files listed in RECORD + its dist-info.
function uninstallPackage(site, name) {
  const key = normalize(name);
  for (const info of listInstalled(site)) {
    if (normalize(info.name) !== key) continue;
    const recordPath = path.join(site, info.distInfo, 'RECORD');
    let removed = 0;
    try {
      const rec = fs.readFileSync(recordPath, 'utf8');
      for (const line of rec.split('\n')) {
        const rel = line.split(',')[0];
        if (!rel) continue;
        const abs = path.join(site, rel);
        try { fs.rmSync(abs, { force: true }); removed++; } catch { /* ignore */ }
      }
    } catch { /* no RECORD: fall back to removing the top package dir + dist-info */ }
    try { fs.rmSync(path.join(site, info.distInfo), { recursive: true, force: true }); } catch {}
    // prune now-empty dirs (best effort)
    pruneEmptyDirs(site);
    return { name: info.name, version: info.version, removed };
  }
  return null;
}

function pruneEmptyDirs(root) {
  let entries;
  try { entries = fs.readdirSync(root); } catch { return; }
  for (const e of entries) {
    const p = path.join(root, e);
    let st; try { st = fs.statSync(p); } catch { continue; }
    if (st.isDirectory()) {
      pruneEmptyDirs(p);
      try { if (fs.readdirSync(p).length === 0) fs.rmdirSync(p); } catch {}
    }
  }
}

// ---------------------------------------------------------------------------
// CLI dispatch. pip3 <cmd> ...  Returns {stdout, stderr, exitCode}.
async function pipMain(args, ctx) {
  args = Array.isArray(args) ? args : [];
  const env = (ctx && ctx.env) || process.env;
  const site = sitePackagesDir(env);
  const outBuf = [];
  const log = (s) => outBuf.push(s);

  // global flags / no-command
  const first = args.find((a) => a && !a.startsWith('-'));
  if (args.includes('--version') || args.includes('-V') || (!first && args.includes('--version'))) {
    return ok(`pip ${PIP_VERSION} (l-shell pure-python front-end) from ${site} (python 3.13)\n`);
  }
  if (!first) {
    return ok(pipUsage());
  }

  const rest = args.slice(args.indexOf(first) + 1);

  switch (first) {
    case 'install':  return pipInstall(rest, site, env, log, outBuf);
    case 'uninstall':return pipUninstall(rest, site);
    case 'list':     return pipList(site, rest);
    case 'show':     return pipShow(site, rest);
    case 'download': return err(`pip download: not supported (use \`pip install\`; this front-end fetches wheels on install only)\n`, 2);
    case 'freeze':   return pipFreeze(site);
    case 'help':     return ok(pipUsage());
    default:
      return err(`ERROR: unknown command "${first}"\n${pipUsage()}`, 2);
  }
}

async function pipInstall(rest, site, env, log, outBuf) {
  // parse specs (ignore common flags we can honor as no-ops or reject clearly)
  const specs = [];
  let reqFile = null;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '-r' || a === '--requirement') { reqFile = rest[++i]; continue; }
    if (a === '-U' || a === '--upgrade' || a === '--no-deps' || a === '--user' ||
        a === '-q' || a === '--quiet' || a === '--no-cache-dir' || a === '--disable-pip-version-check') continue;
    if (a && a.startsWith('-')) continue;      // unknown flag: ignore (best-effort surface)
    specs.push(a);
  }
  const noDeps = rest.includes('--no-deps');

  if (reqFile) {
    try {
      const txt = fs.readFileSync(path.resolve((env && env.PWD) || process.cwd(), reqFile), 'utf8');
      for (const line of txt.split('\n')) {
        const s = line.replace(/#.*$/, '').trim();
        if (s) specs.push(s.split(/[<>=!~ ]/)[0]);
      }
    } catch (e) {
      return err(`ERROR: could not open requirements file ${reqFile}: ${e.message}\n`, 1);
    }
  }
  if (!specs.length) return err('ERROR: You must give at least one requirement to install.\n', 1);

  // strip version pins from specs (we always resolve latest pure wheel)
  const rootNames = specs.map((s) => s.split(/[<>=!~ ]/)[0]).filter(Boolean);

  let closure;
  // --no-deps: resolve ONLY the roots, do not descend into (or block on) their deps.
  try { closure = await resolveClosure(rootNames, { noDeps }); }
  catch (e) { return err(`ERROR: resolution failed: ${e.message}\n`, 1); }

  const toInstall = closure.order;

  if (closure.blocked.length) {
    // HARD WALL. Honest, actionable error. Separate "not found" from "compiled extension".
    const notFound = closure.blocked.filter((b) => b.notFound);
    const compiled = closure.blocked.filter((b) => !b.notFound);
    const lines = [];
    if (notFound.length) {
      lines.push('ERROR: could not find the following on PyPI:');
      for (const b of notFound) {
        const via = b.path.length > 1 ? '  (pulled in via ' + b.path.join(' -> ') + ')' : '';
        lines.push(`  - ${b.name}: ${b.reason}${via}`);
      }
    }
    if (compiled.length) {
      if (notFound.length) lines.push('');
      lines.push('ERROR: cannot install — the following require a compiled C/Rust extension,');
      lines.push('which this on-device runtime cannot build or load (no compiler, no exec):');
      for (const b of compiled) {
        const via = b.path.length > 1 ? '  (pulled in via ' + b.path.join(' -> ') + ')' : '';
        lines.push(`  - ${b.name}: ${b.reason}${via}`);
      }
    }
    const pure = closure.order.filter((r) => !closure.blocked.some((b) => normalize(b.name) === r.key));
    if (pure.length) {
      lines.push('');
      lines.push('These pure-Python packages in the request WOULD install:');
      for (const r of pure) lines.push(`  + ${r.name}@${r.ver}`);
      lines.push('but the install is aborted because the dependency set is incomplete.');
    }
    if (compiled.length) {
      lines.push('');
      lines.push('Only pure-Python wheels (tagged *-none-any) can be installed on this device.');
    }
    return err(lines.join('\n') + '\n', 1);
  }

  // download + unpack each
  const installed = [];
  for (const rec of toInstall) {
    try {
      await installWheel(rec, site, log);
      installed.push(rec);
    } catch (e) {
      return err(outBuf.join('\n') + (outBuf.length ? '\n' : '') +
        `ERROR: failed installing ${rec.name}@${rec.ver}: ${e.message}\n`, 1);
    }
  }

  const summary = 'Successfully installed ' + installed.map((r) => r.name + '-' + r.ver).join(' ') + '\n';
  return ok(outBuf.join('\n') + (outBuf.length ? '\n' : '') + summary);
}

function pipUninstall(rest, site) {
  const names = rest.filter((a) => a && !a.startsWith('-'));
  if (!names.length) return err('ERROR: You must give at least one requirement to uninstall.\n', 1);
  const out = [];
  let any = false;
  for (const n of names) {
    const r = uninstallPackage(site, n);
    if (r) { out.push(`  Successfully uninstalled ${r.name}-${r.version}`); any = true; }
    else out.push(`  WARNING: Skipping ${n} as it is not installed.`);
  }
  return { stdout: out.join('\n') + '\n', stderr: '', exitCode: any ? 0 : 1 };
}

function pipList(site, rest) {
  const pkgs = listInstalled(site);
  if (rest.includes('--format=freeze')) return pipFreeze(site);
  if (!pkgs.length) return ok('');
  const nameW = Math.max(7, ...pkgs.map((p) => p.name.length));
  const verW = Math.max(7, ...pkgs.map((p) => String(p.version).length));
  const lines = [];
  lines.push('Package'.padEnd(nameW) + ' ' + 'Version'.padEnd(verW));
  lines.push('-'.repeat(nameW) + ' ' + '-'.repeat(verW));
  for (const p of pkgs) lines.push(p.name.padEnd(nameW) + ' ' + String(p.version).padEnd(verW));
  return ok(lines.join('\n') + '\n');
}

function pipFreeze(site) {
  const pkgs = listInstalled(site);
  return ok(pkgs.map((p) => `${p.name}==${p.version}`).join('\n') + (pkgs.length ? '\n' : ''));
}

function pipShow(site, rest) {
  const names = rest.filter((a) => a && !a.startsWith('-'));
  if (!names.length) return err('ERROR: Please provide a package name or names.\n', 1);
  const blocks = [];
  const missing = [];
  for (const n of names) {
    const s = showPackage(site, n);
    if (!s) { missing.push(n); continue; }
    const f = s.fields;
    blocks.push(
      `Name: ${f.Name || s.info.name}\n` +
      `Version: ${f.Version || s.info.version}\n` +
      `Summary: ${f.Summary || ''}\n` +
      `Home-page: ${f['Home-page'] || ''}\n` +
      `Author: ${f.Author || ''}\n` +
      `License: ${f.License || ''}\n` +
      `Location: ${site}\n` +
      `Requires: ${(f['Requires-Dist'] ? f['Requires-Dist'] : '')}`);
  }
  let stderr = '';
  if (missing.length) stderr = missing.map((n) => `WARNING: Package(s) not found: ${n}`).join('\n') + '\n';
  return { stdout: blocks.join('\n---\n') + (blocks.length ? '\n' : ''), stderr, exitCode: blocks.length ? 0 : 1 };
}

function pipUsage() {
  return [
    'pip <command> [options]   (l-shell pure-python front-end)',
    '',
    'Commands:',
    '  install    Install pure-Python packages (wheels tagged *-none-any) from PyPI.',
    '  uninstall  Remove installed packages.',
    '  list       List installed packages.',
    '  show       Show details about installed packages.',
    '  freeze     Output installed packages in requirements format.',
    '',
    'Note: packages with compiled C/Rust extensions cannot be installed on this device',
    '(no compiler, no exec). Only pure-Python wheels are supported.',
    '',
  ].join('\n');
}

function ok(stdout) { return { stdout, stderr: '', exitCode: 0 }; }
function err(stderr, code) { return { stdout: '', stderr, exitCode: code == null ? 1 : code }; }

module.exports = {
  pipMain, PIP_VERSION, sitePackagesDir,
  // exported for tests / reuse:
  pickPureWheel, resolveClosure, evalMarker, parseRequiresDist, fetchMeta, installWheel, listInstalled,
};
