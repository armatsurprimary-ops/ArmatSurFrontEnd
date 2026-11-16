const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, tick } = require('./helpers');

test('literal names win before qualifier normalization; duplicate exact names are ambiguous', t => {
  const { A } = app(t);
  const ash = A.store.createBranch('Ashbranch', 'ai', '');
  const watcher = A.store.createBranch('The Watcher', 'ai', '');
  const kaspar = A.store.createBranch('Kaspar Rendle', 'ai', '');
  assert.equal(A.store.resolveBranch('Ashbranch').id, ash);
  assert.equal(A.store.resolveBranch('The Watcher').id, watcher);
  assert.equal(A.store.resolveBranch('Kaspar’s private branch').id, kaspar);
  A.store.createBranch('The Watcher', 'ai', '');
  assert.equal(A.store.resolveBranch('The Watcher').id, null);
  assert.equal(A.store.resolveBranch('The Watcher').ambiguous.length, 2);
});

test('whisper cannot deliver to main through aliases; failed whispers stay unrecorded', t => {
  const { A } = app(t);
  const ctx = { store: A.store, state: A.store.get(), turn: {} };
  for (const name of ['main', 'story', 'the main branch', 'public']) {
    const result = A.tools.execute('whisper', { character: name, text: 'SECRET' }, ctx);
    assert.match(result.text, /Error:/);
    assert.equal(result.record, false);
  }
  const id = A.store.createBranch('Alice', 'ai', '');
  const ok = A.tools.execute('whisper', { character: 'Alice', text: 'First secret' }, ctx);
  const duplicate = A.tools.execute('whisper', { character: 'Alice', text: 'Second secret' }, ctx);
  assert.equal(ok.record, false);
  assert.equal(duplicate.record, false);
  assert.equal(A.store.viewMessages('main').length, 0);
  assert.equal(A.store.viewMessages(id).length, 1);
});

test('whisper and bookkeeping do not clear a human turn indicator', t => {
  const { A } = app(t);
  const st = A.store.get();
  st.awaiting = 'b_user';
  A.store.addMessage({ role: 'gm', origin: 'b_user', content: 'A private hint.' });
  assert.equal(st.awaiting, 'b_user');
  A.store.addMessage({ role: 'character', origin: 'b_user', content: 'My answer.' });
  assert.equal(st.awaiting, null);
});

test('characters receive the full rulebook — behavior, world, then card for recency', t => {
  const { A } = app(t);
  const st = A.store.get();
  st.rulebook = 'RULEBOOK MARKER: the kuln system of Tellgrad. Ookah haggles with Wurther.';
  const id = A.store.createBranch('Kalt', 'ai', '[\nName: Kalt\nRace: Goblin, mountain\n]');
  const cs = A.prompts.characterSystem(st, st.branches[id]);
  // the full world document, not a digest
  assert.ok(cs.indexOf('RULEBOOK MARKER') >= 0);
  assert.ok(cs.indexOf('kuln system') >= 0);
  assert.ok(cs.indexOf('RULES DIGEST') < 0);
  // identity and behavior sections intact
  assert.ok(cs.indexOf('You ARE') >= 0);
  assert.ok(cs.indexOf('OWN YOUR DEPICTION') >= 0);
  assert.ok(cs.indexOf('two to five sentences') >= 0);
  // order: behavior -> rulebook -> card (card last for recency)
  assert.ok(cs.indexOf('RULEBOOK MARKER') > cs.indexOf('You ARE'));
  assert.ok(cs.indexOf('Name: Kalt') > cs.indexOf('RULEBOOK MARKER'));
  // assembled context carries it, and a character never sees the roster
  const ctx = A.prompts.characterApiMessages(st, id);
  assert.equal(ctx[0].role, 'system');
  assert.ok(ctx[0].content.indexOf('RULEBOOK MARKER') >= 0);
  assert.ok(ctx[0].content.indexOf('CURRENT CHARACTER ROSTER') < 0);
  // missing rulebook degrades gracefully
  st.rulebook = '';
  const cs2 = A.prompts.characterSystem(st, st.branches[id]);
  assert.ok(cs2.indexOf('RULEBOOK NOT LOADED') >= 0);
  assert.ok(cs2.indexOf('Name: Kalt') >= 0);
});

test('failed character generation does not start a GM reply', async t => {
  const { A } = app(t);
  const id = A.store.createBranch('Alice', 'ai', '');
  A.api.chatFull = async () => { throw new Error('OpenRouter 401: invalid key'); };
  let followedUp = false;
  A.actions.maybeAutoGm = () => { followedUp = true; };
  await A.actions.generateCharacter(id);
  assert.equal(followedUp, false);
  assert.equal(A.ui._conn, 'bad');
});

test('dropped GM and character responses retain the failure status', async t => {
  const { A } = app(t);
  const id = A.store.createBranch('Alice', 'ai', '');
  A.api.chatFull = async () => ({ message: { content: 'Partial text' }, dropped: true });
  await A.actions.gmReply('main');
  assert.equal(A.ui._conn, 'bad');
  await A.actions.generateCharacter(id);
  assert.equal(A.ui._conn, 'bad');
  assert.ok(A.store.allMessages().every(m => m.stopped));
});

test('the old GM turn cleans up before the next automatic turn starts', async t => {
  const { A, w } = app(t);
  const id = A.store.createBranch('Alice', 'ai', '');
  A.store.get().settings.autoTurns = true;
  A.api.chatFull = async () => ({ message: { content: 'Scene.\n[[route: main]]\n[[next: Alice 100]]' } });
  let started = false;
  A.actions.generateCharacter = bid => {
    assert.equal(bid, id);
    started = true;
    A.ui.setBusy('Next character is thinking...');
  };
  await A.actions.gmReply('main');
  assert.equal(started, true);
  assert.equal(w.document.body.classList.contains('busy'), true);
  assert.match(w.document.querySelector('.busy-row').textContent, /Next character/);
});

test('tools not offered to a character cannot be executed by a stray tool call', async t => {
  const { A } = app(t);
  let calls = 0;
  A.api.chatFull = async () => (++calls === 1 ? { message: { tool_calls: [{
    id: 'bad-call', type: 'function', function: {
      name: 'whisper', arguments: JSON.stringify({ character: 'user', text: 'Unwanted write' })
    }
  }] } } : { message: { content: 'Finished.' } });
  const result = await A.actions._test.chatWithTools({ model: 'test/model', messages: [], audience: 'character', originBranchId: 'b_user' });
  assert.equal(result.content, 'Finished.');
  assert.equal(A.store.allMessages().length, 0);
});

test('a response from an old session cannot write into a newly started game', async t => {
  const { A } = app(t);
  let complete;
  A.api.chatFull = () => new Promise(resolve => { complete = resolve; });
  const pending = A.actions.gmReply('main');
  await tick();
  A.store.newSession();
  const freshMessages = JSON.stringify(A.store.get().messages);
  complete({ message: { content: 'Old game reply.\n[[route: main]]\n[[next: user 100]]' } });
  await pending;
  assert.equal(JSON.stringify(A.store.get().messages), freshMessages);
});

test('settings v2 migration: old defaults shift once; deliberate choices survive', t => {
  const { w } = app(t);
  // simulate a pre-v2 install sitting on the old defaults
  w.localStorage.setItem('armatsur-settings-v1', JSON.stringify({
    settings: { apiKey: 'test-only', reasoning: 'high', maxTokens: 2000 },
    rulebook: ''
  }));
  const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'store.js'), 'utf8');
  w.eval(source);
  let s = w.App.store.get().settings;
  assert.equal(s.reasoning, 'medium');
  assert.equal(s.maxTokens, 10000);
  assert.equal(s.settingsVer, 2);
  // persisted immediately — a crash before the next save won't re-migrate
  assert.equal(JSON.parse(w.localStorage.getItem('armatsur-settings-v1')).settings.settingsVer, 2);
  // deliberately choosing high again sticks across reloads
  s.reasoning = 'high';
  s.maxTokens = 4000;
  w.App.store.save();
  w.eval(source);
  s = w.App.store.get().settings;
  assert.equal(s.reasoning, 'high');
  assert.equal(s.maxTokens, 4000);
  assert.equal(s.settingsVer, 2);
  // deliberate v1 choices that differ from the old defaults are untouched
  const custom = JSON.parse(w.localStorage.getItem('armatsur-settings-v1'));
  custom.settings.reasoning = 'low';
  custom.settings.maxTokens = 6000;
  delete custom.settings.settingsVer;
  w.localStorage.setItem('armatsur-settings-v1', JSON.stringify(custom));
  w.eval(source);
  s = w.App.store.get().settings;
  assert.equal(s.reasoning, 'low');
  assert.equal(s.maxTokens, 6000);
});

test('failed legacy migration retains a recoverable copy and resumes on reload', t => {
  const { A, w } = app(t);
  const legacy = { ...A.store.get(), meta: { name: 'Legacy game' } };
  w.localStorage.clear();
  w.localStorage.setItem('armatsur-state-v1', JSON.stringify(legacy));
  const setItem = w.Storage.prototype.setItem;
  w.Storage.prototype.setItem = function (key, value) {
    if (key === 'armatsur-session-v1') throw new Error('Simulated quota failure');
    return setItem.call(this, key, value);
  };
  w.console.warn = () => {};
  const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'store.js'), 'utf8');
  w.eval(source);
  assert.ok(w.localStorage.getItem('armatsur-state-v1'));
  w.Storage.prototype.setItem = setItem;
  w.eval(source);
  assert.equal(w.App.store.get().meta.name, 'Legacy game');
  assert.equal(w.localStorage.getItem('armatsur-state-v1'), null);
  assert.equal(JSON.parse(w.localStorage.getItem('armatsur-session-v1')).meta.name, 'Legacy game');
});
