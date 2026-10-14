import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quarterOf } from '../src/services/dashboard.js';

test('quarterOf uses the Indian financial year (April to March)', () => {
  assert.equal(quarterOf('2026-04-01'), 'FY2026-Q1');
  assert.equal(quarterOf('2026-09-30'), 'FY2026-Q2');
  assert.equal(quarterOf('2026-10-07'), 'FY2026-Q3');
  assert.equal(quarterOf('2027-01-05'), 'FY2026-Q4');
  assert.equal(quarterOf('2026-03-31'), 'FY2025-Q4');
});
