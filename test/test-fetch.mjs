// Run under: node --jitless test/test-fetch.mjs
// Validates the WASM-free fetch shim in the exact environment iOS gives us.
import { createRequire } from 'node:module';
import http from 'node:http';
const require = createRequire(import.meta.url);
const { nodeFetch } = require('../node-runtime/preload/shims/fetch.js');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗ FAIL:', m)); };

console.log('WebAssembly global under jitless:', typeof globalThis.WebAssembly, '(expect undefined)');

// 1) plain local HTTP, no proxy
{
  const srv = http.createServer((req, res) => { res.writeHead(200, { 'x-test': 'yes' }); res.end('{"hello":"world"}'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const resp = await nodeFetch(`http://127.0.0.1:${port}/`);
    ok(resp.status === 200, `local GET status 200 (got ${resp.status})`);
    ok(resp.headers.get('x-test') === 'yes', 'response header readable');
    const j = await resp.json();
    ok(j.hello === 'world', 'json() parses body');
  } catch (e) { ok(false, 'local GET threw: ' + e.message); }
  srv.close();
}

// 2) POST with JSON body + echo
{
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { res.writeHead(200); res.end(b); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const resp = await nodeFetch(`http://127.0.0.1:${port}/`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ a: 1 }),
    });
    const j = await resp.json();
    ok(j.a === 1, 'POST body round-trips');
  } catch (e) { ok(false, 'POST threw: ' + e.message); }
  srv.close();
}

// 3) streaming body via ReadableStream reader (SSE shape)
{
  const srv = http.createServer((res_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let n = 0; const t = setInterval(() => { res.write(`data: chunk${n++}\n\n`); if (n === 3) { clearInterval(t); res.end(); } }, 10);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const resp = await nodeFetch(`http://127.0.0.1:${port}/`);
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let acc = '', count = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; acc += dec.decode(value); count++; }
    ok(acc.includes('chunk0') && acc.includes('chunk2'), 'streaming reader received all chunks');
    ok(count >= 1, `stream delivered in ${count} read(s)`);
  } catch (e) { ok(false, 'stream threw: ' + e.message); }
  srv.close();
}

// 4) real HTTPS through the proxy — proves the China path (TLS-over-CONNECT + body read)
{
  try {
    const resp = await nodeFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-3-5-haiku-20241022', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
    });
    ok(resp.status === 401 || resp.status === 400, `reached api.anthropic.com through proxy (status ${resp.status}, expect 401 no-auth)`);
    const j = await resp.json();
    ok(j && j.type === 'error', 'got structured API error body: ' + (j?.error?.type || 'n/a'));
  } catch (e) { ok(false, 'proxy HTTPS threw: ' + e.message + (e.cause ? ' | cause: ' + e.cause.message : '')); }
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
