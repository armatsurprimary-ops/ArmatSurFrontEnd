const test = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('./helpers');

const frame = delta => 'data: ' + JSON.stringify({ choices: [{ delta }] }) + '\r\n\r\n';
function mockStream(w, text, chunkSize = 3, close = true) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  let cancelled = false;
  w.fetch = async url => {
    if (url === '/log') return new Response(null, { status: 204 });
    return new Response(new ReadableStream({
      pull(c) {
        if (offset < bytes.length) {
          c.enqueue(bytes.slice(offset, offset + chunkSize)); offset += chunkSize;
        } else if (close) c.close();
      },
      cancel() { cancelled = true; }
    }), { headers: { 'Content-Type': 'text/event-stream' } });
  };
  return () => cancelled;
}

test('split UTF-8 chunks and a final DONE without a newline are handled', async t => {
  const { A, w } = app(t);
  mockStream(w, ': keepalive\r\n\r\n' + frame({ reasoning: '考え' }) +
    frame({ content: 'Café — done.' }) + 'data: [DONE]');
  const updates = [];
  const result = await A.api.chatFull({ stream: true, messages: [], onChunk: x => updates.push(x) });
  assert.equal(result.dropped, false);
  assert.equal(result.message.content, 'Café — done.');
  assert.equal(result.message.reasoning, '考え');
  assert.ok(updates.some(x => x.content === 'Café — done.'));
});

test('DONE terminates a stream even if the server keeps the socket open', { timeout: 3000 }, async t => {
  const { A, w } = app(t);
  const cancelled = mockStream(w, frame({ content: 'Complete' }) + 'data: [DONE]\n\n', 8, false);
  const result = await A.api.chatFull({ stream: true, messages: [] });
  assert.equal(result.dropped, false);
  assert.equal(cancelled(), true);
});

test('multiline SSE data and fragmented tool arguments are assembled', async t => {
  const { A, w } = app(t);
  mockStream(w, 'data: {"choices":\n' +
    'data: [{"delta":{"content":"Ready"}}]}\n\n' +
    frame({ tool_calls: [{ index: 0, id: 'call-1', function: { name: 'roll_resolver', arguments: '{"expression":' } }] }) +
    frame({ tool_calls: [{ index: 0, function: { arguments: '"(skill+)"}' } }] }) +
    'data: [DONE]\n\n');
  const result = await A.api.chatFull({ stream: true, messages: [] });
  assert.equal(result.message.content, 'Ready');
  assert.equal(result.message.tool_calls[0].function.arguments, '{"expression":"(skill+)"}');
});

test('provider errors inside HTTP-200 streams surface their actual message', async t => {
  const { A, w } = app(t);
  mockStream(w, 'data: {"error":{"code":429,"message":"Rate limit reached"}}\n\n');
  await assert.rejects(A.api.chatFull({ stream: true, messages: [] }), /429: Rate limit reached/);
});

test('plain-text HTTP errors are not lost trying to read the body twice', async t => {
  const { A, w } = app(t);
  w.fetch = async url => url === '/log' ? new Response(null, { status: 204 }) :
    new Response('Provider maintenance', { status: 503 });
  await assert.rejects(A.api.chatFull({ messages: [] }), /503: Provider maintenance/);
});

test('JSON responses are supported when a provider ignores streaming', async t => {
  const { A, w } = app(t);
  w.fetch = async url => url === '/log' ? new Response(null, { status: 204 }) :
    new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'JSON reply' } }] }),
      { headers: { 'content-type': 'application/json' } });
  const result = await A.api.chatFull({ stream: true, messages: [] });
  assert.equal(result.message.content, 'JSON reply');
});

test('a genuine cut stream still returns a flagged partial', async t => {
  const { A, w } = app(t);
  mockStream(w, frame({ content: 'Unfinished' }));
  const result = await A.api.chatFull({ stream: true, messages: [] });
  assert.equal(result.dropped, true);
  assert.equal(result.message.content, 'Unfinished');
});
