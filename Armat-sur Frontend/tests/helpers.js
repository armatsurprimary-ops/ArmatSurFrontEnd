const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const root = path.join(__dirname, '..');

// Load the real app in an isolated DOM with browser-local storage. No requests
// to OpenRouter, user saves, or production localStorage are made by these tests.
function app(t, setup, options) {
  const dom = new JSDOM(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), {
    url: 'http://localhost:8000/', runScripts: 'outside-only'
  });
  t.after(() => dom.window.close());
  const w = dom.window;
  if (setup) setup(w);
  // Most tests exercise an existing empty session. Welcome tests explicitly use
  // a first-run browser; do not alter saved or legacy fixtures supplied by setup.
  if (!(options && options.fresh) && !w.localStorage.getItem('armatsur-session-v1') &&
      !w.localStorage.getItem('armatsur-state-v1')) {
    w.localStorage.setItem('armatsur-session-v1', JSON.stringify({ messages: {} }));
  }
  w.TextDecoder = TextDecoder;
  w.AbortController = AbortController;
  w.fetch = async url => {
    if (url === '/log') return new Response(null, { status: 204 });
    throw new Error('Unexpected request in test: ' + url);
  };
  const listen = w.document.addEventListener.bind(w.document);
  w.document.addEventListener = (type, ...args) => {
    if (type !== 'DOMContentLoaded') listen(type, ...args);
  };
  w.document.querySelectorAll('script[src]').forEach(script => {
    w.eval(fs.readFileSync(path.join(root, script.getAttribute('src').split('?')[0]), 'utf8'));
  });
  const A = w.App;
  Object.assign(A.store.get().settings, {
    apiKey: 'test-only', model: 'test/model', autoTurns: false,
    stream: false, autoRetryDrops: 0
  });
  A.ui.renderAll();
  return { A, w, dom };
}

function input(w, element, value, event = 'input') {
  element.value = value;
  element.dispatchEvent(new w.Event(event, { bubbles: true }));
}
function button(w, text) {
  const found = [...w.document.querySelectorAll('button')].find(b => b.textContent === text);
  if (!found) throw new Error('Missing button: ' + text);
  return found;
}
async function tick() { await new Promise(resolve => setImmediate(resolve)); }

module.exports = { app, input, button, tick };
