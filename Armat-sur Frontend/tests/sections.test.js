const test = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('./helpers');

const REPLY = 'The goblin rises from the ditch and looses an arrow.\n\n' +
  '[[route: Ozireth]]\n' +
  '(marksmanship~) + (aim#) - (target evasion): d3 + d3 - d6 = 2 + 1 - 3 = 0.\n' +
  'The arrow skips off the boulder beside you.\n\n' +
  '[[next: Ozireth 60, GM 40]]';

test('two route markers split the reply into sections; unmarked lead is main narration', t => {
  const { A } = app(t);
  const foot = A.actions._test.parseTurnFooter(REPLY);
  assert.equal(foot.sections.length, 2);
  assert.equal(foot.sections[0].name, null);                 // unmarked lead -> main
  assert.match(foot.sections[0].text, /looses an arrow/);
  assert.equal(foot.sections[1].name, 'Ozireth');
  assert.match(foot.sections[1].text, /marksmanship~/);
  assert.equal(foot.next, 'Ozireth 60, GM 40');
});

test('zero or one marker keeps the legacy single-destination behavior', t => {
  const { A } = app(t);
  let foot = A.actions._test.parseTurnFooter('Scene.\n[[route: main]]\n[[next: pause 100]]');
  assert.equal(foot.sections, null);
  assert.equal(foot.route, 'main');
  assert.equal(foot.clean, 'Scene.');
  foot = A.actions._test.parseTurnFooter('Just prose, no control data.');
  assert.equal(foot.sections, null);
  assert.equal(foot.route, null);
  assert.equal(foot.clean, 'Just prose, no control data.');
});

test('a section reply is filed into main and the branch, with the chain continuing from the branch', async t => {
  const { A } = app(t);
  const ozireth = A.store.createBranch('Ozireth', 'ai', '');
  const sorrel = A.store.createBranch('Sorrel', 'human', '');
  let picked = null;
  A.store.get().settings.autoTurns = true;
  A.actions.generateCharacter = bid => { picked = bid; };
  // deterministic table: the roll always picks Ozireth
  A.api.chatFull = async () => ({ message: {
    content: REPLY.replace('[[next: Ozireth 60, GM 40]]', '[[next: Ozireth 100]]'),
    reasoning: 'chain of thought'
  } });
  await A.actions.gmReply('main');
  const msgs = A.store.allMessages().filter(m => m.role === 'gm');
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].origin, 'main');
  assert.match(msgs[0].content, /looses an arrow/);
  assert.equal(msgs[1].origin, ozireth);
  assert.match(msgs[1].content, /marksmanship~/);
  // visibility: narration is public, the system exchange is Ozireth's alone
  assert.ok(A.store.viewMessages(sorrel).some(m => m.id === msgs[0].id));
  assert.ok(!A.store.viewMessages(sorrel).some(m => m.id === msgs[1].id));
  assert.ok(A.store.viewMessages(ozireth).some(m => m.id === msgs[1].id));
  // reasoning attaches once, to the first stored part
  assert.equal(msgs[0].reasoning, 'chain of thought');
  assert.equal(msgs[1].reasoning, undefined);
  // the turn roll happened and the chain continues from the picked character's branch
  assert.ok(A.store.allMessages().some(m => m.name === 'Tool: turn_order'));
  assert.equal(picked, ozireth);
});

test('unroutable sections are dropped visibly; deliverable sections survive', async t => {
  const { A } = app(t);
  const ozireth = A.store.createBranch('Ozireth', 'ai', '');
  const reply = 'Narration everyone sees.\n\n[[route: Ghost Town]]\nPrivate words to nobody.\n\n' +
    '[[route: Ozireth]]\nRoll: d6 = 4.\n\n[[next: pause 100]]';
  A.api.chatFull = async () => ({ message: { content: reply } });
  await A.actions.gmReply('main');
  const msgs = A.store.allMessages().filter(m => m.role === 'gm');
  assert.equal(msgs.length, 2);
  assert.equal(msgs[1].origin, ozireth);
  assert.match(A.store.get().messages[msgs[0].id].content, /Narration everyone sees/);
  assert.ok(!msgs.some(m => /Ghost Town/.test(m.content)));
  assert.ok(!msgs.some(m => /nobody/.test(m.content)));
});

test('when every marked section fails, only the narration survives — private text never leaks to main', async t => {
  const { A } = app(t);
  const ozireth = A.store.createBranch('Ozireth', 'ai', '');
  const reply = 'Everything.\n\n[[route: Ghost One]]\nPart one.\n\n[[route: Ghost Two]]\nPart two.';
  A.api.chatFull = async () => ({ message: { content: reply } });
  await A.actions.gmReply('main');
  const msgs = A.store.allMessages().filter(m => m.role === 'gm');
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].origin, 'main');
  assert.match(msgs[0].content, /Everything/);
  // the unroutable private sections are dropped, not delivered anywhere
  assert.ok(!msgs.some(m => /Part one/.test(m.content)));
  assert.ok(!msgs.some(m => /Part two/.test(m.content)));
  // A wholly unroutable private reply must not fall back to another channel.
  const solo = '[[route: Ghost]]\nThe whole turn.';
  A.api.chatFull = async () => ({ message: { content: solo } });
  await A.actions.gmReply(ozireth);
  assert.equal(A.store.allMessages().filter(m => m.role === 'gm').length, 1);
  assert.ok(!A.store.allMessages().some(m => /The whole turn/.test(m.content)));
});

test('sections are capped so pathological replies cannot flood branches', t => {
  const { A } = app(t);
  A.store.createBranch('Ozireth', 'ai', '');
  let reply = 'Lead.\n\n';
  for (let i = 0; i < 10; i++) reply += '[[route: Ozireth]]\nPart ' + i + '.\n\n';
  const foot = A.actions._test.parseTurnFooter(reply);
  assert.match(foot.routingError, /six-section/);
});

test('multi-destination markers inside sections are refused, not guessed', t => {
  const { A } = app(t);
  A.store.createBranch('Ozireth', 'ai', '');
  A.store.createBranch('Sorrel', 'ai', '');
  const verdict = A.actions._test.resolveRoute('Ozireth and Sorrel');
  assert.equal(verdict.dest, null);
  assert.equal(verdict.reason, 'multi');
  const ok = A.actions._test.resolveRoute('Ozireth');
  assert.equal(ok.reason, 'ok');
});

test('an empty trailing route cannot collapse public and private sections into one branch', async t => {
  const { A } = app(t);
  const alice = A.store.createBranch('Alice', 'human', '');
  const bob = A.store.createBranch('Bob', 'human', '');
  for (const origin of ['main', alice]) {
    A.api.chatFull = async () => ({ message: { content:
      '[[route: main]]\nPUBLIC\n[[route: Alice]]\nPRIVATE\n[[route: main]]\n[[next: pause 100]]' } });
    await A.actions.gmReply(origin);
  }
  const replies = A.store.allMessages().filter(m => m.role === 'gm');
  assert.equal(replies.length, 4);
  assert.equal(replies.filter(m => m.origin === 'main').every(m => m.content === 'PUBLIC'), true);
  assert.equal(replies.filter(m => m.origin === alice).every(m => m.content === 'PRIVATE'), true);
  assert.ok(!A.store.characterContextMessages(bob).some(m => m.content.includes('PRIVATE')));
});

test('ambiguous trailing footers and overflowing sections deliver nothing and stop the chain', async t => {
  const { A, w } = app(t);
  A.store.createBranch('Alice', 'ai', '');
  A.store.get().settings.autoTurns = true;
  A.actions.generateCharacter = () => assert.fail('invalid reply must pause');
  const replies = [
    'PUBLIC\n[[route: main]]\nPRIVATE\n[[route: Alice]]',
    'PRIVATE\n[[route: main]]\n[[route: Alice]]',
    Array.from({ length: 7 }, (_, i) => '[[route: main]]\nPart ' + i).join('\n')
  ];
  for (const content of replies) {
    A.api.chatFull = async () => ({ message: { content: content + '\n[[next: Alice 100]]' } });
    await A.actions.gmReply('main');
    assert.equal(A.store.allMessages().length, 0);
    assert.equal(w.document.body.classList.contains('busy'), false);
  }
});

test('regeneration handles an empty trailing header without importing another destination', async t => {
  const { A } = app(t);
  A.store.createBranch('Alice', 'human', '');
  const m = A.store.addMessage({ role: 'gm', origin: 'main', content: 'Original' });
  A.api.chatFull = async () => ({ message: { content:
    '[[route: main]]\nPUBLIC\n[[route: Alice]]\nPRIVATE\n[[route: main]]' } });
  await A.actions.regenerateMessage(m.id);
  assert.equal(m.content, 'PUBLIC');
  A.api.chatFull = async () => ({ message: { content: 'Unclear\n[[route: main]]\nPrivate\n[[route: Alice]]' } });
  await A.actions.regenerateMessage(m.id);
  assert.equal(m.content, 'PUBLIC');
  assert.equal(m.swipes.length, 2);
});

test('dropped GM replies remain visible to the operator but excluded from all model contexts, including after reload', async t => {
  const { A } = app(t);
  const alice = A.store.createBranch('Alice', 'ai', '');
  const bob = A.store.createBranch('Bob', 'ai', '');
  A.store.get().settings.autoTurns = true;
  A.actions.generateCharacter = () => assert.fail('partial reply must pause');
  for (const origin of ['main', alice]) {
    A.api.chatFull = async () => ({ dropped: true, message: { content: 'PRIVATE UNFINISHED\n[[next: Alice 100]]' } });
    await A.actions.gmReply(origin);
  }
  A.store.applySession(A.store.serializeSession());
  const drafts = A.store.viewMessages('main');
  assert.equal(drafts.length, 2);
  assert.ok(drafts.every(m => m.role === 'note' && m.stopped && m.content.includes('PRIVATE UNFINISHED')));
  for (const id of [alice, bob]) {
    assert.equal(A.store.characterContextMessages(id).length, 0);
    assert.ok(!A.prompts.characterApiMessages(A.store.get(), id).some(m => m.content.includes('PRIVATE UNFINISHED')));
  }
  assert.ok(!A.prompts.gmApiMessages(A.store.get(), { origin: 'main' }).some(m => m.content.includes('PRIVATE UNFINISHED')));
});

test('GM brevity and content-based routing instructions follow the book and accompany every turn', t => {
  const { A } = app(t);
  const alice = A.store.createBranch('Alice', 'human', '');
  const st = A.store.get();
  st.rulebook = 'RULEBOOK_SENTINEL';
  const prompt = A.prompts.gmSystem(st);
  assert.ok(prompt.lastIndexOf('Aim for 1-3 short prose paragraphs') > prompt.indexOf('RULEBOOK_SENTINEL'));
  assert.match(prompt, /across the entire reply/);
  assert.match(prompt, /Succinctness is valued/);
  assert.match(prompt, /preference, not a hard limit/);
  assert.match(prompt, /Necessary tag\/dice\/result lines/);
  assert.match(prompt, /requesting branch is context, NOT the destination/);
  assert.match(prompt, /Private sections must be table talk; main sections may narrate/);
  assert.doesNotMatch(prompt, /talk more than|full rich narration|heavy description|exactly TWO footers|TWO short prose paragraphs MAXIMUM/);
  for (const opts of [{ origin: 'main' }, { origin: alice }, { origin: alice, via: 'chain' }]) {
    const messages = A.prompts.gmApiMessages(st, opts);
    assert.match(messages.at(-1).content, /Aim for 1-3 short prose paragraphs/);
    assert.match(messages.at(-1).content, /main/);
  }
  assert.match(A.prompts.regenerationInstruction(st, 'main'), /Aim for 1-3 short prose paragraphs/);
});
