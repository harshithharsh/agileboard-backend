import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupIntoPeriods } from '../src/services/dashboard.js';

const sprint = (team, name, start, end, status, extra = {}) => ({
  id: `${team}-${name}`, team_name: team, name, start_date: start, end_date: end, status,
  completed_at: status === 'completed' ? new Date(`${end}T18:00:00Z`) : null, release_id: null, release_name: null, goal: null, ...extra,
});

test('sprints starting on the same day are combined into one period', () => {
  const periods = groupIntoPeriods([
    sprint('Vertex', 'Vertex Sprint 13', '2026-09-09', '2026-09-21', 'completed'),
    sprint('Nexo', 'Nexo Sprint 12', '2026-09-09', '2026-09-21', 'completed'),
    sprint('Nexo', 'Nexo Sprint 13', '2026-09-23', '2026-09-28', 'active'),
    sprint('Vertex', 'Vertex Sprint 14', '2026-09-23', '2026-09-28', 'active'),
  ]);
  assert.deepEqual(periods.map((p) => p.name), ['Nexo 12 / Vertex 13', 'Nexo 13 / Vertex 14']);
  assert.deepEqual(periods[0].ids, ['Nexo-Nexo Sprint 12', 'Vertex-Vertex Sprint 13']);
  assert.equal(periods[0].status, 'completed');
  assert.equal(periods[1].status, 'active');
  assert.equal(periods[1].completed_at, null);
});

test('a period ends with its latest sprint and is active while any sprint is', () => {
  const [p] = groupIntoPeriods([
    sprint('Nexo', 'Nexo Sprint 11', '2026-08-27', '2026-09-07', 'completed'),
    sprint('Vertex', 'Vertex Sprint 12', '2026-08-27', '2026-09-08', 'active'),
  ]);
  assert.equal(p.end_date, '2026-09-08');
  assert.equal(p.status, 'active');
});
