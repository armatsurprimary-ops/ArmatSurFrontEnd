const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const { app } = require('./helpers');

const bundled = fs.readFileSync(path.join(__dirname, '../Armat Sur rule book text doc.txt'), 'utf8').replace(/^\uFEFF/, '');
const previousHash = '1b884251293b4dd13a91faedc73cd6488e2e686a46f1fbd60221ee07211e7c0a';
const oldBook = '\uFEFFPrevious bundled edition\r\n' + 'Text. '.repeat(30);

function withBook(t, book, previousEdition) {
  const { A, w } = app(t);
  w.TextEncoder = TextEncoder;
  Object.defineProperty(w.crypto, 'subtle', { value: previousEdition ? {
    // Stand in for the historical manuscript without keeping a second full book
    // in test fixtures. Also verify normalization before fingerprinting.
    async digest(algorithm, bytes) {
      assert.equal(algorithm, 'SHA-256');
      assert.equal(new TextDecoder().decode(bytes), book.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n'));
      return Uint8Array.from(Buffer.from(typeof previousEdition === 'string' ? previousEdition : previousHash, 'hex')).buffer;
    }
  } : webcrypto.subtle });
  A.store.get().rulebook = book;
  return { A, w };
}

test('empty browser loads and persists the current bundled rulebook without using cache', async t => {
  const { A, w } = withBook(t, '');
  w.fetch = async (url, options) => {
    assert.equal(url, 'Armat Sur rule book text doc.txt');
    assert.equal(options.cache, 'no-store');
    return new Response(bundled);
  };
  await A.actions._test.ensureRulebook();
  assert.equal(A.store.get().rulebook, bundled);
  assert.equal(JSON.parse(w.localStorage.getItem('armatsur-settings-v1')).rulebook, bundled);
});

test('previous bundled edition is refreshed without altering the game or settings', async t => {
  const { A, w } = withBook(t, oldBook, true);
  const settings = JSON.stringify(A.store.get().settings);
  const session = JSON.parse(A.store.serializeSession());
  delete session.meta.savedAt;
  w.fetch = async () => new Response(bundled);
  await A.actions._test.ensureRulebook();
  assert.equal(A.store.get().rulebook, bundled);
  assert.equal(JSON.parse(w.localStorage.getItem('armatsur-settings-v1')).rulebook, bundled);
  assert.equal(JSON.stringify(A.store.get().settings), settings);
  const after = JSON.parse(A.store.serializeSession());
  delete after.meta.savedAt;
  assert.deepEqual(after, session);
});

test('custom and already-current rulebooks are preserved without fetching', async t => {
  const { A, w } = withBook(t, 'Custom world. '.repeat(30));
  w.fetch = async () => { assert.fail('must not fetch for a custom/current book'); };
  for (const book of ['Custom world. '.repeat(30), bundled]) {
    A.store.get().rulebook = book;
    await A.actions._test.ensureRulebook();
    assert.equal(A.store.get().rulebook, book);
  }
});

test('the previous November bundled manuscript refreshes to the release edition', async t => {
  const { A, w } = withBook(t, oldBook, '98ae6a6b7145cadc62fbafb728ca6d87092a2a769adc4d50ec5fd3df3f78e558');
  w.fetch = async () => new Response(bundled);
  await A.actions._test.ensureRulebook();
  assert.equal(A.store.get().rulebook, bundled);
  assert.equal(JSON.parse(w.localStorage.getItem('armatsur-settings-v1')).rulebook, bundled);
});

test('failed refresh keeps the previously loaded rules', async t => {
  const { A, w } = withBook(t, oldBook, true);
  for (const response of [new Response('', { status: 404 }), new Response('too short')]) {
    w.fetch = async () => response;
    await A.actions._test.ensureRulebook();
    assert.equal(A.store.get().rulebook, oldBook);
  }
  w.fetch = async () => { throw new Error('offline'); };
  await A.actions._test.ensureRulebook();
  assert.equal(A.store.get().rulebook, oldBook);
});

test('a rulebook import or clear during bootstrap takes precedence over the fetch', async t => {
  const { A, w } = withBook(t, oldBook, true);
  for (const replacement of ['Imported book. '.repeat(30), '']) {
    A.store.get().rulebook = oldBook;
    w.fetch = async () => {
      A.store.get().rulebook = replacement;
      return new Response(bundled);
    };
    await A.actions._test.ensureRulebook();
    assert.equal(A.store.get().rulebook, replacement);
  }
});
