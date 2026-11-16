/* Armat-sur session runner — diagnostics / crash log.
 *
 * A small ring buffer (persisted to localStorage, survives reloads) that
 * records request failures, retries, dropped streams, tool-call problems,
 * and page crashes — so a failed generation can be diagnosed after the
 * fact. Never records message contents; only error details, shapes, and
 * stacks. View via Settings → "Diagnostics log".
 *
 * This module must load FIRST so crash hooks exist before anything else runs.
 */
window.App = window.App || {};

App.diag = (function () {
  const KEY = 'armatsur-diag-v1';
  const MAX = 200;

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) return JSON.parse(raw) || [];
    } catch (e) { /* corrupted — start fresh */ }
    return [];
  }

  let entries = load();

  function persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify(entries));
    } catch (e) {
      // quota: drop older history and retry once
      try {
        entries = entries.slice(-50);
        localStorage.setItem(KEY, JSON.stringify(entries));
      } catch (e2) { /* give up silently */ }
    }
  }

  /* Keep data small and serializable; never carry message bodies. */
  function clone(v) {
    try {
      let s = JSON.stringify(v, function (k, val) {
        return typeof val === 'function' ? '[function]' : val;
      });
      if (s === undefined) s = String(v);
      if (s.length > 20000) s = s.slice(0, 20000) + '...[truncated]';
      return JSON.parse(s);
    } catch (e) {
      try { return String(v).slice(0, 2000); } catch (e2) { return '[unserializable]'; }
    }
  }

  function log(kind, detail, data) {
    const entry = {
      t: new Date().toISOString(),
      kind: String(kind || 'info'),
      detail: String(detail || '').slice(0, 800),
      data: data === undefined ? undefined : clone(data)
    };
    entries.push(entry);
    while (entries.length > MAX) entries.shift();
    persist();
    try { console.warn('[diag:' + entry.kind + '] ' + entry.detail); } catch (e) { /* ignore */ }
    return entry;
  }

  /* True page crashes land in the same log, so a hard failure right after a
   * reply can still be inspected after reloading. */
  window.addEventListener('error', function (e) {
    log('crash', (e && e.message) || 'page error', {
      source: e && e.filename ? (e.filename + ':' + e.lineno) : undefined,
      stack: e && e.error && e.error.stack ? String(e.error.stack).slice(0, 2000) : undefined
    });
  });
  window.addEventListener('unhandledrejection', function (e) {
    const r = e && e.reason;
    log('crash', 'unhandled rejection: ' + String((r && r.message) || r).slice(0, 300), {
      stack: r && r.stack ? String(r.stack).slice(0, 2000) : undefined
    });
  });

  function list() { return entries.slice(); }
  function recent(n) { return entries.slice(-(n || 20)); }
  function clear() { entries = []; persist(); }
  function exportText() {
    return entries.map(function (e) {
      const lines = [e.t + '  [' + e.kind + ']  ' + e.detail];
      if (e.data !== undefined) {
        try { lines.push('    ' + JSON.stringify(e.data)); }
        catch (err) { lines.push('    [unserializable]'); }
      }
      return lines.join('\n');
    }).join('\n\n') || '(no diagnostics recorded)';
  }

  return { log: log, list: list, recent: recent, clear: clear, exportText: exportText };
})();