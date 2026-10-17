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

test('normalizeQuarter accepts old calendar quarters from older frontends', async () => {
  const { normalizeQuarter } = await import('../src/routes/dashboard.js');
  assert.equal(normalizeQuarter('FY2026-Q3'), 'FY2026-Q3');
  assert.equal(normalizeQuarter('2026-Q4'), 'FY2026-Q3'); // Oct–Dec 2026
  assert.equal(normalizeQuarter('2026-Q2'), 'FY2026-Q1'); // Apr–Jun 2026
  assert.equal(normalizeQuarter('2026-Q1'), 'FY2025-Q4'); // Jan–Mar 2026
  assert.equal(normalizeQuarter(undefined), null);
  assert.equal(normalizeQuarter('nonsense'), undefined);
});
