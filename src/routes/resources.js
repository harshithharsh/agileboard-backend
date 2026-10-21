import { Router } from 'express';
import { pool, query } from '../config/db.js';
import { requirePermission } from '../auth/middleware.js';
import { SYNC_SINCE } from '../redmine/sync.js';

// Resource Management data: people (AgileMetrix users on the Jira teams or matched to Redmine people),
// their FTE and allocations, the Jira teams and projects, and the imported Redmine time entries.
// Shaped like the screens' data model (src/resources in the frontend), so the calculations stay there.
const router = Router();
const UUID = /^[0-9a-f-]{36}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME_ZONE = process.env.JIRA_TIMEZONE || 'Asia/Kolkata';

// Capacity rules; an administrator can override them in app_settings 'resource_rules'
const DEFAULT_RULES = {
  hoursPerDay: 7,
  workingWeekdays: [1, 2, 3, 4, 5], // Monday–Friday
  weekStart: 1,
  defaultFte: 1,
  fiscalYearStartMonth: 4, // April
  timeZone: TIME_ZONE,
  thresholds: { under: 85, over: 105 },
  leaveHandling: 'exclude',
  holidays: [],
};
const LEAVE = /\b(leave|holiday|vacation|time off)\b/i;

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const num = (v) => (v == null ? null : Number(v));

router.get('/resources', async (req, res, next) => {
  try {
    const [settings, projects, links, teams, entries, rUsers, syncRuns] = await Promise.all([
      query(`SELECT value FROM app_settings WHERE key = 'resource_rules'`),
      query(`SELECT id, key, name FROM projects WHERE status = 'active' ORDER BY name`),
      query(`SELECT l.project_id, l.redmine_project_id, l.redmine_project_name FROM redmine_project_links l`),
      query(`SELECT t.id, t.name, t.project_id FROM teams t JOIN projects p ON p.id = t.project_id WHERE p.status = 'active' ORDER BY t.name`),
      query(`SELECT e.id, e.redmine_user_id, e.project_id, e.spent_on::text AS spent_on, e.hours::float AS hours, e.activity
               FROM redmine_time_entries e WHERE e.spent_on >= $1`, [SYNC_SINCE]),
      query(`SELECT ru.id, ru.name, ru.user_id, ru.ignored FROM redmine_users ru
              WHERE EXISTS (SELECT 1 FROM redmine_time_entries e WHERE e.redmine_user_id = ru.id AND e.spent_on >= $1)`, [SYNC_SINCE]),
      query(`SELECT id, started_at, finished_at, status, entries, users, message FROM redmine_sync_runs ORDER BY started_at DESC LIMIT 20`),
    ]);

    // People: on a team of an active project, matched to a Redmine person, or with FTE / allocations set
    const { rows: people } = await query(
      `SELECT u.id, u.name, u.email, rp.employment_fte, rp.weekly_hours, rp.team_id AS team_override,
              (SELECT tm.team_id FROM team_members tm JOIN teams t ON t.id = tm.team_id JOIN projects p ON p.id = t.project_id
                WHERE tm.user_id = u.id AND NOT tm.excluded AND p.status = 'active' ORDER BY t.name LIMIT 1) AS jira_team
         FROM users u LEFT JOIN resource_profiles rp ON rp.user_id = u.id
        WHERE u.status = 'active' AND (
              EXISTS (SELECT 1 FROM team_members tm JOIN teams t ON t.id = tm.team_id JOIN projects p ON p.id = t.project_id
                       WHERE tm.user_id = u.id AND NOT tm.excluded AND p.status = 'active')
           OR EXISTS (SELECT 1 FROM redmine_users ru WHERE ru.user_id = u.id AND NOT ru.ignored)
           OR rp.user_id IS NOT NULL
           OR EXISTS (SELECT 1 FROM resource_allocations a WHERE a.user_id = u.id))
        ORDER BY u.name`
    );
    const { rows: allocations } = await query(
      `SELECT id, user_id, project_id, fte::float AS fte, start_date::text AS start_date, end_date::text AS end_date, modified_by, modified_at FROM resource_allocations ORDER BY start_date`
    );

    // A person may have more than one Redmine account: count all of them under the first one
    const primary = new Map(); // AgileMetrix user id -> Redmine user id used in the screens
    const alias = new Map(); // Redmine user id -> Redmine user id used in the screens
    for (const ru of [...rUsers.rows].sort((a, b) => a.id - b.id)) {
      if (!ru.user_id || ru.ignored) continue;
      if (!primary.has(ru.user_id)) primary.set(ru.user_id, ru.id);
      alias.set(ru.id, primary.get(ru.user_id));
    }

    const activities = [...new Set(entries.rows.map((e) => e.activity).filter(Boolean))].sort();
    const saved = settings.rows[0]?.value ?? {};
    const rules = {
      ...DEFAULT_RULES,
      ...saved,
      activities,
      eligibleActivities: saved.eligibleActivities ?? activities.filter((a) => !LEAVE.test(a)),
    };
    const linkOf = new Map(links.rows.map((l) => [l.project_id, l]));

    res.json({
      demo: false,
      today: today(),
      since: SYNC_SINCE,
      rules,
      projects: projects.rows.map((p) => ({ id: p.id, key: p.key, name: p.name, redmineProjectId: linkOf.get(p.id)?.redmine_project_id ?? null })),
      redmineProjects: links.rows.map((l) => ({ id: l.redmine_project_id, name: l.redmine_project_name, mappedProjectId: l.project_id })),
      teams: teams.rows.map((t) => ({
        id: t.id, name: t.name, kind: 'team', leadId: null, projectId: t.project_id,
        redmineProjectIds: linkOf.get(t.project_id) ? [linkOf.get(t.project_id).redmine_project_id] : [],
      })),
      resources: people.map((p) => ({
        id: p.id, name: p.name, email: p.email, teamId: p.team_override ?? p.jira_team ?? null,
        employmentFte: num(p.employment_fte), weeklyHours: num(p.weekly_hours), redmineUserId: primary.get(p.id) ?? null,
      })),
      allocations: allocations.map((a) => ({
        id: a.id, resourceId: a.user_id, projectId: a.project_id, fte: a.fte, startDate: a.start_date, endDate: a.end_date ?? null,
        modifiedBy: a.modified_by, modifiedAt: a.modified_at,
      })),
      leave: [],
      redmineUsers: rUsers.rows.filter((u) => !alias.has(u.id) || alias.get(u.id) === u.id)
        .map((u) => ({ id: u.id, login: null, name: u.name.replace(/\s+/g, ' ').trim(), email: null })),
      entries: entries.rows.map((e) => ({
        id: e.id, redmineUserId: alias.get(e.redmine_user_id) ?? e.redmine_user_id, projectId: e.project_id,
        date: e.spent_on, hours: e.hours, activity: e.activity,
      })),
      history: [],
      integration: { ignoredUserIds: rUsers.rows.filter((u) => u.ignored).map((u) => u.id) },
      syncRuns: syncRuns.rows.map((s) => ({
        id: s.id, startedAt: s.started_at, status: s.status === 'running' ? 'partial' : s.status, entries: s.entries ?? 0, users: s.users ?? 0,
        seconds: s.finished_at ? Math.round((new Date(s.finished_at) - new Date(s.started_at)) / 1000) : null,
        message: s.status === 'success' ? null : s.message,
      })),
    });
  } catch (err) { next(err); }
});

// Employment FTE, weekly hours, team (for Resource Management) and Redmine person of one person
router.put('/resources/:id', requirePermission('edit'), async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID.test(id)) return res.status(400).json({ error: 'Invalid person' });
    const b = req.body ?? {};
    const fte = b.employmentFte == null || b.employmentFte === '' ? null : Number(b.employmentFte);
    const weekly = b.weeklyHours == null || b.weeklyHours === '' ? null : Number(b.weeklyHours);
    if (fte !== null && !(fte >= 0 && fte <= 1.5)) return res.status(400).json({ error: 'Employment FTE must be between 0 and 1.5' });
    if (weekly !== null && !(weekly > 0 && weekly <= 80)) return res.status(400).json({ error: 'Weekly hours must be between 1 and 80' });
    if (b.teamId != null && !UUID.test(b.teamId)) return res.status(400).json({ error: 'Invalid team' });
    const { rows: [current] } = await query(
      `SELECT (SELECT tm.team_id FROM team_members tm JOIN teams t ON t.id = tm.team_id WHERE tm.user_id = u.id AND NOT tm.excluded ORDER BY t.name LIMIT 1) AS jira_team
         FROM users u WHERE u.id = $1`, [id]
    );
    if (!current) return res.status(404).json({ error: 'Person not found' });
    // Keep the Jira team unless a different one is chosen here
    const teamOverride = b.teamId && b.teamId !== current.jira_team ? b.teamId : null;
    await query(
      `INSERT INTO resource_profiles (user_id, employment_fte, weekly_hours, team_id, updated_by, updated_at) VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (user_id) DO UPDATE SET employment_fte = EXCLUDED.employment_fte, weekly_hours = EXCLUDED.weekly_hours,
         team_id = EXCLUDED.team_id, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [id, fte, weekly, teamOverride, req.user.id]
    );
    // Redmine person chosen in the drawer: match it to this person (manual), and unmatch the previous one
    if (b.redmineUserId !== undefined) {
      const ru = b.redmineUserId == null || b.redmineUserId === '' ? null : Number(b.redmineUserId);
      const { rows: mine } = await query('SELECT id FROM redmine_users WHERE user_id = $1 AND NOT ignored', [id]);
      const unchanged = ru === null ? !mine.length : mine.some((m) => m.id === ru);
      if (unchanged) return res.json({ ok: true });
      await query(`UPDATE redmine_users SET user_id = NULL, match = 'manual' WHERE user_id = $1 AND ($2::int IS NULL OR id <> $2)`, [id, ru]);
      if (ru) await query(`UPDATE redmine_users SET user_id = $1, match = 'manual', ignored = false WHERE id = $2`, [id, ru]);
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Replace one person's allocations (the drawer ends changed rows the day before and adds new ones)
router.put('/resources/:id/allocations', requirePermission('edit'), async (req, res, next) => {
  const { id } = req.params;
  if (!UUID.test(id)) return res.status(400).json({ error: 'Invalid person' });
  const list = Array.isArray(req.body?.allocations) ? req.body.allocations : null;
  if (!list) return res.status(400).json({ error: 'allocations must be a list' });
  for (const a of list) {
    if (!UUID.test(a.projectId ?? '')) return res.status(400).json({ error: 'Each allocation needs a project' });
    if (!(Number(a.fte) > 0 && Number(a.fte) <= 1.5)) return res.status(400).json({ error: 'FTE must be more than 0 and at most 1.5' });
    if (!DAY.test(a.startDate ?? '') || (a.endDate && !DAY.test(a.endDate))) return res.status(400).json({ error: 'Dates must look like 2026-04-01' });
    if (a.endDate && a.endDate < a.startDate) return res.status(400).json({ error: 'An allocation can’t end before it starts' });
  }
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('DELETE FROM resource_allocations WHERE user_id = $1', [id]);
    for (const a of list) {
      await c.query(
        `INSERT INTO resource_allocations (id, user_id, project_id, fte, start_date, end_date, modified_by, modified_at)
         VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, COALESCE($8::timestamptz, now()))`,
        [UUID.test(a.id ?? '') ? a.id : null, id, a.projectId, Number(a.fte), a.startDate, a.endDate || null,
          (a.modifiedBy || req.user.name || '').slice(0, 120), a.modifiedAt || null]
      );
    }
    await c.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await c.query('ROLLBACK');
    next(err);
  } finally {
    c.release();
  }
});

export default router;
