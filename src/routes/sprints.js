import { Router } from 'express';
import { query } from '../config/db.js';
import { requirePermission } from '../auth/middleware.js';
import { OUTCOMES } from '../services/sprintGoal.js';

// Sprint goal outcome, recorded by a Scrum Master (Edit permission). Synced Jira data never touches it.
const router = Router();
const UUID = /^[0-9a-f-]{36}$/i;

// Body: { outcome: 'met' | 'partly_met' | 'not_met' | null, note? }. null clears the outcome.
router.put('/sprints/:id/goal-outcome', requirePermission('edit'), async (req, res, next) => {
  const { id } = req.params;
  const { outcome = null } = req.body ?? {};
  const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) || null : null;
  if (!UUID.test(id)) return res.status(400).json({ error: 'Invalid sprint id' });
  if (outcome !== null && !OUTCOMES.includes(outcome)) return res.status(400).json({ error: `outcome must be one of: ${OUTCOMES.join(', ')}` });
  try {
    const { rows: [sprint] } = await query('SELECT id, status FROM sprints WHERE id = $1', [id]);
    if (!sprint) return res.status(404).json({ error: 'Sprint not found' });
    if (outcome === null) {
      await query('DELETE FROM sprint_goal_outcomes WHERE sprint_id = $1', [id]);
      return res.json({ outcome: null });
    }
    const { rows: [saved] } = await query(
      `INSERT INTO sprint_goal_outcomes (sprint_id, outcome, note, recorded_by, recorded_at) VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (sprint_id) DO UPDATE SET outcome = EXCLUDED.outcome, note = EXCLUDED.note,
         recorded_by = EXCLUDED.recorded_by, recorded_at = EXCLUDED.recorded_at
       RETURNING outcome, note, recorded_at`,
      [id, outcome, note, req.user.id]
    );
    res.json({ outcome: { value: saved.outcome, note: saved.note, recordedBy: req.user.name, recordedAt: saved.recorded_at } });
  } catch (err) { next(err); }
});

export default router;
