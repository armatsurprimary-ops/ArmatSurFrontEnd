/* Armat-sur session runner — OpenRouter and Abliteration.ai client.
 * Abliteration.ai uses the local server relay because localhost CORS is denied.
 * Supports plain + streaming (SSE) completions, tool calls, reasoning traces,
 * provider routing, and abort via signal. */
window.App = window.App || {};

App.api = (function () {
  const BASE = 'https://openrouter.ai/api/v1';
  function serviceInfo(id) {
    if (!id || id === 'openrouter') return { id: 'openrouter', name: 'OpenRouter' };
    if (id === 'abliteration') return { id: 'abliteration', name: 'Abliteration.ai' };
    throw new Error('Unknown API service. Select a service in Settings.');
  }

  function request(service, path, apiKey, body, signal) {
    const info = serviceInfo(service);
    const headers = { 'Authorization': 'Bearer ' + apiKey };
    const local = info.id === 'abliteration';
    if (local || body) headers['Content-Type'] = 'application/json';
    if (local) headers['X-ArmatSur-Request'] = '1';
    else if (body) {
      headers['HTTP-Referer'] = location.href || 'http://localhost';
      headers['X-Title'] = 'Armat-sur Session Runner';
    }
    return fetch(local ? '/api/abliteration' + path : BASE + path, {
      method: local || body ? 'POST' : 'GET', headers: headers,
      body: local || body ? JSON.stringify(body || {}) : undefined,
      signal: signal || undefined
    });
  }

  async function listModels(apiKey, service) {
    const res = await request(service, '/models', apiKey);
    if (!res.ok) throw await errorFromResponse(res, null, service, apiKey);
    const json = await res.json();
    return (json.data || [])
      .map(function (m) {
        const modalities = m.architecture && m.architecture.input_modalities;
        const supports = Array.isArray(m.supported_parameters) ? {
          tools: m.supported_parameters.indexOf('tools') >= 0,
          reasoning: m.supported_parameters.indexOf('reasoning') >= 0 || m.supported_parameters.indexOf('include_reasoning') >= 0
        } : null;
        const capabilities = Array.isArray(modalities) ? Object.assign({}, supports, { images: modalities.indexOf('image') >= 0 }) : supports;
        return {
          id: m.id,
          name: m.name || m.id,
          context: m.context_length || 0,
          pricing: m.pricing ? {
            prompt: Math.max(0, parseFloat(m.pricing.prompt) || 0),
            completion: Math.max(0, parseFloat(m.pricing.completion) || 0)
          } : null,
          // declared capabilities (OpenRouter supported_parameters) — used to
          // pre-gate tools/reasoning instead of learning via failed requests
          supports: capabilities
        };
      })
      .sort(function (a, b) { return a.id.localeCompare(b.id); });
  }

  /* All upstream providers serving a given model, with pricing/limits.
   * modelId: 'author/slug' */
  async function listEndpoints(apiKey, modelId) {
    const res = await fetch(BASE + '/models/' + modelId + '/endpoints', {
      headers: { 'Authorization': 'Bearer ' + apiKey }
    });
    if (!res.ok) throw new Error('OpenRouter ' + res.status + ' while listing providers');
    const json = await res.json();
    return (json.data && json.data.endpoints) || [];
  }

  /* Fire-and-forget traffic log to the local server window (serve.py /log).
   * Never includes the API key and never breaks the app if it fails. */
  function logTraffic(payload) {
    try {
      fetch('/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-ArmatSur-Request': '1' },
        body: JSON.stringify(payload)
      }).catch(function () { /* server not logging — fine */ });
    } catch (e) { /* ignore */ }
  }

  /* ---------- shared request plumbing ---------- */

  function buildBody(opts) {
    const body = {
      model: opts.model,
      messages: opts.messages,
      temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.8
    };
    if (opts.maxTokens) body.max_tokens = opts.maxTokens;
    if (opts.reasoning && opts.reasoning !== 'off') {
      body.reasoning = { effort: opts.reasoning };
    }
    if (serviceInfo(opts.apiService).id === 'openrouter' && opts.provider && typeof opts.provider === 'object' && Object.keys(opts.provider).length) {
      body.provider = opts.provider;
    }
    if (opts.tools && opts.tools.length) {
      body.tools = opts.tools;
      body.tool_choice = opts.toolChoice || 'auto';
    }
    if (opts.stream) {
      body.stream = true;
      body.stream_options = { include_usage: true };
    }
    return body;
  }

  function logRequest(body) {
    logTraffic({
      kind: 'request',
      model: body.model,
      provider: body.provider ? JSON.stringify(body.provider) : null,
      tools: (body.tools || []).map(function (t) { return t.function.name; }),
      messages: body.messages.map(function (m) {
        if (!Array.isArray(m.content)) return m;
        return Object.assign({}, m, { content: m.content.map(function (part) {
          return part.type === 'image_url' ? { type: 'text', text: '[reference image omitted from traffic log]' } : part;
        }) });
      })
    });
  }

  function postChat(apiKey, body, signal, service) {
    return request(service, '/chat/completions', apiKey, body, signal);
  }

  async function errorFromResponse(res, model, service, apiKey) {
    const name = serviceInfo(service).name;
    // A response body is single-use: read once so non-JSON errors survive.
    let detail = await res.text();
    try {
      const j = JSON.parse(detail);
      detail = (j.error && (j.error.message || j.error.code)) || detail;
    } catch (e) { /* plain-text error body */ }
    if (apiKey) detail = String(detail).split(apiKey).join('[redacted]');
    logTraffic({ kind: 'error', model: model, error: name + ' ' + res.status + ': ' + (detail || res.statusText) });
    if (App.diag) App.diag.log('error', name + ' ' + res.status + ': ' + String(detail || res.statusText), {
      model: model, status: res.status, detail: String(detail || '').slice(0, 400)
    });
    const error = new Error(name + ' ' + res.status + ': ' + (detail || res.statusText));
    error.status = res.status;
    return error;
  }

  /* ---------- streaming (SSE) ---------- */

  /* Parse an SSE completion stream. Calls onChunk({content?, reasoning?}) with
   * ACCUMULATED text as it arrives. Returns the assembled assistant message. */
  async function parseSSE(res, onChunk, name, apiKey) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    const acc = { role: 'assistant', content: '', reasoning: '', toolCalls: [], usage: null };
    let buf = '';
    let sawDone = false;
    let dataLines = [];
    function handle(data) {
      if (data.trim() === '[DONE]') { sawDone = true; return; }
      let j;
      try { j = JSON.parse(data); }
      catch (e) { throw new Error(name + ' returned malformed stream data.'); }
      if (j.error) {
        let detail = String(j.error.message || JSON.stringify(j.error));
        if (apiKey) detail = detail.split(apiKey).join('[redacted]');
        throw new Error(name + ' ' + (j.error.code || 'stream error') + ': ' + detail);
      }
      if (j.usage) acc.usage = j.usage;
      const ch = j.choices && j.choices[0];
      if (!ch) return;
      const d = ch.delta || {};
      if (d.role) acc.role = d.role;
      if (d.content) {
        acc.content += d.content;
        if (onChunk) onChunk({ content: acc.content });
      }
      if (d.reasoning || d.reasoning_content) {
        acc.reasoning += d.reasoning || d.reasoning_content;
        if (onChunk) onChunk({ reasoning: acc.reasoning });
      }
      (d.tool_calls || []).forEach(function (tc) {
        const i = typeof tc.index === 'number' ? tc.index : 0;
        if (!acc.toolCalls[i]) acc.toolCalls[i] = { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) acc.toolCalls[i].id = tc.id;
        if (tc.function) {
          if (tc.function.name) acc.toolCalls[i].function.name += tc.function.name;
          if (tc.function.arguments) acc.toolCalls[i].function.arguments += tc.function.arguments;
        }
      });
    }
    function dispatch() {
      if (!dataLines.length) return;
      const data = dataLines.join('\n');
      dataLines = [];
      handle(data);
    }
    function line(text) {
      text = text.replace(/\r$/, '');
      if (!text) { dispatch(); return; }
      if (text.indexOf('data:') !== 0) return; // comments, event/id fields
      dataLines.push(text.slice(5).replace(/^ /, ''));
    }
    try {
      while (!sawDone) {
        const r = await reader.read();
        buf += r.done ? dec.decode() : dec.decode(r.value, { stream: true });
        let idx;
        while (!sawDone && (idx = buf.indexOf('\n')) >= 0) {
          line(buf.slice(0, idx));
          buf = buf.slice(idx + 1);
        }
        if (r.done && !sawDone) {
          // Some servers close immediately after the final data line.
          if (buf) line(buf);
          dispatch();
          break;
        }
      }
    } finally {
      // [DONE] terminates the response even if the socket stays open.
      try { await reader.cancel(); } catch (e) { /* already closed/aborted */ }
      reader.releaseLock();
    }
    const msg = { role: acc.role, content: acc.content || null };
    if (acc.reasoning) msg.reasoning = acc.reasoning;
    const calls = acc.toolCalls.filter(Boolean);
    if (calls.length) msg.tool_calls = calls;
    return { message: msg, usage: acc.usage, done: sawDone };
  }

  /* ---------- cost ---------- */

  /* Actual cost when OpenRouter reports one; otherwise estimated from usage
   * tokens x per-token pricing (USD). Null when unknowable. */
  function computeCost(usage, pricing, apiCost) {
    if (typeof apiCost === 'number' && apiCost >= 0) return apiCost;
    if (!usage || !pricing) return null;
    return (usage.prompt_tokens || 0) * pricing.prompt +
      (usage.completion_tokens || 0) * pricing.completion;
  }

  /* ---------- completions ---------- */

  /* opts: { apiKey, model, messages, temperature, maxTokens, provider, reasoning,
   *         tools, toolChoice, stream, onChunk, signal }
   * -> { message (raw; may include tool_calls + reasoning), reasoning, usage }.
   * When opts.stream is truthy, response text is streamed and onChunk receives
   * accumulated {content?} / {reasoning?} updates. Throws on error/abort. */
  async function chatFull(opts) {
    const name = serviceInfo(opts.apiService).name;
    const body = buildBody(opts);
    logRequest(body);

    let res;
    try {
      res = await postChat(opts.apiKey, body, opts.signal, opts.apiService);
    } catch (netErr) {
      logTraffic({ kind: 'error', model: body.model, error: 'network: ' + (netErr && netErr.message) });
      if (App.diag) App.diag.log('error', 'network: ' + String((netErr && netErr.message) || netErr), {
        model: body.model, stack: netErr && netErr.stack ? String(netErr.stack).slice(0, 1500) : undefined
      });
      throw netErr;
    }

    if (!res.ok) throw await errorFromResponse(res, body.model, opts.apiService, opts.apiKey);

    const contentType = res.headers && res.headers.get('content-type') || '';
    if (opts.stream && !contentType.includes('application/json') && res.body && typeof res.body.getReader === 'function') {
      const out = await parseSSE(res, opts.onChunk, name, opts.apiKey);
      const msg = out.message;
      if (!out.done) {
        logTraffic({ kind: 'error', model: body.model, error: 'stream dropped before [DONE] — partial kept (' + ((msg.content || '').length) + ' chars)' });
        if (App.diag) App.diag.log('drop', 'stream dropped before [DONE]', { model: body.model, chars: (msg.content || '').length });
      } else if (!msg.content && !(msg.tool_calls && msg.tool_calls.length)) {
        logTraffic({ kind: 'error', model: body.model, error: name + ' returned an empty completion.' });
        if (App.diag) App.diag.log('error', 'empty completion (all tokens spent on reasoning?)', { model: body.model, maxTokens: body.max_tokens });
        throw new Error(name + ' returned an empty completion.');
      }
      const streamCost = computeCost(out.usage, opts.pricing, out.usage && out.usage.cost);
      logTraffic({ kind: 'response', model: body.model, message: msg, usage: out.usage, cost: streamCost });
      return { message: msg, reasoning: msg.reasoning || null, usage: out.usage, cost: streamCost, dropped: !out.done };
    }

    const json = await res.json();
    if (json.error) {
      let detail = String(json.error.message || JSON.stringify(json.error));
      if (opts.apiKey) detail = detail.split(opts.apiKey).join('[redacted]');
      throw new Error(name + ' ' + (json.error.code || 'error') + ': ' + detail);
    }
    const msg = json.choices && json.choices[0] && json.choices[0].message;
    if (!msg) {
      logTraffic({ kind: 'error', model: body.model, error: name + ' returned no message.' });
      throw new Error(name + ' returned no message.');
    }
    if (!msg.reasoning && msg.reasoning_content) msg.reasoning = msg.reasoning_content;
    const cost = computeCost(json.usage, opts.pricing,
      typeof json.cost === 'number' ? json.cost : (json.usage && json.usage.cost));
    logTraffic({ kind: 'response', model: body.model, message: msg, usage: json.usage || null, cost: cost });
    return { message: msg, reasoning: msg.reasoning || null, usage: json.usage || null, cost: cost };
  }

  /* ---- local session save/load (serve.py endpoints; only over http) ---- */

  async function listSessions() {
    const res = await fetch('/sessions');
    if (!res.ok) throw new Error('server ' + res.status);
    const json = await res.json();
    return json.sessions || [];
  }

  async function saveSession(name, jsonText) {
    const res = await fetch('/save?name=' + encodeURIComponent(name), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ArmatSur-Request': '1' },
      body: jsonText
    });
    if (!res.ok) {
      let detail = 'server ' + res.status;
      try { detail = (await res.json()).error || detail; } catch (e) { /* ignore */ }
      throw new Error(detail);
    }
    return res.json();
  }

  async function loadSession(name) {
    const res = await fetch('/load?name=' + encodeURIComponent(name));
    if (!res.ok) throw new Error('server ' + res.status);
    return res.text();
  }

  async function deleteSession(name) {
    const res = await fetch('/delete?name=' + encodeURIComponent(name), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ArmatSur-Request': '1' },
      body: '{}'
    });
    if (!res.ok) {
      let detail = 'server ' + res.status;
      try { detail = (await res.json()).error || detail; } catch (e) { /* ignore */ }
      throw new Error(detail);
    }
    return res.json();
  }

  return {
    serviceInfo: serviceInfo,
    listModels: listModels,
    listEndpoints: listEndpoints,
    chatFull: chatFull,
    sessions: { list: listSessions, save: saveSession, load: loadSession, delete: deleteSession }
  };
})();
