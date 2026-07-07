'use strict';
// Pure-JS ripgrep for jitless V8 (no JIT, no WASM). Backend of Claude Code's Grep
// tool: file enumeration (`rg --files`) and content search with rg-compatible
// output — context lines (-A/-B/-C with `--` group separators), --json events,
// -t/-T type filters, .gitignore/.ignore semantics. Rust-regex patterns are
// translated to JS RegExp; untranslatable patterns yield rg-style
// `regex parse error` + exit 2 (never a throw — a throw would kill the session).
// Contract (register.js): rg() returns {code,stdout,stderr} synchronously, OR a
// Promise of it once a >4MB file must be streamed (the async spawn path awaits
// either; only spawnSync callers searching >4MB files would miss out).

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const SKIP_UNLESS_U = new Set(['node_modules', '.DS_Store']);
const NUL = String.fromCharCode(0);
const BIG_FILE = 4 * 1024 * 1024; // stream above this: bounded memory on-device
const __stats = { streamedFiles: 0 }; // test probe: counts files taken down the streaming path

// ---------------------------------------------------------------------------
// argv parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const o = {
    files: false, hidden: false, noIgnore: false, follow: false, maxDepth: Infinity,
    ignoreCase: false, smartCase: true, fixedStrings: false, wordRegexp: false,
    lineNumber: true, filesWithMatches: false, count: false, onlyMatching: false,
    invert: false, quiet: false, json: false, noFilename: false,
    globs: [], types: [], typesNot: [], contextBefore: 0, contextAfter: 0,
    maxCount: Infinity, maxColumns: 0, pattern: null, paths: [],
  };
  const patterns = [];
  const int = (v) => { const n = parseInt(v, 10); return Number.isNaN(n) ? 0 : n; };
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i] == null ? '' : argv[i]);
    const next = () => argv[++i];
    let m;
    if (a === '--files') o.files = true;
    else if (a === '--hidden') o.hidden = true;
    else if (a === '-u' || a === '--no-ignore' || a === '--unrestricted') o.noIgnore = true;
    else if (a === '-uu' || a === '-uuu') { o.noIgnore = true; o.hidden = true; }
    else if (a === '-L' || a === '--follow') o.follow = true;
    else if (a === '-d' || a === '--max-depth') o.maxDepth = int(next());
    else if (a.startsWith('--max-depth=')) o.maxDepth = int(a.slice(12));
    else if (a === '-i' || a === '--ignore-case') { o.ignoreCase = true; o.smartCase = false; }
    else if (a === '-s' || a === '--case-sensitive') { o.ignoreCase = false; o.smartCase = false; }
    else if (a === '-S' || a === '--smart-case') o.smartCase = true;
    else if (a === '-F' || a === '--fixed-strings') o.fixedStrings = true;
    else if (a === '-w' || a === '--word-regexp') o.wordRegexp = true;
    else if (a === '-n' || a === '--line-number') o.lineNumber = true;
    else if (a === '-N' || a === '--no-line-number') o.lineNumber = false;
    else if (a === '-l' || a === '--files-with-matches') o.filesWithMatches = true;
    else if (a === '-c' || a === '--count') o.count = true;
    else if (a === '-o' || a === '--only-matching') o.onlyMatching = true;
    else if (a === '-v' || a === '--invert-match') o.invert = true;
    else if (a === '-q' || a === '--quiet') o.quiet = true;
    else if (a === '--json') o.json = true;
    else if (a === '-I' || a === '--no-filename') o.noFilename = true;
    else if (a === '-e' || a === '--regexp') patterns.push(next());
    else if (a.startsWith('--regexp=')) patterns.push(a.slice(9));
    else if (a === '-g' || a === '--glob') o.globs.push(next());
    else if (a.startsWith('--glob=')) o.globs.push(a.slice(7));
    else if (a === '-t' || a === '--type') o.types.push(next());
    else if (a.startsWith('--type=')) o.types.push(a.slice(7));
    else if (a === '-T' || a === '--type-not') o.typesNot.push(next());
    else if (a.startsWith('--type-not=')) o.typesNot.push(a.slice(11));
    else if (a === '-m' || a === '--max-count') o.maxCount = int(next());
    else if (a.startsWith('--max-count=')) o.maxCount = int(a.slice(12));
    else if (a === '-M' || a === '--max-columns') o.maxColumns = int(next());
    else if (a.startsWith('--max-columns=')) o.maxColumns = int(a.slice(14));
    else if (a === '-A' || a === '--after-context') o.contextAfter = int(next());
    else if (a.startsWith('--after-context=')) o.contextAfter = int(a.slice(16));
    else if (a === '-B' || a === '--before-context') o.contextBefore = int(next());
    else if (a.startsWith('--before-context=')) o.contextBefore = int(a.slice(17));
    else if (a === '-C' || a === '--context') { const n = int(next()); o.contextBefore = n; o.contextAfter = n; }
    else if (a.startsWith('--context=')) { const n = int(a.slice(10)); o.contextBefore = n; o.contextAfter = n; }
    else if ((m = /^-([ABCdmM])(\d+)$/.exec(a))) { // joined short forms: -A3, -C2, -m1 …
      const n = int(m[2]);
      if (m[1] === 'A') o.contextAfter = n;
      else if (m[1] === 'B') o.contextBefore = n;
      else if (m[1] === 'C') { o.contextBefore = n; o.contextAfter = n; }
      else if (m[1] === 'd') o.maxDepth = n;
      else if (m[1] === 'm') o.maxCount = n;
      else o.maxColumns = n;
    }
    else if (a === '--color' || a === '--colors' || a === '--sort' || a === '-j' || a === '--threads') { next(); }
    else if (a === '--version') { o.version = true; }
    else if (a === '--') { for (i++; i < argv.length; i++) { if (o.pattern == null && !o.files && patterns.length === 0) o.pattern = argv[i]; else o.paths.push(argv[i]); } }
    else if (a.startsWith('-') && a !== '-') { /* ignore unknown flags */ }
    else { if (!o.files && o.pattern == null && patterns.length === 0) o.pattern = a; else o.paths.push(a); }
  }
  if (patterns.length) o.pattern = patterns.length === 1 ? patterns[0] : '(' + patterns.join('|') + ')';
  if (!(o.maxCount >= 0)) o.maxCount = Infinity;
  return o;
}

// ---------------------------------------------------------------------------
// Rust-regex → JS RegExp translation
// ---------------------------------------------------------------------------
const POSIX_CLASSES = {
  alnum: 'A-Za-z0-9', alpha: 'A-Za-z', ascii: '\\x00-\\x7f', blank: ' \\t',
  cntrl: '\\x00-\\x1f\\x7f', digit: '0-9', graph: '\\x21-\\x7e', lower: 'a-z',
  print: '\\x20-\\x7e', punct: '!-/:-@\\[-`{-~', space: '\\s', upper: 'A-Z',
  word: '0-9A-Za-z_', xdigit: '0-9A-Fa-f',
};

// (?x): strip unescaped whitespace and #-comments (whole-pattern approximation).
function stripExtended(src) {
  let out = '', inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { out += c + (src[i + 1] || ''); i++; continue; }
    if (inClass) { out += c; if (c === ']') inClass = false; continue; }
    if (c === '[') { inClass = true; out += c; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (/\s/.test(c)) continue;
    out += c;
  }
  return out;
}

// Rust/rg regex syntax that JS RegExp rejects: inline flag groups, (?P<>)/(?P=),
// \A/\z anchors, POSIX classes. Inline flags are merged globally (approximation;
// rg scopes them from their position).
function translateRustRegex(src) {
  let out = '', flags = '', xMode = false, inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') {
      const n = src[i + 1];
      if (!inClass && n === 'A') { out += '^'; i++; continue; }
      if (!inClass && n === 'z') { out += '$'; i++; continue; }
      out += n == null ? c : c + n; // lone trailing '\' left as-is → RegExp error path
      if (n != null) i++;
      continue;
    }
    if (inClass) {
      if (c === '[' && src[i + 1] === ':') {
        const e = src.indexOf(':]', i + 2);
        if (e !== -1) {
          let name = src.slice(i + 2, e), neg = false;
          if (name[0] === '^') { neg = true; name = name.slice(1); }
          const exp = POSIX_CLASSES[name];
          if (exp) {
            if (neg && out.endsWith('[') && src[e + 2] === ']') out += '^' + exp;
            else out += exp; // negated-inside-larger-class approximated as positive
            i = e + 1;
            continue;
          }
        }
      }
      if (c === ']') inClass = false;
      out += c;
      continue;
    }
    if (c === '[') {
      inClass = true;
      out += c;
      if (src[i + 1] === '^') { out += '^'; i++; }
      continue;
    }
    if (c === '(' && src[i + 1] === '?') {
      if (src.startsWith('(?P<', i)) { out += '(?<'; i += 3; continue; }
      if (src.startsWith('(?P=', i)) {
        const e = src.indexOf(')', i);
        if (e !== -1) { out += '\\k<' + src.slice(i + 4, e) + '>'; i = e; continue; }
      }
      const fm = /^\(\?([imsxU]*)(?:-[imsxU]+)?([:)])/.exec(src.slice(i));
      if (fm && (fm[1] || fm[0].includes('-'))) {
        for (const f of fm[1]) { if (f === 'x') xMode = true; else if (f === 'i' || f === 'm' || f === 's') flags += f; }
        if (fm[2] === ':') out += '(?:';
        i += fm[0].length - 1;
        continue;
      }
      out += c;
      continue;
    }
    out += c;
  }
  if (xMode) out = stripExtended(out);
  return { source: out, flags };
}

// Throws on invalid patterns — caller maps to rg-style exit 2.
function buildMatcher(o) {
  if (o.pattern == null) return null;
  let src, inline = '';
  if (o.fixedStrings) src = String(o.pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  else { const t = translateRustRegex(String(o.pattern)); src = t.source; inline = t.flags; }
  if (o.wordRegexp) src = '\\b(?:' + src + ')\\b';
  let flags = 'g';
  const hasUpper = /[A-Z]/.test(o.pattern);
  if (o.ignoreCase || (o.smartCase && !hasUpper) || inline.includes('i')) flags += 'i';
  if (inline.includes('m')) flags += 'm';
  if (inline.includes('s')) flags += 's';
  return new RegExp(src, flags);
}

function execAll(matcher, text) {
  matcher.lastIndex = 0;
  const subs = []; let m;
  while ((m = matcher.exec(text))) {
    subs.push({ text: m[0], start: m.index, end: m.index + m[0].length });
    if (m.index === matcher.lastIndex) matcher.lastIndex++;
    if (subs.length >= 1000) break; // zero-width / pathological safety
  }
  return subs;
}

// ---------------------------------------------------------------------------
// globs, -t types
// ---------------------------------------------------------------------------
function globToRegExp(glob) {
  let re = '', brace = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') { if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; } else re += '[^/]*'; }
    else if (c === '?') re += '[^/]';
    else if (c === '[') {
      let j = i + 1, cls = '[';
      if (glob[j] === '!' || glob[j] === '^') { cls += '^'; j++; }
      for (; j < glob.length && glob[j] !== ']'; j++) cls += glob[j] === '\\' ? '\\\\' : glob[j];
      if (j < glob.length) { re += cls + ']'; i = j; } else re += '\\[';
    }
    else if (c === '{') { brace++; re += '(?:'; }
    else if (c === '}' && brace > 0) { brace--; re += ')'; }
    else if (c === ',' && brace > 0) re += '|';
    else if (c === '.') re += '\\.';
    else if ('+^${}()|]\\'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('(^|/)' + re + '$');
}

// Extension lists mirror `rg --type-list` (ripgrep 14.1); jsx/tsx/rb added as
// aliases Claude tends to use even though rg itself lacks them.
const TYPE_MAP = {
  c: ['*.[chH]', '*.[chH].in', '*.cats'],
  cpp: ['*.[ChH]', '*.[ChH].in', '*.[ch]pp', '*.[ch]pp.in', '*.[ch]xx', '*.[ch]xx.in', '*.cc', '*.cc.in', '*.hh', '*.hh.in', '*.inl'],
  cs: ['*.cs'],
  css: ['*.css', '*.scss'],
  go: ['*.go'],
  h: ['*.h', '*.hh', '*.hpp'],
  html: ['*.ejs', '*.htm', '*.html'],
  java: ['*.java', '*.jsp', '*.jspx', '*.properties'],
  js: ['*.cjs', '*.js', '*.jsx', '*.mjs', '*.vue'],
  json: ['*.json', '*.sarif', 'composer.lock'],
  jsx: ['*.jsx'],
  kotlin: ['*.kt', '*.kts'],
  markdown: ['*.markdown', '*.md', '*.mdown', '*.mdwn', '*.mdx', '*.mkd', '*.mkdn'],
  md: ['*.markdown', '*.md', '*.mdown', '*.mdwn', '*.mdx', '*.mkd', '*.mkdn'],
  php: ['*.php', '*.php3', '*.php4', '*.php5', '*.php7', '*.php8', '*.pht', '*.phtml'],
  py: ['*.py', '*.pyi'],
  rb: ['*.gemspec', '*.rb', '*.rbw', '.irbrc', 'Gemfile', 'Rakefile', 'config.ru'],
  ruby: ['*.gemspec', '*.rb', '*.rbw', '.irbrc', 'Gemfile', 'Rakefile', 'config.ru'],
  rust: ['*.rs'],
  sh: ['*.bash', '*.bashrc', '*.csh', '*.cshrc', '*.ksh', '*.kshrc', '*.sh', '*.tcsh', '*.zsh',
    '.bash_login', '.bash_logout', '.bash_profile', '.bashrc', '.cshrc', '.kshrc', '.login', '.logout',
    '.profile', '.tcshrc', '.zlogin', '.zlogout', '.zprofile', '.zshenv', '.zshrc',
    'bash_login', 'bash_logout', 'bash_profile', 'bashrc', 'profile', 'zlogin', 'zlogout', 'zprofile', 'zshenv', 'zshrc'],
  sql: ['*.psql', '*.sql'],
  swift: ['*.swift'],
  toml: ['*.toml', 'Cargo.lock'],
  ts: ['*.cts', '*.mts', '*.ts', '*.tsx'],
  tsx: ['*.tsx'],
  txt: ['*.txt'],
  xml: ['*.dtd', '*.rng', '*.sch', '*.xhtml', '*.xjb', '*.xml', '*.xml.dist', '*.xsd', '*.xsl', '*.xslt'],
  yaml: ['*.yaml', '*.yml'],
};

function passesFilters(file, o, tf) {
  if (o.globs.length) {
    const pos = o.globs.filter((g) => !String(g).startsWith('!'));
    const neg = o.globs.filter((g) => String(g).startsWith('!')).map((g) => String(g).slice(1));
    if (pos.length && !pos.some((g) => globToRegExp(g).test(file))) return false;
    if (neg.some((g) => globToRegExp(g).test(file))) return false;
  }
  if (tf) {
    if (tf.inc && !tf.inc.some((re) => re.test(file))) return false;
    if (tf.exc && tf.exc.some((re) => re.test(file))) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// .gitignore / .ignore
// ---------------------------------------------------------------------------
function compileIgnore(raw) {
  let p = String(raw).replace(/\r$/, '');
  if (!p || p[0] === '#') return null;
  p = p.replace(/[ \t]+$/, '');
  if (!p) return null;
  let negate = false;
  if (p[0] === '!') { negate = true; p = p.slice(1); }
  else if (p.startsWith('\\!') || p.startsWith('\\#')) p = p.slice(1);
  let dirOnly = false;
  if (p.endsWith('/')) { dirOnly = true; p = p.slice(0, -1); }
  if (!p) return null;
  let anchored = false;
  if (p[0] === '/') { anchored = true; p = p.slice(1); }
  else if (p.includes('/')) anchored = true; // git rule: any slash anchors to the ignore-file dir
  let body = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        i++;
        if (p[i + 1] === '/') { body += '(?:[^/]+/)*'; i++; } // '**/'  → any depth
        else body += '.*'; // trailing/bare '**'
      } else body += '[^/]*';
    } else if (c === '?') body += '[^/]';
    else if (c === '[') {
      let j = i + 1, cls = '[';
      if (p[j] === '!' || p[j] === '^') { cls += '^'; j++; }
      for (; j < p.length && p[j] !== ']'; j++) cls += p[j];
      if (j < p.length) { body += cls + ']'; i = j; } else body += '\\[';
    }
    else if ('.+^${}()|\\'.includes(c)) body += '\\' + c;
    else body += c;
  }
  try { return { re: new RegExp((anchored ? '^' : '(^|/)') + body + '$'), negate, dirOnly }; }
  catch { return null; }
}

function loadIgnores(dir, o) {
  if (o.noIgnore) return null;
  const rules = [];
  for (const name of ['.gitignore', '.ignore']) {
    let txt;
    try { txt = fs.readFileSync(path.join(dir, name), 'utf8'); } catch { continue; }
    for (const raw of txt.split('\n')) { const r = compileIgnore(raw); if (r) rules.push(r); }
  }
  return rules.length ? { dir, rules } : null;
}

// Last matching rule wins; deeper ignore files override shallower ones.
function ignoredBy(full, isDir, stack) {
  let ignored = false;
  for (const scope of stack) {
    const rel = full.slice(scope.dir.length + 1).split(path.sep).join('/');
    for (const r of scope.rules) {
      if (r.dirOnly && !isDir) continue;
      if (r.re.test(rel)) ignored = !r.negate;
    }
  }
  return ignored;
}

function* walk(root, o, depth = 0, stack) {
  if (stack === undefined) { const ig = loadIgnores(root, o); stack = ig ? [ig] : []; }
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    if (ent.name === '.git') continue; // never useful on-device; avoids trawling object DBs
    if (!o.hidden && ent.name.startsWith('.')) continue;
    if (SKIP_UNLESS_U.has(ent.name) && !o.noIgnore) continue;
    const full = path.join(root, ent.name);
    let isDir = ent.isDirectory();
    const isSym = ent.isSymbolicLink();
    if (isSym && o.follow) { try { isDir = fs.statSync(full).isDirectory(); } catch { continue; } }
    if (stack.length && ignoredBy(full, isDir, stack)) continue;
    if (isDir) {
      if (depth < o.maxDepth) {
        const sub = loadIgnores(full, o);
        yield* walk(full, o, depth + 1, sub ? [...stack, sub] : stack);
      }
    } else if (ent.isFile() || (isSym && o.follow)) yield full;
  }
}

function isBinary(content) {
  const scan = content.length > 8192 ? content.slice(0, 8192) : content;
  return scan.indexOf(NUL) !== -1;
}

// ---------------------------------------------------------------------------
// per-file emitter: matches, -A/-B/-C context (rg's ':' vs '-' separators and
// '--' between non-contiguous groups/files), --json events, -l/-c/-o/-q modes.
// Shared by the sync (≤4MB) and streaming paths.
// ---------------------------------------------------------------------------
const EL0 = () => ({ secs: 0, nanos: 0, human: '0.000000s' });

function makeFileSink(o, matcher, file, showFname, S) {
  const B = o.contextBefore > 0 ? o.contextBefore : 0;
  const A = o.contextAfter > 0 ? o.contextAfter : 0;
  const ctxMode = (B > 0 || A > 0) && !o.count && !o.filesWithMatches;
  let lineNo = 0, byteOff = 0, matches = 0, subCount = 0, matchedLines = 0;
  let afterLeft = 0, lastPrinted = 0, began = false, filePrinted = 0, done = false;
  const ring = []; // [lineNo, text, byteOffset] of the last B unprinted lines

  const fmt = (no, text, sep) => (showFname ? file + sep : '') + (o.lineNumber ? no + sep : '') + text;
  const cap = (text, isMatch) =>
    o.maxColumns > 0 && Buffer.byteLength(text) > o.maxColumns
      ? (isMatch ? '[Omitted long matching line]' : '[Omitted long context line]')
      : text;
  const jsonPush = (ev) => { const s = JSON.stringify(ev); S.out.push(s); filePrinted += s.length + 1; };
  const jsonBegin = () => { if (!began) { began = true; jsonPush({ type: 'begin', data: { path: { text: file } } }); } };
  const toBytes = (text, idx) => (/[^\x00-\x7f]/.test(text) ? Buffer.byteLength(text.slice(0, idx)) : idx);
  const jsonLineEv = (type, no, text, off, subs) => {
    jsonBegin();
    jsonPush({
      type,
      data: {
        path: { text: file },
        lines: { text: text + '\n' },
        line_number: no,
        absolute_offset: off,
        submatches: (subs || []).map((s) => ({ match: { text: s.text }, start: toBytes(text, s.start), end: toBytes(text, s.end) })),
      },
    });
  };
  const emitCtx = (no, text, off) => {
    if (o.json) jsonLineEv('context', no, text, off, []);
    else S.out.push(fmt(no, cap(text, false), '-'));
    lastPrinted = no;
  };
  const emitMatch = (no, text, off, subs) => {
    if (o.json) jsonLineEv('match', no, text, off, o.invert ? [] : subs || execAll(matcher, text));
    else if (o.onlyMatching && subs && subs.length) { for (const s of subs) S.out.push(fmt(no, s.text, ':')); }
    else S.out.push(fmt(no, cap(text, true), ':'));
    lastPrinted = no;
  };

  return {
    get done() { return done; },
    onLine(text) {
      lineNo++;
      const off = byteOff;
      if (o.json) byteOff += Buffer.byteLength(text) + 1;
      if (done) return;
      matcher.lastIndex = 0;
      let subs = null, hit;
      if (o.invert) hit = !matcher.test(text);
      else if (!o.json && !o.onlyMatching) hit = matcher.test(text);
      else { subs = execAll(matcher, text); hit = subs.length > 0; }
      if (hit && matches < o.maxCount) {
        matches++; matchedLines++;
        if (subs) subCount += subs.length; else if (!o.invert) subCount++;
        S.anyMatch = true;
        if (o.quiet) { S.quietHit = true; done = true; return; }
        if (o.filesWithMatches) { S.out.push(file); done = true; return; }
        if (!o.count) {
          // '--' between non-contiguous groups; also separates files (rg behavior).
          const groupStart = Math.max(lineNo - B, 1);
          if (ctxMode && !o.json && S.printedGroup && (lastPrinted === 0 || groupStart > lastPrinted + 1)) S.out.push('--');
          for (const ent of ring) { if (ent[0] > lastPrinted && ent[0] >= groupStart) emitCtx(ent[0], ent[1], ent[2]); }
          emitMatch(lineNo, text, off, subs);
          S.printedGroup = true;
          afterLeft = A;
        }
      } else if (!o.count && !o.filesWithMatches) {
        if (afterLeft > 0 && ctxMode) { emitCtx(lineNo, text, off); afterLeft--; }
        else if (B > 0 && ctxMode) { ring.push([lineNo, text, off]); if (ring.length > B) ring.shift(); }
      }
      if (matches >= o.maxCount && afterLeft === 0) done = true;
    },
    end(size) {
      if (o.count && matches > 0) S.out.push((showFname ? file + ':' : '') + matches);
      if (o.json && began) {
        jsonPush({
          type: 'end',
          data: {
            path: { text: file },
            binary_offset: null,
            stats: {
              elapsed: EL0(), searches: 1, searches_with_match: 1,
              bytes_searched: size || byteOff, bytes_printed: filePrinted,
              matched_lines: matchedLines, matches: subCount,
            },
          },
        });
      }
      S.tot.searches++;
      if (matchedLines > 0) S.tot.searchesWithMatch++;
      S.tot.matchedLines += matchedLines;
      S.tot.matches += subCount;
      S.tot.bytesSearched += size || byteOff;
      S.tot.bytesPrinted += filePrinted;
    },
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function rg(argv, ctx = {}) {
  try { return rgMain(argv, ctx); }
  catch (e) { return { code: 2, stdout: '', stderr: 'rg: ' + String((e && e.message) || e) + '\n' }; }
}

function rgMain(argv, ctx) {
  const cwd = ctx.cwd || process.cwd();
  const o = parseArgs(argv);
  if (o.version) return { code: 0, stdout: 'ripgrep 14.1.0 (just-ios shim)\n', stderr: '' };

  for (const t of [...o.types, ...o.typesNot]) {
    if (!TYPE_MAP[t]) return { code: 2, stdout: '', stderr: 'rg: unrecognized file type: ' + t + '\n' };
  }
  const tf = (o.types.length || o.typesNot.length) ? {
    inc: o.types.length ? o.types.flatMap((t) => TYPE_MAP[t]).map(globToRegExp) : null,
    exc: o.typesNot.length ? o.typesNot.flatMap((t) => TYPE_MAP[t]).map(globToRegExp) : null,
  } : null;

  const roots = (o.paths.length ? o.paths : ['.']).map((p) => (path.isAbsolute(p) ? p : path.resolve(cwd, p)));

  // --files: enumerate.
  if (o.files) {
    const out = [];
    for (const r of roots) {
      let st; try { st = fs.statSync(r); } catch { continue; }
      if (st.isFile()) { if (passesFilters(r, o, tf)) out.push(r); continue; }
      for (const f of walk(r, o)) if (passesFilters(f, o, tf)) out.push(f);
    }
    return { code: out.length ? 0 : 1, stdout: out.join('\n') + (out.length ? '\n' : ''), stderr: '' };
  }

  // search mode.
  let matcher;
  try { matcher = buildMatcher(o); }
  catch (e) {
    return {
      code: 2, stdout: '',
      stderr: 'rg: regex parse error:\n    ' + o.pattern + '\nerror: ' + String((e && e.message) || e) + '\n',
    };
  }
  if (!matcher) return { code: 2, stdout: '', stderr: 'rg: no pattern given\n' };

  const targets = [];
  for (const r of roots) {
    let st; try { st = fs.statSync(r); } catch { continue; }
    if (st.isFile()) targets.push(r);
    else for (const f of walk(r, o)) targets.push(f);
  }
  const dirRoot = roots.length === 1 && (() => { try { return fs.statSync(roots[0]).isDirectory(); } catch { return false; } })();
  const showFname = (targets.length > 1 || dirRoot) && !o.noFilename;

  const S = {
    out: [], anyMatch: false, quietHit: false, printedGroup: false,
    tot: { searches: 0, searchesWithMatch: 0, matchedLines: 0, matches: 0, bytesSearched: 0, bytesPrinted: 0 },
  };

  const searchSyncFile = (file, size) => {
    let content;
    try { content = fs.readFileSync(file, 'utf8'); } catch { return; }
    if (isBinary(content)) return;
    const lines = content.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop(); // trailing \n is a terminator, not a line
    const sink = makeFileSink(o, matcher, file, showFname, S);
    for (const line of lines) { sink.onLine(line); if (sink.done) break; }
    sink.end(size);
  };

  const streamFile = async (file, size) => {
    let fd, head = null;
    try {
      fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(8192);
      const n = fs.readSync(fd, buf, 0, 8192, 0);
      head = buf.slice(0, n);
    } catch { head = null; }
    finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
    if (head === null || head.includes(0)) return; // unreadable or binary
    __stats.streamedFiles++;
    const sink = makeFileSink(o, matcher, file, showFname, S);
    const stream = fs.createReadStream(file, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of rl) { sink.onLine(line); if (sink.done || S.quietHit) break; }
    } catch { /* mid-stream read error: treat as EOF */ }
    rl.close();
    stream.destroy();
    sink.end(size);
  };

  const finalize = () => {
    if (S.quietHit) return { code: 0, stdout: '', stderr: '' };
    if (o.json) {
      S.out.push(JSON.stringify({
        data: {
          elapsed_total: { human: '0.000000s', nanos: 0, secs: 0 },
          stats: {
            bytes_printed: S.tot.bytesPrinted, bytes_searched: S.tot.bytesSearched, elapsed: EL0(),
            matched_lines: S.tot.matchedLines, matches: S.tot.matches,
            searches: S.tot.searches, searches_with_match: S.tot.searchesWithMatch,
          },
        },
        type: 'summary',
      }));
    }
    return { code: S.anyMatch ? 0 : 1, stdout: S.out.length ? S.out.join('\n') + '\n' : '', stderr: '' };
  };

  const filtered = targets.filter((f) => passesFilters(f, o, tf));
  for (let i = 0; i < filtered.length; i++) {
    if (S.quietHit) break;
    let st; try { st = fs.statSync(filtered[i]); } catch { continue; }
    if (st.size > BIG_FILE) {
      // Go async from here; results accumulated so far stay in S.
      return (async () => {
        for (let j = i; j < filtered.length; j++) {
          if (S.quietHit) break;
          let s2; try { s2 = fs.statSync(filtered[j]); } catch { continue; }
          if (s2.size > BIG_FILE) await streamFile(filtered[j], s2.size);
          else searchSyncFile(filtered[j], s2.size);
        }
        return finalize();
      })().catch((e) => ({ code: 2, stdout: '', stderr: 'rg: ' + String((e && e.message) || e) + '\n' }));
    }
    searchSyncFile(filtered[i], st.size);
  }
  return finalize();
}

module.exports = { rg, parseArgs, translateRustRegex, __stats };
