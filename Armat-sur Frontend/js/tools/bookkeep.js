/* Tool: bookkeep
 * Applies a character state change to their card and announces it at the
 * table, mirroring the example games' pattern:
 *   "I'm setting Michael's aether reserve to (30/60)"
 *   "I'm adding (tired#) to Theren."
 *   "I'm removing (aroused~) and (horny) from Wurther."
 * The announcement is public table record (main branch) and the roster card
 * stays current, so future tag invocations work from real state.
 * Not logged as a tool entry — the announcement message IS the record.
 */
App.tools.register({
  name: 'bookkeep',
  description: 'Apply a character state change to their card and announce it at the table, like the example games ("I\'m setting Michael\'s aether reserve to (30/60)", "I\'m adding (tired#) to Theren", "I\'m removing (aroused~) and (horny) from Wurther"). Use whenever a roll or event changes a character\'s state — wounds, fatigue, arousal, aether reserve, any temporary condition — and to remove tags when conditions end. The announcement is public table record and the character\'s card stays current.',
  audience: ['gm'],
  record: false,
  parameters: {
    type: 'object',
    properties: {
      character: { type: 'string', description: 'The character\'s branch name (from the roster).' },
      add_tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Temporary tags to add, with magnitude marks, e.g. ["tired#", "wounded~", "aroused~"].'
      },
      remove_tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Temporary tags to remove; magnitude marks optional, e.g. ["horny", "stressed casting"].'
      },
      aether_reserve: {
        type: 'string',
        description: 'New reserve as "current/max", e.g. "30/60".'
      }
    },
    required: ['character']
  },
  run: function (args, ctx) {
    const st = ctx.state || ctx.store.get();
    const res = ctx.store.resolveBranch(args.character);
    if (!res.id) {
      if (res.ambiguous.length) {
        return 'Error: "' + args.character + '" is ambiguous — did you mean ' +
          res.ambiguous.join(' or ') + '? Use the exact branch name.';
      }
      const chars = st.branchOrder.filter(function (id) {
        return st.branches[id] && st.branches[id].type === 'character';
      });
      return 'Error: no character branch named "' + args.character + '". Available: ' +
        chars.map(function (id) { return st.branches[id].name; }).join(', ');
    }
    const branch = st.branches[res.id];
    if (branch.type !== 'character') {
      return 'Error: bookkeep needs a character branch.';
    }
    const card = branch.card || '';
    if (!card.trim()) {
      return 'Error: ' + branch.name + ' has no character card to update. Fill in their card first.';
    }

    const adds = (args.add_tags || []).map(String).map(function (s) { return s.trim(); }).filter(Boolean);
    const removes = (args.remove_tags || []).map(String).map(function (s) { return s.trim(); }).filter(Boolean);
    const reserve = String(args.aether_reserve || '').trim();
    if (!adds.length && !removes.length && !reserve) {
      return 'Error: nothing to bookkeep — provide add_tags, remove_tags, or aether_reserve.';
    }
    if (reserve && !/^\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?$/.test(reserve)) {
      return 'Error: aether_reserve must look like "30/60" (current/max).';
    }

    function baseName(tag) {
      return String(tag || '').toLowerCase().replace(/[#+~]/g, '').replace(/\s+/g, ' ').trim();
    }

    const TEMP_RE = /^(\s*Temporary Tags\s*:\s*)(.*)$/im;
    const m = card.match(TEMP_RE);
    const items = m ? m[2].split(',').map(function (s) { return s.trim(); }).filter(Boolean) : [];
    const parts = [];

    if (reserve) {
      const norm = reserve.replace(/\s+/g, '');
      const i = items.findIndex(function (it) { return /^aether reserve\s*\(/i.test(it); });
      if (i >= 0) items[i] = 'aether reserve (' + norm + ')';
      else items.push('aether reserve (' + norm + ')');
      parts.push("I'm setting " + branch.name + "'s aether reserve to (" + norm + ").");
    }
    if (removes.length) {
      const gone = [];
      removes.forEach(function (rt) {
        const bn = baseName(rt);
        const i = items.findIndex(function (it) { return baseName(it) === bn; });
        if (i >= 0) { gone.push(items[i]); items.splice(i, 1); }
      });
      if (gone.length) {
        parts.push("I'm removing " + gone.map(function (t) { return '(' + t + ')'; }).join(' and ') +
          ' from ' + branch.name + '.');
      }
    }
    if (adds.length) {
      const added = [];
      adds.forEach(function (t) {
        const bn = baseName(t);
        if (!items.some(function (it) { return baseName(it) === bn; })) {
          items.push(t);
          added.push(t);
        }
      });
      if (added.length) {
        parts.push("I'm adding " + added.map(function (t) { return '(' + t + ')'; }).join(' and ') +
          ' to ' + branch.name + '.');
      }
    }

    if (!parts.length) {
      return 'Nothing changed — the tags were already present (or absent) as requested.';
    }

    const newTemp = items.join(', ');
    let newCard;
    if (m) {
      newCard = card.replace(TEMP_RE, function (_, lead) { return lead + newTemp; });
    } else if (/^\s*Equipment Tags\s*:/im.test(card)) {
      newCard = card.replace(/^(\s*Equipment Tags\s*:)/im, function (_, lead) {
        return 'Temporary Tags: ' + newTemp + '\n' + lead;
      });
    } else {
      const closed = card.replace(/\]\s*$/, 'Temporary Tags: ' + newTemp + '\n]');
      newCard = closed !== card ? closed : card.replace(/\s*$/, '\nTemporary Tags: ' + newTemp);
    }

    ctx.store.updateBranch(res.id, { card: newCard });
    const announce = parts.join(' ');
    ctx.store.addMessage({ role: 'gm', name: 'GM', content: announce, origin: 'main' });
    return { text: 'Recorded: ' + announce, record: false };
  }
});