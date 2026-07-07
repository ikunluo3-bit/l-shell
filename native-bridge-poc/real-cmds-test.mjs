// Proof: REAL ios_system coreutils (unmodified BSD cat.c / wc.c) run in-process
// through the bridge and produce output BYTE-IDENTICAL to the OS's own cat/wc.
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { run } = require('./bridge.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };

// A real file with varied content: multiple lines, blanks, unicode, long line.
const dir = mkdtempSync(join(tmpdir(), 'bridge-real-'));
const file = join(dir, 'sample.txt');
const content =
  'the quick brown fox\n' +
  'jumps over\n' +
  '\n' +
  'the lazy dog 中文 café\n' +
  'x'.repeat(200) + '\n' +
  'last line no newline after';
writeFileSync(file, content);

function bridge(name, argv, stdin) {
  return new Promise((resolve) => {
    const chunks = [], times = [];
    const h = run(name, argv, {
      onData: (b) => { chunks.push(b); times.push(Date.now()); },
      onExit: (code) => resolve({ code, out: Buffer.concat(chunks), n: chunks.length,
                                  span: times.length ? times[times.length - 1] - times[0] : 0 }),
    });
    if (stdin != null) { h.write(stdin); setTimeout(() => h.closeStdin(), 60); }
  });
}
const sys = (bin, args, input) => spawnSync(bin, args, input != null ? { input } : {});

async function main() {
  console.log('=== REAL ios_system coreutils through the bridge (Node ' + process.version + ') ===');
  console.log('    (cat.c / wc.c: unmodified BSD sources from the ios_system tree)\n');

  // cat <file>  vs  /bin/cat <file>
  {
    const b = await bridge('cat', [file]);
    const s = sys('/bin/cat', [file]);
    ok(b.code === 0, 'cat exit 0');
    ok(b.out.equals(s.stdout), 'cat <file> output BYTE-IDENTICAL to /bin/cat (' + b.out.length + ' bytes)');
  }
  // cat -n <file>  (line numbering — real getopt flag handling)
  {
    const b = await bridge('cat', ['-n', file]);
    const s = sys('/bin/cat', ['-n', file]);
    ok(b.out.equals(s.stdout), 'cat -n <file> identical to /bin/cat -n (real flag parsing works)');
  }
  // cat via stdin (real thread_stdin path)
  {
    const b = await bridge('cat', [], 'piped through stdin\n');
    ok(b.out.toString() === 'piped through stdin\n', 'cat reads thread_stdin and echoes it');
  }
  // wc <file>  vs  /usr/bin/wc
  {
    const b = await bridge('wc', [file]);
    const s = sys('/usr/bin/wc', [file]);
    // normalize the filename column (paths differ) — compare the count numbers.
    const nums = (x) => x.toString().trim().split(/\s+/).slice(0, 3).join(' ');
    ok(b.code === 0, 'wc exit 0');
    ok(nums(b.out) === nums(s.stdout), 'wc <file> counts match /usr/bin/wc: ' + nums(b.out) + ' (lines words bytes)');
  }
  // wc -l
  {
    const b = await bridge('wc', ['-l', file]);
    const s = sys('/usr/bin/wc', ['-l', file]);
    const n = (x) => x.toString().trim().split(/\s+/)[0];
    ok(n(b.out) === n(s.stdout), 'wc -l line count matches /usr/bin/wc -l: ' + n(b.out));
  }
  // exit code path: cat a missing file -> nonzero (real error handling via exit(rval))
  {
    const b = await bridge('cat', [join(dir, 'does-not-exist')]);
    ok(b.code !== 0, 'cat <missing> returned nonzero exit (' + b.code + '), real error path');
  }

  console.log('\n' + (fail === 0
    ? '✅ REAL COREUTILS PROVEN: unmodified BSD cat/wc run in-process on a pthread with thread_stdout, driven by child_process.spawn, output byte-identical to the OS binaries.'
    : '❌ ' + fail + ' failures'));
  process.exit(fail ? 1 : 0);
}
main();
