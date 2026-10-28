import { Router } from 'express';
import { query } from '../config/db.js';
import { createRedmineClient, redmineConfig, RedmineConfigError } from '../redmine/client.js';
import { syncFromRedmine, isRedmineSyncRunning, redmineSyncProgress, autoMatchUsers, SYNC_SINCE } from '../redmine/sync.js';

// Settings → Integrations → Redmine (administrators only: /api/admin is guarded in app.js)
const router = Router();
const UUID = /^[0-9a-f-]{36}$/i;
const bad = (res, error) => res.status(400).json({ error });

const fromRedmine = async (res, fn) => {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof RedmineConfigError ? err.message : `Could not load from Redmine: ${err.cause?.code || err.message}`;
    res.status(400).json({ error: msg });
    return null;
  }
};

// Redmine projects the API key can read, for the link picker
router.get('/admin/redmine/projects', async (req, res, next) => {
  try {
    const projects = await fromRedmine(res, async () => createRedmineClient(await redmineConfig()).projects());
    if (!projects) return;
    const { rows } = await query('SELECT redmine_project_id, project_id FROM redmine_project_links');
    const linked = new Map(rows.map((r) => [r.redmine_project_id, r.project_id]));
    res.json(projects.map((p) => ({ id: p.id, name: p.name, identifier: p.identifier, parent: p.parent?.name ?? null, linkedTo: linked.get(p.id) ?? null })));
  } catch (err) { next(err); }
});

// Everything the Redmine tab shows: links per project, import status and history, people summary
router.get('/admin/redmine', async (req, res, next) => {
  try {
    const [projects, runs, people] = await Promise.all([
      query(
        `SELECT p.id, p.key, p.name, p.status, l.redmine_project_id, l.redmine_project_name, l.include_subprojects, l.linked_at,
                (SELECT count(*)::int FROM redmine_time_entries e WHERE e.project_id = p.id AND e.spent_on >= $1) AS entries,
                (SELECT coalesce(sum(hours), 0)::float FROM redmine_time_entries e WHERE e.project_id = p.id AND e.spent_on >= $1) AS hours,
                (SELECT count(DISTINCT redmine_user_id)::int FROM redmine_time_entries e WHERE e.project_id = p.id AND e.spent_on >= $1) AS people,
                (SELECT max(spent_on) FROM redmine_time_entries e WHERE e.project_id = p.id) AS last_entry
           FROM projects p LEFT JOIN redmine_project_links l ON l.project_id = p.id
          ORDER BY p.name`,
        [SYNC_SINCE]
      ),
      query(`SELECT r.id, r.started_at, r.finished_at, r.status, r.trigger, r.projects, r.entries, r.users, r.message, u.name AS started_by
               FROM redmine_sync_runs r LEFT JOIN users u ON u.id = r.started_by ORDER BY r.started_at DESC LIMIT 10`),
      query(`SELECT count(*)::int AS total,
                    count(*) FILTER (WHERE user_id IS NOT NULL AND NOT ignored)::int AS matched,
                    count(*) FILTER (WHERE user_id IS NULL AND NOT ignored)::int AS unmatched,
                    count(*) FILTER (WHERE ignored)::int AS ignored
               FROM redmine_users ru WHERE EXISTS (SELECT 1 FROM redmine_time_entries e WHERE e.redmine_user_id = ru.id AND e.spent_on >= $1)`,
      [SYNC_SINCE]),
    ]);
    res.json({
      since: SYNC_SINCE,
      projects: projects.rows,
      runs: runs.rows,
      people: people.rows[0],
      running: isRedmineSyncRunning(),
      progress: redmineSyncProgress(),
    });
  } catch (err) { next(err); }
});

// Link a project to a Redmine project (or change the link)
router.put('/admin/redmine/links/:projectId', async (req, res, next) => {
  try {
    const { projectId } = req.params;
    const redmineProjectId = Number(req.body?.redmineProjectId);
    const includeSubprojects = req.body?.includeSubprojects !== false;
    if (!UUID.test(projectId)) return bad(res, 'Invalid project');
    if (!Number.isInteger(redmineProjectId) || redmineProjectId <= 0) return bad(res, 'Choose a Redmine project');
    const projects = await fromRedmine(res, async () => createRedmineClient(await redmineConfig()).projects());
    if (!projects) return;
    const rp = projects.find((p) => p.id === redmineProjectId);
    if (!rp) return bad(res, 'That Redmine project is not visible to the API key');
    const { rows: taken } = await query(
      `SELECT p.name FROM redmine_project_links l JOIN projects p ON p.id = l.project_id WHERE l.redmine_project_id = $1 AND l.project_id <> $2`,
      [redmineProjectId, projectId]
    );
    if (taken.length) return res.status(409).json({ error: `${rp.name} is already linked to ${taken[0].name}` });
    const { rowCount } = await query(
      `INSERT INTO redmine_project_links (project_id, redmine_project_id, redmine_project_name, include_subprojects, linked_by)
       SELECT id, $2, $3, $4, $5 FROM projects WHERE id = $1
       ON CONFLICT (project_id) DO UPDATE SET redmine_project_id = EXCLUDED.redmine_project_id, redmine_project_name = EXCLUDED.redmine_project_name,
         include_subprojects = EXCLUDED.include_subprojects, linked_by = EXCLUDED.linked_by, linked_at = now()`,
      [projectId, rp.id, rp.name, includeSubprojects, req.user.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Project not found' });
    // Entries imported under an earlier link may not belong any more: the next import fills them in again
    await query('DELETE FROM redmine_time_entries WHERE project_id = $1', [projectId]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Unlink: its imported time entries are removed too
router.delete('/admin/redmine/links/:projectId', async (req, res, next) => {
  try {
    if (!UUID.test(req.params.projectId)) return bad(res, 'Invalid project');
    await query('DELETE FROM redmine_project_links WHERE project_id = $1', [req.params.projectId]);
    await query('DELETE FROM redmine_time_entries WHERE project_id = $1', [req.params.projectId]);
    res.status(204).end();
  } catch (err) { next(err); }
});

// Start an import in the background (202); GET /admin/redmine/sync follows it
router.post('/admin/redmine/sync', async (req, res, next) => {
  try {
    const already = isRedmineSyncRunning();
    if (!already) {
      syncFromRedmine({ trigger: 'manual', userId: req.user.id }).catch((err) => console.error('Redmine import failed:', err.message));
    }
    res.status(202).json({ started: !already, running: true, progress: redmineSyncProgress() });
  } catch (err) { next(err); }
});

router.get('/admin/redmine/sync', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT status, started_at, finished_at, message, entries FROM redmine_sync_runs ORDER BY started_at DESC LIMIT 1');
    res.json({ running: isRedmineSyncRunning(), progress: redmineSyncProgress(), latest: rows[0] ?? null });
  } catch (err) { next(err); }
});

// Redmine people with hours since the start date, and who they are in AgileMetrix
router.get('/admin/redmine/users', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT ru.id, ru.name, ru.user_id, u.name AS user_name, ru.match, ru.ignored,
              count(e.id)::int AS entries, coalesce(sum(e.hours), 0)::float AS hours, max(e.spent_on) AS last_entry,
              array_agg(DISTINCT p.name) FILTER (WHERE p.name IS NOT NULL) AS projects
         FROM redmine_users ru
         JOIN redmine_time_entries e ON e.redmine_user_id = ru.id AND e.spent_on >= $1
         LEFT JOIN projects p ON p.id = e.project_id
         LEFT JOIN users u ON u.id = ru.user_id
        GROUP BY ru.id, u.name
        ORDER BY (ru.user_id IS NULL AND NOT ru.ignored) DESC, ru.name`,
      [SYNC_SINCE]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// Match a Redmine person to an AgileMetrix user (userId null = no match), or ignore them
router.put('/admin/redmine/users/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return bad(res, 'Invalid Redmine user');
    const { userId, ignored } = req.body ?? {};
    if (userId != null && !UUID.test(userId)) return bad(res, 'Invalid user');
    const r = await query(
      `UPDATE redmine_users SET user_id = $2, match = 'manual', ignored = $3 WHERE id = $1`,
      [id, ignored ? null : (userId ?? null), !!ignored]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'Redmine user not found' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Undo manual choices: match by name again
router.post('/admin/redmine/users/auto-match', async (req, res, next) => {
  try {
    await autoMatchUsers();
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
