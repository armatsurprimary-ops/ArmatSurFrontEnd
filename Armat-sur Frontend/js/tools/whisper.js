/* Tool: whisper
 * Delivers a private GM message to ONE character's branch during a GM turn.
 * Use for per-character information (private senses, secrets, personal
 * reactions, questions meant for one character alone) alongside public
 * narration — never as [Name]-addressed blocks in the public main branch.
 * Not recorded as an open tool-log entry; the message itself is the record.
 */
App.tools.register({
  name: 'whisper',
  description: 'Deliver a SHORT private fact to ONE character during your turn — something that must be kept FROM the other characters (a private sense, a secret, or a question about something only they know). The message appears only in that character\'s private branch. Use brief factual table talk, never a private scene narrative. Public observations belong in main; solo mechanical or OOC discussion belongs in a routed private reply. Keep each whisper to a few sentences, at most 800 characters; one whisper per character per turn. A successful delivery is already in the history: do not repeat it in your final reply.',
  audience: ['gm'],
  record: false, // Errors must not publish private arguments in another branch.
  parameters: {
    type: 'object',
    properties: {
      character: { type: 'string', description: 'Recipient: the character\'s branch name (from the roster).' },
      text: { type: 'string', description: 'The private message addressed to that character.' }
    },
    required: ['character', 'text']
  },
  run: function (args, ctx) {
    const st = ctx.state || ctx.store.get();
    const q = String(args.character || '').trim().toLowerCase();
    if (!q || q === 'main') return 'Error: whisper needs a character branch name, not main — route your reply there instead.';
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
    if (!branch || branch.type !== 'character') {
      return 'Error: whisper requires a private character branch; use route for main.';
    }
    const text = String(args.text || '').trim();
    if (!text) return 'Error: whisper needs text to deliver.';
    if (text.length > 800) {
      return 'Error: whisper exceeds 800 characters. Shorten the private facts and retry. Narration belongs in main with secrets omitted; solo mechanical or OOC discussion may use a routed private reply.';
    }
    const turn = ctx.turn || {};
    turn.whispers = turn.whispers || {};
    if (turn.whispers[res.id]) {
      return 'Error: you already whispered to ' + branch.name + ' this turn; that message was delivered and cannot be replaced by another call. Do not repeat it. Defer additional private facts until a later turn; solo mechanical or OOC discussion may use a routed private reply.';
    }
    turn.whispers[res.id] = true;
    ctx.store.addMessage({
      role: 'gm',
      name: 'GM',
      content: '[private to ' + branch.name + '] ' + text,
      origin: res.id
    });
    return { text: 'Delivered privately to ' + branch.name + '.', record: false };
  }
});
