'use strict';
// TEST-ONLY: reproduce the iOS runtime environment on a Mac WITHOUT installing the
// preload (bootstrap.js does that itself). Only strips Intl and spoofs platform, so
// we can test bootstrap.js exactly as the native side runs it.
try { delete globalThis.Intl; } catch {}
try { Object.defineProperty(process, 'platform', { value: 'ios', configurable: true }); } catch {}
