const test = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('./helpers');

test('tag expression preserves the example mapping and arithmetic', t => {
  const { A, w } = app(t);
  const draws = [0.8, 0.3, 0.4, 0.2];
  w.Math.random = () => { assert.ok(draws.length); return draws.shift(); };
  const result = A.tools.execute('roll_resolver', {
    expression: '(aether user+) + (aether prodigy#) + (aether commitment+) - (cast complexity~) - (aether ritualist)'
  });
  assert.equal(result.text, 'd10 + 1 + d10 - d3 - d6\n9 + 1 + 4 - 2 - 2\n10');
  assert.equal(draws.length, 0, 'flat tags consume no random draw');
  assert.equal(result.record, true);
});

test('dice include minimum and maximum faces without adjudicating them', t => {
  const { A, w } = app(t);
  const expression = '(major+) + (minor~) + (standard) + (trivial#)';
  w.Math.random = () => 0;
  assert.equal(A.tools.execute('roll_resolver', { expression }).text, 'd10 + d3 + d6 + 1\n1 + 1 + 1 + 1\n4');
  w.Math.random = () => 0.999999;
  assert.equal(A.tools.execute('roll_resolver', { expression }).text, 'd10 + d3 + d6 + 1\n10 + 3 + 6 + 1\n20');
});

test('signs, hyphenated names, whitespace and repeated tags preserve order', t => {
  const { A, w } = app(t);
  w.Math.random = () => 0.999999;
  assert.equal(A.tools.execute('roll_resolver', {
    expression: '  - (battle-scarred ~)\n + (poise#) - (poise#)  '
  }).text, '-d3 + 1 - 1\n-3 + 1 - 1\n-3');
  assert.equal(A.tools.execute('roll_resolver', { expression: '+(balance#)-(balance#)' }).text, '1 - 1\n1 - 1\n0');
  assert.equal(A.tools.execute('roll_resolver', { expression: '(poise#)' }).text, '1\n1\n1');
});

test('invalid expressions are rejected before any random draw', t => {
  const { A, w } = app(t);
  let draws = 0;
  w.Math.random = () => { draws++; return 0; };
  for (const expression of [undefined, null, 5, '', ' ', 'x'.repeat(8193),
    '(skill) +', '(skill) (other)', '(skill) ++ (other)', '(skill) * (other)',
    'junk (skill)', '(skill) junk', '(skill) + ((nested))', '(skill) + ()',
    '(skill) + (+)', '(skill++)', '(skill+~)', '(skill#name)', '(skill)+3',
    '(skill) + Math.random()', '(skill) - - (other)']) {
    assert.match(A.tools.execute('roll_resolver', { expression }).text, /^Error:/, String(expression));
  }
  assert.match(A.tools.execute('roll_resolver', { mode: 'totals', rolls: [] }).text, /^Error:/);
  assert.equal(draws, 0);
});

test('roller is stateless and offers just one expression input to the GM', t => {
  const { A, w } = app(t);
  const before = JSON.stringify(A.store.get());
  w.Math.random = () => 0.5;
  A.tools.execute('roll_resolver', { expression: '(skill+) - (difficulty~)' });
  assert.equal(JSON.stringify(A.store.get()), before);
  const tool = A.tools.forAudience('gm').find(t => t.function.name === 'roll_resolver').function;
  assert.deepEqual(Object.keys(tool.parameters.properties), ['expression']);
  assert.equal(tool.parameters.required.join(','), 'expression');
  assert.equal(A.tools.forAudience('character').some(t => t.function.name === 'roll_resolver'), false);
});

test('GM prompt preserves tag mapping and individual results without adding criticals', t => {
  const { A } = app(t);
  const prompt = A.prompts.gmSystem(A.store.get());
  for (const text of ['Show the original tag expression', 'three result lines unchanged',
    'Preserve tag order so each die maps to its tag', 'Use the individual results as well as the total',
    'does not introduce an automatic critical-hit rule',
    'Apply opposed margins, aether coefficients, and consequences separately']) {
    assert.ok(prompt.includes(text), text);
  }
});

test('long tag expressions remain intact in history beside the exact model tool result', async t => {
  const { A } = app(t);
  const expression = Array.from({ length: 20 }, (_, i) => '(situational advantage ' + i + '#)').join(' + ');
  assert.ok(expression.length > 300, 'exercise the normal tool-argument truncation boundary');
  let calls = 0, result;
  A.api.chatFull = async opts => {
    if (++calls === 1) return { message: { tool_calls: [{ id: 'roll', type: 'function',
      function: { name: 'roll_resolver', arguments: JSON.stringify({ expression }) } }] } };
    result = opts.messages.find(m => m.role === 'tool').content;
    return { message: { content: 'Done.' } };
  };
  await A.actions._test.chatWithTools({ model: 'm', messages: [], temperature: 0.5,
    maxTokens: 50, audience: 'gm', originBranchId: 'b_user' });
  const logged = A.store.allMessages().find(m => m.name === 'Tool: roll_resolver');
  assert.equal(result.split('\n').length, 3);
  assert.equal(result.split('\n')[2], '20');
  assert.equal(logged.content, expression + '\n' + result);
  assert.equal(logged.origin, 'b_user');
});
