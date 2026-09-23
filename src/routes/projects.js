import { Router } from 'express';
import { query } from '../config/db.js';

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM projects ORDER BY created_at');
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  const { key, name, description, owner_id } = req.body;
  if (!key || !name) return res.status(400).json({ error: 'key and name are required' });
  try {
    const { rows } = await query(
      'INSERT INTO projects (key, name, description, owner_id) VALUES ($1, $2, $3, $4) RETURNING *',
      [key, name, description, owner_id]
    );
    const defaults = ['To Do', 'In Progress', 'In Review', 'Done'];
    for (const [i, col] of defaults.entries()) {
      await query('INSERT INTO board_columns (project_id, name, position) VALUES ($1, $2, $3)', [rows[0].id, col, i + 1]);
    }
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// Board view: columns with their issues (active sprint only)
router.get('/:id/board', async (req, res, next) => {
  try {
    const { id } = req.params;
    const [cols, issues, sprint] = await Promise.all([
      query('SELECT * FROM board_columns WHERE project_id = $1 ORDER BY position', [id]),
      query(
        `SELECT i.*, p.key || '-' || i.number AS issue_key, u.name AS assignee_name
           FROM issues i
           JOIN projects p ON p.id = i.project_id
           LEFT JOIN users u ON u.id = i.assignee_id
           JOIN sprints s ON s.id = i.sprint_id AND s.status = 'active'
          WHERE i.project_id = $1
          ORDER BY i.position`,
        [id]
      ),
      query(`SELECT * FROM sprints WHERE project_id = $1 AND status = 'active' LIMIT 1`, [id]),
    ]);
    res.json({
      sprint: sprint.rows[0] || null,
      columns: cols.rows.map((c) => ({ ...c, issues: issues.rows.filter((i) => i.column_id === c.id) })),
    });
  } catch (err) { next(err); }
});

router.get('/:id/backlog', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT i.*, p.key || '-' || i.number AS issue_key
         FROM issues i JOIN projects p ON p.id = i.project_id
        WHERE i.project_id = $1 AND i.sprint_id IS NULL
        ORDER BY i.created_at`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/:id/sprints', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM sprints WHERE project_id = $1 ORDER BY start_date', [req.params.id]);
    res.json(rows);
  } catch (err) { next(err); }
});

export default router;
