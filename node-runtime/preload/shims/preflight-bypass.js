'use strict';
// Claude Code's startup connectivity preflight (cli.js `i2A`) fetches, via axios over
// node:http(s):
//   https://api.anthropic.com/api/hello
//   <oauth token host>/v1/oauth/hello
// Those hosts are HARDCODED to the first-party Anthropic prod config — the preflight
// ignores ANTHROPIC_BASE_URL. In a region where api.anthropic.com is blocked, the
// preflight fails ("Unable to connect to Anthropic services") and Claude aborts at
// launch, even though the configured relay (ANTHROPIC_BASE_URL) is reachable and serves
// the real API.
//
// When a THIRD-PARTY base URL is configured (host != api.anthropic.com), short-circuit
// ONLY those two preflight endpoints with a synthetic 200 so Claude proceeds to use the
// relay for the actual API. Everything else hits the network normally. Official-login
// users (no/first-party base URL) are unaffected — their real preflight still runs.

const http = require('node:http');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');

function usingThirdPartyBase() {
  const base = process.env.ANTHROPIC_BASE_URL;
  if (!base) return false;
  try { return new URL(base).host.toLowerCase() !== 'api.anthropic.com'; } catch { return false; }
}

function isPreflightEndpoint(host, path) {
  if (!host) return false;
  const h = String(host).toLowerCase().split(':')[0];
  const p = String(path || '').split('?')[0];
  const isAnthropic = h === 'anthropic.com' || h === 'api.anthropic.com' || h.endsWith('.anthropic.com');
  return isAnthropic && (p === '/api/hello' || p === '/v1/oauth/hello');
}

// Pull {host, path} out of the http.request(...) argument shapes:
//   request(url), request(url, opts), request(url, opts, cb), request(opts), request(opts, cb)
function extractHostPath(args) {
  let o = {};
  const a0 = args[0];
  if (typeof a0 === 'string' || a0 instanceof URL) {
    try { const u = new URL(String(a0)); o.host = u.hostname; o.path = u.pathname + u.search; } catch {}
    if (args[1] && typeof args[1] === 'object') o = { ...o, ...args[1] };
  } else if (a0 && typeof a0 === 'object') {
    o = a0;
  }
  return { host: o.hostname || o.host, path: o.path || '/', method: (o.method || 'GET').toUpperCase() };
}

// A minimal ClientRequest stand-in that emits a 200 response with a tiny JSON body.
function fakeOkRequest(cb) {
  const req = new EventEmitter();
  req.setHeader = () => {}; req.getHeader = () => undefined; req.removeHeader = () => {};
  req.setTimeout = () => req; req.setNoDelay = () => {}; req.setSocketKeepAlive = () => {};
  req.flushHeaders = () => {}; req.write = () => true; req.destroy = () => {}; req.abort = () => {};
  if (typeof cb === 'function') req.once('response', cb);
  let ended = false;
  req.end = function () {
    if (ended) return req;
    ended = true;
    setImmediate(() => {
      const res = new Readable({ read() {} });
      res.statusCode = 200;
      res.statusMessage = 'OK';
      res.httpVersion = '1.1';
      res.headers = { 'content-type': 'application/json' };
      res.rawHeaders = ['Content-Type', 'application/json'];
      res.complete = false;
      req.emit('response', res);   // listeners attach synchronously here...
      res.push('{}');              // ...then the body flows to them
      res.push(null);
      res.complete = true;
    });
    return req;
  };
  return req;
}

function install() {
  for (const mod of [http, https]) {
    const origRequest = mod.request.bind(mod);
    mod.request = function (...args) {
      try {
        if (usingThirdPartyBase()) {
          const { host, path, method } = extractHostPath(args);
          if (method === 'GET' && isPreflightEndpoint(host, path)) {
            const cb = args.find((a) => typeof a === 'function');
            return fakeOkRequest(cb);
          }
        }
      } catch {}
      return origRequest(...args);
    };
    // node's http.get uses an INTERNAL request ref, so patching .request above does not
    // cover it; reroute .get through our patched .request (+ auto end, as get does).
    mod.get = function (...args) {
      const req = mod.request(...args);
      req.end();
      return req;
    };
  }
}

module.exports = { install, isPreflightEndpoint, usingThirdPartyBase };
