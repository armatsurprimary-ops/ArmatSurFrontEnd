/* Armat-sur session runner — wiring + actions */
window.App = window.App || {};
App.actions = {};

(function () {

  /* ---------------- helpers ---------------- */

  function settingsGuard() {
    const s = App.store.get().settings;
    if (!s.apiKey) {
      App.ui.toast('Set your ' + App.api.serviceInfo(s.apiService).name + ' API key first (Settings).', 'error');
      App.ui.openSettingsModal();
      return null;
    }
    if (!s.model) {
      App.ui.toast('Pick a model first (Settings).', 'error');
      App.ui.openSettingsModal();
      return null;
    }
    return s;
  }

  function charModel(s) { return s.charModel || s.model; }

  /* Build the OpenRouter provider routing object from settings (empty = default routing). */
  function providerPrefs(s) {
    const prefs = {};
    if (s.providerMode === 'pin' && s.providerPin) prefs.only = [s.providerPin];
    else if (s.providerMode === 'order' && s.providerOrder) {
      prefs.order = s.providerOrder.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
    }
    return prefs;
  }

  /* ---------------- routing + automatic turn order ---------------- */

  /* GM replies use route headers and a final next-speaker footer:
   *   [[route: main]] ... [[next: Alice 50, GM 30, pause 20]]
   * They are stripped from the stored message and drive routing/turn order.
   * The parser tolerates single-bracket variants ([route: ...]) and the
   * common next-table entry formats weaker models produce. */
  const ROUTE_RE = /\[{1,2}\s*route\s*:\s*([^\]]+?)\s*\]{1,2}/i;
  const NEXT_RE = /\[{1,2}\s*next\s*:\s*([^\]]+?)\s*\]{1,2}/i;
  const ROUTE_G = /\[{1,2}\s*route\s*:\s*[^\]]+?\s*\]{1,2}/gi;
  const NEXT_G = /\[{1,2}\s*next\s*:\s*[^\]]+?\s*\]{1,2}/gi;

  function parseFooter(raw) {
    const s = String(raw || '');
    const rm = s.match(ROUTE_RE);
    const nm = s.match(NEXT_RE);
    let clean = s.replace(ROUTE_G, '').replace(NEXT_G, '');
    // strip origin-tag imitations ((public) / (private to X)) at any line start
    clean = clean.replace(/(^|\n)[ \t]*\((?:public|private to [^)]*)\)[ \t]*/gi, '$1');
    // sweep orphan markdown asterisks left where footers were removed
    clean = clean.replace(/\*\*[ \t]*\*\*/g, '');
    clean = clean.replace(/\n[ \t]*\*+[ \t]*(?=\n)/g, '');
    clean = clean.replace(/\n[ \t]*(?:\n[ \t]*){2,}/g, '\n\n').trim();
    return { route: rm ? rm[1].trim() : null, next: nm ? nm[1].trim() : null, clean: clean };
  }

  /* 'main' | exact branch name (case-insensitive) | unique substring — see
   * App.store.resolveBranch for the shared resolver and ambiguity rules. */

  /* One next-table entry, tolerant of the formats models actually produce:
   * "Kaspar Rendle 45", "Kaspar: 45", "Kaspar (45)", "GM - 20",
   * "45 Niyalla", "GM 20%", bare names (weight 1). */
  function parseNextEntry(part) {
    let s = part.trim().replace(/\.$/, '').trim();
    s = s.replace(/^["']+|["']+$/g, '').trim();
    if (!s) return null;
    let m = s.match(/^(.+?)\s*[:\uFF08(]\s*(\d+(?:\.\d+)?)\s*%?\s*[)]?$/);          // "Name: 45" / "Name (45)"
    if (m && m[1].trim()) return { name: m[1].trim(), weight: parseFloat(m[2]) };
    m = s.match(/^(.+?)\s+[-\u2013\u2014]\s+(\d+(?:\.\d+)?)\s*%?$/);              // "Name - 45"
    if (m && m[1].trim()) return { name: m[1].trim(), weight: parseFloat(m[2]) };
    m = s.match(/^(.+?)\s+(\d+(?:\.\d+)?)\s*%?$/);                                // "Name 45"
    if (m && m[1].trim()) return { name: m[1].trim(), weight: parseFloat(m[2]) };
    m = s.match(/^(\d+(?:\.\d+)?)\s*%?\s+(.+)$/);                                  // "45 Name"
    if (m && m[2].trim()) return { name: m[2].trim(), weight: parseFloat(m[1]) };
    return { name: s, weight: 1 };
  }

  /* 'Kaspar Rendle 45, GM 20' -> { entries: [...], dropped: [raw] } */
  function parseNextTable(text) {
    const entries = [];
    const dropped = [];
    String(text || '').split(',').forEach(function (part) {
      if (!part.trim()) return;
      const e = parseNextEntry(part);
      if (e && e.name) entries.push(e); else dropped.push(part.trim());
    });
    return { entries: entries, dropped: dropped };
  }

  /* Weighted pick from the GM's table; returns { entries, roll, total, winner, dropped } */
  function rollTurnOrder(tableText) {
    const parsed = parseNextTable(tableText);
    const entries = parsed.entries;
    if (!entries.length) return null;
    const total = entries.reduce(function (s, e) { return s + (e.weight > 0 ? e.weight : 0); }, 0);
    if (total <= 0) return null;
    const raw = Math.random() * total;
    let acc = raw, winner = null;
    entries.forEach(function (e) {
      if (e.weight <= 0) return;
      if (!winner && acc < e.weight) winner = e.name;
      acc -= e.weight;
    });
    if (!winner) winner = entries[entries.length - 1].name;
    return { entries: entries, roll: raw, total: total, winner: winner, dropped: parsed.dropped };
  }

  const PAUSE_WORDS = ['pause', 'wait', 'stop', 'none', 'player', 'human', 'operator'];
  const GM_WORDS = ['gm', 'narrator', 'you', 'continue', 'me'];

  /* Section headers are canonical; one trailing route remains supported for
   * legacy replies. Never collapse a multi-section reply into one destination
   * merely because the model appended an empty final header. */
  const SECTION_CAP = 6;

  function parseTurnFooter(raw) {
    const s0 = String(raw || '');
    const nm = s0.match(NEXT_RE);
    let s = s0.replace(NEXT_G, '');
    // same cleanup as parseFooter: origin-tag imitations + orphan markdown
    s = s.replace(/(^|\n)[ \t]*\((?:public|private to [^)]*)\)[ \t]*/gi, '$1');
    s = s.replace(/\*\*[ \t]*\*\*/g, '');
    s = s.replace(/\n[ \t]*\*+[ \t]*(?=\n)/g, '');
    s = s.replace(/\n[ \t]*(?:\n[ \t]*){2,}/g, '\n\n').trim();
    // collect route markers with positions
    const markers = [];
    const re = /\[{1,2}\s*route\s*:\s*([^\]]+?)\s*\]{1,2}/gi;
    let mm;
    while ((mm = re.exec(s)) !== null) {
      markers.push({ name: mm[1].trim(), start: mm.index, end: mm.index + mm[0].length });
    }
    const afterLast = markers.length ? s.slice(markers[markers.length - 1].end).trim() : '';
    const pre = markers.length ? s.slice(0, markers[0].start).trim() : '';
    if (markers.length > 1 && !afterLast && pre) {
      return { routingError: 'Mixed or conflicting route footers; destinations are unclear.' };
    }
    if (markers.length && (afterLast || (markers.length > 1 && !pre))) {
      const sections = [];
      if (pre) sections.push({ name: null, text: pre });   // unmarked lead -> main narration
      for (let i = 0; i < markers.length; i++) {
        const end = i + 1 < markers.length ? markers[i + 1].start : s.length;
        const text = s.slice(markers[i].end, end).trim();
        if (text && sections.length >= SECTION_CAP) {
          return { routingError: 'Reply exceeds the six-section routing limit.' };
        }
        if (text) sections.push({ name: markers[i].name, text: text });
      }
      return { next: nm ? nm[1].trim() : null, route: null, clean: s, sections: sections };
    }
    const clean = s.replace(ROUTE_G, '').replace(/\n[ \t]*(?:\n[ \t]*){2,}/g, '\n\n').trim();
    return { next: nm ? nm[1].trim() : null, route: markers.length ? markers[0].name : null, clean: clean, sections: null };
  }

  /* Resolve one route marker to a destination. Pure — returns a verdict:
   * { dest: 'main'|branchId|null, reason: 'ok'|'multi'|'ambiguous'|'unknown', ambiguous: [names] } */
  function resolveRoute(name) {
    const q = String(name || '').trim();
    if (/[,]| \band\b/i.test(q)) return { dest: null, reason: 'multi', ambiguous: [] };
    const res = App.store.resolveBranch(q);
    if (res.id) return { dest: res.id, reason: 'ok', ambiguous: [] };
    return { dest: null, reason: res.ambiguous.length ? 'ambiguous' : 'unknown', ambiguous: res.ambiguous };
  }

  function originLabel(st, origin) {
    return origin === 'main' ? 'main' : (st.branches[origin] ? st.branches[origin].name : origin);
  }

  /* ---------------- auto-chain driver ---------------- */

  const autoChain = { count: 0 };
  function resetChain() {
    autoChain.count = 0;
  }

  function recordTurnRoll(tableText, roll) {
    App.store.addMessage({
      role: 'tool',
      name: 'Tool: turn_order',
      content: 'args: next table "' + tableText + '"\n---\nrolled ' + roll.roll.toFixed(1) +
        ' / ' + roll.total.toFixed(1) + ' -> ' + roll.winner + ' acts next.' +
        (roll.dropped && roll.dropped.length ? '\n(unparsed entries dropped: ' + roll.dropped.join(', ') + ')' : ''),
      origin: 'main'
    });
  }

  function autoTurnCap(st) {
    const cap = st.settings.maxAutoTurns;
    return (typeof cap === 'number' && cap >= 0) ? cap : 8;
  }

  /* Decide what the picked next-speaker means and continue (or pause) the game. */
  function advanceChain(winnerName, fromBranchId) {
    const st = App.store.get();
    if (st.settings.autoTurns === false) return;
    if (autoChain.count >= autoTurnCap(st)) {
      App.ui.toast('Auto-turn limit reached (' + autoTurnCap(st) + ') — waiting for you.', 'info');
      App.sound.playerTurn();
      return;
    }
    const lower = String(winnerName || '').trim().toLowerCase();
    if (PAUSE_WORDS.indexOf(lower) >= 0) {
      App.sound.playerTurn();
      return;
    }
    if (GM_WORDS.indexOf(lower) >= 0) {
      autoChain.count++;
      App.actions.gmReply(fromBranchId, { via: 'chain' });
      return;
    }
    const res = App.store.resolveBranch(winnerName);
    if (!res.id) {
      // unknown or ambiguous: pause safely, visibly
      App.ui.toast(res.ambiguous.length
        ? 'Turn-order pick "' + winnerName + '" is ambiguous (' + res.ambiguous.join(', ') + ') — waiting for you.'
        : 'Turn-order pick "' + winnerName + '" matches no branch — waiting for you.', 'error');
      return;
    }
    const bid = res.id;
    const branch = st.branches[bid];
    if (branch.controller === 'ai') {
      autoChain.count++;
      App.actions.generateCharacter(bid);
    } else {
      st.awaiting = bid;                                    // human: flag and wait
      App.store.save();
      App.ui.renderAll();
      App.sound.playerTurn();
    }
  }

  /* ---------------- tool-call orchestration ---------------- */

  function summarizeArgs(raw) {
    const s = String(raw || '');
    return s.length > 300 ? s.slice(0, 300) + '...' : s;
  }

  /* Abort registry: stopGeneration() cancels every in-flight request. */
  const activeControllers = new Set();
  let stopVersion = 0;

  App.actions.stopGeneration = function (silent) {
    stopVersion++;
    let n = 0;
    activeControllers.forEach(function (c) { c.abort(); n++; });
    if (n && !silent) App.ui.toast('Stopping generation...', 'info');
    return n;
  };

  /* Chat with tool-call handling. The model may call tools several times per
   * turn; each execution is fed back as a proper tool message AND recorded in
   * the branch log (origin = the branch being answered), so rolls stay
   * auditable. Falls back to a plain chat call if the model/provider rejects
   * tools. When settings.stream is on, each generation segment is streamed
   * into a live bubble; stopping mid-stream returns { cancelled, content,
   * reasoning } with whatever partial text arrived. */
  async function chatWithTools(opts) {
    const session = App.store.get();
    const s = Object.assign({}, opts.settingsSnapshot || session.settings); // freeze service/key for the whole turn
    const pendingVersion = stopVersion;
    const reference = opts.includeReferences !== false && s.sendAttachments !== false ? await App.attachments.message(opts.supports) : null;
    if (App.store.get() !== session || stopVersion !== pendingVersion) return { cancelled: true, content: '' };
    const tools = App.tools && !opts.textOnly ? App.tools.forAudience(opts.audience) : [];
    // pre-gate features the model declares it doesn't support (from OpenRouter
    // supported_parameters) so we never pay a failed request to learn them
    if (tools.length && s.enableTools !== false && opts.supports && opts.supports.tools === false) {
      App.ui.toast('Model does not declare tool support — sending without tools.', 'info');
    }
    if (opts.reasoning !== false && s.reasoning && s.reasoning !== 'off' && opts.supports && opts.supports.reasoning === false) {
      App.ui.toast('Model does not declare reasoning support — sending without the reasoning parameter.', 'info');
    }
    let useTools = tools.length > 0 && s.enableTools !== false &&
      !(opts.supports && opts.supports.tools === false);
    let useReasoning = opts.reasoning !== false && !!(s.reasoning && s.reasoning !== 'off') &&
      !(opts.supports && opts.supports.reasoning === false);
    const useStream = opts.stream !== false && s.stream !== false;
    let retriesLeft = (typeof s.autoRetryDrops === 'number' && s.autoRetryDrops >= 0) ? s.autoRetryDrops : 2;
    const msgs = opts.messages.slice();
    if (reference) {
      let at = 0;
      while (at < msgs.length && msgs[at].role === 'system') at++;
      msgs.splice(at, 0, reference);
    }
    const toolsUsed = [];
    const turnState = { whispers: {} };   // per-turn bookkeeping shared with tools (whisper dedup)
    const MAX_ITER = 8;                   // tool loops + drop/network retries share this budget

    // pre-flight: catch small-context models before the provider dies mid-stream
    const promptEst = msgs.reduce(function (t, m) { return t + App.prompts.estTokens(m.content || ''); }, 0);
    if (opts.modelContext && promptEst + (opts.maxTokens || 0) > opts.modelContext) {
      throw new Error('Selected model\'s context is too small for this request: ~' +
        Math.round((promptEst + (opts.maxTokens || 0)) / 1000) + 'k tokens needed (prompt + reply room) vs ~' +
        Math.round(opts.modelContext / 1000) + 'k available. Pick a larger-context model in Settings.');
    }

    for (let iter = 0; iter < MAX_ITER; iter++) {
      if (App.store.get() !== session || stopVersion !== pendingVersion) return { cancelled: true, content: '' };
      const partial = { content: '', reasoning: '' };
      let res;
      const ctrl = new AbortController();
      activeControllers.add(ctrl);
      if (useStream) {
        App.ui.streamStart({ name: opts.streamName || 'GM', role: opts.streamRole || 'gm' });
      }
      try {
        res = await App.api.chatFull({
          apiKey: s.apiKey,
          apiService: s.apiService,
          model: opts.model,
          messages: msgs,
          temperature: opts.temperature,
          maxTokens: opts.maxTokens,
          pricing: opts.pricing,
          provider: providerPrefs(s),
          reasoning: useReasoning ? s.reasoning : undefined,
          tools: useTools ? tools : undefined,
          stream: useStream,
          signal: ctrl.signal,
          onChunk: function (p) {
            if (App.store.get() !== session) return;
            if (p.content != null) partial.content = p.content;
            if (p.reasoning != null) partial.reasoning = p.reasoning;
            App.ui.streamChunk(p);
          }
        });
      } catch (err) {
        if (App.store.get() !== session) return { cancelled: true, content: '' };
        if (err && err.name === 'AbortError') {
          return {
            cancelled: true,
            content: (partial.content || '').trim(),
            reasoning: partial.reasoning || null,
            toolsUsed: toolsUsed
          };
        }
        const msg = String((err && err.message) || '');
        const diagCtx = {
          model: opts.model, audience: opts.audience, iteration: iter,
          msgs: msgs.length, useTools: useTools, useReasoning: useReasoning,
          retriesLeft: retriesLeft,
          stack: err && err.stack ? String(err.stack).slice(0, 1500) : undefined
        };
        // Retry without tools ONLY when the API actually rejected the tools
        // parameter (4xx mentioning tools). Network errors must not be
        // mislabeled as tool rejections or silently retried.
        if (useTools && /(?:openrouter|abliteration\.ai) 4\d\d/i.test(msg) && /tool/i.test(msg)) {
          useTools = false;
          if (App.diag) App.diag.log('retry', 'tools rejected by API — retrying without tools', diagCtx);
          App.ui.toast('Model rejected tool use — continuing without tools for this call.', 'error');
          continue;
        }
        // Same pattern for the reasoning parameter — model-swap robustness.
        if (useReasoning && /(?:openrouter|abliteration\.ai) 4\d\d/i.test(msg) && /reasoning/i.test(msg)) {
          useReasoning = false;
          if (App.diag) App.diag.log('retry', 'reasoning rejected by API — retrying without reasoning', diagCtx);
          App.ui.toast('Model rejected the reasoning parameter — continuing without it.', 'error');
          continue;
        }
        // Transient network failure (not an API verdict): auto-retry.
        if (retriesLeft > 0 && !/^(?:openrouter|abliteration\.ai)/i.test(msg)) {
          retriesLeft--;
          if (App.diag) App.diag.log('retry', 'request failed (network or internal) — retrying', diagCtx);
          App.ui.toast('Connection failed — retrying automatically...', 'error');
          continue;
        }
        if (App.diag) App.diag.log('error', 'request failed: ' + msg, diagCtx);
        throw err;
      } finally {
        activeControllers.delete(ctrl);
        if (useStream) App.ui.streamEnd();
      }

      // A response may arrive after a session switch, even after abort.
      // Never execute its tools against the replacement session.
      if (App.store.get() !== session) return { cancelled: true, content: '' };

      // Persist each known request cost once, including billed drops/tool continuations.
      App.store.addSessionCost(res.cost);
      App.ui.renderTopbar();
      if (stopVersion !== pendingVersion) return { cancelled: true, content: '' };

      const m = res.message;

      // Stream dropped mid-response (connection cut before [DONE]). Auto-retry
      // first — flaky providers drop often; give up only when the budget is
      // spent. Never execute fragmentary tool calls from a cut stream.
      if (res.dropped) {
        if (retriesLeft > 0) {
          retriesLeft--;
          if (App.diag) App.diag.log('retry', 'stream dropped mid-response — retrying', { model: opts.model, iteration: iter });
          App.ui.toast('Connection dropped mid-response — retrying automatically...', 'error');
          continue;
        }
        if (App.diag) App.diag.log('drop', 'stream dropped; retries exhausted — partial kept', {
          model: opts.model, chars: (m.content || '').length, toolsUsed: toolsUsed.slice()
        });
        return {
          cancelled: true,
          dropped: true,
          content: (m.content || '').trim(),
          reasoning: m.reasoning || null,
          toolsUsed: toolsUsed
        };
      }

      const calls = m.tool_calls || [];
      if (opts.strictText && (calls.length || !m.content || !m.content.trim())) {
        throw new Error('Compaction returned tools or an empty response instead of summaries. Nothing has been compacted.');
      }
      if (calls.length) {
        // Normalize for the continuation request: some providers stream tool
        // calls without ids or with pre-parsed argument objects, either of
        // which makes the follow-up request (which echoes the assistant
        // message and the tool results) fail. Fix both before re-sending.
        let missingIds = 0;
        calls.forEach(function (tc, i) {
          if (tc.function && typeof tc.function.arguments !== 'string') {
            tc.function.arguments = JSON.stringify(tc.function.arguments || {});
          }
          if (!tc.id) { tc.id = 'call_' + iter + '_' + i; missingIds++; }
        });
        if (missingIds && App.diag) App.diag.log('info', 'tool_calls arrived without ids — synthesized ' + missingIds, { model: opts.model, iteration: iter });
        msgs.push(m);
        for (const tc of calls) {
          if (App.store.get() !== session) return { cancelled: true, content: '' };
          let args = {}, out;
          if (!useTools || !tools.some(function (t) { return t.function.name === tc.function.name; })) {
            out = { text: 'Error: this tool is not available for this request.', record: false };
          }
          try { if (!out) args = JSON.parse(tc.function.arguments || '{}'); }
          catch (e) { out = { text: 'Error: invalid JSON arguments: ' + e.message, record: false }; }
          if (!out) {
            out = App.tools.execute(tc.function.name, args, {
              store: App.store,
              state: session,
              branchId: opts.originBranchId,
              turn: turnState
            });
            App.ui.renderCharacterPanel();
          }
          if (App.diag && /^Error/.test(out.text)) {
            App.diag.log('error', 'tool "' + tc.function.name + '" returned an error', { result: out.text.slice(0, 400) });
          }
          msgs.push({ role: 'tool', tool_call_id: tc.id, content: out.text });
          if (out.record !== false) {
            App.store.addMessage({
              role: 'tool',
              name: 'Tool: ' + tc.function.name,
              // Keep the full tag-to-die mapping in roll history, even for long expressions.
              content: tc.function.name === 'roll_resolver' && !/^Error/.test(out.text)
                ? args.expression + '\n' + out.text
                : 'args: ' + summarizeArgs(tc.function.arguments) + '\n---\n' + out.text,
              origin: opts.originBranchId
            });
            toolsUsed.push(tc.function.name);
          }
        }
        continue;
      }
      if (m.content && m.content.trim()) {
        return { content: m.content.trim(), reasoning: m.reasoning || null, toolsUsed: toolsUsed, usage: res.usage };
      }
      msgs.push({ role: 'user', content: '(empty response — please continue)' });
    }
    if (App.diag) App.diag.log('error', 'turn loop exhausted', { model: opts.model, audience: opts.audience, iterations: MAX_ITER, msgs: msgs.length });
    throw new Error('The model did not produce a reply after ' + MAX_ITER + ' tool iterations.');
  }

  /* ---------------- core actions ---------------- */

  App.actions.compactContext = async function () {
    if (document.body.classList.contains('busy')) return;
    const pending = App.compaction.plan().pending;
    if (!pending.length) { App.ui.toast('No older Main messages need compaction.', 'info'); return; }
    const settings = settingsGuard();
    if (!settings) return;
    const s = Object.assign({}, settings);
    const session = App.store.get(), version = stopVersion;
    const view = App.ui.captureMessageView();
    App.ui.setBusy('Preparing context compaction…');
    try {
      const batches = App.compaction.batches(pending, s.modelContext);
      const summaries = [];
      for (let i = 0; i < batches.length; i++) {
        if (App.store.get() !== session || stopVersion !== version) return;
        App.ui.setBusy('Compacting Main · batch ' + (i + 1) + ' of ' + batches.length + '…');
        const result = await chatWithTools({
          messages: App.compaction.requestMessages(batches[i]),
          model: s.model, modelContext: s.modelContext, supports: s.modelSupports,
          pricing: s.modelPricing, temperature: 0.2, maxTokens: App.compaction.outputBudget(batches[i]),
          audience: 'gm', originBranchId: 'main', textOnly: true, strictText: true,
          includeReferences: false, stream: false, reasoning: false, settingsSnapshot: s
        });
        if (App.store.get() !== session) return;
        if (result.cancelled || stopVersion !== version) {
          App.ui.toast('Compaction stopped. Existing context is unchanged; completed requests still count toward Total.', 'info');
          return;
        }
        summaries.push.apply(summaries, App.compaction.parseReply(result.content, batches[i]));
      }
      const count = App.compaction.apply(session, summaries);
      App.ui.toast(count + ' Main messages summarized for context. Originals remain in the transcript.', 'info');
    } catch (err) {
      if (App.store.get() === session) {
        if (App.diag) App.diag.log('error', 'Context compaction failed; no summaries applied', { model: s.model, messages: pending.length });
        App.ui.toast(err.message || 'Compaction failed; context is unchanged.', 'error');
      }
    } finally {
      App.ui.setBusy(null);
      App.ui.renderAll();
      App.ui.restoreMessageView(view);
    }
  };

  App.actions.restoreContext = function () {
    if (document.body.classList.contains('busy')) return;
    App.compaction.restore();
    const view = App.ui.captureMessageView();
    App.ui.renderAll();
    App.ui.restoreMessageView(view);
    App.ui.toast('Full original context restored. Previous compaction charges remain in Total.', 'info');
  };

  /* Send whatever is in the composer, respecting the role segment. */
  App.actions.sendComposed = function () {
    // single-flight turn ownership: no new turns while a generation runs
    if (document.body.classList.contains('busy')) {
      App.ui.toast('A generation is already in flight — stop it or wait for it to finish.', 'error');
      return;
    }
    const st = App.store.get();
    const b = st.branches[st.activeBranchId];
    if (!b) return;
    const text = App.ui.getDraft(b.id).trim();
    if (!text) return;
    resetChain();   // human input resets the auto-turn budget
    const seg = App.ui.getSeg(b.id);

    if (b.type === 'main') {
      App.store.addMessage({
        role: seg === 'note' ? 'note' : 'gm',
        name: seg === 'note' ? 'GM Note' : 'GM',
        content: text,
        origin: 'main'
      });
    } else if (seg === 'gm') {
      App.store.addMessage({ role: 'gm', name: 'GM', content: text, origin: b.id });
    } else {
      App.store.addMessage({ role: 'character', name: b.name, content: text, origin: b.id });
      App.ui.clearDraft(b.id);
      App.ui.renderAll();
      App.actions.maybeAutoGm(b.id);
      focusComposer();
      return;
    }
    App.ui.clearDraft(b.id);
    App.ui.renderAll();
    focusComposer();
  };

  /* AI-controlled character speaks in their branch. */
  App.actions.generateCharacter = async function (branchId) {
    const s = settingsGuard(); if (!s) return;
    const st = App.store.get();
    const b = st.branches[branchId];
    if (!b || b.type !== 'character') return;

    App.ui.setBusy(b.name + ' is thinking...');
    let completed = false;
    try {
      const messages = App.prompts.characterApiMessages(st, branchId);
      const out = await chatWithTools({
        model: charModel(s),
        messages: messages,
        temperature: s.temperature,
        // characters stay succinct; the cap only guards runaway replies — sized with
      // reasoning headroom so a thinking model can't starve the reply itself
        maxTokens: Math.min(s.maxTokens, 2000),
        audience: 'character',
        originBranchId: branchId,
        streamName: b.name,
        streamRole: 'character',
        pricing: s.charPricing || s.modelPricing,
        modelContext: s.charContext || s.modelContext,
        supports: s.charModel ? s.charSupports : s.modelSupports
      });
      if (App.store.get() !== st) return;
      if (out.cancelled) {
        if (out.content) {
          App.store.addMessage({ role: 'character', name: b.name, content: out.content, origin: branchId, reasoning: out.reasoning, stopped: true });
          App.ui.toast(out.dropped ? 'Connection dropped mid-response — partial kept.' : 'Stopped — partial reply kept.', out.dropped ? 'error' : 'info');
        } else {
          App.ui.toast(out.dropped ? 'Connection dropped mid-response — nothing received.' : 'Generation stopped.', 'error');
        }
        if (out.dropped) App.ui.setConn('bad');
      } else {
        App.store.addMessage({ role: 'character', name: b.name, content: out.content, origin: branchId, reasoning: out.reasoning });
        completed = true;
      }
      if (!out.cancelled) App.ui.setConn('ok');
    } catch (err) {
      if (App.diag) App.diag.log('error', 'generateCharacter failed: ' + err.message, { stack: err && err.stack ? String(err.stack).slice(0, 1500) : undefined, branchId: branchId });
      App.ui.toast(err.message, 'error');
      App.ui.setConn('bad');
    } finally {
      App.ui.setBusy(null);
      App.ui.renderAll();
    }
    if (completed) App.actions.maybeAutoGm(branchId);
  };

  /* AI GM replies. branchId: character branch to answer, or 'main' for a main-branch continuation. */
  App.actions.gmReply = async function (branchId, opts) {
    const s = settingsGuard(); if (!s) return;
    const st = App.store.get();
    const origin = (branchId && branchId !== 'main' && st.branches[branchId]) ? branchId : 'main';
    const via = (opts && opts.via) || 'auto';
    let nextTurn = null;

    App.ui.setBusy('GM is thinking...');
    try {
      const messages = App.prompts.gmApiMessages(st, { origin: origin, via: via });
      const out = await chatWithTools({
        model: s.model,
        messages: messages,
        temperature: s.temperature,
        maxTokens: s.maxTokens,
        audience: 'gm',
        originBranchId: origin,
        streamName: 'GM',
        streamRole: 'gm',
        modelContext: s.modelContext,
        pricing: s.modelPricing,
        supports: s.modelSupports
      });
      if (App.store.get() !== st) return;
      if (out.cancelled) {
        if (out.content) {
          // Its destination may not have arrived yet. Notes are operator-only;
          // stopped notes are also excluded from future GM requests.
          App.store.addMessage({ role: 'note', name: 'Interrupted GM draft',
            content: 'Unfinished reply requested from ' + originLabel(st, origin) +
              '. Not delivered to characters or included in model context.\n\n' + out.content,
            origin: 'main', reasoning: out.reasoning, stopped: true });
          App.ui.toast(out.dropped ? 'Connection dropped — unfinished GM draft kept in Main for you only.' :
            'Stopped — unfinished GM draft kept in Main for you only.', out.dropped ? 'error' : 'info');
        } else {
          App.ui.toast(out.dropped ? 'Connection dropped mid-response — nothing received.' : 'Generation stopped.', 'error');
        }
        if (out.dropped) App.ui.setConn('bad');
      } else {
        const foot = parseTurnFooter(out.content);
        if (foot.routingError) {
          App.ui.toast(foot.routingError + ' Reply not delivered; waiting for you.', 'error');
          return;
        }
        const storedDests = [];
        let routingFailed = false;
        let firstStored = true;
        const storePart = function (content, dest) {
          App.store.addMessage({
            role: 'gm', name: 'GM', content: content, origin: dest,
            reasoning: firstStored ? out.reasoning : undefined
          });
          firstStored = false;
          storedDests.push(dest);
        };
        if (foot.sections) {
          // section protocol: file each part where it belongs
          for (const sec of foot.sections) {
            let dest = 'main';
            if (sec.name) {
              const verdict = resolveRoute(sec.name);
              dest = verdict.dest;
              if (!dest) {
                routingFailed = true;
                if (verdict.reason === 'multi') {
                  App.ui.toast('GM route "' + sec.name + '" lists several destinations — a marker takes ONE; that section is dropped.', 'error');
                } else if (verdict.reason === 'ambiguous') {
                  App.ui.toast('GM route "' + sec.name + '" is ambiguous (' + verdict.ambiguous.join(', ') + ') — that section is dropped.', 'error');
                } else {
                  App.ui.toast('GM route "' + sec.name + '" matches no branch — that section is dropped.', 'error');
                }
              }
            }
            if (dest && sec.text) storePart(sec.text, dest);
          }
          if (!storedDests.length) {
            App.ui.toast('No section could be routed — reply dropped; waiting for you.', 'error');
            routingFailed = true;
          }
        } else {
          // legacy: one destination for the whole reply
          let targetId = origin;
          if (foot.route) {
            const verdict = resolveRoute(foot.route);
            if (verdict.dest) targetId = verdict.dest;
            else {
              targetId = null;
              routingFailed = true;
              const where = ' — reply dropped; waiting for you.';
              if (verdict.reason === 'multi') {
                App.ui.toast('GM route "' + foot.route + '" lists several destinations — a marker takes exactly ONE' + where, 'error');
              } else if (verdict.reason === 'ambiguous') {
                App.ui.toast('GM route "' + foot.route + '" is ambiguous (' + verdict.ambiguous.join(', ') + ')' + where, 'error');
              } else {
                App.ui.toast('GM routed to unknown branch "' + foot.route + '"' + where, 'error');
              }
            }
          }
          if (targetId) storePart(foot.clean, targetId);
        }
        if (foot.next && !routingFailed) {
          const roll = rollTurnOrder(foot.next);
          if (roll) {
            recordTurnRoll(foot.next, roll);
            // the chain continues from the picked character's branch if the
            // reply delivered one; otherwise from main
            const chainFrom = storedDests.filter(function (d) { return d !== 'main'; }).pop() || 'main';
            nextTurn = { winner: roll.winner, origin: chainFrom };
          } else {
            App.ui.toast('GM\'s next table could not be parsed ("' + foot.next + '") — waiting for you.', 'error');
          }
        }
        // no footer next -> chain pauses; the human decides what happens next
      }
      if (!out.cancelled) App.ui.setConn('ok');
    } catch (err) {
      if (App.diag) App.diag.log('error', 'gmReply failed: ' + err.message, { stack: err && err.stack ? String(err.stack).slice(0, 1500) : undefined, origin: origin });
      App.ui.toast(err.message, 'error');
      App.ui.setConn('bad');
    } finally {
      App.ui.setBusy(null);
      App.ui.renderAll();
    }
    // Finish this turn's UI cleanup before starting the next request. Otherwise
    // the previous turn clears the new turn's busy indicator and Stop button.
    if (nextTurn) advanceChain(nextTurn.winner, nextTurn.origin);
  };

  /* After a character message, auto-request the GM reply if enabled. */
  App.actions.maybeAutoGm = function (branchId) {
    const st = App.store.get();
    if (st.gmController !== 'ai') return;
    if (!st.settings.autoGmReply) return;
    App.actions.gmReply(branchId);
  };

  /* ---------------- swipes / regeneration ---------------- */

  /* Ephemeral regen cues. These are appended to the request's message array
   * only — never stored — so the operator's direction exists for exactly
   * one request and then evaporates. */
  function regenCue(audience, note) {
    if (audience === 'gm') {
      return note
        ? '[engine: the operator asked you to regenerate your previous reply. Their direction for the new version: "' + note + '"]'
        : '[engine: regenerate your previous reply — take it differently this time.]';
    }
    return note
      ? '[engine: the operator asked you to redo your last reply. Their direction for the new version: "' + note + '"]'
      : '[engine: redo your last reply — take it differently this time.]';
  }

  /* Regenerate a message as a new swipe variant. The variant replaces the
   * message's text only: routing and turn-order effects of the original are
   * NOT re-applied (they already happened), so regens never re-roll the table
   * or spawn a second chain. comment (optional) is ephemeral steering for
   * this one request — it is never stored in the session. */
  App.actions.regenerateMessage = async function (msgId, comment) {
    if (document.body.classList.contains('busy')) return;
    const s = settingsGuard(); if (!s) return;
    const st = App.store.get();
    const m = st.messages[msgId];
    if (!m || (m.role !== 'gm' && m.role !== 'character')) return;

    if (!st.branches[m.origin]) return;
    // never put AI words in a human's mouth
    if (m.role === 'character' && (st.branches[m.origin].type !== 'character' || st.branches[m.origin].controller !== 'ai')) {
      App.ui.toast('That branch is human-controlled — no AI regeneration.', 'error');
      return;
    }

    const note = comment ? String(comment).trim() : '';
    const audience = m.role === 'gm' ? 'gm' : 'character';
    const branchName = m.role === 'character' && st.branches[m.origin] ? st.branches[m.origin].name : 'GM';

    const view = App.ui.captureMessageView();
    App.ui.setBusy('Regenerating...');
    try {
      let messages;
      if (audience === 'gm') {
        messages = App.prompts.gmApiMessages(st, { origin: m.origin, excludeId: msgId, beforeTs: m.ts });
      } else {
        messages = App.prompts.characterApiMessages(st, m.origin, msgId, m.ts);
      }
      messages.push({ role: 'user', content: '[engine: original reply to revise follows. Preserve its established rolls. Conversation history stops before this reply; supplied cards reflect current state, not a historical snapshot. Later messages and cards will not be rewound.]\n' + m.content });
      messages.push({ role: 'user', content: regenCue(audience, note) });
      messages.push({ role: 'user', content: App.prompts.regenerationInstruction(st, m.origin, audience) });

      const out = await chatWithTools({
        model: audience === 'gm' ? s.model : charModel(s),
        textOnly: true,
        messages: messages,
        temperature: s.temperature,
        maxTokens: audience === 'gm' ? s.maxTokens : Math.min(s.maxTokens, 2000),
        audience: audience,
        originBranchId: m.origin,
        streamName: branchName,
        streamRole: m.role,
        modelContext: audience === 'gm' ? s.modelContext : (s.charContext || s.modelContext),
        pricing: audience === 'gm' ? s.modelPricing : (s.charPricing || s.modelPricing),
        supports: audience === 'gm' ? s.modelSupports : (s.charModel ? s.charSupports : s.modelSupports)
      });
      if (App.store.get() !== st) return;
      if (out.cancelled) {
        // A partial GM reply may end before its private routing footer arrives.
        if (audience === 'gm') {
          App.ui.toast('Regeneration interrupted — original reply kept.', 'error');
          return;
        }
        if (out.content) {
          App.store.addSwipe(msgId, out.content, out.reasoning);
          st.messages[msgId].stopped = true;   // mark the partial
          App.store.save();
          App.ui.toast(out.dropped ? 'Connection dropped mid-response — partial kept as a variant.' : 'Stopped — partial regen kept as a variant.', out.dropped ? 'error' : 'info');
        } else {
          App.ui.toast(out.dropped ? 'Connection dropped mid-response — nothing received.' : 'Generation stopped.', 'error');
        }
        if (out.dropped) App.ui.setConn('bad');
      } else {
        const foot = parseTurnFooter(out.content);
        if (foot.routingError) {
          App.ui.toast(foot.routingError + ' Original reply kept.', 'error');
          return;
        }
        let replacement = foot.clean;
        let discarded = false;
        if (foot.sections) {
          replacement = foot.sections.filter(function (sec) {
            const dest = sec.name ? resolveRoute(sec.name).dest : 'main';
            if (dest === m.origin) return true;
            discarded = true;
            return false;
          }).map(function (sec) { return sec.text; }).join('\n\n');
        } else if (foot.route && resolveRoute(foot.route).dest !== m.origin) {
          replacement = '';
          discarded = true;
        }
        if (discarded) App.ui.toast('Regeneration included other or unresolved destinations — those sections were dropped.', 'error');
        if (replacement.trim()) App.store.addSwipe(msgId, replacement, out.reasoning);
        else App.ui.toast('No replacement for this channel — original reply kept.', 'error');
      }
      if (!out.cancelled) App.ui.setConn('ok');
    } catch (err) {
      if (App.diag) App.diag.log('error', 'regenerate failed: ' + err.message, { stack: err && err.stack ? String(err.stack).slice(0, 1500) : undefined, msgId: msgId });
      App.ui.toast(err.message, 'error');
      App.ui.setConn('bad');
    } finally {
      App.ui.setBusy(null);
      App.ui.renderAll();
      App.ui.restoreMessageView(view);
    }
  };

  /* Cycle a message's saved variants. */
  App.actions.cycleSwipe = function (msgId, dir) {
    const m = App.store.get().messages[msgId];
    if (!m || !Array.isArray(m.swipes) || !m.swipes.length) return;
    const target = (typeof m.swipeIndex === 'number' ? m.swipeIndex : 0) + dir;
    if (target < 0 || target >= m.swipes.length) return;
    App.actions.selectSwipe(msgId, target);
  };

  App.actions.selectSwipe = function (msgId, index) {
    if (document.body.classList.contains('busy')) return;
    const m = App.store.get().messages[msgId];
    if (!m || !Array.isArray(m.swipes) || !Number.isInteger(index) || index < 0 || index >= m.swipes.length) return;
    App.store.setMessageSwipe(msgId, index);
    App.ui.refreshMessageVariants();
  };

  /* ---------------- top bar / sidebar wiring ---------------- */

  function focusComposer() {
    const ta = App.ui._composerTa;
    if (ta) ta.focus();
  }

  function wireStatic() {
    document.querySelector('#themeDay').addEventListener('click', function () { App.theme.set('day'); });
    document.querySelector('#themeNight').addEventListener('click', function () { App.theme.set('night'); });
    document.querySelector('#btnSettings').addEventListener('click', App.ui.openSettingsModal);
    document.querySelector('#btnNewBranch').addEventListener('click', App.ui.openNewBranchModal);

    document.querySelector('#btnExport').addEventListener('click', function () {
      const st = App.store.get();
      const blob = new Blob([App.store.serializeSession()], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'armatsur-' + (st.meta.name || 'session').replace(/[^\w\- ]/g, '').trim() + '.json';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
    });

    document.querySelector('#btnImport').addEventListener('click', function () {
      document.querySelector('#fileImport').click();
    });
    document.querySelector('#fileImport').addEventListener('change', function (e) {
      const f = e.target.files[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = function () {
        try {
          App.store.applySession(String(r.result));
          App.ui.renderAll();
          App.ui.toast('Session imported.', 'info');
        } catch (err) {
          App.ui.toast('Import failed: ' + err.message, 'error');
        }
      };
      r.readAsText(f);
      e.target.value = '';
    });

    document.querySelector('#btnSessions').addEventListener('click', App.ui.openSessionsModal);

    document.querySelector('#fileRulebook').addEventListener('change', function (e) {
      const f = e.target.files[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = function () {
        App.store.get().rulebook = String(r.result || '');
        App.store.save();
        App.ui.renderTopbar();
        App.ui.closeModal();
        App.ui.openSettingsModal();
        App.ui.toast('Rulebook loaded (' + App.store.get().rulebook.length.toLocaleString() + ' chars).', 'info');
      };
      r.readAsText(f);
      e.target.value = '';
    });
  }

  /* ---------------- rulebook bootstrap ---------------- */

  async function ensureRulebook() {
    const loaded = App.store.get().rulebook || '';
    const updating = loaded.length > 100;
    if (updating) {
      // Only replace recognized older bundled editions. Imported/custom books stay
      // untouched; line-ending differences from text-file imports are harmless.
      if (!window.crypto || !window.crypto.subtle || !window.TextEncoder) return;
      try {
        const normalized = loaded.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
        const digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
        const hash = Array.from(new Uint8Array(digest), function (b) { return b.toString(16).padStart(2, '0'); }).join('');
        const previousBundledHashes = [
          '1b884251293b4dd13a91faedc73cd6488e2e686a46f1fbd60221ee07211e7c0a',
          '98ae6a6b7145cadc62fbafb728ca6d87092a2a769adc4d50ec5fd3df3f78e558'
        ];
        if (previousBundledHashes.indexOf(hash) === -1) return;
      } catch (e) { return; }
    }
    try {
      const res = await fetch('Armat Sur rule book text doc.txt', { cache: 'no-store' });
      if (res.ok) {
        const text = await res.text();
        if (text && text.length > 100) {
          // An import or clear while the fetch was pending takes precedence.
          if ((App.store.get().rulebook || '') !== loaded) return;
          App.store.get().rulebook = text;
          App.store.save();
          App.ui.toast('Rulebook ' + (updating ? 'updated' : 'loaded') + ' (' + text.length.toLocaleString() + ' chars, ~' +
            App.prompts.estTokens(text).toLocaleString() + ' tokens).', 'info');
          return;
        }
      }
      throw new Error('bad response');
    } catch (e) {
      App.ui.toast(updating ? 'The bundled rulebook update could not be loaded. Your current rulebook is still available; reload to retry.' : 'Rulebook not auto-loaded. If you opened index.html directly (file://), serve the folder over http (e.g. "python -m http.server") or load the .txt manually in Settings.', 'error');
    }
  }

  /* exposed for headless tests */
  App.actions._test = {
    ensureRulebook: ensureRulebook,
    chatWithTools: chatWithTools,
    providerPrefs: providerPrefs,
    parseFooter: parseFooter,
    parseTurnFooter: parseTurnFooter,
    resolveRoute: resolveRoute,
    parseNextTable: parseNextTable,
    rollTurnOrder: rollTurnOrder,
    advanceChain: advanceChain,
    resetChain: resetChain
  };

  /* ---------------- init ---------------- */

  document.addEventListener('DOMContentLoaded', async function () {
    wireStatic();
    App.ui.renderAll();
    App.attachments.ready().then(App.ui.renderTopbar).catch(function (e) { App.ui.toast(e.message, 'error'); });
    await ensureRulebook();
    App.ui.renderAll();
  });
})();
