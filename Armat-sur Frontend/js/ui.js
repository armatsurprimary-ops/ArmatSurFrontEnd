/* Armat-sur session runner — DOM rendering + modals.
 * Presentational layer: reads App.store state, delegates behavior to App.actions. */
window.App = window.App || {};

App.ui = (function () {
  const $ = function (sel) { return document.querySelector(sel); };

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  /* composer drafts / role choices survive re-renders */
  const drafts = {};
  const segChoice = {};
  let busyLabel = null;
  let streamEl = null;   // live streaming bubble: { wrap, det, rBody, sum, cBody }

  /* ---------------- toast ---------------- */

  function toast(text, type) {
    const root = $('#toastRoot');
    const t = el('div', 'toast ' + (type || 'info'), text);
    root.appendChild(t);
    setTimeout(function () { t.remove(); }, 7000);
  }

  /* ---------------- busy indicator ---------------- */

  function setBusy(label) {
    busyLabel = label || null;
    document.body.classList.toggle('busy', !!busyLabel || !!streamEl);
    renderMessages();
    renderContextUsage();
  }

  /* ---------------- live stream bubble ---------------- */

  /* Start a live streaming bubble at the end of the message list. */
  function streamStart(opts) {
    streamEnd();
    const box = $('#messages');
    const wrap = el('div', 'msg role-' + (opts.role || 'gm') + ' streaming');
    const head = el('div', 'msg-head');
    head.appendChild(el('span', 'msg-name', opts.name || 'GM'));
    head.appendChild(el('span', 'msg-time', 'streaming...'));
    const spacer = el('span', 'bh-spacer');
    head.appendChild(spacer);
    const stopBtn = el('button', 'btn small danger', 'Stop');
    stopBtn.addEventListener('click', function () { App.actions.stopGeneration(); });
    head.appendChild(stopBtn);
    wrap.appendChild(head);

    const det = document.createElement('details');
    det.className = 'reasoning';
    det.hidden = true;
    det.open = true;
    const sum = document.createElement('summary');
    sum.textContent = 'reasoning';
    det.appendChild(sum);
    const rBody = el('div', 'reasoning-body');
    det.appendChild(rBody);
    wrap.appendChild(det);

    const cBody = el('div', 'msg-body', '');
    wrap.appendChild(cBody);

    box.appendChild(wrap);
    box.scrollTop = box.scrollHeight;
    streamEl = { wrap: wrap, det: det, sum: sum, rBody: rBody, cBody: cBody };
    document.body.classList.add('busy');
  }

  /* onChunk receives accumulated {content?} and/or {reasoning?}. */
  function streamChunk(p) {
    if (!streamEl) return;
    if (!streamEl.wrap.isConnected) {
      const box = $('#messages');
      if (box) box.appendChild(streamEl.wrap);   // re-attach if a re-render wiped it
    }
    if (p.reasoning != null) {
      streamEl.det.hidden = false;
      streamEl.rBody.textContent = p.reasoning;
      streamEl.sum.textContent = 'reasoning · ' + p.reasoning.length.toLocaleString() + ' chars';
    }
    if (p.content != null) {
      // hide GM control footers ([[route:]]/[[next:]]) from the live stream
      streamEl.cBody.textContent = p.content
        .replace(/\[{1,2}\s*route\s*:\s*[^\]]+?\s*\]{1,2}/gi, '')
        .replace(/\[{1,2}\s*next\s*:\s*[^\]]+?\s*\]{1,2}/gi, '');
    }
    const box = $('#messages');
    if (box && box.scrollHeight - box.scrollTop - box.clientHeight < 120) {
      box.scrollTop = box.scrollHeight;   // follow the stream unless scrolled up
    }
  }

  function streamEnd() {
    if (streamEl) {
      streamEl.wrap.remove();
      streamEl = null;
    }
    document.body.classList.toggle('busy', !!busyLabel);
  }

  /* ---------------- modal shell ---------------- */

  function openModal(opts) {
    closeModal();
    const root = $('#modalRoot');
    const backdrop = el('div', 'modal-backdrop');
    const modal = el('div', 'modal' + (opts.wide ? ' wide' : ''));
    const head = el('div', 'modal-head');
    head.appendChild(el('span', null, opts.title));
    const x = el('button', 'x', '×');
    x.addEventListener('click', closeModal);
    head.appendChild(x);
    const body = el('div', 'modal-body');
    if (opts.bodyEl) body.appendChild(opts.bodyEl);
    const actions = el('div', 'modal-actions');
    (opts.actions || []).forEach(function (a) {
      const b = el('button', 'btn ' + (a.cls || ''), a.label);
      b.addEventListener('click', function () { a.onClick && a.onClick(); });
      actions.appendChild(b);
    });
    modal.appendChild(head); modal.appendChild(body); modal.appendChild(actions);
    backdrop.appendChild(modal);
    backdrop.addEventListener('mousedown', function (e) { if (e.target === backdrop) closeModal(); });
    root.appendChild(backdrop);
    return modal;
  }

  function closeModal() { $('#modalRoot').innerHTML = ''; }

  function confirmModal(title, text, onYes) {
    const body = el('div', null, text);
    openModal({
      title: title,
      bodyEl: body,
      actions: [
        { label: 'Cancel', onClick: closeModal },
        { label: 'Confirm', cls: 'danger', onClick: function () { closeModal(); onYes(); } }
      ]
    });
  }

  /* ---------------- top bar ---------------- */

  function renderTopbar() {
    const st = App.store.get();
    App.theme.apply(st.settings.theme);
    const dot = $('#connDot'), txt = $('#connText'), lbl = $('#modelLabel'), sess = $('#sessionLabel');
    dot.className = 'dot ' + (App.ui._conn || 'unknown');
    txt.textContent = !st.settings.apiKey ? 'no key' :
      (App.ui._conn === 'ok' ? 'connected' : App.ui._conn === 'bad' ? 'connection failed' : 'key set');
    lbl.textContent = st.settings.model ? 'model: ' + st.settings.model : 'no model selected';
    if (sess) sess.textContent = 'session: ' + ((st.meta && st.meta.name) || 'untitled');
    // Planning estimates at current GM rates/context with the full reply budget.
    // Image estimates are display-only; recorded spend comes from API responses.
    const reqEl = $('#reqMaxCost'), chainEl = $('#chainMaxCost'), spendEl = $('#sessionSpend');
    [reqEl, chainEl].forEach(function (e) {
      if (!e) return;
      if (e.dataset.textTitle === undefined) e.dataset.textTitle = e.title;
      e.title = e.dataset.textTitle;
    });
    let reqMax = null;
    const refs = st.settings.sendAttachments !== false ? App.attachments.estimateTokens()
      : { count: 0, imageTokens: 0, textTokens: 0 };
    const pricing = st.settings.modelPricing;
    if (pricing && Number.isFinite(pricing.prompt) && pricing.prompt >= 0 &&
        Number.isFinite(pricing.completion) && pricing.completion >= 0) {
      const msgs = App.prompts.gmApiMessages(st, { origin: 'main' });
      const promptTok = msgs.reduce(function (t, m) { return t + App.prompts.estTokens(m.content || ''); }, 0);
      reqMax = (promptTok + refs.imageTokens + refs.textTokens) * pricing.prompt +
        (st.settings.maxTokens || 0) * pricing.completion;
    }
    const usd = function (v) { return '$' + v.toFixed(2); };
    const approximate = refs.count ? '~' : '';
    if (reqEl) reqEl.textContent = reqMax == null ? 'Req $?' : 'Req ' + approximate + usd(reqMax);
    if (chainEl) {
      chainEl.textContent = reqMax == null ? 'Chain $?'
        : 'Chain ' + approximate + usd(reqMax * (1 + (st.settings.maxAutoTurns || 0)));
    }
    if (spendEl) spendEl.textContent = 'Total ' + usd(st.sessionSpend);
    if (refs.count) {
      const imageHint = ' Includes ' + refs.count + ' reference image(s), roughly ' + refs.imageTokens.toLocaleString() +
        ' image tokens per request, plus attachment labels. Resolution-based estimate at the input-token rate; provider resizing, detail settings and separate image charges may differ. This estimate never changes Total.';
      if (reqEl) reqEl.title += imageHint;
      if (chainEl) chainEl.title += imageHint;
    }
    renderContextUsage();
  }

  function renderContextUsage() {
    const root = $('#contextUsage');
    if (!root) return;
    const st = App.store.get();
    const msgs = App.prompts.gmApiMessages(st, { origin: st.activeBranchId });
    const refs = st.settings.sendAttachments !== false ? App.attachments.estimateTokens()
      : { imageTokens: 0, textTokens: 0 };
    let tokens = msgs.reduce(function (n, m) { return n + App.prompts.estTokens(m.content); }, 0) +
      refs.imageTokens + refs.textTokens;
    if (st.settings.enableTools !== false && !(st.settings.modelSupports && st.settings.modelSupports.tools === false)) {
      tokens += App.prompts.estTokens(JSON.stringify(App.tools.forAudience('gm')));
    }
    const capacity = st.settings.modelContext > 0 ? st.settings.modelContext : 1000000;
    const level = App.compaction.level(tokens);
    const description = 'Estimated GM input context: ' + tokens.toLocaleString() + ' tokens' +
      (st.settings.modelContext > 0 ? ' / ' + capacity.toLocaleString() + ' model context window' : ' (model context window unknown; bar scale: 1,000,000 tokens)') +
      '. Includes system prompt, rulebook, cards, visible history, tool schemas and enabled images; excludes the reply budget. Text uses a rough characters/4 estimate; image estimates and provider overhead vary. Green below 300,000; yellow from 300,000 to below 600,000; red at 600,000 or more.';
    root.dataset.level = level;
    root.title = description;
    const label = $('#contextUsageLabel');
    label.textContent = 'GM context ~' + tokens.toLocaleString() + ' tokens';
    const meter = $('#contextUsageMeter');
    meter.setAttribute('aria-valuenow', tokens);
    meter.setAttribute('aria-valuemax', Math.max(tokens, capacity));
    meter.setAttribute('aria-valuetext', description);
    $('#contextUsageFill').style.width = Math.min(100, tokens / capacity * 100) + '%';
    const plan = App.compaction.plan();
    const button = $('#btnCompactContext');
    button.disabled = !!busyLabel || document.body.classList.contains('busy');
    button.title = 'Summarize older Main messages; keep the newest ten. ' + plan.active +
      ' summaries currently in use. Open to compact or restore full context.';
  }

  function openCompactionModal() {
    if (document.body.classList.contains('busy')) return;
    const session = App.store.get(), plan = App.compaction.plan();
    const body = el('div', 'compaction-explainer');
    body.appendChild(el('p', null, plan.pending.length + ' older Main messages can be summarized. ' +
      plan.active + ' already use summaries; ' + plan.brief + ' are already brief enough to keep as written.'));
    body.appendChild(el('p', null, 'Each eligible message becomes a 1–2 sentence summary in future GM and character requests. The newest ten Main entries, private conversations, GM notes, rulebook and character cards stay intact. The full original transcript remains visible and is included in session saves and exports.'));
    body.appendChild(el('p', 'compaction-warning', 'Summaries can lose details, exact wording and nuance, or introduce mistakes that affect future replies. You can restore full context here at any time, but that will not undo replies or character changes made while summaries were in use. Editing or switching a message version clears its summary.'));
    let canCompact = plan.pending.length > 0;
    if (canCompact) {
      try {
        const batches = App.compaction.batches(plan.pending, session.settings.modelContext);
        const input = batches.reduce(function (n, b) { return n + App.compaction.inputTokens(b); }, 0);
        const output = batches.reduce(function (n, b) { return n + App.compaction.outputBudget(b); }, 0);
        const price = session.settings.modelPricing;
        const priced = price && Number.isFinite(price.prompt) && price.prompt >= 0 &&
          Number.isFinite(price.completion) && price.completion >= 0;
        body.appendChild(el('p', null, 'Uses the selected GM model (' + (session.settings.model || 'none selected') +
          ') in ' + batches.length + ' request(s), with about ' + input.toLocaleString() + ' input tokens. ' +
          (priced ? 'Estimated cost with the full reply budgets: ~$' + (input * price.prompt + output * price.completion).toFixed(3) + '.' : 'Cost estimate unavailable until model pricing is known.') +
          ' Provider charges count toward session Total. References are not sent. You can stop the operation; summaries are applied only after every batch succeeds.'));
      } catch (err) {
        canCompact = false;
        body.appendChild(el('p', 'compaction-warning', err.message));
      }
    } else {
      body.appendChild(el('p', null, 'There is nothing new to compact. At least eleven Main entries are needed; messages that are already short are kept verbatim.'));
    }
    function currentSession() {
      closeModal();
      if (App.store.get() === session) return true;
      toast('The session changed. Open the compaction dialog again.', 'info');
      return false;
    }
    const actions = [{ label: 'Cancel', onClick: closeModal }];
    if (plan.stored) actions.push({ label: 'Restore Full Context', onClick: function () {
      if (currentSession()) App.actions.restoreContext();
    } });
    if (canCompact) actions.push({ label: 'Compact ' + plan.pending.length + ' Messages', cls: 'primary', onClick: function () {
      if (currentSession()) App.actions.compactContext();
    } });
    openModal({ title: 'Compact Main Context', bodyEl: body, actions: actions });
  }

  function setConn(status) { App.ui._conn = status; renderTopbar(); }

  /* ---------------- sidebar ---------------- */

  function renderSidebar() {
    const st = App.store.get();
    const list = $('#branchList');
    list.innerHTML = '';
    st.branchOrder.forEach(function (bid) {
      const b = st.branches[bid];
      if (!b) return;
      const li = el('li', (bid === st.activeBranchId ? 'active ' : '') + (b.type === 'main' ? 'main' : ''));
      li.appendChild(el('span', 'bname', b.type === 'main' ? 'Main (GM)' : b.name));
      if (b.type === 'character') {
        li.appendChild(el('span', 'ctrl-badge' + (b.controller === 'ai' ? ' ai' : ''), b.controller === 'ai' ? 'AI' : 'H'));
        if (st.awaiting === bid) li.appendChild(el('span', 'ctrl-badge awaiting', 'your turn'));
      } else {
        li.appendChild(el('span', 'count-badge', String(App.store.viewMessages('main').length)));
      }
      li.addEventListener('click', function () {
        st.activeBranchId = bid;
        App.store.save();
        renderAll();
      });
      list.appendChild(li);
    });
  }

  /* ---------------- branch header ---------------- */

  function renderBranchHeader() {
    const st = App.store.get();
    const b = st.branches[st.activeBranchId];
    const hdr = $('#branchHeader');
    hdr.innerHTML = '';
    if (!b) return;
    const heading = el('div', 'bh-heading');
    const controls = el('div', 'bh-controls');
    hdr.appendChild(heading); hdr.appendChild(controls);

    if (b.type === 'main') {
      heading.appendChild(el('span', 'bh-title gold', 'Main Branch'));
      heading.appendChild(el('span', 'bh-sub', 'story & world record · public to all characters · ' + App.store.viewMessages('main').length + ' messages'));

      const f = el('label', 'bh-field');
      f.appendChild(actionArt('controller'));
      f.appendChild(el('span', null, 'GM controlled by'));
      const sel = el('select', 'ctrl');
      sel.setAttribute('aria-label', 'GM controlled by');
      [['ai', 'AI'], ['human', 'Human']].forEach(function (pair) {
        const o = el('option', null, pair[1]); o.value = pair[0];
        if (st.gmController === pair[0]) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener('change', function () { st.gmController = sel.value; App.store.save(); renderComposer(); });
      f.appendChild(sel);
      controls.appendChild(f);

      const sysBtn = el('button', 'btn small', 'System Prompt');
      sysBtn.prepend(actionArt('gm'));
      sysBtn.addEventListener('click', function () { openSystemPromptModal('gm'); });
      controls.appendChild(sysBtn);
    } else {
      const nameEl = el('span', 'bh-title', b.name);
      nameEl.title = 'Click to rename';
      nameEl.style.cursor = 'pointer';
      nameEl.addEventListener('click', function () { openRenameModal(b); });
      heading.appendChild(nameEl);
      heading.appendChild(el('span', 'bh-sub', 'private channel with the GM · also shows public main · ' + App.store.viewMessages(b.id).length + ' messages'));

      const f = el('label', 'bh-field');
      f.appendChild(actionArt('controller'));
      f.appendChild(el('span', null, 'Controlled by'));
      const sel = el('select', 'ctrl');
      sel.setAttribute('aria-label', 'Character controlled by');
      [['human', 'Human'], ['ai', 'AI']].forEach(function (pair) {
        const o = el('option', null, pair[1]); o.value = pair[0];
        if (b.controller === pair[0]) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener('change', function () { App.store.updateBranch(b.id, { controller: sel.value }); renderAll(); });
      f.appendChild(sel);
      controls.appendChild(f);

      const cardBtn = el('button', 'btn small', 'Character Card');
      cardBtn.prepend(actionArt('character-card'));
      cardBtn.addEventListener('click', function () { openCardModal(b); });
      controls.appendChild(cardBtn);

      const sysBtn = el('button', 'btn small', 'System Prompt');
      sysBtn.prepend(actionArt('gm'));
      sysBtn.addEventListener('click', function () { openSystemPromptModal(b.id === 'b_user' ? 'gm' : 'character'); });
      controls.appendChild(sysBtn);

      const delBtn = el('button', 'btn small danger', 'Delete Branch');
      delBtn.prepend(actionArt('prune'));
      delBtn.addEventListener('click', function () {
        confirmModal(
          'Delete branch',
          'Delete the branch "' + b.name + '"? Its messages are kept in the main branch (GM context is preserved).',
          function () { App.store.deleteBranch(b.id); renderAll(); }
        );
      });
      controls.appendChild(delBtn);
    }
    const panelBtn = el('button', 'btn small panel-toggle', st.settings.showCharacterPanel ? 'Hide Card Panel' : 'Show Card Panel');
    panelBtn.prepend(actionArt(st.settings.showCharacterPanel ? 'card-panel-hide' : 'card-panel-show'));
    panelBtn.setAttribute('aria-expanded', String(!!st.settings.showCharacterPanel));
    panelBtn.setAttribute('aria-controls', 'characterPanel');
    panelBtn.addEventListener('click', function () {
      st.settings.showCharacterPanel = !st.settings.showCharacterPanel;
      App.store.save(); renderBranchHeader(); renderCharacterPanel();
    });
    controls.appendChild(panelBtn);
  }

  /* The active character is always followed. Main/operator views may inspect
   * another card without changing message visibility or model context. */
  let inspectedCharacter = null;
  function renderCharacterPanel() {
    const st = App.store.get();
    const panel = $('#characterPanel');
    const oldScroll = panel.querySelector('.card-current');
    const scroll = oldScroll ? oldScroll.scrollTop : 0;
    panel.hidden = !st.settings.showCharacterPanel;
    $('#layout').classList.toggle('with-character-panel', !panel.hidden);
    panel.innerHTML = '';
    if (panel.hidden) return;
    const head = el('div', 'card-panel-head');
    const title = el('div', 'side-title', 'Character Card');
    title.prepend(actionArt('character-card'));
    head.appendChild(title);
    panel.appendChild(head);
    const candidates = st.branchOrder.map(function (id) { return st.branches[id]; }).filter(function (b) {
      return b && b.type === 'character' && (b.id !== 'b_user' || b.card);
    });
    const active = st.branches[st.activeBranchId];
    const followsActive = candidates.some(function (b) { return b === active; });
    const branch = followsActive ? active : candidates.find(function (b) { return b.id === inspectedCharacter; }) || candidates[0];
    if (!branch) {
      panel.appendChild(el('p', 'hint', 'Create a character to keep their card and current state in view here. The user branch is your own line to the GM.'));
      return;
    }
    if (followsActive) head.appendChild(el('div', 'card-panel-name', branch.name));
    else {
      const pick = el('select', 'ctrl');
      pick.setAttribute('aria-label', 'Character to inspect');
      candidates.forEach(function (b) { const o = el('option', null, b.name); o.value = b.id; o.selected = b === branch; pick.appendChild(o); });
      pick.addEventListener('change', function () { inspectedCharacter = pick.value; renderCharacterPanel(); });
      head.appendChild(pick);
    }
    head.appendChild(el('p', 'hint', 'Current state · follows the active character. Card changes appear here as they happen.'));
    const edit = el('button', 'btn small', 'Edit Card');
    edit.addEventListener('click', function () { openCardModal(branch); });
    head.appendChild(edit);
    const card = el('div', 'card-current', branch.card || 'No card yet. Use Edit Card to add this character’s details and tags.');
    card.tabIndex = 0;
    card.setAttribute('aria-label', branch.name + ' — current character card');
    panel.appendChild(card);
    card.scrollTop = panel.dataset.branchId === branch.id ? scroll : 0;
    panel.dataset.branchId = branch.id;
  }

  function captureMessageView() {
    const box = $('#messages');
    return { session: App.store.get(), branchId: App.store.get().activeBranchId, scrollTop: box.scrollTop };
  }

  function restoreMessageView(view) {
    if (view && view.session === App.store.get() && view.branchId === App.store.get().activeBranchId) $('#messages').scrollTop = view.scrollTop;
  }

  function refreshMessageVariants() {
    const view = captureMessageView();
    const focused = document.activeElement;
    const parent = focused && focused.closest('[data-message-id]');
    const messageId = parent && parent.dataset.messageId;
    const label = focused && focused.getAttribute('aria-label');
    renderMessages(); renderTopbar();
    if (messageId && label) {
      const message = Array.from($('#messages').children).find(function (node) { return node.dataset.messageId === messageId; });
      const control = message && Array.from(message.querySelectorAll('[aria-label]')).find(function (node) { return node.getAttribute('aria-label') === label; });
      if (control) control.focus({ preventScroll: true });
    }
    restoreMessageView(view);
  }

  /* ---------------- messages ---------------- */

  function renderMessages() {
    const st = App.store.get();
    const b = st.branches[st.activeBranchId];
    const box = $('#messages');
    box.innerHTML = '';
    if (!b) return;

    const msgs = App.store.viewMessages(b.id);
    const contextText = App.compaction.contextReader();
    if (!msgs.length && !busyLabel) {
      const hint = el('div', 'empty-hint');
      if (b.type === 'main') {
        hint.innerHTML = 'The main branch is the public story and world record — GM narration addressed to everyone.<br>Play happens in the private branches; everything posted here is visible to all characters.';
      } else if (b.id === 'b_user') {
        hint.innerHTML = 'This is YOUR private channel with the GM.<br>Discuss expectations, tone, boundaries, and scenario setup here before play begins.';
      } else {
        hint.innerHTML = 'Private channel between ' + escapeHtml(b.name) + ' and the GM.<br>Public main-branch messages also appear here.';
      }
      box.appendChild(hint);
    }

    msgs.forEach(function (m) {
      const wrap = el('div', 'msg role-' + m.role);
      wrap.dataset.messageId = m.id;
      const head = el('div', 'msg-head');
      head.appendChild(el('span', 'msg-name', m.name));
      if (b.type === 'character' && m.origin === 'main') {
        head.appendChild(el('span', 'msg-tag', 'public (main)'));
      }
      head.appendChild(el('span', 'msg-time', fmtTime(m.ts)));
      if (m.edited) head.appendChild(el('span', 'msg-edited', '(edited)'));
      if (m.stopped) head.appendChild(el('span', 'msg-edited', '(stopped)'));

      const acts = el('span', 'msg-actions');
      const editB = el('button', null, 'edit');
      editB.addEventListener('click', function () { openEditMessageModal(m); });
      const delB = el('button', null, 'delete');
      delB.addEventListener('click', function () {
        confirmModal('Delete message', 'Delete this message everywhere (including the GM\'s main branch)?', function () {
          App.store.deleteMessage(m.id);
          renderAll();
        });
      });
      acts.appendChild(editB); acts.appendChild(delB);
      head.appendChild(acts);

      wrap.appendChild(head);
      if (m.reasoning) {
        const det = document.createElement('details');
        det.className = 'reasoning';
        const sum = document.createElement('summary');
        sum.textContent = 'reasoning · ' + m.reasoning.length.toLocaleString() + ' chars';
        det.appendChild(sum);
        det.appendChild(el('div', 'reasoning-body', m.reasoning));
        wrap.appendChild(det);
      }
      wrap.appendChild(el('div', 'msg-body', m.content));
      if (contextText(m) !== m.content) {
        const summary = el('details', 'context-summary');
        summary.appendChild(el('summary', null, 'Summary used in model context · original shown above'));
        summary.appendChild(el('div', 'context-summary-text', m.contextSummary.text));
        wrap.appendChild(summary);
      }

      // Revision eligibility follows the original speaker, not the branch
      // currently displaying a shared public message. Past replies work too.
      const origin = st.branches[m.origin];
      const canRegen = !!origin && (m.role === 'gm' ||
        (m.role === 'character' && origin.type === 'character' && origin.controller === 'ai'));
      const hasVariants = Array.isArray(m.swipes) && m.swipes.length > 1;
      if ((m.role === 'gm' || m.role === 'character') && (canRegen || hasVariants)) {
        const idx = typeof m.swipeIndex === 'number' ? m.swipeIndex : 0;
        const len = Array.isArray(m.swipes) ? m.swipes.length : 1;
        const row = el('div', 'msg-swipe');
        row.title = 'Text revisions only. Later replies, rolls, and current character cards stay as they are.';
        const left = el('button', 'btn small ghost swipe-arrow swipe-previous');
        left.appendChild(actionArt('swipe'));
        left.setAttribute('aria-label', 'Previous variant');
        left.disabled = !!busyLabel || !hasVariants || idx <= 0;
        left.title = 'previous variant';
        left.addEventListener('click', function () { App.actions.cycleSwipe(m.id, -1); });
        const count = el('select', 'ctrl swipe-count');
        count.setAttribute('aria-label', 'Saved reply version');
        count.disabled = !!busyLabel || !hasVariants;
        for (let v = 0; v < len; v++) {
          const opt = el('option', null, 'Version ' + (v + 1) + ' of ' + len);
          opt.value = String(v); opt.selected = v === idx; count.appendChild(opt);
        }
        count.addEventListener('change', function () { App.actions.selectSwipe(m.id, Number(count.value)); });
        const right = el('button', 'btn small ghost swipe-arrow');
        right.appendChild(actionArt('swipe'));
        right.title = idx < len - 1 ? 'next variant' : 'generate a new variant';
        right.setAttribute('aria-label', idx < len - 1 ? 'Next variant' : 'Generate a new variant');
        right.disabled = !!busyLabel || (idx >= len - 1 && !canRegen);
        right.addEventListener('click', function () {
          if (idx < len - 1) App.actions.cycleSwipe(m.id, 1);
          else if (canRegen) App.actions.regenerateMessage(m.id, null);
        });
        row.appendChild(left); row.appendChild(count); row.appendChild(right);
        if (canRegen) {
          const regenBtn = el('button', 'btn small needs-net revision-action', 'Regenerate');
          regenBtn.prepend(actionArt('regenerate'));
          regenBtn.addEventListener('click', function () { App.actions.regenerateMessage(m.id, null); });
          const noteBtn = el('button', 'btn small needs-net revision-action', 'Regen with note');
          noteBtn.prepend(actionArt('regen-note'));
          noteBtn.addEventListener('click', function () { openRegenNoteModal(m); });
          const spacer = el('span', 'bh-spacer');
          row.appendChild(spacer);
          row.appendChild(regenBtn);
          row.appendChild(noteBtn);
        }
        wrap.appendChild(row);
      }
      box.appendChild(wrap);
    });

    if (busyLabel) {
      const row = el('div', 'busy-row');
      const dots = el('span', 'busy-dots');
      dots.appendChild(el('span')); dots.appendChild(el('span')); dots.appendChild(el('span'));
      row.appendChild(dots);
      row.appendChild(el('span', null, busyLabel));
      const stopBtn = el('button', 'btn small danger', 'Stop');
      stopBtn.addEventListener('click', function () { App.actions.stopGeneration(); });
      row.appendChild(stopBtn);
      box.appendChild(row);
    }

    // Start a lone setup greeting at its beginning; ongoing chats follow the tail.
    box.scrollTop = !busyLabel && b.id === 'b_user' && msgs.length === 1 && msgs[0].role === 'gm'
      ? 0 : box.scrollHeight;
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ---------------- composer ---------------- */

  function actionArt(name) {
    const icon = el('span', 'action-art art-' + name);
    icon.setAttribute('aria-hidden', 'true');
    return icon;
  }

  function renderComposer() {
    const st = App.store.get();
    const b = st.branches[st.activeBranchId];
    const box = $('#composer');
    box.innerHTML = '';
    if (!b) return;

    const context = el('div', 'context-usage');
    context.id = 'contextUsage';
    const contextLabel = el('span', 'context-usage-label');
    contextLabel.id = 'contextUsageLabel';
    const meter = el('div', 'context-usage-meter');
    meter.id = 'contextUsageMeter';
    meter.setAttribute('role', 'meter');
    meter.setAttribute('aria-label', 'Estimated GM context tokens');
    meter.setAttribute('aria-valuemin', '0');
    const fill = el('span', 'context-usage-fill');
    fill.id = 'contextUsageFill';
    meter.appendChild(fill);
    const compact = el('button', 'btn small', 'Compact');
    compact.id = 'btnCompactContext';
    compact.addEventListener('click', openCompactionModal);
    context.appendChild(contextLabel); context.appendChild(meter); context.appendChild(compact);
    box.appendChild(context);
    renderContextUsage();

    const row = el('div', 'comp-row');
    const seg = el('span', 'seg' + (b.type === 'main' ? ' gold' : ''));
    const segKey = b.id;

    if (b.type === 'character') {
      if (!segChoice[segKey]) segChoice[segKey] = 'character';
      [['character', 'as ' + b.name], ['gm', 'as GM']].forEach(function (pair) {
        const btn = el('button', segChoice[segKey] === pair[0] ? 'on' : '', pair[1]);
        btn.addEventListener('click', function () { segChoice[segKey] = pair[0]; renderComposer(); });
        seg.appendChild(btn);
      });
    } else {
      if (!segChoice[segKey]) segChoice[segKey] = 'gm';
      [['gm', 'GM text'], ['note', 'GM note (OOC)']].forEach(function (pair) {
        const btn = el('button', segChoice[segKey] === pair[0] ? 'on' : '', pair[1]);
        btn.addEventListener('click', function () { segChoice[segKey] = pair[0]; renderComposer(); });
        seg.appendChild(btn);
      });
    }
    row.appendChild(seg);
    box.appendChild(row);

    const ta = el('textarea');
    ta.value = drafts[b.id] || '';
    ta.placeholder = b.type === 'main'
      ? (segChoice[segKey] === 'note' ? 'Out-of-character note to the GM...' : 'GM narration (stays in main branch only)...')
      : (segChoice[segKey] === 'gm' ? 'Speak to ' + b.name + ' as the GM...' : 'What does ' + b.name + ' say or do?');
    ta.addEventListener('input', function () { drafts[b.id] = ta.value; });
    ta.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); App.actions.sendComposed(); }
    });
    box.appendChild(ta);

    const actions = el('div', 'comp-actions');
    const sendBtn = el('button', 'btn primary send-btn composer-action');
    sendBtn.appendChild(actionArt('send'));
    const spinner = el('span', 'send-spinner');
    const sendLabel = el('span', 'send-label', b.type === 'main' ? 'Add to Main' : 'Send');
    sendBtn.appendChild(spinner);
    sendBtn.appendChild(sendLabel);
    sendBtn.addEventListener('click', function () { App.actions.sendComposed(); });
    actions.appendChild(sendBtn);

    if (b.type === 'character' && b.controller === 'ai') {
      const genBtn = el('button', 'btn teal needs-net composer-action', 'AI: ' + b.name + ' speaks');
      genBtn.prepend(actionArt('character'));
      genBtn.addEventListener('click', function () { App.actions.generateCharacter(b.id); });
      actions.appendChild(genBtn);
    }
    if (st.gmController === 'ai') {
      const gmBtn = el('button', 'btn needs-net composer-action', b.type === 'main' ? 'AI: GM continues' : 'AI: GM replies');
      gmBtn.prepend(actionArt('gm'));
      gmBtn.addEventListener('click', function () { App.actions.gmReply(b.type === 'main' ? 'main' : b.id); });
      actions.appendChild(gmBtn);
    }

    actions.appendChild(el('span', 'comp-hint', 'Ctrl+Enter to send'));
    box.appendChild(actions);
    App.ui._composerTa = ta;
  }

  function getDraft(branchId) { return drafts[branchId] || ''; }
  function clearDraft(branchId) { drafts[branchId] = ''; }
  function getSeg(branchId) { return segChoice[branchId]; }

  /* ---------------- specific modals ---------------- */

  function openNewBranchModal() {
    const wrap = el('div');
    const f1 = el('div', 'field');
    f1.appendChild(el('label', null, 'Character name'));
    const nameIn = el('input', 'txt'); nameIn.placeholder = 'e.g. Wulta Breadbreaker';
    f1.appendChild(nameIn);
    wrap.appendChild(f1);

    const f2 = el('div', 'field');
    f2.appendChild(el('label', null, 'Controlled by'));
    const sel = el('select', 'ctrl');
    [['human', 'Human — you write their messages'], ['ai', 'AI — generated via the selected API service']].forEach(function (pair) {
      const o = el('option', null, pair[1]); o.value = pair[0]; sel.appendChild(o);
    });
    f2.appendChild(sel);
    wrap.appendChild(f2);

    const f3 = el('div', 'field');
    const lbl = el('label', null, 'Character card (Armat-sur format)');
    f3.appendChild(lbl);
    const cardTa = el('textarea', 'area');
    cardTa.value = App.prompts.CARD_TEMPLATE;
    cardTa.rows = 10;
    f3.appendChild(cardTa);
    f3.appendChild(el('div', 'hint', 'You can edit this later from the branch header.'));
    wrap.appendChild(f3);

    openModal({
      title: 'New character branch',
      bodyEl: wrap,
      actions: [
        { label: 'Cancel', onClick: closeModal },
        {
          label: 'Create', cls: 'primary', onClick: function () {
            const id = App.store.createBranch(nameIn.value, sel.value, cardTa.value);
            closeModal();
            renderAll();
          }
        }
      ]
    });
    nameIn.focus();
  }

  function openRenameModal(branch) {
    const wrap = el('div');
    const f = el('div', 'field');
    f.appendChild(el('label', null, 'Branch name'));
    const inp = el('input', 'txt'); inp.value = branch.name;
    f.appendChild(inp);
    wrap.appendChild(f);
    openModal({
      title: 'Rename branch',
      bodyEl: wrap,
      actions: [
        { label: 'Cancel', onClick: closeModal },
        {
          label: 'Save', cls: 'primary', onClick: function () {
            App.store.updateBranch(branch.id, { name: inp.value.trim() || branch.name });
            closeModal(); renderAll();
          }
        }
      ]
    });
    inp.focus();
  }

  function openCardModal(branch) {
    const wrap = el('div');
    const f = el('div', 'field');
    f.appendChild(el('label', null, 'Character card — included in the GM roster and (for AI control) the character system prompt.'));
    const ta = el('textarea', 'area');
    ta.value = branch.card || App.prompts.CARD_TEMPLATE;
    ta.rows = 14;
    f.appendChild(ta);
    wrap.appendChild(f);
    openModal({
      title: 'Character Card — ' + branch.name,
      bodyEl: wrap,
      wide: true,
      actions: [
        { label: 'Cancel', onClick: closeModal },
        {
          label: 'Save', cls: 'primary', onClick: function () {
            App.store.updateBranch(branch.id, { card: ta.value });
            closeModal(); renderCharacterPanel(); renderTopbar(); toast('Card saved.', 'info');
          }
        }
      ]
    });
  }

  /* Direction note for a one-shot regeneration. The note is passed to the
   * request only — it is never written to the session. */
  function openRegenNoteModal(msg) {
    const wrap = el('div');
    const f = el('div', 'field');
    f.appendChild(el('label', null, 'Direction for the regenerated reply — this note goes out with this single request only and is never saved to the session.'));
    const ta = el('textarea', 'area');
    ta.rows = 4;
    ta.placeholder = 'e.g. Less flowery; the guard refuses the bribe outright and calls for his sergeant...';
    f.appendChild(ta);
    wrap.appendChild(f);
    openModal({
      title: 'Regenerate with direction',
      bodyEl: wrap,
      actions: [
        { label: 'Cancel', onClick: closeModal },
        {
          label: 'Regenerate', cls: 'primary', onClick: function () {
            closeModal();
            App.actions.regenerateMessage(msg.id, ta.value);
          }
        }
      ]
    });
    ta.focus();
  }

  function openEditMessageModal(msg) {
    const wrap = el('div');
    const f = el('div', 'field');
    f.appendChild(el('label', null, 'Editing a message from "' + msg.name + '" — changes apply everywhere this message appears (branch + main).'));
    const ta = el('textarea', 'area');
    ta.value = msg.content;
    ta.rows = 12;
    f.appendChild(ta);
    wrap.appendChild(f);
    openModal({
      title: 'Edit message',
      bodyEl: wrap,
      wide: true,
      actions: [
        { label: 'Cancel', onClick: closeModal },
        {
          label: 'Save', cls: 'primary', onClick: function () {
            App.store.editMessage(msg.id, ta.value);
            closeModal(); renderAll();
          }
        }
      ]
    });
    ta.focus();
  }

  function openSystemPromptModal(initialAudience) {
    const st = App.store.get();
    const wrap = el('div', 'prompt-editor');
    let audience = initialAudience === 'character' ? 'character' : 'gm';
    const drafts = { gm: App.prompts.templateFor(st, 'gm'), character: App.prompts.templateFor(st, 'character') };
    wrap.appendChild(el('p', 'hint', 'Edit the complete system templates for this session. Live inserts pull in the latest rulebook, cards, and tool descriptions each request. Move or remove them as needed. Changes to routing instructions can affect branch delivery.'));
    const controls = el('div', 'prompt-controls');
    const audienceSelect = el('select', 'ctrl');
    audienceSelect.setAttribute('aria-label', 'System prompt audience');
    [['gm', 'Game Master'], ['character', 'AI Characters']].forEach(function (pair) {
      const o = el('option', null, pair[1]); o.value = pair[0]; audienceSelect.appendChild(o);
    });
    audienceSelect.value = audience;
    controls.appendChild(audienceSelect);
    const characterSelect = el('select', 'ctrl');
    characterSelect.setAttribute('aria-label', 'Character prompt preview');
    st.branchOrder.forEach(function (id) {
      const b = st.branches[id];
      if (!b || b.type !== 'character') return;
      const o = el('option', null, b.name); o.value = id; characterSelect.appendChild(o);
    });
    if (st.branches[st.activeBranchId].type === 'character') characterSelect.value = st.activeBranchId;
    controls.appendChild(characterSelect);
    const reset = el('button', 'btn small', 'Restore Default Template');
    controls.appendChild(reset);
    wrap.appendChild(controls);
    const f = el('div', 'field');
    const label = el('label', null, 'Editable system prompt template');
    label.htmlFor = 'systemTemplate'; f.appendChild(label);
    const ta = el('textarea', 'area prompt-source');
    ta.id = 'systemTemplate'; ta.rows = 17; ta.spellcheck = false;
    f.appendChild(ta); wrap.appendChild(f);
    const inserts = el('div', 'prompt-inserts');
    wrap.appendChild(inserts);
    const extraField = el('div', 'field');
    const extraLabel = el('label', null, 'Extra GM instructions / scenario (inserted by {{gm_instructions}})');
    extraLabel.htmlFor = 'gmExtra'; extraField.appendChild(extraLabel);
    const extra = el('textarea', 'area'); extra.id = 'gmExtra'; extra.rows = 3; extra.value = st.gmExtra || '';
    extraField.appendChild(extra); wrap.appendChild(extraField);
    const status = el('p', 'hint'); status.setAttribute('role', 'status'); wrap.appendChild(status);
    const details = el('details', 'prompt-preview'); details.open = true;
    details.appendChild(el('summary', null, 'Composed system prompt — live preview'));
    const prev = el('pre', 'mono-preview'); prev.tabIndex = 0; details.appendChild(prev); wrap.appendChild(details);
    const engine = el('details', 'prompt-preview');
    engine.appendChild(el('summary', null, 'Other request instructions'));
    engine.appendChild(el('p', 'hint', 'Conversation history, enabled reference images, tool schemas, and per-turn engine cues are sent separately from the system prompt. Templates do not change tool permissions or which private branches a character can see. These engine cues still apply:'));
    const cues = el('pre', 'mono-preview'); engine.appendChild(cues); wrap.appendChild(engine);
    wrap.appendChild(el('p', 'hint', 'Saved with the session. Cancel discards these edits. Built-in templates are also backed up in SYSTEM-PROMPT-DEFAULTS.txt beside the app.'));

    function preview() {
      drafts[audience] = ta.value;
      const state = Object.assign({}, st, { promptTemplates: drafts, gmExtra: extra.value });
      const branch = st.branches[characterSelect.value] || { id: '', name: 'Example character', card: '' };
      prev.textContent = audience === 'gm' ? App.prompts.gmSystem(state) : App.prompts.characterSystem(state, branch);
      const error = App.prompts.validateTemplate(ta.value, audience);
      const omitted = App.prompts.inserts[audience].filter(function (key) {
        return !(new RegExp('\\{\\{\\s*' + key + '\\s*\\}\\}')).test(ta.value);
      });
      status.textContent = error || ('~' + App.prompts.estTokens(prev.textContent).toLocaleString() + ' system tokens.' +
        (omitted.length ? ' Omitted live inserts: ' + omitted.join(', ') + '. Their contents will not be included automatically.' : ' All live inserts included.'));
      const gmCue = audience === 'gm' ? App.prompts.gmApiMessages(state, { origin: st.activeBranchId }).slice(-1)[0].content + '\n\n' : '';
      cues.textContent = gmCue + App.prompts.regenerationInstruction(state, audience === 'gm' ? st.activeBranchId : branch.id, audience);
    }
    function showAudience() {
      ta.value = drafts[audience];
      characterSelect.hidden = audience !== 'character';
      extraField.hidden = audience !== 'gm';
      inserts.innerHTML = '';
      inserts.appendChild(el('span', 'hint', 'Insert at cursor:'));
      App.prompts.inserts[audience].forEach(function (key) {
        const b = el('button', 'btn small', '{{' + key + '}}');
        b.addEventListener('click', function () {
          ta.setRangeText('{{' + key + '}}', ta.selectionStart, ta.selectionEnd, 'end');
          ta.focus(); preview();
        });
        inserts.appendChild(b);
      });
      preview();
    }
    audienceSelect.addEventListener('change', function () { drafts[audience] = ta.value; audience = audienceSelect.value; showAudience(); });
    characterSelect.addEventListener('change', preview);
    reset.addEventListener('click', function () { drafts[audience] = App.prompts.defaultTemplate(audience); showAudience(); });
    ta.addEventListener('input', preview); extra.addEventListener('input', preview);
    showAudience();
    openModal({
      title: 'System Prompt Workshop',
      bodyEl: wrap,
      wide: true,
      actions: [
        { label: 'Cancel', onClick: closeModal },
        {
          label: 'Save', cls: 'primary', onClick: function () {
            if (st !== App.store.get()) { closeModal(); return; }
            drafts[audience] = ta.value;
            const error = App.prompts.validateTemplate(drafts.gm, 'gm') || App.prompts.validateTemplate(drafts.character, 'character');
            if (error) { toast(error, 'error'); return; }
            st.promptTemplates = {
              gm: drafts.gm === App.prompts.defaultTemplate('gm') ? null : drafts.gm,
              character: drafts.character === App.prompts.defaultTemplate('character') ? null : drafts.character
            };
            st.gmExtra = extra.value;
            App.store.save();
            closeModal(); renderTopbar(); toast('System prompts saved for this session.', 'info');
          }
        }
      ]
    });
  }

  /* ---- diagnostics ---- */

  /* The failure/crash log recorded by js/diag.js — every request failure,
   * retry, dropped stream, tool error, and page crash, with stacks. */
  function openDiagModal() {
    const wrap = el('div');

    const info = el('div', 'hint',
      'Everything below is recorded locally (never leaves this machine unless you download it). ' +
      'The log survives reloads; message contents are never included — only errors, shapes, and stacks.');
    info.style.marginBottom = '10px';
    wrap.appendChild(info);

    const preview = el('div', 'mono-preview', App.diag.exportText());
    wrap.appendChild(preview);

    openModal({
      title: 'Diagnostics log (' + App.diag.list().length + ' entries)',
      bodyEl: wrap,
      wide: true,
      actions: [
        {
          label: 'Download', onClick: function () {
            const blob = new Blob([App.diag.exportText()], { type: 'text/plain' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'armatsur-diagnostics-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.txt';
            a.click();
            setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
          }
        },
        {
          label: 'Clear', cls: 'danger', onClick: function () {
            App.diag.clear();
            closeModal();
            openDiagModal();
          }
        },
        { label: 'Close', onClick: closeModal }
      ]
    });
  }

  function openSettingsModal() {
    const st = App.store.get();
    const wrap = el('div');
    let service = st.settings.apiService || 'openrouter';
    let modelCache = [];
    let requestVersion = 0;
    const profileFields = ['apiKey', 'model', 'charModel', 'modelContext', 'charContext',
      'modelPricing', 'charPricing', 'modelSupports', 'charSupports', 'providerMode', 'providerPin', 'providerOrder'];
    function profile(source) {
      const out = {}, defaults = App.store.defaultSettings();
      profileFields.forEach(function (key) { out[key] = source[key] === undefined ? defaults[key] : source[key]; });
      return out;
    }
    const drafts = {};
    ['openrouter', 'abliteration'].forEach(function (id) {
      drafts[id] = profile((st.settings.serviceProfiles || {})[id] || {});
    });
    drafts[service] = profile(st.settings);
    const fService = el('div', 'field');
    fService.appendChild(el('label', null, 'API service'));
    const serviceSel = el('select', 'ctrl'); serviceSel.setAttribute('aria-label', 'API service');
    ['openrouter', 'abliteration'].forEach(function (id) {
      const option = el('option', null, App.api.serviceInfo(id).name); option.value = id;
      serviceSel.appendChild(option);
    });
    serviceSel.value = service; fService.appendChild(serviceSel);
    const serviceHint = el('div', 'hint'); fService.appendChild(serviceHint); wrap.appendChild(fService);

    /* ---- API key ---- */
    const fKey = el('div', 'field');
    const keyLabel = el('label'); fKey.appendChild(keyLabel);
    const keyIn = el('input', 'txt'); keyIn.type = 'password'; keyIn.value = st.settings.apiKey || '';
    fKey.appendChild(keyIn);
    wrap.appendChild(fKey);

    const fFetch = el('div', 'field');
    const fetchBtn = el('button', 'btn small', 'Fetch model list / test connection');
    const fetchStatus = el('span', 'hint'); fetchStatus.style.marginLeft = '10px';
    fFetch.appendChild(fetchBtn); fFetch.appendChild(fetchStatus);
    wrap.appendChild(fFetch);

    /* ---- model pickers: filterable dropdown (name + id + context) plus a
       manual-id input so a model can be set even without the fetched list ---- */
    function modelPicker(currentValue, hintText, allowBlank) {
      let selectedValue = currentValue || '';
      const f = el('div', 'field');
      f.appendChild(el('label', null, allowBlank ? 'Character model' : 'GM model'));
      const sel = el('select', 'ctrl model-select');
      f.appendChild(sel);
      const filter = el('input', 'txt'); filter.placeholder = 'Type to filter the model list...';
      f.appendChild(filter);
      const manual = el('input', 'txt');
      manual.placeholder = 'Model id — manual entry (leave blank to use the dropdown)';
      f.appendChild(manual);
      if (hintText) f.appendChild(el('div', 'hint', hintText));
      filter.addEventListener('input', function () { rebuild(); });
      sel.addEventListener('change', function () { selectedValue = sel.value; manual.value = ''; });
      manual.addEventListener('input', function () {
        selectedValue = manual.value.trim();
        rebuild();
      });
      function optionValues() {
        return Array.prototype.map.call(sel.options, function (o) { return o.value; });
      }
      function rebuild() {
        const q = filter.value.trim().toLowerCase();
        sel.innerHTML = '';
        const blank = document.createElement('option');
        blank.value = '';
        blank.textContent = allowBlank ? '(same as GM model)' : '(select a model)';
        sel.appendChild(blank);
        modelCache
          .filter(function (m) {
            return !q || m.id.toLowerCase().indexOf(q) >= 0 || m.name.toLowerCase().indexOf(q) >= 0;
          })
          .slice(0, 400)
          .forEach(function (m) {
            const o = document.createElement('option');
            o.value = m.id;
            o.textContent = m.name + '  [' + m.id + ']' +
              (m.context ? '  ·  ' + (m.context / 1000).toFixed(0) + 'k ctx' : '') +
              (m.supports && m.supports.images === true ? ' · images' : '');
            sel.appendChild(o);
          });
        if (!modelCache.length) {
          const o = document.createElement('option');
          o.textContent = 'no model list loaded — fetch it above, or type an id below:';
          o.disabled = true;
          sel.appendChild(o);
        }
        // Filtering changes the choices, never the user's current selection.
        if (selectedValue && optionValues().indexOf(selectedValue) < 0) {
          const selected = document.createElement('option');
          selected.value = selectedValue;
          selected.textContent = selectedValue + ' (selected)';
          sel.appendChild(selected);
        }
        sel.value = selectedValue;
      }
      rebuild();
      const api = {
        field: f,
        get value() { return selectedValue; },
        setValue: function (value) { selectedValue = value || ''; manual.value = ''; filter.value = ''; rebuild(); },
        rebuild: rebuild
      };
      return api;
    }

    const frow = el('div', 'field-row');
    const gmPick = modelPicker(st.settings.model, 'The GM sees the full rulebook — prefer a large-context model.', false);
    frow.appendChild(gmPick.field);
    const charPick = modelPicker(st.settings.charModel, 'Optional override for AI-controlled characters.', true);
    frow.appendChild(charPick.field);
    wrap.appendChild(frow);

    fetchBtn.addEventListener('click', function () {
      const version = ++requestVersion, requestedKey = keyIn.value.trim();
      fetchStatus.textContent = ' contacting ' + App.api.serviceInfo(service).name + '...';
      App.api.listModels(requestedKey, service).then(function (models) {
        if (version !== requestVersion || requestedKey !== keyIn.value.trim() || !wrap.isConnected) return;
        modelCache = models;
        fetchStatus.textContent = ' OK — ' + models.length + ' models available. Pick below (selections kept).';
        App.ui.setConn('ok');
        gmPick.rebuild();
        charPick.rebuild();
      }).catch(function (err) {
        if (version !== requestVersion || requestedKey !== keyIn.value.trim() || !wrap.isConnected) return;
        fetchStatus.textContent = ' Failed: ' + err.message;
        App.ui.setConn('bad');
      });
    });

    /* ---- provider routing ---- */
    const fProv = el('div', 'field prov-block');
    fProv.appendChild(el('label', null, 'Provider routing (only matters when a model is served by several upstream providers)'));
    const modeRow = el('div', 'comp-row');
    const modeSel = el('select', 'ctrl');
    [['auto', 'Auto — let OpenRouter choose (default, cheapest-first)'],
     ['pin', 'Pin — only use one specific provider'],
     ['order', 'Order — try providers in the order listed']].forEach(function (pair) {
      const o = el('option', null, pair[1]); o.value = pair[0];
      if (st.settings.providerMode === pair[0]) o.selected = true;
      modeSel.appendChild(o);
    });
    modeRow.appendChild(modeSel);
    const loadProvBtn = el('button', 'btn small', 'List providers for GM model');
    modeRow.appendChild(loadProvBtn);
    fProv.appendChild(modeRow);

    const provDetail = el('div', 'prov-detail');
    fProv.appendChild(provDetail);
    const pinIn = el('input', 'txt');
    pinIn.id = 'provPin'; pinIn.value = st.settings.providerPin || '';
    pinIn.placeholder = 'Provider name';
    pinIn.setAttribute('aria-label', 'Pinned provider');
    const ordIn = el('input', 'txt');
    ordIn.id = 'provOrder'; ordIn.value = st.settings.providerOrder || '';
    ordIn.placeholder = 'Comma-separated provider order';
    ordIn.setAttribute('aria-label', 'Provider order');
    const provHint = el('div', 'hint');
    provDetail.appendChild(pinIn); provDetail.appendChild(ordIn); provDetail.appendChild(provHint);
    const provResults = el('div', 'prov-list');
    fProv.appendChild(provResults);
    wrap.appendChild(fProv);

    function renderProvDetail() {
      const mode = modeSel.value;
      pinIn.hidden = mode !== 'pin';
      ordIn.hidden = mode !== 'order';
      if (mode === 'auto') {
        provHint.textContent = 'OpenRouter picks the provider automatically. Use "List providers" to inspect the options.';
      } else if (mode === 'pin') {
        provHint.textContent = 'Requests fail if this provider cannot serve the model.';
      } else {
        provHint.textContent = 'OpenRouter tries them in order; other providers remain as fallback.';
      }
    }
    modeSel.addEventListener('change', renderProvDetail);
    renderProvDetail();

    loadProvBtn.addEventListener('click', function () {
      if (service !== 'openrouter') return;
      const version = requestVersion;
      const modelId = gmPick.value;
      if (!modelId) { provResults.textContent = 'Pick a GM model first.'; return; }
      provResults.textContent = 'Loading providers...';
      App.api.listEndpoints(keyIn.value.trim(), modelId).then(function (eps) {
        if (service !== 'openrouter' || version !== requestVersion || !wrap.isConnected) return;
        if (gmPick.value !== modelId) { provResults.textContent = 'Model changed; list providers again.'; return; }
        provResults.innerHTML = '';
        if (!eps.length) { provResults.textContent = 'No provider info returned for this model.'; return; }
        const list = el('div', 'prov-list');
        eps.forEach(function (ep) {
          const row = el('div', 'prov-row');
          const btn = el('button', 'btn small', ep.provider_name || ep.name || '?');
          const q = ep.quantization && ep.quantization !== 'unknown' ? ' · ' + ep.quantization : '';
          const mctx = ep.max_completion_tokens ? ' · max out ' + (ep.max_completion_tokens / 1000).toFixed(0) + 'k' : '';
          btn.title = (ep.provider_name || '') + q + mctx;
          btn.addEventListener('click', function () {
            if (modeSel.value === 'order') {
              const names = ordIn.value.split(',').map(function (name) { return name.trim(); }).filter(Boolean);
              const name = ep.provider_name || ep.name;
              if (name && names.indexOf(name) < 0) names.push(name);
              ordIn.value = names.join(', ');
            } else {
              modeSel.value = 'pin'; renderProvDetail();
              pinIn.value = ep.provider_name || ep.name || '';
            }
          });
          row.appendChild(btn);
          row.appendChild(el('span', 'hint', (q + mctx).replace(/^ · /, '')));
          list.appendChild(row);
        });
        provResults.appendChild(list);
        provResults.appendChild(el('div', 'hint', 'Click a provider to pin it (or append to the order list).'));
      }).catch(function (err) {
        if (service !== 'openrouter' || version !== requestVersion || !wrap.isConnected) return;
        provResults.textContent = 'Failed: ' + err.message;
      });
    });

    function captureProfile() {
      const out = profile(drafts[service]);
      out.apiKey = keyIn.value.trim();
      [['model', gmPick, 'model'], ['charModel', charPick, 'char']].forEach(function (entry) {
        const key = entry[0], value = entry[1].value, prefix = entry[2];
        const picked = modelCache.find(function (m) { return m.id === value; });
        if (picked || value !== out[key]) {
          out[prefix + 'Context'] = picked && picked.context || 0;
          out[prefix + 'Pricing'] = picked && picked.pricing || null;
          out[prefix + 'Supports'] = picked && picked.supports || null;
        }
        out[key] = value;
      });
      out.providerMode = modeSel.value; out.providerPin = pinIn.value.trim(); out.providerOrder = ordIn.value.trim();
      drafts[service] = out;
      return out;
    }
    function renderService() {
      keyLabel.textContent = App.api.serviceInfo(service).name + ' API key (stored only in this browser\'s localStorage)';
      keyIn.setAttribute('aria-label', App.api.serviceInfo(service).name + ' API key');
      fProv.hidden = service !== 'openrouter';
      serviceHint.textContent = service === 'abliteration'
        ? 'Uses the Armat-sur local server. Fetch your available models or enter an exact API model ID. Image support and context limits depend on the model; missing metadata remains unknown.'
        : 'Connects directly to OpenRouter. Each service remembers its own key and model selections.';
    }
    serviceSel.addEventListener('change', function () {
      captureProfile(); service = serviceSel.value; ++requestVersion; modelCache = [];
      const draft = drafts[service]; keyIn.value = draft.apiKey;
      gmPick.setValue(draft.model); charPick.setValue(draft.charModel);
      modeSel.value = draft.providerMode; pinIn.value = draft.providerPin; ordIn.value = draft.providerOrder;
      fetchStatus.textContent = ''; provResults.textContent = ''; renderProvDetail(); renderService();
    });
    renderService();

    /* ---- generation ---- */
    const frow2 = el('div', 'field-row');
    const fT = el('div', 'field');
    fT.appendChild(el('label', null, 'Temperature'));
    const tIn = el('input', 'txt'); tIn.type = 'number'; tIn.step = '0.01'; tIn.min = '0'; tIn.max = '2'; tIn.value = st.settings.temperature;
    fT.appendChild(tIn);
    frow2.appendChild(fT);
    const fM = el('div', 'field');
    fM.appendChild(el('label', null, 'Max tokens per reply'));
    const mIn = el('input', 'txt'); mIn.type = 'number'; mIn.step = '100'; mIn.min = '100'; mIn.value = st.settings.maxTokens;
    fM.appendChild(mIn);
    fM.appendChild(el('div', 'hint', 'Covers reasoning too — reasoning models draw their thinking from this same budget, so keep headroom or replies come back empty.'));
    frow2.appendChild(fM);
    wrap.appendChild(frow2);

    const fAuto = el('div', 'field check-row');
    const autoCb = document.createElement('input'); autoCb.type = 'checkbox'; autoCb.checked = !!st.settings.autoGmReply;
    fAuto.appendChild(autoCb);
    fAuto.appendChild(el('span', null, 'Automatically request a GM reply after a character message is sent'));
    wrap.appendChild(fAuto);

    const fTools = el('div', 'field check-row');
    const toolsCb = document.createElement('input'); toolsCb.type = 'checkbox';
    toolsCb.checked = st.settings.enableTools !== false;
    fTools.appendChild(toolsCb);
    fTools.appendChild(el('span', null, 'Enable tools (function calling: roll resolver, character creator, anything in js/tools/)'));
    wrap.appendChild(fTools);

    const fReason = el('div', 'field');
    fReason.appendChild(el('label', null, 'Request reasoning (model "thinking"; returned traces shown in a collapsible block on replies)'));
    const rSel = el('select', 'ctrl');
    [['off', 'Off'], ['low', 'Low'], ['medium', 'Medium (default)'], ['high', 'High']].forEach(function (pair) {
      const o = el('option', null, pair[1]); o.value = pair[0];
      if ((st.settings.reasoning || 'medium') === pair[0]) o.selected = true;
      rSel.appendChild(o);
    });
    fReason.appendChild(rSel);
    fReason.appendChild(el('div', 'hint', 'Only models with reasoning support return traces. Adds tokens and latency; the trace is also printed in the server window.'));
    wrap.appendChild(fReason);

    const fStream = el('div', 'field check-row');
    const streamCb = document.createElement('input'); streamCb.type = 'checkbox';
    streamCb.checked = st.settings.stream !== false;
    fStream.appendChild(streamCb);
    fStream.appendChild(el('span', null, 'Stream responses (show text as it generates, with a Stop button)'));
    wrap.appendChild(fStream);

    /* ---- auto turn order ---- */
    const fAutoTurns = el('div', 'field check-row');
    const autoTurnCb = document.createElement('input'); autoTurnCb.type = 'checkbox';
    autoTurnCb.checked = st.settings.autoTurns !== false;
    fAutoTurns.appendChild(autoTurnCb);
    fAutoTurns.appendChild(el('span', null, 'Auto turn order (GM ends replies with a routing + who-goes-next probability table; the engine rolls it)'));
    wrap.appendChild(fAutoTurns);

    const fTurnSound = el('div', 'field check-row');
    const soundLabel = el('label', 'check-row');
    const soundCb = document.createElement('input'); soundCb.type = 'checkbox';
    soundCb.checked = st.settings.playerTurnSound !== false;
    soundLabel.appendChild(soundCb);
    soundLabel.appendChild(document.createTextNode('Play a page-turn sound when control returns to you'));
    fTurnSound.appendChild(soundLabel);
    const previewSound = el('button', 'btn small', 'Preview sound');
    previewSound.addEventListener('click', function () {
      App.sound.preview().then(function (played) {
        if (!played) toast('Audio is unavailable or blocked by this browser.', 'info');
      });
    });
    fTurnSound.appendChild(previewSound);
    wrap.appendChild(fTurnSound);

    const fMaxRow = el('div', 'field-row');
    const fMax = el('div', 'field');
    fMax.appendChild(el('label', null, 'Max consecutive AI turns per auto-chain'));
    const maxIn = el('input', 'txt'); maxIn.type = 'number'; maxIn.step = '1'; maxIn.min = '0'; maxIn.value = st.settings.maxAutoTurns == null ? 8 : st.settings.maxAutoTurns;
    fMax.appendChild(maxIn);
    fMax.appendChild(el('div', 'hint', 'Safety cap so a runaway chain cannot burn credits. Any input from you resets it.'));
    fMaxRow.appendChild(fMax);

    const fRetry = el('div', 'field');
    fRetry.appendChild(el('label', null, 'Auto-retry dropped connections'));
    const retryIn = el('input', 'txt'); retryIn.type = 'number'; retryIn.step = '1'; retryIn.min = '0'; retryIn.max = '5';
    retryIn.value = (typeof st.settings.autoRetryDrops === 'number') ? st.settings.autoRetryDrops : 2;
    fRetry.appendChild(retryIn);
    fRetry.appendChild(el('div', 'hint', 'If the model connection drops or fails mid-request, retry automatically this many times before giving up. Flaky/free providers may need 2-3.'));
    fMaxRow.appendChild(fRetry);
    wrap.appendChild(fMaxRow);

    /* ---- rulebook ---- */
    const fRb = el('div', 'field');
    fRb.appendChild(el('label', null, 'Rulebook (GM reference)'));
    const rbStatus = el('div', 'hint');
    const rbChars = (st.rulebook || '').length;
    rbStatus.textContent = rbChars
      ? 'Loaded: ' + rbChars.toLocaleString() + ' chars (~' + App.prompts.estTokens(st.rulebook).toLocaleString() + ' tokens est.)'
      : 'Not loaded. Serve this folder over http so the app can fetch ArmatSurTextdoc.txt, or load it manually:';
    fRb.appendChild(rbStatus);
    const rbRow = el('div', 'comp-row'); rbRow.style.marginTop = '6px';
    const rbLoad = el('button', 'btn small', 'Load rulebook .txt file');
    rbLoad.addEventListener('click', function () { document.querySelector('#fileRulebook').click(); });
    const rbClear = el('button', 'btn small danger', 'Clear rulebook');
    rbClear.addEventListener('click', function () {
      App.store.get().rulebook = ''; App.store.save(); renderTopbar(); closeModal(); openSettingsModal();
    });
    rbRow.appendChild(rbLoad); rbRow.appendChild(rbClear);
    fRb.appendChild(rbRow);
    wrap.appendChild(fRb);

    /* Library edits save immediately, separately from the settings form. */
    const fRefs = el('div', 'field');
    fRefs.appendChild(el('label', null, 'Reference attachments'));
    const sendRefs = document.createElement('input'); sendRefs.type = 'checkbox';
    sendRefs.checked = st.settings.sendAttachments !== false;
    const sendLabel = el('label', 'checkline'); sendLabel.appendChild(sendRefs);
    sendLabel.appendChild(document.createTextNode(' Send enabled reference images with the rulebook'));
    fRefs.appendChild(sendLabel);
    fRefs.appendChild(el('div', 'hint', 'Shared with the GM and all AI characters on every request, including retries. Add maps, illustrations or ordered document pages (PNG, JPEG, WebP; up to 20 MiB per image). Model/provider image-count and context limits still apply. PDFs must first be exported as page images.'));
    fRefs.appendChild(el('div', 'hint', 'Library changes save immediately in this browser, survive session changes, and are not included in session exports. Image costs and tokens are model-dependent; context checks cover text only.'));
    const refInput = document.createElement('input'); refInput.type = 'file'; refInput.multiple = true;
    refInput.accept = 'image/png,image/jpeg,image/webp'; refInput.hidden = true;
    const addRefs = el('button', 'btn small', 'Add reference images');
    rbRow.appendChild(addRefs); fRefs.appendChild(refInput);
    const refStatus = el('div', 'hint', 'Loading references...'); fRefs.appendChild(refStatus);
    const refList = el('div', 'reference-list'); fRefs.appendChild(refList);
    wrap.appendChild(fRefs);
    let refBusy = false;
    function renderReferences() {
      refList.textContent = '';
      const items = App.attachments.list();
      const active = items.filter(function (m) { return m.enabled; });
      const bytes = active.reduce(function (n, m) { return n + m.size; }, 0);
      refStatus.textContent = items.length + ' images · ' + active.length + ' enabled · ' + (bytes / 1048576).toFixed(1) + ' MiB enabled';
      items.forEach(function (item, index) {
        const row = el('div', 'reference-item'), controls = el('div', 'comp-row');
        const check = document.createElement('input'); check.type = 'checkbox'; check.checked = item.enabled;
        check.setAttribute('aria-label', 'Include ' + item.name); controls.appendChild(check);
        controls.appendChild(el('span', 'reference-name', (index + 1) + '. ' + item.name + ' (' + item.width + ' × ' + item.height + ')'));
        const up = el('button', 'btn small', '↑'), down = el('button', 'btn small', '↓');
        up.setAttribute('aria-label', 'Move ' + item.name + ' earlier'); down.setAttribute('aria-label', 'Move ' + item.name + ' later');
        up.disabled = index === 0; down.disabled = index === items.length - 1;
        const preview = el('button', 'btn small', 'Preview'), remove = el('button', 'btn small danger', 'Remove');
        [up, down, preview, remove].forEach(function (b) { controls.appendChild(b); });
        row.appendChild(controls); refList.appendChild(row);
        check.addEventListener('change', function () { editReferences(function () { return App.attachments.update(item.id, { enabled: check.checked }); }); });
        up.addEventListener('click', function () { editReferences(function () { return App.attachments.move(item.id, -1); }); });
        down.addEventListener('click', function () { editReferences(function () { return App.attachments.move(item.id, 1); }); });
        remove.addEventListener('click', function () { editReferences(function () { return App.attachments.remove(item.id); }); });
        preview.addEventListener('click', async function () {
          const old = row.querySelector('img'); if (old) { old.remove(); preview.textContent = 'Preview'; return; }
          preview.disabled = true;
          try { const url = await App.attachments.imageData(item.id); const img = document.createElement('img'); img.alt = item.name; img.src = url; img.className = 'reference-preview'; row.appendChild(img); preview.textContent = 'Hide preview'; }
          catch (e) { toast(e.message, 'error'); }
          finally { preview.disabled = false; }
        });
      });
      renderTopbar();
    }
    async function editReferences(fn) {
      if (refBusy) return;
      refBusy = true; addRefs.disabled = true;
      refList.querySelectorAll('button,input').forEach(function (b) { b.disabled = true; });
      try { await fn(); } catch (e) { toast(e.message, 'error'); }
      finally { refBusy = false; addRefs.disabled = false; renderReferences(); }
    }
    addRefs.addEventListener('click', function () { if (!refBusy) refInput.click(); });
    refInput.addEventListener('change', function () {
      const files = Array.from(refInput.files || []); refInput.value = '';
      editReferences(async function () {
        for (let i = 0; i < files.length; i++) {
          refStatus.textContent = 'Importing ' + (i + 1) + '/' + files.length + ': ' + files[i].name;
          await App.attachments.importFile(files[i]);
        }
      });
    });
    App.attachments.ready().then(renderReferences).catch(function (e) { refStatus.textContent = e.message; });

    /* ---- danger zone ---- */
    const fReset = el('div', 'field');
    const resetBtn = el('button', 'btn small danger', 'Reset entire session');
    resetBtn.addEventListener('click', function () {
      confirmModal('Reset session', 'Erase all branches, messages, and settings? This cannot be undone.', function () {
        App.store.reset(); renderAll(); toast('Session reset.', 'info');
      });
    });
    fReset.appendChild(resetBtn);
    wrap.appendChild(fReset);

    /* ---- diagnostics ---- */
    const fDiag = el('div', 'field');
    const diagBtn = el('button', 'btn small', 'Diagnostics log (' + App.diag.list().length + ')');
    diagBtn.addEventListener('click', openDiagModal);
    fDiag.appendChild(diagBtn);
    fDiag.appendChild(el('div', 'hint', 'Failures, retries, dropped streams, and crashes — for debugging after the fact.'));
    wrap.appendChild(fDiag);

    openModal({
      title: 'Settings',
      bodyEl: wrap,
      actions: [
        { label: 'Cancel', onClick: closeModal },
        {
          label: 'Save', cls: 'primary', onClick: function () {
            if (![tIn, mIn, maxIn, retryIn].every(function (input) { return input.reportValidity(); })) return;
            const s = App.store.get().settings;
            Object.assign(s, captureProfile());
            s.apiService = service;
            s.serviceProfiles = drafts;
            s.temperature = tIn.value === '' ? 0.8 : Number(tIn.value);
            s.maxTokens = parseInt(mIn.value, 10) || 10000;
            s.autoGmReply = autoCb.checked;
            s.enableTools = toolsCb.checked;
            s.sendAttachments = sendRefs.checked;
            s.reasoning = rSel.value;
            s.stream = streamCb.checked;
            s.autoTurns = autoTurnCb.checked;
            s.playerTurnSound = soundCb.checked;
            s.maxAutoTurns = maxIn.value === '' ? 8 : Number(maxIn.value);
            const rv = parseInt(retryIn.value, 10);
            s.autoRetryDrops = isNaN(rv) ? 2 : Math.max(0, Math.min(5, rv));
            App.store.save();
            App.ui.setConn(s.apiKey ? (App.ui._conn === 'ok' ? 'ok' : 'unknown') : 'unknown');
            closeModal(); renderAll(); toast('Settings saved.', 'info');
          }
        }
      ]
    });
  }

  /* ---------------- sessions modal ---------------- */

  function fmtDate(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return d.toLocaleDateString() + ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  function openSessionsModal() {
    const st = App.store.get();
    const wrap = el('div');

    // save row
    const fSave = el('div', 'field');
    fSave.appendChild(el('label', null, 'Session name'));
    const row = el('div', 'comp-row');
    const nameIn = el('input', 'txt');
    nameIn.value = (st.meta && st.meta.name) || 'untitled';
    nameIn.style.flex = '1';
    const saveBtn = el('button', 'btn primary', 'Save');
    row.appendChild(nameIn);
    row.appendChild(saveBtn);
    fSave.appendChild(row);
    fSave.appendChild(el('div', 'hint',
      'Saves go to the saves/ folder next to the app. Only the session (branches, messages) is saved — your API key, model settings and rulebook are kept separately and never touched by loading.'));
    wrap.appendChild(fSave);

    // new session
    const newBtn = el('button', 'btn session-new', 'New Session (keep settings)');
    newBtn.addEventListener('click', function () {
      confirmModal('New session',
        'Start a fresh session? Unsaved progress in the CURRENT session will be lost (existing save files are kept). API key, settings and rulebook are preserved.',
        function () {
          App.store.newSession();
          closeModal();
          renderAll();
          toast('New session started.', 'info');
        });
    });
    wrap.appendChild(newBtn);

    // list
    const listTitle = el('div', 'side-title'); listTitle.style.margin = '14px 0 6px';
    listTitle.textContent = 'Saved sessions';
    wrap.appendChild(listTitle);
    const listBox = el('div', 'sess-list');
    listBox.appendChild(el('div', 'hint', ' loading...'));
    wrap.appendChild(listBox);

    function refreshList() {
      App.api.sessions.list().then(function (sessions) {
        listBox.innerHTML = '';
        if (!sessions.length) {
          listBox.appendChild(el('div', 'hint', 'No saves yet — save the current session above.'));
          return;
        }
        sessions.forEach(function (s) {
          const r = el('div', 'sess-row');
          const info = el('span', 'sess-info');
          info.appendChild(el('span', 'sess-name', s.name));
          info.appendChild(el('span', 'hint', ' ' + fmtDate(s.savedAt || s.fileSavedAt) + ' · ' + (s.size / 1024).toFixed(1) + ' KB'));
          r.appendChild(info);
          const loadBtn = el('button', 'btn small session-load', 'Load');
          loadBtn.addEventListener('click', function () {
            confirmModal('Load session',
              'Load "' + s.name + '"? Current unsaved progress will be replaced. Settings are preserved.',
              function () {
                App.api.sessions.load(s.name).then(function (text) {
                  App.store.applySession(text);
                  closeModal();
                  renderAll();
                  toast('Loaded session "' + s.name + '".', 'info');
                }).catch(function (err) { toast('Load failed: ' + err.message, 'error'); });
              });
          });
          const deleteBtn = el('button', 'btn small danger session-delete', 'Delete');
          deleteBtn.setAttribute('aria-label', 'Delete saved session ' + s.name);
          deleteBtn.addEventListener('click', function () {
            const confirmation = el('div', null, 'Permanently delete the saved session "' + s.name +
              '"? This cannot be undone. Your currently open session and settings will stay as they are.');
            let deleting = false;
            const dialog = openModal({
              title: 'Delete saved session', bodyEl: confirmation,
              actions: [
                { label: 'Cancel', onClick: function () { showSessions(); deleteBtn.focus(); } },
                { label: 'Delete', cls: 'danger', onClick: function () {
                  if (deleting) return;
                  deleting = true;
                  dialog.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
                  App.api.sessions.delete(s.name).then(function () {
                    refreshList();
                    if (confirmation.isConnected) showSessions();
                    toast('Deleted saved session "' + s.name + '".', 'info');
                  }).catch(function (err) {
                    deleting = false;
                    dialog.querySelectorAll('button').forEach(function (b) { b.disabled = false; });
                    toast('Delete failed: ' + err.message, 'error');
                  });
                } }
              ]
            });
            dialog.querySelector('.modal-actions button').focus();
          });
          r.appendChild(deleteBtn);
          r.appendChild(loadBtn);
          listBox.appendChild(r);
        });
      }).catch(function () {
        listBox.innerHTML = '';
        listBox.appendChild(el('div', 'hint',
          'Server save/load unavailable (app not served by serve.py?). Use Import/Export in the top bar instead.'));
      });
    }
    refreshList();

    saveBtn.addEventListener('click', function () {
      const name = nameIn.value.trim() || 'untitled';
      saveBtn.disabled = true;
      App.api.sessions.save(name, App.store.serializeSession(name))
        .then(function () {
          App.store.setSessionName(name);
          saveBtn.disabled = false;
          renderTopbar();
          refreshList();
          toast('Session saved as "' + name + '".', 'info');
        })
        .catch(function (err) {
          saveBtn.disabled = false;
          toast('Save failed: ' + err.message + ' (running from file://? use Export instead)', 'error');
        });
    });

    function showSessions() {
      openModal({
        title: 'Sessions',
        bodyEl: wrap,
        actions: [{ label: 'Close', onClick: closeModal }]
      });
    }
    showSessions();
    nameIn.focus();
  }

  /* ---------------- render all ---------------- */

  function renderAll() {
    renderTopbar();
    renderSidebar();
    renderBranchHeader();
    renderMessages();
    renderComposer();
    renderCharacterPanel();
  }

  return {
    toast: toast,
    setBusy: setBusy,
    streamStart: streamStart,
    streamChunk: streamChunk,
    streamEnd: streamEnd,
    setConn: setConn,
    closeModal: closeModal,
    openNewBranchModal: openNewBranchModal,
    openSettingsModal: openSettingsModal,
    openSessionsModal: openSessionsModal,
    openSystemPromptModal: openSystemPromptModal,
    openCompactionModal: openCompactionModal,
    renderCharacterPanel: renderCharacterPanel,
    captureMessageView: captureMessageView,
    restoreMessageView: restoreMessageView,
    refreshMessageVariants: refreshMessageVariants,
    renderAll: renderAll,
    renderTopbar: renderTopbar,
    getDraft: getDraft,
    clearDraft: clearDraft,
    getSeg: getSeg,
    _conn: 'unknown',
    _composerTa: null
  };
})();
