'use strict';
// PassthroughFs: a just-bash IFileSystem backed by the REAL filesystem using REAL
// absolute paths (no virtual re-rooting). This is what makes just-bash's Bash/rg/grep
// operate on the same files as Claude Code's node:fs-based Read/Write/Edit tools —
// one shared namespace. On iOS the OS sandbox enforces the boundary; we add a soft
// allow-root check as defense-in-depth.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { resolveTarget, mapTmpAbs } = require('./tmp-map.js');

class PassthroughFs {
  constructor(opts = {}) {
    // Default base for resolving relative paths; not a hard jail (sandbox is).
    this.cwd = opts.cwd || '/';
    this.allowedRoots = opts.allowedRoots || null; // optional soft boundary
    this.maxFileReadSize = opts.maxFileReadSize || 50 * 1024 * 1024;
    // Container-writable dir that classic /tmp roots redirect onto. Resolved once
    // (env TMPDIR/TMP/TEMP → os.tmpdir()). opts.tmpTarget lets tests pin it.
    this.tmpTarget = opts.tmpTarget || resolveTarget();
  }

  // just-bash's registerCommand() writes a `#!/bin/bash` stub to /bin/<name> and
  // /usr/bin/<name> via writeFileSync so PATH resolution can find the builtin. Our
  // fs was async-only, so no stub was written → registered commands (e.g. our `node`)
  // resolved unreliably. Serve those stub paths from an in-memory set — never touch
  // the host's real /bin (which the simulator would otherwise clobber).
  _isStubPath(p) {
    const n = path.normalize(String(p));
    return n.startsWith('/bin/') || n.startsWith('/usr/bin/');
  }

  writeFileSync(p, content) {
    if (this._isStubPath(p)) { (this._stubs || (this._stubs = new Set())).add(path.normalize(String(p))); return; }
    fs.writeFileSync(this._real(p), content);
  }

  _real(p) {
    let abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(this.cwd, p);
    // Redirect classic temp roots (/tmp, /var/tmp, …) onto the container-writable
    // dir. mapTmpAbs guards target-rooted paths against double-mapping (see tmp-map.js).
    if (this.tmpTarget) abs = mapTmpAbs(abs, this.tmpTarget);
    if (this.allowedRoots && !this.allowedRoots.some((r) => abs === r || abs.startsWith(r + path.sep))) {
      const e = new Error(`EACCES: path outside allowed roots: ${abs}`);
      e.code = 'EACCES';
      throw e;
    }
    return abs;
  }

  resolvePath(base, p) {
    if (path.isAbsolute(p)) return path.normalize(p);
    return path.resolve(base || this.cwd, p);
  }

  async readFile(p, options) {
    const enc = typeof options === 'string' ? options : (options && options.encoding);
    const buf = await fsp.readFile(this._real(p));
    return enc && enc !== 'binary' && enc !== 'latin1' ? buf.toString(enc) : buf.toString('utf8');
  }

  async readFileBuffer(p) {
    const buf = await fsp.readFile(this._real(p));
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  async writeFile(p, content, options) {
    const enc = typeof options === 'string' ? options : (options && options.encoding);
    const data = typeof content === 'string' ? Buffer.from(content, enc || 'utf8') : Buffer.from(content);
    await fsp.writeFile(this._real(p), data);
  }

  async appendFile(p, content, options) {
    const enc = typeof options === 'string' ? options : (options && options.encoding);
    const data = typeof content === 'string' ? Buffer.from(content, enc || 'utf8') : Buffer.from(content);
    await fsp.appendFile(this._real(p), data);
  }

  async exists(p) {
    if (this._stubs && this._stubs.has(path.normalize(String(p)))) return true;
    try { await fsp.access(this._real(p)); return true; } catch { return false; }
  }

  _toFsStat(s) {
    return {
      isFile: s.isFile(), isDirectory: s.isDirectory(), isSymbolicLink: s.isSymbolicLink(),
      mode: s.mode, size: s.size, mtime: s.mtime,
    };
  }
  async stat(p) {
    if (this._stubs && this._stubs.has(path.normalize(String(p)))) {
      return { isFile: true, isDirectory: false, isSymbolicLink: false, mode: 0o755, size: 0, mtime: new Date() };
    }
    return this._toFsStat(await fsp.stat(this._real(p)));
  }
  async lstat(p) { return this._toFsStat(await fsp.lstat(this._real(p))); }

  async mkdir(p, options) { await fsp.mkdir(this._real(p), { recursive: !!(options && options.recursive) }); }

  async readdir(p) { return fsp.readdir(this._real(p)); }

  async readdirWithFileTypes(p) {
    const ents = await fsp.readdir(this._real(p), { withFileTypes: true });
    return ents.map((e) => ({
      name: e.name, isFile: e.isFile(), isDirectory: e.isDirectory(), isSymbolicLink: e.isSymbolicLink(),
    }));
  }

  async rm(p, options) {
    await fsp.rm(this._real(p), { recursive: !!(options && options.recursive), force: !!(options && options.force) });
  }

  async cp(src, dest, options) {
    await fsp.cp(this._real(src), this._real(dest), { recursive: !!(options && options.recursive), force: true });
  }

  async mv(src, dest) { await fsp.rename(this._real(src), this._real(dest)); }

  async chmod(p, mode) { await fsp.chmod(this._real(p), mode); }
  async symlink(target, linkPath) { await fsp.symlink(target, this._real(linkPath)); }
  async link(existingPath, newPath) { await fsp.link(this._real(existingPath), this._real(newPath)); }
  async readlink(p) { return fsp.readlink(this._real(p)); }
  async realpath(p) { return fsp.realpath(this._real(p)); }
  async utimes(p, atime, mtime) { await fsp.utimes(this._real(p), atime, mtime); }

  // Whole-fs enumeration is unbounded on a real fs; commands that need it (rare)
  // do their own walking. Return empty to avoid traversing the entire device.
  getAllPaths() { return []; }
}

module.exports = { PassthroughFs };
