import { Router } from 'express';
import { query } from '../config/db.js';

// The signed-in user's own preferences (any role may change their own)
const router = Router();
const SIZES = ['half', 'full'];

// Layout = [{ id, size, hidden }] in display order; unknown widget ids are ignored by the frontend
export function parseLayout(value) {
  if (value === null) return null; // reset to the default layout
  if (!Array.isArray(value) || value.length > 50) throw new Error('Layout must be a list of widgets');
  const seen = new Set();
  return value.map((w) => {
    if (!w || typeof w.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(w.id) || seen.has(w.id)) throw new Error('Invalid widget id');
    if (!SIZES.includes(w.size)) throw new Error('Widget size must be half or full');
    seen.add(w.id);
    return { id: w.id, size: w.size, hidden: w.hidden === true };
  });
}

router.get('/me/preferences', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT dashboard_layout FROM user_preferences WHERE user_id = $1', [req.user.id]);
    res.json({ dashboardLayout: rows[0]?.dashboard_layout ?? null });
  } catch (err) {
    next(err);
  }
});

router.put('/me/preferences', async (req, res, next) => {
  let layout;
  try {
    layout = parseLayout(req.body?.dashboardLayout ?? null);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  try {
    await query(
      `INSERT INTO user_preferences (user_id, dashboard_layout, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (user_id) DO UPDATE SET dashboard_layout = EXCLUDED.dashboard_layout, updated_at = now()`,
      [req.user.id, layout === null ? null : JSON.stringify(layout)]
    );
    res.json({ dashboardLayout: layout });
  } catch (err) {
    next(err);
  }
});

export default router;
