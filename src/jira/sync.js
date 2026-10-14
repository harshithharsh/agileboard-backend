import { pool, query } from '../config/db.js';
import { createJiraClient } from './client.js';
import { transformIssue, pickSprints, mapSprintState, doneStatusIds, localDate } from './transform.js';

const SYNC_CLOSED_SPRINTS = Number(process.env.JIRA_SYNC_CLOSED_SPRINTS || 6);
// Sync every sprint that started since this date (default: 1 January of the current year), for the quarter filter
const SYNC_SINCE = process.env.JIRA_SYNC_SINCE || `${new Date().getFullYear()}-01-01`;
let running = null; // only one sync at a time

// Find the custom field ids for Sprint and Story Points (they differ between Jira sites).
async function resolveFields(jira) {
  const fields = await jira.fields();
  const byName = (re) => fields.find((f) => re.test(f.name))?.id;
  return {
    sprint: process.env.JIRA_SPRINT_FIELD || fields.find((f) => f.schema?.custom === 'com.pyxis.greenhopper.jira:gh-sprint')?.id || byName(/^sprint$/i),
    storyPoints: process.env.JIRA_STORY_POINTS_FIELD || byName(/^story point estimate$/i) || byName(/^story points?$/i),
  };
}

async function upsertUser(client, assignee, teamId) {
  if (!assignee) return null;
  const { rows } = await client.query(
    `INSERT INTO users (name, email, jira_account_id) VALUES ($1, $2, $3)
     ON CONFLICT (jira_account_id) DO UPDATE SET name = EXCLUDED.name, email = COALESCE(EXCLUDED.email, users.email)
     RETURNING id`,
    [assignee.name, assignee.email, assignee.accountId]
  );
  await client.query('INSERT INTO team_members (team_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [teamId, rows[0].id]);
  return rows[0].id;
}

async function upsertRelease(client, projectId, version) {
  const { rows } = await client.query(
    `INSERT INTO releases (project_id, name, target_date) VALUES ($1, $2, $3)
     ON CONFLICT (project_id, name) DO UPDATE SET target_date = COALESCE(EXCLUDED.target_date, releases.target_date)
     RETURNING id`,
    [projectId, version.name, version.releaseDate]
  );
  return rows[0].id;
}

// Write one sprint and all of its issues in a single transaction.
async function saveSprint(team, sprint, records, timeZone) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Release = the fix version most issues in the sprint point at
    const counts = new Map();
    for (const r of records) for (const v of r.fixVersions) counts.set(v.name, (counts.get(v.name) || 0) + 1);
    const topVersion = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    const releaseId = topVersion
      ? await upsertRelease(client, team.project_id, records.flatMap((r) => r.fixVersions).find((v) => v.name === topVersion[0]))
      : null;

    // Sprint dates as shown in Jira for the configured timezone
    const day = (v) => localDate(v, timeZone);
    const { rows: [saved] } = await client.query(
      `INSERT INTO sprints (team_id, release_id, name, goal, start_date, end_date, started_at, completed_at, status, jira_sprint_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (jira_sprint_id) DO UPDATE SET
         team_id = EXCLUDED.team_id, release_id = EXCLUDED.release_id, name = EXCLUDED.name, goal = EXCLUDED.goal,
         start_date = EXCLUDED.start_date, end_date = EXCLUDED.end_date, started_at = EXCLUDED.started_at,
         completed_at = EXCLUDED.completed_at, status = EXCLUDED.status
       RETURNING id`,
      [team.id, releaseId, sprint.name, sprint.goal || null, day(sprint.startDate), day(sprint.endDate) || day(sprint.startDate),
        sprint.startDate || null, sprint.completeDate || null, mapSprintState(sprint.state), sprint.id]
    );

    await client.query('DELETE FROM sprint_issues WHERE sprint_id = $1', [saved.id]);
    await client.query('DELETE FROM defects WHERE sprint_id = $1', [saved.id]);

    for (const r of records) {
      const assigneeId = await upsertUser(client, r.assignee, team.id);
      const { rows: [issue] } = await client.query(
        `INSERT INTO issues (project_id, issue_key, title, type, story_points, assignee_id, status, jira_status,
                             started_at, completed_at, dod_met, has_acceptance_criteria, created_at, jira_issue_id, priority)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         ON CONFLICT (jira_issue_id) DO UPDATE SET
           issue_key = EXCLUDED.issue_key, title = EXCLUDED.title, type = EXCLUDED.type, story_points = EXCLUDED.story_points,
           assignee_id = EXCLUDED.assignee_id, status = EXCLUDED.status, jira_status = EXCLUDED.jira_status,
           started_at = EXCLUDED.started_at, completed_at = EXCLUDED.completed_at, dod_met = EXCLUDED.dod_met,
           has_acceptance_criteria = EXCLUDED.has_acceptance_criteria, priority = EXCLUDED.priority
         RETURNING id`,
        [team.project_id, r.key, r.title, r.type, r.points, assigneeId, r.status, r.jiraStatus,
          r.startedAt, r.completedAt, r.compliance.dod, r.compliance.acceptanceCriteria, r.createdAt, r.jiraId, r.priority]
      );

      await client.query(
        `INSERT INTO sprint_issues (sprint_id, issue_id, commitment, outcome, points, added_at) VALUES ($1, $2, $3, $4, $5, $6)`,
        [saved.id, issue.id, r.membership.commitment, r.membership.outcome, r.membership.points, r.membership.addedAt]
      );

      await client.query('DELETE FROM issue_status_history WHERE issue_id = $1', [issue.id]);
      for (const h of r.history) {
        await client.query('INSERT INTO issue_status_history (issue_id, from_status, to_status, changed_at) VALUES ($1, $2, $3, $4)',
          [issue.id, h.from, h.to, h.at]);
      }
      await client.query('DELETE FROM blocked_periods WHERE issue_id = $1', [issue.id]);
      for (const b of r.blocked) {
        await client.query(
          `INSERT INTO blocked_periods (issue_id, reason, external, started_at, ended_at, blocked_in_status, blocked_assignee)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [issue.id, b.reason, b.external, b.started_at, b.ended_at, b.blocked_in_status ?? null, b.blocked_assignee ?? null]);
      }
      if (r.defect) {
        const d = r.defect;
        await client.query(
          `INSERT INTO defects (project_id, sprint_id, issue_id, title, severity, found_in, created_at, closed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [team.project_id, saved.id, issue.id, d.title, d.severity, d.foundIn, d.createdAt, d.closedAt]
        );
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function syncTeam(jira, team, fields, statusById, log, timeZone) {
  const all = await jira.boardSprints(team.jira_board_id);
  // Completed = the board's Done column, like Jira's sprint report
  const doneIds = jira.boardConfiguration ? doneStatusIds(await jira.boardConfiguration(team.jira_board_id)) : new Set();
  const sprints = pickSprints(all, team.jira_board_id, SYNC_CLOSED_SPRINTS, SYNC_SINCE);
  log(`${team.name} (board ${team.jira_board_id}): ${sprints.map((s) => s.name).join(', ') || 'no sprints'}`);

  const requestFields = ['summary', 'status', 'issuetype', 'assignee', 'created', 'resolutiondate', 'labels',
    'environment', 'priority', 'fixVersions', 'description', fields.storyPoints, fields.sprint].filter(Boolean);

  for (const sprint of sprints) {
    const issues = (await jira.sprintIssues(sprint.id, requestFields)).filter(
      // Epics are skipped; sub-tasks are kept for the Issues by Type count but excluded from metrics
      (i) => !/epic/i.test(i.fields.issuetype?.name || '')
    );
    const records = [];
    for (const issue of issues) {
      let histories = issue.changelog?.histories || [];
      if (issue.changelog && issue.changelog.total > histories.length) histories = await jira.issueChangelog(issue.id);
      records.push(transformIssue(issue, histories, { sprint, fields, statusById, doneStatusIds: doneIds }));
    }
    await saveSprint(team, sprint, records, timeZone);
    log(`  ${sprint.name} [${sprint.state}]: ${records.length} issues`);
  }
  return sprints.length;
}

// `jira` can be injected (e.g. a stub in tests); by default a real client is created from .env
export async function syncFromJira({ log = console.log, jira: injected } = {}) {
  if (running) return running;
  running = (async () => {
    const { rows: [run] } = await query(`INSERT INTO sync_runs DEFAULT VALUES RETURNING id`);
    try {
      const jira = injected ?? createJiraClient();
      // Check the login first: without it Jira still answers some calls, which hides the real problem
      const me = injected ? null : await jira.get('/rest/api/3/myself');
      // Sprint dates use JIRA_TIMEZONE if set, otherwise the timezone of the Jira account used for syncing
      const timeZone = process.env.JIRA_TIMEZONE || me?.timeZone || 'UTC';
      log(`Sprint dates in timezone: ${timeZone}`);
      const fields = await resolveFields(jira);
      if (!fields.sprint) throw new Error('Could not find the Sprint field in Jira');
      log(`Jira fields: sprint=${fields.sprint}, story points=${fields.storyPoints ?? 'not found'}`);
      const statuses = await jira.statuses();
      const statusById = new Map(statuses.map((s) => [String(s.id), { name: s.name, category: s.statusCategory?.key }]));

      // Teams of active projects that have a Jira board (configured in Admin)
      const { rows: teams } = await query(
        `SELECT t.* FROM teams t JOIN projects p ON p.id = t.project_id
          WHERE t.jira_board_id IS NOT NULL AND p.status = 'active' ORDER BY t.name`
      );
      let sprintCount = 0;
      for (const team of teams) sprintCount += await syncTeam(jira, team, fields, statusById, log, timeZone);

      const message = `Synced ${sprintCount} sprints for ${teams.length} teams`;
      await query(`UPDATE sync_runs SET status = 'success', finished_at = now(), message = $2 WHERE id = $1`, [run.id, message]);
      log(message);
      return { status: 'success', message };
    } catch (err) {
      await query(`UPDATE sync_runs SET status = 'failed', finished_at = now(), message = $2 WHERE id = $1`, [run.id, describeSyncError(err)]);
      throw err;
    }
  })().finally(() => {
    running = null;
  });
  return running;
}

export const isSyncRunning = () => running !== null;

// A readable reason for a failed sync (stored with the run and shown on the dashboard)
export function describeSyncError(err) {
  const code = err.cause?.code;
  if (err.message === 'fetch failed' || ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) {
    const host = err.cause?.hostname ? ` (${err.cause.hostname})` : '';
    return `Cannot reach Jira${host}: ${code || 'network error'}. Check the server's internet connection`;
  }
  return err.message;
}

// Runs left 'running' by a restart mid-sync never finish: mark them failed at startup
export async function closeInterruptedSyncs() {
  await query(`UPDATE sync_runs SET status = 'failed', finished_at = now(), message = 'Interrupted (the server restarted during the sync)'
                WHERE status = 'running'`);
}

export async function lastSync() {
  const { rows } = await query(
    `SELECT status, started_at, finished_at, message FROM sync_runs ORDER BY started_at DESC LIMIT 1`
  );
  const { rows: ok } = await query(`SELECT finished_at FROM sync_runs WHERE status = 'success' ORDER BY finished_at DESC LIMIT 1`);
  return { latest: rows[0] || null, lastSuccessAt: ok[0]?.finished_at || null };
}
