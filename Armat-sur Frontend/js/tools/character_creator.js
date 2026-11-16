/* Tool: character_creator
 * Lets the GM add a new named character (PC or NPC) to the game system:
 * builds an Armat-sur format character card and opens a private branch
 * for them, so they immediately appear in the sidebar and the GM roster.
 */
App.tools.register({
  name: 'character_creator',
  description: 'Add a new named character to the game system. Builds their character card in Armat-sur format and opens their private branch with the GM. Use when a new PC or recurring NPC enters play and should be tracked. One-off background extras do not need this.',
  audience: ['gm'],
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Character name.' },
      controller: {
        type: 'string',
        enum: ['ai', 'human'],
        description: "'ai' (default) for characters played by the AI, 'human' for human-controlled characters."
      },
      description: { type: 'string' },
      race: { type: 'string' },
      sex: { type: 'string' },
      inherent_tags: { type: 'string', description: 'Comma-separated inherent tags with magnitude marks (#, ~, +) as needed.' },
      special_tags: { type: 'string', description: 'Unique skill-set tags, if any.' },
      temporary_tags: { type: 'string', description: 'Current state tags, e.g. "aether reserve (90/90)".' },
      equipment_tags: { type: 'string', description: 'Clothing, tools, weapons, money carried.' }
    },
    required: ['name']
  },
  run: function (args, ctx) {
    const name = String(args.name || '').trim();
    if (!name) return 'Error: name is required.';
    const st = ctx.store.get();
    const dupe = st.branchOrder.some(function (bid) {
      const b = st.branches[bid];
      return b && b.type === 'character' && b.name.toLowerCase() === name.toLowerCase();
    });
    if (dupe) return 'Error: a character branch named "' + name + '" already exists. Update that card instead of creating a duplicate.';

    const card = [
      '[',
      'Name: ' + name,
      'Description: ' + (args.description || ''),
      'Race: ' + (args.race || ''),
      'Sex: ' + (args.sex || ''),
      'Inherent Tags: ' + (args.inherent_tags || ''),
      'Special tags: ' + (args.special_tags || ''),
      'Temporary Tags: ' + (args.temporary_tags || ''),
      'Equipment Tags: ' + (args.equipment_tags || ''),
      ']'
    ].join('\n');

    const controller = args.controller === 'human' ? 'human' : 'ai';
    ctx.store.createBranch(name, controller, card);
    return 'Created character "' + name + '" (' + controller + '-controlled) with card:\n' + card +
      '\nThey now have a private branch in the sidebar and are part of your roster.';
  }
});
