import { query } from '../config/db.js';
import { lastSync } from '../jira/sync.js';
import { stageOf, STAGES } from './stage.js';
import { suggestOutcome, hitRate } from './sprintGoal.js';

const DAY_MS = 86400000;
const TREND_SPRINTS = 6; // sprints in the trend charts when no quarter is chosen; also the velocity-band history
const MAX_HISTORY = 20; // sprints loaded before the selected one
const MIN_BLOCK_DAYS = 1 / 24; // blocks shorter than 1 hour are ignored

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

// A closed sprint ends when it was closed in Jira (which can be after its planned end date).
const sprintEnd = (sprint) =>
  sprint.completed_at ? new Date(Math.max(sprint.completed_at, endOfDay(sprint.end_date))) : endOfDay(sprint.end_date);

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

// Indian financial-year quarter a date falls in (the year runs April to March):
// Q1 Apr–Jun, Q2 Jul–Sep, Q3 Oct–Dec, Q4 Jan–Mar. '2026-10-07' -> 'FY2026-Q3' (FY 2026-27), '2027-02-01' -> 'FY2026-Q4'
export const quarterOf = (date) => {
  const year = Number(date.slice(0, 4)), month = Number(date.slice(5, 7));
  return `FY${month >= 4 ? year : year - 1}-Q${Math.floor(((month + 8) % 12) / 3) + 1}`;
};

// Returns the selected sprint plus the ones before it for one team. With a quarter, the selected sprint
// defaults to the latest one that started in that quarter.
async function loadSprintWindow(teamId, sprintId, quarter) {
  const { rows: all } = await query(
    `SELECT s.*, r.name AS release_name
       FROM sprints s LEFT JOIN releases r ON r.id = s.release_id
      WHERE s.team_id = $1
      ORDER BY s.start_date`,
    [teamId]
  );
  if (!all.length) return [];
  const candidates = quarter ? all.filter((s) => quarterOf(s.start_date) === quarter) : all;
  const selected = sprintId ? candidates.find((s) => s.id === sprintId) : candidates.at(-1);
  if (!selected) return [];
  const idx = all.indexOf(selected);
  return all.slice(Math.max(0, idx - MAX_HISTORY + 1), idx + 1);
}

async function loadData(sprintIds, assigneeId) {
  const assigneeFilter = assigneeId ? 'AND i.assignee_id = $2' : '';
  const params = assigneeId ? [sprintIds, assigneeId] : [sprintIds];

  const { rows: items } = await query(
    `SELECT si.sprint_id, si.commitment, si.outcome, si.points, si.added_at, si.added_by, i.is_goal_item,
            i.id AS issue_id, i.issue_key, i.title, i.type, i.priority, i.jira_status, i.started_at, i.completed_at,
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
      `SELECT b.*, i.issue_key, i.title, i.jira_status, u.name AS assignee_name
         FROM blocked_periods b JOIN issues i ON i.id = b.issue_id LEFT JOIN users u ON u.id = i.assignee_id
        WHERE b.issue_id = ANY($1)`,
      [issueIds]
    ),
    query(
      `SELECT d.*, i.issue_key FROM defects d LEFT JOIN issues i ON i.id = d.issue_id
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
  const end = sprintEnd(sprint);
  const sprintItems = data.items.filter((i) => i.sprint_id === sprint.id);
  // Sub-tasks only appear in the Issues by Type count; every other metric uses parent-level issues
  const items = sprintItems.filter((i) => i.type !== 'subtask');

  // Issues by type: planned (in the sprint at start), added mid-sprint, completed
  const TYPE_ROWS = [['story', 'Stories'], ['task', 'Tasks'], ['bug', 'Bugs'], ['spike', 'Spikes'], ['subtask', 'Sub-tasks']];
  const countBy = (list) => ({
    planned: list.filter((i) => i.commitment === 'committed').length,
    added: list.filter((i) => i.commitment === 'added').length,
    completed: list.filter((i) => i.outcome === 'completed').length,
  });
  const issueTypes = TYPE_ROWS
    .map(([type, label]) => ({ type, label, ...countBy(sprintItems.filter((i) => i.type === type)) }))
    .filter((r) => r.type !== 'spike' || r.planned + r.added > 0); // show Spikes only when there are any
  const issueTypesTotal = { type: 'total', label: 'Total Issues', ...countBy(sprintItems) };
  const completedItems = items.filter((i) => i.outcome === 'completed');

  const committed = sum(items.filter((i) => i.commitment === 'committed'), (i) => i.points);
  const added = sum(items.filter((i) => i.commitment === 'added'), (i) => i.points);
  const completed = sum(completedItems, (i) => i.points);
  const completedCommitted = sum(completedItems.filter((i) => i.commitment === 'committed'), (i) => i.points);
  const spillover = sum(items.filter((i) => i.outcome === 'spillover'), (i) => i.points);
  const scope = committed + added;

  // Business Value Delivered % = Stories Completed ÷ Total Stories in the Sprint × 100
  // (all Story issues in the sprint, planned or added; completed = done when the sprint closed)
  const sprintStories = items.filter((i) => i.type === 'story');
  const completedStories = sprintStories.filter((i) => i.outcome === 'completed');

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
      // Still blocked: count up to now (or the sprint end, if that has passed), not to a future end date
      const bEnd = b.ended_at || new Date(Math.min(end, Date.now()));
      const overlap = Math.min(bEnd, end) - Math.max(b.started_at, start);
      return { ...b, overlapDays: overlap / DAY_MS, lengthDays: (bEnd - b.started_at) / DAY_MS };
    })
    // Ignore flags set and cleared within an hour: not a real blocker
    .filter((b) => b.overlapDays > 0 && b.lengthDays >= MIN_BLOCK_DAYS);
  const blockedIssues = new Set(blockedPeriods.map((b) => b.issue_id));
  const externalIssues = new Set(blockedPeriods.filter((b) => b.external).map((b) => b.issue_id));

  // Quality
  const defects = data.defects.filter((d) => d.sprint_id === sprint.id);
  const closedDefects = defects.filter((d) => d.closed_at && d.closed_at <= end);
  const closed = closedDefects.length;
  const defectRef = (d) => ({ key: d.issue_key, title: d.title });
  const uat = defects.filter((d) => d.found_in === 'uat').length;
  const prod = defects.filter((d) => d.found_in === 'prod').length;

  // NULL means "not tracked" (e.g. not available from Jira); report null when nothing is tracked
  // Defect rate = stories ÷ bugs created in the sprint; defect density = achieved velocity ÷ bugs created
  // in the sprint. "Created in the sprint" = created between sprint start and close. Null when there are none.
  const createdInSprint = defects.filter((d) => d.created_at >= start && d.created_at < end).length;
  const storyCount = items.filter((i) => i.type === 'story').length;
  const perBugCreated = (n) => (createdInSprint ? round(n / createdInSprint, 1) : null);

  // P1 - Blocker issues in the sprint, and which were still open at sprint end (or now, while active)
  const p1 = items.filter((i) => /^p1\b|blocker/i.test(i.priority || ''));
  const p1Open = p1.filter((i) => statusAtEnd[items.indexOf(i)] !== 'done');

  const share = (list, key) => {
    const tracked = list.filter((i) => i[key] !== null && i[key] !== undefined);
    return tracked.length ? round(pct(tracked.filter((i) => i[key]).length, tracked.length)) : null;
  };

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
    // % of completion = achieved velocity ÷ committed velocity, where achieved counts
    // completed points from the sprint's commitment (work added mid-sprint is tracked as unplanned)
    completion: round(pct(completedCommitted, committed)),
    businessValue: sprintStories.length ? round(pct(completedStories.length, sprintStories.length)) : null,
    stories: { total: sprintStories.length, completed: completedStories.length },
    issueTypes: { rows: issueTypes, total: issueTypesTotal },
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
    p1Blockers: {
      total: p1.length,
      open: p1Open.length,
      openList: p1Open.map((i) => ({ key: i.issue_key, title: i.title })),
    },
    blocked: {
      items: blockedIssues.size,
      totalDays: round(sum(blockedPeriods, (b) => b.overlapDays), 1),
      longestDays: round(Math.max(0, ...blockedPeriods.map((b) => b.lengthDays)), 1),
      external: externalIssues.size,
      list: blockedPeriods
        .sort((a, b) => b.lengthDays - a.lengthDays)
        .map((b) => ({
          issueKey: b.issue_key, title: b.title, reason: b.reason, external: b.external, days: round(b.lengthDays, 1), open: !b.ended_at,
          startedAt: b.started_at, endedAt: b.ended_at,
          // Who it is stuck with: the workflow stage it was in when blocked
          blockedIn: b.blocked_in_status, stage: stageOf(b.blocked_in_status),
          // Still blocked: the current assignee is the person to chase; otherwise who had it then
          assignee: !b.ended_at ? b.assignee_name ?? b.blocked_assignee : b.blocked_assignee ?? b.assignee_name,
          currentStatus: b.jira_status,
        })),
      byStage: STAGES.map((stage) => ({
        stage,
        issues: new Set(blockedPeriods.filter((b) => stageOf(b.blocked_in_status) === stage).map((b) => b.issue_id)).size,
        open: new Set(blockedPeriods.filter((b) => !b.ended_at && stageOf(b.blocked_in_status) === stage).map((b) => b.issue_id)).size,
      })).filter((s) => s.issues > 0),
    },
    defects: {
      created: defects.length,
      createdList: defects.map(defectRef),
      closedList: closedDefects.map(defectRef),
      closed,
      open: defects.length - closed,
      uatPct: round(pct(uat, defects.length)),
      prodPct: round(pct(prod, defects.length)),
      createdInSprint,
      stories: storyCount,
      achievedVelocity: completedCommitted,
      defectRate: perBugCreated(storyCount),
      defectDensity: perBugCreated(completedCommitted),
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
  const lastDay = sprintEnd(sprint).toISOString().slice(0, 10);
  const days = workingDays(sprint.start_date, lastDay > sprint.end_date && sprint.completed_at ? lastDay : sprint.end_date);
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
      // No actual line for days that have not started yet
      actual: d.getTime() > Date.now() ? null : scope - done,
    };
  });
}

// ---------------------------------------------------------------------------
// Dashboard assembly
// ---------------------------------------------------------------------------

// quarter ('FY2026-Q3', Indian financial year) limits the trend charts to sprints that started in that quarter.
export async function getDashboard({ teamId, sprintId, assigneeId, quarter }) {
  const window = await loadSprintWindow(teamId, sprintId, quarter);
  if (!window.length) return null;

  const [{ rows: teamRows }, data] = await Promise.all([
    query(
      `SELECT t.*, p.id AS project_id, p.name AS project_name FROM teams t JOIN projects p ON p.id = t.project_id WHERE t.id = $1`,
      [teamId]
    ),
    loadData(window.map((s) => s.id), assigneeId),
  ]);
  const { rows: outcomeRows } = await query(
    `SELECT o.sprint_id, o.outcome, o.note, o.recorded_at, u.name AS recorded_by
       FROM sprint_goal_outcomes o LEFT JOIN users u ON u.id = o.recorded_by
      WHERE o.sprint_id = ANY($1)`,
    [window.map((s) => s.id)]
  );
  const outcomesBySprint = new Map(outcomeRows.map((o) => [o.sprint_id, o]));
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
  const prevVelocities = stats.slice(-TREND_SPRINTS, -1).map((s) => s.velocity);
  const velocityAvg = prevVelocities.length ? sum(prevVelocities, (v) => v) / prevVelocities.length : null;
  const velocityBand = velocityAvg === null ? null : { low: Math.round(velocityAvg * 0.9), high: Math.round(velocityAvg * 1.1) };

  // While a sprint is running, outcome metrics (completion etc.) can't be judged yet
  const isActive = sprint.status === 'active';
  const OUTCOME_METRICS = ['predictability', 'velocity', 'spillover'];
  const pending = (key) => isActive && OUTCOME_METRICS.includes(key);

  const targetLabel = (t) => (t ? `${t.operator === '>=' ? '≥' : '≤'} ${t.value}${t.metric === 'blocked_items' ? '' : '%'}` : '');
  const card = (key, label, value, prevValue, unit, target) => ({
    key,
    label,
    value,
    unit,
    prior: prevValue,
    delta: prevValue === null || pending(key) ? null : round(value - prevValue, 1),
    target: target ? targetLabel(target) : 'Stable band',
    status: pending(key)
      ? 'in_progress'
      : target
      ? (meetsTarget(value, target) ? 'on_track' : 'attention')
      : !velocityBand || (value >= velocityBand.low && value <= velocityBand.high) ? 'on_track' : 'attention',
    // for "higher is better" metrics the arrow colour flips
    higherIsBetter: !target || target.operator === '>=',
  });

  // Time elapsed: working days passed ÷ working days in the sprint (100% once it has closed)
  const sprintDays = workingDays(sprint.start_date, sprint.end_date);
  const today = new Date();
  const daysElapsed = sprint.status === 'completed' ? sprintDays.length : sprintDays.filter((d) => d <= today).length;
  const elapsedPct = sprintDays.length ? round(pct(daysElapsed, sprintDays.length)) : null;
  const shortDate = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).replace('Sept', 'Sep');

  const timeElapsedCard = {
    key: 'time_elapsed',
    label: 'Time Elapsed',
    value: elapsedPct,
    unit: '%',
    prior: null,
    delta: null,
    caption: sprint.status === 'completed' ? 'Sprint closed' : `Day ${daysElapsed} of ${sprintDays.length}`,
    footLeft: `${shortDate(sprint.start_date)} – ${shortDate(sprint.end_date)}`,
    footRight: `${sprintDays.length} working days`,
    barPct: elapsedPct,
    status: sprint.status === 'completed' ? 'on_track' : 'in_progress',
    higherIsBetter: true,
  };

  const p1Now = cur.p1Blockers;
  const p1Card = {
    key: 'p1_blockers',
    label: 'P1 - Blocker',
    value: p1Now.open,
    unit: '',
    prior: prev ? prev.p1Blockers.open : null,
    delta: prev ? p1Now.open - prev.p1Blockers.open : null,
    footLeft: 'Target 0 open',
    footRight: `${p1Now.total} in sprint`,
    barPct: p1Now.total ? round(pct(p1Now.open, p1Now.total)) : 0,
    status: p1Now.open > 0 ? 'attention' : 'on_track',
    higherIsBetter: false,
    issues: p1Now.openList,
  };

  const summary = [
    timeElapsedCard,
    card('predictability', 'Sprint Predictability', cur.predictability, prev?.predictability ?? null, '%', targets.predictability),
    card('velocity', 'Velocity', cur.velocity, prev?.velocity ?? null, 'SP', null),
    card('spillover', 'Spillover', cur.spilloverPct, prev?.spilloverPct ?? null, '%', targets.spillover),
    {
      ...card('unplanned', 'Unplanned Work', cur.unplannedPct, prev?.unplannedPct ?? null, '%', targets.unplanned),
      // Issues added after the sprint started (scope change), for the Scrum Master's drill-down
      addedIssues: cur.items
        .filter((i) => i.commitment === 'added')
        .sort((a, b) => (a.added_at ?? 0) - (b.added_at ?? 0))
        .map((i) => ({
          key: i.issue_key, title: i.title, type: i.type, points: i.points ?? 0,
          addedAt: i.added_at, addedBy: i.added_by, status: i.jira_status, done: i.outcome === 'completed',
        })),
      addedPoints: cur.added,
      committedPoints: cur.committed,
    },
    p1Card,
  ];

  const healthRow = (key, label, value, unit, target) => ({
    key,
    label,
    value,
    unit,
    target: target?.value,
    targetLabel: targetLabel(target),
    status: pending(key) ? 'in_progress' : meetsTarget(value, target) ? 'on_track' : 'attention',
  });
  const health = [
    healthRow('predictability', 'Sprint Predictability', cur.predictability, '%', targets.predictability),
    healthRow('spillover', 'Spillover', cur.spilloverPct, '%', targets.spillover),
    healthRow('unplanned', 'Unplanned Work', cur.unplannedPct, '%', targets.unplanned),
    healthRow('blocked_items', 'Blocked Work', cur.blocked.items, '', targets.blocked_items),
    healthRow('dod_compliance', 'DoD Compliance', cur.compliance.dod, '%', targets.dod_compliance),
  ];
  const attentionCount = health.filter((h) => h.status === 'attention').length;
  const sprintState = isActive
    ? 'in_progress'
    : attentionCount === 0 ? 'on_track' : attentionCount === 1 ? 'attention' : 'at_risk';

  // Trend charts: the chosen quarter's sprints (up to the selected one), otherwise the last few sprints
  const trend = quarter ? stats.filter((s) => quarterOf(s.startDate) === quarter) : stats.slice(-TREND_SPRINTS);
  const rolling = (i) => {
    const slice = stats.slice(Math.max(0, i - 2), i + 1);
    return round(sum(slice, (s) => s.velocity) / slice.length, 1);
  };
  const offset = stats.length - trend.length;

  const previousThroughputs = trend.slice(0, -1).map((s) => s.throughput);

  // Sprint goal: goal-tagged issues, suggested outcome, the recorded outcome, and the hit rate across the trend
  const goalItems = cur.items
    .filter((i) => i.is_goal_item)
    .map((i) => ({ key: i.issue_key, title: i.title, status: i.jira_status, done: i.outcome === 'completed' }));
  const recorded = outcomesBySprint.get(sprint.id);
  const sprintGoal = {
    text: sprint.goal,
    items: goalItems,
    ...suggestOutcome(goalItems, sprint.status),
    outcome: recorded
      ? { value: recorded.outcome, note: recorded.note, recordedBy: recorded.recorded_by, recordedAt: recorded.recorded_at }
      : null,
    hitRate: hitRate(trend.map((s) => window.find((w) => w.id === s.id)), outcomesBySprint),
  };

  return {
    context: {
      project: { id: team.project_id, name: team.project_name },
      team: { id: team.id, name: team.name, wipLimit: team.wip_limit },
      sprint: { id: sprint.id, name: sprint.name, goal: sprint.goal, startDate: sprint.start_date, endDate: sprint.end_date, completedAt: sprint.completed_at, release: sprint.release_name, status: sprint.status },
      quarter: quarter || null,
      generatedAt: new Date().toISOString(),
      // Used to link Jira issue numbers on the dashboard
      jiraBaseUrl: process.env.JIRA_BASE_URL?.replace(/\/$/, '') || null,
      sync: await lastSync(),
    },
    summary,
    sprintGoal,
    delivery: trend.map((s, i) => ({
      sprintId: s.id,
      sprint: s.name,
      businessValue: s.businessValue,
      storiesTotal: s.stories.total,
      storiesCompleted: s.stories.completed,
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
        average: previousThroughputs.length ? round(sum(trend, (s) => s.throughput) / trend.length) : null,
        sprintsInAverage: trend.length,
      },
      wip: { ...cur.wip, limit: team.wip_limit },
      // Cycle time per sprint (days from first "in progress" to done, for items completed in the sprint)
      cycleTimeTrend: trend.map((s) => ({ sprint: s.name, ...s.cycleTime, items: s.throughput })),
      blocked: cur.blocked,
    },
    scope: trend.map((s) => ({ sprint: s.name, completed: s.completed, added: s.added, spillover: s.spillover })),
    scopeAddedPct: cur.unplannedPct,
    quality: {
      current: cur.defects,
      trend: trend.map((s) => ({
        sprint: s.name,
        created: s.defects.created,
        closed: s.defects.closed,
        createdList: s.defects.createdList,
        closedList: s.defects.closedList,
        open: s.defects.open,
        createdInSprint: s.defects.createdInSprint,
        stories: s.defects.stories,
        achievedVelocity: s.defects.achievedVelocity,
        defectRate: s.defects.defectRate,
        defectDensity: s.defects.defectDensity,
      })),
    },
    health,
    sprintState,
    burndown: burndown(sprint, cur),
    compliance: cur.compliance,
    issueTypes: cur.issueTypes,
  };
}

export async function getFilters() {
  const [projects, teams, releases, sprints, members] = await Promise.all([
    query(`SELECT id, key, name FROM projects WHERE status = 'active' ORDER BY name`),
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

