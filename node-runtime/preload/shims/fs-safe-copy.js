'use strict';
// fs safe-copy shim for iOS (nodejs-mobile).
//
// ROOT CAUSE: libuv v18's uv__fs_copyfile() (deps/uv/src/unix/fs.c) has NO
// Darwin fcopyfile() fast path — the generic Unix branch ALWAYS copies bytes
// via uv_fs_sendfile() -> the BSD sendfile(2) syscall. iOS's sandbox forbids
// sendfile(2): invoking it raises SIGSYS ("Bad system call: 12") and kills the
// whole app. Confirmed by ClaudeTerminal-2026-07-06-145248.ips:
//   sendfile -> uv__fs_work -> node::fs::CopyFile.
// Every fs.copyFile / copyFileSync / cp / cpSync / promises.copyFile / promises.cp
// on a NON-EMPTY file hits this. (Empty files skip the loop `while (size != 0)`,
// which is why the crash is intermittent.)
//
// FIX: reimplement copyFile* in pure JS using open/read/write (never
// binding.copyFile). All higher-level copies (cp/cpSync) route through these,
// so the sendfile syscall is never reached.
//
// Semantics preserved:
//   * mode flags: COPYFILE_EXCL (fail if dest exists), COPYFILE_FICLONE
//     (best-effort clone -> plain copy is a valid fallback), COPYFILE_FICLONE_FORCE
//     (must hard-fail with ENOSYS when a real reflink is impossible — matches
//     libuv which returns ENOSYS on Darwin for FICLONE_FORCE).
//   * destination file mode copied from source (like libuv's fchmod(src.mode)).
//   * argument shapes: copyFile(src, dest[, mode], cb) and the promises form.

const fs = require('node:fs');

// fs.constants may be undefined very early; read defensively with known values.
const C = (fs.constants && fs.constants) || {};
const COPYFILE_EXCL = C.COPYFILE_EXCL != null ? C.COPYFILE_EXCL : 1;
const COPYFILE_FICLONE = C.COPYFILE_FICLONE != null ? C.COPYFILE_FICLONE : 2;
const COPYFILE_FICLONE_FORCE = C.COPYFILE_FICLONE_FORCE != null ? C.COPYFILE_FICLONE_FORCE : 4;

const CHUNK = 64 * 1024;

function normalizeMode(mode) {
  if (mode == null) return 0;
  if (typeof mode === 'number') return mode;
  const n = Number(mode);
  return Number.isFinite(n) ? n : 0;
}

function ficloneForceError(path) {
  // libuv returns UV_ENOSYS for FICLONE_FORCE when a reflink can't be made.
  const err = new Error(`ENOSYS: function not implemented, copyfile '${path}'`);
  err.code = 'ENOSYS';
  err.errno = -78;
  err.syscall = 'copyfile';
  err.path = path;
  return err;
}

// ---- sync ------------------------------------------------------------------
function copyFileSync(src, dest, mode) {
  mode = normalizeMode(mode);
  if (mode & COPYFILE_FICLONE_FORCE) throw ficloneForceError(src);

  const srcFd = fs.openSync(src, 'r');
  try {
    const st = fs.fstatSync(srcFd);
    // 'wx' == O_WRONLY|O_CREAT|O_EXCL ; 'w' == O_WRONLY|O_CREAT|O_TRUNC.
    const destFlags = (mode & COPYFILE_EXCL) ? 'wx' : 'w';
    const destFd = fs.openSync(dest, destFlags, st.mode);
    try {
      const buf = Buffer.allocUnsafe(CHUNK);
      let pos = 0;
      while (true) {
        const bytesRead = fs.readSync(srcFd, buf, 0, CHUNK, pos);
        if (bytesRead === 0) break;
        let written = 0;
        while (written < bytesRead) {
          written += fs.writeSync(destFd, buf, written, bytesRead - written, pos + written);
        }
        pos += bytesRead;
      }
      // Match libuv: destination takes the source's permission bits.
      try { fs.fchmodSync(destFd, st.mode & 0o777); } catch {}
    } finally {
      fs.closeSync(destFd);
    }
  } finally {
    fs.closeSync(srcFd);
  }
}

// ---- async (callback) ------------------------------------------------------
function copyFile(src, dest, mode, callback) {
  if (typeof mode === 'function') { callback = mode; mode = 0; }
  mode = normalizeMode(mode);
  if (typeof callback !== 'function') callback = () => {};

  if (mode & COPYFILE_FICLONE_FORCE) {
    return process.nextTick(callback, ficloneForceError(src));
  }

  // Streams over open fds; honor EXCL and copy source mode. Uses only
  // read/write/open — never binding.copyFile / sendfile.
  fs.open(src, 'r', (e1, srcFd) => {
    if (e1) return callback(e1);
    fs.fstat(srcFd, (e2, st) => {
      if (e2) { fs.close(srcFd, () => callback(e2)); return; }
      const destFlags = (mode & COPYFILE_EXCL) ? 'wx' : 'w';
      fs.open(dest, destFlags, st.mode, (e3, destFd) => {
        if (e3) { fs.close(srcFd, () => callback(e3)); return; }
        const rs = fs.createReadStream(null, { fd: srcFd, autoClose: false });
        const ws = fs.createWriteStream(null, { fd: destFd, autoClose: false });
        let done = false;
        const finish = (err) => {
          if (done) return; done = true;
          // Close both fds regardless of outcome.
          fs.close(srcFd, () => {
            const afterChmod = () => fs.close(destFd, () => callback(err || null));
            if (!err) fs.fchmod(destFd, st.mode & 0o777, () => afterChmod());
            else afterChmod();
          });
        };
        rs.on('error', finish);
        ws.on('error', finish);
        ws.on('finish', () => finish(null));
        rs.pipe(ws);
      });
    });
  });
}

// ---- promises --------------------------------------------------------------
function copyFilePromise(src, dest, mode) {
  return new Promise((resolve, reject) => {
    copyFile(src, dest, mode, (err) => (err ? reject(err) : resolve()));
  });
}

// ---- cp / cpSync (defensive re-implementation) -----------------------------
// On Node 18 fs.cp / fs.cpSync route through fs.copyFile / fs.copyFileSync, so
// patching those already fixes them. But on Node >= 22/24 cpSync uses a native
// fast path (cpSyncCheckPaths + an internal copy that bypasses the JS copyFile),
// which could reach sendfile independently. To be version-proof we reimplement
// cp/cpSync with a plain recursive walk over our own copyFile primitives. This
// intentionally supports the common, load-bearing options (recursive, force,
// errorOnExist, dereference, preserveTimestamps, filter) rather than every edge.
const nodePath = require('node:path');

function shouldCopy(filter, src, dest) {
  if (typeof filter !== 'function') return true;
  return filter(src, dest);
}

function cpSyncImpl(src, dest, opts) {
  opts = opts || {};
  if (!shouldCopy(opts.filter, src, dest)) return;
  const st = opts.dereference ? fs.statSync(src) : fs.lstatSync(src);

  if (st.isDirectory()) {
    if (!opts.recursive) {
      const e = new Error(`EISDIR: illegal operation on a directory, cp '${src}'`);
      e.code = 'ERR_FS_EISDIR'; throw e;
    }
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      cpSyncImpl(nodePath.join(src, entry), nodePath.join(dest, entry), opts);
    }
    try { fs.chmodSync(dest, st.mode & 0o777); } catch {}
    return;
  }

  if (st.isSymbolicLink() && !opts.dereference) {
    const link = fs.readlinkSync(src);
    try { fs.unlinkSync(dest); } catch {}
    fs.symlinkSync(link, dest);
    return;
  }

  // Regular file: honor force / errorOnExist.
  let destExists = false;
  try { fs.lstatSync(dest); destExists = true; } catch {}
  if (destExists) {
    if (opts.errorOnExist) {
      const e = new Error(`ERR_FS_CP_EEXIST: ${dest} already exists`); e.code = 'ERR_FS_CP_EEXIST'; throw e;
    }
    if (opts.force === false) return; // skip
    try { fs.unlinkSync(dest); } catch {}
  }
  const mode = opts.errorOnExist ? COPYFILE_EXCL : 0;
  copyFileSync(src, dest, mode);
  if (opts.preserveTimestamps) {
    try { fs.utimesSync(dest, st.atime, st.mtime); } catch {}
  }
}

async function cpImpl(src, dest, opts) {
  // Async recursion built on the sync stat calls but our async copyFile for the
  // byte copy; simplest correct form is to await the sync walk's file copies.
  opts = opts || {};
  if (!shouldCopy(opts.filter, src, dest)) return;
  const st = opts.dereference ? fs.statSync(src) : fs.lstatSync(src);
  if (st.isDirectory()) {
    if (!opts.recursive) { const e = new Error(`EISDIR: cp '${src}'`); e.code = 'ERR_FS_EISDIR'; throw e; }
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      await cpImpl(nodePath.join(src, entry), nodePath.join(dest, entry), opts);
    }
    try { fs.chmodSync(dest, st.mode & 0o777); } catch {}
    return;
  }
  if (st.isSymbolicLink() && !opts.dereference) {
    const link = fs.readlinkSync(src);
    try { fs.unlinkSync(dest); } catch {}
    fs.symlinkSync(link, dest);
    return;
  }
  let destExists = false;
  try { fs.lstatSync(dest); destExists = true; } catch {}
  if (destExists) {
    if (opts.errorOnExist) { const e = new Error(`ERR_FS_CP_EEXIST: ${dest}`); e.code = 'ERR_FS_CP_EEXIST'; throw e; }
    if (opts.force === false) return;
    try { fs.unlinkSync(dest); } catch {}
  }
  await copyFilePromise(src, dest, opts.errorOnExist ? COPYFILE_EXCL : 0);
  if (opts.preserveTimestamps) { try { fs.utimesSync(dest, st.atime, st.mtime); } catch {} }
}

function cpSync(src, dest, opts) {
  cpSyncImpl(String(src), String(dest), opts || {});
}
function cp(src, dest, opts, callback) {
  if (typeof opts === 'function') { callback = opts; opts = {}; }
  if (typeof callback !== 'function') callback = () => {};
  cpImpl(String(src), String(dest), opts || {}).then(() => callback(null), (e) => callback(e));
}
function cpPromise(src, dest, opts) {
  return cpImpl(String(src), String(dest), opts || {});
}

// ---- install ---------------------------------------------------------------
// Overwrite the native-backed exports in place so every importer sees the safe
// versions. fs.cp / fs.cpSync / promises.cp are left as-is: on Node 18 they call
// these copyFile/copyFileSync primitives internally, so they inherit the fix. We
// still re-run through require caches to be sure destructured imports pick it up.
function install() {
  try {
    fs.copyFileSync = copyFileSync;
    fs.copyFile = copyFile;
    fs.cpSync = cpSync;
    fs.cp = cp;

    const fsp = fs.promises;
    if (fsp && typeof fsp.copyFile === 'function') fsp.copyFile = copyFilePromise;
    if (fsp && typeof fsp.cp === 'function') fsp.cp = cpPromise;

    // Keep node:fs and fs module objects consistent (same object in practice,
    // but be defensive across require variants).
    try {
      const mfs = require('fs');
      mfs.copyFileSync = copyFileSync;
      mfs.copyFile = copyFile;
      mfs.cpSync = cpSync;
      mfs.cp = cp;
    } catch {}
    try {
      const mfsp = require('fs/promises');
      if (mfsp && typeof mfsp.copyFile === 'function') mfsp.copyFile = copyFilePromise;
      if (mfsp && typeof mfsp.cp === 'function') mfsp.cp = cpPromise;
    } catch {}

    if (process.env.CLAUDE_IOS_DEBUG) {
      process.stderr.write('[fs-safe-copy] installed (copyFile/copyFileSync/cp/cpSync/promises.copyFile/promises.cp patched)\n');
    }
  } catch (e) {
    if (process.env.CLAUDE_IOS_DEBUG) process.stderr.write('[fs-safe-copy] install failed: ' + (e && e.message) + '\n');
  }
}

module.exports = { install, copyFile, copyFileSync, copyFilePromise, cp, cpSync, cpPromise, _internal: { CHUNK } };
