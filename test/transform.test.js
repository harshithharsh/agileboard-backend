import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transformIssue, mapStatus, pickSprints } from '../src/jira/transform.js';

const fields = { sprint: 'customfield_10021', storyPoints: 'customfield_10026' };
const statusById = new Map([
  ['1', { name: 'Backlog', category: 'new' }],
  ['2', { name: 'To Do', category: 'new' }],
  ['3', { name: 'In Progress', category: 'indeterminate' }],
  ['4', { name: 'Done', category: 'done' }],
]);
const sprint1 = { id: 100, name: 'Team Sprint 1', state: 'closed', startDate: '2026-09-01T11:49:53.000Z', endDate: '2026-09-21T22:30:00.000Z', completeDate: '2026-09-23T05:36:30.911Z' };
const sprint2 = { id: 200, name: 'Team Sprint 2', state: 'active', startDate: '2026-09-23T07:25:55.000Z', endDate: '2026-10-05T22:30:00.000Z' };

// Mirrors a real issue: planned into Sprint 2, moved into the running Sprint 1, carried over when Sprint 1 closed.
const issue = {
  id: '1', key: 'T-1',
  fields: {
    summary: 'Edit email template', created: '2026-09-01T15:39:54.323+0300',
    issuetype: { name: 'Story' }, status: { id: '3', name: 'In Progress', statusCategory: { key: 'indeterminate' } },
    customfield_10026: 3, labels: [], fixVersions: [],
  },
};
const histories = [
  { created: '2026-09-14T07:29:08.759+0300', items: [{ field: 'Sprint', fieldId: 'customfield_10021', from: '', to: '200' }] },
  { created: '2026-09-17T09:36:31.755+0300', items: [{ field: 'status', from: '1', fromString: 'Backlog', to: '2', toString: 'To Do' }] },
  { created: '2026-09-17T12:35:00.603+0300', items: [{ field: 'status', from: '2', fromString: 'To Do', to: '3', toString: 'In Progress' }] },
  { created: '2026-09-17T12:41:04.820+0300', items: [{ field: 'Sprint', fieldId: 'customfield_10021', from: '200', to: '100' }] },
  { created: '2026-09-23T08:36:31.691+0300', items: [{ field: 'Sprint', fieldId: 'customfield_10021', from: '100', to: '100, 200' }] },
];

test('issue moved into a running sprint counts as added, and spills over when unfinished', () => {
  const r = transformIssue(issue, histories, { sprint: sprint1, fields, statusById });
  assert.equal(r.membership.commitment, 'added');
  assert.equal(r.membership.outcome, 'spillover');
  assert.equal(r.points, 3);
  assert.equal(r.startedAt.toISOString(), '2026-09-17T09:35:00.603Z');
});

test('carried-over issue is committed in the next sprint and has no outcome while it is active', () => {
  const r = transformIssue(issue, histories, { sprint: sprint2, fields, statusById });
  assert.equal(r.membership.commitment, 'committed');
  assert.equal(r.membership.outcome, null);
});

test('issue done before the sprint closed is completed', () => {
  const done = { ...issue, fields: { ...issue.fields, status: { id: '4', name: 'Done', statusCategory: { key: 'done' } }, resolutiondate: '2026-09-20T10:00:00.000+0000' } };
  const h = [...histories.slice(0, 4), { created: '2026-09-20T10:00:00.000+0000', items: [{ field: 'status', from: '3', fromString: 'In Progress', to: '4', toString: 'Done' }] }];
  const r = transformIssue(done, h, { sprint: sprint1, fields, statusById });
  assert.equal(r.membership.outcome, 'completed');
  assert.equal(r.completedAt.toISOString(), '2026-09-20T10:00:00.000Z');
});

test('flagged periods become blocked periods', () => {
  const h = [
    { created: '2026-09-05T10:00:00.000+0000', items: [{ field: 'Flagged', toString: 'Impediment' }] },
    { created: '2026-09-07T10:00:00.000+0000', items: [{ field: 'Flagged', toString: '' }] },
  ];
  const r = transformIssue(issue, h, { sprint: sprint1, fields, statusById });
  assert.equal(r.blocked.length, 1);
  assert.equal(r.blocked[0].ended_at.toISOString(), '2026-09-07T10:00:00.000Z');
});

test('status mapping', () => {
  assert.equal(mapStatus('Code Review', 'indeterminate'), 'in_review');
  assert.equal(mapStatus('QA Testing', 'indeterminate'), 'in_test');
  assert.equal(mapStatus('In Progress', 'indeterminate'), 'in_progress');
  assert.equal(mapStatus('Backlog', 'new'), 'todo');
  assert.equal(mapStatus('Closed', 'done'), 'done');
});

test('pickSprints keeps active sprints and the latest closed ones from the board', () => {
  const sprints = [1, 2, 3, 4].map((n) => ({ id: n, state: 'closed', originBoardId: 9, startDate: `2026-0${n}-01` }))
    .concat({ id: 5, state: 'active', originBoardId: 9, startDate: '2026-05-01' }, { id: 6, state: 'closed', originBoardId: 7, startDate: '2026-04-15' });
  assert.deepEqual(pickSprints(sprints, 9, 2).map((s) => s.id), [3, 4, 5]);
});

test("statuses in the board's Done column count as done (e.g. Delivered to QA)", async () => {
  const { doneStatusIds } = await import('../src/jira/transform.js');
  const done = doneStatusIds({ columnConfig: { columns: [
    { name: 'To Do', statuses: [{ id: '2' }] },
    { name: 'In Progress', statuses: [{ id: '3' }] },
    { name: 'Done', statuses: [{ id: '4' }, { id: '15' }] },
  ] } });
  assert.deepEqual([...done], ['4', '15']);
  const statuses = new Map([...statusById, ['15', { name: 'Delivered to QA', category: 'indeterminate' }]]);
  const delivered = { ...issue, fields: { ...issue.fields, status: { id: '15', name: 'Delivered to QA', statusCategory: { key: 'indeterminate' } } } };
  const h = [...histories.slice(0, 4), { created: '2026-09-19T10:00:00.000+0000', items: [{ field: 'status', from: '3', fromString: 'In Progress', to: '15', toString: 'Delivered to QA' }] }];
  const r = transformIssue(delivered, h, { sprint: sprint1, fields, statusById: statuses, doneStatusIds: done });
  assert.equal(r.status, 'done');
  assert.equal(r.membership.outcome, 'completed');
  const without = transformIssue(delivered, h, { sprint: sprint1, fields, statusById: statuses });
  assert.equal(without.membership.outcome, 'spillover');
});
