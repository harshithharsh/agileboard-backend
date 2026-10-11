import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLayout } from '../src/routes/preferences.js';

test('parseLayout keeps id, size and hidden only', () => {
  assert.deepEqual(parseLayout([{ id: 'summary', size: 'full', hidden: false, extra: 1 }, { id: 'velocity', size: 'half', hidden: true }]),
    [{ id: 'summary', size: 'full', hidden: false }, { id: 'velocity', size: 'half', hidden: true }]);
});

test('parseLayout null resets to the default layout', () => {
  assert.equal(parseLayout(null), null);
});

test('parseLayout rejects bad input', () => {
  assert.throws(() => parseLayout('x'));
  assert.throws(() => parseLayout([{ id: 'Bad Id', size: 'half' }]));
  assert.throws(() => parseLayout([{ id: 'a', size: 'huge' }]));
  assert.throws(() => parseLayout([{ id: 'a', size: 'half' }, { id: 'a', size: 'full' }]));
});
