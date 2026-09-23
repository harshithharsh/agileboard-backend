import { query } from '../config/db.js';

const DAY_MS = 86400000;
const TREND_SPRINTS = 6; // history loaded for averages and trend charts

const round = (n, dp = 0) => (n === null || Number.isNaN(n) ? null : Number(n.toFixed(dp)));
const pct = (num, den) => (den ? (num / den) * 100 : 0);
const sum = (arr, fn) => arr.reduce((s, x) => s + fn(x), 0);
const startOfDay = (date) => new Date(`${date}T00:00:00Z`);
const endOfDay = (date) => new Date(startOfDay(date).getTime() + DAY_MS);

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function workingDays(start, end) {
  const days = [];
  for (let d = startOfDay(start); d <= startOfDay(end); d = new Date(d.getTime() + DAY_MS)) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) days.push(d);
  }
  return days;
}

function meetsTarget(value, target) {
  if (!target || value === null) return true;
  return target.operator === '>=' ? value >= target.value : value <= target.value;
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function loadSprintWindow(teamId, sprintId) {
  const { rows: all } = await query(
    `SELECT s.*, r.name AS release_name
       FROM sprints s LEFT JOIN releases r ON r.id = s.release_id
      WHERE s.team_id = $1
      ORDER BY s.start_date`,
    [teamId]
  );
  if (!all.length) return [];
  const idx = sprintId ? all.findIndex((s) => s.id === sprintId) : all.length - 1;
  if (idx === -1) return [];
  return all.slice(Math.max(0, idx - TREND_SPRINTS + 1), idx + 1);
}

async function loadData(sprintIds, assigneeId) {
  const assigneeFilter = assigneeId ? 'AND i.assignee_id = $2' : '';
  const params = assigneeId ? [sprintIds, assigneeId] : [sprintIds];

  const { rows: items } = await query(
    `SELECT si.sprint_id, si.commitment, si.outcome, si.points, si.added_at,
            i.id AS issue_id, i.issue_key, i.title, i.type, i.started_at, i.completed_at,
            i.dor_met, i.dod_met, i.has_acceptance_criteria, i.code_reviewed, i.tests_complete, i.automated
       FROM sprint_issues si
       JOIN issues i ON i.id = si.issue_id
      WHERE si.sprint_id = ANY($1) AND si.outcome IS DISTINCT FROM 'removed' ${assigneeFilter}`,
    params
  );
  const issueIds = [...new Set(items.map((i) => i.issue_id))];

  const [history, blocked, defects] = await Promise.all([
    query(
      `SELECT issue_id, to_status, changed_at FROM issue_status_history
        WHERE issue_id = ANY($1) ORDER BY changed_at`,
      [issueIds]
    ),
    query(
      `SELECT b.*, i.issue_key, i.title FROM blocked_periods b JOIN issues i ON i.id = b.issue_id
        WHERE b.issue_id = ANY($1)`,
      [issueIds]
    ),
    query(
      `SELECT d.* FROM defects d LEFT JOIN issues i ON i.id = d.issue_id
        WHERE d.sprint_id = ANY($1) ${assigneeFilter}`,
      params
    ),
  ]);

  return { items, history: history.rows, blocked: blocked.rows, defects: defects.rows };
}

// ---------------------------------------------------------------------------
// Per-sprint metrics
// ---------------------------------------------------------------------------

function statusAt(historyByIssue, issueId, at) {
  let status = 'todo';
  for (const h of historyByIssue.get(issueId) || []) {
    if (h.changed_at > at) break;
    status = h.to_status;
  }
  return status;
}

function sprintStats(sprint, data, historyByIssue) {
  const start = startOfDay(sprint.start_date);
  const end = endOfDay(sprint.end_date);
  const items = data.items.filter((i) => i.sprint_id === sprint.id);
  const completedItems = items.filter((i) => i.outcome === 'completed');

  const committed = sum(items.filter((i) => i.commitment === 'committed'), (i) => i.points);
  const added = sum(items.filter((i) => i.commitment === 'added'), (i) => i.points);
  const completed = sum(completedItems, (i) => i.points);
  const completedCommitted = sum(completedItems.filter((i) => i.commitment === 'committed'), (i) => i.points);
  const spillover = sum(items.filter((i) => i.outcome === 'spillover'), (i) => i.points);
  const scope = committed + added;

  // Flow
  const cycleDays = completedItems
    .filter((i) => i.started_at && i.completed_at)
    .map((i) => (i.completed_at - i.started_at) / DAY_MS);

  const statusAtEnd = items.map((i) => statusAt(historyByIssue, i.issue_id, end));
  const inReview = statusAtEnd.filter((s) => s === 'in_review').length;
  const inTest = statusAtEnd.filter((s) => s === 'in_test').length;
  const wip = statusAtEnd.filter((s) => ['in_progress', 'in_review', 'in_test'].includes(s)).length;

  const itemIds = new Set(items.map((i) => i.issue_id));
  const blockedPeriods = data.blocked
    .filter((b) => itemIds.has(b.issue_id))
    .map((b) => {
      const bEnd = b.ended_at || end;
      const overlap = Math.min(bEnd, end) - Math.max(b.started_at, start);
      return { ...b, overlapDays: overlap / DAY_MS, lengthDays: (bEnd - b.started_at) / DAY_MS };
    })
    .filter((b) => b.overlapDays > 0);
  const blockedIssues = new Set(blockedPeriods.map((b) => b.issue_id));
  const externalIssues = new Set(blockedPeriods.filter((b) => b.external).map((b) => b.issue_id));

  // Quality
  const defects = data.defects.filter((d) => d.sprint_id === sprint.id);
  const closed = defects.filter((d) => d.closed_at && d.closed_at <= end).length;
  const uat = defects.filter((d) => d.found_in === 'uat').length;
  const prod = defects.filter((d) => d.found_in === 'prod').length;

  const share = (list, key) => round(pct(list.filter((i) => i[key]).length, list.length));

  return {
    id: sprint.id,
    name: sprint.name,
    startDate: sprint.start_date,
    endDate: sprint.end_date,
    committed,
    added,
    completed,
    spillover,
    predictability: round(pct(completedCommitted, committed)),
    completion: round(pct(completed, scope)),
    velocity: completed,
    spilloverPct: round(pct(spillover, scope)),
    unplannedPct: round(pct(added, committed)),
    throughput: completedItems.length,
    cycleTime: {
      avg: round(cycleDays.length ? sum(cycleDays, (d) => d) / cycleDays.length : null, 1),
      median: round(percentile(cycleDays, 0.5), 1),
      p85: round(percentile(cycleDays, 0.85), 1),
    },
    wip: { current: wip, inReview, inTest },
    blocked: {
      items: blockedIssues.size,
      totalDays: round(sum(blockedPeriods, (b) => b.overlapDays), 1),
      longestDays: round(Math.max(0, ...blockedPeriods.map((b) => b.lengthDays)), 1),
      external: externalIssues.size,
      list: blockedPeriods
        .sort((a, b) => b.lengthDays - a.lengthDays)
        .map((b) => ({ issueKey: b.issue_key, title: b.title, reason: b.reason, external: b.external, days: round(b.lengthDays, 1), open: !b.ended_at })),
    },
    defects: {
      created: defects.length,
      closed,
      open: defects.length - closed,
      uatPct: round(pct(uat, defects.length)),
      prodPct: round(pct(prod, defects.length)),
      escapePct: round(pct(uat + prod, defects.length)),
    },
    compliance: {
      dor: share(items, 'dor_met'),
      dod: share(completedItems, 'dod_met'),
      acceptanceCriteria: share(items, 'has_acceptance_criteria'),
      codeReview: share(completedItems, 'code_reviewed'),
      testCases: share(completedItems, 'tests_complete'),
      automation: share(completedItems, 'automated'),
    },
    items,
  };
}

function burndown(sprint, stats) {
  const days = workingDays(sprint.start_date, sprint.end_date);
  const initial = stats.committed;
  return days.map((d, i) => {
    const dayEnd = new Date(d.getTime() + DAY_MS);
    const scope = sum(stats.items.filter((it) => it.added_at < dayEnd), (it) => it.points);
    const done = sum(
      stats.items.filter((it) => it.outcome === 'completed' && it.completed_at && it.completed_at < dayEnd),
      (it) => it.points
    );
    return {
      day: `D${i + 1}`,
      date: d.toISOString().slice(0, 10),
      ideal: round(initial - (initial * i) / Math.max(days.length - 1, 1), 1),
      actual: scope - done,
    };
  });
}

// ---------------------------------------------------------------------------
// Dashboard assembly
// ---------------------------------------------------------------------------

function buildInsights(cur, health, velocityBand, isActive) {
  const byKey = Object.fromEntries(health.map((h) => [h.key, h]));
  const ok = (k) => byKey[k]?.status === 'on_track';
  const wentWell = [];
  const attention = [];
  const risks = [];
  const focus = [];

  if (ok('predictability') && ok('completion')) {
    wentWell.push(`Completion is ${cur.completion}% and predictability is ${cur.predictability}%, both meeting target.`);
  } else {
    if (ok('completion')) wentWell.push(`Completion is ${cur.completion}%, meeting the ${byKey.completion.targetLabel} target.`);
    if (!ok('predictability')) attention.push(`Predictability is ${cur.predictability}%, below the ${byKey.predictability.targetLabel} target.`);
    if (!ok('completion')) attention.push(`Completion is ${cur.completion}%, below the ${byKey.completion.targetLabel} target.`);
  }
  if (ok('defect_escape')) wentWell.push(`Defect escape is ${cur.defects.escapePct}%, below the ${byKey.defect_escape.target}% ceiling.`);
  else attention.push(`Defect escape is ${cur.defects.escapePct}%, above the ${byKey.defect_escape.target}% ceiling.`);
  if (velocityBand && cur.velocity >= velocityBand.low && cur.velocity <= velocityBand.high) {
    wentWell.push(`Velocity of ${cur.velocity} SP is within the stable band (${velocityBand.low}–${velocityBand.high} SP).`);
  }

  if (!ok('unplanned')) attention.push(`Unplanned work is ${cur.unplannedPct}%, above the ${byKey.unplanned.target}% threshold.`);
  if (cur.cycleTime.avg !== null) attention.push(`Cycle time is ${cur.cycleTime.avg} days average with a ${cur.cycleTime.p85} day P85.`);

  if (cur.spilloverPct > 0) risks.push(`${cur.spilloverPct}% of sprint scope (${cur.spillover} SP) spilled over to the next sprint.`);
  if (cur.blocked.items > 0) risks.push(`${cur.blocked.items} blocked item${cur.blocked.items > 1 ? 's' : ''} represent ${cur.blocked.totalDays} days of blocked time.`);
  if (cur.defects.open > 0) {
    risks.push(`${cur.defects.open} defect${cur.defects.open > 1 ? 's remain' : ' remains'} open${isActive ? '' : ' at sprint end'}.`);
  }
  if (isActive && cur.wip.current > 0) risks.push(`${cur.wip.current} item${cur.wip.current > 1 ? 's are' : ' is'} still in progress and may spill over.`);

  if (!ok('unplanned')) focus.push('Review mid-sprint scope additions before accepting new work.');
  if (cur.blocked.items > 0) focus.push('Clear the longest blocked item before the next checkpoint.');
  if (!ok('spillover')) focus.push('Reduce committed scope to match recent velocity.');
  if (!ok('defect_escape')) focus.push('Strengthen QA and UAT entry criteria to catch defects earlier.');
  if (!focus.length) focus.push('Maintain the current commitment level and working agreements.');

  return { wentWell, attention, risks, focus };
}

export async function getDashboard({ teamId, sprintId, assigneeId, range = TREND_SPRINTS }) {
  const window = await loadSprintWindow(teamId, sprintId);
  if (!window.length) return null;

  const [{ rows: teamRows }, data] = await Promise.all([
    query(
      `SELECT t.*, p.id AS project_id, p.name AS project_name FROM teams t JOIN projects p ON p.id = t.project_id WHERE t.id = $1`,
      [teamId]
    ),
    loadData(window.map((s) => s.id), assigneeId),
  ]);
  const team = teamRows[0];
  const { rows: targetRows } = await query('SELECT metric, operator, value::float AS value FROM metric_targets WHERE project_id = $1', [team.project_id]);
  const targets = Object.fromEntries(targetRows.map((t) => [t.metric, t]));

  const historyByIssue = new Map();
  for (const h of data.history) {
    if (!historyByIssue.has(h.issue_id)) historyByIssue.set(h.issue_id, []);
    historyByIssue.get(h.issue_id).push(h);
  }

  const stats = window.map((s) => sprintStats(s, data, historyByIssue));
  const cur = stats[stats.length - 1];
  const prev = stats.length > 1 ? stats[stats.length - 2] : null;
  const sprint = window[window.length - 1];

  // Velocity "stable band": ±10% around the average of previous sprints (none for a team's first sprint)
  const prevVelocities = stats.slice(0, -1).map((s) => s.velocity);
  const velocityAvg = prevVelocities.length ? sum(prevVelocities, (v) => v) / prevVelocities.length : null;
  const velocityBand = velocityAvg === null ? null : { low: Math.round(velocityAvg * 0.9), high: Math.round(velocityAvg * 1.1) };

  const targetLabel = (t) => (t ? `${t.operator === '>=' ? '≥' : '≤'} ${t.value}${t.metric === 'blocked_items' ? '' : '%'}` : '');
  const card = (key, label, value, prevValue, unit, target) => ({
    key,
    label,
    value,
    unit,
    prior: prevValue,
    delta: prevValue === null ? null : round(value - prevValue, 1),
    target: target ? targetLabel(target) : 'Stable band',
    status: target
      ? (meetsTarget(value, target) ? 'on_track' : 'attention')
      : !velocityBand || (value >= velocityBand.low && value <= velocityBand.high) ? 'on_track' : 'attention',
    // for "higher is better" metrics the arrow colour flips
    higherIsBetter: !target || target.operator === '>=',
  });

  const summary = [
    card('predictability', 'Sprint predictability', cur.predictability, prev?.predictability ?? null, '%', targets.predictability),
    card('completion', 'Sprint completion', cur.completion, prev?.completion ?? null, '%', targets.completion),
    card('velocity', 'Velocity', cur.velocity, prev?.velocity ?? null, 'SP', null),
    card('spillover', 'Spillover', cur.spilloverPct, prev?.spilloverPct ?? null, '%', targets.spillover),
    card('unplanned', 'Unplanned work', cur.unplannedPct, prev?.unplannedPct ?? null, '%', targets.unplanned),
    card('defect_escape', 'Defect escape rate', cur.defects.escapePct, prev?.defects.escapePct ?? null, '%', targets.defect_escape),
  ];

  const healthRow = (key, label, value, unit, target) => ({
    key,
    label,
    value,
    unit,
    target: target?.value,
    targetLabel: targetLabel(target),
    status: meetsTarget(value, target) ? 'on_track' : 'attention',
  });
  const health = [
    healthRow('predictability', 'Sprint predictability', cur.predictability, '%', targets.predictability),
    healthRow('completion', 'Completion rate', cur.completion, '%', targets.completion),
    healthRow('spillover', 'Spillover', cur.spilloverPct, '%', targets.spillover),
    healthRow('unplanned', 'Unplanned work', cur.unplannedPct, '%', targets.unplanned),
    healthRow('defect_escape', 'Defect escape rate', cur.defects.escapePct, '%', targets.defect_escape),
    healthRow('blocked_items', 'Blocked work', cur.blocked.items, '', targets.blocked_items),
    healthRow('dod_compliance', 'DoD compliance', cur.compliance.dod, '%', targets.dod_compliance),
  ];
  const attentionCount = health.filter((h) => h.status === 'attention').length;
  const sprintState = attentionCount === 0 ? 'on_track' : attentionCount === 1 ? 'attention' : 'at_risk';

  const trend = stats.slice(-Math.max(1, Number(range) || TREND_SPRINTS));
  const rolling = (i) => {
    const slice = stats.slice(Math.max(0, i - 2), i + 1);
    return round(sum(slice, (s) => s.velocity) / slice.length, 1);
  };
  const offset = stats.length - trend.length;

  const previousThroughputs = stats.slice(0, -1).map((s) => s.throughput);

  return {
    context: {
      project: { id: team.project_id, name: team.project_name },
      team: { id: team.id, name: team.name, wipLimit: team.wip_limit },
      sprint: { id: sprint.id, name: sprint.name, goal: sprint.goal, startDate: sprint.start_date, endDate: sprint.end_date, release: sprint.release_name, status: sprint.status },
      generatedAt: new Date().toISOString(),
    },
    summary,
    delivery: trend.map((s, i) => ({
      sprint: s.name,
      committed: s.committed,
      completed: s.completed,
      velocity: s.velocity,
      rollingAverage: rolling(offset + i),
      completion: s.completion,
    })),
    velocityBand,
    flow: {
      cycleTime: { ...cur.cycleTime, prevAvg: prev?.cycleTime.avg ?? null, prevSprint: prev?.name ?? null },
      throughput: {
        current: cur.throughput,
        previous: prev?.throughput ?? null,
        average: previousThroughputs.length ? round(sum(stats, (s) => s.throughput) / stats.length) : null,
        sprintsInAverage: stats.length,
      },
      wip: { ...cur.wip, limit: team.wip_limit },
      blocked: cur.blocked,
    },
    scope: trend.map((s) => ({ sprint: s.name, completed: s.completed, added: s.added, spillover: s.spillover })),
    scopeAddedPct: cur.unplannedPct,
    quality: {
      current: cur.defects,
      trend: trend.map((s) => ({ sprint: s.name, created: s.defects.created, closed: s.defects.closed })),
    },
    health,
    sprintState,
    burndown: burndown(sprint, cur),
    compliance: cur.compliance,
    insights: buildInsights(cur, health, velocityBand, sprint.status === 'active'),
  };
}

export async function getFilters() {
  const [projects, teams, releases, sprints, members] = await Promise.all([
    query('SELECT id, key, name FROM projects ORDER BY name'),
    query('SELECT id, project_id, name FROM teams ORDER BY name'),
    query('SELECT id, project_id, name FROM releases ORDER BY name'),
    query('SELECT id, team_id, release_id, name, start_date, end_date, status FROM sprints ORDER BY start_date DESC'),
    query(
      `SELECT u.id, u.name, tm.team_id FROM users u JOIN team_members tm ON tm.user_id = u.id ORDER BY u.name`
    ),
  ]);
  return {
    projects: projects.rows,
    teams: teams.rows,
    releases: releases.rows,
    sprints: sprints.rows,
    assignees: members.rows,
  };
}
