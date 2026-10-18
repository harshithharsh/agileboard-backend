import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestOutcome, hitRate } from '../src/services/sprintGoal.js';

test('suggestOutcome from goal-tagged issues', () => {
  const items = (...done) => done.map((d) => ({ done: d }));
  assert.equal(suggestOutcome(items(true, true), 'completed').suggestion, 'met');
  assert.equal(suggestOutcome(items(true, false, false), 'completed').suggestion, 'partly_met');
  assert.equal(suggestOutcome(items(false), 'completed').suggestion, 'not_met');
  assert.equal(suggestOutcome([], 'completed').suggestion, null);
  assert.deepEqual(suggestOutcome(items(true, false), 'active'), { done: 1, total: 2, suggestion: null });
});

test('hitRate counts closed sprints with a recorded outcome', () => {
  const sprints = [{ id: 'a', status: 'completed' }, { id: 'b', status: 'completed' }, { id: 'c', status: 'completed' }, { id: 'd', status: 'active' }];
  const outcomes = new Map([['a', { outcome: 'met' }], ['b', { outcome: 'not_met' }], ['d', { outcome: 'met' }]]);
  assert.deepEqual(hitRate(sprints, outcomes), { recorded: 2, met: 1, partlyMet: 0, notMet: 1 });
});
