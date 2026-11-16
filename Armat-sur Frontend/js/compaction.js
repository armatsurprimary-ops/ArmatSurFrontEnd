/* Lossy model context, reversible transcript. Never changes message content. */
window.App = window.App || {};
App.compaction = (function () {
  const KEEP = 10;
  const PREFIX = '[Summary of earlier message] ';
  const hashes = new WeakMap();

  // Cache key, not a security primitive. Two hashes avoid copying the original
  // transcript into every summary (large sessions already strain localStorage).
  function fingerprint(m) {
    const data = JSON.stringify([m.origin, m.role, m.name, m.content]);
    const cached = hashes.get(m);
    if (cached && cached.data === data) return cached.hash;
    let a = 2166136261, b = 5381;
    for (let i = 0; i < data.length; i++) {
      a = Math.imul(a ^ data.charCodeAt(i), 16777619);
      b = Math.imul(b, 33) ^ data.charCodeAt(i);
    }
    const hash = data.length + ':' + (a >>> 0).toString(16) + ':' + (b >>> 0).toString(16);
    hashes.set(m, { data: data, hash: hash });
    return hash;
  }

  function olderMessages() {
    // Count every Main entry in the protected ten; notes remain operator-only
    // and are never sent to the summarizer, even when older than that window.
    return App.store.viewMessages('main').slice(0, -KEEP).filter(function (m) {
      return m.role !== 'note' && !m.stopped && typeof m.content === 'string';
    });
  }

  function validSummary(m) {
    const s = m.contextSummary;
    return !!s && typeof s.text === 'string' && s.text.trim().length > 0 &&
      s.text.length <= 1200 && PREFIX.length + s.text.length < m.content.length &&
      s.sourceHash === fingerprint(m);
  }

  function contextReader() {
    const older = new Set(olderMessages().map(function (m) { return m.id; }));
    return function (m) {
      return older.has(m.id) && m.origin === 'main' && m.role !== 'note' && validSummary(m)
        ? PREFIX + m.contextSummary.text : m.content;
    };
  }

  function plan() {
    const older = olderMessages();
    const pending = older.filter(function (m) { return !validSummary(m) && m.content.length > 160; });
    return {
      older: older.length,
      active: older.filter(validSummary).length,
      stored: App.store.allMessages().filter(function (m) { return !!m.contextSummary; }).length,
      brief: older.filter(function (m) { return !validSummary(m) && m.content.length <= 160; }).length,
      pending: pending.map(function (m) {
        return { id: m.id, role: m.role, name: m.name, content: m.content, sourceHash: fingerprint(m) };
      })
    };
  }

  function requestMessages(batch) {
    return App.prompts.compactionMessages(batch.map(function (m) {
      return { id: m.id, role: m.role, name: m.name, text: m.content };
    }));
  }

  // Some models still reason by default when no reasoning parameter is sent.
  // Leave room for that as well as the JSON rather than starving small batches.
  function outputBudget(batch) { return Math.min(8192, Math.max(2048, 256 + batch.length * 256)); }
  function inputTokens(batch) {
    return requestMessages(batch).reduce(function (n, m) { return n + App.prompts.estTokens(m.content); }, 0);
  }

  function batches(pending, modelContext) {
    const result = [];
    let batch = [];
    const capacity = Number.isFinite(modelContext) && modelContext > 0 ? modelContext : 128000;
    function fits(items) { return inputTokens(items) + outputBudget(items) + 1024 <= capacity; }
    pending.forEach(function (m) {
      const proposed = batch.concat([m]);
      if (batch.length && (proposed.length > 16 || inputTokens(proposed) > 12000 || !fits(proposed))) {
        result.push(batch); batch = [];
      }
      batch.push(m);
      if (!fits(batch)) throw new Error('An older Main message is too large to summarize with this model. Select a model with a larger context window or shorten that message first. Nothing has been compacted.');
    });
    if (batch.length) result.push(batch);
    return result;
  }

  function parseReply(raw, batch) {
    let parsed;
    try { parsed = JSON.parse(String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
    catch (_) { throw new Error('Compaction returned invalid JSON. Nothing has been compacted.'); }
    const expected = new Set(batch.map(function (m) { return m.id; }));
    if (!Array.isArray(parsed) || parsed.length !== batch.length) {
      throw new Error('Compaction did not return one summary per message. Nothing has been compacted.');
    }
    const summaries = new Map();
    parsed.forEach(function (item) {
      if (!item || !expected.has(item.id) || summaries.has(item.id) || typeof item.summary !== 'string' ||
          !item.summary.trim() || item.summary.length > 1200) {
        throw new Error('Compaction returned an invalid or duplicate summary. Nothing has been compacted.');
      }
      summaries.set(item.id, item.summary.trim());
    });
    return batch.map(function (m) {
      return { id: m.id, sourceHash: m.sourceHash, text: summaries.get(m.id) };
    });
  }

  function apply(session, summaries) {
    const eligible = new Set(olderMessages().map(function (m) { return m.id; }));
    if (App.store.get() !== session || summaries.some(function (s) {
      const m = session.messages[s.id];
      return !m || !eligible.has(s.id) || fingerprint(m) !== s.sourceHash;
    })) throw new Error('The source messages changed during compaction. Nothing has been compacted; try again.');
    let count = 0;
    summaries.forEach(function (s) {
      const m = session.messages[s.id];
      // An already concise entry should never become longer through compaction.
      if (PREFIX.length + s.text.length >= m.content.length) return;
      m.contextSummary = { text: s.text, sourceHash: s.sourceHash };
      count++;
    });
    App.store.save();
    return count;
  }

  function restore() {
    App.store.allMessages().forEach(function (m) { delete m.contextSummary; });
    App.store.save();
  }

  function level(tokens) { return tokens < 300000 ? 'green' : tokens < 600000 ? 'yellow' : 'red'; }

  return { plan: plan, contextReader: contextReader, batches: batches, requestMessages: requestMessages,
    outputBudget: outputBudget, inputTokens: inputTokens, parseReply: parseReply, apply: apply,
    restore: restore, level: level };
})();
