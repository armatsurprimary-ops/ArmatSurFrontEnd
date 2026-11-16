const test = require('node:test');
const assert = require('node:assert/strict');
const { app, input, tick } = require('./helpers');

const RESP = (content, extra) => Object.assign({ message: { content } }, extra || {});

test('send is blocked while a generation is in flight (button state and shortcut)', async t => {
  const { A, w } = app(t);
  A.store.get().settings.autoGmReply = false;   // isolate: no follow-up GM turn
  const id = A.store.createBranch('Alice', 'ai', '');
  A.store.get().activeBranchId = id;
  A.ui.renderAll();
  let release;
  A.api.chatFull = () => new Promise(r => { release = r; });
  const pending = A.actions.gmReply('main');
  await tick();
  assert.equal(w.document.body.classList.contains('busy'), true);
  // the button shows the spinner structure and is gated via CSS class
  const sendBtn = w.document.querySelector('.send-btn');
  assert.ok(sendBtn);
  assert.ok(sendBtn.querySelector('.send-spinner'));
  assert.equal(sendBtn.querySelector('.send-label').textContent, 'Send');
  // typing a draft and sending mid-flight is refused
  const ta = w.document.querySelector('#composer textarea');
  input(w, ta, 'Should not go through.');
  const before = A.store.allMessages().length;
  A.actions.sendComposed();
  assert.equal(A.store.allMessages().length, before);
  const toasts = [...w.document.querySelectorAll('.toast')];
  assert.ok(toasts.some(t2 => /already in flight/.test(t2.textContent)));
  release(RESP('Done.\n[[route: main]]\n[[next: pause 100]]'));
  await pending;
  assert.equal(w.document.body.classList.contains('busy'), false);
  // once idle, the same draft sends fine (count includes the stored turn + its roll)
  const after = A.store.allMessages().length;
  assert.ok(after >= 2);
  A.actions.sendComposed();
  assert.equal(A.store.allMessages().length, after + 1);
  const sent = A.store.allMessages().filter(m => m.content === 'Should not go through.');
  assert.equal(sent.length, 1);
});

test('listModels captures per-token pricing', async t => {
  const { A, w } = app(t);
  w.fetch = async url => url.includes('/models')
    ? new Response(JSON.stringify({ data: [
        { id: 'a/model', name: 'A', context_length: 1000, pricing: { prompt: '0.0000015', completion: '0.000002' } },
        { id: 'b/free', name: 'B', context_length: 2000, pricing: { prompt: '0', completion: '0' } },
        { id: 'c/none', name: 'C', context_length: 3000 }
      ] }))
    : new Response(null, { status: 204 });
  const models = await A.api.listModels('k');
  // cross-realm objects: compare field-wise
  assert.equal(models[0].pricing.prompt, 0.0000015);
  assert.equal(models[0].pricing.completion, 0.000002);
  assert.equal(models[1].pricing.prompt, 0);
  assert.equal(models[2].pricing, null);
});

test('cost comes from the API when reported, else is estimated from usage x pricing', async t => {
  const { A, w } = app(t);
  // non-stream: API-reported cost wins
  w.fetch = async url => url === '/log' ? new Response(null, { status: 204 }) :
    new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 10, completion_tokens: 5 }, cost: 0.75 }));
  let r = await A.api.chatFull({ messages: [], pricing: { prompt: 9, completion: 9 } });
  assert.equal(r.cost, 0.75);
  // non-stream: estimated when the API reports none
  w.fetch = async url => url === '/log' ? new Response(null, { status: 204 }) :
    new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  r = await A.api.chatFull({ messages: [], pricing: { prompt: 0.001, completion: 0.01 } });
  assert.ok(Math.abs(r.cost - 0.06) < 1e-9);   // 10*0.001 + 5*0.01
  r = await A.api.chatFull({ messages: [] });   // no usage/pricing -> null
  assert.equal(r.cost, null);
  // streaming: cost in the final usage chunk is used
  const frame = o => 'data: ' + JSON.stringify(o) + '\n\n';
  w.fetch = async url => url === '/log' ? new Response(null, { status: 204 }) :
    new Response(frame({ choices: [{ delta: { content: 'ok' } }] }) +
      frame({ choices: [{}], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 1.25 } }) +
      'data: [DONE]\n\n');
  r = await A.api.chatFull({ messages: [], stream: true, pricing: { prompt: 9, completion: 9 } });
  assert.equal(r.cost, 1.25);
});

test('session total accumulates across model/service changes, human input and repeated stops', async t => {
  const { A, w } = app(t);
  const s = A.store.get().settings;
  s.autoGmReply = false;
  A.api.chatFull = async () => RESP('One.\n[[route: main]]\n[[next: pause 100]]', { cost: 0.42 });
  await A.actions.gmReply('main');
  assert.equal(A.store.get().sessionSpend, 0.42);
  Object.assign(s, { model: 'second/model', apiService: 'abliteration' });
  A.api.chatFull = async opts => {
    assert.equal(opts.model, 'second/model');
    assert.equal(opts.apiService, 'abliteration');
    return RESP('Two.\n[[route: main]]\n[[next: pause 100]]', { cost: 0.08 });
  };
  await A.actions.gmReply('main');
  input(w, w.document.querySelector('#composer textarea'), 'Continue.');
  A.actions.sendComposed();
  assert.ok(A.store.allMessages().some(m => m.content === 'Continue.'));
  assert.equal(A.store.get().sessionSpend, 0.50);
  for (let i = 0; i < 2; i++) {
    let signal;
    A.api.chatFull = opts => new Promise((resolve, reject) => {
      signal = opts.signal;
      signal.addEventListener('abort', () => reject(Object.assign(new Error('Stopped'), { name: 'AbortError' })));
    });
    const stopped = A.actions.gmReply('main');
    await tick();
    A.actions.stopGeneration();
    await stopped;
    assert.equal(signal.aborted, true);
    assert.equal(A.store.get().sessionSpend, 0.5 + i * 0.125);
    A.api.chatFull = async () => RESP('Resumed.', { cost: 0.125 });
    await A.actions.gmReply('main');
  }
  assert.equal(A.store.get().sessionSpend, 0.75);
  assert.equal(w.document.querySelector('#sessionSpend').textContent, 'Total $0.75');
  assert.equal(JSON.parse(w.localStorage.getItem('armatsur-session-v1')).sessionSpend, 0.75);
});

test('session total survives reload/save/import; new and reset sessions start their own total', async t => {
  const { A, w } = app(t);
  A.api.chatFull = async () => RESP('Saved reply.', { cost: 0.625 });
  await A.actions.gmReply('main');
  const saved = A.store.serializeSession('Costed game');
  assert.equal(JSON.parse(saved).sessionSpend, 0.625);
  assert.equal(JSON.parse(saved).settings, undefined);
  assert.equal(JSON.parse(w.localStorage.getItem('armatsur-settings-v1')).sessionSpend, undefined);

  const reloaded = app(t, win => {
    win.localStorage.setItem('armatsur-session-v1', w.localStorage.getItem('armatsur-session-v1'));
    win.localStorage.setItem('armatsur-settings-v1', w.localStorage.getItem('armatsur-settings-v1'));
  });
  assert.equal(reloaded.A.store.get().sessionSpend, 0.625);
  assert.equal(reloaded.w.document.querySelector('#sessionSpend').textContent, 'Total $0.63');
  A.store.newSession();
  A.ui.renderAll();
  assert.equal(w.document.querySelector('#sessionSpend').textContent, 'Total $0.00');
  A.store.addSessionCost(0.25);
  A.store.applySession(saved);
  A.ui.renderAll();
  assert.equal(A.store.get().sessionSpend, 0.625, 'loading restores, rather than adds, the saved total');
  assert.equal(w.document.querySelector('#sessionSpend').textContent, 'Total $0.63');
  A.store.reset();
  A.ui.renderAll();
  assert.equal(w.document.querySelector('#sessionSpend').textContent, 'Total $0.00');
});

test('legacy or malformed totals default to zero; invalid costs cannot corrupt the counter', t => {
  const { A } = app(t);
  const saved = JSON.parse(A.store.serializeSession());
  delete saved.sessionSpend;
  A.store.applySession(saved);
  assert.equal(A.store.get().sessionSpend, 0);
  for (const bad of [-1, '2.5', null, NaN, Infinity, {}]) {
    A.store.applySession(Object.assign({}, saved, { sessionSpend: bad }));
    assert.equal(A.store.get().sessionSpend, 0);
  }
  A.store.addSessionCost(0.125);
  for (const bad of [-1, '2.5', null, undefined, NaN, Infinity, {}, 0]) A.store.addSessionCost(bad);
  assert.equal(A.store.get().sessionSpend, 0.125);
});

test('dropped attempts, tool continuations, characters and regenerations all contribute once', async t => {
  const { A } = app(t);
  A.store.get().settings.autoRetryDrops = 1;
  A.store.get().settings.autoGmReply = false;
  const responses = [
    RESP('Cut off', { dropped: true, cost: 0.125 }),
    { message: { tool_calls: [{ id: 'roll', type: 'function', function: {
      name: 'roll_resolver', arguments: '{"expression":"(skill)"}'
    } }] }, cost: 0.25 },
    RESP('Finished.', { cost: 0.125 })
  ];
  A.api.chatFull = async () => responses.shift();
  await A.actions.gmReply('main');
  assert.equal(responses.length, 0);
  assert.equal(A.store.get().sessionSpend, 0.5);
  const gm = A.store.lastMeaningfulMessage('main');
  A.api.chatFull = async () => RESP('Revised.', { cost: 0.125 });
  await A.actions.regenerateMessage(gm.id);
  assert.equal(A.store.get().sessionSpend, 0.625);
  A.actions.cycleSwipe(gm.id, -1);
  A.store.editMessage(gm.id, 'Edited.');
  A.store.deleteMessage(gm.id);
  assert.equal(A.store.get().sessionSpend, 0.625, 'editing history does not undo billed requests');
  const character = A.store.createBranch('Alice', 'ai', '');
  A.store.get().settings.charModel = 'character/model';
  A.api.chatFull = async opts => {
    assert.equal(opts.model, 'character/model');
    return RESP('Character reply.', { cost: 0.25 });
  };
  await A.actions.generateCharacter(character);
  assert.equal(A.store.get().sessionSpend, 0.875);
  A.api.chatFull = async () => RESP('Unknown price.', { cost: null });
  await A.actions.gmReply('main');
  assert.equal(A.store.get().sessionSpend, 0.875);
});

test('no restrictive cap: even a large cost estimate proceeds without blocking', async t => {
  const { A, w } = app(t);
  const s = A.store.get().settings;
  s.modelPricing = { prompt: 0.000003, completion: 0.000015 };   // deliberately pricey
  let called = 0;
  A.api.chatFull = async () => { called++; return RESP('Big one.\n[[route: main]]\n[[next: pause 100]]', { cost: 1.2 }); };
  await A.actions.gmReply('main');
  assert.equal(called, 1);   // the request went out; nothing was blocked
  assert.ok(A.store.allMessages().some(m => m.role === 'gm' && /Big one/.test(m.content)));
  assert.equal(A.store.get().sessionSpend, 1.2);
  const toasts = [...w.document.querySelectorAll('.toast')];
  assert.ok(!toasts.some(t2 => /cap/i.test(t2.textContent)));   // no cap warnings exist
});

test('defaults: reasoning medium and a 10k reply budget; characters capped at 2k with reasoning headroom', async t => {
  const { A } = app(t);
  const s = A.store.get().settings;
  s.autoGmReply = false; // inspect these two requests without starting a background GM turn
  assert.equal(s.reasoning, 'medium');
  assert.equal(s.maxTokens, 10000);
  assert.equal(s.settingsVer, 2);
  // GM requests use the full budget; character turns are capped (succinct by design,
  // but with enough headroom that a reasoning model cannot starve the reply)
  const sent = [];
  A.api.chatFull = async o => { sent.push(o); return RESP('ok.\n[[route: main]]\n[[next: pause 100]]'); };
  await A.actions.gmReply('main');
  assert.equal(sent[0].maxTokens, 10000);
  const id = A.store.createBranch('Alice', 'ai', '');
  await A.actions.generateCharacter(id);
  assert.equal(sent[1].maxTokens, 2000);
  assert.equal(sent[1].reasoning, { effort: 'medium' }.effort ? 'medium' : 'medium');
});

test('model capabilities are captured and pre-gate tools/reasoning without failed requests', async t => {
  const { A, w } = app(t);
  w.fetch = async url => url.includes('/models')
    ? new Response(JSON.stringify({ data: [
        { id: 'deepseek/flash', name: 'F', context_length: 1000000, supported_parameters: ['tools', 'tool_choice', 'reasoning', 'reasoning_effort', 'temperature'] },
        { id: 'cheap/mini', name: 'M', context_length: 8000, supported_parameters: ['temperature', 'max_tokens'] },
        { id: 'legacy/old', name: 'L', context_length: 4000 }
      ] }))
    : new Response(null, { status: 204 });
  const models = await A.api.listModels('k');   // sorted by id: cheap/mini, deepseek/flash, legacy/old
  assert.equal(models[1].supports.tools, true);
  assert.equal(models[1].supports.reasoning, true);
  assert.equal(models[0].supports.tools, false);
  assert.equal(models[0].supports.reasoning, false);
  assert.equal(models[2].supports, null);   // unknown — never gated

  const sent = [];
  A.api.chatFull = async o => { sent.push(o); return RESP('ok.\n[[route: main]]\n[[next: pause 100]]'); };
  const base = { model: 'm', messages: [{ role: 'system', content: 'x' }], temperature: 0.5, maxTokens: 50, audience: 'gm', originBranchId: 'main' };
  // declared no tools/reasoning -> neither sent, no failed request needed
  A.store.get().settings.reasoning = 'high';
  await A.actions._test.chatWithTools(Object.assign({}, base, { supports: { tools: false, reasoning: false } }));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].tools, undefined);
  assert.equal(sent[0].reasoning, undefined);
  // unknown capabilities -> everything sent as before
  await A.actions._test.chatWithTools(Object.assign({}, base, { supports: null }));
  assert.ok(sent[1].tools && sent[1].tools.length > 0);
  assert.equal(sent[1].reasoning, 'high');
  // declared support but provider rejects anyway -> fallback still recovers
  let n = 0;
  A.api.chatFull = async o => {
    n++;
    if (n === 1) throw new Error('OpenRouter 400: reasoning parameter not supported by this model');
    assert.equal(o.reasoning, undefined, 'retry must omit reasoning');
    assert.ok(o.tools, 'tools kept: the 400 was about reasoning only');
    return RESP('recovered.\n[[route: main]]\n[[next: pause 100]]');
  };
  const r = await A.actions._test.chatWithTools(Object.assign({}, base, { supports: { tools: true, reasoning: true } }));
  assert.ok(r.content.indexOf('recovered.') === 0);   // chatWithTools returns raw output; footers are parsed by gmReply
  assert.equal(n, 2);
});

test('top bar shows projected maxima: request, chain (1 + maxAutoTurns), and session total', t => {
  const { A, w } = app(t);
  const s = A.store.get().settings;
  s.modelPricing = { prompt: 0.000001, completion: 0.00001 };
  s.maxTokens = 2000;
  s.maxAutoTurns = 8;
  A.ui.renderAll();
  // compute the expected request maximum the same way the UI does
  const msgs = A.prompts.gmApiMessages(A.store.get(), { origin: 'main' });
  const promptTok = msgs.reduce((t2, m) => t2 + A.prompts.estTokens(m.content || ''), 0);
  const reqMax = promptTok * s.modelPricing.prompt + s.maxTokens * s.modelPricing.completion;
  assert.equal(w.document.querySelector('#reqMaxCost').textContent, 'Req $' + reqMax.toFixed(2));
  assert.equal(w.document.querySelector('#chainMaxCost').textContent, 'Chain $' + (reqMax * 9).toFixed(2));
  // session spend tracked alongside
  A.store.addSessionCost(0.42);
  A.ui.renderTopbar();
  assert.equal(w.document.querySelector('#sessionSpend').textContent, 'Total $0.42');
  // unknown pricing -> placeholders, no crash
  s.modelPricing = null;
  A.ui.renderAll();
  assert.equal(w.document.querySelector('#reqMaxCost').textContent, 'Req $?)'.replace(')', ''));
  assert.equal(w.document.querySelector('#chainMaxCost').textContent, 'Chain $?)'.replace(')', ''));
});
