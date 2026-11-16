/* Roll a signed tag expression; adjudication stays with the GM.
 * Parse the entire expression before drawing any dice. Never evaluate code.
 */
App.tools.register({
  name: 'roll_resolver',
  description: 'Roll an agreed tag expression instead of inventing numbers. Returns exactly three lines: dice expression, individual results in the same order, and total. # = flat 1, ~ = d3, unmarked = d6, + = d10. Interpret outcomes separately using the rulebook.',
  audience: ['gm'],
  parameters: {
    type: 'object',
    properties: {
      expression: {
        type: 'string', minLength: 1, maxLength: 8192,
        description: 'Parenthesized tag names joined by + or -. A tier marker belongs INSIDE the closing parenthesis, e.g. (aether user+) + (aether prodigy#) - (cast complexity~). Preserve the agreed tag order. No nested parentheses or other arithmetic.'
      }
    },
    required: ['expression'],
    additionalProperties: false
  },
  run: function (args) {
    if (typeof args.expression !== 'string' || !args.expression.trim() || args.expression.length > 8192) {
      return 'Error: provide an expression of 1 to 8192 characters, such as (skill+) - (difficulty~).';
    }
    const expression = args.expression.trim();
    const pattern = /([+-]?)\s*\(([^()]*)\)/g;
    const terms = [];
    let end = 0, match;
    while ((match = pattern.exec(expression))) {
      if (expression.slice(end, match.index).trim() || (terms.length && !match[1])) {
        return 'Error: join parenthesized tags with + or -; nested parentheses and other arithmetic are not supported.';
      }
      let name = match[2].trim();
      const marker = /[+#~]$/.test(name) ? name.slice(-1) : '';
      if (marker) name = name.slice(0, -1).trim();
      if (!name || /[+#~]/.test(name)) {
        return 'Error: each tag needs a name and at most one trailing tier marker (#, ~, or +) inside its parentheses.';
      }
      terms.push({ sign: match[1] === '-' ? -1 : 1, sides: marker === '#' ? 1 : marker === '~' ? 3 : marker === '+' ? 10 : 6 });
      end = pattern.lastIndex;
    }
    if (!terms.length || expression.slice(end).trim()) {
      return 'Error: use parenthesized tags joined by + or -, with tier markers inside the parentheses.';
    }

    const dice = [], results = [];
    let total = 0;
    terms.forEach(function (term, i) {
      const value = term.sides === 1 ? 1 : 1 + Math.floor(Math.random() * term.sides);
      const prefix = i ? (term.sign < 0 ? ' - ' : ' + ') : (term.sign < 0 ? '-' : '');
      dice.push(prefix + (term.sides === 1 ? '1' : 'd' + term.sides));
      results.push(prefix + value);
      total += term.sign * value;
    });
    return dice.join('') + '\n' + results.join('') + '\n' + total;
  }
});
