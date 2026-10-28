// Pure functions that turn Jira sprint/issue JSON into AgileBoard records.
// No database or network access here, so this can be tested with saved Jira responses.

const GRACE_MS = 60 * 60 * 1000; // issues added within 1h of sprint start still count as committed

// Map a Jira status to one of AgileBoard's workflow states. `doneOnBoard` = the status sits in the
// board's Done (last) column, which is what Jira's sprint report counts as completed.
export function mapStatus(name = '', categoryKey = 'new', doneOnBoard = false) {
  if (doneOnBoard || categoryKey === 'done') return 'done';
  if (categoryKey === 'new') return 'todo';
  if (/review/i.test(name)) return 'in_review';
  if (/test|qa|verif|uat/i.test(name)) return 'in_test';
  return 'in_progress';
}

// Status ids in the board's last column ("Done"). Jira's sprint report treats these as completed,
// even when a status is in Jira's "In Progress" category (e.g. "Delivered to QA" on the Nexo board).
export function doneStatusIds(boardConfig) {
  const columns = boardConfig?.columnConfig?.columns || [];
  const last = [...columns].reverse().find((c) => c.statuses?.length);
  return new Set((last?.statuses || []).map((s) => String(s.id)));
}

// The field the board estimates with (Board settings → Estimation), as Jira's sprint report uses it.
// A site can have both "Story point estimate" and "Story Points"; only the board knows which one is filled in.
// null when the board estimates by issue count or time, or the config has no estimation.
export function boardEstimationField(boardConfig) {
  const e = boardConfig?.estimation;
  return e?.type === 'field' && e.field?.fieldId ? e.field.fieldId : null;
}

export function mapIssueType(name = '', isSubtask = false) {
  if (isSubtask || /sub-?task/i.test(name)) return 'subtask';
  if (/bug|defect/i.test(name)) return 'bug';
  if (/story/i.test(name)) return 'story';
  if (/spike|research/i.test(name)) return 'spike';
  return 'task';
}

// Calendar date of a Jira timestamp in the given timezone ('2026-09-28T18:30:00Z' in Asia/Kolkata -> '2026-09-29').
// Jira stores sprint dates in UTC; the date people see in Jira depends on their timezone.
export function localDate(iso, timeZone = 'UTC') {
  if (!iso) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

export function mapSprintState(state) {
  return state === 'active' ? 'active' : state === 'closed' ? 'completed' : 'planned';
}

export function mapFoundIn(issue) {
  const text = [...(issue.fields.labels || []), issue.fields.environment ? JSON.stringify(issue.fields.environment) : '']
    .join(' ')
    .toLowerCase();
  if (/prod/.test(text)) return 'prod';
  if (/uat/.test(text)) return 'uat';
  if (/\bdev\b/.test(text)) return 'dev';
  return 'qa';
}

export function mapSeverity(priorityName = '') {
  if (/highest|blocker|critical/i.test(priorityName)) return 'critical';
  if (/high|major/i.test(priorityName)) return 'high';
  if (/low|minor|trivial/i.test(priorityName)) return 'low';
  return 'medium';
}

// Jira label that marks an issue as part of the sprint goal
export const GOAL_LABEL = (process.env.SPRINT_GOAL_LABEL || 'sprint-goal').toLowerCase();

const splitIds = (value) => (value ? String(value).split(',').map((s) => s.trim()).filter(Boolean) : []);
const toDate = (v) => (v ? new Date(v) : null);

// Flatten changelog histories into [{ at, field, fieldId, from, to, fromString, toString }] sorted by time.
export function changelogItems(histories = []) {
  return histories
    .flatMap((h) => h.items.map((item) => ({ ...item, at: new Date(h.created), author: h.author?.displayName ?? null })))
    .sort((a, b) => a.at - b.at);
}

/**
 * Build everything AgileBoard stores for one issue within one sprint.
 * ctx: { sprint (Jira sprint JSON), fields: { storyPoints, sprint }, statusById: Map(id -> { name, category }), now }
 */
export function transformIssue(issue, histories, ctx) {
  const f = issue.fields;
  const { sprint, statusById } = ctx;
  const doneIds = ctx.doneStatusIds ?? new Set();
  const items = changelogItems(histories);
  const sprintId = String(sprint.id);
  const sprintStart = toDate(sprint.startDate);
  const sprintClose = toDate(sprint.completeDate);
  const created = toDate(f.created);

  const statusOf = (id, name) => {
    const s = statusById.get(String(id));
    return mapStatus(s?.name ?? name, s?.category, doneIds.has(String(id)));
  };

  // --- status history -------------------------------------------------------
  const history = items
    .filter((i) => i.field === 'status')
    .map((i) => ({ at: i.at, from: statusOf(i.from, i.fromString), to: statusOf(i.to, i.toString), toName: i.toString }))
    .filter((h) => h.from !== h.to);

  const currentStatus = mapStatus(f.status?.name, f.status?.statusCategory?.key, doneIds.has(String(f.status?.id)));
  const startedAt = history.find((h) => h.to !== 'todo')?.at ?? (currentStatus !== 'todo' ? created : null);
  const doneEvents = history.filter((h) => h.to === 'done');
  const completedAt = currentStatus === 'done' ? toDate(f.resolutiondate) ?? doneEvents.at(-1)?.at ?? null : null;

  const statusAt = (at) => {
    let s = history.length ? history[0].from : currentStatus;
    for (const h of history) {
      if (h.at > at) break;
      s = h.to;
    }
    return s;
  };

  // --- when did the issue join this sprint? -------------------------------------
  const sprintField = ctx.fields.sprint;
  const joined = items.find(
    (i) => (i.fieldId === sprintField || i.field === 'Sprint') && splitIds(i.to).includes(sprintId) && !splitIds(i.from).includes(sprintId)
  );
  const addedAt = joined?.at ?? created;
  // Who put it in the sprint: the changelog author, or whoever created it straight into the sprint
  const addedBy = joined ? joined.author : f.creator?.displayName ?? f.reporter?.displayName ?? null;
  const commitment = sprintStart && addedAt > new Date(sprintStart.getTime() + GRACE_MS) ? 'added' : 'committed';

  // --- outcome ---------------------------------------------------------------
  let outcome = null;
  if (sprint.state === 'closed') {
    outcome = statusAt(sprintClose ?? toDate(sprint.endDate)) === 'done' ? 'completed' : 'spillover';
  } else if (currentStatus === 'done') {
    outcome = 'completed';
  }

  // --- blocked periods (Flagged = Impediment, or a status named "Blocked") ------
  // Also note the Jira status and assignee at the moment it got blocked (who it is stuck with)
  const blocked = [];
  let open = null;
  let statusName = items.find((i) => i.field === 'status')?.fromString ?? f.status?.name ?? null;
  const firstAssignee = items.find((i) => i.field === 'assignee');
  let assigneeName = firstAssignee ? firstAssignee.fromString ?? null : f.assignee?.displayName ?? null;
  for (const i of items) {
    const flagOn = i.field === 'Flagged' && /impediment/i.test(i.toString || '');
    const flagOff = i.field === 'Flagged' && !/impediment/i.test(i.toString || '');
    const statusBlockedOn = i.field === 'status' && /block|hold/i.test(i.toString || '');
    const statusBlockedOff = i.field === 'status' && /block|hold/i.test(i.fromString || '') && !/block|hold/i.test(i.toString || '');
    if ((flagOn || statusBlockedOn) && !open) {
      open = {
        started_at: i.at,
        reason: flagOn ? 'Flagged as impediment' : `Status: ${i.toString}`,
        blocked_in_status: statusBlockedOn ? i.fromString ?? null : statusName,
        blocked_assignee: assigneeName,
      };
    }
    if ((flagOff || statusBlockedOff) && open) {
      blocked.push({ ...open, ended_at: i.at });
      open = null;
    }
    if (i.field === 'status') statusName = i.toString ?? statusName;
    if (i.field === 'assignee') assigneeName = i.toString ?? null;
  }
  if (open) blocked.push({ ...open, ended_at: null });
  const external = /external|vendor|dependency|client/i.test((f.labels || []).join(' '));

  const points = Number(f[ctx.fields.storyPoints]) || 0;
  const type = mapIssueType(f.issuetype?.name, f.issuetype?.subtask);
  const description = f.description ? JSON.stringify(f.description) : '';

  return {
    jiraId: String(issue.id),
    key: issue.key,
    title: (f.summary || '').slice(0, 255),
    type,
    points,
    status: currentStatus,
    jiraStatus: f.status?.name ?? null,
    priority: f.priority?.name ?? null,
    startedAt,
    completedAt,
    createdAt: created,
    assignee: f.assignee ? { accountId: f.assignee.accountId, name: f.assignee.displayName, email: f.assignee.emailAddress ?? null } : null,
    fixVersions: (f.fixVersions || []).map((v) => ({ name: v.name, releaseDate: v.releaseDate ?? null })),
    compliance: {
      dod: currentStatus === 'done' ? true : null,
      acceptanceCriteria: /acceptance criteria|given .* when .* then/i.test(description),
    },
    membership: { commitment, outcome, points, addedAt, addedBy },
    // Tagged in Jira as part of the sprint goal
    isGoalItem: (f.labels || []).some((l) => l.toLowerCase() === GOAL_LABEL),
    history,
    blocked: blocked.map((b) => ({ ...b, external })),
    defect:
      type === 'bug'
        ? {
            title: (f.summary || '').slice(0, 255),
            severity: mapSeverity(f.priority?.name),
            foundIn: mapFoundIn(issue),
            createdAt: created,
            closedAt: toDate(f.resolutiondate),
          }
        : null,
  };
}

// Which sprints of a board to sync: every active one, every closed one that started on or after `since`
// (YYYY-MM-DD), and at least the latest `closedCount` closed ones.
export function pickSprints(sprints, boardId, closedCount, since = null) {
  const own = sprints.filter((s) => !s.originBoardId || s.originBoardId === Number(boardId));
  const byStart = (a, b) => new Date(a.startDate || 0) - new Date(b.startDate || 0);
  const allClosed = own.filter((s) => s.state === 'closed').sort(byStart);
  const latest = new Set(allClosed.slice(-closedCount));
  const closed = allClosed.filter((s) => latest.has(s) || (since && (s.startDate || '').slice(0, 10) >= since));
  const active = own.filter((s) => s.state === 'active').sort(byStart);
  return [...closed, ...active];
}
