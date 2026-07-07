'use strict';
// in-process npm install PoC for jitless nodejs-mobile
// - registry via node:https  - gunzip via node:zlib (native C++, jitless-safe)
// - tar extract via tar-stream (pure JS, CommonJS)  - semver for range resolution
// NO wasm, NO child_process, NO fork/exec.
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const tar = require('tar-stream');
const semver = require('semver');

const REGISTRY = 'https://registry.npmjs.org';
const UA = 'lshell-inpm/0.1';

function fetchBuf(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'user-agent': UA, accept: '*/*' } }, (r) => {
      // follow one redirect (registry tarballs sometimes 3xx)
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        r.resume();
        return resolve(fetchBuf(r.headers.location));
      }
      if (r.statusCode !== 200) { r.resume(); return reject(new Error('HTTP ' + r.statusCode + ' ' + url)); }
      const d = [];
      r.on('data', (c) => d.push(c));
      r.on('end', () => resolve(Buffer.concat(d)));
    }).on('error', reject);
  });
}

async function fetchMeta(name) {
  const buf = await fetchBuf(REGISTRY + '/' + name.replace('/', '%2f'));
  return JSON.parse(buf.toString('utf8'));
}

// resolve a semver range against a packument -> chosen version object
function pickVersion(meta, range) {
  const versions = Object.keys(meta.versions);
  if (!range || range === 'latest' || range === '*') {
    const lt = meta['dist-tags'] && meta['dist-tags'].latest;
    if (lt && meta.versions[lt]) return meta.versions[lt];
    range = '*';
  }
  if (meta['dist-tags'] && meta['dist-tags'][range]) return meta.versions[meta['dist-tags'][range]];
  const max = semver.maxSatisfying(versions, range, { includePrerelease: false });
  if (!max) throw new Error('no version of ' + meta.name + ' satisfies ' + range);
  return meta.versions[max];
}

// extract a .tgz buffer into destDir, stripping the leading "package/" prefix
function extractTgz(tgzBuf, destDir) {
  return new Promise((resolve, reject) => {
    const gunzipped = zlib.gunzipSync(tgzBuf); // native, sync, jitless-safe
    const extract = tar.extract();
    extract.on('entry', (header, stream, next) => {
      // strip first path segment ("package/")
      const rel = header.name.replace(/^[^/]+\//, '');
      if (!rel || header.type === 'directory') { stream.resume(); stream.on('end', next); return; }
      const outPath = path.join(destDir, rel);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => {
        fs.writeFileSync(outPath, Buffer.concat(chunks), { mode: header.mode || 0o644 });
        next();
      });
      stream.on('error', reject);
    });
    extract.on('finish', resolve);
    extract.on('error', reject);
    extract.end(gunzipped);
  });
}

// versionOf: read installed version from an unpacked package dir (or null)
function installedVersion(pkgDir) {
  try { return JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version || null; }
  catch { return null; }
}

// caretRange: how npm records a freshly-installed version in package.json.
// Mirrors default save-prefix "^": ^1.2.3, but 0.x stays exact-ish per semver.
function caretRange(version) {
  if (!version || !semver.valid(version)) return version || '*';
  return '^' + version;
}

// recursive installer with a global dedupe cache (flat-ish, hoist to top node_modules)
async function install(rootDir, specs, opts = {}) {
  const log = opts.log || (() => {});
  const warn = opts.onWarn || (() => {});
  const installed = new Map(); // name -> version installed at top level
  const added = [];   // names actually written this run (for "added N packages")
  const skipped = []; // names already present that satisfied the range
  const chosen = new Map(); // name -> version chosen for DIRECT specs (for --save)
  const metaCache = new Map();
  const topNM = path.join(rootDir, 'node_modules');
  fs.mkdirSync(topNM, { recursive: true });

  // Seed the dedupe cache with what is already on disk so re-installs are idempotent
  // and transitive deps that are already present are not re-fetched.
  if (opts.reuseExisting !== false) {
    try {
      for (const d of fs.readdirSync(topNM)) {
        if (d.startsWith('.')) continue;
        if (d.startsWith('@')) {
          for (const s of fs.readdirSync(path.join(topNM, d))) {
            const v = installedVersion(path.join(topNM, d, s));
            if (v) installed.set(d + '/' + s, v);
          }
        } else {
          const v = installedVersion(path.join(topNM, d));
          if (v) installed.set(d, v);
        }
      }
    } catch { /* no node_modules yet */ }
  }

  async function getMeta(name) {
    if (metaCache.has(name)) return metaCache.get(name);
    const m = await fetchMeta(name);
    metaCache.set(name, m);
    return m;
  }

  async function resolveOne(name, range, depth) {
    const existing = installed.get(name);
    if (existing) {
      // Already installed (on disk or earlier this run). Skip if it satisfies the
      // requested range; otherwise keep the existing copy and warn (flat install:
      // we do not create nested node_modules for conflicting versions).
      const sat = !range || range === 'latest' || range === '*' || semver.satisfies(existing, range, { includePrerelease: true });
      if (sat) {
        if (depth === 0) { chosen.set(name, existing); log('  = ' + name + '@' + existing + ' (already installed)'); }
        return;
      }
      warn('version conflict for ' + name + ': ' + existing + ' installed but ' + range +
        ' requested — keeping ' + existing + ' (flat install cannot nest a second copy).');
      log('  ! ' + name + ' ' + existing + ' vs ' + range + ' — kept ' + existing);
      if (depth === 0) chosen.set(name, existing);
      return;
    }
    const meta = await getMeta(name);
    const ver = pickVersion(meta, range);
    installed.set(name, ver.version);
    if (depth === 0) chosen.set(name, ver.version);
    added.push(name);
    const dest = path.join(topNM, name);
    // metadata-driven capability warnings (native addon / lifecycle scripts / os-lock)
    const s = ver.scripts || {};
    const lifecycle = ['preinstall', 'install', 'postinstall'].filter((k) => s[k]);
    const nativeDeps = ['node-gyp', 'node-pre-gyp', '@mapbox/node-pre-gyp', 'prebuild-install', 'node-gyp-build']
      .filter((d) => (ver.dependencies && ver.dependencies[d]) || (ver.optionalDependencies && ver.optionalDependencies[d]));
    let tag = '';
    if (ver.binary || nativeDeps.length) {
      warn(name + '@' + ver.version + ' expects a native binary/addon — cannot build (no compiler/exec on device). Package files written but native module will fail to load.');
      tag += '  [native addon: unsupported]';
    }
    if (lifecycle.length && opts.skipScripts) {
      warn(name + '@' + ver.version + ' has lifecycle script(s) ' + JSON.stringify(lifecycle) + ' — skipped (no exec).');
      tag += '  [scripts skipped]';
    }
    if (ver.os && ver.os.length && !ver.os.includes('darwin') && !ver.os.includes('ios')) {
      warn(name + '@' + ver.version + ' declares os ' + JSON.stringify(ver.os) + ' — may not run here.');
    }
    log('  + ' + name + '@' + ver.version + tag);
    const tgz = await fetchBuf(ver.dist.tarball);
    // integrity check (sha1 in dist.shasum / sha512 in dist.integrity)
    if (ver.dist.shasum) {
      const got = require('crypto').createHash('sha1').update(tgz).digest('hex');
      if (got !== ver.dist.shasum) throw new Error('integrity mismatch for ' + name + '@' + ver.version);
    }
    fs.mkdirSync(dest, { recursive: true });
    await extractTgz(tgz, dest);
    // Create node_modules/.bin entries for this package's declared bins so that
    // `npm run` scripts referencing a locally-installed CLI can resolve it via
    // PATH (the run handler prepends node_modules/.bin). We copy the target's
    // relative path into a tiny launcher rather than symlinking, because the iOS
    // sandbox / passthrough-fs does not guarantee symlink support.
    try { linkBins(topNM, name, ver.bin, dest); } catch { /* best-effort */ }
    // recurse into runtime deps
    const deps = ver.dependencies || {};
    for (const [dn, dr] of Object.entries(deps)) {
      await resolveOne(dn, dr, depth + 1);
    }
  }

  for (const [name, range] of Object.entries(specs)) {
    await resolveOne(name, range, 0);
  }

  // Optionally persist to package.json (npm's default is --save to dependencies).
  let savedTo = null;
  if (opts.save && opts.save !== 'none') {
    const field = opts.save === 'dev' ? 'devDependencies'
      : opts.save === 'optional' ? 'optionalDependencies'
      : 'dependencies';
    const pjPath = path.join(rootDir, 'package.json');
    let pj = {};
    try { pj = JSON.parse(fs.readFileSync(pjPath, 'utf8')); } catch { pj = {}; }
    pj[field] = pj[field] || {};
    for (const [name, ver] of chosen.entries()) {
      // Honor an explicit range from the user's spec, else caret the chosen version.
      const explicit = specs[name];
      const rec = (explicit && explicit !== 'latest' && explicit !== '*' && !semver.valid(explicit) && semver.validRange(explicit))
        ? explicit
        : caretRange(ver);
      pj[field][name] = rec;
    }
    // keep dependency maps sorted like npm does
    pj[field] = sortObj(pj[field]);
    fs.writeFileSync(pjPath, JSON.stringify(pj, null, 2) + '\n');
    savedTo = field;
  }

  return {
    installed: Object.fromEntries(installed),
    added,
    skipped,
    direct: Object.fromEntries(chosen),
    savedTo,
  };
}

function sortObj(o) {
  const out = {};
  for (const k of Object.keys(o).sort()) out[k] = o[k];
  return out;
}

// linkBins: materialize node_modules/.bin/<binname> launchers for a package's
// "bin" field. Value can be a string (bin name == package name) or an object.
function linkBins(topNM, pkgName, binField, pkgDir) {
  if (!binField) return;
  const binDir = path.join(topNM, '.bin');
  const map = {};
  if (typeof binField === 'string') {
    map[pkgName.replace(/^@[^/]+\//, '')] = binField;
  } else if (typeof binField === 'object') {
    Object.assign(map, binField);
  }
  const names = Object.keys(map);
  if (!names.length) return;
  fs.mkdirSync(binDir, { recursive: true });
  for (const bn of names) {
    const target = path.join(pkgDir, map[bn]);
    const rel = path.relative(binDir, target);
    const launcher = path.join(binDir, bn);
    // A portable exec-less "launcher": a shell shim that runs the target via node.
    // In this runtime `node` is an in-process builtin, so `.bin/<x>` invoked as a
    // command resolves to `node <target> "$@"` through the shell. We ALSO drop a
    // sibling record so the run handler can map bin->file directly.
    const shim = '#!/bin/sh\nexec node "$(dirname "$0")/' + rel + '" "$@"\n';
    try { fs.writeFileSync(launcher, shim, { mode: 0o755 }); } catch { /* ignore */ }
  }
}

// ---- uninstall -------------------------------------------------------------
// Remove packages from node_modules AND from the package.json dependency maps.
// No lifecycle scripts (npm would run `preuninstall`/`postuninstall`) — none run
// here. Returns { removed:[], missing:[], savedTo }.
function uninstall(rootDir, names, opts = {}) {
  const topNM = path.join(rootDir, 'node_modules');
  const removed = [];
  const missing = [];
  const log = opts.log || (() => {});
  for (const name of names) {
    const dir = path.join(topNM, name);
    if (dirExists(dir)) {
      rmrf(dir);
      // prune an emptied scope dir (@scope/) so `npm ls` stays clean
      if (name.startsWith('@')) {
        const scopeDir = path.join(topNM, name.split('/')[0]);
        try { if (fs.readdirSync(scopeDir).length === 0) fs.rmdirSync(scopeDir); } catch { /* not empty */ }
      }
      // drop any .bin launchers this package owned
      pruneBins(topNM, dir, name);
      removed.push(name);
      log('  - ' + name);
    } else {
      missing.push(name);
    }
  }
  // Update package.json unless caller opted out (npm removes from deps by default).
  let savedTo = null;
  if (opts.save !== false) {
    const pjPath = path.join(rootDir, 'package.json');
    let pj = null;
    try { pj = JSON.parse(fs.readFileSync(pjPath, 'utf8')); } catch { pj = null; }
    if (pj) {
      let touched = false;
      for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
        if (!pj[field]) continue;
        for (const name of names) {
          if (Object.prototype.hasOwnProperty.call(pj[field], name)) {
            delete pj[field][name];
            touched = true;
            savedTo = savedTo || field;
          }
        }
        if (Object.keys(pj[field]).length === 0) delete pj[field];
      }
      if (touched) fs.writeFileSync(pjPath, JSON.stringify(pj, null, 2) + '\n');
    }
  }
  return { removed, missing, savedTo };
}

function pruneBins(topNM, pkgDir, pkgName) {
  const binDir = path.join(topNM, '.bin');
  if (!dirExists(binDir)) return;
  // read the package's bin field before it's gone is impossible here (already rm'd),
  // so best-effort: remove launchers whose relative target points into the removed dir.
  let entries = [];
  try { entries = fs.readdirSync(binDir); } catch { return; }
  for (const e of entries) {
    const p = path.join(binDir, e);
    let body = '';
    try { body = fs.readFileSync(p, 'utf8'); } catch { continue; }
    // launcher body references .../<pkgName>/...
    if (body.includes('/' + pkgName + '/') || body.includes(pkgDir)) {
      try { fs.unlinkSync(p); } catch { /* ignore */ }
    }
  }
  try { if (fs.readdirSync(binDir).length === 0) fs.rmdirSync(binDir); } catch { /* not empty */ }
}

function dirExists(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

// recursive remove without child_process (fs.rmSync on Node 18+, fallback walk)
function rmrf(target) {
  if (fs.rmSync) { fs.rmSync(target, { recursive: true, force: true }); return; }
  let st;
  try { st = fs.lstatSync(target); } catch { return; }
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(target)) rmrf(path.join(target, e));
    fs.rmdirSync(target);
  } else {
    fs.unlinkSync(target);
  }
}

// ---- init -y ---------------------------------------------------------------
// Generate a default package.json (npm init -y). Does not overwrite an existing
// one unless opts.force; merges sensible defaults otherwise.
function initPkg(rootDir, opts = {}) {
  const pjPath = path.join(rootDir, 'package.json');
  const exists = fs.existsSync(pjPath);
  let pj = {};
  if (exists) {
    try { pj = JSON.parse(fs.readFileSync(pjPath, 'utf8')); } catch { pj = {}; }
  }
  const base = path.basename(path.resolve(rootDir)) || 'package';
  const defaults = {
    name: base.toLowerCase().replace(/[^a-z0-9._-]/g, '-'),
    version: '1.0.0',
    description: '',
    main: 'index.js',
    scripts: { test: 'echo "Error: no test specified" && exit 1' },
    keywords: [],
    author: '',
    license: 'ISC',
  };
  const merged = Object.assign({}, defaults, pj);
  // ensure a scripts.test default if none
  if (!merged.scripts) merged.scripts = defaults.scripts;
  fs.writeFileSync(pjPath, JSON.stringify(merged, null, 2) + '\n');
  return { path: pjPath, created: !exists, pkg: merged };
}

// ---- tree (npm ls) ---------------------------------------------------------
// Build a dependency tree rooted at the project, resolving each package's
// declared runtime dependencies against what is actually present in the flat
// top-level node_modules (hoisted install). depth limits recursion (0 = top only).
function buildTree(rootDir, opts = {}) {
  const topNM = path.join(rootDir, 'node_modules');
  const maxDepth = opts.depth == null ? Infinity : opts.depth;
  const readPkg = (dir) => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { return null; }
  };
  const rootPj = readPkg(rootDir) || {};
  const rootDeps = Object.assign({}, rootPj.dependencies,
    opts.production ? {} : rootPj.devDependencies,
    rootPj.optionalDependencies);

  const pkgDir = (name) => path.join(topNM, name);

  function node(name, wantRange, depth, seen) {
    const dir = pkgDir(name);
    const pj = readPkg(dir);
    if (!pj) {
      return { name, version: null, missing: true, invalid: false, wantRange, children: [] };
    }
    const version = pj.version || '?';
    const invalid = wantRange && wantRange !== 'latest' && wantRange !== '*' &&
      semver.validRange(wantRange) && semver.valid(version) &&
      !semver.satisfies(version, wantRange, { includePrerelease: true });
    const out = { name, version, missing: false, invalid: !!invalid, wantRange, children: [], deduped: false };
    if (seen.has(name)) { out.deduped = true; return out; }
    if (depth >= maxDepth) return out;
    const nextSeen = new Set(seen); nextSeen.add(name);
    const deps = pj.dependencies || {};
    for (const [dn, dr] of Object.entries(deps)) {
      out.children.push(node(dn, dr, depth + 1, nextSeen));
    }
    return out;
  }

  const root = {
    name: rootPj.name || path.basename(path.resolve(rootDir)),
    version: rootPj.version || null,
    root: true,
    children: [],
  };
  const seen = new Set();
  for (const [name, range] of Object.entries(rootDeps)) {
    root.children.push(node(name, range, 1, seen));
  }
  return root;
}

// Render a tree (from buildTree) as npm-style ASCII (├──/└──/│).
function renderTree(root) {
  const lines = [];
  lines.push((root.name || 'project') + (root.version ? '@' + root.version : '') + ' ' + (root.rootPath || ''));
  function walk(children, prefix) {
    children.forEach((c, i) => {
      const last = i === children.length - 1;
      const branch = last ? '└── ' : '├── ';
      let label = c.name + '@' + (c.version || 'UNMET');
      if (c.missing) label += ' [MISSING' + (c.wantRange ? ': need ' + c.wantRange : '') + ']';
      else if (c.invalid) label += ' [INVALID: need ' + c.wantRange + ']';
      else if (c.deduped) label += ' deduped';
      lines.push(prefix + branch + label);
      if (c.children && c.children.length && !c.deduped) {
        walk(c.children, prefix + (last ? '    ' : '│   '));
      }
    });
  }
  walk(root.children, '');
  return lines.join('\n');
}

module.exports = {
  install, uninstall, initPkg, buildTree, renderTree,
  fetchMeta, pickVersion, extractTgz, fetchBuf, caretRange,
};

// CLI: node inpm.js <pkg[@range]> [pkg2 ...]  (installs into ./testroot)
if (require.main === module) {
  const args = process.argv.slice(2);
  const root = path.join(__dirname, 'testroot');
  const specs = {};
  for (const a of args) {
    const at = a.lastIndexOf('@');
    if (at > 0) specs[a.slice(0, at)] = a.slice(at + 1);
    else specs[a] = 'latest';
  }
  console.log('installing', JSON.stringify(specs), 'into', root);
  install(root, specs, { log: console.log, skipScripts: true })
    .then((r) => console.log('DONE. top-level tree:', JSON.stringify(r.installed, null, 1)))
    .catch((e) => { console.error('FAIL', e.stack); process.exit(1); });
}
