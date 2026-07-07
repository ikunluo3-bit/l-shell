// Tests for the ripgrep.js fixes: rust-regex translation, -A/-B/-C context
// lines, --json events, -t/-T type filters, .gitignore semantics, >4MB
// streaming, plus regression checks on previously-working flags.
// Where the vendored real ripgrep binary is present, output is diffed against
// it for fidelity. No network needed.
// Run under: node --jitless test/test-ripgrep-fixes.mjs   (Node 18 and Node 24)
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { rg, __stats, translateRustRegex } = require('../node-runtime/preload/commands/ripgrep.js');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗ FAIL:', m)); };
// rg may return a plain object or a Promise; normalize + alias stdout→out.
const run = async (args, cwd) => { const r = await rg(args, { cwd: cwd || WS }); return { ...r, out: r.stdout }; };

// Seed a temp workspace.
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'rgfix-'));
const W = (rel, content) => {
  const p = path.join(WS, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
};

// Real ripgrep (vendored by Claude Code) for fidelity diffing, if runnable.
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const plat = process.platform === 'darwin' ? 'darwin' : 'linux';
const RG_BIN = path.join(ROOT, 'node-runtime/vendor/claude-code/vendor/ripgrep', `${arch}-${plat}`, 'rg');
let haveRealRg = false;
try { execFileSync(RG_BIN, ['--version'], { encoding: 'utf8' }); haveRealRg = true; } catch { /* skip diffs */ }
const realRg = (args) => {
  try { return { code: 0, out: execFileSync(RG_BIN, ['--no-config', '-j1', ...args], { encoding: 'utf8' }) }; }
  catch (e) { return { code: e.status, out: e.stdout || '' }; }
};

(async () => {
  // =========================================================================
  // 1) Rust regex syntax translation — must NEVER throw out of rg().
  // =========================================================================
  const rx = W('rx.txt', 'FOO bar\nplain needle line\nxaay\nabc123\nfoo bar\nbarfoo\n');
  let r = await run(['(?i)foo', rx]);
  ok(r.code === 0 && r.out.includes('FOO bar') && r.out.includes('foo bar'), '(?i)foo matches FOO (inline flag merged)');

  r = await run(['(?P<w>need)le', rx]);
  ok(r.code === 0 && r.out.includes('needle'), '(?P<name>...) group translates');

  r = await run(['(?P<c>a)(?P=c)', rx]);
  ok(r.code === 0 && r.out.includes('xaay'), '(?P=name) backreference translates');

  r = await run(['[[:alpha:]]+[[:digit:]]{3}', rx]);
  ok(r.code === 0 && r.out.includes('abc123'), 'POSIX classes [[:alpha:]] [[:digit:]] translate');

  const digitsOnly = W('digits.txt', '12345\n');
  r = await run(['[[:^digit:]]', digitsOnly]);
  ok(r.code === 1, 'negated POSIX class [[:^digit:]] finds nothing in all-digit line');
  r = await run(['[[:^digit:]]', rx]);
  ok(r.code === 0, 'negated POSIX class matches non-digit text');

  r = await run(['\\Afoo', rx]);
  ok(r.code === 0 && r.out.trim().split('\n').length === 1 && r.out.includes('foo bar') && !r.out.includes('barfoo'),
    '\\A anchors to line start only');
  r = await run(['foo\\z', rx]);
  ok(r.code === 0 && r.out.trim() === '6:barfoo', '\\z anchors to line end');

  r = await run(['(?x)n e e d l e  # find the needle', rx]);
  ok(r.code === 0 && r.out.includes('needle'), '(?x) strips whitespace and #comments');

  let threw = false;
  try { r = await run(['(unclosed', rx]); } catch { threw = true; }
  ok(!threw, 'invalid pattern does not throw out of rg()');
  ok(r.code === 2 && /regex parse error/.test(r.stderr) && r.stdout === '',
    'invalid pattern → exit 2 + rg-style stderr');

  try { r = await run(['(?P<9bad>x)', rx]); } catch { threw = true; }
  ok(!threw && r.code === 2 && /regex parse error/.test(r.stderr), 'bad group name after translation → exit 2, no throw');

  const t = translateRustRegex('(?i)(?P<n>a)\\Ab\\z[[:alpha:]]');
  ok(t.flags === 'i' && t.source === '(?<n>a)^b$[A-Za-z]', 'translateRustRegex source/flags exact');

  // =========================================================================
  // 2) Context lines -A/-B/-C (formats verified against real rg 14.1.1).
  // =========================================================================
  const f1 = W('ctx/f1.txt', 'l1\nl2 match\nl3\nl4\nl5\nl6\nl7 match\nl8\nl9\nl10 match\nl11\n');
  const f2 = W('ctx/f2.txt', 'x1\nx2 match\nx3\n');

  r = await run(['-n', '-C2', 'match', f1]);
  ok(r.out === ['1-l1', '2:l2 match', '3-l3', '4-l4', '5-l5', '6-l6', '7:l7 match', '8-l8', '9-l9', '10:l10 match', '11-l11'].join('\n') + '\n',
    '-C2 merges overlapping/adjacent context, dash separators');

  r = await run(['-n', '-A1', 'match', f1]);
  ok(r.out === ['2:l2 match', '3-l3', '--', '7:l7 match', '8-l8', '--', '10:l10 match', '11-l11'].join('\n') + '\n',
    '-A1 groups split by -- separators');

  r = await run(['-n', '-B1', 'match', f1]);
  ok(r.out === ['1-l1', '2:l2 match', '--', '6-l6', '7:l7 match', '--', '9-l9', '10:l10 match'].join('\n') + '\n',
    '-B1 before-context with -- separators');

  r = await run(['-C1', 'match', f1, f2]); // shim defaults line numbers on (like Claude Code's -n)
  ok(r.out === [
    `${f1}-1-l1`, `${f1}:2:l2 match`, `${f1}-3-l3`, '--',
    `${f1}-6-l6`, `${f1}:7:l7 match`, `${f1}-8-l8`, `${f1}-9-l9`, `${f1}:10:l10 match`, `${f1}-11-l11`, '--',
    `${f2}-1-x1`, `${f2}:2:x2 match`, `${f2}-3-x3`,
  ].join('\n') + '\n', '-C1 multi-file: path-lineno-dash prefix on context, -- between files');

  r = await run(['-n', '-m1', '-C1', 'match', f1]);
  ok(r.out === '1-l1\n2:l2 match\n3-l3\n', '-m1 -C1 stops after first match + its context');

  r = await run(['-n', '-o', '-C1', 'match', f1]);
  ok(r.out.split('\n').slice(0, 3).join('\n') === '1-l1\n2:match\n3-l3', '-o with context: match lines show match text only');

  r = await run(['-n', '-i', '-C1', 'MATCH', f2]);
  ok(r.out === '1-x1\n2:x2 match\n3-x3\n', 'context combined with -i');

  r = await run(['-n', '-C0', 'match', f1]);
  ok(r.out === '2:l2 match\n7:l7 match\n10:l10 match\n', '-C0 means no context, no separators');

  const mc = W('ctx/mc.txt', 'short match\nthis is a very long context line\nend\n');
  r = await run(['-n', '--max-columns=8', '-C1', 'match', mc]);
  ok(r.out === '1:[Omitted long matching line]\n2-[Omitted long context line]\n', '--max-columns omits long lines rg-style');

  if (haveRealRg) {
    // Always pass -n: the shim (like Claude Code's invocations) defaults line
    // numbers ON, whereas real rg piped defaults them off.
    const combos = [
      ['-n', '-C2'], ['-n', '-C1'], ['-A1', '-n'], ['-B1', '-n'], ['-m1', '-C1', '-n'],
      ['-o', '-C1', '-n'], ['-n'], ['-n', '-A2', '-B1'], ['-N', '-C1'],
    ];
    let diffs = 0;
    for (const flags of combos) {
      for (const files of [[f1], [f1, f2]]) {
        const real = realRg([...flags, 'match', ...files]);
        const ours = await run([...flags, 'match', ...files]);
        if (real.out !== ours.stdout || real.code !== ours.code) {
          diffs++;
          console.log('    diff at', flags.join(' '), files.length, 'file(s)\n--- real ---\n' + real.out + '--- ours ---\n' + ours.stdout);
        }
      }
    }
    ok(diffs === 0, `output identical to real rg across ${combos.length * 2} flag/file combos`);
    const realNo = realRg(['-C1', 'zzz', f1]);
    const oursNo = await run(['-C1', 'zzz', f1]);
    ok(realNo.code === 1 && oursNo.code === 1, 'no-match exit code matches real rg');
  } else {
    console.log('  (real rg binary not runnable — skipping fidelity diffs)');
  }

  // =========================================================================
  // 3) --json event stream
  // =========================================================================
  r = await run(['--json', '-C1', 'match', f2]);
  const evs = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  ok(evs.map((e) => e.type).join(',') === 'begin,context,match,context,end,summary',
    '--json -C1 emits begin,context,match,context,end,summary');
  const mev = evs.find((e) => e.type === 'match');
  ok(mev.data.path.text === f2 && mev.data.lines.text === 'x2 match\n' && mev.data.line_number === 2
    && mev.data.absolute_offset === 3 && mev.data.submatches.length === 1
    && mev.data.submatches[0].match.text === 'match' && mev.data.submatches[0].start === 3 && mev.data.submatches[0].end === 8,
    '--json match event fields exact (offsets are byte offsets)');
  const eev = evs.find((e) => e.type === 'end');
  ok(eev.data.binary_offset === null && eev.data.stats.matched_lines === 1 && eev.data.stats.matches === 1
    && typeof eev.data.stats.bytes_searched === 'number', '--json end event carries well-formed stats');
  ok(evs[evs.length - 1].type === 'summary' && typeof evs[evs.length - 1].data.stats.searches === 'number',
    '--json summary is last and well-formed');

  r = await run(['--json', 'zzznope', f2]);
  const evs2 = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  ok(r.code === 1 && evs2.length === 1 && evs2[0].type === 'summary', '--json no-match → summary only, exit 1');

  if (haveRealRg) {
    const real = realRg(['--json', '-C1', 'match', f2]);
    const ours = await run(['--json', '-C1', 'match', f2]);
    const pick = (s) => s.trim().split('\n').map((l) => JSON.parse(l))
      .filter((e) => ['begin', 'context', 'match'].includes(e.type)).map((e) => JSON.stringify(e));
    ok(pick(real.out).join('\n') === pick(ours.stdout).join('\n'),
      '--json begin/context/match events byte-identical to real rg');
  }

  // =========================================================================
  // 4) -t / --type filters
  // =========================================================================
  const td = path.join(WS, 'types');
  for (const f of ['a.py', 'b.js', 'c.rs', 'd.md', 'x.bash', 'e.jsx', 'f.tsx', 'Cargo.lock']) W('types/' + f, 'hit\n');
  r = await run(['-t', 'py', '-l', 'hit', td]);
  ok(r.code === 0 && r.out.trim() === path.join(td, 'a.py'), '-t py matches only *.py');
  r = await run(['-t', 'rust', '-l', 'hit', td]);
  ok(r.out.trim() === path.join(td, 'c.rs'), '-t rust matches *.rs');
  r = await run(['-t', 'sh', '-l', 'hit', td]);
  ok(r.out.trim() === path.join(td, 'x.bash'), '-t sh matches *.bash');
  r = await run(['-t', 'toml', '-l', 'hit', td]);
  ok(r.out.trim() === path.join(td, 'Cargo.lock'), '-t toml matches literal Cargo.lock');
  r = await run(['-t', 'jsx', '-l', 'hit', td]);
  ok(r.out.trim() === path.join(td, 'e.jsx'), '-t jsx works');
  r = await run(['-t', 'tsx', '-l', 'hit', td]);
  ok(r.out.trim() === path.join(td, 'f.tsx'), '-t tsx works');
  r = await run(['-T', 'js', '-l', 'hit', td]);
  ok(r.code === 0 && !r.out.includes('b.js') && !r.out.includes('e.jsx') && r.out.includes('a.py'),
    '-T js excludes js-typed files (jsx is in rg js list)');
  r = await run(['-t', 'bogus', 'hit', td]);
  ok(r.code === 2 && /unrecognized file type: bogus/.test(r.stderr), 'unknown type → rg-style error, exit 2');
  r = await run(['--files', '-t', 'md', td]);
  ok(r.out.trim() === path.join(td, 'd.md'), '--files respects -t');

  // =========================================================================
  // 5) .gitignore / .ignore
  // =========================================================================
  const gi = path.join(WS, 'gi');
  W('gi/.gitignore', '# comment\n\ndist/\n*.log\n!keep.log\n/src\nbuild\ndoc/**\nq?.txt\n');
  W('gi/nested/.gitignore', '*.tmp\n');
  const giFiles = {
    'dist/a.js': false, 'deep/dist/c.js': false, 'deep/src/s.js': true, 'src/b.js': false,
    'keep.log': true, 'skip.log': false, 'sub/build/x.js': false, 'doc/x/y.txt': false,
    'q1.txt': false, 'qab.txt': true, 'nested/d.tmp': false, 'nested/d.txt': true,
  };
  for (const f of Object.keys(giFiles)) W('gi/' + f, 'hit\n');
  r = await run(['-l', 'hit', gi]);
  const found = new Set(r.out.trim().split('\n').map((f) => path.relative(gi, f)));
  let giOk = true;
  for (const [f, kept] of Object.entries(giFiles)) if (found.has(f) !== kept) { giOk = false; console.log('    gitignore mismatch:', f, 'expected kept=' + kept); }
  ok(giOk && found.size === 4, '.gitignore: dir/, *, ?, **, /anchor, ! negation, comments all honored');
  r = await run(['-u', '-l', 'hit', gi]);
  ok(r.out.trim().split('\n').length === Object.keys(giFiles).length, '-u disables ignore rules');
  r = await run(['--files', gi]);
  ok(!r.out.includes('dist/a.js') && r.out.includes('keep.log'), '--files respects .gitignore');

  const gi2 = path.join(WS, 'gi2');
  W('gi2/.ignore', 'private/\n');
  W('gi2/private/p.txt', 'hit\n');
  W('gi2/open.txt', 'hit\n');
  r = await run(['-l', 'hit', gi2]);
  ok(r.out.includes('open.txt') && !r.out.includes('private'), '.ignore file respected');
  r = await run(['-u', '-l', 'hit', gi2]);
  ok(r.out.includes('private'), '-u overrides .ignore');

  // =========================================================================
  // 6) Large files stream (readline) instead of readFileSync
  // =========================================================================
  const N = 110000;
  const arr = new Array(N);
  const pad = 'x'.repeat(56);
  for (let i = 0; i < N; i++) arr[i] = pad + i;
  arr[4999] = 'needleXYZ line 5000';   // 1-based line 5000
  arr[99999] = 'needleXYZ line 100000';
  const big = W('big.txt', arr.join('\n') + '\n');
  ok(fs.statSync(big).size > 4 * 1024 * 1024, 'fixture: big file exceeds 4MB threshold');

  let before = __stats.streamedFiles;
  const pending = rg(['-n', 'needleXYZ', big], { cwd: WS });
  ok(typeof pending.then === 'function', '>4MB search returns a Promise (streaming path engaged)');
  r = await pending;
  ok(r.code === 0 && r.stdout === '5000:needleXYZ line 5000\n100000:needleXYZ line 100000\n', 'streamed search finds correct lines/numbers');
  ok(__stats.streamedFiles === before + 1, 'streaming probe: exactly one file streamed');

  r = await run(['-n', '-C1', 'needleXYZ', big]);
  ok(r.stdout === [
    `4999-${pad}4998`, '5000:needleXYZ line 5000', `5001-${pad}5000`, '--',
    `99999-${pad}99998`, '100000:needleXYZ line 100000', `100001-${pad}100000`,
  ].join('\n') + '\n', 'context lines correct across streaming path');

  r = await run(['-c', 'needleXYZ', big]);
  ok(r.stdout === '2\n', '-c on streamed file');

  before = __stats.streamedFiles;
  const small = rg(['-n', 'needle', rx], { cwd: WS });
  ok(typeof small.then !== 'function' && __stats.streamedFiles === before, 'small file stays on sync fast path (no stream, no Promise)');

  const smallNeedle = W('sm.txt', 'needleXYZ small\n');
  r = await run(['-l', 'needleXYZ', smallNeedle, big]);
  ok(r.stdout === smallNeedle + '\n' + big + '\n', 'mixed small+big multi-file search works');

  // =========================================================================
  // 7) Previously-working behaviors stay intact
  // =========================================================================
  W('base/a.txt', 'alpha needle here\nsecond line\n');
  W('base/sub/b.js', 'const x = needleFn();\n');
  const bd = path.join(WS, 'base');
  r = await run(['--files', bd]);
  ok(r.code === 0 && r.out.includes('a.txt') && r.out.includes('b.js'), '--files enumerates');
  r = await run(['needle', bd]);
  ok(r.code === 0 && r.out.includes('a.txt:1:'), 'dir search shows file:line: prefix');
  r = await run(['-l', 'needle', bd]);
  ok(r.out.trim().split('\n').length === 2, '-l lists matching files');
  r = await run(['-c', 'needle', bd]);
  ok(/a\.txt:1/.test(r.out) && /b\.js:1/.test(r.out), '-c counts per file');
  r = await run(['-i', 'NEEDLE', bd]);
  ok(r.code === 0 && r.out.includes('needle'), '-i case-insensitive');
  r = await run(['zzznomatch', bd]);
  ok(r.code === 1 && r.out === '', 'no match → exit 1');
  r = await run(['-o', 'needle\\w*', bd]);
  ok(r.out.includes('needleFn') && !r.out.includes('const'), '-o prints only the match');
  r = await run(['-v', '-N', 'needle', path.join(bd, 'a.txt')]);
  ok(r.out === 'second line\n', '-v inverts, -N hides line numbers, no trailing phantom line');
  r = await run(['-w', 'needle', bd]);
  ok(r.out.includes('a.txt') && !r.out.includes('b.js'), '-w word boundaries (needleFn excluded)');
  r = await run(['-F', 'needleFn()', bd]);
  ok(r.code === 0 && r.out.includes('b.js'), '-F literal parens');
  r = await run(['-g', '*.js', 'needle', bd]);
  ok(r.out.includes('b.js') && !r.out.includes('a.txt'), '-g glob filter');
  r = await run(['-g', '*.{js,mjs}', 'needle', bd]);
  ok(r.out.includes('b.js'), '-g brace alternation');
  r = await run(['-m', '1', 'e', path.join(bd, 'a.txt')]);
  ok(r.out.trim().split('\n').length === 1, '-m 1 caps matches');
  r = await run(['-e', 'alpha', '-e', 'needleFn', bd]);
  ok(r.out.includes('a.txt') && r.out.includes('b.js'), 'multiple -e patterns OR together');
  W('base/.hidden.txt', 'needle hidden\n');
  r = await run(['needle', bd]);
  ok(!r.out.includes('.hidden.txt'), 'hidden files skipped by default');
  r = await run(['--hidden', 'needle', bd]);
  ok(r.out.includes('.hidden.txt'), '--hidden includes them');
  r = await run(['-q', 'needle', bd]);
  ok(r.code === 0 && r.out === '', '-q quiet exit 0, no output');
  r = await run(['--version']);
  ok(r.code === 0 && /ripgrep/.test(r.stdout), '--version');

  fs.rmSync(WS, { recursive: true, force: true });
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('UNCAUGHT:', e); process.exit(1); });
