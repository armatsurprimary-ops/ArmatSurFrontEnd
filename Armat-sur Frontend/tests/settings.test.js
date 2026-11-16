const test = require('node:test');
const assert = require('node:assert/strict');
const { app, input, button, tick } = require('./helpers');

function field(w, label) {
  const found = [...w.document.querySelectorAll('.field > label')]
    .find(e => e.textContent === label || e.textContent.startsWith(label));
  assert.ok(found, 'Missing field: ' + label);
  return found.parentElement;
}

test('filtering and refreshing models preserve selection; character override can be cleared', async t => {
  const { A, w } = app(t);
  Object.assign(A.store.get().settings, { model: 'old/model', charModel: 'char/old' });
  A.api.listModels = async () => [
    { id: 'old/model', name: 'Old model', context: 100000 },
    { id: 'new/model', name: 'New model', context: 200000 }
  ];
  A.ui.openSettingsModal();
  button(w, 'Fetch model list / test connection').click();
  await tick();
  const gm = field(w, 'GM model');
  input(w, gm.querySelector('select'), 'new/model', 'change');
  input(w, gm.querySelector('input'), 'Old');
  button(w, 'Fetch model list / test connection').click();
  await tick();
  input(w, field(w, 'Character model').querySelector('select'), '', 'change');
  button(w, 'Save').click();
  assert.equal(A.store.get().settings.model, 'new/model');
  assert.equal(A.store.get().settings.charModel, '');
  assert.equal(A.store.get().settings.modelContext, 200000);
});

test('zero temperature and zero auto-turn cap survive save/reopen', t => {
  const { A, w } = app(t);
  A.ui.openSettingsModal();
  input(w, field(w, 'Temperature').querySelector('input'), '0');
  input(w, field(w, 'Max consecutive AI turns').querySelector('input'), '0');
  button(w, 'Save').click();
  assert.equal(A.store.get().settings.temperature, 0);
  assert.equal(A.store.get().settings.maxAutoTurns, 0);
  A.ui.openSettingsModal();
  assert.equal(field(w, 'Max consecutive AI turns').querySelector('input').value, '0');
});

test('switching to an unknown manual model clears the old context limit', t => {
  const { A, w } = app(t);
  A.store.get().settings.modelContext = 32000;
  A.ui.openSettingsModal();
  const manual = field(w, 'GM model').querySelectorAll('input')[1];
  input(w, manual, 'new/unknown-model');
  button(w, 'Save').click();
  assert.equal(A.store.get().settings.model, 'new/unknown-model');
  assert.equal(A.store.get().settings.modelContext, 0);
});

test('provider lookup keeps order/pin inputs alive, preserves drafts, and deduplicates clicks', async t => {
  const { A, w } = app(t);
  A.api.listEndpoints = async () => [
    { provider_name: 'Provider A' }, { provider_name: 'Provider B' }
  ];
  A.ui.openSettingsModal();
  const mode = w.document.querySelector('.prov-block select');
  input(w, mode, 'order', 'change');
  input(w, w.document.getElementById('provOrder'), 'Provider A');
  button(w, 'List providers for GM model').click();
  await tick();
  button(w, 'Provider B').click();
  button(w, 'Provider B').click();
  assert.equal(w.document.getElementById('provOrder').value, 'Provider A, Provider B');
  input(w, mode, 'pin', 'change');
  button(w, 'Provider A').click();
  input(w, mode, 'order', 'change');
  button(w, 'Save').click();
  assert.equal(A.store.get().settings.providerOrder, 'Provider A, Provider B');
  assert.equal(A.store.get().settings.providerPin, 'Provider A');
});
