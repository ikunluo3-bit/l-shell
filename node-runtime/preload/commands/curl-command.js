'use strict';
// ============================================================================
// curl — HTTP(S) client on node:http/https for the iOS jitless runtime.
//
// WHY: just-bash 3.x SHIPS a `curl` builtin, but it is UNUSABLE here — it fails
// internally under this runtime (`bash: line NNNN: unexpected EOF while looking
// for matching '"'`, exit 2) for even a bare `curl`, and its network path is
// fetch/undici-shaped (llhttp.wasm → "WebAssembly is not defined" under jitless).
// This reimplementation talks node:http(s) DIRECTLY — no fetch, no WASM — and
// honors HTTPS_PROXY/HTTP_PROXY/NO_PROXY like the runtime's fetch shim, so it
// works over the on-device proxy. Registered LAST (after just-bash builtins) so
// it overrides the broken stock curl.
//
// Supported flags (the subset Claude actually reaches for):
//   -s/--silent            suppress progress (we have none) — mostly a no-op, ok
//   -S/--show-error        show errors even with -s (default: we always show)
//   -o FILE / --output FILE  write body to FILE (via ctx.fs / node fs)
//   -O / --remote-name     write body to basename of URL path
//   -L/--location          follow 3xx redirects (bounded)
//   -H 'K: V' / --header   add request header (repeatable)
//   -A/--user-agent UA     set User-Agent
//   -e/--referer URL       set Referer
//   -d/--data / --data-raw / --data-binary DATA   POST body (implies POST, sets
//                          content-type application/x-www-form-urlencoded unless
//                          overridden); @file reads a file, - reads stdin
//   --data-urlencode DATA  like -d but url-encodes
//   -G/--get               turn -d data into a query string on a GET
//   -X/--request METHOD    override HTTP method
//   -I/--head              HEAD request, print headers
//   -i/--include           print response headers before body
//   -f/--fail              exit 22 on HTTP >= 400 (no body)
//   -k/--insecure          skip TLS cert verification
//   -u USER:PASS           HTTP Basic auth
//   --connect-timeout SEC / --max-time SEC / -m SEC   timeouts
//   -w/--write-out FMT     minimal: %{http_code}, %{size_download}, \n, \t
//   -b/--cookie STR        Cookie header
//   --compressed           accept gzip/deflate/br and decompress
//   --url URL              explicit URL operand
//   -v/--verbose           trace lines to stderr (>, <)
//
// Not supported (reported honestly, non-fatal where possible): multipart -F,
// --cert client certs, HTTP/2 negotiation (node uses HTTP/1.1).
// ============================================================================

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const zlib = require('node:zlib');
const nodeFs = require('node:fs');
const nodePath = require('node:path');

// Reuse the SAME tmp redirect the rest of the runtime uses, so `curl -o /tmp/x`
// lands in the container-writable dir (not the read-only iOS /tmp) and matches
// what git/npm/mktemp see. Fall back to identity if the module isn't present
// (e.g. isolated unit test without tmp-map.js on disk).
let mapTmpAbs, resolveTarget;
try { ({ mapTmpAbs, resolveTarget } = require('./tmp-map.js')); }
catch { mapTmpAbs = (abs) => abs; resolveTarget = () => null; }

const MAX_REDIRECTS = 20;

function ok(stdout = '', exitCode = 0, stderr = '') { return { stdout, stderr, exitCode }; }

// ctx helpers mirroring shell-extras.js conventions.
function envOf(ctx) {
  return Object.assign({}, (ctx && ctx.exportedEnv) || {}, (ctx && ctx.env) || {});
}
function cwdOf(ctx) {
  const e = envOf(ctx);
  return e.PWD || (ctx && ctx.cwd) || process.cwd();
}

// Resolve an operand to a REAL node-fs absolute path: root at the shell cwd
// (PWD, so `cd` is honored), then apply the tmp redirect. This is exactly the
// git-command.js discipline — never touch the just-bash virtual fs, whose root
// differs from the real container fs and would land -o files off in os.tmpdir().
function realPath(ctx, operand) {
  const abs = nodePath.resolve(cwdOf(ctx), operand);
  const target = resolveTarget();
  return target ? mapTmpAbs(nodePath.normalize(abs), target) : nodePath.normalize(abs);
}
function fsWrite(ctx, operand, buf) {
  const abs = realPath(ctx, operand);
  try { nodeFs.mkdirSync(nodePath.dirname(abs), { recursive: true }); } catch {}
  nodeFs.writeFileSync(abs, buf);
}
function fsRead(ctx, operand) {
  return nodeFs.readFileSync(realPath(ctx, operand));
}

// ---- proxy handling (parity with the fetch shim) ---------------------------
function noProxyMatch(hostname, noProxy) {
  if (!noProxy) return false;
  const host = String(hostname).toLowerCase();
  for (let entry of String(noProxy).split(',')) {
    entry = entry.trim().toLowerCase();
    if (!entry) continue;
    if (entry === '*') return true;
    const bare = entry.replace(/^\./, '');
    if (host === bare || host.endsWith('.' + bare)) return true;
  }
  return false;
}
function proxyForProtocol(protocol, env) {
  const pick = (...keys) => { for (const k of keys) { const v = env[k] || env[k.toLowerCase()] || env[k.toUpperCase()]; if (v) return v; } return ''; };
  if (protocol === 'https:') return pick('HTTPS_PROXY', 'https_proxy') || pick('ALL_PROXY', 'all_proxy');
  return pick('HTTP_PROXY', 'http_proxy') || pick('ALL_PROXY', 'all_proxy');
}

// CONNECT tunnel for HTTPS-over-proxy.
function connectTunnel(proxyUrl, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const p = new URL(proxyUrl);
    const port = Number(p.port) || (p.protocol === 'https:' ? 443 : 80);
    const headers = { Host: `${targetHost}:${targetPort}` };
    if (p.username) headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64');
    const reqFn = p.protocol === 'https:' ? https.request : http.request;
    const cr = reqFn({ host: p.hostname, port, method: 'CONNECT', path: `${targetHost}:${targetPort}`, headers });
    cr.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { reject(new Error(`proxy CONNECT failed: ${res.statusCode}`)); socket.destroy(); return; }
      resolve(socket);
    });
    cr.on('error', reject);
    cr.end();
  });
}

// ---- argument parsing ------------------------------------------------------
function parseArgs(args) {
  const o = {
    urls: [], method: null, headers: [], data: [], dataMode: null, // 'raw'|'urlencode'|'binary'
    output: null, remoteName: false, followRedirects: false, silent: false, showError: false,
    head: false, includeHeaders: false, fail: false, insecure: false, userAgent: null, referer: null,
    basicAuth: null, getWithData: false, writeOut: null, cookie: null, compressed: false,
    connectTimeout: 0, maxTime: 0, verbose: false,
  };
  const errs = [];
  const need = (i, flag) => { if (i + 1 >= args.length) { errs.push(`curl: option ${flag}: requires parameter`); return null; } return args[i + 1]; };
  for (let i = 0; i < args.length; i++) {
    let a = args[i];
    if (a === '--') { for (let j = i + 1; j < args.length; j++) o.urls.push(args[j]); break; }
    // combined short flags like -sSL
    if (/^-[a-zA-Z]{2,}$/.test(a) && !a.startsWith('--')) {
      // expand only if every char is a known no-arg short flag; otherwise treat last as arg-taking
      const chars = a.slice(1).split('');
      const noArg = new Set(['s', 'S', 'L', 'O', 'I', 'i', 'f', 'k', 'G', 'v']);
      let expanded = [];
      let good = true;
      for (let ci = 0; ci < chars.length; ci++) {
        const c = chars[ci];
        if (noArg.has(c)) { expanded.push('-' + c); continue; }
        // arg-taking short flag: the rest of the string is its value
        const rest = chars.slice(ci + 1).join('');
        expanded.push('-' + c);
        if (rest) expanded.push(rest);
        good = 'argtail';
        break;
      }
      // splice expansion into args stream
      args = args.slice(0, i).concat(expanded, args.slice(i + 1));
      a = args[i];
    }
    switch (a) {
      case '-s': case '--silent': o.silent = true; break;
      case '-S': case '--show-error': o.showError = true; break;
      case '-L': case '--location': o.followRedirects = true; break;
      case '-O': case '--remote-name': o.remoteName = true; break;
      case '-I': case '--head': o.head = true; break;
      case '-i': case '--include': o.includeHeaders = true; break;
      case '-f': case '--fail': o.fail = true; break;
      case '-k': case '--insecure': o.insecure = true; break;
      case '-G': case '--get': o.getWithData = true; break;
      case '-v': case '--verbose': o.verbose = true; break;
      case '--compressed': o.compressed = true; break;
      case '-o': case '--output': { const v = need(i, a); if (v != null) { o.output = v; i++; } break; }
      case '-X': case '--request': { const v = need(i, a); if (v != null) { o.method = v; i++; } break; }
      case '-H': case '--header': { const v = need(i, a); if (v != null) { o.headers.push(v); i++; } break; }
      case '-A': case '--user-agent': { const v = need(i, a); if (v != null) { o.userAgent = v; i++; } break; }
      case '-e': case '--referer': { const v = need(i, a); if (v != null) { o.referer = v; i++; } break; }
      case '-b': case '--cookie': { const v = need(i, a); if (v != null) { o.cookie = v; i++; } break; }
      case '-u': case '--user': { const v = need(i, a); if (v != null) { o.basicAuth = v; i++; } break; }
      case '-w': case '--write-out': { const v = need(i, a); if (v != null) { o.writeOut = v; i++; } break; }
      case '-d': case '--data': case '--data-ascii': { const v = need(i, a); if (v != null) { o.data.push(v); o.dataMode = o.dataMode || 'raw'; i++; } break; }
      case '--data-raw': { const v = need(i, a); if (v != null) { o.data.push({ raw: v }); o.dataMode = o.dataMode || 'raw'; i++; } break; }
      case '--data-binary': { const v = need(i, a); if (v != null) { o.data.push(v); o.dataMode = 'binary'; i++; } break; }
      case '--data-urlencode': { const v = need(i, a); if (v != null) { o.data.push({ urlencode: v }); o.dataMode = o.dataMode || 'raw'; i++; } break; }
      case '--url': { const v = need(i, a); if (v != null) { o.urls.push(v); i++; } break; }
      case '-m': case '--max-time': { const v = need(i, a); if (v != null) { o.maxTime = Number(v) || 0; i++; } break; }
      case '--connect-timeout': { const v = need(i, a); if (v != null) { o.connectTimeout = Number(v) || 0; i++; } break; }
      default:
        if (a && a.startsWith('-') && a !== '-') { errs.push(`curl: option ${a}: is unknown`); }
        else o.urls.push(a);
    }
  }
  return { o, errs };
}

function normalizeUrl(u) {
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(u)) u = 'http://' + u;
  return u;
}

// Build request body from -d entries (@file / stdin / literal), joined by '&'.
function buildBody(o, ctx, stdin) {
  if (!o.data.length) return null;
  const parts = [];
  for (const d of o.data) {
    if (d && typeof d === 'object' && 'raw' in d) { parts.push(d.raw); continue; }
    if (d && typeof d === 'object' && 'urlencode' in d) {
      const s = d.urlencode;
      const eq = s.indexOf('=');
      if (eq >= 0) parts.push(encodeURIComponent(s.slice(0, eq)) + '=' + encodeURIComponent(s.slice(eq + 1)));
      else parts.push(encodeURIComponent(s));
      continue;
    }
    let s = String(d);
    if (s.startsWith('@')) {
      // @file (or @- for stdin) reads the file for BOTH -d and --data-binary. -d strips
      // newlines; --data-binary sends verbatim. Previously binary mode skipped this and
      // POSTed the literal "@file" string.
      const fn = s.slice(1);
      if (fn === '-') s = stdin != null ? stdin.toString('utf8') : '';
      else { try { s = fsRead(ctx, fn).toString('utf8'); } catch { s = ''; } }
      if (o.dataMode !== 'binary') s = s.replace(/[\r\n]/g, '');
    }
    parts.push(s);
  }
  return parts.join(o.dataMode === 'binary' ? '' : '&');
}

function decodeBody(buf, encoding) {
  try {
    if (!encoding) return buf;
    encoding = String(encoding).toLowerCase();
    if (encoding === 'gzip') return zlib.gunzipSync(buf);
    if (encoding === 'deflate') { try { return zlib.inflateSync(buf); } catch { return zlib.inflateRawSync(buf); } }
    if (encoding === 'br') return zlib.brotliDecompressSync(buf);
  } catch { /* fall through: return raw */ }
  return buf;
}

// Perform a single request (no redirect following); returns {status,statusMessage,headers,bodyBuf}.
function doRequest(urlStr, method, headers, bodyBuf, opts) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { reject(new Error(`curl: (3) URL rejected: ${urlStr}`)); return; }
    const isHttps = u.protocol === 'https:';
    const port = u.port ? Number(u.port) : (isHttps ? 443 : 80);
    const path = (u.pathname || '/') + (u.search || '');
    const proxy = opts.proxy && !noProxyMatch(u.hostname, opts.noProxy) ? opts.proxy : '';

    const reqHeaders = Object.assign({}, headers);
    if (!Object.keys(reqHeaders).some(h => h.toLowerCase() === 'host')) reqHeaders['Host'] = u.host;
    if (u.username || u.password) {
      reqHeaders['Authorization'] = 'Basic ' + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64');
    }
    if (bodyBuf != null) reqHeaders['Content-Length'] = Buffer.byteLength(bodyBuf);

    const commonOpts = {
      method, headers: reqHeaders,
      rejectUnauthorized: !opts.insecure,
    };

    const onResp = (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode, statusMessage: res.statusMessage || '',
        headers: res.headers, httpVersion: res.httpVersion,
        bodyBuf: Buffer.concat(chunks),
      }));
      res.on('error', reject);
    };

    let clientReq;
    const finish = (reqObj) => {
      clientReq = reqObj;
      if (opts.connectTimeout) clientReq.setTimeout(opts.connectTimeout * 1000, () => clientReq.destroy(new Error('curl: (28) Connection timed out')));
      clientReq.on('error', reject);
      if (bodyBuf != null) clientReq.write(bodyBuf);
      clientReq.end();
    };

    if (proxy && isHttps) {
      // HTTPS-over-proxy: open a raw CONNECT tunnel, do OUR OWN TLS handshake on it
      // (tls.connect), then speak PLAINTEXT HTTP/1.1 over that already-encrypted
      // socket. Two traps we avoid:
      //   1. It must be http.request, NOT https.request — https.request would do a
      //      SECOND TLS handshake on the already-TLS socket (double-TLS) → the
      //      server answers garbage → "wrong version number" EPROTO, exit 7.
      //   2. Feed the connected socket through a custom Agent's createConnection, and
      //      pass NEITHER host/port NOR socket in the request options. Passing host/
      //      port (or createConnection directly on the options with agent:false) makes
      //      node dial a FRESH localhost:80 connection instead of reusing tlsSock
      //      → ECONNREFUSED ::1:80. A dedicated Agent whose createConnection returns
      //      tlsSock is the only wiring node honors across versions.
      connectTunnel(proxy, u.hostname, port).then((socket) => {
        const tlsSock = tls.connect({ socket, servername: u.hostname, rejectUnauthorized: !opts.insecure }, () => {
          const tunnelAgent = new http.Agent({ keepAlive: false });
          tunnelAgent.createConnection = () => tlsSock;
          finish(http.request({ method, path, headers: reqHeaders, agent: tunnelAgent }, onResp));
        });
        tlsSock.on('error', reject);
      }).catch(reject);
      return;
    }
    if (proxy && !isHttps) {
      // plain HTTP via proxy: absolute-form request-target
      const p = new URL(proxy);
      const pPort = Number(p.port) || (p.protocol === 'https:' ? 443 : 80);
      if (p.username) reqHeaders['Proxy-Authorization'] = 'Basic ' + Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64');
      finish(http.request({ host: p.hostname, port: pPort, method, path: urlStr, headers: reqHeaders }, onResp));
      return;
    }
    // direct
    const reqFn = isHttps ? https.request : http.request;
    finish(reqFn(Object.assign({}, commonOpts, { host: u.hostname, port, path }), onResp));
  });
}

// ---- main handler ----------------------------------------------------------
async function curlMain(args, ctx) {
  const { o, errs } = parseArgs(args || []);
  const env = envOf(ctx);

  // --version / --help short-circuits
  if ((args || []).includes('--version') || (args || []).includes('-V')) {
    return ok('curl 8.0.0 (ios-lshell) libcurl/8.0.0 node-https\n' +
      'Release-Date: 2026-01-01\n' +
      'Protocols: http https\n' +
      'Features: HTTPS-proxy AsyncDNS Redirect-Follow Basic-Auth\n');
  }
  if ((args || []).includes('--help') || (args || []).includes('-h')) {
    return ok('Usage: curl [options...] <url>\nSupported: -s -S -o -O -L -H -A -e -d --data-raw --data-binary --data-urlencode -G -X -I -i -f -k -u -w -b --compressed -m --connect-timeout -v\n');
  }

  if (errs.length && !o.urls.length) return ok('', 2, errs.join('\n') + '\n');
  if (!o.urls.length) return ok('', 2, 'curl: no URL specified\ncurl: try \'curl --help\' for more information\n');

  const stdin = ctx && ctx.stdin != null ? (Buffer.isBuffer(ctx.stdin) ? ctx.stdin : Buffer.from(String(ctx.stdin))) : null;

  const opts = {
    proxy: proxyForProtocol('https:', env), // resolved per-url below actually
    noProxy: env.NO_PROXY || env.no_proxy || '',
    insecure: o.insecure,
    connectTimeout: o.connectTimeout || o.maxTime,
  };

  let outText = '';
  let errText = errs.length ? errs.join('\n') + '\n' : '';
  let exitCode = 0;

  for (let urlRaw of o.urls) {
    let url = normalizeUrl(urlRaw);
    let method = o.method || (o.head ? 'HEAD' : (o.data.length && !o.getWithData ? 'POST' : 'GET'));

    // Assemble headers
    const hdrs = {};
    const setH = (k, v) => { hdrs[k] = v; };
    setH('User-Agent', o.userAgent || 'curl/8.0.0');
    setH('Accept', '*/*');
    if (o.referer) setH('Referer', o.referer);
    if (o.cookie) setH('Cookie', o.cookie);
    if (o.compressed) setH('Accept-Encoding', 'gzip, deflate, br');
    if (o.basicAuth) setH('Authorization', 'Basic ' + Buffer.from(o.basicAuth).toString('base64'));
    let bodyStr = buildBody(o, ctx, stdin);
    if (o.getWithData && bodyStr != null) {
      const u = new URL(url);
      u.search = (u.search ? u.search + '&' : '?') + bodyStr;
      url = u.toString();
      bodyStr = null;
      method = o.method || 'GET';
    }
    if (bodyStr != null && !Object.keys(hdrs).some(h => h.toLowerCase() === 'content-type')) {
      setH('Content-Type', 'application/x-www-form-urlencoded');
    }
    // user -H overrides / additions (also allow removal with 'K:')
    for (const h of o.headers) {
      const idx = h.indexOf(':');
      if (idx < 0) continue;
      const k = h.slice(0, idx).trim();
      const v = h.slice(idx + 1).trim();
      // delete any existing case-insensitive key first
      for (const ek of Object.keys(hdrs)) if (ek.toLowerCase() === k.toLowerCase()) delete hdrs[ek];
      if (v === '') continue; // `K:` with empty value removes header
      setH(k, v);
    }

    const bodyBuf = bodyStr != null ? Buffer.from(bodyStr) : null;

    // Redirect loop
    let redirects = 0;
    let resp;
    try {
      let curUrl = url, curMethod = method, curBody = bodyBuf;
      while (true) {
        // pick proxy per protocol of the CURRENT url
        const proto = new URL(curUrl).protocol;
        opts.proxy = proxyForProtocol(proto, env);
        if (o.verbose) errText += `* Connecting to ${curUrl}\n> ${curMethod} ${curUrl}\n`;
        resp = await doRequest(curUrl, curMethod, hdrs, curBody, opts);
        if (o.verbose) errText += `< HTTP ${resp.status} ${resp.statusMessage}\n`;
        if (o.followRedirects && resp.status >= 300 && resp.status < 400 && resp.headers.location && redirects < MAX_REDIRECTS) {
          redirects++;
          curUrl = new URL(resp.headers.location, curUrl).toString();
          if (resp.status === 303 || ((resp.status === 301 || resp.status === 302) && curMethod === 'POST')) { curMethod = 'GET'; curBody = null; delete hdrs['Content-Type']; }
          continue;
        }
        break;
      }
    } catch (e) {
      errText += (String(e && e.message || e).startsWith('curl:') ? String(e.message) : `curl: (7) ${String(e && e.message || e)}`) + '\n';
      exitCode = 7;
      continue;
    }

    // --fail: HTTP >= 400 → exit 22, no body
    if (o.fail && resp.status >= 400) {
      errText += `curl: (22) The requested URL returned error: ${resp.status}${resp.statusMessage ? ' ' + resp.statusMessage : ''}\n`;
      exitCode = 22;
      continue;
    }

    // Build header block text
    let headerBlock = '';
    if (o.includeHeaders || o.head) {
      headerBlock += `HTTP/${resp.httpVersion || '1.1'} ${resp.status} ${resp.statusMessage}\r\n`;
      for (const k of Object.keys(resp.headers)) {
        const v = resp.headers[k];
        if (Array.isArray(v)) for (const vv of v) headerBlock += `${k}: ${vv}\r\n`;
        else headerBlock += `${k}: ${v}\r\n`;
      }
      headerBlock += '\r\n';
    }

    const encoding = resp.headers['content-encoding'];
    let body = o.head ? Buffer.alloc(0) : decodeBody(resp.bodyBuf, encoding);

    // Output routing
    let targetFile = o.output;
    if (o.remoteName && !targetFile) {
      const u = new URL(url);
      targetFile = nodePath.basename(u.pathname) || 'index.html';
    }
    if (o.writeOut) {
      // append write-out to stdout (after body, like curl)
    }

    if (targetFile && targetFile !== '-' && targetFile !== '/dev/null') {
      try {
        const outBuf = (o.includeHeaders ? Buffer.concat([Buffer.from(headerBlock), body]) : body);
        fsWrite(ctx, targetFile, outBuf);
      } catch (e) {
        errText += `curl: (23) Failed writing output: ${String(e && e.message || e)}\n`;
        exitCode = 23;
      }
    } else if (targetFile === '/dev/null') {
      // discard body (but write-out below may still print stats)
    } else {
      outText += headerBlock;
      outText += body.toString('utf8');
    }

    if (o.writeOut) {
      outText += renderWriteOut(o.writeOut, resp, body);
    }
  }

  // -s silences errors unless -S; but never silence hard usage errors we already emitted
  if (o.silent && !o.showError) {
    // suppress transfer error lines (curl: (...)) but keep nothing — curl -s hides them
    errText = errText.replace(/^curl: \(\d+\).*\n?/gm, '');
  }

  return ok(outText, exitCode, errText);
}

function renderWriteOut(fmt, resp, body) {
  return String(fmt)
    .replace(/%\{http_code\}/g, String(resp.status))
    .replace(/%\{size_download\}/g, String(body.length))
    .replace(/%\{content_type\}/g, String(resp.headers['content-type'] || ''))
    .replace(/%\{url_effective\}/g, '')
    .replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r');
}

// wget: thin alias mapping common wget flags onto curlMain.
//   wget URL            → download to basename (like -O basename, curl -o)
//   wget -O FILE URL    → curl -o FILE
//   wget -q             → curl -s
//   wget -o LOGFILE     → ignored (log file)
async function wgetMain(args, ctx) {
  const mapped = [];
  let explicitOut = false;
  let quiet = false;
  const urls = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-O' || a === '--output-document') { mapped.push('-o', args[i + 1]); explicitOut = true; i++; continue; }
    if (a === '-q' || a === '--quiet') { quiet = true; continue; }
    if (a === '-o' || a === '--output-file') { i++; continue; } // log file → ignore
    if (a === '--no-check-certificate') { mapped.push('-k'); continue; }
    if (a === '-U' || a === '--user-agent') { mapped.push('-A', args[i + 1]); i++; continue; }
    if (a === '--header') { mapped.push('-H', args[i + 1]); i++; continue; }
    if (a === '--post-data') { mapped.push('-d', args[i + 1]); i++; continue; }
    if (a === '-c' || a === '--continue') { continue; }
    if (a === '--content-disposition') { continue; }
    if (a && a.startsWith('-')) { continue; } // ignore unknown wget flags
    urls.push(a);
  }
  if (quiet) mapped.unshift('-s');
  // default wget writes each url to its basename unless -O given
  if (!explicitOut) {
    for (const u of urls) {
      const parsed = (() => { try { return new URL(normalizeUrl(u)); } catch { return null; } })();
      const base = parsed ? (nodePath.basename(parsed.pathname) || 'index.html') : 'index.html';
      const r = await curlMain(mapped.concat(['-o', base, u]), ctx);
      if (r.exitCode) return r;
    }
    return ok('', 0, quiet ? '' : `Saved ${urls.length} file(s).\n`);
  }
  return curlMain(mapped.concat(urls), ctx);
}

function registerCurl(bash, injectedDefineCommand) {
  let defineCommand = injectedDefineCommand;
  if (typeof defineCommand !== 'function') { try { ({ defineCommand } = require('just-bash')); } catch { return; } }
  if (typeof defineCommand !== 'function') return;
  try { bash.registerCommand(defineCommand('curl', async (args, ctx) => curlMain(args, ctx))); } catch { /* skip */ }
  try { bash.registerCommand(defineCommand('wget', async (args, ctx) => wgetMain(args, ctx))); } catch { /* skip */ }
}

module.exports = { registerCurl, curlMain, wgetMain };
