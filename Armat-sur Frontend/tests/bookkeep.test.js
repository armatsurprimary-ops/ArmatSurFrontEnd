const test = require('node:test');
const assert = require('node:assert/strict');
const { app, tick } = require('./helpers');

const CARD = [
  '[',
  'Name: Theren Aelderkant',
  'Description: A thirteen year old cadet of the storm guard order.',
  'Race: Elf',
  'Sex: Male',
  'Inherent Tags: combat training#, determined, fit build~',
  'Temporary Tags: aether reserve (50/50)',
  'Equipment Tags: longsword, gambeson vest~',
  ']'
].join('\n');

function tharen(A) {
  const id = A.store.createBranch('Theren Aelderkant', 'ai', CARD);
  return id;
}
const BK = (A, args, turn) => A.tools.execute('bookkeep', args, {
  store: A.store, state: A.store.get(), turn: turn || {}
});

test('bookkeep applies tags and reserve to the card and announces in main', t => {
  const { A } = app(t);
  const id = tharen(A);
  const out = BK(A, { character: 'Theren', add_tags: ['tired#'], aether_reserve: '20/50' });
  assert.match(out.text, /Recorded:/);
  assert.equal(out.record, false);
  const card = A.store.get().branches[id].card;
  assert.match(card, /Temporary Tags: aether reserve \(20\/50\), tired#/);
  // announcement is a public GM message in main, doc phrasing
  const announce = A.store.viewMessages('main').find(m => m.role === 'gm');
  assert.ok(announce);
  assert.match(announce.content, /I'm setting Theren Aelderkant's aether reserve to \(20\/50\)\./);
  assert.match(announce.content, /I'm adding \(tired#\) to Theren Aelderkant\./);
  // no tool-log entry — the announcement is the record
  assert.ok(!A.store.allMessages().some(m => m.name === 'Tool: bookkeep'));
});

test('removals match regardless of magnitude marks; duplicates are skipped', t => {
  const { A } = app(t);
  const id = tharen(A);
  let out = BK(A, { character: 'Theren Aelderkant', add_tags: ['blemished#'] });
  assert.match(out.text, /blemished#/);
  out = BK(A, { character: 'Theren Aelderkant', add_tags: ['blemished+'] });
  assert.match(out.text, /Nothing changed/);
out = BK(A, { character: 'Theren Aelderkant', remove_tags: ['blemished'] });
assert.match(out.text, /I'm removing \(blemished#\)/);
assert.ok(!/blemished/.test(A.store.get().branches[id].card));
// announcements are append-only table history: the removal line exists too
assert.ok(A.store.allMessages().some(m => /I'm removing \(blemished#\)/.test(m.content)));
});

test('reserve is added when the card lacks it; Temporary Tags line is created when missing', t => {
  const { A } = app(t);
  const id = A.store.createBranch('Bare', 'ai', '[\nName: Bare\nRace: Goblin\nEquipment Tags: knife\n]');
  const out = BK(A, { character: 'Bare', add_tags: ['hungry~'], aether_reserve: '5/20' });
  assert.match(out.text, /Recorded/);
  const card = A.store.get().branches[id].card;
  assert.match(card, /Temporary Tags: aether reserve \(5\/20\), hungry~/);
  assert.match(card, /Equipment Tags: knife/);
});

test('bookkeep refuses unknown, ambiguous, and cardless characters; validates reserve format', t => {
  const { A } = app(t);
  tharen(A);
  A.store.createBranch('Theren the Bold', 'ai', CARD);
  assert.match(BK(A, { character: 'Theren' }).text, /ambiguous/);
  assert.match(BK(A, { character: 'Nobody' }).text, /no character branch/);
  const bare = A.store.createBranch('Cardless', 'ai', '');
  assert.match(BK(A, { character: 'Cardless', add_tags: ['tired#'] }).text, /no character card/);
  assert.match(BK(A, { character: 'Theren the Bold', aether_reserve: 'half' }).text, /must look like/);
  assert.match(BK(A, { character: 'Theren the Bold' }).text, /nothing to bookkeep/);
});

test('a full GM turn can narrate, bookkeep mid-stream, and route per the section protocol', async t => {
  const { A } = app(t);
  const id = tharen(A);
  let call = 0;
  A.api.chatFull = async () => {
    call++;
    if (call === 1) {
      return { message: { tool_calls: [{ id: 'bk1', type: 'function', function: {
        name: 'bookkeep',
        arguments: JSON.stringify({ character: 'Theren Aelderkant', add_tags: ['blemished#'] })
      } }] } };
    }
    return { message: { content: 'The knife slips past the guard and cuts deep.\n[[route: main]]\n[[next: pause 100]]' } };
  };
  await A.actions.gmReply('main');
  // narration filed publicly
  const narr = A.store.allMessages().find(m => m.role === 'gm' && /cuts deep/.test(m.content));
  assert.equal(narr.origin, 'main');
  // bookkeeping applied mid-turn: card updated, announcement public
  assert.match(A.store.get().branches[id].card, /blemished#/);
  const announce = A.store.allMessages().filter(m => m.role === 'gm' && /I'm adding/.test(m.content));
  assert.equal(announce.length, 1);
  assert.equal(announce[0].origin, 'main');
  assert.ok(!A.store.allMessages().some(m => m.name === 'Tool: bookkeep'));
});

test('GM prompt teaches the shared/solo split and the bookkeeping pattern', t => {
  const { A } = app(t);
  const gs = A.prompts.gmSystem(A.store.get());
  assert.ok(gs.indexOf('SHARED vs SOLO system talk') >= 0);
  assert.ok(gs.indexOf('Main is not narration-only') >= 0);
  assert.ok(gs.indexOf('STATE BOOKKEEPING') >= 0);
  assert.ok(gs.indexOf("I'm setting Michael's aether reserve to (30/60)") >= 0);
  assert.ok(gs.indexOf('world record and the shared table') >= 0);
  assert.ok(gs.indexOf('play channel for SOLO exchanges') >= 0);
  assert.ok(gs.indexOf('shared table record') >= 0);   // VOICE BY CHANNEL
  assert.ok(gs.indexOf('bookkeep') >= 0);              // duties + tools list
  assert.ok(gs.indexOf('- bookkeep:') >= 0);          // appears in the tools summary
});
