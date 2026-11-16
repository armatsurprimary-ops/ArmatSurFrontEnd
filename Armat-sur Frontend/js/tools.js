/* Armat-sur session runner — tool registry core.
 *
 * A tool is a self-contained module that the AI (GM or character) can call
 * during its turn via OpenRouter function calling. Each tool lives in its own
 * file under js/tools/ and registers itself here:
 *
 *   App.tools.register({
 *     name: 'my_tool',                  // snake_case; the model calls this name
 *     description: '...',               // tells the model WHEN to use it
 *     parameters: { ...JSONSchema... }, // OpenAI function-calling schema
 *     audience: ['gm'],                 // 'gm' and/or 'character'
 *     run: function (args, ctx) {
 *       // args: model-supplied arguments (already JSON-parsed)
 *       // ctx:  { store, state, branchId } - branchId = the branch being answered
 *       return 'plain text result';     // or { text, record:false } to skip logging
 *     }
 *   });
 *
 * To add a tool: create js/tools/my_tool.js and add one <script> tag in
 * index.html (TOOLS section). No other changes needed.
 *
 * Results are returned to the model as tool messages and, unless record:false,
 * are also written into the branch log of the branch being answered, so dice
 * and other resolutions stay visible and auditable.
 */
window.App = window.App || {};

App.tools = (function () {
  const registry = {};

  function register(def) {
    if (!def || typeof def.name !== 'string' || !def.name) {
      throw new Error('Tool registration failed: tool needs a name.');
    }
    if (typeof def.run !== 'function') {
      throw new Error('Tool "' + def.name + '" needs a run(args, ctx) function.');
    }
    if (registry[def.name]) console.warn('Tool "' + def.name + '" re-registered (overriding).');
    registry[def.name] = {
      name: def.name,
      description: def.description || '',
      parameters: def.parameters || { type: 'object', properties: {} },
      audience: def.audience || ['gm'],
      record: def.record !== false,
      run: def.run
    };
  }

  function list() {
    return Object.keys(registry).sort().map(function (k) { return registry[k]; });
  }

  /* OpenAI-format tools array for one audience ('gm' | 'character'). */
  function forAudience(aud) {
    return list()
      .filter(function (t) { return t.audience.indexOf(aud) >= 0; })
      .map(function (t) {
        return {
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters }
        };
      });
  }

  /* Run a tool locally. Never throws — errors go back to the model as text
   * so it can correct its arguments and retry. */
  function execute(name, args, ctx) {
    const t = registry[name];
    if (!t) return { text: 'Error: unknown tool "' + name + '". Available: ' + Object.keys(registry).join(', '), record: false };
    try {
      const res = t.run(args || {}, ctx || {});
      if (typeof res === 'string') return { text: res, record: t.record };
      return { text: String((res && res.text) || ''), record: t.record && (!res || res.record !== false) };
    } catch (e) {
      return { text: 'Error in tool "' + name + '": ' + (e && e.message ? e.message : e), record: t.record };
    }
  }

  /* Human/model-readable bullet list of tools for a system prompt. */
  function summaryFor(aud) {
    return list()
      .filter(function (t) { return t.audience.indexOf(aud) >= 0; })
      .map(function (t) { return '- ' + t.name + ': ' + t.description; })
      .join('\n');
  }

  return { register: register, list: list, forAudience: forAudience, execute: execute, summaryFor: summaryFor };
})();
