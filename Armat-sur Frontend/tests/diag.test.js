const test = require('node:test');
const assert = require('node:assert/strict');
const { app, button, tick } = require('./helpers');

const RESP = (content, extra) => Object.assign({ message: { content } }, extra || {});
const TOOLS_MSG = (calls, id) => ({ message: { tool_calls: calls.map((c, i) => ({
  id: id === undefined ? 'call-' + i : id, type: 'function', function: c
})) } });

test('diag records entries, caps, persists, and clears', t => {
  const { A, w } = app(t);
  A.diag.log('info', 'hello', { a: 1 });
  A.diag.log('error', 'bad thing');
  const stored = JSON.parse(w.localStorage.getItem('armatsur-diag-v1'));
  assert.equal(stored.length, 2);
  assert.equal(stored[1].kind, 'error');
  assert.ok(A.diag.list()[0].t);
  // oversized data is truncated, never throws
  A.diag.log('info', 'big', new Array(500).join('x'));
  assert.ok(A.diag.exportText().indexOf('hello') >= 0);
  A.diag.clear();
  assert.equal(A.diag.list().length, 0);
  assert.equal(JSON.parse(w.localStorage.getItem('armatsur-diag-v1')).length, 0);
});

test('page errors and unhandled rejections land in the log', t => {
  const { A, w } = app(t);
  let ev;
  try { ev = new w.ErrorEvent('error', { message: 'boom', error: new Error('boom') }); }
  catch (e) { ev = new w.Event('error'); ev.message = 'boom'; }
  w.dispatchEvent(ev);
  const ev2 = new w.Event('unhandledrejection');
  ev2.reason = new Error('async boom');
  w.dispatchEvent(ev2);
  const kinds = A.diag.list().map(e => e.kind);
  assert.ok(kinds.includes('crash'));
  assert.ok(A.diag.list().some(e => /boom|async boom/.test(e.detail)));
  assert.ok(A.diag.list().filter(e => e.kind === 'crash').length >= 2);
});

test('tool_calls without ids get synthetic ids matched by the tool result message', async t => {
  const { A } = app(t);
  const sent = [];
  let n = 0;
  A.api.chatFull = async o => {
    n++;
    sent.push(o);
    if (n === 1) return TOOLS_MSG([{ name: 'roll_resolver', arguments: JSON.stringify({ expression: '(x)' }) }], '');
    return RESP('Roll done.\n[[route: main]]\n[[next: pause 100]]');
  };
  const r = await A.actions._test.chatWithTools({ model: 'm', messages: [{ role: 'system', content: 'x' }], temperature: 0.5, maxTokens: 50, audience: 'gm', originBranchId: 'main' });
  assert.ok(r.content.indexOf('Roll done.') === 0);
  // continuation request: assistant tool_calls have ids; tool message references the same id
  const cont = sent[1].messages;
  const asst = cont.find(m => m.tool_calls && m.tool_calls.length);
  const toolMsg = cont.find(m => m.role === 'tool');
  assert.ok(asst.tool_calls[0].id.length > 0);
  assert.equal(toolMsg.tool_call_id, asst.tool_calls[0].id);
  assert.match(toolMsg.content, /^d6\n[1-6]\n[1-6]$/);
  // the synthesis was noted in diagnostics
  assert.ok(A.diag.list().some(e => /synthesized/.test(e.detail)));
  // the roll itself was executed and recorded (tool worked despite missing id)
  const logged = A.store.allMessages().find(m => m.name === 'Tool: roll_resolver');
  assert.ok(logged.content.includes('(x)'));
  assert.ok(logged.content.endsWith(toolMsg.content));
});

test('tool_calls with pre-parsed argument objects are coerced to strings', async t => {
  const { A } = app(t);
  const sent = [];
  let n = 0;
  A.api.chatFull = async o => {
    n++;
    sent.push(o);
    if (n === 1) return TOOLS_MSG([{ name: 'roll_resolver', arguments: { expression: '(x)' } }]);
    return RESP('Done.\n[[route: main]]\n[[next: pause 100]]');
  };
  await A.actions._test.chatWithTools({ model: 'm', messages: [{ role: 'system', content: 'x' }], temperature: 0.5, maxTokens: 50, audience: 'gm', originBranchId: 'main' });
  const asst = sent[1].messages.find(m => m.tool_calls && m.tool_calls.length);
  assert.equal(typeof asst.tool_calls[0].function.arguments, 'string');
  assert.equal(JSON.parse(asst.tool_calls[0].function.arguments).expression, '(x)');
});

test('failed generations are diagnosed: retries, api errors, and caller failures', async t => {
  const { A } = app(t);
  // network-ish failure: retry path records stack + context (harness defaults to 0 retries)
  A.store.get().settings.autoRetryDrops = 1;
  A.api.chatFull = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(A.actions._test.chatWithTools({ model: 'm', messages: [{ role: 'system', content: 'x' }], temperature: 0.5, maxTokens: 50, audience: 'gm', originBranchId: 'main' }), /Failed to fetch/);
  assert.ok(A.diag.list().some(e => e.kind === 'retry' && /network or internal/.test(e.detail) && e.data.stack));
  // API error surfaces through gmReply and is recorded with its origin
  A.api.chatFull = async () => { throw new Error('OpenRouter 500: provider meltdown'); };
  await A.actions.gmReply('main');
  assert.ok(A.diag.list().some(e => e.kind === 'error' && /OpenRouter 500/.test(e.detail)));
  assert.ok(A.diag.list().some(e => /gmReply failed/.test(e.detail)));
  // a tool that errors is recorded too
  let k = 0;
  A.api.chatFull = async () => (++k === 1)
    ? TOOLS_MSG([{ name: 'whisper', arguments: JSON.stringify({ character: 'nobody', text: 'x' }) }])
    : RESP('ok.\n[[route: main]]\n[[next: pause 100]]');
  await A.actions.gmReply('main');
  assert.ok(A.diag.list().some(e => /tool "whisper" returned an error/.test(e.detail)));
});

test('Settings exposes the diagnostics log viewer', t => {
  const { A, w } = app(t);
  A.diag.log('error', 'recorded failure for the viewer');
  A.ui.openSettingsModal();
  const diagBtn = [...w.document.querySelectorAll('button')].find(b => /^Diagnostics log/.test(b.textContent));
  assert.ok(diagBtn, 'settings must show the diagnostics button');
  diagBtn.click();
  const body = w.document.querySelector('.modal .mono-preview');
  assert.ok(body.textContent.indexOf('recorded failure for the viewer') >= 0);
  assert.ok([...w.document.querySelectorAll('.modal-actions button')].some(b => b.textContent === 'Download'));
});
