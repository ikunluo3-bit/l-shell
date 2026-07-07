// Run under: node --jitless test/test-fetch-fixes.mjs
// Regression tests for the fetch-shim fixes: full-lifecycle socket error handling,
// keep-alive pooling (direct + proxy CONNECT), idle timeout, decompression,
// fetch-spec redirects, Response.clone(), IPv6 host handling, AbortSignal.
// Localhost-only: spawns its own servers and a mock CONNECT proxy.
import { createRequire } from 'node:module';
import http from 'node:http';
import net from 'node:net';
import zlib from 'node:zlib';
const require = createRequire(import.meta.url);
const { nodeFetch } = require('../node-runtime/preload/shims/fetch.js');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗ FAIL:', m)); };

// Any uncaught error anywhere in this file is itself a test failure (fix #1).
const stray = [];
process.on('uncaughtException', (e) => stray.push('uncaughtException: ' + (e && e.message)));
process.on('unhandledRejection', (e) => stray.push('unhandledRejection: ' + (e && e.message)));

const listen = (srv, host = '127.0.0.1') => new Promise((resolve, reject) => {
  srv.once('error', reject);
  srv.listen(0, host, () => resolve(srv.address().port));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// keep the env deterministic for the proxy tests
for (const k of ['NO_PROXY', 'no_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) delete process.env[k];

// 1) socket destroyed mid-body -> reader.read() rejects, no uncaughtException
{
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('partial');
    setTimeout(() => res.socket.destroy(), 30);
  });
  const port = await listen(srv);
  try {
    const resp = await nodeFetch(`http://127.0.0.1:${port}/`);
    const reader = resp.body.getReader();
    let err = null;
    try { for (;;) { const { done } = await reader.read(); if (done) break; } } catch (e) { err = e; }
    ok(err instanceof Error, `mid-body socket destroy -> reader.read() rejects (${err && err.message})`);
  } catch (e) { ok(false, 'mid-body destroy: fetch itself threw: ' + e.message); }
  srv.close();
}

// 1b) socket destroyed before headers -> fetch() rejects
{
  const srv = http.createServer(() => {});
  srv.on('connection', (s) => s.destroy());
  const port = await listen(srv);
  let err = null;
  try { await nodeFetch(`http://127.0.0.1:${port}/`); } catch (e) { err = e; }
  ok(err instanceof Error, `pre-response socket destroy -> fetch rejects (${err && err.message})`);
  srv.close();
}

// 2) keep-alive: two sequential fetches reuse one connection
{
  let conns = 0;
  const ports = [];
  const srv = http.createServer((req, res) => { ports.push(req.socket.remotePort); res.writeHead(200); res.end('ok'); });
  srv.on('connection', () => conns++);
  const port = await listen(srv);
  await (await nodeFetch(`http://127.0.0.1:${port}/a`)).text();
  await (await nodeFetch(`http://127.0.0.1:${port}/b`)).text();
  ok(conns === 1, `keep-alive reuses the connection (server saw ${conns} connection(s))`);
  ok(ports.length === 2 && ports[0] === ports[1], `same client port both times (${ports.join(', ')})`);
  srv.close();
}

// 3) proxy CONNECT path: tunnel works, is pooled, and IPv6 authority is bracketed
{
  let conns = 0;
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ host: req.headers.host || null }));
  });
  srv.on('connection', () => conns++);
  const tport = await listen(srv);

  const seen = [];
  const proxy = http.createServer((req, res) => { res.writeHead(405); res.end(); });
  proxy.on('connect', (req, clientSocket, head) => {
    seen.push(req.url);
    const upstream = net.connect(tport, '127.0.0.1', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });
  const pport = await listen(proxy);
  process.env.HTTP_PROXY = `http://127.0.0.1:${pport}`;

  const j1 = await (await nodeFetch(`http://fake-origin.invalid:${tport}/x`)).json();
  ok(seen[0] === `fake-origin.invalid:${tport}`, `CONNECT authority correct (${seen[0]})`);
  ok(j1.host === `fake-origin.invalid:${tport}`, `Host header preserved through tunnel (${j1.host})`);
  await (await nodeFetch(`http://fake-origin.invalid:${tport}/y`)).text();
  ok(conns === 1 && seen.length === 1, `CONNECT tunnel pooled and reused (conns=${conns}, CONNECTs=${seen.length})`);

  // IPv6 target through the proxy: authority + Host must be bracketed (RFC 3986/9112)
  const j2 = await (await nodeFetch(`http://[2001:db8::1]:${tport}/v6`)).json();
  ok(seen[1] === `[2001:db8::1]:${tport}`, `IPv6 CONNECT authority bracketed (${seen[1]})`);
  ok(j2.host === `[2001:db8::1]:${tport}`, `IPv6 Host header bracketed (${j2.host})`);

  delete process.env.HTTP_PROXY;
  proxy.close();
  srv.close();
}

// 3b) URL hostname keeps brackets on this Node (documents the invariant the shim relies on)
ok(new URL('https://[::1]:9/').hostname === '[::1]', `URL('https://[::1]:9/').hostname === '[::1]'`);

// 4) direct IPv6 fetch (URL brackets must be stripped for the socket, kept for Host)
{
  const srv = http.createServer((req, res) => { res.writeHead(200); res.end(req.headers.host || ''); });
  let port = null;
  try { port = await listen(srv, '::1'); } catch { /* machine without ::1 */ }
  if (port == null) ok(true, 'skip: no ::1 loopback on this machine');
  else {
    try {
      const r = await nodeFetch(`http://[::1]:${port}/`);
      const t = await r.text();
      ok(r.status === 200, 'direct IPv6 fetch connects');
      ok(t === `[::1]:${port}`, `direct IPv6 Host header bracketed (${t})`);
    } catch (e) { ok(false, 'direct IPv6 fetch threw: ' + e.message); }
    srv.close();
  }
}

// 5) idle timeout (env-tunable), resets on activity
{
  process.env.CLAUDE_IOS_FETCH_IDLE_TIMEOUT = '250';
  const stallPre = http.createServer(() => { /* never respond */ });
  const p1 = await listen(stallPre);
  let e1 = null;
  try { await nodeFetch(`http://127.0.0.1:${p1}/`); } catch (e) { e1 = e; }
  ok(e1 && /idle timeout/.test(e1.message), `pre-response stall rejects with idle timeout (${e1 && e1.message})`);

  const stallMid = http.createServer((req, res) => { res.writeHead(200); res.write('start'); /* stall */ });
  const p2 = await listen(stallMid);
  const resp = await nodeFetch(`http://127.0.0.1:${p2}/`);
  const reader = resp.body.getReader();
  await reader.read(); // 'start'
  let e2 = null;
  try { await reader.read(); } catch (e) { e2 = e; }
  ok(e2 && /idle timeout/.test(e2.message), `mid-body stall errors the stream with idle timeout (${e2 && e2.message})`);

  // periodic data (SSE shape) at 100ms intervals must survive a 250ms idle limit
  const drip = http.createServer((req, res) => {
    res.writeHead(200);
    let n = 0;
    const t = setInterval(() => { res.write('c' + n++); if (n === 5) { clearInterval(t); res.end(); } }, 100);
  });
  const p3 = await listen(drip);
  const txt = await (await nodeFetch(`http://127.0.0.1:${p3}/`)).text();
  ok(txt === 'c0c1c2c3c4', `periodic activity resets the idle timer (got '${txt}')`);
  delete process.env.CLAUDE_IOS_FETCH_IDLE_TIMEOUT;
  stallPre.close(); stallMid.close(); drip.close();
}

// 6) decompression: gzip / deflate / br; headers scrubbed; 204 + HEAD have no body
{
  const payload = JSON.stringify({ compressed: true, arr: Array.from({ length: 200 }, (_, i) => i) });
  let sawAcceptEncoding = null;
  const srv = http.createServer((req, res) => {
    if (req.url === '/gzip') {
      sawAcceptEncoding = req.headers['accept-encoding'] || null;
      const gz = zlib.gzipSync(payload);
      res.writeHead(200, { 'content-encoding': 'gzip', 'content-length': String(gz.length), 'content-type': 'application/json' });
      res.end(gz);
    } else if (req.url === '/br') {
      res.writeHead(200, { 'content-encoding': 'br' }); res.end(zlib.brotliCompressSync(payload));
    } else if (req.url === '/deflate') {
      res.writeHead(200, { 'content-encoding': 'deflate' }); res.end(zlib.deflateSync(payload));
    } else if (req.url === '/204') {
      res.writeHead(204, { 'content-encoding': 'gzip' }); res.end();
    }
  });
  const port = await listen(srv);
  const r = await nodeFetch(`http://127.0.0.1:${port}/gzip`);
  const j = await r.json();
  ok(j.compressed === true && j.arr.length === 200, 'gzip body decompressed, json() parses');
  ok(r.headers.get('content-encoding') === null, 'content-encoding removed after decode');
  ok(r.headers.get('content-length') === null, 'content-length removed after decode');
  ok(typeof sawAcceptEncoding === 'string' && sawAcceptEncoding.includes('gzip'), `accept-encoding sent (${sawAcceptEncoding})`);
  ok((await (await nodeFetch(`http://127.0.0.1:${port}/br`)).json()).compressed === true, 'brotli decompressed');
  ok((await (await nodeFetch(`http://127.0.0.1:${port}/deflate`)).json()).compressed === true, 'deflate decompressed');
  const r204 = await nodeFetch(`http://127.0.0.1:${port}/204`);
  ok(r204.status === 204 && r204.body === null, '204 has null body even with content-encoding');
  const rh = await nodeFetch(`http://127.0.0.1:${port}/gzip`, { method: 'HEAD' });
  ok(rh.body === null, 'HEAD has null body');
  srv.close();
}

// 7) redirects: 303/301 downgrade, 307 preserve, cross-origin credential strip, manual, error, loop
{
  const echo = (req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        method: req.method, body: b,
        auth: req.headers.authorization || null, apikey: req.headers['x-api-key'] || null,
        cookie: req.headers.cookie || null, custom: req.headers['x-custom'] || null,
      }));
    });
  };
  const other = http.createServer(echo);
  const oport = await listen(other);
  const srv = http.createServer((req, res) => {
    const redir = (code, to) => { req.resume(); req.on('end', () => { res.writeHead(code, { location: to }); res.end(); }); };
    if (req.url === '/303') redir(303, '/target');
    else if (req.url === '/301') redir(301, '/target');
    else if (req.url === '/307') redir(307, '/target');
    else if (req.url === '/cross') redir(302, `http://127.0.0.1:${oport}/target`);
    else if (req.url === '/loop') redir(302, '/loop');
    else if (req.url === '/target') echo(req, res);
    else { res.writeHead(404); res.end(); }
  });
  const port = await listen(srv);
  const base = `http://127.0.0.1:${port}`;
  const creds = { authorization: 'Bearer tok', 'x-api-key': 'sk-key', cookie: 'a=1', 'x-custom': 'keep' };

  const r303 = await nodeFetch(`${base}/303`, { method: 'POST', body: 'data', headers: creds });
  const j303 = await r303.json();
  ok(j303.method === 'GET' && j303.body === '', `303 POST -> GET with body dropped (method=${j303.method})`);
  ok(j303.auth === 'Bearer tok' && j303.apikey === 'sk-key', 'same-origin redirect keeps credentials');
  ok(r303.redirected === true && r303.url === `${base}/target`, `response.redirected/url set (${r303.url})`);

  const j301 = await (await nodeFetch(`${base}/301`, { method: 'POST', body: 'data' })).json();
  ok(j301.method === 'GET' && j301.body === '', '301 POST -> GET with body dropped');

  const j307 = await (await nodeFetch(`${base}/307`, { method: 'POST', body: 'data' })).json();
  ok(j307.method === 'POST' && j307.body === 'data', '307 preserves method and body');

  const jx = await (await nodeFetch(`${base}/cross`, { headers: creds })).json();
  ok(jx.auth === null && jx.apikey === null && jx.cookie === null, 'cross-origin redirect strips authorization/x-api-key/cookie');
  ok(jx.custom === 'keep', 'cross-origin redirect keeps non-sensitive headers');

  const rm = await nodeFetch(`${base}/303`, { method: 'POST', body: 'x', redirect: 'manual' });
  ok(rm.status === 303 && rm.headers.get('location') === '/target' && rm.redirected === false,
    `redirect:'manual' returns the 3xx as-is (status=${rm.status})`);

  let ee = null;
  try { await nodeFetch(`${base}/303`, { method: 'POST', body: 'x', redirect: 'error' }); } catch (e) { ee = e; }
  ok(ee && /redirect/i.test(ee.message), `redirect:'error' rejects (${ee && ee.message})`);

  let el = null;
  try { await nodeFetch(`${base}/loop`); } catch (e) { el = e; }
  ok(el && /redirect/i.test(el.message), `redirect loop rejects (${el && el.message})`);
  srv.close(); other.close();
}

// 8) Response.clone()
{
  const srv = http.createServer((req, res) => { res.writeHead(200, { 'x-c': '1' }); res.end('clone-me'); });
  const port = await listen(srv);
  const r = await nodeFetch(`http://127.0.0.1:${port}/`);
  const c = r.clone();
  ok(c.status === 200 && c.headers.get('x-c') === '1', 'clone copies status and headers');
  const [t1, t2] = await Promise.all([r.text(), c.text()]);
  ok(t1 === 'clone-me' && t2 === 'clone-me', 'clone(): both bodies independently readable');
  let ce = null;
  try { r.clone(); } catch (e) { ce = e; }
  ok(ce instanceof Error, 'clone() after body used throws');
  srv.close();
}

// 9) AbortSignal: pre-aborted and mid-stream
{
  const srv = http.createServer((req, res) => { res.writeHead(200); res.write('first'); /* hold open */ });
  const port = await listen(srv);
  const ac = new AbortController();
  const r = await nodeFetch(`http://127.0.0.1:${port}/`, { signal: ac.signal });
  const reader = r.body.getReader();
  await reader.read();
  setTimeout(() => ac.abort(), 20);
  let e = null;
  try { await reader.read(); } catch (err) { e = err; }
  ok(e && e.name === 'AbortError', `abort mid-stream -> reader rejects AbortError (${e && e.name})`);

  const ac2 = new AbortController();
  ac2.abort();
  let e2 = null;
  try { await nodeFetch(`http://127.0.0.1:${port}/`, { signal: ac2.signal }); } catch (err) { e2 = err; }
  ok(e2 && e2.name === 'AbortError', 'pre-aborted signal rejects immediately');
  srv.close();
}

// 10) multi-chunk accumulation stays correct (chunk-wrap fast path)
{
  const chunk = 'x'.repeat(1024);
  const srv = http.createServer((req, res) => {
    res.writeHead(200);
    let n = 0;
    const write = () => {
      while (n < 100) { const more = res.write(chunk + n); n++; if (!more) return void res.once('drain', write); }
      res.end();
    };
    write();
  });
  const port = await listen(srv);
  const t = await (await nodeFetch(`http://127.0.0.1:${port}/`)).text();
  const expected = Array.from({ length: 100 }, (_, i) => chunk + i).join('');
  ok(t === expected, `multi-chunk body accumulates byte-exact (${t.length} bytes)`);
  srv.close();
}

// let any stray async errors surface before judging
await sleep(300);
for (const s of stray) { fail++; console.log('  ✗ FAIL: stray ' + s); }
if (!stray.length) { pass++; console.log('  ✓ no uncaughtException / unhandledRejection during the whole run'); }

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
