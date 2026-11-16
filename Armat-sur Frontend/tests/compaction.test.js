const test = require('node:test');
const assert = require('node:assert/strict');
const { app, button, tick } = require('./helpers');

function history(A, count = 24) {
  return Array.from({ length: count }, (_, i) => A.store.addMessage({
    role: i % 3 === 0 ? 'tool' : 'gm', name: i % 3 === 0 ? 'Tool: roll_resolver' : 'GM',
    origin: 'main', content: 'Public entry ' + i + '. ' + 'The caravan waits near the gate while Mara negotiates the toll. '.repeat(12)
  }));
}
function reply(opts, cost = 0.03) {
  return { message: { content: JSON.stringify(JSON.parse(opts.messages[1].content).map(m => ({
    id: m.id, summary: 'Mara negotiates the caravan toll at the gate.'
  }))) }, cost };
}
function compactLocally(A) {
  const plan = A.compaction.plan();
  const data = A.compaction.parseReply(reply({ messages: A.compaction.requestMessages(plan.pending) }).message.content, plan.pending);
  return A.compaction.apply(A.store.get(), data);
}

test('only public Main older than the last ten is compacted; transcript, private notes and origins survive', async t => {
  const { A, w } = app(t);
  const st = A.store.get();
  const secret = A.store.addMessage({ role: 'gm', origin: 'b_user', content: 'PRIVATE SECRET '.repeat(30) });
  const note = A.store.addMessage({ role: 'note', origin: 'main', content: 'OPERATOR PLAN '.repeat(30) });
  const messages = history(A);
  st.branches.main.messageIds.unshift(secret.id); // legacy mirroring must not leak
  st.rulebook = 'RULEBOOK ONLY';
  const before = messages.map(m => m.content);
  const calls = [];
  A.attachments.message = async () => { throw Error('Compaction must not load image pixels'); };
  A.api.chatFull = async opts => { calls.push(opts); return reply(opts); };
  await A.actions.compactContext();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].stream, false);
  assert.equal(calls[0].tools, undefined);
  assert.equal(calls[0].reasoning, undefined);
  const sent = JSON.stringify(calls[0].messages);
  assert.ok(!sent.includes('PRIVATE SECRET') && !sent.includes('OPERATOR PLAN') && !sent.includes('RULEBOOK ONLY'));
  assert.equal(JSON.parse(calls[0].messages[1].content).length, 14);
  assert.equal(A.compaction.plan().active, 14);
  assert.deepEqual(messages.map(m => m.content), before);
  messages.slice(-10).forEach(m => assert.equal(m.contextSummary, undefined));
  assert.equal(note.contextSummary, undefined);
  assert.equal(secret.contextSummary, undefined);
  assert.equal(st.sessionSpend, 0.03);
  assert.equal(A.store.allMessages().length, 26);
  const gm = A.prompts.gmApiMessages(st, {}).map(m => m.content).join('\n');
  const character = A.prompts.characterApiMessages(st, 'b_user').map(m => m.content).join('\n');
  assert.ok(gm.includes('[Summary of earlier message]'));
  assert.ok(character.includes('[Summary of earlier message]'));
  assert.ok(gm.includes('OPERATOR PLAN') && !character.includes('OPERATOR PLAN'));
  assert.ok(gm.includes(before[23]) && !gm.includes(before[0]));
  assert.ok(w.document.querySelector('#contextUsageLabel').textContent.includes('tokens'));
  assert.ok(!w.document.body.classList.contains('busy'));
});

test('summaries survive save/import and restore original context without undoing costs or replies', t => {
  const { A } = app(t);
  const messages = history(A, 12);
  compactLocally(A);
  A.store.addSessionCost(1.25);
  const json = A.store.serializeSession();
  assert.ok(!json.includes('test-only'));
  A.store.applySession(json);
  assert.equal(A.compaction.plan().active, 2);
  assert.ok(A.prompts.gmApiMessages(A.store.get(), {}).some(m => m.content.includes('[Summary of earlier message]')));
  A.actions.restoreContext();
  assert.equal(A.compaction.plan().active, 0);
  assert.equal(A.store.get().sessionSpend, 1.25);
  assert.equal(A.store.allMessages().length, 12);
  assert.ok(A.prompts.gmApiMessages(A.store.get(), {}).some(m => m.content.includes(messages[0].content)));
  A.store.newSession();
  assert.equal(A.compaction.plan().stored, 0);
});

test('edits, regenerations, swipes and mismatched imported source invalidate summaries', t => {
  const { A } = app(t);
  const messages = history(A, 15);
  compactLocally(A);
  A.store.editMessage(messages[0].id, 'Edited public information.');
  A.store.addSwipe(messages[1].id, 'Replacement version.', null);
  A.store.addSwipe(messages[2].id, messages[2].content + ' A new detail.', null);
  compactLocally(A);
  A.store.setMessageSwipe(messages[2].id, 0);
  [0, 1, 2].forEach(i => assert.equal(messages[i].contextSummary, undefined));
  messages[3].content += ' External edit from an imported session.';
  assert.equal(A.compaction.contextReader()(messages[3]), messages[3].content);
  assert.equal(A.compaction.plan().active, 1);
});

test('deleting newer messages protects the newest ten again; historical cutoffs still exclude future entries', t => {
  const { A } = app(t);
  const messages = history(A, 12);
  compactLocally(A);
  A.store.deleteMessage(messages[11].id);
  A.store.deleteMessage(messages[10].id);
  assert.equal(A.compaction.plan().active, 0);
  assert.equal(A.compaction.contextReader()(messages[0]), messages[0].content);
  const sent = A.prompts.gmApiMessages(A.store.get(), { beforeTs: messages[4].ts }).map(m => m.content).join('\n');
  assert.ok(sent.includes(messages[3].content));
  assert.ok(!sent.includes(messages[4].content));
});

test('repeat compaction skips existing summaries and uses originals for newly eligible messages', async t => {
  const { A } = app(t);
  const messages = history(A, 12);
  compactLocally(A);
  let calls = 0;
  A.api.chatFull = async opts => {
    calls++;
    const inputs = JSON.parse(opts.messages[1].content);
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].text, messages[2].content);
    return reply(opts);
  };
  await A.actions.compactContext();
  assert.equal(calls, 0);
  history(A, 1);
  await A.actions.compactContext();
  assert.equal(calls, 1);
  assert.equal(A.compaction.plan().active, 3);
});

test('brief entries stay verbatim and a longer model summary never inflates context', t => {
  const { A } = app(t);
  const short = A.store.addMessage({ role: 'tool', origin: 'main', content: 'd10 + d6: 9 + 3 = 12' });
  const messages = history(A, 11);
  A.store.editMessage(messages[0].id, 'A'.repeat(180));
  const plan = A.compaction.plan();
  assert.equal(plan.brief, 1);
  const data = A.compaction.parseReply(JSON.stringify([{ id: messages[0].id, summary: 'B'.repeat(200) }]), plan.pending);
  assert.equal(A.compaction.apply(A.store.get(), data), 0);
  assert.equal(short.contextSummary, undefined);
});

test('malformed or incomplete later batch is atomic; billed responses still accumulate', async t => {
  const { A } = app(t);
  history(A, 43);
  let calls = 0;
  A.api.chatFull = async opts => ++calls === 1 ? reply(opts, 0.1) : { message: { content: '[]' }, cost: 0.2 };
  await A.actions.compactContext();
  assert.equal(calls, 2);
  assert.equal(A.compaction.plan().stored, 0);
  assert.ok(Math.abs(A.store.get().sessionSpend - 0.3) < 1e-9);
});

test('summary validation rejects unknown ids, duplicates, excessive output and empty summaries', t => {
  const { A } = app(t);
  history(A, 12);
  const batch = A.compaction.plan().pending;
  const valid = batch.map(m => ({ id: m.id, summary: 'Short summary.' }));
  const variants = [null, {}, [], [valid[0], valid[0]], [valid[0], { id: 'not-an-input', summary: 'test' }],
    [valid[0], { id: batch[1].id, summary: '' }], [valid[0], { id: batch[1].id, summary: 'a'.repeat(1201) }]];
  variants.forEach(v => assert.throws(() => A.compaction.parseReply(JSON.stringify(v), batch)));
  assert.throws(() => A.compaction.parseReply('not JSON', batch));
});

test('stop during a batch preserves context and single-flight excludes a second compaction', async t => {
  const { A, w } = app(t);
  history(A, 43);
  let resolve, calls = 0, request;
  A.api.chatFull = opts => { calls++; request = opts; return new Promise(r => { resolve = r; }); };
  const run = A.actions.compactContext();
  await tick();
  assert.ok(w.document.body.classList.contains('busy'));
  await A.actions.compactContext();
  assert.equal(calls, 1);
  A.actions.stopGeneration();
  assert.ok(request.signal.aborted);
  resolve(reply(request)); // even a provider that ignores cancellation cannot apply
  await run;
  assert.equal(calls, 1);
  assert.equal(A.compaction.plan().stored, 0);
  assert.equal(A.store.get().sessionSpend, 0.03);
  assert.ok(!w.document.body.classList.contains('busy'));
});

test('session replacement drops late summaries and charges; source edits reject the whole result', async t => {
  const { A } = app(t);
  history(A, 12);
  let resolve, request;
  A.api.chatFull = opts => { request = opts; return new Promise(r => { resolve = r; }); };
  const run = A.actions.compactContext();
  await tick();
  A.store.newSession();
  resolve(reply(request, 5));
  await run;
  assert.equal(A.store.get().sessionSpend, 0);
  assert.equal(A.compaction.plan().stored, 0);
  const messages = history(A, 12);
  A.api.chatFull = async opts => {
    A.store.editMessage(messages[0].id, 'Changed while request was pending.');
    return reply(opts);
  };
  await A.actions.compactContext();
  assert.equal(A.compaction.plan().stored, 0);
  assert.equal(A.store.get().sessionSpend, 0.03);
});

test('tool responses cannot execute actions during compaction', async t => {
  const { A } = app(t);
  history(A, 12);
  A.tools.execute = () => { throw new Error('Must not execute'); };
  let calls = 0;
  A.api.chatFull = async () => {
    calls++;
    return { message: { content: 'pretend summary', tool_calls: [{ id: 'x', function: { name: 'bookkeep', arguments: '{}' } }] }, cost: 0.1 };
  };
  await A.actions.compactContext();
  assert.equal(calls, 1);
  assert.equal(A.compaction.plan().stored, 0);
});

test('batches fit the selected model, reject oversized entries before any paid call', async t => {
  const { A } = app(t);
  const messages = history(A, 30);
  A.store.get().settings.modelContext = 4000;
  const batches = A.compaction.batches(A.compaction.plan().pending, 4000);
  assert.ok(batches.length > 1);
  batches.forEach(b => assert.ok(A.compaction.inputTokens(b) + A.compaction.outputBudget(b) + 1024 <= 4000));
  A.store.editMessage(messages[0].id, 'Too much text '.repeat(3000));
  A.api.chatFull = async () => { assert.fail('Must reject before the request'); };
  await A.actions.compactContext();
  assert.equal(A.compaction.plan().stored, 0);
});

test('meter works without pricing, includes references, changes at exact thresholds and falls after compaction', t => {
  const { A, w } = app(t);
  const st = A.store.get();
  st.settings.modelPricing = null;
  st.settings.enableTools = false;
  const realPrompts = A.prompts.gmApiMessages;
  A.prompts.gmApiMessages = () => [];
  A.attachments.estimateTokens = () => ({ count: 1, imageTokens: 500, textTokens: 0 });
  for (const [tokens, expected] of [[299999, 'green'], [300000, 'yellow'], [599999, 'yellow'], [600000, 'red']]) {
    A.prompts.gmApiMessages = () => [{ content: 'x'.repeat((tokens - 500) * 4) }];
    A.ui.renderTopbar();
    assert.equal(w.document.querySelector('#contextUsage').dataset.level, expected);
    assert.equal(Number(w.document.querySelector('#contextUsageMeter').getAttribute('aria-valuenow')), tokens);
  }
  A.prompts.gmApiMessages = realPrompts;
  history(A);
  A.ui.renderTopbar();
  const before = Number(w.document.querySelector('#contextUsageMeter').getAttribute('aria-valuenow'));
  compactLocally(A);
  A.ui.renderTopbar();
  assert.ok(Number(w.document.querySelector('#contextUsageMeter').getAttribute('aria-valuenow')) < before);
});

test('confirmation explains losses and cost, Cancel sends nothing, Restore makes no API call', t => {
  const { A, w } = app(t);
  history(A, 12);
  A.api.chatFull = async () => { assert.fail('Dialog alone must never spend'); };
  button(w, 'Compact').click();
  const text = w.document.querySelector('#modalRoot').textContent;
  assert.match(text, /lose details/);
  assert.match(text, /newest ten/);
  assert.match(text, /charges count toward session Total/);
  button(w, 'Cancel').click();
  assert.equal(A.compaction.plan().stored, 0);
  compactLocally(A);
  button(w, 'Compact').click();
  button(w, 'Restore Full Context').click();
  assert.equal(A.compaction.plan().stored, 0);
});
