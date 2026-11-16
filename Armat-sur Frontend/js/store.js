/* Armat-sur session runner — state store
 *
 * Persistence is split in two so starting/loading games never touches your setup:
 * - Global (armatsur-settings-v1): API key, model/provider prefs, rulebook.
 * - Session (armatsur-session-v1): branches, messages, session name, cumulative cost.
 * Named session saves (saves/ folder via serve.py, or Export/Import) only ever
 * contain session data.
 *
 * Message model: one canonical message map. Each message records the branch
 * it was posted to (origin); visibility is computed from origin — main is the
 * public channel everyone sees, other branches are private to that character
 * (+ the GM, whose context is the union of everything). Editing edits the
 * canonical copy -> consistent in every view. Deleting removes it everywhere.
 */
window.App = window.App || {};

App.store = (function () {
  const SETTINGS_KEY = 'armatsur-settings-v1';
  const SESSION_KEY = 'armatsur-session-v1';
  const LEGACY_KEY = 'armatsur-state-v1';
  const DEFAULT_GM_WELCOME = [
    'Welcome to Armat-sur a world simulation TTRPG-like experience! I\'ll be your Game Master or GM for short, I\'m responsible for handling the world you explore and making sure everyone plays by the rules. What those rules are is largely up to you and the provided rule book which contains the world we\'ll be playing in.',
    '',
    'You can treat this channel, or branch, as our informal line of communication. It\'s here we decide what kind of game we\'ll be playing. If you have any questions about the world or systems you can ask them here without breaking character.',
    '',
    'Armat-sur uses a system of weighted tags in order to build characters and NPCs. A tag is used to define and track their conditions and characteristics, short descriptors that form the basis for rolls which determine whether an action succeeds or fails. Tags come in four magnitudes, trivial tags denoted with # have a flat impact of 1, minor denoted with a ~ have a d3 impact, standard which lack denotation have an impact of d6, and major which are denoted with a + have an impact of d10. Some Tags are directly tied to a given magnitude but many are variable scalars that can convey relative difference between two entities that hold the same tag. Tags are invoked when relevant and can work for or against a character\'s rolls as makes sense. Tags can be inherent to a character but some come from equipment or circumstance, others can be temporary, disappearing after a few turns or upon use. The key aspect of the tag system is common sense negotiation between the characters and the GM to best reflect the simulated reality, situations are most often the culmination of many small factors and the tags should reflect that. If there is a factor that is present narratively and makes sense as a contributor during a roll but is not present already as an explicit tag, either the GM or a character can propose it, though its invocation and magnitude ultimately falls to the GM.',
    '',
    'The System Prompt button opens the editable GM and character instructions and their composed previews.',
    '',
    'If you feel you don\'t need this message feel free to delete it and save on some context! So what would you like to do first?'
  ].join('\n');

  function defaultSettings() {
    return {
      apiKey: '',
      apiService: 'openrouter', // API service; separate from OpenRouter upstream routing
      serviceProfiles: {},    // saved keys/models per service; global settings only
      theme: 'day',           // 'day' (journal) | 'night' (charcoal and gold)
      showCharacterPanel: true,
      model: '',
      charModel: '',
      temperature: 0.8,
      maxTokens: 10000,      // reply budget; reasoning tokens draw from the same pool
      autoGmReply: true,
      providerMode: 'auto',
      providerPin: '',
      providerOrder: '',
      enableTools: true,
      sendAttachments: true,  // shared reference images, stored separately in IndexedDB
      reasoning: 'medium',    // 'off' | 'low' | 'medium' | 'high' — request reasoning traces from the model
      stream: true,           // stream responses so long replies appear as they generate
      autoTurns: true,        // GM turn-order table decides who acts next automatically
      playerTurnSound: true,  // page-turn cue when an auto-chain hands control back
      maxAutoTurns: 8,        // cap on consecutive AI turns per auto-chain (cost safety)
      autoRetryDrops: 2,      // auto-retry a dropped stream this many times before surfacing the failure
      modelContext: 0,         // context length of the selected GM model (from the picker; 0 = unknown)
      charContext: 0,          // same for the character model override
      modelPricing: null,      // { prompt, completion } per-token USD for the GM model, when known
      charPricing: null,       // same for the character model override
      modelSupports: null,     // { tools, reasoning } declared by the GM model; null = unknown
      charSupports: null,      // same for the character model override
      settingsVer: 2          // settings schema version (drives one-time default migrations)
    };
  }

  function defaultSession() {
    return {
      meta: { name: 'untitled', savedAt: null },
      sessionSpend: 0,       // cumulative recorded request cost in USD, across models/runs
      gmController: 'ai',   // 'ai' | 'human'
      gmExtra: '',
      promptTemplates: { gm: null, character: null }, // null follows the built-in default
      branches: {
        main: { id: 'main', type: 'main', name: 'Main Branch (GM)', messageIds: [] },
        b_user: {
          id: 'b_user', type: 'character', name: 'user', controller: 'human',
          card: '',
          messageIds: []
        }
      },
      branchOrder: ['main', 'b_user'],
      messages: {},
      activeBranchId: 'b_user',
      awaiting: null          // branch id flagged as awaiting human input
    };
  }

  /* Accepts a session object (or a legacy full-state object) and returns a
   * clean, complete session part. */
  function migrateSession(raw) {
    const s = Object.assign(defaultSession(), raw || {});
    const templates = s.promptTemplates || {};
    s.promptTemplates = {
      gm: typeof templates.gm === 'string' ? templates.gm : null,
      character: typeof templates.character === 'string' ? templates.character : null
    };
    if (!Number.isFinite(s.sessionSpend) || s.sessionSpend < 0) s.sessionSpend = 0;
    if (!s.meta || typeof s.meta !== 'object') s.meta = { name: 'untitled', savedAt: null };
    if (!s.branches || typeof s.branches !== 'object') s.branches = {};
    if (!s.branches.main) s.branches.main = { id: 'main', type: 'main', name: 'Main Branch (GM)', messageIds: [] };
    if (!Array.isArray(s.branchOrder) || !s.branchOrder.includes('main')) {
      s.branchOrder = ['main'].concat((s.branchOrder || []).filter(function (b) { return b !== 'main'; }));
    }
    if (!s.messages || typeof s.messages !== 'object') s.messages = {};
    if (!s.branches[s.activeBranchId]) s.activeBranchId = 'main';
    delete s.settings;   // session objects never carry global config
    delete s.rulebook;
    return s;
  }

  let freshStart = false;
  let state = load();
  if (freshStart) addWelcomeMessage();

  function addWelcomeMessage() {
    addMessage({ role: 'gm', name: 'GM', origin: 'b_user', content: DEFAULT_GM_WELCOME });
  }

  function load() {
    let settings = defaultSettings();
    let rulebook = '';
    let session = defaultSession();
    let gotGlobal = false, gotSession = false;
    let savedVer = 1;   // schema version of the SAVED blob (defaults merging must not fake it)
    try {
      const g = localStorage.getItem(SETTINGS_KEY);
      if (g) {
        const p = JSON.parse(g);
        settings = Object.assign(defaultSettings(), p.settings || {});
        savedVer = (p.settings && p.settings.settingsVer) || 1;
        rulebook = p.rulebook || '';
        gotGlobal = true;
      }
    } catch (e) { console.warn('Failed to load settings:', e); }
    try {
      const s = localStorage.getItem(SESSION_KEY);
      if (s) { session = migrateSession(JSON.parse(s)); gotSession = true; }
    } catch (e) { console.warn('Failed to load session:', e); }
    // one-time migration from the legacy single-key format
    if (!gotGlobal || !gotSession) {
      try {
        const old = localStorage.getItem(LEGACY_KEY);
        if (old) {
          const p = JSON.parse(old);
          if (!gotGlobal) {
            settings = Object.assign(defaultSettings(), p.settings || {});
            rulebook = p.rulebook || '';
          }
          if (!gotSession) { session = migrateSession(p); gotSession = true; }
          // persist the migration immediately so it can't silently rerun
          localStorage.setItem(SETTINGS_KEY, JSON.stringify({ settings: settings, rulebook: rulebook }));
          localStorage.setItem(SESSION_KEY, JSON.stringify(session));
          localStorage.removeItem(LEGACY_KEY);
        }
      } catch (e) { console.warn('Legacy migration failed:', e); }
    }
    // one-time shift away from the v1 defaults (reasoning 'high' / 2000 max
    // tokens), which starved replies on reasoning models: anyone still on the
    // old defaults moves to medium / 10000. Deliberate choices survive, and
    // a settingsVer marker keeps the migration from ever re-running.
    if (savedVer < 2) {
      if (settings.reasoning === 'high') settings.reasoning = 'medium';
      if (settings.maxTokens === 2000) settings.maxTokens = 10000;
      settings.settingsVer = 2;
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify({ settings: settings, rulebook: rulebook }));
      } catch (e) { /* will re-migrate harmlessly on next load */ }
    }
    freshStart = !gotSession;
    return Object.assign({}, session, { settings: settings, rulebook: rulebook });
  }

  function sessionPart() {
    return {
      meta: state.meta,
      sessionSpend: state.sessionSpend,
      gmController: state.gmController,
      gmExtra: state.gmExtra,
      promptTemplates: state.promptTemplates,
      branches: state.branches,
      branchOrder: state.branchOrder,
      messages: state.messages,
      activeBranchId: state.activeBranchId,
      awaiting: state.awaiting
    };
  }

  function save() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ settings: state.settings, rulebook: state.rulebook }));
      localStorage.setItem(SESSION_KEY, JSON.stringify(sessionPart()));
    } catch (e) { console.warn('Failed to save state:', e); }
  }

  function get() { return state; }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 9); }

  /* Costs belong to the game, independent of model settings, messages and chains. */
  function addSessionCost(amount) {
    if (!Number.isFinite(amount) || amount <= 0) return;
    const total = state.sessionSpend + amount;
    if (!Number.isFinite(total)) return;
    state.sessionSpend = total;
    save();
  }

  /* ---------------- branches ---------------- */

  function createBranch(name, controller, card) {
    const id = 'b_' + uid();
    state.branches[id] = {
      id: id,
      type: 'character',
      name: (name || 'Character').trim() || 'Character',
      controller: controller === 'ai' ? 'ai' : 'human',
      card: card || '',
      messageIds: []
    };
    state.branchOrder.push(id);
    state.activeBranchId = id;
    save();
    return id;
  }

  function updateBranch(id, patch) {
    const b = state.branches[id];
    if (!b) return;
    Object.assign(b, patch);
    save();
  }

  /* Deleting a branch keeps its messages in the global message map, so the
   * GM's total context (which reads everything) is preserved — they simply
   * stop being visible in any branch view. Labels live on the messages. */
  function deleteBranch(id) {
    if (id === 'main' || !state.branches[id]) return;
    delete state.branches[id];
    state.branchOrder = state.branchOrder.filter(function (b) { return b !== id; });
    if (state.activeBranchId === id) state.activeBranchId = 'main';
    if (state.awaiting === id) state.awaiting = null;
    save();
  }

  /* ---------------- messages ---------------- */

  /* msg: { id, role: 'gm'|'character'|'note'|'tool', name, content, origin, ts, edited? } */
  function addMessage(opts) {
    const id = 'm_' + uid();
    const msg = {
      id: id,
      role: opts.role,
      name: opts.name || (opts.role === 'gm' ? 'GM' : '?'),
      content: opts.content || '',
      origin: opts.origin,
      ts: Date.now()
    };
    if (opts.reasoning) msg.reasoning = opts.reasoning;
    if (opts.stopped) msg.stopped = true;
    state.messages[id] = msg;
    // keep timestamps strictly increasing so chronological order is stable
    // even when several messages land in the same millisecond
    let maxTs = 0;
    Object.keys(state.messages).forEach(function (k) {
      const t = state.messages[k].ts;
      if (t > maxTs) maxTs = t;
    });
    if (msg.ts <= maxTs) msg.ts = maxTs + 1;
    const ob = state.branches[msg.origin];
    if (ob) ob.messageIds.push(id);
    // No mirroring: main is the PUBLIC channel, branches stay private.
    // GM total context is assembled at send time (gmContextMessages).
    if (state.awaiting && msg.origin === state.awaiting && msg.role === 'character') {
      state.awaiting = null;   // the awaited human has spoken
    }
    save();
    return msg;
  }

  function editMessage(id, content) {
    const m = state.messages[id];
    if (!m) return;
    m.content = content;
    delete m.contextSummary;
    m.edited = true;
    // keep the active swipe variant in sync so swiping doesn't revert the edit
    if (Array.isArray(m.swipes) && typeof m.swipeIndex === 'number' && m.swipes[m.swipeIndex]) {
      m.swipes[m.swipeIndex].c = content;
    }
    save();
  }

  /* ---------------- swipes (response variants) ----------------
   * msg.swipes = [{c, r}, ...] (content + reasoning per variant);
   * msg.content/msg.reasoning always mirror the ACTIVE variant so views and
   * prompt assembly need no changes. A message with no swipes is just a
   * single fixed response. */

  /* Store a fresh generation for this message as a new active variant. */
  function addSwipe(id, content, reasoning) {
    const m = state.messages[id];
    if (!m) return;
    if (!Array.isArray(m.swipes)) {
      m.swipes = [{ c: m.content, r: m.reasoning || null }];
      m.swipeIndex = 0;
    }
    m.swipes.push({ c: content, r: reasoning || null });
    m.swipeIndex = m.swipes.length - 1;
    m.content = content;
    delete m.contextSummary;
    if (reasoning) m.reasoning = reasoning; else delete m.reasoning;
    delete m.stopped;
    save();
  }

  /* Make an existing variant the active one. */
  function setMessageSwipe(id, index) {
    const m = state.messages[id];
    if (!m || !Array.isArray(m.swipes)) return;
    if (index < 0 || index >= m.swipes.length) return;
    m.swipeIndex = index;
    m.content = m.swipes[index].c;
    delete m.contextSummary;
    if (m.swipes[index].r) m.reasoning = m.swipes[index].r; else delete m.reasoning;
    save();
  }

  function deleteMessage(id) {
    if (!state.messages[id]) return;
    delete state.messages[id];
    Object.keys(state.branches).forEach(function (bid) {
      const b = state.branches[bid];
      b.messageIds = b.messageIds.filter(function (mid) { return mid !== id; });
    });
    save();
  }

  /* ---------------- context / visibility ----------------
   * Visibility is computed from each message's origin, not from list
   * membership, so old saves (which mirrored messages into main) behave
   * correctly: a message is public iff its origin is the main branch.
   * GM notes are operator-private and never visible to characters. */

  /* Every message in the session, chronological (includes deleted branches'
   * history — the GM's record is append-only). */
  function allMessages() {
    return Object.keys(state.messages)
      .map(function (k) { return state.messages[k]; })
      .sort(function (a, b) { return (a.ts - b.ts) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
  }

  /* What a human sees when viewing a branch:
   * - main: the public story/world record — GM messages addressed to everyone
   *   (narration, public tool results, operator notes). NOT the union of all
   *   branches; the GM's total context is assembled separately below.
   * - character branch: public main + that branch's private conversation. */
  function viewMessages(branchId) {
    if (branchId === 'main') {
      return allMessages().filter(function (m) { return m.origin === 'main'; });
    }
    return allMessages().filter(function (m) {
      return m.role !== 'note' && (m.origin === 'main' || m.origin === branchId);
    });
  }

  /* GM total context. */
  function gmContextMessages() { return allMessages(); }

  /* What an AI-controlled character is allowed to see. */
  function characterContextMessages(branchId) { return viewMessages(branchId); }

  /* The newest gm/character message in a branch view, skipping trailing
   * tool/note bookkeeping — this is the swipe/regen target. Callers apply
   * their own gates (e.g. AI-controlled branch for character messages). */
  function lastMeaningfulMessage(branchId) {
    const view = viewMessages(branchId);
    for (let i = view.length - 1; i >= 0; i--) {
      const r = view[i].role;
      if (r === 'gm' || r === 'character') return view[i];
    }
    return null;
  }

  /* ---------------- branch name resolution ----------------
   * Single source of truth for routing GM output ([[route:]]), turn-order
   * tables, and whisper recipients. Exact (case-insensitive) match wins;
   * otherwise a UNIQUE substring hit resolves; multiple substring hits are
   * reported as ambiguous so callers can refuse instead of guessing.
   * -> { id: branchId|null, ambiguous: [names] } */
  const MAIN_ALIASES = ['main', 'main branch', 'the main branch', 'public', 'narration', 'story'];

  function resolveBranch(name) {
    let q = String(name || '').trim().toLowerCase();
    if (!q) return { id: null, ambiguous: [] };
    const chars = state.branchOrder.filter(function (bid) {
      return state.branches[bid] && state.branches[bid].type === 'character';
    });
    function matching(names) {
      return {
        id: names.length === 1 ? names[0] : null,
        ambiguous: names.length > 1 ? names.map(function (bid) { return state.branches[bid].name; }) : []
      };
    }
    // Preserve actual names such as "The Watcher" or "Ashbranch" before
    // treating any part of them as a routing qualifier.
    const literal = chars.filter(function (bid) { return state.branches[bid].name.toLowerCase() === q; });
    if (q === 'main') return { id: 'main', ambiguous: [] };
    if (literal.length) return matching(literal);
    // normalize the qualifiers models like to add: quotes, "to X",
    // "X's branch", "X branch", "X's private branch", "X private"
    q = q.replace(/^["'\u201C\u201D]+|["'\u201C\u201D]+$/g, '');
    q = q.replace(/^(?:(?:to|the)\s+)+/, '');
    q = q.replace(/(?:['\u2019]s)?\s+(?:private\s+)?branch$/, '');
    q = q.replace(/\s+private$/, '');
    q = q.trim();
    if (!q) return { id: null, ambiguous: [] };
    if (MAIN_ALIASES.indexOf(q) >= 0) return { id: 'main', ambiguous: [] };
    const exact = chars.filter(function (bid) {
      return state.branches[bid].name.toLowerCase() === q;
    });
    if (exact.length) return matching(exact);
    const partial = chars.filter(function (bid) {
      return state.branches[bid].name.toLowerCase().indexOf(q) >= 0;
    });
    if (partial.length === 1) return { id: partial[0], ambiguous: [] };
    return {
      id: null,
      ambiguous: partial.map(function (bid) { return state.branches[bid].name; })
    };
  }

  /* ---------------- named sessions ---------------- */

  /* Session-only JSON (no settings, no rulebook) for saves/ files + Export. */
  function serializeSession(name) {
    const s = sessionPart();
    s.meta = Object.assign({}, s.meta, {
      name: name || state.meta.name || 'untitled',
      savedAt: Date.now()
    });
    return JSON.stringify(s, null, 1);
  }

  /* Replace the current session. Settings + rulebook stay untouched. */
  function applySession(json) {
    const parsed = typeof json === 'string' ? JSON.parse(json) : json;
    if (!parsed || typeof parsed !== 'object' || !parsed.branches || !parsed.messages) {
      throw new Error('Not a valid Armat-sur session.');
    }
    const s = migrateSession(parsed);
    if (App.actions && App.actions.stopGeneration) App.actions.stopGeneration(true);
    state = Object.assign({}, s, { settings: state.settings, rulebook: state.rulebook });
    save();
  }

  function setSessionName(name) {
    state.meta.name = (name || 'untitled').trim() || 'untitled';
    save();
  }

  /* Fresh game, keeping settings + rulebook. */
  function newSession() {
    if (App.actions && App.actions.stopGeneration) App.actions.stopGeneration(true);
    state = Object.assign({}, defaultSession(), { settings: state.settings, rulebook: state.rulebook });
    addWelcomeMessage();
  }

  /* Full wipe including settings (danger zone only). */
  function reset() {
    if (App.actions && App.actions.stopGeneration) App.actions.stopGeneration(true);
    state = Object.assign({}, defaultSession(), { settings: defaultSettings(), rulebook: '' });
    addWelcomeMessage();
  }

  return {
    defaultSettings: defaultSettings,
    get: get,
    save: save,
    addSessionCost: addSessionCost,
    createBranch: createBranch,
    updateBranch: updateBranch,
    deleteBranch: deleteBranch,
    addMessage: addMessage,
    editMessage: editMessage,
    deleteMessage: deleteMessage,
    addSwipe: addSwipe,
    setMessageSwipe: setMessageSwipe,
    allMessages: allMessages,
    viewMessages: viewMessages,
    gmContextMessages: gmContextMessages,
    characterContextMessages: characterContextMessages,
    lastMeaningfulMessage: lastMeaningfulMessage,
    resolveBranch: resolveBranch,
    serializeSession: serializeSession,
    applySession: applySession,
    setSessionName: setSessionName,
    newSession: newSession,
    reset: reset
  };
})();
