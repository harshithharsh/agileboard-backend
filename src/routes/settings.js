import { Router } from 'express';
import { query } from '../config/db.js';
import { requirePermission } from '../auth/middleware.js';
import { getSchedule, getNotifications, getScheduleState, validateAutomation, saveAutomation, nextRun } from '../services/automation.js';
import { emailStatus, sendEmail } from '../services/mailer.js';

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

// Scheduled sync and email notifications (admin only)
async function automation() {
  const [schedule, notifications, state] = await Promise.all([getSchedule(), getNotifications(), getScheduleState()]);
  return { schedule, notifications, email: emailStatus(), lastRun: state.lastStatus ? state : null, nextRun: nextRun(schedule, state) };
}

router.get('/admin/automation', requirePermission('admin'), async (req, res, next) => {
  try {
    res.json(await automation());
  } catch (err) { next(err); }
});

router.put('/admin/automation', requirePermission('admin'), async (req, res, next) => {
  const error = validateAutomation(req.body ?? {});
  if (error) return res.status(400).json({ error });
  try {
    await saveAutomation(req.body, req.user.id);
    res.json(await automation());
  } catch (err) { next(err); }
});

// Send a test email to the saved recipients
router.post('/admin/automation/test-email', requirePermission('admin'), async (req, res) => {
  const { recipients } = await getNotifications();
  if (!recipients.length) return res.status(400).json({ error: 'Add at least one recipient and save first' });
  if (!emailStatus().configured) return res.status(400).json({ error: 'Email is not set up on the server (SMTP settings in the backend .env)' });
  try {
    await sendEmail({
      to: recipients,
      subject: 'AgileMetrix: test email',
      text: `This is a test from AgileMetrix, sent by ${req.user.name}. Sync notifications will arrive like this.`,
    });
    res.json({ sent: recipients.length });
  } catch (err) {
    res.status(502).json({ error: `Could not send email: ${err.message}` });
  }
});


// ---------------------------------------------------------------------------
// Public holidays (Settings → General): left out of capacity in Resource Management
// ---------------------------------------------------------------------------
const DAY = /^\d{4}-\d{2}-\d{2}$/;

router.get('/admin/holidays', async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT day::text AS date, name FROM holidays ORDER BY day`);
    res.json(rows);
  } catch (err) { next(err); }
});

// Add or rename the holiday on a date
router.put('/admin/holidays/:date', async (req, res, next) => {
  const { date } = req.params;
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!DAY.test(date) || Number.isNaN(new Date(`${date}T00:00:00Z`).getTime())) return res.status(400).json({ error: 'Choose a valid date' });
  if (!name || name.length > 120) return res.status(400).json({ error: 'Enter a holiday name (up to 120 characters)' });
  try {
    await query(
      `INSERT INTO holidays (day, name, created_by) VALUES ($1, $2, $3) ON CONFLICT (day) DO UPDATE SET name = EXCLUDED.name`,
      [date, name, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.delete('/admin/holidays/:date', async (req, res, next) => {
  if (!DAY.test(req.params.date)) return res.status(400).json({ error: 'Invalid date' });
  try {
    await query('DELETE FROM holidays WHERE day = $1', [req.params.date]);
    res.status(204).end();
  } catch (err) { next(err); }
});

export default router;
