import { pool, query } from '../config/db.js';
import { createRedmineClient } from './client.js';

// Import time entries of the Redmine projects linked in Settings → Integrations → Redmine.
// Each run re-reads every entry since SYNC_SINCE, so edits and deletions in Redmine are picked up.
const today = new Date();
export const SYNC_SINCE = process.env.REDMINE_SYNC_SINCE
  || `${today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1}-04-01`; // Indian financial year

let running = null; // only one import at a time
let progress = null;

export const isRedmineSyncRunning = () => running !== null;
export const redmineSyncProgress = () => (progress ? { ...progress } : null);

// Custom field "Jira #" on a time entry, if filled in
const jiraKey = (e) => {
  const v = e.custom_fields?.find((f) => /jira/i.test(f.name))?.value;
  return typeof v === 'string' && /^[A-Z][A-Z0-9_]+-\d+$/i.test(v.trim()) ? v.trim().toUpperCase() : null;
};

async function importProject(client, link, entries) {
  const people = [...new Map(entries.map((e) => [e.user.id, e.user.name])).entries()];
  await client.query(
    `INSERT INTO redmine_users (id, name) SELECT * FROM unnest($1::int[], $2::text[])
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
    [people.map(([id]) => id), people.map(([, name]) => name)]
  );
  const col = (fn) => entries.map(fn);
  for (let i = 0; i < entries.length; i += 2000) {
    const part = entries.slice(i, i + 2000);
    const c = (fn) => part.map(fn);
    await client.query(
      `INSERT INTO redmine_time_entries
         (id, project_id, redmine_project_id, redmine_project_name, redmine_user_id, spent_on, hours, activity, redmine_issue_id, jira_key, updated_on)
       SELECT id, $2, rp, rpn, ru, so, h, act, iss, jk, uo
         FROM unnest($1::int[], $3::int[], $4::text[], $5::int[], $6::date[], $7::numeric[], $8::text[], $9::int[], $10::text[], $11::timestamptz[])
              AS t(id, rp, rpn, ru, so, h, act, iss, jk, uo)
       ON CONFLICT (id) DO UPDATE SET project_id = EXCLUDED.project_id, redmine_project_id = EXCLUDED.redmine_project_id,
         redmine_project_name = EXCLUDED.redmine_project_name, redmine_user_id = EXCLUDED.redmine_user_id, spent_on = EXCLUDED.spent_on,
         hours = EXCLUDED.hours, activity = EXCLUDED.activity, redmine_issue_id = EXCLUDED.redmine_issue_id,
         jira_key = EXCLUDED.jira_key, updated_on = EXCLUDED.updated_on`,
      [c((e) => e.id), link.project_id, c((e) => e.project.id), c((e) => e.project.name), c((e) => e.user.id), c((e) => e.spent_on),
        c((e) => e.hours), c((e) => e.activity?.name ?? null), c((e) => e.issue?.id ?? null), c((e) => jiraKey(e)), c((e) => e.updated_on ?? null)]
    );
  }
  // Deleted in Redmine (or moved out of the linked project) since the start date
  await client.query(
    'DELETE FROM redmine_time_entries WHERE project_id = $1 AND spent_on >= $2 AND NOT (id = ANY($3::int[]))',
    [link.project_id, SYNC_SINCE, col((e) => e.id)]
  );
}

// Same name as exactly one AgileMetrix user (ignoring case, dots and extra spaces) → matched
// automatically; manual matches and ignored people are kept as they are
const NORM = (col) => `lower(regexp_replace(regexp_replace(${col}, '[.]', ' ', 'g'), '\\s+', ' ', 'g'))`;
const NORM_TRIM = (col) => `trim(${NORM(col)})`;

export async function autoMatchUsers(c = { query }) {
  await c.query(
    `UPDATE redmine_users ru SET user_id = m.user_id, match = 'auto'
       FROM (SELECT ru2.id, min(u.id::text)::uuid AS user_id
               FROM redmine_users ru2 JOIN users u ON ${NORM_TRIM('u.name')} = ${NORM_TRIM('ru2.name')}
              GROUP BY ru2.id HAVING count(*) = 1) m
      WHERE ru.id = m.id AND ru.user_id IS NULL AND ru.match IS NULL AND NOT ru.ignored`
  );
}

export async function syncFromRedmine({ trigger = 'manual', userId = null, redmine } = {}) {
  if (running) return running;
  running = (async () => {
    const { rows: [run] } = await query(
      `INSERT INTO redmine_sync_runs (trigger, started_by) VALUES ($1, $2) RETURNING id`, [trigger, userId]
    );
    progress = { phase: 'connecting', projectsDone: 0, projectsTotal: 0, current: null, entries: 0, total: 0, startedAt: new Date().toISOString() };
    const failures = [];
    let entries = 0;
    let projects = 0;
    try {
      const api = redmine ?? createRedmineClient();
      const { rows: links } = await query(
        `SELECT l.*, p.name AS project_name FROM redmine_project_links l JOIN projects p ON p.id = l.project_id
          WHERE p.status = 'active' ORDER BY p.name`
      );
      if (!links.length) throw new Error('No Jira project is linked to a Redmine project yet');
      progress = { ...progress, phase: 'importing', projectsTotal: links.length };
      for (const link of links) {
        progress = { ...progress, current: `${link.project_name} ← ${link.redmine_project_name}`, entries: 0, total: 0 };
        try {
          const list = await api.timeEntries(link.redmine_project_id, {
            from: SYNC_SINCE, includeSubprojects: link.include_subprojects,
            onPage: (n, total) => { progress = { ...progress, entries: n, total }; },
          });
          const c = await pool.connect();
          try {
            await c.query('BEGIN');
            await importProject(c, link, list);
            await c.query('COMMIT');
          } catch (err) {
            await c.query('ROLLBACK');
            throw err;
          } finally {
            c.release();
          }
          entries += list.length;
          projects += 1;
        } catch (err) {
          failures.push(`${link.redmine_project_name}: ${err.message}`);
        }
        progress = { ...progress, projectsDone: progress.projectsDone + 1 };
      }
      await autoMatchUsers();
      const { rows: [u] } = await query(
        'SELECT count(DISTINCT redmine_user_id)::int AS n FROM redmine_time_entries WHERE spent_on >= $1', [SYNC_SINCE]
      );
      const status = !failures.length ? 'success' : projects ? 'partial' : 'failed';
      const message = `Imported ${entries.toLocaleString('en-IN')} time entries from ${projects} of ${links.length} linked project${links.length === 1 ? '' : 's'} since ${SYNC_SINCE}`
        + (failures.length ? `. Failed: ${failures.join('; ')}` : '');
      await query(
        `UPDATE redmine_sync_runs SET status = $2, finished_at = now(), projects = $3, entries = $4, users = $5, message = $6 WHERE id = $1`,
        [run.id, status, projects, entries, u.n, message]
      );
      return { status, message, entries, projects };
    } catch (err) {
      await query(`UPDATE redmine_sync_runs SET status = 'failed', finished_at = now(), message = $2 WHERE id = $1`, [run.id, err.message]);
      throw err;
    }
  })();
  try {
    return await running;
  } finally {
    running = null;
    progress = null;
  }
}

export async function closeInterruptedRedmineSyncs() {
  await query(`UPDATE redmine_sync_runs SET status = 'failed', finished_at = now(), message = 'Interrupted (the server restarted during the import)'
                WHERE status = 'running'`);
}
