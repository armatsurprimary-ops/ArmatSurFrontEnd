const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { IDBFactory } = require('fake-indexeddb');
const { app, button, tick } = require('./helpers');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64');
const url = 'data:image/png;base64,' + png.toString('base64');
function referenceApp(t) {
  return app(t, w => {
    w.indexedDB = new IDBFactory();
    // jsdom has no raster decoder; exercise real FileReader and IndexedDB,
    // with only the browser's image decoding boundary substituted.
    w.Image = class {
      constructor() { this.naturalWidth = 1; this.naturalHeight = 1; }
      set src(value) { queueMicrotask(() => this.onload()); }
    };
  });
}
const file = (w, name = 'page.png') => new w.File([png], name, { type: 'image/png' });
const base = { model: 'test/model', messages: [{ role: 'system', content: 'Rules' }, { role: 'user', content: 'Play' }], maxTokens: 50, audience: 'gm', originBranchId: 'main' };
const response = () => ({ message: { content: 'Done.\n[[route: main]]\n[[next: pause 100]]' } });
async function until(fn) {
  for (let i = 0; i < 100; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 5)); }
  assert.fail('Timed out waiting for UI update');
}

test('references persist with order and inclusion, survive new sessions, and stay out of exports', async t => {
  const { A, w } = referenceApp(t);
  const a = await A.attachments.importFile(file(w, 'page-1.png'));
  const b = await A.attachments.importFile(file(w, 'page-2.png'));
  await A.attachments.move(b.id, -1);
  await A.attachments.update(a.id, { enabled: false });
  w.eval(fs.readFileSync(path.join(__dirname, '../js/attachments.js'), 'utf8'));
  await Promise.all([A.attachments.ready(), A.attachments.ready()]);
  assert.equal(A.attachments.list()[0].id, b.id);
  assert.equal(A.attachments.list()[1].enabled, false);
  const msg = await A.attachments.message({ images: true });
  assert.equal(msg.content.filter(p => p.type === 'image_url').length, 1);
  assert.equal(msg.content[1].text, 'Reference 1: page-2.png');
  assert.equal(msg.content[2].image_url.url, url);
  A.store.newSession();
  assert.equal(A.attachments.list().length, 2);
  assert.doesNotMatch(A.store.serializeSession(), /page-2|data:image/);
  assert.doesNotMatch(w.localStorage.getItem('armatsur-settings-v1'), /page-2|data:image/);
  await A.attachments.remove(b.id);
  assert.equal(A.attachments.list().length, 1);
  await assert.rejects(A.attachments.imageData(b.id), /missing or invalid/);
  assert.equal(await A.attachments.message({ images: false }), null);
});

test('unsupported, oversized, spoofed and undecodable files are rejected without changing the library', async t => {
  const { A, w } = referenceApp(t);
  await assert.rejects(A.attachments.importFile(new w.File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' })), /PNG, JPEG or WebP/);
  await assert.rejects(A.attachments.importFile({ type: 'image/png', size: 21 * 1024 * 1024 }), /20 MiB/);
  await assert.rejects(A.attachments.importFile(new w.File(['not an image'], 'x.png', { type: 'image/png' })), /contents do not match/);
  w.Image = class { set src(v) { queueMicrotask(() => this.onerror()); } };
  await assert.rejects(A.attachments.importFile(file(w)), /could not be decoded/);
  assert.equal(A.attachments.list().length, 0);
});

test('GM, characters and regeneration receive references without modifying saved conversations', async t => {
  const { A, w } = referenceApp(t);
  A.store.get().settings.autoGmReply = false;
  await A.attachments.importFile(file(w));
  const sent = [];
  A.api.chatFull = async opts => { sent.push(opts); return response(); };
  await A.actions.gmReply('main');
  const gm = A.store.allMessages().find(m => m.role === 'gm');
  const charId = A.store.createBranch('Alice', 'ai', '');
  // A character override with unknown capabilities must not inherit a GM's
  // text-only flag.
  Object.assign(A.store.get().settings, { charModel: 'unknown/vision', charSupports: null, modelSupports: { images: false } });
  await A.actions.generateCharacter(charId);
  A.store.get().settings.modelSupports = { images: true };
  await A.actions.regenerateMessage(gm.id);
  assert.equal(sent.length, 3);
  for (const request of sent) {
    assert.equal(request.messages[0].role, 'system');
    const images = request.messages.filter(m => Array.isArray(m.content));
    assert.equal(images.length, 1);
    assert.equal(images[0].content[2].image_url.url, url);
  }
  assert.equal(sent[2].tools, undefined);
  assert.doesNotMatch(A.store.serializeSession(), /data:image/);
});

test('text-only models fail before sending; global disable sends ordinary text', async t => {
  const { A, w } = referenceApp(t);
  await A.attachments.importFile(file(w));
  let count = 0;
  A.api.chatFull = async opts => { count++; assert.ok(opts.messages.every(m => typeof m.content === 'string')); return response(); };
  await assert.rejects(A.actions._test.chatWithTools({ ...base, supports: { images: false } }), /does not support image input/);
  assert.equal(count, 0);
  A.store.get().settings.sendAttachments = false;
  await A.actions._test.chatWithTools({ ...base, supports: { images: false } });
  assert.equal(count, 1);
});

test('stop cancels requests while reference storage is still loading', async t => {
  const { A } = app(t);
  let release, count = 0;
  A.attachments.message = () => new Promise(r => { release = r; });
  A.api.chatFull = async () => { count++; return response(); };
  const pending = A.actions._test.chatWithTools(base);
  A.actions.stopGeneration(true);
  release(null);
  assert.equal((await pending).cancelled, true);
  assert.equal(count, 0);
});

test('provider fallback keeps reference images once, and text estimates ignore base64', async t => {
  const { A, w } = referenceApp(t);
  await A.attachments.importFile(file(w));
  let calls = 0;
  A.api.chatFull = async opts => {
    assert.equal(opts.messages.filter(m => Array.isArray(m.content)).length, 1);
    if (++calls === 1) throw new Error('OpenRouter 400: reasoning parameter not supported by this model');
    return response();
  };
  await A.actions._test.chatWithTools(base);
  assert.equal(calls, 2);
  assert.equal(base.messages.length, 2);
  assert.equal(A.prompts.estTokens([{ type: 'text', text: '12345678' }, { type: 'image_url', image_url: { url } }]), 2);
});

test('image estimates use dimensions and enabled metadata without reading image bytes', async t => {
  const { A, w } = referenceApp(t);
  assert.equal(A.attachments.estimateTokens().imageTokens, 0);
  const tiny = await A.attachments.importFile(file(w, 'tiny.png'));
  w.Image = class {
    constructor() { this.naturalWidth = 1024; this.naturalHeight = 1024; }
    set src(value) { queueMicrotask(() => this.onload()); }
  };
  await A.attachments.importFile(file(w, 'square.png'));
  w.Image = class {
    constructor() { this.naturalWidth = 4096; this.naturalHeight = 2048; }
    set src(value) { queueMicrotask(() => this.onload()); }
  };
  await A.attachments.importFile(file(w, 'large.png'));
  const message = await A.attachments.message(null);
  let estimate = A.attachments.estimateTokens();
  assert.equal(estimate.count, 3);
  assert.equal(estimate.imageTokens, 256 + 1024 + 2048);
  assert.equal(estimate.textTokens, A.prompts.estTokens(message.content));
  await A.attachments.update(tiny.id, { enabled: false });
  // Estimation needs neither IndexedDB access nor image decoding after metadata loads.
  w.Image = class { constructor() { assert.fail('must not decode for estimation'); } };
  A.attachments.imageData = () => assert.fail('must not fetch image bytes for estimation');
  estimate = A.attachments.estimateTokens();
  assert.equal(estimate.count, 2);
  assert.equal(estimate.imageTokens, 3072);
});

test('reference projections include image and label tokens, toggle cleanly and never alter Total', async t => {
  const { A, w } = referenceApp(t);
  const item = await A.attachments.importFile(file(w));
  const s = A.store.get().settings;
  Object.assign(s, { modelPricing: { prompt: 0.001, completion: 0.002 }, maxTokens: 100, maxAutoTurns: 2 });
  A.store.addSessionCost(0.42);
  s.sendAttachments = false;
  A.ui.renderTopbar();
  const req = w.document.querySelector('#reqMaxCost'), chain = w.document.querySelector('#chainMaxCost');
  const textOnly = req.textContent;
  const textTokens = A.prompts.gmApiMessages(A.store.get(), { origin: 'main' })
    .reduce((n, m) => n + A.prompts.estTokens(m.content || ''), 0);
  const labelTokens = A.prompts.estTokens((await A.attachments.message(null)).content);
  const expected = (textTokens + labelTokens + 256) * 0.001 + 100 * 0.002;
  s.sendAttachments = true;
  A.ui.renderTopbar();
  assert.equal(req.textContent, 'Req ~$' + expected.toFixed(2));
  assert.equal(chain.textContent, 'Chain ~$' + (expected * 3).toFixed(2));
  assert.match(req.title, /256 image tokens/);
  assert.match(chain.title, /Not a spending cap/);
  assert.equal(w.document.querySelector('#sessionSpend').textContent, 'Total $0.42');
  s.modelPricing = { prompt: 0, completion: 0 };
  A.ui.renderTopbar();
  assert.equal(req.textContent, 'Req ~$0.00');
  for (const pricing of [null, { prompt: NaN, completion: 1 }, { prompt: -1, completion: 1 }]) {
    s.modelPricing = pricing;
    A.ui.renderTopbar();
    assert.equal(req.textContent, 'Req $?');
    assert.equal(chain.textContent, 'Chain $?');
  }
  s.modelPricing = { prompt: 0.001, completion: 0.002 };
  await A.attachments.update(item.id, { enabled: false });
  A.ui.renderTopbar();
  assert.equal(req.textContent, textOnly);
  assert.doesNotMatch(req.title, /image tokens/);
  assert.equal(A.store.get().sessionSpend, 0.42);
});

test('multimodal Total uses reported charges or reported usage, never the image heuristic', async t => {
  const { A, w } = referenceApp(t);
  await A.attachments.importFile(file(w));
  A.attachments.estimateTokens = () => ({ count: 1, imageTokens: 999999, textTokens: 100 });
  const s = A.store.get().settings;
  Object.assign(s, { modelPricing: { prompt: 0.001, completion: 0.002 }, modelSupports: { images: true } });
  let usage = { prompt_tokens: 50, completion_tokens: 5, cost: 0.125 };
  w.fetch = async (target, opts) => {
    if (target === '/log') return new Response(null, { status: 204 });
    assert.ok(JSON.parse(opts.body).messages.some(m => Array.isArray(m.content)));
    return new Response(JSON.stringify({ choices: [response()], usage }));
  };
  await A.actions.gmReply('main');
  assert.equal(A.store.get().sessionSpend, 0.125);
  usage = { prompt_tokens: 50, completion_tokens: 5 };
  await A.actions.gmReply('main');
  assert.ok(Math.abs(A.store.get().sessionSpend - 0.185) < 1e-9);
});

test('transport sends images to OpenRouter but redacts them from local traffic logs', async t => {
  const { A, w } = referenceApp(t);
  await A.attachments.importFile(file(w));
  const messages = [await A.attachments.message(null)], logs = [];
  let payload;
  w.fetch = async (target, opts) => {
    const body = JSON.parse(opts.body);
    if (target === '/log') { logs.push(body); return new Response(null, { status: 204 }); }
    payload = body;
    return new Response(JSON.stringify({ choices: [response()] }));
  };
  await A.api.chatFull({ model: 'x', messages });
  assert.equal(payload.messages[0].content[2].image_url.url, url);
  assert.equal(messages[0].content[2].image_url.url, url);
  assert.doesNotMatch(JSON.stringify(logs), /data:image|iVBORw/);
  assert.match(JSON.stringify(logs), /reference image omitted/);
});

test('model catalog distinguishes image, text-only and unknown capabilities', async t => {
  const { A, w } = app(t);
  w.fetch = async () => new Response(JSON.stringify({ data: [
    { id: 'a', architecture: { input_modalities: ['text', 'image'] } },
    { id: 'b', architecture: { input_modalities: ['text'] } }, { id: 'c' }
  ] }));
  const models = await A.api.listModels('test');
  assert.equal(models[0].supports.images, true);
  assert.equal(models[1].supports.images, false);
  assert.equal(models[2].supports, null);
});

test('settings imports multiple images, safely displays names, reorders, previews and disables them', async t => {
  const { A, w } = referenceApp(t);
  A.ui.openSettingsModal();
  await A.attachments.ready(); await tick();
  const picker = w.document.querySelector('input[type="file"][multiple]');
  Object.defineProperty(picker, 'files', { value: [file(w, '<img src=x>.png'), file(w, 'second.png')] });
  picker.dispatchEvent(new w.Event('change'));
  await until(() => w.document.querySelectorAll('.reference-item').length === 2);
  assert.equal(w.document.querySelectorAll('.reference-item img').length, 0);
  assert.match(w.document.querySelector('.reference-name').textContent, /<img src=x>/);
  button(w, '↓').click();
  await until(() => w.document.querySelector('.reference-name').textContent.includes('second.png'));
  button(w, 'Preview').click();
  await until(() => w.document.querySelector('.reference-preview'));
  assert.equal(w.document.querySelector('.reference-preview').src, url);
  const include = w.document.querySelector('.reference-item input');
  include.checked = false; include.dispatchEvent(new w.Event('change'));
  await until(() => !A.attachments.list()[0].enabled);
  const send = [...w.document.querySelectorAll('label')].find(e => e.textContent.includes('Send enabled reference')).querySelector('input');
  send.checked = false;
  button(w, 'Save').click();
  assert.equal(A.store.get().settings.sendAttachments, false);
  A.ui.openSettingsModal(); await tick();
  button(w, 'Remove').click();
  await until(() => A.attachments.list().length === 1);
});
