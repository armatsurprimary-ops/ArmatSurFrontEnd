const test = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('./helpers');

test('GM guidance separates public narration, private facts, next-speaker choice, and regeneration', t => {
  const { A } = app(t);
  const prompt = A.prompts.gmSystem(A.store.get());
  assert.match(prompt, /Keep unrevealed secrets out/);
  assert.match(prompt, /next-speaker choice alone does not require a private section/);
  assert.match(prompt, /exception overrides normal instructions to roll or bookkeep/);
  assert.match(prompt, /Keep tag marks #, ~, \+ intact/);
  assert.match(prompt, /When automatic turns are enabled/);
  assert.doesNotMatch(prompt, /ALL narration and world state|6, a mild success|Use this whenever the turn-order table picks/);
});

test('character guidance distinguishes table knowledge from character knowledge and keeps regenerations short', async t => {
  const { A } = app(t);
  const alice = A.store.createBranch('Alice', 'ai', 'Name: Alice');
  const st = A.store.get();
  const prompt = A.prompts.characterSystem(st, st.branches[alice]);
  assert.match(prompt, /table knowledge, not automatic in-world knowledge/);
  assert.match(prompt, /does not make you omniscient/);
  const m = A.store.addMessage({ role: 'character', name: 'Alice', origin: alice, content: 'Original' });
  A.api.chatFull = async opts => {
    const cue = opts.messages.at(-1).content;
    assert.match(cue, /two to five sentences/);
    assert.doesNotMatch(cue, /paragraphs/);
    return { message: { content: 'I ask the GM what I can see.' } };
  };
  await A.actions.regenerateMessage(m.id);
  assert.equal(m.content, 'I ask the GM what I can see.');
});

test('context labels preserve actual origins and never attribute another public speaker to the receiving character', t => {
  const { A } = app(t);
  const alice = A.store.createBranch('Alice', 'ai', '');
  const bob = A.store.createBranch('Bob', 'ai', '');
  A.store.addMessage({ role: 'character', name: 'Bob', origin: 'main', content: 'PUBLIC BOB' });
  A.store.addMessage({ role: 'character', name: 'Alice', origin: alice, content: 'OWN ALICE' });
  A.store.addMessage({ role: 'character', name: 'Bob', origin: bob, content: 'PRIVATE BOB' });
  A.store.addMessage({ role: 'gm', origin: 'main', content: 'PUBLIC SCENE' });
  A.store.addMessage({ role: 'gm', origin: alice, content: 'PRIVATE RULING' });
  const st = A.store.get();
  const char = A.prompts.characterApiMessages(st, alice);
  assert.equal(char.find(m => m.content.includes('PUBLIC BOB')).role, 'user');
  assert.match(char.find(m => m.content.includes('PUBLIC BOB')).content, /Bob — public/);
  assert.equal(char.find(m => m.content === 'OWN ALICE').role, 'assistant');
  assert.ok(!char.some(m => m.content.includes('PRIVATE BOB')));
  assert.match(char.find(m => m.content.includes('PUBLIC SCENE')).content, /GM \(public\)/);
  assert.match(char.find(m => m.content.includes('PRIVATE RULING')).content, /GM \(private to Alice\)/);
  const gm = A.prompts.gmApiMessages(st, { origin: alice });
  assert.match(gm.find(m => m.content.includes('PUBLIC BOB')).content, /Bob — public/);
  assert.match(gm.find(m => m.content.includes('PRIVATE BOB')).content, /Bob — private to Bob/);
});

test('whisper recovery instructions respect the actual delivery and length limits', t => {
  const { A } = app(t);
  A.store.createBranch('Alice', 'ai', '');
  const ctx = { store: A.store, state: A.store.get(), turn: {} };
  const tooLong = A.tools.execute('whisper', { character: 'Alice', text: 'x'.repeat(801) }, ctx);
  assert.match(tooLong.text, /Shorten the private facts and retry/);
  A.tools.execute('whisper', { character: 'Alice', text: 'Only you notice the latch.' }, ctx);
  const duplicate = A.tools.execute('whisper', { character: 'Alice', text: 'More.' }, ctx);
  assert.match(duplicate.text, /was delivered and cannot be replaced/);
  assert.doesNotMatch(duplicate.text, /Merge your points/);
  assert.equal(A.store.allMessages().length, 1);
});
