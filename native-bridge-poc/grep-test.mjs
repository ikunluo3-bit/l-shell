// Flagship proof: REAL BSD grep (grep.c/util.c/file.c/queue.c, unmodified from the
// ios_system tree, built with the fastmatch optimizer off -> pure libc regcomp
// path) runs in-process through the bridge, output + exit codes matching /usr/bin/grep.
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { run } = require('./bridge.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };

const dir = mkdtempSync(join(tmpdir(), 'bridge-grep-'));
const file = join(dir, 'poem.txt');
writeFileSync(file,
  'the quick brown fox\n' +
  'jumps over the lazy dog\n' +
  'THE FOX runs\n' +
  'no animals here\n' +
  'fox fox fox\n' +
  'the end\n');

function bridgeGrep(args) {
  return new Promise((resolve) => {
    const chunks = [];
    run('grep', args, { onData: (b) => chunks.push(b), onExit: (code) => resolve({ code, out: Buffer.concat(chunks).toString() }) });
  });
}
const sysGrep = (args) => { const r = spawnSync('/usr/bin/grep', args); return { code: r.status, out: r.stdout.toString() }; };

// Compare bridge grep vs system grep for the same args (args reference the same file path).
async function cmp(desc, args) {
  const b = await bridgeGrep(args);
  const s = sysGrep(args);
  ok(b.out === s.out && b.code === s.code,
     desc + '  (exit ' + b.code + ', ' + b.out.split('\n').filter(Boolean).length + ' lines) matches /usr/bin/grep');
  if (b.out !== s.out) { console.log('     bridge: ' + JSON.stringify(b.out)); console.log('     system: ' + JSON.stringify(s.out)); }
}

async function main() {
  console.log('=== REAL BSD grep through the bridge (Node ' + process.version + ') ===');
  console.log('    (grep.c/util.c/file.c/queue.c unmodified; fastmatch off -> libc regex)\n');
  await cmp("grep 'fox'",         ['fox', file]);
  await cmp("grep -n 'the'",      ['-n', 'the', file]);
  await cmp("grep -i 'FOX'",      ['-i', 'FOX', file]);
  await cmp("grep -c 'fox'",      ['-c', 'fox', file]);
  await cmp("grep -v 'the'",      ['-v', 'the', file]);
  await cmp("grep -w 'the'",      ['-w', 'the', file]);
  await cmp("grep -o 'fox'",      ['-o', 'fox', file]);
  await cmp("grep -E 'fox|dog'",  ['-E', 'fox|dog', file]);
  await cmp("grep '^the' (anchor)", ['^the', file]);
  await cmp("grep 'zzz' (no match → exit 1)", ['zzz', file]);
  await cmp("grep -in 'the'",     ['-in', 'the', file]);

  console.log('\n' + (fail === 0
    ? '✅ REAL GREP PROVEN: unmodified BSD grep runs in-process through child_process.spawn — regex, flags (-n/-i/-c/-v/-w/-o/-E), anchors, and exit codes all match /usr/bin/grep.'
    : '❌ ' + fail + ' failures'));
  process.exit(fail ? 1 : 0);
}
main();
