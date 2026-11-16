const test = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('./helpers');

function welcome(A) {
  const messages = A.store.allMessages();
  assert.equal(messages.length, 1);
  const message = messages[0];
  assert.equal(message.role, 'gm');
  assert.equal(message.name, 'GM');
  assert.equal(message.origin, 'b_user');
  assert.match(message.content, /Welcome to Armat-sur a world simulation TTRPG-like experience!/);
  assert.match(message.content, /So what would you like to do first\?/);
  assert.equal(A.store.get().branches.b_user.messageIds[0], message.id);
  assert.equal(A.store.get().activeBranchId, 'b_user');
  assert.equal(A.store.get().awaiting, null);
  return message;
}

test('first-run welcome is saved, editable, visible to the GM and private to the user', t => {
  const { A, w } = app(t, null, { fresh: true });
  const first = welcome(A);
  const other = A.store.createBranch('Alice', 'ai', '');
  assert.equal(A.store.viewMessages('main').length, 0);
  assert.equal(A.store.characterContextMessages(other).length, 0);
  assert.equal(A.store.viewMessages('b_user')[0].id, first.id);
  assert.equal(A.store.gmContextMessages()[0].id, first.id);
  A.store.editMessage(first.id, 'My revised introduction.');
  const saved = w.localStorage.getItem('armatsur-session-v1');
  const loaded = app(t, win => win.localStorage.setItem('armatsur-session-v1', saved), { fresh: true });
  assert.equal(loaded.A.store.allMessages().length, 1);
  assert.equal(loaded.A.store.allMessages()[0].content, 'My revised introduction.');
});

test('new sessions and reset get one local welcome without changing saved history', t => {
  const { A } = app(t);
  A.store.get().rulebook = 'Test rulebook';
  A.store.get().settings.apiKey = 'test-key';
  A.store.addMessage({ role: 'gm', origin: 'main', content: 'Existing story.' });
  const saved = A.store.serializeSession();
  A.store.newSession();
  const first = welcome(A);
  assert.equal(A.store.get().rulebook, 'Test rulebook');
  assert.equal(A.store.get().settings.apiKey, 'test-key');
  A.store.addMessage({role:'character', origin:'b_user', content:'An explorer.'});
  assert.ok(A.store.allMessages()[1].ts > first.ts);
  A.store.newSession(); welcome(A);
  A.store.applySession(saved);
  assert.equal(A.store.allMessages().length, 1);
  assert.equal(A.store.allMessages()[0].content, 'Existing story.');
  A.store.reset(); welcome(A);
});

test('loading empty, imported or legacy sessions never inserts a welcome', t => {
  const { A } = app(t);
  assert.equal(A.store.allMessages().length, 0);
  const saved = A.store.serializeSession();
  A.store.newSession(); welcome(A);
  A.store.applySession(saved);
  assert.equal(A.store.allMessages().length, 0);
  const legacy = app(t, w => w.localStorage.setItem('armatsur-state-v1', saved), { fresh: true });
  assert.equal(legacy.A.store.allMessages().length, 0);
});
