// Outer runner: launches the inner test under the TARGET runtime (Node 18.20.4
// --jitless) and captures its real fd 1 (stdout) and fd 2 (stderr) SEPARATELY.
// This is the only way to prove fd isolation: native command output that used
// thread_stdout must NOT appear on fd 1; the demoleak printf MUST appear on fd 1.
import { spawn } from 'node:child_process';

const NODE18 = process.env.NODE18 || process.env.NODE || 'node';
const inner = new URL('./test-bridge.mjs', import.meta.url).pathname;

const child = spawn(NODE18, ['--jitless', inner], { stdio: ['ignore', 'pipe', 'pipe'] });
let out = '', err = '';
child.stdout.on('data', (c) => { out += c; });
child.stderr.on('data', (c) => { err += c; });

child.on('close', (code) => {
  // Relay the inner functional results (they were written to stderr).
  process.stdout.write(err);

  console.log('\n=== fd-isolation checks (on the child real fd 1) ===');
  let isoPass = 0, isoFail = 0;
  const iok = (c, m) => { if (c) { isoPass++; console.log('  ✓ ' + m); } else { isoFail++; console.log('  ✗ ' + m); } };

  iok(out.includes('LEAKED-TO-REAL-FD1'),
      'demoleak (un-ported printf) DID reach real fd 1 — proves why porting is required');
  iok(!out.includes('tick '),
      'democount output did NOT leak to real fd 1 (thread_stdout stayed isolated from libuv)');
  iok(!out.includes('spin '),
      'demospin output did NOT leak to real fd 1');
  iok(!out.includes('echo:'),
      'democat output did NOT leak to real fd 1');
  // real fd 1 should contain ONLY the single intentional leak line
  const fd1lines = out.split('\n').filter((l) => l.trim());
  iok(fd1lines.length === 1 && fd1lines[0] === 'LEAKED-TO-REAL-FD1',
      'real fd 1 carried exactly one line — the intentional leak, nothing else');

  const innerOk = code === 0;
  console.log('\n=== VERDICT ===');
  console.log('inner functional test: ' + (innerOk ? 'PASS' : 'FAIL (exit ' + code + ')'));
  console.log('fd-isolation test: ' + (isoFail === 0 ? 'PASS' : 'FAIL') + ' (' + isoPass + ' checks)');
  const allOk = innerOk && isoFail === 0;
  console.log(allOk
    ? '\n✅ BRIDGE PROVEN: Node child_process → in-process native command works — streaming, stdin, exit codes, cooperative interrupt, concurrency, and fd-isolation from libuv.'
    : '\n❌ bridge PoC has failures — see above.');
  process.exit(allOk ? 0 : 1);
});
