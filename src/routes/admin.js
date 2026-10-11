import { Router } from 'express';
import { pool, query } from '../config/db.js';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../auth/password.js';
import { readCookie } from '../auth/session.js';
import { createHash } from 'node:crypto';
import { createJiraClient } from '../jira/client.js';

// Admin API: users & role assignment, roles, projects & teams.
// Access: signed-in users whose role has the 'admin' permission (enforced in app.js).

const router = Router();
const UUID = /^[0-9a-f-]{36}$/i;
const PERMISSIONS = ['view', 'create', 'edit', 'delete', 'admin'];
const STATUSES = ['active', 'inactive'];

class ValidationError extends Error {}
const fail = (message) => { throw new ValidationError(message); };
const text = (v, field, { required = false, max = 255 } = {}) => {
  const s = typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
  if (required && !s) fail(`${field} is required`);
  if (s.length > max) fail(`${field} is too long (max ${max} characters)`);
  return s || null;
};
const oneOf = (v, list, field) => (list.includes(v) ? v : fail(`${field} must be one of: ${list.join(', ')}`));
const isEmail = (v) => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || fail('Email is not valid');

// Wrap a handler: validation errors -> 400, unique violations -> 409
const handle = (fn) => async (req, res, next) => {
  if (req.params.id && !UUID.test(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err.code === '23505') return res.status(409).json({ error: 'That name or key is already in use' });
    next(err);
  }
};

// ---------------------------------------------------------------------------
// Overview: everything the Admin screen shows
// ---------------------------------------------------------------------------

router.get('/admin', handle(async (req, res) => {
  const [users, roles, projects] = await Promise.all([
    query(`SELECT u.id, u.name, u.email, u.status, u.role_id, r.name AS role, u.username, u.last_login_at,
                  (u.password_hash IS NOT NULL AND u.username IS NOT NULL) AS can_sign_in,
                  (u.jira_account_id IS NOT NULL) AS from_jira,
                  COALESCE(array_agg(p.id ORDER BY p.name) FILTER (WHERE p.id IS NOT NULL), '{}') AS project_ids,
                  COALESCE(array_agg(p.name ORDER BY p.name) FILTER (WHERE p.id IS NOT NULL), '{}') AS projects
             FROM users u
             LEFT JOIN roles r ON r.id = u.role_id
             LEFT JOIN user_projects up ON up.user_id = u.id
             LEFT JOIN projects p ON p.id = up.project_id
            GROUP BY u.id, r.name ORDER BY u.name`),
    query(`SELECT r.id, r.name, r.description, r.permissions, count(u.id)::int AS users
             FROM roles r LEFT JOIN users u ON u.role_id = r.id
            GROUP BY r.id ORDER BY r.created_at, r.name`),
    query(`SELECT p.id, p.key, p.name, p.description, p.status,
                  (SELECT count(DISTINCT tm.user_id)::int FROM team_members tm JOIN teams t ON t.id = tm.team_id WHERE t.project_id = p.id) AS members,
                  (SELECT count(*)::int FROM sprints s JOIN teams t ON t.id = s.team_id WHERE t.project_id = p.id) AS sprints,
                  COALESCE((SELECT json_agg(json_build_object(
                      'id', t.id, 'name', t.name, 'jiraBoardId', t.jira_board_id, 'wipLimit', t.wip_limit,
                      'sprints', (SELECT count(*)::int FROM sprints s WHERE s.team_id = t.id)) ORDER BY t.name)
                    FROM teams t WHERE t.project_id = p.id), '[]') AS teams
             FROM projects p ORDER BY p.name`),
  ]);
  res.json({
    users: users.rows,
    roles: roles.rows,
    projects: projects.rows,
    permissions: PERMISSIONS,
  });
}));

// ---------------------------------------------------------------------------
// Users & role assignment
// ---------------------------------------------------------------------------

function userInput(body) {
  const u = {
    name: text(body.name, 'Name', { required: true, max: 120 }),
    email: text(body.email, 'Email'),
    roleId: body.roleId || null,
    projectIds: Array.isArray(body.projectIds) ? body.projectIds : [],
    status: oneOf(body.status || 'active', STATUSES, 'Status'),
    // Sign-in: empty username = cannot sign in; password only needed when setting/changing it
    username: text(body.username, 'Username', { max: 60 }),
    password: typeof body.password === 'string' && body.password !== '' ? body.password : null,
  };
  isEmail(u.email);
  if (u.username && !/^[a-zA-Z0-9._-]{3,60}$/.test(u.username)) fail('Username must be 3–60 letters, numbers, dots, dashes or underscores');
  if (u.password && u.password.length < MIN_PASSWORD_LENGTH) fail(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  if (u.password && !u.username) fail('Set a username to go with the password');
  if (u.roleId && !UUID.test(u.roleId)) fail('Role is not valid');
  if (u.projectIds.some((p) => !UUID.test(p))) fail('Projects are not valid');
  return u;
}

async function saveUserProjects(client, userId, projectIds) {
  await client.query('DELETE FROM user_projects WHERE user_id = $1', [userId]);
  for (const p of projectIds) {
    await client.query('INSERT INTO user_projects (user_id, project_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, p]);
  }
}

// Save sign-in details. Clearing the username removes the ability to sign in.
async function saveLogin(c, userId, u, { isNew }) {
  if (!u.username) {
    await c.query('UPDATE users SET username = NULL, password_hash = NULL WHERE id = $1', [userId]);
    return { passwordChanged: true };
  }
  const taken = await c.query('SELECT 1 FROM users WHERE lower(username) = lower($1) AND id <> $2', [u.username, userId]);
  if (taken.rowCount) fail('That username is already taken');
  const { rows } = await c.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
  if (!u.password && !rows[0]?.password_hash) fail(isNew ? 'Set a password for the new sign-in' : 'Set a password to enable sign-in');
  const hash = u.password ? await hashPassword(u.password) : rows[0].password_hash;
  await c.query('UPDATE users SET username = $2, password_hash = $3 WHERE id = $1', [userId, u.username, hash]);
  return { passwordChanged: !!u.password };
}

// There must always be at least one active administrator who can sign in
async function ensureAdminRemains(c) {
  const { rows } = await c.query(
    `SELECT count(*)::int AS n FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.status = 'active' AND u.password_hash IS NOT NULL AND u.username IS NOT NULL AND 'admin' = ANY (r.permissions)`
  );
  if (!rows[0].n) fail('At least one active administrator who can sign in must remain');
}

const tokenHash = (req) => {
  const t = readCookie(req);
  return t ? createHash('sha256').update(t).digest('hex') : null;
};

async function inTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

router.post('/admin/users', handle(async (req, res) => {
  const u = userInput(req.body ?? {});
  const id = await inTransaction(async (c) => {
    const { rows } = await c.query(
      'INSERT INTO users (name, email, role_id, status) VALUES ($1, $2, $3, $4) RETURNING id',
      [u.name, u.email, u.roleId, u.status]
    );
    await saveUserProjects(c, rows[0].id, u.projectIds);
    if (u.username) await saveLogin(c, rows[0].id, u, { isNew: true });
    return rows[0].id;
  });
  res.status(201).json({ id });
}));

router.put('/admin/users/:id', handle(async (req, res) => {
  const u = userInput(req.body ?? {});
  const isSelf = req.params.id === req.user.id;
  if (isSelf && u.status !== 'active') fail('You can’t deactivate your own account');
  const found = await inTransaction(async (c) => {
    const { rowCount } = await c.query(
      'UPDATE users SET name = $2, email = $3, role_id = $4, status = $5 WHERE id = $1',
      [req.params.id, u.name, u.email, u.roleId, u.status]
    );
    if (!rowCount) return 0;
    await saveUserProjects(c, req.params.id, u.projectIds);
    const { passwordChanged } = await saveLogin(c, req.params.id, u, { isNew: false });
    if (isSelf) {
      const { rows } = await c.query('SELECT permissions FROM roles WHERE id = $1', [u.roleId]);
      if (!rows[0]?.permissions.includes('admin')) fail('You can’t remove your own admin access');
      if (!u.username) fail('You can’t remove your own sign-in');
    }
    await ensureAdminRemains(c);
    // Sign the person out elsewhere when their password changes or they are deactivated
    if (passwordChanged || u.status !== 'active') {
      await c.query('DELETE FROM sessions WHERE user_id = $1 AND token_hash IS DISTINCT FROM $2', [req.params.id, isSelf ? tokenHash(req) : null]);
    }
    return rowCount;
  });
  if (!found) return res.status(404).json({ error: 'User not found' });
  res.json({ ok: true });
}));

router.delete('/admin/users/:id', handle(async (req, res) => {
  if (req.params.id === req.user.id) return res.status(409).json({ error: 'You can’t delete your own account' });
  const { rows } = await query('SELECT jira_account_id FROM users WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  if (rows[0].jira_account_id) {
    return res.status(409).json({ error: 'This person comes from Jira and would be re-added on the next sync. Set them to Inactive instead.' });
  }
  await query('DELETE FROM users WHERE id = $1', [req.params.id]);
  res.status(204).end();
}));

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

function roleInput(body) {
  const permissions = Array.isArray(body.permissions) ? [...new Set(body.permissions)] : [];
  if (!permissions.length) fail('Choose at least one permission');
  permissions.forEach((p) => oneOf(p, PERMISSIONS, 'Permission'));
  return {
    name: text(body.name, 'Role name', { required: true, max: 60 }),
    description: text(body.description, 'Description', { max: 500 }),
    permissions: PERMISSIONS.filter((p) => permissions.includes(p)),
  };
}

router.post('/admin/roles', handle(async (req, res) => {
  const r = roleInput(req.body ?? {});
  const { rows } = await query('INSERT INTO roles (name, description, permissions) VALUES ($1, $2, $3) RETURNING id',
    [r.name, r.description, r.permissions]);
  res.status(201).json({ id: rows[0].id });
}));

router.put('/admin/roles/:id', handle(async (req, res) => {
  const r = roleInput(req.body ?? {});
  const rowCount = await inTransaction(async (c) => {
    const result = await c.query('UPDATE roles SET name = $2, description = $3, permissions = $4 WHERE id = $1',
      [req.params.id, r.name, r.description, r.permissions]);
    await ensureAdminRemains(c);
    return result.rowCount;
  });
  if (!rowCount) return res.status(404).json({ error: 'Role not found' });
  res.json({ ok: true });
}));

router.delete('/admin/roles/:id', handle(async (req, res) => {
  const { rows } = await query('SELECT count(*)::int AS n FROM users WHERE role_id = $1', [req.params.id]);
  if (rows[0].n) return res.status(409).json({ error: `${rows[0].n} user(s) have this role. Assign them another role first.` });
  const { rowCount } = await query('DELETE FROM roles WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'Role not found' });
  res.status(204).end();
}));

// ---------------------------------------------------------------------------
// Projects & teams (teams map to Jira boards; the sync uses active projects only)
// ---------------------------------------------------------------------------

function projectInput(body) {
  const teams = Array.isArray(body.teams) ? body.teams : [];
  const p = {
    key: text(body.key, 'Key', { required: true, max: 10 })?.toUpperCase(),
    name: text(body.name, 'Project name', { required: true, max: 120 }),
    description: text(body.description, 'Description', { max: 500 }),
    status: oneOf(body.status || 'active', STATUSES, 'Status'),
    teams: teams.map((t, i) => {
      const board = t.jiraBoardId === '' || t.jiraBoardId == null ? null : Number(t.jiraBoardId);
      if (board !== null && (!Number.isInteger(board) || board <= 0)) fail(`Team ${i + 1}: Jira board id must be a positive number`);
      const wip = t.wipLimit === '' || t.wipLimit == null ? 5 : Number(t.wipLimit);
      if (!Number.isInteger(wip) || wip < 1) fail(`Team ${i + 1}: WIP limit must be a whole number of 1 or more`);
      if (t.id && !UUID.test(t.id)) fail(`Team ${i + 1}: invalid id`);
      return { id: t.id || null, name: text(t.name, `Team ${i + 1} name`, { required: true, max: 120 }), jiraBoardId: board, wipLimit: wip };
    }),
  };
  if (!/^[A-Z][A-Z0-9_]*$/.test(p.key)) fail('Key must start with a letter and use only letters, numbers or _');
  const names = p.teams.map((t) => t.name.toLowerCase());
  if (new Set(names).size !== names.length) fail('Team names must be unique within the project');
  return p;
}

async function saveTeams(c, projectId, teams) {
  const { rows: existing } = await c.query(
    `SELECT t.id, t.name, (SELECT count(*)::int FROM sprints s WHERE s.team_id = t.id) AS sprints FROM teams t WHERE t.project_id = $1`,
    [projectId]
  );
  const keep = new Set(teams.filter((t) => t.id).map((t) => t.id));
  for (const t of existing.filter((e) => !keep.has(e.id))) {
    if (t.sprints) fail(`Team "${t.name}" has synced sprints and can't be removed`);
    await c.query('DELETE FROM teams WHERE id = $1', [t.id]);
  }
  for (const t of teams) {
    if (t.id) {
      await c.query('UPDATE teams SET name = $2, jira_board_id = $3, wip_limit = $4 WHERE id = $1 AND project_id = $5',
        [t.id, t.name, t.jiraBoardId, t.wipLimit, projectId]);
    } else {
      await c.query('INSERT INTO teams (project_id, name, jira_board_id, wip_limit) VALUES ($1, $2, $3, $4)',
        [projectId, t.name, t.jiraBoardId, t.wipLimit]);
    }
  }
}

// Jira problems (network, token) become a readable 400 instead of a 500
const fromJira = async (fn) => {
  try {
    return await fn();
  } catch (err) {
    fail(`Could not load from Jira: ${err.cause?.code || err.message}`);
  }
};

// Jira projects to choose from when adding a project; `added` = already in AgileMetrix
router.get('/admin/jira/projects', handle(async (req, res) => {
  const [jiraProjects, { rows }] = await Promise.all([
    fromJira(() => createJiraClient().projects()),
    query('SELECT upper(key) AS key FROM projects'),
  ]);
  const existing = new Set(rows.map((r) => r.key));
  res.json(jiraProjects
    .filter((p) => !p.archived)
    .map((p) => ({ key: p.key, name: p.name, description: p.description || '', added: existing.has(p.key.toUpperCase()) })));
}));

// Scrum boards of a Jira project, offered as the project's teams
router.get('/admin/jira/projects/:key/boards', handle(async (req, res) => {
  if (!/^[A-Z][A-Z0-9_]{0,19}$/i.test(req.params.key)) fail('Invalid project key');
  const boards = await fromJira(() => createJiraClient().projectBoards(req.params.key));
  res.json(boards.map((b) => ({ id: b.id, name: b.name })));
}));

router.post('/admin/projects', handle(async (req, res) => {
  const p = projectInput(req.body ?? {});
  const id = await inTransaction(async (c) => {
    const { rows } = await c.query(
      'INSERT INTO projects (key, name, description, status) VALUES ($1, $2, $3, $4) RETURNING id',
      [p.key, p.name, p.description, p.status]
    );
    await saveTeams(c, rows[0].id, p.teams);
    await c.query(
      `INSERT INTO metric_targets (project_id, metric, operator, value)
       SELECT $1, metric, operator, value FROM metric_targets
        WHERE project_id = (SELECT id FROM projects WHERE id <> $1 ORDER BY created_at LIMIT 1)
       ON CONFLICT DO NOTHING`,
      [rows[0].id]
    );
    return rows[0].id;
  });
  res.status(201).json({ id });
}));

router.put('/admin/projects/:id', handle(async (req, res) => {
  const p = projectInput(req.body ?? {});
  const found = await inTransaction(async (c) => {
    const { rowCount } = await c.query(
      'UPDATE projects SET key = $2, name = $3, description = $4, status = $5 WHERE id = $1',
      [req.params.id, p.key, p.name, p.description, p.status]
    );
    if (rowCount) await saveTeams(c, req.params.id, p.teams);
    return rowCount;
  });
  if (!found) return res.status(404).json({ error: 'Project not found' });
  res.json({ ok: true });
}));

router.delete('/admin/projects/:id', handle(async (req, res) => {
  const { rows } = await query(
    `SELECT (SELECT count(*)::int FROM sprints s JOIN teams t ON t.id = s.team_id WHERE t.project_id = $1) AS sprints,
            EXISTS (SELECT 1 FROM projects WHERE id = $1) AS found`,
    [req.params.id]
  );
  if (!rows[0].found) return res.status(404).json({ error: 'Project not found' });
  if (rows[0].sprints) {
    return res.status(409).json({ error: 'This project has synced sprint history. Set it to Inactive instead of deleting it.' });
  }
  await query('DELETE FROM projects WHERE id = $1', [req.params.id]);
  res.status(204).end();
}));

export default router;
