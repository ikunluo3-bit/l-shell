'use strict';
// Fake-TTY bridge for Ink (Claude Code's TUI). On iOS there is no real pty:
// output bytes flow through process.stdout to the native SwiftTerm view, and
// keystrokes arrive from native pushed into process.stdin. This shim presents the
// TTY surface Ink probes for, and exposes setSize() for the native resize callback.
//
// The surface Ink actually needs (from ink-testing-library's minimal spec):
//   stdout: isTTY, columns, rows, write(), 'resize' event
//   stdin:  isTTY, setRawMode(), setEncoding(), resume/pause/ref/unref, 'data'/'readable'

const state = { columns: 80, rows: 24 };

function def(obj, prop, value, opts = {}) {
  try {
    Object.defineProperty(obj, prop, { value, writable: true, configurable: true, enumerable: false, ...opts });
    return true;
  } catch { return false; }
}
function defGetter(obj, prop, get) {
  try { Object.defineProperty(obj, prop, { get, configurable: true, enumerable: false }); return true; } catch { return false; }
}

function install(opts = {}) {
  if (opts.columns) state.columns = opts.columns;
  if (opts.rows) state.rows = opts.rows;

  const out = process.stdout;
  const err = process.stderr;
  const inp = process.stdin;

  for (const s of [out, err]) {
    if (!s) continue;
    def(s, 'isTTY', true);
    defGetter(s, 'columns', () => state.columns);
    defGetter(s, 'rows', () => state.rows);
    if (typeof s.getWindowSize !== 'function') def(s, 'getWindowSize', () => [state.columns, state.rows]);
    if (typeof s.getColorDepth !== 'function') def(s, 'getColorDepth', () => 24); // truecolor
    if (typeof s.hasColors !== 'function') def(s, 'hasColors', () => true);
    // readline cursor helpers some libs call directly (Ink emits ANSI strings, but be safe).
    for (const m of ['cursorTo', 'moveCursor', 'clearLine', 'clearScreenDown']) {
      if (typeof s[m] !== 'function') def(s, m, (...a) => { const cb = a[a.length - 1]; if (typeof cb === 'function') cb(); return true; });
    }
  }

  if (inp) {
    def(inp, 'isTTY', true);
    let rawMode = !!inp.isRaw;
    const nativeSetRawMode = typeof inp.setRawMode === 'function' ? inp.setRawMode.bind(inp) : null;
    def(inp, 'setRawMode', function setRawMode(mode) {
      rawMode = !!mode;
      if (nativeSetRawMode) {
        try { nativeSetRawMode(mode); } catch {}
      }
      // The outer shell uses this as a semantic "foreground program owns/releases
      // the TTY" signal; native side may also observe it. Harmless on Mac tests.
      process.emit('__setRawMode', rawMode);
      return inp;
    });
    defGetter(inp, 'isRaw', () => rawMode);
    if (typeof inp.ref !== 'function') def(inp, 'ref', () => inp);
    if (typeof inp.unref !== 'function') def(inp, 'unref', () => inp);
  }
}

// Called by the native bridge when the SwiftTerm view resizes.
function setSize(columns, rows) {
  if (columns > 0) state.columns = columns;
  if (rows > 0) state.rows = rows;
  try { if (process.stdout) process.stdout.emit('resize'); } catch {}
  try { if (process.stderr) process.stderr.emit('resize'); } catch {}
}

function getSize() { return { columns: state.columns, rows: state.rows }; }

module.exports = { install, setSize, getSize, _state: state };
