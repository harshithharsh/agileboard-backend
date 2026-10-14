import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stageOf } from '../src/services/stage.js';

test('stageOf maps this Jira workflow to who the work sits with', () => {
  assert.equal(stageOf('Development Inprogress'), 'Developer');
  assert.equal(stageOf('In Progress'), 'Developer');
  assert.equal(stageOf('Selected for Development'), 'Developer');
  assert.equal(stageOf('FAILED TEST'), 'Developer');
  assert.equal(stageOf('Delivered to QA'), 'QA');
  assert.equal(stageOf('QA In Progress'), 'QA');
  assert.equal(stageOf('Delivered to UAT'), 'BA');
  assert.equal(stageOf('To Do'), 'BA');
  assert.equal(stageOf('Backlog'), 'BA');
  assert.equal(stageOf('Finalized'), 'Other');
  assert.equal(stageOf(null), 'Unknown');
});
