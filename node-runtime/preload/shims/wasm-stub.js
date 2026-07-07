'use strict';
// Benign WebAssembly stub for jitless V8, where the `WebAssembly` global does not
// exist at all (bare `WebAssembly.compile` throws ReferenceError). cli.js itself
// references WebAssembly directly (a libvips/sharp-style optional codepath) outside
// a guard, producing an unhandled rejection. We install a stub so those references
// resolve to a tagged, catchable failure instead of a hard ReferenceError. Real WASM
// cannot run jitless, so every method fails — but gracefully, and the failures are
// tagged WasmUnavailable so the bootstrap can swallow them silently.

const WASM_TAG = 'WasmUnavailable';

function wasmError() {
  const e = new Error('WebAssembly is not available in the jitless iOS runtime');
  e.name = WASM_TAG;
  e.__wasmUnavailable = true;
  return e;
}

function install() {
  if (typeof globalThis.WebAssembly !== 'undefined') return; // real WASM present (non-jitless build)
  const reject = () => Promise.reject(wasmError());
  const thrower = class { constructor() { throw wasmError(); } };
  globalThis.WebAssembly = {
    compile: reject,
    compileStreaming: reject,
    instantiate: reject,
    instantiateStreaming: reject,
    validate: () => false,
    Module: thrower,
    Instance: thrower,
    Memory: thrower,
    Table: thrower,
    Global: thrower,
    Tag: thrower,
    Exception: thrower,
    CompileError: class CompileError extends Error {},
    LinkError: class LinkError extends Error {},
    RuntimeError: class RuntimeError extends Error {},
    __stub: true,
  };
}

function isWasmUnavailable(err) {
  return !!(err && (err.__wasmUnavailable || err.name === WASM_TAG));
}

module.exports = { install, isWasmUnavailable, WASM_TAG };
