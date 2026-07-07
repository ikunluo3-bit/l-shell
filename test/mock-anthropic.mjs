// A faithful-enough mock of the Anthropic /v1/messages streaming API, so we can
// drive Claude Code's FULL agent loop (stream → tool_use → tool execution via our
// shims → tool_result → final text) with NO real key and NO network. This validates
// the runtime deterministically: point Claude Code at it with ANTHROPIC_BASE_URL.
//
// Turn 1 (no tool_result in history): emit a Bash tool_use that writes a proof file.
// Turn 2 (tool_result present):        emit a final text confirming success.
import http from 'node:http';

const PROOF_CMD = process.env.MOCK_PROOF_CMD || 'echo agent-loop-works > proof.txt && cat proof.txt';

function sse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function streamText(res, text) {
  const msg = { id: 'msg_mock_' + Date.now(), type: 'message', role: 'assistant', model: 'mock-model',
    content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } };
  sse(res, 'message_start', { type: 'message_start', message: msg });
  sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  for (const chunk of text.match(/.{1,8}/gs) || [text]) {
    sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } });
  }
  sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } });
  sse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

function streamToolUse(res, toolName, input) {
  const msg = { id: 'msg_mock_' + Date.now(), type: 'message', role: 'assistant', model: 'mock-model',
    content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } };
  sse(res, 'message_start', { type: 'message_start', message: msg });
  sse(res, 'content_block_start', { type: 'content_block_start', index: 0,
    content_block: { type: 'tool_use', id: 'toolu_mock_1', name: toolName, input: {} } });
  const json = JSON.stringify(input);
  for (const chunk of json.match(/.{1,12}/gs) || [json]) {
    sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: chunk } });
  }
  sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } });
  sse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

function historyHasToolResult(body) {
  const msgs = body.messages || [];
  for (const m of msgs) {
    if (m.role !== 'user') continue;
    const content = Array.isArray(m.content) ? m.content : [];
    if (content.some((c) => c && c.type === 'tool_result')) return true;
  }
  return false;
}

function pickToolName(body) {
  const tools = (body.tools || []).map((t) => t.name);
  return tools.includes('Bash') ? 'Bash' : (tools[0] || 'Bash');
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let parsed = {};
    try { parsed = JSON.parse(body || '{}'); } catch {}
    const url = req.url || '';

    if (url.includes('/count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ input_tokens: 100 }));
    }
    if (!url.includes('/v1/messages')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }

    const stream = parsed.stream !== false;
    res.writeHead(200, { 'content-type': stream ? 'text/event-stream' : 'application/json', 'anthropic-version': '2023-06-01' });

    const done = historyHasToolResult(parsed);
    process.stderr.write(`[mock] /v1/messages turn=${done ? '2-final' : '1-tooluse'} tools=${(parsed.tools || []).length}\n`);
    if (done) {
      // Log what the tool actually returned, to see whether the Bash command ran.
      for (const m of parsed.messages || []) {
        const content = Array.isArray(m.content) ? m.content : [];
        for (const c of content) {
          if (c && c.type === 'tool_result') {
            const text = typeof c.content === 'string' ? c.content : JSON.stringify(c.content);
            process.stderr.write(`[mock] tool_result (is_error=${!!c.is_error}): ${String(text).slice(0, 400)}\n`);
          }
        }
      }
    }

    if (!stream) {
      // Non-streaming fallback.
      if (done) return res.end(JSON.stringify({ id: 'msg1', type: 'message', role: 'assistant', model: 'mock',
        content: [{ type: 'text', text: 'Done — proof file created.' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } }));
      return res.end(JSON.stringify({ id: 'msg1', type: 'message', role: 'assistant', model: 'mock',
        content: [{ type: 'tool_use', id: 'toolu_mock_1', name: pickToolName(parsed), input: { command: PROOF_CMD, description: 'write proof' } }],
        stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } }));
    }

    if (done) streamText(res, 'Done. I created proof.txt with the expected content — the local agent loop works end to end.');
    else streamToolUse(res, pickToolName(parsed), { command: PROOF_CMD, description: 'write a proof file' });
  });
});

const PORT = parseInt(process.env.MOCK_PORT || '0', 10);
server.listen(PORT, '127.0.0.1', () => {
  const addr = server.address();
  process.stdout.write(`MOCK_LISTENING ${addr.port}\n`);
});
