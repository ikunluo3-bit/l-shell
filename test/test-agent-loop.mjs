// End-to-end agent-loop test with a mock Anthropic backend. Proves that in the
// jitless embedded-Node environment, Claude Code can: stream a response, receive a
// tool_use, EXECUTE the tool through our child_process/just-bash shims against the
// real filesystem, return the tool_result, and finish the turn — all with no key.
//
// Usage: NODE=<node18> node test/test-agent-loop.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const NODE = path.isAbsolute(process.env.NODE || '') ? process.env.NODE : process.execPath;

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agentloop-'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthome-'));
fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
const proofPath = path.join(workspace, 'proof.txt');

function startMock() {
  return new Promise((resolve) => {
    const mock = spawn(NODE, [path.join(HERE, 'mock-anthropic.mjs')], {
      env: { ...process.env, MOCK_PORT: '0', MOCK_PROOF_CMD: `echo agent-loop-works > ${proofPath} && cat ${proofPath}` },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    mock.stdout.on('data', (d) => {
      const m = /MOCK_LISTENING (\d+)/.exec(d.toString());
      if (m) resolve({ mock, port: parseInt(m[1], 10) });
    });
  });
}

function runClaude(port) {
  return new Promise((resolve) => {
    const args = [
      '--jitless',
      '--require', path.join(HERE, 'ios-env-only.js'),
      path.join(ROOT, 'node-runtime', 'bootstrap.js'),
      '-p', 'Create a proof file to show tools work.',
      '--dangerously-skip-permissions',
      '--output-format', 'text',
    ];
    const env = {
      ...process.env,
      HOME: home,
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      ANTHROPIC_API_KEY: 'mock-key',
      ANTHROPIC_MODEL: 'mock-model',
      API_TIMEOUT_MS: '20000',
      DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      USE_BUILTIN_RIPGREP: '0',
      PATH: '',
    };
    const cp = spawn(NODE, args, { cwd: workspace, env });
    let out = '', err = '';
    cp.stdout.on('data', (d) => (out += d));
    cp.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => { cp.kill('SIGKILL'); resolve({ out, err, timedOut: true }); }, 45000);
    cp.on('close', (code) => { clearTimeout(timer); resolve({ out, err, code }); });
  });
}

(async () => {
  const { mock, port } = await startMock();
  console.log('mock backend on 127.0.0.1:' + port);
  const { out, err, code, timedOut } = await runClaude(port);
  mock.kill('SIGKILL');

  console.log('\n--- Claude Code output ---');
  console.log(out.trim() || '(empty)');
  const relevantErr = err.split('\n').filter((l) => l && !/^Warning: disabling/.test(l)).join('\n');
  if (relevantErr) console.log('--- stderr ---\n' + relevantErr.slice(0, 800));

  const proofExists = fs.existsSync(proofPath);
  const proofContent = proofExists ? fs.readFileSync(proofPath, 'utf8').trim() : '';
  console.log('\n--- verification ---');
  console.log('exit code           :', timedOut ? 'TIMEOUT' : code);
  console.log('proof.txt created   :', proofExists);
  console.log('proof.txt content   :', JSON.stringify(proofContent));
  const toolRan = proofExists && proofContent.includes('agent-loop-works');
  const finished = /proof|works|done|created/i.test(out);
  console.log('\nAGENT LOOP:', (toolRan && finished) ? 'PASS — streamed, executed a real tool via shims, finished'
    : toolRan ? 'PARTIAL — tool executed but final text unclear'
    : 'FAIL — tool did not execute');

  try { fs.rmSync(workspace, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); } catch {}
  process.exit(toolRan ? 0 : 1);
})();
