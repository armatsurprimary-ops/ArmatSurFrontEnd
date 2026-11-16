const test = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('./helpers');

for (const format of ['section', 'legacy']) {
  test('unresolved ' + format + ' routes never redirect secrets or advance the chain', async t => {
    const { A } = app(t);
    const alice = A.store.createBranch('Alice', 'ai', '');
    A.store.createBranch('Alice Two', 'ai', '');
    A.store.get().settings.autoTurns = true;
    A.actions.generateCharacter = () => assert.fail('must pause on routing failure');
    for (const origin of ['main', alice]) {
      for (const route of ['Ghost', 'Ali', 'Alice and Alice Two']) {
        const content = (format === 'section' ? '[[route: ' + route + ']]\nSECRET' : 'SECRET\n[[route: ' + route + ']]') + '\n[[next: Alice 100]]';
        A.api.chatFull = async () => ({ message: { content } });
        await A.actions.gmReply(origin);
        assert.equal(A.store.allMessages().length, 0);
      }
    }
  });
}

test('regeneration retains only sections for the original channel', async t => {
  const { A } = app(t);
  const alice = A.store.createBranch('Alice', 'ai', '');
  for (const origin of ['main', alice]) {
    const m = A.store.addMessage({ role: 'gm', origin, content: 'Original' });
    A.api.chatFull = async () => ({ message: { content: 'PUBLIC\n[[route: Alice]]\nPRIVATE\n[[route: Ghost]]\nSECRET\n[[next: user 100]]' } });
    await A.actions.regenerateMessage(m.id);
    assert.equal(m.content, origin === 'main' ? 'PUBLIC' : 'PRIVATE');
    A.api.chatFull = async () => ({ message: { content: 'SECRET\n[[route: Ghost]]' } });
    await A.actions.regenerateMessage(m.id);
    assert.equal(m.swipes.length, 2);
  }
  assert.equal(A.store.allMessages().length, 2);
});

test('interrupted GM regeneration never publishes a partial private section', async t => {
  const { A } = app(t);
  const m = A.store.addMessage({ role: 'gm', origin: 'main', content: 'Original' });
  A.api.chatFull = async () => ({ dropped: true, message: { content: 'Secret without its routing footer yet' } });
  await A.actions.regenerateMessage(m.id);
  assert.equal(m.content, 'Original');
  assert.equal(m.swipes, undefined);
});

test('regeneration neither offers nor executes tools and preserves original state', async t => {
  const { A } = app(t);
  const alice = A.store.createBranch('Alice', 'ai', 'Name: Alice\nTemporary Tags: healthy');
  const m = A.store.addMessage({ role: 'gm', origin: 'main', content: 'Original' });
  const calls = [
    ['bookkeep', { character: 'Alice', add_tags: ['wounded'] }],
    ['character_creator', { name: 'Unwanted NPC' }],
    ['whisper', { character: 'Alice', text: 'Unwanted whisper' }],
    ['roll_resolver', { expression: '(New roll)' }]
  ];
  let n = 0;
  A.api.chatFull = async opts => {
    assert.equal(opts.tools, undefined);
    assert.ok(opts.messages.some(x => /TEXT-ONLY REGENERATION/.test(x.content || '')));
    return ++n === 1 ? { message: { tool_calls: calls.map(([name,args],i) => ({ id:'c'+i, function:{name,arguments:JSON.stringify(args)} })) } } : {message:{content:'Reworded'}};
  };
  await A.actions.regenerateMessage(m.id);
  assert.equal(m.content, 'Reworded');
  assert.equal(A.store.allMessages().length, 1);
  assert.equal(A.store.get().branchOrder.length, 3);
  assert.equal(A.store.get().branches[alice].card, 'Name: Alice\nTemporary Tags: healthy');
});

for (const change of ['newSession', 'applySession', 'reset']) {
  test(change + ' aborts requests and rejects late tool responses', async t => {
    const { A } = app(t);
    A.store.addSessionCost(0.25);
    let complete, signal;
    A.api.chatFull = opts => { signal = opts.signal; return new Promise(r => { complete = r; }); };
    const pending = A.actions.gmReply('main');
    // Reference storage is asynchronous; wait until the request has started
    // before testing cancellation of an in-flight transport.
    await new Promise(resolve => setImmediate(resolve));
    if (change === 'applySession') A.store.applySession(A.store.serializeSession());
    else A.store[change]();
    const replacementMessages = JSON.stringify(A.store.get().messages);
    const replacementSpend = change === 'applySession' ? 0.25 : 0;
    assert.equal(signal.aborted, true);
    complete({cost: 9, message:{tool_calls:[{id:'late',function:{name:'character_creator',arguments:'{"name":"Old NPC"}'}}]}});
    await pending;
    assert.equal(JSON.stringify(A.store.get().messages), replacementMessages);
    assert.equal(A.store.get().branchOrder.length, 2);
    assert.equal(A.store.get().sessionSpend, replacementSpend);
  });
}

test('local save and logging requests include the same-origin request header', async t => {
  const { A, w } = app(t);
  const seen = [];
  w.fetch = async (url, opts) => {
    seen.push({url, opts});
    if (url === '/log') return new Response(null, {status:204});
    return new Response(JSON.stringify(url.startsWith('/save') ? {saved:'test'} : {choices:[{message:{content:'Done'}}]}), {headers:{'content-type':'application/json'}});
  };
  await A.api.sessions.save('test', A.store.serializeSession());
  await A.api.chatFull({messages:[]});
  const local = seen.filter(x => x.url.startsWith('/'));
  assert.ok(local.length >= 3);
  local.forEach(x => assert.equal(x.opts.headers['X-ArmatSur-Request'], '1'));
});
