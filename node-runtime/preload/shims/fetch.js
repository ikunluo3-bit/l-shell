'use strict';
// WASM-free fetch for jitless V8 (iOS nodejs-mobile).
//
// Node's builtin fetch (undici) needs llhttp.wasm, which throws
// "WebAssembly is not defined" under --jitless. This reimplements the subset of
// fetch that the Anthropic SDK / Claude Code needs, on top of node:http(s):
//   - streaming response body as a web ReadableStream (SSE works unchanged)
//   - HTTPS_PROXY / HTTP_PROXY / NO_PROXY support (mandatory: api.anthropic.com is
//     geo-blocked, so requests must tunnel through an on-device proxy)
//   - keep-alive pooling via custom Agents; proxy CONNECT tunnels are pooled too
//     (a fresh CONNECT + TLS handshake costs ~200ms per request on-device)
//   - gzip/deflate/br response decompression (undici parity)
//   - idle-socket timeout (CLAUDE_IOS_FETCH_IDLE_TIMEOUT ms, 0 disables) that
//     resets on activity, so healthy long SSE streams are never killed
//   - AbortSignal, fetch-spec redirects, standard Response methods (.text/.json/.body)
//
// CRITICAL (Node 18): we must NOT touch the global Headers/Response/Request classes.
// On Node 18 those are undici-backed and merely referencing `Headers` (e.g. for
// `instanceof`) lazy-loads undici's HTTP client, which pulls in llhttp.wasm and
// crashes under jitless. So we use our own ShimHeaders/ShimResponse and duck-type
// any incoming Headers-like object. Web ReadableStream (node:stream/web) is safe.

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const zlib = require('node:zlib');
const { Readable, pipeline } = require('node:stream');

const MAX_REDIRECTS = 5;
const FREE_SOCKET_TIMEOUT = 15000; // idle keep-alive sockets in the pool die after this
const DEFAULT_IDLE_TIMEOUT = 300000;

function idleTimeoutMs() {
  const raw = process.env.CLAUDE_IOS_FETCH_IDLE_TIMEOUT;
  if (raw == null || raw === '') return DEFAULT_IDLE_TIMEOUT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_IDLE_TIMEOUT;
}

// Wrap a stream chunk without copying (Buffer.from(u8) copies; this view doesn't).
// Safe: chunks produced by our own http/zlib streams are never reused by the producer.
function chunkToBuf(v) {
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  return Buffer.from(v);
}

// ---- lightweight Headers/Response that never load undici -------------------
class ShimHeaders {
  constructor(init) {
    this._m = new Map(); // lowercased name -> value (comma-joined)
    if (init) {
      if (typeof init.forEach === 'function' && !Array.isArray(init)) init.forEach((v, k) => this.append(k, v));
      else if (Array.isArray(init)) for (const [k, v] of init) this.append(k, v);
      else for (const k of Object.keys(init)) this.append(k, init[k]);
    }
  }
  append(k, v) { k = String(k).toLowerCase(); const e = this._m.get(k); this._m.set(k, e != null ? e + ', ' + v : String(v)); }
  set(k, v) { this._m.set(String(k).toLowerCase(), String(v)); }
  get(k) { const v = this._m.get(String(k).toLowerCase()); return v == null ? null : v; }
  has(k) { return this._m.has(String(k).toLowerCase()); }
  delete(k) { this._m.delete(String(k).toLowerCase()); }
  forEach(fn, thisArg) { for (const [k, v] of this._m) fn.call(thisArg, v, k, this); }
  keys() { return this._m.keys(); }
  values() { return this._m.values(); }
  entries() { return this._m.entries(); }
  [Symbol.iterator]() { return this._m.entries(); }
}

class ShimResponse {
  constructor(bodyStream, opts = {}) {
    this.status = opts.status == null ? 200 : opts.status;
    this.statusText = opts.statusText || '';
    this.headers = opts.headers instanceof ShimHeaders ? opts.headers : new ShimHeaders(opts.headers);
    this.ok = this.status >= 200 && this.status < 300;
    this.redirected = !!opts.redirected;
    this.type = 'basic';
    this.url = opts.url || '';
    this.bodyUsed = false;
    this._stream = bodyStream || null; // web ReadableStream | null
  }
  get body() { return this._stream; }
  async _bytes() {
    this.bodyUsed = true;
    if (!this._stream) return Buffer.alloc(0);
    const reader = this._stream.getReader();
    const chunks = [];
    for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(chunkToBuf(value)); }
    return Buffer.concat(chunks);
  }
  async arrayBuffer() { const b = await this._bytes(); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
  async bytes() { const b = await this._bytes(); return new Uint8Array(b); }
  async text() { return (await this._bytes()).toString('utf8'); }
  async json() { return JSON.parse(await this.text()); }
  clone() {
    if (this.bodyUsed) throw new TypeError('Failed to execute clone(): body already used');
    const copy = new ShimResponse(null, {
      status: this.status, statusText: this.statusText, headers: new ShimHeaders(this.headers),
      url: this.url, redirected: this.redirected,
    });
    if (this._stream) { const [a, b] = this._stream.tee(); this._stream = a; copy._stream = b; }
    return copy;
  }
}

// ---- proxy resolution ------------------------------------------------------
function isLoopback(hostname) {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]' || h.endsWith('.localhost');
}
function noProxyMatches(hostname, noProxy) {
  if (!noProxy) return false;
  if (noProxy.trim() === '*') return true;
  return noProxy.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).some((entry) => {
    const bare = entry.replace(/^\./, '');
    return hostname === bare || hostname.endsWith('.' + bare);
  });
}
function proxyForUrl(url) {
  const env = process.env;
  if (isLoopback(url.hostname)) return null;
  if (noProxyMatches(url.hostname.toLowerCase(), env.NO_PROXY || env.no_proxy)) return null;
  const raw = url.protocol === 'https:'
    ? (env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy)
    : (env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy);
  if (!raw) return null;
  try { return new URL(raw); } catch { return null; }
}

// URL.hostname keeps IPv6 brackets ('[::1]'); sockets need the bare address while
// the CONNECT authority / Host header need the bracketed form (RFC 3986 / 9112).
function stripBrackets(h) { return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h; }
function bracketHost(h) { return h.includes(':') && h[0] !== '[' ? '[' + h + ']' : h; }

// Establish a raw tunnel to host:port through an HTTP CONNECT proxy.
function tunnel(proxy, host, port) {
  return new Promise((resolve, reject) => {
    const proxyPort = Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80);
    const authority = `${bracketHost(host)}:${port}`;
    const headers = { Host: authority, 'Proxy-Connection': 'keep-alive' };
    if (proxy.username) {
      const auth = Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password || '')}`).toString('base64');
      headers['Proxy-Authorization'] = `Basic ${auth}`;
    }
    const req = (proxy.protocol === 'https:' ? https : http).request({
      host: stripBrackets(proxy.hostname), port: proxyPort, method: 'CONNECT', path: authority, headers,
    });
    const idleMs = idleTimeoutMs();
    if (idleMs > 0) req.setTimeout(idleMs, () => req.destroy(new Error(`fetch idle timeout after ${idleMs}ms during proxy CONNECT to ${authority}`)));
    req.once('connect', (res, socket, head) => {
      if (res.statusCode !== 200) { socket.destroy(); return reject(new Error(`Proxy CONNECT failed: ${res.statusCode} ${res.statusMessage}`)); }
      if (head && head.length) socket.unshift(head);
      resolve(socket);
    });
    req.once('error', reject);
    req.end();
  });
}

// ---- keep-alive connection pooling ------------------------------------------
// Agent `timeout` doubles as the free-socket idle timeout: keepSocketAlive applies it
// when a socket is parked and Node destroys free sockets whose timer fires; active
// requests override it per-request via setRequestSocket (verified on 18.20.4 + 24).
const AGENT_OPTS = {
  keepAlive: true, keepAliveMsecs: 1000, maxSockets: 8, maxFreeSockets: 4,
  timeout: FREE_SOCKET_TIMEOUT, scheduling: 'lifo',
};

class ProxyHttpAgent extends http.Agent {
  constructor(proxy) { super(AGENT_OPTS); this._proxy = proxy; }
  createConnection(options, cb) {
    tunnel(this._proxy, options.host, options.port).then((sock) => cb(null, sock), (err) => cb(err));
  }
}

class ProxyHttpsAgent extends https.Agent {
  constructor(proxy) { super(AGENT_OPTS); this._proxy = proxy; }
  createConnection(options, cb) {
    tunnel(this._proxy, options.host, options.port).then((raw) => {
      let tlsSock;
      try { tlsSock = super.createConnection({ ...options, socket: raw }); } // TLS upgrade (keeps session cache)
      catch (e) { raw.destroy(); return cb(e); }
      // The raw proxy socket under the TLSSocket has no listeners of its own; forward
      // its errors onto the managed socket so they can never become uncaughtException.
      raw.on('error', (e) => { if (!tlsSock.destroyed) tlsSock.destroy(e); });
      cb(null, tlsSock);
    }, (err) => cb(err));
  }
}

const agents = new Map(); // 'h'|'s' + proxy href -> Agent
function agentFor(url, proxy) {
  const key = (url.protocol === 'https:' ? 's|' : 'h|') + (proxy ? proxy.href : '');
  let a = agents.get(key);
  if (!a) {
    a = proxy
      ? (url.protocol === 'https:' ? new ProxyHttpsAgent(proxy) : new ProxyHttpAgent(proxy))
      : (url.protocol === 'https:' ? new https.Agent(AGENT_OPTS) : new http.Agent(AGENT_OPTS));
    if (agents.size >= 8) { const [k0, a0] = agents.entries().next().value; a0.destroy(); agents.delete(k0); } // proxy env churn guard
    agents.set(key, a);
  }
  return a;
}

// Standalone one-shot socket to an origin (CONNECT-tunneled when a proxy applies).
// The fetch path uses the pooled Agents above; kept for the exported API.
function connect(url, proxy) {
  const isHttps = url.protocol === 'https:';
  const port = Number(url.port) || (isHttps ? 443 : 80);
  const host = stripBrackets(url.hostname);
  const servername = net.isIP(host) ? undefined : host;
  if (!proxy) {
    return new Promise((resolve, reject) => {
      if (!isHttps) { const s = net.connect(port, host, () => resolve(s)); s.once('error', reject); return; }
      const s = tls.connect({ host, port, servername }, () => resolve(s));
      s.once('error', reject);
    });
  }
  return tunnel(proxy, host, port).then((raw) => {
    if (!isHttps) return raw;
    return new Promise((resolve, reject) => {
      const s = tls.connect({ socket: raw, servername }, () => resolve(s));
      s.once('error', reject);
      raw.on('error', (e) => { if (!s.destroyed) s.destroy(e); });
    });
  });
}

// Duck-typed header normalization — never references the global Headers class.
function normalizeHeaders(h) {
  const out = {};
  if (!h) return out;
  if (typeof h.forEach === 'function' && typeof h.get === 'function') { h.forEach((v, k) => { out[k] = v; }); return out; }
  if (Array.isArray(h)) { for (const [k, v] of h) out[k] = v; return out; }
  for (const k of Object.keys(h)) out[k] = h[k];
  return out;
}

async function bodyToBuffer(body) {
  if (body == null) return null;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array || body instanceof ArrayBuffer) return Buffer.from(body);
  if (typeof body.getReader === 'function') {
    const reader = body.getReader(); const chunks = [];
    for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(chunkToBuf(value)); }
    return Buffer.concat(chunks);
  }
  if (typeof body[Symbol.asyncIterator] === 'function') {
    const chunks = []; for await (const c of body) chunks.push(chunkToBuf(c)); return Buffer.concat(chunks);
  }
  return Buffer.from(String(body), 'utf8');
}

function encodeFormData(fd) {
  const boundary = '----iosFormBoundary' + Math.abs(hashString(String(fd._e.length) + fd._e.map((e) => e[0]).join(''))).toString(36) + 'x';
  const parts = [];
  for (const [name, value, filename] of fd._e) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${name}"`;
    if (filename) head += `; filename="${filename}"`;
    head += '\r\n';
    if (value && (Buffer.isBuffer(value) || value instanceof Uint8Array)) {
      head += 'Content-Type: application/octet-stream\r\n\r\n';
      parts.push(Buffer.from(head, 'utf8'), Buffer.from(value), Buffer.from('\r\n'));
    } else {
      head += '\r\n';
      parts.push(Buffer.from(head + String(value) + '\r\n', 'utf8'));
    }
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { buffer: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}
function hashString(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

const REDIRECT_STATUS = [301, 302, 303, 307, 308];
const SENSITIVE_HEADERS = ['authorization', 'x-api-key', 'cookie', 'proxy-authorization'];
const BODY_HEADERS = ['content-type', 'content-length', 'content-encoding', 'transfer-encoding'];

function deleteHeaders(headers, names) {
  for (const k of Object.keys(headers)) if (names.includes(k.toLowerCase())) delete headers[k];
}

async function nodeFetch(input, init = {}) {
  const urlStr = typeof input === 'string' ? input : (input && input.url) || String(input);
  let url = new URL(urlStr);
  let method = (init.method || (input && input.method) || 'GET').toUpperCase();
  const signal = init.signal || (input && input.signal);
  const redirectMode = init.redirect || (input && input.redirect) || 'follow';
  const rawHeaders = { ...normalizeHeaders(init.headers || (input && input.headers)) };
  let rawBody = init.body != null ? init.body : (input && input.body);
  if (rawBody && rawBody.__isFormData) {
    const enc = encodeFormData(rawBody);
    rawBody = enc.buffer;
    if (!hasHeader(rawHeaders, 'content-type')) rawHeaders['Content-Type'] = enc.contentType;
  }
  let bodyBuf = await bodyToBuffer(rawBody);

  for (let hop = 0; ; hop++) {
    if (signal && signal.aborted) throw abortError();
    const proxy = proxyForUrl(url);
    const agent = agentFor(url, proxy);
    let out;
    try {
      out = await sendRequest(url, method, rawHeaders, bodyBuf, signal, agent);
    } catch (e) {
      // Pooled keep-alive socket died between requests (server closed it while parked).
      // Node docs pattern: safe to retry exactly once on a fresh connection.
      if (e && e.staleSocketRetry) out = await sendRequest(url, method, rawHeaders, bodyBuf, signal, agent);
      else throw e;
    }
    const status = out.res.statusCode;
    const loc = out.res.headers.location;

    if (REDIRECT_STATUS.includes(status) && loc && redirectMode !== 'manual') {
      const drain = () => { (out.body || out.res).resume(); }; // discard body, free socket to pool
      if (redirectMode === 'error') { drain(); throw new TypeError(`Redirect blocked (redirect: 'error'): ${url} -> ${loc}`); }
      if (hop >= MAX_REDIRECTS) { drain(); throw new TypeError('Too many redirects: ' + url); }
      let next;
      try { next = new URL(loc, url); } catch { drain(); throw new TypeError('Invalid redirect Location: ' + loc); }
      drain();
      // Fetch spec: 303 (unless GET/HEAD) and 301/302+POST downgrade to a body-less GET.
      if (status === 303 ? (method !== 'GET' && method !== 'HEAD') : ((status === 301 || status === 302) && method === 'POST')) {
        method = 'GET'; bodyBuf = null;
        deleteHeaders(rawHeaders, BODY_HEADERS);
      }
      // Cross-origin hop: never forward credentials.
      if (next.protocol !== url.protocol || next.host !== url.host) deleteHeaders(rawHeaders, SENSITIVE_HEADERS);
      url = next;
      continue;
    }
    return toResponse(out, url, hop > 0);
  }
}

// Decompress per Content-Encoding, undici-style. Returns { stream, decoded }:
// stream is the node Readable to expose (null for body-less responses).
const DECODERS = {
  gzip: () => zlib.createGunzip(),
  'x-gzip': () => zlib.createGunzip(),
  deflate: () => zlib.createInflate(),
  br: () => zlib.createBrotliDecompress(),
};
function wrapBody(res, method) {
  if (method === 'HEAD' || res.statusCode === 204 || res.statusCode === 304) {
    res.resume();
    return { stream: null, decoded: false };
  }
  const enc = String(res.headers['content-encoding'] || '').toLowerCase();
  if (!enc || enc === 'identity') return { stream: res, decoded: false };
  const codings = enc.split(',').map((s) => s.trim()).filter((c) => c && c !== 'identity').reverse();
  if (!codings.length || codings.some((c) => !DECODERS[c])) return { stream: res, decoded: false }; // unknown coding: expose raw
  const stages = codings.map((c) => DECODERS[c]());
  pipeline(res, ...stages, () => {}); // propagates errors/teardown both ways; surfaced via the last stage
  return { stream: stages[stages.length - 1], decoded: true };
}

function sendRequest(url, method, headers, bodyBuf, signal, agent) {
  const mod = url.protocol === 'https:' ? https : http;
  const hdrs = { ...headers };
  if (!hasHeader(hdrs, 'host')) hdrs.Host = url.host; // url.host keeps IPv6 brackets + port
  if (!hasHeader(hdrs, 'accept-encoding')) hdrs['Accept-Encoding'] = 'gzip, deflate, br';
  if (bodyBuf && !hasHeader(hdrs, 'content-length')) hdrs['Content-Length'] = String(bodyBuf.length);
  const idleMs = idleTimeoutMs();
  return new Promise((resolve, reject) => {
    const req = mod.request({
      host: stripBrackets(url.hostname),
      port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
      method,
      path: url.pathname + url.search,
      headers: hdrs,
      agent,
      timeout: idleMs, // idle timer, resets on socket activity; 0 disables
    });
    let settled = false;
    let bodyStream = null; // node stream backing the exposed web ReadableStream
    let onAbort = null;
    const dropAbort = () => { if (onAbort) { signal.removeEventListener('abort', onAbort); onAbort = null; } };
    // Full-lifecycle error routing: before the response resolves → reject the fetch;
    // after → destroy the exposed stream so reader.read() rejects. Never uncaught.
    const fail = (err) => {
      if (!settled) { settled = true; dropAbort(); reject(err); }
      else if (bodyStream && !bodyStream.destroyed) bodyStream.destroy(err);
    };
    req.on('error', (err) => {
      if (!settled && req.reusedSocket && err && err.code === 'ECONNRESET') err.staleSocketRetry = true;
      fail(err);
    });
    req.on('timeout', () => {
      if (idleMs <= 0) return; // spurious: pool free-timer leaked into an active request
      const e = new Error(`fetch idle timeout after ${idleMs}ms: ${url.href}`);
      fail(e);
      req.destroy(e);
    });
    req.on('response', (res) => {
      res.on('error', () => {}); // guard only; real delivery is via toWeb/pipeline/fail
      const wrapped = wrapBody(res, method);
      bodyStream = wrapped.stream || res;
      bodyStream.once('close', dropAbort);
      settled = true;
      resolve({ res, body: wrapped.stream, decoded: wrapped.decoded });
    });
    if (signal) {
      if (signal.aborted) { settled = true; const e = abortError(); reject(e); req.destroy(e); return; }
      onAbort = () => { const e = abortError(); fail(e); req.destroy(e); };
      signal.addEventListener('abort', onAbort, { once: true });
    }
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

function toResponse(out, url, redirected) {
  const headers = new ShimHeaders();
  for (const [k, v] of Object.entries(out.res.headers)) {
    if (Array.isArray(v)) v.forEach((vv) => headers.append(k, vv));
    else if (v != null) headers.set(k, v);
  }
  if (out.decoded) { headers.delete('content-encoding'); headers.delete('content-length'); } // undici behavior
  const webStream = out.body ? Readable.toWeb(out.body) : null;
  return new ShimResponse(webStream, {
    status: out.res.statusCode, statusText: out.res.statusMessage || '', headers,
    url: url.toString(), redirected,
  });
}

function hasHeader(h, name) { return Object.keys(h).some((k) => k.toLowerCase() === name); }
function abortError() { const e = new Error('The operation was aborted'); e.name = 'AbortError'; return e; }

// ---- minimal Request / FormData that never load undici ---------------------
class ShimRequest {
  constructor(input, init = {}) {
    this.url = typeof input === 'string' ? input : (input && input.url) || '';
    this.method = (init.method || (input && input.method) || 'GET').toUpperCase();
    this.headers = init.headers instanceof ShimHeaders ? init.headers : new ShimHeaders(init.headers || (input && input.headers));
    this.body = init.body != null ? init.body : (input && input.body) || null;
    this.signal = init.signal || (input && input.signal) || null;
    this.redirect = init.redirect || (input && input.redirect) || 'follow';
  }
  clone() { return new ShimRequest(this.url, { method: this.method, headers: this.headers, body: this.body, signal: this.signal, redirect: this.redirect }); }
}

class ShimFormData {
  constructor() { this._e = []; }
  append(name, value, filename) { this._e.push([String(name), value, filename]); }
  set(name, value, filename) { this.delete(name); this.append(name, value, filename); }
  get(name) { const f = this._e.find((e) => e[0] === name); return f ? f[1] : null; }
  getAll(name) { return this._e.filter((e) => e[0] === name).map((e) => e[1]); }
  has(name) { return this._e.some((e) => e[0] === name); }
  delete(name) { this._e = this._e.filter((e) => e[0] !== name); }
  forEach(fn, t) { for (const [k, v] of this._e) fn.call(t, v, k, this); }
  entries() { return this._e.map((e) => [e[0], e[1]])[Symbol.iterator](); }
  keys() { return this._e.map((e) => e[0])[Symbol.iterator](); }
  values() { return this._e.map((e) => e[1])[Symbol.iterator](); }
  [Symbol.iterator]() { return this.entries(); }
  get __isFormData() { return true; }
}

// WebSocket is not supported in this runtime (would need a from-scratch client over
// the proxy). Stub throws on construction so any code path that needs it fails loudly
// rather than silently, but merely referencing the global is safe (no undici load).
class ShimWebSocket {
  constructor() { throw new Error('WebSocket is not supported in the iOS embedded runtime'); }
}

// Replace the undici-backed Web globals with WASM-free equivalents. MUST run before
// any module (just-bash, cli.js, the SDK) touches them: on Node 18 merely referencing
// the real Headers/Response/etc. lazy-loads undici's llhttp.wasm and crashes jitless.
function installWebGlobals() {
  const set = (name, value) => { try { Object.defineProperty(globalThis, name, { value, writable: true, configurable: true }); } catch { try { globalThis[name] = value; } catch {} } };
  set('fetch', nodeFetch);
  set('Headers', ShimHeaders);
  set('Response', ShimResponse);
  set('Request', ShimRequest);
  set('FormData', ShimFormData);
  set('WebSocket', ShimWebSocket);
}

module.exports = { nodeFetch, proxyForUrl, connect, installWebGlobals, ShimHeaders, ShimResponse, ShimRequest, ShimFormData };
