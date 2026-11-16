const test = require('node:test');
const assert = require('node:assert/strict');
const { app, input, button, tick } = require('./helpers');
function field(w, label) {
  return [...w.document.querySelectorAll('.field > label')].find(e => e.textContent.startsWith(label)).parentElement;
}
function service(w, value) { input(w, field(w, 'API service').querySelector('select'), value, 'change'); }
function manual(w, label, value) { input(w, field(w, label).querySelectorAll('input')[1], value); }

test('services isolate credentials, model metadata and drafts, and survive reload', async t => {
  const { A, w } = app(t);
  A.store.addSessionCost(1.25);
  Object.assign(A.store.get().settings, { apiKey: 'router-key', model: 'shared-id', modelContext: 99000,
    modelPricing: { prompt: 1, completion: 2 }, modelSupports: { images: true }, providerPin: 'upstream' });
  A.ui.openSettingsModal();
  service(w, 'abliteration');
  assert.equal(field(w, 'Abliteration.ai API key').querySelector('input').value, '');
  assert.equal(w.document.querySelector('.prov-block').hidden, true);
  input(w, field(w, 'Abliteration.ai API key').querySelector('input'), 'ablit-key');
  manual(w, 'GM model', 'shared-id');
  service(w, 'openrouter');
  assert.equal(field(w, 'OpenRouter API key').querySelector('input').value, 'router-key');
  assert.equal(w.document.querySelector('.prov-block').hidden, false);
  service(w, 'abliteration');
  assert.equal(field(w, 'Abliteration.ai API key').querySelector('input').value, 'ablit-key');
  button(w, 'Save').click();
  assert.equal(A.store.get().sessionSpend, 1.25);
  assert.equal(w.document.querySelector('#sessionSpend').textContent, 'Total $1.25');
  const s = A.store.get().settings;
  assert.equal(s.apiService, 'abliteration'); assert.equal(s.model, 'shared-id');
  assert.equal(s.modelContext, 0); assert.equal(s.modelPricing, null); assert.equal(s.modelSupports, null);
  assert.equal(s.serviceProfiles.openrouter.modelContext, 99000);
  const saved = w.localStorage.getItem('armatsur-settings-v1');
  const reloaded = app(t, win => win.localStorage.setItem('armatsur-settings-v1', saved));
  assert.equal(reloaded.A.store.get().settings.apiService, 'abliteration');
  assert.equal(reloaded.A.store.get().settings.serviceProfiles.openrouter.apiKey, 'router-key');
  assert.ok(!A.store.serializeSession().includes('ablit-key'));
  assert.ok(!A.store.serializeSession().includes('router-key'));
  A.ui.openSettingsModal(); service(w, 'openrouter'); button(w, 'Save').click();
  assert.equal(s.apiKey, 'router-key'); assert.equal(s.modelContext, 99000);
});

test('cancel does not change active provider; stale model requests do not cross services', async t => {
  const { A, w } = app(t); let release;
  A.api.listModels = () => new Promise(r => { release = r; });
  A.ui.openSettingsModal(); button(w, 'Fetch model list / test connection').click();
  service(w, 'abliteration');
  release([{ id: 'router-only', name: 'Router', context: 42 }]); await tick();
  assert.ok(!field(w, 'GM model').textContent.includes('router-only'));
  button(w, 'Cancel').click(); assert.equal(A.store.get().settings.apiService, 'openrouter');
});

test('Abliteration requests preserve multimodal messages and tools but omit OpenRouter routing headers', async t => {
  const { A, w } = app(t); const requests = [];
  w.fetch = async (url, opts) => {
    if (url === '/log') return new Response(null, { status: 204 });
    requests.push({ url, opts });
    if (url.endsWith('/models')) return new Response(JSON.stringify({data:[{id:'abliterated-model'}]}));
    return new Response(JSON.stringify({ choices:[{message:{role:'assistant',content:'Ready',reasoning_content:'Thought'}}] }));
  };
  const models = await A.api.listModels('ablit-key', 'abliteration');
  assert.equal(requests[0].url, '/api/abliteration/models');
  assert.equal(models[0].context, 0); assert.equal(models[0].pricing, null); assert.equal(models[0].supports, null);
  const messages = [{role:'system',content:'Rulebook'}, {role:'user',content:[
    {type:'text',text:'Reference'}, {type:'image_url',image_url:{url:'data:image/png;base64,AAAA'}}]}];
  const tools = [{type:'function',function:{name:'roll',parameters:{type:'object'}}}];
  const result = await A.api.chatFull({apiService:'abliteration',apiKey:'ablit-key',model:'abliterated-model',
    messages, tools, reasoning:'medium', provider:{only:['router-only']}});
  const r = requests[1], body = JSON.parse(r.opts.body);
  assert.equal(r.url, '/api/abliteration/chat/completions');
  assert.equal(r.opts.headers.Authorization, 'Bearer ablit-key');
  assert.equal(r.opts.headers['X-ArmatSur-Request'], '1');
  assert.equal(r.opts.headers['HTTP-Referer'], undefined); assert.equal(r.opts.headers['X-Title'], undefined);
  assert.equal(body.provider, undefined); assert.deepEqual(body.messages, messages); assert.deepEqual(body.tools, tools);
  assert.equal(body.reasoning.effort, 'medium'); assert.equal(result.reasoning, 'Thought');
  await assert.rejects(A.api.chatFull({apiService:'unknown',messages:[]}), /Unknown API service/);
  assert.equal(requests.length, 2);
});

test('Abliteration streaming supports fragmented tools, reasoning aliases, usage and abort signals', async t => {
  const { A, w } = app(t); const ctrl = new AbortController();
  w.fetch = async (url, opts) => {
    if (url === '/log') return new Response(null, {status:204});
    assert.equal(opts.signal, ctrl.signal);
    return new Response('data: {"choices":[{"delta":{"reasoning_content":"Thinking","tool_calls":[{"index":0,"id":"t1","function":{"name":"roll","arguments":"{"}}]}}]}\n\n'+
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]}}],"usage":{"cost":0.25}}\n\n'+
      'data: [DONE]\n\n', {headers:{'Content-Type':'text/event-stream'}});
  };
  const result = await A.api.chatFull({apiService:'abliteration',stream:true,messages:[],signal:ctrl.signal});
  assert.equal(result.reasoning,'Thinking'); assert.equal(result.message.tool_calls[0].function.arguments,'{}');
  assert.equal(result.cost,0.25); assert.equal(result.dropped,false);
});

test('provider errors identify the service and redact echoed credentials', async t => {
  const { A, w } = app(t); const logs=[];
  w.fetch = async (url, opts) => {
    if (url === '/log') { logs.push(opts.body); return new Response(null,{status:204}); }
    return new Response(JSON.stringify({error:{message:'invalid secret-key'}}),{status:401});
  };
  await assert.rejects(A.api.chatFull({apiService:'abliteration',apiKey:'secret-key',messages:[]}), /Abliteration.ai 401: invalid \[redacted\]/);
  assert.ok(!logs.join('').includes('secret-key')); assert.ok(!A.diag.exportText().includes('secret-key'));
});

test('generation snapshots service/key through tools and applies Abliteration fallback', async t => {
  const { A } = app(t); const s=A.store.get().settings; let calls=0;
  Object.assign(s,{apiService:'abliteration',apiKey:'ablit-key'});
  A.api.chatFull=async opts=>{
    calls++; assert.equal(opts.apiService,'abliteration'); assert.equal(opts.apiKey,'ablit-key');
    if(calls===1){s.apiService='openrouter';s.apiKey='router-key';throw new Error('Abliteration.ai 400: tools unsupported');}
    assert.equal(opts.tools,undefined); return {message:{content:'Done'}};
  };
  const out=await A.actions._test.chatWithTools({audience:'gm',model:'test',messages:[]});
  assert.equal(out.content,'Done'); assert.equal(calls,2);
});
