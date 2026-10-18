import { Router } from 'express';
import { query } from '../config/db.js';
import { requirePermission } from '../auth/middleware.js';

// Workspace display settings: everyone signed in can read them, administrators change them.
const router = Router();
export const DATE_FORMATS = ['DD MMM YYYY', 'DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'];
export const TIME_FORMATS = ['12h', '24h'];
const DEFAULTS = { dateFormat: 'DD MMM YYYY', timeFormat: '12h' };

async function loadDisplay() {
  const { rows } = await query(`SELECT value FROM app_settings WHERE key = 'display'`);
  return { ...DEFAULTS, ...(rows[0]?.value ?? {}) };
}

router.get('/settings', async (req, res, next) => {
  try {
    res.json(await loadDisplay());
  } catch (err) { next(err); }
});

router.put('/admin/settings', requirePermission('admin'), async (req, res, next) => {
  const { dateFormat, timeFormat } = req.body ?? {};
  if (!DATE_FORMATS.includes(dateFormat)) return res.status(400).json({ error: `dateFormat must be one of: ${DATE_FORMATS.join(', ')}` });
  if (!TIME_FORMATS.includes(timeFormat)) return res.status(400).json({ error: 'timeFormat must be 12h or 24h' });
  try {
    await query(
      `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES ('display', $1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [JSON.stringify({ dateFormat, timeFormat }), req.user.id]
    );
    res.json(await loadDisplay());
  } catch (err) { next(err); }
});

export default router;
