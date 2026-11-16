const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, button, input, tick } = require('./helpers');

test('new welcome explains all four tag magnitudes, negotiation, and the System Prompt control', t => {
  const { A } = app(t, null, { fresh: true });
  const text = A.store.allMessages()[0].content;
  for (const fragment of ['trivial tags denoted with # have a flat impact of 1', 'minor denoted with a ~ have a d3 impact', 'standard which lack denotation have an impact of d6', 'major which are denoted with a + have an impact of d10', 'common sense negotiation', 'invocation and magnitude ultimately falls to the GM', 'The System Prompt button opens']) assert.ok(text.includes(fragment));
});

test('prompt templates persist with sessions, reset on new game, and expand live data only once', t => {
  const { A, w } = app(t);
  const alice = A.store.createBranch('Alice', 'ai', 'Name: Alice\nTemporary Tags: fresh');
  A.store.createBranch('Hidden Bob', 'ai', 'PRIVATE ROSTER VALUE');
  const st = A.store.get();
  st.rulebook = 'WORLD {{roster}}';
  st.promptTemplates = { gm: 'GM custom\n{{rulebook}}\n{{roster}}\n{{gm_instructions}}', character: 'Player {{character_name}}\n{{rulebook}}\n{{character_card}}' };
  st.gmExtra = 'Scenario instructions';
  A.store.save();
  assert.match(A.prompts.gmApiMessages(st)[0].content, /GM custom/);
  assert.match(A.prompts.gmSystem(st), /PRIVATE ROSTER VALUE/);
  assert.match(A.prompts.gmSystem(st), /Scenario instructions/);
  const char = A.prompts.characterApiMessages(st, alice)[0].content;
  assert.match(char, /Player Alice/);
  assert.match(char, /WORLD \{\{roster\}\}/);
  assert.doesNotMatch(char, /PRIVATE ROSTER VALUE/);
  st.branches[alice].card = 'UPDATED CARD {{gm_instructions}}';
  st.rulebook = 'UPDATED BOOK';
  assert.match(A.prompts.characterSystem(st, st.branches[alice]), /UPDATED CARD \{\{gm_instructions\}\}/);
  assert.match(A.prompts.gmSystem(st), /UPDATED BOOK/);
  assert.match(A.prompts.validateTemplate('{{roster}}', 'character'), /Unavailable/);
  assert.match(A.prompts.validateTemplate('{{typo}}', 'gm'), /typo/);
  st.promptTemplates.character = '{{roster}} {{toString}}';
  assert.equal(A.prompts.characterSystem(st, st.branches[alice]), '{{roster}} {{toString}}'); // imported invalid inserts are inert
  const saved = A.store.serializeSession();
  assert.ok(!saved.includes('test-only'));
  A.store.newSession();
  assert.equal(A.store.get().promptTemplates.gm, null);
  A.store.applySession(saved);
  assert.equal(A.store.get().promptTemplates.gm, st.promptTemplates.gm);
  assert.equal(A.store.get().rulebook, 'UPDATED BOOK');
  assert.equal(JSON.parse(w.localStorage.getItem('armatsur-session-v1')).promptTemplates.gm, st.promptTemplates.gm);
  A.store.applySession(JSON.stringify({ branches: { main: st.branches.main }, branchOrder: ['main'], messages: {}, promptTemplates: { gm: 42 } }));
  assert.equal(A.store.get().promptTemplates.gm, null);
});

test('prompt editor preserves both drafts, previews live inserts, cancels and restores defaults', t => {
  const { A, w } = app(t);
  A.store.createBranch('Alice', 'ai', 'Name: Alice\nTemporary Tags: tired#');
  A.ui.renderAll();
  button(w, 'System Prompt').click();
  const audience = w.document.querySelector('[aria-label="System prompt audience"]');
  const ta = w.document.querySelector('#systemTemplate');
  input(w, ta, 'Character draft {{character_card}}');
  assert.match(w.document.querySelector('.prompt-preview pre').textContent, /tired#/);
  input(w, audience, 'gm', 'change');
  input(w, ta, 'GM draft {{roster}}');
  input(w, audience, 'character', 'change');
  assert.equal(ta.value, 'Character draft {{character_card}}');
  button(w, 'Save').click();
  assert.equal(A.store.get().promptTemplates.gm, 'GM draft {{roster}}');
  assert.equal(A.store.get().promptTemplates.character, 'Character draft {{character_card}}');
  A.ui.openSystemPromptModal('gm');
  input(w, w.document.querySelector('#systemTemplate'), 'Discarded');
  button(w, 'Cancel').click();
  assert.equal(A.store.get().promptTemplates.gm, 'GM draft {{roster}}');
  A.ui.openSystemPromptModal('gm');
  button(w, 'Restore Default Template').click();
  button(w, 'Save').click();
  assert.equal(A.store.get().promptTemplates.gm, null);
});

test('older replies can regenerate without future context, side effects or a scroll jump', async t => {
  const { A, w } = app(t);
  const alice = A.store.createBranch('Alice', 'ai', 'CURRENT CARD');
  A.store.addMessage({ role: 'character', name: 'Alice', origin: alice, content: 'EARLIER INTENT' });
  const old = A.store.addMessage({ role: 'gm', origin: alice, content: 'OLD RESULT d6 = 4', reasoning: 'Original reasoning' });
  const later = A.store.addMessage({ role: 'gm', origin: alice, content: 'FUTURE RESULT' });
  A.store.addMessage({ role: 'gm', origin: 'main', content: 'FUTURE PUBLIC' });
  A.store.get().awaiting = alice;
  A.ui.renderAll();
  assert.ok(w.document.querySelector('[data-message-id="' + old.id + '"] .revision-action'));
  const box = w.document.querySelector('#messages'); box.scrollTop = 37;
  const draft = w.document.querySelector('#composer textarea'); input(w, draft, 'Unsent draft');
  let calls = 0;
  A.api.chatFull = async opts => {
    calls++;
    const text = opts.messages.map(m => m.content).join('\n');
    assert.match(text, /EARLIER INTENT/);
    assert.match(text, /OLD RESULT d6 = 4/);
    assert.match(text, /CURRENT CARD/);
    assert.doesNotMatch(text, /FUTURE RESULT|FUTURE PUBLIC/);
    assert.equal(opts.tools, undefined);
    return { cost: 0.25, message: { content: 'Revised RESULT d6 = 4', reasoning: 'New reasoning' } };
  };
  await A.actions.regenerateMessage(old.id);
  assert.equal(calls, 1);
  assert.equal(old.content, 'Revised RESULT d6 = 4');
  assert.equal(later.content, 'FUTURE RESULT');
  assert.equal(A.store.get().branches[alice].card, 'CURRENT CARD');
  assert.equal(A.store.get().awaiting, alice);
  assert.equal(A.store.allMessages().length, 4);
  assert.equal(box.scrollTop, 37);
  assert.equal(w.document.querySelector('#composer textarea').value, 'Unsent draft');
  const versions = w.document.querySelector('[data-message-id="' + old.id + '"] [aria-label="Saved reply version"]');
  input(w, versions, '0', 'change');
  assert.equal(old.content, 'OLD RESULT d6 = 4');
  assert.equal(old.reasoning, 'Original reasoning');
  assert.equal(box.scrollTop, 37);
  assert.equal(A.store.get().sessionSpend, 0.25);
  assert.match(A.prompts.gmApiMessages(A.store.get()).find(m => m.content.includes('OLD RESULT')).content, /OLD RESULT/);
});

test('historical character regeneration respects visibility, controller and single-flight guard', async t => {
  const { A, w } = app(t);
  const alice = A.store.createBranch('Alice', 'ai', 'Name: Alice');
  const bob = A.store.createBranch('Bob', 'human', 'BOB CARD');
  A.store.addMessage({ role: 'gm', origin: bob, content: 'BOB PRIVATE' });
  const old = A.store.addMessage({ role: 'character', name: 'Alice', origin: alice, content: 'First declaration' });
  A.store.addMessage({ role: 'gm', origin: 'main', content: 'LATER SCENE' });
  let finish, calls = 0;
  A.api.chatFull = async opts => {
    calls++;
    assert.doesNotMatch(opts.messages.map(m => m.content).join('\n'), /BOB PRIVATE|BOB CARD|LATER SCENE/);
    return new Promise(resolve => { finish = resolve; });
  };
  const pending = A.actions.regenerateMessage(old.id);
  await tick();
  await A.actions.regenerateMessage(old.id);
  assert.equal(calls, 1);
  finish({ message: { content: 'New declaration' } });
  await pending;
  A.ui.setBusy('Another request');
  A.actions.selectSwipe(old.id, 0);
  assert.equal(old.content, 'New declaration');
  A.ui.setBusy(null);
  A.store.updateBranch(alice, { controller: 'human' });
  await A.actions.regenerateMessage(old.id);
  assert.equal(calls, 1);
  A.store.get().activeBranchId = alice; A.ui.renderAll();
  assert.equal(w.document.querySelector('[data-message-id="' + old.id + '"] .revision-action'), null);
  A.actions.selectSwipe(old.id, 0); // saved versions remain usable
  assert.equal(old.content, 'First declaration');
});

test('card panel follows the active character, updates during bookkeeping and preserves narrow-view editing', async t => {
  const { A, w } = app(t);
  const alice = A.store.createBranch('Alice', 'ai', 'Name: Alice\nTemporary Tags: healthy');
  const bob = A.store.createBranch('Bob', 'human', 'Name: Bob\nTemporary Tags: tired#');
  A.ui.renderAll();
  assert.match(w.document.querySelector('.card-current').textContent, /Name: Bob/);
  A.store.get().activeBranchId = alice; A.ui.renderAll();
  assert.match(w.document.querySelector('.card-current').textContent, /Name: Alice/);
  let n = 0;
  A.api.chatFull = async () => {
    if (++n === 1) return { message: { tool_calls: [{ id: 'book', function: { name: 'bookkeep', arguments: JSON.stringify({ character: 'Alice', add_tags: ['tired~'] }) } }] } };
    assert.match(w.document.querySelector('.card-current').textContent, /tired~/); // updated before continuation returns
    return { message: { content: '[[route: Alice]]\nYou are tired.\n[[next: pause 100]]' } };
  };
  await A.actions.gmReply(alice);
  button(w, 'Hide Card Panel').click();
  assert.equal(w.document.querySelector('#characterPanel').hidden, true);
  button(w, 'Character Card').click();
  input(w, w.document.querySelector('.modal textarea'), 'Name: Alice\nTemporary Tags: rested');
  button(w, 'Save').click();
  button(w, 'Show Card Panel').click();
  assert.match(w.document.querySelector('.card-current').textContent, /rested/);
  assert.equal(A.store.get().branches[bob].card, 'Name: Bob\nTemporary Tags: tired#');
});

test('default prompt recovery file matches both built-in templates', t => {
  const { A } = app(t);
  const backup = fs.readFileSync(path.join(__dirname, '../SYSTEM-PROMPT-DEFAULTS.txt'), 'utf8');
  assert.ok(backup.includes(A.prompts.defaultTemplate('gm')));
  assert.ok(backup.includes(A.prompts.defaultTemplate('character')));
});
