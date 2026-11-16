const test = require('node:test');
const assert = require('node:assert/strict');
const { app, button, tick } = require('./helpers');

test('saved-session deletion requires confirmation, preserves the active session, and refreshes the list', async t => {
  const { A, w } = app(t);
  const name = 'Campaign & <chapter 2>';
  let saves = [{ name, size: 1024 }], calls = 0, release;
  A.api.sessions.list = async () => saves;
  A.api.sessions.delete = value => {
    calls++;
    assert.equal(value, name);
    return new Promise(resolve => { release = () => { saves = []; resolve({ deleted: name }); }; });
  };
  const before = JSON.stringify(A.store.get());
  const settings = JSON.stringify(A.store.get().settings);
  A.ui.openSessionsModal(); await tick();
  const input = w.document.querySelector('.modal input');
  input.value = 'Unsaved name draft';
  button(w, 'Delete').click();
  assert.equal(calls, 0);
  assert.ok(w.document.querySelector('.modal-body').textContent.includes(name));
  assert.equal(w.document.querySelector('.modal-body chapter'), null);
  assert.equal(w.document.activeElement.textContent, 'Cancel');
  button(w, 'Cancel').click();
  assert.equal(w.document.querySelector('.modal input').value, 'Unsaved name draft');
  assert.equal(calls, 0);
  button(w, 'Delete').click();
  const confirm = button(w, 'Delete');
  confirm.click(); confirm.click();
  assert.equal(calls, 1);
  assert.equal(confirm.disabled, true);
  release(); await tick();
  assert.match(w.document.querySelector('.sess-list').textContent, /No saves yet/);
  assert.equal(JSON.stringify(A.store.get()), before);
  assert.equal(JSON.stringify(A.store.get().settings), settings);
});

test('failed deletion keeps the saved row and allows retry', async t => {
  const { A, w } = app(t);
  A.api.sessions.list = async () => [{ name: 'Keep me', size: 12 }];
  A.api.sessions.delete = async () => { throw new Error('could not delete saved session'); };
  A.ui.openSessionsModal(); await tick();
  button(w, 'Delete').click(); button(w, 'Delete').click(); await tick();
  assert.equal(button(w, 'Delete').disabled, false);
  assert.match(w.document.body.textContent, /Delete failed: could not delete/);
  button(w, 'Cancel').click();
  assert.equal(w.document.querySelector('.sess-name').textContent, 'Keep me');
});

test('delete API uses the protected POST route and surfaces server errors', async t => {
  const { A, w } = app(t);
  w.fetch = async (url, opts) => {
    assert.equal(url, '/delete?name=Two%20%26%20three');
    assert.equal(opts.method, 'POST');
    assert.equal(opts.headers['X-ArmatSur-Request'], '1');
    assert.equal(opts.headers['Content-Type'], 'application/json');
    return new Response(JSON.stringify({ deleted: 'Two & three' }));
  };
  assert.equal((await A.api.sessions.delete('Two & three')).deleted, 'Two & three');
  w.fetch = async () => new Response(JSON.stringify({ error: 'saved session no longer exists' }), { status: 404 });
  await assert.rejects(A.api.sessions.delete('missing'), /no longer exists/);
});
