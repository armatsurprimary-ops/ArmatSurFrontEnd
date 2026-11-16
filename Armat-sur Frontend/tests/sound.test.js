const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, button } = require('./helpers');
const pageFlip = fs.readFileSync(path.join(__dirname, '../assets/audio/page-turn.mp3'));

function soundApp(t) {
  const stats = { starts: 0, buffers: [], contexts: [], fetches: 0 };
  const result = app(t, w => {
    w.AudioContext = class {
      constructor() { this.state = 'suspended'; this.sampleRate = 44100; this.destination = {}; stats.contexts.push(this); }
      resume() { this.state = 'running'; return Promise.resolve(); }
      decodeAudioData(bytes) {
        stats.buffers.push(Buffer.from(bytes));
        return Promise.resolve({ decoded: true });
      }
      createBufferSource() {
        return { connect() {}, disconnect() {}, stop() {}, start() { stats.starts++; } };
      }
    };
  });
  result.w.fetch = async url => {
    if (url === '/log') return new Response(null, { status: 204 });
    assert.equal(url, 'assets/audio/page-turn.mp3');
    stats.fetches++;
    return new Response(pageFlip);
  };
  return { ...result, stats };
}

test('supplied MP3 is loaded once, decoded unchanged and independent of game randomness', async t => {
  const { A, w, stats } = soundApp(t);
  w.Math.random = () => assert.fail('sound must not consume the game RNG');
  assert.equal(A.sound.playerTurn(), false, 'no sound before audio unlock');
  assert.equal(await A.sound.preview(), true);
  assert.equal(stats.starts, 1);
  assert.deepEqual(stats.buffers[0], pageFlip);
  assert.equal(A.sound.playerTurn(), true);
  assert.equal(stats.buffers.length, 1);
  assert.equal(stats.contexts.length, 1);
  assert.equal(await A.sound.preview(), true);
  assert.equal(stats.fetches, 1);
  assert.equal(stats.buffers.length, 1);
});

test('loading does not queue handoff sounds and simultaneous preparations share one fetch', async t => {
  const { A, w, stats } = soundApp(t);
  let release;
  w.fetch = async () => { stats.fetches++; return new Promise(resolve => { release = resolve; }); };
  const preview = A.sound.preview();
  const anotherPreview = A.sound.preview();
  assert.equal(A.sound.playerTurn(), false);
  assert.equal(stats.starts, 0);
  assert.equal(stats.fetches, 1);
  release(new Response(pageFlip));
  assert.equal(await preview, true);
  assert.equal(await anotherPreview, true);
  assert.equal(stats.starts, 2, 'only the two explicit previews play');
  assert.equal(stats.buffers.length, 1);
});

test('asset and decoding failures are harmless and can be retried', async t => {
  const { A, w, stats } = soundApp(t);
  const fetchAsset = w.fetch;
  w.fetch = async () => new Response(null, { status: 404 });
  assert.equal(await A.sound.preview(), false);
  assert.equal(A.sound.playerTurn(), false);
  w.fetch = fetchAsset;
  const ctx = stats.contexts[0], decode = ctx.decodeAudioData;
  ctx.decodeAudioData = () => Promise.reject(new Error('Unsupported audio'));
  assert.equal(await A.sound.preview(), false);
  assert.equal(stats.starts, 0);
  ctx.decodeAudioData = decode;
  assert.equal(await A.sound.preview(), true);
  assert.equal(stats.starts, 1);
});

test('muting suppresses handoffs while explicit preview remains available', async t => {
  const { A, stats } = soundApp(t);
  await A.sound.preview();
  A.store.get().settings.playerTurnSound = false;
  assert.equal(A.sound.playerTurn(), false);
  assert.equal(stats.starts, 1);
  assert.equal(await A.sound.preview(), true);
  assert.equal(A.store.get().settings.playerTurnSound, false);
});

test('blocked, unsupported or failing audio is harmless and never queues stale cues', async t => {
  const { A, stats } = soundApp(t);
  await A.sound.preview();
  const ctx = stats.contexts[0];
  ctx.state = 'suspended';
  ctx.resume = () => Promise.reject(new Error('Autoplay blocked'));
  assert.equal(A.sound.playerTurn(), false);
  assert.equal(await A.sound.preview(), false);
  ctx.state = 'running';
  assert.equal(stats.starts, 1, 'resuming must not replay the missed notification');
  ctx.createBufferSource = () => { throw new Error('Audio device unavailable'); };
  assert.equal(A.sound.playerTurn(), false);
  const unsupported = app(t).A;
  assert.equal(await unsupported.sound.preview(), false);
  assert.equal(unsupported.sound.playerTurn(), false);
});

test('only auto-chain human, pause and cap handoffs play a cue; renders and stops do not', async t => {
  const { A, stats } = soundApp(t);
  await A.sound.preview(); stats.starts = 0;
  const st = A.store.get(); st.settings.autoTurns = true;
  const ai = A.store.createBranch('Alice', 'ai', '');
  A.actions.generateCharacter = bid => assert.equal(bid, ai);
  A.actions.gmReply = () => {};
  A.actions._test.advanceChain('Alice', 'main');
  A.actions._test.advanceChain('GM', 'main');
  assert.equal(stats.starts, 0);
  A.actions._test.advanceChain('user', 'main');
  assert.equal(st.awaiting, 'b_user');
  assert.equal(stats.starts, 1);
  A.ui.renderAll(); A.ui.renderAll(); A.actions.stopGeneration(true);
  assert.equal(stats.starts, 1);
  A.actions._test.advanceChain('pause', 'main');
  assert.equal(stats.starts, 2);
  A.actions._test.advanceChain('unknown', 'main');
  assert.equal(stats.starts, 2);
  st.settings.maxAutoTurns = 0;
  A.actions._test.advanceChain('Alice', 'main');
  assert.equal(stats.starts, 3);
  st.settings.autoTurns = false;
  A.actions._test.advanceChain('user', 'main');
  assert.equal(stats.starts, 3);
});

test('a completed GM turn sounds once when its next table selects the player', async t => {
  const { A, stats } = soundApp(t);
  await A.sound.preview(); stats.starts = 0;
  A.store.get().settings.autoTurns = true;
  A.api.chatFull = async () => ({ message: { content: 'Your move.\n[[route: main]]\n[[next: user 100]]' } });
  await A.actions.gmReply('main');
  assert.equal(stats.starts, 1);
  assert.equal(A.store.get().awaiting, 'b_user');
  A.api.chatFull = async () => ({ message: { content: 'Partial' }, dropped: true });
  await A.actions.gmReply('main');
  assert.equal(stats.starts, 1);
});

test('sound setting defaults on, saves globally, survives reload/session changes, and Cancel discards edits', t => {
  const { A, w } = app(t);
  const labelText = 'Play a page-turn sound when control returns to you';
  const checkbox = () => [...w.document.querySelectorAll('.modal label')]
    .find(label => label.textContent === labelText).querySelector('input');
  assert.equal(A.store.get().settings.playerTurnSound, true);
  A.ui.openSettingsModal(); checkbox().checked = false;
  button(w, 'Cancel').click();
  assert.equal(A.store.get().settings.playerTurnSound, true);
  A.ui.openSettingsModal(); checkbox().checked = false;
  button(w, 'Save').click();
  assert.equal(A.store.get().settings.playerTurnSound, false);
  assert.equal(JSON.parse(w.localStorage.getItem('armatsur-settings-v1')).settings.playerTurnSound, false);
  assert.doesNotMatch(A.store.serializeSession(), /playerTurnSound/);
  A.store.newSession();
  assert.equal(A.store.get().settings.playerTurnSound, false);
  w.eval(fs.readFileSync(path.join(__dirname, '../js/store.js'), 'utf8'));
  assert.equal(w.App.store.get().settings.playerTurnSound, false);
});
