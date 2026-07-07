'use strict';
// tmp-map: redirect the classic UNIX temp roots (/tmp, /var/tmp, …) onto a
// container-writable directory. iOS sandboxes the app so ONLY the app's own
// container is writable — the literal /tmp (and its /private symlink twins) are
// read-only. Claude Code and the tools it drives (git clone `cd /tmp`, mktemp,
// build scratch) assume a writable /tmp; without a redirect they hit
// `ENOENT: mkdir '/tmp/.../.git'` and abort.
//
// The mapping is applied at the fs boundary (PassthroughFs._real for just-bash,
// and git-command's raw node fs paths). Both share THIS module so the prefix set
// and — critically — the double-map safety guard stay identical.

const path = require('node:path');

// Classic temp roots we redirect. Segment-boundary matched (see _underPrefix):
// `/tmp` matches `/tmp` and `/tmp/x`, never `/tmpfoo`. `/private/var/tmp` and
// `/private/tmp` are the macOS/iOS symlink-resolved twins of `/var/tmp` /`/tmp`.
const TMP_PREFIXES = ['/tmp', '/var/tmp', '/private/tmp', '/private/var/tmp'];

// Resolve the container-writable target once. Order:
//  1) explicit override (arg) — used by tests / callers that already know it
//  2) LSHELL_TMPDIR / TMPDIR / TMP / TEMP env (we point these at the container)
//  3) os.tmpdir() — nodejs-mobile returns the app container's tmp on iOS
// Never returns a classic /tmp prefix (that would defeat the whole point); if the
// resolved value is itself a classic root we fall through to os.tmpdir().
function resolveTarget(override) {
  const os = require('node:os');
  const candidates = [
    override,
    process.env.LSHELL_TMPDIR,
    process.env.TMPDIR,
    process.env.TMP,
    process.env.TEMP,
  ];
  for (let c of candidates) {
    if (!c) continue;
    c = stripTrailingSlash(path.normalize(String(c)));
    if (c && !_underAnyPrefix(c)) return c;
  }
  let t = stripTrailingSlash(path.normalize(os.tmpdir()));
  return t;
}

function stripTrailingSlash(p) {
  if (p.length > 1 && p.endsWith('/')) return p.replace(/\/+$/, '') || '/';
  return p;
}

// True iff `abs` == prefix or lives under prefix + '/'. Segment boundary only.
function _underPrefix(abs, prefix) {
  return abs === prefix || abs.startsWith(prefix + '/');
}
function _underAnyPrefix(abs) {
  for (const p of TMP_PREFIXES) if (_underPrefix(abs, p)) return true;
  return false;
}

// Map an ALREADY-ABSOLUTE, ALREADY-NORMALIZED path. If it lives under a classic
// temp root, rewrite that root to `target`; otherwise return it untouched.
//
// SAFETY GUARD (load-bearing — do not remove): if `abs` is already inside the
// target container tmp, return it verbatim. Two ways this matters:
//   (a) `target` may itself sit under a matched TMP_PREFIX (e.g. if a device puts
//       the container tmp under /private/var/tmp/...). Without the guard we'd
//       re-map target-rooted paths, doubling the prefix → /target/tmp/target/tmp/…
//       → ENOENT. On iOS this is exactly the dir Claude Code writes its own
//       stream/output files to, so a double-map SILENTLY BREAKS OUTPUT DELIVERY.
//   (b) Idempotency: mapping an already-mapped path is a no-op, so callers can
//       apply map twice without corruption.
function mapTmpAbs(abs, target) {
  // Guard FIRST, before any prefix rewrite.
  if (abs === target || abs.startsWith(target + '/')) return abs;
  for (const prefix of TMP_PREFIXES) {
    if (_underPrefix(abs, prefix)) {
      const rest = abs.slice(prefix.length); // '' or '/...'
      return target + rest;
    }
  }
  return abs;
}

// Convenience: normalize (if needed) then map. `p` may be relative-resolved by
// the caller beforehand; we only normalize.
function mapMaybe(p, target) {
  if (!target) return p;
  const abs = path.isAbsolute(p) ? path.normalize(p) : p;
  if (!path.isAbsolute(abs)) return p; // leave relative paths to the caller's resolve
  return mapTmpAbs(abs, target);
}

module.exports = {
  TMP_PREFIXES,
  resolveTarget,
  mapTmpAbs,
  mapMaybe,
  _underPrefix,
  _underAnyPrefix,
  stripTrailingSlash,
};
