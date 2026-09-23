import { Router } from 'express';
import { query } from '../config/db.js';

const router = Router();

router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM issues WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Issue not found' });
    const comments = await query('SELECT * FROM comments WHERE issue_id = $1 ORDER BY created_at', [req.params.id]);
    res.json({ ...rows[0], comments: comments.rows });
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  const { project_id, sprint_id, column_id, title, description, type, priority, story_points, assignee_id, reporter_id } = req.body;
  if (!project_id || !title) return res.status(400).json({ error: 'project_id and title are required' });
  try {
    const { rows } = await query(
      `INSERT INTO issues (project_id, sprint_id, column_id, number, title, description, type, priority, story_points, assignee_id, reporter_id)
       VALUES ($1, $2, $3,
               (SELECT COALESCE(MAX(number), 0) + 1 FROM issues WHERE project_id = $1),
               $4, $5, COALESCE($6, 'task'), COALESCE($7, 'medium'), $8, $9, $10)
       RETURNING *`,
      [project_id, sprint_id, column_id, title, description, type, priority, story_points, assignee_id, reporter_id]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

const EDITABLE = ['title', 'description', 'type', 'priority', 'story_points', 'assignee_id', 'sprint_id', 'column_id', 'position'];

router.patch('/:id', async (req, res, next) => {
  const fields = Object.keys(req.body).filter((k) => EDITABLE.includes(k));
  if (!fields.length) return res.status(400).json({ error: 'No editable fields provided' });
  const sets = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
  try {
    const { rows } = await query(
      `UPDATE issues SET ${sets}, updated_at = now() WHERE id = $1 RETURNING *`,
      [req.params.id, ...fields.map((f) => req.body[f])]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Issue not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await query('DELETE FROM issues WHERE id = $1', [req.params.id]);
    res.status(204).end();
  } catch (err) { next(err); }
});

export default router;
